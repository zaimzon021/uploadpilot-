'use strict';
// CloudService: everything v0.3 adds on top of the local app, in one place.
//   config -> Firebase Auth sign-in -> Firestore sync + leases -> profile login sync -> Drive backup
// When no cloud config is set, or the user picked "Use offline", none of this starts and the app
// behaves exactly like v0.2 (the local SQLite DB is the only store).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { SecretStore } = require('./secretStore');
const { LeaseManager } = require('./leases');
const { CloudSync } = require('./sync');
const { ProfileStateSync } = require('./profileState');
const { GoogleAuth } = require('./googleAuth');
const { DriveClient } = require('./drive');
const { BackupWorker } = require('./backup');
const { makeVerifier, checkVerifier } = require('./crypto');
const { withTimeout } = require('./store/common');

const REQUIRED_FB = ['apiKey', 'projectId', 'appId'];

function parseMaybeJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  const s = String(v).trim();
  try { return JSON.parse(s); } catch (_) { /* maybe the JS snippet from the console */ }
  const m = /\{[\s\S]*\}/.exec(s);
  if (!m) return null;
  try { return JSON.parse(m[0].replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":').replace(/'/g, '"').replace(/,\s*}/g, '}')); } catch (_) { return null; }
}

/** Read the first JSON file that exists. */
function readJsonFirst(files) {
  for (const f of files) { try { if (f && fs.existsSync(f)) return { data: JSON.parse(fs.readFileSync(f, 'utf8')), file: f }; } catch (_) { /* bad file: skip */ } }
  return { data: null, file: null };
}

/**
 * Cloud config, layered (first that has a value wins):
 *   Firebase / OAuth client ID:  Settings → Cloud  >  <data>/cloud-config.json  >  bundled config/cloud.default.json
 *   OAuth client secret:         Settings → Cloud (sealed with safeStorage)  >  env UPLOADPILOT_OAUTH_CLIENT_SECRET
 *                                >  config/cloud.secret.json (written by CI from the OAUTH_CLIENT_SECRET secret)
 * The secret is never in the repo or in plain settings.
 */
function resolveCloudConfig({ settings, dataDir, resourcesPath = process.resourcesPath, env = process.env, secrets = null, bundledDir = null }) {
  const c = settings.get('cloud');
  const cfgDirs = [bundledDir, resourcesPath && path.join(resourcesPath, 'config'), path.join(__dirname, '..', '..', 'config')].filter(Boolean);
  const user = readJsonFirst([path.join(dataDir, 'cloud-config.json')]);
  const bundled = env.UPLOADPILOT_NO_DEFAULT_CLOUD ? { data: null, file: null } : readJsonFirst(cfgDirs.map(d => path.join(d, 'cloud.default.json')));
  const secretFile = readJsonFirst(cfgDirs.map(d => path.join(d, 'cloud.secret.json')));
  const fb = x => x && (x.firebase || x.firebaseConfig) || null;
  const fromSettings = parseMaybeJson(c.firebaseConfig);
  const firebase = fromSettings || fb(user.data) || fb(bundled.data) || null;
  const source = fromSettings ? 'settings' : fb(user.data) ? user.file : fb(bundled.data) ? 'bundled default' : null;
  const sealed = secrets ? secrets.get('googleClientSecret') : null;
  const secretSrc = sealed ? 'settings' : env.UPLOADPILOT_OAUTH_CLIENT_SECRET ? 'env' : (user.data && user.data.google && user.data.google.clientSecret) ? 'cloud-config.json' : (secretFile.data && secretFile.data.google && secretFile.data.google.clientSecret) ? 'bundled (CI)' : null;
  const google = {
    clientId: c.googleClientId || (user.data && user.data.google && user.data.google.clientId) || (bundled.data && bundled.data.google && bundled.data.google.clientId) || '',
    clientSecret: sealed || env.UPLOADPILOT_OAUTH_CLIENT_SECRET || (user.data && user.data.google && user.data.google.clientSecret) || (secretFile.data && secretFile.data.google && secretFile.data.google.clientSecret) || '',
    secretSource: secretSrc,
  };
  const emulator = {
    firestore: (c.emulator && c.emulator.firestore) || env.FIRESTORE_EMULATOR_HOST || '',
    auth: (c.emulator && c.emulator.auth) || (env.FIREBASE_AUTH_EMULATOR_HOST ? `http://${env.FIREBASE_AUTH_EMULATOR_HOST}` : ''),
  };
  const missing = firebase ? REQUIRED_FB.filter(k => !firebase[k]) : REQUIRED_FB;
  return { firebase, google, emulator, configured: !!firebase && !missing.length, missing, source, projectId: firebase && firebase.projectId || null };
}

