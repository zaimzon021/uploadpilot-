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

function statusPill(c) {
  if (c.live) return `<span class="pill b">${c.live.state === 'opening' ? 'Opening profile' : 'Uploading'}</span>`;
  const map = { active: ['g', 'Live'], stopped: ['gr', 'Stopped'], paused: ['gr', 'Paused'], needs_you: ['r', 'Needs you'], linking: ['y', 'Linking'] };
  const [cls, label] = map[c.status] || ['gr', c.status];
  if (c.status === 'active' && c.paused_until && c.paused_until > Date.now()) return `<span class="pill y" title="${esc(c.status_reason)}">Limit — resumes ${fmtTime(c.paused_until)}</span>`;
  if (c.status === 'active' && c.awaiting) return `<span class="pill y">Waiting approval</span>`;
  return `<span class="pill ${cls}" title="${esc(c.status_reason || '')}">${label}${c.status === 'needs_you' && c.status_reason ? ' · ' + esc(c.status_reason) : ''}</span>`;
}
const videoPill = v => {
  const m = { queued: ['gr', 'Queued'], ai: ['b', 'AI writing'], awaiting_approval: ['y', 'Needs your OK'], ready: ['g', 'Ready'], uploading: ['b', 'Uploading'], done: ['g', 'Published'], failed: ['r', 'Failed'], missing: ['r', 'File missing'], skipped: ['gr', 'Skipped'] };
  const [c, l] = m[v.status] || ['gr', v.status];
  return `<span class="pill ${c}" title="${esc(v.error || v.ai_error || '')}">${l}${v.status === 'queued' && v.ai_status === 'failed' ? ' · AI failed' : ''}</span>`;
};

// ---------------------------------------------------------------- navigation
function nav(page, channelId) {
  state.page = page; state.channelId = channelId ?? null;
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.page === page || (page === 'channel' && a.dataset.page === 'channels')));
  render();
}
window.__nav = nav;
document.querySelectorAll('.nav a').forEach(a => a.addEventListener('click', () => nav(a.dataset.page)));

