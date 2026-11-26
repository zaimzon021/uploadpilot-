'use strict';
// UploadPilot core: wires DB, profiles, autopilot (scan/plan/watch/AI/lanes), link wizard and API.
// Runs inside Electron's main process or standalone (src/headless.js).
const fs = require('fs');
const path = require('path');
const { DB } = require('./db');
const { Settings } = require('./settings');
const { Events } = require('./events');
const { ProfileManager } = require('../profiles/profileManager');
const { scanFolder, findThumb, moveToDone } = require('../autopilot/scanner');
const { watchFolder } = require('../autopilot/watcher');
const { buildPlan } = require('../autopilot/planner');
const { LaneScheduler } = require('../autopilot/laneScheduler');
const { GeminiClient } = require('../ai/gemini');
const { ChannelRunner } = require('../upload/channelRunner');
const { LinkWizard, normalizeStyle } = require('../wizard/linkWizard');
const { startOfDay, addDays, inWindow, dayKey } = require('../util/time');
const { proxyLabel } = require('../proxy/parse');
const { CloudService } = require('../cloud');
const { makeLowRes } = require('../ai/lowres');
const { rotateLogs } = require('../util/logRotate');

class UploadPilotApp {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {object} [o.settings]        overrides applied at startup (tests)
   * @param {Function} [o.launcher]      browser launcher (tests)
   * @param {Function} [o.fetchImpl]     fetch used by Gemini (tests)
   * @param {object} [o.engineOpts]      upload engine options e.g. {speed}
   * @param {boolean} [o.startApi=true]
   * @param {object} [o.safeStorage]      Electron safeStorage (secrets sealed with Windows DPAPI)
   * @param {(url:string)=>any} [o.openExternal]   system browser (Google Drive sign-in)
   * @param {() => number} [o.idleTimeProvider]    seconds since the user last touched mouse/keyboard (Electron powerMonitor)
   * @param {object} [o.cloud]            CloudService options for tests: {storeFactory, fetchImpl, driveBaseUrl, googleEndpoints, leaseOpts, syncOpts}
   */
  constructor(o) {
    this.o = o;
    this.dataDir = o.dataDir;
    this.logsDir = path.join(this.dataDir, 'logs');
    fs.mkdirSync(this.logsDir, { recursive: true });
    this.db = new DB(path.join(this.dataDir, 'uploadpilot.db'));
    this.settings = new Settings(this.db);
    if (o.settings) this.settings.set(o.settings);
    this.events = new Events(this.db, this.logsDir);
    this.profiles = new ProfileManager({ db: this.db, settings: this.settings, events: this.events, dataDir: this.dataDir, launcher: o.launcher, proxyChecker: o.proxyChecker });
    this.cloud = new CloudService({ app: this, safeStorage: o.safeStorage, openExternal: o.openExternal, resourcesPath: o.resourcesPath, ...(o.cloud || {}) });
    this.runner = new ChannelRunner({ db: this.db, settings: this.settings, events: this.events, profiles: this.profiles, logsDir: this.logsDir, engineOpts: o.engineOpts || {}, cloud: this.cloud });
    this.profiles.hooks = {
      beforeOpen: (prof, purpose) => this.cloud.beforeOpenProfile(prof, purpose),
      afterLaunch: (prof, sess) => this.cloud.afterLaunchProfile(prof, sess),
      beforeClose: (prof, sess) => this.cloud.beforeCloseProfile(prof, sess),
      afterClose: prof => this.cloud.afterCloseProfile(prof),
    };
    this.wizard = new LinkWizard(this);
    this.watchers = new Map();
    this.aiBusy = new Set(); this.aiNextTry = new Map();
    this.started = false;
  }

