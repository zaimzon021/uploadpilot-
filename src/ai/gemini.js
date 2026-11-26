'use strict';
// Gemini via REST: Files API resumable upload -> wait ACTIVE -> generateContent (JSON) -> delete file.
// Rotates across many API keys; a key that answers 429 is cooled down and the next key is tried.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm' };

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    description: { type: 'STRING' },
    tags: { type: 'ARRAY', items: { type: 'STRING' } },
    hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['title', 'description', 'tags', 'hashtags'],
};

class GeminiError extends Error { constructor(msg, status, retryAfterMs) { super(msg); this.status = status; this.retryAfterMs = retryAfterMs; } }

const keyHash = k => crypto.createHash('sha1').update(k).digest('hex').slice(0, 12);

class KeyPool {
  constructor(keys, { now = () => Date.now() } = {}) {
    this.keys = keys.filter(Boolean).map(k => ({ key: k, coolUntil: 0, fails: 0, calls: 0 }));
    this.i = 0; this.now = now;
  }
  get size() { return this.keys.length; }
  /** next key not cooling down, round-robin; null when all are cooling */
  next() {
    const n = this.keys.length;
    for (let j = 0; j < n; j++) {
      const k = this.keys[(this.i + j) % n];
      if (k.coolUntil <= this.now()) { this.i = (this.i + j + 1) % n; k.calls++; return k; }
    }
    return null;
  }
  cool(k, ms) { k.fails++; k.coolUntil = this.now() + ms; }
  ok(k) { k.fails = 0; }
  soonestMs() { return Math.max(0, Math.min(...this.keys.map(k => k.coolUntil)) - this.now()); }
}

function buildPrompt(style = {}, filename = '') {
  const lang = style.language || 'English';
  return [
    'You are writing YouTube metadata for the attached video. Watch the whole video first.',
    `Channel niche / tone: ${style.niche || 'general'}.`,
    `Write everything in ${lang}.`,
    'Return ONLY a JSON object: {"title": string, "description": string, "tags": string[], "hashtags": string[]}.',
    '- title: max 100 characters, catchy and accurate to what happens in the video, no clickbait lies, no surrounding quotes.',
    '- description: 2-4 short paragraphs describing the video, natural keywords, no hashtags and no links (a footer is added automatically).',
    '- tags: 8-15 search tags, no # sign, total under 450 characters.',
    '- hashtags: 3-5 hashtags, each starting with #, no spaces.',
    style.madeForKids ? '- The audience is children: keep it family friendly.' : '',
    filename ? `Original file name (may hint at the topic): ${filename}` : '',
  ].filter(Boolean).join('\n');
}

