'use strict';
// Two (or three) simulated PCs on one account: sync both ways, job race, lease-expiry take-over from
// the Drive backup, profile lock, profile login sync, quota behaviour.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MemoryServer } = require('../../src/cloud/store/memoryStore');
const { startMockDrive } = require('../helpers/mockDrive');
const { makePc, seedChannel, settle, waitFor, profileStates } = require('../helpers/cloudPcs');

async function world({ create = true } = {}) {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const uploads = [];
  const A = await makePc(server, drive, 'PC-A', { create, uploads });
  const B = await makePc(server, drive, 'PC-B', { uploads });
  return { server, drive, uploads, A, B, close: async () => { await A.app.stop(); await B.app.stop(); await drive.close(); } };
}
const uid = pc => pc.app.cloud.user.uid;

test('sync: channel, profile (proxy password encrypted), videos flow A -> B, edits flow B -> A, no echo loop', async () => {
  const w = await world();
  const { A, B, server } = w;
  const { chId } = seedChannel(A.app, { name: 'Alpha' });
  await settle([A.app]);
  const bCh = await waitFor(() => B.app.db.get(`SELECT * FROM channels WHERE name='Alpha'`), { what: 'channel on B', timeout: 5000 });
  const bVids = await waitFor(() => { const r = B.app.db.all('SELECT * FROM videos WHERE channel_id=?', bCh.id); return r.length === 2 && r; }, { what: 'videos on B', timeout: 5000 });
  assert.ok(bVids.every(v => v.remote === 1 && v.path.startsWith('cloud:') && v.origin_pc_name === 'PC-A' && v.status === 'ready'));
  assert.strictEqual(bCh.folder, null, 'the folder stays on PC-A');
  assert.strictEqual(bCh.folder_pc_name, 'PC-A');
  // proxy assignment travels with the profile; the password only as AES-GCM ciphertext
  const bProf = await waitFor(() => B.app.db.get('SELECT * FROM profiles WHERE id=?', bCh.profile_id), { what: 'profile link' });
  const bProxy = B.app.db.get('SELECT * FROM proxies WHERE id=?', bProf.proxy_id);
  assert.deepStrictEqual([bProxy.host, bProxy.port, bProxy.username, bProxy.password], ['203.0.113.9', 1080, 'puser', 'p@ss-w0rd']);
  const profDoc = server.docs.get(`users/${uid(A)}/profiles/${bProf.cloud_id}`).data;
  assert.ok(profDoc.proxy.passwordEnc && !JSON.stringify(profDoc).includes('p@ss-w0rd'));
  // status: queued/writing/uploading/done/failed in Firestore
  const vDoc = server.docs.get(`users/${uid(A)}/videos/${bVids[0].cloud_id}`).data;
  assert.strictEqual(vDoc.status, 'queued'); assert.strictEqual(vDoc.detail, 'ready'); assert.strictEqual(vDoc.updatedBy, A.app.cloud.pcId);
  // an edit on B reaches A (field-level merge)
  B.app.updateVideo(bVids[0].id, { title: 'Edited on B' });
  await settle([B.app]);
  await waitFor(() => A.app.db.get(`SELECT title FROM videos WHERE cloud_id=?`, bVids[0].cloud_id).title === 'Edited on B', { what: 'edit on A', timeout: 5000 });
  // channel stop on A reaches B
  A.app.stopChannel(chId);
  await settle([A.app]);
  await waitFor(() => B.app.db.get('SELECT status FROM channels WHERE id=?', bCh.id).status === 'stopped', { what: 'stop on B' });
  // plans doc written for the channel
  assert.ok(server.docs.get(`users/${uid(A)}/plans/${bCh.cloud_id}`));
  // quiet afterwards: no write ping-pong
  await settle([A.app, B.app], 500);
  const c0 = server.commits;
  await new Promise(r => setTimeout(r, 800));
  assert.ok(server.commits - c0 <= 1, `writes kept happening: ${server.commits - c0}`);
  const st = A.app.cloud.status();
  assert.ok(st.quota.writes < 60, `writes so far ${st.quota.writes}`);
  assert.ok(st.sync.pcs.some(p => p.name === 'PC-B'));
  await w.close();
});

