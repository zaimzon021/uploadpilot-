'use strict';
// Real renderer (with its real CSP) in real Chromium against the real local API:
// the Open profile / Stop buttons in the Channels table must not also open the channel page.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { UploadPilotApp } = require('../../src/core/app');
const { detectExecutable } = require('../../src/profiles/browser');
const { tmpDir, makeVideos, headless } = require('../helpers/env');

const RENDERER = path.join(__dirname, '..', '..', 'renderer');
let app, web, webUrl, browser, chId;

test.before(async () => {
  app = new UploadPilotApp({ dataDir: tmpDir('rendch-'), apiPort: 0, settings: { autopilotPaused: true, geminiKeys: [], cloud: { mode: 'offline' }, browser: { headless, windowMode: 'normal' } } });
  await app.start();
  const prof = app.profiles.createProfile({ name: 'UI test', autoProxy: false });
  const folder = tmpDir('rendch-v-');
  makeVideos(folder, ['a.mp4']);
  chId = app.db.run(`INSERT INTO channels(profile_id,name,folder,status,style,created_at) VALUES(?,?,?,?,?,?)`, prof.id, 'Row Click Channel', folder, 'active', JSON.stringify({ mode: 'approval' }), Date.now()).lastInsertRowid;
  web = http.createServer((q, s) => {
    const f = path.join(RENDERER, path.normalize(decodeURIComponent(q.url.split('?')[0])).replace(/^([/\\])+/, '') || 'index.html');
    if (!f.startsWith(RENDERER) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); }
    s.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(s);
  });
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  webUrl = `http://127.0.0.1:${web.address().port}/index.html`;
  browser = await chromium.launch({ headless: true, executablePath: detectExecutable({}) || undefined });
});
test.after(async () => { await browser?.close().catch(() => {}); web?.close(); await app.stop(); });

test('Channels table: action buttons do not open the channel page (CSP-safe)', async () => {
  const page = await browser.newPage();
  const cspErrors = [];
  page.on('console', m => { if (/Content Security Policy|inline event handler/i.test(m.text())) cspErrors.push(m.text()); });
  const calls = [];
  // open-profile would launch a real browser window; record it instead
  await page.route(/\/channels\/\d+\/open-profile$/, r => { calls.push('open-profile'); r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ code: 0, data: { signIn: false } }) }); });
  await page.addInitScript(cfg => { window.uploadpilot = { config: async () => cfg, pickFolder: async () => null, openPath: async () => {} }; }, { apiUrl: app.api.url, token: app.api.uiToken });
  await page.goto(webUrl);
  await page.waitForFunction(() => document.querySelector('h1'));
  await page.waitForTimeout(800);   // let boot() finish its cloud check
  await page.evaluate(() => { document.getElementById('modal').classList.add('hidden'); window.__nav('channels'); });
  const row = page.locator(`tr[data-ch="${chId}"]`);
  await row.waitFor();

  await row.locator('button', { hasText: 'Open profile' }).click();
  await page.waitForTimeout(400);
  assert.deepStrictEqual(calls, ['open-profile']);
  assert.strictEqual(await page.locator('h1').innerText(), 'Channels', 'Open profile stays on Channels');

  await row.locator('[data-stop]').click();
  await page.waitForFunction(id => !document.querySelector(`tr[data-ch="${id}"] [data-stop]`), chId);
  assert.strictEqual(app.db.get('SELECT status FROM channels WHERE id=?', chId).status, 'stopped');
  assert.strictEqual(await page.locator('h1').innerText(), 'Channels', 'Stop stays on Channels');

  // clicking the gap inside the actions cell does nothing either
  await page.locator(`tr[data-ch="${chId}"] .row-actions`).click({ position: { x: 1, y: 1 } });
  await page.waitForTimeout(300);
  assert.strictEqual(await page.locator('h1').innerText(), 'Channels');

  // the rest of the row still opens the channel page
  await page.locator(`tr[data-ch="${chId}"] td`).first().click();
  await page.waitForFunction(() => document.querySelector('h1')?.innerText !== 'Channels');
  assert.notStrictEqual(await page.locator('h1').innerText(), 'Channels');
  assert.deepStrictEqual(cspErrors, [], 'no CSP violations');
  assert.ok(!fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8').match(/\son[a-z]+="/), 'no inline event handlers in renderer markup');
  await page.close();
});