  // ---------------- lifecycle ----------------
  async start({ api = this.o.startApi !== false } = {}) {
    if (this.started) return;
    this.started = true;
    // crash recovery: anything this PC left "uploading"/"ai" goes back to its queue
    // (cloud copies of other PCs' videos are left alone: their own PC or a lease expiry handles them)
    this.db.run(`UPDATE videos SET status='ready' WHERE status='uploading' AND remote=0`);
    this.db.run(`UPDATE videos SET status='queued', ai_status='pending' WHERE status='ai' AND remote=0`);
    this.cacheDir = path.join(this.dataDir, 'cache');
    this._rotate();
    this._rotateTimer = setInterval(() => this._rotate(), 6 * 3600e3);
    if (this._rotateTimer.unref) this._rotateTimer.unref();
    this.db.run(`UPDATE runs SET result='interrupted', ended_at=? WHERE result='running'`, Date.now());
    if (api) {
      const { startApiServer } = require('../api/server');
      this.api = await startApiServer(this, { port: this.o.apiPort ?? this.settings.get('apiPort') });
    }
    for (const ch of this.db.all(`SELECT id FROM channels WHERE folder IS NOT NULL AND status IN ('active','paused','needs_you')`)) {
      try { this.ingest(ch.id); this.watch(ch.id); } catch (e) { this.events.warn(`Folder scan failed: ${e.message}`, { channelId: ch.id }); }
    }
    this._buildScheduler();
    if (!this.settings.get('autopilotPaused')) this.scheduler.start();
    this._aiTimer = setInterval(() => this.aiTick().catch(e => this.events.error(`AI worker: ${e.message}`)), this.settings.get('aiTickMs'));
    this._planTimer = setInterval(() => this.replanAll(), 15 * 60000);
    setTimeout(() => this.aiTick().catch(() => {}), 500);
    this.events.info(`UploadPilot started (db: ${this.db.driver})`, { kind: 'app' });
    // cloud sign-in / sync starts in the background; the app works locally meanwhile
    this.cloudReady = this.cloud.start().then(st => { if (this.scheduler) this.scheduler.wake(); return st; })
      .catch(e => { this.events.error(`Cloud: ${e.message}`, { kind: 'cloud' }); return this.cloud.status(); });
    this.cloud.on('change', () => this.events.emit('cloud', { ts: Date.now() }));
  }

  _rotate() {
    try { rotateLogs({ logsDir: this.logsDir, db: this.db, days: this.settings.get('logRetentionDays') || 14, cacheDir: this.cacheDir }); } catch (_) { /* never fatal */ }
  }

  /** "Pause when I'm using the PC": true while the user touched mouse/keyboard in the last N minutes. */
  userActive() {
    const p = this.settings.get('pauseWhenActive');
    if (!p || !p.enabled || !this.o.idleTimeProvider) return false;
    let idleSec = 0; try { idleSec = this.o.idleTimeProvider(); } catch (_) { return false; }
    return idleSec < (p.idleMinutes || 5) * 60;
  }

  /** Another PC published a video whose file lives here: move it into Done/ like a local upload. */
  onRemoteDone(videoId) {
    const v = this.db.get('SELECT * FROM videos WHERE id=?', videoId);
    if (!v || v.remote || !this.settings.get('upload').moveDoneFiles || !fs.existsSync(v.path)) return;
    try { const m = moveToDone(v.path, v.thumb); this.db.applying(() => this.db.run('UPDATE videos SET path=?, thumb=? WHERE id=?', m.video || v.path, m.thumb || v.thumb, v.id)); this.events.info(`${v.filename} was published by another PC — moved to Done`, { channelId: v.channel_id, kind: 'scan' }); } catch (_) { /* ignore */ }
  }

  _buildScheduler() {
    const s = this.settings.all();
    this.scheduler = new LaneScheduler({
      lanes: s.lanes,
      delayRangeMin: s.delayRangeMin,
      idleMs: s.schedulerTickMs,
      cooldownMs: this.o.cooldownMs ?? 10 * 60000,
      getAllChannels: () => this.db.all(`SELECT id FROM channels WHERE status='active'`).map(r => r.id),
      getDueChannels: () => this.dueChannelIds(),
      canStart: () => !this.userActive(),
      runChannel: (id, lane) => this.runner.run(id, lane),
      onEvent: ev => { if (ev.type === 'wait') this.events.info(`Lane ${ev.lane + 1}: waiting ${Math.round(ev.ms / 1000)}s before next channel`, { kind: 'lane' }); if (ev.type === 'error') this.events.error(`Lane ${ev.lane + 1}: ${ev.error}`, { channelId: ev.channelId, kind: 'lane' }); },
    });
  }

  async restartScheduler() {
    if (this.scheduler) await this.scheduler.stop();
    this._buildScheduler();
    if (!this.settings.get('autopilotPaused')) this.scheduler.start();
  }

  async stop() {
    clearInterval(this._aiTimer); clearInterval(this._planTimer); clearInterval(this._rotateTimer);
    if (this.scheduler) await this.scheduler.stop();
    for (const w of this.watchers.values()) await w.close();
    this.watchers.clear();
    await this.wizard.closeAll();
    await this.profiles.closeAll();
    if (this.cloudReady) await this.cloudReady.catch(() => {});
    await this.cloud.stop().catch(() => {});
    if (this.api) await this.api.close();
    this.db.close();
    this.started = false;
  }

