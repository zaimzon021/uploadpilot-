'use strict';
// v0.3.2: sign-in detection, only the active PC writes logins, stale failures re-queued, files that
// live on another PC (Drive on demand, priority request, owner offline, same path here, back up new videos).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { MemoryServer } = require('../../src/cloud/store/memoryStore');
const { startMockDrive } = require('../helpers/mockDrive');
const { makePc, seedChannel, settle, waitFor, profileStates, fakeLauncher } = require('../helpers/cloudPcs');
const { UploadPilotApp } = require('../../src/core/app');
const { SignInWatch, judgeSignedIn } = require('../../src/profiles/signInWatch');
const { tmpDir } = require('../helpers/env');

const cookie = (name, value, domain = '.google.com') => ({ name, value, domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });
const SIGNED_IN = [cookie('SID', 'g-sid'), cookie('__Secure-1PSID', 'g-1p'), cookie('LOGIN_INFO', 'yt', '.youtube.com'), cookie('SID', 'yt-sid', '.youtube.com')];
const uid = pc => pc.app.cloud.user.uid;
const msgs = app => app.events.recent(80).map(e => e.message).join('\n');
const profPath = (pc, cloudId) => `users/${uid(pc)}/profiles/${cloudId}`;
const notIdleNow = () => { const h = (new Date().getHours() + 12) % 24; const s = `${String(h).padStart(2, '0')}:00`; return { start: s, end: `${String(h).padStart(2, '0')}:01` }; };

function flag(app, chId, profileId) {
  app.db.run(`UPDATE profiles SET login_state='signed_out', login_note='Sign in needed' WHERE id=?`, profileId);
  app.db.run(`UPDATE channels SET status='needs_you', status_reason='Login expired' WHERE id=?`, chId);
}

// ------------------------------------------------------------------ 1. sign-in detection
test('SignInWatch: cookies + Studio URL judge a sign-in; navigation, tab close and window close all count', async () => {
  assert.strictEqual(judgeSignedIn([cookie('NID', 'x')]).signedIn, false);
  assert.strictEqual(judgeSignedIn([cookie('SID', 'x')]).signedIn, false, 'Google cookie alone is not enough');
  assert.strictEqual(judgeSignedIn([cookie('SID', 'x')], { studioLoaded: true }).signedIn, true, 'Studio loaded without a sign-in redirect');
  assert.strictEqual(judgeSignedIn(SIGNED_IN).signedIn, true);
  assert.strictEqual(judgeSignedIn([{ ...cookie('SID', 'x'), expires: 1 }, cookie('LOGIN_INFO', 'y', '.youtube.com')]).signedIn, false, 'expired SID');
  // a fake window
  const ctx = new EventEmitter(); let jar = [];
  const page = new EventEmitter(); const frame = { url: () => 'https://studio.youtube.com/channel/UC1' }; page.mainFrame = () => frame;
  ctx.pages = () => [page]; ctx.cookies = async () => jar;
  let flagged = true; const fired = [];
  const w = new SignInWatch({ context: ctx, everyMs: 60000, debounceMs: 10, flagged: () => flagged, onSignedIn: r => { fired.push(r); flagged = false; } }).start();
  await w.check('t'); assert.deepStrictEqual(fired, []);
  jar = [cookie('SID', 'x')];
  page.emit('framenavigated', { url: () => 'https://accounts.google.com/v3/signin/identifier' });
  await w.check('t'); assert.deepStrictEqual(fired, [], 'still on the sign-in page');
  page.emit('framenavigated', frame);                                          // Studio loaded, no redirect
  await waitFor(() => fired.length === 1, { what: 'navigation check', timeout: 2000 });
  assert.deepStrictEqual(fired, ['navigation']);
  // tab closed / window closed
  flagged = true; jar = SIGNED_IN; page.emit('close');
  await waitFor(() => fired.length === 2, { what: 'tab close', timeout: 2000 });
  flagged = true; await w.check('t'); fired.length = 2; flagged = true;       // last cookies remembered
  ctx.emit('close');
  await waitFor(() => fired.length === 3, { what: 'window close', timeout: 2000 });
  assert.strictEqual(fired[2], 'window closed');
  w.stop();
});

