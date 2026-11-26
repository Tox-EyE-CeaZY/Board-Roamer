/* ==========================================================================================================================
   The Feed's engine: what gets shown next, and how politely it is fetched. The screen itself is feed.js; the long-term taste model is
   taste.js, the short-lived "today" layer on top of it is mood.js, and the art-style signal is style.js (fed by stylist.js).

   What comes up is learned on this device from what you like (your favorites / upvotes on the sites, and the hearts you tap), mixed
   with deliberate wandering, and new posts from artists you follow.

   Being kind to the sites:
   - each kind of request queues on its own ("lanes"): posts at least 1.5 s apart on e621/e926 (1.2 s elsewhere), chores slower, never
     closer than 0.7 s to each other, and never more than 120 requests to a site in five minutes;
   - one request carries as many posts as the site allows, and only goes out when the pool is running low and the Feed is on screen;
   - follow checks bundle up to 8 artists into one e621 request and re-check an artist at most every 25 minutes;
   - an error or 429 puts that site on a growing cool-down (20 s doubling to 5 min) instead of retrying.
   ========================================================================================================================== */
import { debounce, sleep, pretty } from './util.js';
import { S, on, emit, subs, tagc, kv, voted } from './store.js';
import { getProvider, Feed, compileBlacklist, blacklistHit } from './providers.js';
import { Taste, softPick, features } from './taste.js';
import { Mood } from './mood.js';
import { Style } from './style.js';
import * as stylist from './stylist.js';
import { isPhone } from './platform.js';

const GAP = { e621: 1500, e926: 1500 };
const DEF_GAP = 1200;
const BUDGET = 120; // safety ceiling: requests per five minutes per site (0.4 a second)
const EVERY = 700;
const LANE_GAP = { tags: 2500, learn: 3000, follow: 4000 };
const PAGE = 40;
/** The most each site hands out at once (e621 allows 320): fewer requests, and a deeper pool to pick from. */
const pageFor = (prov) => ({ e6: 200, db: 100, gb: 100, pm: 50 }[prov.engine] || prov.pageSize || 40);
export const SUGGEST_AT = 3; // liked this many times (favorite 1, upvote about 0.8): worth suggesting
export const POOL_LOW = 80;
const POOL_MAX = 700;
const SEEN_MAX = 3000; // shown posts remembered between sessions
const FRESH_DAYS = 8;
const FOLLOW_EVERY = 25 * 60000;
const LEARN_EVERY = 12 * 3600000;
const MIN_SCORE = { e621: 30, e926: 30, danbooru: 8, gelbooru: 6, safebooru: 2, derpibooru: 60 };
const ALL_RATINGS = { s: true, q: true, e: true };
const mode = () => S('feedMode') || 'foryou';
const trim = (set, max) => { while (set.size > max) set.delete(set.values().next().value); };
const tag = (o, key, value) => Object.defineProperty(o, key, { value, enumerable: false, writable: true, configurable: true });

/* ------------------------------------------------------------------ per-account model (shared by e621 and e926)  */
const models = new Map();
class Model {
  constructor(cred) {
    this.cred = cred;
    this.taste = new Taste(kv.get('feed:t:' + cred, null));
    this.mood = new Mood(kv.get('feed:mood:' + cred, null)); // today's lean, on top of the taste
    this.style = new Style(kv.get('feed:style:' + cred, null)); // what the pictures you like look like
    this.seen = new Set(kv.get('feed:seen:' + cred, []));
    this.likes = new Set(kv.get('feed:likes:' + cred, []));
    this.hidden = new Set(kv.get('feed:hide:' + cred, [])); // "not interested": never shown again
    this.learnInfo = kv.get('feed:learn:' + cred, {});
    this.fchk = kv.get('feed:fchk:' + cred, {});
    this.save = debounce(() => this._save(), 1500);
  }
  _save() {
    trim(this.seen, SEEN_MAX);
    trim(this.hidden, SEEN_MAX);
    kv.set('feed:t:' + this.cred, this.taste.toJSON());
    kv.set('feed:mood:' + this.cred, this.mood.toJSON());
    kv.set('feed:style:' + this.cred, this.style.toJSON());
    kv.set('feed:seen:' + this.cred, [...this.seen]);
    kv.set('feed:likes:' + this.cred, [...this.likes].slice(-8000));
    kv.set('feed:hide:' + this.cred, [...this.hidden]);
    kv.set('feed:learn:' + this.cred, this.learnInfo);
    kv.set('feed:fchk:' + this.cred, this.fchk);
  }
  reset() {
    this.taste.reset();
    this.mood.reset();
    this.style.reset();
    this.seen.clear();
    this.likes.clear();
    this.hidden.clear();
    this.learnInfo = {};
    this.save.flush();
  }
}
export const modelOf = (prov) => {
  prov = typeof prov === 'string' ? getProvider(prov) : prov;
  if (!models.has(prov.credKey)) models.set(prov.credKey, new Model(prov.credKey));
  return models.get(prov.credKey);
};
addEventListener('pagehide', () => models.forEach((m) => m.save.flush()));
addEventListener('visibilitychange', () => document.hidden && models.forEach((m) => m.save.flush()));

/* ------------------------------------------------------------------ nothing twice */
const shown = new Set(); // everything that has been on screen since the app started
/** A post's identities: its id (e621 and e926 share them) and its file, so a re-upload counts as the same picture. */
export const idsOf = (p) => {
  const k = getProvider(p.provider).credKey + ':' + p.id;
  return p.md5 ? [k, 'md5:' + p.md5] : [k];
};
export function markShown(post) {
  for (const id of idsOf(post)) shown.add(id);
  const m = modelOf(post.provider);
  if (!m.seen.has(post.id)) {
    m.seen.add(post.id);
    m.taste.learn(post, { l: 0, n: 1 });
    m.save();
  }
}
const queued = (view) => new Set(view ? view.items.flatMap((i) => idsOf(i.post)) : []);

