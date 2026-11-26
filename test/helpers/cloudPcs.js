'use strict';
// Simulated PCs for cloud tests: full UploadPilotApp instances sharing one MemoryServer (the
// "Firestore project") and one mock Google Drive, with a fake browser launcher whose persistent
// profiles keep a storageState per user-data-dir, and a fake YouTube upload (engineOpts.uploadImpl).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { UploadPilotApp } = require('../../src/core/app');
const { MemoryStore } = require('../../src/cloud/store/memoryStore');
const { tmpDir, waitFor } = require('./env');

const FAKE_FB = { apiKey: 'fake-api-key', projectId: 'demo-uploadpilot', appId: '1:1:web:1', authDomain: 'demo.firebaseapp.com' };
const profileStates = new Map();   // userDataDir -> storageState (what the "browser" keeps on disk)

function fakeLauncher(calls = []) {
  return async ({ userDataDir }) => {
    const ctx = new EventEmitter();
    let closed = false;
    const page = { isClosed: () => closed, url: () => 'about:blank', goto: async u => { calls.push({ op: 'goto', dir: userDataDir, url: u }); }, screenshot: async () => {}, close: async () => {}, context: () => ctx };
    ctx.pages = () => [page]; ctx.newPage = async () => page;
    ctx.storageState = async () => JSON.parse(JSON.stringify(profileStates.get(userDataDir) || { cookies: [], origins: [] }));
    ctx.setStorageState = async s => { calls.push({ op: 'setStorageState', dir: userDataDir }); profileStates.set(userDataDir, JSON.parse(JSON.stringify(s))); };
    ctx.addCookies = async list => {
      calls.push({ op: 'addCookies', dir: userDataDir, n: list.length });
      const st = profileStates.get(userDataDir) || { cookies: [], origins: [] };
      for (const c of list) {
        const domain = c.domain || new URL(c.url).hostname;
        st.cookies = st.cookies.filter(x => !(x.name === c.name && x.domain === domain));
        st.cookies.push({ name: c.name, value: c.value, domain, path: c.path || '/', expires: c.expires ?? -1, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax' });
      }
      profileStates.set(userDataDir, st);
    };
    ctx.clearCookies = async () => { const st = profileStates.get(userDataDir); if (st) st.cookies = []; };
    ctx.route = async () => {};
    ctx.cookies = async () => (profileStates.get(userDataDir) || { cookies: [] }).cookies;
    ctx.close = async () => { closed = true; ctx.emit('close'); };
    calls.push({ op: 'launch', dir: userDataDir });
    return { context: ctx, cdpEndpoint: null, debugPort: 0, isClosed: () => closed, close: async () => { if (!closed) { closed = true; ctx.emit('close'); } } };
  };
}

/**
 * @returns {Promise<{app, name, uploads, calls}>}
 */
async function makePc(server, drive, name, { email = 'owner@example.com', password = 'secret-pass', create = false, settings = {}, uploadMs = 50, uploads = [], driveConnected = true, singleActive = false, dataDir = null, activeOpts = {}, signIn = true } = {}) {
  const calls = [];
  const app = new UploadPilotApp({
    dataDir: dataDir || tmpDir(`pc-${name}-`), startApi: false, launcher: fakeLauncher(calls),
    proxyChecker: async () => ({ ok: true, ip: '198.51.100.7', ms: 5 }),
    settings: {
      autopilotPaused: true, uploadWindow: { start: '00:00', end: '24:00' }, geminiLowRes: { enabled: false },
      cloud: { mode: 'auto', firebaseConfig: JSON.stringify(FAKE_FB), pcName: name, backup: { enabled: false, idleHours: { start: '00:00', end: '00:00' }, speedCapKBps: 0, speedCapPct: 30, chunkMB: 1, deleteAfterUpload: true }, takeoverGraceMin: 120, leaseTtlSec: 120, leaseRenewSec: 30, writeBudget: 18000, singleActivePc: singleActive, verifyAfterRestore: false },
      keepAlive: { enabled: false },
      ...settings,
    },
    engineOpts: {
      speed: 0,
      uploadImpl: async (page, job, { video }) => {
        uploads.push({ pc: name, videoId: video.cloud_id, file: job.file, size: fs.statSync(job.file).size, title: job.title, at: Date.now() });
        await new Promise(r => setTimeout(r, uploadMs));
        return { url: `https://youtu.be/${video.cloud_id.slice(0, 11)}` };
      },
    },
    cloud: {
      storeFactory: () => new MemoryStore(server, { name }),
      driveBaseUrl: drive && drive.base, googleEndpoints: drive && drive.endpoints,
      leaseOpts: { renewMs: 100 }, syncOpts: { pushMs: 80, activityFlushMs: 150 }, backupOpts: { tickMs: 3600e3 },
      activeOpts: { heartbeatMs: 150, staleMs: 1500, handoverTimeoutMs: 6000, handoverWaitMs: 3000, backupBudgetMs: 5000, ...activeOpts },
    },
  });
  await app.start({ api: false });
  await app.cloudReady;
  if (signIn) await app.cloud.signIn(email, password, { create });
  if (signIn && driveConnected && drive && !app.cloud.googleAuth().connected) { app.cloud.secrets.set('googleDrive', { refresh_token: drive.tokens.refresh, email: 'tester@example.com' }); app.cloud._gauth = null; if (app.cloud.account) await app.cloud.account.publishDrive(); }
  return { app, name, uploads, calls, dataDir: app.dataDir };
}

/** A linked channel on this PC: proxy + profile + channel + folder with video files. */
function seedChannel(app, { name = 'Alpha', files = ['a1.mp4', 'a2.mp4'], proxy = '203.0.113.9:1080:puser:p@ss-w0rd' } = {}) {
  const folder = tmpDir('chf-');
  for (const f of files) fs.writeFileSync(path.join(folder, f), Buffer.alloc(200 * 1024, f.length));
  const prof = app.profiles.createProfile({ name, proxy, autoProxy: false });
  const chId = app.db.run(`INSERT INTO channels(profile_id,name,handle,folder,status,style,created_at) VALUES(?,?,?,?,?,?,?)`, prof.id, name, '@' + name.toLowerCase(), folder, 'active', JSON.stringify({ niche: 'tests', perDay: 5 }), Date.now()).lastInsertRowid;
  app.ingest(chId);
  // titles so videos are uploadable, due now
  app.db.run(`UPDATE videos SET title='T-'||filename, status='ready', ai_status='manual', scheduled_at=? WHERE channel_id=?`, Date.now() - 60000, chId);
  return { chId, profileId: prof.id, folder };
}

const settle = async (apps, ms = 400) => { for (const a of apps) if (a.cloud.sync) await a.cloud.sync.pushNow().catch(() => {}); await new Promise(r => setTimeout(r, ms)); };

module.exports = { makePc, seedChannel, fakeLauncher, settle, FAKE_FB, profileStates, waitFor };
