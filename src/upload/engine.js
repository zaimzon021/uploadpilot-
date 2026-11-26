'use strict';
// Upload engine: a state machine driven by what is actually on screen (detectState), so after any
// hiccup it continues from where it really is. Every step has a timeout; failures screenshot,
// try recovery (dismiss dialogs -> reload -> new tab), and retry; nothing waits forever.
const fs = require('fs');
const path = require('path');
const SEL = require('./selectors');
const { detectState, readUploadProgress, readVideoUrl } = require('./detect');
const { Human } = require('./humanize');
const { sleep } = require('../util/random');

class NeedsUserError extends Error { constructor(state, msg) { super(msg || `Needs you: ${state}`); this.state = state; this.code = 'NEEDS_USER'; } }
class UploadLimitError extends Error { constructor() { super('YouTube daily upload limit reached'); this.code = 'UPLOAD_LIMIT'; } }
class StepTimeoutError extends Error { constructor(state, ms) { super(`Step timeout: stuck in "${state}" for ${Math.round(ms / 1000)}s`); this.state = state; this.code = 'STEP_TIMEOUT'; } }
class HardLimitError extends Error { constructor(ms) { super(`Hard limit of ${Math.round(ms / 60000)} min reached`); this.code = 'HARD_LIMIT'; } }
class FatalUploadError extends Error { constructor(msg) { super(msg); this.code = 'FATAL'; } }

const NEEDS_USER_STATES = new Set(['google_login', 'verification', 'new_device', 'no_channel']);

/** First visible locator from a fallback list (Playwright selectors incl. :has-text allowed). */
async function firstVisible(page, list, { timeout = 0 } = {}) {
  const t0 = Date.now();
  do {
    for (const s of list) {
      try {
        const loc = page.locator(s);
        const n = await loc.count();
        for (let i = 0; i < Math.min(n, 5); i++) { const l = loc.nth(i); if (await l.isVisible()) return l; }
      } catch (_) { /* bad selector for this engine – skip */ }
    }
    if (Date.now() - t0 >= timeout) break;
    await sleep(250);
  } while (true);
  return null;
}
async function firstAttached(page, list) {
  for (const s of list) { try { const l = page.locator(s).first(); if (await l.count()) return l; } catch (_) {} }
  return null;
}

/** Null-safe job: a missing title/description/tags can never crash the flow (0.3.1 "uploading null" fix). */
function normalizeJob(job = {}) {
  const { titleFromFilename } = require('./metadata');
  const title = typeof job.title === 'string' && job.title.trim() ? job.title.trim() : titleFromFilename(job.filename || (job.file ? path.basename(job.file) : ''));
  return {
    ...job, title,
    description: job.description == null ? '' : String(job.description),
    tags: Array.isArray(job.tags) ? job.tags.filter(t => t != null && String(t).trim()).map(String) : [],
  };
}

class UploadEngine {
  /**
   * @param {object} o
   * @param {object} o.cfg              settings.upload
   * @param {string} o.studioUrl
   * @param {string} o.runDir           where screenshots / run.log go
   * @param {(msg:string)=>void} [o.log]
   * @param {() => number} [o.rng]
   * @param {number} [o.speed=1]         multiplier for human pauses (tests use small values)
   */
  constructor(o) {
    this.cfg = o.cfg; this.studioUrl = o.studioUrl.replace(/\/$/, ''); this.runDir = o.runDir;
    this.log = o.log || (() => {}); this.rng = o.rng || Math.random; this.speed = o.speed ?? 1;
    this.onState = o.onState || (() => {});
    this.shotN = 0;
    fs.mkdirSync(this.runDir, { recursive: true });
  }

  async screenshot(page, tag) {
    const file = path.join(this.runDir, `${String(++this.shotN).padStart(2, '0')}-${tag.replace(/[^\w.-]+/g, '_')}.png`);
    try { await page.screenshot({ path: file, timeout: 10000 }); this.log(`screenshot ${path.basename(file)}`); return file; }
    catch (e) { this.log(`screenshot failed: ${e.message.split('\n')[0]}`); return null; }
  }

