'use strict';
// Token-bucket speed cap shared by Drive uploads/downloads. take(n) waits until n bytes may pass.
// The rate can change at any time (setRate); 0 or Infinity = no cap.
class Throttle {
  constructor(bytesPerSec = 0, { burstSec = 0.5, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    this.now = now; this.sleep = sleep; this.burstSec = burstSec;
    this.setRate(bytesPerSec);
    this.tokens = Math.min(this.capacity, 16 * 1024); this.last = this.now();   // start nearly empty: a cap is a cap from the first byte
    this.total = 0;
  }
  setRate(bps) {
    this.rate = bps > 0 && Number.isFinite(bps) ? bps : 0;
    this.capacity = this.rate ? Math.max(16 * 1024, this.rate * this.burstSec) : Infinity;
    if (this.tokens > this.capacity) this.tokens = this.capacity;
  }
  _refill() { const t = this.now(); this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.rate); this.last = t; }
  async take(n, signal) {
    this.total += n;
    if (!this.rate) return;
    let need = n;
    while (need > 0) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      this._refill();
      const chunk = Math.min(need, this.capacity);
      if (this.tokens >= chunk) { this.tokens -= chunk; need -= chunk; continue; }
      await this.sleep(Math.max(5, Math.ceil(((chunk - this.tokens) / this.rate) * 1000)));
    }
  }
}

/** Async iterable over a Buffer in slices that respects a Throttle (used as a fetch body). */
async function* throttledChunks(buf, throttle, { slice = 64 * 1024, signal, onBytes } = {}) {
  for (let off = 0; off < buf.length; off += slice) {
    const part = buf.subarray(off, Math.min(buf.length, off + slice));
    if (throttle) await throttle.take(part.length, signal);
    if (onBytes) onBytes(part.length);
    yield part;
  }
}

module.exports = { Throttle, throttledChunks };
