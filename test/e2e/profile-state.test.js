'use strict';
// Real Chromium: a login made in one persistent profile (cookie + localStorage + IndexedDB) is exported
// with storageState({indexedDB:true}), encrypted, decrypted, and imported into a brand-new persistent
// profile before navigation — the same path PC-B takes. No raw profile-folder copy involved.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { launchProfileBrowser } = require('../../src/profiles/browser');
const { importStorageState, exportStorageState } = require('../../src/cloud/profileState');
const { encryptJson, decryptJson, storageStateHash } = require('../../src/cloud/crypto');
const { tmpDir } = require('../helpers/env');

const PAGE = `<!doctype html><title>site</title><script>
window.writeLogin = () => new Promise((res, rej) => {
  document.cookie = 'SID=session-123; path=/; max-age=86400';
  localStorage.setItem('token', 'ls-abc');
  const r = indexedDB.open('authdb', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put('idb-xyz', 'user'); tx.oncomplete = () => res(true); tx.onerror = rej; };
  r.onerror = rej;
});
window.readLogin = () => new Promise(res => {
  const out = { cookie: document.cookie, ls: localStorage.getItem('token'), idb: null };
  const r = indexedDB.open('authdb', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => { try { const g = r.result.transaction('kv').objectStore('kv').get('user'); g.onsuccess = () => { out.idb = g.result || null; res(out); }; g.onerror = () => res(out); } catch (e) { res(out); } };
  r.onerror = () => res(out);
});
</script>`;

test('storageState with IndexedDB: export -> AES-GCM -> import into a fresh persistent profile', { timeout: 90000 }, async () => {
  const server = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end(PAGE); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cfg = { launchMode: 'persistent', extraArgs: process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [] };
  const a = await launchProfileBrowser({ userDataDir: tmpDir('psA-'), cfg, windowMode: 'normal', headless: true });
  const pa = a.context.pages()[0] || await a.context.newPage();
  await pa.goto(origin);
  await pa.evaluate(() => window.writeLogin());
  const state = await exportStorageState(a.context);
  await a.close();
  assert.ok(state.cookies.some(c => c.name === 'SID' && c.value === 'session-123'));
  const o = state.origins.find(x => x.origin === origin);
  assert.ok(o && o.localStorage.some(x => x.name === 'token'));
  assert.ok(o.indexedDB && o.indexedDB.some(d => d.name === 'authdb'), 'IndexedDB captured');

  const blob = encryptJson(state, 'sync-passphrase-1');
  const back = decryptJson(blob, 'sync-passphrase-1');
  assert.strictEqual(storageStateHash(back), storageStateHash(state));

  const b = await launchProfileBrowser({ userDataDir: tmpDir('psB-'), cfg, windowMode: 'normal', headless: true });
  const how = await importStorageState(b.context, back);
  const pb = b.context.pages()[0] || await b.context.newPage();
  await pb.goto(origin);
  const got = await pb.evaluate(() => window.readLogin());
  await b.close();
  server.close();
  assert.match(got.cookie, /SID=session-123/);
  assert.strictEqual(got.ls, 'ls-abc');
  assert.strictEqual(got.idb, 'idb-xyz', `IndexedDB restored (${how})`);
});
