'use strict';
// v0.3.2: the active PC needs a video whose file lives on another PC (a channel folder belongs to one
// PC). In this order:
//   1. the same file is on this PC (same folder path, or a folder linked here): same name + same size
//      -> uploaded straight from there (cloud.localCopy)
//   2. a Drive backup exists -> downloaded on demand into the cache at upload time (any hour)
//   3. no backup: ask the PC that has the file for a PRIORITY backup of just that file
//        users/{uid}/meta/file_<videoCloudId> = { kind:'file', videoId, filename, ownerPcId, ownerPcName,
//          toPcId, toPcName, state: requested|uploading|done|missing|failed, requestedAt, ackAt, driveFileId, error }
//      The owning PC (signed in, active or not) sees it through its meta listener, answers at once
//      (state 'uploading'), uploads the file to Drive ignoring idle hours but keeping the speed cap,
//      then writes 'done' + driveFileId. The active PC pulls it like any backup.
//   4. no answer within ackMs: the owning PC is offline -> Needs you: "Video is on <PC>, which is
//      offline — turn it on or relink folder" (Skip). The request stays open: when that PC comes back
//      online its listener sees it and serves it.
// The row shows "Waiting for file from <PC>" meanwhile, never "failed" / "missing".
const fs = require('fs');

class FileRequests {
  /** @param {{app, cloud, store, root:()=>string, pcId, pcName, ackMs?, leadMin?, tickMs?, now?}} o */
  constructor(o) {
    Object.assign(this, { ackMs: 45000, leadMin: 60, tickMs: 15000, firstTickMs: 2000, now: () => Date.now(), ...o });
    this.docs = new Map();      // videoCloudId -> request doc (from the meta listener)
    this.sent = new Map();      // videoCloudId -> when this PC sent its request
    this.serving = new Set();
    this.served = 0; this.requested = 0;
  }
  path(cid) { return `${this.root()}/meta/file_${cid}`; }
  get db() { return this.app.db; }

  start() { this._timer = setInterval(() => this.tick().catch(() => {}), this.tickMs); if (this._timer.unref) this._timer.unref(); this._first = setTimeout(() => this.tick().catch(() => {}), this.firstTickMs); if (this._first.unref) this._first.unref(); return this; }
  stop() { clearInterval(this._timer); clearTimeout(this._first); this.stopped = true; }

  /** meta listener: id = 'file_<cid>' */
  onDoc(id, d) {
    const cid = id.slice(5);
    if (!d) { this.docs.delete(cid); return; }
    this.docs.set(cid, d);
    if (d.ownerPcId === this.pcId && d.state === 'requested' && !this.stopped) this.serve(cid, d).catch(e => this.app.events.warn(`File request for ${d.filename}: ${e.message}`, { kind: 'backup' }));
    if (d.toPcId === this.pcId) this._onAnswer(cid, d);
  }

  // ---------------------------------------------------------------- active PC (requester)
  /** Remote videos due soon with no local copy and no Drive backup: ask their PC. */
  async tick(now = this.now()) {
    // one active PC per account (the owner of a file is then never uploading it itself)
    if (this.stopped || !this.cloud.online || !this.cloud.singleActive || !(this.cloud.activePc && this.cloud.activePc.isActive)) return 0;
    if (!this.cloud.drive()) return 0;
    const rows = this.db.all(`SELECT v.*, c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id
      WHERE v.remote=1 AND v.cloud_id IS NOT NULL AND v.drive_file_id IS NULL AND v.status IN ('queued','ready','awaiting_approval')
        AND c.status='active' AND v.scheduled_at IS NOT NULL AND v.scheduled_at<=? ORDER BY v.scheduled_at LIMIT 20`, now + this.leadMin * 60000);
    let n = 0;
    for (const v of rows) {
      if (this.cloud.localCopy(v)) continue;
      const d = this.docs.get(v.cloud_id);
      const mine = d && d.toPcId === this.pcId;
      const retry = d && ['failed'].includes(d.state) && now - (this.sent.get(v.cloud_id) || 0) > 10 * 60000;
      if (!mine || retry) { await this.request(v).catch(e => this.app.events.warn(`Could not ask ${v.origin_pc_name || 'the other PC'} for ${v.filename}: ${e.message}`, { kind: 'backup' })); n++; }
    }
    return n;
  }

