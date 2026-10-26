import { uid } from './util.js';

const NS = 'br1:';
export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => (bus.addEventListener(name, fn), () => bus.removeEventListener(name, fn));

function load(key, def) {
  try {
    const v = localStorage.getItem(NS + key);
    return v == null ? structuredClone(def) : JSON.parse(v);
  } catch {
    return structuredClone(def);
  }
}
let quotaWarned = false;
function save(key, val) {
  try {
    localStorage.setItem(NS + key, JSON.stringify(val));
  } catch (e) {
    if (!quotaWarned) {
      quotaWarned = true;
      emit('toast', { msg: 'Storage is full — export your boards and clear some history.', kind: 'err' });
    }
  }
}

export const DEFAULTS = {
  provider: 'e621',
  theme: 'night',
  hue: 128,
  topo: true,
  grain: true,
  layout: 'masonry', // masonry | grid | rows
  density: 250, // target tile width px
  gap: 10,
  thumbQ: 'sharp', // sharp | fast
  showMeta: false,
  blurThumbs: false,
  fullOriginal: true,
  autoplay: true,
  muted: true,
  wheel: 'zoom', // zoom | nav
  slideshowSec: 5,
  filmstrip: true,
  panelOpen: true,
  ua: '',
  creds: {},
  blacklist: [],
  blacklistMode: 'veil', // veil | hide | off
  poolMostly: 50, // a pool whose pages match the blacklist MORE than this % counts as "mostly" that: hidden / veiled, or (#blur) offers to unblur it all
  poolWarn: 15, // a pool with at least this % of #blur pages is flagged as having blurred pages (below it, those pages are only blurred one by one)
  starred: [], // [{p: credKey, t: tag, cat}]
  mobileCols: 2, // gallery columns on a phone held upright (one more when sideways)
  haptics: true,
  keepAwake: true, // while a video plays or a comic is open
  privacyScreen: false, // Android: hide the app in the app switcher and block screenshots
  autoCloak: false, // cloak the screen whenever the app goes to the background
  dtap: 'like', // double-tap a picture on a touch screen: like (favorite + upvote) | zoom
  filmPhone: false, // filmstrip in the viewer on a phone
  embedMeta: true, // write tags / artist / source / md5 into saved files
  volume: 0.8,
  videoLoop: true,
  readerMode: 'single', // single | double | scroll
  readerRtl: false,
  readerFit: 'page', // page | width | height | orig
  readerCover: true, // first page stands alone in two-page mode
  tabs: 'auto', // off | auto (the tab bar appears once there is a second tab) | always
  restoreTabs: true, // reopen the tabs from last time
  mainTab: true, // computers: the first tab is a pinned Main tab; what you open from it gets its own tab
  followsFresh: 10, // minutes before Follows re-checks for new posts when you look at it
  boardCounters: true, // "N new" on live boards, their chips above the gallery and the Boards badge (one board can opt out: board.hideNew)
  openLinks: true, // Android: links to the supported sites offer Board Roamer
  localOn: false, // the Local section: browse pictures and videos in folders you choose, on this and your other devices
  localSort: 'new',
  notify: false, // system notifications when something new turns up (text only, never pictures)
  notifyFollows: true,
  notifyBoards: true,
  notifyPools: true,
  notifyNames: false, // say which followed artists posted, instead of just "your follows"
  autoUpdate: true, // look for a newer version on GitHub now and then
  savedClear: 'never', // never | monthly: forget posts saved more than 30 days ago (the list of saved posts is tiny, so the default keeps it forever)
  poolsTab: 'browse', // browse | library
  libSort: 'updates',
  subSort: 'latest',
  subGroup: true,
  filters: { order: '', score: 0, ratings: { s: true, q: true, e: true }, media: '', shape: '', age: '' },
};

let settings = { ...structuredClone(DEFAULTS), ...load('settings', {}) };
settings.filters = { ...DEFAULTS.filters, ...settings.filters, ratings: { ...DEFAULTS.filters.ratings, ...(settings.filters || {}).ratings } };

