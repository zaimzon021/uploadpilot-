'use strict';
// v0.3.1 autopilot fixes: never upload without metadata (the "uploading null" crash), AI writes ahead
// (earliest first, a moved-earlier video jumps the queue), autosave semantics, "now"/past times,
// automatic retry with back-off inside the window, scheduler wake that keeps the humanized delays.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { UploadPilotApp } = require('../../src/core/app');
const { startMockGemini } = require('../helpers/mockGemini');
const { fakeLauncher } = require('../helpers/cloudPcs');
const { tmpDir, waitFor } = require('../helpers/env');
const { titleFromFilename, fallbackMeta, missingFields, safeJobFields } = require('../../src/upload/metadata');
const { normalizeJob } = require('../../src/upload/engine');
const { LaneScheduler } = require('../../src/autopilot/laneScheduler');
const { nextInWindow, windowBounds } = require('../../src/util/time');

function mkApp(extra = {}, o = {}) {
  const uploads = [];
  const app = new UploadPilotApp({
    dataDir: tmpDir('v031-'), startApi: false, launcher: fakeLauncher(), proxyChecker: async () => ({ ok: true, ip: '1.2.3.4' }),
    geminiPollMs: 1, geminiSleep: async () => {},
    settings: { uploadWindow: { start: '00:00', end: '24:00' }, geminiLowRes: { enabled: false }, aiMinGapMs: 0, keepAlive: { enabled: false }, cloud: { mode: 'offline' }, ...extra },
    engineOpts: { speed: 0, uploadImpl: o.uploadImpl || (async (page, job) => { uploads.push(job); return { url: 'https://youtu.be/ok' }; }) },
  });
  return { app, uploads };
}
function channel(app, { files = ['a.mp4'], style = {}, folder = tmpDir('v031f-') } = {}) {
  for (const f of files) if (!fs.existsSync(path.join(folder, f))) fs.writeFileSync(path.join(folder, f), Buffer.alloc(4000, 7));
  const prof = app.profiles.createProfile({ name: 'p', autoProxy: false });
  const id = app.db.run(`INSERT INTO channels(profile_id,name,folder,status,style,created_at) VALUES(?,?,?,?,?,?)`, prof.id, 'Tales in Motion', folder, 'active', JSON.stringify(style), Date.now()).lastInsertRowid;
  return { id, folder };
}

test('metadata helpers: clean title from the file name, null-safe job fields', () => {
  assert.strictEqual(titleFromFilename('my_cat_video_FINAL.mp4'), 'My Cat Video Final');
  assert.strictEqual(titleFromFilename('the-best_of.the.year.MOV'), 'The Best of the Year');
  assert.strictEqual(titleFromFilename('12345.mp4'), 'Video 12345');
  assert.strictEqual(titleFromFilename(''), 'New Video');
  const long = titleFromFilename('a_very_' + 'long_words_'.repeat(20) + 'end.mp4');
  assert.ok([...long].length <= 70, long);
  assert.deepStrictEqual(missingFields({ title: null, description: '', tags: '[]' }), ['title', 'description', 'tags']);
  const j = safeJobFields({ title: null, description: null, tags: null, hashtags: null, filename: 'funny_dog.mp4' });
  assert.strictEqual(j.title, 'Funny Dog'); assert.ok(j.description.length > 5); assert.ok(j.tags.length >= 1);
  const fb = fallbackMeta('cool_trick.mp4', { niche: 'Skate tricks. Short clips.' });
  assert.match(fb.description, /Skate tricks/);
  // the engine itself never sees a null title (the .replace crash)
  const n = normalizeJob({ title: null, description: null, tags: null, file: '/x/summer_trip.mp4' });
  assert.strictEqual(n.title, 'Summer Trip'); assert.strictEqual(n.description, ''); assert.deepStrictEqual(n.tags, []);
});