/* ------------------------------------------------------------------ per-site state: pool of candidates, pacing, cool-down */
export const srcs = new Map();
/** The last pool of candidates is kept on the device, so opening the app shows cards at once while a fresh batch is fetched behind them. */
const poolKey = (prov) => 'feed:pool2:' + prov.id;
for (const id of ['e621', 'e926', 'danbooru', 'gelbooru', 'safebooru', 'derpibooru']) kv.del('feed:pool:' + id); // the old format
const loadPool = (prov) => {
  const list = kv.get(poolKey(prov), []);
  if (!Array.isArray(list)) return [];
  for (const p of list) tag(p, '_kind', 'explore');
  return list.filter((p) => p && p.id && p.full && p.tags);
};
const savePool = (src) => {
  src.savePool ||= debounce(() => {
    if (mode() !== 'foryou') return;
    kv.set(poolKey(src.prov), src.pool.slice(-90).map((p) => ({ ...p, desc: String(p.desc || '').slice(0, 2000) })));
  }, 4000);
  src.savePool();
};
const newSrc = (prov, pool) => ({ prov, pool, fresh: [], last: 0, reqs: [], cool: 0, fails: 0, filling: null, followBusy: false, told: false });
export const srcOf = (prov) => {
  if (!srcs.has(prov.id)) srcs.set(prov.id, newSrc(prov, loadPool(prov)));
  return srcs.get(prov.id);
};
/** Whose turn-taking a pool follows: its own, or (a second pool on the same site) the site's. */
const paceOf = (src) => src.pace || src;
/** The pool a view picks from, and the mode it picks in (the Feed follows the setting; Roam's For you has its own of both). */
const poolFor = (view, prov) => (view?.src && view.src.prov.id === prov.id ? view.src : srcOf(prov));
const modeFor = (view) => view?.mode || mode();
export const enabled = () => (S('feedSources') || []).map((id) => getProvider(id)).filter((p, i, a) => p && a.indexOf(p) === i);
export const needsKeyMissing = (prov) => prov.needsKey && !(((S('creds') || {})[prov.credKey] || {}).key);

/** Wait for this site's turn. Each kind of request queues on its own, so a chore never sits in front of the next batch of posts. */
function gate(src, lane = 'posts') {
  const gap = LANE_GAP[lane] || GAP[src.prov.id] || DEF_GAP;
  const pace = paceOf(src);
  const L = ((pace.lanes ||= {})[lane] ||= { last: 0, chain: Promise.resolve() });
  return (L.chain = L.chain.then(async () => {
    for (;;) {
      const now = Date.now();
      pace.reqs = pace.reqs.filter((t) => now - t < 300000);
      let wait = Math.max(0, L.last + gap - now, pace.last + EVERY - now);
      if (pace.reqs.length >= BUDGET) wait = Math.max(wait, pace.reqs[0] + 300000 - now);
      if (wait <= 0) break;
      await sleep(wait); // another lane may have gone meanwhile: look again
    }
    L.last = pace.last = Date.now();
    pace.reqs.push(pace.last);
  }));
}

const filtersFor = (o = {}) => ({ order: o.order || '', score: o.score || 0, ratings: o.ratings || S('filters').ratings, media: '', shape: '', age: o.age || '' });

/** One paced request. */
async function fetchPage(src, terms, { order = '', score = 0, age = '', page = null, limit = pageFor(src.prov), ratings, lane } = {}) {
  const feed = new Feed(src.prov, terms, filtersFor({ order, score, age, ratings }));
  feed.limit = limit;
  if (page != null) feed.pageNo = page;
  return pageOf(src, feed, lane);
}

