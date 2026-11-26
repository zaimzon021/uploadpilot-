'use strict';
// Folder scan: videos (mp4/mov/mkv/webm) + thumbnail with the same base name (jpg/jpeg/png).
const fs = require('fs');
const path = require('path');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm']);
const THUMB_EXT = ['.jpg', '.jpeg', '.png'];
const DONE_DIR = 'Done';
const naturalCmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

const isVideo = f => VIDEO_EXT.has(path.extname(f).toLowerCase());
const isThumb = f => THUMB_EXT.includes(path.extname(f).toLowerCase());

function findThumb(videoPath, entries) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const names = entries || fs.readdirSync(dir);
  for (const ext of THUMB_EXT) {
    const hit = names.find(n => n.toLowerCase() === base + ext);
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/** Scan the top level of a folder (the Done subfolder is ignored). Sorted naturally by filename. */
function scanFolder(folder) {
  if (!folder || !fs.existsSync(folder)) throw new Error(`Folder not found: ${folder}`);
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  const names = entries.filter(e => e.isFile()).map(e => e.name);
  const out = [];
  for (const name of names) {
    if (!isVideo(name) || name.startsWith('.') || name.startsWith('~$')) continue;
    const full = path.join(folder, name);
    let size = 0; try { size = fs.statSync(full).size; } catch (_) { continue; }
    if (size === 0) continue;
    out.push({ path: full, filename: name, size, thumb: findThumb(full, names) });
  }
  out.sort((a, b) => naturalCmp(a.filename, b.filename));
  return out;
}

/** Move an uploaded file (and its thumbnail) into <folder>/Done, never overwriting. */
function moveToDone(videoPath, thumbPath) {
  const dir = path.join(path.dirname(videoPath), DONE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const mv = src => {
    if (!src || !fs.existsSync(src)) return null;
    let dest = path.join(dir, path.basename(src));
    if (fs.existsSync(dest)) { const e = path.extname(src); dest = path.join(dir, `${path.basename(src, e)}-${Date.now()}${e}`); }
    try { fs.renameSync(src, dest); } catch (e) { if (e.code === 'EXDEV') { fs.copyFileSync(src, dest); fs.unlinkSync(src); } else throw e; }
    return dest;
  };
  return { video: mv(videoPath), thumb: mv(thumbPath) };
}

module.exports = { scanFolder, findThumb, moveToDone, isVideo, isThumb, VIDEO_EXT, DONE_DIR, naturalCmp };
