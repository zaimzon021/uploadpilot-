'use strict';
// Link-channel wizard:
//  1) new profile + auto proxy -> open accounts.google.com -> user logs in by hand -> detect login
//     (Google session cookies) -> open Studio -> read channel name / id / handle
//  2) style   3) folder -> channel becomes active and autopilot starts (no Start button).
const crypto = require('crypto');
const { detectState } = require('../upload/detect');
const SEL = require('../upload/selectors');
const { cssOnly } = require('../upload/detect');

class LinkWizard {
  constructor(app) { this.app = app; this.sessions = new Map(); }

  get db() { return this.app.db; }

  async start({ name, proxyId, proxy, pollMs = 3000, timeoutMs = 30 * 60000 } = {}) {
    const { profiles, settings, events } = this.app;
    if (!proxyId && !proxy && !profiles.pickFreeProxy()) {
      if (!settings.get('allowNoProxy')) throw Object.assign(new Error('Proxy pool is empty. Paste proxies in Settings first.'), { status: 400 });
    }
    const prof = profiles.createProfile({ name, proxyId, proxy, autoProxy: true });
    const chId = this.db.run('INSERT INTO channels(profile_id,name,status,created_at,style) VALUES(?,?,?,?,?)', prof.id, name || null, 'linking', Date.now(), '{}').lastInsertRowid;
    const id = crypto.randomBytes(6).toString('hex');
    const s = { id, channelId: chId, profileId: prof.id, profileNumber: prof.number, step: 1, status: 'opening', channel: null, error: null, startedAt: Date.now() };
    this.sessions.set(id, s);
    events.info(`Link wizard: profile #${prof.number} created, opening Google sign-in`, { channelId: chId, kind: 'link' });
    try {
      const urls = settings.get('urls');
      await profiles.open(prof.id, { purpose: 'link', startUrl: `${urls.accounts.replace(/\/$/, '')}/ServiceLogin?continue=${encodeURIComponent(urls.studio)}` });
      s.status = 'waiting_login';
    } catch (e) {
      s.status = 'error'; s.error = e.message;
      events.error(`Link wizard: ${e.message}`, { channelId: chId, kind: 'link' });
      return this.view(s);
    }
    s._timer = setInterval(() => this._poll(s).catch(e => { s.error = e.message; }), pollMs);
    s._timeout = setTimeout(() => { if (s.status === 'waiting_login') { s.status = 'timeout'; this._stopPolling(s); } }, timeoutMs);
    return this.view(s);
  }

  _stopPolling(s) { clearInterval(s._timer); clearTimeout(s._timeout); }

