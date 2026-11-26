'use strict';
// Firestore + Firebase Auth (modular JS SDK) behind the small store interface in common.js.
// Runs in the Electron main process (Node build of the SDK). Works against the real project or the
// Firebase Emulator Suite (emulator: {firestore:'127.0.0.1:8080', auth:'http://127.0.0.1:9099'}).
const { SERVER_TS, DELETE, CloudError, QuotaMeter } = require('./common');

/**
 * Firebase Auth persistence backed by our encrypted SecretStore, so the sign-in survives restarts
 * (the Node SDK only has in-memory persistence). Shape follows the SDK's internal Persistence API.
 */
function makeSecretPersistence(secretStore, key = 'firebaseAuth') {
  return class SecretPersistence {
    constructor() { this.type = 'LOCAL'; }
    async _isAvailable() { return true; }
    async _set(k, v) { const all = secretStore.get(key) || {}; all[k] = v; secretStore.set(key, all); }
    async _get(k) { const all = secretStore.get(key) || {}; return all[k] === undefined ? null : all[k]; }
    async _remove(k) { const all = secretStore.get(key) || {}; delete all[k]; secretStore.set(key, all); }
    _addListener() {}
    _removeListener() {}
  };
}

function mapErr(e) {
  if (e instanceof CloudError) return e;
  const code = String(e && e.code || 'unknown');
  const nice = {
    'auth/invalid-credential': 'Wrong email or password', 'auth/wrong-password': 'Wrong email or password', 'auth/user-not-found': 'No account with that email',
    'auth/email-already-in-use': 'An account with that email already exists', 'auth/weak-password': 'Password should be at least 6 characters',
    'auth/invalid-email': 'That email address is not valid', 'auth/network-request-failed': 'Network error — check the internet connection',
    'auth/operation-not-allowed': 'Email/Password sign-in is not enabled in the Firebase console', 'auth/invalid-api-key': 'The Firebase config (apiKey) is not valid',
  }[code];
  const err = new CloudError(code.replace(/^firestore\//, ''), nice || (e && e.message) || code);
  err.cause = e;
  return err;
}

class FirestoreStore {
  /**
   * @param {object} o
   * @param {object} o.firebaseConfig   web app config from the Firebase console
   * @param {object} [o.emulator]       {firestore:'host:port', auth:'http://host:port'}
   * @param {import('../secretStore').SecretStore} [o.secrets]  for auth persistence
   * @param {string} [o.appName]        separate app instance (tests run two "PCs" in one process)
   */
  constructor({ firebaseConfig, emulator = {}, secrets = null, appName = 'uploadpilot' }) {
    const fbApp = require('firebase/app');
    const fa = require('firebase/auth');
    const fs = require('firebase/firestore');
    this.F = fs; this.A = fa;
    this.SERVER_TS = SERVER_TS; this.DELETE = DELETE;
    this.stats = new QuotaMeter();
    const existing = fbApp.getApps().find(a => a.name === appName);
    this.app = existing || fbApp.initializeApp(firebaseConfig, appName);
    this.db = fs.initializeFirestore(this.app, { ignoreUndefinedProperties: true });
    this.authObj = fa.initializeAuth(this.app, { persistence: secrets ? makeSecretPersistence(secrets) : fa.inMemoryPersistence });
    if (emulator.firestore) { const [h, p] = emulator.firestore.replace(/^https?:\/\//, '').split(':'); fs.connectFirestoreEmulator(this.db, h, +p || 8080); }
    if (emulator.auth) fa.connectAuthEmulator(this.authObj, /^https?:/.test(emulator.auth) ? emulator.auth : `http://${emulator.auth}`, { disableWarnings: true });
    const A = this.authObj;
    const u = () => (A.currentUser ? { uid: A.currentUser.uid, email: A.currentUser.email } : null);
    this.auth = {
      signUp: async (email, pw) => { try { await fa.createUserWithEmailAndPassword(A, email, pw); return u(); } catch (e) { throw mapErr(e); } },
      signIn: async (email, pw) => { try { await fa.signInWithEmailAndPassword(A, email, pw); return u(); } catch (e) { throw mapErr(e); } },
      signOut: async () => { await fa.signOut(A); },
      user: u,
      onChange: cb => fa.onAuthStateChanged(A, () => cb(u())),
      ready: async () => { await A.authStateReady(); return u(); },
    };
  }

  /** a time value usable in queries against serverTimestamp fields */
  ts(ms) { return this.F.Timestamp.fromMillis(ms); }
  _ref(path) { return this.F.doc(this.db, path); }
  _toWire(v) {
    if (v === SERVER_TS) return this.F.serverTimestamp();
    if (v === DELETE) return this.F.deleteField();
    if (Array.isArray(v)) return v.map(x => this._toWire(x));
    if (v && typeof v === 'object' && v.constructor === Object) { const o = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = this._toWire(x); return o; }
    return v;
  }
  _fromWire(v) {
    if (v && typeof v.toMillis === 'function') return v.toMillis();
    if (Array.isArray(v)) return v.map(x => this._fromWire(x));
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = this._fromWire(x); return o; }
    return v;
  }
  _data(snap) { return snap.exists() ? this._fromWire(snap.data({ serverTimestamps: 'estimate' })) : null; }

  async get(path) { try { const s = await this.F.getDoc(this._ref(path)); this.stats.read(); return this._data(s); } catch (e) { throw mapErr(e); } }
  async set(path, data, { merge = false } = {}) { try { await this.F.setDoc(this._ref(path), this._toWire(data), { merge }); this.stats.write(); } catch (e) { throw mapErr(e); } }
  async delete(path) { try { await this.F.deleteDoc(this._ref(path)); this.stats.del(); } catch (e) { throw mapErr(e); } }
  async batch(ops) {
    try {
      for (let i = 0; i < ops.length; i += 450) {
        const b = this.F.writeBatch(this.db);
        for (const op of ops.slice(i, i + 450)) { if (op.type === 'delete') { b.delete(this._ref(op.path)); this.stats.del(); } else { b.set(this._ref(op.path), this._toWire(op.data), { merge: !!op.merge }); this.stats.write(); } }
        await b.commit();
      }
    } catch (e) { throw mapErr(e); }
  }
  async tx(fn, { maxAttempts = 5 } = {}) {
    try {
      return await this.F.runTransaction(this.db, async t => {
        const w = {
          get: async path => { const s = await t.get(this._ref(path)); this.stats.read(); return this._data(s); },
          set: (path, data, { merge = false } = {}) => { t.set(this._ref(path), this._toWire(data), { merge }); this.stats.write(); },
          delete: path => { t.delete(this._ref(path)); this.stats.del(); },
        };
        return fn(w);
      }, { maxAttempts });
    } catch (e) { throw mapErr(e); }
  }
  watch(collPath, q = {}, onChanges, onError = () => {}) {
    const F = this.F;
    const parts = [F.collection(this.db, collPath)];
    for (const [f, op, v] of q.where || []) parts.push(F.where(f, op, v));
    if (q.orderBy) parts.push(F.orderBy(q.orderBy[0], q.orderBy[1] || 'asc'));
    if (q.limit) parts.push(F.limit(q.limit));
    const query = F.query(...parts);
    return F.onSnapshot(query, snap => {
      const changes = snap.docChanges().map(c => ({ type: c.type, id: c.doc.id, path: c.doc.ref.path, data: c.type === 'removed' ? null : this._data(c.doc), pending: c.doc.metadata.hasPendingWrites }));
      this.stats.read(Math.max(1, changes.filter(c => c.type !== 'removed' && !c.pending).length));
      onChanges(changes);
    }, e => onError(mapErr(e)));
  }
  async close() {
    try { await this.F.terminate(this.db); } catch (_) { /* ignore */ }
    try { await require('firebase/app').deleteApp(this.app); } catch (_) { /* ignore */ }
  }
}

module.exports = { FirestoreStore, makeSecretPersistence, mapErr };