  // ---------------- autopilot pieces ----------------
  dueChannelIds(now = Date.now()) {
    const s = this.settings.all();
    if (s.autopilotPaused || !inWindow(now, s.uploadWindow)) return [];
    const rows = this.db.all(`SELECT c.id AS cid, c.profile_id, v.* FROM channels c JOIN videos v ON v.channel_id=c.id
      WHERE c.status='active' AND (c.paused_until IS NULL OR c.paused_until<=?) AND v.status='ready' AND v.scheduled_at<=?`, now, now);
    const ids = new Set();
    for (const r of rows) {
      if (ids.has(r.cid)) continue;
      if (this.profiles.isOpen(r.profile_id) && this.profiles.session(r.profile_id).purpose !== 'auto') continue;
      if (r.remote && !this.cloud.runnableHere(r, now)) continue;                    // file is on another PC
      if (this.cloud.online && this.cloud.holderName(`profile_${this.db.get('SELECT cloud_id FROM profiles WHERE id=?', r.profile_id)?.cloud_id}`)?.me === false) continue; // profile open elsewhere
      ids.add(r.cid);
    }
    return [...ids];
  }

  /** Scan the channel folder, add new videos, then plan. */
  ingest(channelId) {
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', channelId);
    if (!ch || !ch.folder) return { added: 0 };
    const files = scanFolder(ch.folder);
    let added = 0;
    this.db.tx(() => {
      for (const f of files) {
        const r = this.db.run('INSERT OR IGNORE INTO videos(channel_id,path,thumb,filename,size,status,created_at) VALUES(?,?,?,?,?,?,?)', channelId, f.path, f.thumb, f.filename, f.size, 'queued', Date.now());
        added += r.changes;
        if (!r.changes && f.thumb) this.db.run('UPDATE videos SET thumb=? WHERE channel_id=? AND path=? AND thumb IS NULL', f.thumb, channelId, f.path);
      }
    });
    if (added) this.events.info(`${ch.name || 'Channel'}: ${added} new video(s) found`, { channelId, kind: 'scan' });
    this.plan(channelId);
    return { added, total: files.length };
  }

  addVideoFile(channelId, file) {
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', channelId);
    let size = 0; try { size = fs.statSync(file).size; } catch (_) { return; }
    const r = this.db.run('INSERT OR IGNORE INTO videos(channel_id,path,thumb,filename,size,status,created_at) VALUES(?,?,?,?,?,?,?)', channelId, file, findThumb(file), path.basename(file), size, 'queued', Date.now());
    if (r.changes) { this.events.info(`${ch?.name || 'Channel'}: new video ${path.basename(file)} added to the plan`, { channelId, kind: 'scan' }); this.plan(channelId); }
  }

  watch(channelId) {
    if (this.watchers.has(channelId)) return;
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', channelId);
    if (!ch?.folder) return;
    const w = watchFolder(ch.folder, {
      stabilityMs: this.o.watchStabilityMs ?? 3000,
      usePolling: !!this.o.watchPolling,               // native OS events; polling only for tests on odd filesystems
      pollInterval: this.o.watchPollInterval ?? 1000,  // awaitWriteFinish size checks of a file still being copied
      onVideo: p => this.addVideoFile(channelId, p),
      onThumb: p => {
        const base = path.basename(p, path.extname(p)).toLowerCase();
        for (const v of this.db.all(`SELECT id, path FROM videos WHERE channel_id=? AND thumb IS NULL AND status NOT IN ('done')`, channelId)) {
          if (path.basename(v.path, path.extname(v.path)).toLowerCase() === base) this.db.run('UPDATE videos SET thumb=? WHERE id=?', p, v.id);
        }
      },
    });
    this.watchers.set(channelId, w);
  }

  plan(channelId, now = Date.now()) {
    const s = this.settings.all();
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', channelId);
    const style = JSON.parse(ch?.style || '{}');
    const perDay = style.perDay || s.videosPerDay;
    const unscheduled = this.db.all(`SELECT id, filename FROM videos WHERE channel_id=? AND scheduled_at IS NULL AND remote=0 AND status IN ('queued','ready','awaiting_approval') ORDER BY id`, channelId);
    if (!unscheduled.length) return [];
    const { naturalCmp } = require('../autopilot/scanner');
    unscheduled.sort((a, b) => naturalCmp(a.filename, b.filename));
    // count uploads already done today too, so a day never gets more than perDay
    const existing = this.db.all(`SELECT COALESCE(uploaded_at, scheduled_at) AS t FROM videos WHERE channel_id=? AND scheduled_at IS NOT NULL AND status NOT IN ('skipped','missing') AND COALESCE(uploaded_at, scheduled_at)>=?`, channelId, startOfDay(now)).map(r => r.t);
    const plan = buildPlan({ videos: unscheduled, existing, perDay, window: s.uploadWindow, now });
    this.db.tx(() => { for (const p of plan) this.db.run('UPDATE videos SET scheduled_at=? WHERE id=?', p.scheduled_at, p.id); });
    return plan;
  }

