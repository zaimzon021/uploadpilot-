'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LaneScheduler } = require('../../src/autopilot/laneScheduler');
const { mulberry32 } = require('../../src/util/random');

function harness({ channels = 7, lanes = 3, runMs = 60, delay = { min: 0.001, max: 0.002 }, rng = mulberry32(42), now } = {}) {
  const due = new Set(Array.from({ length: channels }, (_, i) => i + 1));
  const log = []; let active = 0, maxActive = 0; const laneBusy = {};
  const sched = new LaneScheduler({
    lanes, delayRangeMin: delay, idleMs: 30, cooldownMs: 0, rng, now,
    getAllChannels: () => [...Array(channels).keys()].map(i => i + 1),
    getDueChannels: () => [...due],
    runChannel: async (id, lane) => {
      assert.ok(!laneBusy[lane], `lane ${lane} must be strictly sequential`);
      laneBusy[lane] = true; active++; maxActive = Math.max(maxActive, active);
      log.push({ id, lane, t: Date.now(), ev: 'start' });
      await new Promise(r => setTimeout(r, runMs));
      due.delete(id);
      log.push({ id, lane, t: Date.now(), ev: 'end' });
      active--; laneBusy[lane] = false;
    },
  });
  return { sched, due, log, stats: () => ({ maxActive }) };
}

test('3 lanes: every due channel runs once, never concurrently, max 3 at a time', async () => {
  const h = harness();
  h.sched.start();
  const t0 = Date.now();
  while (h.due.size && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 20));
  await h.sched.stop();
  const starts = h.log.filter(e => e.ev === 'start');
  assert.strictEqual(starts.length, 7);
  assert.strictEqual(new Set(starts.map(s => s.id)).size, 7);
  assert.ok(h.stats().maxActive <= 3 && h.stats().maxActive >= 2, `maxActive=${h.stats().maxActive}`);
  // each channel's run is contiguous in one lane
  for (const s of starts) { const e = h.log.find(x => x.ev === 'end' && x.id === s.id); assert.strictEqual(e.lane, s.lane); }
});

test('lane waits a random 1-7 min style delay between channels (scaled)', async () => {
  const waits = [];
  const sched = new LaneScheduler({ lanes: 1, delayRangeMin: { min: 1, max: 7 }, rng: mulberry32(7), getAllChannels: () => [], getDueChannels: () => [], runChannel: async () => {} });
  for (let i = 0; i < 500; i++) waits.push(sched.nextDelayMs());
  assert.ok(Math.min(...waits) >= 60000 && Math.max(...waits) <= 420000);
  assert.ok(Math.max(...waits) - Math.min(...waits) > 300000, 'spread across the range');
  // real loop: with one lane, gap between end of one run and start of next >= min delay
  const h = harness({ channels: 3, lanes: 1, runMs: 10, delay: { min: 0.002, max: 0.003 } }); // 120-180ms
  h.sched.start();
  const t0 = Date.now();
  while (h.due.size && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 10));
  await h.sched.stop();
  const ev = h.log;
  for (let i = 1; i < ev.length; i++) if (ev[i].ev === 'start') assert.ok(ev[i].t - ev[i - 1].t >= 110, `gap ${ev[i].t - ev[i - 1].t}`);
});

test('daily shuffle: order changes per day, stable within a day, new channels appended', () => {
  let day = new Date(2026, 10, 26, 10).getTime();
  let all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const s = new LaneScheduler({ lanes: 1, delayRangeMin: { min: 1, max: 2 }, rng: mulberry32(5), now: () => day, getAllChannels: () => all, getDueChannels: () => all, runChannel: async () => {} });
  const o1 = s.dailyOrder().slice();
  assert.deepStrictEqual(s.dailyOrder(), o1, 'stable within day');
  assert.deepStrictEqual([...o1].sort((a, b) => a - b), all);
  all = [...all, 11];
  assert.strictEqual(s.dailyOrder().at(-1), 11);
  day += 24 * 3600e3;
  const o2 = s.dailyOrder();
  assert.notDeepStrictEqual(o2, o1, 'reshuffled next day');
});

test('claimNext: least-recently-run first, busy and cooling channels skipped', () => {
  let t = 1e12;
  const s = new LaneScheduler({ lanes: 2, delayRangeMin: { min: 1, max: 2 }, cooldownMs: 1000, rng: mulberry32(1), now: () => t, getAllChannels: () => [1, 2, 3], getDueChannels: () => [1, 2, 3], runChannel: async () => {} });
  const a = s.claimNext(0), b = s.claimNext(1), c = s.claimNext(0);
  assert.strictEqual(new Set([a, b, c]).size, 3);
  assert.strictEqual(s.claimNext(1), null, 'all in progress');
  s.inProgress.clear();
  s.lastRun.set(a, t); s.lastRun.set(b, t - 5000); s.lastRun.set(c, t - 9000);
  assert.strictEqual(s.claimNext(0), c, 'oldest run first');
  assert.strictEqual(s.claimNext(1), b);
  assert.strictEqual(s.claimNext(0), null, 'a is cooling down');
});

test('stop() interrupts sleeping lanes promptly; runner errors do not kill a lane', async () => {
  let calls = 0;
  const s = new LaneScheduler({ lanes: 2, delayRangeMin: { min: 10, max: 10 }, idleMs: 60000, cooldownMs: 0, getAllChannels: () => [1], getDueChannels: () => (calls < 1 ? [1] : []), runChannel: async () => { calls++; throw new Error('boom'); } });
  s.start();
  await new Promise(r => setTimeout(r, 100));
  const t0 = Date.now();
  await s.stop();
  assert.ok(Date.now() - t0 < 500, 'stopped fast');
  assert.strictEqual(calls, 1);
});