/** Settings that follow you between devices. Layout/size/phone-only options stay per device, and credentials never leave it. */
export const SYNC_KEYS = ['provider', 'theme', 'hue', 'topo', 'grain', 'blacklist', 'blacklistMode', 'poolMostly', 'poolWarn', 'starred', 'ua', 'embedMeta', 'autoplay', 'muted', 'videoLoop',
  'fullOriginal', 'slideshowSec', 'readerMode', 'readerRtl', 'readerFit', 'readerCover', 'subSort', 'subGroup', 'filters', 'showMeta', 'blurThumbs', 'boardCounters'];
let settingsT = load('settingsT', {}); // when each synced setting was last changed here

export const S = (k) => settings[k];
export function setS(k, v) {
  settings[k] = v;
  save('settings', settings);
  if (SYNC_KEYS.includes(k)) (settingsT[k] = Date.now(), save('settingsT', settingsT));
  emit('settings', { key: k, value: v });
}
export const allSettings = () => settings;

/* ---------- comics / pools you chose to see unblurred (per device) ---------- */
const unblurPools = new Set(load('unblurPools', []));
/** Keys are `<provider id>:<pool id>`, which is what a post's `pools` list can be checked against. */
export const poolUnblur = {
  has: (key) => unblurPools.has(key),
  set(key, v) {
    v ? unblurPools.add(key) : unblurPools.delete(key);
    save('unblurPools', [...unblurPools]);
    emit('unblur', { key, on: v });
  },
  /** Is this post a page of a pool that was unblurred as a whole? */
  covers: (post) => !!unblurPools.size && !!post.pools?.some((id) => unblurPools.has(`${post.provider}:${id}`)),
};

/* ---------- posts saved to Downloads (per device) ---------- */
const DAY = 86400_000, SAVED_KEEP = 30;
/** {provider id: {post id: day number}}: about 15 bytes a post, so even 50,000 saves stay under 1 MB. */
let savedMap = load('saved', {});
const savedDay = () => Math.floor(Date.now() / DAY);
const savedPrune = () => {
  if (settings.savedClear !== 'monthly') return;
  const cut = savedDay() - SAVED_KEEP;
  for (const pid of Object.keys(savedMap)) {
    for (const id of Object.keys(savedMap[pid])) if (savedMap[pid][id] < cut) delete savedMap[pid][id];
    if (!Object.keys(savedMap[pid]).length) delete savedMap[pid];
  }
  save('saved', savedMap);
};
savedPrune();
export const saved = {
  has: (p) => !!savedMap[p.provider]?.[p.id],
  add(p) {
    (savedMap[p.provider] ||= {})[p.id] = savedDay();
    save('saved', savedMap);
    emit('saved', { key: postKey(p) });
  },
  count: () => Object.values(savedMap).reduce((n, m) => n + Object.keys(m).length, 0),
  /** Roughly what it takes up in this device's storage. */
  bytes: () => (localStorage.getItem(NS + 'saved') || '').length * 2,
  clear() {
    savedMap = {};
    save('saved', savedMap);
    emit('saved', {});
  },
  prune: savedPrune,
};

/* ---------- post helpers ---------- */
export const postKey = (p) => `${p.provider}:${p.id}`;

/** Keep only what is needed to render/open a post again offline. */
export function snapshot(p) {
  const { desc, _set, ...rest } = p;
  return { ...rest, desc: desc ? desc.slice(0, 400) : '', pinnedAt: Date.now() };
}

/* ---------- tombstones: what was deleted here, so a sync can tell "deleted" from "never had it" ---------- */
const TOMB_KEEP = 120 * 86400_000;
let tomb = { b: {}, bp: {}, s: {}, t: {}, l: {}, f: {}, tc: 0, ...load('tomb', {}) };
const bury = (map, key) => ((tomb[map][key] = Date.now()), save('tomb', tomb));
export const trailSig = (e) => e.provider + '|' + JSON.stringify(e.terms) + '|' + JSON.stringify(e.filters);

/* ---------- tag links: the same subject under each site's own tag, e.g. {e621: 'spike_(mlp)', derpibooru: 'spike'} ---------- */
let linkList = load('tagLinks', []);
export const tagLinks = {
  all: () => linkList,
  /** The tag `to` uses for what `tag` means on `from` (keys are providers' credKey), or null. */
  suggest(from, tag, to) {
    const g = linkList.find((x) => x[from] === tag);
    return (g && g[to]) || null;
  },
  /** pairs: [{key, tag}] that all mean the same thing. Groups that share a tag are joined. */
  link(pairs) {
    const hit = linkList.filter((g) => pairs.some((p) => g[p.key] === p.tag));
    const merged = Object.assign({}, ...hit);
    for (const p of pairs) merged[p.key] = p.tag;
    linkList = [...linkList.filter((g) => !hit.includes(g)), merged];
    save('tagLinks', linkList);
    emit('taglinks');
  },
};

