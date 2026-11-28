/**
 * Fur Affinity as a source: the part of Board Roamer that talks to the site and turns its pages into Board Roamer posts.
 * (The screens are in fapage.js, the markup it reads is in fa-parse.js, the rules the app keeps are in claude/furaffinity.md.)
 *
 * FA has no public API, so every page is fetched through the local proxy (src/proxy.rs, which keeps FA's robots.txt rules and its
 * one-request-a-second pace, sends the signed-in session, and says so when Cloudflare wants a browser check) and read from its HTML.
 * Only pages FA's robots.txt leaves open are ever requested: search, the watch feed and the real favorite / watch buttons are
 * opened on the site itself in the user's browser.
 *
 * Favorites and upvotes in here are Board Roamer's own, saved on this device only. They are never sent to Fur Affinity.
 */
import { kv, emit, voted } from './store.js';
import { sleep } from './util.js';
import { isAndroid } from './platform.js';
import * as P from './fa-parse.js';

const enc = encodeURIComponent;
export const FA_ID = 'fa';
/** Windows, macOS and Linux builds only: the sign-in window and the proxy rules live in the desktop app. */
export const faSupported = () => !isAndroid();

export const faUrl = {
  front: () => P.FA_WEB + '/',
  browse: () => P.FA_WEB + '/browse/',
  view: (id) => `${P.FA_WEB}/view/${id}/`,
  user: (n) => `${P.FA_WEB}/user/${enc(faName(n))}/`,
  gallery: (n, folder) => `${P.FA_WEB}/gallery/${enc(n)}/` + (folder ? `folder/${folder.id}/${folder.slug || ''}` : ''),
  scraps: (n) => `${P.FA_WEB}/scraps/${enc(n)}/`,
  favorites: (n) => `${P.FA_WEB}/favorites/${enc(n)}/`,
  journals: (n) => `${P.FA_WEB}/journals/${enc(n)}/`,
  /** Search is closed to apps by robots.txt: this address is only ever opened in the user's own browser. */
  search: (q) => `${P.FA_WEB}/search/?q=${enc(q)}`,
};

/** A Fur Affinity link -> where it opens inside Board Roamer: {hash, user?, post?}, or null. */
export function faLink(url) {
  const m = /^https?:\/\/(?:www\.)?furaffinity\.net\/(user|gallery|scraps|favorites|view|full)\/([^/?#]+)(?:\/folder\/(\d+)(?:\/([^/?#]*))?)?/i.exec(String(url || '').trim());
  if (!m) return null; // journals, search, messages and the rest are not read here: they open in the browser
  const kind = m[1].toLowerCase();
  let id = m[2];
  try { id = decodeURIComponent(id); } catch { /* keep as is */ }
  if (kind === 'view' || kind === 'full') return /^\d+$/.test(id) ? { post: id, hash: `#/fa?post=${id}` } : null;
  const user = id.toLowerCase();
  const base = `#/fa/user/${enc(user)}`;
  if (m[3]) return { user, hash: `${base}?t=folder&f=${m[3]}/${m[4] || ''}` };
  return { user, hash: kind === 'gallery' ? `${base}?t=gallery` : kind === 'scraps' ? `${base}?t=scraps` : kind === 'favorites' ? `${base}?t=favs` : base };
}
/** The first link among some (a post's sources) that is a Fur Affinity submission. */
export const faPostIn = (urls) => (urls || []).find((u) => faLink(u)?.post) || '';

/** The first Fur Affinity user among some links (an e621 artist's URLs, a post's sources). */
export function faUserIn(urls) {
  for (const u of urls || []) {
    const l = faLink(u);
    if (l?.user) return l.user;
  }
  return '';
}

/* ------------------------------------------------------------------ state shared with the screens */
export const faState = { connected: false, cleared: false, gen: 0, loggedIn: null, me: '', online: null, challenge: false, backoff: 0 };
const touch = () => emit('fa-state', faState);

export async function faStatus() {
  try {
    const j = await (await fetch('/fa/status')).json();
    Object.assign(faState, { connected: !!j.connected, cleared: !!j.cleared, gen: j.gen || 0 });
  } catch { /* the app is closing */ }
  touch();
  return faState;
}
export const faPost = (path, body) => fetch('/fa/' + path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }).then((r) => r.json().catch(() => ({})));
export const faLogin = () => faPost('login');
export const faVerify = () => faPost('verify');
/** Opens the person's own watch list in the Fur Affinity window (they sign in there if asked); the names come back through `faWatchNames`. */
export const faWatchStart = () => faPost('watch');
export const faWatchNames = () => fetch('/fa/watch').then((r) => r.json()).then((j) => j.names || null).catch(() => null);
export const faDisconnect = async () => (await faPost('disconnect'), (faState.loggedIn = null), (faState.me = ''), faStatus());
export const faPaste = (a, b) => faPost('paste', { a, b }).then(async (j) => { if (j.error) throw new Error(j.error); await faStatus(); return j; });

/** FA's footer asks bots to stay away while 15,000 or more registered users are online. User taps are never held back by it. */
export const faBusy = () => (faState.online?.registered || 0) >= 15000;
export const backgroundOk = () => !faBusy() && !faState.challenge;

export class FaError extends Error {
  constructor(msg, extra = {}) {
    super(msg);
    Object.assign(this, extra);
  }
}

/* ------------------------------------------------------------------ requests */
let lastAt = 0;
// One request at a time, a second apart. Whoever is waiting on the screen goes first (0); checks nobody is waiting on
// (background follows, looking ahead at the next pictures) go after (2).
const GAP = 1000;
const queue = [];
let pumping = false;
const serial = (fn, prio = 0) => new Promise((resolve, reject) => {
  queue.push({ fn, prio, resolve, reject });
  pump();
});
async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    queue.sort((a, b) => a.prio - b.prio); // stable: first come, first served within a level
    const job = queue.shift();
    try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
  }
  pumping = false;
}

