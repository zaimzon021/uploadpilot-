'use strict';
// v0.3.1 "everything follows the account": password-wrapped data key, change / forgot password,
// legacy passphrase migration, a new PC that only signs in gets settings, Gemini keys, proxies,
// Drive and the Google logins.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../src/cloud/crypto');
const { MemoryServer, MemoryStore } = require('../../src/cloud/store/memoryStore');
const { KeyManager } = require('../../src/cloud/keys');
const { SecretStore } = require('../../src/cloud/secretStore');
const { startMockDrive } = require('../helpers/mockDrive');
const { makePc, seedChannel, settle, waitFor, profileStates } = require('../helpers/cloudPcs');
const { tmpDir } = require('../helpers/env');
const path = require('path');

test('data key: wrap / unwrap with the account password; wrong password refused; blobs need the key', () => {
  const key = C.newDataKey();
  const w = C.wrapKey(key, 'correct horse');
  assert.ok(C.unwrapKey(w, 'correct horse').equals(key));
  assert.throws(() => C.unwrapKey(w, 'wrong'), e => e.code === 'BAD_PASSWORD');
  assert.ok(!Buffer.from(w, 'base64').includes(key), 'key not stored in clear');
  const blob = C.encryptWithKey(Buffer.from('{"cookies":[]}'), key);
  assert.strictEqual(C.decryptWithKey(blob, key).toString(), '{"cookies":[]}');
  assert.throws(() => C.decryptWithKey(blob, C.newDataKey()), e => e.code === 'BAD_KEY');
  const t = Buffer.from(blob); t[t.length - 1] ^= 1;
  assert.throws(() => C.decryptWithKey(t, key), e => e.code === 'BAD_KEY');
});

async function twoKeyPcs() {
  const server = new MemoryServer();
  const sa = new MemoryStore(server, { name: 'a' }), sb = new MemoryStore(server, { name: 'b' });
  const u = await sa.auth.signUp('k@example.com', 'first-pass'); await sb.auth.signIn('k@example.com', 'first-pass');
  const mk = (store, name) => new KeyManager({ store, root: () => `users/${u.uid}`, uid: () => u.uid, secrets: new SecretStore(path.join(tmpDir('ks-'), 's.json')), pcId: name, pcName: name });
  return { server, sa, sb, u, A: mk(sa, 'PC-A'), B: mk(sb, 'PC-B'), mk };
}

test('key manager: first PC creates the key, second unlocks it with the password, cached across restarts; change password keeps old data readable', async () => {
  const { sa, sb, A, B, mk, u, server } = await twoKeyPcs();
  assert.deepStrictEqual(await A.unlock('first-pass'), { ok: true, created: true });
  const enc = A.encString('proxy-password-1');
  const blob = A.encJson({ cookies: [{ name: 'SID', value: 'v' }] });
  assert.deepStrictEqual(await B.unlock('first-pass'), { ok: true });
  assert.strictEqual(B.decString(enc), 'proxy-password-1');
  // restart: the key comes from safeStorage, no password
  const A2 = new KeyManager({ store: sa, root: () => `users/${u.uid}`, uid: () => u.uid, secrets: A.secrets, pcId: 'PC-A', pcName: 'PC-A' });
  assert.ok(A2.loadCached()); assert.strictEqual((await A2.unlock(null)).ok, true);
  // change password (Firebase + re-wrap): the SAME key, so everything stays readable
  await sa.auth.changePassword('first-pass', 'second-pass');
  await A.rewrap('second-pass');
  const C2 = mk(new MemoryStore(server, { name: 'c' }), 'PC-C');
  await C2.store.auth.signIn('k@example.com', 'second-pass');
  assert.strictEqual((await C2.unlock('first-pass')).reason, 'password_mismatch', 'old password no longer unwraps');
  assert.strictEqual((await C2.unlock('second-pass')).ok, true);
  assert.deepStrictEqual(C2.decJson(blob).cookies[0].name, 'SID');
  assert.strictEqual(C2.decString(enc), 'proxy-password-1');
  void sb;
});

