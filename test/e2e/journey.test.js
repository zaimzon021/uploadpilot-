'use strict';
// v0.3.1 end-to-end user journey on two simulated PCs (two separate userData dirs, two local APIs,
// real Chromium, real upload engine), driven only through the local HTTP API like the UI does:
//   PC1: first install -> create account -> connect Drive (mock OAuth) -> add proxy + Gemini key ->
//        link a channel (mock Google sign-in + mock Studio) -> drop videos -> AI writes ahead ->
//        "Now" -> upload -> publish
//   PC2: sign in only -> settings, keys, proxies, Drive arrive by themselves -> "active on PC1" ->
//        Take over -> PC1 hands over (login saved, due video backed up) and signs out ->
//        PC2 uploads PC1's next video with the restored login.
// Cloud: in-memory Firestore stand-in by default; with FIRESTORE_EMULATOR_HOST set (npm run
// test:emulator:journey) the same journey runs on the Firebase emulators with the real rules.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { UploadPilotApp } = require('../../src/core/app');
const { MemoryServer, MemoryStore } = require('../../src/cloud/store/memoryStore');
const { startMockStudio } = require('../mock-studio/server');
const { startMockGemini } = require('../helpers/mockGemini');
const { startMockDrive } = require('../helpers/mockDrive');
const { startSocksAuthServer, tmpDir, makeVideos, waitFor, headless } = require('../helpers/env');

const EMU = !!process.env.FIRESTORE_EMULATOR_HOST;
const FB = EMU ? { apiKey: 'demo-key', projectId: process.env.GCLOUD_PROJECT || 'demo-uploadpilot', appId: '1:1:web:1', authDomain: 'localhost' }
  : { apiKey: 'fake-api-key', projectId: 'demo-uploadpilot', appId: '1:1:web:1', authDomain: 'demo.firebaseapp.com' };
