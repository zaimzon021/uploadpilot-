'use strict';
// Job / profile leases on the in-memory Firestore stand-in (same rules as firestore.rules).
const test = require('node:test');
const assert = require('node:assert');
const { MemoryServer, MemoryStore } = require('../../src/cloud/store/memoryStore');
const { LeaseManager } = require('../../src/cloud/leases');

async function twoPcs({ skewB = 0, ttlSec = 120 } = {}) {
  const server = new MemoryServer();
  const a = new MemoryStore(server, { name: 'A' }), b = new MemoryStore(server, { name: 'B', clockSkewMs: skewB });
  const u = await a.auth.signUp('me@example.com', 'secret12');
  await b.auth.signIn('me@example.com', 'secret12');
  const root = `users/${u.uid}`;
  const la = new LeaseManager({ store: a, root, pcId: 'pcA', pcName: 'PC-A', ttlSec, renewMs: 50 });
  const lb = new LeaseManager({ store: b, root, pcId: 'pcB', pcName: 'PC-B', ttlSec, renewMs: 50 });
  await la.syncClock(); await lb.syncClock();
  return { server, a, b, la, lb, root };
}

test('two PCs racing for the same job: exactly one wins, every time', async () => {
  const { la, lb } = await twoPcs();
  for (let i = 0; i < 25; i++) {
    const [ra, rb] = await Promise.all([la.claim(`video_${i}`), lb.claim(`video_${i}`)]);
    assert.strictEqual(+ra.ok + +rb.ok, 1, `race ${i}: ${ra.ok} ${rb.ok}`);
    const loser = ra.ok ? rb : ra;
    assert.ok(loser.holder && ['PC-A', 'PC-B'].includes(loser.holder.pcName));
  }
  await la.stop(); await lb.stop();
});

test('renewal keeps a lease alive; release frees it for the other PC', async () => {
  const { server, la, lb } = await twoPcs({ ttlSec: 10 });
  assert.ok((await la.claim('profile_1', { kind: 'profile' })).ok);
  server.advance(8000); await new Promise(r => setTimeout(r, 150));      // renewals (every 50 ms) at the new server time
  server.advance(8000);                                                     // 16 s after the claim but < 10 s after a renewal
  assert.strictEqual((await lb.claim('profile_1')).ok, false, 'renewed lease must not be taken');
  await la.release('profile_1');
  const r = await lb.claim('profile_1');
  assert.ok(r.ok && !r.takeover, 'released lease is free (not a take-over)');
  await la.stop(); await lb.stop();
});

test('expired lease (PC died) is taken over; the old holder learns it lost it', async () => {
  const { server, la, lb } = await twoPcs({ ttlSec: 120 });
  assert.ok((await la.claim('video_x')).ok);
  // PC-A freezes: stop its renew timer without releasing
  clearInterval(la.held.get('video_x').timer);
  server.advance(60000);
  assert.strictEqual((await lb.claim('video_x')).ok, false, 'not expired after 60 s');
  server.advance(70000);                                    // 130 s > ttl 120 s
  const r = await lb.claim('video_x');
  assert.ok(r.ok && r.takeover, 'taken over after expiry');
  const doc = await lb.store.get(lb.path('video_x'));
  assert.strictEqual(doc.pcName, 'PC-B'); assert.strictEqual(doc.takenOverFrom, 'PC-A');
  // PC-A wakes up and tries to renew: the rules refuse, it emits "lost"
  const lost = new Promise(res => la.once('lost', k => res(k)));
  await la._renew('video_x');
  assert.strictEqual(await lost, 'video_x');
  assert.strictEqual(la.holds('video_x'), false);
  await la.stop(); await lb.stop();
});

test('clock skew: a PC whose clock runs 10 min fast cannot steal a live lease (server time decides)', async () => {
  const { la, lb, server } = await twoPcs({ skewB: 10 * 60000 });
  assert.ok(Math.abs(lb.offsetMs + 10 * 60000) < 2000, `offset measured (${lb.offsetMs})`);
  assert.ok((await la.claim('video_s')).ok);
  // even if B ignored its offset and believed the lease expired, the server rules refuse the write
  lb.offsetMs = 0;
  const r = await lb.claim('video_s');
  assert.strictEqual(r.ok, false);
  assert.ok(r.denied, 'rejected by server-time rule');
  // with the measured offset B correctly sees it as held
  await lb.syncClock();
  assert.strictEqual((await lb.claim('video_s')).ok, false);
  clearInterval(la.held.get('video_s').timer);
  server.advance(121000);
  assert.ok((await lb.claim('video_s')).ok, 'free after real (server) expiry');
  await la.stop(); await lb.stop();
});

test('watcher shows who holds what ("running on PC-A")', async () => {
  const { la, lb } = await twoPcs();
  lb.watch();
  await la.claim('profile_7', { kind: 'profile', extra: { profileNumber: 7 } });
  la.note('profile_7', { state: 'uploading' });
  await la._renew('profile_7');
  await new Promise(r => setTimeout(r, 50));
  const h = lb.holder('profile_7');
  assert.strictEqual(h.pcName, 'PC-A');
  assert.strictEqual(h.state, 'uploading');
  await la.release('profile_7');
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(lb.holder('profile_7'), null);
  await la.stop(); await lb.stop();
});

test('rules: another account cannot touch my data; leases must carry server time', async () => {
  const { server, root } = await twoPcs();
  const c = new MemoryStore(server, { name: 'stranger' });
  await c.auth.signUp('other@example.com', 'secret12');
  await assert.rejects(c.get(`${root}/leases/x`), e => e.code === 'permission-denied');
  const lc = new LeaseManager({ store: c, root, pcId: 'pcC', pcName: 'C' });
  const r = await lc.claim('video_1');
  assert.strictEqual(r.ok, false); assert.ok(r.denied);
  const a = new MemoryStore(server); await a.auth.signIn('me@example.com', 'secret12');
  await assert.rejects(a.set(`${root}/leases/y`, { pcId: 'p', pcName: 'P', renewedAt: Date.now() - 999999, ttlSec: 120, released: false }), e => e.code === 'permission-denied');
});
