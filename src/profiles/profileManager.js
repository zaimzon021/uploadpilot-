'use strict';
// Profile engine: isolated browser profiles (own user-data-dir, cookies, storage), each with an
// assigned SOCKS5 proxy reached through a per-profile local bridge. No fingerprint spoofing.
const fs = require('fs');
const path = require('path');
const { SocksBridge } = require('../proxy/socksBridge');
const { checkProxy } = require('../proxy/check');
const { parseProxyList, parseProxyLine, proxyLabel } = require('../proxy/parse');
const { launchProfileBrowser } = require('./browser');

const ACCOUNTS_HOST = /(^|\.)accounts\.google\.|\/ServiceLogin|\/signin\b|\/v3\/signin/i;
const plain = e => String((e && e.message) || e).replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0].replace(/^[a-zA-Z.]+: /, '').slice(0, 160);

/**
 * page.goto that understands redirects: Studio answers a signed-out profile with a redirect to
 * accounts.google.com, which Playwright reports as net::ERR_ABORTED / "frame was detached". That is
 * not an error: wait for the page to settle and read where it ended up.
 * Returns {url, signIn, error?, detail?}.
 */
async function gotoLanding(page, url, { timeout = 60000 } = {}) {
  let err = null;
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); }
  catch (e) { err = e; }
  if (err && !/ERR_ABORTED|frame was detached|Navigation .* interrupted|net::ERR_ABORTED|interrupted by another navigation/i.test(err.message || '')) {
    return { url: safeUrl(page), signIn: false, error: humanNetError(err), detail: String(err.message || err) };
  }
  if (err) { try { await page.waitForLoadState('domcontentloaded', { timeout: 30000 }); } catch (_) { /* best effort */ } }
  // a redirect may still be on its way
  for (let i = 0; i < 10 && !page.isClosed?.(); i++) { const u = safeUrl(page); if (u && u !== 'about:blank' && !/^data:|^chrome-error:/.test(u)) break; await new Promise(r => setTimeout(r, 300)); }
  const final = safeUrl(page);
  return { url: final, signIn: ACCOUNTS_HOST.test(final || '') };
}
const safeUrl = p => { try { return p.url(); } catch (_) { return ''; } };
function humanNetError(e) {
  const m = /net::(ERR_[A-Z_]+)/.exec((e && e.message) || '');
  const map = { ERR_PROXY_CONNECTION_FAILED: 'proxy connection failed', ERR_TUNNEL_CONNECTION_FAILED: 'proxy tunnel failed', ERR_SOCKS_CONNECTION_FAILED: 'proxy connection failed', ERR_NAME_NOT_RESOLVED: 'site not found', ERR_INTERNET_DISCONNECTED: 'no internet', ERR_CONNECTION_TIMED_OUT: 'connection timed out', ERR_TIMED_OUT: 'timed out', ERR_CONNECTION_REFUSED: 'connection refused', ERR_CONNECTION_RESET: 'connection reset' };
  if (m) return map[m[1]] || m[1].toLowerCase().replace(/^err_/, '').replace(/_/g, ' ');
  if (/Timeout/i.test((e && e.message) || '')) return 'timed out';
  return plain(e);
}

class ProfileManager {
  constructor({ db, settings, events, dataDir, launcher = launchProfileBrowser, proxyChecker = checkProxy }) {
    this.db = db; this.settings = settings; this.events = events; this.dataDir = dataDir;
    this.launcher = launcher; this.proxyChecker = proxyChecker;
    this.sessions = new Map(); // profileId -> { bridge, handle, purpose, openedAt }
    this._opening = new Map();
    // v0.3 cloud hooks (set by the app when cloud sync is on): profile lock + login snapshot sync
    //   beforeOpen(prof, purpose)  afterLaunch(prof, sess)  beforeClose(prof, sess)  afterClose(prof)
    this.hooks = null;
  }
  async _hook(name, ...args) { if (this.hooks && this.hooks[name]) return this.hooks[name](...args); }