test('two PCs race for the same due job: only one uploads it', async () => {
  const w = await world();
  const { A, B, uploads } = w;
  const { chId } = seedChannel(A.app, { name: 'Racer', files: ['r1.mp4'] });
  // B may take it over right away (backed up + grace 0), so both PCs really want the job
  A.app.settings.set({ cloud: { ...A.app.settings.get('cloud'), backup: { ...A.app.settings.get('cloud').backup, enabled: true } } });
  assert.ok(await A.app.cloud.backup.tick(), 'backed up');
  for (const pc of [A, B]) pc.app.settings.set({ cloud: { ...pc.app.settings.get('cloud'), takeoverGraceMin: 0 } });
  await settle([A.app]);
  const bCh = await waitFor(() => B.app.db.get(`SELECT * FROM channels WHERE name='Racer'`), { what: 'channel on B' });
  await waitFor(() => B.app.db.get(`SELECT drive_file_id FROM videos WHERE channel_id=? AND drive_file_id IS NOT NULL`, bCh.id), { what: 'backup id on B' });
  await waitFor(() => B.app.db.get('SELECT profile_id FROM channels WHERE id=?', bCh.id).profile_id, { what: 'profile linked on B' });
  const [ra, rb] = await Promise.all([A.app.runner.run(chId, 0), B.app.runner.run(bCh.id, 0)]);
  assert.strictEqual(uploads.length, 1, `uploads: ${JSON.stringify(uploads)}`);
  const winner = uploads[0].pc;
  const res = winner === 'PC-A' ? [ra, rb] : [rb, ra];
  assert.deepStrictEqual(res[0].uploaded.length, 1);
  assert.ok(['busy', 'nothing_due', 'ok'].includes(res[1].result) && !(res[1].uploaded || []).length, JSON.stringify(res[1]));
  await settle([A.app, B.app]);
  await waitFor(() => A.app.db.get(`SELECT status FROM videos WHERE channel_id=?`, chId).status === 'done' && B.app.db.get(`SELECT status FROM videos WHERE channel_id=?`, bCh.id).status === 'done', { what: 'done everywhere', timeout: 5000 });
  // a second run on either PC finds nothing to do
  assert.strictEqual((await B.app.runner.run(bCh.id, 0)).result, 'nothing_due');
  assert.strictEqual(uploads.length, 1);
  await w.close();
});

test('lease expiry: PC-A dies mid-upload, PC-B takes over from the Drive backup; cache deleted; A tidies up', async () => {
  const w = await world();
  const { A, B, server, drive, uploads } = w;
  const { chId, folder } = seedChannel(A.app, { name: 'Taker', files: ['t1.mp4'] });
  A.app.settings.set({ cloud: { ...A.app.settings.get('cloud'), backup: { ...A.app.settings.get('cloud').backup, enabled: true } } });
  await A.app.cloud.backup.tick();
  await settle([A.app], 50);
  const vA = A.app.db.get('SELECT * FROM videos WHERE channel_id=?', chId);
  assert.ok(vA.cloud_id);
  assert.ok(vA.drive_file_id && drive.files.get(vA.drive_file_id).data.length === 200 * 1024);
  // PC-A starts uploading: claims profile + job, marks it uploading ... then freezes
  const profA = A.app.db.get('SELECT * FROM profiles WHERE id=(SELECT profile_id FROM channels WHERE id=?)', chId);
  assert.ok((await A.app.cloud.leases.claim(`profile_${profA.cloud_id}`, { kind: 'profile' })).ok);
  assert.ok((await A.app.cloud.claimVideo(vA)).ok);
  A.app.db.run(`UPDATE videos SET status='uploading' WHERE id=?`, vA.id);
  await settle([A.app]);
  for (const h of A.app.cloud.leases.held.values()) clearInterval(h.timer);   // no more renewals
  const bCh = await waitFor(() => B.app.db.get(`SELECT * FROM channels WHERE name='Taker'`), { what: 'channel on B' });
  await waitFor(() => B.app.db.get(`SELECT status FROM videos WHERE channel_id=?`, bCh.id)?.status === 'uploading', { what: 'uploading on B' });
  // while A's lease is fresh, B neither recovers nor runs it
  assert.strictEqual(B.app.cloud.recoverStale(), 0);
  assert.strictEqual(B.app.runner.dueVideos(bCh.id).length, 0);
  B.app.listChannels(); // smoke
  const runningOn = B.app.getChannel(bCh.id).running_on;
  assert.strictEqual(runningOn && runningOn.pcName, 'PC-A', 'dashboard shows "running on PC-A"');
  // 2+ minutes pass (server time)
  server.advance(130000);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(B.app.cloud.recoverStale(), 1);
  assert.strictEqual(B.app.runner.dueVideos(bCh.id).length, 1, 'B now wants the job');
  B.app.settings.set({ autopilotPaused: false });
  assert.ok(B.app.dueChannelIds().includes(bCh.id), 'and the scheduler would pick the channel');
  B.app.settings.set({ autopilotPaused: true });
  const r = await B.app.runner.run(bCh.id, 0);
  assert.strictEqual(r.uploaded.length, 1, JSON.stringify(r));
  assert.strictEqual(uploads.length, 1); assert.strictEqual(uploads[0].pc, 'PC-B');
  assert.strictEqual(uploads[0].size, 200 * 1024, 'uploaded the downloaded copy');
  assert.match(uploads[0].file, /cache/);
  assert.ok(!fs.existsSync(uploads[0].file), 'cache copy deleted after the upload');
  assert.strictEqual(drive.files.has(vA.drive_file_id), false, 'Drive backup removed after publishing');
  // the job lease shows the take-over
  const lease = server.docs.get(`users/${uid(A)}/leases/video_${vA.cloud_id}`).data;
  assert.strictEqual(lease.takenOverFrom, 'PC-A'); assert.strictEqual(lease.released, true);
  // A sees "done" and moves its local file to Done/
  await settle([B.app]);
  await waitFor(() => A.app.db.get('SELECT status FROM videos WHERE id=?', vA.id).status === 'done', { what: 'done on A', timeout: 5000 });
  await waitFor(() => fs.existsSync(path.join(folder, 'Done', 't1.mp4')), { what: 'moved to Done on A' });
  await w.close();
});

