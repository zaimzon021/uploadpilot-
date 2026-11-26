'use strict';
// Hits every local API endpoint (real HTTP on 127.0.0.1, real Chromium for profile open/close).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const { UploadPilotApp } = require('../../src/core/app');
const { startMockGemini } = require('../helpers/mockGemini');
const { startSocksAuthServer, tmpDir, makeVideos, headless, waitFor } = require('../helpers/env');

let app, api, px, gemini, ipServer, ipUrl;
const hit = async (method, p, body, headers = {}) => {
  const res = await fetch(api + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
};
const ok = async (method, p, body) => { const r = await hit(method, p, body); assert.strictEqual(r.json.code, 0, `${method} ${p}: ${r.json.message}`); return r.json.data; };
const covered = new Set();
const track = (m, p) => covered.add(`${m} ${p}`);

test.before(async () => {
  px = await startSocksAuthServer({ user: 'apiu', pass: 'apip' });
  gemini = await startMockGemini();
  ipServer = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{"ip":"192.0.2.10"}'); });
  await new Promise(r => ipServer.listen(0, '127.0.0.1', r));
  ipUrl = `http://127.0.0.1:${ipServer.address().port}/`;
  app = new UploadPilotApp({ dataDir: tmpDir('apidata-'), apiPort: 0, settings: { proxyCheckUrl: ipUrl, geminiBaseUrl: gemini.url, autopilotPaused: true, browser: { headless, windowMode: 'normal' } } });
  await app.start();
  api = app.api.url;
});
test.after(async () => { await app.stop(); await px.close(); await gemini.close(); ipServer.close(); });

test('health, dashboard, events, settings', async () => {
  const h = await ok('GET', '/health'); track('GET', '/health');
  assert.strictEqual(h.ok, true);
  const d = await ok('GET', '/dashboard'); track('GET', '/dashboard');
  assert.strictEqual(d.channels, 0);
  assert.ok(Array.isArray(await ok('GET', '/events?limit=5'))); track('GET', '/events');
  const s = await ok('PUT', '/settings', { geminiKeys: 'AIzaKEYONE1234\nAIzaKEYTWO5678', videosPerDay: 3, lanes: 4, uploadWindow: { start: '10:00', end: '22:00' }, delayRangeMin: { min: 2, max: 5 } }); track('PUT', '/settings');
  assert.strictEqual(s.settings.geminiKeyCount, 2);
  assert.ok(!JSON.stringify(s).includes('AIzaKEYONE1234'), 'keys masked in responses');
  const g = await ok('GET', '/settings'); track('GET', '/settings');
  assert.deepStrictEqual([g.videosPerDay, g.lanes, g.uploadWindow.start, g.delayRangeMin.max], [3, 4, '10:00', 5]);
  const bad = await hit('PUT', '/settings', { uploadWindow: { start: '22:00', end: '10:00' } });
  assert.strictEqual(bad.status, 400);
  await ok('PUT', '/settings', { geminiBaseUrl: gemini.url });
  const m = await ok('POST', '/settings/gemini/test'); track('POST', '/settings/gemini/test');
  assert.deepStrictEqual(m.models, ['gemini-mock-flash']);
});

test('proxies: add, list, check, check-all, delete', async () => {
  const r = await ok('POST', '/proxies', { text: `${px.line}\n10.255.255.1:1080:x:y\nnot-a-proxy` }); track('POST', '/proxies');
  assert.deepStrictEqual([r.added, r.errors.length], [2, 1]);
  const list = await ok('GET', '/proxies'); track('GET', '/proxies');
  assert.strictEqual(list.length, 2);
  assert.ok(!('password' in list[0]), 'passwords never returned');
  const good = list.find(p => p.port === px.port);
  const c = await ok('POST', `/proxies/${good.id}/check`); track('POST', '/proxies/:id/check');
  assert.deepStrictEqual([c.ok, c.ip], [true, '192.0.2.10']);
  await ok('PUT', '/settings', { proxyCheckTimeoutMs: 2000 });
  const all = await ok('POST', '/proxies/check-all'); track('POST', '/proxies/check-all');
  assert.deepStrictEqual(all.map(x => x.ok).sort(), [false, true]);
  const dead = list.find(p => p.port !== px.port);
  assert.strictEqual((await ok('DELETE', `/proxies/${dead.id}`)).deleted, true); track('DELETE', '/proxies/:id');
});

let profId;
test('profiles: create (auto proxy), get, set proxy, check proxy, open (CDP ws), close, delete', async () => {
  const p = await ok('POST', '/profiles', { name: 'API test' }); track('POST', '/profiles');
  profId = p.id;
  assert.ok(p.proxy_id && p.number === 1 && fs.existsSync(p.data_dir));
  assert.strictEqual((await ok('GET', '/profiles')).length, 1); track('GET', '/profiles');
  assert.strictEqual((await ok('GET', `/profiles/${p.id}`)).proxy_port, px.port); track('GET', '/profiles/:id');
  const c = await ok('POST', `/profiles/${p.id}/proxy/check`); track('POST', '/profiles/:id/proxy/check');
  assert.strictEqual(c.ok, true);
  const o = await ok('POST', `/profiles/${p.id}/open`, {}); track('POST', '/profiles/:id/open');
  assert.match(o.ws, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
  assert.strictEqual(o.exitIp, '192.0.2.10');
  assert.match(o.proxyBridge, /^socks5:\/\/127\.0\.0\.1:\d+$/);
  // CDP endpoint really works for external tools
  const { chromium } = require('playwright-core');
  const b = await chromium.connectOverCDP(o.ws);
  assert.ok(b.contexts().length >= 1);
  await b.close().catch(() => {});
  assert.strictEqual((await ok('GET', `/profiles/${p.id}`)).open, true);
  assert.strictEqual((await ok('POST', `/profiles/${p.id}/close`)).closed, true); track('POST', '/profiles/:id/close');
  const p2 = await ok('POST', `/profiles/${p.id}/proxy`, { proxy: '127.0.0.1:9:z:z' }); track('POST', '/profiles/:id/proxy');
  assert.notStrictEqual(p2.proxy_id, p.proxy_id);
  const refused = await hit('POST', `/profiles/${p.id}/open`, {});
  assert.strictEqual(refused.status, 502, 'dead proxy blocks open (no IP leak)');
  await ok('POST', `/profiles/${p.id}/proxy`, { proxyId: p.proxy_id });
});

test('channels + videos endpoints', async () => {
  await ok('PUT', '/settings', { geminiKeys: [] }); // keep the AI worker out of this test's way
  const folder = tmpDir('apich-');
  makeVideos(folder, ['v1.mp4', 'v2.mp4', 'v3.mp4']);
  const id = app.db.run(`INSERT INTO channels(profile_id,name,folder,status,style,created_at) VALUES(?,?,?,?,?,?)`, profId, 'API Channel', folder, 'active', JSON.stringify({ mode: 'approval' }), Date.now()).lastInsertRowid;
  const sc = await ok('POST', `/channels/${id}/scan`); track('POST', '/channels/:id/scan');
  assert.strictEqual(sc.added, 3);
  assert.strictEqual((await ok('GET', '/channels')).length, 1); track('GET', '/channels');
  assert.strictEqual((await ok('GET', `/channels/${id}`)).queue, 3); track('GET', '/channels/:id');
  const st = await ok('GET', `/channels/${id}/status`); track('GET', '/channels/:id/status');
  assert.strictEqual(st.status, 'active'); assert.ok(st.next_upload);
  assert.strictEqual((await ok('POST', `/channels/${id}/stop`)).status, 'stopped'); track('POST', '/channels/:id/stop');
  assert.strictEqual((await ok('POST', `/channels/${id}/resume`)).status, 'active'); track('POST', '/channels/:id/resume');
  const pc = await ok('PATCH', `/channels/${id}`, { style: { footer: 'FOOT', perDay: 1 } }); track('PATCH', '/channels/:id');
  assert.strictEqual(pc.style.footer, 'FOOT'); assert.strictEqual(pc.style.mode, 'approval');
  const vids = await ok('GET', `/channels/${id}/videos`); track('GET', '/channels/:id/videos');
  assert.strictEqual(vids.length, 3);
  const e = await ok('PATCH', `/videos/${vids[0].id}`, { title: 'Hand written', tags: 'a, b' }); track('PATCH', '/videos/:id');
  assert.deepStrictEqual([e.title, e.tags, e.status], ['Hand written', ['a', 'b'], 'awaiting_approval']);
  assert.strictEqual((await hit('PATCH', `/videos/${vids[0].id}`, { title: 'x'.repeat(101) })).status, 400);
  assert.strictEqual((await ok('POST', `/videos/${vids[0].id}/approve`)).status, 'ready'); track('POST', '/videos/:id/approve');
  assert.strictEqual((await ok('POST', `/videos/${vids[1].id}/skip`)).status, 'skipped'); track('POST', '/videos/:id/skip');
  assert.strictEqual((await ok('POST', `/videos/${vids[1].id}/retry`)).status, 'queued'); track('POST', '/videos/:id/retry');
  assert.ok(Array.isArray(await ok('GET', `/channels/${id}/runs`))); track('GET', '/channels/:id/runs');
  const op = await ok('POST', `/channels/${id}/open-profile`); track('POST', '/channels/:id/open-profile');
  assert.match(op.ws, /^ws:/);
  await ok('POST', `/profiles/${profId}/close`);
  const sch = await ok('GET', '/scheduler'); track('GET', '/scheduler');
  assert.ok('lanes' in sch);
  assert.strictEqual((await ok('POST', '/autopilot/resume')).paused, false); track('POST', '/autopilot/resume');
  assert.strictEqual((await ok('POST', '/autopilot/pause')).paused, true); track('POST', '/autopilot/pause');
  assert.strictEqual((await hit('DELETE', `/profiles/${profId}`)).status, 409, 'linked profile protected');
  assert.strictEqual((await ok('DELETE', `/channels/${id}`)).deleted, true); track('DELETE', '/channels/:id');
  assert.strictEqual((await ok('DELETE', `/profiles/${profId}`)).deleted, true); track('DELETE', '/profiles/:id');
});

test('link wizard endpoints: start, get, style/folder guards, cancel', async () => {
  await ok('PUT', '/settings', { urls: { accounts: 'about:blank#', studio: 'about:blank', youtube: 'about:blank' } });
  const s = await ok('POST', '/link/start', { name: 'Wiz' }); track('POST', '/link/start');
  assert.ok(['waiting_login', 'error'].includes(s.status));
  const g = await ok('GET', `/link/${s.id}`); track('GET', '/link/:id');
  assert.strictEqual(g.step, 1);
  assert.strictEqual((await hit('POST', `/link/${s.id}/style`, { niche: 'x' })).status, 409); track('POST', '/link/:id/style');
  assert.strictEqual((await hit('POST', `/link/${s.id}/folder`, { folder: '/tmp' })).status, 409); track('POST', '/link/:id/folder');
  assert.strictEqual((await ok('DELETE', `/link/${s.id}`)).cancelled, true); track('DELETE', '/link/:id');
  assert.strictEqual((await ok('GET', '/profiles')).length, 0, 'cancel removes the half-made profile');
});

test('SSE event stream delivers live events', async () => {
  const res = await fetch(api + '/events/stream'); track('GET', '/events/stream');
  const reader = res.body.getReader();
  await reader.read(); // ": connected"
  app.events.info('hello-sse');
  const { value } = await reader.read();
  assert.match(Buffer.from(value).toString(), /hello-sse/);
  await reader.cancel();
});

test('security: loopback only, Host header check, browser Origin needs token, 404s', async () => {
  assert.strictEqual(app.api.server.address().address, '127.0.0.1');
  const r1 = await new Promise(r => http.get({ host: '127.0.0.1', port: app.api.port, path: '/api/v1/health', headers: { Host: 'evil.example.com' } }, res => r(res.statusCode)));
  assert.strictEqual(r1, 403, 'DNS-rebinding style Host rejected');
  assert.strictEqual((await hit('GET', '/health', null, { Origin: 'https://evil.example.com' })).status, 403);
  assert.strictEqual((await hit('GET', '/health', null, { Origin: 'null', 'X-UploadPilot-Token': app.api.uiToken })).status, 200);
  assert.strictEqual((await hit('GET', '/nope')).status, 404);
  assert.strictEqual((await hit('GET', '/channels/999')).status, 404);
  await ok('PUT', '/settings', { apiToken: 'sekret' });
  assert.strictEqual((await hit('GET', '/health')).status, 401);
  assert.strictEqual((await hit('GET', '/health', null, { 'X-UploadPilot-Token': 'sekret' })).status, 200);
  await hit('PUT', '/settings', { apiToken: '' }, { 'X-UploadPilot-Token': 'sekret' });
  console.log(`   endpoints covered: ${covered.size}`);
  void waitFor;
});