/* ---------- folders: tidy boards (pin boards and live boards) and library titles (pools, comics) into groups ---------- */
let folderList = load('folders', []);
const saveFolders = () => (save('folders', folderList), emit('folders'));
export const folders = {
  all: (kind) => folderList.filter((f) => f.kind === kind).sort((a, b) => a.name.localeCompare(b.name)),
  get: (id) => folderList.find((f) => f.id === id),
  create(name, kind) {
    const f = { id: uid(), kind, name: name.trim() || 'New folder', created: Date.now(), updated: Date.now() };
    folderList.push(f);
    saveFolders();
    return f;
  },
  rename(id, name) {
    const f = folders.get(id);
    if (f && name.trim()) (Object.assign(f, { name: name.trim(), updated: Date.now() }), saveFolders());
  },
  /** What is inside goes back to the top level; nothing is deleted. */
  remove(id) {
    const f = folders.get(id);
    if (!f) return;
    bury('f', id);
    folderList = folderList.filter((x) => x.id !== id);
    save('folders', folderList);
    if (f.kind === 'boards') boardList.filter((b) => b.folder === id).forEach((b) => boards.update(b.id, { folder: null }));
    else libList.filter((l) => l.folder === id).forEach((l) => library.update(l.id, { folder: null, folderT: Date.now() }));
    emit('folders');
  },
};

/* ---------- boards ---------- */
let boardList = load('boards', []);
const saveBoards = () => (save('boards', boardList), emit('boards'));
const INBOX = 'pins';
export const NEW_CAP = 8; // a board's check looks at its newest 8 posts, so "8 new" really means 8 or more
// repair boards saved by older builds (a cached Set was serialised into every pinned post as "{}")
let repaired = false;
for (const b of boardList) for (const p of b.posts || []) if (p && '_set' in p) (delete p._set, (repaired = true));
if (repaired) save('boards', boardList);
// the built-in quick-pin board: one tap pins here, other boards are for sorting things properly
if (!boardList.some((b) => b.id === INBOX)) {
  boardList.unshift({ id: INBOX, name: 'Pins', kind: 'pins', inbox: true, hue: 85, created: Date.now(), updated: Date.now(), posts: [] });
  save('boards', boardList);
}
const PALETTE = [128, 35, 200, 330, 85, 260, 10, 170];

