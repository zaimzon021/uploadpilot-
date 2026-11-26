'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseProxyLine, parseProxyList } = require('../../src/proxy/parse');
const { extractIp } = require('../../src/proxy/check');
const { buildArgs } = require('../../src/profiles/browser');

test('parse host:port:user:pass, socks5:// URLs, passwords with colons', () => {
  assert.deepStrictEqual(parseProxyLine('1.2.3.4:1080:bob:secret'), { host: '1.2.3.4', port: 1080, username: 'bob', password: 'secret' });
  assert.deepStrictEqual(parseProxyLine('proxy.example.com:9000:u:p:a:ss'), { host: 'proxy.example.com', port: 9000, username: 'u', password: 'p:a:ss' });
  assert.deepStrictEqual(parseProxyLine('socks5://u%40x:pw@h.io:1'), { host: 'h.io', port: 1, username: 'u@x', password: 'pw' });
  assert.deepStrictEqual(parseProxyLine('10.0.0.1:3128'), { host: '10.0.0.1', port: 3128, username: null, password: null });
  assert.strictEqual(parseProxyLine('  # comment'), null);
  assert.throws(() => parseProxyLine('host:99999:u:p'), /port/);
  assert.throws(() => parseProxyLine('ho st:1:u:p'), /host/);
  assert.throws(() => parseProxyLine('h:1:user'), /without password/);
});

test('parse list collects errors with line numbers', () => {
  const r = parseProxyList('1.1.1.1:1:a:b\n\nbad\n2.2.2.2:2:c:d\r\n');
  assert.strictEqual(r.proxies.length, 2);
  assert.deepStrictEqual(r.errors.map(e => e.line), [3]);
});

test('extractIp handles ipify JSON, httpbin, plain text', () => {
  assert.strictEqual(extractIp('{"ip":"5.6.7.8"}'), '5.6.7.8');
  assert.strictEqual(extractIp('{"origin":"9.9.9.9"}'), '9.9.9.9');
  assert.strictEqual(extractIp('your ip: 1.2.3.4\n'), '1.2.3.4');
});

test('browser args: proxy, debugging port, no automation banner flag, offscreen mode', () => {
  const a = buildArgs({ proxyUrl: 'socks5://127.0.0.1:5555', windowMode: 'offscreen', debugPort: 9333 });
  assert.ok(a.includes('--proxy-server=socks5://127.0.0.1:5555'));
  assert.ok(a.includes('--remote-debugging-port=9333'));
  assert.ok(a.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(a.some(x => x.startsWith('--window-position=-32000')));
  assert.ok(a.includes('--disable-backgrounding-occluded-windows'));
});
