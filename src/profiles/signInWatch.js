'use strict';
// v0.3.2: notice a Google / YouTube sign-in while a profile window is open.
//
// Before 0.3.2 a profile flagged "Sign in needed" only became OK again when its login was exported
// AND that export was accepted (often refused: "the cloud has a newer login"), so a fresh sign-in by
// hand was never noticed. This watcher looks at the window itself:
//   * every navigation of a tab (cheap URL test: studio.youtube.com loaded without a bounce to
//     accounts.google.com counts as signed in when the Google cookie is there),
//   * a cookie check every ~10 s: SID / __Secure-1PSID on .google.com AND a signed-in .youtube.com
//     (LOGIN_INFO / SID / __Secure-1PSID / __Secure-3PSID / SAPISID on youtube.com),
//   * when a tab closes (the context is still alive: cookies readable) and when the window closes
//     (the cookies seen last are judged).
// onSignedIn(reason) fires on every check that finds a sign-in while flagged() is true; the handler
// clears the flag, so in practice it runs once per sign-in.
const ACCOUNTS = /(^|\.)accounts\.google\.|\/ServiceLogin|\/signin\b|\/v3\/signin/i;
const STUDIO = /^https:\/\/studio\.youtube\.com\//i;
const GOOGLE_SID = new Set(['SID', '__Secure-1PSID']);
const YT_AUTH = new Set(['LOGIN_INFO', 'SID', '__Secure-1PSID', '__Secure-3PSID', 'SAPISID', '__Secure-3PAPISID']);
const dom = c => String(c.domain || '').replace(/^\./, '').toLowerCase();
const alive = (c, now) => !(c.expires > 0) || c.expires > now;

/** Signed in = Google session cookie + (YouTube auth cookie or Studio loaded without a sign-in redirect). */
function judgeSignedIn(cookies, { studioLoaded = false, now = Date.now() / 1000 } = {}) {
  const list = (cookies || []).filter(c => alive(c, now));
  const google = list.some(c => /(^|\.)google\.[a-z.]+$/.test(dom(c)) && GOOGLE_SID.has(c.name));
  const youtube = list.some(c => /(^|\.)youtube\.com$/.test(dom(c)) && YT_AUTH.has(c.name));
  return { signedIn: google && (youtube || !!studioLoaded), google, youtube, studioLoaded: !!studioLoaded };
}

class SignInWatch {
  /**
   * @param {object} o
   * @param {object} o.context              Playwright BrowserContext
   * @param {() => boolean} o.flagged        is the profile/channel currently waiting for a sign-in?
   * @param {(reason:string, info:object) => any} o.onSignedIn
   * @param {number} [o.everyMs=10000]
   */
  constructor(o) {
    this.o = { everyMs: 10000, debounceMs: 1500, ...o };
    this.ctx = o.context; this.last = null; this.studioLoaded = false; this.stopped = false; this.busy = null; this.fired = 0;
    this._pages = new WeakSet();
  }

  start() {
    const ctx = this.ctx;
    if (!ctx) return this;
    if (typeof ctx.on === 'function') {
      ctx.on('page', p => this._bind(p));
      ctx.on('close', () => this._onWindowClosed());
    }
    try { for (const p of (ctx.pages ? ctx.pages() : [])) this._bind(p); } catch (_) { /* ignore */ }
    this._timer = setInterval(() => this.check('timer').catch(() => {}), this.o.everyMs);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  stop() { this.stopped = true; clearInterval(this._timer); clearTimeout(this._navT); }

  _bind(p) {
    if (!p || this._pages.has(p) || typeof p.on !== 'function') return;
    this._pages.add(p);
    p.on('framenavigated', f => {
      try { if (p.mainFrame && f !== p.mainFrame()) return; } catch (_) { return; }
      const u = (() => { try { return f.url(); } catch (_) { return ''; } })();
      this._onUrl(u);
    });
    p.on('close', () => { if (!this.stopped) this.check('tab closed').catch(() => {}); });
  }

  _onUrl(u) {
    if (ACCOUNTS.test(u)) { this.studioLoaded = false; return; }
    if (STUDIO.test(u)) this.studioLoaded = true;
    if (/^https:\/\/([a-z0-9-]+\.)*(youtube\.com|google\.[a-z.]+)\//i.test(u)) {
      clearTimeout(this._navT);
      this._navT = setTimeout(() => this.check('navigation').catch(() => {}), this.o.debounceMs);
      if (this._navT.unref) this._navT.unref();
    }
  }

  /** One check now (cookies of the live window). Returns the verdict. */
  async check(reason = 'check') {
    if (this.stopped) return null;
    if (this.busy) return this.busy;
    this.busy = (async () => {
      let cookies;
      try { cookies = await this.ctx.cookies(); } catch (_) { return null; }   // window closing
      this.last = cookies;
      const v = judgeSignedIn(cookies, { studioLoaded: this.studioLoaded });
      if (v.signedIn && this.o.flagged()) { this.fired++; await this.o.onSignedIn(reason, v); }
      return v;
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  _onWindowClosed() {
    if (this.stopped) return;
    this.stop();
    const v = judgeSignedIn(this.last, { studioLoaded: this.studioLoaded });
    if (v.signedIn && this.o.flagged()) { this.fired++; Promise.resolve(this.o.onSignedIn('window closed', v)).catch(() => {}); }
  }
}

module.exports = { SignInWatch, judgeSignedIn };
