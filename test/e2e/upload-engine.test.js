'use strict';
// Real upload engine (state machine + human input) against the mock YouTube Studio, incl. failure modes.
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

test('happy path: full Studio flow, all fields, URL confirmed', async () => {
  await studio.setMode('ok');
  const page = await freshPage();
  const { e, logs } = engine('ok');
  const t0 = Date.now();
  const r = await e.uploadVideo(page, job(), { deadline: Date.now() + 120000 });
  const s = lastSub();
  assert.match(r.url, /^https:\/\/youtu\.be\/mock\w+$/);
  assert.strictEqual(r.url, `https://youtu.be/${s.videoId}`);
  assert.strictEqual(s.title, job().title);
  assert.strictEqual(s.description, job().description);
  assert.deepStrictEqual(s.tags, job().tags);
  assert.strictEqual(s.kids, 'VIDEO_MADE_FOR_KIDS_NOT_MFK');
  assert.strictEqual(s.visibility, 'PUBLIC');
  assert.strictEqual(s.thumb, 'clip_001.jpg');
  assert.strictEqual(s.fileName, 'clip_001.mp4');
  assert.strictEqual(s.uploadedBeforePublish, true, 'waited for transfer before publishing');
  for (const st of ['dashboard', 'upload_dialog', 'details', 'elements', 'checks', 'visibility', 'done']) assert.ok(logs.some(l => l === `state: ${st}`), `visited ${st}`);
  assert.ok(fs.readdirSync(path.join(runRoot, 'ok')).some(f => /done\.png$/.test(f)), 'done screenshot');
  console.log(`   happy path took ${Date.now() - t0}ms`);
});

test('made-for-kids + unlisted honoured', async () => {
  await studio.setMode('ok');
  const { e } = engine('kids');
  await e.uploadVideo(await freshPage(), { ...job(), madeForKids: true, visibility: 'UNLISTED', thumb: null }, { deadline: Date.now() + 120000 });
  assert.strictEqual(lastSub().kids, 'VIDEO_MADE_FOR_KIDS_MFK');
  assert.strictEqual(lastSub().visibility, 'UNLISTED');
});

test('recovery: error dialog on Next is dismissed and the flow continues', async () => {
  await studio.setMode('error_once', { errorAtStep: 1 });
  const n = studio.state.submissions.length;
  const { e, logs } = engine('error_once');
  const r = await e.uploadVideo(await freshPage(), job(), { deadline: Date.now() + 120000 });
  assert.ok(r.url);
  assert.strictEqual(studio.state.submissions.length, n + 1);
  assert.strictEqual(studio.state.errorShown, 1);
  assert.ok(logs.some(l => l.startsWith('state: error_dialog')) && logs.some(l => /dismissed error dialog/.test(l)));
  assert.ok(fs.readdirSync(path.join(runRoot, 'error_once')).some(f => /error-dialog/.test(f)), 'screenshot of error');
});

test('recovery: random error dialogs (p=0.5) on every Next', async () => {
  await studio.setMode('error_random', { p: 0.5 });
  const { e, logs } = engine('error_random');
  const r = await e.uploadVideo(await freshPage(), job(), { deadline: Date.now() + 120000 });
  assert.ok(r.url);
  assert.ok(studio.state.errorShown >= 1, `errors shown: ${studio.state.errorShown}`);
  assert.strictEqual(lastSub().title, job().title);
  void logs;
});

test('recovery: upload dialog vanishes mid-flow -> engine notices and re-opens/re-uploads', async () => {
  await studio.setMode('dialog_vanish');
  const { e, logs } = engine('vanish');
  const r = await e.uploadVideo(await freshPage(), job(), { deadline: Date.now() + 120000 });
  assert.ok(r.url);
  assert.strictEqual(studio.state.vanished, 1);
  assert.strictEqual(lastSub().title, job().title);
  assert.ok(logs.filter(l => l.startsWith('file selected')).length >= 2, 'file selected again after the dialog vanished');
});

test('verification page -> NeedsUser (verification), fast, no retries', async () => {
  await studio.setMode('verify');
  const { e } = engine('verify');
  const t0 = Date.now();
  await assert.rejects(e.uploadVideo(await freshPage(), job(), { deadline: Date.now() + 120000 }), err => err.code === 'NEEDS_USER' && err.state === 'verification');
  assert.ok(Date.now() - t0 < 20000);
  assert.ok(fs.readdirSync(path.join(runRoot, 'verify')).some(f => /needs_user/.test(f)));
});

test('session expired -> NeedsUser (google_login)', async () => {
  await studio.setMode('login');
  const { e } = engine('login');
  await assert.rejects(e.uploadVideo(await freshPage(), job(), { deadline: Date.now() + 60000 }), err => err.code === 'NEEDS_USER' && err.state === 'google_login');
});

test('daily upload limit dialog -> UploadLimit error', async () => {
  await studio.setMode('limit');
  const { e } = engine('limit');
  await assert.rejects(e.uploadVideo(await freshPage(), job(), { deadline: Date.now() + 60000 }), err => err.code === 'UPLOAD_LIMIT');
});


test('v0.3.1 repro: a job with title null (the "uploading \\"null\\"" crash: Cannot read properties of null (reading \'replace\')) uploads with a clean file-name title', async () => {
  await studio.setMode('ok');
  const page = await freshPage();
  const { e } = engine('null-title');
  const r = await e.uploadVideo(page, { ...job(), title: null, description: null, tags: null }, { deadline: Date.now() + 120000 });
  assert.match(r.url, /youtu\.be/);
  assert.strictEqual(lastSub().title, 'Clip 001');
});

test('v0.3.1 duplicate check before a retry: finds an earlier published upload (by title) or a leftover draft (by file name) in the content list', async () => {
  await studio.setMode('ok');
  const page = await freshPage();
  const { e } = engine('dupcheck');
  const pub = lastSub();
  const f1 = await e.findExisting(page, { channelId: studio.channelId, title: pub.title, filename: 'nothing.mp4' });
  assert.strictEqual(f1.checked, true);
  assert.ok(f1.match && !f1.match.draft, JSON.stringify(f1));
  assert.strictEqual(f1.match.url, `https://youtu.be/${pub.videoId}`);
  studio.state.drafts = [{ title: 'clip_777' }];
  const f2 = await e.findExisting(page, { channelId: studio.channelId, title: 'Some New Title', filename: 'clip_777.mp4' });
  assert.ok(f2.match && f2.match.draft, JSON.stringify(f2));
  const f3 = await e.findExisting(page, { channelId: studio.channelId, title: 'Never Uploaded', filename: 'x.mp4' });
  assert.deepStrictEqual([f3.checked, f3.match], [true, null]);
  assert.strictEqual((await e.findExisting(page, { channelId: null, title: 'x' })).checked, false);
  studio.state.drafts = [];
});
