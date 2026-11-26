'use strict';
// v0.3.1: one active PC per UploadPilot account, with a graceful hand-over.
//
//   users/{uid}/meta/activePc = { pcId, pcName, since, renewedAt (server time), handedOver, handedTo, handedToName }
//   users/{uid}/meta/takeover = { id, toPcId, toPcName, fromPcId, state: 'requested'|'handed_over'|'cancelled', at, doneAt }
//
// The active PC renews renewedAt every ~30 s (server timestamp). Another PC may become active when
//   * there is no doc, or it is this PC already,
//   * the holder's heartbeat is older than staleMs (~2 min, by the SERVER clock: PC dead / offline), or
//   * the holder marked itself handedOver (graceful hand-over finished).
// A graceful take-over: the new PC writes meta/takeover {state:'requested'}; the active PC sees it via
// the meta listener, winds down (stop new jobs, finish/abort the upload, save logins, back up, release
// leases), writes handedOver + takeover.state='handed_over', then signs out. The new PC waits for that
// ack (or for the heartbeat to go stale / the timeout) and claims the doc.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { withTimeout } = require('./store/common');

class ActivePc extends EventEmitter {
  /** @param {{store, root:()=>string, pcId, pcName, serverNow:()=>number, heartbeatMs?, staleMs?, handoverTimeoutMs?}} o */
  constructor(o) {
    super();
    this.o = { heartbeatMs: 30000, staleMs: 120000, handoverTimeoutMs: 240000, ...o };
    this.doc = null; this.req = null; this.isActive = false; this._timer = null; this._waiters = new Set();
  }
  get path() { return `${this.o.root()}/meta/activePc`; }
  get reqPath() { return `${this.o.root()}/meta/takeover`; }

  fresh(d = this.doc, now = this.o.serverNow()) { return !!(d && d.pcId && !d.handedOver && now - (d.renewedAt || 0) <= this.o.staleMs); }
  holder() { return this.doc && this.doc.pcId && this.doc.pcId !== this.o.pcId && this.fresh() ? { pcId: this.doc.pcId, pcName: this.doc.pcName, since: this.doc.since } : null; }
  status() {
    const d = this.doc;
    return { me: this.isActive, activePcId: d ? d.pcId : null, activePcName: d && !d.handedOver ? d.pcName : (this.isActive ? this.o.pcName : null), since: d ? d.since : null, fresh: this.fresh(), other: this.holder(), takeover: this.req && this.req.state === 'requested' ? { to: this.req.toPcName, from: this.req.fromPcId } : null };
  }

  async load() {
    const [d, r] = await Promise.all([withTimeout(this.o.store.get(this.path), 15000, 'read active PC'), this.o.store.get(this.reqPath).catch(() => null)]);
    this.doc = d || null; this.req = r || null;
    return this.status();
  }

  /** Become the active PC if allowed (or force after a timed-out hand-over). */
  async claim({ force = false } = {}) {
    const me = this.o.pcId;
    const res = await this.o.store.tx(async t => {
      const cur = await t.get(this.path);
      const free = !cur || !cur.pcId || cur.pcId === me || cur.handedOver || !this.fresh(cur);
      if (!free && !force) return { ok: false, holder: { pcId: cur.pcId, pcName: cur.pcName, since: cur.since } };
      t.set(this.path, { pcId: me, pcName: this.o.pcName, since: cur && cur.pcId === me && !cur.handedOver ? (cur.since || this.o.store.SERVER_TS) : this.o.store.SERVER_TS, renewedAt: this.o.store.SERVER_TS, handedOver: false, handedTo: null, handedToName: null });
      return { ok: true, from: cur && cur.pcId !== me ? { pcId: cur.pcId, pcName: cur.pcName, stale: !this.fresh(cur), handedOver: !!cur.handedOver } : null };
    });
    if (res.ok) { this.isActive = true; this._startHeartbeat(); this.doc = await this.o.store.get(this.path).catch(() => this.doc); this.emit('active'); }
    return res;
  }

