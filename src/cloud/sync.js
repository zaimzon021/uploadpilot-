'use strict';
// Two-way sync between the local SQLite cache and Firestore (the shared source of truth).
//
// Firestore layout (everything under users/{uid}):
//   channels/{id}  profiles/{id}  videos/{id}  plans/{channelId}  activity/{auto}  pcs/{pcId}  leases/{key}  meta/sync
//
// Local -> cloud: SQLite triggers set rows dirty=1 on local edits. Every `pushMs` the dirty rows are
//   diffed against the last synced copy (cloud_shadow); only changed fields are written, in batches,
//   merged, with updatedAt=serverTimestamp. Unchanged rows cost nothing. Deletes go through tombstones.
// Cloud -> local: onSnapshot listeners (no polling). A remote change is applied field by field, except
//   fields this PC also changed and hasn't pushed yet (those win and are pushed next). Rows written by
//   the sync don't trigger dirty (sync_ctx.applying), so nothing echoes back.
// Quota (Spark: 50k reads / 20k writes a day): writes are batched + diffed, progress only rides on
//   lease renewals, activity is batched every 15 s and capped per day, videos are listened to with two
//   narrow queries (unfinished + changed in the last ~36 h) instead of the whole history.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { encryptString, decryptString } = require('./crypto');
const { withTimeout } = require('./store/common');

const newId = () => crypto.randomBytes(15).toString('base64').replace(/[+/=]/g, c => ({ '+': 'A', '/': 'B', '=': '' }[c])).slice(0, 20);
const J = v => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (_) { return d; } };

const COARSE = { queued: 'queued', ready: 'queued', awaiting_approval: 'queued', ai: 'writing', uploading: 'uploading', done: 'done', failed: 'failed', missing: 'failed', skipped: 'skipped' };
const LOCAL_STATUSES = new Set(Object.keys(COARSE));
const IMPORTANT_KINDS = new Set(['published', 'failed', 'needs_you', 'approval', 'limit', 'channel', 'link', 'cloud', 'takeover', 'proxy']);

class CloudSync {
  /**
   * @param {object} o
   * @param {object} o.app            UploadPilotApp (db, settings, events, profiles, dataDir)
   * @param {object} o.store
   * @param {string} o.root           users/<uid>
   * @param {string} o.pcId
   * @param {string} o.pcName
   * @param {() => string|null} o.passphrase
   * @param {number} [o.pushMs=2000]
   * @param {number} [o.activityFlushMs=15000]
   */
  constructor(o) {
    Object.assign(this, { pushMs: 2000, activityFlushMs: 15000, activityDailyCap: 1500, ...o });
    this.db = o.app.db;
    this.unsubs = [];
    this.remoteActivity = [];
    this.pcs = new Map();
    this.pendingVideos = new Map();   // video docs whose channel hasn't arrived yet
    this.activityBuf = [];
    this.activityToday = { day: '', n: 0 };
    this.lastPushAt = 0; this.lastPushError = null; this.pushing = null;
    this.initialLoaded = { channels: false, profiles: false, videos: false };
    this.counters = { pushedDocs: 0, appliedDocs: 0, skippedWrites: 0 };
    this.onChange = o.onChange || (() => {});
  }

