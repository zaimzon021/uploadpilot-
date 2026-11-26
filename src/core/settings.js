'use strict';
// Settings live in the `settings` table as JSON values. Defaults below.
const DEFAULTS = {
  videosPerDay: 2,
  uploadWindow: { start: '09:00', end: '23:00' },
  lanes: 3,
  delayRangeMin: { min: 1, max: 7 },        // minutes between channels in a lane
  minGapMinutes: 45,                        // minimum gap between two planned uploads of the same channel
  geminiKeys: [],
  geminiModel: 'gemini-3.5-flash-lite',
  geminiBaseUrl: 'https://generativelanguage.googleapis.com',
  geminiMaxAttempts: 4,
  aiLookaheadDays: 0,                       // only used when aiWriteAhead is false (0.3.0 behaviour: today's videos only)
  aiWriteAhead: true,                       // 0.3.1: Gemini writes metadata as soon as a video is found, earliest slot first
  aiMinGapMs: 4000,                         // rate limit: at least this long between two Gemini jobs starting
  aiInlineTimeoutMs: 5 * 60000,             // a due video without metadata waits this long for Gemini, then gets a clean title from its file name
  aiConcurrency: 2,
  aiTickMs: 20000,
  apiPort: 53300,
  apiToken: '',                             // optional; when set, every request must send X-UploadPilot-Token
  browser: {
    executablePath: '',                     // empty = auto-detect (Chrome on Windows, Playwright Chromium elsewhere)
    channel: '',                            // e.g. 'chrome' to let Playwright find installed Chrome
    launchMode: 'persistent',               // 'persistent' (launchPersistentContext) | 'cdp' (spawn + connectOverCDP)
    windowMode: 'minimized',                // autopilot windows: 'minimized' | 'offscreen' | 'normal'
    headless: false,
    extraArgs: [],
    blockMedia: false,                      // block images/video/fonts in autopilot browsers (saves bandwidth; off by default for Studio)
    snapshotEveryMin: 3,                    // manual/link windows: save the login to the cloud this often (only when it changed)
  },
  urls: {
    studio: 'https://studio.youtube.com',
    accounts: 'https://accounts.google.com',
    youtube: 'https://www.youtube.com',
  },
  loginCookieNames: ['SID', '__Secure-1PSID', '__Secure-3PSID', 'SAPISID'],
  proxyCheckUrl: 'https://api.ipify.org?format=json',
  proxyCheckTimeoutMs: 20000,
  upload: {
    stepTimeoutMs: 60000,                   // per state-machine step
    uploadCompleteTimeoutMs: 15 * 60000,    // waiting for the file transfer to finish
    channelHardLimitMs: 20 * 60000,         // hard cap per channel run
    maxRetries: 3,
    typing: { minDelay: 35, maxDelay: 160, humanChars: 350 },
    visibility: 'PUBLIC',                   // PUBLIC | UNLISTED | PRIVATE | SCHEDULE
    moveDoneFiles: true,
  },
  retry: { max: 3, backoffMin: [5, 15, 45], jitterPct: 20 },   // failed uploads: automatic retries, inside the upload window only
  keepAlive: { enabled: true, idleHours: 24, staySec: 20, tickMs: 10 * 60000 },   // daily youtube.com visit for unused profiles (fresh cookies)
  schedulerTickMs: 30000,
  allowNoProxy: false,                      // link channels without a proxy (not recommended)
  autopilotPaused: false,                   // global pause switch
  pauseWhenActive: { enabled: false, idleMinutes: 5 },   // don't START new jobs while the user is using the PC
  geminiLowRes: { enabled: true, height: 360, videoKbps: 300, ffmpegPath: '' },   // small copy for Gemini (ffmpeg)
  logRetentionDays: 14,
  cloud: {
    mode: 'auto',                           // 'auto' (sign in when a config exists) | 'cloud' | 'offline' (user picked "Use offline")
    singleActivePc: true,                   // 0.3.1: one active PC per account (hand-over between PCs)
    handedOverTo: '',                       // set after this PC handed over / lost the active role (stays quiet until signed in again)
    verifyAfterRestore: true,               // after a login restore, open youtube.com once and check the account is signed in
    firebaseConfig: '',                     // web app config JSON from the Firebase console (or config/cloud-config.json)
    googleClientId: '', googleClientSecret: '',   // OAuth Desktop client override; the secret itself is sealed in secrets.json (never stored here)
    pcId: '', pcName: '', lastEmail: '',
    emulator: { firestore: '', auth: '' },  // e.g. 127.0.0.1:8080 / http://127.0.0.1:9099 (development)
    backup: { enabled: false, idleHoursOnly: false, speedCapKBps: 0, speedCapPct: 30, measuredBps: 0, idleHours: { start: '01:00', end: '07:00' }, chunkMB: 8, deleteAfterUpload: true },   // v0.3.2: channels back up new videos right away (style.backupNew, default on) unless idleHoursOnly (Advanced)
    takeoverGraceMin: 120,                  // another PC may take over a backed-up video this long after its slot
    leaseTtlSec: 120, leaseRenewSec: 30,
    writeBudget: 18000,                     // soft daily cap: above it, activity/plan docs stop syncing (Spark: 20k writes/day)
    driveUsage: {},
  },
};

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object' || !base || !over) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

class Settings {
  constructor(db) { this.db = db; this._cache = null; }
  all() {
    if (this._cache) return this._cache;
    let s = JSON.parse(JSON.stringify(DEFAULTS));
    for (const row of this.db.all('SELECT key, value FROM settings')) {
      try { s[row.key] = deepMerge(DEFAULTS[row.key], JSON.parse(row.value)); } catch (_) { /* skip */ }
    }
    this._cache = s;
    return s;
  }
  get(key) { return this.all()[key]; }
  set(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS)) continue;
      this.db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(v));
    }
    this._cache = null;
    return this.all();
  }
  // Public view: hide secrets
  publicView() {
    const s = this.all();
    const cloud = { ...s.cloud, googleClientSecret: '' };
    return { ...s, cloud, geminiKeys: s.geminiKeys.map(k => k.slice(0, 6) + '…' + k.slice(-4)), geminiKeyCount: s.geminiKeys.length };
  }
}

module.exports = { Settings, DEFAULTS, deepMerge };
