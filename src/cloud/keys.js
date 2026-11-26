'use strict';
// v0.3.1 account data key: envelope encryption, no separate sync passphrase.
//
//   users/{uid}/meta/keys = { wrapped, keyId, legacyEnc?, wrappedAt, wrappedBy }
//     wrapped   = the random 256-bit data key, AES-GCM-wrapped with scrypt(account password, salt)
//     keyId     = short hash of the data key (lets a PC notice the key was replaced)
//     legacyEnc = the old v0.3 sync passphrase, encrypted WITH the data key, so data written by
//                 0.3.0 (UPS1 blobs, proxy passwords) stays readable on every PC after migration.
//   users/{uid}/meta/keyRequest = { pub, pcId, pcName, state: 'open'|'answered', box?, rpub?, by? }
//     after a Firebase password reset the old wrap no longer opens with the new password. A PC that
//     still holds the data key (any signed-in PC) answers the request with an x25519-sealed copy,
//     and the requesting PC re-wraps it with the new password.
//
// The data key is kept on each PC only in the SecretStore (Electron safeStorage / DPAPI), so the app
// signs in again after a restart without asking for anything.
const crypto = require('crypto');
const C = require('./crypto');
const { withTimeout } = require('./store/common');

class KeyManager {
  /** @param {{store, root:()=>string, uid:()=>string, secrets, pcId, pcName, log?}} o */
  constructor(o) { Object.assign(this, o); this.key = null; this.keyIdV = null; this.legacyPass = null; this.state = 'none'; this.request = null; this.log = o.log || (() => {}); this.password = null; }

  get path() { return `${this.root()}/meta/keys`; }
  get reqPath() { return `${this.root()}/meta/keyRequest`; }

  /** The cached data key for this uid (safeStorage), if any. */
  loadCached() {
    const c = this.secrets.get('dataKey');
    if (c && c.uid === this.uid() && c.key) { this._setKey(Buffer.from(c.key, 'base64')); this.legacyPass = c.legacy || null; this.state = 'ok'; return true; }
    return false;
  }
  _setKey(key) { this.key = key; this.keyIdV = C.keyId(key); }
  _cache() { this.secrets.set('dataKey', { uid: this.uid(), key: this.key.toString('base64'), keyId: this.keyIdV, legacy: this.legacyPass || null }); }
  forget() { this.key = null; this.keyIdV = null; this.legacyPass = null; this.state = 'none'; this.password = null; this.secrets.delete('dataKey'); }

  /**
   * After sign-in with the typed password: unwrap the account key, or create it (first PC).
   * Returns {ok, created?} or {ok:false, reason:'password_mismatch'} after a password reset.
   */
  async unlock(password) {
    this.password = password || null;
    const doc = await withTimeout(this.store.get(this.path), 15000, 'read account key');
    if (doc && doc.wrapped) {
      if (this.key && this.keyIdV === doc.keyId) { this.state = 'ok'; await this._loadLegacy(doc); this._cache(); return { ok: true }; }
      if (!password) { this.state = 'locked'; return { ok: false, reason: 'password_needed' }; }
      try { this._setKey(C.unwrapKey(doc.wrapped, password)); }
      catch (_) { this.key = null; this.state = 'locked'; return { ok: false, reason: 'password_mismatch' }; }
      await this._loadLegacy(doc);
      this.state = 'ok'; this._cache();
      return { ok: true };
    }
    if (!password) { this.state = 'locked'; return { ok: false, reason: 'password_needed' }; }
    // first PC on this account (or an account from 0.3.0): make the key
    const key = this.key && this.state === 'ok' ? this.key : C.newDataKey();
    const created = await this.store.tx(async t => {
      const cur = await t.get(this.path);
      if (cur && cur.wrapped) return false;
      t.set(this.path, { wrapped: C.wrapKey(key, password), keyId: C.keyId(key), wrappedAt: this.store.SERVER_TS, wrappedBy: this.pcName }, { merge: true });
      return true;
    });
    if (!created) return this.unlock(password);   // another PC won the race: use theirs
    this._setKey(key); this.state = 'ok'; this._cache();
    this.log('info', 'Account key created — everything you save now follows your account');
    return { ok: true, created: true };
  }

  async _loadLegacy(doc) {
    if (doc && doc.legacyEnc) { try { this.legacyPass = this.decString(doc.legacyEnc); } catch (_) { /* unreadable */ } }
  }

  /** Is there 0.3.0 data that needs the old sync passphrase once? */
  async legacyNeeded() {
    if (this.legacyPass) return false;
    const meta = await this.store.get(`${this.root()}/meta/sync`).catch(() => null);
    return !!(meta && meta.verifier);
  }

  /** Migration: enter the old 0.3.0 passphrase once; it is kept encrypted with the data key for every PC. */
  async migrateLegacy(passphrase) {
    if (!this.key) throw Object.assign(new Error('Sign in first'), { status: 409 });
    const meta = await this.store.get(`${this.root()}/meta/sync`).catch(() => null);
    if (meta && meta.verifier && !C.checkVerifier(meta.verifier, passphrase)) throw Object.assign(new Error('That is not the old sync passphrase'), { status: 400 });
    this.legacyPass = String(passphrase);
    await this.store.set(this.path, { legacyEnc: this.encString(this.legacyPass) }, { merge: true });
    this._cache();
    return { migrated: true };
  }