test('signed in by hand in an open window: flag + Needs you cleared at once, login exported (v+1, over a newer stray copy), "signed in ✓", jobs run', async () => {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const A = await makePc(server, drive, 'RDP', { create: true, singleActive: true, appOpts: { signInWatchMs: 100 } });
  const { chId, profileId } = seedChannel(A.app, { name: 'Purrfect Giggles', files: ['baby.mp4'] });
  await settle([A.app]);
  const prof = A.app.db.get('SELECT * FROM profiles WHERE id=?', profileId);
  flag(A.app, chId, profileId);
  // a stray newer copy (v3, as DESKTOP-MDM36KB wrote it in the field) is already in the cloud
  const p = profPath(A, prof.cloud_id);
  server.docs.set(p, { data: { ...server.docs.get(p).data, stateVersion: 3, stateGoogle: 1, stateBy: 'DESKTOP-MDM36KB', stateFileId: null }, version: 99 });
  A.app.db.run('UPDATE profiles SET cloud_state_version=3 WHERE id=?', profileId);
  let items = A.app.needsYou().filter(i => i.id === `ch${chId}`);
  assert.ok(items.length && items[0].actions.some(a => a.action === 'check-signin'), JSON.stringify(items));
  // Open profile (manual) -> the user signs in inside the window
  profileStates.set(prof.data_dir, { cookies: [cookie('NID', 'anon')], origins: [] });
  await A.app.profiles.open(profileId, { purpose: 'manual' });
  await new Promise(r => setTimeout(r, 250));
  assert.ok(A.app.loginFlagged(profileId), 'nothing happens before the sign-in');
  profileStates.set(prof.data_dir, { cookies: SIGNED_IN, origins: [] });
  await waitFor(() => !A.app.loginFlagged(profileId), { what: 'sign-in detected', timeout: 5000 });
  const ch = A.app.db.get('SELECT * FROM channels WHERE id=?', chId);
  assert.strictEqual(ch.status, 'active'); assert.strictEqual(ch.status_reason, null);
  assert.strictEqual(A.app.db.get('SELECT login_state FROM profiles WHERE id=?', profileId).login_state, 'ok');
  assert.strictEqual(A.app.needsYou().filter(i => i.id === `ch${chId}` || i.id === `login${chId}`).length, 0, 'Needs-you item gone');
  assert.match(msgs(A.app), /Purrfect Giggles: signed in ✓/);
  await waitFor(() => server.docs.get(p).data.stateVersion === 4, { what: 'login exported as v4', timeout: 5000 });
  assert.ok(server.docs.get(p).data.stateGoogle >= 1);
  assert.strictEqual(server.docs.get(p).data.stateByPc, A.app.cloud.pcId);
  // the window closes -> the channel's due job is picked again
  await A.app.profiles.close(profileId);
  A.app.settings.set({ autopilotPaused: false });
  assert.ok(A.app.dueChannelIds().includes(chId), 'jobs run again');
  A.app.settings.set({ autopilotPaused: true });
  await A.app.stop(); await drive.close();
});

