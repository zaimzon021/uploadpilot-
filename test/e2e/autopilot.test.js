'use strict';
// Full system: API + link wizard + profiles behind authenticated SOCKS5 proxies (via the local bridge)
// + folder scan/watch + Gemini (mock) + 2 lanes + real upload engine against the mock Studio.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { UploadPilotApp } = require('../../src/core/app');
const { startMockStudio } = require('../mock-studio/server');
const { startMockGemini } = require('../helpers/mockGemini');
const { startSocksAuthServer, tmpDir, makeVideos, waitFor, headless } = require('../helpers/env');

let studio, gemini, px1, px2, app, api, dataDir;
const folders = {};
const call = async (method, p, body) => {
  const res = await fetch(api + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`${method} ${p} -> ${res.status} ${j.message}`);
  return j.data;
};

test.before(async () => {
  studio = await startMockStudio();
  gemini = await startMockGemini({ respond: ({ n }) => ({ title: `AI Title ${n}`, description: `AI description ${n}.`, tags: ['ai', `t${n}`], hashtags: ['#aitag'] }) });
  px1 = await startSocksAuthServer({ user: 'u1', pass: 'p1' });
  px2 = await startSocksAuthServer({ user: 'u2', pass: 'p2' });
  dataDir = tmpDir('updata-');
  app = new UploadPilotApp({
    dataDir, apiPort: 0, cooldownMs: 0, geminiPollMs: 10, watchStabilityMs: 500,
    engineOpts: { speed: 0.05 },
    settings: {
      urls: { studio: studio.url, accounts: studio.url, youtube: studio.url },
      proxyCheckUrl: `${studio.url}/__ip`,
      geminiKeys: ['key-one', 'key-two'], geminiBaseUrl: gemini.url, geminiModel: 'gemini-mock-flash',
      lanes: 2, delayRangeMin: { min: 0.01, max: 0.02 }, uploadWindow: { start: '00:00', end: '24:00' },
      schedulerTickMs: 1000, aiTickMs: 1000,
      upload: { stepTimeoutMs: 8000, channelHardLimitMs: 120000, typing: { minDelay: 1, maxDelay: 3, humanChars: 40 } },
      browser: { headless, windowMode: 'minimized', extraArgs: ['--proxy-bypass-list=<-loopback>'] },
    },
  });
  await app.start();
  api = app.api.url;
});
test.after(async () => { await app.stop(); await studio.close(); await gemini.close(); await px1.close(); await px2.close(); });

async function linkChannel(email, name, videos) {
  const ls = await call('POST', '/link/start', { name });
  assert.strictEqual(ls.status, 'waiting_login', ls.error);
  // --- the "user" signs in by hand in the opened profile window
  const sess = app.profiles.session(ls.profileId);
  assert.ok(sess.exitIp === '203.0.113.77', 'proxy health check ran before opening');
  const page = sess.handle.context.pages()[0];
  await page.waitForSelector('#identifierId');
  await page.fill('#identifierId', email); await page.click('#identifierNext');
  await page.fill('input[name=Passwd]', 'hunter2'); await page.click('#passwordNext');
  const st = await waitFor(async () => { const s = await call('GET', `/link/${ls.id}`); return s.status === 'connected' && s; }, { timeout: 30000, what: 'login detection' });
  assert.deepStrictEqual(st.channel, { name: 'Mock Channel', channelId: studio.channelId, handle: '@mockchannel' });
  assert.ok(st.proxy);
  await call('POST', `/link/${ls.id}/style`, { niche: 'dashcam fails', language: 'English', madeForKids: false, footer: 'Follow us on socials!', hashtags: '#shorts', mode: 'auto' });
  const folder = tmpDir('chan-');
  makeVideos(folder, videos, { thumbFor: [videos[0].replace(/\.\w+$/, '.jpg')] });
  folders[name] = folder;
  const done = await call('POST', `/link/${ls.id}/folder`, { folder });
  assert.strictEqual(done.status, 'done');
  assert.strictEqual(app.profiles.isOpen(ls.profileId), false, 'link browser closed after setup');
  return st.channelId;
}

async function makeDue(channelId) {
  const vids = await call('GET', `/channels/${channelId}/videos`);
  for (const v of vids.filter(v => !['done', 'skipped'].includes(v.status))) await call('PATCH', `/videos/${v.id}`, { scheduled_at: new Date(Date.now() - 60000).toISOString() });
}

let chA, chB;
test('link two channels through the wizard (each on its own profile + proxy)', async () => {
  const imp = await call('PUT', '/settings', { proxyPool: `${px1.line}\n${px2.line}\nbad line` });
  assert.strictEqual(imp.proxyImport.added, 2);
  assert.strictEqual(imp.proxyImport.errors.length, 1);
  chA = await linkChannel('alpha@example.com', 'Alpha', ['a_clip1.mp4', 'a_clip2.mp4']);
  chB = await linkChannel('bravo@example.com', 'Bravo', ['b_clip1.mp4', 'b_clip2.mp4']);
  const chans = await call('GET', '/channels');
  assert.strictEqual(chans.length, 2);
  assert.ok(chans.every(c => c.status === 'active'));
  assert.notStrictEqual(chans[0].proxy, chans[1].proxy, 'each profile got a different proxy from the pool');
  assert.notStrictEqual(chans[0].profile_number, chans[1].profile_number);
  for (const c of [chA, chB]) {
    const vids = await call('GET', `/channels/${c}/videos`);
    assert.strictEqual(vids.length, 2);
    assert.ok(vids.every(v => v.scheduled_at), 'planned automatically');
  }
});

