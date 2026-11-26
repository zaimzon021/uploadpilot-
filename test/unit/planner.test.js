'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildPlan } = require('../../src/autopilot/planner');
const { mulberry32 } = require('../../src/util/random');
const { dayKey, parseHHMM, windowBounds, inWindow } = require('../../src/util/time');

const W = { start: '09:00', end: '23:00' };
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const vids = n => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
const minutesOfDay = t => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };

test('2 per day, spread inside the window, in order', () => {
  const now = at(2026, 11, 26, 8, 0);
  const plan = buildPlan({ videos: vids(5), perDay: 2, window: W, now, rng: mulberry32(1) });
  assert.strictEqual(plan.length, 5);
  assert.deepStrictEqual(plan.map(p => p.id), [1, 2, 3, 4, 5]);
  const byDay = {};
  for (const p of plan) (byDay[dayKey(p.scheduled_at)] ||= []).push(p.scheduled_at);
  assert.deepStrictEqual(Object.values(byDay).map(a => a.length), [2, 2, 1]);
  for (const p of plan) { const m = minutesOfDay(p.scheduled_at); assert.ok(m >= 9 * 60 && m < 23 * 60, `in window: ${m}`); assert.strictEqual(p.scheduled_at % 60000, 0); }
  // spread: first slot of a day in the first half, second in the second half
  for (const ts of Object.values(byDay).filter(a => a.length === 2)) { assert.ok(minutesOfDay(ts[0]) < 16 * 60); assert.ok(minutesOfDay(ts[1]) >= 16 * 60); }
  // chronological
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].scheduled_at > plan[i - 1].scheduled_at);
});

test('late in the day: today is skipped, starts tomorrow', () => {
  const now = at(2026, 11, 26, 22, 40);
  const plan = buildPlan({ videos: vids(2), perDay: 2, window: W, now, rng: mulberry32(2) });
  assert.ok(plan.every(p => dayKey(p.scheduled_at) === dayKey(at(2026, 11, 27, 12))));
});

test('mid-day: only remaining segment today, never in the past', () => {
  const now = at(2026, 11, 26, 17, 0);
  const plan = buildPlan({ videos: vids(3), perDay: 2, window: W, now, rng: mulberry32(3) });
  assert.strictEqual(dayKey(plan[0].scheduled_at), dayKey(now));
  assert.ok(plan[0].scheduled_at >= now + 10 * 60000);
  assert.strictEqual(dayKey(plan[1].scheduled_at), dayKey(at(2026, 11, 27, 12)));
});

test('existing slots count against the daily quota', () => {
  const now = at(2026, 11, 26, 8, 0);
  const existing = [at(2026, 11, 26, 10, 0), at(2026, 11, 26, 18, 0)];
  const plan = buildPlan({ videos: vids(2), existing, perDay: 2, window: W, now, rng: mulberry32(4) });
  assert.ok(plan.every(p => dayKey(p.scheduled_at) !== dayKey(now)));
  const one = buildPlan({ videos: vids(1), existing: [at(2026, 11, 26, 10, 0)], perDay: 2, window: W, now, rng: mulberry32(4) });
  assert.strictEqual(dayKey(one[0].scheduled_at), dayKey(now));
  assert.ok(minutesOfDay(one[0].scheduled_at) >= 16 * 60, 'uses the free (second) segment');
});

test('perDay=3 and many seeds: slots keep a gap and stay in window', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const plan = buildPlan({ videos: vids(9), perDay: 3, window: W, now: at(2026, 11, 26, 6), rng: mulberry32(seed) });
    assert.strictEqual(plan.length, 9);
    for (let i = 1; i < plan.length; i++) {
      const gap = plan[i].scheduled_at - plan[i - 1].scheduled_at;
      assert.ok(gap >= 0.2 * (14 * 60 / 3) * 60000 - 60000, `gap ${gap / 60000}min seed ${seed}`);
    }
    for (const p of plan) assert.ok(inWindow(p.scheduled_at, W));
  }
});

test('custom window and validation', () => {
  const plan = buildPlan({ videos: vids(4), perDay: 4, window: { start: '12:00', end: '14:00' }, now: at(2026, 11, 26, 1), rng: mulberry32(9) });
  for (const p of plan) { const m = minutesOfDay(p.scheduled_at); assert.ok(m >= 720 && m < 840); }
  assert.throws(() => buildPlan({ videos: vids(1), perDay: 2, window: { start: '14:00', end: '12:00' }, now: Date.now() }), /after start/);
  assert.throws(() => buildPlan({ videos: vids(1), perDay: 0, window: W, now: Date.now() }), /perDay/);
  assert.throws(() => parseHHMM('25:00'));
  const b = windowBounds(at(2026, 11, 26, 12), W);
  assert.strictEqual(new Date(b.start).getHours(), 9);
  assert.strictEqual(new Date(b.end).getHours(), 23);
});
