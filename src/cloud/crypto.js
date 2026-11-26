'use strict';
// Sync encryption: AES-256-GCM with a key derived (scrypt) from the user's sync passphrase.
// Blob format (all binary):  "UPS1" | salt(16) | iv(12) | tag(16) | ciphertext( gzip(plaintext) )
// The salt is per blob, so the same passphrase never reuses a key+iv pair. Without the passphrase
// nothing stored in Google Drive / Firestore (profile logins, proxy passwords) can be read.
const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = Buffer.from('UPS1');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const keyCache = new Map(); // `${salt}:${passHash}` -> key (scrypt is slow on purpose; cache per process)

function deriveKey(passphrase, salt) {
  if (!passphrase || typeof passphrase !== 'string') throw Object.assign(new Error('Sync passphrase is not set'), { code: 'NO_PASSPHRASE' });
  const id = salt.toString('hex') + ':' + crypto.createHash('sha256').update(passphrase).digest('hex');
  let k = keyCache.get(id);
  if (!k) { k = crypto.scryptSync(passphrase.normalize('NFC'), salt, 32, SCRYPT); keyCache.set(id, k); if (keyCache.size > 64) keyCache.delete(keyCache.keys().next().value); }
  return k;
}

function encryptBuffer(plain, passphrase, { compress = true } = {}) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(MAGIC);
  const body = compress ? zlib.gzipSync(plain) : plain;
  const ct = Buffer.concat([c.update(body), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]);
}

function decryptBuffer(blob, passphrase, { compressed = true } = {}) {
  if (!Buffer.isBuffer(blob) || blob.length < 48 || !blob.subarray(0, 4).equals(MAGIC)) throw Object.assign(new Error('Not an UploadPilot encrypted blob'), { code: 'BAD_BLOB' });
  const salt = blob.subarray(4, 20), iv = blob.subarray(20, 32), tag = blob.subarray(32, 48), ct = blob.subarray(48);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  d.setAAD(MAGIC); d.setAuthTag(tag);
  let body;
  try { body = Buffer.concat([d.update(ct), d.final()]); }
  catch (_) { throw Object.assign(new Error('Wrong sync passphrase (or the data was changed)'), { code: 'BAD_PASSPHRASE' }); }
  return compressed ? zlib.gunzipSync(body) : body;
}

const encryptJson = (obj, pass) => encryptBuffer(Buffer.from(JSON.stringify(obj), 'utf8'), pass);
const decryptJson = (blob, pass) => JSON.parse(decryptBuffer(blob, pass).toString('utf8'));
/** short strings (proxy passwords) -> base64 text that fits in a Firestore field */
const encryptString = (s, pass) => encryptBuffer(Buffer.from(String(s), 'utf8'), pass, { compress: false }).toString('base64');
const decryptString = (b64, pass) => decryptBuffer(Buffer.from(b64, 'base64'), pass, { compressed: false }).toString('utf8');

/** Stable JSON (sorted keys) so equal states hash equally. */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

/**
 * Hash of a Playwright storageState that ignores churn which doesn't change the login
 * (cookie expiry drift, sorting). Changed logins -> different hash -> new snapshot uploaded.
 */
function storageStateHash(state) {
  const cookies = (state.cookies || []).map(c => ({ n: c.name, d: c.domain, p: c.path, v: c.value, s: !!c.secure, h: !!c.httpOnly, ss: c.sameSite }))
    .sort((a, b) => (a.d + a.p + a.n).localeCompare(b.d + b.p + b.n));
  const origins = (state.origins || []).map(o => ({ o: o.origin, ls: (o.localStorage || []).slice().sort((a, b) => a.name.localeCompare(b.name)), idb: o.indexedDB || null }))
    .sort((a, b) => a.o.localeCompare(b.o));
  return sha256(canonical({ cookies, origins }));
}

/** A value saved in the account meta doc that proves another PC uses the same passphrase. */
const VERIFIER_TEXT = 'uploadpilot-sync-ok';
const makeVerifier = pass => encryptString(VERIFIER_TEXT, pass);
function checkVerifier(verifier, pass) { try { return decryptString(verifier, pass) === VERIFIER_TEXT; } catch (_) { return false; } }

module.exports = { deriveKey, encryptBuffer, decryptBuffer, encryptJson, decryptJson, encryptString, decryptString, canonical, sha256, storageStateHash, makeVerifier, checkVerifier, MAGIC };
