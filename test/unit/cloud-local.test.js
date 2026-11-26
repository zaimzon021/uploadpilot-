'use strict';
// Offline/local behaviour and the v0.3 load rules: default config, offline mode, secret handling,
// backup worker gating, low-res Gemini copies, log rotation, "pause when I'm using the PC", browser cap.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UploadPilotApp } = require('../../src/core/app');
const { resolveCloudConfig } = require('../../src/cloud');
const { inDailyWindow } = require('../../src/cloud/backup');
const { makeLowRes } = require('../../src/ai/lowres');
const { rotateLogs } = require('../../src/util/logRotate');
const { LaneScheduler } = require('../../src/autopilot/laneScheduler');
const { MemoryServer } = require('../../src/cloud/store/memoryStore');
const { startMockDrive } = require('../helpers/mockDrive');
const { makePc, seedChannel, settle, fakeLauncher } = require('../helpers/cloudPcs');
const { tmpDir, makeVideos } = require('../helpers/env');

test('bundled default config: Firebase project + OAuth client id, no secret; Settings override wins', () => {
  const settings = { get: () => ({ firebaseConfig: '', googleClientId: '' }) };
  const r = resolveCloudConfig({ settings, dataDir: tmpDir('cfg-'), resourcesPath: null, env: {} });
  assert.strictEqual(r.configured, true); assert.strictEqual(r.source, 'bundled default');
  assert.strictEqual(r.projectId, 'uploadpilot-2c754');
  assert.match(r.google.clientId, /^1069754724778-.*\.apps\.googleusercontent\.com$/);
  assert.strictEqual(r.google.clientSecret, '', 'secret never bundled in the repo');
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'cloud.default.json'), 'utf8');
  assert.ok(!/clientSecret|GOCSPX/i.test(raw.replace(/"_comment"[^\n]*/, '')));
  const o = resolveCloudConfig({ settings: { get: () => ({ firebaseConfig: 'const firebaseConfig = { apiKey: "k2", projectId: "other", appId: "1:2:web:3" };' }) }, dataDir: tmpDir('cfg-'), resourcesPath: null, env: { UPLOADPILOT_OAUTH_CLIENT_SECRET: 'from-env' } });
  assert.strictEqual(o.projectId, 'other'); assert.strictEqual(o.source, 'settings');
  assert.strictEqual(o.google.clientSecret, 'from-env'); assert.strictEqual(o.google.secretSource, 'env');
  // CI-written secret file is picked up when present
  const dir = tmpDir('cfgdir-');
  fs.copyFileSync(path.join(__dirname, '..', '..', 'config', 'cloud.default.json'), path.join(dir, 'cloud.default.json'));
  fs.writeFileSync(path.join(dir, 'cloud.secret.json'), JSON.stringify({ google: { clientSecret: 'ci-secret' } }));
  assert.strictEqual(resolveCloudConfig({ settings, dataDir: tmpDir('cfg-'), resourcesPath: null, env: {}, bundledDir: dir }).google.secretSource, 'bundled (CI)');
});

