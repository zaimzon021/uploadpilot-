'use strict';
// Locating and launching Chromium for a profile (real, persistent user-data-dir; no fingerprint spoofing).
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

function detectExecutable(cfg = {}) {
  if (cfg.executablePath && fs.existsSync(cfg.executablePath)) return cfg.executablePath;
  if (process.env.UPLOADPILOT_CHROME && fs.existsSync(process.env.UPLOADPILOT_CHROME)) return process.env.UPLOADPILOT_CHROME;
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    for (const base of pf) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    // bundled chromium next to the app (resources/chromium/chrome.exe) if shipped
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'chromium', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  }
  // Playwright-managed Chromium (npx playwright install chromium)
  const pwRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright') : path.join(os.homedir(), '.cache', 'ms-playwright'));
  try {
    for (const d of fs.readdirSync(pwRoot).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-linux-arm64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) candidates.push(path.join(pwRoot, d, sub));
    }
  } catch (_) { /* none */ }
  if (process.platform === 'linux') candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  return candidates.find(c => { try { return fs.existsSync(c); } catch (_) { return false; } }) || null;
}

function buildArgs({ proxyUrl, windowMode, debugPort, extraArgs = [] }) {
  const args = [
    '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    // keep background/minimized windows fully alive so uploads don't stall
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
  // Chromium sends hostnames to socks5:// proxies, so DNS is resolved at the upstream exit.
  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);
  if (debugPort) args.push(`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1');
  if (windowMode === 'offscreen') args.push('--window-position=-32000,-32000');
  return args.concat(extraArgs);
}

function getJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
async function waitForCdp(port, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await getJson(`http://127.0.0.1:${port}/json/version`); } catch (_) { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error(`Browser DevTools endpoint on port ${port} did not come up`);
}

/** Minimize the browser window through CDP so it never sits on top of the user's work. */
async function minimizeWindows(context, browser) {
  try {
    const page = context.pages()[0] || await context.newPage();
    const session = await context.newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await session.detach().catch(() => {});
    return true;
  } catch (_) { return false; }
}

/**
 * Launch a browser for a profile. Returns { context, browser, cdpEndpoint, close() }.
 * launchMode 'persistent': playwright launchPersistentContext (headed) + remote debugging port for the API.
 * launchMode 'cdp': spawn the browser as a normal process and attach with connectOverCDP.
 */
async function launchProfileBrowser({ userDataDir, proxyUrl, cfg, windowMode, headless, proxyBypassLoopback = false }) {
  const { chromium } = require('playwright-core');
  const executablePath = cfg.channel ? undefined : detectExecutable(cfg);
  if (!executablePath && !cfg.channel) throw new Error('No Chrome/Chromium found. Install Google Chrome or set Settings → browser.executablePath.');
  const debugPort = await freePort();
  const extra = [...(cfg.extraArgs || [])];
  if (proxyBypassLoopback) extra.push('--proxy-bypass-list=<-loopback>');
  const args = buildArgs({ proxyUrl, windowMode, debugPort, extraArgs: extra });
  fs.mkdirSync(userDataDir, { recursive: true });
  let context, browser = null, child = null;
  if ((cfg.launchMode || 'persistent') === 'cdp') {
    const spawnArgs = [...args, `--user-data-dir=${userDataDir}`];
    if (headless) spawnArgs.push('--headless=new');
    if (process.platform === 'linux' && process.getuid && process.getuid() === 0) spawnArgs.push('--no-sandbox');
    child = spawn(executablePath, [...spawnArgs, 'about:blank'], { stdio: 'ignore', detached: false });
    const ver = await waitForCdp(debugPort);
    browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
    context = browser.contexts()[0];
  } else {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath, channel: cfg.channel || undefined, headless: !!headless, args,
      ignoreDefaultArgs: ['--enable-automation'], viewport: null, acceptDownloads: false,
    });
  }
  let cdpEndpoint = null;
  try { cdpEndpoint = (await waitForCdp(debugPort, 10000)).webSocketDebuggerUrl; } catch (_) { /* not critical */ }
  if (!headless && windowMode === 'minimized') await minimizeWindows(context, browser);
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { await Promise.race([context.close(), new Promise(r => setTimeout(r, 15000))]); } catch (_) { /* ignore */ }
    if (browser) { try { await browser.close(); } catch (_) {} }
    if (child && !child.killed) { try { child.kill(); } catch (_) {} }
  };
  context.on('close', () => { closed = true; if (child && !child.killed) { try { child.kill(); } catch (_) {} } });
  return { context, browser, cdpEndpoint, debugPort, executablePath, close, isClosed: () => closed };
}

module.exports = { launchProfileBrowser, detectExecutable, buildArgs, freePort, waitForCdp };
