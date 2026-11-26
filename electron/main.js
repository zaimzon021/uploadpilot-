'use strict';
// Electron main process: hosts the UploadPilot core (autopilot + local API) and the UI window.
// Closing the window hides it to the tray; autopilot keeps running until Quit.
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, safeStorage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { UploadPilotApp } = require('../src/core/app');

const SMOKE = process.argv.includes('--smoke');
let core, win, tray, quitting = false;

if (!SMOKE && !app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, backgroundColor: '#0f0f10', title: 'UploadPilot',
    show: !SMOKE || true, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', e => { if (!quitting && !SMOKE && tray) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  try {
    tray = new Tray(img);
    tray.setToolTip('UploadPilot — autopilot running');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open UploadPilot', click: () => { win.show(); win.focus(); } },
      { type: 'separator' },
      { label: 'Quit (stops autopilot)', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('double-click', () => { win.show(); win.focus(); });
  } catch (_) { tray = null; }
}

ipcMain.handle('config', () => ({ apiUrl: core.api.url, token: core.api.uiToken, dataDir: core.dataDir, version: app.getVersion() }));
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));

app.whenReady().then(async () => {
  const dataDir = process.env.UPLOADPILOT_DATA || (SMOKE ? fs.mkdtempSync(path.join(require('os').tmpdir(), 'up-smoke-')) : app.getPath('userData'));
  core = new UploadPilotApp({
    dataDir, apiPort: SMOKE ? 0 : undefined,
    safeStorage,                                                     // secrets sealed with Windows DPAPI
    openExternal: url => shell.openExternal(url),                    // Google Drive sign-in in the user's own browser
    idleTimeProvider: () => powerMonitor.getSystemIdleTime(),        // "Pause when I'm using the PC"
    resourcesPath: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
  });
  try { await core.start(); }
  catch (e) {
    dialog.showErrorBox('UploadPilot could not start', `${e.message}\n\nIs another copy already running on port ${core.settings.get('apiPort')}?`);
    app.exit(1); return;
  }
  createWindow();
  if (!SMOKE) createTray();
  if (SMOKE) runSmoke();
});

async function runSmoke() {
  const out = path.join(process.cwd(), 'smoke');
  fs.mkdirSync(out, { recursive: true });
  const result = { ok: false, steps: [] };
  const step = (name, ok, detail) => { result.steps.push({ name, ok, detail }); console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
  try {
    if (process.argv.includes('--seed')) seedDemo(core);
    await new Promise(r => win.webContents.once('did-finish-load', r));
    if (process.argv.includes('--seed')) { win.webContents.reload(); await new Promise(r => win.webContents.once('did-finish-load', r)); }
    step('renderer loaded', true);
    await new Promise(r => setTimeout(r, 2500));
    // v0.3: the built-in cloud config means the sign-in screen shows first (never signed in here)
    const signIn = await win.webContents.executeJavaScript('!!document.getElementById("siEmail")');
    step('sign-in screen shown', signIn);
    fs.writeFileSync(path.join(out, 'sign-in.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('document.getElementById("siOff") && document.getElementById("siOff").click()');
    await new Promise(r => setTimeout(r, 1200));
    const st = await fetch(core.api.url + '/cloud/status', { headers: { 'X-UploadPilot-Token': core.api.uiToken } }).then(r => r.json());
    step('"Use offline" -> local mode', st.data.state === 'offline', st.data.state);
    const title = await win.webContents.executeJavaScript('document.querySelector("h1") && document.querySelector("h1").textContent');
    step('dashboard rendered', !!title, title);
    const stats = await win.webContents.executeJavaScript('[...document.querySelectorAll(".stat .num")].map(e=>e.textContent).join(",")');
    step('stats from local API', stats.split(',').length === 4, stats);
    for (const page of ['channels', 'settings', 'dashboard']) {
      await win.webContents.executeJavaScript(`window.__nav && window.__nav('${page}')`);
      await new Promise(r => setTimeout(r, 900));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, `${page}.png`), img.toPNG());
      step(`screenshot ${page}`, true);
    }
    await win.webContents.executeJavaScript(`window.__openLink && window.__openLink(true)`);
    await new Promise(r => setTimeout(r, 900));
    fs.writeFileSync(path.join(out, 'link-wizard.png'), (await win.webContents.capturePage()).toPNG());
    step('screenshot link wizard', true);
    const h = await fetch(core.api.url + '/health').then(r => r.json());
    step('API health from main', h.code === 0, JSON.stringify(h.data));
    result.ok = result.steps.every(s => s.ok);
  } catch (e) { step('exception', false, e.message); }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  quitting = true;
  await core.stop().catch(() => {});
  app.exit(result.ok ? 0 : 1);
}

/** Demo data for smoke screenshots only (--smoke --seed). Never used in normal runs. */
function seedDemo(c) {
  const now = Date.now();
  c.profiles.addProxies('203.0.113.10:1080:demo:demo\n203.0.113.11:1080:demo:demo\n203.0.113.12:1080:demo:demo');
  const demo = [['Tapvex Family', '@tapvex', 'active'], ['Monarch Clips', '@monarchclips', 'active'], ['Fail Xpress', '@failxpress', 'needs_you']];
  demo.forEach(([name, handle, status], i) => {
    const p = c.profiles.createProfile({ name });
    const ch = c.db.run('INSERT INTO channels(profile_id,name,handle,folder,status,status_reason,style,created_at) VALUES(?,?,?,?,?,?,?,?)', p.id, name, handle, '/tmp', status, status === 'needs_you' ? 'Login expired' : null, JSON.stringify({ niche: 'demo', mode: i === 1 ? 'approval' : 'auto' }), now).lastInsertRowid;
    const rows = [['done', -3, 'Driver Didn\u2019t See This Coming\u2026'], ['ready', 2, '5 Places That Look Alien'], ['awaiting_approval', 5, 'Bodycam: Traffic Stop Goes Wrong'], ['queued', 26, null]];
    rows.forEach(([st, h, title], j) => c.db.run('INSERT INTO videos(channel_id,path,filename,status,scheduled_at,title,url,uploaded_at,created_at,ai_status) VALUES(?,?,?,?,?,?,?,?,?,?)', ch, `/tmp/demo_${i}_${j}.mp4`, `clip_${i}${j}.mp4`, st, now + h * 3600e3, title, st === 'done' ? 'https://youtu.be/demo' : null, st === 'done' ? now - 3 * 3600e3 : null, now, title ? 'done' : 'pending'));
    c.events.success(`${name}: published "Driver Didn\u2019t See This Coming\u2026"`, { channelId: ch, kind: 'published' });
  });
  c.events.warn('Fail Xpress: Login expired \u2014 channel paused, needs you', { kind: 'needs_you' });
}

app.on('before-quit', async e => {
  if (core && core.started) { e.preventDefault(); quitting = true; await core.stop().catch(() => {}); app.exit(0); }
});
app.on('window-all-closed', () => { if (SMOKE) app.quit(); });
