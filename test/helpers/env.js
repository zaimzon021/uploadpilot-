'use strict';
// Shared e2e helpers: local SOCKS5-with-auth server (pproxy), test media, temp dirs, waiting.
const { spawn, execFileSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function startSocksAuthServer({ user = 'alice', pass = 's3cret' } = {}) {
  const port = await freePort();
  const proc = spawn('python3', [path.join(__dirname, 'pproxy_run.py'), '-l', `socks5://127.0.0.1:${port}#${user}:${pass}`, '--auth', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', d => (out += d)); proc.stderr.on('data', d => (out += d));
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const ok = await new Promise(r => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    if (ok) break;
    await new Promise(r => setTimeout(r, 150));
  }
  return { host: '127.0.0.1', port, username: user, password: pass, line: `127.0.0.1:${port}:${user}:${pass}`, log: () => out, close: () => new Promise(r => { proc.on('exit', () => r()); proc.kill('SIGTERM'); setTimeout(r, 1500); }) };
}

const tmpDir = (p = 'up-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Tiny real mp4 files (ffmpeg) + a jpg thumbnail for the first one. */
function makeVideos(dir, names, { thumbFor = [] } = {}) {
  for (const n of names) {
    const out = path.join(dir, n);
    try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', out]); }
    catch (_) { fs.writeFileSync(out, Buffer.alloc(50000, 1)); }
  }
  for (const n of thumbFor) {
    const out = path.join(dir, n);
    try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720', '-frames:v', '1', out]); }
    catch (_) { fs.writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); }
  }
}

async function waitFor(fn, { timeout = 30000, interval = 250, what = 'condition' } = {}) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = await fn(); if (last) return last; await new Promise(r => setTimeout(r, interval)); }
  throw new Error(`Timed out waiting for ${what}`);
}

const headless = !process.env.DISPLAY;

module.exports = { startSocksAuthServer, tmpDir, makeVideos, waitFor, freePort, headless };