  async gotoStudio(page) {
    await page.goto(this.studioUrl, { waitUntil: 'domcontentloaded', timeout: this.cfg.stepTimeoutMs }).catch(e => this.log(`goto studio: ${e.message.split('\n')[0]}`));
  }

  async dismissDialogs(page, human) {
    let n = 0;
    for (let round = 0; round < 3; round++) {
      const btn = await firstVisible(page, SEL.dismiss);
      if (!btn) break;
      // never close the upload dialog itself during recovery
      const insideUpload = await btn.evaluate((el, roots) => roots.some(r => { try { return !!el.closest(r); } catch (_) { return false; } }), SEL.dialog.root).catch(() => false);
      if (insideUpload) break;
      try { await human.click(btn, { timeout: 5000 }); n++; } catch (_) { break; }
      await human.pause(400, 900);
    }
    if (!n) { try { await page.keyboard.press('Escape'); } catch (_) {} }
    return n;
  }

  async clickFirst(page, human, list, what, timeout = 15000) {
    const loc = await firstVisible(page, list, { timeout });
    if (!loc) throw new FatalUploadError(`Could not find ${what}`);
    await human.click(loc, { timeout });
  }

  async openUploadDialog(page, human) {
    const direct = await firstVisible(page, SEL.studio.dashboardUploadButton);
    if (direct && this.rng() < 0.5) { await human.click(direct); return; }
    await this.clickFirst(page, human, SEL.studio.createButton, 'Create button');
    await human.pause(300, 900);
    await this.clickFirst(page, human, SEL.studio.uploadMenuItem, '"Upload videos" menu item', 10000);
  }

  async setRadio(page, human, list, what) {
    const r = await firstVisible(page, list, { timeout: 8000 });
    if (!r) throw new FatalUploadError(`Could not find ${what}`);
    const checked = await r.getAttribute('aria-checked').catch(() => null);
    if (checked !== 'true') await human.click(r);
    await human.pause(150, 400);
    const now = await r.getAttribute('aria-checked').catch(() => null);
    if (now !== null && now !== 'true') { await r.click({ force: true }); }
  }

  async fillDetails(page, human, job) {
    const title = await firstVisible(page, SEL.details.titleBox, { timeout: this.cfg.stepTimeoutMs });
    if (!title) throw new FatalUploadError('Title box not found');
    await human.pause(500, 1500);
    await human.replaceText(title, job.title);
    // read back: Studio can auto-complete @mentions or drop characters; fix with a direct insert once
    const got = String((await title.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (got !== String(job.title || '').replace(/\s+/g, ' ').trim()) {
      this.log(`WARN title read-back mismatch ("${got.slice(0, 60)}"), re-inserting`);
      await title.click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText(job.title);
    }
    await human.pause(300, 900);
    const desc = await firstVisible(page, SEL.details.descriptionBox, { timeout: 8000 });
    if (desc) { await human.replaceText(desc, job.description || ''); } else this.log('WARN description box not found');
    await human.scrollALittle();
    if (job.thumb && fs.existsSync(job.thumb)) {
      const ti = await firstAttached(page, SEL.details.thumbnailInput);
      if (ti) { try { await ti.setInputFiles(job.thumb, { timeout: 10000 }); this.log('thumbnail set'); await human.pause(800, 1600); } catch (e) { this.log(`WARN thumbnail: ${e.message.split('\n')[0]}`); } }
      else this.log('WARN thumbnail input not found (channel may need phone verification for custom thumbnails)');
    }
    await human.scrollALittle();
    await this.setRadio(page, human, job.madeForKids ? SEL.details.kidsYes : SEL.details.kidsNo, 'made-for-kids radio');
    if (job.tags && job.tags.length) {
      let tagInput = await firstVisible(page, SEL.details.tagsInput);
      if (!tagInput) {
        const more = await firstVisible(page, SEL.details.showMore, { timeout: 5000 });
        if (more) { await human.click(more); await human.pause(500, 1200); }
        tagInput = await firstVisible(page, SEL.details.tagsInput, { timeout: 8000 });
      }
      if (tagInput) { await human.click(tagInput); await human.type(job.tags.join(',') + ','); await human.pause(300, 800); }
      else this.log('WARN tags input not found, skipping tags');
    }
  }

  async chooseVisibility(page, human, job) {
    const vis = job.visibility || 'PUBLIC';
    if (vis === 'SCHEDULE' && job.publishAt) {
      // best effort: Studio's scheduler widget (needs live verification)
      await this.clickFirst(page, human, SEL.visibility.scheduleExpand, 'Schedule section', 8000);
      const trig = await firstVisible(page, SEL.visibility.scheduleDateTrigger, { timeout: 5000 });
      if (trig) {
        await human.click(trig);
        const di = await firstVisible(page, SEL.visibility.scheduleDateInput, { timeout: 5000 });
        if (di) { await human.replaceText(di, new Date(job.publishAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })); await page.keyboard.press('Enter'); }
      }
      const ti = await firstVisible(page, SEL.visibility.scheduleTimeInput, { timeout: 5000 });
      if (ti) { await human.replaceText(ti, new Date(job.publishAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })); await page.keyboard.press('Enter'); }
      return;
    }
    await this.setRadio(page, human, SEL.visibility.radio(vis), `${vis} visibility radio`);
  }