  // ---------- proxies ----------
  addProxies(text) {
    const { proxies, errors } = parseProxyList(text);
    let added = 0;
    for (const p of proxies) {
      const r = this.db.run('INSERT OR IGNORE INTO proxies(host,port,username,password) VALUES(?,?,?,?)', p.host, p.port, p.username || '', p.password || '');
      added += r.changes;
    }
    return { added, parsed: proxies.length, errors };
  }
  /** Replace the pool with the pasted list; proxies still assigned to a profile are kept. */
  replaceProxyPool(text) {
    const { proxies, errors } = parseProxyList(text);
    const keep = new Set(proxies.map(p => `${p.host}:${p.port}:${p.username || ''}`));
    for (const row of this.db.all('SELECT p.*, (SELECT COUNT(*) FROM profiles f WHERE f.proxy_id=p.id) AS used FROM proxies p')) {
      if (!keep.has(`${row.host}:${row.port}:${row.username || ''}`) && !row.used) this.db.run('DELETE FROM proxies WHERE id=?', row.id);
    }
    const r = this.addProxies(text);
    return { ...r, errors };
  }
  /**
   * Sync the pool to the Settings textarea text. Lines whose password is masked (••••) keep the saved
   * proxy as-is; other lines are added, or update the saved password when host:port:user already exists.
   * Saved proxies missing from the text are removed unless a profile uses them.
   */
  syncProxyPool(text) {
    const MASK = '••••';
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const keptHostPort = new Set(lines.filter(l => l.includes(MASK)).map(l => l.split(':').slice(0, 2).join(':').toLowerCase()));
    const { proxies, errors } = parseProxyList(lines.filter(l => !l.includes(MASK)).join('\n'));
    const freshKeys = new Set(proxies.map(p => `${p.host}:${p.port}:${p.username || ''}`.toLowerCase()));
    let removed = 0, added = 0, updated = 0;
    for (const row of this.db.all('SELECT p.*, (SELECT COUNT(*) FROM profiles f WHERE f.proxy_id=p.id) AS used FROM proxies p')) {
      const hp = `${row.host}:${row.port}`.toLowerCase();
      if (keptHostPort.has(hp) || freshKeys.has(`${hp}:${row.username || ''}`.toLowerCase()) || row.used) continue;
      removed += this.db.run('DELETE FROM proxies WHERE id=?', row.id).changes;
    }
    for (const p of proxies) {
      const ins = this.db.run('INSERT OR IGNORE INTO proxies(host,port,username,password) VALUES(?,?,?,?)', p.host, p.port, p.username || '', p.password || '');
      if (ins.changes) { added++; continue; }
      const u = this.db.run("UPDATE proxies SET password=?, status='unknown' WHERE host=? AND port=? AND username=? AND password IS NOT ?", p.password || '', p.host, p.port, p.username || '', p.password || '');
      updated += u.changes;
    }
    return { added, updated, removed, parsed: proxies.length, errors, total: this.db.get('SELECT COUNT(*) AS n FROM proxies').n };
  }
  listProxies() {
    return this.db.all(`SELECT p.id, p.host, p.port, p.username, p.label, p.status, p.last_ip, p.last_check, p.last_error,
      (SELECT GROUP_CONCAT(number) FROM profiles f WHERE f.proxy_id=p.id) AS profiles FROM proxies p ORDER BY p.id`);
  }
  getProxy(id) { return id ? this.db.get('SELECT * FROM proxies WHERE id=?', id) : null; }
  pickFreeProxy() {
    return this.db.get(`SELECT p.*, (SELECT COUNT(*) FROM profiles f WHERE f.proxy_id=p.id) AS used FROM proxies p
      WHERE p.status != 'bad' ORDER BY used ASC, p.id ASC LIMIT 1`) || null;
  }
  async checkProxyById(id) {
    const p = this.getProxy(id);
    if (!p) throw new Error(`Proxy ${id} not found`);
    const s = this.settings.all();
    const r = await this.proxyChecker(p, { url: s.proxyCheckUrl, timeoutMs: s.proxyCheckTimeoutMs });
    this.db.run('UPDATE proxies SET status=?, last_ip=?, last_check=?, last_error=? WHERE id=?', r.ok ? 'ok' : 'bad', r.ip || p.last_ip, Date.now(), r.error || null, id);
    return { id, label: proxyLabel(p), ...r };
  }

  // ---------- profiles ----------
  listProfiles() {
    return this.db.all(`SELECT f.*, p.host AS proxy_host, p.port AS proxy_port, p.status AS proxy_status, p.last_ip AS proxy_ip,
      (SELECT c.id FROM channels c WHERE c.profile_id=f.id LIMIT 1) AS channel_id,
      (SELECT c.name FROM channels c WHERE c.profile_id=f.id LIMIT 1) AS channel_name
      FROM profiles f LEFT JOIN proxies p ON p.id=f.proxy_id ORDER BY f.number`).map(r => ({ ...r, open: this.sessions.has(r.id), purpose: this.sessions.get(r.id)?.purpose || null }));
  }
  getProfile(id) { return this.db.get('SELECT * FROM profiles WHERE id=?', id); }
  getProfileByNumber(n) { return this.db.get('SELECT * FROM profiles WHERE number=?', n); }