test('"Check sign-in" button: quick headless check; signed in -> cleared + saved; signed out -> stays', async () => {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const calls = [];
  const A = await makePc(server, drive, 'RDP', { create: true, singleActive: true });
  A.app.profiles.launcher = (o => { calls.push(o); return fakeLauncher()(o); });
  const { chId, profileId } = seedChannel(A.app, { name: 'Tales in Motion', files: ['t.mp4'] });
  await settle([A.app]);
  const prof = A.app.db.get('SELECT * FROM profiles WHERE id=?', profileId);
  A.app.db.run(`UPDATE profiles SET login_state='signed_out' WHERE id=?`, profileId);
  const item = A.app.needsYou().find(i => i.id === `login${chId}`);
  assert.deepStrictEqual(item.actions.map(a => a.action), ['open-profile', 'check-signin']);
  profileStates.set(prof.data_dir, { cookies: [cookie('NID', 'x')], origins: [] });
  assert.deepStrictEqual(await A.app.checkSignIn(chId), { signedIn: false, how: 'headless check' });
  assert.ok(A.app.loginFlagged(profileId));
  assert.strictEqual(calls[0].headless, true, 'headless');
  assert.strictEqual(A.app.profiles.isOpen(profileId), false);
  // the user had signed in and closed the window before it was seen
  profileStates.set(prof.data_dir, { cookies: SIGNED_IN, origins: [] });
  assert.deepStrictEqual(await A.app.checkSignIn(chId), { signedIn: true, how: 'headless check' });
  assert.strictEqual(A.app.loginFlagged(profileId), false);
  assert.ok(!A.app.needsYou().some(i => i.id === `login${chId}`));
  assert.ok(server.docs.get(profPath(A, prof.cloud_id)).data.stateVersion >= 1, 'saved to the cloud');
  await A.app.stop(); await drive.close();
});

test('stale flag never persists: a newer cloud login with Google cookies is imported (on becoming active and live via onSnapshot) and re-checked', async () => {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const D = await makePc(server, drive, 'DESKTOP', { create: true, singleActive: true });
  const { profileId } = seedChannel(D.app, { name: 'Purrfect Giggles', files: ['b.mp4'] });
  await settle([D.app]);
  const dp = D.app.db.get('SELECT * FROM profiles WHERE id=?', profileId);
  await D.app.profiles.open(profileId, { purpose: 'manual' });
  profileStates.set(dp.data_dir, { cookies: SIGNED_IN, origins: [] });
  await D.app.profiles.close(profileId);                                     // v1, signed in, written while DESKTOP was active
  // RDP signs in and takes over; its copy of the profile still says "sign in needed"
  const R = await makePc(server, drive, 'RDP', { singleActive: true, appOpts: { afterCloudUpMs: 50 } });
  const rp = await waitFor(() => R.app.db.get('SELECT * FROM profiles WHERE cloud_id=?', dp.cloud_id), { what: 'profile on RDP' });
  const rch = R.app.db.get('SELECT id FROM channels WHERE profile_id=?', rp.id).id;
  R.app.db.run(`UPDATE profiles SET login_state='signed_out', login_note='Sign in needed' WHERE id=?`, rp.id);
  assert.ok(R.app.needsYou().some(i => i.id === `login${rch}`));
  await R.app.cloud.takeOver();
  await waitFor(() => R.app.db.get('SELECT login_state FROM profiles WHERE id=?', rp.id).login_state === 'ok' && !R.app.profiles.isOpen(rp.id) && !(R.app._importing && R.app._importing.size), { what: 'imported + re-checked after becoming active', timeout: 8000 });
  assert.strictEqual(R.app.db.get('SELECT state_version FROM profiles WHERE id=?', rp.id).state_version, 1);
  assert.match(msgs(R.app), /newer login from DESKTOP/);
  // live: a newer signed-in copy appears in the cloud (written outside this app, e.g. an old version) -> imported at once
  R.app.db.run(`UPDATE profiles SET login_state='signed_out' WHERE id=?`, rp.id);
  const p = profPath(R, dp.cloud_id);
  const enc = R.app.cloud.keys.encJson({ cookies: [...SIGNED_IN, cookie('SID', 'v2-live')], origins: [] });
  const f = await R.app.cloud.drive().putSmall({ parts: ['profiles'], name: 'live.state', data: enc });
  server.docs.set(p, { data: { ...server.docs.get(p).data, stateVersion: 2, stateFileId: f.id, stateHash: 'x', stateGoogle: 2, stateBy: 'OLD-PC', updatedBy: 'old-pc' }, version: 500 });
  server._notify();
  await waitFor(() => !R.app.loginFlagged(rp.id) && R.app.db.get('SELECT state_version FROM profiles WHERE id=?', rp.id).state_version === 2, { what: 'live import', timeout: 8000 });
  assert.strictEqual(profileStates.get(rp.data_dir).cookies.find(c => c.name === 'SID' && c.value === 'v2-live') ? true : false, true);
  // not waiting for a sign-in: the active PC still imports a newer live copy right away (no extra check)
  await waitFor(() => !R.app.profiles.isOpen(rp.id) && !(R.app._importing && R.app._importing.size), { what: 'idle', timeout: 5000 });
  const f3 = await R.app.cloud.drive().putSmall({ parts: ['profiles'], name: 'live3.state', data: R.app.cloud.keys.encJson({ cookies: [...SIGNED_IN, cookie('SID', 'v3-live')], origins: [] }) });
  server.docs.set(p, { data: { ...server.docs.get(p).data, stateVersion: 3, stateFileId: f3.id, stateHash: 'y', stateGoogle: 2, stateBy: 'OLD-PC', updatedBy: 'old-pc' }, version: 600 });
  server._notify();
  await waitFor(() => R.app.db.get('SELECT state_version FROM profiles WHERE id=?', rp.id).state_version === 3, { what: 'eager live import', timeout: 8000 });
  assert.ok(profileStates.get(rp.data_dir).cookies.some(c => c.value === 'v3-live'));
  assert.strictEqual(R.app.loginFlagged(rp.id), false);
  await D.app.stop(); await R.app.stop(); await drive.close();
});

