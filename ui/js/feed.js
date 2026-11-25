import { h, pretty, fmtNum, debounce, sleep } from './util.js';
import { icon } from './icons.js';
import { S, setS, on, emit, subs, tagc, kv, postKey, voted } from './store.js';
import { getProvider, providerList, Feed, compileBlacklist, blacklistHit, isBlurred, CATS, CAT_LABEL } from './providers.js';
import { Taste, softPick, features } from './taste.js';
import { toast, popover, closePopover, confirmDlg } from './ui.js';
import { quickPin } from './pins.js';
import { haptic, isPhone } from './platform.js';

/* ==========================================================================================================================
   The Feed: one post at a time, full screen, swipe for the next. What comes up is learned on this device from what you like
   (your favorites / upvotes on the sites, and the hearts you tap here), mixed with some deliberate wandering, and new posts
   from artists you follow jump the queue.

   Being kind to the sites:
   - one request at a time per site, at least 2.4 s apart (1.8 s for the others) and at most 20 per five minutes;
   - a request fetches 40 posts, which is minutes of swiping, and only goes out when the pool is running low and the Feed is on screen;
   - follow checks bundle up to 8 artists into one e621 request and re-check an artist at most every 25 minutes;
   - an error or 429 puts that site on a growing cool-down (1, 2, 4... up to 15 minutes) instead of retrying;
   - pictures come from the sites' CDN, loaded only for the card on screen and the next two.
   ========================================================================================================================== */

const GAP = { e621: 2400, e926: 2400 };
const DEF_GAP = 1800;
const BUDGET = 20; // requests per five minutes per site
const PAGE = 40;
/** Posts per request: bigger pages mean fewer requests, and a deeper pool to swipe through. */
const pageFor = (prov) => (prov.engine === 'e6' ? 75 : Math.min(prov.pageSize || 40, 60));
const POOL_LOW = 45; // top the pool up long before it runs out
const POOL_MAX = 260;
const FRESH_DAYS = 8;
const FOLLOW_EVERY = 25 * 60000;
const LEARN_EVERY = 12 * 3600000;
const MIN_SCORE = { e621: 30, e926: 30, danbooru: 8, gelbooru: 6, safebooru: 2, derpibooru: 60 };
const ALL_RATINGS = { s: true, q: true, e: true };

/* ------------------------------------------------------------------ per-account model (shared by e621 and e926)  */
const models = new Map();
class Model {
  constructor(cred) {
    this.cred = cred;
    this.taste = new Taste(kv.get('feed:t:' + cred, null));
    this.seen = new Set(kv.get('feed:seen:' + cred, []));
    this.seenMax = 400;
    this.likes = new Set(kv.get('feed:likes:' + cred, []));
    this.learnInfo = kv.get('feed:learn:' + cred, {});
    this.fchk = kv.get('feed:fchk:' + cred, {});
    this.save = debounce(() => this._save(), 1500);
  }
  _save() {
    kv.set('feed:t:' + this.cred, this.taste.toJSON());
    kv.set('feed:seen:' + this.cred, [...this.seen].slice(-400));
    kv.set('feed:likes:' + this.cred, [...this.likes].slice(-8000));
    kv.set('feed:learn:' + this.cred, this.learnInfo);
    kv.set('feed:fchk:' + this.cred, this.fchk);
  }
  reset() {
    this.taste.reset();
    this.seen.clear();
    this.likes.clear();
    this.learnInfo = {};
    this.save.flush();
  }
}
const modelOf = (prov) => {
  prov = typeof prov === 'string' ? getProvider(prov) : prov;
  if (!models.has(prov.credKey)) models.set(prov.credKey, new Model(prov.credKey));
  return models.get(prov.credKey);
};
addEventListener('pagehide', () => models.forEach((m) => m.save.flush()));
addEventListener('visibilitychange', () => document.hidden && models.forEach((m) => m.save.flush()));

/* ------------------------------------------------------------------ per-site state: pool of candidates, pacing, cool-down */
const srcs = new Map();
const srcOf = (prov) => {
  if (!srcs.has(prov.id)) srcs.set(prov.id, { prov, pool: [], fresh: [], last: 0, reqs: [], chain: Promise.resolve(), cool: 0, fails: 0, filling: null, followBusy: false, told: false });
  return srcs.get(prov.id);
};

function gate(src) {
  const gap = GAP[src.prov.id] || DEF_GAP;
  return (src.chain = src.chain.then(async () => {
    const now = Date.now();
    src.reqs = src.reqs.filter((t) => now - t < 300000);
    let wait = Math.max(0, src.last + gap - now);
    if (src.reqs.length >= BUDGET) wait = Math.max(wait, src.reqs[0] + 300000 - now);
    if (wait) await sleep(wait);
    src.last = Date.now();
    src.reqs.push(src.last);
  }));
}

const filtersFor = (o = {}) => ({ order: o.order || '', score: o.score || 0, ratings: o.ratings || S('filters').ratings, media: '', shape: '', age: o.age || '' });
const trim = (set, max) => { while (set.size > max) set.delete(set.values().next().value); };

/** One paced request. Cool-down on trouble, so a struggling site is left alone. */
async function fetchPage(src, terms, { order = '', score = 0, age = '', page = null, limit = pageFor(src.prov), ratings } = {}) {
  const feed = new Feed(src.prov, terms, filtersFor({ order, score, age, ratings }));
  feed.limit = limit;
  if (page != null) feed.pageNo = page;
  return pageOf(src, feed);
}

