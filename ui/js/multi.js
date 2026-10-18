/**
 * A feed that reads several boorus at once (a board with more than one site) and shows each picture once.
 *
 * Merging: every site keeps its own feed. Newest-first boards are merged by post date (each site's page is only fetched when
 * its buffer runs dry, so a stingy site such as Derpibooru is asked for as little as possible); any other order takes turns.
 *
 * Duplicates (the same picture on two sites) are found, strongest signal first, by
 *   1. a post's source list pointing at the other post (e621 sources often link the Derpibooru post and the other way round),
 *   2. both posts naming the same original (a tweet, a Pixiv work, a DeviantArt page…),
 *   3. a small picture fingerprint of the thumbnails, only for posts of the same shape by the same artist.
 * A match never changes what you can open: the tile gets `also` (the other copies) and shows the best copy, which is the one
 * from the most generous site unless another is clearly bigger.
 */
import { Feed, getProvider, linkToHash } from './providers.js';

/** Most generous API first: this is the copy that is loaded when two sites have the same picture. */
const RANK = ['e621', 'e926', 'danbooru', 'gelbooru', 'safebooru', 'derpibooru'];
const rankOf = (p) => { const i = RANK.indexOf(p.provider); return i < 0 ? 99 : i; };
const pixels = (p) => (p.w || 0) * (p.h || 0);

/** Is `a` the copy to show instead of `b`? Clearly bigger wins; otherwise the more generous site. */
export function better(a, b) {
  const pa = pixels(a), pb = pixels(b);
  if (pa > pb * 1.25) return true;
  if (pb > pa * 1.25) return false;
  return rankOf(a) < rankOf(b);
}

/* ------------------------------------------------------------------ what a post says about where it came from */
const site = (p) => (p === 'e926' ? 'e621' : p); // e926 is a mirror of e621: same posts, same ids

/** Keys for one source address. Only addresses that point at ONE picture (a post, a work), never a profile page. */
export function srcKeys(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const host = u.hostname.toLowerCase().replace(/^(www|mobile|m)\./, ''), path = u.pathname.replace(/\/+$/, '');
  let m;
  if (/(^|\.)(twitter|x|fxtwitter|vxtwitter|fixupx)\.com$/.test(host) && (m = /\/status(?:es)?\/(\d+)(?:\/photo\/(\d+))?/.exec(path))) return m[2] ? (m[2] === '1' ? [`tw:${m[1]}`, `tw:${m[1]}:1`] : [`tw:${m[1]}:${m[2]}`]) : [`tw:${m[1]}`];
  if (host.endsWith('pixiv.net') && (m = /artworks\/(\d+)/.exec(path) || /illust_id=(\d+)/.exec(u.search))) return [`px:${m[1]}`, `px:${m[1]}:0`];
  if (host === 'i.pximg.net' && (m = /\/(\d+)_p(\d+)/.exec(path))) return m[2] === '0' ? [`px:${m[1]}`, `px:${m[1]}:0`] : [`px:${m[1]}:${m[2]}`];
  if (host.endsWith('deviantart.com') && (m = /-(\d{6,})$/.exec(path))) return [`da:${m[1]}`];
  if (host.endsWith('furaffinity.net') && (m = /\/view\/(\d+)/.exec(path))) return [`fa:${m[1]}`];
  if (host.endsWith('inkbunny.net') && (m = /\/s\/(\d+)/.exec(path))) return [`ib:${m[1]}`];
  if (host.endsWith('bsky.app') && (m = /\/post\/(\w+)/.exec(path))) return [`bs:${m[1]}`];
  if (host.endsWith('tumblr.com') && (m = /\/post\/(\d+)/.exec(path))) return [`tb:${m[1]}`];
  if (host.endsWith('weasyl.com') && (m = /\/submissions\/(\d+)/.exec(path))) return [`wz:${m[1]}`];
  return path.length >= 14 && /\d/.test(path) ? [`url:${host}${path}`] : [];
}

/** `post:<site>:<id>` for a link to a post on one of the supported sites. */
function postRef(url) {
  const m = /^#\/roam\?p=([a-z0-9]+)&post=(\w+)$/.exec(linkToHash(url) || '');
  return m ? `post:${site(m[1])}:${m[2]}` : null;
}

const keysOf = (post) => {
  const k = new Set([`post:${site(post.provider)}:${post.id}`]);
  for (const s of post.sources || []) {
    if (!/^https?:/i.test(s)) continue;
    srcKeys(s).forEach((x) => k.add(x));
    const r = postRef(s);
    if (r) k.add(r);
  }
  return k;
};

const aspect = (p) => (p.w && p.h ? p.w / p.h : 0);
const sameShape = (a, b, tol) => { const x = aspect(a), y = aspect(b); return !x || !y || Math.abs(x - y) / y <= tol; };

