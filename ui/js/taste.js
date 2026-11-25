/**
 * The Feed's taste model. Pure functions and one class, no browser APIs, so it can be run in node.
 *
 * Idea: for every tag a post carries we count how often posts with that tag were SHOWN (n) and how often they were LIKED (l).
 * A tag's "lift" is how much more often it is liked than posts in general (log of the ratio, smoothed so a tag seen twice
 * cannot shout). A post scores the sum of its tags' lifts, each scaled by its category (an artist you love counts for more than
 * "solo"), divided by the square root of how many tags it has so long tag lists don't win by size alone.
 *
 * Everything lives on the device. Counts fade with a half-life, so what you liked last year matters less than last week.
 */
export const CAT_W = { artist: 2.2, character: 1.3, species: 1.2, copyright: 1.0, general: 1.0, lore: 0.6, meta: 0.12, contributor: 0, invalid: 0 };
const HALF_LIFE_DAYS = 120;
const SMOOTH = 3; // pseudo-observations at the global rate: how much evidence a tag needs before its own rate counts
const MAX_TAGS = 4500;
const LIFT_MIN = -1.5, LIFT_MAX = 3;

/** [feature, weight] pairs for a post: its tags by category, plus its kind and rating (as "~kind:video"). */
export function features(post) {
  const out = [];
  let n = 0;
  for (const [cat, list] of Object.entries(post.tags || {})) {
    const w = CAT_W[cat] ?? 1;
    if (!w) continue;
    for (const t of list) {
      if (++n > 70) break;
      out.push([t, w, cat]);
    }
  }
  if (post.kind) out.push(['~kind:' + post.kind, 0.9, 'kind']);
  if (post.rating) out.push(['~rating:' + post.rating, 0.5, 'kind']);
  return out;
}

export class Taste {
  constructor(data) {
    const d = data && typeof data === 'object' ? data : {};
    this.t = d.t || {}; // feature -> [liked, shown]
    this.pl = d.pl || 0; // posts liked (weighted)
    this.pn = d.pn || 0; // posts shown (weighted)
    this.ts = d.ts || Date.now();
    this.likes = d.likes || 0; // real likes, never faded: for "have we learned anything yet"
    this.a = d.a || {}; // artist -> how much of their work was liked (for suggesting who to follow)
    this._calls = 0;
    this._decay();
  }

  toJSON() {
    const t = {};
    for (const [k, [l, n]] of Object.entries(this.t)) t[k] = [Math.round(l * 1000) / 1000, Math.round(n * 1000) / 1000];
    const a = {};
    for (const [k, v] of Object.entries(this.a)) if (v >= 0.2) a[k] = Math.round(v * 100) / 100;
    return { t, a, pl: Math.round(this.pl * 1000) / 1000, pn: Math.round(this.pn * 1000) / 1000, ts: this.ts, likes: this.likes };
  }

  _decay(now = Date.now()) {
    const days = (now - this.ts) / 86400000;
    if (days < 0.5) return;
    const f = Math.pow(0.5, days / HALF_LIFE_DAYS);
    for (const k of Object.keys(this.t)) {
      const e = this.t[k];
      e[0] *= f;
      e[1] *= f;
      if (e[1] < 0.15) delete this.t[k];
    }
    this.pl *= f;
    this.pn *= f;
    for (const k of Object.keys(this.a)) this.a[k] *= f;
    this.ts = now;
  }

  _prune() {
    const keys = Object.keys(this.t);
    if (keys.length <= MAX_TAGS) return;
    keys.sort((a, b) => this.t[a][1] - this.t[b][1]);
    for (const k of keys.slice(0, keys.length - MAX_TAGS + 300)) delete this.t[k];
  }

  /** Record something: l = how much it was liked, n = how many times it was shown (extra n is a penalty). */
  learn(post, { l = 0, n = 0, post_n = n } = {}) {
    for (const [f] of features(post)) {
      const e = (this.t[f] ||= [0, 0]);
      e[0] = Math.max(0, e[0] + l);
      e[1] += n;
    }
    this.pl = Math.max(0, this.pl + l);
    this.pn += post_n;
    if (l >= 1) this.likes++;
    if (l) this.countArtists(post, l);
    if (++this._calls % 100 === 0) this._prune();
  }

  /** Add to (or with a negative amount take from) how much an artist is liked. Weights are kept and nudged, never recomputed. */
  countArtists(post, amount) {
    for (const name of post.artists || []) {
      const v = Math.max(0, (this.a[name] || 0) + amount);
      if (v) this.a[name] = v;
      else delete this.a[name];
    }
  }

  /** Artists liked at least `min` times, most liked first. */
  topArtists(min = 3) {
    return Object.entries(this.a).filter(([, v]) => v >= min).sort((x, y) => y[1] - x[1]).map(([name, v]) => ({ name, v }));
  }

  /** How often posts in general are liked. */
  get base() {
    return this.pn > 8 ? Math.max(0.02, Math.min(0.5, this.pl / this.pn)) : 0.08;
  }

  lift(f) {
    const e = this.t[f];
    if (!e) return 0;
    const g = this.base;
    const r = (e[0] + SMOOTH * g) / (e[1] + SMOOTH);
    return Math.max(LIFT_MIN, Math.min(LIFT_MAX, Math.log(r / g)));
  }

  /** Is there enough to go on to rank by taste at all? */
  get ready() {
    return this.likes >= 4 && this.pn >= 12;
  }

  /** score, how unfamiliar it is (0..1), and the feature that pulled it up the most. */
  rate(post) {
    const fs = features(post);
    let sum = 0, unknown = 0, best = null, bestV = 0;
    for (const [f, w, cat] of fs) {
      const e = this.t[f];
      if (!e || e[1] < 2) {
        if (cat !== 'meta' && cat !== 'kind') unknown++;
        continue;
      }
      const v = this.lift(f) * w;
      sum += v;
      if (v > bestV && cat !== 'kind') (bestV = v), (best = { f, cat });
    }
    const n = Math.max(8, fs.length);
    return { score: sum / Math.sqrt(n), novelty: Math.min(1, unknown / Math.max(4, fs.length - 1)), why: best };
  }

  /** The tags worth searching for: liked a fair amount and clearly above average. */
  interests(cats = ['artist', 'character', 'species', 'general', 'copyright'], limit = 30, tagCat = () => null) {
    const out = [];
    for (const [f, [l, n]] of Object.entries(this.t)) {
      if (f[0] === '~' || l < 1.2) continue;
      const cat = tagCat(f);
      if (cat && !cats.includes(cat)) continue;
      const lf = this.lift(f);
      if (lf < 0.6) continue;
      out.push({ tag: f, lift: lf, l, n, rank: lf * Math.sqrt(l) * (CAT_W[cat] ?? 1) });
    }
    return out.sort((a, b) => b.rank - a.rank).slice(0, limit);
  }

  reset() {
    this.t = {};
    this.a = {};
    this.pl = this.pn = this.likes = 0;
    this.ts = Date.now();
  }
}

/** Pick an index with probability following the scores (temperature controls how adventurous it is). */
export function softPick(scores, temp = 0.7, rnd = Math.random) {
  if (!scores.length) return -1;
  const mx = Math.max(...scores);
  const ws = scores.map((s) => Math.exp((s - mx) / temp));
  let r = rnd() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ws.length; i++) if ((r -= ws[i]) <= 0) return i;
  return ws.length - 1;
}