/** The next page of a feed object (which remembers its own cursor), paced. */
async function pageOf(src, feed) {
  feed.noCats = true; // no automatic tag-category lookups for a whole page (see ensureCats)
  if (src.cool > Date.now()) throw new Error('cooling');
  await gate(src);
  if (src.cool > Date.now()) throw new Error('cooling');
  const prov = src.prov;
  try {
    const posts = await prov.page(feed);
    src.fails = 0;
    return posts;
  } catch (e) {
    if (!e.status || e.status === 429 || e.status >= 500 || e.status === 403) {
      src.fails++;
      src.cool = Date.now() + Math.min(5 * 60000, 20000 * 2 ** (src.fails - 1));
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

/** Repeats are fine, so "seen" only keeps the most recent few hundred out of For you; New and Hot ignore it. */
function acceptable(post, model, queued, mode = S('feedMode') || 'foryou') {
  if (!post || !post.full || post.kind === 'flash' || post.isComic) return false;
  if (!S('filters').ratings[post.rating]) return false;
  if (queued.has(postKey(post)) || (mode === 'foryou' && model.seen.has(post.id))) return false;
  if (S('blacklistMode') !== 'off' && blacklistHit(post, hideRules())) return false;
  return true;
}

/* ------------------------------------------------------------------ learning from the account */
const LEARN = {
  e6: (c) => (c.user ? [{ t: `fav:${c.user.replace(/ /g, '_')}`, w: 1 }, { t: `votedup:${c.user.replace(/ /g, '_')}`, w: 0.8 }] : []),
  db: (c) => (c.user ? [{ t: `ordfav:${c.user.replace(/ /g, '_')}`, w: 1 }] : []),
  pm: (c) => (c.key ? [{ t: 'my:faves', w: 1 }, { t: 'my:upvotes', w: 0.7 }] : []),
};
const canLearn = (prov) => {
  const c = (S('creds') || {})[prov.credKey] || {};
  return !!LEARN[prov.engine]?.(c).length && (prov.engine === 'pm' ? !!c.key : !!c.user && !!c.key);
};

const learning = new Set();
async function learnAccount(prov, { force = false } = {}) {
  const model = modelOf(prov), src = srcOf(prov);
  if (!canLearn(prov) || learning.has(prov.credKey)) return;
  const info = model.learnInfo;
  if (!force && info.ts && Date.now() - info.ts < LEARN_EVERY) return;
  learning.add(prov.credKey);
  const first = !info.ts || force;
  const c = (S('creds') || {})[prov.credKey] || {};
  let added = 0;
  try {
    emit('feed-learn', { running: true, cred: prov.credKey, n: 0 });
    for (const q of LEARN[prov.engine](c)) {
      const pages = first ? 6 : 2;
      const feed = new Feed(prov, [{ t: q.t, op: '+' }], filtersFor({ ratings: ALL_RATINGS }));
      feed.limit = prov.engine === 'e6' ? 75 : PAGE;
      for (let i = 0; i < pages && !feed.done; i++) {
        const posts = await pageOf(src, feed);
        if (!posts.length) break;
        learnCats(posts);
        let fresh = 0;
        for (const p of posts) {
          if (model.likes.has(p.id)) continue;
          model.likes.add(p.id);
          model.taste.learn(p, { l: q.w, n: 1 });
          fresh++;
          added++;
        }
        model.save();
        emit('feed-learn', { running: true, cred: prov.credKey, n: added });
        if (!first && !fresh) break;
      }
    }
    if (first || !info.base) await baseline(prov, model, src);
    info.ts = Date.now();
    info.base = true;
    model.save();
  } catch (e) {
    if (e.message !== 'cooling') emit('toast', { msg: `Could not read ${prov.name} favorites: ${e.message}`, kind: 'err' });
  } finally {
    learning.delete(prov.credKey);
    emit('feed-learn', { running: false, cred: prov.credKey, n: added });
  }
}

/** A sample of ordinary posts from the same pool the Feed draws on, counted as "shown, not liked", so a tag's lift has something to compare with. */
async function baseline(prov, model, src) {
  for (let i = 0; i < 2; i++) {
    const posts = await fetchPage(src, [], { ...exploreOpts(prov), ratings: ALL_RATINGS });
    learnCats(posts);
    for (const p of posts) model.taste.learn(p, { l: 0, n: 1 });
  }
  model.save();
}

/* ------------------------------------------------------------------ candidate queries */
function exploreOpts(prov, half = false) {
  const s = Math.round((MIN_SCORE[prov.id] || 10) * (half ? 0.5 : 1));
  if (!half && prov.ages && prov.engine !== 'db' && Math.random() < 0.35) return { order: 'score', score: 0, age: 'month', page: 1 + Math.floor(Math.random() * 6) }; // a wander through what was hot lately
  if (prov.engine === 'db') return { order: '', score: s, page: 1 + Math.floor(Math.random() * 200) };
  if (prov.engine === 'gb') return { order: 'random', score: s, page: Math.floor(Math.random() * 3) };
  return { order: 'random', score: s };
}

function interestQuery(prov, model) {
  const t = model.taste;
  const list = t.interests(undefined, 24, (f) => tagc.get(prov.id, f)?.cat ?? null);
  if (list.length < 3) return null;
  const first = list[Math.max(0, softPick(list.slice(0, 14).map((x) => x.rank), 1.6))];
  const terms = [{ t: first.tag, op: '+' }];
  if (prov.maxTags >= 3 && Math.random() < 0.4) {
    const isArt = (f) => tagc.get(prov.id, f)?.cat === 'artist';
    const pool = list.filter((x) => x.tag !== first.tag && !(isArt(first.tag) && isArt(x.tag)));
    if (pool.length) terms.push({ t: pool[Math.floor(Math.random() * Math.min(10, pool.length))].tag, op: '+' });
  }
  const o = exploreOpts(prov, true);
  if (prov.engine === 'db') {
    const known = tagc.get(prov.id, first.tag)?.count;
    o.page = 1 + Math.floor(Math.random() * Math.max(1, Math.min(25, Math.ceil((known || 300) / prov.pageSize))));
  }
  return { terms: terms.slice(0, prov.maxTags), opts: o, kind: 'interest', tag: first.tag };
}

function queued(view) {
  return view ? new Set(view.items.map((i) => postKey(i.post))) : new Set();
}

/** New and Hot read the site's own ordering page after page (a feed object remembers where it is). */
function streamFeed(src, mode) {
  const prov = src.prov;
  src.streams ||= {};
  let f = src.streams[mode];
  if (f && !f.done) return f;
  if (mode === 'hot') {
    src.hotLevel = f ? Math.min(2, (src.hotLevel || 0) + 1) : src.hotLevel || 0;
    const ages = ['day', 'week', 'month'];
    const o = prov.engine === 'db' ? { order: 'rank' } : { order: 'score', age: prov.ages ? ages[src.hotLevel] : '' };
    f = new Feed(prov, [], filtersFor(o));
  } else f = new Feed(prov, [], filtersFor({}));
  f.limit = pageFor(prov);
  src.streams[mode] = f;
  return f;
}

/** Top the pool of a site up with one request. */
function refill(src, view) {
  if (src.filling) return src.filling;
  const prov = src.prov, model = modelOf(prov);
  src.filling = (async () => {
    try {
      const mode = S('feedMode') || 'foryou';
      if (mode === 'new' || mode === 'hot') {
        let posts = await pageOf(src, streamFeed(src, mode));
        learnCats(posts);
        const have = new Set(src.pool.map((p) => p.id)), q2 = queued(view);
        posts = posts.filter((p) => !have.has(p.id) && acceptable(p, model, q2, mode));
        for (const p of posts) Object.defineProperty(p, '_kind', { value: mode, enumerable: false, writable: true, configurable: true });
        src.pool.push(...posts);
        src.told = false;
        return;
      }
      const pExplore = Math.max(0.15, (S('feedExplore') || 0) / 100);
      let plan = null;
      if (model.taste.ready && Math.random() > pExplore) plan = interestQuery(prov, model);
      for (let attempt = 0; attempt < 2; attempt++) {
        const q = plan || { terms: [], opts: exploreOpts(prov), kind: 'explore' };
        let posts = await fetchPage(src, q.terms, q.opts);
        learnCats(posts);
        const have = new Set(src.pool.map((p) => p.id));
        const q2 = queued(view);
        posts = posts.filter((p) => !have.has(p.id) && acceptable(p, model, q2));
        for (const p of posts) Object.defineProperty(p, '_kind', { value: q.kind, enumerable: false, writable: true, configurable: true });
        src.pool.push(...posts);
        if (src.pool.length > POOL_MAX) src.pool.splice(0, src.pool.length - POOL_MAX);
        if (posts.length >= 6) break;
        plan = null; // a thin answer (a rare tag pair, a blacklist that ate the page): try a plain wander next
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
async function followTick(src, view) {
  const prov = src.prov, model = modelOf(prov);
  if (!S('feedFollows') || src.followBusy || src.cool > Date.now()) return;
  const now = Date.now();
  const due = subs.all().filter((f) => f.p === prov.credKey && f.cat === 'artist' && now - (model.fchk[f.t] || 0) > FOLLOW_EVERY).sort((a, b) => (model.fchk[a.t] || 0) - (model.fchk[b.t] || 0));
  if (!due.length) return;
  src.followBusy = true;
  try {
    const batch = due.slice(0, prov.engine === 'e6' ? 8 : 1);
    const terms = batch.map((f) => ({ t: f.t, op: batch.length > 1 ? '~' : '+' }));
    const posts = await fetchPage(src, terms, { limit: PAGE, ratings: S('filters').ratings });
    learnCats(posts);
    for (const f of batch) model.fchk[f.t] = Date.now();
    const q = queued(view);
    const lim = Date.now() - (S('feedMode') === 'follows' ? 30 : FRESH_DAYS) * 86400000;
    const names = new Set(batch.map((f) => f.t));
    const have = new Set(src.fresh.map((p) => p.id));
    for (const p of posts) {
      if (have.has(p.id) || !acceptable(p, model, q)) continue;
      if (new Date(p.created).getTime() < lim) continue;
      Object.defineProperty(p, '_kind', { value: 'follow', enumerable: false, writable: true, configurable: true });
      Object.defineProperty(p, '_who', { value: [...p.artists, ...Object.values(p.tags).flat()].find((a) => names.has(a)) || batch[0].t, enumerable: false, writable: true, configurable: true });
      src.fresh.push(p);
    }
    src.fresh.sort((a, b) => new Date(b.created) - new Date(a.created));
    model.save();
  } catch {
    /* the cool-down in fetchPage already handled it */
  } finally {
    src.followBusy = false;
  }
}

/* ------------------------------------------------------------------ choosing the next post */
const enabled = () => (S('feedSources') || []).map((id) => getProvider(id)).filter((p, i, a) => p && a.indexOf(p) === i);
const needsKeyMissing = (prov) => prov.needsKey && !(((S('creds') || {})[prov.credKey] || {}).key);

function whyOf(post, model, kind) {
  if (kind === 'new') return 'Newest';
  if (kind === 'hot') return 'Hot right now';
  if (kind === 'follow') return `New from ${pretty(post._who || post.artists[0] || 'an artist you follow')}`;
  const r = model.taste.rate(post);
  if (kind !== 'explore' && model.taste.ready && r.why && model.taste.lift(r.why.f) > 0.8) {
    const t = pretty(r.why.f);
    return r.why.cat === 'artist' ? `You like art by ${t}` : `You like ${t}`;
  }
  return model.taste.ready ? 'Something different' : 'Popular, to get to know you';
}

/** A gentle lean toward newer and hotter posts: a strong taste match still beats it, but between equals the fresh one wins. */
const lean = (p) => {
  const age = Math.max(0, (Date.now() - new Date(p.created).getTime()) / 86400000) || 0;
  return 0.5 * Math.exp(-age / 45) + 0.35 * Math.min(1, Math.log10(1 + Math.max(0, p.score || 0)) / 3);
};

function takeFrom(src, view, explore) {
  const model = modelOf(src.prov);
  const q = queued(view);
  const mode = S('feedMode') || 'foryou';
  src.pool = src.pool.filter((p) => acceptable(p, model, q, mode));
  if (!src.pool.length) return null;
  if (mode !== 'foryou') return src.pool.shift(); // New / Hot: the site's own order
  let idx;
  if (!model.taste.ready) idx = softPick(src.pool.map(lean), 0.5);
  else {
    const rated = src.pool.map((p) => ({ p, ...model.taste.rate(p) }));
    if (explore) {
      // off the beaten path, but not off a cliff: unfamiliar posts that are at least not disliked
      const sc = rated.map((r) => r.novelty * 1.4 + Math.min(1, r.score) * 0.3 + (r.p._kind === 'explore' ? 0.3 : 0) + lean(r.p) * 0.6);
      idx = softPick(sc, 0.35);
    } else idx = softPick(rated.map((r) => r.score + lean(r.p)), 0.55);
  }
  const [post] = src.pool.splice(idx, 1);
  return post;
}

/** The few tags that weigh most for this post: what the person likes first, then the telling ones (characters, species). */
function heaviestTags(post, model, limit = 5) {
  const t = model.taste, fs = features(post).filter(([f, , cat]) => cat !== 'meta' && cat !== 'kind' && cat !== 'artist');
  const base = { character: 0.5, species: 0.4, copyright: 0.2, general: 0, lore: -0.2 };
  return fs.map(([f, w, cat]) => ({ f, v: (t.ready ? t.lift(f) * w : 0) + (base[cat] ?? 0) + (t.t[f] ? 0.1 : 0) })).sort((a, b) => b.v - a.v).slice(0, limit).map((x) => x.f);
}

/** e621 sends tags flat: look up the categories of what is about to be shown (the cache makes this rarer and rarer), so artists and weights are right. */
async function ensureCats(posts) {
  const first = posts[0];
  if (!first) return;
  const prov = getProvider(first.provider);
  const need = posts.filter((p) => p.tags.general.some((t) => !tagc.get(prov.id, t)));
  if (!prov.resolveCats || !need.length) return;
  try {
    await gate(srcOf(prov));
    await prov.resolveCats(need, 1); // one request covers about four posts, and the cache makes it rarer and rarer
  } catch {
    /* categories are a nicety: carry on without */
  }
}

/** Take the next post for the view: a follow's new post every third card, otherwise taste or a deliberate wander. */
async function nextPost(view) {
  const list = enabled().filter((p) => !needsKeyMissing(p));
  if (!list.length) return null;
  const q = queued(view);
  const mode = S('feedMode') || 'foryou';
  if (mode === 'follows') {
    for (const p of list) srcOf(p).fresh = srcOf(p).fresh.filter((x) => acceptable(x, modelOf(p), q, mode));
    const all = list.flatMap((p) => srcOf(p).fresh).sort((a, b) => new Date(b.created) - new Date(a.created));
    if (!all.length) return null;
    list.forEach((p) => (srcOf(p).fresh = srcOf(p).fresh.filter((x) => x !== all[0])));
    return { post: all[0], kind: 'follow' };
  }
  if (mode === 'foryou' && S('feedFollows') && view.picks % 3 === 1) {
    for (const p of list) {
      const src = srcOf(p), m = modelOf(p);
      src.fresh = src.fresh.filter((x) => acceptable(x, m, q));
    }
    const all = list.flatMap((p) => srcOf(p).fresh);
    if (all.length) {
      all.sort((a, b) => new Date(b.created) - new Date(a.created));
      const post = all[0];
      list.forEach((p) => (srcOf(p).fresh = srcOf(p).fresh.filter((x) => x !== post)));
      return { post, kind: 'follow' };
    }
  }
  for (let round = 0; round < 3; round++) {
    for (let k = 0; k < list.length; k++) {
      const prov = list[(view.rr++) % list.length], src = srcOf(prov);
      const explore = mode === 'foryou' && Math.random() < (S('feedExplore') || 0) / 100;
      let post = takeFrom(src, view, explore);
      if (src.pool.length < POOL_LOW && !src.filling && view.active()) refill(src, view); // in the background
      if (!post && src.cool <= Date.now()) {
        await refill(src, view);
        post = takeFrom(src, view, explore);
      }
      if (post) return { post, kind: explore && modelOf(prov).taste.ready ? 'explore' : post._kind || 'interest' };
    }
  }
  return null;
}

/* ================================================================== the view */
const mediaSrc = (p) => {
  if (p.kind === 'video') return (p.alts || []).find((a) => /720/.test(a.label))?.url || p.full;
  if (p.kind === 'anim') return p.full;
  return (isPhone() ? p.sample || p.full : p.full || p.sample) || p.thumb;
};
const viewerOpen = () => { const v = document.getElementById('viewer'); return !!v && !v.hidden && v.classList.contains('in'); };

export function renderFeed(root, ctx) {
  const view = {
    items: [], // {post, kind, why}
    picks: 0,
    rr: 0,
    idx: 0,
    busy: false,
    active: () => root.isConnected && !root.hidden && !document.hidden && document.body.dataset.view === 'feed' && !viewerOpen(),
  };
  const scroller = h('div', { class: 'fd-scroll', tabindex: '0' });
  const empty = h('div', { class: 'fd-empty' });
  const chips = h('div', { class: 'fd-chips' });
  const modes = h('div', { class: 'fd-modes' }, [['foryou', 'For you'], ['follows', 'Following'], ['new', 'New'], ['hot', 'Hot']].map(([k, label]) => h('button', { 'data-m': k, onclick: () => setMode(k) }, label)));
  const paintModes = () => modes.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === (S('feedMode') || 'foryou')));
  const setMode = (k) => {
    if (k === (S('feedMode') || 'foryou')) return;
    setS('feedMode', k);
    paintModes();
    refreshFeed(true);
  };
  const pullEl = h('div', { class: 'fd-pull', html: icon('refresh', 20) });
  const head = h('div', { class: 'fd-head' }, chips, h('button', { class: 'ibtn', title: 'Refresh the feed', 'aria-label': 'Refresh the feed', html: icon('refresh', 19), onclick: () => refreshFeed() }), h('button', { class: 'ibtn', title: 'Feed settings', 'aria-label': 'Feed settings', html: icon('sliders', 19), onclick: (e) => feedSettings(e.currentTarget) }));
  const el = h('div', { class: 'fd' }, head, modes, pullEl, scroller, empty);
  root.replaceChildren(el);

  const cards = []; // DOM per item
  let enter = 0, activePost = null;

  /* --- header: which sites */
  const paintChips = () => {
    const on = new Set(S('feedSources') || []);
    chips.replaceChildren(...providerList.map((p) => h('button', { class: 'fd-chip' + (on.has(p.id) ? ' on' : ''), style: `--ph:${p.color}`, title: p.name + (needsKeyMissing(p) ? ' (needs an API key)' : ''), onclick: () => toggleSource(p) }, h('b', {}, p.short), h('span', {}, p.name))));
  };
  const toggleSource = (p) => {
    const cur = new Set(S('feedSources') || []);
    if (cur.has(p.id)) {
      if (cur.size === 1) return toast('The Feed needs at least one site', { ms: 1800 });
      cur.delete(p.id);
    } else {
      cur.add(p.id);
      if (needsKeyMissing(p)) toast(`${p.name} needs an API key: add it in Settings`, { kind: 'err', ms: 3000 });
    }
    setS('feedSources', [...cur]);
    paintChips();
    dropUpcoming();
    autoLearn();
    fill();
  };
  const unsub = on('settings', (e) => e.detail.key === 'feedSources' && paintChips());

  /* --- cards */
  const buildCard = (i) => {
    const it = view.items[i];
    const p = it.post, prov = getProvider(p.provider);
    const model = modelOf(prov);
    const liked = () => model.likes.has(p.id) || p.faved;
    const likeBtn = h('button', { class: 'fd-btn like' + (liked() ? ' on' : ''), title: 'Like (L)', 'aria-label': 'Like', html: icon('heart', 26) + `<small>${fmtNum(p.favs)}</small>`, onclick: (e) => (e.stopPropagation(), toggleLike(p, likeBtn)) });
    const blurred = isBlurred(p);
    let media;
    if (p.kind === 'video') {
      media = h('video', { class: 'fd-media', loop: true, playsinline: true, muted: true, preload: 'metadata', poster: p.thumb });
      media.muted = S('muted') !== false;
      media.dataset.src = mediaSrc(p);
    } else media = h('img', { class: 'fd-media', alt: '', draggable: 'false', decoding: 'async' });
    if (p.kind !== 'video') media.dataset.src = mediaSrc(p);
    const stage = h('div', { class: 'fd-stage' + (blurred ? ' blur' : '') }, media);
    const soundBtn = p.kind === 'video' ? h('button', { class: 'fd-btn', title: 'Sound', 'aria-label': 'Sound', html: icon(media.muted ? 'mute' : 'sound', 24), onclick: (e) => { e.stopPropagation(); media.muted = !media.muted; setS('muted', media.muted); soundBtn.innerHTML = icon(media.muted ? 'mute' : 'sound', 24); } }) : null;
    const card = h('section', { class: 'fd-card', 'data-i': i, style: `--ph:${prov.color}` },
      h('img', { class: 'fd-bg', src: p.thumb, alt: '', draggable: 'false' }),
      stage,
      h('div', { class: 'fd-shade' }),
      buildInfo(it),
      h('div', { class: 'fd-rail' },
        likeBtn,
        h('button', { class: 'fd-btn up' + (voted.has(p) ? ' on' : ''), title: 'Upvote (U)', 'aria-label': 'Upvote', html: icon('up', 24), onclick: (e) => (e.stopPropagation(), upvote(p, e.currentTarget)) }),
        h('button', { class: 'fd-btn', title: 'Downvote / not interested (X)', 'aria-label': 'Downvote', html: icon('down', 24), onclick: (e) => (e.stopPropagation(), dislike(i, true)) }),
        h('button', { class: 'fd-btn', title: 'Open (Enter)', 'aria-label': 'Open', html: icon('eye', 24), onclick: (e) => (e.stopPropagation(), openIt(i)) }),
        h('button', { class: 'fd-btn', title: 'Download (D)', 'aria-label': 'Download', html: icon('download', 24), onclick: (e) => (e.stopPropagation(), ctx.savePost?.(p)) }),
        h('button', { class: 'fd-btn', title: 'Pin', 'aria-label': 'Pin', html: icon('pin', 24), onclick: (e) => (e.stopPropagation(), quickPin([p])) }),
        soundBtn),
      h('button', { class: 'fd-zoomreset', hidden: true, onclick: (e) => (e.stopPropagation(), card._zoom?.reset()) }, 'Reset zoom'),
      blurred ? h('button', { class: 'fd-reveal', onclick: (e) => (e.stopPropagation(), stage.classList.remove('blur'), e.currentTarget.remove()) }, 'Blurred: tap to show') : null);
    attachTaps(card, stage, media, p, likeBtn);
    attachZoom(card, stage, media);
    return card;
  };

  /** Description and the heaviest tags: redrawn once e621's tag categories arrive. */
  const buildInfo = (it) => {
    const p = it.post, prov = getProvider(p.provider), model = modelOf(prov);
    const art = p.artists.slice(0, 2);
    const desc = String(p.desc || '').replace(/\[\/?[a-z]+(=[^\]]*)?\]|"([^"]+)":\S+/gi, '$2').replace(/\s+/g, ' ').trim().slice(0, 140);
    return h('div', { class: 'fd-info' },
      h('div', { class: 'fd-why ' + it.kind }, it.why, h('i', {}, prov.short)),
      art.length ? h('div', { class: 'fd-art' }, art.map((a) => h('button', { onclick: (e) => (e.stopPropagation(), openSearch(p, a)) }, pretty(a)))) : h('div', { class: 'fd-art' }, h('span', {}, 'unknown artist')),
      desc ? h('div', { class: 'fd-desc' }, desc) : null,
      tagBox(p, model, heaviestTags(p, model)));
  };
  const refreshInfo = (it) => {
    it.why = whyOf(it.post, modelOf(it.post.provider), it.kind);
    const slot = cards[view.items.indexOf(it)];
    const old = slot?.querySelector('.fd-info');
    if (old && !old.querySelector('.fd-tags.open')) old.replaceWith(buildInfo(it));
  };

  /** Pinch to zoom (images and video), drag to pan while zoomed. It stays where you leave it; "Reset zoom", a double-tap or moving to another card puts it back. */
  const attachZoom = (card, stage, media) => {
    const z = { s: 1, x: 0, y: 0, moved: false };
    const pill = card.querySelector('.fd-zoomreset');
    const apply = () => {
      media.style.transform = z.s === 1 && !z.x && !z.y ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
      pill.hidden = z.s <= 1.02;
      scroller.style.overflowY = z.s > 1.02 ? 'hidden' : '';
    };
    const clampPan = () => {
      const r = stage.getBoundingClientRect();
      const mx = ((z.s - 1) * r.width) / 2, my = ((z.s - 1) * r.height) / 2;
      z.x = Math.max(-mx, Math.min(mx, z.x));
      z.y = Math.max(-my, Math.min(my, z.y));
    };
    const rel = (t) => { const r = stage.getBoundingClientRect(); return { x: t.clientX - r.left - r.width / 2, y: t.clientY - r.top - r.height / 2 }; };
    let pinch = null, pan = null; // listeners sit on the whole card: a second finger often lands on the buttons
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    card.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        scroller.style.overflowY = 'hidden'; // a swipe that had just begun must not carry on
        const [a, b] = e.touches, ma = rel(a), mb = rel(b);
        pinch = { d: dist(a, b), s: z.s, x: z.x, y: z.y, mid: { x: (ma.x + mb.x) / 2, y: (ma.y + mb.y) / 2 } };
        pan = null;
        z.moved = true;
      } else if (e.touches.length === 1 && z.s > 1.02) {
        pan = { px: e.touches[0].clientX, py: e.touches[0].clientY, x: z.x, y: z.y };
        z.moved = false;
      }
    }, { passive: true });
    card.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches, ma = rel(a), mb = rel(b), mid = { x: (ma.x + mb.x) / 2, y: (ma.y + mb.y) / 2 };
        const s = Math.max(1, Math.min(8, (pinch.s * dist(a, b)) / pinch.d));
        const k = s / pinch.s;
        z.s = s;
        z.x = mid.x - (pinch.mid.x - pinch.x) * k;
        z.y = mid.y - (pinch.mid.y - pinch.y) * k;
        clampPan();
        apply();
      } else if (pan && e.touches.length === 1 && z.s > 1.02) {
        e.preventDefault();
        const t = e.touches[0];
        if (Math.abs(t.clientX - pan.px) + Math.abs(t.clientY - pan.py) > 4) z.moved = true;
        z.x = pan.x + t.clientX - pan.px;
        z.y = pan.y + t.clientY - pan.py;
        clampPan();
        apply();
      }
    }, { passive: false });
    card.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 0) pan = null;
      if (z.s <= 1.02) z.reset();
    }, { passive: true });
    card.addEventListener('touchcancel', () => { pinch = null; pan = null; }, { passive: true });
    // a drag or pinch is not a tap
    stage.addEventListener('click', (e) => { if (z.moved) (e.stopImmediatePropagation(), e.preventDefault(), (z.moved = false)); }, true);
    // desktop: ctrl + wheel (or a trackpad pinch) zooms, plain wheel pans while zoomed
    stage.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && z.s <= 1.02) return;
      e.preventDefault();
      if (e.ctrlKey) {
        const m = rel(e), s = Math.max(1, Math.min(8, z.s * Math.exp(-e.deltaY * 0.01))), k = s / z.s;
        z.x = m.x - (m.x - z.x) * k;
        z.y = m.y - (m.y - z.y) * k;
        z.s = s;
      } else (z.x -= e.deltaX), (z.y -= e.deltaY);
      clampPan();
      apply();
    }, { passive: false });
    z.reset = () => { z.s = 1; z.x = 0; z.y = 0; z.moved = false; apply(); };
    z.zoomed = () => z.s > 1.02;
    card._zoom = z;
  };

  /** The heaviest few tags like hashtags, and a button that opens the full list (grouped by category, in a scroll box). */
  const tagBox = (p, model, top) => {
    const box = h('div', { class: 'fd-tags' });
    const chip = (t, cat) => h('button', { class: cat ? 'c-' + cat : '', onclick: (e) => (e.stopPropagation(), openSearch(p, t)) }, pretty(t));
    const total = Object.entries(p.tags).filter(([c]) => c !== 'artist').reduce((n, [, l]) => n + l.length, 0);
    let all = false;
    const paint = () => {
      box.classList.toggle('open', all);
      if (!all) {
        box.replaceChildren(...top.map((t) => chip(t)), total > top.length ? h('button', { class: 'fd-more', onclick: (e) => (e.stopPropagation(), (all = true), paint()) }, `View all ${total}`) : null);
        return;
      }
      const groups = CATS.filter((c) => c !== 'artist' && p.tags[c]?.length).map((c) => h('div', { class: 'fd-tg' }, h('small', {}, CAT_LABEL[c] || c), h('div', {}, p.tags[c].map((t) => chip(t, c)))));
      box.replaceChildren(h('div', { class: 'fd-allscroll' }, groups), h('button', { class: 'fd-more', onclick: (e) => (e.stopPropagation(), (all = false), paint()) }, 'Show fewer'));
    };
    paint();
    box.addEventListener('click', (e) => e.stopPropagation());
    return box;
  };

  const attachTaps = (card, stage, media, p, likeBtn) => {
    let t = 0, timer = 0;
    stage.addEventListener('click', (e) => {
      if (stage.classList.contains('blur')) return;
      const now = Date.now();
      if (card._zoom?.zoomed()) {
        if (now - t < 300) (card._zoom.reset(), (t = 0));
        else t = now;
        return;
      }
      if (now - t < 300) {
        clearTimeout(timer);
        t = 0;
        burst(card, e);
        if (!modelOf(p.provider).likes.has(p.id) && !p.faved) toggleLike(p, likeBtn, true);
        return;
      }
      t = now;
      timer = setTimeout(() => {
        if (p.kind === 'video') togglePlay(media);
        else openIt(+card.dataset.i);
      }, 300);
    });
  };

  const togglePlay = (v) => {
    if (v.paused) (delete v.dataset.userPaused, v.play().catch(() => {}));
    else (v.dataset.userPaused = '1', v.pause());
  };

  const burst = (card, e) => {
    const r = card.getBoundingClientRect();
    const b = h('div', { class: 'fd-burst', html: icon('heart', 90 ), style: `left:${e.clientX - r.left}px;top:${e.clientY - r.top}px` });
    card.append(b);
    haptic('tick');
    setTimeout(() => b.remove(), 800);
  };

  const mountCard = (i) => {
    if (i < 0 || i >= view.items.length) return;
    const slot = cards[i];
    if (!slot || slot.firstChild) return;
    slot.append(buildCard(i));
  };
  const unmountCard = (i) => {
    const slot = cards[i];
    if (slot?.firstChild) {
      slot.querySelectorAll('video').forEach((v) => (v.pause(), v.removeAttribute('src'), v.load()));
      slot.replaceChildren();
    }
  };
  const loadMedia = (i, play) => {
    const m = cards[i]?.querySelector('.fd-media');
    if (!m || !m.dataset.src) return;
    if (!m.getAttribute('src')) m.src = m.dataset.src;
    if (m.tagName === 'VIDEO') {
      if (play && view.active()) m.play().catch(() => {});
      else m.pause();
    }
  };

  const addSlot = () => {
    const i = cards.length;
    const slot = h('div', { class: 'fd-slot', 'data-i': i });
    cards.push(slot);
    scroller.append(slot);
    return i;
  };

  /* --- keeping the queue stocked */
  const AHEAD = 14; // cards lined up past the one on screen, so a swipe never waits for the network
  const MIN_AHEAD = 5;
  /** An earlier card, far enough back to feel fresh, shown again. */
  const recycle = () => {
    if (view.items.length >= view.idx + MIN_AHEAD || (S('feedMode') || 'foryou') === 'follows') return null; // enough in hand: wait for real posts
    const ahead = new Set(view.items.slice(view.idx).map((x) => x.post));
    const old = view.items.slice(0, Math.max(0, view.idx - 12)).filter((x) => !ahead.has(x.post));
    if (old.length < 8) return null;
    const it = old[Math.floor(Math.random() * old.length)];
    return { post: it.post, kind: it.kind };
  };
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  async function fill() {
    if (view.busy) return void (view.again = true); // run once more when the current round ends
    view.busy = true;
    try {
      do {
        view.again = false;
        while (view.items.length < view.idx + AHEAD) {
          if (!root.isConnected) return;
          if (view.items.length > view.idx + 1 && !view.active()) break; // nothing is looking: do not spend requests
          let got = await withTimeout(nextPost(view), 40000);
          if (!got) got = recycle(); // the site is slow or cooling down: never dead-end, repeats are fine
          if (!got) break;
          const { post, kind } = got;
          const it = { post, kind, why: whyOf(post, modelOf(post.provider), kind) };
          view.items.push(it);
          view.picks++;
          addSlot();
          paintEmpty();
          if (view.items.length === 1) activate(0);
          else syncWindow();
        }
      } while (view.again && root.isConnected);
    } finally {
      view.busy = false;
      paintEmpty();
    }
    catsNear();
    if (view.items.length < view.idx + AHEAD) retry();
  }
  let retryT = 0;
  function retry() {
    clearTimeout(retryT);
    retryT = setTimeout(() => root.isConnected && (view.active() || !view.items.length) && fill(), 6000);
  }
  const paintEmpty = () => {
    const list = enabled();
    if (view.items.length) return void (empty.hidden = true);
    empty.hidden = false;
    const blocked = list.length && list.every(needsKeyMissing);
    const cool = list.some((p) => srcOf(p).cool > Date.now());
    if ((S('feedMode') || 'foryou') === 'follows' && !view.busy && !list.some((p) => subs.all().some((f) => f.p === p.credKey))) return void empty.replaceChildren(h('div', { class: 'fd-loading' }, h('b', {}, 'Follow some artists first'), h('small', {}, 'Follow an artist from the viewer or a search. Their new posts show up here.')));
    empty.replaceChildren(h('div', { class: 'fd-loading' }, h('i'), h('b', {}, blocked ? 'Add an API key for this site' : cool ? 'The site asked us to slow down' : 'Tuning your feed…'), h('small', {}, blocked ? 'Open Settings > Accounts, or pick another site above.' : cool ? 'Trying again shortly. Requests are spaced out on purpose.' : 'Fetching a first batch.')));
  };

  const warmed = new Set();
  const prefetch = (i) => {
    const p = view.items[i]?.post;
    if (!p || p.kind === 'video' || warmed.has(p.id)) return;
    warmed.add(p.id);
    if (warmed.size > 400) warmed.delete(warmed.values().next().value);
    new Image().src = mediaSrc(p);
  };
  const syncWindow = () => {
    for (let i = 0; i < cards.length; i++) {
      if (Math.abs(i - view.idx) <= 2) mountCard(i);
      else unmountCard(i);
    }
    for (let k = 0; k <= 2; k++) loadMedia(view.idx + k, k === 0);
    for (let k = 3; k <= 6; k++) prefetch(view.idx + k); // pictures a few cards down are fetched ahead of time, videos only on arrival
    // the pictures just behind are kept, the ones far behind are dropped with their card
  };

  /* --- what is on screen now: learn from it */
  let since = 0, shownT = 0, catBusy = false;
  /** Categories for the cards about to be seen (not the whole queue): a single paced request, then their text is redrawn. */
  async function catsNear() {
    if (catBusy) return;
    catBusy = true;
    try {
      const near = view.items.slice(view.idx, view.idx + 4);
      await ensureCats(near.map((x) => x.post));
      near.forEach(refreshInfo);
    } finally {
      catBusy = false;
    }
  }
  function activate(i) {
    leave();
    if (i !== view.idx) cards[view.idx]?.firstChild?._zoom?.reset();
    view.idx = i;
    const it = view.items[i];
    syncWindow();
    since = Date.now();
    activePost = it?.post || null;
    clearTimeout(shownT);
    if (it) {
      shownT = setTimeout(() => {
        const m = modelOf(it.post.provider);
        if (m.seen.has(it.post.id)) return;
        m.seen.add(it.post.id);
        trim(m.seen, m.seenMax);
        m.taste.learn(it.post, { l: 0, n: 1 });
        m.save();
      }, 700);
    }
    fill();
    catsNear();
    for (const p of enabled()) { // keep the pool deep: one refill at a time, paced by the gate
      const src = srcOf(p);
      if (!needsKeyMissing(p) && src.pool.length < POOL_LOW && !src.filling && src.cool <= Date.now() && view.active()) refill(src, view);
    }
    scrollSaved = i;
  }
  let scrollSaved = 0;
  function leave() {
    if (!activePost) return;
    const ms = Date.now() - since, p = activePost, m = modelOf(p.provider);
    const liked = m.likes.has(p.id);
    const vid = cards[view.idx]?.querySelector('video');
    if (ms < 1100 && !liked) {
      if (m.seen.has(p.id)) m.taste.learn(p, { n: 0.3, post_n: 0 }); // flicked past
    } else if (!liked && !document.hidden && ms > 0) {
      const watched = vid ? ms > Math.min(14000, (vid.duration || 8) * 1000 * 0.9) : ms > 7000;
      if (watched) m.taste.learn(p, { l: 0.25, n: 0, post_n: 0 }); // stayed a while: a little in its favor
    }
    m.save();
    clearTimeout(shownT);
    activePost = null;
  }

  let ticking = 0;
  const settle = () => {
    const hgt = scroller.clientHeight || 1;
    const i = Math.round(scroller.scrollTop / hgt);
    if (i !== view.idx && i >= 0 && i < view.items.length) activate(i);
  };
  // a short timer rather than a frame callback: frames are not delivered while the window is in the background
  scroller.addEventListener('scroll', () => { clearTimeout(ticking); ticking = setTimeout(settle, 60); }, { passive: true });

  /* --- actions */
  const goTo = (i) => {
    i = Math.max(0, Math.min(cards.length - 1, i));
    const top = i * scroller.clientHeight;
    scroller.scrollTo({ top, behavior: 'smooth' });
    clearTimeout(view.snapT); // some web views drop a smooth scroll that snap points interrupt: finish it by hand
    view.snapT = setTimeout(() => Math.abs(scroller.scrollTop - top) > 2 && scroller.scrollTo({ top, behavior: 'instant' }), 650);
  };

  async function toggleLike(p, btn, onlyAdd = false) {
    const m = modelOf(p.provider), prov = getProvider(p.provider);
    const was = m.likes.has(p.id) || !!p.faved;
    const want = onlyAdd ? true : !was;
    if (want === was) return;
    if (want) { m.likes.add(p.id); m.taste.learn(p, { l: 1, n: 0, post_n: 0 }); }
    else { m.likes.delete(p.id); m.taste.learn(p, { l: -1, n: 0, post_n: 0 }); }
    btn?.classList.toggle('on', want);
    haptic(want ? 'tick' : 'soft');
    m.save();
    if (S('feedSyncLikes')) {
      const c = (S('creds') || {})[prov.credKey];
      if (c?.user && c?.key) {
        try {
          const jobs = [];
          if (prov.fav) jobs.push(prov.setFav(p, want).then(() => { p.faved = want; }));
          if (want && prov.vote && !voted.has(p)) jobs.push(prov.setVote(p, 1, true).then(() => voted.set(p, true)));
          await Promise.all(jobs);
        } catch (e) {
          toast(`Liked here, but ${prov.name} said: ${e.message}`, { kind: 'err', ms: 3600 });
        }
      } else if (want && !view.hintLike && (prov.fav || prov.vote)) {
        view.hintLike = true;
        toast('Saved to your taste. Sign in under Settings to favorite on the site too', { ms: 3200 });
      }
    }
  }

  const signedIn = (prov) => { const c = (S('creds') || {})[prov.credKey]; return !!(c?.user && c?.key) && S('feedSyncLikes'); };

  async function upvote(p, btn) {
    const m = modelOf(p.provider), prov = getProvider(p.provider);
    let on = !voted.has(p);
    haptic('tick');
    if (prov.vote && signedIn(prov)) {
      try {
        const r = await prov.setVote(p, 1);
        if (r?.our_score != null) on = r.our_score > 0;
      } catch (e) {
        return toast(`${prov.name} said: ${e.message}`, { kind: 'err', ms: 3600 });
      }
      toast(on ? 'Upvoted' : 'Upvote removed', { ms: 1100 });
    } else toast(on ? (prov.vote ? 'Counted in your taste. Sign in to upvote on the site too' : 'Counted in your taste') : 'Upvote removed', { ms: 1600 });
    voted.set(p, on);
    btn?.classList.toggle('on', on);
    if (on && !m.likes.has(p.id)) { m.likes.add(p.id); m.taste.learn(p, { l: 0.8, n: 0, post_n: 0 }); m.save(); }
  }

  function dislike(i, vote = false) {
    const p = view.items[i]?.post;
    if (!p) return;
    const prov = getProvider(p.provider);
    if (vote && prov.vote && signedIn(prov)) prov.setVote(p, -1).catch((e) => toast(`${prov.name} said: ${e.message}`, { kind: 'err', ms: 3000 }));
    const m = modelOf(p.provider);
    m.taste.learn(p, { n: 1.5, post_n: 0.5 });
    m.seen.add(p.id);
    m.save();
    haptic('tick');
    toast('Got it, fewer like this', { ms: 1400 });
    goTo(i + 1);
  }

  function openIt(i) {
    const g = {
      viewList: () => view.items.map((x) => x.post),
      itemIndexOfView: (v) => v,
      viewIndexOf: (v) => v,
      scrollTo: (n) => { scroller.scrollTop = n * scroller.clientHeight; },
      refreshMarks() {},
    };
    ctx.openViewer(g, i, null);
  }

  function openSearch(p, tag) {
    ctx.go(ctx.roamHash([{ t: tag, op: '+' }], null, p.provider));
  }

  /* --- on-device learning from likes made anywhere (the viewer's heart, double-tap, upvote) */
  const offLike = on('post-like', (e) => {
    const { post, on: yes, vote } = e.detail;
    const m = modelOf(post.provider);
    if (yes && !m.likes.has(post.id)) { m.likes.add(post.id); m.taste.learn(post, { l: vote ? 0.7 : 1, n: 0, post_n: 0 }); m.save(); }
    else if (!yes && m.likes.has(post.id)) { m.likes.delete(post.id); m.taste.learn(post, { l: -1, n: 0, post_n: 0 }); m.save(); }
    const card = cards[view.items.findIndex((x) => x.post === post)];
    card?.querySelector(vote ? '.fd-btn.up' : '.fd-btn.like')?.classList.toggle('on', !!yes);
  });

  /* --- keys (arrows / J K / L / X / Enter) while the Feed is what you are looking at */
  const onKey = (e) => {
    if (!view.active() || e.ctrlKey || e.metaKey || e.altKey || e.target.matches('input,textarea,select,[contenteditable]')) return;
    const p = view.items[view.idx]?.post;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'j' || k === 'PageDown') (e.preventDefault(), goTo(view.idx + 1));
    else if (k === 'ArrowUp' || k === 'k' || k === 'PageUp') (e.preventDefault(), goTo(view.idx - 1));
    else if (k === 'l' || k === 'L') p && toggleLike(p, cards[view.idx]?.querySelector('.fd-btn.like'));
    else if (k === 'x' || k === 'X') dislike(view.idx, true);
    else if (k === 'u' || k === 'U') p && upvote(p, cards[view.idx]?.querySelector('.fd-btn[aria-label=Upvote]'));
    else if (k === 'Enter') (e.preventDefault(), openIt(view.idx));
    else if (k === 'd' || k === 'D') p && ctx.savePost?.(p);
    else if (k === ' ') {
      const v = cards[view.idx]?.querySelector('video');
      if (v) (e.preventDefault(), togglePlay(v));
    }
  };
  addEventListener('keydown', onKey);

  /* --- settings popover */
  function feedSettings(anchor) {
    const body = h('div', { class: 'fd-set' });
    const row = (label, hint, ctl) => h('div', { class: 'fd-row' }, h('div', {}, h('b', {}, label), hint ? h('small', {}, hint) : null), ctl);
    const tgl = (key, after) => { const b = h('button', { class: 'tgl' + (S(key) ? ' on' : ''), role: 'switch', onclick: () => { setS(key, !S(key)); b.classList.toggle('on', S(key)); after?.(); } }, h('i')); return b; };
    const out = h('output', {}, (S('feedExplore') || 0) + '%');
    const sl = h('input', { type: 'range', min: 0, max: 60, step: 5, value: S('feedExplore') || 0, oninput: () => { setS('feedExplore', +sl.value); out.textContent = sl.value + '%'; } });
    const provs = enabled();
    const stats = h('div', { class: 'fd-stats' });
    const paintStats = () => {
      stats.replaceChildren(...provs.map((p) => {
        const m = modelOf(p), t = m.taste;
        const top = t.interests(undefined, 6, (f) => tagc.get(p.id, f)?.cat ?? null).map((x) => pretty(x.tag));
        const can = canLearn(p);
        return h('div', { class: 'fd-stat', style: `--ph:${p.color}` },
          h('div', { class: 'fd-stat-h' }, h('i', { class: 'prov-dot' }, p.short), h('b', {}, p.name), h('small', {}, `${m.likes.size} liked · ${Math.round(t.pn)} shown`)),
          h('p', {}, top.length ? 'Learning: ' + top.join(', ') : t.ready ? 'Still finding your pattern.' : 'Not enough yet: like a few things' + (can ? ', or read your favorites below.' : '.')),
          can ? h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; await learnAccount(p, { force: true }); paintStats(); } }, learning.has(p.credKey) ? 'Reading…' : 'Read my favorites again') : h('small', { class: 'dim' }, p.fav || p.vote ? 'Sign in under Settings to learn from your favorites' : `${p.name} has no favorites: hearts in the Feed teach it`));
      }));
    };
    paintStats();
    body.append(
      h('h4', {}, 'Your Feed'),
      row('Exploring', 'How much is deliberately outside your taste', h('div', { class: 'fd-slide' }, sl, out)),
      row('New from follows jump the queue', 'Fresh posts from artists you follow, about one card in three', tgl('feedFollows')),
      row('Likes go to the site', 'A heart also favorites and upvotes there when you are signed in', tgl('feedSyncLikes')),
      row('Learn from my favorites', 'Reads your favorites and upvotes (a few requests, then a quick top-up every 12 hours)', tgl('feedLearn', () => autoLearn())),
      stats,
      h('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmDlg('Forget what the Feed learned?', 'This clears taste and the list of posts already shown, on this device. Favorites on the sites are not touched.', 'Forget')) return;
        provs.forEach((p) => modelOf(p).reset());
        closePopover();
        dropUpcoming(true);
        toast('Feed taste reset');
        autoLearn();
        fill();
      } }, 'Forget my taste on this device'));
    popover(anchor, body, { align: 'right', cls: 'fd-pop' });
  }

  /** New cards from scratch (what was already shown stays "seen"). At most one every 8 s, and the same pacing applies to the requests. */
  let lastRefresh = 0;
  function refreshFeed(force = false) {
    if (!force && Date.now() - lastRefresh < 8000) return toast('Just refreshed', { ms: 1200 });
    lastRefresh = Date.now();
    leave();
    for (const s of srcs.values()) (s.pool = []), (s.streams = null), (s.hotLevel = 0);
    dropUpcoming(true);
    view.picks = 0;
    view.idx = 0;
    scroller.scrollTop = 0;
    paintEmpty();
    for (const p of enabled()) !needsKeyMissing(p) && followTick(srcOf(p), view);
    fill();
  }

  /* pull down on the first card to refresh */
  let pull = null;
  scroller.addEventListener('touchstart', (e) => { pull = scroller.scrollTop <= 0 && e.touches.length === 1 ? { y: e.touches[0].clientY, dy: 0 } : null; }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!pull) return;
    pull.dy = e.touches[0].clientY - pull.y;
    if (pull.dy < 0 || scroller.scrollTop > 0) return (pull = null), pullEl.classList.remove('show');
    pullEl.style.setProperty('--p', Math.min(1, pull.dy / 110));
    pullEl.classList.toggle('show', pull.dy > 12);
    pullEl.classList.toggle('go', pull.dy > 110);
  }, { passive: true });
  const endPull = () => {
    const go = pull && pull.dy > 110;
    pull = null;
    pullEl.classList.remove('show', 'go');
    if (go) (haptic('tick'), refreshFeed());
  };
  scroller.addEventListener('touchend', endPull, { passive: true });
  scroller.addEventListener('touchcancel', () => (pull = null, pullEl.classList.remove('show', 'go')), { passive: true });


  /** Posts picked ahead from sites that are no longer on, or after a reset. */
  function dropUpcoming(all = false) {
    const keep = new Set(enabled().map((p) => p.id));
    const tail = view.items.splice(view.idx + 1).filter((x) => !all && keep.has(x.post.provider));
    while (cards.length > view.idx + 1) (unmountCard(cards.length - 1), cards.pop().remove());
    if (all && view.items.length) { view.items.length = 0; while (cards.length) cards.pop().remove(); view.idx = 0; }
    for (const x of tail) (view.items.push(x), addSlot());
    syncWindow();
    for (const s of srcs.values()) if (all || !keep.has(s.prov.id)) (s.pool = []), (s.fresh = []);
    paintEmpty();
  }

  function autoLearn() {
    if (!S('feedLearn')) return;
    for (const p of enabled()) if (canLearn(p)) learnAccount(p);
  }

  /* --- background upkeep while the Feed is open: follow checks, a top-up of pools */
  const upkeep = setInterval(() => {
    if (!root.isConnected) return;
    if (!view.active()) return;
    for (const p of enabled()) {
      if (needsKeyMissing(p)) continue;
      const src = srcOf(p);
      followTick(src, view);
      if (src.pool.length < POOL_LOW && !src.filling && src.cool <= Date.now()) refill(src, view);
    }
    if (view.items.length < view.idx + AHEAD) fill();
  }, 20000);
  const onVis = () => { if (!document.hidden) { fill(); loadMedia(view.idx, true); } else cards[view.idx]?.querySelector('video')?.pause(); };
  document.addEventListener('visibilitychange', onVis);
  // pause video when the viewer or another page covers the feed, and resume when it comes back
  const watch = setInterval(() => {
    if (!root.isConnected) { clearInterval(watch); clearInterval(upkeep); unsub(); offLike(); removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onVis); leave(); return; }
    const v = cards[view.idx]?.querySelector('video');
    if (v) (view.active() && v.paused && !v.dataset.userPaused ? v.play().catch(() => {}) : !view.active() && v.pause());
  }, 1500);

  /* --- go */
  paintChips();
  paintModes();
  paintEmpty();
  autoLearn();
  setTimeout(() => { for (const p of enabled()) !needsKeyMissing(p) && followTick(srcOf(p), view); }, 2500);
  fill();
}