export const boards = {
  all: () => boardList,
  inbox: () => boardList.find((b) => b.id === INBOX),
  get: (id) => boardList.find((b) => b.id === id),
  pins: () => boardList.filter((b) => b.kind === 'pins'),
  create(name, kind = 'pins', data = {}) {
    const b = {
      id: uid(),
      name: name || 'Untitled board',
      kind,
      hue: PALETTE[boardList.length % PALETTE.length],
      created: Date.now(),
      updated: Date.now(),
      posts: [],
      ...data,
    };
    boardList.unshift(b);
    saveBoards();
    return b;
  },
  update(id, patch) {
    const b = boards.get(id);
    if (!b) return;
    Object.assign(b, patch, { updated: Date.now() });
    saveBoards();
  },
  remove(id) {
    if (id === INBOX) return; // the Pins board is permanent
    bury('b', id);
    boardList = boardList.filter((b) => b.id !== id);
    saveBoards();
  },
  has: (id, key) => !!boards.get(id)?.posts.some((p) => postKey(p) === key),
  inAny: (key) => boardList.some((b) => b.kind === 'pins' && b.posts.some((p) => postKey(p) === key)),
  add(id, posts) {
    const b = boards.get(id);
    if (!b) return 0;
    let n = 0;
    for (const p of posts) {
      if (b.posts.some((q) => postKey(q) === postKey(p))) continue;
      b.posts.unshift(snapshot(p));
      n++;
    }
    if (n) (b.updated = Date.now()), saveBoards();
    return n;
  },
  removePosts(id, keys) {
    const b = boards.get(id);
    if (!b) return;
    const ks = new Set(keys);
    for (const k of ks) tomb.bp[id + '|' + k] = Date.now();
    save('tomb', tomb);
    b.posts = b.posts.filter((p) => !ks.has(postKey(p)));
    b.updated = Date.now();
    saveBoards();
  },
  replaceAll(list) {
    boardList = list;
    saveBoards();
  },
  /** Change bookkeeping on a board (new-content marks) without counting it as an edit. */
  patch(id, patch) {
    const b = boards.get(id);
    if (!b) return;
    Object.assign(b, patch);
    saveBoards();
  },
  /** A live board has seen everything up to its latest post. */
  markSeen(id) {
    const b = boards.get(id);
    if (b && (b.newCount || b.seenId < b.latestId)) boards.patch(id, { seenId: b.latestId, newCount: 0 });
  },
  markAllSeen() {
    boardList.forEach((b) => b.kind === 'smart' && ((b.seenId = b.latestId || 0), (b.newCount = 0)));
    saveBoards();
  },
  /** Does this board show its new-post counter? Off everywhere (Settings > Look) or for this board (its menu). */
  counts: (b) => b?.kind === 'smart' && S('boardCounters') !== false && !b.hideNew,
  /**
   * New posts across the live boards that show a counter, as the cards show them: a check only looks at the newest
   * few posts, so one board counts 8 at most and is "8+". Same rule for the badge and the Boards header.
   */
  unseen: (list = boardList) => list.reduce((t, b) => {
    const n = boards.counts(b) ? Math.min(b.newCount || 0, NEW_CAP) : 0;
    return { n: t.n + n, more: t.more || n >= NEW_CAP };
  }, { n: 0, more: false }),
};

/* ---------- follows (artist subscriptions) ---------- */
let subList = load('subs', []);
const saveSubs = () => (save('subs', subList), emit('subs'));
export const subs = {
  all: () => subList,
  get: (id) => subList.find((x) => x.id === id),
  find: (cred, tag) => subList.find((x) => x.p === cred && x.t === tag),
  add({ p, t, cat = 'artist' }) {
    if (subs.find(p, t)) return subs.find(p, t);
    const f = { id: uid(), p, t, cat, added: Date.now(), seenId: 0, latestId: 0, latestAt: null, thumbs: [], count: 0, newCount: 0, checked: 0, err: '' };
    subList.unshift(f);
    saveSubs();
    return f;
  },
  remove(id) {
    const gone = subs.get(id);
    if (gone) bury('s', gone.p + ':' + gone.t);
    subList = subList.filter((x) => x.id !== id);
    saveSubs();
  },
  update(id, patch, quiet = false) {
    const f = subs.get(id);
    if (!f) return;
    Object.assign(f, patch);
    quiet ? save('subs', subList) : saveSubs();
  },
  markSeen(id) {
    const f = subs.get(id);
    if (f && (f.newCount || f.seenId < f.latestId)) subs.update(id, { seenId: f.latestId, newCount: 0 });
  },
  markAllSeen() {
    subList.forEach((f) => ((f.seenId = f.latestId), (f.newCount = 0)));
    saveSubs();
  },
  unseen: () => subList.reduce((n, f) => n + (f.newCount || 0), 0),
};
// one-time migration: artists that were only "starred" become follows
if (!load('mig_subs', false)) {
  const st = settings.starred || [];
  const arts = st.filter((x) => x.cat === 'artist');
  if (arts.length) {
    for (const a of arts) subs.add({ p: a.p, t: a.t, cat: 'artist' });
    settings.starred = st.filter((x) => x.cat !== 'artist');
    save('settings', settings);
  }
  save('mig_subs', true);
}


