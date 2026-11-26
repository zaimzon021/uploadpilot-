'use strict';
// Low-bandwidth copies for Gemini: a 360p, low-bitrate re-encode is plenty for writing a title, and
// is a fraction of the original's size to upload. ffmpeg runs one job at a time at idle priority.
// If ffmpeg is missing or fails, the original file is used (never blocks metadata).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

let cachedPath; // undefined = not looked up yet

/** ffmpeg binary: setting -> bundled (resources/ffmpeg) -> ffmpeg-static -> PATH. null if none. */
function findFfmpeg({ configured = '', resourcesPath = process.resourcesPath, refresh = false } = {}) {
  if (configured) return fs.existsSync(configured) ? configured : null;
  if (cachedPath !== undefined && !refresh) return cachedPath;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const cands = [];
  if (resourcesPath) cands.push(path.join(resourcesPath, 'ffmpeg', exe));
  try { const p = require('ffmpeg-static'); if (p) cands.push(p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)); } catch (_) { /* not installed */ }
  cachedPath = cands.find(p => { try { return fs.existsSync(p) && fs.statSync(p).size > 1e6; } catch (_) { return false; } }) || null;
  if (!cachedPath) { try { execFileSync(exe, ['-version'], { stdio: 'ignore', timeout: 5000 }); cachedPath = exe; } catch (_) { cachedPath = null; } }
  return cachedPath;
}

// one ffmpeg at a time
let chain = Promise.resolve();
function serial(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

function lowPriority(pid) {
  try { os.setPriority(pid, os.constants.priority.PRIORITY_LOW); } catch (_) { /* best effort (Windows: IDLE_PRIORITY_CLASS) */ }
}

/**
 * Make a small copy. Resolves {path, lowres:true, ms, bytes} or {path: input, lowres:false, reason}.
 * @param {string} input
 * @param {object} [o]
 * @param {string} [o.outDir]       defaults to os.tmpdir()/uploadpilot-lowres
 * @param {number} [o.height=360]
 * @param {number} [o.videoKbps=300]
 * @param {string} [o.ffmpegPath]
 * @param {number} [o.timeoutMs=20 min]
 */
function makeLowRes(input, o = {}) {
  return serial(async () => {
    const ff = o.ffmpegPath !== undefined ? o.ffmpegPath : findFfmpeg({ configured: o.configured || '' });
    if (!ff) return { path: input, lowres: false, reason: 'ffmpeg not found' };
    const outDir = o.outDir || path.join(os.tmpdir(), 'uploadpilot-lowres');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `${path.basename(input, path.extname(input))}-${process.pid}-${Date.now()}-360p.mp4`);
    const h = o.height || 360, kbps = o.videoKbps || 300;
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-vf', `scale=-2:'min(${h},ih)'`, '-r', '15', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`,
      '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-threads', '2', '-movflags', '+faststart', out];
    const t0 = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const p = spawn(ff, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        lowPriority(p.pid);
        let err = '';
        p.stderr.on('data', d => { err = (err + d).slice(-2000); });
        const t = setTimeout(() => { p.kill(); reject(new Error('ffmpeg timed out')); }, o.timeoutMs || 20 * 60000);
        p.on('error', e => { clearTimeout(t); reject(e); });
        p.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.trim().split('\n').pop()}`)); });
      });
      const bytes = fs.statSync(out).size;
      if (!bytes) throw new Error('ffmpeg wrote an empty file');
      return { path: out, lowres: true, ms: Date.now() - t0, bytes, originalBytes: fs.statSync(input).size };
    } catch (e) {
      try { fs.unlinkSync(out); } catch (_) { /* none */ }
      return { path: input, lowres: false, reason: e.message };
    }
  });
}

module.exports = { makeLowRes, findFfmpeg };