/** The next page of a feed object (which remembers its own cursor), paced. Cool-down on trouble, so a struggling site is left alone. */
async function pageOf(src, feed, lane = 'posts') {
  feed.noCats = true; // no automatic tag-category lookups for a whole page (see ensureCats)
  const pace = paceOf(src);
  if (pace.cool > Date.now()) throw new Error('cooling');
  await gate(src, lane);
  if (pace.cool > Date.now()) throw new Error('cooling');
  try {
    const posts = await src.prov.page(feed);
    pace.fails = 0;
    return posts;
  } catch (e) {
    if (!e.status || e.status === 429 || e.status >= 500 || e.status === 403) {
      pace.fails++;
      pace.cool = Date.now() + Math.min(5 * 60000, 20000 * 2 ** (pace.fails - 1));
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ what may be shown */
let rulesSig = null, rules = [];
const hideRules = () => {
  const sig = (S('blacklist') || []).join('\n');
  if (sig !== rulesSig) (rulesSig = sig), (rules = compileBlacklist(S('blacklist') || []));
  return rules;
};

function learnCats(posts) {
  for (const p of posts) for (const c of Object.keys(p.tags)) if (c !== 'general' && c !== 'meta') for (const t of p.tags[c]) tagc.set(p.provider, t, { cat: c });
}

/**
 * For you never repeats something you have been shown (this session, or the last few thousand) and leaves out favorites and anything you
 * said you were not interested in. New / Hot / Following are lists: they only avoid showing a post twice in the same list.
 */
function acceptable(post, model, q, m = mode()) {
  if (!post || !post.full || post.kind === 'flash' || post.isComic) return false;
  if (!S('filters').ratings[post.rating]) return false;
  if (post.faved || model.likes.has(post.id) || model.hidden.has(post.id) || model.taste.banned(post)) return false;
  const ids = idsOf(post);
  if (ids.some((i) => q.has(i))) return false;
  if (m === 'foryou' && (model.seen.has(post.id) || ids.some((i) => shown.has(i)))) return false;
  if (S('blacklistMode') !== 'off' && blacklistHit(post, hideRules())) return false;
  return true;
}

/* ------------------------------------------------------------------ learning from the account */
const LEARN = {
  e6: (c) => (c.user ? [{ t: `fav:${c.user.replace(/ /g, '_')}`, w: 1 }, { t: `votedup:${c.user.replace(/ /g, '_')}`, w: 0.8 }] : []),
  db: (c) => (c.user ? [{ t: `ordfav:${c.user.replace(/ /g, '_')}`, w: 1 }] : []),
  pm: (c) => (c.key ? [{ t: 'my:faves', w: 1 }, { t: 'my:upvotes', w: 0.7 }] : []),
};
export const canLearn = (prov) => {
  const c = (S('creds') || {})[prov.credKey] || {};
  return !!LEARN[prov.engine]?.(c).length && (prov.engine === 'pm' ? !!c.key : !!c.user && !!c.key);
};

export const learning = new Set();
const LEARN_VERSION = 2; // 2: artists are counted too (one more read of the favorites for those learned before)
const LEARN_PAGES = 6;
/**
 * Reads favorites / upvotes into the stored weights. The full read happens once: where it got to is saved after every page, so closing
 * the app continues from there instead of starting over. Later runs only look at the newest page and add what is new.
 */
export async function learnAccount(prov, { force = false } = {}) {
  const model = modelOf(prov), src = srcOf(prov);
  if (!canLearn(prov) || learning.has(prov.credKey)) return;
  const queries = LEARN[prov.engine]((S('creds') || {})[prov.credKey] || {});
  let info = model.learnInfo;
  if (info.v !== LEARN_VERSION) info = model.learnInfo = { v: LEARN_VERSION, q: {}, base: info.base, recount: model.likes.size > 0 };
  const unfinished = queries.some((q) => !info.q[q.t]?.done);
  if (!force && !unfinished && info.ts && Date.now() - info.ts < LEARN_EVERY) return;
  learning.add(prov.credKey);
  let added = 0;
  try {
    emit('feed-learn', { running: true, cred: prov.credKey, n: 0 });
    for (const q of queries) {
      const st = (info.q[q.t] ||= { done: false, pages: 0, cursor: null, pageNo: null });
      const full = !st.done;
      const feed = new Feed(prov, [{ t: q.t, op: '+' }], filtersFor({ ratings: ALL_RATINGS }));
      feed.limit = pageFor(prov);
      if (full && st.pages) (feed.cursor = st.cursor), (feed.pageNo = st.pageNo);
      for (let i = full ? st.pages : 0; i < (full ? LEARN_PAGES : 2) && !feed.done; i++) {
        const posts = await pageOf(src, feed, 'learn');
        if (!posts.length) break;
        learnCats(posts);
        let fresh = 0;
        for (const p of posts) {
          if (model.likes.has(p.id)) {
            // learned before artists were counted: count them now, once, without learning the tags twice
            if (full && info.recount) model.taste.countArtists(p, q.w);
            continue;
          }
          model.likes.add(p.id);
          model.taste.learn(p, { l: q.w, n: 1 });
          fresh++;
          added++;
          if (!full && fresh <= 10) styleLike(p, 0.6 * q.w, stylist.SEED); // favorited elsewhere since last time
        }
        if (full) Object.assign(st, { pages: i + 1, cursor: feed.cursor, pageNo: feed.pageNo });
        model.save();
        emit('feed-learn', { running: true, cred: prov.credKey, n: added });
        if (!full && !fresh) break;
      }
      st.done = true;
    }
    info.recount = false;
    if (!info.base) await baseline(prov, model, src);
    info.base = true;
    info.ts = Date.now();
    model.save();
  } catch (e) {
    if (e.message !== 'cooling') emit('toast', { msg: `Could not read ${prov.name} favorites: ${e.message}`, kind: 'err' });
  } finally {
    learning.delete(prov.credKey);
    emit('feed-learn', { running: false, cred: prov.credKey, n: added });
  }
}

/** A sample of ordinary posts, counted as "shown, not liked", so a tag's lift has something to compare with. */
async function baseline(prov, model, src) {
  for (let i = 0; i < 2; i++) {
    const posts = await fetchPage(src, [], { ...exploreOpts(prov), ratings: ALL_RATINGS, lane: 'learn' });
    learnCats(posts);
    for (const p of posts) model.taste.learn(p, { l: 0, n: 1 });
  }
  model.save();
}

/* ------------------------------------------------------------------ art style */
export const styleOn = () => S('feedStyle') !== false;
const STYLE = 0.9; // how much looking like what you like counts, next to the tags (1.2) and today (1.4)
const SEEDS = 30; // favorites looked at once
const BACKGROUND = 24; // and ordinary posts beside them, so "particular to what you like" has something to be measured against
/** Posts picked without knowing whether you like them: only these make up the average picture (liked ones would cancel themselves out). */
const ordinary = new WeakSet();
stylist.onFingerprint((post, v) => {
  if (!ordinary.has(post)) return;
  const m = modelOf(post.provider);
  m.style.see(v);
  m.save();
});
const someOf = (list, n) => list.map((p) => [Math.random(), p]).sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]);
/** Runs `use(model, fingerprint)` for a post: at once if it was looked at already, otherwise after looking (when `look` allows it). */
function withStyle(post, look, rank, use) {
  if (!styleOn()) return;
  const m = modelOf(post.provider);
  const have = stylist.peek(post);
  const run = (v) => (use(m, v), m.save());
  if (have) run(have);
  else if (look) stylist.fingerprint(post, rank).then((v) => v && run(v));
}
/** A like (or, below zero, one taken back) tells the style profile what you go for. */
export function styleLike(post, weight, rank = stylist.NOW) {
  withStyle(post, weight > 0, rank, (m, v) => (weight > 0 ? m.style.like(v, weight) : m.style.unlike(v, -weight)));
}
/**
 * Once: looks at a sample of your favorites, so the style signal has something to go on before you like anything new. One request, and
 * thumbnails only. (Without favorites it learns from your likes and what you linger on.)
 */
export async function seedStyle(prov) {
  const model = modelOf(prov), src = srcOf(prov);
  if (!styleOn() || model.style.seeded || src.seeding || !canLearn(prov) || stylist.stats().broken) return;
  src.seeding = true;
  try {
    const q = LEARN[prov.engine]((S('creds') || {})[prov.credKey] || {})[0];
    const feed = new Feed(prov, [{ t: q.t, op: '+' }], filtersFor({ ratings: ALL_RATINGS }));
    feed.limit = 40;
    const posts = (await pageOf(src, feed, 'learn')).filter((p) => p.thumb).slice(0, SEEDS);
    for (const p of someOf(src.pool, BACKGROUND)) (ordinary.add(p), stylist.fingerprint(p, stylist.SEED));
    const got = await Promise.all(posts.map((p) => stylist.fingerprint(p, stylist.SEED).then((v) => v && (model.style.like(v, 0.5), true))));
    if (got.some(Boolean) || !posts.length) model.style.seeded = true; // otherwise: next time
    model.save();
  } catch {
    /* next time */
  } finally {
    src.seeding = false;
  }
}
/** How much each of these posts looks like your style, against the average of those looked at: the others count as average. */
function styleScores(model, posts) {
  if (!styleOn() || !model.style.known) return () => 0;
  const rate = model.style.rater(), raw = new Map();
  let sum = 0;
  for (const p of posts) {
    const v = stylist.peek(p);
    if (!v) continue;
    const x = rate(v);
    raw.set(p, x);
    sum += x;
  }
  const base = sum / (raw.size + 4);
  return (p) => (raw.has(p) ? Math.max(-1, Math.min(1.5, (raw.get(p) - base) * 2.5)) : 0);
}
/**
 * As you move on: have the model look at a few of the posts that may come up (the likeliest by tags, and one at random, so that a look
 * you like can surface something the tags would not). A few thumbnails at a time, fewer on slow devices.
 */
export function scout(view) {
  if (!styleOn() || modeFor(view) !== 'foryou') return;
  const n = stylist.quota();
  if (!n) return;
  const list = [];
  for (const prov of enabled()) {
    const model = modelOf(prov);
    if (!model.style.known) continue;
    const open = poolFor(view, prov).pool.filter((p) => !stylist.peek(p));
    const by = new Map(open.map((p) => [p, tagScore(model, p)]));
    list.push(...open.sort((a, b) => by.get(b) - by.get(a)).slice(0, Math.max(1, n - 1)));
    if (n > 1 && open.length > n) list.push(open[n - 1 + Math.floor(Math.random() * (open.length - n + 1))]);
  }
  list.forEach((p) => ordinary.add(p));
  stylist.consider(list, () => view.active());
}

/* ------------------------------------------------------------------ candidate queries */
function exploreOpts(prov, half = false) {
  const s = Math.round((MIN_SCORE[prov.id] || 10) * (half ? 0.5 : 1));
  if (!half && prov.ages && prov.engine !== 'db' && Math.random() < 0.35) return { order: 'score', score: 0, age: 'month', page: 1 + Math.floor(Math.random() * 6) }; // a wander through what was hot lately
  if (prov.engine === 'db') return { order: '', score: s, page: 1 + Math.floor(Math.random() * 200) };
  if (prov.engine === 'gb') return { order: 'random', score: s, page: Math.floor(Math.random() * 3) };
  return { order: 'random', score: s };
}

/** A search for something you like. Kept small, so one subject never floods the pool. */
function interestQuery(prov, model) {
  const t = model.taste;
  const all = t.interests(undefined, 40, (f) => tagc.get(prov.id, f)?.cat ?? null);
  if (all.length < 3) return null;
  const src = srcOf(prov);
  const used = (src.searched ||= []); // the last few subjects searched for are left alone for a while
  let list = all.filter((x) => !used.includes(x.tag));
  if (list.length < 3) list = all;
  const first = list[Math.max(0, softPick(list.slice(0, 24).map((x) => x.rank), 3.5))];
  used.push(first.tag);
  if (used.length > 10) used.shift();
  const terms = [{ t: first.tag, op: '+' }];
  if (prov.maxTags >= 3 && Math.random() < 0.3) {
    const isArt = (f) => tagc.get(prov.id, f)?.cat === 'artist';
    const pool = list.filter((x) => x.tag !== first.tag && !(isArt(first.tag) && isArt(x.tag)));
    if (pool.length) terms.push({ t: pool[Math.floor(Math.random() * Math.min(10, pool.length))].tag, op: '+' });
  }
  const o = { ...exploreOpts(prov, true), limit: Math.min(40, pageFor(prov)) };
  if (prov.engine === 'db') {
    const known = tagc.get(prov.id, first.tag)?.count;
    o.page = 1 + Math.floor(Math.random() * Math.max(1, Math.min(25, Math.ceil((known || 300) / prov.pageSize))));
  }
  return { terms: terms.slice(0, prov.maxTags), opts: o, kind: 'interest', tag: first.tag };
}

/** New and Hot read the site's own ordering page after page (a feed object remembers where it is). */
function streamFeed(src, m) {
  const prov = src.prov;
  src.streams ||= {};
  let f = src.streams[m];
  if (f && !f.done) return f;
  if (m === 'hot') {
    src.hotLevel = f ? Math.min(2, (src.hotLevel || 0) + 1) : src.hotLevel || 0;
    const ages = ['day', 'week', 'month'];
    const o = prov.engine === 'db' ? { order: 'rank' } : { order: 'score', age: prov.ages ? ages[src.hotLevel] : '' };
    f = new Feed(prov, [], filtersFor(o));
  } else f = new Feed(prov, [], filtersFor({}));
  f.limit = pageFor(prov);
  src.streams[m] = f;
  return f;
}

/** Top the pool of a site up. */
export function refill(src, view) {
  if (src.filling) return src.filling;
  const prov = src.prov, model = modelOf(prov);
  src.filling = (async () => {
    try {
      const m = modeFor(view);
      if (m === 'new' || m === 'hot') {
        let posts = await pageOf(src, streamFeed(src, m));
        learnCats(posts);
        const have = new Set(src.pool.map((p) => p.id)), q = queued(view);
        posts = posts.filter((p) => !have.has(p.id) && acceptable(p, model, q, m));
        for (const p of posts) tag(p, '_kind', m);
        src.pool.push(...posts);
        src.told = false;
        return;
      }
      const pExplore = Math.max(0.15, (S('feedExplore') || 0) / 100);
      // mostly broad batches that the taste model picks from, with a minority of targeted searches
      let plan = model.taste.ready && Math.random() > pExplore && Math.random() < 0.55 ? interestQuery(prov, model) : null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const q = plan || { terms: [], opts: exploreOpts(prov), kind: 'explore' };
        const small = !src.warmed && src.pool.length < 20; // the very first request of a session is a small one, so the first cards show quickly
        src.warmed = true;
        let posts = await fetchPage(src, q.terms, small ? { ...q.opts, limit: 40 } : q.opts);
        learnCats(posts);
        const have = new Set(src.pool.map((p) => p.id));
        const inView = queued(view);
        posts = posts.filter((p) => !have.has(p.id) && acceptable(p, model, inView, 'foryou'));
        for (const p of posts) (tag(p, '_kind', q.kind), tag(p, '_q', q.tag || ''));
        src.pool.push(...posts);
        if (src.pool.length > POOL_MAX) src.pool.splice(0, src.pool.length - POOL_MAX);
        if (!src.pace) savePool(src);
        // a targeted search is only a handful: top up with a broad batch too when the pool is thin
        if (posts.length >= 6 && (!plan || src.pool.length >= POOL_LOW)) break;
        plan = null;
      }
      src.told = false;
    } catch (e) {
      if (e.message !== 'cooling' && !src.told) {
        src.told = true;
        emit('toast', { msg: `${src.prov.name}: ${e.message}`, kind: 'err' });
      }
    } finally {
      src.filling = null;
    }
  })();
  return src.filling;
}

