'use strict';
// Google Drive client against a mock Drive server: folders, chunked resumable upload, speed cap,
// back-off on 403 userRateLimitExceeded, abort + resume, download, daily cap; OAuth loopback flow.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DriveClient, backupRate } = require('../../src/cloud/drive');
const { Throttle } = require('../../src/cloud/throttle');
const { GoogleAuth } = require('../../src/cloud/googleAuth');
const { SecretStore } = require('../../src/cloud/secretStore');
const { startMockDrive, staticToken } = require('../helpers/mockDrive');
const { tmpDir } = require('../helpers/env');

const fastSleep = ms => new Promise(r => setTimeout(r, Math.min(ms, 20)));
const KiB = 1024;

test('folders are created once and reused: UploadPilot/channels/<channel>', async () => {
  const m = await startMockDrive();
  const d = new DriveClient({ getToken: staticToken(), baseUrl: m.base, sleep: fastSleep });
  const id1 = await d.ensureFolder(['channels', "Bob's Clips"]);
  const id2 = await d.ensureFolder(['channels', "Bob's Clips"]);
  assert.strictEqual(id1, id2);
  const d2 = new DriveClient({ getToken: staticToken(), baseUrl: m.base, sleep: fastSleep });   // fresh cache finds existing folders
  assert.strictEqual(await d2.ensureFolder(['channels', "Bob's Clips"]), id1);
  assert.strictEqual([...m.files.values()].filter(f => f.mimeType === 'application/vnd.google-apps.folder').length, 3);
  await m.close();
});

test('chunked resumable upload: exact bytes, 256 KiB-aligned chunks, progress, daily byte count', async () => {
  const m = await startMockDrive();
  const dir = tmpDir('drv-'); const file = path.join(dir, 'v.mp4');
  const data = crypto.randomBytes(1300 * KiB); fs.writeFileSync(file, data);
  const d = new DriveClient({ getToken: staticToken(), baseUrl: m.base, sleep: fastSleep });
  const parentId = await d.ensureFolder(['channels', 'A']);
  const prog = [];
  const out = await d.upload({ source: file, name: 'v.mp4', parentId, chunkBytes: 512 * KiB, onProgress: (s, t) => prog.push([s, t]) });
  assert.ok(m.files.get(out.id).data.equals(data));
  const puts = m.requests.filter(r => r.method === 'PUT' && r.range && !r.range.includes('*'));
  assert.deepStrictEqual(puts.map(r => r.range), ['bytes 0-524287/1331200', 'bytes 524288-1048575/1331200', 'bytes 1048576-1331199/1331200']);
  assert.deepStrictEqual(prog.at(-1), [1331200, 1331200]);
  assert.strictEqual(d.bytesToday(), 1331200);
  await m.close();
});

test('speed cap: a 600 KiB upload at 300 KiB/s takes ~2 s', async () => {
  const m = await startMockDrive();
  const d = new DriveClient({ getToken: staticToken(), baseUrl: m.base, sleep: fastSleep });
  const t0 = Date.now();
  await d.upload({ source: crypto.randomBytes(600 * KiB), name: 'cap.bin', parentId: 'root', throttle: new Throttle(300 * KiB, { burstSec: 0.1 }), chunkBytes: 256 * KiB });
  const secs = (Date.now() - t0) / 1000;
  assert.ok(secs >= 1.7 && secs < 4, `took ${secs}s`);
  // backup rate rules: user cap wins, else 30% of measured, else a safe default
  assert.strictEqual(backupRate({ speedCapKBps: 100 }), 100 * KiB);
  assert.strictEqual(backupRate({ measuredBps: 1000000, speedCapPct: 30 }), 300000);
  assert.strictEqual(backupRate({}), 256 * KiB);
  await m.close();
});