let waiters = [];
let pollTimer = 0;
async function startChallenge() {
  if (faState.challenge) return;
  await faStatus();
  const gen0 = faState.gen;
  faState.challenge = true;
  touch();
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await faStatus();
    if (faState.gen !== gen0) endChallenge();
  }, 1500);
}
export function endChallenge() {
  clearInterval(pollTimer);
  if (!faState.challenge) return;
  faState.challenge = false;
  touch();
  waiters.splice(0).forEach((r) => r());
}
const untilClear = () => (faState.challenge ? new Promise((r) => waiters.push(r)) : Promise.resolve());

async function once(url) {
  const wait = lastAt + GAP - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  let res;
  try {
    res = await fetch('/proxy?u=' + enc(url));
  } catch {
    throw new FaError('Cannot reach the local proxy — is the app still running?');
  }
  lastAt = Date.now();
  return { res, text: await res.text(), via: res.headers.get('x-br-fa'), final: res.headers.get('x-br-final') || url };
}

/**
 * Fetch a Fur Affinity page and parse it. Waits quietly while Cloudflare wants a browser check (the screens show a banner;
 * the request goes again once it is passed), backs off on 429 and 5xx, and never loops on a refusal.
 * `background`: work nobody asked for right now (checking follows). It is held while FA is busy or a check is pending.
 */
export async function faHtml(url, { background = false, prio = background ? 2 : 0 } = {}) {
  if (!faSupported()) throw new FaError('Fur Affinity is not available on Android yet.');
  for (let attempt = 0; ; ) {
    if (background && !backgroundOk()) throw new FaError('Paused: Fur Affinity asks apps to stay away while it is busy.', { paused: true });
    await untilClear();
    const r = await serial(() => once(url), prio);
    if (r.via === 'challenge') {
      await startChallenge();
      continue;
    }
    if (r.res.status === 403 && /robots/.test(r.text)) throw new FaError('Fur Affinity asks apps not to open that page. It opens in your browser instead.', { robots: true });
    if (r.res.status === 404) throw new FaError('Fur Affinity says that page does not exist (it may have been removed).', { status: 404 });
    if (r.res.status === 429 || r.res.status >= 500) {
      if (++attempt > 3) throw new FaError(`Fur Affinity is not answering (HTTP ${r.res.status}). Try again in a minute.`, { status: r.res.status });
      faState.backoff = 2000 * 2 ** attempt;
      touch();
      await sleep(faState.backoff);
      faState.backoff = 0;
      touch();
      continue;
    }
    if (!r.res.ok) throw new FaError(`Fur Affinity answered HTTP ${r.res.status}.`, { status: r.res.status });
    const doc = P.parseHtml(r.text);
    const info = P.inspect(doc);
    if (info.challenge) {
      await startChallenge();
      continue;
    }
    if (info.online) faState.online = info.online;
    if (info.kind) {
      faState.loggedIn = info.loggedIn;
      faState.me = info.me;
    }
    touch();
    if (/\/login/.test(new URL(r.final, P.FA_WEB).pathname)) throw new FaError('Sign in to Fur Affinity first (Settings > Fur Affinity).', { needsLogin: true });
    if (!info.kind) throw new FaError('Fur Affinity answered with a page this app does not recognise. It may have changed.', { unknown: true });
    return { doc, info, final: r.final };
  }
}