/** New posts from followed artists. One request covers up to eight of them on e621. */
export async function followTick(src, view) {
  const prov = src.prov, model = modelOf(prov);
  if (!S('feedFollows') && mode() !== 'follows') return;
  if (src.followBusy || paceOf(src).cool > Date.now()) return;
  const now = Date.now();
  const due = subs.all().filter((f) => f.p === prov.credKey && f.cat === 'artist' && now - (model.fchk[f.t] || 0) > FOLLOW_EVERY).sort((a, b) => (model.fchk[a.t] || 0) - (model.fchk[b.t] || 0));
  if (!due.length) return;
  src.followBusy = true;
  try {
    const batch = due.slice(0, prov.engine === 'e6' ? 8 : 1);
    const terms = batch.map((f) => ({ t: f.t, op: batch.length > 1 ? '~' : '+' }));
    const posts = await fetchPage(src, terms, { limit: PAGE, ratings: S('filters').ratings, lane: 'follow' });
    learnCats(posts);
    for (const f of batch) model.fchk[f.t] = Date.now();
    const q = queued(view);
    const lim = Date.now() - (mode() === 'follows' ? 30 : FRESH_DAYS) * 86400000;
    const names = new Set(batch.map((f) => f.t));
    const have = new Set(src.fresh.map((p) => p.id));
    for (const p of posts) {
      if (have.has(p.id) || !acceptable(p, model, q)) continue;
      if (new Date(p.created).getTime() < lim) continue;
      tag(p, '_kind', 'follow');
      tag(p, '_who', [...p.artists, ...Object.values(p.tags).flat()].find((a) => names.has(a)) || batch[0].t);
      src.fresh.push(p);
    }
    src.fresh.sort((a, b) => new Date(b.created) - new Date(a.created));
    model.save();
  } catch {
    /* the cool-down in pageOf already handled it */
  } finally {
    src.followBusy = false;
  }
}