  createProfile({ name, proxyId, proxy, autoProxy = true } = {}) {
    const number = (this.db.get('SELECT MAX(number) AS m FROM profiles').m || 0) + 1;
    let pid = proxyId || null;
    if (!pid && proxy) {
      const p = typeof proxy === 'string' ? parseProxyLine(proxy) : proxy;
      this.db.run('INSERT OR IGNORE INTO proxies(host,port,username,password) VALUES(?,?,?,?)', p.host, p.port, p.username || '', p.password || '');
      pid = this.db.get(`SELECT id FROM proxies WHERE host=? AND port=? AND IFNULL(username,'')=IFNULL(?,'')`, p.host, p.port, p.username).id;
    }
    if (!pid && autoProxy) pid = this.pickFreeProxy()?.id || null;
    const dataDir = path.join(this.dataDir, 'profiles', `profile-${String(number).padStart(4, '0')}`);
    fs.mkdirSync(dataDir, { recursive: true });
    const r = this.db.run('INSERT INTO profiles(number,name,data_dir,proxy_id,created_at) VALUES(?,?,?,?,?)', number, name || `Profile ${number}`, dataDir, pid, Date.now());
    this.events.info(`Profile #${number} created${pid ? ` with proxy ${proxyLabel(this.getProxy(pid))}` : ' (no proxy)'}`, { kind: 'profile' });
    return this.getProfile(r.lastInsertRowid);
  }

  setProfileProxy(profileId, { proxyId, proxy } = {}) {
    let pid = proxyId ?? null;
    if (proxy) {
      const p = typeof proxy === 'string' ? parseProxyLine(proxy) : proxy;
      this.db.run('INSERT OR IGNORE INTO proxies(host,port,username,password) VALUES(?,?,?,?)', p.host, p.port, p.username || '', p.password || '');
      pid = this.db.get(`SELECT id FROM proxies WHERE host=? AND port=? AND IFNULL(username,'')=IFNULL(?,'')`, p.host, p.port, p.username).id;
    }
    this.db.run('UPDATE profiles SET proxy_id=? WHERE id=?', pid, profileId);
    return this.getProfile(profileId);
  }

  isOpen(id) { return this.sessions.has(id); }
  session(id) { return this.sessions.get(id) || null; }

  /**
   * Open a profile. purpose: 'manual' (normal window, for the user) | 'auto' (autopilot, minimized) | 'link'.
   * Runs a proxy health check first; refuses to open on a dead proxy (no IP leak).
   */
  async open(profileId, { purpose = 'manual', startUrl, skipProxyCheck = false, windowMode, headless } = {}) {
    if (this.sessions.has(profileId)) {
      const s = this.sessions.get(profileId);
      if ((purpose === 'auto' || purpose === 'keepalive') && s.purpose !== purpose) throw Object.assign(new Error('Profile is open for manual use'), { code: 'PROFILE_BUSY' });
      if (s.handle.isClosed()) { await this.close(profileId); } else return s;
    }
    if (this._opening.has(profileId)) return this._opening.get(profileId);
    // load rule: never more browsers than lanes (autopilot waits; manual windows count too)
    const maxBrowsers = Math.max(1, this.settings.get('lanes') || 3);
    if ((purpose === 'auto' || purpose === 'keepalive') && this.sessions.size + this._opening.size >= maxBrowsers) throw Object.assign(new Error(`Browser limit reached (${maxBrowsers} open)`), { code: 'BROWSER_LIMIT' });
    const p = (async () => {
      const prof = this.getProfile(profileId);
      if (!prof) throw new Error(`Profile ${profileId} not found`);
      await this._hook('beforeOpen', prof, purpose);       // cloud profile lock (throws PROFILE_LOCKED)
      try { return await this._openLocked(prof, profileId, { purpose, startUrl, skipProxyCheck, windowMode, headless }); }
      catch (e) { await this._hook('afterClose', prof).catch(() => {}); throw e; }
    })();
    this._opening.set(profileId, p);
    try { return await p; } finally { this._opening.delete(profileId); }
  }

