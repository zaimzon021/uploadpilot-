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
  aiLookaheadDays: 0,                       // 0 = Gemini writes metadata for today's videos only; 1 = also tomorrow's (handy in approval mode)
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
  schedulerTickMs: 30000,
  allowNoProxy: false,                      // link channels without a proxy (not recommended)
  autopilotPaused: false,                   // global pause switch
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
    return { ...s, geminiKeys: s.geminiKeys.map(k => k.slice(0, 6) + '…' + k.slice(-4)), geminiKeyCount: s.geminiKeys.length };
  }
}

module.exports = { Settings, DEFAULTS, deepMerge };
