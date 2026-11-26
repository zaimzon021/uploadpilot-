'use strict';
// Leases = short-lived locks in Firestore so two PCs never upload the same video or open the same
// browser profile at the same time.
//   users/{uid}/leases/{key}  { pcId, pcName, kind, key, renewedAt: serverTimestamp, ttlSec, expiresAt, released, gen, state? }
// * claim: Firestore transaction; free / released / expired / already mine -> take it.
// * renew every 30 s (one write, no read): the rules only accept it while we still hold it.
// * expired = server time > renewedAt + ttl (~2 min). Expiry is judged with the SERVER clock: the
//   rules check request.time, and locally we use an offset measured against server timestamps, so a
//   PC whose clock is wrong can neither steal a live lease nor keep a dead one.
// * release: holder sets released=true (no delete needed; rules allow it only for the holder).
const { EventEmitter } = require('events');
const { withTimeout } = require('./store/common');

class LeaseManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.store      cloud store (firestoreStore / memoryStore)
   * @param {string} o.root       'users/<uid>'
   * @param {string} o.pcId
   * @param {string} o.pcName
   * @param {number} [o.ttlSec=120]
   * @param {number} [o.renewMs=30000]
   * @param {number} [o.timeoutMs=15000]   a claim that takes longer counts as "offline"
   * @param {() => number} [o.localNow]
   */
  constructor({ store, root, pcId, pcName, ttlSec = 120, renewMs = 30000, timeoutMs = 15000, localNow }) {
    super();
    Object.assign(this, { store, root, pcId, pcName, ttlSec, renewMs, timeoutMs });
    this.localNow = localNow || (store.localNow ? () => store.localNow() : () => Date.now());
    this.offsetMs = 0;           // serverTime ≈ localNow() + offsetMs
    this.offsetKnown = false;
    this.held = new Map();       // key -> { kind, extra, timer, lastOk }
    this.remote = new Map();     // key -> lease doc (from the watcher), all PCs
    this._unwatch = null;
  }

  path(key) { return `${this.root}/leases/${key}`; }
  serverNow() { return this.localNow() + this.offsetMs; }
  isExpired(d, now = this.serverNow()) { return !d || d.released === true || now > (d.renewedAt || 0) + (d.ttlSec || this.ttlSec) * 1000; }

  /** Measure the local-vs-server clock offset with one write + one read of this PC's doc. */
  async syncClock() {
    const p = `${this.root}/pcs/${this.pcId}`;
    const t0 = this.localNow();
    await withTimeout(this.store.set(p, { name: this.pcName, lastSeen: this.store.SERVER_TS }, { merge: true }), this.timeoutMs, 'clock sync');
    const t1 = this.localNow();
    const d = await withTimeout(this.store.get(p), this.timeoutMs, 'clock sync');
    if (d && typeof d.lastSeen === 'number') { this.offsetMs = d.lastSeen - Math.round((t0 + t1) / 2); this.offsetKnown = true; }
    return this.offsetMs;
  }

  _doc(kind, extra, gen) {
    return { pcId: this.pcId, pcName: this.pcName, kind, renewedAt: this.store.SERVER_TS, ttlSec: this.ttlSec, expiresAt: this.serverNow() + this.ttlSec * 1000, released: false, ...(gen ? { gen } : {}), ...extra };
  }

  /**
   * Try to take a lease. Resolves {ok:true, takeover?} or {ok:false, holder?, offline?, error?}.
   * Never throws for "someone else has it" or "offline".
   */
  async claim(key, { kind = 'job', extra = {} } = {}) {
    if (this.held.has(key)) return { ok: true, already: true };
    let res;
    try {
      res = await withTimeout(this.store.tx(async t => {
        const cur = await t.get(this.path(key));
        if (cur && !cur.released && cur.pcId !== this.pcId && !this.isExpired(cur)) return { ok: false, holder: cur };
        const takeover = !!(cur && !cur.released && cur.pcId !== this.pcId);
        t.set(this.path(key), { key, ...this._doc(kind, extra, (cur && cur.gen || 0) + 1), ...(takeover ? { takenOverFrom: cur.pcName } : {}) });
        return { ok: true, takeover, previous: cur || null };
      }), this.timeoutMs, 'lease claim');
    } catch (e) {
      if (e.code === 'permission-denied') return { ok: false, error: e.message, denied: true };   // server clock says it is still held
      if (e.code === 'unavailable' || e.code === 'deadline-exceeded') return { ok: false, offline: true, error: e.message };
      throw e;
    }
    if (!res.ok) return res;
    const h = { kind, extra, lastOk: this.localNow(), state: {} };
    h.timer = setInterval(() => this._renew(key).catch(() => {}), this.renewMs);
    if (h.timer.unref) h.timer.unref();
    this.held.set(key, h);
    if (res.takeover) this.emit('takeover', key, res.previous);
    return res;
  }

  /** Extra fields (e.g. {state:'uploading'}) ride along with the next renewal: no extra writes. */
  note(key, fields) { const h = this.held.get(key); if (h) Object.assign(h.state, fields); }

  async _renew(key) {
    const h = this.held.get(key);
    if (!h) return;
    try {
      await withTimeout(this.store.set(this.path(key), { key, ...this._doc(h.kind, { ...h.extra, ...h.state }) }, { merge: true }), this.timeoutMs, 'lease renew');
      h.lastOk = this.localNow();
    } catch (e) {
      if (e.code === 'permission-denied') { this._drop(key); this.emit('lost', key, 'taken over by another PC'); return; }
      if (this.localNow() - h.lastOk > this.ttlSec * 1000) this.emit('stale', key, e.message);   // offline longer than the ttl
    }
  }

  async release(key) {
    const h = this.held.get(key);
    if (!h) return false;
    this._drop(key);
    try { await withTimeout(this.store.set(this.path(key), { key, ...this._doc(h.kind, h.extra), released: true }, { merge: true }), this.timeoutMs, 'lease release'); }
    catch (_) { /* expires on its own */ }
    return true;
  }
  _drop(key) { const h = this.held.get(key); if (h) clearInterval(h.timer); this.held.delete(key); }
  holds(key) { return this.held.has(key); }

  /** Live view of everyone's active leases (one listener, only unreleased docs). */
  watch() {
    if (this._unwatch) return;
    this._unwatch = this.store.watch(`${this.root}/leases`, { where: [['released', '==', false]] }, changes => {
      for (const c of changes) {
        if (c.type === 'removed') this.remote.delete(c.id);
        else {
          this.remote.set(c.id, c.data);
          // our own renewal coming back from the server refines the clock offset for free
          if (!c.pending && c.data.pcId === this.pcId && typeof c.data.renewedAt === 'number' && !this.offsetKnown) { this.offsetMs = c.data.renewedAt - this.localNow(); this.offsetKnown = true; }
        }
      }
      this.emit('change');
    }, e => this.emit('error', e));
  }
  /** Current live holder of a key (null when free or expired). */
  holder(key) { const d = this.remote.get(key); return d && !this.isExpired(d) ? d : null; }
  active() { return [...this.remote.entries()].filter(([, d]) => !this.isExpired(d)).map(([k, d]) => ({ key: k, ...d })); }

  async stop({ release = true } = {}) {
    if (this._unwatch) { this._unwatch(); this._unwatch = null; }
    for (const k of [...this.held.keys()]) { if (release) await this.release(k); else this._drop(k); }
  }
}

module.exports = { LeaseManager };