test('forgot password: the new password cannot unwrap; another signed-in PC hands the key over (x25519) and the new PC re-wraps it; or start fresh', async () => {
  const { server, A, mk } = await twoKeyPcs();
  await A.unlock('first-pass');
  const secretBlob = A.encString('gemini-key-xyz');
  // reset by e-mail: Firebase now has a new password the wrap does not know
  const sc = new MemoryStore(server, { name: 'c' });
  server.users.get('k@example.com').password = 'after-reset';
  await sc.auth.signIn('k@example.com', 'after-reset');
  const N = mk(sc, 'PC-New');
  assert.strictEqual((await N.unlock('after-reset')).reason, 'password_mismatch');
  await N.requestFromOtherPc();
  const req = await sc.get(N.reqPath);
  assert.strictEqual(req.state, 'open'); assert.ok(!JSON.stringify(req).includes(A.key.toString('base64')));
  await A.onRequestDoc(req);                                   // PC-A (still signed in) answers
  const ans = await sc.get(N.reqPath);
  assert.strictEqual(ans.state, 'answered');
  assert.strictEqual(await N.onRequestDoc(ans), true);
  assert.strictEqual(N.decString(secretBlob), 'gemini-key-xyz');
  // re-wrapped with the new password: a fourth PC signs in with it only
  const sd = new MemoryStore(server, { name: 'd' }); await sd.auth.signIn('k@example.com', 'after-reset');
  const D = mk(sd, 'PC-D');
  assert.strictEqual((await D.unlock('after-reset')).ok, true);
  // no PC left to help: start fresh (old blobs unreadable, the app says so)
  const se = new MemoryStore(server, { name: 'e' }); await se.auth.signIn('k@example.com', 'after-reset');
  const E = mk(se, 'PC-E');
  await E.startFresh('after-reset');
  assert.throws(() => E.decString(secretBlob), e => e.code === 'BAD_KEY');
  D.onKeysDoc(await sc.get(D.path));
  assert.strictEqual(D.state, 'locked', 'other PCs notice the replaced key');
});

test('0.3.0 migration: data sealed with the old sync passphrase stays readable after entering it once (or automatically when the PC still has it)', async () => {
  const { sa, A, B, u } = await twoKeyPcs();
  await sa.set(`users/${u.uid}/meta/sync`, { verifier: C.makeVerifier('old-sync-pass') });
  const legacyBlob = C.encryptJson({ cookies: [{ name: 'SID', value: 'legacy' }] }, 'old-sync-pass');
  await A.unlock('first-pass');
  assert.strictEqual(await A.legacyNeeded(), true);
  assert.throws(() => A.decJson(legacyBlob), e => e.code === 'LEGACY_PASSPHRASE');
  await assert.rejects(A.migrateLegacy('nope'), /not the old/);
  await A.migrateLegacy('old-sync-pass');
  assert.strictEqual(A.decJson(legacyBlob).cookies[0].value, 'legacy');
  await B.unlock('first-pass');                                   // another PC gets the passphrase from the account
  assert.strictEqual(B.decJson(legacyBlob).cookies[0].value, 'legacy');
  assert.strictEqual(await B.legacyNeeded(), false);
});