test('REPRO "uploading null": row Save sent empty description/tags (edited=1), AI ran, time moved to now -> 0.3.0 uploaded title null and crashed; 0.3.1 uploads the AI title', async () => {
  const g = await startMockGemini({ respond: () => ({ title: 'Cats In Motion', description: 'A long description', tags: ['cats'], hashtags: ['#cats'] }) });
  const { app, uploads } = mkApp({ geminiKeys: ['k'], geminiBaseUrl: g.url });
  const { id: ch } = channel(app, { files: ['tales_01.mp4'] });
  app.ingest(ch);
  const v = app.db.get('SELECT * FROM videos');
  // what the old row "Save" button sent for a video still waiting for AI
  app.updateVideo(v.id, { description: '', tags: '', hashtags: '', scheduled_at: new Date(Date.now() - 60000).toISOString() });
  assert.strictEqual(app.db.get('SELECT edited FROM videos').edited, 0, 'empty fields are not a hand edit');
  await app.aiTick();
  const after = app.db.get('SELECT * FROM videos');
  assert.strictEqual(after.title, 'Cats In Motion', 'AI title written');
  assert.strictEqual(after.status, 'ready');
  const r = await app.runner.run(ch, 0);
  assert.deepStrictEqual(r.uploaded, [v.id]);
  assert.strictEqual(uploads[0].title, 'Cats In Motion');
  // and even if a row somehow is ready with no title at all, the job is never null
  app.db.run(`UPDATE videos SET status='ready', title=NULL, description=NULL, tags=NULL, url=NULL, edited=1, ai_status='done', scheduled_at=? WHERE id=?`, Date.now() - 1000, v.id);
  fs.writeFileSync(after.path.replace(/Done[\\/]/, ''), 'x');
  app.db.run('UPDATE videos SET path=? WHERE id=?', path.join(path.dirname(path.dirname(app.db.get('SELECT path FROM videos').path)), 'tales_01.mp4'), v.id);
  g.close();   // Gemini unreachable now -> filename fallback
  const r2 = await app.runner.run(ch, 0);
  assert.strictEqual(r2.uploaded.length, 1, JSON.stringify(r2));
  assert.strictEqual(uploads[1].title, 'Tales 01');
  assert.ok(uploads[1].description.length > 0 && uploads[1].tags.length > 0);
  assert.strictEqual(app.db.get('SELECT meta_source FROM videos').meta_source, 'filename');
  app.db.close();
});

test('inline metadata: a due video without AI gets Gemini right before the upload (no Save click, no daily batch)', async () => {
  const g = await startMockGemini({ respond: ({ n }) => ({ title: `Inline ${n}`, description: 'desc', tags: ['t'], hashtags: [] }) });
  const { app, uploads } = mkApp({ geminiKeys: ['k'], geminiBaseUrl: g.url });
  const { id: ch } = channel(app, { files: ['x1.mp4'] });
  app.ingest(ch);
  app.db.run(`UPDATE videos SET scheduled_at=?`, Date.now() - 1000);       // due, still queued, AI never ran
  assert.deepStrictEqual(app.dueChannelIds(), [ch], 'queued video is due in auto mode');
  const r = await app.runner.run(ch, 0);
  assert.strictEqual(r.uploaded.length, 1);
  assert.match(uploads[0].title, /^Inline \d+$/);
  assert.strictEqual(g.stats.generates, 1);
  await g.close(); app.db.close();
});

test('AI writes ahead: found videos are written in the background, earliest slot first; a video moved earlier jumps the queue', async () => {
  const order = [];
  const g = await startMockGemini({ respond: ({ prompt }) => { const f = /file name[^:]*: (\S+)/.exec(prompt || ''); order.push(f ? f[1] : '?'); return { title: `T ${f && f[1]}`, description: 'd', tags: ['x'], hashtags: [] }; } });
  const { app } = mkApp({ geminiKeys: ['k'], geminiBaseUrl: g.url, aiConcurrency: 1 });
  const { id: ch } = channel(app, { files: ['v1.mp4', 'v2.mp4', 'v3.mp4'] });
  app.ingest(ch);
  const vids = app.db.all('SELECT id, filename FROM videos ORDER BY id');
  const day = 86400e3, now = Date.now();
  app.db.run('UPDATE videos SET scheduled_at=? WHERE id=?', now + 5 * day, vids[0].id);
  app.db.run('UPDATE videos SET scheduled_at=? WHERE id=?', now + 3 * day, vids[1].id);
  app.db.run('UPDATE videos SET scheduled_at=? WHERE id=?', now + 4 * day, vids[2].id);
  await app.aiTick();                                     // days ahead: still written (0.3.0 waited for the day)
  assert.deepStrictEqual(order, ['v2.mp4']);
  app.updateVideo(vids[0].id, { scheduled_at: new Date(now + 2 * day).toISOString() });   // v1 moved earlier
  await app.aiTick();
  assert.deepStrictEqual(order, ['v2.mp4', 'v1.mp4'], 'moved-earlier video jumped ahead of v3');
  await app.aiTick();
  assert.deepStrictEqual(order, ['v2.mp4', 'v1.mp4', 'v3.mp4']);
  assert.ok(app.db.all('SELECT status FROM videos').every(v => v.status === 'ready'));
  await g.close(); app.db.close();
});

