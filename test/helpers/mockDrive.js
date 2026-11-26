'use strict';
// Mock Google Drive v3 + OAuth token endpoint, enough to exercise DriveClient / GoogleAuth for real
// over HTTP: folders, search by name/parent, resumable sessions (308 + Range, status queries),
// media download with Range, delete, plus fault injection (403 userRateLimitExceeded, 500, …).
const http = require('http');
const crypto = require('crypto');

async function startMockDrive({ log = false } = {}) {
  const files = new Map();     // id -> { id, name, parents, mimeType, data:Buffer, modifiedTime }
  const sessions = new Map();  // sid -> { meta, size, data:Buffer[], received, fileId }
  const faults = [];           // { method, pathRe, status, reason, times }
  const requests = [];
  const tokens = { issued: 0, refreshed: 0, codes: new Map(), refresh: 'rt-' + crypto.randomBytes(6).toString('hex') };
  let server, base;
  const id = () => crypto.randomBytes(9).toString('hex');
  const json = (res, status, obj, headers = {}) => { const b = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...headers }); res.end(b); };
  const body = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); req.on('error', () => r(Buffer.concat(c))); });
  const fileView = f => ({ id: f.id, name: f.name, size: String(f.data.length), mimeType: f.mimeType, modifiedTime: new Date(f.modifiedTime).toISOString(), md5Checksum: crypto.createHash('md5').update(f.data).digest('hex') });

  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, base);
    const rec = { method: req.method, path: u.pathname, range: req.headers['content-range'] || null, t: Date.now(), bytes: 0 };
    requests.push(rec);
    if (log) console.log('[drive]', req.method, req.url, rec.range || '');
    const f = faults.find(x => x.times > 0 && x.method === req.method && x.pathRe.test(u.pathname));
    if (f) { f.times--; await body(req); return json(res, f.status, { error: { code: f.status, message: f.reason, errors: [{ reason: f.reason }] } }); }
    // ---- OAuth
    if (u.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams((await body(req)).toString());
      if (p.get('grant_type') === 'authorization_code') { if (!tokens.codes.has(p.get('code'))) return json(res, 400, { error: 'invalid_grant' }); tokens.issued++; return json(res, 200, { access_token: 'at-' + id(), expires_in: 3600, refresh_token: tokens.refresh, scope: 'https://www.googleapis.com/auth/drive.file' }); }
      if (p.get('grant_type') === 'refresh_token') { if (p.get('refresh_token') !== tokens.refresh) return json(res, 400, { error: 'invalid_grant' }); tokens.refreshed++; return json(res, 200, { access_token: 'at-' + id(), expires_in: 3600 }); }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/revoke') { tokens.revoked = true; return json(res, 200, {}); }
    if (u.pathname === '/drive/v3/about') return json(res, 200, { user: { emailAddress: 'tester@example.com' } });
    if (!/^Bearer at-/.test(req.headers.authorization || '')) { await body(req); return json(res, 401, { error: { code: 401, message: 'no token', errors: [{ reason: 'authError' }] } }); }
    // ---- files.list
    if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = u.searchParams.get('q') || '';
      const name = /name='((?:\\'|[^'])*)'/.exec(q); const parent = /'([^']+)' in parents/.exec(q); const folderOnly = /mimeType='application\/vnd.google-apps.folder'/.test(q);
      const out = [...files.values()].filter(x => (!name || x.name === name[1].replace(/\\'/g, "'")) && (!parent || x.parents.includes(parent[1])) && (!folderOnly || x.mimeType === 'application/vnd.google-apps.folder')).map(fileView);
      return json(res, 200, { files: out });
    }
    if (u.pathname === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse((await body(req)).toString() || '{}');
      const fid = id(); files.set(fid, { id: fid, name: meta.name, parents: meta.parents || ['root'], mimeType: meta.mimeType, data: Buffer.alloc(0), modifiedTime: Date.now() });
      return json(res, 200, { id: fid, name: meta.name });
    }
    let m;
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname))) {
      const file = files.get(m[1]);
      if (req.method === 'DELETE') { files.delete(m[1]); res.writeHead(file ? 204 : 404); return res.end(); }
      if (!file) return json(res, 404, { error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] } });
      if (u.searchParams.get('alt') === 'media') {
        const r = /bytes=(\d+)-/.exec(req.headers.range || '');
        const start = r ? +r[1] : 0;
        const chunk = file.data.subarray(start);
        res.writeHead(r ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': chunk.length });
        return res.end(chunk);
      }
      return json(res, 200, fileView(file));
    }
    // ---- resumable start
    if ((m = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(u.pathname)) && (req.method === 'POST' || req.method === 'PATCH') && u.searchParams.get('uploadType') === 'resumable') {
      const meta = JSON.parse((await body(req)).toString() || '{}');
      const sid = id();
      sessions.set(sid, { meta, size: +req.headers['x-upload-content-length'], data: [], received: 0, fileId: m[1] || null, mimeType: req.headers['x-upload-content-type'] });
      res.writeHead(200, { Location: `${base}/upload/session/${sid}`, 'Content-Length': 0 }); return res.end();
    }
    if ((m = /^\/upload\/session\/([^/]+)$/.exec(u.pathname)) && req.method === 'PUT') {
      const s = sessions.get(m[1]);
      if (!s) { await body(req); return json(res, 404, { error: { code: 404, message: 'session not found', errors: [{ reason: 'notFound' }] } }); }
      const cr = req.headers['content-range'] || '';
      const finish = () => {
        const data = Buffer.concat(s.data);
        let file;
        if (s.fileId && files.has(s.fileId)) { file = files.get(s.fileId); file.data = data; file.modifiedTime = Date.now(); if (s.meta.name) file.name = s.meta.name; }
        else { const fid = id(); file = { id: fid, name: s.meta.name, parents: s.meta.parents || ['root'], mimeType: s.mimeType, data, modifiedTime: Date.now() }; files.set(fid, file); }
        sessions.delete(m[1]); s.done = file;
        return json(res, 200, fileView(file));
      };
      const st = /^bytes \*\/(\d+)$/.exec(cr);
      if (st) { await body(req); if (s.done) return json(res, 200, fileView(s.done)); if (s.received >= s.size) return finish(); res.writeHead(308, s.received ? { Range: `bytes=0-${s.received - 1}`, 'Content-Length': 0 } : { 'Content-Length': 0 }); return res.end(); }
      const r = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
      if (!r) { await body(req); return json(res, 400, { error: { code: 400, message: 'bad Content-Range' } }); }
      if (+r[1] !== s.received) { await body(req); res.writeHead(308, s.received ? { Range: `bytes=0-${s.received - 1}` } : {}); return res.end(); }
      // stream the body in, keeping what arrived even if the client aborts
      const before = s.received;
      await new Promise(resolve => {
        req.on('data', d => { s.data.push(d); s.received += d.length; rec.bytes += d.length; });
        req.on('end', resolve); req.on('aborted', resolve); req.on('close', resolve); req.on('error', resolve);
      });
      // a cut-off chunk: Drive keeps only whole 256 KiB multiples; we keep what arrived (simpler, still exercises resume)
      if (req.aborted || req.destroyed && s.received - before < (+r[2] - +r[1] + 1)) { return; }
      if (s.received >= s.size) return finish();
      res.writeHead(308, { Range: `bytes=0-${s.received - 1}`, 'Content-Length': 0 }); return res.end();
    }
    await body(req);
    json(res, 404, { error: { code: 404, message: `mock: no route ${req.method} ${u.pathname}` } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, files, sessions, requests, faults, tokens,
    endpoints: { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, userinfo: `${base}/drive/v3/about?fields=user` },
    fail(method, pathRe, status, reason, times = 1) { faults.push({ method, pathRe, status, reason, times }); },
    /** pretend the user approved in the browser: make a code the token endpoint accepts */
    approve(authUrl) { const u = new URL(authUrl); const code = 'code-' + id(); tokens.codes.set(code, true); return `${u.searchParams.get('redirect_uri')}/?code=${code}&state=${u.searchParams.get('state')}`; },
    putFile(name, data, parents = ['root']) { const fid = id(); files.set(fid, { id: fid, name, parents, mimeType: 'video/mp4', data: Buffer.from(data), modifiedTime: Date.now() }); return fid; },
    byName(name) { return [...files.values()].find(f => f.name === name) || null; },
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** A GoogleAuth-like token source for DriveClient tests */
const staticToken = () => async () => 'at-static';

module.exports = { startMockDrive, staticToken };
