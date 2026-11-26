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

// YouTube limits: title 100 chars (we aim much shorter), description 5000 bytes-ish chars, tags 500 chars total.
const LIMITS = { titleMax: 70, descriptionMax: 4990, tagsMax: 490 };

function buildPrompt(style = {}, filename = '') {
  const lang = style.language || 'English';
  return [
    'You are a YouTube SEO expert writing metadata for the attached video. Watch the whole video first, then write metadata that ranks in YouTube search and gets clicks while staying 100% honest about what is in the video.',
    `Channel niche / style note (follow it): ${style.niche || 'general'}.`,
    `Write everything in ${lang}.`,
    'Return ONLY a JSON object: {"title": string, "description": string, "tags": string[], "hashtags": string[]}.',
    '',
    'TITLE:',
    '- SEO-optimized, engaging and click-worthy, but honest: it must match what actually happens in the video. No misleading clickbait, no fake claims, no ALL CAPS sentences, no surrounding quotes.',
    '- SHORT: aim for 40-60 characters, never more than 70 characters.',
    '- Put the main keyword (what people would search for) near the start of the title.',
    '',
    'DESCRIPTION (long and SEO-optimized):',
    '- Aim for about 1,500-3,000 characters; never exceed 4,500 characters.',
    '- The first 2 lines are a strong hook that contains the main keywords — they are shown above the fold, so make them count.',
    '- Then several paragraphs describing in detail what happens in the video (scenes, moments, what the viewer will see or learn), using the main and related keywords naturally. No keyword stuffing, no lists of keywords.',
    '- End with a short call to action (ask viewers to like, comment and subscribe).',
    '- Plain text with paragraph breaks (\\n\\n). No links, no "<" or ">" characters, and do NOT put hashtags in the description text (they are added at the end automatically from the hashtags field).',
    '',
    'TAGS:',
    '- 10-20 relevant search keywords and phrases (main keyword, variations, related topics), no # sign, total under 450 characters.',
    '',
    'HASHTAGS:',
    '- 3-5 relevant hashtags, each starting with #, no spaces. They are placed at the end of the description.',
    style.madeForKids ? '\nThe audience is children: keep everything family friendly.' : '',
    filename ? `\nOriginal file name (may hint at the topic): ${filename}` : '',
  ].filter(x => x !== '').join('\n');
}