test('autopilot: AI writes metadata, 2 lanes upload all due videos, files move to Done', async () => {
  const t0 = Date.now();
  await makeDue(chA); await makeDue(chB);
  await waitFor(() => app.db.get(`SELECT COUNT(*) n FROM videos WHERE status='done'`).n === 4, { timeout: 100000, interval: 500, what: '4 uploads' });
  const subs = studio.state.submissions;
  assert.strictEqual(subs.length, 4);
  for (const s of subs) {
    assert.match(s.title, /^AI Title \d+$/);
    assert.match(s.description, /^AI description \d+\.\n\nFollow us on socials!\n\n#aitag #shorts$/);
    assert.deepStrictEqual(s.tags.slice(0, 1), ['ai']);
    assert.strictEqual(s.visibility, 'PUBLIC');
    assert.strictEqual(s.kids, 'VIDEO_MADE_FOR_KIDS_NOT_MFK');
  }
  assert.deepStrictEqual(new Set(subs.map(s => s.cookie)), new Set([true]));
  assert.strictEqual(subs.filter(s => s.thumb).length, 2, 'thumbnails for the two clips that had one');
  for (const name of ['Alpha', 'Bravo']) {
    const left = fs.readdirSync(folders[name]).filter(f => f.endsWith('.mp4'));
    assert.deepStrictEqual(left, [], 'videos moved out');
    assert.strictEqual(fs.readdirSync(path.join(folders[name], 'Done')).filter(f => f.endsWith('.mp4')).length, 2);
  }
  const vids = app.db.all('SELECT * FROM videos');
  assert.ok(vids.every(v => /^https:\/\/youtu\.be\/mock/.test(v.url) && v.path.includes(`${path.sep}Done${path.sep}`)));
  const runs = app.db.all('SELECT * FROM runs');
  assert.ok(runs.length >= 2 && runs.every(r => fs.existsSync(path.join(r.log_dir, 'run.log'))));
  const lanes = new Set(runs.map(r => r.lane));
  assert.ok(lanes.size >= 1);
  assert.ok(gemini.stats.generates >= 4 && gemini.stats.byKey['key-one'] && gemini.stats.byKey['key-two'], 'both Gemini keys used');
  const dash = await call('GET', '/dashboard');
  assert.strictEqual(dash.publishedToday, 4);
  assert.strictEqual(dash.channels, 2);
  const evs = await call('GET', '/events?limit=200');
  assert.ok(evs.filter(e => e.kind === 'published').length === 4);
  console.log(`   4 uploads across 2 channels in ${Date.now() - t0}ms, lanes used: ${[...lanes].join(',')}`);
});

test('watcher: a video dropped into the folder is added and planned', async () => {
  makeVideos(folders.Alpha, ['a_clip3.mp4']);
  const v = await waitFor(() => app.db.get(`SELECT * FROM videos WHERE filename='a_clip3.mp4'`), { timeout: 15000, what: 'watcher' });
  await waitFor(() => app.db.get('SELECT scheduled_at FROM videos WHERE id=?', v.id).scheduled_at, { timeout: 5000, what: 'plan' });
});

test('verification on one channel pauses only that channel ("Needs you"); other channel keeps uploading', async () => {
  makeVideos(folders.Bravo, ['b_clip3.mp4']);
  await waitFor(() => app.db.get(`SELECT * FROM videos WHERE filename='b_clip3.mp4' AND scheduled_at IS NOT NULL`), { timeout: 15000, what: 'b_clip3 planned' });
  await studio.setMode('verify', { only: 'alpha@example.com' });
  await makeDue(chA); await makeDue(chB);
  await waitFor(() => app.db.get('SELECT status FROM channels WHERE id=?', chA).status === 'needs_you', { timeout: 60000, what: 'A needs you' });
  await waitFor(() => app.db.get(`SELECT status FROM videos WHERE filename='b_clip3.mp4'`).status === 'done', { timeout: 60000, what: 'B upload' });
  const a = await call('GET', `/channels/${chA}/status`);
  assert.strictEqual(a.status, 'needs_you');
  assert.match(a.reason, /verification/i);
  assert.strictEqual(app.db.get(`SELECT status FROM videos WHERE filename='a_clip3.mp4'`).status, 'ready', 'A video kept for later');
  // user fixes it and resumes
  await studio.setMode('ok');
  await call('POST', `/channels/${chA}/resume`);
  await waitFor(() => app.db.get(`SELECT status FROM videos WHERE filename='a_clip3.mp4'`).status === 'done', { timeout: 60000, what: 'A upload after resume' });
});