async function render() {
  try {
    if (state.page === 'dashboard') await renderDashboard();
    else if (state.page === 'channels') await renderChannels();
    else if (state.page === 'channel') await renderChannel(state.channelId);
    else if (state.page === 'settings') await renderSettings();
  } catch (e) { main.innerHTML = `<div class="card r">Could not load: ${esc(e.message)}</div>`; }
}
async function refreshSide() {
  try {
    const d = await api('GET', '/dashboard');
    document.getElementById('keysLine').innerHTML = `Gemini · ${d.ai.keys} key${d.ai.keys === 1 ? '' : 's'} <span class="pill ${d.ai.keys ? 'g' : 'r'}">${d.ai.keys ? 'OK' : 'Add keys'}</span>`;
    document.getElementById('keysCalls').textContent = `${d.ai.callsToday} calls today${d.ai.errorsToday ? ` · ${d.ai.errorsToday} errors` : ''}`;
    return d;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- dashboard
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
function feedItem(e) {
  const cls = { success: 'g', error: 'r', warn: 'y', info: 'b' }[e.level] || 'gr';
  return `<div class="item"><span class="pill ${cls}">${new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> <span class="muted">${esc(e.message)}</span></div>`;
}
function channelRows(chans, compact) {
  if (!chans.length) return `<tr><td colspan="7" class="muted" style="padding:30px;text-align:center">No channels yet. Click <b>+ Link channel</b> to add your first one.</td></tr>`;
  return chans.map(c => {
    const pct = c.planned_today ? Math.round(100 * c.done_today / c.planned_today) : 0;
    const next = c.status === 'needs_you' ? `<button class="btn link" data-relogin="${c.id}">Re-login ›</button>` : (c.status === 'active' ? fmtTime(c.next_upload) : '—');
    return `<tr class="click" data-ch="${c.id}"><td>${avatar(c.name, c.id)}${esc(c.name || 'Unnamed')}${c.handle ? ` <span class="muted small">${esc(c.handle)}</span>` : ''}</td>
      <td>${statusPill(c)}</td>
      ${compact ? '' : `<td class="muted">#${c.profile_number ?? '—'}</td>`}
      <td class="muted">${esc(c.proxy || '—')}</td>
      <td><span class="bar"><i style="width:${pct}%"></i></span>${c.done_today}/${c.planned_today}</td>
      <td>${c.queue}</td><td>${next}</td>
      ${compact ? '' : `<td><div class="actions" onclick="event.stopPropagation()">
        <button class="btn ghost sm" data-open="${c.id}">Open profile</button>
        ${c.status === 'active' ? `<button class="btn ghost sm" data-stop="${c.id}">Stop</button>` : c.status !== 'linking' ? `<button class="btn sm" data-resume="${c.id}">Resume</button>` : ''}
      </div></td>`}</tr>`;
  }).join('');
}
function bindChannelRows(root) {
  root.querySelectorAll('tr[data-ch]').forEach(tr => tr.addEventListener('click', () => nav('channel', +tr.dataset.ch)));
  root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', guard(async e => { e.stopPropagation(); b.disabled = true; toast('Opening profile (checking proxy first)…'); const r = await api('POST', `/channels/${b.dataset.open}/open-profile`); toast(`Profile open · exit IP ${r.exitIp || 'n/a'}`); b.disabled = false; })));
  root.querySelectorAll('[data-relogin]').forEach(b => b.addEventListener('click', guard(async e => { e.stopPropagation(); await api('POST', `/channels/${b.dataset.relogin}/open-profile`); toast('Sign in again in the opened window, then press Resume.'); })));
  root.querySelectorAll('[data-stop]').forEach(b => b.addEventListener('click', guard(async e => { e.stopPropagation(); await api('POST', `/channels/${b.dataset.stop}/stop`); render(); })));
  root.querySelectorAll('[data-resume]').forEach(b => b.addEventListener('click', guard(async e => { e.stopPropagation(); await api('POST', `/channels/${b.dataset.resume}/resume`); render(); })));
}

async function renderDashboard() {
  const [d, chans, evs] = await Promise.all([refreshSide(), api('GET', '/channels'), api('GET', '/events?limit=40')]);
  state.events = evs;
  const nextIn = d.nextUpload ? Math.round((d.nextUpload - Date.now()) / 60000) : null;
  const ap = d.autopilot.paused ? 'autopilot is paused' : !d.autopilot.inWindow ? `outside upload window (${d.autopilot.window.start}–${d.autopilot.window.end})` : 'autopilot is on';
  const nd = d.needsYouDetail;
  const needParts = [nd.channels && `${nd.channels} login/verify`, nd.failed && `${nd.failed} failed`, nd.approval && `${nd.approval} to approve`].filter(Boolean).join(' · ') || 'all good';
  main.innerHTML = `
  <div class="head"><div><h1>${greeting()}</h1><div class="sub">${new Date().toLocaleDateString([], { weekday: 'long' })} · ${ap}${nextIn !== null && !d.autopilot.paused ? `, next upload ${nextIn <= 0 ? 'due now' : `in ${nextIn} min`}` : ''}</div></div>
    <div><button class="btn ghost" id="pauseBtn">${d.autopilot.paused ? '▶ Resume autopilot' : '❚❚ Pause autopilot'}</button> <button class="btn" id="linkBtn">+ Link channel</button></div></div>
  <div class="row" style="margin-bottom:18px">
    <div class="card stat" style="flex:1"><div class="muted">Channels</div><div class="num">${d.channels}</div><div class="muted" style="margin-top:4px">${d.connected} connected</div></div>
    <div class="card stat" style="flex:1"><div class="muted">Published today</div><div class="num">${d.publishedToday}</div><div style="color:#4ade80;margin-top:4px">of ${d.plannedToday} planned</div></div>
    <div class="card stat" style="flex:1"><div class="muted">In queue</div><div class="num">${d.inQueue}</div><div class="muted" style="margin-top:4px">${d.lanesText || `${(d.autopilot.lanes || []).filter(l => l.state === 'running').length} lane(s) busy`}</div></div>
    <div class="card stat" style="flex:1;${d.needsYou ? 'border-color:#5a2222' : ''}"><div class="muted">Needs you</div><div class="num" style="${d.needsYou ? 'color:#f87171' : ''}">${d.needsYou}</div><div class="muted" style="margin-top:4px">${needParts}</div></div>
  </div>
  <div class="row">
    <div class="card" style="flex:2.3;min-width:0">
      <div class="head" style="margin-bottom:6px"><b>Channels</b><input id="search" placeholder="Search channels…" style="width:220px;padding:6px 10px"></div>
      <table id="chTable"><thead><tr><th>Channel</th><th>Status</th><th>Proxy</th><th>Today</th><th>Queue</th><th>Next upload</th></tr></thead><tbody>${channelRows(chans, true)}</tbody></table>
      <div class="muted" style="margin-top:10px">Showing ${chans.length} of ${chans.length}</div>
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
  const chans = await api('GET', '/channels');
  main.innerHTML = `<div class="head"><div><h1>Channels</h1><div class="sub">${chans.length} linked</div></div><button class="btn" id="linkBtn">+ Link channel</button></div>
  <div class="card"><table><thead><tr><th>Channel</th><th>Status</th><th>Profile</th><th>Proxy</th><th>Today</th><th>Queue</th><th>Next upload</th><th></th></tr></thead><tbody>${channelRows(chans, false)}</tbody></table></div>`;
  bindChannelRows(main);
  document.getElementById('linkBtn').onclick = () => openLink();
}

// ---------------------------------------------------------------- channel detail
async function renderChannel(id) {
  const [c, vids, runs] = await Promise.all([api('GET', `/channels/${id}`), api('GET', `/channels/${id}/videos`), api('GET', `/channels/${id}/runs`)]);
  const st = c.style || {};
  main.innerHTML = `
  <div class="head"><div><h1>${avatar(c.name, c.id)}${esc(c.name || 'Channel')}</h1><div class="sub">${esc(c.handle || '')} · profile #${c.profile_number ?? '—'} · proxy ${esc(c.proxy || '—')} · ${statusPill(c)}</div></div>
    <div class="actions"><button class="btn ghost" id="openP">Open profile</button>${c.status === 'active' ? '<button class="btn ghost" id="stopB">Stop</button>' : '<button class="btn" id="resB">Resume</button>'}<button class="btn ghost" id="scanB">Rescan folder</button></div></div>
  ${c.status_reason ? `<div class="card" style="margin-bottom:14px;border-color:#5a2222">${esc(c.status_reason)}</div>` : ''}
  <div class="row" style="margin-bottom:16px">
    <div class="card" style="flex:1"><h2>Style</h2>
      <div class="field"><label>What's this channel about? (niche / tone)</label><textarea id="sNiche">${esc(st.niche)}</textarea></div>
      <div class="grid3"><div class="field"><label>Language</label><input id="sLang" value="${esc(st.language || 'English')}"></div>
        <div class="field"><label>AI titles</label><select id="sMode"><option value="auto">Auto-publish</option><option value="approval" ${st.mode === 'approval' ? 'selected' : ''}>Approval first</option></select></div>
        <div class="field"><label>Made for kids</label><select id="sKids"><option value="no">No</option><option value="yes" ${st.madeForKids ? 'selected' : ''}>Yes</option></select></div></div>
      <div class="field"><label>Description footer (added to every video)</label><textarea id="sFooter" style="min-height:60px">${esc(st.footer)}</textarea></div>
      <div class="grid2"><div class="field"><label>Fixed hashtags</label><input id="sTags" value="${esc(st.hashtags)}" placeholder="#shorts #fails"></div>
        <div class="field"><label>Videos per day (blank = global)</label><input id="sPer" type="number" min="1" max="20" value="${st.perDay || ''}"></div></div>
      <div class="field"><label>Folder</label><div style="display:flex;gap:8px"><input id="sFolder" value="${esc(c.folder || '')}"><button class="btn ghost" id="browse">Browse</button></div></div>
      <button class="btn" id="saveStyle">Save</button>
    </div>
    <div class="card" style="width:340px"><h2>Recent runs</h2>${runs.slice(0, 8).map(r => `<div style="margin-bottom:10px"><span class="pill ${r.result === 'ok' ? 'g' : r.result === 'running' ? 'b' : r.result === 'nothing_due' ? 'gr' : 'r'}">${esc(r.result)}</span> <span class="muted small">${new Date(r.started_at).toLocaleString()} · lane ${r.lane + 1}</span><div class="muted small">${esc(r.detail || '')}</div>${r.log_dir ? `<button class="btn link small" data-path="${esc(r.log_dir)}">Logs &amp; screenshots ›</button>` : ''}</div>`).join('') || '<div class="muted">No runs yet.</div>'}</div>
  </div>
  <div class="card"><h2>Plan (${vids.length})</h2>
    <table><thead><tr><th>Video</th><th style="width:190px">Date / time</th><th>Status</th><th>AI title</th><th></th></tr></thead><tbody>
    ${vids.map(v => {
      const locked = ['uploading', 'done'].includes(v.status);
      return `<tr data-v="${v.id}"><td><div>${esc(v.filename)}</div><div class="muted small">${v.thumb ? '🖼 thumbnail' : 'no thumbnail'}${v.url ? ` · <a href="${esc(v.url)}" target="_blank">${esc(v.url)}</a>` : ''}</div></td>
        <td>${locked ? fmtTime(v.uploaded_at || v.scheduled_at) : `<input type="datetime-local" class="vWhen" value="${toLocalInput(v.scheduled_at)}">`}</td>
        <td>${videoPill(v)}</td>
        <td style="min-width:300px">${locked ? esc(v.title) : `<input class="inline-title vTitle" maxlength="100" value="${esc(v.title || '')}" placeholder="${v.status === 'ai' ? 'Gemini is watching the video…' : 'Waiting for AI (or type a title)'}">
          <details><summary class="muted small" style="cursor:pointer">description · tags</summary><textarea class="vDesc" placeholder="Description">${esc(v.description || '')}</textarea><input class="vTags" style="margin-top:6px" placeholder="tags, comma separated" value="${esc((v.tags || []).join(', '))}"><input class="vHash" style="margin-top:6px" placeholder="#hashtags" value="${esc((v.hashtags || []).join(' '))}"></details>`}</td>
        <td><div class="actions">${locked ? '' : '<button class="btn ghost sm vSave">Save</button>'}${v.status === 'awaiting_approval' ? '<button class="btn sm vOk">Approve</button>' : ''}${['failed', 'missing', 'skipped'].includes(v.status) ? '<button class="btn ghost sm vRetry">Retry</button>' : ''}${!locked && v.status !== 'skipped' ? '<button class="btn ghost sm vSkip">Skip</button>' : ''}</div></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No videos found in the folder yet.</td></tr>'}
    </tbody></table></div>`;
  const $ = s => document.getElementById(s);
  $('openP').onclick = guard(async () => { toast('Opening profile…'); await api('POST', `/channels/${id}/open-profile`); toast('Profile window opened'); });
  if ($('stopB')) $('stopB').onclick = guard(async () => { await api('POST', `/channels/${id}/stop`); render(); });
  if ($('resB')) $('resB').onclick = guard(async () => { await api('POST', `/channels/${id}/resume`); render(); });
  $('scanB').onclick = guard(async () => { const r = await api('POST', `/channels/${id}/scan`); toast(`${r.added} new video(s)`); render(); });
  $('browse').onclick = guard(async () => { const f = await window.uploadpilot.pickFolder(); if (f) $('sFolder').value = f; });
  $('saveStyle').onclick = guard(async () => {
    await api('PATCH', `/channels/${id}`, { folder: $('sFolder').value.trim() || undefined, style: { niche: $('sNiche').value, language: $('sLang').value, mode: $('sMode').value, madeForKids: $('sKids').value === 'yes', footer: $('sFooter').value, hashtags: $('sTags').value, perDay: $('sPer').value || undefined } });
    toast('Saved'); render();
  });
  main.querySelectorAll('[data-path]').forEach(b => b.onclick = () => window.uploadpilot.openPath(b.dataset.path));
  main.querySelectorAll('tr[data-v]').forEach(tr => {
    const vid = tr.dataset.v, q = s => tr.querySelector(s);
    if (q('.vSave')) q('.vSave').onclick = guard(async () => {
      const patch = { title: q('.vTitle').value.trim() || undefined, description: q('.vDesc').value, tags: q('.vTags').value, hashtags: q('.vHash').value };
      if (q('.vWhen').value) patch.scheduled_at = new Date(q('.vWhen').value).toISOString();
      if (!patch.title) delete patch.title;
      await api('PATCH', `/videos/${vid}`, patch); toast('Saved'); render();
    });
    if (q('.vOk')) q('.vOk').onclick = guard(async () => { await api('POST', `/videos/${vid}/approve`); render(); });
    if (q('.vRetry')) q('.vRetry').onclick = guard(async () => { await api('POST', `/videos/${vid}/retry`); render(); });
    if (q('.vSkip')) q('.vSkip').onclick = guard(async () => { await api('POST', `/videos/${vid}/skip`); render(); });
  });
}

// ---------------------------------------------------------------- settings
async function renderSettings() {
  const s = await api('GET', '/settings');
  main.innerHTML = `<h1>Settings</h1><div class="sub">Changes apply immediately. Lanes / delays restart the scheduler between runs.</div>
  <div class="row">
    <div class="card" style="flex:1">
      <h2>Proxy pool</h2>
      <div class="field"><label>SOCKS5 proxies, one per line: <code>host:port:user:pass</code></label><textarea id="proxies" style="min-height:180px" placeholder="1.2.3.4:1080:user:pass">${esc(s.proxyPoolText)}</textarea>
      <div class="muted small" style="margin-top:6px">Passwords of saved proxies are hidden (••••). Lines you leave unchanged keep their saved password; proxies used by a profile are never removed.</div></div>
      <button class="btn ghost" id="checkAll">Check all proxies</button> <span id="checkOut" class="muted"></span>
      <h2 style="margin-top:22px">Gemini</h2>
      <div class="field"><label>API keys, one per line (${s.geminiKeyCount} saved — leave empty to keep them)</label><textarea id="keys" placeholder="${esc(s.geminiKeys.join('\n'))}"></textarea></div>
      <div class="grid2"><div class="field"><label>Model</label><input id="model" value="${esc(s.geminiModel)}"></div><div class="field"><label>&nbsp;</label><button class="btn ghost" id="testG">Test keys / list models</button></div></div>
      <div id="gOut" class="muted small"></div>
    </div>
    <div class="card" style="flex:1">
      <h2>Autopilot</h2>
      <div class="grid2">
        <div class="field"><label>Videos per channel per day</label><input id="perDay" type="number" min="1" value="${s.videosPerDay}"></div>
        <div class="field"><label>Lanes (channels in parallel)</label><input id="lanes" type="number" min="1" max="20" value="${s.lanes}"></div>
        <div class="field"><label>Upload window start</label><input id="wStart" type="time" value="${s.uploadWindow.start}"></div>
        <div class="field"><label>Upload window end</label><input id="wEnd" type="time" value="${s.uploadWindow.end === '24:00' ? '23:59' : s.uploadWindow.end}"></div>
        <div class="field"><label>Delay between channels — min (minutes)</label><input id="dMin" type="number" min="0" step="0.5" value="${s.delayRangeMin.min}"></div>
        <div class="field"><label>Delay between channels — max (minutes)</label><input id="dMax" type="number" min="0" step="0.5" value="${s.delayRangeMin.max}"></div>
        <div class="field"><label>Default visibility</label><select id="vis">${['PUBLIC', 'UNLISTED', 'PRIVATE'].map(v => `<option ${s.upload.visibility === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>Per-channel time limit (minutes)</label><input id="hard" type="number" min="5" value="${Math.round(s.upload.channelHardLimitMs / 60000)}"></div>
      </div>
      <h2 style="margin-top:8px">Browser</h2>
      <div class="field"><label>Chrome / Chromium path (blank = auto-detect)</label><input id="exe" value="${esc(s.browser.executablePath)}" placeholder="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"></div>
      <div class="grid2"><div class="field"><label>Autopilot windows</label><select id="wmode">${[['minimized', 'Minimized (default)'], ['offscreen', 'Off-screen'], ['normal', 'Normal']].map(([v, l]) => `<option value="${v}" ${s.browser.windowMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Launch mode</label><select id="lmode">${[['persistent', 'Playwright persistent'], ['cdp', 'Spawn + CDP attach']].map(([v, l]) => `<option value="${v}" ${s.browser.launchMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="field"><label>Local API token (optional; blank = none) · API on 127.0.0.1:${s.apiPort}</label><input id="tok" value="${esc(s.apiToken)}"></div>
      <button class="btn" id="save">Save settings</button>
    </div>
  </div>`;
  const $ = id => document.getElementById(id);
  const original = s.proxyPoolText;
  $('save').onclick = guard(async () => {
    const patch = {
      geminiModel: $('model').value.trim(), videosPerDay: +$('perDay').value, lanes: +$('lanes').value,
      uploadWindow: { start: $('wStart').value, end: $('wEnd').value === '23:59' ? '24:00' : $('wEnd').value },
      delayRangeMin: { min: +$('dMin').value, max: +$('dMax').value },
      upload: { visibility: $('vis').value, channelHardLimitMs: Math.max(5, +$('hard').value) * 60000 },
      browser: { executablePath: $('exe').value.trim(), windowMode: $('wmode').value, launchMode: $('lmode').value },
      apiToken: $('tok').value.trim(),
    };
    if ($('keys').value.trim()) patch.geminiKeys = $('keys').value;
    if ($('proxies').value !== original) {
      // keep unchanged masked lines as-is: send only lines with real passwords plus host:port of kept ones
      const lines = $('proxies').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const fresh = lines.filter(l => !l.includes('••••'));
      const keptMasked = lines.filter(l => l.includes('••••'));
      const keptIds = new Set(keptMasked.map(l => l.split(':').slice(0, 2).join(':')));
      const existing = await api('GET', '/proxies');
      for (const p of existing) if (!keptIds.has(`${p.host}:${p.port}`) && !p.profiles) await api('DELETE', `/proxies/${p.id}`);
      if (fresh.length) { const r = await api('POST', '/proxies', { text: fresh.join('\n') }); toast(`Proxies: ${r.added} added${r.errors.length ? `, ${r.errors.length} bad line(s)` : ''}`, !!r.errors.length); }
    }
    await api('PUT', '/settings', patch);
    toast('Settings saved'); refreshSide(); render();
  });
  $('checkAll').onclick = guard(async () => { $('checkOut').innerHTML = '<span class="spinner"></span>checking…'; const r = await api('POST', '/proxies/check-all'); $('checkOut').innerHTML = r.map(x => `<span class="pill ${x.ok ? 'g' : 'r'}" title="${esc(x.error || '')}">${esc(x.label)} ${x.ok ? esc(x.ip) : 'dead'}</span>`).join(' ') || 'no proxies'; });
  $('testG').onclick = guard(async () => { $('gOut').textContent = 'Testing…'; const r = await api('POST', '/settings/gemini/test'); $('gOut').textContent = `OK — ${r.models.length} models: ${r.models.filter(m => /flash/.test(m)).join(', ')}`; });
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
  es.onerror = () => { es.close(); setTimeout(connectEvents, 3000); };
}

(async function boot() {
  const cfg = await window.uploadpilot.config();
  API = cfg.apiUrl; TOKEN = cfg.token;
  await render();
  connectEvents();
  setInterval(() => { if (!state.link && ['dashboard', 'channels'].includes(state.page)) render(); else refreshSide(); }, 30000);
})();