/** Cut text to max chars at a word boundary (no trailing punctuation dangling). */
function cutAtWord(text, max) {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max + 1).join('');
  const sp = cut.lastIndexOf(' ');
  const out = (sp > max * 0.5 ? cut.slice(0, sp) : chars.slice(0, max).join(''));
  return out.replace(/[\s\-–—:,;|&/]+$/, '').trim();
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
  let title = String(j.title || '').replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/^["'“”]+|["'“”]+$/g, '').replace(/[<>]/g, '').trim();
  if (!title) throw new Error('Gemini JSON has no title');
  title = cutAtWord(title, LIMITS.titleMax);
  let description = String(j.description || '').replace(/[<>]/g, '').replace(/\r\n/g, '\n').trim();
  // hashtags the model left at the end of the text move to the hashtags list (they are re-added once, at the end)
  const extraTags = [];
  const lines = description.split('\n');
  while (lines.length && /^\s*(#[^\s#]+\s*)+$/.test(lines[lines.length - 1])) extraTags.unshift(...lines.pop().trim().split(/\s+/));
  description = lines.join('\n').trim();
  if (description.length > LIMITS.descriptionMax) description = cutAtWord(description, LIMITS.descriptionMax);
  const toList = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : []).map(x => String(x).trim()).filter(Boolean);
  const seen = new Set();
  let tags = toList(j.tags).map(t => t.replace(/^#/, '').replace(/[<>,]/g, '').trim()).filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  // YouTube limit: 500 chars for all tags; a tag with spaces is counted with surrounding quotes, plus a comma each
  let total = 0; tags = tags.filter(t => { const cost = t.length + (/\s/.test(t) ? 2 : 0) + 1; if (total + cost > LIMITS.tagsMax) return false; total += cost; return true; });
  const hs = new Set();
  const hashtags = [...toList(j.hashtags), ...extraTags].map(h => '#' + h.replace(/^#+/, '').replace(/\s+/g, '')).filter(h => h.length > 1 && !hs.has(h.toLowerCase()) && hs.add(h.toLowerCase())).slice(0, 15);
  return { title, description, tags, hashtags };
}

/** Compose the description that will be uploaded: AI text + fixed footer + hashtags (channel + AI), always < 5000 chars. */
function composeDescription(meta, style = {}) {
  const tags = [];
  const seen = new Set();
  for (const h of [...(meta.hashtags || []), ...String(style.hashtags || '').split(/[\s,]+/)]) {
    const t = h && ('#' + h.replace(/^#+/, ''));
    if (t && t.length > 1 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); tags.push(t); }
  }
  const tail = [style.footer ? style.footer.trim() : '', tags.slice(0, 15).join(' ')].filter(Boolean);
  const tailLen = tail.reduce((n, t) => n + t.length + 2, 0);
  let body = String(meta.description || '').trim();
  const budget = LIMITS.descriptionMax - tailLen;
  if (body.length > budget) body = budget > 0 ? cutAtWord(body, budget) : '';
  return [body, ...tail].filter(Boolean).join('\n\n').slice(0, LIMITS.descriptionMax);
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
    let res = await this.fetch(`${this.base}/upload/v1beta/files`, {
      method: 'POST',
      headers: { 'x-goog-api-key': k.key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' },
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
      const res = await this.fetch(`${this.base}/v1beta/${f.name}`, { headers: { 'x-goog-api-key': k.key } });
      const body = await this._json(res);
      if (!res.ok) throw this._err(res, body, 'Files API get');
      f = body;
    }
    return f;
  }

  async deleteFile(k, file) {
    try { await this.fetch(`${this.base}/v1beta/${file.name}`, { method: 'DELETE', headers: { 'x-goog-api-key': k.key } }); } catch (_) { /* best effort */ }
  }

  async generate(k, file, prompt) {
    const res = await this.fetch(`${this.base}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k.key },
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

  /** Raw model list for one key (key sent in the x-goog-api-key header; any key format, e.g. AIza… or AQ.…). */
  async _listModelsWith(key) {
    const res = await this.fetch(`${this.base}/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    const body = await this._json(res);
    if (!res.ok) throw this._err(res, body, 'list models');
    return (body.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
  }

  async listModels() {
    const k = this.pool.next();
    if (!k) throw new GeminiError('No Gemini API keys configured', 400);
    return this._listModelsWith(k.key);
  }

  /** Check every key on its own: [{ key: '…abcd', ok, models?, error? }]. */
  async testKeys() {
    if (!this.pool.size) throw new GeminiError('No Gemini API keys configured', 400);
    const out = [];
    for (const k of this.pool.keys) {
      try { const models = await this._listModelsWith(k.key); out.push({ key: '…' + k.key.slice(-4), ok: true, models }); }
      catch (e) { out.push({ key: '…' + k.key.slice(-4), ok: false, error: e.message, status: e.status || null }); }
    }
    return out;
  }
}

/** Best Gemini "flash" model for video metadata among names that support generateContent: stable > preview,
 *  newest version first, full flash before flash-lite. Skips image/tts/audio/live/embedding variants. */
function pickBestModel(models = []) {
  const ver = n => { const m = /gemini-(\d+(?:\.\d+)?)/.exec(n); return m ? parseFloat(m[1]) : 0; };
  const cands = models.filter(n => /flash/i.test(n) && !/(image|tts|audio|live|embed|thinking|computer|robotics)/i.test(n));
  const rank = n => [/(preview|exp)/i.test(n) ? 1 : 0, -ver(n), /lite/i.test(n) ? 1 : 0, /latest/i.test(n) ? 1 : 0, n.length];
  cands.sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.localeCompare(b); });
  return cands[0] || null;
}

module.exports = { GeminiClient, pickBestModel, cutAtWord, LIMITS, KeyPool, parseGeminiResponse, normalizeMeta, composeDescription, buildPrompt, keyHash, GeminiError, RESPONSE_SCHEMA };