/* ------------------------------------------------------------------ choosing the next post */
/** The line above a post. Only where it says something you could not guess; taste picks are left unlabeled. */
export function whyOf(post, kind) {
  if (kind === 'new') return 'Newest';
  if (kind === 'hot') return 'Hot right now';
  if (kind === 'follow') return `New from ${pretty(post._who || post.artists[0] || 'an artist you follow')}`;
  return '';
}

/** A gentle lean toward newer and hotter posts: a strong taste match still beats it, but between equals the fresh one wins. */
const lean = (p) => {
  const age = Math.max(0, (Date.now() - new Date(p.created).getTime()) / 86400000) || 0;
  return 0.5 * Math.exp(-age / 45) + 0.35 * Math.min(1, Math.log10(1 + Math.max(0, p.score || 0)) / 3);
};

const MOOD = 1.4; // how much today counts next to the long-term score (which is scaled by 1.2)
/** The long-term score, flattened: a favorite subject helps, it does not take over. */
const flat = (score) => Math.sign(score) * Math.sqrt(Math.abs(score));

/* ------------------------------------------------------------------ today */
/** The share of everything shown that carried this tag: how little a tag says about a mood. */
const commonness = (model) => (tag) => (model.taste.pn > 20 ? (model.taste.t[tag]?.[1] || 0) / model.taste.pn : 0);
/** A reaction to a post, -1..1. Moves today's mood only; the long-term weights are learned elsewhere. */
export function feel(post, signal) {
  const m = modelOf(post.provider);
  m.mood.feel(post, signal, commonness(m));
  m.save();
  // the same for today's art style. A picture is only looked at for a clear signal: a quick skip uses what is already known
  withStyle(post, signal >= 0.3 || signal <= -0.8, stylist.NOW, (x, v) => x.style.feel(v, signal));
}
// likes made in the viewer (from the Feed, the artist page or Roam) count for today too
on('post-like', (e) => feel(e.detail.post, e.detail.on ? (e.detail.vote ? 0.8 : 1) : -0.5));

