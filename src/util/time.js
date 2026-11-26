'use strict';
// Local-time helpers. All plan times are epoch ms; "local" = the machine's timezone.
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Invalid time "${s}", expected HH:MM`);
  const h = +m[1], min = +m[2];
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`Invalid time "${s}"`);
  return h * 60 + min;
}
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }
function atMinutes(dayStartTs, minutes) { const d = new Date(dayStartTs); d.setHours(0, 0, 0, 0); d.setMinutes(minutes); return d.getTime(); }
function windowBounds(dayTs, window) {
  const s = startOfDay(dayTs);
  return { start: atMinutes(s, parseHHMM(window.start)), end: atMinutes(s, parseHHMM(window.end)) };
}
function inWindow(ts, window) { const b = windowBounds(ts, window); return ts >= b.start && ts < b.end; }
/** ts if it is inside the daily upload window, else the next window start (plus up to 10 min, so retries don't bunch up). */
function nextInWindow(ts, window, rng = Math.random) {
  if (inWindow(ts, window)) return ts;
  let b = windowBounds(ts, window);
  if (ts >= b.end) b = windowBounds(addDays(startOfDay(ts), 1), window);
  return b.start + Math.floor(rng() * 10) * 60000;
}
module.exports = { nextInWindow, parseHHMM, dayKey, startOfDay, addDays, atMinutes, windowBounds, inWindow };
