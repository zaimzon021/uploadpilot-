'use strict';
// Shared pieces of the cloud store interface (implemented by firestoreStore.js and memoryStore.js).
//
//   store.SERVER_TS / store.DELETE   sentinels usable anywhere in written data
//   store.get(path)                  -> data | null       (timestamps come back as epoch ms)
//   store.set(path, data, {merge})
//   store.batch(ops)                 ops: {type:'set', path, data, merge} | {type:'delete', path}
//   store.tx(async t => …)           t.get(path), t.set(path, data, {merge}), t.delete(path)
//   store.watch(collPath, q, onChanges, onError) -> unsubscribe     (q: {where:[[f,op,v]], orderBy:[f,dir], limit})
//       onChanges([{type:'added'|'modified'|'removed', id, path, data, pending}])
//   store.auth: signUp/signIn/signOut/user()/onChange(cb)
//   store.stats: {reads, writes, day}
const SERVER_TS = Symbol.for('uploadpilot.serverTimestamp');
const DELETE = Symbol.for('uploadpilot.deleteField');

class CloudError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

/** Per-day read/write counter (the free Spark plan allows 50k reads / 20k writes a day). */
class QuotaMeter {
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.reset(); }
  _day() { const d = new Date(this.now()); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`; } // Firestore quota resets at midnight Pacific; UTC day is close enough for a soft meter
  reset() { this.day = this._day(); this.reads = 0; this.writes = 0; this.deletes = 0; }
  _roll() { if (this._day() !== this.day) this.reset(); }
  read(n = 1) { this._roll(); this.reads += n; }
  write(n = 1) { this._roll(); this.writes += n; }
  del(n = 1) { this._roll(); this.deletes += n; }
  snapshot() { this._roll(); return { day: this.day, reads: this.reads, writes: this.writes, deletes: this.deletes }; }
}

const withTimeout = (p, ms, what = 'cloud call') => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new CloudError('unavailable', `${what} timed out after ${Math.round(ms / 1000)}s (offline?)`)), ms); })]).finally(() => clearTimeout(t));
};

module.exports = { SERVER_TS, DELETE, CloudError, QuotaMeter, withTimeout };