/* ---------- library (saved pools and comics, with update tracking) ---------- */
let libList = load('library', []);
const saveLib = () => (save('library', libList), emit('library'));
const libKey = (f) => f.p + ':' + f.pid;
export const library = {
  all: () => libList,
  get: (id) => libList.find((x) => x.id === id),
  find: (p, pid) => libList.find((x) => x.p === p && String(x.pid) === String(pid)),
  /** Saving something starts from "all caught up": only pages added later count as new. */
  add({ p, pid, name, kind, cover, count, updated }) {
    const had = library.find(p, pid);
    if (had) return had;
    const f = { id: uid(), p, pid, name, kind, cover: cover || '', count: count || 0, seenCount: count || 0, updated: updated || null, checked: Date.now(), added: Date.now(), err: '' };
    libList.unshift(f);
    saveLib();
    return f;
  },
  remove(id) {
    const gone = library.get(id);
    if (gone) bury('l', libKey(gone));
    libList = libList.filter((x) => x.id !== id);
    saveLib();
  },
  update(id, patch, quiet = false) {
    const f = library.get(id);
    if (!f) return;
    Object.assign(f, patch);
    quiet ? save('library', libList) : saveLib();
  },
  newPages: (f) => Math.max(0, (f.count || 0) - (f.seenCount || 0)),
  markSeen(id) {
    const f = library.get(id);
    if (f && f.seenCount < f.count) library.update(id, { seenCount: f.count });
  },
  markAllSeen() {
    libList.forEach((f) => (f.seenCount = f.count));
    saveLib();
  },
  /** How many titles have pages you have not seen. */
  unseen: () => libList.reduce((n, f) => n + (library.newPages(f) ? 1 : 0), 0),
};

/* ---------- reading progress (comics / pools) ---------- */
let readList = load('reading', {});
export const reading = {
  get: (key) => readList[key],
  set(key, v) {
    readList[key] = { ...readList[key], ...v, ts: Date.now() };
    const keys = Object.keys(readList);
    if (keys.length > 300) for (const k of keys.sort((a, b) => readList[a].ts - readList[b].ts).slice(0, 60)) delete readList[k];
    save('reading', readList);
    emit('reading');
  },
  all: () => readList,
};

/* ---------- history (the Trail) ---------- */
let trail = load('trail', []);
export const history = {
  all: () => trail,
  push(entry) {
    const sig = trailSig;
    const i = trail.findIndex((e) => sig(e) === sig(entry));
    if (i >= 0) trail.splice(i, 1);
    trail.unshift({ ...entry, ts: Date.now() });
    trail = trail.slice(0, 250);
    save('trail', trail);
    emit('trail');
  },
  update(ts, patch) {
    const e = trail.find((x) => x.ts === ts);
    if (e) (Object.assign(e, patch), save('trail', trail));
  },
  remove(ts) {
    const gone = trail.find((e) => e.ts === ts);
    if (gone) bury('t', trailSig(gone));
    trail = trail.filter((e) => e.ts !== ts);
    save('trail', trail);
    emit('trail');
  },
  clear() {
    tomb.tc = Date.now();
    save('tomb', tomb);
    trail = [];
    save('trail', trail);
    emit('trail');
  },
};

/* ---------- local files: the tags you gave them. Kept here, never written into the files. Per device, not synced. ---------- */
let localMetaMap = load('localMeta', {});
export const localMeta = {
  tags: (key) => localMetaMap[key]?.tags || [],
  setTags(key, tags) {
    if (tags.length) localMetaMap[key] = { tags };
    else delete localMetaMap[key];
    save('localMeta', localMetaMap);
    emit('localmeta');
  },
};

/* ---------- tag knowledge (category + count), remembered between sessions ---------- */
let tagStore = load('tags', {});
let tagDirty = 0;
export const tagc = {
  get: (prov, name) => tagStore[prov + ':' + name],
  set(prov, name, info) {
    const k = prov + ':' + name;
    const old = tagStore[k];
    if (old && old.cat === info.cat && Math.abs((old.count || 0) - (info.count || 0)) < (old.count || 0) * 0.2) return;
    tagStore[k] = { cat: info.cat, count: info.count ?? old?.count ?? 0 };
    if (++tagDirty % 40 === 0) tagc.flush();
  },
  flush() {
    const keys = Object.keys(tagStore);
    if (keys.length > 6000) for (const k of keys.slice(0, keys.length - 4500)) delete tagStore[k];
    save('tags', tagStore);
  },
};
addEventListener('beforeunload', () => tagc.flush());

