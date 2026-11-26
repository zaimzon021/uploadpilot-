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
module.exports = { parseHHMM, dayKey, startOfDay, addDays, atMinutes, windowBounds, inWindow };