  /** Wait until the file transfer is complete (or fails), bounded by deadline. */
  async waitUploadComplete(page, deadline) {
    const t0 = Date.now(); let last = '', lastChange = Date.now(), lastPct = null;
    const limit = Math.min(deadline, t0 + this.cfg.uploadCompleteTimeoutMs);
    while (Date.now() < limit) {
      const p = await readUploadProgress(page);
      if (p.failed) throw new FatalUploadError(`YouTube reported: ${p.text}`);
      if (p.complete) { this.log(`upload transfer complete (${p.text})`); return p; }
      if (!p.text && Date.now() - t0 > 15000) { this.log('WARN no progress label found, continuing'); return p; }
      if (p.text !== last || p.percent !== lastPct) { last = p.text; lastPct = p.percent; lastChange = Date.now(); if (p.text) this.log(`progress: ${p.text}`); }
      // progress frozen for a full step timeout = stuck upload
      if (Date.now() - lastChange > this.cfg.stepTimeoutMs) throw new StepTimeoutError(`upload progress "${last}"`, Date.now() - lastChange);
      await sleep(1500);
    }
    if (Date.now() >= deadline) throw new HardLimitError(this.cfg.channelHardLimitMs);
    throw new StepTimeoutError('upload transfer', Date.now() - t0);
  }

  /**
   * Upload one video. job = {file, thumb, title, description, tags[], madeForKids, visibility}
   * Returns {url, finalText}.
   */
  async uploadVideo(page, job, { deadline }) {
    job = normalizeJob(job);
    const human = new Human(page, { rng: this.rng, typing: this.cfg.typing, speed: this.speed });
    const st = { filesSet: false, detailsDone: false, visibilityDone: false, published: false, url: null, errors: 0 };
    let attempt = 0;
    const maxAttempts = Math.max(1, this.cfg.maxRetries);
    while (true) {
      attempt++;
      try {
        return await this._drive(page, human, job, st, deadline);
      } catch (e) {
        if (e.code === 'NEEDS_USER' || e.code === 'UPLOAD_LIMIT' || e.code === 'HARD_LIMIT') { await this.screenshot(page, e.code.toLowerCase()); throw e; }
        if (page.isClosed() && e.code !== 'NEW_TAB') { /* page gone: recover with a new tab below */ }
        this.log(`attempt ${attempt}/${maxAttempts} failed: ${e.message.split('\n')[0]}`);
        await this.screenshot(page, `fail-attempt${attempt}`).catch(() => {});
        if (attempt >= maxAttempts || Date.now() >= deadline) throw e;
        page = await this.recover(page, human, attempt, st);
        human.page = page;
      }
    }
  }

