'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanFolder, moveToDone, findThumb } = require('../../src/autopilot/scanner');
const { watchFolder } = require('../../src/autopilot/watcher');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'upscan-'));
const touch = (p, bytes = 10) => fs.writeFileSync(p, Buffer.alloc(bytes, 1));

test('scanFolder: extensions, thumbnails, Done ignored, natural sort, empty files skipped', () => {
  const d = tmp();
  ['clip10.mp4', 'clip2.mp4', 'b.MOV', 'c.mkv', 'd.webm', 'notes.txt', 'clip2.jpg', 'B.png', 'c.jpeg', '.hidden.mp4'].forEach(f => touch(path.join(d, f)));
  touch(path.join(d, 'empty.mp4'), 0);
  fs.mkdirSync(path.join(d, 'Done')); touch(path.join(d, 'Done', 'old.mp4'));
  const r = scanFolder(d);
  assert.deepStrictEqual(r.map(x => x.filename), ['b.MOV', 'c.mkv', 'clip2.mp4', 'clip10.mp4', 'd.webm']);
  const by = Object.fromEntries(r.map(x => [x.filename, x.thumb && path.basename(x.thumb)]));
  assert.strictEqual(by['clip2.mp4'], 'clip2.jpg');
  assert.strictEqual(by['b.MOV'], 'B.png');
  assert.strictEqual(by['c.mkv'], 'c.jpeg');
  assert.strictEqual(by['clip10.mp4'], null);
  assert.throws(() => scanFolder(path.join(d, 'nope')), /not found/);
});

test('moveToDone moves video + thumbnail and never overwrites', () => {
  const d = tmp();
  touch(path.join(d, 'a.mp4')); touch(path.join(d, 'a.jpg'));
  const r = moveToDone(path.join(d, 'a.mp4'), path.join(d, 'a.jpg'));
  assert.ok(fs.existsSync(r.video) && fs.existsSync(r.thumb));
  assert.ok(!fs.existsSync(path.join(d, 'a.mp4')));
  touch(path.join(d, 'a.mp4'));
  const r2 = moveToDone(path.join(d, 'a.mp4'), null);
  assert.notStrictEqual(r2.video, r.video);
  assert.strictEqual(fs.readdirSync(path.join(d, 'Done')).length, 3);
  assert.strictEqual(findThumb(path.join(d, 'zzz.mp4')), null);
});

test('watcher reports new videos once fully written, thumbnails, ignores Done', async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'Done'));
  const videos = [], thumbs = [];
  let ready; const readyP = new Promise(r => (ready = r));
  const w = watchFolder(d, { onVideo: p => videos.push(p), onThumb: p => thumbs.push(p), onReady: ready, stabilityMs: 400, pollInterval: 100 });
  await readyP;
  // a file written in chunks: must only be reported after it stops growing
  const fd = fs.openSync(path.join(d, 'slow.mp4'), 'w');
  for (let i = 0; i < 4; i++) { fs.writeSync(fd, Buffer.alloc(1000, 1)); await new Promise(r => setTimeout(r, 150)); }
  assert.strictEqual(videos.length, 0, 'not reported while still being written');
  fs.closeSync(fd);
  touch(path.join(d, 'slow.jpg'));
  touch(path.join(d, 'Done', 'ignored.mp4'));
  touch(path.join(d, 'readme.txt'));
  const t0 = Date.now();
  while ((videos.length < 1 || thumbs.length < 1) && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 800));
  await w.close();
  assert.deepStrictEqual(videos.map(p => path.basename(p)), ['slow.mp4']);
  assert.strictEqual(fs.statSync(videos[0]).size, 4000);
  assert.deepStrictEqual(thumbs.map(p => path.basename(p)), ['slow.jpg']);
});
