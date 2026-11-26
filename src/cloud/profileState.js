'use strict';
// Profile login sync between PCs.
// Raw profile folders can't move between Windows PCs (cookies are sealed with DPAPI for one user on
// one machine), so the login travels as a Playwright storageState instead: cookies + localStorage +
// IndexedDB. It is encrypted (AES-256-GCM, scrypt key from the sync passphrase) and stored in
// Google Drive under UploadPilot/profiles/. Firestore keeps {stateVersion, stateHash, stateFileId}
// on the profile doc; a PC imports a newer snapshot before the first navigation.
const { encryptJson, decryptJson, storageStateHash } = require('./crypto');

async function exportStorageState(context) {
  return context.storageState({ indexedDB: true });
}

/**
 * Put a storageState into a (persistent) context before anything navigates.
 * Prefers context.setStorageState (Playwright ≥1.5x: clears and sets cookies, localStorage, IndexedDB);
 * falls back to cookies + localStorage written on a routed blank page (no network traffic).
 */
async function importStorageState(context, state, { log = () => {} } = {}) {
  if (typeof context.setStorageState === 'function') {
    try { await context.setStorageState(state); return 'setStorageState'; }
    catch (e) { log(`setStorageState failed (${e.message.split('\n')[0]}), importing cookies + localStorage instead`); }
  }
  await context.clearCookies();
  if (state.cookies && state.cookies.length) await context.addCookies(state.cookies);
  for (const o of state.origins || []) {
    if (!o.localStorage || !o.localStorage.length) continue;
    const page = await context.newPage();
    try {
      await page.route('**/*', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>import</title>' }));
      await page.goto(o.origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.evaluate(items => { for (const { name, value } of items) localStorage.setItem(name, value); }, o.localStorage);
    } finally { await page.close().catch(() => {}); }
  }
  return 'manual';
}

class ProfileStateSync {
  /**
   * @param {object} o
   * @param {object} o.db                 local DB
   * @param {() => object|null} o.drive   DriveClient or null when Drive isn't connected
   * @param {() => string|null} o.passphrase
   * @param {object} o.store              cloud store
   * @param {() => string} o.root         'users/<uid>'
   * @param {string} o.pcId
   * @param {string} o.pcName
   * @param {(lvl:string,msg:string)=>void} [o.log]
   */
  constructor(o) { Object.assign(this, o); this.log = o.log || (() => {}); this.exports = 0; this.imports = 0; this.skipped = 0; }

  _ready() {
    const drive = this.drive(), pass = this.passphrase();
    if (!drive) return { ok: false, why: 'Google Drive is not connected' };
    if (!pass) return { ok: false, why: 'sync passphrase is not set' };
    return { ok: true, drive, pass };
  }

  /** Import the newest snapshot if this PC's copy is older or missing. Call right after launch. */
  async importIfNewer(profile, context) {
    if (!profile.cloud_id || !(profile.cloud_state_version > (profile.state_version || 0)) || !profile.cloud_state_file) return { imported: false };
    if (profile.cloud_state_hash && profile.cloud_state_hash === profile.state_hash) {
      this.db.run('UPDATE profiles SET state_version=? WHERE id=?', profile.cloud_state_version, profile.id);
      return { imported: false, sameHash: true };
    }
    const r = this._ready();
    if (!r.ok) { this.log('warn', `Profile #${profile.number}: newer login on another PC, but ${r.why} — can't import it`); return { imported: false, reason: r.why }; }
    const blob = await r.drive.downloadBuffer(profile.cloud_state_file);
    const state = decryptJson(blob, r.pass);
    const how = await importStorageState(context, state, { log: m => this.log('warn', m) });
    const h = storageStateHash(state);
    this.db.run('UPDATE profiles SET state_version=?, state_hash=? WHERE id=?', profile.cloud_state_version, h, profile.id);
    this.imports++;
    this.log('info', `Profile #${profile.number}: login imported from ${profile.cloud_state_by || 'another PC'} (v${profile.cloud_state_version}, ${state.cookies.length} cookies, ${how})`);
    return { imported: true, version: profile.cloud_state_version, how };
  }

  /** Export + upload when the login changed. Call before the context closes. */
  async exportIfChanged(profile, context) {
    if (!profile.cloud_id) return { exported: false, reason: 'not synced yet' };
    const state = await exportStorageState(context);
    const h = storageStateHash(state);
    if (h === profile.state_hash) { this.skipped++; return { exported: false, unchanged: true }; }
    const r = this._ready();
    if (!r.ok) return { exported: false, reason: r.why };
    const file = await r.drive.putSmall({ parts: ['profiles'], name: `profile-${profile.cloud_id}.state`, data: encryptJson(state, r.pass) });
    const p = `${this.root()}/profiles/${profile.cloud_id}`;
    const version = await this.store.tx(async t => {
      const cur = await t.get(p);
      const v = ((cur && cur.stateVersion) || 0) + 1;
      t.set(p, { stateVersion: v, stateHash: h, stateFileId: file.id, stateBy: this.pcName, stateAt: this.store.SERVER_TS, updatedAt: this.store.SERVER_TS, updatedBy: this.pcId }, { merge: true });
      return v;
    });
    this.db.run('UPDATE profiles SET state_version=?, state_hash=?, cloud_state_version=?, cloud_state_hash=?, cloud_state_file=? WHERE id=?', version, h, version, h, file.id, profile.id);
    this.exports++;
    this.log('info', `Profile #${profile.number}: login saved to the cloud (v${version})`);
    return { exported: true, version, fileId: file.id };
  }
}

module.exports = { ProfileStateSync, exportStorageState, importStorageState };