  replanAll() { for (const ch of this.db.all(`SELECT id FROM channels WHERE folder IS NOT NULL`)) { try { this.plan(ch.id); } catch (_) {} } }

  geminiClient() {
    const s = this.settings.all();
    return new GeminiClient({
      keys: s.geminiKeys, model: s.geminiModel, baseUrl: s.geminiBaseUrl, fetchImpl: this.o.fetchImpl || globalThis.fetch,
      sleep: this.o.geminiSleep, pollMs: this.o.geminiPollMs ?? 3000,
      log: m => this.events.warn(m, { kind: 'ai' }),
      onUsage: (h, ok) => this.db.run(`INSERT INTO key_usage(key_hash,day,calls,errors) VALUES(?,?,1,?) ON CONFLICT(key_hash,day) DO UPDATE SET calls=calls+1, errors=errors+excluded.errors`, h, dayKey(Date.now()), ok ? 0 : 1),
    });
  }

  /** Generate AI metadata for today's (and lookahead) videos. */
  async aiTick(now = Date.now()) {
    const s = this.settings.all();
    if (!s.geminiKeys.length) return 0;
    if (this.userActive()) return 0;
    const until = startOfDay(addDays(now, 1 + (s.aiLookaheadDays || 0)));
    const free = (s.aiConcurrency || 2) - this.aiBusy.size;
    if (free <= 0) return 0;
    const rows = this.db.all(`SELECT v.*, c.style, c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id
      WHERE v.status='queued' AND v.remote=0 AND v.ai_status IN ('pending','retry') AND v.scheduled_at IS NOT NULL AND v.scheduled_at<? AND c.status IN ('active','paused','needs_you')
      ORDER BY v.scheduled_at LIMIT ?`, until, 50).filter(v => !this.aiBusy.has(v.id) && !((this.aiNextTry.get(v.id) || 0) > now)).slice(0, free);
    const client = this.geminiClient();
    await Promise.all(rows.map(v => this._aiOne(client, v)));
    return rows.length;
  }

  async _aiOne(client, v) {
    this.aiBusy.add(v.id);
    this.db.run(`UPDATE videos SET status='ai', ai_status='running' WHERE id=? AND status='queued'`, v.id);
    const style = JSON.parse(v.style || '{}');
    let low = null;
    try {
      // low-bandwidth: send Gemini a 360p copy (ffmpeg, idle priority, one at a time); original if that fails
      const lr = this.settings.get('geminiLowRes');
      let src = v.path;
      if (lr && lr.enabled) {
        low = await makeLowRes(v.path, { outDir: path.join(this.dataDir, 'cache', 'lowres'), height: lr.height, videoKbps: lr.videoKbps, configured: lr.ffmpegPath || '' });
        if (low.lowres) src = low.path; else if (low.reason && !this._lowresWarned) { this._lowresWarned = true; this.events.warn(`Low-bandwidth copy for Gemini not made (${low.reason}) — sending the original`, { kind: 'ai' }); }
      }
      const meta = await client.describeVideo(src, style, { maxAttempts: this.settings.get('geminiMaxAttempts'), displayName: v.filename });
      const cur = this.db.get('SELECT * FROM videos WHERE id=?', v.id);
      const next = style.mode === 'approval' ? 'awaiting_approval' : 'ready';
      if (cur.edited) this.db.run(`UPDATE videos SET status=?, ai_status='done' WHERE id=?`, next, v.id);
      else this.db.run(`UPDATE videos SET status=?, ai_status='done', ai_error=NULL, title=?, description=?, tags=?, hashtags=? WHERE id=?`, next, meta.title, meta.description, JSON.stringify(meta.tags), JSON.stringify(meta.hashtags), v.id);
      this.events.info(`${v.channel_name}: AI title ready — "${meta.title}"${next === 'awaiting_approval' ? ' (needs your OK)' : ''}`, { channelId: v.channel_id, kind: next === 'awaiting_approval' ? 'approval' : 'ai' });
    } catch (e) {
      const attempts = (v.ai_attempts || 0) + 1;
      const final = attempts >= 3;
      this.db.run(`UPDATE videos SET status='queued', ai_status=?, ai_error=?, ai_attempts=? WHERE id=?`, final ? 'failed' : 'retry', e.message.slice(0, 500), attempts, v.id);
      this.aiNextTry.set(v.id, Date.now() + 10 * 60000 * attempts);
      this.events.error(`${v.channel_name}: AI failed for ${v.filename}${final ? ' (gave up — edit the title by hand)' : ', will retry'}: ${e.message.split('\n')[0]}`, { channelId: v.channel_id, kind: 'ai' });
    } finally {
      this.aiBusy.delete(v.id);
      if (low && low.lowres) { try { fs.unlinkSync(low.path); } catch (_) { /* gone */ } }
    }
  }