  async request(v) {
    if (!v.origin_pc || v.origin_pc === this.pcId) return null;
    this.sent.set(v.cloud_id, this.now());
    const doc = { kind: 'file', videoId: v.cloud_id, filename: v.filename, size: v.size || 0, ownerPcId: v.origin_pc, ownerPcName: v.origin_pc_name || 'another PC', toPcId: this.pcId, toPcName: this.pcName, state: 'requested', requestedAt: this.store.SERVER_TS, ackAt: null, driveFileId: null, error: null };
    this.docs.set(v.cloud_id, { ...doc, requestedAt: this.now() });
    await this.store.set(this.path(v.cloud_id), doc);
    this.requested++;
    this.app.events.info(`${v.channel_name || 'Channel'}: "${v.title || v.filename}" is on ${doc.ownerPcName} — asked it to upload the file to Google Drive now`, { channelId: v.channel_id, kind: 'backup' });
    return doc;
  }

  _onAnswer(cid, d) {
    const v = this.db.get('SELECT v.*, c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.cloud_id=?', cid);
    if (!v) return;
    if (d.state === 'done' && d.driveFileId) {
      if (v.drive_file_id !== d.driveFileId) {
        this.db.applying(() => this.db.run('UPDATE videos SET drive_file_id=? WHERE id=?', d.driveFileId, v.id));   // the owner syncs it too
        this.app.events.info(`${v.channel_name}: "${v.title || v.filename}" arrived from ${d.ownerPcName} (Google Drive)`, { channelId: v.channel_id, kind: 'backup' });
      }
      this.store.delete(this.path(cid)).catch(() => {});
      if (this.app.onVideosChanged) this.app.onVideosChanged();
    } else if (d.state === 'missing') {
      this.db.run(`UPDATE videos SET status='missing', error=?, error_kind='missing' WHERE id=? AND status NOT IN ('done','uploading')`, `File not found on ${d.ownerPcName}`, v.id);
      this.app.events.error(`${v.channel_name}: "${v.title || v.filename}" is not in the folder on ${d.ownerPcName} any more`, { channelId: v.channel_id, kind: 'failed' });
      this.store.delete(this.path(cid)).catch(() => {});
    }
    if (this.app.cloud) this.app.cloud.emit('change');
  }

  /** For the UI: {from, state: 'requested'|'uploading'|'offline'|'failed', since} or null. */
  waitingFor(v, now = this.now()) {
    if (!v || !v.remote || v.drive_file_id || !v.cloud_id || ['done', 'skipped', 'uploading'].includes(v.status)) return null;
    const d = this.docs.get(v.cloud_id);
    if (!d || d.toPcId !== this.pcId) return null;
    const from = d.ownerPcName || v.origin_pc_name || 'another PC';
    if (d.state === 'uploading') return { from, state: 'uploading', since: this.sent.get(v.cloud_id) || null };
    if (d.state === 'failed') return { from, state: 'failed', error: d.error || null };
    if (d.state === 'requested') {
      const sentAt = this.sent.get(v.cloud_id) || (typeof d.requestedAt === 'number' ? d.requestedAt : now);
      return { from, state: now - sentAt > this.ackMs ? 'offline' : 'requested', since: sentAt };
    }
    return null;
  }

  // ---------------------------------------------------------------- PC that has the file (owner)
  async serve(cid, d) {
    if (this.serving.has(cid)) return null;
    this.serving.add(cid);
    try {
      const v = this.db.get('SELECT v.*, c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.cloud_id=? AND v.remote=0', cid);
      const answer = fields => this.store.set(this.path(cid), { ...fields }, { merge: true });
      if (!v) { await answer({ state: 'failed', error: 'not on this PC' }); return null; }
      if (v.drive_file_id) { await answer({ state: 'done', driveFileId: v.drive_file_id, ackAt: this.store.SERVER_TS }); return v.drive_file_id; }
      if (!v.path || !fs.existsSync(v.path)) { await answer({ state: 'missing', ackAt: this.store.SERVER_TS }); return null; }
      if (!this.cloud.backup || !this.cloud.drive()) { await answer({ state: 'failed', error: 'Google Drive is not connected on ' + this.pcName }); return null; }
      await answer({ state: 'uploading', ackAt: this.store.SERVER_TS });
      this.app.events.info(`${d.toPcName || 'The active PC'} needs "${v.title || v.filename}" now — uploading it to Google Drive first (speed cap kept)`, { channelId: v.channel_id, kind: 'backup' });
      const f = await this.cloud.backup.backupOne(v.id, { priority: true });
      if (f && f.id) {
        await answer({ state: 'done', driveFileId: f.id });
        if (this.cloud.sync) this.cloud.sync.pushNow().catch(() => {});
        this.served++;
        return f.id;
      }
      await answer({ state: 'failed', error: (this.cloud.backup.stats && this.cloud.backup.stats.lastError) || 'upload failed' });
      return null;
    } finally { this.serving.delete(cid); }
  }
}

module.exports = { FileRequests };