/* ------------------------------------------------------------------ this device's likes, follows-of-the-moment and index of what was seen */
const likeStore = { fav: kv.get('faFav', {}) };
export const faLikes = {
  isFav: (id) => !!likeStore.fav[id],
  setFav(id, on) {
    on ? (likeStore.fav[id] = Date.now()) : delete likeStore.fav[id];
    kv.set('faFav', likeStore.fav);
  },
  favIds: () => Object.keys(likeStore.fav).map(Number).sort((a, b) => likeStore.fav[b] - likeStore.fav[a]),
};

const INDEX_CAP = 6000;
let indexMap = null;
let indexTimer = 0;
const index = () => (indexMap ||= kv.get('faIndex', {}));
const slug = (s) => String(s || '').toLowerCase();

/** What was seen, kept small so it can be searched later without asking the site: tags, artist, rating, thumbnail version. */
export const faIndex = {
  put(it) {
    if (!it?.id || !it.ts) return;
    const m = index();
    m[it.id] = { u: it.user, r: it.rating, y: it.type, c: it.category, th: it.theme, s: it.species, k: (it.keywords || []).map(slug).join(' '), t: it.title, ts: it.ts, w: Math.round(it.w || 0), h: Math.round(it.h || 0) };
    clearTimeout(indexTimer);
    indexTimer = setTimeout(() => faIndex.flush(), 1500);
  },
  flush() {
    const m = index();
    const ids = Object.keys(m);
    if (ids.length > INDEX_CAP) {
      // drop the oldest uploads (lowest ids) but never anything that was liked here
      for (const id of ids.sort((a, b) => a - b)) {
        if (Object.keys(m).length <= INDEX_CAP * 0.9) break;
        if (!likeStore.fav[id]) delete m[id];
      }
    }
    kv.set('faIndex', m);
  },
  size: () => Object.keys(index()).length,
  clear() {
    indexMap = {};
    kv.set('faIndex', indexMap);
  },
  item: (id) => {
    const r = index()[id];
    return r && { id: String(id), user: r.u, rating: r.r, type: r.y || 'image', category: r.c, theme: r.th, species: r.s, keywords: r.k ? r.k.split(' ') : [], title: r.t, ts: r.ts, w: r.w, h: r.h, thumb: '' };
  },
  /** Tag names with how often they appear, for suggestions while typing. */
  tags(prefix, n = 12) {
    const q = slug(prefix);
    const count = new Map();
    for (const r of Object.values(index())) {
      for (const t of [r.u, ...(r.k ? r.k.split(' ') : []), r.th, r.s]) if (t && t.startsWith(q)) count.set(t, (count.get(t) || 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, c]) => ({ name, count: c }));
  },
  /** Ids matching every `+` term and none of the `-` terms (a term is a tag, an artist, `rating:q`, or a word of the title), newest first. */
  search(terms) {
    const pos = terms.filter((t) => t.op !== '-' && t.op !== '~').map((t) => slug(t.t));
    const neg = terms.filter((t) => t.op === '-').map((t) => slug(t.t));
    const any = terms.filter((t) => t.op === '~').map((t) => slug(t.t));
    const out = [];
    for (const [id, r] of Object.entries(index())) {
      const set = new Set([r.u, r.th, r.s, 'rating:' + r.r, 'type:' + (r.y || 'image'), ...(r.k ? r.k.split(' ') : [])]);
      if (r.c) set.add('category:' + r.c);
      const title = slug(r.t);
      const has = (t) => set.has(t) || (t.length > 2 && title.includes(t));
      if (pos.every(has) && !neg.some(has) && (!any.length || any.some(has))) out.push(+id);
    }
    return out.sort((a, b) => b - a);
  },
};