  async activateChannel(channelId) {
    this.ingest(channelId);
    this.watch(channelId);
    this.aiTick().catch(() => {});
    if (this.scheduler) this.scheduler.wake();
  }

  // ---------------- channel / video ops (used by API + UI) ----------------
  listChannels() {
    const today = startOfDay(Date.now()), tomorrow = addDays(today, 1);
    return this.db.all(`SELECT c.*, f.number AS profile_number, p.host AS proxy_host, p.port AS proxy_port, p.status AS proxy_status,
      (SELECT COUNT(*) FROM videos v WHERE v.channel_id=c.id AND v.status='done' AND v.uploaded_at>=?) AS done_today,
      (SELECT COUNT(*) FROM videos v WHERE v.channel_id=c.id AND v.scheduled_at>=? AND v.scheduled_at<? AND v.status NOT IN ('skipped','missing')) AS planned_today,
      (SELECT COUNT(*) FROM videos v WHERE v.channel_id=c.id AND v.status IN ('queued','ai','awaiting_approval','ready')) AS queue,
      (SELECT COUNT(*) FROM videos v WHERE v.channel_id=c.id AND v.status='awaiting_approval') AS awaiting,
      (SELECT COUNT(*) FROM videos v WHERE v.channel_id=c.id AND v.status='failed') AS failed,
      (SELECT MIN(v.scheduled_at) FROM videos v WHERE v.channel_id=c.id AND v.status IN ('queued','ai','awaiting_approval','ready')) AS next_upload
      FROM channels c LEFT JOIN profiles f ON f.id=c.profile_id LEFT JOIN proxies p ON p.id=f.proxy_id ORDER BY c.id`, today, today, tomorrow)
      .map(c => {
        const nextV = this.db.get(`SELECT id, title, filename, scheduled_at, remote, origin_pc_name FROM videos WHERE channel_id=? AND status IN ('queued','ai','awaiting_approval','ready') AND scheduled_at IS NOT NULL ORDER BY scheduled_at LIMIT 1`, c.id);
        const pc = c.profile_id ? this.db.get('SELECT cloud_id FROM profiles WHERE id=?', c.profile_id) : null;
        let holder = this.cloud.online && pc && pc.cloud_id ? this.cloud.holderName(`profile_${pc.cloud_id}`) : null;
        if (!holder && this.cloud.online && c.cloud_id) { const l = this.cloud.leases.active().find(x => x.kind === 'video' && x.channelId === c.cloud_id); if (l) holder = { pcName: l.pcName, me: l.pcId === this.cloud.pcId, state: l.state || 'uploading' }; }
        const live = this.runner.live.get(c.id) || null;
        return {
          ...c, style: JSON.parse(c.style || '{}'), proxy: c.proxy_host ? `${c.proxy_host}:${c.proxy_port}` : null, live, profile_open: c.profile_id ? this.profiles.isOpen(c.profile_id) : false,
          next_video: nextV ? { id: nextV.id, title: nextV.title || nextV.filename, at: nextV.scheduled_at, from: nextV.remote ? nextV.origin_pc_name : null } : null,
          running_on: live ? { pcName: this.cloud.pcName, me: true, state: live.state } : holder ? { pcName: holder.pcName, me: holder.me, state: holder.state } : null,
          folder_pc_name: c.folder_pc && c.folder_pc !== this.cloud.pcId ? c.folder_pc_name : null,
        };
      });
  }
  getChannel(id) { return this.listChannels().find(c => c.id === +id) || null; }
  channelStatus(id) {
    const c = this.getChannel(id);
    if (!c) return null;
    return { id: c.id, name: c.name, status: c.status, reason: c.status_reason, paused_until: c.paused_until, live: c.live, next_upload: c.next_upload, done_today: c.done_today, planned_today: c.planned_today, queue: c.queue, failed: c.failed, profile_number: c.profile_number, proxy: c.proxy, profile_open: c.profile_open };
  }
  stopChannel(id) {
    const r = this.db.run(`UPDATE channels SET status='stopped', status_reason='Stopped by you' WHERE id=? AND status!='linking'`, id);
    if (r.changes) this.events.info(`Channel ${this.getChannel(id)?.name || id} stopped`, { channelId: +id, kind: 'channel' });
    return this.channelStatus(id);
  }
  resumeChannel(id) {
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', id);
    if (!ch) return null;
    if (!ch.folder && !(ch.folder_pc && ch.folder_pc !== this.cloud.pcId)) throw Object.assign(new Error('Channel has no folder yet — finish linking'), { status: 409 });
    this.db.run(`UPDATE channels SET status='active', status_reason=NULL, paused_until=NULL WHERE id=?`, id);
    this.events.info(`Channel ${ch.name || id} resumed`, { channelId: +id, kind: 'channel' });
    this.activateChannel(+id);
    return this.channelStatus(id);
  }
  async updateChannel(id, patch) {
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', id);
    if (!ch) return null;
    if (patch.style) this.db.run('UPDATE channels SET style=? WHERE id=?', JSON.stringify(normalizeStyle({ ...JSON.parse(ch.style || '{}'), ...patch.style })), id);
    if (patch.name) this.db.run('UPDATE channels SET name=? WHERE id=?', String(patch.name).slice(0, 200), id);
    if (patch.folder && patch.folder !== ch.folder) {
      if (!fs.existsSync(patch.folder)) throw Object.assign(new Error('Folder not found'), { status: 400 });
      this.db.run('UPDATE channels SET folder=? WHERE id=?', patch.folder, id);
      const w = this.watchers.get(+id); if (w) { await w.close(); this.watchers.delete(+id); }
      if (ch.status === 'active') await this.activateChannel(+id);
    }
    return this.getChannel(id);
  }
  async deleteChannel(id, { deleteProfile = false } = {}) {
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', id);
    if (!ch) return false;
    const w = this.watchers.get(+id); if (w) { await w.close(); this.watchers.delete(+id); }
    this.db.run('DELETE FROM channels WHERE id=?', id);
    if (deleteProfile && ch.profile_id) await this.profiles.deleteProfile(ch.profile_id);
    return true;
  }
  listVideos(channelId) {
    return this.db.all('SELECT * FROM videos WHERE channel_id=? ORDER BY CASE WHEN scheduled_at IS NULL THEN 1 ELSE 0 END, scheduled_at, id', channelId)
      .map(v => ({ ...v, tags: JSON.parse(v.tags || '[]'), hashtags: JSON.parse(v.hashtags || '[]') }));
  }
  updateVideo(id, patch) {
    const v = this.db.get('SELECT v.*, c.style FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.id=?', id);
    if (!v) return null;
    if (['uploading', 'done'].includes(v.status)) throw Object.assign(new Error(`Video is ${v.status}, can't edit`), { status: 409 });
    const sets = [], vals = [];
    if (patch.title !== undefined) { const t = String(patch.title).trim(); if (!t || [...t].length > 100) throw Object.assign(new Error('Title must be 1-100 characters'), { status: 400 }); sets.push('title=?'); vals.push(t); }
    if (patch.description !== undefined) { sets.push('description=?'); vals.push(String(patch.description).slice(0, 4500)); }
    if (patch.tags !== undefined) { sets.push('tags=?'); vals.push(JSON.stringify((Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(',')).map(t => t.trim()).filter(Boolean))); }
    if (patch.hashtags !== undefined) { sets.push('hashtags=?'); vals.push(JSON.stringify((Array.isArray(patch.hashtags) ? patch.hashtags : String(patch.hashtags).split(/[\s,]+/)).map(t => t.trim()).filter(Boolean))); }
    if (patch.scheduled_at !== undefined) { sets.push('scheduled_at=?'); vals.push(patch.scheduled_at ? +new Date(patch.scheduled_at) : null); }
    if (!sets.length) return this.listVideos(v.channel_id).find(x => x.id === +id);
    if (['title', 'description', 'tags', 'hashtags'].some(k => patch[k] !== undefined)) sets.push('edited=1');
    this.db.run(`UPDATE videos SET ${sets.join(', ')} WHERE id=?`, ...vals, id);
    // a hand-written title makes the video uploadable even if AI never ran / failed
    const cur = this.db.get('SELECT * FROM videos WHERE id=?', id);
    if (cur.title && ['queued', 'failed'].includes(cur.status) && cur.ai_status !== 'running') {
      const mode = JSON.parse(v.style || '{}').mode;
      this.db.run(`UPDATE videos SET status=?, ai_status=CASE WHEN ai_status='done' THEN 'done' ELSE 'manual' END WHERE id=?`, mode === 'approval' && cur.status !== 'failed' ? 'awaiting_approval' : 'ready', id);
    }
    if (cur.scheduled_at == null) this.plan(v.channel_id);
    return this.listVideos(v.channel_id).find(x => x.id === +id);
  }
  approveVideo(id) {
    const r = this.db.run(`UPDATE videos SET status='ready' WHERE id=? AND status='awaiting_approval'`, id);
    if (!r.changes) throw Object.assign(new Error('Video is not waiting for approval'), { status: 409 });
    return this.db.get('SELECT * FROM videos WHERE id=?', id);
  }
  retryVideo(id) {
    const v = this.db.get('SELECT * FROM videos WHERE id=?', id);
    if (!v || !['failed', 'missing', 'skipped'].includes(v.status)) throw Object.assign(new Error('Only failed/skipped videos can be retried'), { status: 409 });
    this.db.run(`UPDATE videos SET status=?, error=NULL, scheduled_at=NULL WHERE id=?`, v.title ? 'ready' : 'queued', id);
    if (!v.title) this.db.run(`UPDATE videos SET ai_status='pending', ai_attempts=0 WHERE id=?`, id);
    this.plan(v.channel_id);
    return this.db.get('SELECT * FROM videos WHERE id=?', id);
  }
  skipVideo(id) { this.db.run(`UPDATE videos SET status='skipped' WHERE id=? AND status NOT IN ('uploading','done')`, id); return this.db.get('SELECT * FROM videos WHERE id=?', id); }

