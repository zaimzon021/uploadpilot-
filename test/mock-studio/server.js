'use strict';
// Mock "YouTube Studio" + "Google sign-in" for end-to-end tests of the real upload engine.
// Failure modes are switched with POST /__mode {mode}. Published uploads are recorded at /__submissions.
//   modes: ok | error_once | error_random | verify | login | stuck | spinner | dialog_vanish | limit | slow
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHANNEL_ID = 'UCmockchannel00000001';

function startMockStudio({ port = 0 } = {}) {
  const state = { mode: 'ok', opts: {}, submissions: [], loads: 0, errorShown: 0, vanished: 0, uploadsStarted: 0 };
  const page = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
  const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
  const send = (res, status, body, type = 'text/html; charset=utf-8', extra = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const p = u.pathname;
    if (p === '/__mode' && req.method === 'POST') { const j = JSON.parse(body || '{}'); state.mode = j.mode || 'ok'; state.opts = j; state.errorShown = 0; state.vanished = 0; return send(res, 200, JSON.stringify(state), 'application/json'); }
    if (p === '/__mode') return send(res, 200, JSON.stringify({ mode: state.opts.only && state.opts.only !== cookies(req).SID ? 'ok' : state.mode, opts: state.opts, errorShown: state.errorShown, vanished: state.vanished }), 'application/json');
    if (p === '/__event' && req.method === 'POST') { const j = JSON.parse(body); if (j.type === 'error_shown') state.errorShown++; if (j.type === 'vanished') state.vanished++; if (j.type === 'upload_started') state.uploadsStarted++; return send(res, 200, '{}', 'application/json'); }
    if (p === '/__submit' && req.method === 'POST') {
      const j = JSON.parse(body);
      const id = j.videoId || 'mock' + Math.random().toString(36).slice(2, 10);
      state.submissions.push({ ...j, videoId: id, at: Date.now(), cookie: !!cookies(req).SID });
      return send(res, 200, JSON.stringify({ videoId: id, url: `https://youtu.be/${id}` }), 'application/json');
    }
    if (p === '/__ip') return send(res, 200, JSON.stringify({ ip: '203.0.113.77' }), 'application/json');
    if (p === '/__submissions') return send(res, 200, JSON.stringify(state.submissions), 'application/json');
    if (p === '/__reset' && req.method === 'POST') { state.submissions = []; state.mode = 'ok'; state.opts = {}; state.errorShown = 0; state.vanished = 0; state.uploadsStarted = 0; return send(res, 200, '{}', 'application/json'); }

    // ---- Google sign-in mock
    if (p === '/ServiceLogin' || p === '/signin') return send(res, 200, page('login.html'));
    if (p === '/__do_login' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      const cont = form.get('continue') || '/';
      const who = encodeURIComponent(form.get('identifier') || 'mock@example.com');
      return send(res, 302, '', 'text/plain', { Location: cont, 'Set-Cookie': [`SID=${who}; Path=/; Max-Age=31536000`, '__Secure-3PSID=mock; Path=/; Max-Age=31536000'] });
    }
    if (p === '/__logout') return send(res, 302, '', 'text/plain', { Location: '/', 'Set-Cookie': ['SID=; Path=/; Max-Age=0', '__Secure-3PSID=; Path=/; Max-Age=0'] });
    if (p.startsWith('/challenge/')) return send(res, 200, page('verify.html'));

    // ---- Studio
    if (p === '/' || p.startsWith('/channel/')) {
      state.loads++;
      // opts.only = "<email>": the failure mode applies only to the account signed in with that email
      const sid = cookies(req).SID;
      const mode = state.opts.only && state.opts.only !== sid ? 'ok' : state.mode;
      if (!sid || mode === 'login') return send(res, 302, '', 'text/plain', { Location: `/ServiceLogin?continue=${encodeURIComponent('/')}` });
      if (mode === 'verify') return send(res, 302, '', 'text/plain', { Location: '/challenge/recaptcha?continue=/' });
      if (p === '/') return send(res, 302, '', 'text/plain', { Location: `/channel/${CHANNEL_ID}` });
      return send(res, 200, page('studio.html'));
    }
    send(res, 404, 'not found');
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    r({
      url: base, state, channelId: CHANNEL_ID,
      setMode: async (mode, opts = {}) => { state.mode = mode; state.opts = { mode, ...opts }; state.errorShown = 0; state.vanished = 0; },
      close: () => new Promise(c => { server.close(() => c()); server.closeAllConnections?.(); }),
    });
  }));
}

module.exports = { startMockStudio, CHANNEL_ID };

if (require.main === module) {
  startMockStudio({ port: +process.env.PORT || 8765 }).then(s => console.log(`Mock Studio on ${s.url}`));
}