/* ---------- backup ---------- */
export function exportAll() {
  return JSON.stringify({ app: 'board-roamer', v: 2, settings: { ...settings, creds: {} }, boards: boardList, trail, subs: subList, reading: readList }, null, 1);
}
export function importAll(text) {
  const d = JSON.parse(text);
  if (d.app !== 'board-roamer') throw new Error('Not a Board Roamer backup');
  if (d.settings) {
    const keepCreds = settings.creds;
    settings = { ...settings, ...d.settings, creds: keepCreds };
    save('settings', settings);
  }
  if (Array.isArray(d.boards)) {
    const have = new Set(boardList.map((b) => b.id));
    boardList = [...d.boards.filter((b) => !have.has(b.id)), ...boardList];
    saveBoards();
  }
  if (Array.isArray(d.subs)) {
    const have = new Set(subList.map((x) => x.p + ':' + x.t));
    subList = [...d.subs.filter((x) => !have.has(x.p + ':' + x.t)), ...subList];
    saveSubs();
  }
  if (d.reading && typeof d.reading === 'object') {
    readList = { ...d.reading, ...readList };
    save('reading', readList);
  }
  if (Array.isArray(d.trail)) {
    trail = [...d.trail, ...trail].slice(0, 250);
    save('trail', trail);
  }
}
export function wipe(what) {
  if (what === 'trail') history.clear();
  if (what === 'tags') ((tagStore = {}), save('tags', tagStore));
}

/* ---------- sync: everything that travels, and how it lands ---------- */
export const syncData = {
  snapshot() {
    const cfg = {}, cfgT = {};
    for (const k of SYNC_KEYS) {
      if (settingsT[k]) (cfg[k] = settings[k], cfgT[k] = settingsT[k]);
      else if (JSON.stringify(settings[k]) !== JSON.stringify(DEFAULTS[k])) (cfg[k] = settings[k], cfgT[k] = 1); // customised before sync existed
    }
    const cut = Date.now() - TOMB_KEEP;
    for (const m of ['b', 'bp', 's', 't', 'l', 'f']) for (const k of Object.keys(tomb[m])) if (tomb[m][k] < cut) delete tomb[m][k];
    return JSON.parse(JSON.stringify({ v: 1, settings: cfg, settingsT: cfgT, boards: boardList, subs: subList, library: libList, folders: folderList, tagLinks: linkList, trail, reading: readList, tomb }));
  },
  /** Replace local state with a merged document. */
  apply(doc) {
    const changed = [];
    for (const k of SYNC_KEYS) {
      if (!(k in (doc.settings || {}))) continue;
      const t = (doc.settingsT || {})[k] || 0;
      if (JSON.stringify(settings[k]) !== JSON.stringify(doc.settings[k])) (settings[k] = doc.settings[k], changed.push(k));
      if (t) settingsT[k] = t;
    }
    if (changed.length) {
      if (changed.includes('blacklist')) settings.blacklist = settings.blacklist || [];
      save('settings', settings);
    }
    save('settingsT', settingsT);
    boardList = Array.isArray(doc.boards) ? doc.boards : boardList;
    if (!boardList.some((b) => b.id === INBOX)) boardList.unshift({ id: INBOX, name: 'Pins', kind: 'pins', inbox: true, hue: 85, created: Date.now(), updated: Date.now(), posts: [] });
    subList = Array.isArray(doc.subs) ? doc.subs : subList;
    libList = Array.isArray(doc.library) ? doc.library : libList;
    trail = Array.isArray(doc.trail) ? doc.trail : trail;
    readList = doc.reading && typeof doc.reading === 'object' ? doc.reading : readList;
    tomb = { b: {}, bp: {}, s: {}, t: {}, l: {}, f: {}, tc: 0, ...(doc.tomb || {}) };
    folderList = Array.isArray(doc.folders) ? doc.folders : folderList;
    linkList = Array.isArray(doc.tagLinks) ? doc.tagLinks : linkList;
    save('tagLinks', linkList);
    save('folders', folderList); emit('folders');
    save('boards', boardList); save('subs', subList); save('library', libList); save('trail', trail); save('reading', readList); save('tomb', tomb);
    emit('boards'); emit('subs'); emit('library'); emit('trail');
    for (const k of changed) emit('settings', { key: k, value: settings[k] });
    return changed;
  },
  counts: () => ({ boards: boardList.length, pins: boardList.reduce((n, b) => n + (b.kind === 'pins' ? b.posts.length : 0), 0), follows: subList.length, library: libList.length, trail: trail.length }),
};