// ------------------------------------------------------------------ 2. only the active PC writes logins
test('only the active PC writes logins: a PC that lost the role is refused locally, in the transaction and by the rules', async () => {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const D = await makePc(server, drive, 'DESKTOP', { create: true, singleActive: true });
  const { profileId } = seedChannel(D.app, { name: 'Alpha', files: ['a.mp4'] });
  await settle([D.app]);
  const dp = D.app.db.get('SELECT * FROM profiles WHERE id=?', profileId);
  await D.app.profiles.open(profileId, { purpose: 'manual' });
  profileStates.set(dp.data_dir, { cookies: SIGNED_IN, origins: [] });
  await D.app.profiles.close(profileId);
  const p = profPath(D, dp.cloud_id);
  assert.strictEqual(server.docs.get(p).data.stateVersion, 1);
  // DESKTOP goes quiet (asleep); RDP becomes the active PC
  D.app.cloud.activePc.stop();
  server.advance(200000);
  const R = await makePc(server, drive, 'RDP', { singleActive: true });
  assert.strictEqual(R.app.cloud.activePc.isActive, true);
  // 1. DESKTOP signed in again as a standby PC with a window's login in hand: not even tried
  assert.strictEqual(D.app.cloud.online, true); assert.strictEqual(D.app.cloud.mayExportLogin(), false);
  const h = await D.app.profiles.launcher({ userDataDir: dp.data_dir });
  profileStates.set(dp.data_dir, { cookies: [...SIGNED_IN, cookie('SID', 'desktop-v2')], origins: [] });
  const sess = { handle: h, number: dp.number };
  assert.deepStrictEqual(await D.app.cloud.exportLogin(D.app.db.get('SELECT * FROM profiles WHERE id=?', profileId), sess, { reason: 'snapshot' }), { exported: false, refused: 'not the active PC' });
  assert.match(msgs(D.app), /login not saved here — this PC is not the active one/);
  // 2. a PC whose local view is stale ("I am active"): the transaction reads meta/activePc and refuses, even with force
  const { ProfileStateSync } = require('../../src/cloud/profileState');
  const stale = new ProfileStateSync({ db: D.app.db, drive: () => R.app.cloud.drive(), keys: R.app.cloud.keys, store: R.app.cloud.store, root: () => `users/${uid(R)}`, pcId: D.app.cloud.pcId, pcName: 'DESKTOP', singleActive: () => true, isActive: () => true });
  D.app.db.run('UPDATE profiles SET state_version=1 WHERE id=?', profileId);
  const r1 = await stale.exportIfChanged(D.app.db.get('SELECT * FROM profiles WHERE id=?', profileId), h.context, { reason: 'snapshot', force: true });
  assert.strictEqual(r1.exported, false); assert.match(r1.refused, /RDP is the active PC/);
  // 3. the rules (old app versions): only the active PC may change stateVersion; other profile fields still sync
  const store = R.app.cloud.store;
  await assert.rejects(store.set(p, { stateVersion: 9, stateFileId: 'evil', updatedAt: store.SERVER_TS, updatedBy: D.app.cloud.pcId }, { merge: true }), e => e.code === 'permission-denied');
  await store.set(p, { name: 'renamed', updatedAt: store.SERVER_TS, updatedBy: D.app.cloud.pcId }, { merge: true });
  assert.strictEqual(server.docs.get(p).data.stateVersion, 1, 'cloud login untouched');
  await store.set(p, { stateVersion: 2, updatedAt: store.SERVER_TS, updatedBy: R.app.cloud.pcId }, { merge: true });
  assert.strictEqual(server.docs.get(p).data.stateVersion, 2, 'the active PC may');
  await h.close();
  await D.app.stop(); await R.app.stop(); await drive.close();
});