const artistSet = (p) => new Set((p.artists || []).map((a) => String(a).toLowerCase().replace(/^artist:/, '').replace(/_\(artist\)$/, '').replace(/[^a-z0-9]/g, '')).filter(Boolean));
const artistsAgree = (a, b) => {
  const x = artistSet(a), y = artistSet(b);
  if (!x.size || !y.size) return true; // one side does not say: the picture itself has to decide
  for (const n of x) if (y.has(n)) return true;
  return false;
};

/* ------------------------------------------------------------------ picture fingerprint (difference hash of the thumbnail) */
const prints = new WeakMap();
function fingerprint(post) {
  if (prints.has(post)) return prints.get(post);
  const job = (async () => {
    if (!post.thumb) return null;
    const r = await fetch('/img?u=' + encodeURIComponent(post.thumb)); // through the app, so the canvas is not tainted
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    const c = document.createElement('canvas');
    c.width = 9;
    c.height = 8;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0, 9, 8);
    bmp.close?.();
    const d = x.getImageData(0, 0, 9, 8).data;
    const g = (i) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let bits = '';
    for (let y = 0; y < 8; y++) for (let xx = 0; xx < 8; xx++) bits += g(y * 9 + xx) > g(y * 9 + xx + 1) ? '1' : '0';
    return bits;
  })().catch(() => null);
  prints.set(post, job);
  return job;
}
const distance = (a, b) => { let n = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) n++; return n; };

/* ------------------------------------------------------------------ the feed */
export class MultiFeed {
  /** @param sources [{prov, terms}]  @param filters the filters shared by every site (each site translates them itself) */
  constructor(sources, filters) {
    this.filters = filters;
    this.srcs = sources.map(({ prov, terms }) => {
      const order = prov.sorts?.some(([v]) => v === (filters.order || '')) ? filters.order : ''; // an order this site does not have: its newest
      return { prov, feed: new Feed(prov, terms, { ...filters, order }), buf: [], done: false, err: null };
    });
    this.tags = this.srcs[0].feed.tags;
    this.done = false;
    this.busy = false;
    this.total = null;
    this.loaded = 0;
    this.pagesFetched = 0;
    this.shown = []; // what has been handed out, for matching later arrivals
    this.index = new Map(); // key -> the shown post that carries it
    this.turn = 0;
  }

  async _fill() {
    await Promise.all(this.srcs.filter((s) => !s.buf.length && !s.done).map(async (s) => {
      try {
        const got = await s.feed.next(1);
        this.pagesFetched++;
        if (got.length) s.buf.push(...got);
        else s.done = true;
      } catch (e) {
        s.err = e;
        s.done = true;
      }
    }));
  }

  _pick() {
    const live = this.srcs.filter((s) => s.buf.length);
    if (!live.length) return null;
    if (!this.filters.order) { // newest first: take the newest head
      const t = (s) => Date.parse(s.buf[0].created) || 0;
      return live.reduce((a, b) => (t(b) > t(a) ? b : a));
    }
    this.turn++;
    return live[this.turn % live.length]; // any other order is not comparable between sites: take turns
  }

  _match(post) {
    for (const k of keysOf(post)) {
      const r = this.index.get(k);
      if (r && r !== post && sameShape(r, post, 0.03)) return r;
    }
    return null;
  }

  async _lookAlike(post) {
    const cands = this.shown.filter((r) => r.provider !== post.provider && sameShape(r, post, 0.015) && artistsAgree(r, post)).slice(-40);
    if (!cands.length) return null;
    const mine = await fingerprint(post);
    if (!mine) return null;
    for (const r of cands) {
      const theirs = await fingerprint(r);
      if (theirs && distance(mine, theirs) <= 6) return r;
    }
    return null;
  }

  _register(post, as = post) {
    for (const k of keysOf(post)) if (!this.index.has(k)) this.index.set(k, as);
  }

  /** `post` is another copy of `shown`. Keep one tile: the better copy shows, the other is listed in `also`. */
  _merge(shown, post) {
    const entry = (p) => ({ provider: p.provider, id: p.id, url: p.url, w: p.w, h: p.h, name: getProvider(p.provider).name });
    const also = shown.also || [];
    if (better(post, shown)) {
      const old = entry(shown);
      Object.assign(shown, post); // the tile (already on screen) now stands for the better copy
      shown.also = [old, ...also];
    } else shown.also = [...also, entry(post)];
    this._register(post, shown);
  }

  async next(minWanted = 18) {
    if (this.done || this.busy) return [];
    this.busy = true;
    try {
      const out = [];
      for (let guard = 0; guard < 400 && out.length < minWanted; guard++) {
        await this._fill();
        const src = this._pick();
        if (!src) { this.done = true; break; }
        const post = src.buf.shift();
        const twin = this._match(post) || (await this._lookAlike(post));
        if (twin) { this._merge(twin, post); continue; }
        this._register(post);
        this.shown.push(post);
        out.push(post);
      }
      this.loaded += out.length;
      if (!out.length && this.done && this.srcs.every((s) => s.err)) throw this.srcs[0].err; // every site failed
      return out;
    } finally {
      this.busy = false;
    }
  }
}