test('403 userRateLimitExceeded / 500 -> exponential back-off, then success; quota error stops', async () => {
  const m = await startMockDrive();
  const sleeps = [];
  const d = new DriveClient({ getToken: staticToken(), baseUrl: m.base, sleep: async ms => { sleeps.push(ms); } });
  m.fail('GET', /\/drive\/v3\/files$/, 403, 'userRateLimitExceeded', 2);
  m.fail('POST', /\/drive\/v3\/files$/, 500, 'backendError', 1);
  const id = await d.ensureFolder(['x']);
  assert.ok(id);
  assert.ok(sleeps.length >= 3 && sleeps[1] > sleeps[0] - 1000, `back-off ${sleeps}`);
  assert.strictEqual(d.backoffs, 3);
  // mid-upload rate limit on a chunk: resumes from the server offset
  m.fail('PUT', /\/upload\/session\//, 403, 'userRateLimitExceeded', 1);
  const data = crypto.randomBytes(700 * KiB);
  const f = await d.upload({ source: data, name: 'rl.bin', parentId: id, chunkBytes: 256 * KiB });
  assert.ok(m.files.get(f.id).data.equals(data));
  // daily limit -> DRIVE_QUOTA, no retries, then the client refuses until later
  m.fail('POST', /\/upload\/drive\/v3\/files$/, 403, 'uploadLimitExceeded', 1);
  await assert.rejects(d.upload({ source: Buffer.alloc(10), name: 'q', parentId: id }), e => e.code === 'DRIVE_QUOTA');
  await assert.rejects(d.ensureFolder(['y']), e => e.code === 'DRIVE_QUOTA');
  await m.close();
});

test('abort mid-chunk (a YouTube upload started), pause, then resume from the server offset', async () => {
  const m = await startMockDrive();
  const d = new DriveClient({ getToken: staticToken(), baseUrl: m.base, sleep: fastSleep });
  const data = crypto.randomBytes(1024 * KiB);
  let ctl = new AbortController(), paused = false, session = null;
  const throttle = new Throttle(400 * KiB, { burstSec: 0.05 });
  setTimeout(() => { paused = true; ctl.abort(); ctl = new AbortController(); }, 600);   // YouTube upload starts
  setTimeout(() => { paused = false; }, 1500);                                           // and ends
  const pauses = [];
  const f = await d.upload({ source: data, name: 'big.bin', parentId: 'root', throttle, chunkBytes: 1024 * KiB, signalFor: () => ctl.signal, shouldPause: () => { if (paused) pauses.push(Date.now()); return paused; }, pausePollMs: 100, onSession: u => { session = u; } });
  assert.ok(m.files.get(f.id).data.equals(data), 'file intact after abort + resume');
  assert.ok(pauses.length >= 3, 'waited while paused');
  assert.ok(m.requests.some(r => r.range === `bytes */${data.length}`), 'asked the server for its offset');
  assert.ok(session);
  await m.close();
});

test('download (to .part, then renamed), resumable session survives a restart, daily cap', async () => {
  const m = await startMockDrive();
  const data = crypto.randomBytes(333 * KiB);
  const fid = m.putFile('dl.mp4', data);
  const d = new DriveClient({ getToken: staticToken(), baseUrl: m.base, sleep: fastSleep, dailyCapBytes: 1000 * KiB });
  const dest = path.join(tmpDir('dl-'), 'cache', 'x.mp4');
  await d.download(fid, dest);
  assert.ok(fs.readFileSync(dest).equals(data)); assert.ok(!fs.existsSync(dest + '.part'));
  // a session URL kept from an earlier run is resumed instead of restarted
  const big = crypto.randomBytes(600 * KiB);
  const url = await d.startSession({ name: 'r.bin', parentId: 'root', size: big.length });
  await fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer at-x', 'Content-Range': `bytes 0-${256 * KiB - 1}/${big.length}` }, body: big.subarray(0, 256 * KiB) });
  const f = await d.upload({ source: big, name: 'r.bin', parentId: 'root', sessionUrl: url, chunkBytes: 256 * KiB });
  assert.ok(m.files.get(f.id).data.equals(big));
  assert.ok(!m.requests.some(r => r.range && r.range.startsWith('bytes 0-') && r.path.includes(url.split('/').pop()) && r.t > 0 && r === m.requests.at(-1)));
  await assert.rejects(d.upload({ source: Buffer.alloc(800 * KiB), name: 'too-much', parentId: 'root' }), e => e.code === 'DRIVE_QUOTA');
  await m.close();
});

test('Google OAuth desktop flow: loopback redirect + PKCE, refresh token sealed, refresh, revoke', async () => {
  const m = await startMockDrive();
  const secrets = new SecretStore(path.join(tmpDir('oa-'), 'secrets.json'));
  let opened = null;
  const ga = new GoogleAuth({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csec', secrets, endpoints: m.endpoints, openExternal: u => { opened = u; } });
  const { url, done } = await ga.begin();
  assert.strictEqual(opened, url);
  const q = new URL(url).searchParams;
  assert.strictEqual(q.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.strictEqual(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  // the "browser" follows Google's redirect back to the app
  const page = await (await fetch(m.approve(url))).text();
  assert.match(page, /Google Drive connected/);
  const r = await done;
  assert.strictEqual(r.email, 'tester@example.com');
  assert.ok(ga.connected);
  assert.ok(!fs.readFileSync(secrets.file, 'utf8').includes(m.tokens.refresh), 'refresh token not stored in clear');
  ga._access = null;
  assert.match(await ga.accessToken(), /^at-/);
  assert.strictEqual(m.tokens.refreshed, 1);
  // a forged redirect with the wrong state is refused
  const second = await ga.begin();
  const bad = m.approve(second.url).replace(/state=[^&]+/, 'state=forged');
  await fetch(bad).catch(() => {});
  await assert.rejects(second.done, /state mismatch/);
  await ga.disconnect();
  assert.ok(!ga.connected); assert.ok(m.tokens.revoked);
  await m.close();
});