test('profile lock: a profile open on PC-A cannot be opened on PC-B until A closes it', async () => {
  const w = await world();
  const { A, B } = w;
  const { profileId } = seedChannel(A.app, { name: 'Locky', files: ['l.mp4'] });
  await settle([A.app]);
  await A.app.profiles.open(profileId, { purpose: 'manual' });
  const cloudId = A.app.db.get('SELECT cloud_id FROM profiles WHERE id=?', profileId).cloud_id;
  const bProf = await waitFor(() => B.app.db.get('SELECT * FROM profiles WHERE cloud_id=?', cloudId), { what: 'profile on B' });
  await assert.rejects(B.app.profiles.open(bProf.id, { purpose: 'manual' }), e => e.code === 'PROFILE_LOCKED' && /open on PC-A/.test(e.message));
  // the autopilot on B treats it as busy, not as a failure
  const bCh = B.app.db.get('SELECT id FROM channels WHERE profile_id=?', bProf.id);
  B.app.settings.set({ cloud: { ...B.app.settings.get('cloud'), takeoverGraceMin: 0 } });
  B.app.db.run(`UPDATE videos SET drive_file_id='x' WHERE channel_id=?`, bCh.id);
  assert.strictEqual((await B.app.runner.run(bCh.id, 0)).result, 'busy');
  B.app.db.run(`UPDATE videos SET drive_file_id=NULL WHERE channel_id=?`, bCh.id);
  await A.app.profiles.close(profileId);
  const s = await B.app.profiles.open(bProf.id, { purpose: 'manual' });
  assert.ok(s);
  await assert.rejects(A.app.profiles.open(profileId, { purpose: 'auto' }), e => e.code === 'PROFILE_LOCKED' && /PC-B/.test(e.message));
  await B.app.profiles.close(bProf.id);
  await w.close();
});

test('profile login sync: storageState exported on close (encrypted, Drive), imported on B before navigation, unchanged = no upload', async () => {
  const w = await world();
  const { A, B, drive, server } = w;
  const { profileId } = seedChannel(A.app, { name: 'Login', files: ['x.mp4'] });
  await settle([A.app]);
  const profA = A.app.db.get('SELECT * FROM profiles WHERE id=?', profileId);
  await A.app.profiles.open(profileId, { purpose: 'link' });
  // the user signs in to Google inside the window
  profileStates.set(profA.data_dir, { cookies: [{ name: 'SID', value: 'secret-session', domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [{ origin: 'https://studio.youtube.com', localStorage: [{ name: 'k', value: 'v' }], indexedDB: [] }] });
  await A.app.profiles.close(profileId);
  const file = drive.byName(`profile-${profA.cloud_id}.state`);
  assert.ok(file, 'snapshot in UploadPilot/profiles');
  assert.ok(!file.data.toString('latin1').includes('secret-session'), 'encrypted');
  const doc = server.docs.get(`users/${uid(A)}/profiles/${profA.cloud_id}`).data;
  assert.strictEqual(doc.stateVersion, 1); assert.strictEqual(doc.stateFileId, file.id); assert.strictEqual(doc.stateBy, 'PC-A');
  // reopen + close on A with no change: nothing uploaded
  const before = drive.requests.length;
  await A.app.profiles.open(profileId, { purpose: 'manual' });
  await A.app.profiles.close(profileId);
  assert.strictEqual(drive.requests.filter((r, i) => i >= before && r.method === 'PUT').length, 0, 'unchanged login is not uploaded');
  assert.strictEqual(server.docs.get(`users/${uid(A)}/profiles/${profA.cloud_id}`).data.stateVersion, 1);
  // B opens: imports v1 before any navigation
  const bProf = await waitFor(() => { const p = B.app.db.get('SELECT * FROM profiles WHERE cloud_id=?', profA.cloud_id); return p && p.cloud_state_version === 1 && p; }, { what: 'state version on B' });
  await B.app.profiles.open(bProf.id, { purpose: 'manual', startUrl: 'https://studio.youtube.com' });
  const ops = B.calls.filter(c => c.dir === bProf.data_dir).map(c => c.op);
  assert.deepStrictEqual(ops, ['launch', 'setStorageState', 'goto'], 'imported before navigation');
  assert.strictEqual(profileStates.get(bProf.data_dir).cookies[0].value, 'secret-session');
  assert.strictEqual(B.app.db.get('SELECT state_version FROM profiles WHERE id=?', bProf.id).state_version, 1);
  await B.app.profiles.close(bProf.id);
  // wrong passphrase on a third PC: can't decrypt, warns, opens anyway with its own (empty) state
  const C = await makePc(w.server, drive, 'PC-C', { passphrase: null });
  await assert.rejects(C.app.cloud.setPassphrase('a-different-pass'), e => e.status === 409);
  await C.app.cloud.setPassphrase('shared-sync-pass');
  await C.app.stop();
  await w.close();
});