const EM = EMU ? { firestore: process.env.FIRESTORE_EMULATOR_HOST, auth: process.env.FIREBASE_AUTH_EMULATOR_HOST ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}` : '' } : { firestore: '', auth: '' };
const EMAIL = `journey${Date.now()}@example.com`, PASSWORD = 'journey-pass-1';

let studio, gemini, drive, px, server;
const pcs = [];
const bugs = [];   // filled by soft checks, printed at the end

async function startPc(name) {
  const dataDir = tmpDir(`journey-${name}-`);
  const app = new UploadPilotApp({
    dataDir, apiPort: 0, cooldownMs: 0, geminiPollMs: 10, watchStabilityMs: 400, watchPolling: true,
    engineOpts: { speed: 0.03 },
    openExternal: async url => { const back = drive.approve(url); await fetch(back).catch(() => {}); },   // the user approves in the browser
    settings: {
      urls: { studio: studio.url, accounts: studio.url, youtube: studio.url },
      proxyCheckUrl: `${studio.url}/__ip`, geminiBaseUrl: gemini.url,
      schedulerTickMs: 1000, aiTickMs: 1000, delayRangeMin: { min: 0.01, max: 0.02 },
      upload: { stepTimeoutMs: 8000, channelHardLimitMs: 120000, typing: { minDelay: 1, maxDelay: 2, humanChars: 20 } },
      browser: { headless, windowMode: 'minimized', extraArgs: ['--proxy-bypass-list=<-loopback>'] },
      keepAlive: { enabled: false }, geminiLowRes: { enabled: false },
      cloud: { pcName: name, firebaseConfig: JSON.stringify(FB), emulator: EM, verifyAfterRestore: false },
    },
    cloud: {
      ...(EMU ? {} : { storeFactory: () => new MemoryStore(server, { name }) }),
      driveBaseUrl: drive.base, googleEndpoints: drive.endpoints,
      syncOpts: { pushMs: 300, activityFlushMs: 1000 }, leaseOpts: { renewMs: 1000 },
      activeOpts: { heartbeatMs: 1000, staleMs: 8000, handoverTimeoutMs: 40000, handoverWaitMs: 20000, backupBudgetMs: 20000 },
    },
  });
  await app.start();
  await app.cloudReady;
  const call = async (method, p, body) => {
    const r = await fetch(app.api.url + p, { method, headers: { 'Content-Type': 'application/json', 'X-UploadPilot-Token': app.api.uiToken }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (j.code !== 0) throw Object.assign(new Error(`${method} ${p}: ${j.message}`), { status: j.code });
    return j.data;
  };
  const pc = { app, call, name, dataDir };
  pcs.push(pc);
  return pc;
}

test.before(async () => {
  studio = await startMockStudio();
  gemini = await startMockGemini({ respond: ({ prompt }) => { const f = /file name[^:]*: (\S+)/.exec(prompt || ''); return { title: `Journey ${f ? f[1].replace(/\.\w+$/, '') : 'clip'}`, description: 'Written by AI.', tags: ['journey', 'test'], hashtags: ['#journey'] }; } });
  drive = await startMockDrive();
  px = await startSocksAuthServer({ user: 'ju', pass: 'jp@ss' });
  server = new MemoryServer();
});
test.after(async () => {
  for (const p of pcs) await p.app.stop().catch(() => {});
  await studio.close(); await gemini.close(); await drive.close(); await px.close();
  if (bugs.length) console.log('JOURNEY NOTES:\n' + bugs.join('\n'));
});

let PC1, PC2, chId, folder;

test('PC1: first install -> create account -> Drive -> proxy + Gemini key -> link channel -> drop videos -> AI writes ahead -> Now -> published', { timeout: 115000 }, async () => {
  PC1 = await startPc('PC1');
  const st0 = await PC1.call('GET', '/cloud/status');
  assert.strictEqual(st0.state, 'signed_out', 'first screen = sign in');
  const s1 = await PC1.call('POST', '/cloud/signin', { email: EMAIL, password: PASSWORD, create: true });
  assert.strictEqual(s1.state, 'online'); assert.strictEqual(s1.activePc.me, true, 'first PC is active at once');
  assert.ok(s1.keys.ready, 'account key made from the password');
  let needs = await PC1.call('GET', '/needs-you');
  assert.ok(needs.some(i => i.id === 'drive') && needs.some(i => i.id === 'gemini'), JSON.stringify(needs));
  // Connect Drive (the OAuth client secret is bundled by CI in the installer; here: Advanced field)
  await PC1.call('PUT', '/settings', { cloud: { googleClientSecret: 'GOCSPX-journey' } });
  await PC1.call('POST', '/cloud/drive/connect');
  await waitFor(async () => (await PC1.call('GET', '/cloud/status')).drive.connected, { what: 'Drive connected', timeout: 10000 });
  await PC1.call('PUT', '/settings', { proxyPool: px.line, geminiKeys: 'AIza-journey-key' });
  await waitFor(async () => (await PC1.call('GET', '/cloud/status')).account.driveShared, { what: 'Drive shared with the account', timeout: 10000 });
  needs = await PC1.call('GET', '/needs-you');
  assert.ok(!needs.some(i => ['drive', 'gemini'].includes(i.id)), JSON.stringify(needs));
  // Link a channel
  const ls = await PC1.call('POST', '/link/start', { name: 'Tales in Motion' });
  const sess = PC1.app.profiles.session(ls.profileId);
  const page = sess.handle.context.pages()[0];
  await page.waitForSelector('#identifierId');
  await page.fill('#identifierId', 'tales@example.com'); await page.click('#identifierNext');
  await page.fill('input[name=Passwd]', 'pw'); await page.click('#passwordNext');
  await waitFor(async () => (await PC1.call('GET', `/link/${ls.id}`)).status === 'connected', { what: 'login detected', timeout: 30000 });
  await PC1.call('POST', `/link/${ls.id}/style`, { niche: 'animated tales', language: 'English', madeForKids: false, footer: 'Subscribe!', hashtags: '#shorts', mode: 'auto' });
  folder = tmpDir('journey-folder-');
  const done = await PC1.call('POST', `/link/${ls.id}/folder`, { folder });
  chId = done.channelId;
  // the link window closed: its login went to the cloud (Drive, encrypted)
  await waitFor(() => PC1.app.db.get('SELECT state_version FROM profiles WHERE id=?', ls.profileId).state_version >= 1, { what: 'login saved to the cloud', timeout: 15000 });
  // Drop videos into the folder: the watcher finds them, Gemini writes ahead without any click
  makeVideos(folder, ['tale_one.mp4', 'tale_two.mp4']);
  await waitFor(() => PC1.app.db.all('SELECT id FROM videos WHERE channel_id=?', chId).length === 2, { what: 'watcher found 2 videos', timeout: 15000 });
  await waitFor(() => PC1.app.db.all(`SELECT ai_status FROM videos WHERE channel_id=?`, chId).every(v => v.ai_status === 'done'), { what: 'AI wrote both ahead', timeout: 30000 });
  const vids = await PC1.call('GET', `/channels/${chId}/videos`);
  assert.ok(vids.every(v => /^Journey tale_/.test(v.title)), JSON.stringify(vids.map(v => v.title)));
  // "Now" on the first video -> uploads at the next free slot
  const first = vids.find(v => v.filename === 'tale_one.mp4');
  await PC1.call('PATCH', `/videos/${first.id}`, { scheduled_at: 'now' });
  await waitFor(() => PC1.app.db.get('SELECT status FROM videos WHERE id=?', first.id).status === 'done', { what: 'published', timeout: 60000, interval: 500 });
  const sub = studio.state.submissions.at(-1);
  assert.strictEqual(sub.title, 'Journey tale_one');
  assert.strictEqual(sub.cookie, true);
  assert.ok(fs.existsSync(path.join(folder, 'Done', 'tale_one.mp4')));
});

test('PC2: sign in only -> everything arrives -> Take over -> PC1 hands over and signs out -> PC2 publishes PC1\'s next video with the restored login', { timeout: 115000 }, async () => {
  PC2 = await startPc('PC2');
  const t0 = Date.now();
  const s2 = await PC2.call('POST', '/cloud/signin', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(s2.state, 'online');
  assert.ok(s2.keys.ready, 'the password unlocked the account key');
  assert.strictEqual(s2.activePc.me, false); assert.strictEqual(s2.activePc.other.pcName, 'PC1');
  const set2 = await PC2.call('GET', '/settings');
  assert.strictEqual(set2.geminiKeyCount, 1, 'Gemini key arrived');
  assert.ok(set2.proxyPoolText.includes(`${px.host}:${px.port}`), 'proxy arrived');
  assert.strictEqual(PC2.app.db.get('SELECT password FROM proxies').password, 'jp@ss', 'with its password');
  assert.ok(s2.drive.connected, 'Drive connected from the account (no reconnect, no secret paste)');
  assert.ok(Date.now() - t0 < 60000, 'ready in under a minute');
  const needs = await PC2.call('GET', '/needs-you');
  assert.deepStrictEqual(needs.map(i => i.id), ['active'], JSON.stringify(needs));
  await waitFor(() => PC2.app.db.get(`SELECT id FROM channels WHERE name='Mock Channel' OR name='Tales in Motion'`), { what: 'channel on PC2', timeout: 15000 });
  // Take over
  const r = await PC2.call('POST', '/cloud/takeover');
  assert.strictEqual(r.me, true); assert.strictEqual(r.how, 'handed_over');
  const st1 = await PC1.call('GET', '/cloud/status');
  assert.strictEqual(st1.state, 'signed_out');
  assert.match(st1.notice.text, /Signed out — now active on PC2/);
  assert.ok((await PC1.call('GET', '/needs-you')).some(i => i.id === 'handed'));
  // PC1 backed up the video that is still to come, so PC2 can upload it
  const v2 = PC1.app.db.get(`SELECT * FROM videos WHERE filename='tale_two.mp4'`);
  assert.ok(v2.drive_file_id, 'due video backed up during the hand-over');
  // PC2: the remote copy of that video, "Now"
  const rv = await waitFor(() => { const x = PC2.app.db.get(`SELECT * FROM videos WHERE filename='tale_two.mp4'`); return x && x.drive_file_id && x; }, { what: 'backup id on PC2', timeout: 15000 });
  await PC2.call('PATCH', `/videos/${rv.id}`, { scheduled_at: 'now' });
  await waitFor(() => PC2.app.db.get('SELECT status FROM videos WHERE id=?', rv.id).status === 'done', { what: 'PC2 published', timeout: 70000, interval: 500 });
  const sub = studio.state.submissions.at(-1);
  assert.strictEqual(sub.title, 'Journey tale_two');
  assert.strictEqual(sub.cookie, true, 'PC2 was signed in with the login restored from PC1');
  const evs = PC2.app.events.recent(80).map(e => e.message).join('\n');
  assert.match(evs, /login restored from cloud \(v\d+, \d+ cookies/);
  // PC1 tidies its file into Done when it sees the publish? It is signed out now: the file stays until it signs in again.
  if (!fs.existsSync(path.join(folder, 'Done', 'tale_two.mp4'))) bugs.push('note: PC1 is signed out, so tale_two.mp4 stays in its folder until PC1 signs in again (then it is moved to Done)');
});