/*
 * Probes: while today's mood is unknown, a few of the first posts are chosen to find it out, one from each of the main things you like,
 * one by an artist you like on a subject you are cooler on, and one from outside your usual. They look like any other post.
 */
function planProbes(view, prov) {
  const src = poolFor(view, prov), model = modelOf(prov), t = model.taste;
  if (!t.ready || !model.mood.fresh) return [];
  const likes = t.interests(['species', 'character', 'general', 'copyright'], 24, (f) => tagc.get(prov.id, f)?.cat ?? null);
  // separate subjects: skip a tag that mostly turns up together with one already chosen
  const having = (tag) => new Set(src.pool.filter((p) => carries(p, tag)).map((p) => p.id));
  const heads = [];
  for (const x of likes) {
    if (heads.length >= 4) break;
    const mine = having(x.tag);
    const twin = heads.some((h) => { let both = 0; for (const id of mine) if (h.ids.has(id)) both++; return both > 0.35 * Math.min(mine.size || 1, h.ids.size || 1); });
    if (!twin) heads.push({ tag: x.tag, ids: mine });
  }
  const artists = t.topArtists(2).slice(0, 6).map((a) => a.name);
  const plan = [...heads.map((h) => ({ type: 'subject', tag: h.tag })), ...(artists.length ? [{ type: 'artist', artists }] : []), { type: 'wild' }];
  if (artists.length) seedArtists(src, view, artists);
  // scattered over cards 2-11, the wildcards toward the end, so it never reads as a questionnaire
  const spots = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].sort(() => Math.random() - 0.5).slice(0, plan.length).sort((a, b) => a - b);
  return plan.map((p, i) => ({ ...p, at: spots[i] }));
}
const carries = (p, tag) => Object.values(p.tags).some((list) => list.includes(tag));
/** One small request so that the artists you like are among the candidates. */
async function seedArtists(src, view, artists) {
  const prov = src.prov, model = modelOf(prov);
  if (paceOf(src).cool > Date.now()) return;
  try {
    const some = artists.slice(0, prov.engine === 'e6' ? 5 : 1);
    const posts = await fetchPage(src, some.map((t) => ({ t, op: some.length > 1 ? '~' : '+' })), { ...(prov.engine === 'e6' ? { order: 'random' } : {}), limit: 40, lane: 'follow' });
    learnCats(posts);
    const have = new Set(src.pool.map((p) => p.id)), q = queued(view);
    for (const p of posts.filter((x) => !have.has(x.id) && acceptable(x, model, q, 'foryou'))) (tag(p, '_kind', 'explore'), src.pool.push(p));
  } catch {
    /* the probes make do with what is in the pool */
  }
}
/** Take the post that answers this probe best, or nothing if the pool holds none. */
function takeProbe(view, prov, probe) {
  const src = poolFor(view, prov), model = modelOf(prov), t = model.taste;
  const q = queued(view);
  const open = src.pool.filter((p) => acceptable(p, model, q, 'foryou'));
  const seenArtists = new Set(view.items.slice(-8).flatMap((x) => x.post.artists));
  const fresh = (p) => !p.artists.some((a) => seenArtists.has(a));
  let from, score;
  if (probe.type === 'subject') {
    from = open.filter((p) => carries(p, probe.tag) && fresh(p));
    score = (p) => flat(t.rate(p).score) + lean(p);
  } else if (probe.type === 'artist') {
    const loved = open.filter((p) => p.artists.some((a) => probe.artists.includes(a)) && fresh(p));
    const offTaste = loved.filter((p) => Object.values(p.tags).flat().some((x) => t.r[x] === -1 || t.lift(x) < -0.25));
    from = offTaste.length ? offTaste : loved;
    score = lean;
  } else {
    from = open.filter(fresh);
    score = (p) => t.rate(p).novelty * 1.5 + lean(p);
  }
  if (!from.length) return null;
  const post = from[softPick(from.map((p) => score(p) + Math.random() * 0.4), 0.4)];
  src.pool.splice(src.pool.indexOf(post), 1);
  return post;
}
function nextProbe(view, list) {
  view.probes ||= {};
  for (const prov of list) {
    const plan = (view.probes[prov.id] ||= poolFor(view, prov).pool.length >= 20 ? planProbes(view, prov) : null);
    if (!plan) continue;
    const probe = plan.find((p) => p.at === view.items.length);
    if (!probe) continue;
    plan.splice(plan.indexOf(probe), 1);
    const post = takeProbe(view, prov, probe);
    if (post) return { post, kind: 'probe' };
  }
  return null;
}

/** What the tags, today and freshness say about a candidate. */
const tagScore = (model, p) => flat(model.taste.rate(p).score) * 1.2 + model.mood.score(p) * MOOD + lean(p);

/** The posts most likely to come next (not taken): their pictures are worth downloading early. */
export function likely(view, count) {
  const out = [];
  for (const prov of enabled()) {
    const model = modelOf(prov), pool = poolFor(view, prov).pool, look = styleScores(model, pool);
    out.push(...pool.map((p) => [tagScore(model, p) + look(p) * STYLE, p]));
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, count).map((x) => x[1]);
}
/** Give back posts that were lined up but never reached, so they can be picked again with today's mood as it is now. */
export function putBack(view, posts) {
  for (const p of posts) poolFor(view, getProvider(p.provider)).pool.push(p);
}

