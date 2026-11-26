'use strict';
// Lane scheduler: N lanes, each strictly sequential:
//   pick channel -> runChannel (open profile, upload due videos, close) -> random wait -> next.
// A channel is only ever in one lane at a time. Channel order is shuffled once per day; among due
// channels the one that ran least recently goes first (ties broken by today's shuffled order).
const { shuffle, mulberry32, hashString, randFloat } = require('../util/random');
const { dayKey } = require('../util/time');

class LaneScheduler {
  /**
   * @param {object} o
   * @param {number} o.lanes
   * @param {() => Array<number>} o.getDueChannels   ids of channels that currently have due work (respects window)
   * @param {() => Array<number>} o.getAllChannels   ids of all active channels (for the daily shuffle)
   * @param {(channelId:number, lane:number) => Promise<any>} o.runChannel
   * @param {{min:number,max:number}} o.delayRangeMin   minutes
   * @param {number} [o.idleMs=30000]  how long an idle lane waits before looking again
   * @param {number} [o.cooldownMs=600000] a channel isn't picked again this soon after its last run
   * @param {() => boolean} [o.canStart]  gate for starting NEW runs (e.g. false while the user uses the PC)
   */
  constructor(o) {
    this.o = { idleMs: 30000, cooldownMs: 10 * 60000, now: () => Date.now(), rng: Math.random, onEvent: () => {}, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) };
    this.running = false;
    this.inProgress = new Map(); // channelId -> lane
    this.lastRun = new Map();
    this.order = []; this.orderDay = null;
    this.laneState = [];
    this._wakers = new Set();
    this._loops = [];
  }

  dailyOrder() {
    const today = dayKey(this.o.now());
    const all = this.o.getAllChannels();
    if (this.orderDay !== today) {
      const seed = hashString(today + ':' + Math.floor(this.o.rng() * 1e9));
      this.order = shuffle(all, mulberry32(seed));
      this.orderDay = today;
      this.o.onEvent({ type: 'shuffle', order: this.order.slice() });
    } else {
      const missing = all.filter(id => !this.order.includes(id));
      if (missing.length) this.order = this.order.concat(shuffle(missing, this.o.rng));
    }
    return this.order;
  }

  /** Choose and claim the next channel for a lane, or null. */
  claimNext(lane) {
    if (this.o.canStart && !this.o.canStart()) return null;
    const due = new Set(this.o.getDueChannels());
    if (!due.size) return null;
    const order = this.dailyOrder();
    const now = this.o.now();
    const candidates = order.filter(id => due.has(id) && !this.inProgress.has(id) && !(now - (this.lastRun.get(id) ?? -Infinity) < this.o.cooldownMs));
    if (!candidates.length) return null;
    candidates.sort((a, b) => (this.lastRun.get(a) ?? -Infinity) - (this.lastRun.get(b) ?? -Infinity) || order.indexOf(a) - order.indexOf(b));
    const id = candidates[0];
    this.inProgress.set(id, lane);
    return id;
  }

  nextDelayMs() { const { min, max } = this.o.delayRangeMin; return Math.round(randFloat(this.o.rng, min, max) * 60000); }

  _sleep(ms) {
    return new Promise(resolve => {
      const w = () => { clearTimeout(t); this._wakers.delete(w); resolve(); };
      const t = setTimeout(w, ms);
      this._wakers.add(w);
    });
  }
  wake() { for (const w of [...this._wakers]) w(); }

  async _laneLoop(lane) {
    const st = this.laneState[lane] = { lane, state: 'idle', channelId: null, until: null };
    while (this.running) {
      const id = this.claimNext(lane);
      if (id == null) { st.state = 'idle'; st.until = this.o.now() + this.o.idleMs; await this._sleep(this.o.idleMs); continue; }
      st.state = 'running'; st.channelId = id; st.until = null;
      this.o.onEvent({ type: 'start', lane, channelId: id });
      try { await this.o.runChannel(id, lane); this.o.onEvent({ type: 'end', lane, channelId: id }); }
      catch (e) { this.o.onEvent({ type: 'error', lane, channelId: id, error: e.message }); }
      finally { this.lastRun.set(id, this.o.now()); this.inProgress.delete(id); st.channelId = null; }
      if (!this.running) break;
      const d = this.nextDelayMs();
      st.state = 'waiting'; st.until = this.o.now() + d;
      this.o.onEvent({ type: 'wait', lane, ms: d });
      await this._sleep(d);
    }
    st.state = 'stopped';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loops = Array.from({ length: this.o.lanes }, (_, i) => this._laneLoop(i));
  }
  async stop() { this.running = false; this.wake(); await Promise.all(this._loops); this._loops = []; }
  status() { return { running: this.running, lanes: this.laneState.map(s => ({ ...s })), inProgress: [...this.inProgress.entries()] }; }
}

module.exports = { LaneScheduler };
