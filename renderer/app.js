'use strict';
/* UploadPilot renderer: plain JS, talks to the local API (127.0.0.1) with the session token. */
let API = '', TOKEN = '';
const main = document.getElementById('main');
const modal = document.getElementById('modal');
const state = { page: 'dashboard', channelId: null, events: [], timer: null, link: null };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#7c3aed', '#0891b2', '#1d4ed8', '#be123c', '#15803d', '#c2410c', '#a16207', '#4d7c0f', '#9333ea', '#0e7490'];
const initials = n => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const avatar = (name, id) => `<span class="av" style="background:${COLORS[(id || 0) % COLORS.length]}">${esc(initials(name))}</span>`;

async function api(method, path, body) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', 'X-UploadPilot-Token': TOKEN }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({ code: res.status, message: res.statusText }));
  if (j.code !== 0) throw new Error(j.message || `HTTP ${res.status}`);
  return j.data;
}
function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 4500);
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  if (ts <= Date.now() && diff === 0) return 'now';
  if (diff === 0) return hm;
  if (diff === 1) return `tomorrow ${hm}`;
  if (diff === -1) return `yesterday ${hm}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm;
}
const toLocalInput = ts => { if (!ts) return ''; const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

const tip = t => `<span class="tip" title="${esc(t)}">?</span>`;
const hm = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function statusPill(c) {
  if (c.live) return `<span class="pill b">${c.live.state === 'opening' ? 'Opening profile' : c.live.state === 'writing' ? 'Writing titles' : 'Uploading'}</span>`;
  const map = { active: ['g', 'Live'], stopped: ['gr', 'Stopped'], paused: ['gr', 'Paused'], needs_you: ['r', 'Needs you'], linking: ['y', 'Linking'] };
  const [cls, label] = map[c.status] || ['gr', c.status];
  if (c.status === 'active' && c.paused_until && c.paused_until > Date.now()) return `<span class="pill y" title="${esc(c.status_reason)}">Limit — resumes ${fmtTime(c.paused_until)}</span>`;
  if (c.status === 'active' && c.login_state === 'signed_out') return `<span class="pill r">Sign in needed</span>`;
  if (c.status === 'active' && c.awaiting) return `<span class="pill y">Waiting approval</span>`;
  return `<span class="pill ${cls}" title="${esc(c.status_reason || '')}">${label}${c.status === 'needs_you' && c.status_reason ? ' · ' + esc(c.status_reason) : ''}</span>`;
}
const videoPill = v => {
  if (v.status === 'ready' && v.retry_at && v.retry_at > Date.now()) return `<span class="pill y" title="${esc(v.error || '')}">Retrying at ${hm(v.retry_at)} (attempt ${v.retry_count}/3)</span>`;
  const m = { queued: ['gr', 'Queued'], ai: ['b', 'AI writing'], awaiting_approval: ['y', 'Needs your OK'], ready: ['g', 'Ready'], uploading: ['b', 'Uploading'], done: ['g', 'Published'], failed: ['r', 'Failed'], missing: ['r', 'File missing'], skipped: ['gr', 'Skipped'] };
  const [c, l] = m[v.status] || ['gr', v.status];
  return `<span class="pill ${c}" title="${esc(v.error || v.ai_error || '')}">${l}${v.status === 'queued' && v.ai_status === 'failed' ? ' · AI failed' : ''}</span>`;
};
const videoNote = v => (v.error && ['failed', 'ready'].includes(v.status) && (v.retry_at || v.status === 'failed')) ? `<div class="r-text small" style="margin-top:4px" title="${esc(v.error)}">${esc(String(v.error).split('\n')[0].slice(0, 90))}</div>` : '';

// ---------------------------------------------------------------- navigation
function nav(page, channelId) {
  state.editing = 0;   // a click to another page always redraws
  state.page = page; state.channelId = channelId ?? null;
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.page === page || (page === 'channel' && a.dataset.page === 'channels')));
  render();
}
window.__nav = nav;
document.querySelectorAll('.nav a').forEach(a => a.addEventListener('click', () => nav(a.dataset.page)));

async function render() {
  if (state.editing && Date.now() - state.editing < 4000 && state.page === 'channel') return;   // don't redraw under your cursor
  try {
    if (state.page === 'dashboard') await renderDashboard();
    else if (state.page === 'channels') await renderChannels();
    else if (state.page === 'channel') await renderChannel(state.channelId);
    else if (state.page === 'settings') await renderSettings();
  } catch (e) { main.innerHTML = `<div class="card r">Could not load: ${esc(e.message)}</div>`; }
}
function cloudLine(c, d) {
  if (!c) return '';
  const map = { online: ['g', 'Synced'], connecting: ['y', 'Connecting'], signed_out: ['gr', 'Signed out'], offline: ['gr', 'Offline'], unconfigured: ['gr', 'Local only'], error: ['r', 'Error'] };
  const [cls, l] = map[c.state] || ['gr', c.state];
  return `<span class="pill ${cls}">${l}</span> <span class="muted small">${esc(c.state === 'online' ? (c.email || '') : 'this PC only')}</span><div class="muted small" style="margin-top:4px">${esc(c.pcName || '')}${d && d.activeOn ? ` · active: ${esc(d.activeIsMe ? 'this PC' : d.activeOn)}` : ''}</div>`;
}
async function refreshSide() {
  try {
    const d = await api('GET', '/dashboard');
    const cl = document.getElementById('cloudLine'); if (cl) cl.innerHTML = cloudLine(d.cloud, d);
    document.getElementById('keysLine').innerHTML = `Gemini · ${d.ai.keys} key${d.ai.keys === 1 ? '' : 's'} <span class="pill ${d.ai.keys ? 'g' : 'r'}">${d.ai.keys ? 'OK' : 'Add keys'}</span>`;
    document.getElementById('keysCalls').textContent = `${d.ai.callsToday} calls today${d.ai.errorsToday ? ` · ${d.ai.errorsToday} errors` : ''}`;
    return d;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- "Needs you": one click fixes
async function doAction(action, arg) {
  switch (action) {
    case 'open-profile': toast('Opening profile…'); { const r = await api('POST', `/channels/${arg}/open-profile`); toast(r.signIn ? 'Sign in to Google in the window, then press Resume' : 'Profile window opened'); } break;
    case 'resume': await api('POST', `/channels/${arg}/resume`); toast('Resumed'); break;
    case 'retry': await api('POST', `/videos/${arg}/retry`); toast('Will upload at the next free slot'); break;
    case 'takeover': await takeOverFlow(); break;
    case 'signin': showSignIn(true); return;
    case 'unlock': showUnlock(); return;
    case 'start-fresh': showUnlock(true); return;
    case 'legacy': { const p = prompt('Your old sync passphrase (from version 0.3.0):'); if (!p) return; await api('POST', '/cloud/legacy-passphrase', { passphrase: p }); toast('Done — old logins are readable on every PC'); } break;
    case 'drive': await api('POST', '/cloud/drive/connect'); toast('Finish in the browser: pick the Google account for Drive'); break;
    case 'settings': nav('settings'); return;
    case 'channel': nav('channel', arg); return;
    default: break;
  }
  render();
}
function needsList(items) {
  if (!items || !items.length) return '';
  return `<div class="card needs" style="margin-bottom:16px"><b>Needs you</b>${items.map(i => `<div class="need ${i.level}"><span>${esc(i.text)}</span><span class="actions">${i.actions.map(a => `<button class="btn sm ${a.action === 'start-fresh' ? 'ghost' : ''}" data-act="${esc(a.action)}" data-arg="${esc(a.arg ?? '')}">${esc(a.label)}</button>`).join('')}</span></div>`).join('')}</div>`;
}
function bindActions(root) {
  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', guard(async e => { e.stopPropagation(); b.disabled = true; try { await doAction(b.dataset.act, b.dataset.arg === '' ? undefined : b.dataset.arg); } finally { b.disabled = false; } })));
}

// ---------------------------------------------------------------- dashboard
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
function feedItem(e) {
  const cls = { success: 'g', error: 'r', warn: 'y', info: 'b' }[e.level] || 'gr';
  return `<div class="item"><span class="pill ${cls}">${hm(e.ts)}</span> ${e.pc_name ? `<span class="pill gr">${esc(e.pc_name)}</span> ` : ''}<span class="muted">${esc(e.message)}</span></div>`;
}
function channelRows(chans, compact, showPc) {
  const cols = 6 + (compact ? 0 : 2) + (showPc ? 1 : 0);
  if (!chans.length) return `<tr><td colspan="${cols}" class="muted" style="padding:30px;text-align:center">No channels yet. Click <b>+ Link channel</b> to add your first one.</td></tr>`;
  return chans.map(c => {
    const pct = c.planned_today ? Math.round(100 * c.done_today / c.planned_today) : 0;
    const next = c.status === 'needs_you' || c.login_state === 'signed_out' ? `<button class="btn link" data-act="open-profile" data-arg="${c.id}">Sign in ›</button>` : (c.status === 'active' ? fmtTime(c.next_upload) : '—');
    return `<tr class="click" data-ch="${c.id}"><td>${avatar(c.name, c.id)}${esc(c.name || 'Unnamed')}${c.handle ? ` <span class="muted small">${esc(c.handle)}</span>` : ''}</td>
      <td>${statusPill(c)}</td>
      ${compact ? '' : `<td class="muted">#${c.profile_number ?? '—'}</td>`}
      <td class="muted">${esc(c.proxy || '—')}</td>
      <td><span class="bar"><i style="width:${pct}%"></i></span>${c.done_today}/${c.planned_today}</td>
      <td>${c.queue}</td><td>${next}${c.status === 'active' && c.next_video ? `<div class="muted small" title="${esc(c.next_video.title)}">${esc(String(c.next_video.title).slice(0, 34))}</div>` : ''}</td>
      ${showPc ? `<td>${c.running_on ? `<span class="pill ${c.running_on.me ? 'b' : 'y'}">${c.running_on.me ? 'this PC' : esc(c.running_on.pcName)}</span>` : `<span class="muted small">${c.folder_pc_name ? 'files on ' + esc(c.folder_pc_name) : '—'}</span>`}</td>` : ''}
      ${compact ? '' : `<td><div class="actions row-actions">
        <button class="btn ghost sm" data-act="open-profile" data-arg="${c.id}">Open profile</button>
        ${c.status === 'active' ? `<button class="btn ghost sm" data-stop="${c.id}">Stop</button>` : c.status !== 'linking' ? `<button class="btn sm" data-act="resume" data-arg="${c.id}">Resume</button>` : ''}
      </div></td>`}</tr>`;
  }).join('');
}
function bindChannelRows(root) {
  root.querySelectorAll('tr[data-ch]').forEach(tr => tr.addEventListener('click', e => {
    if (e.target.closest('.row-actions, button, a')) return;   // buttons in the row never open the channel page
    nav('channel', +tr.dataset.ch);
  }));
  // CSP (script-src 'self') blocks inline onclick, so stop the row click with a real listener
  root.querySelectorAll('.row-actions').forEach(el => el.addEventListener('click', e => e.stopPropagation()));
  root.querySelectorAll('[data-stop]').forEach(b => b.addEventListener('click', guard(async e => { e.stopPropagation(); await api('POST', `/channels/${b.dataset.stop}/stop`); render(); })));
  bindActions(root);
}

async function renderDashboard() {
  const [d, chans, evs] = await Promise.all([refreshSide(), api('GET', '/channels'), api('GET', '/events?limit=40')]);
  state.events = evs; state.dash = d;
  const nextIn = d.nextUpload ? Math.round((d.nextUpload - Date.now()) / 60000) : null;
  const ap = d.autopilot.paused ? 'autopilot is paused' : !d.activeIsMe ? `standing by (active on ${esc(d.activeOn || 'another PC')})` : d.autopilot.userActive ? 'waiting while you use the PC' : !d.autopilot.inWindow ? `outside the upload window (${d.autopilot.window.start}–${d.autopilot.window.end})` : 'autopilot is on';
  const showPc = d.pcCount > 1;
  main.innerHTML = `
  <div class="head"><div><h1>${greeting()}</h1><div class="sub">${new Date().toLocaleDateString([], { weekday: 'long' })} · ${ap}${nextIn !== null && !d.autopilot.paused && d.activeIsMe ? `, next upload ${nextIn <= 0 ? 'due now' : nextIn < 120 ? `in ${nextIn} min` : fmtTime(d.nextUpload)}` : ''}${d.activeOn ? ` · <span class="pill ${d.activeIsMe ? 'g' : 'y'}">Active on: ${esc(d.activeOn)}</span>` : ''}</div></div>
    <div><button class="btn ghost" id="pauseBtn">${d.autopilot.paused ? '▶ Resume autopilot' : '❚❚ Pause autopilot'}</button> <button class="btn" id="linkBtn">+ Link channel</button></div></div>
  <div class="row" style="margin-bottom:18px">
    <div class="card stat" style="flex:1"><div class="muted">Channels</div><div class="num">${d.channels}</div><div class="muted" style="margin-top:4px">${d.connected} connected</div></div>
    <div class="card stat" style="flex:1"><div class="muted">Published today</div><div class="num">${d.publishedToday}</div><div style="color:#4ade80;margin-top:4px">of ${d.plannedToday} planned</div></div>
    <div class="card stat" style="flex:1"><div class="muted">In queue</div><div class="num">${d.inQueue}</div><div class="muted" style="margin-top:4px">${(d.autopilot.lanes || []).filter(l => l.state === 'running').length} lane(s) busy</div></div>
    <div class="card stat" style="flex:1;${d.needsYou ? 'border-color:#5a2222' : ''}"><div class="muted">Needs you</div><div class="num" style="${d.needsYou ? 'color:#f87171' : ''}">${d.needsYou}</div><div class="muted" style="margin-top:4px">${d.needsYou ? 'see below' : 'all good'}</div></div>
  </div>
  ${needsList(d.needsYouItems)}
  <div class="row">
    <div class="card" style="flex:2.3;min-width:0">
      <div class="head" style="margin-bottom:6px"><b>Channels</b><input id="search" placeholder="Search channels…" style="width:220px;padding:6px 10px"></div>
      <table id="chTable"><thead><tr><th>Channel</th><th>Status</th><th>Proxy</th><th>Uploaded today</th><th>Queue</th><th>Next video</th>${showPc ? '<th>PC</th>' : ''}</tr></thead><tbody>${channelRows(chans, true, showPc)}</tbody></table>
    </div>
    <div class="card" style="flex:1;min-width:280px"><b>Live activity</b><div class="feed" id="feed">${evs.map(feedItem).join('') || '<div class="muted">Nothing yet.</div>'}</div></div>
  </div>`;
  bindChannelRows(main);
  document.getElementById('linkBtn').onclick = () => openLink();
  document.getElementById('pauseBtn').onclick = guard(async () => { await api('POST', d.autopilot.paused ? '/autopilot/resume' : '/autopilot/pause'); render(); });
  document.getElementById('search').oninput = e => { const q = e.target.value.toLowerCase(); document.querySelectorAll('#chTable tbody tr').forEach(tr => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; }); };
}

// ---------------------------------------------------------------- channels
async function renderChannels() {
  const [chans, d] = await Promise.all([api('GET', '/channels'), api('GET', '/dashboard')]);
  const showPc = d.pcCount > 1;
  main.innerHTML = `<div class="head"><div><h1>Channels</h1><div class="sub">${chans.length} linked${d.activeOn ? ` · Active on: ${esc(d.activeOn)}` : ''}</div></div><button class="btn" id="linkBtn">+ Link channel</button></div>
  <div class="card"><table><thead><tr><th>Channel</th><th>Status</th><th>Profile</th><th>Proxy</th><th>Today</th><th>Queue</th><th>Next video</th>${showPc ? '<th>PC</th>' : ''}<th></th></tr></thead><tbody>${channelRows(chans, false, showPc)}</tbody></table></div>`;
  bindChannelRows(main);
  document.getElementById('linkBtn').onclick = () => openLink();
}

// ---------------------------------------------------------------- autosave helper
/**
 * Save a field by itself: while typing (debounced ~800 ms), and at once on change / blur.
 * Shows "Saving…" then a small "Saved ✓" next to the field.
 */
function autosave(el, save, { delay = 800, mark = null } = {}) {
  let t = null, last = el.type === 'checkbox' ? el.checked : el.value, busy = Promise.resolve();
  const badge = mark || (() => { const s = document.createElement('span'); s.className = 'saved'; el.insertAdjacentElement('afterend', s); return s; })();
  const run = () => {
    clearTimeout(t);
    const v = el.type === 'checkbox' ? el.checked : el.value;
    if (v === last) return busy;
    last = v; badge.textContent = 'Saving…'; badge.className = 'saved on';
    busy = busy.then(() => save(v)).then(() => { badge.textContent = 'Saved ✓'; badge.className = 'saved on ok'; setTimeout(() => { badge.className = 'saved'; }, 1800); })
      .catch(e => { badge.textContent = '⚠ ' + e.message; badge.className = 'saved on err'; last = null; });
    return busy;
  };
  el.addEventListener('input', () => { state.editing = Date.now(); clearTimeout(t); t = setTimeout(run, delay); });
  el.addEventListener('change', run);
  el.addEventListener('blur', run);
  return run;
}

// ---------------------------------------------------------------- channel detail (everything autosaves)
async function renderChannel(id) {
  const [c, vids, runs] = await Promise.all([api('GET', `/channels/${id}`), api('GET', `/channels/${id}/videos`), api('GET', `/channels/${id}/runs`)]);
  const st = c.style || {};
  main.innerHTML = `
  <div class="head"><div><h1>${avatar(c.name, c.id)}${esc(c.name || 'Channel')}</h1><div class="sub">${esc(c.handle || '')} · profile #${c.profile_number ?? '—'} · proxy ${esc(c.proxy || '—')} · ${statusPill(c)}</div></div>
    <div class="actions"><button class="btn ghost" data-act="open-profile" data-arg="${c.id}">Open profile</button>${c.status === 'active' ? '<button class="btn ghost" id="stopB">Stop</button>' : `<button class="btn" data-act="resume" data-arg="${c.id}">Resume</button>`}<button class="btn ghost" id="scanB">Rescan folder</button></div></div>
  ${c.status_reason && c.status !== 'active' ? `<div class="card" style="margin-bottom:14px;border-color:#5a2222">${esc(c.status_reason)}</div>` : ''}
  <div class="card" style="margin-bottom:16px"><h2>Plan (${vids.length}) <span class="muted small" style="font-weight:normal">— changes save by themselves ${tip('Edit a time, title, description or tags: it is saved when you stop typing and takes effect at once. A time in the past or "Now" uploads at the next free slot. Titles are written by Gemini as soon as a video is found; a video without one gets it right before its upload.')}</span></h2>
    <table class="plan"><thead><tr><th>Video</th><th style="width:240px">Date / time</th><th>Status</th><th>Title</th><th></th></tr></thead><tbody>
    ${vids.map(v => {
      const locked = ['uploading', 'done'].includes(v.status);
      return `<tr data-v="${v.id}"><td><div>${esc(v.filename)}</div><div class="muted small">${v.thumb ? '🖼 thumbnail' : 'no thumbnail'}${v.url ? ` · <a href="${esc(v.url)}" target="_blank">${esc(v.url)}</a>` : ''}</div></td>
        <td>${locked ? fmtTime(v.uploaded_at || v.scheduled_at) : `<div style="display:flex;gap:6px;align-items:center"><input type="datetime-local" class="vWhen" value="${toLocalInput(v.scheduled_at)}"><button class="btn ghost sm vNow" title="Upload at the next free slot">Now</button></div>`}</td>
        <td class="vPill">${videoPill(v)}${videoNote(v)}</td>
        <td style="min-width:300px">${locked ? esc(v.title || '') : `<input class="inline-title vTitle" maxlength="100" value="${esc(v.title || '')}" placeholder="${v.status === 'ai' ? 'Gemini is watching the video…' : 'Gemini writes this (or type your own)'}">
          <details><summary class="muted small" style="cursor:pointer">description · tags</summary><textarea class="vDesc" placeholder="Description">${esc(v.description || '')}</textarea><input class="vTags" style="margin-top:6px" placeholder="tags, comma separated" value="${esc((v.tags || []).join(', '))}"><input class="vHash" style="margin-top:6px" placeholder="#hashtags" value="${esc((v.hashtags || []).join(' '))}"></details>`}</td>
        <td><div class="actions">${v.status === 'awaiting_approval' ? '<button class="btn sm vOk">Approve</button>' : ''}${['failed', 'missing', 'skipped'].includes(v.status) ? '<button class="btn ghost sm vRetry">Retry</button>' : ''}${!locked && v.status !== 'skipped' ? '<button class="btn ghost sm vSkip">Skip</button>' : ''}</div></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No videos found in the folder yet.</td></tr>'}
    </tbody></table></div>
  <div class="row">
    <div class="card" style="flex:1"><h2>Style <span class="muted small" style="font-weight:normal">— saves by itself</span></h2>
      <div class="field"><label>What's this channel about? ${tip('Niche and tone. Gemini follows it for every title, description and tag set.')}</label><textarea id="sNiche">${esc(st.niche)}</textarea></div>
      <div class="grid3"><div class="field"><label>Language</label><input id="sLang" value="${esc(st.language || 'English')}"></div>
        <div class="field"><label>AI titles ${tip('Auto: uploads without asking. Approval: each video waits for your OK.')}</label><select id="sMode"><option value="auto">Auto-publish</option><option value="approval" ${st.mode === 'approval' ? 'selected' : ''}>Approval first</option></select></div>
        <div class="field"><label>Made for kids</label><select id="sKids"><option value="no">No</option><option value="yes" ${st.madeForKids ? 'selected' : ''}>Yes</option></select></div></div>
      <div class="field"><label>Description footer ${tip('Added under every description.')}</label><textarea id="sFooter" style="min-height:60px">${esc(st.footer)}</textarea></div>
      <div class="grid2"><div class="field"><label>Fixed hashtags</label><input id="sTags" value="${esc(st.hashtags)}" placeholder="#shorts #fails"></div>
        <div class="field"><label>Videos per day ${tip('Blank = the default from Settings.')}</label><input id="sPer" type="number" min="1" max="20" value="${st.perDay || ''}"></div></div>
      <div class="field"><label>Folder</label><div style="display:flex;gap:8px"><input id="sFolder" value="${esc(c.folder || '')}"><button class="btn ghost" id="browse">Browse</button></div></div>
    </div>
    <div class="card" style="width:340px"><h2>Recent runs</h2>${runs.slice(0, 8).map(r => `<div style="margin-bottom:10px"><span class="pill ${r.result === 'ok' ? 'g' : r.result === 'running' ? 'b' : r.result === 'nothing_due' ? 'gr' : 'r'}">${esc(r.result)}</span> <span class="muted small">${new Date(r.started_at).toLocaleString()} · lane ${r.lane + 1}</span><div class="muted small">${esc(r.detail || '')}</div>${r.log_dir ? `<button class="btn link small" data-path="${esc(r.log_dir)}">Logs &amp; screenshots ›</button>` : ''}</div>`).join('') || '<div class="muted">No runs yet.</div>'}</div>
  </div>`;
  const $ = s => document.getElementById(s);
  bindActions(main);
  if ($('stopB')) $('stopB').onclick = guard(async () => { await api('POST', `/channels/${id}/stop`); render(); });
  $('scanB').onclick = guard(async () => { const r = await api('POST', `/channels/${id}/scan`); toast(`${r.added} new video(s)`); render(); });
  const saveStyle = () => api('PATCH', `/channels/${id}`, { style: { niche: $('sNiche').value, language: $('sLang').value, mode: $('sMode').value, madeForKids: $('sKids').value === 'yes', footer: $('sFooter').value, hashtags: $('sTags').value, perDay: $('sPer').value ? +$('sPer').value : null } });
  for (const f of ['sNiche', 'sLang', 'sMode', 'sKids', 'sFooter', 'sTags', 'sPer']) autosave($(f), saveStyle);
  const saveFolder = autosave($('sFolder'), v => api('PATCH', `/channels/${id}`, { folder: v.trim() || undefined }), { delay: 1500 });
  $('browse').onclick = guard(async () => { const f = await window.uploadpilot.pickFolder(); if (f) { $('sFolder').value = f; await saveFolder(); } });
  main.querySelectorAll('[data-path]').forEach(b => b.onclick = () => window.uploadpilot.openPath(b.dataset.path));
  main.querySelectorAll('tr[data-v]').forEach(tr => {
    const vid = tr.dataset.v, q = s => tr.querySelector(s);
    const after = v => { if (v) { const cell = q('.vPill'); if (cell) cell.innerHTML = videoPill(v) + videoNote(v); } };
    const patch = body => api('PATCH', `/videos/${vid}`, body).then(after);
    if (q('.vWhen')) {
      const runWhen = autosave(q('.vWhen'), v => patch({ scheduled_at: v ? new Date(v).toISOString() : null }), { delay: 800 });
      q('.vNow').onclick = guard(async () => { await patch({ scheduled_at: 'now' }); toast('Uploads at the next free slot'); state.editing = 0; render(); void runWhen; });
    }
    if (q('.vTitle')) autosave(q('.vTitle'), v => patch({ title: v }));
    if (q('.vDesc')) autosave(q('.vDesc'), v => patch({ description: v }));
    if (q('.vTags')) autosave(q('.vTags'), v => patch({ tags: v }));
    if (q('.vHash')) autosave(q('.vHash'), v => patch({ hashtags: v }));
    if (q('.vOk')) q('.vOk').onclick = guard(async () => { await api('POST', `/videos/${vid}/approve`); render(); });
    if (q('.vRetry')) q('.vRetry').onclick = guard(async () => { await api('POST', `/videos/${vid}/retry`); render(); });
    if (q('.vSkip')) q('.vSkip').onclick = guard(async () => { await api('POST', `/videos/${vid}/skip`); render(); });
  });
}

// ---------------------------------------------------------------- settings: simple main view + one collapsed "Advanced"
async function renderSettings() {
  const [s, cs] = await Promise.all([api('GET', '/settings'), api('GET', '/cloud/status')]);
  const b = s.cloud.backup, drive = cs.drive;
  const online = cs.state === 'online';
  const acct = online
    ? `<div>Signed in as <b>${esc(cs.user.email)}</b> <span class="pill g">Synced</span> <button class="btn ghost sm" id="cSignOut">Sign out</button></div>
       <div class="muted small" style="margin-top:6px">Active PC: <b>${esc((cs.activePc && cs.activePc.activePcName) || '—')}</b>${cs.activePc && !cs.activePc.me && cs.activePc.other ? ' <button class="btn sm" data-act="takeover">Take over</button>' : ''}</div>`
    : `<div><span class="pill gr">${cs.state === 'offline' ? 'Offline (this PC only)' : cs.state === 'unconfigured' ? 'Not configured' : 'Signed out'}</span> ${cs.configured ? '<button class="btn sm" id="cSignIn">Sign in</button>' : ''}</div>`;
  main.innerHTML = `<h1>Settings</h1><div class="sub">Everything saves by itself.</div>
  <div class="row">
    <div class="card" style="flex:1">
      <h2>Gemini ${tip('Writes titles, descriptions and tags. Get a free key at aistudio.google.com. Keys follow your account to every PC.')}</h2>
      <div class="field"><label id="keysLabel">API keys, one per line — ${s.geminiKeyCount} saved</label><textarea id="keys" placeholder="${esc(s.geminiKeys.join('\n') || 'AIza…')}"></textarea></div>
      <button class="btn ghost" id="testG">Test</button> <span class="muted small">model: <span id="modelName">${esc(s.geminiModel)}</span></span>
      <div id="gOut" class="muted small" style="margin-top:8px"></div>
      <h2 style="margin-top:22px">Proxies ${tip('SOCKS5, one per line: host:port:user:pass. Each channel gets its own. Passwords of saved proxies show as ••••; lines you leave unchanged keep their password.')}</h2>
      <div class="field"><textarea id="proxies" style="min-height:150px" placeholder="1.2.3.4:1080:user:pass">${esc(s.proxyPoolText)}</textarea><div id="proxyState" class="muted small" style="margin-top:6px"></div></div>
      <button class="btn ghost" id="checkAll">Check</button><div id="checkOut" class="muted" style="margin-top:10px;line-height:1.9"></div>
    </div>
    <div class="card" style="flex:1">
      <h2>Uploads</h2>
      <div class="grid2">
        <div class="field"><label>Upload window from ${tip('Uploads only start inside this window (your PC\'s local time).')}</label><input id="wStart" type="time" value="${s.uploadWindow.start}"></div>
        <div class="field"><label>to</label><input id="wEnd" type="time" value="${s.uploadWindow.end === '24:00' ? '23:59' : s.uploadWindow.end}"></div>
        <div class="field"><label>Uploads per channel per day ${tip('Default for every channel; a channel can override it.')}</label><input id="perDay" type="number" min="1" max="50" value="${s.videosPerDay}"></div>
      </div>
      <h2 style="margin-top:8px">Account</h2>
      <div class="field">${acct}</div>
      <div class="field"><label>This PC's name ${tip('Shown on your other PCs.')}</label><input id="cPcName" value="${esc(s.cloud.pcName)}"></div>
      <div class="field"><label>Google Drive ${tip('Connect once for the whole account. It carries the Google logins between PCs and (optionally) backups of your videos.')} ${drive.connected ? `<span class="pill g">connected${drive.account ? ' · ' + esc(drive.account) : ''}</span>` : '<span class="pill y">not connected</span>'}</label>
        ${drive.connected ? '<button class="btn ghost sm" id="cDriveOff">Disconnect</button>' : `<button class="btn" data-act="drive" ${online ? '' : 'disabled'}>Connect Google Drive</button>`}</div>
      <div class="field"><label><input type="checkbox" id="cBk" style="width:auto" ${b.enabled ? 'checked' : ''}> Back up videos to Drive ${tip('So another PC can upload them if this one is off. Runs at night, never during a YouTube upload.')}</label></div>
    </div>
  </div>
  <details class="card adv" style="margin-top:16px" id="adv"><summary><b>Advanced</b> <span class="muted small">— only if you know you need it</span></summary>
    <div class="row" style="margin-top:12px">
      <div style="flex:1">
        <div class="grid2">
          <div class="field"><label>Lanes ${tip('Channels uploading at the same time on this PC.')}</label><input id="lanes" type="number" min="1" max="20" value="${s.lanes}"></div>
          <div class="field"><label>Gemini model</label><input id="model" value="${esc(s.geminiModel)}"></div>
          <div class="field"><label>Autopilot windows</label><select id="wmode">${[['minimized', 'Minimized'], ['offscreen', 'Off-screen'], ['normal', 'Normal']].map(([v, l]) => `<option value="${v}" ${s.browser.windowMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Launch mode ${tip('Try "Spawn + attach" if Google refuses the sign-in.')}</label><select id="lmode">${[['persistent', 'Persistent'], ['cdp', 'Spawn + attach']].map(([v, l]) => `<option value="${v}" ${s.browser.launchMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>Browser engine path ${tip('Blank = the built-in Chromium.')}</label><input id="exe" value="${esc(s.browser.executablePath)}" placeholder="Built-in Chromium"></div>
        <div class="field"><label>Local API token ${tip(`Optional. API on 127.0.0.1:${s.apiPort}.`)}</label><input id="tok" value="${esc(s.apiToken)}"></div>
        <div class="field"><label><input type="checkbox" id="pwa" style="width:auto" ${s.pauseWhenActive.enabled ? 'checked' : ''}> Pause while I use the PC</label></div>
        <div class="field"><label><input type="checkbox" id="lowres" style="width:auto" ${s.geminiLowRes.enabled ? 'checked' : ''}> Send Gemini a small 360p copy</label></div>
        <div class="field"><label><input type="checkbox" id="blockMedia" style="width:auto" ${s.browser.blockMedia ? 'checked' : ''}> Block images/video in Studio</label></div>
      </div>
      <div style="flex:1">
        ${online ? `<div class="field"><label>Change password ${tip('Your other PCs keep working; saved logins stay readable.')}</label><div style="display:flex;gap:6px"><input id="pwOld" type="password" placeholder="current"><input id="pwNew" type="password" placeholder="new"><button class="btn ghost sm" id="pwGo">Change</button></div></div>` : ''}
        <div class="field"><label>Firebase config ${tip('Empty = the built-in project.')}</label><textarea id="cFb" style="min-height:60px" placeholder="built-in: ${esc(cs.projectId || '')}">${esc(s.cloud.firebaseConfig || '')}</textarea></div>
        <div class="grid2">
          <div class="field"><label>OAuth client ID</label><input id="cCid" value="${esc(s.cloud.googleClientId || '')}" placeholder="built-in"></div>
          <div class="field"><label>OAuth client secret ${drive.secretSet ? '<span class="pill g">set</span>' : ''}</label><input id="cSecret" type="password" placeholder="${drive.secretSet ? 'saved' : 'GOCSPX-…'}"></div>
        </div>
        <div class="grid3">
          <div class="field"><label>Backup speed KB/s ${tip('0 = 30% of the measured upload speed.')}</label><input id="cCap" type="number" min="0" value="${b.speedCapKBps}"></div>
          <div class="field"><label>Backup hours from</label><input id="cIdleS" type="time" value="${b.idleHours.start}"></div>
          <div class="field"><label>to</label><input id="cIdleE" type="time" value="${b.idleHours.end}"></div>
        </div>
        ${cs.sync ? `<div class="muted small">Cloud today: ${cs.quota.reads} reads · ${cs.quota.writes} writes · PCs: ${cs.sync.pcs.map(p => esc(p.name) + (p.me ? ' (this PC)' : '')).join(', ')}</div>` : ''}
      </div>
    </div>
  </details>`;
  const $ = id => document.getElementById(id);
  bindActions(main);
  if (state.advOpen) $('adv').open = true;
  $('adv').addEventListener('toggle', () => { state.advOpen = $('adv').open; });
  const put = patch => api('PUT', '/settings', patch).then(r => { refreshSide(); return r; });
  // main
  autosave($('wStart'), () => put({ uploadWindow: { start: $('wStart').value, end: $('wEnd').value === '23:59' ? '24:00' : $('wEnd').value } }));
  autosave($('wEnd'), () => put({ uploadWindow: { start: $('wStart').value, end: $('wEnd').value === '23:59' ? '24:00' : $('wEnd').value } }));
  autosave($('perDay'), v => put({ videosPerDay: +v || 2 }));
  autosave($('cPcName'), v => put({ cloud: { pcName: v.trim() } }));
  autosave($('cBk'), v => put({ cloud: { backup: { enabled: v } } }));
  const saveKeys = autosave($('keys'), async v => { if (!v.trim()) return; const r = await put({ geminiKeys: v }); $('keys').value = ''; $('keysLabel').textContent = `API keys, one per line — ${r.settings.geminiKeyCount} saved`; }, { delay: 1500 });
  // proxies: the pool is replaced from the textarea (masked lines keep their saved password)
  const syncProxies = autosave($('proxies'), async v => {
    const r = await api('POST', '/proxies', { text: v, sync: true });
    const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`].filter(Boolean);
    $('proxyState').innerHTML = `${r.total} in pool${parts.length ? ' (' + parts.join(', ') + ')' : ''}${r.errors.length ? ` · <span class="r-text">${r.errors.length} bad line(s): ${esc(r.errors.map(e => e.error || e.message || e).join('; '))}</span>` : ''}`;
  }, { delay: 1500 });
  if (online || cs.state) {
    if ($('cSignOut')) $('cSignOut').onclick = guard(async () => { await api('POST', '/cloud/signout'); toast('Signed out — this PC keeps working locally'); render(); });
    if ($('cSignIn')) $('cSignIn').onclick = () => showSignIn(true);
    if ($('cDriveOff')) $('cDriveOff').onclick = guard(async () => { if (!confirm('Disconnect Google Drive for every PC on this account?')) return; await api('POST', '/cloud/drive/disconnect'); render(); });
  }
  // advanced
  autosave($('lanes'), v => put({ lanes: +v || 3 }));
  autosave($('model'), v => put({ geminiModel: v.trim() }));
  autosave($('wmode'), v => put({ browser: { ...s.browser, windowMode: v } }));
  autosave($('lmode'), v => put({ browser: { ...s.browser, launchMode: v } }));
  autosave($('exe'), v => put({ browser: { ...s.browser, executablePath: v.trim() } }), { delay: 1500 });
  autosave($('tok'), v => put({ apiToken: v.trim() }), { delay: 1500 });
  autosave($('pwa'), v => put({ pauseWhenActive: { ...s.pauseWhenActive, enabled: v } }));
  autosave($('lowres'), v => put({ geminiLowRes: { ...s.geminiLowRes, enabled: v } }));
  autosave($('blockMedia'), v => put({ browser: { ...s.browser, blockMedia: v } }));
  autosave($('cFb'), v => put({ cloud: { firebaseConfig: v.trim() } }), { delay: 2000 });
  autosave($('cCid'), v => put({ cloud: { googleClientId: v.trim() } }), { delay: 1500 });
  autosave($('cSecret'), v => { if (!v.trim()) return null; return put({ cloud: { googleClientSecret: v.trim() } }).then(() => { $('cSecret').value = ''; }); }, { delay: 1500 });
  const bk = () => put({ cloud: { backup: { speedCapKBps: +$('cCap').value || 0, idleHours: { start: $('cIdleS').value, end: $('cIdleE').value } } } });
  autosave($('cCap'), bk); autosave($('cIdleS'), bk); autosave($('cIdleE'), bk);
  if ($('pwGo')) $('pwGo').onclick = guard(async () => { await api('POST', '/cloud/password', { oldPassword: $('pwOld').value, newPassword: $('pwNew').value }); $('pwOld').value = $('pwNew').value = ''; toast('Password changed'); });
  $('checkAll').onclick = guard(async () => {
    const out = $('checkOut');
    out.innerHTML = '<span class="spinner"></span>checking…';
    try {
      await syncProxies();
      const r = await api('POST', '/proxies/check-all');
      if (!r.length) { out.innerHTML = '<span class="r-text">No proxies yet — paste host:port:user:pass lines above</span>'; return; }
      out.innerHTML = `<div class="small" style="margin-bottom:4px">${r.filter(x => x.ok).length}/${r.length} working</div>` + r.map(x => `<div class="proxyRes"><span class="pill ${x.ok ? 'g' : 'r'}">${x.ok ? 'OK' : 'FAIL'}</span> <b>${esc(x.label)}</b> <span class="${x.ok ? '' : 'r-text'}">${x.ok ? 'exit IP ' + esc(x.ip || '?') : esc(x.error || 'dead')}</span></div>`).join('');
    } catch (e) { out.innerHTML = `<span class="r-text">${esc(e.message)}</span>`; throw e; }
  });
  $('testG').onclick = async () => {
    const out = $('gOut'), btn = $('testG');
    btn.disabled = true; out.innerHTML = '<span class="spinner"></span>Testing…';
    try {
      await saveKeys();
      const r = await api('POST', '/settings/gemini/test');
      let html = r.keys.map(k => `<div><span class="pill ${k.ok ? 'g' : 'r'}">${k.ok ? 'OK' : 'FAIL'}</span> key ${esc(k.key)} ${k.ok ? '' : `<span class="r-text">${esc(k.error || 'failed')}</span>`}</div>`).join('');
      if (r.models.length && !r.modelOk && r.suggested) { await api('PUT', '/settings', { geminiModel: r.suggested }); $('modelName').textContent = r.suggested; $('model').value = r.suggested; html += `<div style="margin-top:6px">Using <b>${esc(r.suggested)}</b> (the model set before isn't available for these keys).</div>`; }
      else if (r.modelOk) html += `<div style="margin-top:6px">Model ${esc(r.model)} ✓</div>`;
      else if (!r.keys.some(k => k.ok)) html += '<div class="r-text" style="margin-top:6px">No key worked — check the keys.</div>';
      out.innerHTML = html;
    } catch (e) { out.innerHTML = `<span class="r-text">${esc(e.message)}</span>`; } finally { btn.disabled = false; }
  };
}

// ---------------------------------------------------------------- sign-in screen: email + password, nothing else
function showSignIn(fromSettings = false, st = null) {
  modal.classList.remove('hidden');
  modal.innerHTML = `<div class="card" style="width:400px">
    <div class="logo" style="margin-bottom:14px"><div class="dot">▶</div>UploadPilot</div>
    <div class="field"><label>Email</label><input id="siEmail" type="email" value="${esc(st && st.lastEmail || '')}" autocomplete="username"></div>
    <div class="field"><label>Password</label><input id="siPass" type="password" autocomplete="current-password"></div>
    <div id="siErr" class="r-text small" style="min-height:16px;margin-bottom:8px"></div>
    <div class="head"><div><button class="btn" id="siGo">Sign in</button> <button class="btn ghost" id="siNew">Create account</button></div><button class="btn link small" id="siForgot">Forgot password?</button></div>
    <div style="margin-top:16px;text-align:right"><button class="btn link small" id="siOff">${fromSettings ? 'Cancel' : 'Work offline on this PC'}</button></div></div>`;
  const $ = id => document.getElementById(id);
  const go = create => async () => {
    $('siErr').textContent = ''; $('siGo').disabled = $('siNew').disabled = true; $('siGo').textContent = create ? 'Sign in' : 'Signing in…';
    try {
      const st2 = await api('POST', '/cloud/signin', { email: $('siEmail').value, password: $('siPass').value, create });
      modal.classList.add('hidden');
      toast(create ? 'Account created' : 'Signed in — everything is loading');
      if (st2.activePc && !st2.activePc.me && st2.activePc.other) showTakeOver(st2.activePc.other);
      render();
    } catch (e) { $('siErr').textContent = e.message; } finally { if ($('siGo')) { $('siGo').disabled = $('siNew').disabled = false; $('siGo').textContent = 'Sign in'; } }
  };
  $('siGo').onclick = go(false); $('siNew').onclick = go(true);
  $('siPass').onkeydown = e => { if (e.key === 'Enter') go(false)(); };
  $('siForgot').onclick = guard(async () => {
    const r = await api('POST', '/cloud/forgot', { email: $('siEmail').value });
    $('siErr').innerHTML = `<span style="color:#aaa">Reset e-mail sent. ${esc(r.note)}</span>`;
  });
  $('siOff').onclick = guard(async () => { if (!fromSettings) await api('POST', '/cloud/offline'); modal.classList.add('hidden'); render(); });
}
window.__showSignIn = showSignIn;

function showTakeOver(other) {
  modal.classList.remove('hidden');
  modal.innerHTML = `<div class="card" style="width:440px"><h2>UploadPilot is active on ${esc(other.pcName)}</h2>
    <div class="muted" style="margin-bottom:16px">since ${other.since ? new Date(other.since).toLocaleString() : 'earlier'}. Take over? ${esc(other.pcName)} finishes its current upload, saves its logins and signs out.</div>
    <div id="toMsg" class="muted small" style="min-height:16px;margin-bottom:8px"></div>
    <button class="btn" id="toGo">Take over</button> <button class="btn ghost" id="toNo">Cancel</button></div>`;
  document.getElementById('toNo').onclick = () => { modal.classList.add('hidden'); render(); };
  document.getElementById('toGo').onclick = guard(async () => { document.getElementById('toGo').disabled = true; document.getElementById('toMsg').innerHTML = '<span class="spinner"></span>Waiting for the other PC to hand over (up to 4 min)…'; await takeOverFlow(); modal.classList.add('hidden'); });
}
async function takeOverFlow() {
  const r = await api('POST', '/cloud/takeover');
  toast(r.me ? 'This PC is now active — autopilot is running here' : 'Could not take over yet');
  render();
}

function showUnlock(fresh = false) {
  modal.classList.remove('hidden');
  modal.innerHTML = `<div class="card" style="width:460px"><h2>${fresh ? 'Start fresh?' : 'Unlock your saved logins'}</h2>
    <div class="muted" style="margin-bottom:14px">${fresh ? 'Google logins, proxy passwords and keys saved before must then be entered again. Your channels, plans and videos stay.' : 'Your password was changed or reset. Type your password, or let one of your other signed-in PCs unlock this one.'}</div>
    <div class="field"><label>Password</label><input id="ulPass" type="password"></div>
    <div id="ulErr" class="r-text small" style="min-height:16px;margin-bottom:8px"></div>
    ${fresh ? '<button class="btn" id="ulFresh">Start fresh</button>' : '<button class="btn" id="ulGo">Unlock</button> <button class="btn ghost" id="ulAsk">Ask my other PC</button>'} <button class="btn link" id="ulNo">Cancel</button></div>`;
  const $ = id => document.getElementById(id);
  $('ulNo').onclick = () => modal.classList.add('hidden');
  const run = fn => guard(async () => { $('ulErr').textContent = ''; try { await fn(); modal.classList.add('hidden'); render(); } catch (e) { $('ulErr').textContent = e.message; } });
  if ($('ulGo')) $('ulGo').onclick = run(() => api('POST', '/cloud/unlock', { password: $('ulPass').value }).then(() => toast('Unlocked')));
  if ($('ulAsk')) $('ulAsk').onclick = run(() => api('POST', '/cloud/key-request').then(() => toast('Asked — any of your signed-in PCs unlocks this one in a moment')));
  if ($('ulFresh')) $('ulFresh').onclick = run(() => api('POST', '/cloud/start-fresh', { password: $('ulPass').value }).then(() => toast('Started fresh')));
}

// ---------------------------------------------------------------- link wizard
function openLink(preview = false) {
  state.link = { step: 1, session: null, preview };
  modal.classList.remove('hidden');
  drawLink();
  if (!preview) startLink();
}
window.__openLink = openLink;
function closeLink(cancel) {
  const s = state.link; clearInterval(s?.poll);
  if (cancel && s?.session && s.session.status !== 'done') api('DELETE', `/link/${s.session.id}`).catch(() => {});
  modal.classList.add('hidden'); state.link = null; render();
}
async function startLink() {
  try {
    const s = await api('POST', '/link/start', {});
    state.link.session = s; drawLink();
    state.link.poll = setInterval(guard(async () => {
      const cur = await api('GET', `/link/${s.id}`);
      state.link.session = cur;
      if (cur.status === 'connected' && state.link.step === 1) { state.link.step = 2; clearInterval(state.link.poll); }
      drawLink();
    }), 2000);
  } catch (e) { state.link.error = e.message; drawLink(); }
}
function drawLink() {
  const L = state.link; if (!L) return;
  const s = L.session || {};
  const stepsBar = `<div class="steps">${['1 Sign in', '2 Style', '3 Folder'].map((t, i) => `<div class="${L.step >= i + 1 ? 'on' : ''}">${t}</div>`).join('')}</div>`;
  const conn = s.channel ? `<div class="card okcard">${avatar(s.channel.name, s.channelId)}<div style="flex:1"><b>${esc(s.channel.name || 'Channel')}</b> <span class="pill g">Connected ✓</span><div class="muted">${esc(s.channel.handle || s.channel.channelId || '')} · Profile #${s.profileNumber} · ${esc(s.proxy || 'no proxy')} (auto)</div></div></div>` : '';
  let body = '';
  if (L.error) body = `<div class="card" style="border-color:#5a2222">${esc(L.error)}</div>`;
  else if (L.step === 1) {
    const msg = { opening: 'Creating a profile and checking its proxy…', waiting_login: 'A browser window opened. Sign in to the Google account that owns the channel. UploadPilot detects it automatically.', reading_channel: 'Signed in — reading the channel from YouTube Studio…', no_channel: s.error, browser_closed: s.error, error: s.error, timeout: 'Timed out waiting for sign-in.' }[s.status] || 'Starting…';
    body = `<div class="card waitcard"><span class="spinner"></span>${esc(msg)}${s.profileNumber ? `<div class="muted small" style="margin-top:8px">Profile #${s.profileNumber} · proxy ${esc(s.proxy || '—')}</div>` : ''}</div>
      <div class="muted">Tip: complete any phone prompts or verification in that window. You only do this once per channel.</div>`;
  } else if (L.step === 2) {
    const st = s.style || {};
    body = `${conn}
      <div class="field"><label><b style="color:#eaeaea">What's this channel about?</b></label><textarea id="lNiche" placeholder="Viral fails, dashcam and bodycam moments. Punchy, curious titles.">${esc(st.niche || '')}</textarea></div>
      <div class="grid3"><div class="field"><label>Language</label><select id="lLang">${['English', 'Spanish', 'Portuguese', 'German', 'French', 'Hindi', 'Arabic', 'Urdu', 'Turkish', 'Indonesian', 'Russian', 'Japanese'].map(l => `<option>${l}</option>`).join('')}</select></div>
        <div class="field"><label>AI titles</label><select id="lMode"><option value="auto">Auto-publish</option><option value="approval">Approval first</option></select></div>
        <div class="field"><label>Made for kids</label><select id="lKids"><option value="no">No</option><option value="yes">Yes</option></select></div></div>
      <div class="field"><label>Fixed description footer</label><textarea id="lFooter" style="min-height:60px" placeholder="Follow us on Instagram @…"></textarea></div>
      <div class="field"><label>Fixed hashtags</label><input id="lTags" placeholder="#shorts #fails"></div>
      <div class="head"><span class="muted">Gemini writes title, description and tags from each video in this style.</span><button class="btn" id="lNext">Next ›</button></div>`;
  } else if (L.step === 3) {
    body = `${conn}<div class="field"><label><b style="color:#eaeaea">Video folder</b> — videos (mp4/mov/mkv/webm) with optional same-name .jpg/.png thumbnails</label>
      <div style="display:flex;gap:8px"><input id="lFolder" placeholder="D:\\Videos\\MonarchClips"><button class="btn ghost" id="lBrowse">Browse</button></div></div>
      <div class="muted" style="margin-bottom:16px">When you save, autopilot starts for this channel right away: it plans uploads inside the upload window, writes metadata with Gemini and watches the folder for new files. Uploaded files move to a <code>Done</code> subfolder.</div>
      <div class="head"><button class="btn ghost" id="lBack">‹ Back</button><button class="btn" id="lSave">Save & start autopilot</button></div>`;
  }
  modal.innerHTML = `<div class="card"><div class="head"><b style="font-size:18px">Link a channel</b><button class="btn ghost sm" id="lClose">✕</button></div>
    <div class="muted" style="margin:4px 0 20px">Takes about a minute. You only do this once per channel.</div>${stepsBar}${body}</div>`;
  const $ = id => document.getElementById(id);
  $('lClose').onclick = () => closeLink(true);
  if ($('lNext')) $('lNext').onclick = guard(async () => {
    if (L.preview) { L.step = 3; return drawLink(); }
    L.session = await api('POST', `/link/${s.id}/style`, { niche: $('lNiche').value, language: $('lLang').value, mode: $('lMode').value, madeForKids: $('lKids').value === 'yes', footer: $('lFooter').value, hashtags: $('lTags').value });
    L.step = 3; drawLink();
  });
  if ($('lBack')) $('lBack').onclick = () => { L.step = 2; drawLink(); };
  if ($('lBrowse')) $('lBrowse').onclick = guard(async () => { const f = await window.uploadpilot.pickFolder(); if (f) $('lFolder').value = f; });
  if ($('lSave')) $('lSave').onclick = guard(async () => {
    const r = await api('POST', `/link/${s.id}/folder`, { folder: $('lFolder').value.trim() });
    L.session = r; toast('Channel linked — autopilot started'); closeLink(false); nav('channel', r.channelId);
  });
}

// ---------------------------------------------------------------- live updates
function connectEvents() {
  const es = new EventSource(`${API}/events/stream?token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = m => {
    const e = JSON.parse(m.data);
    state.events.unshift(e); state.events = state.events.slice(0, 60);
    const feed = document.getElementById('feed');
    if (feed) feed.innerHTML = state.events.map(feedItem).join('');
    clearTimeout(connectEvents._t);
    connectEvents._t = setTimeout(() => { if (state.page === 'dashboard' || state.page === 'channels') render(); }, 1500);
  };
  // another PC changed something (cloud listener) -> refresh the live views
  es.addEventListener('cloud', () => { clearTimeout(connectEvents._c); connectEvents._c = setTimeout(() => { if (!state.link && (state.page === 'dashboard' || state.page === 'channels' || state.page === 'channel')) render(); else refreshSide(); }, 500); });
  es.onerror = () => { es.close(); setTimeout(connectEvents, 3000); };
}

(async function boot() {
  const cfg = await window.uploadpilot.config();
  API = cfg.apiUrl; TOKEN = cfg.token;
  await render();
  connectEvents();
  try {
    let st = await api('GET', '/cloud/status');
    for (let i = 0; i < 20 && st.state === 'connecting'; i++) { await new Promise(r => setTimeout(r, 500)); st = await api('GET', '/cloud/status'); }
    if (st.configured && st.state === 'signed_out' && st.mode !== 'offline' && !st.handedOverTo) showSignIn(false, st);
    else if (st.state === 'online' && st.activePc && !st.activePc.me && st.activePc.other) showTakeOver(st.activePc.other);
  } catch (_) { /* local API not ready: stay local */ }
  setInterval(() => { if (!state.link && ['dashboard', 'channels'].includes(state.page)) render(); else refreshSide(); }, 30000);
})();
