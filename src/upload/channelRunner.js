'use strict';
// One channel run inside a lane: open profile -> upload that channel's due videos -> close.
// Hard limit per run (default 20 min): a timer closes the browser, which makes every pending
// Playwright call reject, so the run can never hang.
const fs = require('fs');
const path = require('path');
const { UploadEngine, HardLimitError } = require('./engine');
const { moveToDone } = require('../autopilot/scanner');
const { composeDescription } = require('../ai/gemini');

function runDirFor(logsDir, runId, channelId) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dir = path.join(logsDir, 'runs', day, `run-${String(runId).padStart(5, '0')}-ch${channelId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class ChannelRunner {
  constructor({ db, settings, events, profiles, logsDir, engineOpts = {} }) {
    Object.assign(this, { db, settings, events, profiles, logsDir, engineOpts });
    this.live = new Map(); // channelId -> {state, videoId, startedAt}
  }

  dueVideos(channelId, now = Date.now()) {
    return this.db.all(`SELECT * FROM videos WHERE channel_id=? AND status='ready' AND scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at`, channelId, now);
  }

  async run(channelId, lane = 0) {
    const s = this.settings.all();
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', channelId);
    if (!ch || ch.status !== 'active') return { result: 'skipped' };
    if (!ch.profile_id) { this._pause(ch, 'needs_you', 'No browser profile linked'); return { result: 'needs_you' }; }
    const due = this.dueVideos(channelId);
    if (!due.length) return { result: 'nothing_due' };
    const runId = this.db.run('INSERT INTO runs(channel_id,lane,started_at,result) VALUES(?,?,?,?)', channelId, lane, Date.now(), 'running').lastInsertRowid;
    const runDir = runDirFor(this.logsDir, runId, channelId);
    this.db.run('UPDATE runs SET log_dir=? WHERE id=?', runDir, runId);
    const logFile = path.join(runDir, 'run.log');
    const log = m => { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); if (process.env.UPLOADPILOT_VERBOSE) console.log(`  [run ${runId}] ${m}`); };
    const hardMs = s.upload.channelHardLimitMs;
    const deadline = Date.now() + hardMs;
    const live = { state: 'opening', videoId: null, startedAt: Date.now(), lane, runId };
    this.live.set(channelId, live);
    this.events.info(`Lane ${lane + 1}: starting ${ch.name || 'channel ' + channelId} (${due.length} due)`, { channelId, kind: 'run' });
    log(`run ${runId} channel ${channelId} "${ch.name}" lane ${lane} due=${due.length} hardLimit=${hardMs}ms`);

    let hardTimer, timedOut = false, result = 'ok', detail = '';
    const done = [];
    const hardPromise = new Promise(resolve => { hardTimer = setTimeout(() => { timedOut = true; resolve('hard'); }, hardMs); });
    const work = (async () => {
      let sess;
      try {
        sess = await this.profiles.open(ch.profile_id, { purpose: 'auto' });
      } catch (e) {
        log(`open profile failed: ${e.message}`);
        if (e.code === 'PROFILE_BUSY') { result = 'busy'; detail = e.message; return; }
        if (e.code === 'PROXY_DEAD') { result = 'proxy_dead'; detail = e.message; this.events.error(`${ch.name}: ${e.message}`, { channelId, kind: 'proxy' }); this._setReason(ch, `Proxy failed check, will retry`); return; }
        throw e;
      }
      log(`profile #${sess.number} open, exit IP ${sess.exitIp || 'n/a'}`);
      const ctx = sess.handle.context;
      let page = ctx.pages()[0] || await ctx.newPage();
      const engine = new UploadEngine({ cfg: s.upload, studioUrl: s.urls.studio, runDir, log, onState: st => { live.state = st; }, ...this.engineOpts });
      const style = JSON.parse(ch.style || '{}');
      for (const v of due) {
        if (timedOut) break;
        const cur = this.db.get('SELECT * FROM videos WHERE id=?', v.id);
        if (!cur || cur.status !== 'ready') continue;
        if (!fs.existsSync(cur.path)) { this.db.run(`UPDATE videos SET status='missing', error=? WHERE id=?`, 'File not found', v.id); log(`video ${v.id} file missing`); continue; }
        live.videoId = v.id; live.state = 'uploading';
        this.db.run(`UPDATE videos SET status='uploading', attempts=attempts+1 WHERE id=?`, v.id);
        this.events.info(`${ch.name}: uploading "${cur.title}"`, { channelId, kind: 'upload' });
        const job = {
          file: cur.path, thumb: cur.thumb, title: cur.title,
          description: composeDescription({ description: cur.description, hashtags: JSON.parse(cur.hashtags || '[]') }, style),
          tags: JSON.parse(cur.tags || '[]'), madeForKids: !!style.madeForKids,
          visibility: style.visibility || s.upload.visibility,
        };
        try {
          if (page.isClosed()) page = await ctx.newPage();
          const r = await engine.uploadVideo(page, job, { deadline });
          page = ctx.pages().find(p => !p.isClosed()) || page;
          this.db.run(`UPDATE videos SET status='done', url=?, uploaded_at=?, error=NULL WHERE id=?`, r.url, Date.now(), v.id);
          if (s.upload.moveDoneFiles) {
            try { const m = moveToDone(cur.path, cur.thumb); this.db.run('UPDATE videos SET path=?, thumb=? WHERE id=?', m.video || cur.path, m.thumb || cur.thumb, v.id); } catch (e) { log(`move to Done failed: ${e.message}`); }
          }
          done.push(v.id);
          log(`video ${v.id} DONE ${r.url}`);
          this.events.success(`${ch.name}: published "${cur.title}"`, { channelId, kind: 'published' });
          await new Promise(r2 => setTimeout(r2, 1500 + Math.random() * 3000 * (this.engineOpts.speed ?? 1)));
        } catch (e) {
          const err = timedOut ? new HardLimitError(hardMs) : e;
          log(`video ${v.id} FAILED: ${err.code || ''} ${err.message}`);
          if (err.code === 'NEEDS_USER') {
            this.db.run(`UPDATE videos SET status='ready', attempts=attempts-1 WHERE id=?`, v.id);
            this._pause(ch, 'needs_you', humanReason(err.state));
            this.events.warn(`${ch.name}: ${humanReason(err.state)} — channel paused, needs you`, { channelId, kind: 'needs_you' });
            result = 'needs_you'; detail = err.state; break;
          }
          if (err.code === 'UPLOAD_LIMIT') {
            this.db.run(`UPDATE videos SET status='ready', attempts=attempts-1 WHERE id=?`, v.id);
            const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
            this.db.run('UPDATE channels SET paused_until=?, status_reason=? WHERE id=?', tomorrow.getTime(), 'YouTube upload limit reached — resumes tomorrow', channelId);
            this.events.warn(`${ch.name}: YouTube daily upload limit reached, resuming tomorrow`, { channelId, kind: 'limit' });
            result = 'limit'; break;
          }
          this.db.run(`UPDATE videos SET status='failed', error=? WHERE id=?`, err.message.slice(0, 500), v.id);
          this.events.error(`${ch.name}: upload failed — ${err.message.split('\n')[0]}`, { channelId, kind: 'failed' });
          result = timedOut || err.code === 'HARD_LIMIT' ? 'hard_limit' : 'failed'; detail = err.message;
          if (err.code === 'HARD_LIMIT') break;
        }
      }
    })();

    try {
      const winner = await Promise.race([work.then(() => 'work'), hardPromise]);
      if (winner === 'hard') {
        log('HARD LIMIT reached: closing profile');
        result = 'hard_limit'; detail = `Hard limit ${Math.round(hardMs / 60000)} min`;
        this.events.error(`${ch.name}: run hit the ${Math.round(hardMs / 60000)}-minute limit, closed`, { channelId, kind: 'failed' });
        await this.profiles.close(ch.profile_id);
        await Promise.race([work.catch(() => {}), new Promise(r => setTimeout(r, 20000))]);
        this.db.run(`UPDATE videos SET status='failed', error=? WHERE channel_id=? AND status='uploading'`, 'Hard time limit reached', channelId);
      }
    } catch (e) {
      result = 'error'; detail = e.message; log(`run error: ${e.stack || e.message}`);
      this.events.error(`${ch.name}: ${e.message}`, { channelId, kind: 'failed' });
      this.db.run(`UPDATE videos SET status='failed', error=? WHERE channel_id=? AND status='uploading'`, e.message.slice(0, 500), channelId);
    } finally {
      clearTimeout(hardTimer);
      await this.profiles.close(ch.profile_id).catch(() => {});
      this.live.delete(channelId);
      this.db.run('UPDATE runs SET ended_at=?, result=?, detail=? WHERE id=?', Date.now(), result, `${done.length} uploaded. ${detail}`.slice(0, 1000), runId);
      this.db.run('UPDATE channels SET last_run=? WHERE id=?', Date.now(), channelId);
      log(`run end: ${result} uploaded=${done.length}`);
    }
    return { result, uploaded: done, runDir, runId };
  }

  _pause(ch, status, reason) { this.db.run('UPDATE channels SET status=?, status_reason=? WHERE id=?', status, reason, ch.id); }
  _setReason(ch, reason) { this.db.run('UPDATE channels SET status_reason=? WHERE id=?', reason, ch.id); }
}

function humanReason(state) {
  return ({ google_login: 'Login expired', verification: 'Google verification / captcha', new_device: 'New-device confirmation', no_channel: 'No YouTube channel on this account' })[state] || state;
}

module.exports = { ChannelRunner, humanReason };
