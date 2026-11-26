'use strict';
// Log rotation: daily app logs and per-run folders older than `days` are deleted, an app log over
// `maxBytes` is rolled to app-DATE.1.log, the activity table keeps the newest `keepEvents` rows,
// and stale download cache files are removed.
const fs = require('fs');
const path = require('path');

function rotateLogs({ logsDir, db = null, days = 14, maxBytes = 20 * 1024 * 1024, keepEvents = 20000, cacheDir = null, now = Date.now() }) {
  const out = { removedFiles: 0, removedRunDirs: 0, rolled: 0, prunedEvents: 0, cacheFiles: 0 };
  const cutoff = now - days * 86400000;
  const dayOf = name => { const m = /(\d{4}-\d{2}-\d{2})/.exec(name); return m ? new Date(m[1] + 'T00:00:00').getTime() : null; };
  try {
    for (const f of fs.readdirSync(logsDir)) {
      const full = path.join(logsDir, f);
      if (!/^app-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(f)) continue;
      const d = dayOf(f);
      if (d !== null && d < cutoff) { fs.rmSync(full, { force: true }); out.removedFiles++; continue; }
      if (/^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)) {
        try {
          if (fs.statSync(full).size > maxBytes) {
            let n = 1; while (fs.existsSync(full.replace(/\.log$/, `.${n}.log`))) n++;
            fs.renameSync(full, full.replace(/\.log$/, `.${n}.log`)); out.rolled++;
          }
        } catch (_) { /* in use */ }
      }
    }
  } catch (_) { /* no logs dir */ }
  try {
    const runs = path.join(logsDir, 'runs');
    for (const d of fs.readdirSync(runs)) {
      const t = dayOf(d);
      if (t !== null && t < cutoff) { fs.rmSync(path.join(runs, d), { recursive: true, force: true }); out.removedRunDirs++; }
    }
  } catch (_) { /* none */ }
  if (db) {
    try {
      const row = db.get('SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?', keepEvents);
      if (row) out.prunedEvents = db.run('DELETE FROM events WHERE id<=?', row.id).changes;
    } catch (_) { /* ignore */ }
  }
  if (cacheDir) {
    try {
      for (const f of fs.readdirSync(cacheDir)) {
        const full = path.join(cacheDir, f);
        try { if (fs.statSync(full).mtimeMs < now - 2 * 86400000) { fs.rmSync(full, { recursive: true, force: true }); out.cacheFiles++; } } catch (_) { /* gone */ }
      }
    } catch (_) { /* none */ }
  }
  return out;
}

module.exports = { rotateLogs };