  dashboard() {
    const today = startOfDay(Date.now()), tomorrow = addDays(today, 1);
    const chans = this.listChannels();
    const s = this.settings.all();
    const day = dayKey(Date.now());
    const usage = this.db.get('SELECT COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(errors),0) AS errors FROM key_usage WHERE day=?', day);
    const nextRow = this.db.get(`SELECT MIN(v.scheduled_at) AS t FROM videos v JOIN channels c ON c.id=v.channel_id WHERE c.status='active' AND v.status IN ('queued','ai','awaiting_approval','ready')`);
    return {
      channels: chans.length,
      connected: chans.filter(c => ['active', 'paused'].includes(c.status)).length,
      publishedToday: this.db.get(`SELECT COUNT(*) AS n FROM videos WHERE status='done' AND uploaded_at>=?`, today).n,
      plannedToday: this.db.get(`SELECT COUNT(*) AS n FROM videos WHERE scheduled_at>=? AND scheduled_at<? AND status NOT IN ('skipped','missing')`, today, tomorrow).n,
      inQueue: this.db.get(`SELECT COUNT(*) AS n FROM videos WHERE status IN ('queued','ai','awaiting_approval','ready')`).n,
      needsYou: chans.filter(c => c.status === 'needs_you').length + this.db.get(`SELECT COUNT(*) AS n FROM videos WHERE status IN ('failed','awaiting_approval')`).n,
      needsYouDetail: { channels: chans.filter(c => c.status === 'needs_you').length, failed: this.db.get(`SELECT COUNT(*) AS n FROM videos WHERE status='failed'`).n, approval: this.db.get(`SELECT COUNT(*) AS n FROM videos WHERE status='awaiting_approval'`).n },
      nextUpload: nextRow?.t || null,
      autopilot: { paused: !!s.autopilotPaused, userActive: this.userActive(), inWindow: inWindow(Date.now(), s.uploadWindow), window: s.uploadWindow, lanes: this.scheduler ? this.scheduler.status().lanes : [] },
      cloud: { state: this.cloud.state, email: this.cloud.user ? this.cloud.user.email : null, pcName: this.cloud.pcName, pcs: this.cloud.sync ? this.cloud.sync.status().pcs : [] },
      ai: { keys: s.geminiKeys.length, model: s.geminiModel, callsToday: usage.calls, errorsToday: usage.errors },
      proxies: { total: this.db.get('SELECT COUNT(*) AS n FROM proxies').n, bad: this.db.get(`SELECT COUNT(*) AS n FROM proxies WHERE status='bad'`).n },
    };
  }