class CloudService extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.app
   * @param {object} [o.safeStorage]       Electron safeStorage
   * @param {(url:string)=>any} [o.openExternal]
   * @param {(cfg:object)=>object} [o.storeFactory]   tests inject a MemoryStore
   * @param {object} [o.googleEndpoints] [o.driveBaseUrl] [o.fetchImpl]   tests point these at mocks
   * @param {object} [o.leaseOpts]   {ttlSec, renewMs, timeoutMs}
   */
  constructor(o) {
    super();
    this.o = o; this.app = o.app;
    this.secrets = new SecretStore(path.join(this.app.dataDir, 'secrets.json'), o.safeStorage);
    this.state = 'off';            // off | unconfigured | offline | signed_out | connecting | online | error
    this.error = null; this.user = null;
    this.store = null; this.leases = null; this.sync = null; this.backup = null; this.profileState = null;
    this._drive = null; this._gauth = null;
    this.recovered = new Set();     // video cloud ids freed from a dead PC's stale "uploading"
    this.cacheDir = path.join(this.app.dataDir, 'cache');
    this._ensureIdentity();
  }

  get settings() { return this.app.settings; }
  get cfg() { return this.settings.get('cloud'); }
  get pcId() { return this.cfg.pcId; }
  get pcName() { return this.cfg.pcName || os.hostname(); }
  get online() { return this.state === 'online'; }
  get root() { return this.user ? `users/${this.user.uid}` : null; }

  _ensureIdentity() {
    const c = this.cfg;
    if (!c.pcId || !c.pcName) this.settings.set({ cloud: { ...c, pcId: c.pcId || crypto.randomBytes(8).toString('hex'), pcName: c.pcName || os.hostname() || 'PC' } });
  }
  config() { return resolveCloudConfig({ settings: this.settings, dataDir: this.app.dataDir, resourcesPath: this.o.resourcesPath, secrets: this.secrets, bundledDir: this.o.bundledConfigDir, env: this.o.env || process.env }); }

  async start() {
    const c = this.config();
    if (!c.configured) { this.state = 'unconfigured'; return this.status(); }
    if (this.cfg.mode === 'offline') { this.state = 'offline'; return this.status(); }
    // Nothing to restore (never signed in on this PC): don't even load the Firebase SDK; the app runs
    // locally exactly like v0.2 until the user signs in.
    if (!this.o.storeFactory && !this.secrets.has('firebaseAuth')) { this.state = 'signed_out'; return this.status(); }
    try { this._makeStore(c); } catch (e) { this.state = 'error'; this.error = `Firebase setup failed: ${e.message}`; this.app.events.error(this.error, { kind: 'cloud' }); return this.status(); }
    this.state = 'signed_out';
    let u = null;
    try { u = await withTimeout(this.store.auth.ready(), 15000, 'sign-in restore'); } catch (e) { this.error = e.message; }
    if (u) await this._goOnline(u);
    return this.status();
  }

  _makeStore(c) {
    if (this.store) return this.store;
    if (this.o.storeFactory) this.store = this.o.storeFactory(c, this);
    else {
      const { FirestoreStore } = require('./store/firestoreStore');
      try { require('firebase/firestore').setLogLevel('silent'); } catch (_) { /* ignore */ }
      this.store = new FirestoreStore({ firebaseConfig: c.firebase, emulator: c.emulator, secrets: this.secrets, appName: `uploadpilot-${this.pcId}` });
    }
    return this.store;
  }

  async signIn(email, password, { create = false } = {}) {
    const c = this.config();
    if (!c.configured) throw Object.assign(new Error(`Cloud is not configured (missing ${c.missing.join(', ')}) — paste the Firebase config in Settings → Cloud`), { status: 400 });
    this._makeStore(c);
    if (!email || !password) throw Object.assign(new Error('Email and password are required'), { status: 400 });
    let u;
    try { u = create ? await this.store.auth.signUp(email.trim(), password) : await this.store.auth.signIn(email.trim(), password); }
    catch (e) { throw Object.assign(new Error(e.message), { status: 401, code: e.code }); }
    this.settings.set({ cloud: { ...this.cfg, mode: 'cloud', lastEmail: email.trim() } });
    await this._goOnline(u);
    return this.status();
  }

  async signOut() {
    await this._goOffline();
    if (this.store) { try { await this.store.auth.signOut(); } catch (_) { /* ignore */ } }
    this.user = null; this.state = this.config().configured ? 'signed_out' : 'unconfigured';
    if (!this.o.storeFactory) this.secrets.delete('firebaseAuth');
    this.settings.set({ cloud: { ...this.cfg, mode: 'auto' } });
    this.emit('change');
    return this.status();
  }

  async useOffline() {
    await this._goOffline();
    this.settings.set({ cloud: { ...this.cfg, mode: 'offline' } });
    this.state = this.config().configured ? 'offline' : 'unconfigured';
    this.emit('change');
    return this.status();
  }

  /** Leave offline mode / reload config (after Settings → Cloud changes). */
  async reconnect() {
    await this._goOffline();
    if (this.store) { await this.store.close().catch(() => {}); this.store = null; }
    this.settings.set({ cloud: { ...this.cfg, mode: this.cfg.mode === 'offline' ? 'auto' : this.cfg.mode } });
    this._gauth = null; this._drive = null;
    return this.start();
  }

  async _goOnline(user) {
    this.user = user; this.state = 'connecting'; this.error = null;
    const lo = { ttlSec: this.cfg.leaseTtlSec, renewMs: this.cfg.leaseRenewSec * 1000, ...(this.o.leaseOpts || {}) };
    this.leases = new LeaseManager({ store: this.store, root: this.root, pcId: this.pcId, pcName: this.pcName, ...lo });
    this.leases.on('lost', (key, why) => { this.app.events.warn(`Lost ${key.replace('_', ' ')} (${why})`, { kind: 'cloud' }); this.emit('lease-lost', key); });
    this.leases.on('takeover', (key, prev) => this.app.events.warn(`Took over ${key.split('_')[0]} from ${prev && prev.pcName} (its lease had expired)`, { kind: 'takeover' }));
    this.leases.on('change', () => this.emit('change'));
    try {
      await this.leases.syncClock();
      await withTimeout(this.store.set(`${this.root}/pcs/${this.pcId}`, { name: this.pcName, version: require('../../package.json').version, platform: process.platform, lastSeen: this.store.SERVER_TS }, { merge: true }), 15000, 'register PC');
    } catch (e) { this.app.events.warn(`Cloud: ${e.message} — working from the local copy until the connection is back`, { kind: 'cloud' }); }
    this.leases.watch();
    this.sync = new CloudSync({ app: this.app, store: this.store, root: this.root, pcId: this.pcId, pcName: this.pcName, passphrase: () => this.passphrase(), onChange: () => this.emit('change'), ...(this.o.syncOpts || {}) });
    this.sync.onRemoteDone = id => this.app.onRemoteDone && this.app.onRemoteDone(id);
    await this.sync.start();
    this.profileState = new ProfileStateSync({ db: this.app.db, drive: () => this.drive(), passphrase: () => this.passphrase(), store: this.store, root: () => this.root, pcId: this.pcId, pcName: this.pcName, log: (lvl, m) => this.app.events.log(lvl, m, { kind: 'cloud' }) });
    this.backup = new BackupWorker({ app: this.app, cloud: this, ...(this.o.backupOpts || {}) });
    this.backup.start();
    this._staleTimer = setInterval(() => this.recoverStale(), 60000);
    if (this._staleTimer.unref) this._staleTimer.unref();
    this.state = 'online';
    this.app.events.info(`Cloud sync on — signed in as ${user.email} on ${this.pcName}`, { kind: 'cloud' });
    this.emit('change');
  }

  async _goOffline() {
    clearInterval(this._staleTimer);
    if (this.backup) { await this.backup.stop(); this.backup = null; }
    if (this.sync) { await this.sync.stop().catch(() => {}); this.sync = null; }
    if (this.leases) { await this.leases.stop({ release: true }).catch(() => {}); this.leases = null; }
    this.profileState = null;
  }

  async stop() { await this._goOffline(); if (this.store) { await this.store.close().catch(() => {}); this.store = null; } }

  // ------------------------------------------------------------------ passphrase
  passphrase() { return this.secrets.get('syncPassphrase'); }
  /** OAuth client secret typed in Settings → Cloud: sealed (safeStorage), never kept in plain settings. */
  setClientSecret(secret) { const v = String(secret || '').trim(); if (v) this.secrets.set('googleClientSecret', v); else this.secrets.delete('googleClientSecret'); this._gauth = null; this._drive = null; return { set: !!v }; }
  async setPassphrase(pass, { force = false } = {}) {
    if (!pass || String(pass).length < 8) throw Object.assign(new Error('Use at least 8 characters for the sync passphrase'), { status: 400 });
    if (this.online) {
      const p = `${this.root}/meta/sync`;
      const meta = await withTimeout(this.store.get(p), 15000, 'read sync meta').catch(() => null);
      if (meta && meta.verifier && !checkVerifier(meta.verifier, pass) && !force) throw Object.assign(new Error('This passphrase is different from the one your other PCs use. Enter the same one (or force a new one — older profile logins become unreadable).'), { status: 409 });
      if (!meta || !meta.verifier || force) await this.store.set(p, { verifier: makeVerifier(pass), setBy: this.pcName, setAt: this.store.SERVER_TS }, { merge: true });
    }
    this.secrets.set('syncPassphrase', String(pass));
    // proxy passwords from other PCs can be read now
    if (this.sync) { this.app.db.run('UPDATE profiles SET cloud_shadow=NULL'); }
    return { set: true };
  }

  // ------------------------------------------------------------------ Google Drive
  googleAuth() {
    const g = this.config().google;
    if (!this._gauth || this._gauth.clientId !== g.clientId) {
      this._gauth = new GoogleAuth({ clientId: g.clientId, clientSecret: g.clientSecret, secrets: this.secrets, openExternal: this.o.openExternal, endpoints: this.o.googleEndpoints, fetchImpl: this.o.fetchImpl || globalThis.fetch });
      this._drive = null;
    }
    return this._gauth;
  }
  drive() {
    const ga = this.googleAuth();
    if (!ga.connected) return null;
    if (!this._drive) {
      this._drive = new DriveClient({
        getToken: () => ga.accessToken(), baseUrl: this.o.driveBaseUrl, fetchImpl: this.o.fetchImpl || globalThis.fetch, sleep: this.o.driveSleep,
        usageStore: { get: () => this.settings.get('cloud').driveUsage || {}, set: u => this.settings.set({ cloud: { ...this.settings.get('cloud'), driveUsage: u } }) },
        log: m => this.app.events.warn(m, { kind: 'backup' }),
      });
    }
    return this._drive;
  }
  async connectDrive() {
    const ga = this.googleAuth();
    const { url, done } = await ga.begin();
    done.then(r => { this._drive = null; this.app.events.success(`Google Drive connected${r.email ? ' (' + r.email + ')' : ''}`, { kind: 'cloud' }); this.emit('change'); })
      .catch(e => this.app.events.warn(`Google Drive: ${e.message}`, { kind: 'cloud' }));
    return { url };
  }
  async disconnectDrive() { await this.googleAuth().disconnect(); this._drive = null; this.emit('change'); return { connected: false }; }

  // ------------------------------------------------------------------ jobs (used by ChannelRunner / scheduler)
  videoKey(v) { return `video_${v.cloud_id}`; }
  profileKey(p) { return `profile_${p.cloud_id}`; }

  /** Can this PC upload this video now? Local file: yes. Another PC's file: only as a take-over. */
  runnableHere(v, now = Date.now()) {
    if (!v.remote) return true;
    if (!this.online || !this.leases || !v.drive_file_id || !v.cloud_id) return false;
    if (this.leases.holder(this.videoKey(v))) return false;
    if (this.recovered.has(v.cloud_id)) return true;
    const graceMs = (this.cfg.takeoverGraceMin ?? 120) * 60000;
    return v.scheduled_at != null && now - v.scheduled_at > graceMs;
  }

  async claimVideo(v) {
    if (this.online && !v.cloud_id && this.sync) { this.sync._assignIds(); v = this.app.db.get('SELECT * FROM videos WHERE id=?', v.id) || v; }
    if (!this.online || !v.cloud_id) return { ok: !v.remote, offline: true };
    const r = await this.leases.claim(this.videoKey(v), { kind: 'video', extra: { videoId: v.cloud_id, channelId: this.app.db.get('SELECT cloud_id FROM channels WHERE id=?', v.channel_id)?.cloud_id || null, title: v.title || v.filename } });
    if (r.offline && !v.remote) return { ok: true, offline: true };   // our own file: keep working without the cloud
    return r;
  }
  noteVideo(v, fields) { if (this.leases && v.cloud_id) this.leases.note(this.videoKey(v), fields); }
  async releaseVideo(v) { if (this.leases && v.cloud_id) await this.leases.release(this.videoKey(v)); this.recovered.delete(v.cloud_id); }

  /** Take-over: download another PC's video from Drive into the cache. Caller deletes it after. */
  async fetchForTakeover(v) {
    const drive = this.drive();
    if (!drive) throw new Error('Google Drive is not connected (needed to take over another PC\'s video)');
    const dest = path.join(this.cacheDir, `${v.cloud_id}${path.extname(v.filename) || '.mp4'}`);
    await drive.download(v.drive_file_id, dest);
    return dest;
  }

  /** After a successful YouTube upload: drop the Drive backup if the setting says so. */
  async afterUploaded(v) {
    if (!v.drive_file_id || !this.cfg.backup.deleteAfterUpload) return;
    const drive = this.drive(); if (!drive) return;
    try { await drive.remove(v.drive_file_id); this.app.db.run('UPDATE videos SET drive_file_id=NULL WHERE id=?', v.id); } catch (e) { this.app.events.warn(`Could not delete Drive backup of ${v.filename}: ${e.message}`, { kind: 'backup' }); }
  }

  /** A video stuck in "uploading" whose lease is gone (its PC died) goes back to ready, once. */
  recoverStale(now = Date.now()) {
    if (!this.online || !this.leases || !this.sync || !this.sync.initialLoaded.videos) return 0;
    let n = 0;
    const ttl = this.leases.ttlSec * 1000;
    for (const v of this.app.db.all(`SELECT * FROM videos WHERE status='uploading' AND cloud_id IS NOT NULL`)) {
      if (this.app.runner.live.has(v.channel_id) && this.app.runner.live.get(v.channel_id).videoId === v.id) continue;   // ours, running
      if (this.leases.holder(this.videoKey(v))) continue;
      const shadow = JSON.parse(v.cloud_shadow || '{}');
      const lastLease = this.leases.remote.get(this.videoKey(v));
      if (lastLease && this.leases.serverNow() - (lastLease.renewedAt || 0) < ttl) continue;
      this.app.db.run(`UPDATE videos SET status='ready', error=? WHERE id=? AND status='uploading'`, `Recovered: ${lastLease ? lastLease.pcName : shadow.updatedBy || 'another PC'} stopped responding`, v.id);
      this.recovered.add(v.cloud_id); n++;
      this.app.events.warn(`${v.filename}: the PC uploading it stopped responding — job is free again`, { channelId: v.channel_id, kind: 'takeover' });
    }
    return n;
  }

  // ------------------------------------------------------------------ profile hooks (ProfileManager)
  async beforeOpenProfile(prof, purpose) {
    if (!this.online || !prof.cloud_id) return;
    const r = await this.leases.claim(this.profileKey(prof), { kind: 'profile', extra: { profileNumber: prof.number, purpose } });
    if (r.ok) return;
    if (r.offline) return;   // can't reach the cloud: the local open is still allowed (logged)
    const who = r.holder ? r.holder.pcName : 'another PC';
    throw Object.assign(new Error(`Profile #${prof.number} is open on ${who}`), { code: 'PROFILE_LOCKED', status: 409, holder: who });
  }
  async afterLaunchProfile(prof, sess) {
    if (!this.online || !this.profileState) return;
    const fresh = this.app.db.get('SELECT * FROM profiles WHERE id=?', prof.id);
    try { await withTimeout(this.profileState.importIfNewer(fresh, sess.handle.context), 120000, 'profile login import'); }
    catch (e) { this.app.events.warn(`Profile #${prof.number}: could not import the login from the cloud: ${e.message}`, { kind: 'cloud' }); }
  }
  async beforeCloseProfile(prof, sess) {
    if (!this.online || !this.profileState || sess.noExport || !sess.handle || (sess.handle.isClosed && sess.handle.isClosed())) return;
    const fresh = this.app.db.get('SELECT * FROM profiles WHERE id=?', prof.id);
    if (!fresh) return;
    try { await withTimeout(this.profileState.exportIfChanged(fresh, sess.handle.context), 90000, 'profile login export'); }
    catch (e) { this.app.events.warn(`Profile #${prof.number}: could not save the login to the cloud: ${e.message}`, { kind: 'cloud' }); }
  }
  async afterCloseProfile(prof) { if (this.leases && prof.cloud_id) await this.leases.release(this.profileKey(prof)); }

  /** "running on PC-x" for a profile / video, for the UI */
  holderName(key) { const h = this.leases && this.leases.holder(key); return h ? { pcId: h.pcId, pcName: h.pcName, me: h.pcId === this.pcId, state: h.state || null, since: h.renewedAt } : null; }

  status() {
    const c = this.config();
    const ga = (() => { try { return this.googleAuth(); } catch (_) { return null; } })();
    return {
      state: this.state, error: this.error, configured: c.configured, configSource: c.source, missing: c.missing,
      emulator: !!(c.emulator.firestore), mode: this.cfg.mode, user: this.user, lastEmail: this.cfg.lastEmail || '',
      pc: { id: this.pcId, name: this.pcName },
      passphraseSet: !!this.passphrase(), secretsProtected: this.secrets.osProtected,
      projectId: c.projectId,
      drive: { clientConfigured: !!c.google.clientId, clientId: c.google.clientId, secretSet: !!c.google.clientSecret, secretSource: c.google.secretSource, connected: !!(ga && ga.connected), account: ga ? ga.account : null, bytesToday: this._drive ? this._drive.bytesToday() : 0, blockedUntil: this._drive ? this._drive.blockedUntil : 0 },
      backup: this.backup ? this.backup.status() : null,
      sync: this.sync ? this.sync.status() : null,
      quota: this.store ? this.store.stats.snapshot() : null,
      leases: this.leases ? this.leases.active().map(l => ({ key: l.key, kind: l.kind, pcName: l.pcName, me: l.pcId === this.pcId, state: l.state || null, title: l.title || null })) : [],
      clockOffsetMs: this.leases ? this.leases.offsetMs : 0,
      profileSync: this.profileState ? { exports: this.profileState.exports, imports: this.profileState.imports, unchanged: this.profileState.skipped } : null,
    };
  }
}

module.exports = { CloudService, resolveCloudConfig, parseMaybeJson };