  async _poll(s) {
    if (s._busy || !['waiting_login', 'reading_channel', 'no_channel'].includes(s.status)) return;
    s._busy = true;
    try {
      const sess = this.app.profiles.session(s.profileId);
      if (!sess) { s.status = 'browser_closed'; s.error = 'The sign-in window was closed. Start again or reopen.'; this._stopPolling(s); return; }
      const ctx = sess.handle.context;
      const urls = this.app.settings.get('urls');
      const names = this.app.settings.get('loginCookieNames');
      if (s.status === 'waiting_login') {
        const cookies = await ctx.cookies([urls.accounts, urls.youtube]).catch(() => []);
        if (!cookies.some(c => names.includes(c.name))) return;
        s.status = 'reading_channel';
        this.app.events.info(`Link wizard: Google login detected on profile #${s.profileNumber}`, { channelId: s.channelId, kind: 'link' });
      }
      // Open Studio in its own tab (doesn't disturb whatever the user is looking at) and read channel
      let page = s._studioPage && !s._studioPage.isClosed() ? s._studioPage : null;
      if (!page) { page = await ctx.newPage(); s._studioPage = page; await page.goto(urls.studio, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); }
      const t0 = Date.now();
      let st;
      while (Date.now() - t0 < 30000) {
        st = await detectState(page);
        if (['dashboard', 'no_channel', 'google_login', 'verification', 'new_device'].includes(st.state)) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      if (st.state === 'dashboard') {
        const info = await this.readChannel(page, urls);
        s.channel = info; s.status = 'connected'; s.step = 2;
        this.db.run('UPDATE channels SET name=?, handle=?, yt_channel_id=? WHERE id=?', info.name, info.handle, info.channelId, s.channelId);
        this.app.events.success(`Link wizard: connected ${info.name || info.channelId}${info.handle ? ' (' + info.handle + ')' : ''}`, { channelId: s.channelId, kind: 'link' });
        this._stopPolling(s);
        await page.close().catch(() => {}); s._studioPage = null;
      } else if (st.state === 'no_channel') {
        s.status = 'no_channel'; s.error = 'This Google account has no YouTube channel yet. Create one in the open window; it will be detected.';
        await page.reload().catch(() => {});
      } else {
        s.status = 'waiting_login'; // e.g. still on a verification step
        await page.close().catch(() => {}); s._studioPage = null;
      }
    } finally { s._busy = false; }
  }

  async readChannel(page, urls) {
    const name = await page.evaluate(sels => {
      for (const s of sels) { const el = document.querySelector(s); if (el && el.textContent.trim()) return el.textContent.trim(); }
      return null;
    }, cssOnly(SEL.studio.channelName)).catch(() => null);
    let channelId = (/\/channel\/(UC[\w-]{10,})/.exec(page.url()) || [])[1] || null;
    if (!channelId) channelId = await page.evaluate(() => { const m = /"(?:channelId|externalChannelId)":"(UC[\w-]{10,})"/.exec(document.documentElement.innerHTML); return m ? m[1] : null; }).catch(() => null);
    let handle = await page.evaluate(() => { const m = /"(?:channelHandle|handle)":"(@[\w.\-]+)"/.exec(document.documentElement.innerHTML); return m ? m[1] : null; }).catch(() => null);
    if (!handle && channelId) {
      try {
        const res = await page.context().request.get(`${urls.youtube.replace(/\/$/, '')}/channel/${channelId}`, { timeout: 20000 });
        const html = await res.text();
        handle = (/"canonicalBaseUrl":"\/(@[^"]+)"/.exec(html) || /"vanityChannelUrl":"https?:\/\/www\.youtube\.com\/(@[^"]+)"/.exec(html) || [])[1] || null;
      } catch (_) { /* best effort */ }
    }
    return { name, channelId, handle };
  }

  saveStyle(id, style) {
    const s = this._get(id);
    if (s.status !== 'connected') throw Object.assign(new Error('Finish signing in first'), { status: 409 });
    const clean = normalizeStyle(style);
    this.db.run('UPDATE channels SET style=? WHERE id=?', JSON.stringify(clean), s.channelId);
    s.step = 3; s.style = clean;
    return this.view(s);
  }

  async saveFolder(id, folder) {
    const s = this._get(id);
    if (s.status !== 'connected' || s.step < 3) throw Object.assign(new Error('Finish steps 1 and 2 first'), { status: 409 });
    const fs = require('fs');
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw Object.assign(new Error(`Folder not found: ${folder}`), { status: 400 });
    this.db.run(`UPDATE channels SET folder=?, status='active', status_reason=NULL WHERE id=?`, folder, s.channelId);
    await this.app.profiles.close(s.profileId);
    s.step = 4; s.status = 'done';
    this.app.events.success(`Channel ${s.channel?.name || s.channelId} linked — autopilot started`, { channelId: s.channelId, kind: 'link' });
    await this.app.activateChannel(s.channelId);
    this.sessions.delete(id);
    return { ...this.view(s), status: 'done' };
  }

  async cancel(id) {
    const s = this._get(id);
    this._stopPolling(s);
    await this.app.profiles.close(s.profileId);
    if (s.status !== 'done') {
      this.db.run('DELETE FROM channels WHERE id=?', s.channelId);
      await this.app.profiles.deleteProfile(s.profileId);
    }
    this.sessions.delete(id);
    return { cancelled: true };
  }

  _get(id) { const s = this.sessions.get(id); if (!s) throw Object.assign(new Error('Link session not found'), { status: 404 }); return s; }
  get(id) { return this.view(this._get(id)); }
  view(s) {
    const p = this.app.profiles.getProfile(s.profileId);
    const proxy = p && this.app.profiles.getProxy(p.proxy_id);
    return { id: s.id, step: s.step, status: s.status, error: s.error, channelId: s.channelId, profileId: s.profileId, profileNumber: s.profileNumber, proxy: proxy ? `${proxy.host}:${proxy.port}` : null, channel: s.channel, style: s.style || null };
  }
  async closeAll() { for (const id of [...this.sessions.keys()]) { const s = this.sessions.get(id); this._stopPolling(s); } }
}

function normalizeStyle(st = {}) {
  return {
    niche: String(st.niche || '').slice(0, 2000),
    language: String(st.language || 'English').slice(0, 60),
    madeForKids: st.madeForKids === true || st.madeForKids === 'true' || st.madeForKids === 'yes',
    footer: String(st.footer || '').slice(0, 2000),
    hashtags: String(st.hashtags || '').slice(0, 500),
    mode: st.mode === 'approval' ? 'approval' : 'auto',
    visibility: ['PUBLIC', 'UNLISTED', 'PRIVATE'].includes(st.visibility) ? st.visibility : undefined,
    perDay: st.perDay ? Math.max(1, Math.min(20, +st.perDay)) : undefined,
    // v0.3.2: back up new videos to Google Drive right after they are found (default on)
    backupNew: !(st.backupNew === false || st.backupNew === 'false' || st.backupNew === 'no'),
  };
}

module.exports = { LinkWizard, normalizeStyle };
