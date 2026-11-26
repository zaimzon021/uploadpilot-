'use strict';
// Small encrypted key/value file for secrets: Google Drive refresh token, sync passphrase, Firebase
// sign-in session. In Electron the values are sealed with safeStorage (Windows DPAPI, per user);
// headless/tests fall back to AES-256-GCM with a random key file next to it (mode 0600) and report
// osProtected=false.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SecretStore {
  /**
   * @param {string} file
   * @param {{isEncryptionAvailable:()=>boolean, encryptString:(s:string)=>Buffer, decryptString:(b:Buffer)=>string}} [safeStorage]
   */
  constructor(file, safeStorage = null) {
    this.file = file;
    this.safe = safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable() ? safeStorage : null;
    this.osProtected = !!this.safe;
    this._data = null;
  }
  _fallbackKey() {
    const kf = this.file + '.key';
    if (!fs.existsSync(kf)) { fs.mkdirSync(path.dirname(kf), { recursive: true }); fs.writeFileSync(kf, crypto.randomBytes(32), { mode: 0o600 }); }
    return fs.readFileSync(kf);
  }
  _seal(text) {
    if (this.safe) return 's:' + this.safe.encryptString(text).toString('base64');
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', this._fallbackKey(), iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return 'f:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  _open(v) {
    if (v.startsWith('s:')) { if (!this.safe) throw new Error('Secret was sealed with OS encryption that is not available now'); return this.safe.decryptString(Buffer.from(v.slice(2), 'base64')); }
    const b = Buffer.from(v.slice(2), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this._fallbackKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }
  _load() {
    if (this._data) return this._data;
    try { this._data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { this._data = {}; }
    return this._data;
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  get(key) { const v = this._load()[key]; if (v == null) return null; try { return JSON.parse(this._open(v)); } catch (_) { return null; } }
  has(key) { return this._load()[key] != null; }
  set(key, value) { this._load(); if (value == null) delete this._data[key]; else this._data[key] = this._seal(JSON.stringify(value)); this._save(); }
  delete(key) { this.set(key, null); }
}

module.exports = { SecretStore };
