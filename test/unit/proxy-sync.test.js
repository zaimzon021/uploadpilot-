'use strict';
// Settings "Proxy pool" textarea sync: pasted lines are saved without a separate Save click,
// masked (••••) lines keep their stored password, removed unused proxies are dropped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DB } = require('../../src/core/db');
const { Settings } = require('../../src/core/settings');
const { ProfileManager } = require('../../src/profiles/profileManager');

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-sync-'));
  const db = new DB(path.join(dir, 'db.sqlite'));
  const checked = [];
  const pm = new ProfileManager({ db, settings: new Settings(db), events: { info() {}, warn() {}, error() {} }, dataDir: dir,
    proxyChecker: async p => { checked.push(`${p.host}:${p.password}`); return p.host === '9.9.9.9' ? { ok: false, error: 'SOCKS auth failed' } : { ok: true, ip: '203.0.113.' + p.port % 255 }; } });
  return { db, pm, checked };
}

test('syncProxyPool: paste 3 lines unsaved -> all saved, then check-all checks all of them', async () => {
  const { pm, checked } = mk();
  const r = pm.syncProxyPool('1.1.1.1:1080:a:pa\n2.2.2.2:1081:b:pb\r\n9.9.9.9:1082:c:pc\n');
  assert.deepStrictEqual([r.added, r.total, r.errors.length], [3, 3, 0]);
  const out = []; for (const x of pm.listProxies()) out.push(await pm.checkProxyById(x.id));
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map(x => x.ok), [true, true, false]);
  assert.strictEqual(out[2].error, 'SOCKS auth failed');
  assert.ok(checked.includes('1.1.1.1:pa'));
});

test('syncProxyPool: masked lines keep password, edited password updates, removed unused deleted, bad lines reported', () => {
  const { pm, db } = mk();
  pm.syncProxyPool('1.1.1.1:1080:a:pa\n2.2.2.2:1081:b:pb\n3.3.3.3:1082:c:pc');
  // as shown in Settings after save (passwords masked); user drops 3.3.3.3, fixes b's password, adds a bad line
  const r = pm.syncProxyPool('1.1.1.1:1080:a:••••\n2.2.2.2:1081:b:newpass\nnot-a-proxy');
  assert.deepStrictEqual([r.added, r.updated, r.removed, r.errors.length, r.total], [0, 1, 1, 1, 2]);
  assert.strictEqual(db.get('SELECT password FROM proxies WHERE host=?', '1.1.1.1').password, 'pa');
  assert.strictEqual(db.get('SELECT password FROM proxies WHERE host=?', '2.2.2.2').password, 'newpass');
  // idempotent: re-syncing the same text changes nothing
  const again = pm.syncProxyPool('1.1.1.1:1080:a:••••\n2.2.2.2:1081:b:newpass');
  assert.deepStrictEqual([again.added, again.updated, again.removed], [0, 0, 0]);
  // empty text clears unused proxies
  assert.strictEqual(pm.syncProxyPool('').total, 0);
});