/** The few tags the taste model is leaning on for a post. */
const pull = (p, t) => features(p).filter(([, , c]) => c !== 'meta' && c !== 'kind').map(([f, w]) => [f, t.lift(f) * w]).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f]) => f);

/**
 * How much a post repeats what was just shown: the same artist, the same characters, the same tags doing the pulling, or the same search
 * that fetched it. Taken off its score, so a strong taste still comes through but never in a visible run.
 */
function sameness(view, model) {
  const recent = view.items.slice(-16).map((x) => x.post);
  const artists = new Map(), heavy = new Map(), chars = new Map(), searches = new Map();
  const bump = (m, k, v = 1) => k && m.set(k, (m.get(k) || 0) + v);
  recent.forEach((p, i) => {
    const near = i >= recent.length - 5 ? 2 : 1; // the last few count double
    for (const a of p.artists) bump(artists, a, near);
    for (const f of pull(p, model.taste)) bump(heavy, f, near);
    for (const c of p.tags.character) bump(chars, c);
    if (i >= recent.length - 10) bump(searches, p._q);
  });
  return (p) => {
    let pen = 0;
    for (const a of p.artists) pen += Math.min(3, artists.get(a) || 0) * 0.8;
    for (const f of pull(p, model.taste)) pen += Math.min(5, Math.max(0, (heavy.get(f) || 0) - 1)) * 0.13;
    for (const c of p.tags.character) pen += Math.min(3, chars.get(c) || 0) * 0.2;
    if (p._q) pen += Math.min(3, searches.get(p._q) || 0) * 0.6;
    return pen;
  };
}

function takeFrom(src, view, explore) {
  const model = modelOf(src.prov);
  const q = queued(view);
  const m = modeFor(view);
  src.pool = src.pool.filter((p) => acceptable(p, model, q, m));
  if (!src.pool.length) return null;
  if (m !== 'foryou') return src.pool.shift(); // New / Hot: the site's own order
  let idx;
  model.mood.fade();
  model.style.fade();
  const look = styleScores(model, src.pool);
  if (!model.taste.ready) idx = softPick(src.pool.map((p) => lean(p) + model.mood.score(p) * MOOD + look(p) * STYLE + Math.random() * 0.4), 0.5);
  else {
    const dull = sameness(view, model);
    const scores = src.pool.map((p) => {
      const r = model.taste.rate(p);
      const liking = flat(r.score);
      // exploring leans on style more than on known tags: new subjects, drawn in ways you like
      if (explore) return r.novelty * 1.2 + Math.max(-1, Math.min(0.6, liking)) * 0.3 + lean(p) * 0.6 + model.mood.score(p) * 0.3 + look(p) * STYLE * 0.7 + Math.random() * 0.5 - dull(p) * 0.5;
      return liking * 1.2 + model.mood.score(p) * MOOD + look(p) * STYLE + lean(p) + Math.random() * 0.6 - dull(p);
    });
    idx = softPick(scores, explore ? 0.5 : 0.75);
  }
  const [post] = src.pool.splice(idx, 1);
  return post;
}

/** The next post for the view: now and then one fresh from a follow, otherwise taste or a deliberate wander. */
export async function nextPost(view) {
  const list = (view.sites || enabled()).filter((p) => !needsKeyMissing(p));
  if (!list.length) return null;
  const m = modeFor(view);
  const fresh = () => {
    const q = queued(view);
    for (const p of list) poolFor(view, p).fresh = poolFor(view, p).fresh.filter((x) => acceptable(x, modelOf(p), q, m));
    return list.flatMap((p) => poolFor(view, p).fresh).sort((a, b) => new Date(b.created) - new Date(a.created));
  };
  const useFresh = (post) => {
    list.forEach((p) => (poolFor(view, p).fresh = poolFor(view, p).fresh.filter((x) => x !== post)));
    return { post, kind: 'follow' };
  };
  if (m === 'follows') {
    const all = fresh();
    return all.length ? useFresh(all[0]) : null;
  }
  if (m === 'foryou') {
    const probe = nextProbe(view, list);
    if (probe) return probe;
  }
  // about one card in five, never two close together, and not always strictly the newest
  if (m === 'foryou' && S('feedFollows') && view.items.length && !view.items.slice(-2).some((x) => x.kind === 'follow') && Math.random() < 0.28) {
    const all = fresh();
    if (all.length) return useFresh(all[Math.floor(Math.random() * Math.min(5, all.length))]);
  }
  for (let round = 0; round < 3; round++) {
    for (let k = 0; k < list.length; k++) {
      const prov = list[(view.rr++) % list.length], src = poolFor(view, prov);
      const explore = m === 'foryou' && Math.random() < (S('feedExplore') || 0) / 100;
      let post = takeFrom(src, view, explore);
      if (src.pool.length < POOL_LOW && !src.filling && view.active()) refill(src, view); // in the background
      if (!post && paceOf(src).cool <= Date.now()) {
        await refill(src, view);
        post = takeFrom(src, view, explore);
      }
      if (post) return { post, kind: explore && modelOf(prov).taste.ready ? 'explore' : post._kind || 'interest' };
    }
  }
  // nothing new anywhere: forget the oldest half of what was seen in earlier sessions (this session's posts still never repeat)
  if (m === 'foryou') for (const p of list) trim(modelOf(p).seen, Math.floor(modelOf(p).seen.size / 2));
  return null;
}

/* ------------------------------------------------------------------ For you, in Roam */
/**
 * The Feed's suggestions as a page-by-page source for the Roam grid (same shape as a search feed). It has its own pool, shares the
 * site's pacing, and what it hands out does not come up again in the Feed this session. Showing a grid teaches nothing.
 */
