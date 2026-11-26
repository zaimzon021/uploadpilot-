'use strict';
// One channel run inside a lane: open profile -> upload that channel's due videos -> close.
// Hard limit per run (default 20 min): a timer closes the browser, which makes every pending
// Playwright call reject, so the run can never hang.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { UploadEngine, HardLimitError } = require('./engine');
const { moveToDone } = require('../autopilot/scanner');
const { composeDescription } = require('../ai/gemini');
const { safeJobFields, isComplete } = require('./metadata');

function runDirFor(logsDir, runId, channelId) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dir = path.join(logsDir, 'runs', day, `run-${String(runId).padStart(5, '0')}-ch${channelId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Studio assets that must load even when "block media" is on (upload preview / thumbnails / player)
const MEDIA_ALLOW = /(^blob:|^data:|ytimg\.com|ggpht\.com|googleusercontent\.com\/.*(upload|thumbnail)|\/youtubei\/|studio\.youtube\.com\/.*(upload|thumbnail))/i;

class ChannelRunner extends EventEmitter {
  /**
   * @param {object} o
   * @param {(video:object, ctx:{log:Function}) => Promise<object>} [o.ensureMeta]  fills missing title/description/tags (Gemini inline, then file-name fallback)
   * @param {(video:object, err:Error, ctx:object) => object} [o.onFailure]  retry policy (app.failUpload)
   */
  constructor({ db, settings, events, profiles, logsDir, engineOpts = {}, cloud = null, ensureMeta = null, onFailure = null }) {
    super();
    Object.assign(this, { db, settings, events, profiles, logsDir, engineOpts, cloud, ensureMeta, onFailure });
    this.stopping = false;   // hand-over / wind-down: finish the current upload, start nothing new
    this.live = new Map(); // channelId -> {state, videoId, startedAt}
  }

  /**
   * Due = scheduled time reached, not waiting for a retry, and either ready, or (auto mode) still queued
   * for AI: the runner writes the metadata itself before uploading.
   */
  dueVideos(channelId, now = Date.now()) {
    const ch = this.db.get('SELECT style FROM channels WHERE id=?', channelId);
    const auto = JSON.parse((ch && ch.style) || '{}').mode !== 'approval';
    const rows = this.db.all(`SELECT * FROM videos WHERE channel_id=? AND (status='ready' OR (? AND status='queued' AND ai_status!='running')) AND scheduled_at IS NOT NULL AND scheduled_at<=? AND (retry_at IS NULL OR retry_at<=?) ORDER BY scheduled_at, id`, channelId, auto ? 1 : 0, now, now);
    // videos whose file is on another PC are only taken over (from the Drive backup) when allowed
    return this.cloud ? rows.filter(v => this.cloud.runnableHere(v, now)) : rows.filter(v => !v.remote);
  }

  async run(channelId, lane = 0) {
    const s = this.settings.all();
    const ch = this.db.get('SELECT * FROM channels WHERE id=?', channelId);
    if (!ch || ch.status !== 'active') return { result: 'skipped' };
    if (!ch.profile_id) { this._pause(ch, 'needs_you', 'No browser profile linked'); return { result: 'needs_you' }; }
    if (this.stopping) return { result: 'skipped' };
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

    // metadata first (before the browser opens, so Gemini time never counts against the run's hard limit)
    if (this.ensureMeta) {
      live.state = 'writing';
      for (const v of due) {
        const cur = this.db.get('SELECT * FROM videos WHERE id=?', v.id);
        if (!cur || isComplete(cur) || this.stopping || cur.remote) continue;   // another PC's file: written after its Drive copy is downloaded
        try { await this.ensureMeta(cur, { log }); } catch (e) { log(`metadata for video ${v.id}: ${e.message}`); }
      }
      live.state = 'opening';
    }
    let hardTimer, timedOut = false, result = 'ok', detail = '';
    const done = [];
    const hardPromise = new Promise(resolve => { hardTimer = setTimeout(() => { timedOut = true; resolve('hard'); }, hardMs); });
    const work = (async () => {
      let sess;
      try {
        sess = await this.profiles.open(ch.profile_id, { purpose: 'auto' });
      } catch (e) {
        log(`open profile failed: ${e.message}`);
        if (['PROFILE_BUSY', 'PROFILE_LOCKED', 'BROWSER_LIMIT'].includes(e.code)) { result = 'busy'; detail = e.message; if (e.code === 'PROFILE_LOCKED') this._setReason(ch, e.message); return; }
        if (e.code === 'PROXY_DEAD') { result = 'proxy_dead'; detail = e.message; this.events.error(`${ch.name}: ${e.message}`, { channelId, kind: 'proxy' }); this._setReason(ch, `Proxy failed check, will retry`); return; }
        throw e;
      }
      log(`profile #${sess.number} open, exit IP ${sess.exitIp || 'n/a'}`);
      const ctx = sess.handle.context;
      if (s.browser.blockMedia && typeof ctx.route === 'function') {
        await ctx.route('**/*', r => { const req = r.request(); const t = req.resourceType(); return (t === 'image' || t === 'media' || t === 'font') && !MEDIA_ALLOW.test(req.url()) ? r.abort() : r.continue(); }).catch(() => {});
      }
      let page = ctx.pages()[0] || await ctx.newPage();
      const engine = new UploadEngine({ cfg: s.upload, studioUrl: s.urls.studio, runDir, log, onState: st => { live.state = st; }, ...this.engineOpts });
      const style = JSON.parse(ch.style || '{}');
      for (const v of due) {
        if (timedOut || this.stopping) break;
        const cur = this.db.get('SELECT * FROM videos WHERE id=?', v.id);
        if (!cur || !['ready', 'queued'].includes(cur.status) || (cur.retry_at && cur.retry_at > Date.now())) continue;
        if (!cur.remote && !fs.existsSync(cur.path)) { this.db.run(`UPDATE videos SET status='missing', error=? WHERE id=?`, 'File not found', v.id); log(`video ${v.id} file missing`); continue; }
        // cloud: claim the job first (only one PC uploads a video)
        let claim = { ok: true };
        if (this.cloud) {
          claim = await this.cloud.claimVideo(cur).catch(e => ({ ok: false, error: e.message }));
          if (!claim.ok) { log(`video ${v.id} skipped: ${claim.holder ? 'running on ' + claim.holder.pcName : claim.error || 'claim refused'}`); continue; }
          if (claim.offline) log('cloud unreachable: uploading our own file without a lease');
        }
        let file = cur.path, cacheFile = null, lost = false;
        const onLost = key => { if (this.cloud && key === this.cloud.videoKey(cur)) { lost = true; log(`lease for video ${v.id} was taken over by another PC — stopping`); this.profiles.close(ch.profile_id).catch(() => {}); } };
        if (this.cloud) this.cloud.on('lease-lost', onLost);
        try {
          if (cur.remote) {
            live.state = 'downloading';
            log(`video ${v.id} is from ${cur.origin_pc_name || 'another PC'}: taking over, downloading the Drive copy`);
            this.events.info(`${ch.name}: taking over "${cur.title || cur.filename}" from ${cur.origin_pc_name || 'another PC'} (downloading backup)`, { channelId, kind: 'takeover' });
            try { file = cacheFile = await this.cloud.fetchForTakeover(cur); }
            catch (e) { log(`download failed: ${e.message}`); this.events.warn(`${ch.name}: could not download the backup of ${cur.filename}: ${e.message}`, { channelId, kind: 'takeover' }); continue; }
          }
          if (cur.remote && !isComplete(cur) && this.ensureMeta) { try { Object.assign(cur, await this.ensureMeta(cur, { log, file })); } catch (e) { log(`metadata: ${e.message}`); } }
          // never upload without metadata: fill anything still missing (null-safe, file-name fallback)
          const meta = safeJobFields(cur, style);
          if (!isComplete(cur)) {
            log(`video ${v.id}: metadata incomplete at upload time — using ${cur.title ? 'its title + ' : ''}file-name fallback for the rest`);
            this.db.run(`UPDATE videos SET title=COALESCE(NULLIF(TRIM(title),''),?), description=COALESCE(NULLIF(TRIM(description),''),?), tags=CASE WHEN tags IS NULL OR tags IN ('','[]') THEN ? ELSE tags END, meta_source=COALESCE(meta_source,'filename') WHERE id=?`, meta.title, meta.description, JSON.stringify(meta.tags), v.id);
          }
          live.videoId = v.id; live.state = 'uploading';
          this.db.run(`UPDATE videos SET status='uploading', attempts=attempts+1 WHERE id=?`, v.id);
          this.emit('upload-start', { channelId, videoId: v.id });
          if (this.cloud) this.cloud.noteVideo(cur, { state: 'uploading' });
          this.events.info(`${ch.name}: uploading "${meta.title}"${cur.retry_count ? ` (retry ${cur.retry_count}/${s.retry.max})` : ''}`, { channelId, kind: 'upload' });
          const job = {
            file, thumb: cur.remote ? null : cur.thumb, title: meta.title, filename: cur.filename,
            description: composeDescription({ description: meta.description, hashtags: meta.hashtags }, style),
            tags: meta.tags, madeForKids: !!style.madeForKids,
            visibility: style.visibility || s.upload.visibility,
          };
          try {
            if (page.isClosed()) page = await ctx.newPage();
            // duplicate safety: a retry first looks in Studio's content list for the earlier attempt
            if (cur.retry_count > 0 && !this.engineOpts.uploadImpl && typeof engine.findExisting === 'function') {
              const found = await engine.findExisting(page, { channelId: ch.yt_channel_id, title: meta.title, filename: cur.filename }).catch(e => ({ checked: false, reason: e.message }));
              if (found.match && !found.match.draft && found.match.url) {
                log(`video ${v.id}: already in Studio as ${found.match.url} — not uploading again`);
                this.db.run(`UPDATE videos SET status='done', url=?, uploaded_at=?, error=NULL, retry_at=NULL WHERE id=?`, found.match.url, Date.now(), v.id);
                this.events.success(`${ch.name}: "${meta.title}" was already published by an earlier attempt`, { channelId, kind: 'published' });
                done.push(v.id); continue;
              }
              if (found.match && found.match.draft) log(`video ${v.id}: an earlier attempt left a draft "${found.match.title}" in Studio; uploading again (the draft stays private)`);
              else if (!found.checked) log(`video ${v.id}: could not check Studio for an earlier attempt (${found.reason || 'unknown'}) — a duplicate draft is possible`);
            }
            const r = this.engineOpts.uploadImpl ? await this.engineOpts.uploadImpl(page, job, { deadline, video: cur }) : await engine.uploadVideo(page, job, { deadline });
            if (lost) throw new Error('Lease lost to another PC');
            page = ctx.pages().find(p => !p.isClosed()) || page;
            this.db.run(`UPDATE videos SET status='done', url=?, uploaded_at=?, error=NULL, retry_at=NULL, error_kind=NULL WHERE id=?`, r.url, Date.now(), v.id);
            if (s.upload.moveDoneFiles && !cur.remote) {
              try { const m = moveToDone(cur.path, cur.thumb); this.db.run('UPDATE videos SET path=?, thumb=? WHERE id=?', m.video || cur.path, m.thumb || cur.thumb, v.id); } catch (e) { log(`move to Done failed: ${e.message}`); }
            }
            done.push(v.id);
            log(`video ${v.id} DONE ${r.url}`);
            this.events.success(`${ch.name}: published "${meta.title}"`, { channelId, kind: 'published' });
            if (this.cloud) await this.cloud.afterUploaded(this.db.get('SELECT * FROM videos WHERE id=?', v.id)).catch(() => {});
            await new Promise(r2 => setTimeout(r2, 1500 + Math.random() * 3000 * (this.engineOpts.speed ?? 1)));
          } catch (e) {
            const err = timedOut ? new HardLimitError(hardMs) : e;
            log(`video ${v.id} FAILED: ${err.code || ''} ${err.message}`);
            if (lost) { this.db.run(`UPDATE videos SET status='ready', attempts=attempts-1 WHERE id=? AND status='uploading'`, v.id); result = 'lease_lost'; detail = 'Another PC took over'; break; }
            if (this.stopping && this.aborted) { this.db.run(`UPDATE videos SET status='ready', attempts=attempts-1 WHERE id=? AND status='uploading'`, v.id); log(`video ${v.id}: aborted for hand-over, back in the queue`); result = 'aborted'; detail = 'Handed over'; break; }
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
            this._failed(ch, v.id, err, log);
            result = timedOut || err.code === 'HARD_LIMIT' ? 'hard_limit' : 'failed'; detail = err.message;
            if (err.code === 'HARD_LIMIT') break;
          }
        } finally {
          if (this.cloud) { this.cloud.off('lease-lost', onLost); await this.cloud.releaseVideo(cur).catch(() => {}); }
          if (cacheFile) { try { fs.unlinkSync(cacheFile); log('cache copy deleted'); } catch (_) { /* gone */ } }
        }
      }
    })();

    try {
      const winner = await Promise.race([work.then(() => 'work'), hardPromise]);
      if (winner === 'hard') {
        log('HARD LIMIT reached: closing profile');
        const hs = this.profiles.session(ch.profile_id); if (hs) hs.noExport = true;   // a hung browser: don't wait on a login export
        result = 'hard_limit'; detail = `Hard limit ${Math.round(hardMs / 60000)} min`;
        this.events.error(`${ch.name}: run hit the ${Math.round(hardMs / 60000)}-minute limit, closed`, { channelId, kind: 'failed' });
        await this.profiles.close(ch.profile_id);
        await Promise.race([work.catch(() => {}), new Promise(r => setTimeout(r, 20000))]);
        for (const r of this.db.all(`SELECT id FROM videos WHERE channel_id=? AND status='uploading'`, channelId)) this._failed(ch, r.id, new HardLimitError(hardMs), log);
      }
    } catch (e) {
      result = 'error'; detail = e.message; log(`run error: ${e.stack || e.message}`);
      this.events.error(`${ch.name}: ${e.message}`, { channelId, kind: 'failed' });
      for (const r of this.db.all(`SELECT id FROM videos WHERE channel_id=? AND status='uploading'`, channelId)) this._failed(ch, r.id, e, log);
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

  /** A failed upload: retry later (with back-off, inside the window) or give up — app.failUpload decides. */
  _failed(ch, videoId, err, log = () => {}) {
    if (this.stopping && this.aborted) { this.db.run(`UPDATE videos SET status='ready', attempts=MAX(attempts-1,0) WHERE id=? AND status='uploading'`, videoId); return; }
    if (this.onFailure) { const r = this.onFailure(this.db.get('SELECT * FROM videos WHERE id=?', videoId), err, { channel: ch }); log(`video ${videoId} -> ${r.action}${r.retryAt ? ' at ' + new Date(r.retryAt).toISOString() : ''}`); return; }
    this.db.run(`UPDATE videos SET status='failed', error=? WHERE id=?`, String(err.message).slice(0, 500), videoId);
    this.events.error(`${ch.name}: upload failed — ${String(err.message).split('\n')[0]}`, { channelId: ch.id, kind: 'failed' });
  }

  _pause(ch, status, reason) { this.db.run('UPDATE channels SET status=?, status_reason=? WHERE id=?', status, reason, ch.id); }
  _setReason(ch, reason) { this.db.run('UPDATE channels SET status_reason=? WHERE id=?', reason, ch.id); }
}

function humanReason(state) {
  return ({ google_login: 'Login expired', verification: 'Google verification / captcha', new_device: 'New-device confirmation', no_channel: 'No YouTube channel on this account' })[state] || state;
}

module.exports = { ChannelRunner, humanReason };