  async _openLocked(prof, profileId, { purpose, startUrl, skipProxyCheck, windowMode, headless }) {
    {
      const cfg = this.settings.get('browser');
      let bridge = null, proxyInfo = null;
      if (prof.proxy_id) {
        const proxy = this.getProxy(prof.proxy_id);
        if (!skipProxyCheck) {
          const chk = await this.checkProxyById(proxy.id);
          if (!chk.ok) throw Object.assign(new Error(`Proxy ${proxyLabel(proxy)} failed health check: ${chk.error}`), { code: 'PROXY_DEAD' });
          proxyInfo = chk;
        }
        bridge = await new SocksBridge(proxy, { onError: (e, d) => this.events.warn(`Proxy bridge #${prof.number}: ${d.host}:${d.port} ${e.message}`, { kind: 'proxy' }) }).start();
      }
      let handle;
      try {
        handle = await this.launcher({
          userDataDir: prof.data_dir, proxyUrl: bridge ? bridge.url : null, cfg,
          windowMode: windowMode || (purpose === 'auto' || purpose === 'keepalive' ? cfg.windowMode : 'normal'),
          headless: headless ?? cfg.headless,
        });
      } catch (e) { if (bridge) await bridge.stop(); throw e; }
      const sess = { profileId, number: prof.number, bridge, handle, purpose, openedAt: Date.now(), exitIp: proxyInfo?.ip || null, cdpEndpoint: handle.cdpEndpoint };
      this.sessions.set(profileId, sess);
      handle.context.on('close', () => {
        if (this.sessions.get(profileId) === sess) {
          this.sessions.delete(profileId); clearInterval(sess.snapTimer); if (bridge) bridge.stop();
          this._hook('afterClose', prof).catch(() => {});           // window closed by hand: free the lock
        }
      });
      this.db.run('UPDATE profiles SET last_opened=? WHERE id=?', Date.now(), profileId);
      // newer login from another PC is imported before anything navigates
      await this._hook('afterLaunch', prof, sess);
      if (purpose !== 'auto' && purpose !== 'keepalive' && this.hooks && this.hooks.beforeClose) {
        // a hand-used window may be closed with the X button (no chance to export then): snapshot now and then
        const every = Math.max(1, cfg.snapshotEveryMin || 3) * 60000;
        sess.snapTimer = setInterval(() => { if (!sess.handle.isClosed()) this._hook('beforeClose', prof, sess).catch(() => {}); }, every);
        if (sess.snapTimer.unref) sess.snapTimer.unref();
      }
      this.events.info(`Profile #${prof.number} opened${purpose === 'auto' ? '' : purpose === 'keepalive' ? ' (daily keep-alive)' : ` (${purpose})`}${sess.exitIp ? ` · exit IP ${sess.exitIp}` : ''}`, { kind: 'profile' });
      if (startUrl) {
        const page = handle.context.pages()[0] || await handle.context.newPage();
        sess.landing = await gotoLanding(page, startUrl);
        if (sess.landing.error) this.events.warn(`Profile #${prof.number}: Studio did not load (${sess.landing.error})`, { kind: 'profile', detail: sess.landing.detail });
        else if (sess.landing.signIn && purpose !== 'link') {
          this.events.warn(`Profile #${prof.number}: sign in needed — the window is open for you`, { kind: 'needs_you', detail: `final URL ${sess.landing.url}` });
          this.db.run(`UPDATE profiles SET login_state='signed_out', login_note=? WHERE id=?`, 'Sign in needed', profileId);
        }
      }
      return sess;
    }
  }

  async close(profileId) {
    const s = this.sessions.get(profileId);
    if (!s) return false;
    this.sessions.delete(profileId);
    clearInterval(s.snapTimer);
    const prof = this.getProfile(profileId) || { id: profileId, number: s.number };
    await this._hook('beforeClose', prof, s).catch(() => {});   // save the login to the cloud if it changed
    try { await s.handle.close(); } catch (_) { /* ignore */ }
    if (s.bridge) await s.bridge.stop();
    await this._hook('afterClose', prof).catch(() => {});       // free the profile lock
    this.events.info(`Profile #${s.number} closed`, { kind: 'profile' });
    return true;
  }

  async deleteProfile(profileId, { removeData = true } = {}) {
    await this.close(profileId);
    const prof = this.getProfile(profileId);
    if (!prof) return false;
    this.db.run('UPDATE channels SET profile_id=NULL, status=?, status_reason=? WHERE profile_id=?', 'stopped', 'Profile deleted', profileId);
    this.db.run('DELETE FROM profiles WHERE id=?', profileId);
    if (removeData && prof.data_dir.startsWith(path.join(this.dataDir, 'profiles'))) fs.rmSync(prof.data_dir, { recursive: true, force: true });
    this.events.info(`Profile #${prof.number} deleted`, { kind: 'profile' });
    return true;
  }

  async closeAll() { for (const id of [...this.sessions.keys()]) await this.close(id); }
}

module.exports = { ProfileManager, gotoLanding, humanNetError };