  _startHeartbeat() {
    clearInterval(this._timer);
    this._timer = setInterval(() => this.beat().catch(() => {}), this.o.heartbeatMs);
    if (this._timer.unref) this._timer.unref();
  }

  /** Renew the heartbeat; if another PC owns the doc now, this PC lost the active role. */
  async beat() {
    if (!this.isActive) return false;
    const me = this.o.pcId;
    const r = await this.o.store.tx(async t => {
      const cur = await t.get(this.path);
      if (!cur || cur.pcId !== me || cur.handedOver) return { lost: true, by: cur ? cur.pcName : null };
      t.set(this.path, { renewedAt: this.o.store.SERVER_TS }, { merge: true });
      return { lost: false };
    });
    if (r.lost) this._lose(r.by);
    return !r.lost;
  }

  _lose(byName) {
    if (!this.isActive) return;
    this.isActive = false; clearInterval(this._timer);
    this.emit('lost', byName || (this.doc && this.doc.pcName) || 'another PC');
  }

  /** Called by the meta listener for meta/activePc and meta/takeover. */
  onDoc(id, d) {
    if (id === 'activePc') {
      this.doc = d || null;
      if (this.isActive && d && d.pcId && d.pcId !== this.o.pcId) this._lose(d.pcName);
    }
    if (id === 'takeover') {
      this.req = d || null;
      if (d && d.state === 'requested' && this.isActive && d.toPcId !== this.o.pcId && (!d.fromPcId || d.fromPcId === this.o.pcId) && this._handling !== d.id) {
        this._handling = d.id;
        this.emit('handover-request', d);
      }
    }
    for (const w of [...this._waiters]) w();
    this.emit('change');
  }

  /** New PC: ask the active PC to hand over, wait for the ack (or stale heartbeat / timeout), then claim. */
  async requestTakeover({ onProgress = () => {} } = {}) {
    await this.load();
    const h = this.holder();
    if (!h) { const r = await this.claim(); return { ...r, how: 'free' }; }
    const id = crypto.randomBytes(8).toString('hex');
    await this.o.store.set(this.reqPath, { id, toPcId: this.o.pcId, toPcName: this.o.pcName, fromPcId: h.pcId, fromPcName: h.pcName, state: 'requested', at: this.o.store.SERVER_TS, doneAt: null });
    onProgress(`Asked ${h.pcName} to hand over…`);
    const t0 = Date.now();
    let how = 'timeout';
    while (Date.now() - t0 < this.o.handoverTimeoutMs) {
      const d = await this.o.store.get(this.path).catch(() => null);
      const rq = await this.o.store.get(this.reqPath).catch(() => null);
      if (d) this.doc = d;
      if (rq && rq.id === id && rq.state === 'handed_over') { how = 'handed_over'; break; }
      if (!d || d.handedOver || !this.fresh(d)) { how = d && d.handedOver ? 'handed_over' : 'stale'; break; }
      await new Promise(res => { const w = () => { clearTimeout(tm); this._waiters.delete(w); res(); }; const tm = setTimeout(w, Math.min(2000, this.o.heartbeatMs)); this._waiters.add(w); });
    }
    const r = await this.claim({ force: true });
    await this.o.store.set(this.reqPath, { state: how === 'handed_over' ? 'done' : 'forced', doneAt: this.o.store.SERVER_TS }, { merge: true }).catch(() => {});
    return { ...r, how, from: h };
  }

  /** Old PC, after winding down: mark handed over (the new PC may claim at once). */
  async markHandedOver(req) {
    await this.o.store.set(this.path, { handedOver: true, handedTo: req.toPcId, handedToName: req.toPcName, renewedAt: this.o.store.SERVER_TS }, { merge: true });
    await this.o.store.set(this.reqPath, { state: 'handed_over', doneAt: this.o.store.SERVER_TS }, { merge: true });
    this.isActive = false; clearInterval(this._timer);
  }

  stop() { clearInterval(this._timer); this.isActive = false; for (const w of [...this._waiters]) w(); }
}

module.exports = { ActivePc };
