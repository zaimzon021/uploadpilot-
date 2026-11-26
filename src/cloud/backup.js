'use strict';
// Optional video backup to Google Drive (UploadPilot/channels/<channel>/<file>) so another PC can
// take over a job if this PC is off. Gentle by design:
//  * only inside the idle-hours window (e.g. 01:00–07:00), only when this PC isn't uploading to
//    YouTube (a YouTube upload that starts aborts the chunk in flight; it resumes later from the
//    server's offset), and not while the user is using the PC when that setting is on
//  * speed cap: user KB/s, else 30% of the measured upload speed (measured on the first chunk)
//  * one file at a time, chunked resumable upload (session kept in drive_jobs across restarts)
const fs = require('fs');
const path = require('path');
const { Throttle } = require('./throttle');
const { backupRate } = require('./drive');
const { parseHHMM } = require('../util/time');

/** HH:MM–HH:MM window that may wrap midnight (22:00–06:00). start==end means all day. */
function inDailyWindow(ts, w) {
  if (!w || !w.start || !w.end) return true;
  const d = new Date(ts); const m = d.getHours() * 60 + d.getMinutes();
  const a = parseHHMM(w.start), b = parseHHMM(w.end);
  if (a === b) return true;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

class BackupWorker {
  constructor({ app, cloud, tickMs = 60000, now = () => Date.now() }) {
    Object.assign(this, { app, cloud, tickMs, now });
    this.busy = false; this.current = null; this.abortCtl = new AbortController();
    this.stats = { uploaded: 0, bytes: 0, errors: 0, lastError: null, pausedReason: null };
  }
  get cfg() { return this.app.settings.get('cloud').backup; }

  start() {
    this._timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
    if (this._timer.unref) this._timer.unref();
    this._onUpload = () => this.interrupt('YouTube upload started');
    this.app.runner.on('upload-start', this._onUpload);
  }
  async stop() {
    clearInterval(this._timer);
    if (this._onUpload) this.app.runner.off('upload-start', this._onUpload);
    this.interrupt('stopping'); this.stopped = true;
    while (this.busy) await new Promise(r => setTimeout(r, 50));
  }
  interrupt(why) { this.abortCtl.abort(); this.abortCtl = new AbortController(); this.stats.pausedReason = why; }

  /** null when backup may run now, else the reason it waits */
  blockedReason() {
    const c = this.cfg;
    if (!c.enabled) return 'Backup is off';
    if (!this.cloud.drive()) return 'Google Drive is not connected';
    if (!inDailyWindow(this.now(), c.idleHours)) return `Outside idle hours (${c.idleHours.start}–${c.idleHours.end})`;
    if (this.app.runner.live.size) return 'Uploading to YouTube';
    if (this.app.userActive && this.app.userActive()) return 'You are using the PC';
    return null;
  }

  nextVideo() {
    return this.app.db.get(`SELECT v.*, c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id
      WHERE v.remote=0 AND v.drive_file_id IS NULL AND v.backup_error IS NULL AND v.status IN ('queued','ai','awaiting_approval','ready','failed')
      ORDER BY CASE WHEN v.scheduled_at IS NULL THEN 1 ELSE 0 END, v.scheduled_at, v.id LIMIT 1`);
  }

  async tick() {
    if (this.busy || this.stopped) return null;
    const why = this.blockedReason();
    this.stats.pausedReason = why;
    if (why) return null;
    const v = this.nextVideo();
    if (!v) return null;
    if (!fs.existsSync(v.path)) { this.app.db.run('UPDATE videos SET backup_error=? WHERE id=?', 'file missing', v.id); return null; }
    this.busy = true; this.current = { videoId: v.id, sent: 0, size: v.size, filename: v.filename };
    const drive = this.cloud.drive();
    const c = this.cfg;
    const throttle = new Throttle(0);
    const probe = !(c.speedCapKBps > 0);
    let t0 = Date.now(), measured = false;
    const applyCap = () => throttle.setRate(backupRate({ speedCapKBps: c.speedCapKBps, speedCapPct: c.speedCapPct, measuredBps: this.app.settings.get('cloud').backup.measuredBps }));
    if (!probe) applyCap();
    try {
      const job = this.app.db.get('SELECT * FROM drive_jobs WHERE video_id=?', v.id);
      const parentId = await drive.ensureFolder(['channels', v.channel_name || `channel-${v.channel_id}`]);
      const file = await drive.upload({
        source: v.path, name: v.filename, parentId, mimeType: 'video/mp4', throttle,
        chunkBytes: (c.chunkMB || 8) * 1024 * 1024,
        sessionUrl: job && job.session_url,
        onSession: url => this.app.db.run('INSERT OR REPLACE INTO drive_jobs(video_id,session_url,size,started_at) VALUES(?,?,?,?)', v.id, url, v.size, Date.now()),
        shouldPause: () => !!this.blockedReason() && !this.stopped,
        signalFor: () => this.abortCtl.signal,
        onProgress: sent => {
          this.current.sent = sent;
          if (probe && !measured && sent > 0) {
            const secs = (Date.now() - t0) / 1000;
            if (secs > 0.2) {
              const bps = sent / secs, old = this.app.settings.get('cloud').backup.measuredBps || 0;
              this.app.settings.set({ cloud: { ...this.app.settings.get('cloud'), backup: { ...this.app.settings.get('cloud').backup, measuredBps: Math.round(old ? old * 0.6 + bps * 0.4 : bps) } } });
            }
            measured = true; applyCap();
          }
        },
      });
      this.app.db.run('UPDATE videos SET drive_file_id=? WHERE id=?', file.id, v.id);
      this.app.db.run('DELETE FROM drive_jobs WHERE video_id=?', v.id);
      this.stats.uploaded++; this.stats.bytes += v.size || 0;
      this.app.events.info(`${v.channel_name}: ${v.filename} backed up to Google Drive`, { channelId: v.channel_id, kind: 'backup' });
      return file;
    } catch (e) {
      this.stats.errors++; this.stats.lastError = e.message;
      if (e.code === 'DRIVE_QUOTA') this.app.events.warn(`Drive backup paused: ${e.message}`, { kind: 'backup' });
      else if (e.status === 404) this.app.db.run('DELETE FROM drive_jobs WHERE video_id=?', v.id);
      else if (e.code !== 'DRIVE_NOT_CONNECTED') this.app.events.warn(`Drive backup of ${v.filename} failed: ${e.message.split('\n')[0]}`, { channelId: v.channel_id, kind: 'backup' });
      return null;
    } finally { this.busy = false; this.current = null; }
  }

  status() { return { ...this.stats, busy: this.busy, current: this.current, waiting: this.blockedReason(), pending: this.app.db.get(`SELECT COUNT(*) AS n FROM videos WHERE remote=0 AND drive_file_id IS NULL AND status IN ('queued','ai','awaiting_approval','ready')`).n }; }
}

module.exports = { BackupWorker, inDailyWindow };
