/**
 * The art-style fingerprint: what the pictures you like look like, beside what they are tagged. Pure, no browser APIs, so it runs in node.
 *
 * Each thumbnail is turned into 512 numbers (a unit vector) by a small image model (stylist.js). All art from one site looks fairly
 * alike to such a model, so everything is compared after taking away the average of the pictures seen: what is left is what sets one apart.
 * The liked pictures are averaged into one direction; a second, short-lived one follows today, fading like the mood (mood.js). Nothing is
 * trained: these are averages. (Measured on real e621 thumbnails, one average told liked artists from others better than several groups
 * or comparing with each liked picture.)
 */
export const DIM = 512;
const WEIGHT_CAP = 60; // the average never gets so heavy that it stops moving with you
const MEAN_CAP = 400;
const HALF_LIFE = 5 * 3600e3;
const NEW_DAY = 3 * 3600e3;

const zeros = () => new Float32Array(DIM);
const unit = (v) => {
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 1e-6) for (let i = 0; i < DIM; i++) v[i] /= n;
  else v.fill(0);
  return v;
};
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
};

/* stored as 16-bit numbers in base64: about 1.4 kB a vector */
const pack = (v) => {
  let top = 0;
  for (let i = 0; i < DIM; i++) top = Math.max(top, Math.abs(v[i]));
  const q = new Int16Array(DIM);
  if (top) for (let i = 0; i < DIM; i++) q[i] = Math.round((v[i] / top) * 32767);
  return [Math.round(top * 1e6) / 1e6, btoa(String.fromCharCode(...new Uint8Array(q.buffer)))];
};
const unpack = (d) => {
  const out = zeros();
  if (!Array.isArray(d) || typeof d[1] !== 'string') return out;
  const bytes = Uint8Array.from(atob(d[1]), (c) => c.charCodeAt(0));
  if (bytes.length !== DIM * 2) return out;
  const q = new Int16Array(bytes.buffer);
  for (let i = 0; i < DIM; i++) out[i] = (q[i] / 32767) * d[0];
  return out;
};

export class Style {
  constructor(data, now = Date.now()) {
    const d = data && typeof data === 'object' ? data : {};
    this.mean = unpack(d.mean); // the average picture
    this.nm = d.nm || 0;
    this.lv = unpack(d.lv); // the average liked picture
    this.lw = d.lw || 0; // how much has been liked
    this.tv = unpack(d.tv); // today: sum of (signal x picture)
    this.ts = d.ts || 0; // today: sum of signals, signed
    this.tn = d.tn || 0; // today: sum of signal strengths
    this.at = d.at || 0;
    this.seeded = !!d.seeded; // a sample of favorites has been read once
    this.extra = []; // the profiles from your other devices (sync): averaged in here, written there
    this.fade(now);
  }

  toJSON() {
    return {
      mean: pack(this.mean), nm: this.nm, lv: pack(this.lv), lw: Math.round(this.lw * 1000) / 1000,
      tv: pack(this.tv), ts: Math.round(this.ts * 1000) / 1000, tn: Math.round(this.tn * 100) / 100, at: this.at, seeded: this.seeded,
    };
  }

  /** A picture was looked at by the model: it moves the average that everything is compared against. */
  see(e) {
    this.nm = Math.min(this.nm + 1, MEAN_CAP);
    for (let i = 0; i < DIM; i++) this.mean[i] += (e[i] - this.mean[i]) / this.nm;
  }

  /** What is particular about a picture: it minus the average (trusting the average only once it has seen a fair number). */
  center(v, of = this) {
    const k = of.nm / (of.nm + 20), out = zeros();
    for (let i = 0; i < DIM; i++) out[i] = v[i] - of.mean[i] * k;
    return unit(out);
  }

  /** This device's profile and the others' as one: averages weighted by how much each has seen, today's directions added. */
  joined() {
    const all = [this, ...this.extra];
    if (all.length === 1) return this;
    const out = { mean: zeros(), lv: zeros(), tv: zeros(), nm: 0, lw: 0, ts: 0, tn: 0 };
    for (const s of all) {
      out.nm += s.nm;
      out.lw += s.lw;
      out.ts += s.ts;
      out.tn += s.tn;
      for (let i = 0; i < DIM; i++) {
        out.mean[i] += s.mean[i] * s.nm;
        out.lv[i] += s.lv[i] * s.lw;
        out.tv[i] += s.tv[i];
      }
    }
    for (let i = 0; i < DIM; i++) {
      out.mean[i] /= out.nm || 1;
      out.lv[i] /= out.lw || 1;
    }
    return out;
  }

  /** Enough to go on. */
  get known() {
    const all = [this, ...this.extra];
    return all.reduce((n, s) => n + s.lw, 0) >= 1.5 || all.reduce((n, s) => n + s.tn, 0) >= 1.5;
  }

  /** A like (weight 1 for a favorite, less for quieter signs). */
  like(e, weight = 1) {
    if (!(weight > 0)) return;
    for (let i = 0; i < DIM; i++) this.lv[i] = (this.lv[i] * this.lw + e[i] * weight) / (this.lw + weight);
    this.lw = Math.min(WEIGHT_CAP, this.lw + weight);
  }

  /** A like taken back. */
  unlike(e, weight = 1) {
    const left = this.lw - weight;
    if (left < 0.1) {
      this.lv = zeros();
      this.lw = 0;
      return;
    }
    for (let i = 0; i < DIM; i++) this.lv[i] = (this.lv[i] * this.lw - e[i] * weight) / left;
    this.lw = left;
  }

  /** Let time pass for today's direction. */
  fade(now = Date.now()) {
    for (const s of this.extra) s.fade(now);
    if (!this.at) return;
    const gap = now - this.at;
    if (gap < 60000) return;
    let f = Math.pow(0.5, gap / HALF_LIFE);
    if (gap > NEW_DAY && new Date(now).toDateString() !== new Date(this.at).toDateString()) f *= 0.2;
    this.keep(f, f);
    this.at = now;
  }

  keep(f, fn) {
    for (let i = 0; i < DIM; i++) this.tv[i] *= f;
    this.ts *= f;
    this.tn *= fn;
  }

  /** A reaction to a picture today, -1..1. */
  feel(e, signal, now = Date.now()) {
    if (!signal) return;
    this.fade(now);
    this.at = now;
    this.keep(0.95, 1);
    for (let i = 0; i < DIM; i++) this.tv[i] += signal * e[i];
    this.ts += signal;
    this.tn += Math.abs(signal);
  }

  /** A function that rates pictures against your style as it is now: about -1..1, higher is closer to it. */
  rater() {
    const me = this.joined();
    const liked = me.lw ? this.center(me.lv, me) : zeros(), sure = me.lw / (me.lw + 5);
    const k = me.nm / (me.nm + 20), today = zeros();
    for (let i = 0; i < DIM; i++) today[i] = me.tv[i] - me.mean[i] * k * me.ts;
    const sureToday = Math.sqrt(dot(today, today)) > 0.05 ? me.tn / (me.tn + 3) : 0;
    unit(today);
    return (e) => {
      const c = this.center(e, me);
      return dot(c, liked) * sure + dot(c, today) * sureToday * 0.6;
    };
  }

  reset() {
    this.mean = zeros();
    this.tv = zeros();
    this.lv = zeros();
    this.nm = this.lw = this.ts = this.tn = this.at = 0;
    this.seeded = false;
    this.extra = [];
  }
}
