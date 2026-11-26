/**
 * Today's mood: a short-lived lean on top of the long-term taste (taste.js). Pure, no browser APIs, so it can be run in node.
 *
 * The long-term weights say what you like in general. This says what you are after right now: every like, skip and long look nudges the
 * tags of that post up or down, older nudges fade a little with each new one, and the whole thing halves every five hours, so tomorrow
 * starts nearly clean. It only affects the order things are shown in. It never writes to the long-term weights, so an odd first few
 * posts cannot spoil them.
 */
import { features } from './taste.js';

const HALF_LIFE = 5 * 3600e3;
const NEW_DAY = 3 * 3600e3; // a new calendar day after a break this long wipes most of what is left
const STEP = 0.3; // how far one full-strength signal moves a tag of ordinary weight
const RECENCY = 0.97; // what every older nudge keeps when a new one arrives
const CAP = 1.5;
const MAX_KEYS = 600;

const felt = (post) => features(post).filter(([, , cat]) => cat !== 'meta' && cat !== 'invalid' && cat !== 'contributor');

export class Mood {
  constructor(data, now = Date.now()) {
    const d = data && typeof data === 'object' ? data : {};
    this.v = d.v || {}; // tag -> how much it fits today, -CAP..CAP
    this.n = d.n || 0; // how much has been said today (sum of signal strengths)
    this.ts = d.ts || 0;
    this.extra = []; // today as seen on your other devices (sync): read here, written there
    this.fade(now);
  }

  toJSON() {
    const v = {};
    for (const [k, x] of Object.entries(this.v)) v[k] = Math.round(x * 1000) / 1000;
    return { v, n: Math.round(this.n * 100) / 100, ts: this.ts };
  }

  /** Let time pass. */
  fade(now = Date.now()) {
    for (const m of this.extra) m.fade(now);
    if (!this.ts) return;
    const gap = now - this.ts;
    if (gap < 60000) return;
    let f = Math.pow(0.5, gap / HALF_LIFE);
    if (gap > NEW_DAY && new Date(now).toDateString() !== new Date(this.ts).toDateString()) f *= 0.2;
    for (const k of Object.keys(this.v)) {
      this.v[k] *= f;
      if (Math.abs(this.v[k]) < 0.03) delete this.v[k];
    }
    this.n *= f;
    this.ts = now;
  }

  /** Too little said yet to know what today is about. */
  get fresh() {
    return this.extra.reduce((n, m) => n + m.n, this.n) < 2.5;
  }

  /**
   * React to a post: signal from -1 (not today) to 1 (yes, this). `common(tag)` is the share of all posts that carry the tag (0..1):
   * a tag that is on everything says little about a mood, so it moves less.
   */
  feel(post, signal, common = () => 0, now = Date.now()) {
    if (!signal) return;
    this.fade(now);
    this.ts = now;
    for (const k of Object.keys(this.v)) this.v[k] *= RECENCY;
    for (const [f, w] of felt(post)) {
      const rare = 1 - Math.min(0.85, common(f) || 0);
      const x = Math.max(-CAP, Math.min(CAP, (this.v[f] || 0) + signal * STEP * w * rare));
      this.v[f] = x;
    }
    this.n += Math.abs(signal);
    const keys = Object.keys(this.v);
    if (keys.length > MAX_KEYS) for (const k of keys.sort((a, b) => Math.abs(this.v[a]) - Math.abs(this.v[b])).slice(0, keys.length - MAX_KEYS + 50)) delete this.v[k];
  }

  /** How well a post suits today, on about the same scale as the long-term score. */
  score(post) {
    const fs = felt(post);
    let sum = 0;
    for (const [f, w] of fs) {
      let x = this.v[f] || 0;
      for (const m of this.extra) x += m.v[f] || 0;
      sum += x * w;
    }
    return Math.max(-CAP, Math.min(CAP, sum / Math.sqrt(Math.max(8, fs.length))));
  }

  forget(tag) {
    delete this.v[tag];
    for (const m of this.extra) delete m.v[tag];
  }

  reset() {
    this.v = {};
    this.n = 0;
    this.ts = 0;
    this.extra = [];
  }
}