// ------------------------------------------------------------------ 3. stale failures from older versions
test('upgrade: old code-crash failures go back to the queue (attempts reset, Needs you cleared); real / new failures stay', async () => {
  const dir = tmpDir('v032-up-');
  const mk = () => new UploadPilotApp({ dataDir: dir, startApi: false, launcher: fakeLauncher(), settings: { cloud: { mode: 'offline' }, autopilotPaused: true } });
  let app = mk();
  const folder = tmpDir('v032f-');
  const chId = app.db.run(`INSERT INTO channels(name,folder,status,style,created_at) VALUES(?,?,?,?,?)`, 'Tales in Motion', folder, 'active', '{}', Date.now()).lastInsertRowid;
  const ins = (file, error, extra = {}) => app.db.run(`INSERT INTO videos(channel_id,path,filename,size,status,error,attempts,retry_count,ai_status,title,failed_version,scheduled_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    chId, path.join(folder, file), file, 10, 'failed', error, 3, 3, extra.ai || 'done', extra.title ?? null, extra.version ?? null, Date.now() - 60000, Date.now()).lastInsertRowid;
  const crash = ins('Copy of _video_realistic_UGC.mp4', "Cannot read properties of null (reading 'replace')");
  const newCrash = ins('n.mp4', "Cannot read properties of null (reading 'replace')", { version: require('../../package.json').version, title: 'N' });
  const real = ins('r.mp4', 'Step timeout: Studio stopped responding', { title: 'R' });
  app.db.close();
  app = mk();
  await app.start({ api: false });
  const v = app.db.get('SELECT * FROM videos WHERE id=?', crash);
  assert.strictEqual(v.status, 'queued'); assert.strictEqual(v.attempts, 0); assert.strictEqual(v.retry_count, 0); assert.strictEqual(v.error, null);
  assert.strictEqual(v.ai_status, 'pending', 'no title yet: the metadata path writes it');
  assert.strictEqual(app.db.get('SELECT status FROM videos WHERE id=?', newCrash).status, 'failed', 'failed in this version: kept');
  assert.strictEqual(app.db.get('SELECT status FROM videos WHERE id=?', real).status, 'failed');
  const ids = app.needsYou().map(i => i.id);
  assert.ok(!ids.includes(`v${crash}`) && ids.includes(`v${real}`) && ids.includes(`v${newCrash}`), ids.join(','));
  assert.match(msgs(app), /failed in an older version .* queued again/);
  // a failure recorded now carries this version, so a restart doesn't re-queue it in a loop
  app.failUpload(app.db.get('SELECT * FROM videos WHERE id=?', crash), new Error("Cannot read properties of undefined (reading 'x')"), { channel: { name: 'T' } });
  assert.strictEqual(app.db.get('SELECT failed_version FROM videos WHERE id=?', crash).failed_version, require('../../package.json').version);
  await app.stop();
});

// ------------------------------------------------------------------ 4. files that live on another PC
async function twoPcs({ ownerStyle = { backupNew: false }, rdpOpts = {}, files = ['baby.mp4'] } = {}) {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const uploads = [];
  const D = await makePc(server, drive, 'DESKTOP-MDM36KB', { create: true, singleActive: true, uploads });
  const { chId, folder } = seedChannel(D.app, { name: 'Purrfect Giggles', files });
  D.app.db.run('UPDATE channels SET style=? WHERE id=?', JSON.stringify({ niche: 't', perDay: 5, ...ownerStyle }), chId);
  D.app.db.run('UPDATE videos SET scheduled_at=? WHERE channel_id=?', Date.now() + 5 * 86400e3, chId);   // not due: nothing backed up at hand-over
  await settle([D.app]);
  // DESKTOP stops being active but stays signed in (standby); RDP becomes the active PC
  D.app.cloud.activePc.stop();
  server.advance(200000);
  const R = await makePc(server, drive, 'RDP', { singleActive: true, uploads, cloudOpts: { fileOpts: { ackMs: 400, tickMs: 3600e3, firstTickMs: 3600e3 } }, ...rdpOpts });
  assert.strictEqual(R.app.cloud.activePc.isActive, true);
  const rch = await waitFor(() => R.app.db.get(`SELECT * FROM channels WHERE name='Purrfect Giggles'`), { what: 'channel on RDP' });
  const rv = await waitFor(() => R.app.db.get('SELECT * FROM videos WHERE channel_id=?', rch.id), { what: 'video on RDP' });
  await waitFor(() => R.app.db.get('SELECT profile_id FROM channels WHERE id=?', rch.id).profile_id, { what: 'profile link' });
  R.app.updateVideo(rv.id, { scheduled_at: 'now' });     // due now on RDP
  await settle([R.app, D.app]);
  return { server, drive, uploads, D, R, chId, folder, rch, rv, close: async () => { await D.app.stop(); await R.app.stop(); await drive.close(); } };
}

test('file on another PC, no backup, that PC online: priority backup on request (idle hours ignored), then RDP pulls it and uploads; row says "waiting for file"', async () => {
  const w = await twoPcs();
  const { D, R, rch, rv, uploads, drive } = w;
  D.app.settings.set({ cloud: { ...D.app.settings.get('cloud'), backup: { ...D.app.settings.get('cloud').backup, enabled: false, idleHours: notIdleNow(), speedCapKBps: 4000 } } });
  assert.strictEqual(R.app.cloud.runnableHere(R.app.db.get('SELECT * FROM videos WHERE id=?', rv.id)), false, 'no file here yet');
  assert.strictEqual(await R.app.cloud.files.tick(), 1, 'asked DESKTOP');
  const pill = () => (R.app.listVideos(rch.id).find(v => v.id === rv.id) || {}).waiting_for;
  assert.ok(pill() && pill().from === 'DESKTOP-MDM36KB', JSON.stringify(pill()));
  await waitFor(() => R.app.db.get('SELECT drive_file_id FROM videos WHERE id=?', rv.id).drive_file_id, { what: 'file arrived on Drive', timeout: 8000 });
  assert.match(msgs(D.app), /RDP needs "T-baby.mp4" now — uploading it to Google Drive first/);
  assert.ok(!R.app.needsYou().some(i => i.id.startsWith('file')), 'never "offline"');
  assert.ok(!pill(), 'no longer waiting');
  const r = await R.app.runner.run(rch.id, 0);
  assert.strictEqual(r.uploaded.length, 1, JSON.stringify(r));
  assert.strictEqual(uploads[0].pc, 'RDP'); assert.match(uploads[0].file, /cache/); assert.strictEqual(uploads[0].size, 200 * 1024);
  void drive;
  await w.close();
});

test('file on another PC that is offline: Needs you "Video is on X, which is offline — turn it on or relink folder" with Skip; served once it is back', async () => {
  const w = await twoPcs();
  const { D, R, rch, rv } = w;
  await D.app.cloud.signOut({ keepKey: true });                                // DESKTOP is off
  await R.app.cloud.files.tick();
  await new Promise(r => setTimeout(r, 600));                                 // > ackMs, nobody answered
  const item = R.app.needsYou().find(i => i.id === `file${rv.id}`);
  assert.ok(item, JSON.stringify(R.app.needsYou()));
  assert.match(item.text, /Video is on DESKTOP-MDM36KB, which is offline — turn it on or relink folder/);
  assert.deepStrictEqual(item.actions.map(a => a.action), ['skip']);
  assert.strictEqual(R.app.listVideos(rch.id).find(v => v.id === rv.id).waiting_for.state, 'offline');
  assert.notStrictEqual(R.app.db.get('SELECT status FROM videos WHERE id=?', rv.id).status, 'failed');
  // DESKTOP comes back: its listener finds the open request and serves it
  await D.app.cloud.signIn('owner@example.com', 'secret-pass');
  await waitFor(() => R.app.db.get('SELECT drive_file_id FROM videos WHERE id=?', rv.id).drive_file_id, { what: 'served after coming back', timeout: 8000 });
  assert.ok(!R.app.needsYou().some(i => i.id === `file${rv.id}`));
  await w.close();
});

test('file on another PC with a Drive backup: downloaded on demand at upload time, any hour; same path on this PC: used directly', async () => {
  // (a) backup exists
  let w = await twoPcs();
  D_backup: {
    const { D, R, rch, rv, uploads, chId } = w;
    const dv = D.app.db.get('SELECT * FROM videos WHERE channel_id=?', chId);
    const f = await D.app.cloud.backup.backupOne(dv.id);
    assert.ok(f && f.id);
    await settle([D.app]);
    await waitFor(() => R.app.db.get('SELECT drive_file_id FROM videos WHERE id=?', rv.id).drive_file_id, { what: 'backup id on RDP' });
    R.app.settings.set({ cloud: { ...R.app.settings.get('cloud'), backup: { ...R.app.settings.get('cloud').backup, idleHours: notIdleNow() } } });
    assert.strictEqual(await R.app.cloud.files.tick(), 0, 'no request needed');
    const r = await R.app.runner.run(rch.id, 0);
    assert.strictEqual(r.uploaded.length, 1); assert.match(uploads[0].file, /cache/);
    break D_backup;
  }
  await w.close();
  // (b) the same folder path exists here with the same file (name + size)
  w = await twoPcs({ rdpOpts: { sameDisk: false } });
  {
    const { R, rch, rv, uploads, folder } = w;
    const v = R.app.db.get('SELECT * FROM videos WHERE id=?', rv.id);
    assert.strictEqual(R.app.cloud.localCopy(v), path.join(folder, 'baby.mp4'));
    assert.strictEqual(R.app.cloud.runnableHere(v), true);
    assert.strictEqual(await R.app.cloud.files.tick(), 0, 'nothing to ask for');
    const r = await R.app.runner.run(rch.id, 0);
    assert.strictEqual(r.uploaded.length, 1); assert.strictEqual(uploads[0].file, path.join(folder, 'baby.mp4'));
    assert.strictEqual(R.app.db.get('SELECT local_path FROM videos WHERE id=?', rv.id).local_path, null, 'nothing copied or adopted');
    // a different size is not the same file
    const v2 = { ...v, size: 123 };
    assert.strictEqual(R.app.cloud.localCopy(v2), null);
  }
  await w.close();
});

test('relinking the folder on the active PC adopts the other PC\'s videos (no duplicates); a 0.3.1 "file is missing" for another PC\'s video waits for the file instead', async () => {
  const w = await twoPcs({ files: ['baby.mp4', 'cat.mp4'] });
  const { R, rch, folder } = w;
  const before = R.app.db.get('SELECT COUNT(*) AS n FROM videos WHERE channel_id=?', rch.id).n;
  const here = tmpDir('relink-'); for (const f of fs.readdirSync(folder).filter(f => f.endsWith('.mp4'))) fs.copyFileSync(path.join(folder, f), path.join(here, f));
  await R.app.updateChannel(rch.id, { folder: here });
  assert.strictEqual(R.app.db.get('SELECT COUNT(*) AS n FROM videos WHERE channel_id=?', rch.id).n, before, 'no duplicate rows');
  const cat = R.app.db.get(`SELECT * FROM videos WHERE channel_id=? AND filename='cat.mp4'`, rch.id);
  assert.strictEqual(cat.local_path, path.join(here, 'cat.mp4'));
  // 0.3.1 left "missing" on a cloud copy
  R.app.db.run(`UPDATE videos SET status='missing', error='File not found' WHERE id=?`, cat.id);
  assert.ok(R.app.needsYou().some(i => i.id === `v${cat.id}` && /file is missing/.test(i.text)));
  assert.ok(R.app.resetStaleFailures() >= 1);
  assert.strictEqual(R.app.db.get('SELECT status FROM videos WHERE id=?', cat.id).status, 'ready');
  assert.ok(!R.app.needsYou().some(i => i.id === `v${cat.id}`));
  await w.close();
});

test('back up new videos right away (per channel, default on, throttled); "idle hours only" is an Advanced option; off per channel', async () => {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const A = await makePc(server, drive, 'PC1', { create: true, singleActive: true });
  const set = b => A.app.settings.set({ cloud: { ...A.app.settings.get('cloud'), backup: { ...A.app.settings.get('cloud').backup, ...b } } });
  set({ enabled: false, idleHours: notIdleNow(), idleHoursOnly: false, speedCapKBps: 4000 });
  const { chId } = seedChannel(A.app, { name: 'Fresh', files: ['f1.mp4'] });
  assert.notStrictEqual(JSON.parse(A.app.db.get('SELECT style FROM channels WHERE id=?', chId).style).backupNew, false);
  assert.strictEqual(require('../../src/wizard/linkWizard').normalizeStyle({}).backupNew, true, 'default on');
  assert.strictEqual(A.app.cloud.backup.blockedReason(), 'Backup is off', 'the old all-videos switch is untouched');
  const f = await A.app.cloud.backup.tick();
  assert.ok(f && f.id, 'backed up right away, outside idle hours');
  assert.ok(A.app.db.get('SELECT drive_file_id FROM videos WHERE channel_id=?', chId).drive_file_id);
  // idle hours only (Advanced): a new video waits
  set({ idleHoursOnly: true });
  fs.writeFileSync(path.join(A.app.db.get('SELECT folder FROM channels WHERE id=?', chId).folder, 'f2.mp4'), Buffer.alloc(1000, 2));
  A.app.ingest(chId);
  assert.match(A.app.cloud.backup.freshBlockedReason(), /idle hours/);
  assert.strictEqual(await A.app.cloud.backup.tick(), null);
  // per channel off
  set({ idleHoursOnly: false });
  await A.app.updateChannel(chId, { style: { backupNew: false } });
  assert.strictEqual(A.app.cloud.backup.nextFresh(), null);
  assert.strictEqual(await A.app.cloud.backup.tick(), null);
  await A.app.stop(); await drive.close();
});