test('AI rate limit: at most aiConcurrency jobs, aiMinGapMs between starts; the watcher/scan kicks the worker by itself', async () => {
  const g = await startMockGemini({ respond: () => ({ title: 'T', description: 'd', tags: ['x'], hashtags: [] }) });
  const { app } = mkApp({ geminiKeys: ['k'], geminiBaseUrl: g.url, aiConcurrency: 2, aiMinGapMs: 300 });
  app.started = true;                                      // let aiKick schedule (no full start needed)
  const { id: ch } = channel(app, { files: ['r1.mp4', 'r2.mp4', 'r3.mp4'] });
  const t0 = Date.now();
  app.ingest(ch);                                          // found -> queued -> AI kicked, no click
  await waitFor(() => app.db.all(`SELECT ai_status FROM videos`).every(v => v.ai_status === 'done'), { timeout: 8000, what: 'all written' });
  assert.ok(Date.now() - t0 >= 550, `3 starts need >= 2 gaps (${Date.now() - t0} ms)`);
  clearTimeout(app._aiKickT); app.started = false;
  await g.close(); app.db.close();
});

test('autosave: only changed fields are written; "now" and past times = next free slot; the scheduler is woken; edits keep AI from overwriting', async () => {
  const { app } = mkApp();
  const { id: ch } = channel(app, { files: ['s1.mp4'] });
  app.ingest(ch);
  const v = app.db.get('SELECT * FROM videos');
  let woke = 0; app.scheduler = { wake: () => woke++ };
  const before = Date.now();
  app.updateVideo(v.id, { scheduled_at: 'now' });
  const t = app.db.get('SELECT scheduled_at FROM videos').scheduled_at;
  assert.ok(t >= before && t <= Date.now()); assert.strictEqual(woke, 1);
  const future = Date.now() + 3600e3;
  app.updateVideo(v.id, { scheduled_at: new Date(future).toISOString() });
  assert.strictEqual(app.db.get('SELECT scheduled_at FROM videos').scheduled_at, future);
  app.updateVideo(v.id, { scheduled_at: '2020-01-01T10:00:00Z' });          // past -> now (next free lane slot)
  assert.ok(app.db.get('SELECT scheduled_at FROM videos').scheduled_at >= before && app.db.get('SELECT scheduled_at FROM videos').scheduled_at <= Date.now());
  assert.strictEqual(woke, 3);
  app.updateVideo(v.id, { scheduled_at: new Date(future).toISOString() });
  assert.strictEqual(woke, 4);
  app.updateVideo(v.id, { scheduled_at: new Date(future).toISOString() });  // unchanged: nothing written, no wake
  assert.strictEqual(woke, 4);
  // typing a title: edited, uploadable; AI later fills only the empty fields
  app.updateVideo(v.id, { title: 'My Own Title' });
  let r = app.db.get('SELECT * FROM videos');
  assert.strictEqual(r.edited, 1); assert.strictEqual(r.status, 'ready');
  app._writeMeta(v.id, { title: 'AI title', description: 'AI desc', tags: ['ai'], hashtags: [] }, 'ai');
  r = app.db.get('SELECT * FROM videos');
  assert.strictEqual(r.title, 'My Own Title'); assert.strictEqual(r.description, 'AI desc'); assert.strictEqual(r.tags, '["ai"]');
  assert.throws(() => app.updateVideo(v.id, { title: 'x'.repeat(101) }), /100/);
  app.updateVideo(v.id, { title: '' });                                     // clearing a title is allowed
  assert.strictEqual(app.db.get('SELECT title FROM videos').title, null);
  app.db.close();
});

test('retry: back-off 5/15/45 min (+jitter) inside the window, 3 attempts, then failed + manual Retry; missing file / needs-you are not retried', async () => {
  const { app } = mkApp({ uploadWindow: { start: '00:00', end: '24:00' } });
  const { id: ch } = channel(app, { files: ['f1.mp4'] });
  app.ingest(ch);
  const v = () => app.db.get('SELECT * FROM videos');
  app.db.run(`UPDATE videos SET title='T', description='d', tags='["x"]', status='ready', scheduled_at=?`, Date.now() - 1000);
  const mins = [];
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    const r = app.failUpload(v(), new Error('Step timeout: stuck in "details" for 60s'), { channel: { name: 'C' } });
    assert.strictEqual(r.action, 'retry'); assert.strictEqual(r.attempt, i);
    assert.strictEqual(v().status, 'ready'); assert.strictEqual(v().retry_count, i);
    mins.push((v().retry_at - t0) / 60000);
    assert.strictEqual(app.runner.dueVideos(ch).length, 0, 'not due before the retry time');
    assert.strictEqual(app.runner.dueVideos(ch, v().retry_at + 1).length, 1, 'due again at the retry time');
  }
  assert.ok(mins[0] >= 4 && mins[0] <= 6, mins); assert.ok(mins[1] >= 12 && mins[1] <= 18, mins); assert.ok(mins[2] >= 36 && mins[2] <= 54, mins);
  const last = app.failUpload(v(), new Error('boom'), { channel: { name: 'C' } });
  assert.strictEqual(last.action, 'failed'); assert.strictEqual(v().status, 'failed'); assert.strictEqual(v().retry_at, null);
  assert.ok(app.needsYou().some(i => i.id === `v${v().id}` && i.actions[0].action === 'retry'), 'Needs you: Retry button');
  app.retryVideo(v().id);
  assert.strictEqual(v().status, 'ready'); assert.strictEqual(v().retry_count, 0); assert.ok(v().scheduled_at <= Date.now());
  // missing file: not retried
  const m = app.failUpload(v(), Object.assign(new Error("ENOENT: no such file or directory, stat 'x'"), { code: 'ENOENT' }), { channel: { name: 'C' } });
  assert.strictEqual(m.action, 'missing'); assert.strictEqual(v().status, 'missing');
  // a retry that would land outside the window moves into the next window
  const w = { start: '09:00', end: '10:00' };
  const late = windowBounds(Date.now(), w).end + 3600e3;
  const at = nextInWindow(late, w, () => 0);
  assert.strictEqual(at, windowBounds(late + 86400e3, w).start);
  app.db.close();
});