  /** "Change password": Firebase password changes; the same data key is wrapped again (old data stays readable). */
  async rewrap(newPassword) {
    if (!this.key) throw Object.assign(new Error('The account key is not unlocked on this PC'), { status: 409 });
    await this.store.set(this.path, { wrapped: C.wrapKey(this.key, newPassword), keyId: this.keyIdV, wrappedAt: this.store.SERVER_TS, wrappedBy: this.pcName }, { merge: true });
    this.password = newPassword;
    return { rewrapped: true };
  }

  /** Locked after a password reset: ask the other signed-in PCs for the key. */
  async requestFromOtherPc() {
    const pair = C.makeKeyRequestPair();
    this.request = { priv: pair.priv, pub: pair.pub, at: Date.now() };
    await this.store.set(this.reqPath, { pub: pair.pub, pcId: this.pcId, pcName: this.pcName, state: 'open', at: this.store.SERVER_TS, box: null, rpub: null, by: null });
    this.state = 'requesting';
    return { requested: true };
  }

  /** meta/keyRequest changed (from the meta listener). Returns true when this PC just got the key. */
  async onRequestDoc(d) {
    if (!d) return false;
    // responder: a PC that holds the key answers someone else's open request
    if (d.state === 'open' && d.pcId !== this.pcId && this.key) {
      const sealed = C.sealKeyFor(d.pub, this.key);
      await this.store.set(this.reqPath, { state: 'answered', box: sealed.box, rpub: sealed.pub, by: this.pcName, keyId: this.keyIdV }, { merge: true }).catch(() => {});
      this.log('info', `Gave the account key to ${d.pcName} (its password was reset)`);
      return false;
    }
    // requester: our request was answered
    if (d.state === 'answered' && d.pcId === this.pcId && this.request && d.pub === this.request.pub && !this.key) {
      try {
        const key = C.openSealedKey(this.request.priv, d.rpub, d.box);
        this._setKey(key); this.request = null;
        if (this.password) await this.rewrap(this.password);
        const doc = await this.store.get(this.path).catch(() => null);
        await this._loadLegacy(doc);
        this.state = 'ok'; this._cache();
        await this.store.set(this.reqPath, { state: 'done', box: null }, { merge: true }).catch(() => {});
        this.log('success', `Account unlocked with the key from ${d.by || 'another PC'}`);
        return true;
      } catch (e) { this.log('error', `Could not open the key from ${d.by || 'another PC'}: ${e.message}`); }
    }
    return false;
  }

  /** No other PC can help after a password reset: new key; old encrypted data (logins, proxy passwords, keys) must be re-entered. */
  async startFresh(password) {
    if (!password) throw Object.assign(new Error('Password is required'), { status: 400 });
    const key = C.newDataKey();
    await this.store.set(this.path, { wrapped: C.wrapKey(key, password), keyId: C.keyId(key), wrappedAt: this.store.SERVER_TS, wrappedBy: this.pcName, legacyEnc: null, freshStartAt: this.store.SERVER_TS }, { merge: true });
    this._setKey(key); this.legacyPass = null; this.state = 'ok'; this.password = password; this._cache();
    this.log('warn', 'Started with a new account key — saved Google logins and secrets from before must be entered again');
    return { fresh: true };
  }

  /** meta/keys changed remotely (e.g. another PC started fresh): if the key id moved, this PC is locked. */
  onKeysDoc(d) {
    if (!d || !d.keyId || !this.key) return;
    if (d.keyId !== this.keyIdV) { this.key = null; this.keyIdV = null; this.state = 'locked'; this.secrets.delete('dataKey'); this.log('warn', 'The account key was replaced on another PC — sign in again on this PC'); }
    else if (d.legacyEnc && !this.legacyPass) { try { this.legacyPass = this.decString(d.legacyEnc); this._cache(); } catch (_) { /* ignore */ } }
  }

  // ---------------- cipher used by sync / profile logins / account settings
  get ready() { return !!this.key; }
  encBuffer(buf, opts) { if (!this.key) throw Object.assign(new Error('Account key is locked'), { code: 'KEY_LOCKED' }); return C.encryptWithKey(buf, this.key, opts); }
  decBuffer(blob, { compressed = true } = {}) {
    if (C.isKeyBlob(blob)) { if (!this.key) throw Object.assign(new Error('Account key is locked'), { code: 'KEY_LOCKED' }); return C.decryptWithKey(blob, this.key); }
    if (C.isLegacyBlob(blob)) {
      if (!this.legacyPass) throw Object.assign(new Error('Saved with the old sync passphrase — enter it once in Needs you'), { code: 'LEGACY_PASSPHRASE' });
      return C.decryptBuffer(blob, this.legacyPass, { compressed });
    }
    throw Object.assign(new Error('Not an UploadPilot encrypted blob'), { code: 'BAD_BLOB' });
  }
  encJson(obj) { return this.encBuffer(Buffer.from(JSON.stringify(obj), 'utf8')); }
  decJson(blob) { return JSON.parse(this.decBuffer(blob).toString('utf8')); }
  encString(s) { return this.encBuffer(Buffer.from(String(s), 'utf8'), { compress: false }).toString('base64'); }
  decString(b64) { return this.decBuffer(Buffer.from(String(b64), 'base64'), { compressed: false }).toString('utf8'); }
}

module.exports = { KeyManager, keyFingerprint: k => crypto.createHash('sha256').update(k).digest('hex').slice(0, 8) };
