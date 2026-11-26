'use strict';
// Channel runner guard rails with a fake browser: hard limit kills a hung run, dead proxy, missing file, AI flow.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { UploadPilotApp } = require('../../src/core/app');
const { startMockGemini } = require('../helpers/mockGemini');
const { tmpDir } = require('../helpers/env');

function hangingLauncher() {
  return async () => {
    const pending = new Set();
    const hang = () => new Promise((_, rej) => pending.add(rej));
    const ctx = new EventEmitter();
    const page = { isClosed: () => false, evaluate: hang, goto: hang, url: () => 'about:blank', screenshot: async () => {}, context: () => ctx, close: async () => {} };
    ctx.pages = () => [page]; ctx.newPage = async () => page; ctx.close = async () => {};
    let closed = false;
    return { context: ctx, cdpEndpoint: null, debugPort: 0, isClosed: () => closed, close: async () => { closed = true; for (const r of pending) r(new Error('Target closed')); ctx.emit('close'); } };
  };
}

function seed(app, { folder, files = ['x.mp4'], proxy = null }) {
  const prof = app.profiles.createProfile({ name: 't', proxy, autoProxy: false });
  const ch = app.db.run(`INSERT INTO channels(profile_id,name,folder,status,style,created_at) VALUES(?,?,?,?,?,?)`, prof.id, 'Hung', folder, 'active', '{}', Date.now()).lastInsertRowid;
  for (const f of files) {
    const p = path.join(folder, f); if (!fs.existsSync(p)) fs.writeFileSync(p, 'x');
    app.db.run(`INSERT INTO videos(channel_id,path,filename,status,scheduled_at,title,created_at) VALUES(?,?,?,?,?,?,?)`, ch, p, f, 'ready', Date.now() - 1000, 'T', Date.now());
  }
  return ch;
}

test('hard limit: a run whose browser hangs is killed on time, video marked failed, profile closed', async () => {
  const app = new UploadPilotApp({ dataDir: tmpDir('cr-'), startApi: false, launcher: hangingLauncher(), settings: { upload: { channelHardLimitMs: 1500, stepTimeoutMs: 60000 } } });
  const ch = seed(app, { folder: tmpDir('crf-') });
  const t0 = Date.now();
  const r = await app.runner.run(ch, 0);
  const took = Date.now() - t0;
  assert.strictEqual(r.result, 'hard_limit');
  assert.ok(took < 6000, `took ${took}`);
  assert.strictEqual(app.db.get('SELECT status FROM videos').status, 'failed');
  assert.match(app.db.get('SELECT error FROM videos').error, /Hard|limit/i);
  assert.strictEqual(app.profiles.isOpen(app.db.get('SELECT profile_id FROM channels').profile_id), false);
  assert.ok(fs.existsSync(path.join(r.runDir, 'run.log')));
  app.db.close();
});

test('dead proxy: run aborts before opening a browser, video stays queued for later', async () => {
  let launched = 0;
  const app = new UploadPilotApp({ dataDir: tmpDir('cr-'), startApi: false, launcher: async () => { launched++; throw new Error('should not launch'); }, proxyChecker: async () => ({ ok: false, error: 'connect ECONNREFUSED' }) });
  const ch = seed(app, { folder: tmpDir('crf-'), proxy: '127.0.0.1:9:a:b' });
  const r = await app.runner.run(ch, 0);
  assert.strictEqual(r.result, 'proxy_dead');
  assert.strictEqual(launched, 0);
  assert.strictEqual(app.db.get('SELECT status FROM videos').status, 'ready');
  assert.strictEqual(app.db.get('SELECT status FROM proxies').status, 'bad');
  app.db.close();
});

test('missing file is marked missing, not uploaded', async () => {
  const app = new UploadPilotApp({ dataDir: tmpDir('cr-'), startApi: false, launcher: hangingLauncher(), settings: { upload: { channelHardLimitMs: 3000 } } });
  const folder = tmpDir('crf-');
  const ch = seed(app, { folder });
  fs.unlinkSync(path.join(folder, 'x.mp4'));
  const r = await app.runner.run(ch, 0);
  assert.strictEqual(app.db.get('SELECT status FROM videos').status, 'missing');
  assert.strictEqual(r.uploaded.length, 0);
  app.db.close();
});

test('AI worker: today\'s videos only, approval mode, failures retried then given up, manual title unblocks', async () => {
  let fail = false;
  const g = await startMockGemini({ respond: ({ n }) => (fail ? 'nope' : { title: `T${n}`, description: 'd', tags: ['a'], hashtags: ['#h'] }) });
  const folder = tmpDir('ai-');
  ['a.mp4', 'b.mp4', 'c.mp4'].forEach(f => fs.writeFileSync(path.join(folder, f), 'x'));
  const app = new UploadPilotApp({ dataDir: tmpDir('ai-d-'), startApi: false, geminiPollMs: 1, geminiSleep: async () => {}, settings: { geminiKeys: ['k'], geminiBaseUrl: g.url, aiConcurrency: 5 } });
  const ch = app.db.run(`INSERT INTO channels(name,folder,status,style,created_at) VALUES(?,?,?,?,?)`, 'AI', folder, 'active', JSON.stringify({ mode: 'approval' }), Date.now()).lastInsertRowid;
  app.ingest(ch);
  const vids = app.db.all('SELECT id FROM videos ORDER BY id');
  const tomorrow = Date.now() + 2 * 86400e3;
  app.db.run('UPDATE videos SET scheduled_at=? WHERE id=?', Date.now() - 1000, vids[0].id);
  app.db.run('UPDATE videos SET scheduled_at=? WHERE id=?', tomorrow, vids[1].id);
  app.db.run('UPDATE videos SET scheduled_at=? WHERE id=?', Date.now() - 500, vids[2].id);
  fail = true;
  await app.aiTick();
  const v2 = app.db.get('SELECT * FROM videos WHERE id=?', vids[2].id);
  assert.strictEqual(v2.ai_status, 'retry');
  fail = false;
  app.aiNextTry.clear();
  await app.aiTick();
  const rows = app.db.all('SELECT id, status, title, ai_status FROM videos ORDER BY id');
  assert.strictEqual(rows[0].status, 'awaiting_approval');
  assert.match(rows[0].title, /^T\d+$/);
  assert.strictEqual(rows[1].status, 'queued', 'tomorrow\'s video not processed yet');
  assert.strictEqual(rows[2].status, 'awaiting_approval');
  app.approveVideo(rows[0].id);
  assert.strictEqual(app.db.get('SELECT status FROM videos WHERE id=?', rows[0].id).status, 'ready');
  // give up after 3 failures, then a hand-written title makes it uploadable
  fail = true;
  app.db.run('UPDATE videos SET scheduled_at=? WHERE id=?', Date.now() - 100, rows[1].id);
  for (let i = 0; i < 3; i++) { app.aiNextTry.clear(); await app.aiTick(); }
  assert.strictEqual(app.db.get('SELECT ai_status FROM videos WHERE id=?', rows[1].id).ai_status, 'failed');
  app.updateVideo(rows[1].id, { title: 'My own title' });
  assert.strictEqual(app.db.get('SELECT status FROM videos WHERE id=?', rows[1].id).status, 'awaiting_approval');
  await g.close(); app.db.close();
});
