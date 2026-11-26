'use strict';
// Sync encryption: storageState encrypt/decrypt round trip, wrong passphrase, tampering, hashing, secret store.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { encryptJson, decryptJson, encryptString, decryptString, storageStateHash, makeVerifier, checkVerifier, MAGIC } = require('../../src/cloud/crypto');
const { SecretStore } = require('../../src/cloud/secretStore');
const { tmpDir } = require('../helpers/env');

const STATE = {
  cookies: [
    { name: 'SID', value: 'abc'.repeat(30), domain: '.google.com', path: '/', expires: 1999999999, httpOnly: true, secure: true, sameSite: 'None' },
    { name: '__Secure-3PSID', value: 'xyz', domain: '.youtube.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
  ],
  origins: [{ origin: 'https://studio.youtube.com', localStorage: [{ name: 'yt-player', value: '{"a":1}' }], indexedDB: [{ name: 'db1', version: 1, stores: [] }] }],
};

test('storageState encrypt -> decrypt round trip (AES-256-GCM, scrypt key)', () => {
  const blob = encryptJson(STATE, 'correct horse battery');
  assert.ok(blob.subarray(0, 4).equals(MAGIC));
  assert.ok(!blob.toString('latin1').includes('SID'), 'ciphertext must not contain cookie names');
  assert.deepStrictEqual(decryptJson(blob, 'correct horse battery'), STATE);
  // fresh salt + iv every time
  assert.notDeepStrictEqual(encryptJson(STATE, 'correct horse battery'), blob);
});

test('wrong passphrase and tampered data are rejected', () => {
  const blob = encryptJson(STATE, 'pass-one-1');
  assert.throws(() => decryptJson(blob, 'pass-two-2'), e => e.code === 'BAD_PASSPHRASE');
  const t = Buffer.from(blob); t[t.length - 5] ^= 0xff;
  assert.throws(() => decryptJson(t, 'pass-one-1'), e => e.code === 'BAD_PASSPHRASE');
  assert.throws(() => decryptJson(Buffer.from('nope'), 'x'), e => e.code === 'BAD_BLOB');
  assert.throws(() => encryptJson(STATE, ''), e => e.code === 'NO_PASSPHRASE');
});

test('short strings (proxy passwords) and passphrase verifier', () => {
  const s = encryptString('pr0xy:pass', 'k-12345678');
  assert.strictEqual(decryptString(s, 'k-12345678'), 'pr0xy:pass');
  const v = makeVerifier('k-12345678');
  assert.strictEqual(checkVerifier(v, 'k-12345678'), true);
  assert.strictEqual(checkVerifier(v, 'other-pass'), false);
});

test('storageState hash ignores order/expiry churn but sees login changes', () => {
  const h = storageStateHash(STATE);
  const reordered = { cookies: [{ ...STATE.cookies[1] }, { ...STATE.cookies[0], expires: 2111111111 }], origins: STATE.origins };
  assert.strictEqual(storageStateHash(reordered), h);
  const changed = { ...STATE, cookies: [{ ...STATE.cookies[0], value: 'new' }, STATE.cookies[1]] };
  assert.notStrictEqual(storageStateHash(changed), h);
});

test('secret store: fallback encryption at rest, safeStorage when available', () => {
  const d = tmpDir('sec-');
  const s = new SecretStore(path.join(d, 'secrets.json'));
  s.set('googleDrive', { refresh_token: 'rt-secret-123' });
  assert.ok(!fs.readFileSync(path.join(d, 'secrets.json'), 'utf8').includes('rt-secret-123'));
  assert.deepStrictEqual(new SecretStore(path.join(d, 'secrets.json')).get('googleDrive'), { refresh_token: 'rt-secret-123' });
  assert.strictEqual(s.osProtected, false);
  const fake = { isEncryptionAvailable: () => true, encryptString: t => Buffer.from(t.split('').reverse().join('')), decryptString: b => b.toString().split('').reverse().join('') };
  const s2 = new SecretStore(path.join(d, 's2.json'), fake);
  s2.set('k', 'v'); assert.strictEqual(s2.osProtected, true);
  assert.match(fs.readFileSync(path.join(d, 's2.json'), 'utf8'), /"s:/);
  assert.strictEqual(new SecretStore(path.join(d, 's2.json'), fake).get('k'), 'v');
  s2.delete('k'); assert.strictEqual(s2.get('k'), null);
});