  /**
   * Duplicate safety before a retry: look in Studio's content list (Videos tab) for a video with the same
   * title or file name. Returns {checked, match?:{title, draft, url, videoId}, reason?}.
   * Best effort: the content-list selectors are NOT verified against live Studio (see selectors.js).
   */
  async findExisting(page, { channelId, title, filename }) {
    if (!channelId) return { checked: false, reason: 'channel id unknown' };
    const url = `${this.studioUrl}/channel/${channelId}/videos/upload`;
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.cfg.stepTimeoutMs }); }
    catch (e) { if (!/ERR_ABORTED|detached/i.test(e.message)) return { checked: false, reason: e.message.split('\n')[0] }; }
    const row = await firstVisible(page, SEL.content.row, { timeout: Math.min(15000, this.cfg.stepTimeoutMs) });
    if (!row) return { checked: false, reason: 'content list not found' };
    const rows = await page.evaluate(sel => {
      const out = [];
      for (const r of document.querySelectorAll(sel.row.join(','))) {
        const t = r.querySelector(sel.title.join(','));
        const a = r.querySelector(sel.link.join(','));
        const txt = (r.innerText || '').toLowerCase();
        out.push({ title: (t ? t.textContent : '').replace(/\s+/g, ' ').trim(), href: a ? a.getAttribute('href') : '', draft: sel.draftText.some(d => txt.includes(d)) });
      }
      return out;
    }, { row: SEL.content.row, title: SEL.content.title, link: SEL.content.link, draftText: SEL.text.draft }).catch(() => []);
    const norm = x => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const base = norm(String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, ''));
    const m = rows.find(r => norm(r.title) === norm(title) || (base && norm(r.title) === base));
    if (!m) return { checked: true, match: null, rows: rows.length };
    const id = (/\/video\/([\w-]{6,})/.exec(m.href || '') || [])[1] || null;
    return { checked: true, match: { title: m.title, draft: m.draft, videoId: id, url: id ? `https://youtu.be/${id}` : null } };
  }

  /** Recovery ladder. attempt 1: dismiss dialogs/escape and continue; 2: reload; 3+: fresh tab. */
  async recover(page, human, attempt, st) {
    try {
      if (attempt === 1 && !page.isClosed()) {
        this.log('recovery: dismiss dialogs and continue from current screen');
        await this.dismissDialogs(page, human);
        return page;
      }
      if (attempt === 2 && !page.isClosed()) {
        this.log('recovery: reload Studio');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: this.cfg.stepTimeoutMs }).catch(() => {});
        Object.assign(st, { filesSet: false, detailsDone: false, visibilityDone: false });
        return page;
      }
    } catch (_) { /* fall through to new tab */ }
    this.log('recovery: open a new tab');
    const ctx = page.context();
    const np = await ctx.newPage();
    try { if (!page.isClosed()) await page.close(); } catch (_) {}
    Object.assign(st, { filesSet: false, detailsDone: false, visibilityDone: false });
    await this.gotoStudio(np);
    return np;
  }

  async _drive(page, human, job, st, deadline) {
    let lastState = null, stateSince = Date.now(), sameStateActs = 0;
    const stepMs = this.cfg.stepTimeoutMs;
    while (true) {
      if (Date.now() >= deadline) throw new HardLimitError(this.cfg.channelHardLimitMs);
      const d = await detectState(page);
      if (d.state !== lastState) { this.log(`state: ${d.state}${d.detail ? ` (${d.detail})` : ''}`); this.onState(d.state); lastState = d.state; stateSince = Date.now(); sameStateActs = 0; }
      else if (Date.now() - stateSince > stepMs) throw new StepTimeoutError(d.state, Date.now() - stateSince);

      if (NEEDS_USER_STATES.has(d.state)) throw new NeedsUserError(d.state);
      switch (d.state) {
        case 'upload_limit': throw new UploadLimitError();
        case 'error_dialog': {
          st.errors++;
          if (st.errors > 6) throw new FatalUploadError(`Repeated error dialogs: ${d.detail}`);
          await this.screenshot(page, 'error-dialog');
          const n = await this.dismissDialogs(page, human);
          this.log(`dismissed error dialog (${n} clicks)`);
          await human.pause(800, 1500);
          continue;
        }
        case 'blank': case 'unknown':
          if (d.state === 'blank' || !/studio\.youtube\.com|\/studio/.test(d.url) || Date.now() - stateSince > 8000) {
            if (Date.now() - stateSince > 3000 || d.state === 'blank') { await this.gotoStudio(page); stateSince = Date.now(); }
          }
          await sleep(1000); continue;
        case 'loading': await sleep(1000); continue;
        case 'dashboard':
          if (st.published) {
            // done dialog was closed/never shown; the URL may already be known
            if (st.url) return { url: st.url, finalText: 'published (dialog closed)' };
            throw new FatalUploadError('Publish clicked but no confirmation dialog appeared');
          }
          if (sameStateActs++ > 2) throw new StepTimeoutError('dashboard (upload dialog does not open)', Date.now() - stateSince);
          await human.pause(600, 1800);
          await this.openUploadDialog(page, human);
          await sleep(1500);
          continue;
        case 'upload_dialog': {
          if (st.filesSet && sameStateActs++ < 10) { await sleep(1000); continue; }
          const input = await firstAttached(page, SEL.dialog.fileInput);
          if (!input) { await sleep(1000); continue; }
          await human.pause(400, 1200);
          await input.setInputFiles(job.file, { timeout: stepMs });
          st.filesSet = true; sameStateActs = 0;
          this.log(`file selected: ${path.basename(job.file)}`);
          await sleep(1500);
          continue;
        }
        case 'details':
          st.filesSet = true;
          if (!st.detailsDone) { await this.fillDetails(page, human, job); st.detailsDone = true; this.log('details filled'); }
          if (!st.url) st.url = await readVideoUrl(page);
          await this.next(page, human);
          continue;
        case 'elements': case 'checks':
          if (!st.url) st.url = await readVideoUrl(page);
          if (!st.detailsDone && d.state === 'elements') {
            // we got here without filling details (e.g. recovery landed mid-flow): go back
            const back = await firstVisible(page, SEL.dialog.backButton);
            if (back) { await human.click(back); await sleep(800); continue; }
          }
          await human.pause(500, 1500);
          await this.next(page, human);
          continue;
        case 'visibility':
          if (!st.detailsDone) { const back = await firstVisible(page, SEL.dialog.backButton); if (back) { await human.click(back); await sleep(800); continue; } }
          if (!st.visibilityDone) { await this.chooseVisibility(page, human, job); st.visibilityDone = true; this.log(`visibility set: ${job.visibility || 'PUBLIC'}`); }
          if (!st.url) st.url = await readVideoUrl(page);
          await this.waitUploadComplete(page, deadline);
          stateSince = Date.now();
          if (sameStateActs++ > 3) throw new StepTimeoutError('visibility (Publish does nothing)', Date.now() - stateSince);
          await human.pause(500, 1200);
          await this.clickFirst(page, human, SEL.dialog.doneButton, 'Publish/Save button');
          st.published = true;
          this.log('publish clicked');
          await sleep(2000);
          continue;
        case 'done': {
          const url = (await readVideoUrl(page)) || st.url;
          const text = await firstVisible(page, SEL.done.dialog).then(l => l && l.innerText()).catch(() => '') || '';
          if (!st.published) this.log('WARN done dialog without our publish click');
          if (/uploading|upload \d+%/i.test(text) && Date.now() - stateSince < stepMs) { await sleep(2000); continue; }
          if (!url) {
            if (Date.now() - stateSince < 10000) { await sleep(1000); continue; }
            throw new FatalUploadError('Published but could not read the video URL');
          }
          await this.screenshot(page, 'done');
          const close = await firstVisible(page, SEL.done.close);
          if (close) { await human.click(close).catch(() => {}); }
          return { url, finalText: text.replace(/\s+/g, ' ').trim().slice(0, 200) };
        }
        default: await sleep(1000);
      }
    }
  }

  async next(page, human) {
    const btn = await firstVisible(page, SEL.dialog.nextButton, { timeout: 10000 });
    if (!btn) throw new FatalUploadError('Next button not found');
    const disabled = await btn.evaluate(el => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true').catch(() => false);
    if (disabled) { await sleep(1500); return; }
    await human.click(btn);
    await sleep(900 * this.speed + 300);
  }
}

module.exports = { normalizeJob, UploadEngine, NeedsUserError, UploadLimitError, StepTimeoutError, HardLimitError, FatalUploadError, firstVisible };
