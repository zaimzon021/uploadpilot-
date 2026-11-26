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

// ---------------------------------------------------------------- v0.3.1
const { encryptWithKey, decryptWithKey, newDataKey } = require('../../src/cloud/crypto');
const { googleAuthCookies } = require('../../src/cloud/profileState');

const GOOGLE_COOKIES = [
  { name: 'SID', value: 'sid', url: 'https://google.com', domain: '.google.com', httpOnly: false, secure: false },
  { name: 'HSID', value: 'hsid', domain: '.google.com', httpOnly: true, secure: false },
  { name: 'SSID', value: 'ssid', domain: '.google.com', httpOnly: true, secure: true },
  { name: 'SAPISID', value: 'sapisid', domain: '.google.com', httpOnly: false, secure: true },
  { name: '__Secure-1PSID', value: 's1', domain: '.google.com', httpOnly: true, secure: true },
  { name: '__Secure-3PSID', value: 's3', domain: '.google.com', httpOnly: true, secure: true, sameSite: 'None' },
  { name: '__Secure-1PSIDTS', value: 'ts1', domain: '.google.com', httpOnly: true, secure: true },
  { name: 'LSID', value: 'lsid', host: 'accounts.google.com', httpOnly: true, secure: true },
  { name: '__Host-1PLSID', value: 'h1', host: 'accounts.google.com', httpOnly: true, secure: true },
  { name: '__Host-GAPS', value: 'gaps', host: 'accounts.google.com', httpOnly: true, secure: true },
  { name: 'LOGIN_INFO', value: 'li', domain: '.youtube.com', httpOnly: true, secure: true, sameSite: 'None' },
  { name: 'VISITOR_INFO1_LIVE', value: 'vi', domain: '.youtube.com', httpOnly: true, secure: true, sameSite: 'None' },
  { name: 'SID', value: 'yt-sid', domain: '.youtube.com', httpOnly: false, secure: false },
  { name: '__Secure-3PAPISID', value: 'ap', domain: '.youtube.com', httpOnly: false, secure: true, sameSite: 'None' },
  { name: 'STUDIO_PREF', value: 'sp', host: 'studio.youtube.com', httpOnly: false, secure: true },
].map(c => {
  const o = { name: c.name, value: c.value, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite || 'Lax', expires: Math.floor(Date.now() / 1000) + 30 * 86400 };
  if (c.host) o.url = `https://${c.host}/`; else { o.domain = c.domain; o.path = '/'; }
  return o;
});

test('v0.3.1 (f): Google login exported from profile A imports into a fresh profile B (other user-data-dir): every cookie present BEFORE the first navigation, localStorage restored', { timeout: 90000 }, async () => {
  const cfg = { launchMode: 'persistent', extraArgs: process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [] };
  const dirA = tmpDir('gA-'), dirB = tmpDir('gB-');
  const a = await launchProfileBrowser({ userDataDir: dirA, cfg, windowMode: 'normal', headless: true });
  await a.context.addCookies(GOOGLE_COOKIES);
  const pa = a.context.pages()[0] || await a.context.newPage();
  await pa.route('https://www.youtube.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>yt</title>' }));
  await pa.goto('https://www.youtube.com/');
  await pa.evaluate(() => { localStorage.setItem('yt-player-quality', '{"data":"720"}'); localStorage.setItem('ytidb::LAST_RESULT_ENTRY_KEY', 'x'); });
  const state = await exportStorageState(a.context);
  await a.close();
  for (const c of GOOGLE_COOKIES) assert.ok(state.cookies.some(x => x.name === c.name && x.value === c.value), `exported ${c.name}`);
  assert.ok(googleAuthCookies(state.cookies).length >= 8);
  // the cloud path: account data key, AES-GCM
  const key = newDataKey();
  const back = JSON.parse(decryptWithKey(encryptWithKey(Buffer.from(JSON.stringify(state)), key), key).toString());

  const b = await launchProfileBrowser({ userDataDir: dirB, cfg, windowMode: 'normal', headless: true });
  const r = await importStorageState(b.context, back);
  assert.strictEqual(r.failed, 0);
  // before ANY navigation: the cookie jar already has them, with their flags
  const jar = await b.context.cookies();
  for (const c of GOOGLE_COOKIES) {
    const got = jar.find(x => x.name === c.name && x.value === c.value);
    assert.ok(got, `cookie ${c.name} present before navigation`);
    assert.strictEqual(got.httpOnly, c.httpOnly, `${c.name} httpOnly`);
    assert.strictEqual(got.secure, c.secure, `${c.name} secure`);
    if (c.url) assert.ok(!got.domain.startsWith('.'), `${c.name} stays host-only (${got.domain})`);
    else assert.strictEqual(got.domain, c.domain);
  }
  const pb = b.context.pages()[0] || await b.context.newPage();
  await pb.route('https://www.youtube.com/**', rr => rr.fulfill({ status: 200, contentType: 'text/html', body: '<title>yt</title>' }));
  await pb.goto('https://www.youtube.com/');
  assert.strictEqual(await pb.evaluate(() => localStorage.getItem('yt-player-quality')), '{"data":"720"}');
  await b.close();
});

test('v0.3.1 (d): every profile launches with Device Bound Session Credentials off, and Playwright\'s own disabled features kept', { timeout: 60000 }, async () => {
  const cfg = { launchMode: 'persistent', extraArgs: process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [] };
  const h = await launchProfileBrowser({ userDataDir: tmpDir('dbsc-'), cfg, windowMode: 'normal', headless: true });
  const p = h.context.pages()[0] || await h.context.newPage();
  await p.goto('chrome://version');
  const cmd = await p.evaluate(() => (document.querySelector('#command_line') || document.body).innerText);
  await h.close();
  const sw = cmd.split(/\s+/).filter(x => x.startsWith('--disable-features='));
  assert.strictEqual(sw.length, 1, `exactly one --disable-features (${sw.length})`);
  for (const f of ['EnableBoundSessionCredentials', 'DeviceBoundSessions', 'PaintHolding']) assert.ok(sw[0].includes(f), `${f} in ${sw[0]}`);
});