export class SuggestFeed {
  constructor(prov) {
    this.prov = prov;
    this.done = false;
    this.busy = false;
    this.total = null;
    this.tags = [];
    const main = srcOf(prov);
    const src = Object.assign(newSrc(prov, []), { pace: main, warmed: true });
    this.view = { items: [], rr: 0, mode: 'foryou', sites: [prov], src, active: () => true };
  }
  async next(count = 30) {
    if (this.busy || this.done) return [];
    this.busy = true;
    try {
      if (needsKeyMissing(this.prov)) throw new Error(`${this.prov.name} needs an API key: add it in Settings.`);
      if (!this.started) {
        this.started = true;
        if (S('feedLearn') && canLearn(this.prov)) learnAccount(this.prov); // in the background, for next time if not this one
        followTick(this.view.src, this.view);
      }
      const out = [];
      while (out.length < count) {
        const got = await nextPost(this.view);
        if (!got) break;
        this.view.items.push(got);
        for (const id of idsOf(got.post)) shown.add(id);
        out.push(got.post);
      }
      if (!out.length) {
        if (paceOf(this.view.src).cool > Date.now()) throw new Error('The site asked us to slow down. Try again in a moment.');
        this.done = true;
      }
      return out;
    } finally {
      this.busy = false;
    }
  }
}

/* ------------------------------------------------------------------ what you said about a post */
export const isLiked = (p) => modelOf(p.provider).likes.has(p.id) || !!p.faved;
export const isUp = (p) => voted.has(p) || p.myVote > 0;
export const isDown = (p) => p.myVote < 0;
/** Teaches the Feed without telling the site anything. */
export function notInterested(post) {
  feel(post, -1);
  const m = modelOf(post.provider);
  m.hidden.add(post.id);
  m.taste.learn(post, { n: 2.5, post_n: 0.5 });
  m.taste.countArtists(post, -1);
  m.save();
}

/* ------------------------------------------------------------------ artists worth following */
/** Artists whose work keeps getting liked, not followed and not dismissed. */
export function suggestions() {
  const out = [], dismissed = new Set(kv.get('feed:nofollow', []));
  for (const prov of enabled()) {
    for (const a of modelOf(prov).taste.topArtists(SUGGEST_AT)) {
      const key = prov.credKey + ':' + a.name;
      if (!dismissed.has(key) && !subs.find(prov.credKey, a.name) && !out.some((o) => o.key === key)) out.push({ key, prov, ...a });
    }
  }
  return out.sort((x, y) => y.v - x.v).slice(0, 12);
}
export const dismissSuggestion = (key) => kv.set('feed:nofollow', [...kv.get('feed:nofollow', []), key].slice(-300));

/* ------------------------------------------------------------------ what a card needs */
/** The few tags that weigh most for this post: what the person likes first, then the telling ones (characters, species). */
export function heaviestTags(post, limit = 5) {
  const t = modelOf(post.provider).taste, fs = features(post).filter(([, , cat]) => cat !== 'meta' && cat !== 'kind' && cat !== 'artist');
  const base = { character: 0.5, species: 0.4, copyright: 0.2, general: 0, lore: -0.2 };
  return fs.map(([f, w, cat]) => ({ f, v: (t.ready ? t.lift(f) * w : 0) + (base[cat] ?? 0) + (t.t[f] ? 0.1 : 0) })).sort((a, b) => b.v - a.v).slice(0, limit).map((x) => x.f);
}

/** Posts that came without tag categories (older data, Gelbooru): look up the ones about to be seen, one paced request. */
const unknownTags = (prov, posts) => new Set(posts.flatMap((p) => p.tags.general).filter((t) => !tagc.get(prov.id, t)));
export async function ensureCats(posts) {
  const first = posts[0];
  if (!first) return false;
  const prov = getProvider(first.provider);
  if (!prov.resolveCats) return false;
  const need = posts.filter((p) => p.flat !== false && p.provider === prov.id && p.tags.general.some((t) => !tagc.get(prov.id, t)));
  if (!need.length || !(need.includes(first) || unknownTags(prov, need).size >= 70)) return false;
  if (srcOf(prov).reqs.length > BUDGET * 0.7) return false; // short on budget: posts come first
  try {
    await gate(srcOf(prov), 'tags');
    const asked = [...unknownTags(prov, need)].slice(0, prov.engine === 'gb' ? 60 : 100); // the same ones resolveCats will send
    await prov.resolveCats(need, 1);
    // a few tags never come back (renamed, empty): once the answer arrived, stop asking about them
    if (asked.some((t) => tagc.get(prov.id, t))) for (const t of asked) if (!tagc.get(prov.id, t)) tagc.set(prov.id, t, { cat: 'general' });
  } catch {
    /* categories are a nicety: carry on without */
  }
  return true;
}

export const mediaSrc = (p) => {
  if (p.kind === 'video') {
    const alts = (p.alts || []).filter((a) => a.url);
    // phones take the smallest re-encode, computers 720p
    const pick = isPhone() ? [...alts].sort((a, b) => (a.size || 1e12) - (b.size || 1e12))[0] : alts.find((a) => /720/.test(a.label)) || alts[0];
    return pick?.url || p.full;
  }
  if (p.kind === 'anim') return p.full;
  return (isPhone() ? p.sampleSmall || p.sample || p.full : p.full || p.sample) || p.thumb;
};
export const smallVideo = (p) => !!p && (p.alts || []).some((a) => a.url === mediaSrc(p) && a.size && a.size < 8e6);

/** Forget candidate posts: all of them, or only those of sites that are switched off. */
export function dropPools({ all = false } = {}) {
  const keep = new Set(enabled().map((p) => p.id));
  for (const s of srcs.values()) if (all || !keep.has(s.prov.id)) (s.pool = []), (s.fresh = []), (s.streams = null), (s.hotLevel = 0);
}
