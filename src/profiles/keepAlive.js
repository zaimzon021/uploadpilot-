'use strict';
// v0.3.1 keep-alive: Google cookies of a profile that sits unused for days go stale. Once a day, each
// profile not opened in the last `idleHours` gets a short youtube.com visit (~20 s, minimized window,
// through its own proxy), which refreshes its cookies; closing the window saves the login to the cloud
// (only when it changed). Light on purpose:
//   * one profile at a time, only on the active PC, only inside the upload window,
//   * never while an upload lane is busy with that channel, never while you use the PC,
//   * a humanized wait (the lane delay range) between two visits,
//   * a signed-out profile is reported at once ("Sign in needed" + Open profile) and not visited again
//     until it is signed in.
const { inWindow } = require('../util/time');

class KeepAlive {
  constructor({ app, now = () => Date.now(), rng = Math.random, tickMs = null }) {
    Object.assign(this, { app, now, rng, tickMsOverride: tickMs });
    this.busy = null; this.nextAllowed = 0; this.timer = null; this.stats = { visits: 0, signedOut: 0, lastProfile: null };
  }
  get cfg() { return this.app.settings.get('keepAlive') || { enabled: false }; }

  start() {
    const ms = this.tickMsOverride || this.cfg.tickMs || 600000;
    this.timer = setInterval(() => this.tick().catch(e => this.app.events.warn(`Keep-alive: ${e.message}`, { kind: 'profile' })), ms);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
  async idle() { if (this.busy) await this.busy.catch(() => {}); }

  /** Why no visit can start now (null = go). */
  blockedReason(now = this.now()) {
    const c = this.cfg, s = this.app.settings.all();
    if (!c.enabled) return 'off';
    if (this.busy) return 'busy';
    if (s.autopilotPaused) return 'autopilot paused';
    if (!this.app.canWork()) return 'not the active PC / you are using the PC';
    if (!inWindow(now, s.uploadWindow)) return 'outside the upload window';
    if (now < this.nextAllowed) return 'humanized wait';
    return null;
  }

  /** The profile that needs a visit most (longest unused), or null. */
  pick(now = this.now()) {
    const cut = now - (this.cfg.idleHours || 24) * 3600e3;
    const rows = this.app.db.all(`SELECT p.*, c.id AS channel_id, c.name AS channel_name FROM profiles p JOIN channels c ON c.profile_id=p.id
      WHERE c.status IN ('active','paused') AND (p.last_opened IS NULL OR p.last_opened<?) AND (p.keepalive_at IS NULL OR p.keepalive_at<?)
        AND IFNULL(p.login_state,'') NOT IN ('signed_out')
      ORDER BY COALESCE(p.keepalive_at, p.last_opened, 0) LIMIT 10`, cut, cut);
    return rows.find(r => !this.app.profiles.isOpen(r.id) && !this.app.runner.live.has(r.channel_id) && !(this.app.scheduler && this.app.scheduler.inProgress.has(r.channel_id))) || null;
  }

  async tick() {
    const now = this.now();
    if (this.blockedReason(now)) return null;
    const p = this.pick(now);
    if (!p) return null;
    this.busy = this.visit(p).finally(() => {
      this.busy = null;
      const { min, max } = this.app.settings.get('delayRangeMin');
      this.nextAllowed = this.now() + Math.round((min + this.rng() * (max - min)) * 60000);
    });
    return this.busy;
  }

  async visit(p) {
    const stayMs = (this.cfg.staySec ?? 20) * 1000;
    this.app.db.run('UPDATE profiles SET keepalive_at=? WHERE id=?', this.now(), p.id);
    let sess;
    try { sess = await this.app.profiles.open(p.id, { purpose: 'keepalive' }); }
    catch (e) {
      if (!['BROWSER_LIMIT', 'PROFILE_BUSY', 'PROFILE_LOCKED', 'NOT_ACTIVE'].includes(e.code)) this.app.events.warn(`Profile #${p.number}: keep-alive visit skipped — ${e.code === 'PROXY_DEAD' ? 'proxy failed check' : e.message}`, { kind: 'profile' });
      this.app.db.run('UPDATE profiles SET keepalive_at=NULL WHERE id=?', p.id);
      return { visited: false, reason: e.code || e.message };
    }
    let r = { signedIn: false };
    try {
      const page = sess.handle.context.pages()[0] || await sess.handle.context.newPage();
      r = await this.app.checkSignedIn(p, sess, { log: false, stayMs, page });
      sess.exportReason = 'keep-alive';
    } finally { await this.app.profiles.close(p.id).catch(() => {}); }
    this.stats.visits++; this.stats.lastProfile = p.number;
    if (r.signedIn) this.app.events.info(`Profile #${p.number}: keep-alive visit done, still signed in`, { kind: 'profile' });
    else { this.stats.signedOut++; this.app.events.warn(`${p.channel_name || 'Profile #' + p.number}: sign in needed (found by the daily check)`, { channelId: p.channel_id, kind: 'needs_you' }); }
    return { visited: true, signedIn: r.signedIn };
  }
}

module.exports = { KeepAlive };