/* ------------------------------------------------------------------ items -> posts */
const THUMB = 400;
const SAMPLE = 600;
const BORING = /^(all|any|unspecified_any|other)$/;
const mediaKind = (ext) => (['webm', 'mp4', 'mov'].includes(ext) ? 'video' : ext === 'gif' ? 'anim' : ext === 'swf' ? 'flash' : 'image');
const unBB = (s) => String(s || '').replace(/\[url=([^\]]*)\]([^[]*)\[\/url\]/gi, '$2').replace(/\[\/?[a-z*]+(=[^\]]*)?\]/gi, '').trim();
const toBytes = (s) => {
  const m = /([\d.]+)\s*(kb|mb|gb|b)/i.exec(s || '');
  return m ? Math.round(+m[1] * { b: 1, kb: 1024, mb: 1048576, gb: 1073741824 }[m[2].toLowerCase()]) : 0;
};

/** One thumbnail's data as a Board Roamer post (the full picture and details arrive when it is opened, see `fill`). */
function fromItem(it, prov) {
  const tags = {};
  for (const c of prov.cats) tags[c] = [];
  if (it.user) tags.artist.push(it.user);
  if (it.species && !BORING.test(it.species)) tags.species.push(it.species);
  const general = new Set([...(it.keywords || []).map(slug), it.theme && it.theme !== 'all' ? slug(it.theme) : ''].filter(Boolean));
  tags.general.push(...general);
  if (it.category && !BORING.test(it.category)) tags.meta.push('category:' + it.category);
  const id = +it.id;
  const ts = it.ts;
  // writing and music are not pictures: they show as a card (when the site has no cover for them) and open as a reading page or a player
  const doc = it.type === 'text' || it.type === 'audio';
  const card = doc && !P.thumbParts(it.thumb || '') && !ts;
  const w = card ? (it.type === 'audio' ? 1000 : 750) : (it.w || 200) * 5, h = card ? 1000 : (it.h || 200) * 5;
  return {
    provider: prov.id, id, rating: P.FA_RATING[it.rating] || 'q', w: Math.round(w), h: Math.round(h), ext: it.type === 'image' ? 'jpg' : it.type, kind: doc ? (it.type === 'audio' ? 'music' : 'story') : 'image', card, md5: '', size: 0,
    // the picture the page itself listed is known to exist and is small; the 600px version is only for the viewer's first look
    thumb: it.thumb || (ts ? P.thumbUrl(id, ts, THUMB) : ''), sample: it.thumb || (ts ? P.thumbUrl(id, ts, THUMB) : ''), full: ts ? P.thumbUrl(id, ts, SAMPLE) : it.thumb, viaProxy: true,
    score: 0, up: 0, down: 0, favs: 0, noScore: true, tags, artists: it.user ? [it.user] : [], sources: [], created: '', desc: unBB(it.desc),
    parent: null, children: [], pools: [], duration: 0, comments: 0, faved: faLikes.isFav(id), url: faUrl.view(id), alts: [], isComic: false,
    title: it.title || '', type: it.type, facts: [], folders: [], _lazy: true, _ts: ts,
  };
}