test('runner: a failed upload is retried automatically; login expired goes to Needs you and is not retried', async () => {
  let mode = 'fail';
  const { app } = mkApp({}, { uploadImpl: async () => { if (mode === 'fail') throw new Error('Upload failed: network error'); if (mode === 'login') throw Object.assign(new Error('Needs you: google_login'), { code: 'NEEDS_USER', state: 'google_login' }); return { url: 'https://youtu.be/z' }; } });
  const { id: ch } = channel(app, { files: ['n1.mp4'] });
  app.ingest(ch);
  app.db.run(`UPDATE videos SET title='T', description='d', tags='["x"]', status='ready', scheduled_at=?`, Date.now() - 1000);
  await app.runner.run(ch, 0);
  let v = app.db.get('SELECT * FROM videos');
  assert.strictEqual(v.status, 'ready'); assert.strictEqual(v.retry_count, 1); assert.ok(v.retry_at > Date.now());
  assert.match(app.events.recent(5).map(e => e.message).join('\n'), /Retrying at \d{1,2}:\d\d( ?[AP]M)? \(attempt 1\/3\)/);
  app.db.run('UPDATE videos SET retry_at=? WHERE id=?', Date.now() - 1, v.id);
  mode = 'login';
  await app.runner.run(ch, 0);
  v = app.db.get('SELECT * FROM videos');
  assert.strictEqual(v.retry_count, 1, 'login problems are not counted as retries');
  assert.strictEqual(app.db.get('SELECT status FROM channels').status, 'needs_you');
  assert.ok(app.needsYou().some(i => i.actions.some(a => a.action === 'open-profile')));
  app.resumeChannel(ch); mode = 'ok';
  await app.runner.run(ch, 0);
  assert.strictEqual(app.db.get('SELECT status FROM videos').status, 'done');
  await app.stop().catch(() => {});
});

test('scheduler: wake() starts idle lanes at once but never cuts the humanized wait between channels; idle sleep ends at the next due time', async () => {
  let due = [];
  const runs = [];
  const s = new LaneScheduler({ lanes: 1, delayRangeMin: { min: 0.02, max: 0.02 }, idleMs: 60000, cooldownMs: 0,
    getAllChannels: () => [1, 2], getDueChannels: () => due, runChannel: async id => { runs.push({ id, at: Date.now() }); due = due.filter(x => x !== id); } });
  s.start();
  await new Promise(r => setTimeout(r, 100));
  due = [1, 2]; const t0 = Date.now(); s.wake();
  await waitFor(() => runs.length >= 1, { timeout: 2000, what: 'first run after wake' });
  assert.ok(runs[0].at - t0 < 500, 'idle lane woke immediately');
  s.wake(); s.wake();                                     // during the 1.2 s humanized wait
  await waitFor(() => runs.length >= 2, { timeout: 4000, what: 'second run' });
  assert.ok(runs[1].at - runs[0].at >= 1100, `humanized delay kept (${runs[1].at - runs[0].at} ms)`);
  await s.stop();
  // next due time shortens an idle sleep
  const s2 = new LaneScheduler({ lanes: 1, delayRangeMin: { min: 0, max: 0 }, idleMs: 60000, getAllChannels: () => [], getDueChannels: () => [], runChannel: async () => {}, getNextDueAt: () => Date.now() + 700 });
  assert.ok(s2.idleSleepMs() <= 800 && s2.idleSleepMs() >= 200);
});
