'use strict';
// In-memory stand-in for Firestore + Firebase Auth, used by tests to simulate several PCs.
// It is deliberately faithful where UploadPilot depends on Firestore semantics:
//  * one MemoryServer = one project; each MemoryStore = one PC's SDK client (own auth, own clock skew)
//  * server time is the server's clock (controllable), serverTimestamp() resolves at commit
//  * transactions are optimistic (read versions checked at commit, retried up to 5 times), so
//    concurrent claims of the same lease produce exactly one winner
//  * the security rules from firestore.rules that matter (uid scoping, stamped docs, lease
//    validity / take-over only after SERVER-time expiry) are enforced -> 'permission-denied'
//  * listeners get added/modified/removed diffs asynchronously, like onSnapshot
const crypto = require('crypto');
const { SERVER_TS, DELETE, CloudError, QuotaMeter } = require('./common');

const tick = () => new Promise(r => setImmediate(r));
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class MemoryServer {
  constructor({ now = () => Date.now(), latencyMs = 0 } = {}) {
    this._now = now; this.offsetMs = 0; this.latencyMs = latencyMs;
    this.docs = new Map();      // path -> { data, version }
    this.users = new Map();     // email -> { uid, password }
    this.listeners = new Set();
    this.online = true;
    this.commits = 0;
  }
  now() { return this._now() + this.offsetMs; }
  advance(ms) { this.offsetMs += ms; }
  async delay() { if (!this.online) throw new CloudError('unavailable', 'Server unreachable (simulated offline)'); if (this.latencyMs) await new Promise(r => setTimeout(r, this.latencyMs)); else await tick(); }

  // ---- rules (mirror of firestore.rules) ----
  _check(uid, path, kind, next, prev, now = this.now()) {
    const seg = path.split('/');
    if (seg[0] !== 'users' || !uid || seg[1] !== uid) throw new CloudError('permission-denied', `Missing or insufficient permissions (${path})`);
    if (kind === 'read' || seg.length === 2) return;
    const coll = seg[2];
    const expired = d => d.released === true || now > d.renewedAt + d.ttlSec * 1000;
    if (coll === 'leases') {
      if (kind === 'delete') { if (prev && !expired(prev)) throw new CloudError('permission-denied', 'Lease is still held'); return; }
      const d = next;
      const valid = typeof d.pcId === 'string' && typeof d.pcName === 'string' && d.renewedAt === now && Number.isInteger(d.ttlSec) && d.ttlSec >= 10 && d.ttlSec <= 900 && typeof d.released === 'boolean';
      if (!valid) throw new CloudError('permission-denied', 'Invalid lease document');
      if (prev && !(prev.pcId === d.pcId || expired(prev))) throw new CloudError('permission-denied', `Lease held by ${prev.pcName}`);
      return;
    }
    if (kind === 'delete') return;
    if (['channels', 'profiles', 'videos', 'plans'].includes(coll)) {
      if (next.updatedAt !== now || typeof next.updatedBy !== 'string') throw new CloudError('permission-denied', 'Document must carry updatedAt=serverTimestamp and updatedBy');
      if (Object.keys(next).length > 64 && coll !== 'plans') throw new CloudError('permission-denied', 'Too many fields');
      if (coll === 'profiles' && (next.stateVersion || 0) !== ((prev && prev.stateVersion) || 0)) {
        const ap = this.docs.get(`users/${uid}/meta/activePc`);
        if (ap && (ap.data.pcId !== next.updatedBy || ap.data.handedOver === true)) throw new CloudError('permission-denied', 'Only the active PC may change a saved login');
      }
      if (coll === 'videos' && !['queued', 'writing', 'uploading', 'done', 'failed', 'skipped'].includes(next.status)) throw new CloudError('permission-denied', `Bad video status ${next.status}`);
    }
    if (coll === 'meta' && seg[3] === 'activePc' && (typeof next.pcId !== 'string' || next.renewedAt !== now)) throw new CloudError('permission-denied', 'activePc must carry pcId and renewedAt=serverTimestamp');
    if (coll === 'activity' && (typeof next.message !== 'string' || next.message.length > 1000)) throw new CloudError('permission-denied', 'Bad activity');
  }

  static _resolve(prev, data, merge, now) {
    const out = merge && prev ? clone(prev) : {};
    for (const [k, v] of Object.entries(data)) {
      if (v === DELETE) delete out[k];
      else if (v === SERVER_TS) out[k] = now;
      else if (v && typeof v === 'object' && !Array.isArray(v) && merge && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = MemoryServer._resolve(out[k], v, true, now);
      else if (v !== undefined) out[k] = MemoryServer._resolveDeep(v, now);
    }
    return out;
  }
  static _resolveDeep(v, now) {
    if (v === SERVER_TS) return now;
    if (Array.isArray(v)) return v.map(x => MemoryServer._resolveDeep(x, now));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== DELETE).map(([k, x]) => [k, MemoryServer._resolveDeep(x, now)]));
    return v;
  }

  /** Apply a list of writes atomically (rules checked for all first). readVersions: optimistic tx check. */
  _commit(uid, ops, readVersions = null) {
    if (readVersions) for (const [p, v] of readVersions) { const cur = this.docs.get(p); if ((cur ? cur.version : 0) !== v) throw new CloudError('aborted', 'Transaction contention'); }
    const now = this.now();
    const staged = new Map();
    for (const op of ops) {
      const prevEntry = staged.has(op.path) ? staged.get(op.path) : this.docs.get(op.path) || null;
      const prev = prevEntry ? prevEntry.data : null;
      if (op.type === 'delete') { this._check(uid, op.path, 'delete', null, prev, now); staged.set(op.path, null); continue; }
      const next = MemoryServer._resolve(prev, op.data, !!op.merge, now);
      this._check(uid, op.path, prev ? 'update' : 'create', next, prev, now);
      staged.set(op.path, { data: next, version: (prevEntry ? prevEntry.version : 0) + 1 });
    }
    for (const [p, e] of staged) { if (e) this.docs.set(p, e); else this.docs.delete(p); }
    this.commits++;
    this._notify();
  }

  _query(collPath, q = {}) {
    const depth = collPath.split('/').length + 1;
    let rows = [...this.docs.entries()].filter(([p]) => p.startsWith(collPath + '/') && p.split('/').length === depth).map(([p, e]) => ({ path: p, id: p.split('/').pop(), data: e.data, version: e.version }));
    for (const [f, op, v] of q.where || []) {
      rows = rows.filter(r => { const x = r.data[f]; switch (op) { case '==': return x === v; case '!=': return x !== v && x !== undefined; case 'in': return v.includes(x); case '>=': return x >= v; case '>': return x > v; case '<': return x < v; case '<=': return x <= v; default: throw new Error(`op ${op}`); } });
    }
    if (q.orderBy) { const [f, dir = 'asc'] = q.orderBy; rows = rows.filter(r => r.data[f] !== undefined); rows.sort((a, b) => (a.data[f] < b.data[f] ? -1 : a.data[f] > b.data[f] ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
    if (q.limit) rows = rows.slice(0, q.limit);
    return rows;
  }
  _notify() { for (const l of this.listeners) l.refresh(); }
}

class MemoryStore {
  /** @param {MemoryServer} server @param {{clockSkewMs?:number, name?:string}} o */
  constructor(server, { clockSkewMs = 0, name = 'client' } = {}) {
    this.server = server; this.clockSkewMs = clockSkewMs; this.name = name;
    this.SERVER_TS = SERVER_TS; this.DELETE = DELETE;
    this.stats = new QuotaMeter();
    this._uid = null; this._email = null; this._authCbs = new Set();
    this._watches = new Set();
    const self = this;
    this.auth = {
      async signUp(email, password) { await server.delay(); email = String(email).toLowerCase(); if (server.users.has(email)) throw new CloudError('auth/email-already-in-use', 'Email already in use'); if (String(password).length < 6) throw new CloudError('auth/weak-password', 'Password should be at least 6 characters'); const uid = crypto.randomBytes(14).toString('hex'); server.users.set(email, { uid, password }); self._setUser(uid, email); return self.auth.user(); },
      async signIn(email, password) { await server.delay(); email = String(email).toLowerCase(); const u = server.users.get(email); if (!u || u.password !== password) throw new CloudError('auth/invalid-credential', 'Wrong email or password'); self._setUser(u.uid, email); return self.auth.user(); },
      async signOut() { self._setUser(null, null); },
      async changePassword(oldPw, newPw) { await server.delay(); const u = server.users.get(self._email); if (!u || u.password !== oldPw) throw new CloudError('auth/invalid-credential', 'Wrong current password'); if (String(newPw).length < 6) throw new CloudError('auth/weak-password', 'Password should be at least 6 characters'); u.password = newPw; },
      async sendPasswordReset(email) { await server.delay(); server.resetEmails = (server.resetEmails || []).concat(String(email).toLowerCase()); },
      user() { return self._uid ? { uid: self._uid, email: self._email } : null; },
      onChange(cb) { self._authCbs.add(cb); setImmediate(() => cb(self.auth.user())); return () => self._authCbs.delete(cb); },
      async ready() { return self.auth.user(); },
    };
  }
  _setUser(uid, email) { this._uid = uid; this._email = email; for (const cb of this._authCbs) cb(this.auth.user()); }
  // simulated wall clock of this PC: world time (server.advance moves it for everyone) + this PC's clock error
  ts(ms) { return ms; }
  localNow() { return this.server.now() + this.clockSkewMs; }

  async get(path) {
    await this.server.delay();
    this.server._check(this._uid, path, 'read');
    this.stats.read();
    const e = this.server.docs.get(path);
    return e ? clone(e.data) : null;
  }
  async set(path, data, { merge = false } = {}) { await this.server.delay(); this.server._commit(this._uid, [{ type: 'set', path, data, merge }]); this.stats.write(); }
  async delete(path) { await this.server.delay(); this.server._commit(this._uid, [{ type: 'delete', path }]); this.stats.del(); }
  async batch(ops) {
    for (let i = 0; i < ops.length; i += 450) { await this.server.delay(); const part = ops.slice(i, i + 450); this.server._commit(this._uid, part); this.stats.write(part.filter(o => o.type !== 'delete').length); this.stats.del(part.filter(o => o.type === 'delete').length); }
  }
  async tx(fn, { maxAttempts = 5 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reads = new Map(); const ops = [];
      const t = {
        get: async path => {
          await this.server.delay();
          this.server._check(this._uid, path, 'read');
          this.stats.read();
          const e = this.server.docs.get(path);
          reads.set(path, e ? e.version : 0);
          return e ? clone(e.data) : null;
        },
        set: (path, data, { merge = false } = {}) => { ops.push({ type: 'set', path, data, merge }); },
        delete: path => { ops.push({ type: 'delete', path }); },
      };
      const result = await fn(t);
      await this.server.delay();
      try { this.server._commit(this._uid, ops, reads); this.stats.write(ops.length); return result; }
      catch (e) { lastErr = e; if (e.code !== 'aborted') throw e; await new Promise(r => setTimeout(r, Math.random() * 10 * attempt)); }
    }
    throw lastErr;
  }
  watch(collPath, q, onChanges, onError = () => {}) {
    const prev = new Map(); // path -> version
    let active = true;
    const self = this;
    const listener = {
      refresh() {
        if (!active) return;
        setImmediate(() => {
          if (!active) return;
          try { self.server._check(self._uid, collPath + '/x', 'read'); } catch (e) { active = false; self.server.listeners.delete(listener); return onError(e); }
          const rows = self.server._query(collPath, q);
          const seen = new Set(); const changes = [];
          for (const r of rows) {
            seen.add(r.path);
            const pv = prev.get(r.path);
            if (pv === undefined) changes.push({ type: 'added', id: r.id, path: r.path, data: clone(r.data), pending: false });
            else if (pv !== r.version) changes.push({ type: 'modified', id: r.id, path: r.path, data: clone(r.data), pending: false });
            prev.set(r.path, r.version);
          }
          for (const p of [...prev.keys()]) if (!seen.has(p)) { prev.delete(p); changes.push({ type: 'removed', id: p.split('/').pop(), path: p, data: null, pending: false }); }
          if (changes.length) { self.stats.read(changes.filter(c => c.type !== 'removed').length || 1); onChanges(changes); }
        });
      },
    };
    this.server.listeners.add(listener);
    this._watches.add(listener);
    listener.refresh();
    if (!rowsCount(this.server, collPath, q)) setImmediate(() => active && onChanges([]));
    return () => { active = false; this.server.listeners.delete(listener); this._watches.delete(listener); };
  }
  async close() { for (const l of this._watches) this.server.listeners.delete(l); this._watches.clear(); }
}
function rowsCount(server, collPath, q) { try { return server._query(collPath, q).length; } catch (_) { return 0; } }

module.exports = { MemoryServer, MemoryStore };
