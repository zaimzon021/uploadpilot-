'use strict';
// Runs only inside the Firebase Emulator Suite (real Firestore + Auth emulators, real firestore.rules):
//   npm run test:emulator     (= firebase emulators:exec --only auth,firestore "node --test test/emulator")
// Two full UploadPilotApp instances ("PC-A", "PC-B") use the real Firebase JS SDK.
const test = require('node:test');
const assert = require('node:assert');
const { UploadPilotApp } = require('../../src/core/app');
const { FirestoreStore } = require('../../src/cloud/store/firestoreStore');
const { LeaseManager } = require('../../src/cloud/leases');
const { fakeLauncher, seedChannel } = require('../helpers/cloudPcs');
const { tmpDir, waitFor } = require('../helpers/env');

const ON = !!process.env.FIRESTORE_EMULATOR_HOST;
const FB = { apiKey: 'demo-key', projectId: process.env.GCLOUD_PROJECT || 'demo-uploadpilot', appId: '1:1:web:1', authDomain: 'localhost' };
const EM = { firestore: process.env.FIRESTORE_EMULATOR_HOST, auth: process.env.FIREBASE_AUTH_EMULATOR_HOST ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}` : '' };
const email = `t${Date.now()}@example.com`;
let n = 0;
const store = () => new FirestoreStore({ firebaseConfig: FB, emulator: EM, appName: `t${++n}` });

test('emulator: lease race, rules (other uid, server time), expiry take-over', { skip: !ON && 'FIRESTORE_EMULATOR_HOST not set', timeout: 60000 }, async () => {
  require('firebase/firestore').setLogLevel('silent');
  const a = store(), b = store(), x = store();
  const u = await a.auth.signUp(email, 'secret123');
  await b.auth.signIn(email, 'secret123');
  await x.auth.signUp('x' + email, 'secret123');
  const root = `users/${u.uid}`;
  const la = new LeaseManager({ store: a, root, pcId: 'pcA', pcName: 'PC-A', ttlSec: 10, renewMs: 60000 });
  const lb = new LeaseManager({ store: b, root, pcId: 'pcB', pcName: 'PC-B', ttlSec: 10, renewMs: 60000 });
  await la.syncClock(); await lb.syncClock();
  for (let i = 0; i < 5; i++) {
    const [ra, rb] = await Promise.all([la.claim(`video_${i}`), lb.claim(`video_${i}`)]);
    assert.strictEqual(+ra.ok + +rb.ok, 1, `race ${i}`);
  }
  // B pretends its clock is 10 min ahead: the server rule (request.time) still refuses the take-over
  const held = la.holds('video_0') ? lb : la;
  held.offsetMs += 600000;
  const steal = await held.claim('video_0');
  assert.strictEqual(steal.ok, false); assert.ok(steal.denied, 'denied by rules');
  held.offsetMs -= 600000;
  // another account can't read my leases
  await assert.rejects(x.get(`${root}/leases/video_0`), e => e.code === 'permission-denied');
  // a lease without a server timestamp is refused
  await assert.rejects(a.set(`${root}/leases/bad`, { pcId: 'p', pcName: 'P', renewedAt: 1, ttlSec: 10, released: false }), e => e.code === 'permission-denied');
  // real expiry (ttl 10 s) -> take-over allowed by the rules
  const owner = la.holds('video_1') ? la : lb, other = owner === la ? lb : la;
  for (const h of owner.held.values()) clearInterval(h.timer);
  await new Promise(r => setTimeout(r, 11500));
  const t = await other.claim('video_1');
  assert.ok(t.ok && t.takeover, JSON.stringify(t));
  await la.stop({ release: false }); await lb.stop({ release: false });
  for (const s of [a, b, x]) await s.close();
});

test('emulator: two PCs with the real SDK sync channels/videos and never upload the same job twice', { skip: !ON && 'FIRESTORE_EMULATOR_HOST not set', timeout: 90000 }, async () => {
  const uploads = [];
  const mk = async (name, create) => {
    const app = new UploadPilotApp({
      dataDir: tmpDir(`em-${name}-`), startApi: false, launcher: fakeLauncher(), proxyChecker: async () => ({ ok: true, ip: '1.2.3.4' }),
      settings: { autopilotPaused: true, uploadWindow: { start: '00:00', end: '24:00' }, geminiLowRes: { enabled: false }, cloud: { mode: 'auto', firebaseConfig: JSON.stringify(FB), emulator: EM, pcName: name, takeoverGraceMin: 0, singleActivePc: false, verifyAfterRestore: false, backup: { enabled: false, idleHours: { start: '00:00', end: '00:00' } } } },
      engineOpts: { speed: 0, uploadImpl: async (p, job, { video }) => { uploads.push({ pc: name, id: video.cloud_id }); await new Promise(r => setTimeout(r, 300)); return { url: 'https://youtu.be/x' }; } },
      cloud: { leaseOpts: { renewMs: 2000 }, syncOpts: { pushMs: 300, activityFlushMs: 1000 } },
    });
    await app.start({ api: false }); await app.cloudReady;
    await app.cloud.signIn('pc' + email, 'secret123', { create });
    return app;
  };
  const A = await mk('PC-A', true), B = await mk('PC-B', false);
  const { chId } = seedChannel(A, { name: 'EmuChan', files: ['e1.mp4', 'e2.mp4'] });
  await A.cloud.sync.pushNow();
  const bCh = await waitFor(() => B.db.get(`SELECT * FROM channels WHERE name='EmuChan'`), { timeout: 15000, what: 'channel on B' });
  await waitFor(() => B.db.all('SELECT id FROM videos WHERE channel_id=?', bCh.id).length === 2, { timeout: 15000, what: 'videos on B' });
  await waitFor(() => B.db.get('SELECT profile_id FROM channels WHERE id=?', bCh.id).profile_id, { timeout: 15000, what: 'profile on B' });
  // pretend B has the Drive copy so it also wants the jobs; both run the channel at once
  B.db.run(`UPDATE videos SET drive_file_id='fake' WHERE channel_id=?`, bCh.id);
  B.cloud.fetchForTakeover = async v => { const p = require('path').join(B.dataDir, 'cache', v.cloud_id); require('fs').mkdirSync(require('path').dirname(p), { recursive: true }); require('fs').writeFileSync(p, 'x'); return p; };
  await Promise.all([A.runner.run(chId, 0), B.runner.run(bCh.id, 0)]);
  const ids = uploads.map(u => u.id);
  assert.strictEqual(new Set(ids).size, ids.length, `a video was uploaded twice: ${JSON.stringify(uploads)}`);
  assert.strictEqual(ids.length, 2);
  await A.cloud.sync.pushNow(); await B.cloud.sync.pushNow();
  await waitFor(() => B.db.all(`SELECT status FROM videos WHERE channel_id=?`, bCh.id).every(v => v.status === 'done'), { timeout: 15000, what: 'done on B' })
    .catch(e => { console.log('DBG', uploads, A.cloud.sync.lastPushError, B.cloud.sync.lastPushError, A.db.all('SELECT status,dirty FROM videos'), B.db.all('SELECT status,dirty FROM videos'), A.events.recent(15).map(x => x.message)); throw e; });
  await waitFor(() => A.db.all(`SELECT status FROM videos WHERE channel_id=?`, chId).every(v => v.status === 'done'), { timeout: 15000, what: 'done on A' });
  const q = A.cloud.status().quota;
  assert.ok(q.writes < 100, `writes ${q.writes}`);
  await A.stop(); await B.stop();
});

test('emulator v0.3.1: meta/activePc rule (pcId + server time), account key, restart signs in again with no password', { skip: !ON && 'FIRESTORE_EMULATOR_HOST not set', timeout: 90000 }, async () => {
  const a = store();
  const u = await a.auth.signUp('ap' + email, 'secret123');
  const root = `users/${u.uid}`;
  // the activePc doc must carry pcId and the server time
  await assert.rejects(a.set(`${root}/meta/activePc`, { pcId: 'x', pcName: 'X', renewedAt: Date.now() }), e => e.code === 'permission-denied');
  await assert.rejects(a.set(`${root}/meta/activePc`, { pcName: 'X', renewedAt: a.SERVER_TS }), e => e.code === 'permission-denied');
  await a.set(`${root}/meta/activePc`, { pcId: 'x', pcName: 'X', since: a.SERVER_TS, renewedAt: a.SERVER_TS, handedOver: false });
  await a.set(`${root}/meta/settings`, { enc: 'abc', updatedBy: 'x' });   // other meta docs: owner only
  await a.close();
  // a full app: create account, then restart from the same data folder: online, key unlocked, active
  const dataDir = tmpDir('em-restart-');
  const first = { autopilotPaused: true, keepAlive: { enabled: false }, cloud: { mode: 'auto', firebaseConfig: JSON.stringify(FB), emulator: EM, pcName: 'PC-R', verifyAfterRestore: false } };
  const mk = isFirst => new UploadPilotApp({ dataDir, startApi: false, launcher: fakeLauncher(), ...(isFirst ? { settings: first } : {}), cloud: { activeOpts: { heartbeatMs: 1000, staleMs: 4000 } } });
  const A = mk(true); await A.start({ api: false }); await A.cloudReady;
  await A.cloud.signIn('restart' + email, 'secret123', { create: true });
  assert.ok(A.cloud.keys.ready); assert.ok(A.cloud.activePc.isActive);
  await A.updateSettings({ geminiKeys: 'AIza-em-key' });
  await A.cloud.account.pushIfChanged();
  await A.stop();
  const B = mk(false); await B.start({ api: false }); const st = await B.cloudReady;   // a restart: no settings passed in, like the real app
  assert.strictEqual(st.state, 'online', 'signed in again from the saved session');
  assert.ok(st.keys.ready, 'account key from safeStorage, no password asked');
  assert.ok(B.cloud.activePc.isActive, 'same PC: active again at once');
  assert.deepStrictEqual(B.settings.get('geminiKeys'), ['AIza-em-key']);
  await B.stop();
});

test('emulator (v0.3.2 rules): only the active PC may change a profile\'s saved login (stateVersion); other fields still sync', { skip: !ON && 'FIRESTORE_EMULATOR_HOST not set', timeout: 30000 }, async () => {
  const a = store();
  const u = await a.auth.signUp('login' + email, 'secret123');
  const root = `users/${u.uid}`;
  const P = `${root}/profiles/p1`;
  const stamp = by => ({ updatedAt: a.SERVER_TS, updatedBy: by });
  // no active-PC doc yet (offline / 0.3.0 accounts): allowed
  await a.set(P, { number: 1, name: 'One', stateVersion: 1, ...stamp('pcA') });
  await a.set(`${root}/meta/activePc`, { pcId: 'pcR', pcName: 'RDP', since: a.SERVER_TS, renewedAt: a.SERVER_TS, handedOver: false });
  // DESKTOP (not active) tries to write login v2: denied
  await assert.rejects(a.set(P, { stateVersion: 2, stateFileId: 'f2', ...stamp('pcD') }, { merge: true }), e => e.code === 'permission-denied');
  // ...but may still sync a name change (stateVersion unchanged)
  await a.set(P, { name: 'Renamed', ...stamp('pcD') }, { merge: true });
  // the active PC may write the login
  await a.set(P, { stateVersion: 2, stateFileId: 'f2', ...stamp('pcR') }, { merge: true });
  // after it handed over, not even the old active PC may
  await a.set(`${root}/meta/activePc`, { pcId: 'pcR', pcName: 'RDP', renewedAt: a.SERVER_TS, handedOver: true }, { merge: true });
  await assert.rejects(a.set(P, { stateVersion: 3, ...stamp('pcR') }, { merge: true }), e => e.code === 'permission-denied');
  const d = await a.get(P);
  assert.strictEqual(d.stateVersion, 2); assert.strictEqual(d.name, 'Renamed');
  await a.close();
});