  async setAutopilotPaused(paused) {
    this.settings.set({ autopilotPaused: !!paused });
    if (paused) await this.scheduler.stop(); else { this.scheduler.start(); this.scheduler.wake(); }
    this.events.info(`Autopilot ${paused ? 'paused' : 'resumed'}`, { kind: 'app' });
    return { paused: !!paused };
  }

  async updateSettings(patch) {
    const before = this.settings.all();
    if (typeof patch.proxyPool === 'string') { const r = this.profiles.replaceProxyPool(patch.proxyPool); delete patch.proxyPool; this._lastProxyImport = r; }
    if (typeof patch.geminiKeys === 'string') patch.geminiKeys = patch.geminiKeys.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    if (patch.lanes !== undefined) patch.lanes = Math.max(1, Math.min(20, +patch.lanes || 1));
    if (patch.videosPerDay !== undefined) patch.videosPerDay = Math.max(1, Math.min(50, +patch.videosPerDay || 1));
    if (patch.uploadWindow) { const { parseHHMM } = require('../util/time'); if (parseHHMM(patch.uploadWindow.end) <= parseHHMM(patch.uploadWindow.start)) throw Object.assign(new Error('Upload window end must be after start'), { status: 400 }); }
    if (patch.cloud) {
      const cur = this.settings.get('cloud');
      const c = { ...cur, ...patch.cloud };
      if (patch.cloud.backup) c.backup = { ...cur.backup, ...patch.cloud.backup, idleHours: { ...cur.backup.idleHours, ...(patch.cloud.backup.idleHours || {}) } };
      // the OAuth client secret never stays in plain settings: it is sealed with safeStorage
      if (typeof patch.cloud.googleClientSecret === 'string' && patch.cloud.googleClientSecret.trim() && !patch.cloud.googleClientSecret.startsWith('••••')) this.cloud.setClientSecret(patch.cloud.googleClientSecret);
      if (patch.cloud.clearClientSecret) this.cloud.setClientSecret('');
      delete c.clearClientSecret;
      c.googleClientSecret = '';
      if (c.backup) { c.backup.speedCapKBps = Math.max(0, +c.backup.speedCapKBps || 0); c.backup.speedCapPct = Math.max(1, Math.min(100, +c.backup.speedCapPct || 30)); const { parseHHMM } = require('../util/time'); parseHHMM(c.backup.idleHours.start); parseHHMM(c.backup.idleHours.end); }
      if (patch.cloud.firebaseConfig !== undefined && typeof patch.cloud.firebaseConfig === 'string' && patch.cloud.firebaseConfig.trim()) {
        const { parseMaybeJson } = require('../cloud');
        const fb = parseMaybeJson(patch.cloud.firebaseConfig);
        if (!fb || !fb.apiKey || !fb.projectId) throw Object.assign(new Error('Firebase config must be the JSON (or firebaseConfig = {...} snippet) from the Firebase console with apiKey, projectId and appId'), { status: 400 });
        c.firebaseConfig = JSON.stringify(fb);
      }
      if (typeof c.pcName === 'string') c.pcName = c.pcName.trim().slice(0, 40) || cur.pcName;
      patch.cloud = c;
    }
    if (patch.pauseWhenActive) patch.pauseWhenActive = { enabled: !!patch.pauseWhenActive.enabled, idleMinutes: Math.max(1, Math.min(120, +patch.pauseWhenActive.idleMinutes || 5)) };
    if (patch.delayRangeMin) { const a = +patch.delayRangeMin.min, b = +patch.delayRangeMin.max; if (!(a >= 0 && b >= a)) throw Object.assign(new Error('Delay range invalid'), { status: 400 }); patch.delayRangeMin = { min: a, max: b }; }
    const cloudKeysChanged = patch.cloud && ['firebaseConfig', 'googleClientId', 'emulator'].some(k => JSON.stringify(before.cloud[k]) !== JSON.stringify(patch.cloud[k]));
    const after = this.settings.set(patch);
    if (this.started && cloudKeysChanged) this.cloudReady = this.cloud.reconnect().catch(e => { this.events.error(`Cloud: ${e.message}`, { kind: 'cloud' }); });
    if (this.started && (before.lanes !== after.lanes || JSON.stringify(before.delayRangeMin) !== JSON.stringify(after.delayRangeMin))) await this.restartScheduler();
    if (JSON.stringify(before.uploadWindow) !== JSON.stringify(after.uploadWindow) || before.videosPerDay !== after.videosPerDay) {
      // re-spread future, not-yet-uploaded slots
      this.db.run(`UPDATE videos SET scheduled_at=NULL WHERE status IN ('queued','awaiting_approval','ready') AND scheduled_at>?`, Date.now());
      this.replanAll();
    }
    return { settings: this.settings.publicView(), proxyImport: this._lastProxyImport || null };
  }
}

module.exports = { UploadPilotApp, proxyLabel };
