'use strict';
// SOCKS5 auth bridge against an independent SOCKS5 server with username/password (pproxy).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { SocksClient } = require('socks');
const { SocksBridge } = require('../../src/proxy/socksBridge');
const { checkProxy } = require('../../src/proxy/check');
const { launchProfileBrowser } = require('../../src/profiles/browser');
const { startSocksAuthServer, tmpDir, headless } = require('../helpers/env');

let upstream, target, targetUrl;
test.before(async () => {
  upstream = await startSocksAuthServer({ user: 'alice', pass: 's3cret' });
  target = http.createServer((req, res) => {
    if (req.url.startsWith('/ip')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ip: '198.51.100.23' })); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><title>through-proxy</title><body>hello via socks</body></html>');
  });
  await new Promise(r => target.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${target.address().port}`;
});
test.after(async () => { await upstream.close(); target.close(); });

function httpViaSocks(proxy, url) {
  return (async () => {
    const u = new URL(url);
    const { socket } = await SocksClient.createConnection({ proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username, password: proxy.password }, command: 'connect', destination: { host: u.hostname, port: +u.port }, timeout: 5000 });
    return new Promise((resolve, reject) => {
      let d = ''; socket.on('data', c => (d += c)); socket.on('end', () => resolve(d)); socket.on('error', reject);
      socket.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`);
    });
  })();
}

test('upstream really enforces auth (sanity)', async () => {
  await assert.rejects(httpViaSocks({ host: upstream.host, port: upstream.port }, targetUrl + '/'));
  const ok = await httpViaSocks(upstream, targetUrl + '/');
  assert.match(ok, /hello via socks/);
});

test('bridge: unauthenticated local SOCKS5 -> authenticated upstream', async () => {
  const b = await new SocksBridge(upstream).start();
  try {
    assert.ok(b.port > 0);
    const r = await httpViaSocks({ host: '127.0.0.1', port: b.port }, targetUrl + '/');
    assert.match(r, /200 OK/); assert.match(r, /hello via socks/);
    // many parallel tunnels
    const many = await Promise.all(Array.from({ length: 20 }, () => httpViaSocks({ host: '127.0.0.1', port: b.port }, targetUrl + '/ip')));
    assert.ok(many.every(x => x.includes('198.51.100.23')));
    assert.strictEqual(b.stats.connections, 21);
  } finally { await b.stop(); }
});

test('bridge with wrong upstream password refuses the tunnel', async () => {
  const errors = [];
  const b = await new SocksBridge({ ...upstream, password: 'wrong' }, { onError: e => errors.push(e.message) }).start();
  try {
    await assert.rejects(httpViaSocks({ host: '127.0.0.1', port: b.port }, targetUrl + '/'));
    assert.ok(errors.length >= 1);
    assert.strictEqual(b.stats.failures, 1);
  } finally { await b.stop(); }
});

test('health check: exit IP through the authenticated proxy; failures reported', async () => {
  const ok = await checkProxy(upstream, { url: targetUrl + '/ip', timeoutMs: 5000 });
  assert.deepStrictEqual([ok.ok, ok.ip], [true, '198.51.100.23']);
  const bad = await checkProxy({ ...upstream, password: 'nope' }, { url: targetUrl + '/ip', timeoutMs: 5000 });
  assert.strictEqual(bad.ok, false); assert.ok(bad.error);
  const dead = await checkProxy({ host: '127.0.0.1', port: 1, username: 'a', password: 'b' }, { url: targetUrl + '/ip', timeoutMs: 3000 });
  assert.strictEqual(dead.ok, false);
});

test('real Chromium (persistent profile) browses through the bridge', async () => {
  const b = await new SocksBridge(upstream).start();
  const h = await launchProfileBrowser({ userDataDir: tmpDir('prof-'), proxyUrl: b.url, cfg: { extraArgs: [] }, windowMode: 'normal', headless, proxyBypassLoopback: true });
  try {
    const page = h.context.pages()[0] || await h.context.newPage();
    await page.goto(targetUrl + '/', { timeout: 15000 });
    assert.strictEqual(await page.title(), 'through-proxy');
    assert.ok(b.stats.connections >= 1, 'traffic went through the bridge');
    assert.match(h.cdpEndpoint || '', /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
  } finally { await h.close(); await b.stop(); }
});

test('launch mode "cdp" (spawned Chrome + connectOverCDP) also browses through the bridge', async () => {
  const b = await new SocksBridge(upstream).start();
  const h = await launchProfileBrowser({ userDataDir: tmpDir('prof-cdp-'), proxyUrl: b.url, cfg: { launchMode: 'cdp', extraArgs: [] }, windowMode: 'normal', headless, proxyBypassLoopback: true });
  try {
    const page = h.context.pages()[0] || await h.context.newPage();
    await page.goto(targetUrl + '/', { timeout: 15000 });
    assert.strictEqual(await page.title(), 'through-proxy');
    assert.ok(b.stats.connections >= 1);
  } finally { await h.close(); await b.stop(); }
});
