'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GeminiClient, parseGeminiResponse, composeDescription, KeyPool, buildPrompt } = require('../../src/ai/gemini');
const { startMockGemini } = require('../helpers/mockGemini');

const video = (() => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gem-')), 'clip.mp4'); fs.writeFileSync(p, Buffer.alloc(123456, 7)); return p; })();
const fastSleep = () => Promise.resolve();

test('parse: plain JSON, fenced JSON, response envelope, prose around JSON', () => {
  const j = { title: 'Hi', description: 'd', tags: ['a'], hashtags: ['x'] };
  assert.strictEqual(parseGeminiResponse(JSON.stringify(j)).title, 'Hi');
  assert.strictEqual(parseGeminiResponse('```json\n' + JSON.stringify(j) + '\n```').title, 'Hi');
  assert.strictEqual(parseGeminiResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(j) }] }, finishReason: 'STOP' }] }).title, 'Hi');
  assert.strictEqual(parseGeminiResponse('Sure! Here it is: ' + JSON.stringify(j) + ' hope it helps').title, 'Hi');
  assert.strictEqual(parseGeminiResponse('[' + JSON.stringify(j) + ']').hashtags[0], '#x');
});

test('parse: validation and normalisation', () => {
  const long = 'Word '.repeat(40);
  const r = parseGeminiResponse(JSON.stringify({ title: `"${long}"`, description: 'x <b>y</b>', tags: ['#Cats', 'cats', 'dogs', ' ', 'a,b'], hashtags: ['funny', '#Funny', 'two words'] }));
  assert.ok([...r.title].length <= 100);
  assert.ok(!r.title.startsWith('"'));
  assert.ok(!/[<>]/.test(r.description));
  assert.deepStrictEqual(r.tags, ['Cats', 'dogs', 'ab']);
  assert.deepStrictEqual(r.hashtags, ['#funny', '#twowords']);
  const tags = parseGeminiResponse(JSON.stringify({ title: 't', description: '', tags: Array.from({ length: 100 }, (_, i) => 'tag-number-' + i), hashtags: [] })).tags;
  assert.ok(tags.join(',').length <= 450);
  assert.throws(() => parseGeminiResponse('{"title": ""}'), /no title/);
  assert.throws(() => parseGeminiResponse('not json'), /invalid JSON/);
  assert.throws(() => parseGeminiResponse({ candidates: [] }), /No candidates/);
  assert.throws(() => parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
  assert.throws(() => parseGeminiResponse(''), /Empty/);
});

test('composeDescription adds footer + merged, de-duplicated hashtags', () => {
  const d = composeDescription({ description: 'Body', hashtags: ['#fails', '#Funny'] }, { footer: 'Follow us!', hashtags: '#funny #shorts' });
  assert.strictEqual(d, 'Body\n\nFollow us!\n\n#fails #Funny #shorts');
  assert.ok(buildPrompt({ niche: 'dashcam', language: 'German' }, 'x.mp4').includes('German'));
});

test('KeyPool rotates round-robin and skips cooling keys', () => {
  let t = 0; const p = new KeyPool(['a', 'b', 'c'], { now: () => t });
  assert.deepStrictEqual([p.next().key, p.next().key, p.next().key, p.next().key], ['a', 'b', 'c', 'a']);
  const b = p.keys[1]; p.cool(b, 1000);
  assert.deepStrictEqual([p.next().key, p.next().key, p.next().key], ['c', 'a', 'c']);
  p.cool(p.keys[0], 500); p.cool(p.keys[2], 2000);
  assert.strictEqual(p.next(), null);
  assert.strictEqual(p.soonestMs(), 500);
  t = 600; assert.strictEqual(p.next().key, 'a');
});

test('full pipeline against mock HTTP Gemini: upload, poll ACTIVE, generate, delete', async () => {
  const m = await startMockGemini({ processingPolls: 2 });
  try {
    const c = new GeminiClient({ keys: ['k1'], model: 'gemini-x', baseUrl: m.url, sleep: fastSleep, pollMs: 1 });
    const r = await c.describeVideo(video, { niche: 'cats', language: 'English' });
    assert.strictEqual(r.title, 'Mock title 1');
    assert.strictEqual(m.stats.bytes, 123456, 'whole file streamed');
    assert.strictEqual(m.stats.gets, 2);
    assert.strictEqual(m.stats.deletes, 1, 'file cleaned up');
    assert.match(m.stats.prompts[0], /cats/);
    assert.deepStrictEqual(await c.listModels(), ['gemini-mock-flash']);
  } finally { await m.close(); }
});

test('429 on one key rotates to the next key; 403 key disabled', async () => {
  const m = await startMockGemini({ rateLimitedKeys: new Set(['k1']), badKeys: new Set(['k2']) });
  try {
    const logs = [];
    const c = new GeminiClient({ keys: ['k1', 'k2', 'k3'], model: 'g', baseUrl: m.url, sleep: fastSleep, pollMs: 1, log: s => logs.push(s) });
    const r = await c.describeVideo(video, {});
    assert.ok(r.title);
    assert.ok(m.stats.byKey.k1 >= 1 && m.stats.byKey.k2 >= 1 && m.stats.byKey.k3 >= 3);
    assert.ok(logs.some(l => /rate-limited/.test(l)) && logs.some(l => /rejected/.test(l)));
    assert.ok(c.pool.keys[0].coolUntil > Date.now() && c.pool.keys[1].coolUntil > Date.now() + 3600e3);
  } finally { await m.close(); }
});

test('all keys rate-limited: backs off (sleep) and succeeds when a key frees up', async () => {
  const m = await startMockGemini({ rateLimitedKeys: new Set(['k1', 'k2']) });
  try {
    const sleeps = [];
    const c = new GeminiClient({
      keys: ['k1', 'k2'], model: 'g', baseUrl: m.url, pollMs: 1,
      sleep: async ms => { sleeps.push(ms); if (ms > 1000) { m.rateLimitedKeys.clear(); c.pool.keys.forEach(k => (k.coolUntil = 0)); } },
    });
    const r = await c.describeVideo(video, {}, { maxAttempts: 4 });
    assert.ok(r.title);
    assert.ok(sleeps.some(ms => ms > 1000), 'waited for cooldown');
  } finally { await m.close(); }
});

test('bad JSON from model retries with next key, then gives up with clear error', async () => {
  let n = 0;
  const m = await startMockGemini({ respond: () => (++n === 1 ? 'garbage' : { title: 'OK now', description: '', tags: [], hashtags: [] }) });
  try {
    const c = new GeminiClient({ keys: ['a', 'b'], model: 'g', baseUrl: m.url, sleep: fastSleep, pollMs: 1 });
    assert.strictEqual((await c.describeVideo(video, {})).title, 'OK now');
    const m2 = await startMockGemini({ respond: () => 'garbage' });
    const c2 = new GeminiClient({ keys: ['a'], model: 'g', baseUrl: m2.url, sleep: fastSleep, pollMs: 1 });
    await assert.rejects(c2.describeVideo(video, {}, { maxAttempts: 2 }), /invalid JSON/);
    await m2.close();
    await assert.rejects(new GeminiClient({ keys: [], model: 'g', baseUrl: m.url }).describeVideo(video), /No Gemini API keys/);
  } finally { await m.close(); }
});
