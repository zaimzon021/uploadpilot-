'use strict';
// v0.3.1: an upload never starts without a title, description and tags.
// Helpers shared by the AI worker, the channel runner and the API.
const path = require('path');
const { cutAtWord } = require('../ai/gemini');

const parseList = v => { if (Array.isArray(v)) return v; try { const j = JSON.parse(v || '[]'); return Array.isArray(j) ? j : []; } catch (_) { return []; } };
const hasText = v => typeof v === 'string' && v.trim().length > 0;

/** Which metadata fields are missing on a video row. */
function missingFields(v) {
  const out = [];
  if (!v || !hasText(v.title)) out.push('title');
  if (!v || !hasText(v.description)) out.push('description');
  if (!v || !parseList(v.tags).length) out.push('tags');
  return out;
}
const isComplete = v => missingFields(v).length === 0;

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
/** "my_cat-video_FINAL.mp4" -> "My Cat Video Final" (no extension, no underscores, Title Case, ≤ 70 chars). */
function titleFromFilename(filename) {
  let base = path.basename(String(filename || ''));
  base = base.replace(/\.[a-z0-9]{2,5}$/i, '');
  base = base.replace(/[_\-.+]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s{2,}/g, ' ').trim();
  if (!base || /^\d+$/.test(base)) base = base ? `Video ${base}` : 'New Video';
  const words = base.split(' ').map((w, i) => {
    if (/^[A-Z0-9]{2,}$/.test(w) && w.length <= 4) return w;              // keep short acronyms (USA, 4K)
    const lw = w.toLowerCase();
    if (i > 0 && SMALL.has(lw)) return lw;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  });
  return cutAtWord(words.join(' '), 70);
}

/** Basic metadata when Gemini can't help: clean title + a short description + tags from the title words. */
function fallbackMeta(filename, style = {}) {
  const title = titleFromFilename(filename);
  const niche = style && style.niche ? String(style.niche).split(/[.\n]/)[0].trim().slice(0, 120) : '';
  const description = `${title}${niche ? ` — ${niche}` : ''}.\n\nThanks for watching! Like, comment and subscribe for more.`;
  const tags = [...new Set(title.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !SMALL.has(w)))].slice(0, 10);
  if (!tags.length) tags.push('video');
  return { title, description, tags, hashtags: [] };
}

/** Upload job fields, never null: anything missing falls back to the file name. */
function safeJobFields(v, style = {}) {
  const fb = fallbackMeta(v && v.filename, style);
  const title = hasText(v && v.title) ? String(v.title).trim() : fb.title;
  const description = hasText(v && v.description) ? String(v.description) : fb.description;
  const tags = parseList(v && v.tags).map(t => String(t)).filter(Boolean);
  const hashtags = parseList(v && v.hashtags).map(t => String(t)).filter(Boolean);
  return { title, description, tags: tags.length ? tags : fb.tags, hashtags };
}

module.exports = { missingFields, isComplete, titleFromFilename, fallbackMeta, safeJobFields, parseList, hasText };
