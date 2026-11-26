'use strict';
// v0.3.1 "everything follows the account": settings, Gemini keys, the proxy pool (with passwords) and
// the Google Drive connection travel between PCs, encrypted with the account data key.
//
//   users/{uid}/meta/settings = { enc, hash, updatedBy, updatedAt }   enc = data-key blob of {settings, proxies}
//   users/{uid}/meta/drive    = { enc, email, revoked, updatedBy, updatedAt }   enc = {refresh_token, email, clientId, clientSecret}
//
// Per-PC values never leave the PC: PC name/id, lanes, the API port/token, the browser path, the
// autopilot pause switch, cloud mode / emulator / Firebase config, Drive byte counters.
const crypto = require('crypto');

const SHARED_KEYS = ['videosPerDay', 'uploadWindow', 'delayRangeMin', 'minGapMinutes', 'geminiKeys', 'geminiModel', 'geminiBaseUrl', 'geminiMaxAttempts',
  'aiConcurrency', 'aiWriteAhead', 'aiMinGapMs', 'aiInlineTimeoutMs', 'upload', 'retry', 'keepAlive', 'allowNoProxy', 'pauseWhenActive', 'geminiLowRes', 'logRetentionDays', 'browser', 'proxyCheckUrl'];
const PER_PC_BROWSER = ['executablePath', 'channel'];

const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);

function sharedSettings(settings) {
  const s = settings.all(), out = {};
  for (const k of SHARED_KEYS) if (s[k] !== undefined) out[k] = JSON.parse(JSON.stringify(s[k]));
  if (out.browser) for (const k of PER_PC_BROWSER) delete out.browser[k];
  if (out.geminiLowRes) delete out.geminiLowRes.ffmpegPath;
  const b = { ...s.cloud.backup }; delete b.measuredBps;
  out.cloud = { backup: b, takeoverGraceMin: s.cloud.takeoverGraceMin, googleClientId: s.cloud.googleClientId || '' };
  return out;
}

class AccountSync {
  /** @param {{app, cloud, store, root:()=>string, keys, pcId, pcName, pushMs?}} o */
  constructor(o) { Object.assign(this, o); this.lastHash = null; this.appliedHash = null; this.timer = null; this.counters = { pushed: 0, applied: 0 }; this.driveDoc = null; }

  payload() {
    const proxies = this.app.db.all('SELECT host, port, username, password, label FROM proxies ORDER BY id').map(p => ({ host: p.host, port: p.port, username: p.username || '', password: p.password || '', label: p.label || null }));
    return { settings: sharedSettings(this.app.settings), proxies };
  }