test('a new PC that only signs in gets everything: settings, Gemini keys, proxy pool with passwords, Drive (no reconnect, no secret paste), Google logins', async () => {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const A = await makePc(server, drive, 'DESKTOP-MDM36KB', { create: true, singleActive: true });
  // PC-A: the user configures things once
  await A.app.updateSettings({ geminiKeys: 'AIzaKEY-one\nAIzaKEY-two', uploadWindow: { start: '08:30', end: '22:00' }, videosPerDay: 3, proxyPool: '198.51.100.20:1080:puser:pp@ss1\n198.51.100.21:1080:quser:qq@ss2', lanes: 5 });
  A.app.cloud.setClientSecret('GOCSPX-shared-secret');
  const { profileId } = seedChannel(A.app, { name: 'Purrfect Giggles', files: ['g1.mp4'] });
  await settle([A.app]);
  await A.app.cloud.account.pushIfChanged();
  // the Google login inside profile #1 on PC-A
  const pa = A.app.db.get('SELECT * FROM profiles WHERE id=?', profileId);
  await A.app.profiles.open(profileId, { purpose: 'manual' });
  profileStates.set(pa.data_dir, { cookies: [
    { name: 'SID', value: 'sid-1', domain: '.google.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
    { name: '__Secure-3PSID', value: 's3', domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' },
    { name: 'LOGIN_INFO', value: 'li', domain: '.youtube.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' },
    { name: '__Host-GAPS', value: 'h', domain: 'accounts.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
  ], origins: [{ origin: 'https://www.youtube.com', localStorage: [{ name: 'yt-remote', value: '1' }] }] });
  await A.app.profiles.close(profileId);
  assert.strictEqual(A.app.db.get('SELECT state_version FROM profiles WHERE id=?', profileId).state_version, 1);
  // A hands over cleanly when B asks, so let it go to sleep: stop its heartbeat (dead PC)
  A.app.cloud.activePc.stop();
  await new Promise(r => setTimeout(r, 1700));
  // PC "RDP": install + sign in. Nothing else.
  const B = await makePc(server, drive, 'RDP', { singleActive: true, driveConnected: false });
  const s = B.app.settings.all();
  assert.deepStrictEqual(s.geminiKeys, ['AIzaKEY-one', 'AIzaKEY-two']);
  assert.deepStrictEqual(s.uploadWindow, { start: '08:30', end: '22:00' }); assert.strictEqual(s.videosPerDay, 3);
  assert.notStrictEqual(s.lanes, 5, 'lanes stay per PC');
  assert.strictEqual(B.app.cloud.pcName, 'RDP');
  const px = B.app.db.all('SELECT host, username, password FROM proxies ORDER BY host');
  assert.ok(px.find(p => p.host === '198.51.100.21' && p.password === 'qq@ss2'), JSON.stringify(px));
  assert.ok(B.app.cloud.googleAuth().connected, 'Drive connected from the account');
  assert.strictEqual(B.app.cloud.config().google.clientSecret, 'GOCSPX-shared-secret');
  assert.ok(!JSON.stringify([...server.docs.values()].map(d => d.data)).includes('qq@ss2'), 'proxy passwords never in clear in Firestore');
  assert.ok(!JSON.stringify([...server.docs.values()].map(d => d.data)).includes(drive.tokens.refresh), 'Drive token never in clear');
  // B is active (A was dead) and opens the profile: the login is restored before any page loads
  assert.strictEqual(B.app.cloud.activePc.isActive, true);
  const bProf = await waitFor(() => B.app.db.get('SELECT * FROM profiles WHERE number=1'), { what: 'profile on B' });
  await B.app.profiles.open(bProf.id, { purpose: 'manual', startUrl: 'https://studio.youtube.com' });
  const st = profileStates.get(bProf.data_dir);
  assert.deepStrictEqual(st.cookies.map(c => c.name).sort(), ['LOGIN_INFO', 'SID', '__Host-GAPS', '__Secure-3PSID']);
  const ops = B.calls.filter(c => c.dir === bProf.data_dir).map(c => c.op);
  assert.ok(ops.indexOf('addCookies') < ops.indexOf('goto'), ops.join(','));
  assert.match(B.app.events.recent(30).map(e => e.message).join('\n'), /login restored from cloud \(v1, 4 cookies/);
  await B.app.profiles.close(bProf.id);
  await A.app.stop(); await B.app.stop(); await drive.close();
});

test('Drive revoked on one PC: every PC drops it and shows one "Connect Google Drive" item', async () => {
  const server = new MemoryServer();
  const drive = await startMockDrive();
  const A = await makePc(server, drive, 'PC-A', { create: true });
  const B = await makePc(server, drive, 'PC-B', { driveConnected: false });
  assert.ok(B.app.cloud.googleAuth().connected);
  await A.app.cloud.disconnectDrive();
  await waitFor(() => !B.app.cloud.googleAuth().connected, { what: 'drive dropped on B', timeout: 3000 });
  const items = B.app.needsYou().filter(i => i.id === 'drive');
  assert.strictEqual(items.length, 1); assert.strictEqual(items[0].actions[0].action, 'drive');
  await A.app.stop(); await B.app.stop(); await drive.close();
});