test('offline: never signed in -> no Firebase SDK, local app unchanged; "Use offline" sticks; client secret is sealed', async () => {
  const dataDir = tmpDir('off-');
  const app = new UploadPilotApp({ dataDir, startApi: false, launcher: fakeLauncher(), settings: { autopilotPaused: true } });
  await app.start({ api: false });
  const st = await app.cloudReady;
  assert.strictEqual(st.state, 'signed_out'); assert.strictEqual(app.cloud.store, null, 'Firebase not loaded');
  assert.strictEqual(st.configured, true);
  // v0.2 behaviour: local channel + plan + run work without the cloud
  const folder = tmpDir('offf-'); makeVideos(folder, ['o1.mp4']);
  const prof = app.profiles.createProfile({ name: 'x', autoProxy: false });
  const ch = app.db.run(`INSERT INTO channels(profile_id,name,folder,status,style,created_at) VALUES(?,?,?,?,?,?)`, prof.id, 'Local', folder, 'active', '{}', Date.now()).lastInsertRowid;
  assert.strictEqual(app.ingest(ch).added, 1);
  assert.ok(app.db.get('SELECT scheduled_at FROM videos').scheduled_at);
  assert.strictEqual(app.runner.dueVideos(ch, Date.now() + 3 * 86400e3).length, 0, 'not ready yet (no title)');
  // Use offline
  const off = await app.cloud.useOffline();
  assert.strictEqual(off.state, 'offline');
  // OAuth client secret typed in Settings is sealed, never in plain settings
  await app.updateSettings({ cloud: { googleClientSecret: 'GOCSPX-test-secret' } });
  assert.strictEqual(app.settings.get('cloud').googleClientSecret, '');
  assert.ok(!fs.readFileSync(path.join(dataDir, 'uploadpilot.db')).toString('latin1').includes('GOCSPX-test-secret'));
  assert.ok(!fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8').includes('GOCSPX-test-secret'));
  assert.strictEqual(app.cloud.status().drive.secretSource, 'settings');
  await app.updateSettings({ cloud: { googleClientSecret: '' } });          // empty field = keep
  assert.strictEqual(app.cloud.status().drive.secretSet, true);
  await app.stop();
  const again = new UploadPilotApp({ dataDir, startApi: false, launcher: fakeLauncher() });
  await again.start({ api: false });
  assert.strictEqual((await again.cloudReady).state, 'offline', 'offline choice survives restart');
  await again.stop();
  // and with no config at all
  process.env.UPLOADPILOT_NO_DEFAULT_CLOUD = '1';
  try {
    const bare = new UploadPilotApp({ dataDir: tmpDir('bare-'), startApi: false, launcher: fakeLauncher() });
    await bare.start({ api: false });
    assert.strictEqual((await bare.cloudReady).state, 'unconfigured');
    await assert.rejects(bare.cloud.signIn('a@b.c', 'xxxxxx'), /not configured/);
    await bare.stop();
  } finally { delete process.env.UPLOADPILOT_NO_DEFAULT_CLOUD; }
});

test('backup: idle-hours window (wraps midnight), never while uploading to YouTube, speed cap applied', async () => {
  const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
  assert.ok(inDailyWindow(at(2), { start: '01:00', end: '07:00' }));
  assert.ok(!inDailyWindow(at(12), { start: '01:00', end: '07:00' }));
  assert.ok(inDailyWindow(at(23, 30), { start: '22:00', end: '06:00' }) && inDailyWindow(at(3), { start: '22:00', end: '06:00' }) && !inDailyWindow(at(12), { start: '22:00', end: '06:00' }));
  const server = new MemoryServer(); const drive = await startMockDrive();
  const A = await makePc(server, drive, 'PC-A', { create: true });
  const { chId } = seedChannel(A.app, { name: 'Bk', files: ['b1.mp4'] });
  const set = b => A.app.settings.set({ cloud: { ...A.app.settings.get('cloud'), backup: { ...A.app.settings.get('cloud').backup, ...b } } });
  assert.strictEqual(A.app.cloud.backup.blockedReason(), 'Backup is off');
  set({ enabled: true, idleHours: { start: '00:00', end: '00:00' }, speedCapKBps: 400 });
  A.app.runner.live.set(chId, { state: 'uploading' });
  assert.strictEqual(A.app.cloud.backup.blockedReason(), 'Uploading to YouTube');
  assert.strictEqual(await A.app.cloud.backup.tick(), null);
  A.app.runner.live.delete(chId);
  const t0 = Date.now();
  const f = await A.app.cloud.backup.tick();
  const secs = (Date.now() - t0) / 1000;
  assert.ok(f && drive.files.get(f.id).data.length === 200 * 1024);
  assert.ok(secs >= 0.3, `capped at 400 KB/s: 200 KiB took ${secs}s`);
  assert.ok(drive.byName('b1.mp4').parents.length);
  await settle([A.app]);
  const doc = server.docs.get(`users/${A.app.cloud.user.uid}/videos/${A.app.db.get('SELECT cloud_id FROM videos').cloud_id}`).data;
  assert.strictEqual(doc.driveFileId, f.id, 'Drive file id tracked in Firestore');
  set({ idleHours: { start: '03:00', end: '03:01' } });
  if (!inDailyWindow(Date.now(), { start: '03:00', end: '03:01' })) assert.match(A.app.cloud.backup.blockedReason(), /idle hours/);
  await A.app.stop(); await drive.close();
});

test('Gemini low-bandwidth copy: 360p via ffmpeg, smaller; original when ffmpeg is missing', async () => {
  const d = tmpDir('lr-');
  const src = path.join(d, 'hd.mp4');
  const { execFileSync } = require('child_process');
  try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-pix_fmt', 'yuv420p', '-b:v', '4M', '-shortest', src]); }
  catch (_) { return test.skip?.('ffmpeg not available'); }
  const r = await makeLowRes(src, { outDir: d });
  assert.ok(r.lowres, r.reason);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', r.path]).toString().trim();
  assert.strictEqual(probe, '360');
  assert.ok(r.bytes < r.originalBytes / 3, `${r.bytes} vs ${r.originalBytes}`);
  const miss = await makeLowRes(src, { ffmpegPath: null });
  assert.strictEqual(miss.lowres, false); assert.strictEqual(miss.path, src);
  const bad = await makeLowRes(src, { ffmpegPath: '/nonexistent/ffmpeg' });
  assert.strictEqual(bad.path, src);
});

test('log rotation: old daily logs / run folders deleted, big log rolled, events table capped', () => {
  const logs = tmpDir('logs-');
  const old = new Date(Date.now() - 20 * 86400e3).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(logs, `app-${old}.log`), 'x');
  fs.writeFileSync(path.join(logs, `app-${today}.log`), Buffer.alloc(3000));
  fs.mkdirSync(path.join(logs, 'runs', old), { recursive: true }); fs.mkdirSync(path.join(logs, 'runs', today), { recursive: true });
  const { DB } = require('../../src/core/db');
  const db = new DB(':memory:');
  for (let i = 0; i < 50; i++) db.run('INSERT INTO events(ts,level,message) VALUES(?,?,?)', i, 'info', 'm' + i);
  const r = rotateLogs({ logsDir: logs, db, days: 14, maxBytes: 1000, keepEvents: 10 });
  assert.deepStrictEqual([r.removedFiles, r.removedRunDirs, r.rolled], [1, 1, 1]);
  assert.ok(fs.existsSync(path.join(logs, `app-${today}.1.log`)));
  assert.ok(fs.existsSync(path.join(logs, 'runs', today)));
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM events').n, 10);
});

