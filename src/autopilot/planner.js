'use strict';
// Plan builder: assigns each unscheduled video a date/time inside the upload window,
// N per channel per day, spread across the window with random jitter.
const { startOfDay, addDays, windowBounds, dayKey } = require('../util/time');

/**
 * @param {object} o
 * @param {Array<{id:any}>} o.videos             unscheduled videos, in upload order
 * @param {number[]} o.existing                  already-planned timestamps for this channel (not done)
 * @param {number} o.perDay
 * @param {{start:string,end:string}} o.window
 * @param {number} o.now                         epoch ms
 * @param {() => number} o.rng
 * @param {number} [o.leadMinutes=10]            earliest slot today is now + lead
 * @param {number} [o.maxDays=730]
 * @returns {Array<{id:any, scheduled_at:number}>}
 */
function buildPlan({ videos, existing = [], perDay = 2, window, now, rng = Math.random, leadMinutes = 10, maxDays = 730 }) {
  if (!(perDay >= 1)) throw new Error('perDay must be >= 1');
  const out = [];
  const queue = videos.slice();
  const taken = existing.slice().sort((a, b) => a - b);
  let day = startOfDay(now);
  for (let d = 0; d < maxDays && queue.length; d++, day = addDays(startOfDay(now), d)) {
    const { start: ws, end: we } = windowBounds(day, window);
    if (we <= ws) throw new Error('Upload window end must be after start');
    const seg = (we - ws) / perDay;
    const earliest = d === 0 ? now + leadMinutes * 60000 : ws;
    const onDay = taken.filter(t => dayKey(t) === dayKey(day));
    let free = perDay - onDay.length;
    if (free <= 0) continue;
    for (let i = 0; i < perDay && free > 0 && queue.length; i++) {
      let a = ws + i * seg, b = a + seg;
      if (onDay.some(t => t >= a && t < b)) continue;           // segment already used
      // keep a margin so neighbouring slots never touch
      const margin = seg * 0.1;
      a += margin; b -= margin;
      if (b <= earliest) continue;                               // segment is in the past
      a = Math.max(a, earliest);
      if (b - a < 60000) continue;
      const t = Math.floor(a + rng() * (b - a));
      const ts = t - (t % 60000);                                // whole minutes
      out.push({ id: queue.shift().id, scheduled_at: ts });
      taken.push(ts); onDay.push(ts); free--;
    }
  }
  return out;
}

module.exports = { buildPlan };