/** The details a submission page adds to a post. */
function applySubmission(p, s) {
  const t = s.tagsAttr || {};
  p.title = s.title || p.title;
  p.rating = P.FA_RATING[s.rating] || p.rating;
  p.type = s.type;
  if (s.user) {
    p.artists = [s.user];
    if (!p.tags.artist.includes(s.user)) p.tags.artist = [s.user];
  }
  const kw = (s.keywords || []).map(slug);
  const general = new Set([...kw, t.theme && t.theme !== 'all' ? slug(t.theme) : ''].filter(Boolean));
  p.tags.general = [...general];
  p.tags.species = t.species && !BORING.test(t.species) ? [t.species] : [];
  p.tags.meta = t.category && !BORING.test(t.category) ? ['category:' + t.category] : [];
  if (s.type === 'image' && s.full) {
    p.ext = s.ext || s.full.split('.').pop().split('?')[0].toLowerCase();
    p.kind = mediaKind(p.ext);
    p.full = s.full;
    if (p.kind === 'video') p.sample = null;
    else if (p.kind === 'anim') p.sample = p.full;
  } else {
    // a story or a song: the viewer shows a reading page or a player (see fadoc.js)
    p.ext = s.ext || s.type;
    p.kind = s.type === 'audio' ? 'music' : 'story';
    p.full = s.full || p.full;
    p.body = s.body || '';
    p.audio = s.audio || '';
    if (p.kind === 'story' && !p.body && !['txt', 'rtf'].includes(p.ext)) p.external = s.type; // a .pdf or .docx: read it on the site
  }
  if (s.w && s.h) (p.w = s.w), (p.h = s.h);
  p.size = toBytes(s.fileSize);
  p.desc = s.desc;
  p.favs = s.favs;
  p.comments = s.comments;
  p.views = s.views;
  p.created = s.created;
  p.folders = s.folders;
  p.newer = s.newer;
  p.older = s.older;
  p.facts = [['Views', s.views], ['Category', s.category], ['Theme', s.theme], ['Species', s.species], ['Uploaded by', s.display || s.user]].filter(([, v]) => v !== '' && v != null);
  if (p.kind === 'story' || p.kind === 'music') p.facts.push(['Kind', p.kind === 'music' ? 'Music' : 'Story' + (p.external ? ` (.${p.ext} file, read it on Fur Affinity)` : '')]);
  p._lazy = false;
  delete p._set; // the blacklist's cached tag set
  return p;
}

function figuresToItems(figs) {
  return figs.filter((f) => f.id);
}

/* ------------------------------------------------------------------ the provider */
const startUrl = (src) => {
  switch (src.kind) {
    case 'front': return faUrl.front();
    case 'browse': return faUrl.browse();
    case 'scraps': return faUrl.scraps(src.user);
    case 'favs': return faUrl.favorites(src.user);
    case 'folder': return faUrl.gallery(src.user, src.folder);
    default: return faUrl.gallery(src.user);
  }
};

