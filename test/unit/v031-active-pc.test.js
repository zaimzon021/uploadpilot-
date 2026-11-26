'use strict';
// v0.3.1 single active PC per account + keep-alive scheduler.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MemoryServer } = require('../../src/cloud/store/memoryStore');
const { startMockDrive } = require('../helpers/mockDrive');
const { makePc, seedChannel, settle, waitFor, profileStates, fakeLauncher } = require('../helpers/cloudPcs');
const { UploadPilotApp } = require('../../src/core/app');
const { tmpDir } = require('../helpers/env');

const cookie = (name, value, domain = '.google.com') => ({ name, value, domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });
const uid = pc => pc.app.cloud.user.uid;

test('graceful take-over: PC2 asks, PC1 finishes its upload, saves logins, backs up due videos, releases leases, signs out; PC2 becomes active', async () => {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const uploads = [];
  const A = await makePc(server, drive, 'PC1', { create: true, singleActive: true, uploads, uploadMs: 1200 });
  assert.strictEqual(A.app.cloud.activePc.isActive, true, 'first PC is active at once');
  const { chId, profileId } = seedChannel(A.app, { name: 'Alpha', files: ['a1.mp4', 'a2.mp4'] });
  A.app.db.run('UPDATE videos SET scheduled_at=? WHERE filename=?', Date.now() + 3600e3, 'a2.mp4');   // due later today: must be backed up for PC2
  await settle([A.app]);
  // PC1 is uploading a1 right now
  const run = A.app.runner.run(chId, 0);
  await waitFor(() => A.app.runner.live.get(chId) && A.app.runner.live.get(chId).state === 'uploading', { what: 'upload in progress' });
  const pa = A.app.db.get('SELECT * FROM profiles WHERE id=?', profileId);
  profileStates.set(pa.data_dir, { cookies: [cookie('SID', 'pc1-login')], origins: [] });
  // PC2 signs in: PC1 is live -> PC2 waits in standby and offers "Take over"
  const B = await makePc(server, drive, 'PC2', { singleActive: true, driveConnected: false });
  assert.strictEqual(B.app.cloud.activePc.isActive, false);
  assert.strictEqual(B.app.cloud.mayRun(), false);
  const offer = B.app.needsYou().find(i => i.id === 'active');
  assert.ok(offer && /active on PC1/.test(offer.text) && offer.actions[0].action === 'takeover');
  assert.strictEqual(B.app.dashboard().activeOn, 'PC1');
  await assert.rejects(B.app.profiles.open(B.app.db.get('SELECT id FROM profiles').id, { purpose: 'manual' }), e => e.code === 'NOT_ACTIVE');
  // Take over
  const r = await B.app.cloud.takeOver();
  assert.strictEqual(r.how, 'handed_over');
  await run;
  assert.strictEqual(uploads.length, 1, 'the upload in progress finished, once');
  assert.strictEqual(A.app.db.get(`SELECT status FROM videos WHERE filename='a1.mp4'`).status, 'done');
  assert.strictEqual(B.app.cloud.activePc.isActive, true);
  assert.strictEqual(B.app.cloud.mayRun(), true);
  // PC1: signed out, quiet, says where it went
  assert.strictEqual(A.app.cloud.state, 'signed_out');
  assert.strictEqual(A.app.cloud.mayRun(), false);
  assert.ok(A.app.needsYou().some(i => i.id === 'handed' && /now active on PC2/.test(i.text)));
  assert.match(A.app.events.recent(40).map(e => e.message).join('\n'), /Signed out — now active on PC2/);
  // its login was saved; the video due later was backed up for PC2; no leases left
  const doc = server.docs.get(`users/${uid(B)}/profiles/${pa.cloud_id}`).data;
  assert.ok(doc.stateVersion >= 1 && doc.stateGoogle >= 1, JSON.stringify(doc));
  assert.ok(A.app.db.get(`SELECT drive_file_id FROM videos WHERE filename='a2.mp4'`).drive_file_id, 'a2 backed up');
  const leases = [...server.docs.entries()].filter(([k, d]) => k.includes('/leases/') && !d.data.released);
  assert.strictEqual(leases.length, 0, JSON.stringify(leases));
  // PC2 opens the profile: PC1's login is imported
  const bp = await waitFor(() => B.app.db.get('SELECT * FROM profiles WHERE cloud_id=?', pa.cloud_id), { what: 'profile on PC2' });
  await B.app.profiles.open(bp.id, { purpose: 'manual' });
  assert.strictEqual(profileStates.get(bp.data_dir).cookies.find(c => c.name === 'SID').value, 'pc1-login');
  await B.app.profiles.close(bp.id);
  // PC1 can't open profiles or run autopilot until it signs in again
  await assert.rejects(A.app.profiles.open(profileId, { purpose: 'manual' }), e => e.code === 'NOT_ACTIVE');
  assert.deepStrictEqual(A.app.scheduler.claimNext(0), null);
  await A.app.stop(); await B.app.stop(); await drive.close();
});

