'use strict';
// Human-like input through Playwright/CDP only (never the OS mouse/keyboard, so it doesn't steal
// focus or depend on the user's real mouse).
const { randInt, randFloat, sleep } = require('../util/random');

class Human {
  constructor(page, { rng = Math.random, typing = { minDelay: 35, maxDelay: 160, humanChars: 350 }, speed = 1 } = {}) {
    this.page = page; this.rng = rng; this.typing = typing; this.speed = speed;
    this.mouse = { x: randInt(rng, 100, 600), y: randInt(rng, 100, 400) };
  }
  ms(min, max) { return Math.round(randFloat(this.rng, min, max) * this.speed); }
  async pause(min = 250, max = 900) { await sleep(this.ms(min, max)); }

  async moveTo(x, y) {
    const steps = randInt(this.rng, 8, 22);
    // slight curve via a random control point
    const cx = (this.mouse.x + x) / 2 + randInt(this.rng, -80, 80), cy = (this.mouse.y + y) / 2 + randInt(this.rng, -60, 60);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = (1 - t) * (1 - t) * this.mouse.x + 2 * (1 - t) * t * cx + t * t * x;
      const py = (1 - t) * (1 - t) * this.mouse.y + 2 * (1 - t) * t * cy + t * t * y;
      await this.page.mouse.move(px, py);
      if (this.speed > 0) await sleep(randInt(this.rng, 4, 18) * this.speed);
    }
    this.mouse = { x, y };
  }

  /** Scroll into view, glide the mouse to a random point inside the element, pause, click. */
  async click(locator, { timeout = 15000 } = {}) {
    await locator.waitFor({ state: 'visible', timeout });
    await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
    const box = await locator.boundingBox();
    let position;
    if (box && box.width > 2 && box.height > 2) {
      const ox = box.width * randFloat(this.rng, 0.3, 0.7), oy = box.height * randFloat(this.rng, 0.3, 0.7);
      await this.moveTo(box.x + ox, box.y + oy);
      position = { x: ox, y: oy };
    }
    await this.pause(80, 300);
    await locator.click({ timeout, position, delay: this.ms(30, 110) });
    if (box) this.mouse = { x: box.x + (position?.x || 0), y: box.y + (position?.y || 0) };
  }

  /**
   * Type like a person: per-character random delays with occasional longer "thinking" pauses.
   * After `humanChars` characters the rest is inserted in small chunks (keeps long descriptions
   * from eating the 20-minute channel budget). Newlines are sent as Enter presses.
   */
  async type(text) {
    const { minDelay, maxDelay, humanChars } = this.typing;
    let typed = 0;
    const lines = String(text ?? '').split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = Array.from(lines[li]); // code points, so emoji / surrogate pairs are never split
      let i = 0;
      while (i < line.length) {
        if (typed < humanChars) {
          const ch = line[i++];
          await this.page.keyboard.type(ch);
          typed++;
          let d = randInt(this.rng, minDelay, maxDelay);
          if (ch === ' ' && this.rng() < 0.08) d += randInt(this.rng, 200, 700);
          await sleep(d * this.speed);
        } else {
          const n = randInt(this.rng, 12, 40);
          await this.page.keyboard.insertText(line.slice(i, i + n).join(''));
          i += n; typed += n;
          await sleep(randInt(this.rng, 20, 90) * this.speed);
        }
      }
      if (li < lines.length - 1) { await this.page.keyboard.press('Enter'); await sleep(randInt(this.rng, minDelay, maxDelay) * this.speed); }
    }
  }

  /** Clear a contenteditable/textbox and type new content. */
  async replaceText(locator, text) {
    await this.click(locator);
    await this.pause(100, 300);
    await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await this.page.keyboard.press('Backspace');
    await this.pause(150, 400);
    await this.type(text);
  }

  async scrollALittle() {
    const dy = randInt(this.rng, -250, 350);
    try { await this.page.mouse.wheel(0, dy); } catch (_) { /* ignore */ }
    await this.pause(150, 500);
  }
}

module.exports = { Human };