test('"pause when I\'m using the PC": no new runs or AI while the user is active; browser cap = lanes', async () => {
  let idleSec = 10;
  const app = new UploadPilotApp({ dataDir: tmpDir('idle-'), startApi: false, launcher: fakeLauncher(), idleTimeProvider: () => idleSec, settings: { pauseWhenActive: { enabled: true, idleMinutes: 5 }, lanes: 1, autopilotPaused: true, geminiKeys: ['k'] } });
  assert.strictEqual(app.userActive(), true);
  idleSec = 400; assert.strictEqual(app.userActive(), false);
  idleSec = 10;
  assert.strictEqual(await app.aiTick(), 0);
  const sched = new LaneScheduler({ lanes: 1, delayRangeMin: { min: 0, max: 0 }, getAllChannels: () => [1], getDueChannels: () => [1], runChannel: async () => {}, canStart: () => !app.userActive() });
  assert.strictEqual(sched.claimNext(0), null);
  idleSec = 999; assert.strictEqual(sched.claimNext(0), 1);
  // max browsers = lanes (1): a manual window blocks the autopilot from opening a second one
  const p1 = app.profiles.createProfile({ autoProxy: false }), p2 = app.profiles.createProfile({ autoProxy: false });
  await app.profiles.open(p1.id, { purpose: 'manual' });
  await assert.rejects(app.profiles.open(p2.id, { purpose: 'auto' }), e => e.code === 'BROWSER_LIMIT');
  await app.profiles.close(p1.id);
  await app.profiles.open(p2.id, { purpose: 'auto' });
  await app.profiles.closeAll();
  app.db.close();
});