  p(coll, id) { return `${this.root}/${coll}/${id}`; }
  get S() { return this.store.SERVER_TS; }
  _meta() { return { updatedAt: this.S, updatedBy: this.pcId }; }
  _overBudget() { const st = this.store.stats.snapshot(); const b = this.app.settings.get('cloud'); return st.writes > (b.writeBudget || 18000); }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    this._assignIds();
    await this.pushNow().catch(e => { this.lastPushError = e.message; });
    this._watchAll();
    this._timer = setInterval(() => this.pushNow().catch(e => { this.lastPushError = e.message; }), this.pushMs);
    this._actTimer = setInterval(() => this.flushActivity().catch(() => {}), this.activityFlushMs);
    this._rewatchTimer = setInterval(() => this._rewatchVideos(), 12 * 3600e3);
    for (const t of [this._timer, this._actTimer, this._rewatchTimer]) if (t.unref) t.unref();
    this._onEvent = ev => this._queueActivity(ev);
    this.app.events.on('event', this._onEvent);
  }

  async stop() {
    clearInterval(this._timer); clearInterval(this._actTimer); clearInterval(this._rewatchTimer);
    if (this._onEvent) this.app.events.off('event', this._onEvent);
    for (const u of [...this.unsubs, ...(this._videoUnsubs || [])]) { try { u(); } catch (_) { /* ignore */ } }
    this.unsubs = []; this._videoUnsubs = [];
    if (this.pushing) await this.pushing.catch(() => {});
    await this.pushNow().catch(() => {});
    await this.flushActivity().catch(() => {});
  }

  _watchAll() {
    const w = (coll, q, fn, key) => this.unsubs.push(this.store.watch(`${this.root}/${coll}`, q, ch => { try { fn(ch); } catch (e) { this.app.events.warn(`Cloud sync (${coll}): ${e.message}`, { kind: 'sync' }); } if (key) this.initialLoaded[key] = true; this.onChange(coll); }, e => this.app.events.warn(`Cloud listener ${coll}: ${e.message}`, { kind: 'sync' })));
    w('profiles', {}, ch => this._applyProfiles(ch), 'profiles');
    w('channels', {}, ch => this._applyChannels(ch), 'channels');
    this._rewatchVideos();
    w('activity', { orderBy: ['ts', 'desc'], limit: 40 }, ch => {
      for (const c of ch) { if (c.type === 'removed') this.remoteActivity = this.remoteActivity.filter(a => a.id !== c.id); else if (c.data.pcId !== this.pcId) { this.remoteActivity = this.remoteActivity.filter(a => a.id !== c.id); this.remoteActivity.push({ id: c.id, ...c.data }); } }
      this.remoteActivity.sort((a, b) => b.ts - a.ts); this.remoteActivity = this.remoteActivity.slice(0, 40);
    });
    w('pcs', {}, ch => { for (const c of ch) { if (c.type === 'removed') this.pcs.delete(c.id); else this.pcs.set(c.id, c.data); } });
  }

  _rewatchVideos() {
    for (const u of this._videoUnsubs || []) { try { u(); } catch (_) { /* ignore */ } }
    const since = Date.now() - 36 * 3600e3;
    const apply = ch => { try { this._applyVideos(ch); } catch (e) { this.app.events.warn(`Cloud sync (videos): ${e.message}`, { kind: 'sync' }); } this.initialLoaded.videos = true; this.onChange('videos'); };
    const err = e => this.app.events.warn(`Cloud listener videos: ${e.message}`, { kind: 'sync' });
    this._videoUnsubs = [
      this.store.watch(`${this.root}/videos`, { where: [['status', 'in', ['queued', 'writing', 'uploading', 'failed']]] }, apply, err),
      this.store.watch(`${this.root}/videos`, { where: [['updatedAt', '>=', this.store.ts ? this.store.ts(since) : since]] }, apply, err),
    ];
  }

  // ------------------------------------------------------------------ local -> cloud
  _assignIds() {
    for (const t of ['profiles', 'channels', 'videos']) {
      for (const r of this.db.all(`SELECT id FROM ${t} WHERE cloud_id IS NULL`)) this.db.run(`UPDATE ${t} SET cloud_id=?, dirty=1 WHERE id=?`, newId(), r.id);
    }
  }

  profileDoc(r) {
    const proxy = r.proxy_id ? this.db.get('SELECT * FROM proxies WHERE id=?', r.proxy_id) : null;
    let proxyDoc = null;
    if (proxy) {
      proxyDoc = { host: proxy.host, port: proxy.port, username: proxy.username || '' };
      const pass = this.passphrase();
      const shadow = parse(r.cloud_shadow, {});
      // keep the previous ciphertext when the password didn't change (no write churn: AES-GCM is randomized)
      if (shadow.proxy && shadow.proxy.host === proxy.host && shadow.proxy.port === proxy.port && shadow.proxy.username === (proxy.username || '') && shadow.proxy._pw === sha(proxy.password || '')) { proxyDoc.passwordEnc = shadow.proxy.passwordEnc || null; }
      else proxyDoc.passwordEnc = pass && proxy.password ? encryptString(proxy.password, pass) : null;
      proxyDoc._pw = sha(proxy.password || '');
    }
    return { number: r.number, name: r.name, proxy: proxyDoc, createdAt: r.created_at };
  }
  channelDoc(r) {
    const prof = r.profile_id ? this.db.get('SELECT cloud_id FROM profiles WHERE id=?', r.profile_id) : null;
    const mine = r.folder && (!r.folder_pc || r.folder_pc === this.pcId);
    return {
      name: r.name, handle: r.handle, ytChannelId: r.yt_channel_id, style: parse(r.style, {}), status: r.status, statusReason: r.status_reason,
      pausedUntil: r.paused_until, profileId: prof ? prof.cloud_id : null, createdAt: r.created_at,
      ...(mine ? { folder: r.folder, folderPc: this.pcId, folderPcName: this.pcName } : {}),
    };
  }
  videoDoc(r) {
    const ch = this.db.get('SELECT cloud_id FROM channels WHERE id=?', r.channel_id);
    return {
      channelId: ch ? ch.cloud_id : null, filename: r.filename, size: r.size,
      originPc: r.remote ? r.origin_pc : this.pcId, originPcName: r.remote ? r.origin_pc_name : this.pcName,
      status: COARSE[r.status] || 'queued', detail: r.status, scheduledAt: r.scheduled_at,
      title: r.title, description: r.description, tags: parse(r.tags, []), hashtags: parse(r.hashtags, []), edited: !!r.edited,
      aiStatus: r.ai_status, aiError: r.ai_error, url: r.url, error: r.error, attempts: r.attempts || 0, uploadedAt: r.uploaded_at,
      driveFileId: r.drive_file_id, createdAt: r.created_at,
    };
  }

  /** Push dirty rows + tombstones (diffed, batched). Safe to call any time; calls are serialized. */
  pushNow() {
    if (this.pushing) return this.pushing;
    this.pushing = this._push().finally(() => { this.pushing = null; });
    return this.pushing;
  }

  async _push() {
    this._assignIds();
    const ops = [], done = [];
    const plan = (table, coll, docFn) => {
      const rows = this.db.all(`SELECT * FROM ${table} WHERE dirty>0 LIMIT 400`);
      for (const r of rows) {
        this.db.run(`UPDATE ${table} SET dirty=2 WHERE id=?`, r.id);    // in flight; a new local edit sets it back to 1
        const doc = docFn(r);
        const shadow = parse(r.cloud_shadow, null);
        const diff = {};
        for (const [k, v] of Object.entries(doc)) if (!shadow || J(shadow[k]) !== J(v)) diff[k] = v;
        const next = { ...(shadow || {}), ...doc };
        if (!Object.keys(diff).length) { this.counters.skippedWrites++; done.push({ table, id: r.id, shadow: next }); continue; }
        if (table === 'videos' && !doc.channelId) { done.push({ table, id: r.id, shadow, keepDirty: true }); continue; }
        // the proxy password hash only lives in the shadow
        const wire = { ...diff, ...this._meta() };
        if (wire.proxy) { wire.proxy = { ...wire.proxy }; delete wire.proxy._pw; }
        // status is required by the rules on every video write
        if (table === 'videos' && !('status' in wire)) wire.status = doc.status;
        ops.push({ type: 'set', path: this.p(coll, r.cloud_id), data: wire, merge: true });
        done.push({ table, id: r.id, shadow: next });
      }
    };
    plan('profiles', 'profiles', r => this.profileDoc(r));
    plan('channels', 'channels', r => this.channelDoc(r));
    plan('videos', 'videos', r => this.videoDoc(r));
    const tombs = this.db.all('SELECT * FROM sync_tombstones LIMIT 200');
    for (const t of tombs) ops.push({ type: 'delete', path: this.p(t.kind, t.cloud_id) });
    if (!this._overBudget()) ops.push(...this._planOps());
    try {
      if (ops.length) await withTimeout(this.store.batch(ops), 30000, 'cloud push');
      for (const d of done) {
        if (d.keepDirty) { this.db.run(`UPDATE ${d.table} SET dirty=1 WHERE id=? AND dirty=2`, d.id); continue; }
        this.db.run(`UPDATE ${d.table} SET cloud_shadow=? WHERE id=?`, JSON.stringify(d.shadow), d.id);
        this.db.run(`UPDATE ${d.table} SET dirty=0 WHERE id=? AND dirty=2`, d.id);
      }
      for (const t of tombs) this.db.run('DELETE FROM sync_tombstones WHERE kind=? AND cloud_id=?', t.kind, t.cloud_id);
      this.counters.pushedDocs += ops.length;
      this.lastPushAt = Date.now(); this.lastPushError = null;
    } catch (e) {
      for (const d of done) this.db.run(`UPDATE ${d.table} SET dirty=1 WHERE id=? AND dirty=2`, d.id);
      this.lastPushError = e.message;
      throw e;
    }
    return ops.length;
  }

  /** plans/{channelId}: the next upcoming slots of channels whose folder is on this PC (written only when changed). */
  _planOps() {
    const ops = [];
    this._planHash = this._planHash || new Map();
    for (const c of this.db.all(`SELECT * FROM channels WHERE cloud_id IS NOT NULL AND folder IS NOT NULL AND (folder_pc IS NULL OR folder_pc=?)`, this.pcId)) {
      const slots = this.db.all(`SELECT cloud_id, title, filename, scheduled_at, status FROM videos WHERE channel_id=? AND scheduled_at IS NOT NULL AND status IN ('queued','ai','awaiting_approval','ready','uploading') ORDER BY scheduled_at LIMIT 10`, c.id)
        .map(v => ({ videoId: v.cloud_id, title: v.title || v.filename, at: v.scheduled_at, status: COARSE[v.status] }));
      const perDay = parse(c.style, {}).perDay || this.app.settings.get('videosPerDay');
      const h = J({ slots, perDay });
      if (this._planHash.get(c.cloud_id) === h) continue;
      this._planHash.set(c.cloud_id, h);
      ops.push({ type: 'set', path: this.p('plans', c.cloud_id), data: { channelId: c.cloud_id, perDay, slots, next: slots[0] || null, ...this._meta() }, merge: false });
    }
    return ops;
  }

  // ------------------------------------------------------------------ cloud -> local
  _fieldsChanged(doc, shadow) { return Object.keys(doc).filter(k => k !== 'updatedAt' && k !== 'updatedBy' && (!shadow || J(shadow[k]) !== J(doc[k]))); }
  /** Which remote-changed fields may be applied: skip the ones this PC changed and hasn't pushed. */
  _applicable(row, doc, localDoc) {
    const shadow = parse(row && row.cloud_shadow, null);
    const changed = this._fieldsChanged(doc, shadow);
    if (!row || !row.dirty || !shadow) return changed;
    return changed.filter(k => J(localDoc[k]) === J(shadow[k]));   // local didn't touch it -> remote wins
  }
  _newShadow(row, doc, skipped) {
    const shadow = { ...(parse(row && row.cloud_shadow, {}) || {}) };
    for (const [k, v] of Object.entries(doc)) if (k !== 'updatedAt' && k !== 'updatedBy' && !skipped.includes(k)) shadow[k] = v;
    return shadow;
  }

  _applyProfiles(changes) {
    this.db.applying(() => this.db.tx(() => {
      for (const c of changes) {
        const row = this.db.get('SELECT * FROM profiles WHERE cloud_id=?', c.id);
        if (c.type === 'removed') {
          if (row) { this.db.run('UPDATE channels SET profile_id=NULL WHERE profile_id=?', row.id); this.db.run('DELETE FROM profiles WHERE id=?', row.id); }
          continue;
        }
        const d = c.data;
        if (c.pending) continue;
        if (row && d.updatedBy === this.pcId && !row.dirty) { this._applyProfileState(row, d); continue; }
        const proxyId = d.proxy ? this._ensureProxy(d.proxy) : null;
        if (!row) {
          let number = d.number;
          if (this.db.get('SELECT id FROM profiles WHERE number=?', number)) number = (this.db.get('SELECT MAX(number) AS m FROM profiles').m || 0) + 1;
          const dir = path.join(this.app.dataDir, 'profiles', `profile-${String(number).padStart(4, '0')}`);
          const r = this.db.run('INSERT INTO profiles(number,name,data_dir,proxy_id,created_at,cloud_id,dirty) VALUES(?,?,?,?,?,?,0)', number, d.name, dir, proxyId, d.createdAt || Date.now(), c.id);
          const shadow = { ...d }; delete shadow.updatedAt; delete shadow.updatedBy; if (shadow.proxy) shadow.proxy = { ...shadow.proxy, _pw: sha(this._proxyPw(d.proxy) || '') };
          this.db.run('UPDATE profiles SET cloud_shadow=? WHERE id=?', JSON.stringify(shadow), r.lastInsertRowid);
          this._applyProfileState(this.db.get('SELECT * FROM profiles WHERE id=?', r.lastInsertRowid), d);
          this.counters.appliedDocs++;
          continue;
        }
        const local = this.profileDoc(row);
        const docCmp = { ...d, proxy: d.proxy ? { ...d.proxy, _pw: sha(this._proxyPw(d.proxy) || '') } : null };
        const ok = this._applicable(row, docCmp, local);
        if (ok.includes('name')) this.db.run('UPDATE profiles SET name=? WHERE id=?', d.name, row.id);
        if (ok.includes('proxy')) this.db.run('UPDATE profiles SET proxy_id=? WHERE id=?', proxyId, row.id);
        this.db.run('UPDATE profiles SET cloud_shadow=? WHERE id=?', JSON.stringify(this._newShadow(row, docCmp, this._fieldsChanged(docCmp, parse(row.cloud_shadow, null)).filter(k => !ok.includes(k)))), row.id);
        this._applyProfileState(row, d);
        this.counters.appliedDocs++;
      }
    }));
    this._relink();
  }
  _applyProfileState(row, d) {
    if (d.stateVersion && d.stateVersion !== row.cloud_state_version) this.db.run('UPDATE profiles SET cloud_state_version=?, cloud_state_hash=?, cloud_state_file=?, cloud_state_by=? WHERE id=?', d.stateVersion, d.stateHash || null, d.stateFileId || null, d.stateBy || null, row.id);
  }
  _proxyPw(p) { if (!p || !p.passwordEnc) return ''; const pass = this.passphrase(); if (!pass) return null; try { return decryptString(p.passwordEnc, pass); } catch (_) { return null; } }
  _ensureProxy(p) {
    const pw = this._proxyPw(p);
    this.db.run('INSERT OR IGNORE INTO proxies(host,port,username,password) VALUES(?,?,?,?)', p.host, p.port, p.username || '', pw || '');
    const row = this.db.get(`SELECT * FROM proxies WHERE host=? AND port=? AND IFNULL(username,'')=?`, p.host, p.port, p.username || '');
    if (pw && row.password !== pw) this.db.run(`UPDATE proxies SET password=?, status='unknown' WHERE id=?`, pw, row.id);
    if (pw === null && !row.password) this.app.events.warn(`Proxy ${p.host}:${p.port} came from another PC but its password can't be read — set the same sync passphrase in Settings → Cloud`, { kind: 'sync' });
    return row.id;
  }

  _applyChannels(changes) {
    this.db.applying(() => this.db.tx(() => {
      for (const c of changes) {
        const row = this.db.get('SELECT * FROM channels WHERE cloud_id=?', c.id);
        if (c.type === 'removed') { if (row) this.db.run('DELETE FROM channels WHERE id=?', row.id); continue; }
        const d = c.data;
        if (c.pending) continue;
        const prof = d.profileId ? this.db.get('SELECT id FROM profiles WHERE cloud_id=?', d.profileId) : null;
        if (!row) {
          const r = this.db.run(`INSERT INTO channels(profile_id,name,handle,yt_channel_id,folder,style,status,status_reason,paused_until,created_at,cloud_id,folder_pc,folder_pc_name,dirty) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
            prof ? prof.id : null, d.name, d.handle, d.ytChannelId, d.folderPc === this.pcId ? d.folder : null, JSON.stringify(d.style || {}), d.status || 'active', d.statusReason, d.pausedUntil, d.createdAt || Date.now(), c.id, d.folderPc || null, d.folderPcName || null);
          const shadow = { ...d }; delete shadow.updatedAt; delete shadow.updatedBy;
          this.db.run('UPDATE channels SET cloud_shadow=? WHERE id=?', JSON.stringify(shadow), r.lastInsertRowid);
          this.counters.appliedDocs++;
          continue;
        }
        if (d.updatedBy === this.pcId && !row.dirty) { const shadow = this._newShadow(row, d, []); this.db.run('UPDATE channels SET cloud_shadow=? WHERE id=?', JSON.stringify(shadow), row.id); continue; }
        const ok = this._applicable(row, d, this.channelDoc(row));
        const set = (col, v) => this.db.run(`UPDATE channels SET ${col}=? WHERE id=?`, v, row.id);
        if (ok.includes('name')) set('name', d.name);
        if (ok.includes('handle')) set('handle', d.handle);
        if (ok.includes('ytChannelId')) set('yt_channel_id', d.ytChannelId);
        if (ok.includes('style')) set('style', JSON.stringify(d.style || {}));
        if (ok.includes('status')) set('status', d.status);
        if (ok.includes('statusReason')) set('status_reason', d.statusReason);
        if (ok.includes('pausedUntil')) set('paused_until', d.pausedUntil);
        if (ok.includes('profileId')) set('profile_id', prof ? prof.id : null);
        if (ok.includes('folderPc') || ok.includes('folderPcName')) { set('folder_pc', d.folderPc || null); set('folder_pc_name', d.folderPcName || null); if (d.folderPc && d.folderPc !== this.pcId && row.folder_pc === this.pcId) set('folder', null); }
        this.db.run('UPDATE channels SET cloud_shadow=? WHERE id=?', JSON.stringify(this._newShadow(row, d, this._fieldsChanged(d, parse(row.cloud_shadow, null)).filter(k => !ok.includes(k)))), row.id);
        this.counters.appliedDocs++;
      }
    }));
    this._relink();
    if (this.pendingVideos.size) { const p = [...this.pendingVideos.values()]; this.pendingVideos.clear(); this._applyVideos(p); }
  }

  /** channels that arrived before their profile */
  _relink() {
    this.db.applying(() => {
      for (const ch of this.db.all('SELECT id, cloud_shadow FROM channels WHERE profile_id IS NULL AND cloud_shadow IS NOT NULL')) {
        const pid = parse(ch.cloud_shadow, {}).profileId;
        if (!pid) continue;
        const prof = this.db.get('SELECT id FROM profiles WHERE cloud_id=?', pid);
        if (prof) this.db.run('UPDATE channels SET profile_id=? WHERE id=?', prof.id, ch.id);
      }
    });
  }

  _applyVideos(changes) {
    const doneMoves = [];
    this.db.applying(() => this.db.tx(() => {
      for (const c of changes) {
        if (c.type === 'removed') continue;   // leaving a filtered query is not a delete
        if (c.pending) continue;
        const d = c.data;
        const row = this.db.get('SELECT * FROM videos WHERE cloud_id=?', c.id);
        const ch = d.channelId ? this.db.get('SELECT id FROM channels WHERE cloud_id=?', d.channelId) : null;
        if (!ch) { this.pendingVideos.set(c.id, c); continue; }
        const detail = LOCAL_STATUSES.has(d.detail) && COARSE[d.detail] === d.status ? d.detail : (d.status === 'writing' ? 'ai' : d.status === 'uploading' ? 'uploading' : d.status === 'queued' ? (d.title ? 'ready' : 'queued') : d.status);
        if (!row) {
          const remote = d.originPc !== this.pcId ? 1 : 0;
          const r = this.db.run(`INSERT OR IGNORE INTO videos(channel_id,path,thumb,filename,size,status,scheduled_at,ai_status,ai_error,title,description,tags,hashtags,edited,url,attempts,error,created_at,uploaded_at,cloud_id,remote,origin_pc,origin_pc_name,drive_file_id,dirty)
            VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,0)`,
            ch.id, `cloud:${c.id}`, d.filename || 'video', d.size || 0, detail, d.scheduledAt ?? null, d.aiStatus || 'pending', d.aiError || null, d.title || null, d.description || null, JSON.stringify(d.tags || []), JSON.stringify(d.hashtags || []), d.edited ? 1 : 0, d.url || null, d.attempts || 0, d.error || null, d.createdAt || Date.now(), d.uploadedAt || null, c.id, d.originPc || null, d.originPcName || null, d.driveFileId || null);
          if (!remote) this.app.events.warn(`Video ${d.filename} is listed in the cloud as from this PC but isn't in the local database — kept as a cloud copy`, { kind: 'sync' });
          if (r.changes) { const shadow = { ...d }; delete shadow.updatedAt; delete shadow.updatedBy; this.db.run('UPDATE videos SET cloud_shadow=? WHERE cloud_id=?', JSON.stringify(shadow), c.id); }
          this.counters.appliedDocs++;
          continue;
        }
        if (d.updatedBy === this.pcId && !row.dirty) { this.db.run('UPDATE videos SET cloud_shadow=? WHERE id=?', JSON.stringify(this._newShadow(row, d, [])), row.id); continue; }
        const ok = this._applicable(row, d, this.videoDoc(row));
        const sets = [], vals = [];
        const set = (col, v) => { sets.push(`${col}=?`); vals.push(v === undefined ? null : v); };
        if (ok.includes('detail') || ok.includes('status')) set('status', detail);
        if (ok.includes('scheduledAt')) set('scheduled_at', d.scheduledAt ?? null);
        if (ok.includes('title')) set('title', d.title || null);
        if (ok.includes('description')) set('description', d.description || null);
        if (ok.includes('tags')) set('tags', JSON.stringify(d.tags || []));
        if (ok.includes('hashtags')) set('hashtags', JSON.stringify(d.hashtags || []));
        if (ok.includes('edited')) set('edited', d.edited ? 1 : 0);
        if (ok.includes('aiStatus')) set('ai_status', d.aiStatus || 'pending');
        if (ok.includes('aiError')) set('ai_error', d.aiError || null);
        if (ok.includes('url')) set('url', d.url || null);
        if (ok.includes('error')) set('error', d.error || null);
        if (ok.includes('attempts')) set('attempts', d.attempts || 0);
        if (ok.includes('uploadedAt')) set('uploaded_at', d.uploadedAt || null);
        if (ok.includes('driveFileId')) set('drive_file_id', d.driveFileId || null);
        if (sets.length) this.db.run(`UPDATE videos SET ${sets.join(', ')} WHERE id=?`, ...vals, row.id);
        this.db.run('UPDATE videos SET cloud_shadow=? WHERE id=?', JSON.stringify(this._newShadow(row, d, this._fieldsChanged(d, parse(row.cloud_shadow, null)).filter(k => !ok.includes(k)))), row.id);
        // another PC published a video whose file lives here: tidy it into Done/ like a local upload would
        if (detail === 'done' && row.status !== 'done' && !row.remote) doneMoves.push(row.id);
        this.counters.appliedDocs++;
      }
    }));
    for (const id of doneMoves) { try { this.onRemoteDone && this.onRemoteDone(id); } catch (_) { /* ignore */ } }
  }

  // ------------------------------------------------------------------ activity
  _queueActivity(ev) {
    if (!IMPORTANT_KINDS.has(ev.kind) && ev.level !== 'error' && ev.level !== 'success') return;
    if (ev.fromCloud) return;
    this.activityBuf.push(ev);
    if (this.activityBuf.length > 200) this.activityBuf.shift();
  }
  async flushActivity() {
    if (!this.activityBuf.length) return 0;
    const day = new Date().toISOString().slice(0, 10);
    if (this.activityToday.day !== day) this.activityToday = { day, n: 0 };
    if (this.activityToday.n >= this.activityDailyCap || this._overBudget()) { this.activityBuf = []; return 0; }
    const batch = this.activityBuf.splice(0, Math.min(50, this.activityDailyCap - this.activityToday.n));
    const ops = batch.map(ev => {
      const ch = ev.channel_id ? this.db.get('SELECT cloud_id FROM channels WHERE id=?', ev.channel_id) : null;
      return { type: 'set', path: this.p('activity', `${ev.ts}-${this.pcId.slice(0, 6)}-${ev.id}`), data: { ts: ev.ts, level: ev.level, kind: ev.kind, message: String(ev.message).slice(0, 1000), pcId: this.pcId, pcName: this.pcName, channelId: ch ? ch.cloud_id : null } };
    });
    try { await withTimeout(this.store.batch(ops), 30000, 'activity push'); this.activityToday.n += ops.length; }
    catch (e) { this.activityBuf.unshift(...batch); throw e; }
    return ops.length;
  }

  status() {
    const dirty = ['profiles', 'channels', 'videos'].reduce((n, t) => n + this.db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE dirty>0`).n, 0);
    return { lastPushAt: this.lastPushAt, lastPushError: this.lastPushError, pending: dirty, loaded: { ...this.initialLoaded }, ...this.counters, pcs: [...this.pcs.entries()].map(([id, d]) => ({ id, name: d.name, lastSeen: d.lastSeen, version: d.version || null, me: id === this.pcId })) };
  }
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

module.exports = { CloudSync, COARSE, newId };
