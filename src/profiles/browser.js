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

const exists = p => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };

/** Browser binaries inside a Playwright-style browsers folder (chromium-<rev>/chrome-<plat>/...), newest revision first. */
function chromiumInBrowsersDir(root, platform = process.platform) {
  const subs = platform === 'win32' ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
    : platform === 'darwin' ? ['chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
    : ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux-arm64/chrome'];
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort((x, y) => +y.split('-')[1] - +x.split('-')[1]); } catch (_) { return []; }
  const out = [];
  for (const d of dirs) {
    for (const sub of subs) out.push(path.join(root, d, sub));
    // any other chrome-win* layout Playwright may use in future
    if (platform === 'win32') {
      try { for (const x of fs.readdirSync(path.join(root, d))) if (/^chrome-win/.test(x)) out.push(path.join(root, d, x, 'chrome.exe')); } catch (_) { /* skip */ }
    }
  }
  return out;
}

/** Folders that may hold the Chromium shipped with the app (installer: resources/browsers; dev: <repo>/browsers). */
function bundledBrowserRoots(opts = {}) {
  const roots = [];
  const resourcesPath = opts.resourcesPath !== undefined ? opts.resourcesPath : process.resourcesPath;
  if (resourcesPath) roots.push(path.join(resourcesPath, 'browsers'));
  roots.push(path.join(__dirname, '..', '..', 'browsers'));
  return roots;
}

/**
 * Pick the browser binary. Order: user-set executablePath (if it exists) -> UPLOADPILOT_CHROME env ->
 * built-in Chromium shipped with the app -> installed Google Chrome -> Playwright's default download -> system Chromium.
 */
function detectExecutable(cfg = {}, opts = {}) {
  const platform = opts.platform || process.platform;
  if (exists(cfg.executablePath)) return cfg.executablePath;
  if (exists(process.env.UPLOADPILOT_CHROME)) return process.env.UPLOADPILOT_CHROME;
  const candidates = [];
  for (const root of bundledBrowserRoots(opts)) candidates.push(...chromiumInBrowsersDir(root, platform));
  if (platform === 'win32') {
    const pf = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    for (const base of pf) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
  }
  // Playwright-managed Chromium (npx playwright install chromium)
  const pwRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || (platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright') : platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') : path.join(os.homedir(), '.cache', 'ms-playwright'));
  candidates.push(...chromiumInBrowsersDir(pwRoot, platform));
  if (platform === 'linux') candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser');
  return candidates.find(exists) || null;
}

// Google "Device Bound Session Credentials" (DBSC). On Windows, Chromium ≥145 binds a Google sign-in to a
// key in the PC's TPM: the short-lived __Secure-1PSIDTS / __Secure-3PSIDTS cookies are only refreshed
// with a signature from that key. A storageState copied to another PC then signs out within minutes.
// UploadPilot moves logins between PCs, so these features are switched off for every profile.
// Names checked against the bundled Chromium (Playwright build 1255 = Chrome for Testing 159).
const DBSC_DISABLED_FEATURES = [
  'EnableBoundSessionCredentials', 'EnableBoundSessionCredentialsContinuity',
  'DeviceBoundSessions', 'DeviceBoundSessionsFederatedRegistration', 'DeviceBoundSessionsForRestrictedSites', 'DeviceBoundSessionsForSingleSignOn',
];

let _pwDefaults;
/** The --disable-features list Playwright itself passes (Chromium keeps only the LAST --disable-features switch). */
function playwrightDisabledFeatures() {
  if (_pwDefaults !== undefined) return _pwDefaults;
  _pwDefaults = null;
  try {
    const dir = path.dirname(require.resolve('playwright-core/package.json'));
    for (const f of ['lib/coreBundle.js', 'lib/server/chromium/chromiumSwitches.js']) {
      const file = path.join(dir, f);
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const m = /disabledFeatures\s*=\s*\[([\s\S]*?)\]\s*\.filter\(Boolean\)/.exec(src);
      if (m) { _pwDefaults = [...m[1].replace(/\/\/.*$/gm, '').matchAll(/^\s*"([A-Za-z0-9_]+)"\s*,?\s*$/gm)].map(x => x[1]); break; }
    }
  } catch (_) { _pwDefaults = null; }
  return _pwDefaults;
}

function disableFeaturesArg(extra = []) {
  const list = [...new Set([...(playwrightDisabledFeatures() || []), ...DBSC_DISABLED_FEATURES, ...extra])];
  return `--disable-features=${list.join(',')}`;
}

function buildArgs({ proxyUrl, windowMode, debugPort, extraArgs = [] }) {
  // a user-supplied --disable-features is merged into ours (Chromium honours only one)
  const userDisabled = extraArgs.filter(a => a.startsWith('--disable-features=')).flatMap(a => a.slice('--disable-features='.length).split(',').filter(Boolean));
  extraArgs = extraArgs.filter(a => !a.startsWith('--disable-features='));
  const args = [
    disableFeaturesArg(userDisabled),
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
  if (!executablePath && !cfg.channel) throw new Error('No browser engine found. The built-in Chromium is missing — reinstall UploadPilot, install Google Chrome, or set Settings → Browser engine path.');
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
      // Playwright's own --disable-features is replaced by ours, which contains its list + the DBSC features
      ignoreDefaultArgs: ['--enable-automation', ...(playwrightDisabledFeatures() ? ['--disable-features=' + playwrightDisabledFeatures().join(',')] : [])], viewport: null, acceptDownloads: false,
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

module.exports = { DBSC_DISABLED_FEATURES, playwrightDisabledFeatures, disableFeaturesArg, launchProfileBrowser, detectExecutable, chromiumInBrowsersDir, bundledBrowserRoots, buildArgs, freePort, waitForCdp };