export function faEngine({ CATS }) {
  return {
    engine: 'fa', credKey: FA_ID, auth: 'cookies', web: P.FA_WEB, short: 'fa', color: 38, maxTags: 99, pageSize: 48, cats: CATS,
    sorts: [], shapes: false, ages: false, media: false, pageNumberCap: 1e9, fav: true, vote: true, localLikes: true, plainDesc: true, noScore: true,
    dossier: false, wiki: false, pools: false,
    filterTags: () => [],

    /**
     * The next page of what `feed.fa` describes ({kind: 'front' | 'browse' | 'gallery' | 'scraps' | 'favs' | 'folder' | 'seen' | 'liked', user, folder, section}).
     * A feed without it is a plain "posts by this artist" (what Follows and the artist page ask for).
     */
    async page(feed) {
      const src = feed.fa || { kind: 'gallery', user: (feed.terms?.[0]?.t || '').toLowerCase() };
      if (src.kind === 'seen' || src.kind === 'liked') return this.localPage(feed, src);
      // The front page lists a fixed set per section and has no next page. Past it, the feed carries on through Browse
      // (the site's own newest-first list), keeping the section's kind of work; the screen offers it as "Load more".
      const TYPES = ['image', 'text', 'audio'];
      const url = feed.nextUrl || (feed.phase === 'browse' ? faUrl.browse() : startUrl(src));
      if (!url || (!src.user && !['front', 'browse'].includes(src.kind))) return ((feed.done = true), []);
      let figs = [];
      for (let tries = 0; ; tries++) {
        const u = tries ? feed.nextUrl : url;
        if (!u) { feed.done = true; break; }
        const { doc, final } = await faHtml(u, { background: !!feed.background });
        if (src.kind === 'front' && feed.phase !== 'browse') {
          figs = P.parseFrontpage(doc)[src.section || 0]?.items || [];
          feed.phase = 'browse';
          feed.nextUrl = faUrl.browse();
          feed.hold = true; // wait for "Load more"
        } else {
          figs = P.parseFigures(doc);
          if (src.kind === 'front' && TYPES[src.section || 0]) figs = figs.filter((x) => x.type === TYPES[src.section || 0]);
          feed.nextUrl = P.nextPageUrl(doc, final);
          if (!feed.nextUrl) feed.done = true;
        }
        if (!feed.pageInfo) feed.pageInfo = { user: P.parseUserHeader(doc), folders: P.parseFolders(doc), folderTitle: P.parseFolderTitle(doc) };
        // a filtered Browse page can be nearly empty: look at a few more before giving the screen back
        if (figs.length >= 8 || feed.done || src.kind !== 'front' || feed.hold || tries >= 3) break;
      }
      figs = figuresToItems(figs);
      for (const f of figs) faIndex.put(f);
      return figs.map((f) => fromItem(f, this));
    },

    /** Posts from this device's index (what was browsed, what was liked), in pages. */
    async localPage(feed, src) {
      if (!feed.ids) feed.ids = src.kind === 'liked' ? faLikes.favIds() : faIndex.search(feed.terms || []);
      const at = feed.cursor || 0;
      const chunk = feed.ids.slice(at, at + 60);
      feed.cursor = at + chunk.length;
      if (feed.cursor >= feed.ids.length) feed.done = true;
      return chunk.map((id) => faIndex.item(id)).filter(Boolean).map((it) => fromItem(it, this));
    },

    /** A whole post: the submission page, with the full-size file and everything written about it. */
    async post(id, opts = {}) {
      const { doc } = await faHtml(faUrl.view(id), opts);
      const s = P.parseSubmission(doc);
      if (!s) throw new FaError('That submission could not be read. It may have been removed, or it is not an ordinary submission page.');
      const th = P.thumbParts(s.preview);
      const it = { id: String(s.id || id), title: s.title, user: s.user, rating: s.rating, type: s.type, category: s.tagsAttr.category, theme: s.tagsAttr.theme, species: s.tagsAttr.species, keywords: s.keywords, ts: th?.ts || '', w: 0, h: 0, thumb: s.preview };
      const p = applySubmission(fromItem(it, this), s);
      if (it.ts) faIndex.put({ ...it, w: s.w / 5, h: s.h / 5 });
      return p;
    },

    /** Fill in a post that came from a thumbnail (once, however often it is asked). */
    fill(post, opts = {}) {
      if (!post._lazy) return Promise.resolve(post);
      if (post._fp) return post._fp;
      // not an enumerable property: a pinned or saved copy of the post must not carry a promise
      const pr = this.post(post.id, opts).then((full) => {
        const { _lazy, ...rest } = full;
        Object.assign(post, rest, { _lazy: false });
        delete post._set;
        return post;
      }).catch((e) => {
        post._fp = null;
        throw e;
      });
      Object.defineProperty(post, '_fp', { value: pr, enumerable: false, writable: true, configurable: true });
      return pr;
    },

    /** A user's profile page: header, bio, stats, latest uploads. Remembered for a few minutes. */
    async user(name) {
      const hit = userCache.get(name);
      if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
      const { doc } = await faHtml(faUrl.user(name));
      const v = P.parseUserpage(doc);
      if (!v) throw new FaError('That user page could not be read. The account may not exist or be disabled.');
      userCache.set(name, { at: Date.now(), v });
      return v;
    },

    /** Autocomplete from what was seen: artists and tags in this device's index. */
    async autocomplete(q) {
      return faIndex.tags(q).map((t) => ({ name: t.name, count: t.count, cat: 'general' }));
    },
    async tagInfo() {
      return null;
    },

    /** Board Roamer's own favorites: saved on this device only. */
    async setFav(post, on) {
      faLikes.setFav(post.id, on);
      if (on) faIndex.put({ id: String(post.id), user: post.artists[0], rating: Object.entries(P.FA_RATING).find(([, v]) => v === post.rating)?.[0] || 'general', type: post.type || 'image', category: '', theme: '', species: post.tags.species[0] || '', keywords: post.tags.general, title: post.title, ts: post._ts || P.thumbParts(post.thumb)?.ts || '', w: post.w / 5, h: post.h / 5 });
      if (on) faIndex.flush();
    },
    /** Board Roamer's own upvote. Answers like e621 does, so the viewer treats both alike. */
    async setVote(post, score, keep) {
      const on = keep ? true : !voted.has(post);
      voted.set(post, on);
      return { our_score: on ? 1 : 0 };
    },
  };
}
const userCache = new Map();

/** Fur Affinity's address form of a name: lowercase, no spaces, underscores or punctuation ("Barbie Wire" -> barbiewire). */
export const faName = (s) => String(s || '').trim().replace(/^[@~]+/, '').toLowerCase().replace(/[^a-z0-9.\-`]/g, '');
