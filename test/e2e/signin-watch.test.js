'use strict';
// v0.3.2 in real Chromium: a profile window flagged "Sign in needed" notices the Google / YouTube
// sign-in by itself (cookies + navigation), and the Needs-you "Check sign-in" button runs a real
// headless check. No real Google: cookies are set on .google.com / .youtube.com the way a sign-in
// leaves them, and "youtube.com" is a local page.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { UploadPilotApp } = require('../../src/core/app');
const { tmpDir, makeVideos, headless, waitFor } = require('../helpers/env');

const far = Math.floor(Date.now() / 1000) + 30 * 86400;
const SIGNED_IN = [
  { name: 'SID', value: 'g-sid', domain: '.google.com', path: '/', expires: far, httpOnly: true, secure: true, sameSite: 'Lax' },
  { name: '__Secure-1PSID', value: 'g-1p', domain: '.google.com', path: '/', expires: far, httpOnly: true, secure: true, sameSite: 'Lax' },
  { name: 'LOGIN_INFO', value: 'yt', domain: '.youtube.com', path: '/', expires: far, httpOnly: true, secure: true, sameSite: 'None' },
];
let app, web, base, chId, profileId;

test.before(async () => {
  web = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end('<!doctype html><title>YouTube (local)</title><h1>home</h1>'); });
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${web.address().port}`;
  app = new UploadPilotApp({ dataDir: tmpDir('siw-'), startApi: false, signInWatchMs: 500,
    settings: { autopilotPaused: true, geminiKeys: [], cloud: { mode: 'offline' }, keepAlive: { enabled: false }, browser: { headless, windowMode: 'normal' }, urls: { youtube: `${base}/youtube`, studio: `${base}/studio`, accounts: `${base}/accounts` } } });
  await app.start({ api: false });
  const prof = app.profiles.createProfile({ name: 'Purrfect Giggles', autoProxy: false });
  profileId = prof.id;
  const folder = tmpDir('siw-v-');
  makeVideos(folder, ['baby.mp4']);
  chId = app.db.run(`INSERT INTO channels(profile_id,name,folder,status,status_reason,style,created_at) VALUES(?,?,?,?,?,?,?)`, prof.id, 'Purrfect Giggles', folder, 'active', null, '{}', Date.now()).lastInsertRowid;
  app.ingest(chId);
});
test.after(async () => { await app.stop(); web.close(); });

test('real Chromium: a sign-in in the open window is noticed within seconds; Needs you clears; "signed in ✓"', async () => {
  app.db.run(`UPDATE profiles SET login_state='signed_out', login_note='Sign in needed' WHERE id=?`, profileId);
  assert.ok(app.needsYou().some(i => i.id === `login${chId}`));
  const sess = await app.profiles.open(profileId, { purpose: 'manual', startUrl: `${base}/studio`, skipProxyCheck: true });
  assert.ok(sess.watch, 'watching the window');
  await new Promise(r => setTimeout(r, 800));
  assert.ok(app.loginFlagged(profileId), 'no sign-in yet');
  // what Google leaves after a sign-in, then the user lands on a page
  await sess.handle.context.addCookies(SIGNED_IN);
  await sess.handle.context.pages()[0].goto(`${base}/after-login`);
  await waitFor(() => !app.loginFlagged(profileId), { what: 'sign-in noticed', timeout: 8000 });
  assert.ok(!app.needsYou().some(i => i.id === `login${chId}`));
  assert.match(app.events.recent(30).map(e => e.message).join('\n'), /Purrfect Giggles: signed in ✓/);
  await app.profiles.close(profileId);
});

test('real Chromium: "Check sign-in" runs a headless check of the closed profile', async () => {
  app.db.run(`UPDATE profiles SET login_state='signed_out' WHERE id=?`, profileId);
  const r = await app.checkSignIn(chId);
  assert.deepStrictEqual(r, { signedIn: true, how: 'headless check' }, 'cookies kept in the profile folder');
  assert.strictEqual(app.loginFlagged(profileId), false);
  assert.strictEqual(app.profiles.isOpen(profileId), false, 'closed again');
  // signed out (cookies gone) -> stays flagged
  const s2 = await app.profiles.open(profileId, { purpose: 'manual', skipProxyCheck: true });
  await s2.handle.context.clearCookies();
  await app.profiles.close(profileId);
  app.db.run(`UPDATE profiles SET login_state='signed_out' WHERE id=?`, profileId);
  assert.deepStrictEqual(await app.checkSignIn(chId), { signedIn: false, how: 'headless check' });
  assert.ok(app.loginFlagged(profileId));
});
