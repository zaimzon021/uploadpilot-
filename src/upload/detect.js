'use strict';
// Screen-state detector: one page.evaluate that looks at URL, visible elements and visible text.
const SEL = require('./selectors');

const STATES = ['google_login', 'verification', 'new_device', 'no_channel', 'upload_limit', 'error_dialog', 'done', 'visibility', 'checks', 'elements', 'details', 'upload_dialog', 'dashboard', 'loading', 'blank', 'unknown'];

const cssOnly = list => list.filter(s => !/:has-text|^text=|:text\(/.test(s));

function detectorPayload() {
  return {
    dialogRoot: cssOnly(SEL.dialog.root),
    filePicker: cssOnly(SEL.dialog.filePicker),
    details: cssOnly(SEL.dialog.detailsPane),
    titleBox: cssOnly(SEL.details.titleBox),
    elements: cssOnly(SEL.dialog.elementsPane),
    checks: cssOnly(SEL.dialog.checksPane),
    visibility: cssOnly(SEL.dialog.visibilityPane),
    doneDialog: cssOnly(SEL.done.dialog),
    create: cssOnly(SEL.studio.createButton),
    appRoot: cssOnly(SEL.studio.appRoot),
    email: cssOnly(SEL.google.emailInput),
    password: cssOnly(SEL.google.passwordInput),
    text: SEL.text,
  };
}

/* istanbul ignore next — runs in the browser */
function inPage(P) {
  const vis = el => {
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) return false;
    if (el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    // web-component hosts (e.g. ytcp-video-share-dialog) are often 0x0 with a fixed-position child
    const kids = el.querySelectorAll('*');
    for (let i = 0; i < Math.min(kids.length, 60); i++) {
      const k = kids[i], kr = k.getBoundingClientRect(), ks = getComputedStyle(k);
      if (kr.width > 0 && kr.height > 0 && ks.display !== 'none' && ks.visibility !== 'hidden') return true;
    }
    return false;
  };
  const any = list => list.some(s => { try { return [...document.querySelectorAll(s)].some(vis); } catch (_) { return false; } });
  const has = (hay, needles) => needles.some(n => hay.includes(n));
  const url = location.href;
  const lower = (document.body && document.body.innerText || '').toLowerCase().slice(0, 20000);
  // visible modal-ish dialogs (not the upload dialog itself)
  const dialogs = [...document.querySelectorAll('ytcp-dialog, tp-yt-paper-dialog, [role="dialog"], [role="alertdialog"], ytcp-error-dialog, .error-dialog')]
    .filter(vis).filter(d => !d.matches(P.dialogRoot.join(',')) && !d.closest(P.dialogRoot.join(',')) && !d.closest(P.doneDialog.join(',')) && !d.querySelector(P.dialogRoot.join(',')));
  const dialogText = dialogs.map(d => (d.innerText || '').toLowerCase()).join(' \n ');
  const spinner = [...document.querySelectorAll('tp-yt-paper-spinner, tp-yt-paper-spinner-lite, ytcp-spinner, .spinner, [role="progressbar"]')].some(vis);
  const r = (state, detail = '') => ({ state, detail, url });

  if (!document.body || url === 'about:blank') return r('blank');
  const host = location.hostname;
  if (/\/sorry\/|recaptcha|\/challenge\/(ipp|sk|dp|recaptcha|iap|selection|pwd)|speedbump|deniedsigninrejected/i.test(url) || [...document.querySelectorAll('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"]')].some(vis) || (has(lower, P.text.verification) && !any(P.appRoot)) || (dialogText && has(dialogText, P.text.verification))) {
    if (has(lower, P.text.newDevice) && !has(lower, P.text.verification)) return r('new_device');
    return r('verification');
  }
  if (/\/challenge\//i.test(url) || (has(lower, P.text.newDevice) && !any(P.appRoot))) return r('new_device');
  if (host.startsWith('accounts.google.') || /ServiceLogin|\/signin\/|\/v3\/signin|AccountChooser/i.test(url) || any(P.email) || (any(P.password) && !any(P.appRoot))) return r('google_login');
  if (dialogText && has(dialogText, P.text.uploadLimit)) return r('upload_limit');
  if (dialogText && has(dialogText, P.text.errorDialog)) return r('error_dialog', dialogText.slice(0, 160));
  if (any(P.doneDialog)) return r('done');
  if (any(P.dialogRoot)) {
    if (any(P.visibility)) return r('visibility');
    if (any(P.checks)) return r('checks');
    if (any(P.elements)) return r('elements');
    if (any(P.details) || any(P.titleBox)) return r('details');
    if (any(P.filePicker)) return r('upload_dialog');
    return r('loading', 'upload dialog without a known step');
  }
  if (any(P.create)) return r('dashboard');
  if (has(lower, P.text.noChannel) && !any(P.appRoot)) return r('no_channel');
  if (spinner) return r('loading');
  return r('unknown', (document.title || '').slice(0, 80));
}

async function detectState(page) {
  try { return await page.evaluate(inPage, detectorPayload()); }
  catch (e) { return { state: 'loading', detail: `evaluate failed: ${e.message.split('\n')[0]}`, url: (() => { try { return page.url(); } catch (_) { return ''; } })() }; }
}

/** Read upload progress text from the dialog: {text, percent, complete, failed} */
async function readUploadProgress(page) {
  return page.evaluate(P => {
    const vis = el => el && el.getClientRects().length > 0 && !el.closest('[hidden]');
    let text = '';
    for (const s of P.sel) { const el = [...document.querySelectorAll(s)].find(vis); if (el && el.innerText.trim()) { text = el.innerText.trim(); break; } }
    const lower = text.toLowerCase();
    const m = /(\d{1,3})\s*%/.exec(lower);
    const percent = m ? +m[1] : null;
    const failed = P.failed.some(t => lower.includes(t));
    const complete = !failed && (P.complete.some(t => lower.includes(t)) && !/uploading/.test(lower) || percent === 100 && !/uploading/.test(lower));
    return { text, percent, complete, failed };
  }, { sel: cssOnly(SEL.dialog.progressLabel), complete: SEL.text.uploadComplete, failed: SEL.text.uploadFailed }).catch(() => ({ text: '', percent: null, complete: false, failed: false }));
}

async function readVideoUrl(page) {
  return page.evaluate(sels => {
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        const href = el.getAttribute('href') || el.textContent || '';
        const m = /https?:\/\/(?:youtu\.be\/|(?:www\.)?youtube\.com\/(?:watch\?v=|shorts\/))([\w-]{6,})/.exec(href.trim());
        if (m) return href.trim();
      }
    }
    return null;
  }, [...cssOnly(SEL.done.url), ...cssOnly(SEL.dialog.videoUrl)]).catch(() => null);
}

module.exports = { detectState, readUploadProgress, readVideoUrl, STATES, cssOnly };
