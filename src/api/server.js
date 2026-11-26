'use strict';
// Local JSON API (iX-style envelope {code, message, data}). Binds to 127.0.0.1 only.
// Protection: Host header must be loopback (DNS-rebinding), and any request carrying a browser
// Origin header must present the session token (blocks websites from driving the API).
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

function startApiServer(app, { port = 53300, host = '127.0.0.1', uiToken = crypto.randomBytes(16).toString('hex') } = {}) {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
  };
  const P = '/api/v1';
  const need = (v, msg = 'Not found') => { if (v === null || v === undefined || v === false) throw Object.assign(new Error(msg), { status: 404 }); return v; };
  const int = v => { const n = parseInt(v, 10); if (!Number.isFinite(n)) throw Object.assign(new Error('Bad id'), { status: 400 }); return n; };

  // ---- health / dashboard / events
  add('GET', `${P}/health`, () => ({ ok: true, version: require('../../package.json').version, db: app.db.driver }));
  add('GET', `${P}/dashboard`, () => app.dashboard());
  add('GET', `${P}/events`, ({ q }) => app.events.recent(Math.min(500, +q.get('limit') || 50)));
  // ---- profiles
  add('GET', `${P}/profiles`, () => app.profiles.listProfiles());
  add('POST', `${P}/profiles`, ({ body }) => app.profiles.createProfile({ name: body.name, proxyId: body.proxyId, proxy: body.proxy, autoProxy: body.autoProxy !== false }));
  add('GET', `${P}/profiles/:id`, ({ p }) => need(app.profiles.listProfiles().find(x => x.id === int(p.id))));
  add('POST', `${P}/profiles/:id/open`, async ({ p, body }) => {
    const id = int(p.id); need(app.profiles.getProfile(id));
    const s = await app.profiles.open(id, { purpose: 'manual', startUrl: body.url, skipProxyCheck: !!body.skipProxyCheck, headless: body.headless });
    return { profileId: id, number: s.number, ws: s.cdpEndpoint, debugPort: s.handle.debugPort, http: `127.0.0.1:${s.handle.debugPort}`, exitIp: s.exitIp, proxyBridge: s.bridge ? s.bridge.url : null };
  });
  add('POST', `${P}/profiles/:id/close`, async ({ p }) => ({ closed: await app.profiles.close(int(p.id)) }));
  add('DELETE', `${P}/profiles/:id`, async ({ p, q }) => {
    const id = int(p.id);
    const ch = app.db.get(`SELECT id FROM channels WHERE profile_id=? AND status NOT IN ('stopped')`, id);
    if (ch && q.get('force') !== '1') throw Object.assign(new Error('Profile is linked to an active channel; stop the channel or pass ?force=1'), { status: 409 });
    return { deleted: need(await app.profiles.deleteProfile(id)) };
  });
  add('POST', `${P}/profiles/:id/proxy`, ({ p, body }) => need(app.profiles.setProfileProxy(int(p.id), { proxyId: body.proxyId, proxy: body.proxy })));
  add('POST', `${P}/profiles/:id/proxy/check`, async ({ p }) => { const prof = need(app.profiles.getProfile(int(p.id))); if (!prof.proxy_id) throw Object.assign(new Error('Profile has no proxy'), { status: 400 }); return app.profiles.checkProxyById(prof.proxy_id); });
  // ---- proxies
  add('GET', `${P}/proxies`, () => app.profiles.listProxies());
  add('POST', `${P}/proxies`, ({ body }) => body.sync ? app.profiles.syncProxyPool(body.text || '') : body.replace ? app.profiles.replaceProxyPool(body.text || '') : app.profiles.addProxies(body.text || body.proxy || ''));
  add('POST', `${P}/proxies/:id/check`, ({ p }) => app.profiles.checkProxyById(int(p.id)));
  add('POST', `${P}/proxies/check-all`, async ({ body }) => { if (body && typeof body.text === 'string') app.profiles.syncProxyPool(body.text); const out = []; for (const x of app.profiles.listProxies()) out.push(await app.profiles.checkProxyById(x.id)); return out; });
  add('DELETE', `${P}/proxies/:id`, ({ p }) => ({ deleted: app.db.run('DELETE FROM proxies WHERE id=?', int(p.id)).changes > 0 }));
  // ---- channels
  add('GET', `${P}/channels`, () => app.listChannels());
  add('GET', `${P}/channels/:id`, ({ p }) => need(app.getChannel(int(p.id))));
  add('GET', `${P}/channels/:id/status`, ({ p }) => need(app.channelStatus(int(p.id))));
  add('POST', `${P}/channels/:id/stop`, ({ p }) => need(app.stopChannel(int(p.id))));
  add('POST', `${P}/channels/:id/resume`, ({ p }) => need(app.resumeChannel(int(p.id))));
  add('PATCH', `${P}/channels/:id`, async ({ p, body }) => need(await app.updateChannel(int(p.id), body)));
  add('DELETE', `${P}/channels/:id`, async ({ p, q }) => ({ deleted: need(await app.deleteChannel(int(p.id), { deleteProfile: q.get('deleteProfile') === '1' })) }));
  add('POST', `${P}/channels/:id/scan`, ({ p }) => app.ingest(int(p.id)));
  add('POST', `${P}/channels/:id/open-profile`, async ({ p }) => {
    const ch = need(app.db.get('SELECT * FROM channels WHERE id=?', int(p.id)));
    if (!ch.profile_id) throw Object.assign(new Error('Channel has no profile'), { status: 409 });
    if (app.runner.live.has(ch.id)) throw Object.assign(new Error('Autopilot is uploading on this profile right now'), { status: 409 });
    const s = await app.profiles.open(ch.profile_id, { purpose: 'manual', startUrl: app.settings.get('urls').studio });
    return { profileId: ch.profile_id, ws: s.cdpEndpoint, exitIp: s.exitIp };
  });
  add('GET', `${P}/channels/:id/videos`, ({ p }) => app.listVideos(int(p.id)));
  add('GET', `${P}/channels/:id/runs`, ({ p }) => app.db.all('SELECT * FROM runs WHERE channel_id=? ORDER BY id DESC LIMIT 50', int(p.id)));
  // ---- videos
  add('PATCH', `${P}/videos/:id`, ({ p, body }) => need(app.updateVideo(int(p.id), body)));
  add('POST', `${P}/videos/:id/approve`, ({ p }) => app.approveVideo(int(p.id)));
  add('POST', `${P}/videos/:id/retry`, ({ p }) => app.retryVideo(int(p.id)));
  add('POST', `${P}/videos/:id/skip`, ({ p }) => app.skipVideo(int(p.id)));
  // ---- link wizard
  add('POST', `${P}/link/start`, ({ body }) => app.wizard.start({ name: body.name, proxyId: body.proxyId, proxy: body.proxy }));
  add('GET', `${P}/link/:id`, ({ p }) => app.wizard.get(p.id));
  add('POST', `${P}/link/:id/style`, ({ p, body }) => app.wizard.saveStyle(p.id, body));
  add('POST', `${P}/link/:id/folder`, ({ p, body }) => app.wizard.saveFolder(p.id, body.folder));
  add('DELETE', `${P}/link/:id`, ({ p }) => app.wizard.cancel(p.id));
  // ---- settings / autopilot
  add('GET', `${P}/settings`, () => ({ ...app.settings.publicView(), proxyPoolText: app.profiles.listProxies().map(x => `${x.host}:${x.port}${x.username ? ':' + x.username + ':••••' : ''}`).join('\n') }));
  add('PUT', `${P}/settings`, ({ body }) => app.updateSettings(body));
  add('POST', `${P}/settings/gemini/test`, async ({ body }) => {
    // keys pasted but not saved yet are saved first, so Test never says "no keys" for what the user sees
    if (body && typeof body.keys === 'string' && body.keys.trim()) await app.updateSettings({ geminiKeys: body.keys });
    const keys = await app.geminiClient().testKeys();
    const models = [...new Set(keys.filter(k => k.ok).flatMap(k => k.models))];
    for (const k of keys) delete k.models;
    const model = app.settings.all().geminiModel;
    const { pickBestModel } = require('../ai/gemini');
    return { keys, models, model, modelOk: models.includes(model), suggested: models.length && !models.includes(model) ? pickBestModel(models) : null, flashModels: models.filter(n => /flash/i.test(n)) };
  });
  add('GET', `${P}/scheduler`, () => ({ ...(app.scheduler ? app.scheduler.status() : {}), live: [...app.runner.live.entries()].map(([id, l]) => ({ channelId: id, ...l })) }));
  add('POST', `${P}/autopilot/pause`, () => app.setAutopilotPaused(true));
  add('POST', `${P}/autopilot/resume`, () => app.setAutopilotPaused(false));

  const sseClients = new Set();
  const onEvent = ev => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const res of sseClients) res.write(line); };
  app.events.on('event', onEvent);

  const send = (res, status, payload, origin) => {
    const body = JSON.stringify(payload);
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' };
    if (origin) { h['Access-Control-Allow-Origin'] = origin; h['Vary'] = 'Origin'; }
    res.writeHead(status, h); res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const hostHdr = String(req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHdr)) return send(res, 403, { code: 403, message: 'Forbidden host' });
    const apiToken = app.settings.get('apiToken');
    const token = req.headers['x-uploadpilot-token'];
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE', 'Access-Control-Allow-Headers': 'Content-Type, X-UploadPilot-Token', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const u = new URL(req.url, `http://${hostHdr}`);
    const tokenOk = token === uiToken || (apiToken && token === apiToken) || (u.pathname.endsWith('/events/stream') && u.searchParams.get('token') === uiToken);
    if (origin && !tokenOk) return send(res, 403, { code: 403, message: 'Browser requests need the UI token' });
    if (apiToken && !tokenOk) return send(res, 401, { code: 401, message: 'Missing or bad X-UploadPilot-Token' });
    if (req.method === 'GET' && u.pathname === `${P}/events/stream`) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) });
      res.write(': connected\n\n');
      sseClients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 25000);
      req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }
    const route = routes.find(r => r.method === req.method && r.re.test(u.pathname));
    if (!route) return send(res, 404, { code: 404, message: `No route ${req.method} ${u.pathname}` }, origin);
    let body = {};
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      try {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 2e6) throw new Error('Body too large'); chunks.push(c); }
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      } catch (e) { return send(res, 400, { code: 400, message: `Bad JSON body: ${e.message}` }, origin); }
    }
    const m = route.re.exec(u.pathname);
    const p = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      const data = await route.handler({ p, q: u.searchParams, body: body || {}, req });
      send(res, 200, { code: 0, message: 'success', data }, origin);
    } catch (e) {
      const status = e.status || (e.code === 'PROFILE_BUSY' ? 409 : e.code === 'PROXY_DEAD' ? 502 : 500);
      send(res, status, { code: status, message: e.message }, origin);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        server, port: actual, uiToken, url: `http://127.0.0.1:${actual}${P}`,
        close: () => new Promise(r => { app.events.off('event', onEvent); for (const c of sseClients) c.end(); server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}

module.exports = { startApiServer };
