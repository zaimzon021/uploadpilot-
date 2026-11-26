'use strict';
// Local HTTP server imitating the Gemini REST surface used by UploadPilot:
// resumable Files API upload, file GET (PROCESSING -> ACTIVE), generateContent, file DELETE, models list.
const http = require('http');

function startMockGemini({ rateLimitedKeys = new Set(), badKeys = new Set(), processingPolls = 1, respond } = {}) {
  const stats = { starts: 0, uploads: 0, bytes: 0, gets: 0, generates: 0, deletes: 0, byKey: {}, prompts: [] };
  const files = new Map();
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const key = u.searchParams.get('key');
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (key) stats.byKey[key] = (stats.byKey[key] || 0) + 1;
    if (key && badKeys.has(key)) return json(403, { error: { code: 403, message: 'API key not valid' } });
    if (key && rateLimitedKeys.has(key)) return json(429, { error: { code: 429, message: 'Resource has been exhausted' } });
    if (req.method === 'POST' && u.pathname === '/upload/v1beta/files') {
      stats.starts++;
      if (req.headers['x-goog-upload-protocol'] !== 'resumable' || req.headers['x-goog-upload-command'] !== 'start') return json(400, { error: { message: 'bad start headers' } });
      const id = `files/mock${++n}`;
      files.set(id, { name: id, uri: `https://mock/v1beta/${id}`, mimeType: req.headers['x-goog-upload-header-content-type'], state: 'PROCESSING', polls: 0, key, expected: +req.headers['x-goog-upload-header-content-length'] });
      res.writeHead(200, { 'x-goog-upload-url': `http://127.0.0.1:${server.address().port}/upload-session/${encodeURIComponent(id)}`, 'x-goog-upload-status': 'active' });
      return res.end();
    }
    if (req.method === 'POST' && u.pathname.startsWith('/upload-session/')) {
      const id = decodeURIComponent(u.pathname.slice('/upload-session/'.length));
      const f = files.get(id);
      stats.uploads++; stats.bytes += body.length;
      if (!f || !/finalize/.test(req.headers['x-goog-upload-command'] || '')) return json(400, { error: { message: 'bad upload' } });
      if (f.expected !== body.length) return json(400, { error: { message: `size mismatch ${body.length} != ${f.expected}` } });
      return json(200, { file: { name: f.name, uri: f.uri, mimeType: f.mimeType, state: processingPolls ? 'PROCESSING' : 'ACTIVE' } });
    }
    let m;
    if ((m = /^\/v1beta\/(files\/[\w-]+)$/.exec(u.pathname))) {
      const f = files.get(m[1]);
      if (!f) return json(404, { error: { message: 'no such file' } });
      if (f.key !== key) return json(403, { error: { message: 'file belongs to another project' } });
      if (req.method === 'DELETE') { stats.deletes++; files.delete(m[1]); return json(200, {}); }
      stats.gets++; f.polls++;
      if (f.polls >= processingPolls) f.state = 'ACTIVE';
      return json(200, { name: f.name, uri: f.uri, mimeType: f.mimeType, state: f.state });
    }
    if (req.method === 'POST' && (m = /^\/v1beta\/models\/([^:]+):generateContent$/.exec(u.pathname))) {
      stats.generates++;
      const reqBody = JSON.parse(body.toString());
      const fd = reqBody.contents[0].parts.find(p => p.file_data);
      const f = files.get(fd.file_data.file_uri.replace('https://mock/v1beta/', ''));
      if (!f || f.state !== 'ACTIVE') return json(400, { error: { message: 'file not active' } });
      if (f.key !== key) return json(403, { error: { message: 'file belongs to another project' } });
      const prompt = reqBody.contents[0].parts.find(p => p.text).text;
      stats.prompts.push(prompt);
      const out = respond ? respond({ prompt, model: m[1], n: stats.generates }) : { title: `Mock title ${stats.generates}`, description: 'A mock description.', tags: ['mock', 'test'], hashtags: ['#mock'] };
      if (out && out.__status) return json(out.__status, { error: { message: out.message || 'err' } });
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      return json(200, { candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }] });
    }
    if (req.method === 'GET' && u.pathname === '/v1beta/models') return json(200, { models: [{ name: 'models/gemini-mock-flash', supportedGenerationMethods: ['generateContent'] }] });
    json(404, { error: { message: `mock: no route ${req.method} ${u.pathname}` } });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, stats, files, rateLimitedKeys, badKeys, close: () => new Promise(c => server.close(() => c())) })));
}

module.exports = { startMockGemini };
