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
const { KeyManager } = require('./keys');
const { ActivePc } = require('./activePc');
const { AccountSync } = require('./accountSync');
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
    this.keys = null; this.activePc = null; this.account = null; this.decided = true; this.notice = null;
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
  /** v0.3.1: one active PC per account (tests of the 0.3.0 multi-PC behaviour switch it off). */
  get singleActive() { return this.cfg.singleActivePc !== false; }

  /** May this PC run autopilot / open profiles right now? */
  mayRun() {
    if (!this.decided) return false;                                   // still finding out whether another PC is active
    if (this.online) return !this.singleActive || !!(this.activePc && this.activePc.isActive);
    if (this.cfg.handedOverTo) return false;                           // handed over / lost the active role: stay quiet until signed in again
    return true;                                                       // offline mode / never signed in: works like 0.2
  }

  _ensureIdentity() {
    const c = this.cfg;
    if (!c.pcId || !c.pcName) this.settings.set({ cloud: { ...c, pcId: c.pcId || crypto.randomBytes(8).toString('hex'), pcName: c.pcName || os.hostname() || 'PC' } });
  }
  config() { return resolveCloudConfig({ settings: this.settings, dataDir: this.app.dataDir, resourcesPath: this.o.resourcesPath, secrets: this.secrets, bundledDir: this.o.bundledConfigDir, env: this.o.env || process.env }); }

  async start() {
    this.decided = false;   // until we know whether this PC is the active one, nothing starts
    try {
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
      if (u) { this._makeKeys(u); this.keys.loadCached(); await this._goOnline(u, { interactive: false }); }
      return this.status();
    } finally { this.decided = true; this.emit('change'); }
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
    if (this.online) await this._goOffline();
    this.settings.set({ cloud: { ...this.cfg, mode: 'cloud', lastEmail: email.trim(), handedOverTo: '' } });
    this.notice = null;
    this._makeKeys(u);
    if (!this.keys.loadCached() || this.keys.uid() !== u.uid) { /* fresh PC */ }
    try { const r = await this.keys.unlock(password); if (!r.ok) this.app.events.warn(r.reason === 'password_mismatch' ? 'Your password was reset: unlock the saved logins from another signed-in PC, or start fresh (Needs you)' : 'Account locked on this PC', { kind: 'needs_you' }); }
    catch (e) { this.app.events.warn(`Account key: ${e.message}`, { kind: 'cloud' }); }
    await this._goOnline(u, { interactive: true });
    this.decided = true;
    return this.status();
  }

  async signOut({ keepKey = false } = {}) {
    await this._goOffline();
    if (this.keys && !keepKey) this.keys.forget();
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

  _makeKeys(user) {
    if (this.keys && this.keys.uid() === user.uid) return this.keys;
    this.keys = new KeyManager({ store: this.store, root: () => `users/${user.uid}`, uid: () => user.uid, secrets: this.secrets, pcId: this.pcId, pcName: this.pcName, log: (lvl, m) => this.app.events.log(lvl, m, { kind: 'cloud' }) });
    return this.keys;
  }

  async _goOnline(user, { interactive = false } = {}) {
    this.user = user; this.state = 'connecting'; this.error = null;
    this._makeKeys(user);
    if (!this.keys.ready) { try { await this.keys.unlock(null); } catch (_) { /* offline: stays locked */ } }
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
    await this._checkLegacy();
    // account settings, Gemini keys, proxies and the Drive connection come first: everything else uses them
    this.account = new AccountSync({ app: this.app, cloud: this, store: this.store, root: () => this.root, keys: this.keys, pcId: this.pcId, pcName: this.pcName, pushMs: (this.o.syncOpts && this.o.syncOpts.pushMs) || 2000 });
    try { await withTimeout(this.account.load(), 20000, 'load account settings'); } catch (e) { this.app.events.warn(`Cloud: account settings not loaded yet (${e.message})`, { kind: 'cloud' }); }
    this.account.start();
    this.sync = new CloudSync({ app: this.app, store: this.store, root: this.root, pcId: this.pcId, pcName: this.pcName, keys: this.keys, onChange: () => this.emit('change'), ...(this.o.syncOpts || {}) });
    this.sync.onRemoteDone = id => this.app.onRemoteDone && this.app.onRemoteDone(id);
    this.sync.onVideosChanged = () => this.app.onVideosChanged && this.app.onVideosChanged();
    await this.sync.start();
    this.profileState = new ProfileStateSync({ db: this.app.db, drive: () => this.drive(), keys: this.keys, store: this.store, root: () => this.root, pcId: this.pcId, pcName: this.pcName, log: (lvl, m, detail) => this.app.events.log(lvl, m, { kind: 'cloud', detail }) });
    this.backup = new BackupWorker({ app: this.app, cloud: this, ...(this.o.backupOpts || {}) });
    this.backup.start();
    this._staleTimer = setInterval(() => this.recoverStale(), 60000);
    if (this._staleTimer.unref) this._staleTimer.unref();
    this.state = 'online';
    this.app.events.info(`Signed in as ${user.email} on ${this.pcName}`, { kind: 'cloud' });
    // one active PC per account
    this.activePc = new ActivePc({ store: this.store, root: () => this.root, pcId: this.pcId, pcName: this.pcName, serverNow: () => this.leases.serverNow(), ...(this.o.activeOpts || {}) });
    this.activePc.on('handover-request', req => this.handover(req).catch(e => this.app.events.error(`Hand-over failed: ${e.message}`, { kind: 'cloud' })));
    this.activePc.on('lost', by => this.onLostActive(by).catch(() => {}));
    this.activePc.on('change', () => this.emit('change'));
    this.activePc.on('active', () => { this.emit('change'); if (this.app.onBecameActive) this.app.onBecameActive(); });
    this._metaUnsub = this.store.watch(`${this.root}/meta`, {}, changes => this._onMeta(changes), e => this.app.events.warn(`Cloud listener meta: ${e.message}`, { kind: 'sync' }));
    if (this.singleActive) {
      try {
        await this.activePc.load();
        const other = this.activePc.holder();
        if (!other) { const r = await this.activePc.claim(); if (r.ok && r.from && r.from.stale) this.app.events.warn(`${r.from.pcName} stopped responding — this PC is now the active one`, { kind: 'cloud' }); }
        else this.app.events.info(`UploadPilot is active on ${other.pcName} — take over to run it here`, { kind: 'cloud' });
      } catch (e) { this.app.events.warn(`Cloud: could not check the active PC (${e.message})`, { kind: 'cloud' }); }
    }
    this.emit('change');
  }

  _onMeta(changes) {
    for (const c of changes) {
      const d = c.type === 'removed' ? null : c.data;
      if (c.id === 'activePc' || c.id === 'takeover') { if (this.activePc) this.activePc.onDoc(c.id, d); }
      else if (c.id === 'keys') { if (this.keys) this.keys.onKeysDoc(d); }
      else if (c.id === 'keyRequest') { if (this.keys) this.keys.onRequestDoc(d).then(got => { if (got) this._afterUnlock(); }).catch(() => {}); }
      else if (c.id === 'settings') { if (this.account) this.account.apply(d); }
      else if (c.id === 'drive') { if (this.account) this.account.applyDrive(d); }
    }
    this.emit('change');
  }

  /** The account key just became available (other PC answered / old passphrase entered): re-read what needs it. */
  /** 0.3.0 data saved with the old sync passphrase: migrate silently when this PC still has it, else ask once. */
  async _checkLegacy() {
    this._legacyNeeded = false;
    if (!this.keys || !this.keys.ready) return;
    try {
      if (!(await this.keys.legacyNeeded())) return;
      const old = this.secrets.get('syncPassphrase');
      if (old) { await this.keys.migrateLegacy(old); this.secrets.delete('syncPassphrase'); this.app.events.info('Moved from the sync passphrase to your account password — nothing else to enter', { kind: 'cloud' }); return; }
      this._legacyNeeded = true;
    } catch (_) { this._legacyNeeded = false; }
  }

  async _afterUnlock() {
    await this._checkLegacy();
    if (this.account) { await this.account.load().catch(() => {}); }
    if (this.sync) this.app.db.run('UPDATE profiles SET cloud_shadow=NULL');
    this.app.db.run(`UPDATE profiles SET login_state=NULL, login_note=NULL WHERE login_state='restore_failed'`);
    this.emit('change');
  }

  // ------------------------------------------------------------------ active PC hand-over
  /** UI: "UploadPilot is active on X since … Take over?" → Take over. */
  async takeOver() {
    if (!this.online || !this.activePc) throw Object.assign(new Error('Sign in first'), { status: 409 });
    this.app.events.info(`Taking over from ${(this.activePc.holder() || {}).pcName || 'the other PC'}…`, { kind: 'cloud' });
    const r = await this.activePc.requestTakeover({ onProgress: m => this.app.events.info(m, { kind: 'cloud' }) });
    if (r.ok) this.app.events.success(`This PC is now the active one${r.how === 'handed_over' ? ` (${r.from.pcName} handed over)` : r.how === 'stale' ? ` (${r.from.pcName} was not responding)` : r.how === 'timeout' ? ` (${r.from.pcName} did not answer in time)` : ''}`, { kind: 'cloud' });
    // logins of other PCs' last sessions are imported on each profile's next open (newest version wins)
    this.emit('change');
    return { ...this.status().activePc, how: r.how };
  }

  /**
   * Old PC: graceful hand-over, in order: stop new jobs -> finish/abort the upload in progress ->
   * save every open profile's login -> back up local-only videos that are due soon -> release leases
   * -> mark handed over -> sign out.
   */
  async handover(req) {
    if (this._handingOver) return;
    this._handingOver = true;
    const to = req.toPcName || 'another PC';
    try {
      this.app.events.info(`${to} asked to take over — finishing up here`, { kind: 'cloud' });
      await this.app.windDown({ waitMs: (this.o.activeOpts && this.o.activeOpts.handoverWaitMs) ?? 180000, reason: `hand-over to ${to}` });
      await this._backupForHandover((this.o.activeOpts && this.o.activeOpts.backupBudgetMs) ?? 120000);
      if (this.leases) await this.leases.stop({ release: true }).catch(() => {});
      await this.activePc.markHandedOver(req);
      if (this.sync) await this.sync.pushNow().catch(() => {});
      this.settings.set({ cloud: { ...this.cfg, handedOverTo: to } });
      this.notice = { kind: 'handed_over', text: `Signed out — now active on ${to}` };
      await this.signOut({ keepKey: true });
      this.app.events.warn(`Signed out — now active on ${to}`, { kind: 'cloud' });
    } finally { this._handingOver = false; }
  }

  /** Back up local files of videos due in the next 24 h (bounded), so the new PC can upload them. */
  async _backupForHandover(budgetMs) {
    if (!this.backup || !this.drive()) return 0;
    const t0 = Date.now(); let n = 0;
    const soon = Date.now() + 24 * 3600e3;
    const rows = this.app.db.all(`SELECT id FROM videos WHERE remote=0 AND drive_file_id IS NULL AND status IN ('queued','ai','awaiting_approval','ready','failed') AND (scheduled_at IS NULL OR scheduled_at<=?) ORDER BY scheduled_at LIMIT 50`, soon);
    for (const r of rows) {
      if (Date.now() - t0 > budgetMs) { this.app.events.warn(`Hand-over: ${rows.length - n} video(s) not backed up in time — they upload when this PC is active again`, { kind: 'backup' }); break; }
      const f = await this.backup.backupOne(r.id).catch(() => null);
      if (f) n++;
    }
    if (n) this.app.events.info(`Hand-over: ${n} video(s) backed up to Google Drive for the new PC`, { kind: 'backup' });
    return n;
  }

  /** This PC was replaced while away (asleep/offline): stop at once, never upload its stale logins, sign out. */
  async onLostActive(byName) {
    if (this._handingOver) return;
    this.app.events.warn(`${byName} took over while this PC was away — stopping here`, { kind: 'cloud' });
    await this.app.windDown({ waitMs: 0, noExport: true, reason: `lost active role to ${byName}` });
    this.settings.set({ cloud: { ...this.cfg, handedOverTo: byName } });
    this.notice = { kind: 'handed_over', text: `Signed out — now active on ${byName}` };
    await this.signOut({ keepKey: true });
  }

  async _goOffline() {
    clearInterval(this._staleTimer);
    if (this._metaUnsub) { try { this._metaUnsub(); } catch (_) { /* ignore */ } this._metaUnsub = null; }
    if (this.activePc) { this.activePc.stop(); this.activePc = null; }
    if (this.account) { this.account.stop(); this.account = null; }
    if (this.backup) { await this.backup.stop(); this.backup = null; }
    if (this.sync) { await this.sync.stop().catch(() => {}); this.sync = null; }
    if (this.leases) { await this.leases.stop({ release: true }).catch(() => {}); this.leases = null; }
    this.profileState = null;
  }

  async stop() { await this._goOffline(); if (this.store) { await this.store.close().catch(() => {}); this.store = null; } }

  // ------------------------------------------------------------------ account key (v0.3.1: no sync passphrase)
  _needKeys() { if (!this.online || !this.keys) throw Object.assign(new Error('Sign in first'), { status: 409 }); return this.keys; }
  /** 0.3.0 accounts: the old sync passphrase, once, so data saved with it stays readable everywhere. */
  async migrateLegacy(passphrase) { const r = await this._needKeys().migrateLegacy(passphrase); this._legacyNeeded = false; await this._afterUnlock(); return r; }
  /** Locked after a restart (no cached key) or a reset: unlock with the account password. */
  async unlock(password) {
    const k = this._needKeys();
    const r = await k.unlock(password);
    if (!r.ok) throw Object.assign(new Error(r.reason === 'password_mismatch' ? 'That password does not open the saved logins (it was reset). Get the key from another signed-in PC, or start fresh.' : 'Password needed'), { status: 400, reason: r.reason });
    await this._afterUnlock(); return { unlocked: true };
  }
  async requestKey() { return this._needKeys().requestFromOtherPc(); }
  async startFresh(password) { const r = await this._needKeys().startFresh(password); await this._afterUnlock(); return r; }
  /** Advanced → Change password: Firebase password + the data key wrapped again (old data stays readable). */
  async changePassword(oldPw, newPw) {
    const k = this._needKeys();
    if (!k.ready) throw Object.assign(new Error('Unlock the account on this PC first'), { status: 409 });
    if (!newPw || String(newPw).length < 6) throw Object.assign(new Error('Use at least 6 characters'), { status: 400 });
    try { await this.store.auth.changePassword(oldPw, newPw); } catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
    await k.rewrap(newPw);
    this.app.events.success('Password changed — your other PCs keep working', { kind: 'cloud' });
    return { changed: true };
  }
  /** Firebase reset e-mail. The saved logins need any one signed-in PC to hand the key over afterwards. */
  async forgotPassword(email) {
    const c = this.config();
    if (!c.configured) throw Object.assign(new Error('Cloud is not configured'), { status: 400 });
    this._makeStore(c);
    try { await this.store.auth.sendPasswordReset(String(email || this.cfg.lastEmail || '').trim()); } catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
    return { sent: true, note: 'After you set a new password, sign in here while one of your other PCs is still signed in: it hands this PC the key to your saved logins. If no PC is signed in anymore, Google logins and proxy passwords must be entered again.' };
  }
  passphrase() { return null; }
  /** OAuth client secret typed in Settings → Advanced: sealed (safeStorage), never in plain settings; shared with the account's other PCs. */
  setClientSecret(secret) {
    const v = String(secret || '').trim();
    if (v) this.secrets.set('googleClientSecret', v); else this.secrets.delete('googleClientSecret');
    this._gauth = null; this._drive = null;
    if (v && this.account && this.googleAuth().connected) this.account.publishDrive().catch(() => {});
    return { set: !!v };
  }   // 0.3.0 API (removed); kept so old callers don't crash

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
        getToken: () => ga.accessToken().catch(e => { if (e.revoked && this.account) { this._drive = null; this.account.markDriveRevoked().catch(() => {}); this.app.events.warn('Google Drive access was revoked — connect it again once (Needs you)', { kind: 'needs_you' }); } throw e; }), baseUrl: this.o.driveBaseUrl, fetchImpl: this.o.fetchImpl || globalThis.fetch, sleep: this.o.driveSleep,
        usageStore: { get: () => this.settings.get('cloud').driveUsage || {}, set: u => this.settings.set({ cloud: { ...this.settings.get('cloud'), driveUsage: u } }) },
        log: m => this.app.events.warn(m, { kind: 'backup' }),
      });
    }
    return this._drive;
  }
  async connectDrive() {
    const ga = this.googleAuth();
    const { url, done } = await ga.begin();
    done.then(r => { this._drive = null; this.app.events.success(`Google Drive connected${r.email ? ' (' + r.email + ')' : ''} — for every PC on this account`, { kind: 'cloud' }); if (this.account) this.account.publishDrive().catch(() => {}); this.emit('change'); })
      .catch(e => this.app.events.warn(`Google Drive: ${e.message}`, { kind: 'cloud' }));
    return { url };
  }
  async disconnectDrive() { await this.googleAuth().disconnect(); this._drive = null; if (this.account) await this.account.markDriveRevoked(); this.emit('change'); return { connected: false }; }

  // ------------------------------------------------------------------ jobs (used by ChannelRunner / scheduler)
  videoKey(v) { return `video_${v.cloud_id}`; }
  profileKey(p) { return `profile_${p.cloud_id}`; }

  /** Can this PC upload this video now? Local file: yes. Another PC's file: only as a take-over. */
  runnableHere(v, now = Date.now()) {
    if (!v.remote) return true;
    if (!this.online || !this.leases || !v.drive_file_id || !v.cloud_id) return false;
    if (this.leases.holder(this.videoKey(v))) return false;
    if (this.recovered.has(v.cloud_id)) return true;
    // single active PC: the other PCs are not uploading, so a backed-up video runs here at its time
    if (this.singleActive && this.activePc && this.activePc.isActive) return true;
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
    if (this.online && this.singleActive && !(this.activePc && this.activePc.isActive)) {
      const h = this.activePc && this.activePc.holder();
      throw Object.assign(new Error(h ? `UploadPilot is active on ${h.pcName} — take over first` : 'This PC is not the active one yet'), { code: 'NOT_ACTIVE', status: 409 });
    }
    if (!this.online && this.cfg.handedOverTo) throw Object.assign(new Error(`Signed out — UploadPilot is active on ${this.cfg.handedOverTo}`), { code: 'NOT_ACTIVE', status: 409 });
    if (!this.online || !prof.cloud_id) return;
    const r = await this.leases.claim(this.profileKey(prof), { kind: 'profile', extra: { profileNumber: prof.number, purpose } });
    if (!r.ok && !r.offline) {
      const who = r.holder ? r.holder.pcName : 'another PC';
      throw Object.assign(new Error(`Profile #${prof.number} is open on ${who}`), { code: 'PROFILE_LOCKED', status: 409, holder: who });
    }
    // download + decrypt a newer login BEFORE the browser starts (applied right after launch, before any page loads)
    if (this.profileState) {
      const fresh = this.app.db.get('SELECT * FROM profiles WHERE id=?', prof.id) || prof;
      try { await withTimeout(this.profileState.prepare(fresh), 120000, 'profile login download'); }
      catch (e) { this.app.events.warn(`Profile #${prof.number}: login not restored — ${e.message}`, { kind: 'cloud' }); }
    }
  }
  async afterLaunchProfile(prof, sess) {
    if (!this.profileState) return;
    const fresh = this.app.db.get('SELECT * FROM profiles WHERE id=?', prof.id) || prof;
    let r = null;
    try { r = await withTimeout(this.profileState.apply(fresh, sess.handle.context), 60000, 'profile login import'); }
    catch (e) { this.app.events.warn(`Profile #${prof.number}: login not restored — ${e.message}`, { kind: 'cloud', detail: e.stack }); return; }
    if (r && r.imported) {
      sess.restored = r;
      // after a restore: is the Google account really signed in? (youtube.com, in a throw-away tab)
      if (this.cfg.verifyAfterRestore !== false) await this.app.checkSignedIn(prof, sess, { log: true }).catch(() => {});
    }
  }
  async beforeCloseProfile(prof, sess) {
    if (!this.online || !this.profileState || sess.noExport || !sess.handle || (sess.handle.isClosed && sess.handle.isClosed())) return;
    const fresh = this.app.db.get('SELECT * FROM profiles WHERE id=?', prof.id);
    if (!fresh) return;
    try { await withTimeout(this.profileState.exportIfChanged(fresh, sess.handle.context, { reason: sess.exportReason || 'close' }), 90000, 'profile login export'); }
    catch (e) { this.app.events.warn(`Profile #${prof.number}: login not saved to the cloud — ${e.message}`, { kind: 'cloud', detail: e.stack }); }
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
      secretsProtected: this.secrets.osProtected,
      keys: this.keys ? { state: this.keys.state, ready: this.keys.ready, legacy: !!this.keys.legacyPass, requesting: this.keys.state === 'requesting' } : null,
      activePc: this.activePc ? this.activePc.status() : (this.cfg.handedOverTo ? { me: false, activePcName: this.cfg.handedOverTo, handedOver: true } : null),
      singleActive: this.singleActive, mayRun: this.mayRun(), notice: this.notice, handedOverTo: this.cfg.handedOverTo || null,
      account: this.account ? { ...this.account.counters, driveShared: !!(this.account.driveDoc && this.account.driveDoc.enc && !this.account.driveDoc.revoked) } : null,
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