/** Parse + validate the model output. Accepts raw JSON, ```json fences, or a response object. */
function parseGeminiResponse(input) {
  let text = input;
  if (input && typeof input === 'object') {
    const cand = input.candidates?.[0];
    if (!cand) throw new Error(input.promptFeedback?.blockReason ? `Blocked: ${input.promptFeedback.blockReason}` : 'No candidates in Gemini response');
    if (cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason) && !cand.content) throw new Error(`Gemini finished with ${cand.finishReason}`);
    text = (cand.content?.parts || []).map(p => p.text || '').join('');
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('Empty Gemini response');
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{')) { const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1); }
  let j;
  try { j = JSON.parse(s); } catch (e) { throw new Error(`Gemini returned invalid JSON: ${e.message}`); }
  if (Array.isArray(j)) j = j[0];
  return normalizeMeta(j);
}

function normalizeMeta(j) {
  if (!j || typeof j !== 'object') throw new Error('Gemini JSON is not an object');
  let title = String(j.title || '').replace(/[\r\n]+/g, ' ').replace(/^["'“”]+|["'“”]+$/g, '').replace(/[<>]/g, '').trim();
  if (!title) throw new Error('Gemini JSON has no title');
  if ([...title].length > 100) { const cut = [...title].slice(0, 100).join(''); const sp = cut.lastIndexOf(' '); title = (sp > 60 ? cut.slice(0, sp) : cut).trim(); }
  const description = String(j.description || '').replace(/[<>]/g, '').trim();
  const toList = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : []).map(x => String(x).trim()).filter(Boolean);
  const seen = new Set();
  let tags = toList(j.tags).map(t => t.replace(/^#/, '').replace(/[<>,]/g, '').trim()).filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  // YouTube limit: tags total 500 chars; keep under 450 to be safe
  let total = 0; tags = tags.filter(t => (total += t.length + 1) <= 450);
  const hs = new Set();
  const hashtags = toList(j.hashtags).map(h => '#' + h.replace(/^#+/, '').replace(/\s+/g, '')).filter(h => h.length > 1 && !hs.has(h.toLowerCase()) && hs.add(h.toLowerCase())).slice(0, 15);
  return { title, description, tags, hashtags };
}

/** Compose the description that will be uploaded: AI text + fixed footer + hashtags (channel + AI). */
function composeDescription(meta, style = {}) {
  const parts = [meta.description || ''];
  if (style.footer) parts.push(style.footer.trim());
  const tags = [];
  const seen = new Set();
  for (const h of [...(meta.hashtags || []), ...String(style.hashtags || '').split(/[\s,]+/)]) {
    const t = h && ('#' + h.replace(/^#+/, ''));
    if (t && t.length > 1 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); tags.push(t); }
  }
  if (tags.length) parts.push(tags.join(' '));
  return parts.filter(Boolean).join('\n\n').slice(0, 4900);
}

class GeminiClient {
  constructor({ keys, model, baseUrl = 'https://generativelanguage.googleapis.com', fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), onUsage, log = () => {}, activeTimeoutMs = 10 * 60000, pollMs = 3000 }) {
    this.pool = new KeyPool(keys);
    this.model = model; this.base = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl; this.sleep = sleep; this.onUsage = onUsage || (() => {}); this.log = log;
    this.activeTimeoutMs = activeTimeoutMs; this.pollMs = pollMs;
  }

  async _json(res) { const t = await res.text(); try { return JSON.parse(t); } catch (_) { return { raw: t }; } }
  _err(res, body, what) {
    const retryAfter = +res.headers.get('retry-after') * 1000 || null;
    return new GeminiError(`${what}: HTTP ${res.status} ${body?.error?.message || body?.raw?.slice?.(0, 200) || ''}`.trim(), res.status, retryAfter);
  }

  async uploadFile(k, filePath) {
    const size = fs.statSync(filePath).size;
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'video/mp4';
    let res = await this.fetch(`${this.base}/upload/v1beta/files?key=${encodeURIComponent(k.key)}`, {
      method: 'POST',
      headers: { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: { display_name: path.basename(filePath) } }),
    });
    if (!res.ok) throw this._err(res, await this._json(res), 'Files API start');
    const uploadUrl = res.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new GeminiError('Files API start: no upload URL returned', 500);
    res = await this.fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Length': String(size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: Readable.toWeb(fs.createReadStream(filePath)), duplex: 'half',
    });
    const body = await this._json(res);
    if (!res.ok) throw this._err(res, body, 'Files API upload');
    const file = body.file || body;
    if (!file?.name) throw new GeminiError('Files API upload: no file name in response', 500);
    return { ...file, mimeType: file.mimeType || mime };
  }

  async waitActive(k, file) {
    const t0 = Date.now();
    let f = file;
    while (f.state && f.state !== 'ACTIVE') {
      if (f.state === 'FAILED') throw new GeminiError(`Gemini could not process the video (${f.error?.message || 'FAILED'})`, 422);
      if (Date.now() - t0 > this.activeTimeoutMs) throw new GeminiError('Timed out waiting for Gemini to process the video', 504);
      await this.sleep(this.pollMs);
      const res = await this.fetch(`${this.base}/v1beta/${f.name}?key=${encodeURIComponent(k.key)}`);
      const body = await this._json(res);
      if (!res.ok) throw this._err(res, body, 'Files API get');
      f = body;
    }
    return f;
  }

  async deleteFile(k, file) {
    try { await this.fetch(`${this.base}/v1beta/${file.name}?key=${encodeURIComponent(k.key)}`, { method: 'DELETE' }); } catch (_) { /* best effort */ }
  }

  async generate(k, file, prompt) {
    const res = await this.fetch(`${this.base}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(k.key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ file_data: { mime_type: file.mimeType, file_uri: file.uri } }, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0.8 },
      }),
    });
    const body = await this._json(res);
    if (!res.ok) throw this._err(res, body, 'generateContent');
    return parseGeminiResponse(body);
  }

  /** Full pipeline with key rotation and 429/5xx back-off. Files are per-key, so one attempt = one key end-to-end. */
  async describeVideo(filePath, style = {}, { maxAttempts = 4 } = {}) {
    if (!this.pool.size) throw new GeminiError('No Gemini API keys configured', 400);
    const prompt = buildPrompt(style, path.basename(filePath));
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let k = this.pool.next();
      if (!k) { const wait = Math.min(this.pool.soonestMs() + 500, 120000); this.log(`All Gemini keys cooling down, waiting ${Math.round(wait / 1000)}s`); await this.sleep(wait); k = this.pool.next(); if (!k) continue; }
      let file = null;
      try {
        file = await this.uploadFile(k, filePath);
        file = await this.waitActive(k, file);
        const meta = await this.generate(k, file, prompt);
        this.pool.ok(k); this.onUsage(keyHash(k.key), true);
        return meta;
      } catch (e) {
        lastErr = e; this.onUsage(keyHash(k.key), false);
        if (e.status === 429) { this.pool.cool(k, e.retryAfterMs || Math.min(60000 * 2 ** (k.fails), 15 * 60000)); this.log(`Gemini key …${k.key.slice(-4)} rate-limited, rotating`); }
        else if (e.status === 401 || e.status === 403) { this.pool.cool(k, 6 * 3600000); this.log(`Gemini key …${k.key.slice(-4)} rejected (${e.status}), disabled for 6h`); }
        else if (e.status >= 500 || !e.status) { await this.sleep(Math.min(2000 * 2 ** attempt, 30000)); }
        else if (e.status === 400 && /model/i.test(e.message)) throw e; // bad model name: don't burn keys
        else if (e.status === 422) throw e;
        // JSON/parse errors (no status) fall through and retry with the next key
      } finally { if (file?.name) await this.deleteFile(k, file); }
    }
    throw lastErr || new GeminiError('Gemini failed', 500);
  }

  async listModels() {
    const k = this.pool.next();
    if (!k) throw new GeminiError('No Gemini API keys configured', 400);
    const res = await this.fetch(`${this.base}/v1beta/models?key=${encodeURIComponent(k.key)}&pageSize=200`);
    const body = await this._json(res);
    if (!res.ok) throw this._err(res, body, 'list models');
    return (body.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
  }
}

module.exports = { GeminiClient, KeyPool, parseGeminiResponse, normalizeMeta, composeDescription, buildPrompt, keyHash, GeminiError, RESPONSE_SCHEMA };
