'use strict';
// Profile login sync between PCs.
// Raw profile folders can't move between Windows PCs (cookies are sealed with DPAPI for one user on
// one machine), so the login travels as a Playwright storageState instead: every cookie (httpOnly and
// secure ones included: SID, HSID, SSID, APISID, SAPISID, LSID, __Secure-*, __Host-*, on .google.com,
// accounts.google.com, .youtube.com, studio.youtube.com …) + localStorage + IndexedDB. It is gzip'd,
// encrypted with the account data key (AES-256-GCM) and stored in Google Drive under UploadPilot/profiles/.
// Firestore keeps {stateVersion, stateHash, stateFileId, stateCookies, stateGoogle} on the profile doc.
//
// v0.3.1 order on every open (manual, link, autopilot, keep-alive):
//   1. prepare()   BEFORE the browser starts: read the profile doc, download + decrypt a newer snapshot
//   2. launch the browser (nothing navigates yet)
//   3. apply()     context.addCookies + localStorage (+ setStorageState for IndexedDB) before any page loads
// Exports are guarded: a PC never uploads over a NEWER cloud version (stale PC), and never replaces a
// snapshot that has a Google sign-in with one that has none (fresh/signed-out window).
// v0.3.2: only the ACTIVE PC writes logins (checked locally and again inside the transaction against
// meta/activePc; firestore.rules enforce the same). A sign-in that was just seen in a window on the
// active PC (force) may replace a newer cloud copy: that copy can only have come from a PC that was
// not supposed to write.
const { storageStateHash } = require('./crypto');

// Google/YouTube auth cookies that mean "signed in" (any one of them on a Google/YouTube domain)
const AUTH_COOKIES = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID', 'SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID', 'HSID', 'SSID', 'APISID', 'LSID', '__Host-1PLSID', '__Host-3PLSID', 'LOGIN_INFO']);
const GOOGLE_DOMAIN = /(^|\.)(google\.[a-z.]+|youtube\.com|googleusercontent\.com|youtube-nocookie\.com)$/i;

function isGoogleCookie(c) { return GOOGLE_DOMAIN.test(String(c.domain || '').replace(/^\./, '')); }
function googleAuthCookies(cookies, now = Date.now() / 1000) {
  return (cookies || []).filter(c => isGoogleCookie(c) && AUTH_COOKIES.has(c.name) && (!(c.expires > 0) || c.expires > now));
}
function stateInfo(state) {
  const cookies = (state && state.cookies) || [];
  return { cookies: cookies.length, google: cookies.filter(isGoogleCookie).length, auth: googleAuthCookies(cookies).length };
}

async function exportStorageState(context) {
  return context.storageState({ indexedDB: true });
}

/** storageState cookie -> addCookies() input. Host-only cookies (no leading dot, e.g. __Host-*) go by url so they stay host-only. */
function toAddCookie(c) {
  const out = { name: c.name, value: c.value, httpOnly: !!c.httpOnly, secure: !!c.secure };
  if (c.sameSite) out.sameSite = c.sameSite;
  if (c.expires > 0) out.expires = c.expires;
  if (c.partitionKey) out.partitionKey = c.partitionKey;
  const domain = String(c.domain || '');
  if (domain.startsWith('.') && !c.name.startsWith('__Host-')) { out.domain = domain; out.path = c.path || '/'; }
  else out.url = `${c.secure || c.name.startsWith('__Host-') || c.name.startsWith('__Secure-') ? 'https' : 'http'}://${domain.replace(/^\./, '')}${c.name.startsWith('__Host-') ? '/' : (c.path || '/')}`;
  return out;
}

/**
 * Put a storageState into a (persistent) context before anything navigates.
 * Cookies go in with context.addCookies (one by one on a failure so a single odd cookie can't drop the
 * rest); localStorage is written on a routed blank page per origin (no network); IndexedDB via
 * setStorageState when Playwright has it. Returns {how, cookies, failed}.
 */