test('take-over from a dead PC: heartbeat stale > staleMs -> the new PC becomes active straight away', async () => {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const A = await makePc(server, drive, 'PC1', { create: true, singleActive: true });
  A.app.cloud.activePc.stop();                         // PC1 died (no more heartbeats)
  await new Promise(r => setTimeout(r, 1700));
  const B = await makePc(server, drive, 'PC2', { singleActive: true });
  assert.strictEqual(B.app.cloud.activePc.isActive, true, 'no question asked');
  assert.match(B.app.events.recent(20).map(e => e.message).join('\n'), /PC1 stopped responding/);
  assert.strictEqual(B.app.needsYou().filter(i => i.id === 'active').length, 0);
  await A.app.stop(); await B.app.stop(); await drive.close();
});

test('a stale PC coming back never uploads its old login over newer cloud state, and signs itself out', async () => {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const A = await makePc(server, drive, 'PC1', { create: true, singleActive: true });
  const { profileId } = seedChannel(A.app, { name: 'Beta', files: ['b1.mp4'] });
  await settle([A.app]);
  const pa = A.app.db.get('SELECT * FROM profiles WHERE id=?', profileId);
  await A.app.profiles.open(profileId, { purpose: 'manual' });
  profileStates.set(pa.data_dir, { cookies: [cookie('SID', 'v1')], origins: [] });
  await A.app.profiles.close(profileId);                                     // v1 in the cloud
  await A.app.profiles.open(profileId, { purpose: 'manual' });               // PC1 keeps a window open...
  profileStates.set(pa.data_dir, { cookies: [cookie('SID', 'stale-on-pc1')], origins: [] });
  // ...and freezes (sleep): no heartbeat, no lease renewals
  A.app.cloud.activePc.stop(); A.app.cloud.activePc.isActive = true;          // it still believes it is active
  for (const h of A.app.cloud.leases.held.values()) clearInterval(h.timer);
  clearInterval(A.app.profiles.session(profileId).snapTimer);
  server.advance(200000);                                                     // > lease ttl and > staleMs
  const staleGuard = A.app.cloud.profileState;
  const B = await makePc(server, drive, 'PC2', { singleActive: true });
  assert.strictEqual(B.app.cloud.activePc.isActive, true);
  const bp = await waitFor(() => B.app.db.get('SELECT * FROM profiles WHERE cloud_id=?', pa.cloud_id), { what: 'profile on PC2' });
  await B.app.profiles.open(bp.id, { purpose: 'manual' });
  profileStates.set(bp.data_dir, { cookies: [cookie('SID', 'v2-from-pc2')], origins: [] });
  await B.app.profiles.close(bp.id);
  const p = `users/${uid(B)}/profiles/${pa.cloud_id}`;
  assert.strictEqual(server.docs.get(p).data.stateVersion, 2);
  // PC1 wakes up: its listener / heartbeat finds PC2 -> stops, closes WITHOUT exporting, signs out
  if (A.app.cloud.activePc) await A.app.cloud.activePc.beat().catch(() => {});
  await waitFor(() => A.app.cloud.state === 'signed_out', { what: 'PC1 signed out', timeout: 5000 });
  assert.strictEqual(server.docs.get(p).data.stateVersion, 2, 'cloud state untouched');
  assert.strictEqual(A.app.profiles.isOpen(profileId), false);
  assert.ok(A.app.needsYou().some(i => /now active on PC2/.test(i.text)));
  // even if the stale window's login were exported now, the version guard refuses it (cloud v2 > its v1)
  const h = await A.app.profiles.launcher({ userDataDir: pa.data_dir });
  const { ProfileStateSync } = require('../../src/cloud/profileState');
  const wakingPc = new ProfileStateSync({ db: A.app.db, drive: staleGuard.drive, keys: B.app.cloud.keys, store: B.app.cloud.store, root: () => `users/${uid(B)}`, pcId: 'pc1', pcName: 'PC1' });
  const refused = await wakingPc.exportIfChanged(A.app.db.get('SELECT * FROM profiles WHERE id=?', profileId), h.context);
  assert.match(refused.refused || '', /newer login \(v2/);
  assert.strictEqual(server.docs.get(p).data.stateVersion, 2);
  // and the signed-out guard: a window with no Google sign-in never replaces a signed-in snapshot
  await B.app.profiles.open(bp.id, { purpose: 'manual' });
  profileStates.set(bp.data_dir, { cookies: [cookie('NID', 'x', '.google.com')], origins: [] });
  await B.app.profiles.close(bp.id);
  assert.strictEqual(server.docs.get(p).data.stateVersion, 2);
  assert.match(B.app.events.recent(20).map(e => e.message).join('\n'), /no Google sign-in; the signed-in copy in the cloud is kept/);
  await A.app.stop(); await B.app.stop(); await drive.close();
});

test('keep-alive: one unused profile at a time, inside the window, humanized gap; refreshed + saved; signed-out found early with Open profile', async () => {
  const app = new UploadPilotApp({ dataDir: tmpDir('ka-'), startApi: false, launcher: fakeLauncher(), proxyChecker: async () => ({ ok: true, ip: '1.1.1.1' }),
    settings: { cloud: { mode: 'offline' }, uploadWindow: { start: '00:00', end: '24:00' }, keepAlive: { enabled: true, idleHours: 24, staySec: 0, tickMs: 3600e3 }, delayRangeMin: { min: 1, max: 7 } } });
  const mk = (name, cookies) => {
    const p = app.profiles.createProfile({ name, autoProxy: false });
    app.db.run(`INSERT INTO channels(profile_id,name,folder,status,style,created_at) VALUES(?,?,?,?,?,?)`, p.id, name, tmpDir('kaf-'), 'active', '{}', Date.now());
    app.db.run('UPDATE profiles SET last_opened=? WHERE id=?', Date.now() - 3 * 86400e3, p.id);
    profileStates.set(app.db.get('SELECT data_dir FROM profiles WHERE id=?', p.id).data_dir, { cookies, origins: [] });
    return p.id;
  };
  const p1 = mk('One', [cookie('SID', 'ok'), cookie('__Secure-3PSID', 'ok')]);
  const p2 = mk('Two', [cookie('NID', 'no-login')]);
  app.db.run('UPDATE profiles SET last_opened=? WHERE id=?', Date.now() - 5 * 86400e3, p1);   // longest unused first
  const r1 = await app.keepAlive.tick();
  assert.deepStrictEqual(r1, { visited: true, signedIn: true });
  assert.ok(app.db.get('SELECT keepalive_at FROM profiles WHERE id=?', p1).keepalive_at > Date.now() - 5000);
  assert.strictEqual(app.profiles.isOpen(p1), false, 'closed after the visit');
  assert.strictEqual(await app.keepAlive.tick(), null, 'humanized wait before the next profile');
  assert.match(app.keepAlive.blockedReason(), /humanized/);
  app.keepAlive.nextAllowed = 0;
  const r2 = await app.keepAlive.tick();
  assert.deepStrictEqual(r2, { visited: true, signedIn: false });
  const item = app.needsYou().find(i => i.id.startsWith('login'));
  assert.ok(item && /sign in needed/.test(item.text) && item.actions[0].action === 'open-profile');
  app.keepAlive.nextAllowed = 0;
  assert.strictEqual(await app.keepAlive.tick(), null, 'both visited today (and #2 waits for a sign-in)');
  // outside the upload window nothing starts
  app.db.run('UPDATE profiles SET keepalive_at=NULL, login_state=NULL');
  await app.updateSettings({ uploadWindow: { start: '00:00', end: '00:01' } });
  app.keepAlive.nextAllowed = 0;
  if (!require('../../src/util/time').inWindow(Date.now(), { start: '00:00', end: '00:01' })) assert.match(app.keepAlive.blockedReason(), /window/);
  app.db.close(); void p2; void fs; void path;
});
