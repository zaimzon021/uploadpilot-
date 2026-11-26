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
const { startOfDay, addDays, inWindow, dayKey, nextInWindow } = require('../util/time');
const { proxyLabel } = require('../proxy/parse');
const { CloudService } = require('../cloud');
const { makeLowRes } = require('../ai/lowres');
const { rotateLogs } = require('../util/logRotate');
const { missingFields, isComplete, fallbackMeta } = require('../upload/metadata');
const { KeepAlive } = require('../profiles/keepAlive');
const { gotoLanding } = require('../profiles/profileManager');
const { googleAuthCookies } = require('../cloud/profileState');
const { SignInWatch } = require('../profiles/signInWatch');
const VERSION = require('../../package.json').version;

/** Channel reasons that a Google sign-in fixes. */
const isLoginReason = r => /login|log in|sign.?in|signed out|session expired/i.test(String(r || ''));
/** Errors that were bugs in the app (not YouTube / network): re-queued after an upgrade. */
const CODE_CRASH = /Cannot read propert(?:y|ies) of (?:null|undefined)|is not a function|is not defined|is not iterable|of undefined \(reading|TypeError|ReferenceError/i;
function versionLt(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
}

/** Short, plain reason for the activity feed. */
function humanizeError(msg) {
  const m = String(msg || '');
  if (/Step timeout/i.test(m)) return 'Studio stopped responding';
  if (/Hard limit/i.test(m)) return 'the run took too long';
  if (/net::ERR_(PROXY|SOCKS|TUNNEL)/i.test(m)) return 'proxy connection failed';
  if (/net::ERR_/i.test(m)) return 'network error';
  if (/Target (page, context or browser )?closed|browser has been closed/i.test(m)) return 'the browser closed';
  return m.replace(/^(Error: )?/, '').slice(0, 160);
}

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
    this.runner = new ChannelRunner({ db: this.db, settings: this.settings, events: this.events, profiles: this.profiles, logsDir: this.logsDir, engineOpts: o.engineOpts || {}, cloud: this.cloud,
      ensureMeta: (v, ctx) => this.ensureMetadata(v, ctx), onFailure: (v, err, ctx) => this.failUpload(v, err, ctx) });
    this.profiles.hooks = {
      beforeOpen: (prof, purpose) => this.cloud.beforeOpenProfile(prof, purpose),
      afterLaunch: (prof, sess) => this.cloud.afterLaunchProfile(prof, sess),
      beforeClose: (prof, sess) => this.cloud.beforeCloseProfile(prof, sess),
      afterClose: async prof => { await this.cloud.afterCloseProfile(prof); if (this.scheduler) this.scheduler.wake(); },
      afterOpen: (prof, sess) => this._watchSignIn(prof, sess),
    };
    this.wizard = new LinkWizard(this);
    this.watchers = new Map();
    this.aiBusy = new Set(); this.aiNextTry = new Map(); this.aiJobs = new Map(); this._aiLastStart = 0;
    this.keepAlive = new KeepAlive({ app: this, ...(o.keepAliveOpts || {}) });
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
    try { this.resetStaleFailures(); } catch (e) { this.events.warn(`Re-queue of old failures: ${e.message}`); }
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
    this.keepAlive.start();
    this._planTimer = setInterval(() => { this.replanAll(); try { this.resetStaleFailures(); } catch (_) { /* ignore */ } }, 15 * 60000);
    setTimeout(() => this.aiTick().catch(() => {}), 500);
    this.events.info(`UploadPilot started (db: ${this.db.driver})`, { kind: 'app' });
    // cloud sign-in / sync starts in the background; the app works locally meanwhile
    this.cloudReady = this.cloud.start().then(st => { if (this.scheduler) this.scheduler.wake(); this.aiKick(); this._afterCloudUp(); return st; })
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

  /** Is this PC allowed to start work now (active PC, not winding down, user not busy)? */
  canWork() { return !this.windingDown && !this.userActive() && this.cloud.mayRun(); }

  _buildScheduler() {
    const s = this.settings.all();
    this.scheduler = new LaneScheduler({
      lanes: s.lanes,
      delayRangeMin: s.delayRangeMin,
      idleMs: s.schedulerTickMs,
      cooldownMs: this.o.cooldownMs ?? 10 * 60000,
      getAllChannels: () => this.db.all(`SELECT id FROM channels WHERE status='active'`).map(r => r.id),
      getDueChannels: () => this.dueChannelIds(),
      canStart: () => this.canWork(),
      getNextDueAt: () => this.nextDueAt(),
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
    clearInterval(this._aiTimer); clearTimeout(this._aiKickT); this.keepAlive.stop(); clearInterval(this._planTimer); clearInterval(this._rotateTimer);
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
    const rows = this.db.all(`SELECT c.id AS cid, c.profile_id, c.style AS ch_style, v.* FROM channels c JOIN videos v ON v.channel_id=c.id
      WHERE c.status='active' AND (c.paused_until IS NULL OR c.paused_until<=?) AND v.scheduled_at<=? AND (v.retry_at IS NULL OR v.retry_at<=?)
        AND (v.status='ready' OR (v.status='queued' AND v.ai_status!='running'))`, now, now, now)
      .filter(r => r.status === 'ready' || JSON.parse(r.ch_style || '{}').mode !== 'approval');   // queued (AI not done yet) in auto mode: the runner writes it inline
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

  /** Earliest future moment something becomes due (a slot or a retry), so idle lanes don't over-sleep. */
  nextDueAt(now = Date.now()) {
    const r = this.db.get(`SELECT MIN(MAX(v.scheduled_at, COALESCE(v.retry_at, 0))) AS t FROM videos v JOIN channels c ON c.id=v.channel_id
      WHERE c.status='active' AND v.status IN ('ready','queued') AND v.scheduled_at IS NOT NULL AND MAX(v.scheduled_at, COALESCE(v.retry_at, 0))>?`, now);
    return r && r.t ? r.t : null;
  }

  /** A time / status changed (here or on another PC): the scheduler and the AI queue look again now. */
  onVideosChanged() { if (this.scheduler) this.scheduler.wake(); this.aiKick(); }
  onBecameActive() { if (this.scheduler) { if (!this.scheduler.running && !this.settings.get('autopilotPaused')) this.scheduler.start(); this.scheduler.wake(); } this.aiKick(); this._afterCloudUp(); }

  /** Cloud is up / this PC became active: old failures from other PCs, logins that arrived while away. */
  _afterCloudUp() {
    clearTimeout(this._upT);
    this._upT = setTimeout(() => {
      if (!this.started) return;
      try { this.resetStaleFailures(); } catch (_) { /* ignore */ }
      this.importPendingLogins().catch(() => {});
    }, this.o.afterCloudUpMs ?? 3000);
    if (this._upT.unref) this._upT.unref();
  }

  /** Scan the channel folder, add new videos, then plan. */
  ingest(channelId) {
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', channelId);
    if (!ch || !ch.folder) return { added: 0 };
    const files = scanFolder(ch.folder);
    let added = 0;
    this.db.tx(() => {
      for (const f of files) {
        if (this._adoptRemote(channelId, f.path, f.filename, f.size)) continue;
        const r = this.db.run('INSERT OR IGNORE INTO videos(channel_id,path,thumb,filename,size,status,created_at) VALUES(?,?,?,?,?,?,?)', channelId, f.path, f.thumb, f.filename, f.size, 'queued', Date.now());
        added += r.changes;
        if (!r.changes && f.thumb) this.db.run('UPDATE videos SET thumb=? WHERE channel_id=? AND path=? AND thumb IS NULL', f.thumb, channelId, f.path);
      }
    });
    if (added) this.events.info(`${ch.name || 'Channel'}: ${added} new video(s) found`, { channelId, kind: 'scan' });
    this.plan(channelId);
    if (added) { this.aiKick(); if (this.scheduler) this.scheduler.wake(); if (this.cloud.backup) this.cloud.backup.kick(); }
    return { added, total: files.length };
  }

  addVideoFile(channelId, file) {
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', channelId);
    let size = 0; try { size = fs.statSync(file).size; } catch (_) { return; }
    if (this._adoptRemote(channelId, file, path.basename(file), size)) return;
    const r = this.db.run('INSERT OR IGNORE INTO videos(channel_id,path,thumb,filename,size,status,created_at) VALUES(?,?,?,?,?,?,?)', channelId, file, findThumb(file), path.basename(file), size, 'queued', Date.now());
    if (r.changes) { this.events.info(`${ch?.name || 'Channel'}: new video ${path.basename(file)} added`, { channelId, kind: 'scan' }); this.plan(channelId); this.aiKick(); if (this.scheduler) this.scheduler.wake(); if (this.cloud.backup) this.cloud.backup.kick(); }
  }

  /**
   * v0.3.2: a file in a folder linked on this PC that is another PC's video of the same channel (same
   * name + size): no duplicate row; the cloud copy remembers where it is here and uploads from it.
   */
  _adoptRemote(channelId, file, filename, size) {
    const r = this.db.get(`SELECT id, status, local_path FROM videos WHERE channel_id=? AND remote=1 AND filename=? AND (size=? OR size IS NULL OR size=0) ORDER BY id DESC LIMIT 1`, channelId, filename, size);
    if (!r) return false;
    if (r.local_path !== file && !['done', 'skipped'].includes(r.status)) this.db.applying(() => this.db.run('UPDATE videos SET local_path=? WHERE id=?', file, r.id));
    return true;
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
      // files dropped while the watcher was still starting are not reported as "add": scan once when it is ready
      onReady: () => { try { if (this.watchers.has(channelId)) this.ingest(channelId); } catch (_) { /* folder gone */ } },
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

  /** Upload window / per-day changed: re-spread future, not-yet-uploaded slots (one channel or all). */
  replanFuture(channelId = null) {
    const now = Date.now();
    if (channelId) this.db.run(`UPDATE videos SET scheduled_at=NULL WHERE channel_id=? AND status IN ('queued','awaiting_approval','ready') AND scheduled_at>? AND retry_at IS NULL`, channelId, now);
    else this.db.run(`UPDATE videos SET scheduled_at=NULL WHERE status IN ('queued','awaiting_approval','ready') AND scheduled_at>? AND retry_at IS NULL`, now);
    if (channelId) this.plan(channelId); else this.replanAll();
    if (this.scheduler) this.scheduler.wake();
  }

  replanAll() { for (const ch of this.db.all(`SELECT id FROM channels WHERE folder IS NOT NULL`)) { try { this.plan(ch.id); } catch (_) {} } }

  /** One Gemini client while keys/model stay the same, so key rotation and 429 cool-downs carry across jobs. */
  geminiClient() {
    const s = this.settings.all();
    const sig = JSON.stringify([s.geminiKeys, s.geminiModel, s.geminiBaseUrl]);
    if (this._geminiClient && this._geminiSig === sig) return this._geminiClient;
    this._geminiSig = sig;
    return (this._geminiClient = new GeminiClient({
      keys: s.geminiKeys, model: s.geminiModel, baseUrl: s.geminiBaseUrl, fetchImpl: this.o.fetchImpl || globalThis.fetch,
      sleep: this.o.geminiSleep, pollMs: this.o.geminiPollMs ?? 3000,
      log: m => this.events.warn(m, { kind: 'ai' }),
      onUsage: (h, ok) => this.db.run(`INSERT INTO key_usage(key_hash,day,calls,errors) VALUES(?,?,1,?) ON CONFLICT(key_hash,day) DO UPDATE SET calls=calls+1, errors=errors+excluded.errors`, h, dayKey(Date.now()), ok ? 0 : 1),
    }));
  }

  /** Start the AI worker soon (debounced): new video, time moved earlier, keys added, … */
  aiKick(delayMs = 150) {
    if (!this.started) return;
    clearTimeout(this._aiKickT);
    this._aiKickT = setTimeout(() => this.aiTick().catch(e => this.events.error(`AI worker: ${e.message}`, { kind: 'ai' })), delayMs);
    if (this._aiKickT.unref) this._aiKickT.unref();
  }

  /**
   * AI writes ahead: every queued video gets Gemini metadata in the background as soon as it is found,
   * earliest slot first (a video moved earlier jumps the queue). Rate-limited: aiConcurrency jobs at a
   * time and at least aiMinGapMs between two starts. aiWriteAhead=false keeps the 0.3.0 rule (today only).
   */
  async aiTick(now = Date.now()) {
    const s = this.settings.all();
    if (!s.geminiKeys.length) return 0;
    if (this.userActive() || this.windingDown || (this.cloud && !this.cloud.mayRun())) return 0;
    const free = (s.aiConcurrency || 2) - this.aiBusy.size;
    if (free <= 0) return 0;
    const until = s.aiWriteAhead === false ? startOfDay(addDays(now, 1 + (s.aiLookaheadDays || 0))) : Number.MAX_SAFE_INTEGER;
    const rows = this.db.all(`SELECT v.*, c.style, c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id
      WHERE v.remote=0 AND v.ai_status IN ('pending','retry') AND c.status IN ('active','paused','needs_you')
        AND (v.status='queued' OR (v.status='ready' AND (v.title IS NULL OR TRIM(v.title)='' OR v.description IS NULL OR TRIM(v.description)='' OR v.tags IS NULL OR v.tags IN ('','[]'))))
        AND (v.scheduled_at IS NULL OR v.scheduled_at<?)
      ORDER BY CASE WHEN v.scheduled_at IS NULL THEN 1 ELSE 0 END, v.scheduled_at, v.id LIMIT 50`, until)
      .filter(v => !this.aiBusy.has(v.id) && !((this.aiNextTry.get(v.id) || 0) > now));
    if (!rows.length) return 0;
    const gap = s.aiMinGapMs ?? 4000;
    const client = this.geminiClient();
    const started = [];
    for (const v of rows.slice(0, free)) {
      const wait = this._aiLastStart + gap - Date.now();
      if (gap > 0 && wait > 0) { this.aiKick(wait + 20); break; }
      this._aiLastStart = Date.now();
      started.push(this._aiStart(client, v));
      if (gap > 0) { if (rows.length > started.length) this.aiKick(gap + 20); break; }
    }
    await Promise.all(started);
    return started.length;
  }

  _aiStart(client, v) {
    const p = this._aiOne(client, v).finally(() => { this.aiJobs.delete(v.id); this.aiKick(50); });
    this.aiJobs.set(v.id, p);
    return p;
  }

  /** Gemini (360p copy when possible) for one video. Throws on failure. */
  async _gemini(client, v, style, { maxAttempts } = {}) {
    let low = null;
    try {
      const lr = this.settings.get('geminiLowRes');
      let src = v.path;
      if (lr && lr.enabled) {
        low = await makeLowRes(v.path, { outDir: path.join(this.dataDir, 'cache', 'lowres'), height: lr.height, videoKbps: lr.videoKbps, configured: lr.ffmpegPath || '' });
        if (low.lowres) src = low.path; else if (low.reason && !this._lowresWarned) { this._lowresWarned = true; this.events.warn(`Small copy for Gemini not made (${low.reason}) — sending the original`, { kind: 'ai' }); }
      }
      return await client.describeVideo(src, style, { maxAttempts: maxAttempts || this.settings.get('geminiMaxAttempts'), displayName: v.filename });
    } finally { if (low && low.lowres) { try { fs.unlinkSync(low.path); } catch (_) { /* gone */ } } }
  }

  /** Write AI fields: never overwrite what you typed; always fill what is empty. */
  _writeMeta(id, meta, source) {
    const cur = this.db.get('SELECT * FROM videos WHERE id=?', id);
    const keep = f => cur.edited && missingFields(cur).indexOf(f) < 0;   // a hand-edited, non-empty field stays
    const title = keep('title') ? cur.title : meta.title;
    const description = keep('description') ? cur.description : meta.description;
    const tags = keep('tags') ? cur.tags : JSON.stringify(meta.tags || []);
    const hashtags = cur.edited && cur.hashtags && cur.hashtags !== '[]' ? cur.hashtags : JSON.stringify(meta.hashtags || []);
    this.db.run(`UPDATE videos SET title=?, description=?, tags=?, hashtags=?, meta_source=? WHERE id=?`, title, description, tags, hashtags, source, id);
    return this.db.get('SELECT * FROM videos WHERE id=?', id);
  }

  async _aiOne(client, v) {
    this.aiBusy.add(v.id);
    const wasReady = v.status === 'ready';
    this.db.run(`UPDATE videos SET status='ai', ai_status='running' WHERE id=? AND status IN ('queued','ready')`, v.id);
    const style = JSON.parse(v.style || '{}');
    try {
      const meta = await this._gemini(client, v, style);
      const cur = this.db.get('SELECT * FROM videos WHERE id=?', v.id);
      if (!cur) return;
      const next = wasReady ? 'ready' : style.mode === 'approval' ? 'awaiting_approval' : 'ready';
      const after = this._writeMeta(v.id, meta, 'ai');
      this.db.run(`UPDATE videos SET status=CASE WHEN status='ai' THEN ? ELSE status END, ai_status='done', ai_error=NULL WHERE id=?`, next, v.id);
      this.events.info(`${v.channel_name}: AI title ready — "${after.title}"${next === 'awaiting_approval' ? ' (needs your OK)' : ''}`, { channelId: v.channel_id, kind: next === 'awaiting_approval' ? 'approval' : 'ai' });
      if (this.scheduler) this.scheduler.wake();
    } catch (e) {
      const attempts = (v.ai_attempts || 0) + 1;
      const final = attempts >= 3;
      this.db.run(`UPDATE videos SET status=CASE WHEN status='ai' THEN ? ELSE status END, ai_status=?, ai_error=?, ai_attempts=? WHERE id=?`, wasReady ? 'ready' : 'queued', final ? 'failed' : 'retry', String(e.message).slice(0, 500), attempts, v.id);
      this.aiNextTry.set(v.id, Date.now() + 10 * 60000 * attempts);
      this.events.error(`${v.channel_name}: AI failed for ${v.filename}${final ? ' — a clean title from the file name is used if it is still missing at upload time' : ', will retry'}: ${String(e.message).split('\n')[0]}`, { channelId: v.channel_id, kind: 'ai' });
    } finally {
      this.aiBusy.delete(v.id);
    }
  }

  /**
   * Inline, right before an upload: a video still missing title/description/tags gets Gemini now
   * (waiting for it, with its retries, capped by aiInlineTimeoutMs). If Gemini can't, a clean title
   * from the file name and a basic description are used. Never throws; returns the updated row.
   */
  async ensureMetadata(video, { log = () => {}, file = null } = {}) {
    let v = this.db.get('SELECT v.*, c.style, c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.id=?', video.id);
    if (!v || isComplete(v)) return v;
    // a background job is already on it: wait for that one
    if (this.aiJobs.has(v.id)) {
      log(`video ${v.id}: waiting for the AI job already running`);
      await Promise.race([this.aiJobs.get(v.id).catch(() => {}), new Promise(r => setTimeout(r, this.settings.get('aiInlineTimeoutMs') || 300000))]);
      v = this.db.get('SELECT v.*, c.style, c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.id=?', video.id);
      if (isComplete(v)) return v;
    }
    const style = JSON.parse(v.style || '{}');
    const s = this.settings.all();
    const src = file || (!v.remote ? v.path : null);
    let meta = null, why = '';
    if (s.geminiKeys.length && src && fs.existsSync(src)) {
      this.aiBusy.add(v.id);
      this.db.run(`UPDATE videos SET ai_status='running' WHERE id=?`, v.id);
      this.events.info(`${v.channel_name}: writing the title for ${v.filename} now (it is due)`, { channelId: v.channel_id, kind: 'ai' });
      let timer;
      try {
        const job = this._gemini(this.geminiClient(), { ...v, path: src }, style);
        job.catch(() => {});
        meta = await Promise.race([job, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Gemini took too long')), s.aiInlineTimeoutMs || 300000); })]);
      } catch (e) { why = String(e.message).split('\n')[0]; }
      finally { clearTimeout(timer); this.aiBusy.delete(v.id); }
    } else why = !s.geminiKeys.length ? 'no Gemini key' : 'video file not on this PC';
    if (meta) {
      const after = this._writeMeta(v.id, meta, 'ai');
      this.db.run(`UPDATE videos SET ai_status='done', ai_error=NULL WHERE id=?`, v.id);
      log(`video ${v.id}: AI metadata written inline`);
      if (isComplete(after)) return after;
    }
    const fb = fallbackMeta(v.filename, style);
    const after = this._writeMeta(v.id, fb, 'filename');
    this.db.run(`UPDATE videos SET ai_status=CASE WHEN ai_status='running' THEN 'failed' ELSE ai_status END, ai_error=COALESCE(?, ai_error) WHERE id=?`, why || null, v.id);
    this.events.warn(`${v.channel_name}: AI could not write ${v.filename}${why ? ` (${why})` : ''} — using the title "${after.title}"`, { channelId: v.channel_id, kind: 'ai' });
    log(`video ${v.id}: file-name fallback metadata (${why})`);
    return after;
  }

  /**
   * Retry policy for a failed upload. Not retried: login expired / verification (→ Needs you; handled
   * by the runner before this), a missing file. Everything else: up to retry.max automatic retries
   * after ~5, 15, 45 min (+ jitter), moved into the upload window. Then "failed" with a Retry button.
   */
  failUpload(v, err, { channel } = {}) {
    if (!v) return { action: 'none' };
    const s = this.settings.all();
    const msg = String((err && err.message) || err || 'Upload failed').replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 300);
    const name = (channel && channel.name) || 'Channel';
    // another PC's video: its file is not "missing" (it is on that PC) — retried like any failure, the file is fetched again
    if (!v.remote && err && (err.code === 'ENOENT' || /ENOENT|no such file|File not found/i.test(msg))) {
      this.db.run(`UPDATE videos SET status='missing', error=?, error_kind='missing', retry_at=NULL WHERE id=?`, 'File not found', v.id);
      this.events.error(`${name}: ${v.filename} is missing from the folder — not retried`, { channelId: v.channel_id, kind: 'failed' });
      return { action: 'missing' };
    }
    const r = s.retry || { max: 3, backoffMin: [5, 15, 45], jitterPct: 20 };
    const n = (v.retry_count || 0) + 1;
    const kind = err && err.code ? String(err.code).toLowerCase() : 'error';
    if (n > (r.max ?? 3)) {
      this.db.run(`UPDATE videos SET status='failed', error=?, error_kind=?, retry_at=NULL, failed_version=? WHERE id=?`, msg, kind, VERSION, v.id);
      this.events.error(`${name}: upload of "${v.title || v.filename}" failed ${r.max} retries — ${humanizeError(msg)} (press Retry)`, { channelId: v.channel_id, kind: 'failed', detail: err && err.stack });
      return { action: 'failed' };
    }
    const base = (r.backoffMin[Math.min(n - 1, r.backoffMin.length - 1)] || 5) * 60000;
    const jitter = base * ((r.jitterPct ?? 20) / 100) * (Math.random() * 2 - 1);
    const at = nextInWindow(Date.now() + base + jitter, s.uploadWindow);
    this.db.run(`UPDATE videos SET status='ready', error=?, error_kind=?, retry_at=?, retry_count=?, failed_version=? WHERE id=?`, msg, kind, at, n, VERSION, v.id);
    const hm = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.events.warn(`${name}: upload failed — ${humanizeError(msg)}. Retrying at ${hm} (attempt ${n}/${r.max})`, { channelId: v.channel_id, kind: 'failed', detail: err && err.stack });
    return { action: 'retry', retryAt: at, attempt: n };
  }

  /** Stop taking jobs; finish the current upload if it ends within waitMs, else abort it back to the queue; save logins; close browsers. */
  async windDown({ waitMs = 180000, noExport = false, reason = '' } = {}) {
    this.windingDown = true;
    this.runner.stopping = true;
    try {
      const t0 = Date.now();
      while (this.runner.live.size && Date.now() - t0 < waitMs) await new Promise(r => setTimeout(r, 200));
      if (this.runner.live.size) {
        this.runner.aborted = true;
        this.events.warn(`Stopping the upload in progress (${reason}) — it goes back to the queue`, { kind: 'cloud' });
        for (const chId of [...this.runner.live.keys()]) {
          const ch = this.db.get('SELECT profile_id FROM channels WHERE id=?', chId);
          const sess = ch && this.profiles.session(ch.profile_id);
          if (sess) { if (noExport) sess.noExport = true; else sess.exportReason = 'hand-over'; }
          if (ch) await this.profiles.close(ch.profile_id).catch(() => {});
        }
        const t1 = Date.now();
        while (this.runner.live.size && Date.now() - t1 < 25000) await new Promise(r => setTimeout(r, 200));
      }
      this.db.run(`UPDATE videos SET status='ready' WHERE status='uploading' AND remote=0`);
      for (const [id, sess] of this.profiles.sessions) { if (noExport) sess.noExport = true; else sess.exportReason = 'hand-over'; void id; }
      await this.profiles.closeAll();     // saves every open profile's login (unless noExport)
      if (this.keepAlive) await this.keepAlive.idle();
    } finally {
      this.runner.stopping = false; this.runner.aborted = false; this.windingDown = false;
    }
  }

  /**
   * Is this profile's Google account signed in? Opens youtube.com in a throw-away tab (or the given
   * page), checks the Google auth cookies and where the page ended up. Logs the answer.
   */
  async checkSignedIn(prof, sess, { log = true, stayMs = 0, page: usePage = null, via = 'check', exportLogin = false } = {}) {
    const ctx = sess.handle.context;
    const urls = this.settings.get('urls');
    const page = usePage || await ctx.newPage();
    let land = { url: '', signIn: false };
    try {
      land = await gotoLanding(page, urls.youtube, { timeout: 45000 });
      if (stayMs) { const t0 = Date.now(); while (Date.now() - t0 < stayMs) { try { await page.mouse.wheel(0, 200 + Math.random() * 400); } catch (_) { /* ignore */ } await new Promise(r => setTimeout(r, 1500 + Math.random() * 2500)); } }
    } catch (_) { /* judged by cookies */ }
    let cookies = [];
    try { cookies = await ctx.cookies(); } catch (_) { /* ignore */ }
    const ok = googleAuthCookies(cookies).length > 0 && !land.signIn;
    if (!usePage) await page.close().catch(() => {});
    // signed in: clears a "sign in needed" flag on the profile and its channel(s), saves + re-plans
    const cleared = ok ? await this.onSignedIn(prof.id, { sess, via, exportLogin }).catch(() => false) : false;
    if (!ok) this.db.run('UPDATE profiles SET login_state=?, login_note=? WHERE id=?', 'signed_out', 'Sign in needed', prof.id);
    if (log) {
      if (ok && !cleared) this.events.success(`Profile #${prof.number}: signed in to YouTube`, { kind: 'profile' });
      else if (ok) { /* "<channel>: signed in ✓" was logged */ }
      else this.events.warn(`Profile #${prof.number}: not signed in to YouTube — sign in needed`, { kind: 'needs_you', detail: land.error || land.url });
    }
    return { signedIn: ok, url: land.url };
  }

  // ---------------- v0.3.2: sign-in detection ----------------
  /** Is this profile (or a channel on it) waiting for a Google sign-in? */
  loginFlagged(profileId) {
    const p = this.db.get('SELECT login_state FROM profiles WHERE id=?', profileId);
    if (!p) return false;
    if (['signed_out', 'restore_failed'].includes(p.login_state)) return true;
    return this.db.all(`SELECT status_reason FROM channels WHERE profile_id=? AND status='needs_you'`, profileId).some(c => isLoginReason(c.status_reason));
  }

  /** Watch an open window (manual or autopilot) for a Google / YouTube sign-in. */
  _watchSignIn(prof, sess) {
    if (!sess || !['manual', 'auto'].includes(sess.purpose) || !sess.handle || !sess.handle.context) return;
    const w = new SignInWatch({
      context: sess.handle.context, everyMs: this.o.signInWatchMs ?? 10000,
      flagged: () => this.loginFlagged(prof.id),
      onSignedIn: reason => this.onSignedIn(prof.id, { sess, via: reason, exportLogin: !(sess.handle.isClosed && sess.handle.isClosed()) }),
    });
    w.studioLoaded = !!(sess.landing && !sess.landing.signIn && /^https:\/\/studio\.youtube\.com\//i.test(sess.landing.url || ''));
    sess.watch = w.start();
    if (this.loginFlagged(prof.id)) w.check('opened').catch(() => {});
  }

  /**
   * A Google sign-in was seen (window, close, check, import). When the profile or its channel was
   * waiting for one: clear the flag and the Needs-you item at once, save the login to the cloud (a new
   * version; only the active PC may), log "<channel>: signed in ✓", and re-plan so its jobs run.
   * Returns true when something was waiting for this sign-in.
   */
  async onSignedIn(profileId, { sess = null, via = 'window', exportLogin = true } = {}) {
    const prof = this.profiles.getProfile(profileId);
    if (!prof) return false;
    const was = this.loginFlagged(profileId);
    this.db.run(`UPDATE profiles SET login_state='ok', login_note=NULL WHERE id=?`, profileId);
    if (!was) return false;
    const chans = this.db.all('SELECT * FROM channels WHERE profile_id=?', profileId);
    for (const ch of chans) if (ch.status === 'needs_you' && isLoginReason(ch.status_reason)) this.db.run(`UPDATE channels SET status='active', status_reason=NULL, paused_until=NULL WHERE id=?`, ch.id);
    const label = chans.map(c => c.name).filter(Boolean).join(', ') || `Profile #${prof.number}`;
    this.events.success(`${label}: signed in ✓`, { channelId: chans[0] ? chans[0].id : null, kind: 'channel', detail: `seen: ${via}` });
    if (exportLogin && sess && this.cloud) await this.cloud.exportLogin(prof, sess, { reason: 'signed in', force: true }).catch(() => null);
    for (const ch of chans) { try { if (ch.folder) this.plan(ch.id); } catch (_) { /* ignore */ } }
    if (this.scheduler) this.scheduler.wake();
    this.aiKick();
    this.cloud.emit('change');
    return true;
  }

  /** Needs you → "Check sign-in": a quick check (the open window's cookies, or a headless visit). */
  async checkSignIn(channelId) {
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', channelId);
    if (!ch) return null;
    if (!ch.profile_id) throw Object.assign(new Error('Channel has no profile'), { status: 409 });
    if (this.runner.live.has(ch.id)) throw Object.assign(new Error('Autopilot is uploading on this profile right now'), { status: 409 });
    const prof = this.profiles.getProfile(ch.profile_id);
    const open = this.profiles.session(prof.id);
    if (open && open.watch) {
      const v = await open.watch.check('Check sign-in');
      if (v && v.signedIn) { await this.onSignedIn(prof.id, { sess: open, via: 'Check sign-in' }); return { signedIn: true, how: 'open window' }; }
      if (v) return { signedIn: false, how: 'open window' };
    }
    if (open) throw Object.assign(new Error('The profile window is open — sign in there; it is detected by itself'), { status: 409 });
    const sess = await this.profiles.open(prof.id, { purpose: 'check', headless: true });
    let r = { signedIn: false };
    try { r = await this.checkSignedIn(prof, sess, { log: true, via: 'Check sign-in', exportLogin: true }); }
    finally { sess.noExport = true; await this.profiles.close(prof.id).catch(() => {}); }
    return { signedIn: !!r.signedIn, how: 'headless check' };
  }

  /** A newer login in the cloud (with Google cookies) while this profile waits for a sign-in. */
  loginImportNeeded(p) {
    return !!p && (p.cloud_state_version || 0) > (p.state_version || 0) && (p.cloud_state_google == null || p.cloud_state_google > 0)
      && this.loginFlagged(p.id) && !this.profiles.isOpen(p.id);
  }

  /**
   * Import the newest cloud login now (headless, before any page loads) and re-check the sign-in.
   * If it can't run now (browser limit, proxy, …) a cloud copy WITH Google cookies still clears the
   * stale flag; the next open re-checks it.
   */
  async importLoginNow(profileId, { reason = 'newer login in the cloud', verify = true } = {}) {
    this._importing = this._importing || new Set();
    if (this._importing.has(profileId)) return null;
    this._importing.add(profileId);
    try {
      const prof = this.profiles.getProfile(profileId);
      if (!prof) return null;
      this.events.info(`Profile #${prof.number}: ${reason} — importing it${verify ? ' and checking the sign-in' : ''}`, { kind: 'profile' });
      try {
        const sess = await this.profiles.open(profileId, { purpose: 'check', headless: true });   // imported right after launch, before any page loads
        try { return verify ? await this.checkSignedIn(prof, sess, { log: true, via: 'import' }) : { imported: !!sess.restored }; }
        finally { sess.noExport = true; await this.profiles.close(profileId).catch(() => {}); }
      } catch (e) {
        const p = this.profiles.getProfile(profileId);
        if (verify && p && p.cloud_state_google > 0 && this.loginFlagged(profileId)) {
          await this.onSignedIn(profileId, { via: 'cloud login with Google cookies', exportLogin: false });
          this.db.run(`UPDATE profiles SET login_state='restored', login_note=? WHERE id=?`, 'Newer login from the cloud — checked at the next open', profileId);
        }
        return { signedIn: null, error: e.message };
      }
    } finally { this._importing.delete(profileId); }
  }

  /** Every profile that waits for a sign-in while the cloud already has a newer Google login. */
  async importPendingLogins() {
    if (!this.cloud.online || !this.cloud.mayRun()) return 0;
    let n = 0;
    for (const p of this.db.all(`SELECT * FROM profiles WHERE cloud_state_version > IFNULL(state_version,0)`)) {
      if (!this.loginImportNeeded(p)) continue;
      await this.importLoginNow(p.id, { reason: `newer login from ${p.cloud_state_by || 'another PC'}` }).catch(() => {});
      n++;
    }
    return n;
  }

  // ---------------- v0.3.2: failures left by older versions ----------------
  /**
   * After an upgrade: uploads that failed with a code crash in an older version (e.g. "Cannot read
   * properties of null (reading 'replace')") go back to the queue with their attempts reset, so the
   * new metadata path handles them; their Needs-you items go with them. Another PC's video that 0.3.1
   * marked "missing" here waits for its file instead (fileRequests.js).
   */
  resetStaleFailures() {
    const cloudActive = this.cloud.online && this.cloud.mayRun();
    let n = 0;
    for (const v of this.db.all(`SELECT v.*, c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.status='failed' AND v.error IS NOT NULL`)) {
      if (!CODE_CRASH.test(v.error)) continue;
      if (v.failed_version && !versionLt(v.failed_version, VERSION)) continue;       // failed in this version: a real, new problem
      if (v.remote && !cloudActive) continue;                                          // another PC's job: the active PC re-queues it
      const r = this.db.run(`UPDATE videos SET status='queued', error=NULL, error_kind=NULL, retry_at=NULL, retry_count=0, attempts=0, ai_attempts=0, failed_version=NULL,
        ai_status=CASE WHEN title IS NULL OR TRIM(title)='' OR description IS NULL OR TRIM(description)='' OR tags IS NULL OR tags IN ('','[]') THEN 'pending' ELSE ai_status END WHERE id=? AND status='failed'`, v.id);
      if (!r.changes) continue;
      this.aiNextTry.delete(v.id);
      n++;
      this.events.info(`${v.channel_name}: "${v.title || v.filename}" had failed in an older version (${humanizeError(v.error).slice(0, 80)}) — queued again`, { channelId: v.channel_id, kind: 'channel' });
    }
    if (cloudActive) {
      const r = this.db.run(`UPDATE videos SET status=CASE WHEN title IS NOT NULL AND TRIM(title)!='' THEN 'ready' ELSE 'queued' END, error=NULL, error_kind=NULL, retry_at=NULL
        WHERE remote=1 AND status='missing' AND (error IS NULL OR error='File not found')`);
      n += r.changes;
    }
    if (n) { if (this.scheduler) this.scheduler.wake(); this.aiKick(); }
    return n;
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
    return this.db.all(`SELECT c.*, f.number AS profile_number, f.login_state AS login_state, p.host AS proxy_host, p.port AS proxy_port, p.status AS proxy_status,
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
    if (patch.style) {
      const before = JSON.parse(ch.style || '{}');
      const next = normalizeStyle({ ...before, ...patch.style });
      this.db.run('UPDATE channels SET style=? WHERE id=?', JSON.stringify(next), id);
      if ((before.perDay || null) !== (next.perDay || null)) this.replanFuture(+id);     // re-spread this channel's future slots
      if (before.mode !== next.mode && this.scheduler) this.scheduler.wake();
    }
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
  /** Another PC's video this PC waits for (v0.3.2): {from, state} or null. */
  _waitingFor(v) {
    if (!v.remote || v.drive_file_id || !this.cloud.files) return null;
    if (this.cloud.localCopy(v)) return null;
    return this.cloud.files.waitingFor(v);
  }
  listVideos(channelId) {
    return this.db.all('SELECT * FROM videos WHERE channel_id=? ORDER BY CASE WHEN scheduled_at IS NULL THEN 1 ELSE 0 END, scheduled_at, id', channelId)
      .map(v => ({ ...v, tags: JSON.parse(v.tags || '[]'), hashtags: JSON.parse(v.hashtags || '[]'), waiting_for: v.remote ? this._waitingFor(v) : null }));
  }
  /**
   * Autosave from the channel table: only the fields sent are written, and only when they changed.
   * scheduled_at: a date, 'now', or a past time (= the next free lane slot). Takes effect at once:
   * DB, scheduler (woken), AI queue (an earlier time jumps it), cloud (pushed now).
   */
  updateVideo(id, patch) {
    const v = this.db.get('SELECT v.*, c.style FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.id=?', id);
    if (!v) return null;
    if (['uploading', 'done'].includes(v.status)) throw Object.assign(new Error(`Video is ${v.status === 'done' ? 'published' : 'uploading'}, can't edit`), { status: 409 });
    const sets = [], vals = [];
    let metaEdited = false;
    const put = (col, val) => { sets.push(`${col}=?`); vals.push(val); };
    if (patch.title !== undefined) {
      const t = String(patch.title ?? '').trim();
      if ([...t].length > 100) throw Object.assign(new Error('Title must be 100 characters or less'), { status: 400 });
      if ((t || null) !== (v.title || null)) { put('title', t || null); if (t) metaEdited = true; }
    }
    if (patch.description !== undefined) { const d = String(patch.description ?? '').slice(0, 4500); if ((d || null) !== (v.description || null)) { put('description', d || null); if (d.trim()) metaEdited = true; } }
    const listOf = (x, re) => (Array.isArray(x) ? x : String(x ?? '').split(re)).map(t => String(t).trim()).filter(Boolean);
    if (patch.tags !== undefined) { const j = JSON.stringify(listOf(patch.tags, ',')); if (j !== (v.tags || '[]')) { put('tags', j); if (j !== '[]') metaEdited = true; } }
    if (patch.hashtags !== undefined) { const j = JSON.stringify(listOf(patch.hashtags, /[\s,]+/)); if (j !== (v.hashtags || '[]')) put('hashtags', j); }
    let timeChanged = false, movedEarlier = false;
    if (patch.scheduled_at !== undefined) {
      let t = patch.scheduled_at === 'now' ? Date.now() : patch.scheduled_at ? +new Date(patch.scheduled_at) : null;
      if (t != null && !Number.isFinite(t)) throw Object.assign(new Error('Invalid date / time'), { status: 400 });
      if (t != null && t < Date.now()) t = Date.now();          // a past time = upload at the next free lane slot
      if (t !== v.scheduled_at) { put('scheduled_at', t); timeChanged = true; movedEarlier = t != null && (v.scheduled_at == null || t < v.scheduled_at); }
      if (v.retry_at && t != null) { put('retry_at', null); }   // a new time from you replaces a pending retry time
    }
    if (metaEdited) put('edited', 1);
    if (sets.length) this.db.run(`UPDATE videos SET ${sets.join(', ')} WHERE id=?`, ...vals, id);
    const cur = this.db.get('SELECT * FROM videos WHERE id=?', id);
    // a hand-written title makes the video uploadable even if AI never ran / failed (missing parts are filled at upload)
    if (metaEdited && cur.title && ['queued', 'failed'].includes(cur.status) && cur.ai_status !== 'running') {
      const mode = JSON.parse(v.style || '{}').mode;
      this.db.run(`UPDATE videos SET status=?, retry_count=CASE WHEN status='failed' THEN 0 ELSE retry_count END, ai_status=CASE WHEN ai_status IN ('done','pending','retry') THEN ai_status ELSE 'manual' END WHERE id=?`, mode === 'approval' && cur.status !== 'failed' ? 'awaiting_approval' : 'ready', id);
    }
    if (cur.scheduled_at == null) this.plan(v.channel_id);
    if (sets.length) {
      if (timeChanged && this.scheduler) this.scheduler.wake();
      if (movedEarlier || timeChanged) this.aiKick();
      if (this.cloud.sync) this.cloud.sync.pushNow().catch(() => {});
    }
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
    this.db.run(`UPDATE videos SET status=?, error=NULL, error_kind=NULL, retry_at=NULL, retry_count=0, scheduled_at=? WHERE id=?`, v.title ? 'ready' : 'queued', Date.now(), id);
    if (!v.title) this.db.run(`UPDATE videos SET ai_status='pending', ai_attempts=0 WHERE id=?`, id);
    if (this.scheduler) this.scheduler.wake();
    this.aiKick();
    return this.db.get('SELECT * FROM videos WHERE id=?', id);
  }
  skipVideo(id) { this.db.run(`UPDATE videos SET status='skipped' WHERE id=? AND status NOT IN ('uploading','done')`, id); return this.db.get('SELECT * FROM videos WHERE id=?', id); }

  /**
   * Everything that needs the user, each with a one-click fix: {id, level, text, actions:[{label, action, arg}]}.
   * action names are handled by the UI (open-profile, resume, retry, takeover, signin, unlock, legacy,
   * drive, settings, channel).
   */
  needsYou() {
    const items = [];
    const c = this.cloud, st = c.state;
    const add = (id, text, actions, level = 'warn') => items.push({ id, level, text, actions });
    if (c.notice && c.notice.kind === 'handed_over' && st !== 'online') add('handed', c.notice.text, [{ label: 'Sign in', action: 'signin' }], 'info');
    else if (!c.online && c.cfg.handedOverTo && st !== 'online') add('handed', `Signed out — now active on ${c.cfg.handedOverTo}`, [{ label: 'Sign in', action: 'signin' }], 'info');
    if (c.online) {
      const k = c.keys;
      if (k && !k.ready) {
        if (k.state === 'requesting') add('keys', 'Waiting for one of your other signed-in PCs to unlock the saved logins…', [{ label: 'Start fresh instead', action: 'start-fresh' }]);
        else add('keys', 'Your password was changed or reset: unlock the saved logins on this PC', [{ label: 'Unlock', action: 'unlock' }]);
      }
      if (k && k.ready && c._legacyNeeded) add('legacy', 'Enter your old sync passphrase once (from version 0.3.0)', [{ label: 'Enter passphrase', action: 'legacy' }]);
      const ap = c.activePc && c.activePc.status();
      if (c.singleActive && ap && !ap.me && ap.other) add('active', `UploadPilot is active on ${ap.other.pcName}`, [{ label: 'Take over', action: 'takeover' }], 'info');
      if (k && k.ready && !c.googleAuth().connected) add('drive', 'Connect Google Drive once (for every PC): it carries your Google logins and backups', [{ label: 'Connect Drive', action: 'drive' }]);
    }
    if (!this.settings.get('geminiKeys').length) add('gemini', 'Add a Gemini API key so titles and descriptions are written for you', [{ label: 'Add key', action: 'settings' }]);
    for (const ch of this.db.all(`SELECT c.id, c.name, c.status, c.status_reason, c.profile_id, p.login_state, p.login_note, p.number FROM channels c LEFT JOIN profiles p ON p.id=c.profile_id WHERE c.status IN ('active','paused','needs_you')`)) {
      const check = { label: 'Check sign-in', action: 'check-signin', arg: ch.id };
      if (ch.status === 'needs_you') add(`ch${ch.id}`, `${ch.name || 'Channel'}: ${ch.status_reason || 'needs you'}`, [{ label: 'Open profile', action: 'open-profile', arg: ch.id }, ...(isLoginReason(ch.status_reason) ? [check] : []), { label: 'Resume', action: 'resume', arg: ch.id }]);
      else if (ch.login_state === 'signed_out') add(`login${ch.id}`, `${ch.name || 'Channel'}: sign in needed`, [{ label: 'Open profile', action: 'open-profile', arg: ch.id }, check]);
      else if (ch.login_state === 'restore_failed') add(`login${ch.id}`, `${ch.name || 'Channel'}: ${ch.login_note || 'login not restored'}`, [{ label: 'Open profile', action: 'open-profile', arg: ch.id }, check]);
    }
    for (const v of this.db.all(`SELECT v.id, v.title, v.filename, v.error, v.status, v.channel_id, c.name FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.status IN ('failed','missing') ORDER BY v.id DESC LIMIT 20`)) {
      add(`v${v.id}`, `${v.name}: "${v.title || v.filename}" ${v.status === 'missing' ? 'file is missing' : 'failed — ' + humanizeError(v.error || '')}`, [{ label: 'Retry', action: 'retry', arg: v.id }], 'error');
    }
    // another PC's video whose PC does not answer (v0.3.2)
    if (this.cloud.files) {
      for (const v of this.db.all(`SELECT v.*, c.name AS channel_name FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.remote=1 AND v.drive_file_id IS NULL AND v.status IN ('queued','ready','awaiting_approval') AND c.status='active' LIMIT 200`)) {
        const w = this._waitingFor(v);
        if (!w) continue;
        if (w.state === 'offline') add(`file${v.id}`, `${v.channel_name}: Video is on ${w.from}, which is offline — turn it on or relink folder ("${v.title || v.filename}")`, [{ label: 'Skip', action: 'skip', arg: v.id }]);
        else if (w.state === 'failed') add(`file${v.id}`, `${v.channel_name}: ${w.from} could not send "${v.title || v.filename}"${w.error ? ` (${w.error})` : ''}`, [{ label: 'Skip', action: 'skip', arg: v.id }]);
      }
    }
    for (const r of this.db.all(`SELECT channel_id, c.name, COUNT(*) AS n FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.status='awaiting_approval' GROUP BY channel_id`)) {
      add(`ok${r.channel_id}`, `${r.name}: ${r.n} video(s) need your OK`, [{ label: 'Review', action: 'channel', arg: r.channel_id }], 'info');
    }
    return items;
  }

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
      needsYou: this.needsYou().length,
      needsYouItems: this.needsYou(),
      activeOn: this.cloud.online && this.cloud.activePc ? (this.cloud.activePc.status().activePcName || null) : (this.cloud.online ? this.cloud.pcName : null),
      activeIsMe: this.cloud.online ? !!(this.cloud.activePc && this.cloud.activePc.isActive) : true,
      pcCount: this.cloud.sync ? this.cloud.sync.status().pcs.length : 1,
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
      this.replanFuture();
    }
    return { settings: this.settings.publicView(), proxyImport: this._lastProxyImport || null };
  }
}

module.exports = { UploadPilotApp, proxyLabel };
