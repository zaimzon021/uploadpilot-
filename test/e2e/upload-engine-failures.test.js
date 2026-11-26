'use strict';
// Upload engine timeouts / hard limit / detector against the mock Studio.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startMockStudio } = require('../mock-studio/server');
const { launchProfileBrowser } = require('../../src/profiles/browser');
const { UploadEngine } = require('../../src/upload/engine');
const { detectState } = require('../../src/upload/detect');
const { tmpDir, makeVideos, headless } = require('../helpers/env');

let studio, handle, mediaDir, runRoot;
const CFG = {
  stepTimeoutMs: 6000, uploadCompleteTimeoutMs: 60000, channelHardLimitMs: 120000, maxRetries: 3,
  typing: { minDelay: 1, maxDelay: 4, humanChars: 60 },
};
const job = () => ({
  file: path.join(mediaDir, 'clip_001.mp4'), thumb: path.join(mediaDir, 'clip_001.jpg'),
  title: 'Driver Didn’t See This Coming 😳 #shorts', description: 'Line one of the description.\nLine two with a link-free footer.\n\n#dashcam #fails',
  tags: ['dashcam', 'near miss', 'fails'], madeForKids: false, visibility: 'PUBLIC',
});

test.before(async () => {
  studio = await startMockStudio();
  mediaDir = tmpDir('media-'); runRoot = tmpDir('runs-');
  makeVideos(mediaDir, ['clip_001.mp4'], { thumbFor: ['clip_001.jpg'] });
  handle = await launchProfileBrowser({ userDataDir: tmpDir('prof-'), cfg: { extraArgs: [] }, windowMode: 'normal', headless });
  await handle.context.addCookies([{ name: 'SID', value: 'tester%40example.com', url: studio.url }]);
});
test.after(async () => { await handle.close(); await studio.close(); });

async function freshPage() {
  const np = await handle.context.newPage();   // open first: closing the last tab would quit the browser
  for (const p of handle.context.pages()) if (p !== np) await p.close().catch(() => {});
  return np;
}
function engine(name, cfg = {}) {
  const logs = [];
  const e = new UploadEngine({ cfg: { ...CFG, ...cfg }, studioUrl: studio.url, runDir: path.join(runRoot, name), log: m => logs.push(m), speed: 0.05 });
  return { e, logs };
}
const lastSub = () => studio.state.submissions.at(-1);

test('stuck upload progress -> step timeout, 3 attempts with recovery ladder, screenshots, bounded time', async () => {
  await studio.setMode('stuck');
  const n = studio.state.submissions.length;
  const { e, logs } = engine('stuck', { stepTimeoutMs: 4000 });
  const t0 = Date.now();
  await assert.rejects(e.uploadVideo(await freshPage(), job(), { deadline: Date.now() + 120000 }), err => err.code === 'STEP_TIMEOUT');
  const took = Date.now() - t0;
  assert.strictEqual(studio.state.submissions.length, n, 'never published a stuck upload');
  assert.ok(logs.some(l => /attempt 1\/3 failed/.test(l)) && logs.some(l => /attempt 3\/3 failed/.test(l)));
  assert.ok(logs.some(l => /recovery: dismiss/.test(l)) && logs.some(l => /recovery: reload/.test(l)));
  const shots = fs.readdirSync(path.join(runRoot, 'stuck')).filter(f => /fail-attempt/.test(f));
  assert.strictEqual(shots.length, 3);
  assert.ok(took < 90000, `took ${took}ms`);
  console.log(`   stuck run gave up after ${took}ms`);
});

test('stuck spinner (Studio never loads) -> hard limit stops the run on time', async () => {
  await studio.setMode('spinner');
  const { e } = engine('spinner', { stepTimeoutMs: 60000 });
  const t0 = Date.now();
  await assert.rejects(e.uploadVideo(await freshPage(), job(), { deadline: Date.now() + 8000 }), err => err.code === 'HARD_LIMIT');
  const took = Date.now() - t0;
  assert.ok(took >= 7500 && took < 20000, `took ${took}ms`);
});

test('detector: recognises each screen', async () => {
  const page = await freshPage();
  await studio.setMode('ok');
  await page.goto(studio.url + '/'); await page.waitForSelector('#create-icon');
  assert.strictEqual((await detectState(page)).state, 'dashboard');
  await page.click('#create-icon'); await page.click('#text-item-0');
  assert.strictEqual((await detectState(page)).state, 'upload_dialog');
  await page.goto(studio.url + '/ServiceLogin');
  assert.strictEqual((await detectState(page)).state, 'google_login');
  await page.goto(studio.url + '/challenge/recaptcha');
  assert.strictEqual((await detectState(page)).state, 'verification');
  await page.goto('about:blank');
  assert.strictEqual((await detectState(page)).state, 'blank');
  await page.goto(studio.url + '/some-other-page');
  await page.setContent('<html><body><h1>Choose how to create your channel</h1><button>Create channel</button></body></html>');
  assert.strictEqual((await detectState(page)).state, 'no_channel');
  await page.setContent('<html><body><p>Confirm it\'s you</p><p>Google sent a notification to your phone. Tap Yes on your phone</p></body></html>');
  assert.strictEqual((await detectState(page)).state, 'new_device');
});