  start() {
    this.timer = setInterval(() => this.pushIfChanged().catch(() => {}), this.pushMs || 2000);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  /** Local edits -> cloud (encrypted). The first push of a PC never overwrites an account that already has settings. */
  async pushIfChanged({ force = false } = {}) {
    if (!this.keys.ready || !this.loaded) return false;
    const p = this.payload();
    const h = hash(p);
    if (!force && (h === this.lastHash || h === this.appliedHash)) { this.lastHash = h; return false; }
    await this.store.set(`${this.root()}/meta/settings`, { enc: this.keys.encJson(p).toString('base64'), hash: h, updatedBy: this.pcId, updatedByName: this.pcName, updatedAt: this.store.SERVER_TS });
    this.lastHash = h; this.counters.pushed++;
    return true;
  }

  /** First load after sign-in: take the account's settings if there are any, else publish ours. */
  async load() {
    const d = await this.store.get(`${this.root()}/meta/settings`).catch(() => null);
    const dr = await this.store.get(`${this.root()}/meta/drive`).catch(() => null);
    this.loaded = true;
    if (d && d.enc) this.apply(d, { initial: true });
    else await this.pushIfChanged({ force: true }).catch(() => {});
    if (dr) this.applyDrive(dr);
    else if (this.cloud.googleAuth().connected) await this.publishDrive().catch(() => {});
  }

  /** Cloud -> local. */
  apply(d, { initial = false } = {}) {
    if (!d || !d.enc || !this.keys.ready) return false;
    if (d.updatedBy === this.pcId && !initial) return false;
    if (d.hash && (d.hash === this.lastHash || d.hash === this.appliedHash)) return false;
    let p;
    try { p = this.keys.decJson(Buffer.from(d.enc, 'base64')); } catch (e) { this.app.events.warn(`Account settings could not be read: ${e.message}`, { kind: 'cloud' }); return false; }
    const s = this.app.settings.all();
    const patch = {};
    for (const k of SHARED_KEYS) if (p.settings[k] !== undefined) patch[k] = k === 'browser' ? { ...p.settings.browser, executablePath: s.browser.executablePath, channel: s.browser.channel } : k === 'geminiLowRes' ? { ...p.settings.geminiLowRes, ffmpegPath: s.geminiLowRes.ffmpegPath } : p.settings[k];
    if (p.settings.cloud) patch.cloud = { ...s.cloud, backup: { ...s.cloud.backup, ...p.settings.cloud.backup, measuredBps: s.cloud.backup.measuredBps }, takeoverGraceMin: p.settings.cloud.takeoverGraceMin ?? s.cloud.takeoverGraceMin, googleClientId: p.settings.cloud.googleClientId || s.cloud.googleClientId };
    const beforeWin = JSON.stringify([s.uploadWindow, s.videosPerDay]);
    this.app.settings.set(patch);
    this._applyProxies(p.proxies || []);
    this.appliedHash = hash(this.payload());
    this.lastHash = this.appliedHash;
    this.counters.applied++;
    const after = this.app.settings.all();
    if (beforeWin !== JSON.stringify([after.uploadWindow, after.videosPerDay]) && this.app.replanFuture) this.app.replanFuture();
    if (this.app.aiKick) this.app.aiKick();
    this.app.events.emit('cloud', { ts: Date.now() });
    return true;
  }

  _applyProxies(list) {
    const db = this.app.db;
    const keep = new Set();
    for (const p of list) {
      db.run('INSERT OR IGNORE INTO proxies(host,port,username,password,label) VALUES(?,?,?,?,?)', p.host, p.port, p.username || '', p.password || '', p.label || null);
      const row = db.get(`SELECT * FROM proxies WHERE host=? AND port=? AND IFNULL(username,'')=?`, p.host, p.port, p.username || '');
      if (row && p.password && row.password !== p.password) db.run(`UPDATE proxies SET password=?, status='unknown' WHERE id=?`, p.password, row.id);
      if (row) keep.add(row.id);
    }
    // a proxy removed on another PC goes here too, unless a profile uses it
    for (const r of db.all('SELECT id FROM proxies')) if (!keep.has(r.id) && !db.get('SELECT id FROM profiles WHERE proxy_id=?', r.id)) db.run('DELETE FROM proxies WHERE id=?', r.id);
  }

  // ---------------- Google Drive connection (one connect for the whole account)
  async publishDrive() {
    if (!this.keys.ready) return false;
    const tok = this.cloud.secrets.get('googleDrive');
    if (!tok || !tok.refresh_token) return false;
    const g = this.cloud.config().google;
    const payload = { refresh_token: tok.refresh_token, email: tok.email || null, scope: tok.scope || null, clientId: g.clientId || '', clientSecret: g.clientSecret || '' };
    await this.store.set(`${this.root()}/meta/drive`, { enc: this.keys.encJson(payload).toString('base64'), email: tok.email || null, revoked: false, updatedBy: this.pcId, updatedByName: this.pcName, updatedAt: this.store.SERVER_TS });
    return true;
  }

  /** Another PC connected Drive (or it was revoked): mirror it here. */
  applyDrive(d) {
    this.driveDoc = d || null;
    if (!d) return false;
    if (d.revoked) {
      if (this.cloud.secrets.get('googleDrive')) { this.cloud.secrets.delete('googleDrive'); this.cloud._drive = null; this.app.events.warn('Google Drive was disconnected for the account — connect it again once', { kind: 'cloud' }); }
      return false;
    }
    if (!d.enc || !this.keys.ready) return false;
    let p;
    try { p = this.keys.decJson(Buffer.from(d.enc, 'base64')); } catch (e) { this.app.events.warn(`Google Drive connection could not be read: ${e.message}`, { kind: 'cloud' }); return false; }
    const cur = this.cloud.secrets.get('googleDrive');
    let changed = false;
    if (!cur || cur.refresh_token !== p.refresh_token) { this.cloud.secrets.set('googleDrive', { refresh_token: p.refresh_token, email: p.email, scope: p.scope, connectedAt: Date.now(), fromAccount: true }); changed = true; }
    if (p.clientSecret && !this.cloud.secrets.get('googleClientSecret') && !this.cloud.config().google.clientSecret) { this.cloud.secrets.set('googleClientSecret', p.clientSecret); changed = true; }
    if (p.clientId && !this.app.settings.get('cloud').googleClientId && p.clientId !== this.cloud.config().google.clientId) this.app.settings.set({ cloud: { ...this.app.settings.get('cloud'), googleClientId: p.clientId } });
    if (changed) { this.cloud._gauth = null; this.cloud._drive = null; if (d.updatedBy !== this.pcId) this.app.events.success(`Google Drive connected from your account${p.email ? ' (' + p.email + ')' : ''}`, { kind: 'cloud' }); }
    return changed;
  }

  async markDriveRevoked() {
    await this.store.set(`${this.root()}/meta/drive`, { enc: null, revoked: true, updatedBy: this.pcId, updatedByName: this.pcName, updatedAt: this.store.SERVER_TS }).catch(() => {});
  }
}

module.exports = { AccountSync, sharedSettings, SHARED_KEYS };