async function importStorageState(context, state, { log = () => {} } = {}) {
  let how = 'cookies';
  if (typeof context.setStorageState === 'function') {
    try { await context.setStorageState(state); how = 'setStorageState+cookies'; }
    catch (e) { log(`setStorageState failed (${firstLine(e)}), importing cookies + localStorage instead`); }
  } else if (typeof context.clearCookies === 'function') await context.clearCookies().catch(() => {});
  const cookies = (state.cookies || []).map(toAddCookie);
  let failed = 0;
  if (cookies.length && typeof context.addCookies === 'function') {
    try { await context.addCookies(cookies); }
    catch (_) { for (const c of cookies) { try { await context.addCookies([c]); } catch (e) { failed++; log(`cookie ${c.name} not imported: ${firstLine(e)}`); } } }
  }
  if (how === 'cookies' && typeof context.newPage === 'function') {
    for (const o of state.origins || []) {
      if (!o.localStorage || !o.localStorage.length) continue;
      const page = await context.newPage();
      try {
        await page.route('**/*', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>import</title>' }));
        await page.goto(o.origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.evaluate(items => { for (const { name, value } of items) localStorage.setItem(name, value); }, o.localStorage);
      } catch (e) { log(`localStorage for ${o.origin} not imported: ${firstLine(e)}`); }
      finally { await page.close().catch(() => {}); }
    }
  }
  return { how, cookies: cookies.length - failed, failed };
}

const firstLine = e => String((e && e.message) || e).replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 200);

class ProfileStateSync {
  /**
   * @param {object} o
   * @param {object} o.db                 local DB
   * @param {() => object|null} o.drive   DriveClient or null when Drive isn't connected
   * @param {object} o.keys               KeyManager (account data key)
   * @param {object} o.store              cloud store
   * @param {() => string} o.root         'users/<uid>'
   * @param {string} o.pcId
   * @param {string} o.pcName
   * @param {(lvl:string,msg:string,detail?:string)=>void} [o.log]
   * @param {() => boolean} [o.singleActive]   one active PC per account: only it may write logins
   * @param {() => boolean} [o.isActive]       is this PC the active one right now (local view)?
   */
  constructor(o) { Object.assign(this, o); this.log = o.log || (() => {}); this.exports = 0; this.imports = 0; this.skipped = 0; this.refused = 0; this.prepared = new Map(); }

  _ready() {
    if (!this.keys || !this.keys.ready) return { ok: false, why: 'the account is locked on this PC', code: 'KEY_LOCKED' };
    const drive = this.drive();
    if (!drive) return { ok: false, why: 'Google Drive is not connected', code: 'DRIVE' };
    return { ok: true, drive };
  }
  _note(profile, state, note) { this.db.run('UPDATE profiles SET login_state=?, login_note=? WHERE id=?', state, note, profile.id); }

  /** Fresh cloud fields for this profile (one read), copied into the local row. */
  async refresh(profile) {
    if (!profile.cloud_id) return profile;
    try {
      const d = await this.store.get(`${this.root()}/profiles/${profile.cloud_id}`);
      if (d && d.stateVersion && d.stateVersion !== profile.cloud_state_version) {
        this.db.run('UPDATE profiles SET cloud_state_version=?, cloud_state_hash=?, cloud_state_file=?, cloud_state_by=?, cloud_state_google=? WHERE id=?', d.stateVersion, d.stateHash || null, d.stateFileId || null, d.stateBy || null, d.stateGoogle ?? null, profile.id);
      }
    } catch (_) { /* offline: use what sync gave us */ }
    return this.db.get('SELECT * FROM profiles WHERE id=?', profile.id) || profile;
  }

  /** Step 1, BEFORE launch: download + decrypt a newer snapshot. Never throws; returns {state?|reason}. */
  async prepare(profile) {
    this.prepared.delete(profile.id);
    const p = await this.refresh(profile);
    if (!p.cloud_id || !(p.cloud_state_version > (p.state_version || 0)) || !p.cloud_state_file) return { needed: false };
    if (p.cloud_state_hash && p.cloud_state_hash === p.state_hash) { this.db.run('UPDATE profiles SET state_version=? WHERE id=?', p.cloud_state_version, p.id); return { needed: false, sameHash: true }; }
    const r = this._ready();
    if (!r.ok) {
      const msg = `Profile #${p.number}: login not restored — ${r.why}`;
      this.log('warn', msg); this._note(p, 'restore_failed', r.code === 'DRIVE' ? 'Connect Google Drive once to restore Google logins' : 'Unlock your account (sign in again) to restore Google logins');
      return { needed: true, reason: r.why, code: r.code };
    }
    try {
      const blob = await r.drive.downloadBuffer(p.cloud_state_file);
      const state = this.keys.decJson(blob);
      const prep = { state, version: p.cloud_state_version, by: p.cloud_state_by };
      this.prepared.set(p.id, prep);
      return { needed: true, ready: true, version: prep.version };
    } catch (e) {
      const why = e.code === 'LEGACY_PASSPHRASE' ? 'it was saved with the old sync passphrase — enter it once (Needs you)' : e.code === 'BAD_KEY' ? 'it was saved with a different account key' : e.status === 404 ? 'the saved copy is missing on Google Drive (connected to a different Google account?)' : firstLine(e);
      this.log('warn', `Profile #${p.number}: login not restored — ${why}`, e.stack);
      this._note(p, 'restore_failed', `Login not restored: ${why}`);
      return { needed: true, reason: why };
    }
  }

  /** Step 3, right after launch and before anything navigates. */
  async apply(profile, context) {
    const prep = this.prepared.get(profile.id);
    if (!prep) return { imported: false };
    this.prepared.delete(profile.id);
    const r = await importStorageState(context, prep.state, { log: m => this.log('info', `Profile #${profile.number}: ${m}`) });
    const h = storageStateHash(prep.state);
    this.db.run('UPDATE profiles SET state_version=?, state_hash=? WHERE id=?', prep.version, h, profile.id);
    let present = r.cookies;
    if (typeof context.cookies === 'function') { try { present = (await context.cookies()).length; } catch (_) { /* ignore */ } }
    const info = stateInfo(prep.state);
    this.imports++;
    this.log('info', `Profile #${profile.number}: login restored from cloud (v${prep.version}, ${present} cookies${prep.by ? ', from ' + prep.by : ''})`);
    this._note(profile, info.auth ? 'restored' : 'signed_out', info.auth ? null : 'The saved login has no Google sign-in');
    return { imported: true, version: prep.version, cookies: present, how: r.how, auth: info.auth };
  }

  /** Back-compat (tests / callers of 0.3.0): prepare + apply in one go. */
  async importIfNewer(profile, context) { const p = await this.prepare(profile); if (!p.ready) return { imported: false, reason: p.reason }; return this.apply(profile, context); }

  /** May this PC write logins? Local view (cheap); the transaction re-checks meta/activePc. */
  _notActive() { return this.singleActive && this.singleActive() && this.isActive && !this.isActive(); }
  _activeRefuse(ap) {
    if (!this.singleActive || !this.singleActive() || !ap || !ap.pcId) return null;
    if (ap.pcId !== this.pcId || ap.handedOver) return `${ap.handedOver ? 'this PC handed over' : `${ap.pcName || 'another PC'} is the active PC`} — only the active PC saves logins`;
    return null;
  }

  /**
   * Export + upload when the login changed. Call before the context closes.
   * force: a sign-in was just confirmed in this window on the active PC -> it may replace a newer cloud copy.
   */
  async exportIfChanged(profile, context, { reason = 'close', force = false } = {}) {
    if (!profile.cloud_id) return { exported: false, reason: 'not synced yet' };
    if (this._notActive()) { this.refused++; this.log('warn', `Profile #${profile.number}: login not saved — this PC is not the active one (only the active PC saves logins)`); return { exported: false, refused: 'not the active PC' }; }
    const state = await exportStorageState(context);
    const h = storageStateHash(state);
    if (h === profile.state_hash) { this.skipped++; return { exported: false, unchanged: true }; }
    const r = this._ready();
    if (!r.ok) return { exported: false, reason: r.why };
    const info = stateInfo(state);
    const p = `${this.root()}/profiles/${profile.cloud_id}`;
    // guard BEFORE uploading anything: a newer cloud copy, or a signed-in copy vs. a signed-out window
    const cur = await this.store.get(p).catch(() => null);
    const ap0 = this.singleActive && this.singleActive() ? await this.store.get(`${this.root()}/meta/activePc`).catch(() => null) : null;
    const refuse = this._activeRefuse(ap0) || this._refuse(profile, cur, info, { force });
    if (refuse) { this.refused++; this.log('warn', `Profile #${profile.number}: login not saved — ${refuse}`); return { exported: false, refused: refuse }; }
    const nextV = ((cur && cur.stateVersion) || 0) + 1;
    const file = await r.drive.putSmall({ parts: ['profiles'], name: `profile-${profile.cloud_id}-v${nextV}.state`, data: this.keys.encJson(state) });
    let res;
    try {
      res = await this.store.tx(async t => {
        const c = await t.get(p);
        const ap = this.singleActive && this.singleActive() ? await t.get(`${this.root()}/meta/activePc`) : null;
        const why = this._activeRefuse(ap) || this._refuse(profile, c, info, { force });
        if (why) return { refused: why };
        const v = ((c && c.stateVersion) || 0) + 1;
        t.set(p, { stateVersion: v, stateHash: h, stateFileId: file.id, stateBy: this.pcName, stateByPc: this.pcId, stateCookies: info.cookies, stateGoogle: info.auth, stateAt: this.store.SERVER_TS, updatedAt: this.store.SERVER_TS, updatedBy: this.pcId }, { merge: true });
        return { version: v, oldFile: c && c.stateFileId };
      });
    } catch (e) {
      await r.drive.remove(file.id).catch(() => {});
      if (e.code === 'permission-denied') { this.refused++; this.log('warn', `Profile #${profile.number}: login not saved — the cloud refused it (only the active PC saves logins)`); return { exported: false, refused: 'permission-denied' }; }
      throw e;
    }
    if (res.refused) { await r.drive.remove(file.id).catch(() => {}); this.refused++; this.log('warn', `Profile #${profile.number}: login not saved — ${res.refused}`); return { exported: false, refused: res.refused }; }
    if (res.oldFile && res.oldFile !== file.id) r.drive.remove(res.oldFile).catch(() => {});
    this.db.run('UPDATE profiles SET state_version=?, state_hash=?, cloud_state_version=?, cloud_state_hash=?, cloud_state_file=?, cloud_state_google=?, login_state=?, login_note=NULL WHERE id=?', res.version, h, res.version, h, file.id, info.auth, info.auth ? 'ok' : 'signed_out', profile.id);
    this.exports++;
    this.log('info', `Profile #${profile.number}: login saved to the cloud (v${res.version}, ${info.cookies} cookies${reason !== 'close' ? ', ' + reason : ''})`);
    return { exported: true, version: res.version, fileId: file.id, cookies: info.cookies, auth: info.auth };
  }

  _refuse(profile, cur, info, { force = false } = {}) {
    if (!cur) return null;
    const mine = profile.state_version || 0;
    if ((cur.stateVersion || 0) > mine && !(force && info.auth)) return `the cloud has a newer login (v${cur.stateVersion}, this PC has v${mine})`;
    if (!info.auth && (cur.stateGoogle > 0 || (cur.stateGoogle === undefined && cur.stateVersion > 0))) return 'this window has no Google sign-in; the signed-in copy in the cloud is kept';
    return null;
  }
}

module.exports = { ProfileStateSync, exportStorageState, importStorageState, toAddCookie, stateInfo, googleAuthCookies, isGoogleCookie, AUTH_COOKIES };
