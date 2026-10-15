import { $, h, fmtNum, pretty, debounce, copyText } from './util.js';
import { icon } from './icons.js';
import { S, setS, on, boards, subs, library, reading, history as trailStore, tagc } from './store.js';
import { refreshLib } from './library.js';
import { getProvider, providerList, Feed, catName } from './providers.js';
import { initTopo, paintTopo } from './bg.js';
import { Gallery } from './gallery.js';
import { SearchBar } from './search.js';
import { Viewer } from './viewer.js';
import { ComicReader } from './reader.js';
import { renderBoards, renderBoard, updateCover } from './boards.js';
import { renderTrail } from './trail.js';
import { renderFollows, refreshAll, follow } from './follows.js';
import { renderPoolView, renderPools, poolInfo, loadPool, poolKey, dtext as poolText } from './pools.js';
import { openSettings, closeSettings, showHelp } from './settings.js';
import { startAutoSync } from './sync.js';
import { startAutoUpdateCheck } from './updates.js';
import { toast, popover, closePopover, promptText } from './ui.js';
import { pinPopover, quickPin } from './pins.js';
import { downloadMany, selBar, openExternal, savePost } from './actions.js';
import * as actions from './actions.js';
import { initTitlebar, isNative, windowCommand } from './titlebar.js';
import { showMenu, bindContext, closeMenu, menuOpen } from './ctxmenu.js';
import { isPhone, isTouch, isAndroid, onLayout, native, onBack, haptic } from './platform.js';
import { M, postMenu, tagMenu } from './menus.js';

/* ================================================================== state */
let prov = getProvider(S('provider'));
const st = {
  terms: [], filters: null, feed: null, loaded: [], total: null, sig: null, loading: null,
  smartId: null, trailTs: 0, dossierOff: new Set(), isNew: null, followMarks: null,
};
let boardGal = null; // gallery of the board / pool view currently on screen
let viewerGal = null;
let viewerPushed = false;
let readerPushed = false;
let suppressClose = false;
let curPool = null; // {id, provId} of the pool view that is rendered
let navDepth = 0; // how many in-app screens are stacked behind this one (for the Back button)
const clone = (x) => JSON.parse(JSON.stringify(x));
const defaultFilters = () => ({ order: '', score: 0, ratings: { ...S('filters').ratings }, media: '', shape: '', age: '' });
const fSig = (f = {}) => JSON.stringify({ o: f.order || '', s: f.score || 0, r: ['s', 'q', 'e'].filter((k) => (f.ratings || { s: 1, q: 1, e: 1 })[k]).join(''), m: f.media || '', h: f.shape || '', a: f.age || '' });

/* ================================================================== shell */
const rail = $('#rail');
const NAV = [['roam', 'Roam', 'roam'], ['boards', 'Boards', 'boards'], ['follows', 'Follows', 'bell'], ['pools', 'Pools', 'book'], ['trail', 'Trail', 'trail']];
const dial = h('button', { class: 'dial', title: 'Switch source', onclick: () => providerMenu() });
const followBadge = h('b', { class: 'nav-badge', hidden: true });
const poolBadge = h('b', { class: 'nav-badge', hidden: true });

const markSvg = '<svg class="mark" viewBox="0 0 40 40" width="30" height="30"><rect x="2" y="2" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="20" cy="20" r="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 3"/><path d="M20 7 24 20 20 33 16 20z" fill="var(--accent)"/><circle cx="20" cy="20" r="2.2" fill="var(--bg)"/></svg>';
const appbarTitle = h('span', { class: 'ab-title' }, 'Roam');
const dialMini = h('button', { class: 'dial-mini', 'aria-label': 'Switch source', onclick: () => providerMenu() });
const tabBadge = h('b', { class: 'nav-badge', hidden: true });
const poolTabBadge = h('b', { class: 'nav-badge', hidden: true });
const appbar = h('header', { id: 'appbar' },
  h('a', { class: 'ab-brand', href: '#/roam', 'aria-label': 'Board Roamer', html: markSvg }), appbarTitle, h('div', { class: 'vw-spacer' }), dialMini,
  h('button', { class: 'ibtn', 'aria-label': 'Cloak the screen', onclick: () => toggleCloak(), html: icon('cloak', 21) }),
  h('button', { class: 'ibtn', 'aria-label': 'Settings', onclick: () => openSettings(), html: icon('settings', 21) }));
const tabbar = h('nav', { id: 'tabbar', 'aria-label': 'Sections' }, h('i', { class: 'tab-ind' }),
  NAV.map(([id, label, ic]) => h('a', { class: 'tab', href: '#/' + id, 'data-view': id }, h('span', { class: 'tab-ic', html: icon(ic, 23) }), h('span', { class: 'tab-t' }, label), id === 'follows' ? tabBadge : id === 'pools' ? poolTabBadge : null)));
const fab = h('button', { class: 'fab', hidden: true, 'aria-label': 'Back to top', onclick: () => document.querySelector('#v-roam:not([hidden]) .gal, #v-other:not([hidden]) .gal, #v-other:not([hidden])')?.scrollTo({ top: 0, behavior: 'smooth' }), html: icon('up', 22) });
const ptr = h('div', { class: 'ptr', 'aria-hidden': 'true', html: icon('refresh', 20) });
document.body.append(appbar, tabbar, fab);

function buildRail() {
  rail.append(
    h('a', { class: 'brand', href: '#/roam', title: 'Board Roamer' },
      h('svg', { class: 'mark', viewBox: '0 0 40 40', width: 34, height: 34, html: '<rect x="2" y="2" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="20" cy="20" r="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 3"/><path class="needle" d="M20 7 24 20 20 33 16 20z" fill="var(--accent)"/><circle cx="20" cy="20" r="2.2" fill="var(--bg)"/>' }),
      h('span', { class: 'brand-name' }, 'BOARD', h('i', {}, '/'), 'ROAMER')),
    h('div', { class: 'nav' },
      h('i', { class: 'nav-ind' }),
      NAV.map(([id, label, ic], n) => h('a', { class: 'nav-i', href: '#/' + id, 'data-view': id, title: `${label} (${n + 1})` }, h('span', { class: 'ni-ic', html: icon(ic, 21) }), h('span', { class: 'ni-t' }, label), id === 'follows' ? followBadge : id === 'pools' ? poolBadge : null))),
    h('div', { class: 'rail-spacer' }),
    dial,
    h('button', { class: 'ibtn', title: 'Cloak screen (`)', html: icon('cloak', 20), onclick: toggleCloak }),
    h('button', { class: 'ibtn', title: 'Settings (,)', html: icon('settings', 20), onclick: () => openSettings() }),
  );
}

function paintPoolBadge() {
  const n = library.unseen();
  for (const b of [poolBadge, poolTabBadge]) {
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : n;
  }
}

function paintFollowBadge() {
  const n = subs.unseen();
  for (const b of [followBadge, tabBadge]) {
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : n;
  }
}

function paintDial() {
  dial.style.setProperty('--ph', prov.color);
  dial.innerHTML = `<span class="dial-ring"></span><b>${prov.short}</b><small>${prov.name}</small>`;
  dial.classList.toggle('adult', prov.adult);
  dialMini.style.setProperty('--ph', prov.color);
  dialMini.innerHTML = `<b>${prov.short}</b>`;
}

function providerMenu() {
  const box = h('div', { class: 'provmenu' }, h('div', { class: 'pm-head' }, h('b', {}, 'Source')),
    providerList.map((p) => h('button', { class: 'pv-row' + (p.id === prov.id ? ' on' : ''), style: `--ph:${p.color}`, onclick: () => { closePopover(); setProvider(p.id); } },
      h('i', { class: 'prov-dot' }, p.short), h('div', {}, h('b', {}, p.name), h('small', {}, p.sub)), p.needsKey ? h('em', { html: icon('tag', 12) }) : null)),
    h('button', { class: 'pv-row link', onclick: () => (closePopover(), openSettings('source')) }, h('i', { html: icon('settings', 14) }), h('div', {}, h('b', {}, 'Accounts & keys…'))));
  popover(dial, box, { align: 'left', cls: 'prov-pop' });
}

const NAV_OF = { board: 'boards', pool: 'pools' };
function setActiveNav(view) {
  const key = NAV_OF[view] || view;
  const items = [...rail.querySelectorAll('.nav-i')];
  items.forEach((a) => a.classList.toggle('on', a.dataset.view === key));
  const i = items.findIndex((a) => a.dataset.view === key);
  rail.querySelector('.nav').style.setProperty('--i', Math.max(0, i));
  tabbar.style.setProperty('--i', Math.max(0, i));
  tabbar.querySelectorAll('.tab').forEach((a) => a.classList.toggle('on', a.dataset.view === key));
  appbarTitle.textContent = { roam: 'Roam', boards: 'Boards', board: 'Board', follows: 'Follows', pools: 'Pools', pool: 'Pool', trail: 'Trail' }[view] || 'Roam';
}

/* ================================================================== roam view */
const roam = $('#v-roam'), other = $('#v-other'), strip = $('#strip');
const scroller = h('div', { class: 'gal' });
const status = h('div', { class: 'status' });
const routesEl = h('div', { class: 'routes' });
const dossierEl = h('div', { class: 'dossier-host' });
const boardBar = h('div', { class: 'boardbar', hidden: true });
const layoutSeg = h('div', { class: 'layout-seg' }, [['masonry', 'masonry'], ['rows', 'rows'], ['grid', 'grid']].map(([v, ic]) =>
  h('button', { 'data-v': v, title: v[0].toUpperCase() + v.slice(1) + ' layout', html: icon(ic, 17), onclick: () => setS('layout', v) })));
const sizeSlider = h('input', { type: 'range', min: 130, max: 520, step: 10, title: 'Tile size', value: S('density'), oninput: debounce((e) => setS('density', +e.target.value), 60) });
const selBtn = h('button', { class: 'ibtn', title: 'Select posts (S)', 'aria-label': 'Select posts', html: icon('select', 18), onclick: () => toggleSelect() });
const layoutBtn = h('button', { class: 'ibtn layout-cycle', title: 'Change layout', 'aria-label': 'Change layout', onclick: () => { const o = ['masonry', 'rows', 'grid']; setS('layout', o[(o.indexOf(S('layout')) + 1) % o.length]); } });
const topBtn = h('button', { class: 'ibtn top-btn', title: 'Back to top', html: icon('up', 18), onclick: () => scroller.scrollTo({ top: 0, behavior: 'smooth' }) });

const gal = new Gallery(scroller, {
  onOpen: (vi, tile) => openViewer(gal, vi, tile),
  onNeedMore: () => loadMore(),
  onPin: (ps) => quickPin(ps),
  onOpenSite: (p) => openExternal(p.url),
  onSelect: (n) => bar.update(n),
});
const bar = selBar(gal, [
  { label: 'Pin', icon: 'pin', run: (sel, el) => pinPopover(el, sel) },
  { label: 'Download', icon: 'download', run: (sel) => downloadMany(sel) },
]);
roam.append(
  h('div', { class: 'tbar' }, status, h('div', { class: 'tools' }, layoutBtn, layoutSeg, sizeSlider, selBtn, topBtn)),
  ptr, boardBar, routesEl, dossierEl, scroller, bar);

function toggleSelect() {
  const cur = currentGallery();
  if (cur) cur.setSelectMode(!cur.selectMode);
  selBtn.classList.toggle('on', !!cur?.selectMode);
}
const currentGallery = () => (parseHash().view === 'roam' ? gal : boardGal);

/* ---------- search bar */
const searchBar = new SearchBar(strip, {
  getProv: () => prov,
  onRun: (terms) => navigateRoam({ terms }),
  onFilters: (f) => {
    setS('filters', { ...S('filters'), ratings: f.ratings });
    navigateRoam({ filters: f });
  },
  onRoll: () => navigateRoam({ filters: { ...st.filters, order: 'random' } }),
  onSaveBoard: (btn) => saveBoardMenu(btn),
  onEdit: () => updateBoardBar(),
  onTagLearned: () => {},
  tagMenu: (tag, cat) => tagMenu(tag, cat, prov.id),
});

/* ================================================================== routing */
function parseTerms(q) {
  return q.split(/\s+/).filter(Boolean).map((tok) => {
    const op = tok[0] === '-' ? '-' : tok[0] === '~' ? '~' : '+';
    return { t: op === '+' ? tok : tok.slice(1), op };
  }).filter((t) => t.t);
}
const termsStr = (terms) => terms.map((t) => (t.op === '+' ? '' : t.op) + t.t).join(' ');

function parseFilters(p) {
  const f = defaultFilters();
  if (p.has('o')) f.order = p.get('o');
  if (p.has('ms')) f.score = +p.get('ms') || 0;
  if (p.has('r')) f.ratings = { s: p.get('r').includes('s'), q: p.get('r').includes('q'), e: p.get('r').includes('e') };
  if (p.has('md')) f.media = p.get('md');
  if (p.has('sh')) f.shape = p.get('sh');
  if (p.has('ag')) f.age = p.get('ag');
  if (!Object.values(f.ratings).some(Boolean)) f.ratings = { s: true, q: true, e: true };
  return f;
}

function parseHash() {
  const raw = location.hash.slice(1) || '/roam';
  const [path, qstr = ''] = raw.split('?');
  const seg = path.split('/').filter(Boolean);
  return { view: seg[0] || 'roam', id: seg[1], p: new URLSearchParams(qstr) };
}

function roamHash(terms, filters, provId, post) {
  const p = new URLSearchParams();
  p.set('p', provId);
  if (terms.length) p.set('q', termsStr(terms));
  if (filters.order) p.set('o', filters.order);
  if (filters.score > 0) p.set('ms', filters.score);
  const r = ['s', 'q', 'e'].filter((k) => filters.ratings[k]).join('');
  if (r !== 'sqe') p.set('r', r);
  if (filters.media) p.set('md', filters.media);
  if (filters.shape) p.set('sh', filters.shape);
  if (filters.age) p.set('ag', filters.age);
  if (post) p.set('post', post);
  return '#/roam?' + p.toString();
}

function navigateRoam({ terms = st.terms, filters = st.filters, provider = prov.id } = {}) {
  viewerPushed = false;
  const next = roamHash(terms, filters, provider);
  const cur = parseHash();
  if (location.hash === next || (cur.view === 'roam' && roamHash(st.terms, st.filters, prov.id) === next && !cur.p.get('post'))) {
    st.terms = clone(terms);
    st.filters = clone(filters);
    return startSearch();
  }
  location.hash = next;
}

const go = (hash) => (location.hash = hash);

function showView(name) {
  const isRoam = name === 'roam';
  roam.hidden = !isRoam;
  other.hidden = isRoam;
  strip.hidden = !isRoam;
  document.body.dataset.view = name;
  if (isRoam) requestAnimationFrame(() => gal.render());
}

const viewCtx = () => ({ go, refresh: applyRoute, runSmart, openViewer, runEntry, saveSmart: saveSmartFromEntry, provId: prov.id, readPool, openFollow, feedOf });

function applyRoute() {
  const { view, id, p } = parseHash();
  setActiveNav(view);
  closePopover();
  closeMenu();
  if (view !== 'pool') curPool = null;
  if (view === 'roam') {
    boardGal = null;
    handleRead(null);
    showView('roam');
    const pid = p.get('p');
    if (pid && pid !== prov.id) setProvider(pid, false);
    const terms = parseTerms(p.get('q') || '');
    const filters = parseFilters(p);
    const sig = JSON.stringify([prov.id, terms, filters]);
    if (sig !== st.sig) {
      st.terms = terms;
      st.filters = filters;
      startSearch();
    }
    handlePost(p.get('post'), gal);
    document.title = terms.length ? `${terms.map((t) => pretty(t.t)).slice(0, 3).join(', ')} — Board Roamer` : 'Board Roamer';
    return;
  }
  showView(view);
  st.smartId = null; // leaving Roam ends the "you are inside this board" state
  document.title = 'Board Roamer';
  const ctx = viewCtx();
  if (view === 'pool') {
    const provId = p.get('p') || prov.id;
    if (curPool?.id === id && boardGal) {
      handleRead(p.get('read'), id, provId);
      handlePost(p.get('post'), boardGal);
      return;
    }
    boardGal = null;
    curPool = { id, provId };
    renderPoolView(other, id, { ...ctx, provId }).then((g) => {
      if (!g || parseHash().id !== id || parseHash().view !== 'pool') return;
      boardGal = g;
      const q = parseHash().p;
      handleRead(q.get('read'), id, provId);
      handlePost(q.get('post'), g);
    });
    return;
  }
  handleRead(null);
  if (view === 'boards') (boardGal = null), renderBoards(other, ctx);
  else if (view === 'board') {
    const g = renderBoard(other, id, ctx);
    boardGal = g;
    if (g) requestAnimationFrame(() => handlePost(p.get('post'), g));
  } else if (view === 'trail') (boardGal = null), renderTrail(other, ctx);
  else if (view === 'follows') (boardGal = null), renderFollows(other, ctx);
  else if (view === 'pools') (boardGal = null), renderPools(other, ctx);
  if (view !== 'board') handlePost(null);
}

async function handlePost(postId, g) {
  if (!postId) {
    if (viewer.isOpen) {
      suppressClose = true;
      viewer.close();
      suppressClose = false;
      viewerPushed = false;
    }
    return;
  }
  if (viewer.isOpen && String(viewer.post?.id) === postId) return;
  const list = g ? g.viewList() : [];
  const idx = list.findIndex((p) => String(p.id) === postId);
  viewerGal = g;
  if (idx >= 0) return viewer.open(list, idx, null), poolRoot(g);
  if (g === gal) {
    try {
      const post = await prov.post(postId);
      if (post) viewer.open([post], 0);
      else toast('That post could not be found', { kind: 'err' });
    } catch (e) {
      toast(e.message, { kind: 'err' });
    }
  }
}

/** When the viewer is opened from a pool page, tell it which pool it is stepping through. */
function poolRoot(g, opts) {
  const meta = opts || (g?.pool && { pool: g.pool.pool, kind: g.pool.kind });
  if (!meta) return;
  viewer.poolCtx = { id: meta.pool.id, name: meta.pool.name, kind: meta.kind, root: true };
  viewer._renderPoolBar(viewer._tok);
}

/* ================================================================== viewer wiring */
const viewer = new Viewer($('#viewer'), {
  onNeedMore: async () => {
    if (viewerGal === gal) {
      await loadMore();
      viewer.setList(gal.viewList());
    }
  },
  onNavigate: (post, i) => {
    if (!viewerGal) return;
    const { p } = parseHash();
    p.set('post', post.id);
    const [path] = location.hash.slice(1).split('?');
    history.replaceState(history.state, '', '#' + path + '?' + p.toString());
    const idx = viewerGal.itemIndexOfView(i);
    if (idx >= 0 && !viewer.poolCtx?.id) viewerGal.scrollTo(idx);
  },
  onClose: () => {
    if (suppressClose) return;
    if (viewerPushed) {
      viewerPushed = false;
      history.back();
    } else {
      const { p } = parseHash();
      if (p.has('post')) {
        p.delete('post');
        const [path] = location.hash.slice(1).split('?');
        history.replaceState(history.state, '', '#' + path + (p.toString() ? '?' + p.toString() : ''));
      }
    }
  },
  onTag: (tag, mode) => tagAction(tag, mode, viewer.post?.provider),
  isStarred: (t, pv) => isStarred(t, getProvider(pv || prov.id)),
  onStar: (t, pv) => toggleStar(t, getProvider(pv || prov.id)),
  isFollowing: (t, pv) => isFollowing(t, pv),
  onFollow: (t, pv) => toggleFollow(t, pv),
  onPinChange: () => refreshMarks(),
  onHelp: showHelp,
  savePost: (p) => saveOne(p),
  postMenu: (p, o) => postMenu(p, o),
  tagMenu: (t, c, pv) => tagMenu(t, c, pv),
  poolInfo: (pv, id) => poolInfo(pv, id),
  enterPool: (id, postId) => enterPool(id, postId, viewer.post?.provider),
  openPoolPage: (id) => { const pv = viewer.post?.provider || prov.id; if (viewer.isOpen) closeViewerQuiet(); go(`#/pool/${id}?p=${pv}`); },
  readPool: (id, postId) => readPool(id, postId, viewer.post?.provider),
});
on('pins-changed', () => { refreshMarks(); });
function refreshMarks() {
  gal.refreshMarks();
  boardGal?.refreshMarks();
}
function closeViewerQuiet() {
  suppressClose = true;
  viewer.close();
  suppressClose = false;
  viewerPushed = false;
}

async function saveOne(p) {
  const t = toast('Saving…', { ms: 20000 });
  try {
    const path = await savePost(p);
    t();
    const how = { embedded: ' · tags & source embedded', sidecar: ' · tags saved in a .xmp beside it' }[actions.lastMeta] || '';
    toast('Saved to Downloads\\Board Roamer' + how, { action: { label: 'Show', run: () => fetch('/open?reveal=' + encodeURIComponent(path), { method: 'POST' }) }, ms: 5000 });
  } catch (e) {
    t();
    toast('Download failed: ' + e.message, { kind: 'err' });
  }
}

function openViewer(g, viewIndex, tileEl, slideshow = false, poolOpts = null) {
  const list = g.viewList();
  if (!list[viewIndex]) return;
  viewerGal = g;
  const rect = tileEl ? tileEl.getBoundingClientRect() : null;
  const { p } = parseHash();
  p.set('post', list[viewIndex].id);
  const [path] = location.hash.slice(1).split('?');
  history.pushState({ n: ++navDepth }, '', '#' + path + '?' + p.toString());
  viewerPushed = true;
  viewer.open(list, viewIndex, rect);
  poolRoot(g, poolOpts);
  if (slideshow) setTimeout(() => viewer.startSlideshow(), 400);
}

/* ---------- stars & follows */
const isStarred = (tag, p = prov) => (S('starred') || []).some((x) => x.p === (typeof p === 'string' ? getProvider(p) : p).credKey && x.t === tag);
function toggleStar(tag, p = prov) {
  p = typeof p === 'string' ? getProvider(p) : p;
  const list = [...(S('starred') || [])];
  const i = list.findIndex((x) => x.p === p.credKey && x.t === tag);
  if (i >= 0) list.splice(i, 1);
  else list.unshift({ p: p.credKey, t: tag, cat: tagc.get(p.id, tag)?.cat || 'general' });
  setS('starred', list);
  toast(i >= 0 ? `Unstarred ${pretty(tag)}` : `Starred ${pretty(tag)} — it shows up when you focus the search box`, { ms: 1800 });
}
const isFollowing = (tag, pv) => !!subs.find(getProvider(pv || prov.id).credKey, tag);
const toggleFollow = (tag, pv) => follow(tag, pv || prov.id);

function tagAction(tag, mode, provId) {
  if (!tag) return;
  const vp = provId || viewer.post?.provider || prov.id;
  if (viewer.isOpen) closeViewerQuiet();
  if (reader.isOpen) closeReaderQuiet();
  viewerPushed = false;
  let terms = mode === 'only' ? [] : clone(st.terms);
  if (vp !== prov.id && mode !== 'only') terms = [];
  const i = terms.findIndex((t) => t.t === tag);
  const op = mode === 'exclude' ? '-' : '+';
  if (i >= 0) terms[i].op = op;
  else terms.push({ t: tag, op });
  if (vp !== prov.id) setProvider(vp, false);
  const filters = mode === 'only' ? { ...st.filters, order: st.filters.order === 'random' ? '' : st.filters.order } : st.filters;
  const next = roamHash(terms, filters, vp);
  if (location.hash === next) return navigateRoam({ terms, filters, provider: vp });
  location.hash = next;
}

/* ---------- menus need to reach back into the app */
Object.assign(M, {
  tagAction: (t, m, pv) => tagAction(t, m, pv),
  toggleStar: (t, pv) => toggleStar(t, pv),
  toggleFollow: (t, pv) => toggleFollow(t, pv),
  isStarred: (t, pv) => isStarred(t, pv),
  isFollowing: (t, pv) => isFollowing(t, pv),
  enterPool: (id, postId, pv) => enterPool(id, postId, pv),
  openPoolPage: (id, pv) => go(`#/pool/${id}?p=${pv || prov.id}`),
  readPool: (id, postId, pv) => readPool(id, postId, pv),
});

/* ================================================================== pools & the comic reader */
async function enterPool(id, postId, provId) {
  const pv = getProvider(provId || prov.id);
  const t = toast('Loading pool…', { ms: 30000 });
  try {
    const { pool, posts, kind } = await loadPool(pv, id);
    t();
    if (!posts.length) return toast('That pool has no visible pages', { kind: 'err' });
    if (viewer.isOpen) return viewer.enterPool(pool, posts, postId, kind);
    viewerGal = null;
    viewer.open(posts, Math.max(0, posts.findIndex((x) => x.id === postId)), null);
    poolRoot(null, { pool, kind });
  } catch (e) {
    t();
    toast(e.message, { kind: 'err' });
  }
}

const reader = new ComicReader($('#reader'), {
  onClose: () => {
    if (suppressReader) return;
    if (readerPushed) {
      readerPushed = false;
      history.back();
    } else {
      const { p } = parseHash();
      if (p.has('read')) {
        p.delete('read');
        const [path] = location.hash.slice(1).split('?');
        history.replaceState(history.state, '', '#' + path + (p.toString() ? '?' + p.toString() : ''));
      }
    }
  },
  onPage: (i) => {
    const { p } = parseHash();
    if (!p.has('read') || p.get('read') === String(i)) return;
    p.set('read', i);
    const [path] = location.hash.slice(1).split('?');
    history.replaceState(history.state, '', '#' + path + '?' + p.toString());
  },
  savePost: (p) => saveOne(p),
  openInViewer: (post, i) => {
    closeReaderQuiet();
    if (boardGal) {
      const vi = boardGal.viewList().findIndex((x) => x.id === post.id);
      if (vi >= 0) return openViewer(boardGal, vi, null, false, { pool: reader.pool, kind: reader.kind });
    }
    enterPool(reader.pool.id, post.id, reader.prov.id);
  },
});
let suppressReader = false;
function closeReaderQuiet() {
  suppressReader = true;
  reader.close();
  suppressReader = false;
  readerPushed = false;
}

/** Open the reader for a pool. Navigates to the pool page first so Back returns to where you were. */
function readPool(id, postId, provId) {
  const pv = provId || prov.id;
  if (viewer.isOpen) closeViewerQuiet();
  readerPushed = true;
  const q = postId ? 'p' + postId : 'resume';
  location.hash = `#/pool/${id}?p=${pv}&read=${q}`;
}

async function handleRead(read, id, provId) {
  if (!read) {
    if (reader.isOpen) closeReaderQuiet();
    return;
  }
  if (reader.isOpen && String(reader.pool?.id) === String(id)) return;
  const pv = getProvider(provId || prov.id);
  try {
    const { pool, posts, kind } = await loadPool(pv, id);
    if (!posts.length) return toast('That pool has no visible pages', { kind: 'err' });
    if (parseHash().p.get('read') == null) return; // closed while loading
    let index = 0;
    if (read === 'resume') index = reading.get(poolKey(pv, id))?.i || 0;
    else if (read.startsWith('p')) index = Math.max(0, posts.findIndex((x) => String(x.id) === read.slice(1)));
    else index = +read || 0;
    reader.open({ pool, posts, index, key: poolKey(pv, id), prov: pv, kind });
    if (read === 'resume' || read.startsWith('p')) reader.hooks.onPage(index);
  } catch (e) {
    toast(e.message, { kind: 'err' });
  }
}

/* ================================================================== searching */
function setFoot(kind, extra) {
  if (kind === 'none') return gal.setFoot(null);
  if (kind === 'loading') {
    const skel = gal.length === 0 ? h('div', { class: 'skeleton' }, Array.from({ length: 18 }, (_, i) => h('i', { style: `height:${150 + ((i * 53) % 170)}px;animation-delay:${i * 60}ms` }))) : null;
    return gal.setFoot([skel, h('div', { class: 'foot-load' }, h('i'), h('i'), h('i'), h('span', {}, 'charting…'))].filter(Boolean));
  }
  if (kind === 'end') return gal.setFoot(h('div', { class: 'foot-end' }, h('i', { html: icon('compass', 18) }), `End of the trail · ${fmtNum(st.loaded.length)} posts`));
  if (kind === 'empty') {
    return gal.setFoot(h('div', { class: 'empty-state' },
      h('div', { class: 'es-art', html: icon('compass', 72) }),
      h('h2', {}, 'Nothing on this map'),
      h('p', {}, st.terms.length ? 'No posts matched. Try removing a tag, loosening the filters, or checking the spelling.' : 'No results.'),
      h('div', { class: 'row-btns center' },
        st.terms.length ? h('button', { class: 'btn', onclick: () => navigateRoam({ terms: st.terms.slice(0, -1) }) }, `Drop “${pretty(st.terms[st.terms.length - 1].t)}”`) : null,
        searchBar.activeFilterCount() ? h('button', { class: 'btn', onclick: () => navigateRoam({ filters: defaultFilters() }) }, 'Reset filters') : null,
        h('button', { class: 'btn primary', onclick: () => navigateRoam({ terms: [], filters: defaultFilters() }) }, 'Start over'))));
  }
  if (kind === 'error') {
    const e = extra;
    return gal.setFoot(h('div', { class: 'empty-state err' },
      h('div', { class: 'es-art', html: icon('info', 56) }),
      h('h2', {}, 'The signal dropped'),
      h('p', {}, e.message || String(e)),
      h('div', { class: 'row-btns center' },
        h('button', { class: 'btn primary', onclick: () => loadMore() }, 'Retry'),
        /key|credential|auth|401|403/i.test(e.message || '') ? h('button', { class: 'btn', onclick: () => openSettings('source') }, 'Open settings') : null)));
  }
}

async function startSearch() {
  const filters = clone(st.filters);
  st.sig = JSON.stringify([prov.id, st.terms, filters]);
  const feed = new Feed(prov, clone(st.terms), filters);
  st.feed = feed;
  st.loaded = [];
  st.total = null;
  st.loading = null;
  gal.setSelectMode(false);
  gal.clear();
  gal.isNew = st.isNew; // "NEW" markers when this feed was opened from Follows
  const marks = st.followMarks;
  st.isNew = null;
  st.followMarks = null;
  searchBar.setTerms(st.terms);
  searchBar.setFilters(filters);
  paintDial();
  renderRoutes();
  updateBoardBar();
  dossierEl.replaceChildren();
  updateStatus();
  setFoot('loading');
  trailStore.push({ provider: prov.id, terms: clone(st.terms), filters: clone(filters), thumbs: [] });
  st.trailTs = trailStore.all()[0]?.ts;
  if (prov.count) prov.count(feed.tags).then((n) => feed === st.feed && ((st.total = n), updateStatus())).catch(() => {});
  await loadMore();
  if (feed === st.feed) {
    marks?.forEach((id) => subs.markSeen(id)); // you've now seen what was new
    renderDossier(); // artist/wiki lookups wait until the posts are on screen
  }
}

function loadMore() {
  const feed = st.feed;
  if (!feed || feed.done) return st.loading || Promise.resolve();
  if (st.loading) return st.loading;
  const run = (async () => {
    setFoot('loading');
    try {
      const first = !st.loaded.length;
      const posts = await feed.next();
      if (feed !== st.feed) return;
      st.loaded.push(...posts);
      gal.append(posts);
      if (feed.total != null) st.total = feed.total;
      if (first && posts.length) {
        trailStore.update(st.trailTs, { thumbs: posts.slice(0, 4).map((p) => p.thumb) });
        const sb = boards.get(st.smartId);
        if (sb && JSON.stringify(sb.terms) === JSON.stringify(st.terms)) updateCover(st.smartId, posts);
      }
      updateStatus();
      if (feed.done) setFoot(st.loaded.length ? 'end' : 'empty');
      else setFoot('none');
    } catch (e) {
      if (feed === st.feed) setFoot('error', e);
    } finally {
      if (feed === st.feed) st.loading = null;
      requestAnimationFrame(() => gal.render());
    }
  })();
  st.loading = run;
  return run;
}

function updateStatus() {
  const single = st.terms.length === 1 && st.terms[0].op === '+' ? tagc.get(prov.id, st.terms[0].t) : null;
  const total = st.total ?? (single?.count ? single.count : null);
  status.replaceChildren(...[
    h('span', { class: 'odo' }, fmtNum(st.loaded.length)),
    h('span', { class: 'st-l' }, ' loaded'),
    total ? h('span', { class: 'st-t' }, ` · ${st.total == null ? '≈' : ''}${fmtNum(total)} on ${prov.name}`) : null,
    gal.hiddenCount ? h('span', { class: 'st-h' }, ` · ${gal.hiddenCount} hidden by blacklist`) : null,
    st.feed?.busy ? h('i', { class: 'spin' }) : null,
  ].filter(Boolean));
  layoutSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === S('layout')));
  layoutBtn.innerHTML = icon(S('layout'), 20);
}

/* ---------- quick routes */
const ROUTES = [
  ['Latest', 'clock', {}],
  ['Hot today', 'flame', { order: 'score', age: 'day' }],
  ['Hot this week', 'flame', { order: 'score', age: 'week' }],
  ['Hot this month', 'flame', { order: 'score', age: 'month' }],
  ['All-time top', 'star', { order: 'score' }],
  ['Most faved', 'heart', { order: 'favcount' }],
  ['Shuffle', 'dice', { order: 'random' }],
  ['Animated', 'video', { media: 'animated', order: 'score' }],
];

function renderRoutes() {
  const f = st.filters;
  const chips = ROUTES.filter(([, , o]) => (!o.age || prov.ages) && (!o.media || prov.media) && (!o.order || prov.sorts.some(([v]) => v === o.order))).map(([label, ic, o]) => {
    const active = (f.order || '') === (o.order || '') && (f.age || '') === (o.age || '') && (f.media || '') === (o.media || '');
    return h('button', { class: 'route' + (active ? ' on' : ''), html: icon(ic, 14) + `<span>${label}</span>`, onclick: () => navigateRoam({ filters: { ...f, order: o.order || '', age: o.age || '', media: o.media || '' } }) });
  });
  const mine = subs.all().filter((x) => x.p === prov.credKey);
  if (mine.length && prov.maxTags >= 6) {
    const fresh = mine.reduce((n, x) => n + (x.newCount || 0), 0);
    chips.push(h('button', { class: 'route follow', title: 'Everything from the artists you follow', html: icon('bell', 14) + `<span>Following · ${mine.length}${fresh ? ` · ${fresh} new` : ''}</span>`, onclick: () => feedOf(mine) }));
  }
  const smart = boards.all().filter((b) => b.kind === 'smart').slice(0, 8).map((b) =>
    h('button', { class: 'route smart', 'data-board': b.id, style: `--bh:${b.hue}`, title: 'Live board', onclick: () => runSmart(b), html: icon('compass', 14) + `<span>${b.name.replace(/</g, '&lt;')}</span>` }));
  routesEl.replaceChildren(...chips, ...(smart.length ? [h('i', { class: 'route-sep' })] : []), ...smart);
}
on('boards', () => { if (!roam.hidden) renderRoutes(); updateBoardBar(); });
on('subs', () => { paintFollowBadge(); if (!roam.hidden) renderRoutes(); });
on('library', paintPoolBadge);

bindContext(routesEl, (e) => {
  const el = e.target.closest('.route');
  if (!el) return null;
  const b = boards.get(el.dataset.board);
  if (b) return [
    { header: b.name },
    { label: 'Run this board', icon: 'compass', run: () => runSmart(b) },
    { label: 'Rename', icon: 'edit', run: async () => { const n = await promptText('Rename board', b.name); if (n) boards.update(b.id, { name: n }); } },
    { label: 'Show in Boards', icon: 'boards', run: () => go('#/boards') },
    { sep: true },
    { label: 'Delete board', icon: 'trash', danger: true, run: () => (boards.remove(b.id), toast(`Deleted “${b.name}”`, { ms: 1400 })) },
  ];
  return [{ label: 'Run', icon: 'compass', run: () => el.click() }, { label: 'Save as live board', icon: 'save', run: () => saveSmart() }];
});

/* ---------- following feed & opening one followed artist */
function feedOf(list) {
  const first = list[0];
  if (!first) return;
  const pv = getProvider(first.p);
  const same = list.filter((x) => x.p === first.p);
  const pick = same.slice(0, Math.max(1, Math.min(35, pv.maxTags - 3)));
  const seen = new Map(pick.map((x) => [x.t, x.seenId]));
  st.isNew = (post) => post.artists.some((a) => seen.has(a) && post.id > seen.get(a));
  st.followMarks = pick.map((x) => x.id);
  if (same.length > pick.length) toast(`Showing ${pick.length} of ${same.length} — ${pv.name} limits how many tags one search can have`, { ms: 3200 });
  st.smartId = null;
  navigateRoam({ terms: pick.map((x) => ({ t: x.t, op: pick.length === 1 ? '+' : '~' })), filters: { ...defaultFilters(), order: '' }, provider: pv.id });
}

function openFollow(f) {
  const pv = getProvider(f.p);
  const before = f.seenId;
  st.isNew = (post) => post.id > before;
  st.followMarks = [f.id];
  st.smartId = null;
  navigateRoam({ terms: [{ t: f.t, op: '+' }], filters: defaultFilters(), provider: pv.id });
}

/* ---------- dossier */
async function renderDossier() {
  const real = st.terms.filter((t) => !t.t.includes(':'));
  const pos = real.filter((t) => t.op === '+');
  if (pos.length !== 1 || real.some((t) => t.op === '~') || st.dossierOff.has(prov.id + pos[0]?.t)) return dossierEl.replaceChildren();
  const name = pos[0].t;
  const feedAt = st.feed;
  let info = tagc.get(prov.id, name);
  const card = h('div', { class: 'dossier cut' });
  let lastExtra = {};
  const paint = (extra = {}) => {
    lastExtra = extra;
    const cat = info?.cat || 'general';
    const artist = cat === 'artist';
    const on = artist ? isFollowing(name) : isStarred(name);
    card.className = `dossier cut cat-${cat}`;
    card.dataset.tag = name;
    card.dataset.cat = cat;
    card.replaceChildren(
      h('div', { class: 'ds-head' },
        h('span', { class: 'ds-kick' }, catName(cat)),
        h('h2', {}, pretty(name)),
        info?.count ? h('span', { class: 'ds-n' }, `${fmtNum(info.count)} posts`) : null),
      h('div', { class: 'ds-body' },
        extra.aka?.length ? h('p', { class: 'ds-aka' }, 'aka ', extra.aka.map(pretty).join(' · ')) : null,
        extra.group ? h('p', { class: 'ds-aka' }, 'group ', extra.group) : null,
        extra.urls?.length ? h('div', { class: 'ds-links' }, extra.urls.slice(0, 8).map((u) => h('a', { href: '#', title: u, onclick: (e) => (e.preventDefault(), openExternal(u)), oncontextmenu: (e) => (e.preventDefault(), e.stopPropagation(), showMenu(e.clientX, e.clientY, [{ label: 'Open in browser', icon: 'external', run: () => openExternal(u) }, { label: 'Copy link', icon: 'copy', run: () => copyText(u) }])) }, new URL(u).hostname.replace(/^www\./, ''), h('i', { html: icon('external', 11) })))) : null,
        extra.wiki ? h('p', { class: 'ds-wiki' }, extra.wiki) : null),
      h('div', { class: 'ds-act' },
        artist
          ? h('button', { class: 'btn' + (on ? ' primary' : ''), onclick: () => (toggleFollow(name), paint(lastExtra)), html: icon(on ? 'bellOn' : 'bell', 15) + `<span>${on ? 'Following' : 'Follow'}</span>` })
          : h('button', { class: 'btn' + (on ? ' primary' : ''), onclick: () => (toggleStar(name), paint(lastExtra)), html: icon('star', 15) + `<span>${on ? 'Starred' : 'Star'}</span>` }),
        h('button', { class: 'btn', onclick: () => saveBoardMenu(), html: icon('save', 15) + '<span>Save as board</span>' }),
        h('button', { class: 'ibtn', title: 'Dismiss', html: icon('close', 16), onclick: () => (st.dossierOff.add(prov.id + name), dossierEl.replaceChildren()) })));
  };
  dossierEl.replaceChildren(card);
  paint();
  try {
    if (!info && prov.tagInfo) {
      info = await prov.tagInfo(name);
      if (info) tagc.set(prov.id, name, info);
    }
    if (feedAt !== st.feed) return;
    paint();
    const extra = {};
    if (info?.cat === 'artist' && prov.artist) {
      const a = await prov.artist(name);
      if (a) Object.assign(extra, { aka: a.other, group: a.group, urls: a.urls.filter((u) => /^https?:/.test(u)) });
    } else if (prov.wiki && info) {
      const w = await prov.wiki(name);
      if (w) {
        const t = poolText(w).replace(/\s*\*\s+/g, ' · ').replace(/\s+/g, ' ');
        extra.wiki = t.slice(0, 320) + (t.length > 320 ? '…' : '');
      }
    }
    if (feedAt === st.feed) paint(extra);
  } catch {}
}
bindContext(dossierEl, () => {
  const c = dossierEl.firstChild;
  return c?.dataset.tag ? tagMenu(c.dataset.tag, c.dataset.cat, prov.id) : null;
});

/* ---------- live boards (saved searches) */
function updateBoardBar() {
  const b = boards.get(st.smartId);
  if (!b || b.kind !== 'smart') {
    st.smartId = null;
    return void (boardBar.hidden = true);
  }
  const terms = searchBar.terms.length || !st.terms.length ? searchBar.terms : st.terms;
  if (!terms.length && !searchBar.activeFilterCount()) { // everything was cleared: this is a new search, not the board any more
    st.smartId = null;
    return void (boardBar.hidden = true);
  }
  const same = JSON.stringify(b.terms) === JSON.stringify(terms) && b.provider === prov.id && fSig(b.filters) === fSig(st.filters);
  boardBar.style.setProperty('--bh', b.hue);
  boardBar.replaceChildren(
    h('i', { class: 'bb-ic', html: icon('compass', 17) }),
    h('span', { class: 'bb-k' }, 'LIVE BOARD'),
    h('b', { class: 'bb-name' }, b.name),
    same ? h('span', { class: 'bb-ok', html: icon('check', 12) + 'saved' }) : h('span', { class: 'bb-mod' }, 'modified'),
    h('div', { class: 'vw-spacer' }),
    !same && h('button', { class: 'btn primary', title: 'Overwrite the board with what you are looking at now', onclick: () => updateBoardFromSearch(), html: icon('save', 15) + '<span>Update board</span>' }),
    !same && h('button', { class: 'btn', title: 'Go back to how the board was saved', onclick: () => runSmart(b) }, 'Revert'),
    h('button', { class: 'btn', title: 'Keep this board as is and save the current search separately', onclick: () => saveSmart() }, 'Save as new'),
    h('button', { class: 'ibtn', title: 'Detach from this board', html: icon('close', 16), onclick: () => ((st.smartId = null), updateBoardBar()) }),
  );
  boardBar.hidden = false;
}

function updateBoardFromSearch() {
  const b = boards.get(st.smartId);
  if (!b) return;
  const terms = searchBar.terms.length ? clone(searchBar.terms) : clone(st.terms);
  boards.update(b.id, { provider: prov.id, terms, filters: clone(st.filters), cover: st.loaded.slice(0, 10).map((p) => p.sample || p.thumb) });
  toast(`Updated “${b.name}”`, { ms: 1800 });
  updateBoardBar();
}

function saveBoardMenu(anchor) {
  const b = boards.get(st.smartId);
  if (!b) return saveSmart();
  const r = (anchor || { getBoundingClientRect: () => ({ left: innerWidth - 260, bottom: 120 }) }).getBoundingClientRect();
  showMenu(r.left - 140, r.bottom + 6, [
    { header: 'This search came from a board' },
    { label: `Update “${b.name}”`, icon: 'save', run: () => updateBoardFromSearch() },
    { label: 'Save as a new board…', icon: 'plus', run: () => saveSmart() },
  ]);
}

async function saveSmart() {
  const terms = searchBar.terms.length ? clone(searchBar.terms) : clone(st.terms);
  if (!terms.length && !searchBar.activeFilterCount()) return toast('Add some tags first — then save the search.', { kind: 'err' });
  const def = terms.filter((t) => t.op !== '-').map((t) => pretty(t.t)).slice(0, 3).join(' + ') || 'My search';
  const name = await promptText('Save this search as a live board', def);
  if (!name) return;
  const b = boards.create(name, 'smart', { provider: prov.id, terms, filters: clone(st.filters), cover: st.loaded.slice(0, 10).map((p) => p.sample || p.thumb) });
  st.smartId = b.id;
  updateBoardBar();
  toast(`Saved “${b.name}”`, { action: { label: 'View boards', run: () => go('#/boards') } });
}

async function saveSmartFromEntry(e) {
  const name = await promptText('Save as live board', e.terms.map((t) => pretty(t.t)).slice(0, 3).join(' + ') || 'My search');
  if (!name) return;
  boards.create(name, 'smart', { provider: e.provider, terms: clone(e.terms), filters: clone(e.filters), cover: e.thumbs || [] });
  toast(`Saved “${name}”`);
}

function runSmart(b) {
  st.smartId = b.id;
  if (b.provider !== prov.id) setProvider(b.provider, false);
  const next = roamHash(b.terms, { ...defaultFilters(), ...b.filters }, b.provider);
  if (location.hash === next || (parseHash().view === 'roam' && roamHash(st.terms, st.filters, prov.id) === next)) return navigateRoam({ terms: b.terms, filters: { ...defaultFilters(), ...b.filters } });
  location.hash = next;
}

function runEntry(e) {
  st.smartId = null;
  if (e.provider !== prov.id) setProvider(e.provider, false);
  location.hash = roamHash(e.terms, { ...defaultFilters(), ...e.filters }, e.provider);
}

/* ================================================================== provider / theme */
function setProvider(id, rerun = true) {
  if (id === prov.id) return;
  prov = getProvider(id);
  setS('provider', id);
  paintDial();
  if (st.filters && st.filters.order && !prov.sorts.some(([v]) => v === st.filters.order)) st.filters.order = '';
  if (rerun) navigateRoam({ filters: st.filters, provider: id });
  toast(`Source: ${prov.name}`, { ms: 1400 });
}

function applyTheme() {
  const r = document.documentElement;
  r.dataset.theme = S('theme');
  r.style.setProperty('--hue', S('hue'));
  r.classList.toggle('no-topo', !S('topo'));
  r.classList.toggle('no-grain', !S('grain'));
  requestAnimationFrame(paintTopo);
  const bar = { night: ['#0a1113', true], paper: ['#ece5d3', false], violet: ['#0d0a18', true] }[S('theme')] || ['#0a1113', true];
  native.bars(bar[0], bar[1]);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', bar[0]);
}

function applyGalleryClasses() {
  for (const el of document.querySelectorAll('.gal')) {
    el.classList.toggle('blur', S('blurThumbs'));
    el.classList.toggle('meta-on', S('showMeta'));
  }
}

on('settings', (e) => {
  const k = e.detail.key;
  if (['theme', 'hue', 'topo', 'grain'].includes(k)) applyTheme();
  if (['layout', 'density', 'gap', 'thumbQ', 'mobileCols'].includes(k)) {
    gal.relayout();
    boardGal?.relayout();
    updateStatus();
    sizeSlider.value = S('density');
  }
  if (['showMeta', 'blurThumbs'].includes(k)) applyGalleryClasses();
  if (['blacklist', 'blacklistMode'].includes(k)) rebuildBlacklist();
  if (k === 'provider' && e.detail.value !== prov.id) setProvider(e.detail.value);
  if (k === 'starred') renderRoutes();
});

const rebuildBlacklist = debounce(() => {
  gal.setBlacklist();
  const top = scroller.scrollTop;
  gal.setItems(st.loaded);
  scroller.scrollTop = top;
  updateStatus();
  if (boardGal) boardGal.setBlacklist();
}, 400);

/* ================================================================== cloak */
const cloak = $('#cloak');
let titleBefore = '';
function toggleCloak() {
  const on = cloak.hidden;
  cloak.hidden = !on;
  document.body.classList.toggle('cloaked', on);
  document.querySelectorAll('video').forEach((v) => on && v.pause());
  if (on) {
    titleBefore = document.title;
    document.title = 'Untitled document';
  } else document.title = titleBefore || 'Board Roamer';
}
cloak.addEventListener('dblclick', toggleCloak);

/* ================================================================== context menus for everything else */
bindContext(dial, () => providerList.map((p) => ({ label: p.name, icon: 'compass', checked: p.id === prov.id, run: () => setProvider(p.id) })));
bindContext(rail, (e) => {
  const nav = e.target.closest('.nav-i');
  if (nav) {
    const id = nav.dataset.view;
    return [
      { label: `Open ${NAV.find((n) => n[0] === id)[1]}`, icon: NAV.find((n) => n[0] === id)[2], run: () => go('#/' + id) },
      id === 'follows' && { label: 'Check for new posts', icon: 'refresh', run: () => refreshAll({ force: true }) },
      id === 'follows' && { label: 'Mark all seen', icon: 'check', run: () => subs.markAllSeen() },
      id === 'trail' && { label: 'Clear the trail', icon: 'trash', danger: true, run: () => { trailStore.clear(); toast('Trail cleared', { ms: 1200 }); } },
    ];
  }
  return null;
});
if (isNative()) {
  bindContext(document.getElementById('titlebar'), () => [
    { label: 'Minimize', icon: 'winMin', run: () => windowCommand('min') },
    { label: 'Maximize / restore', icon: 'winMax', run: () => windowCommand('max') },
    { sep: true },
    { label: 'Close', icon: 'close', danger: true, run: () => windowCommand('close') },
  ]);
}
bindContext(status, () => [
  { label: 'Copy search as text', icon: 'copy', run: () => copyText(termsStr(st.terms)) },
  { label: 'Copy this search’s link', icon: 'link', run: () => copyText(location.href) },
]);
bindContext(scroller, () => null); // tiles handle themselves; empty gallery space falls through

document.addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented) return;
  if (e.target.closest('input,textarea,[contenteditable="true"]')) return; // keep the native edit menu
  e.preventDefault();
  const sel = String(getSelection() || '').trim();
  const view = parseHash().view;
  showMenu(e.clientX, e.clientY, [
    sel && { label: 'Copy', icon: 'copy', kbd: 'Ctrl+C', run: () => copyText(sel) },
    sel && sel.length < 60 && { label: `Search “${sel.length > 22 ? sel.slice(0, 22) + '…' : sel}”`, icon: 'search', run: () => tagAction(sel.toLowerCase().replace(/\s+/g, '_'), 'only', prov.id) },
    sel && { sep: true },
    { label: 'Go to', icon: 'compass', sub: NAV.map(([id, label, ic], n) => ({ label, icon: ic, kbd: String(n + 1), checked: (NAV_OF[view] || view) === id, run: () => go('#/' + id) })) },
    view === 'roam' && { label: 'Focus search', icon: 'search', kbd: '/', run: () => searchBar.focus() },
    view === 'roam' && { label: 'Refresh results', icon: 'refresh', run: () => navigateRoam({}) },
    { label: 'Back', icon: 'left', run: () => history.back() },
    { sep: true },
    { label: 'Settings', icon: 'settings', kbd: ',', run: () => openSettings() },
    { label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', run: () => showHelp() },
    { label: 'Cloak the screen', icon: 'cloak', kbd: '`', run: () => toggleCloak() },
  ]);
});

/* ================================================================== global keys */
addEventListener('keydown', (e) => {
  if (e.key === '`' || (e.key === 'F9')) return (e.preventDefault(), toggleCloak());
  if (!cloak.hidden) return;
  if (e.target.matches('input,textarea,select,[contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (viewer.isOpen || reader.isOpen || document.querySelector('.dlg-back,.help-back')) return;
  const view = parseHash().view;
  switch (e.key) {
    case '/': e.preventDefault(); if (view !== 'roam') go('#/roam'); setTimeout(() => searchBar.focus(), 30); break;
    case '1': go('#/roam'); break;
    case '2': go('#/boards'); break;
    case '3': go('#/follows'); break;
    case '4': go('#/pools'); break;
    case '5': go('#/trail'); break;
    case ',': openSettings(); break;
    case '?': showHelp(); break;
    case 'ArrowRight': case 'ArrowLeft': case 'ArrowDown': case 'ArrowUp': {
      const g = currentGallery();
      if (!g || !['roam', 'board', 'pool'].includes(view)) break;
      e.preventDefault();
      g.moveFocus(e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0, e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0);
      break;
    }
    case 'Enter': { const g = currentGallery(); if (g && g.focusI != null && ['roam', 'board', 'pool'].includes(view)) (e.preventDefault(), g.openFocused()); break; }
    case ' ': { const g = currentGallery(); if (g && g.focusI != null && g.selectMode) (e.preventDefault(), g.openFocused()); break; }
    case 's': case 'S': if (['roam', 'board', 'pool'].includes(view)) toggleSelect(); break;
    case 'Escape': {
      const g = currentGallery();
      if (g?.selectMode) (g.setSelectMode(false), selBtn.classList.remove('on'));
      else closeSettings();
      break;
    }
  }
});

/* ================================================================== phones & touch */
/** Re-home controls when the layout flips between phone and desktop. */
let lastPhone = null;
function applyPhoneLayout() {
  const ph = isPhone();
  if (ph !== lastPhone) {
    const first = lastPhone === null;
    lastPhone = ph;
    if (!first && ['follows', 'pools'].includes(parseHash().view)) setTimeout(applyRoute, 0);
    const tools = roam.querySelector('.tools'), stripTools = strip.querySelector('.strip-tools');
    // on a phone the "save as board" button moves down into the toolbar to keep the search row clean
    ph ? tools.prepend(searchBar.saveBtn) : stripTools.append(searchBar.saveBtn);
  }
  clearTimeout(applyPhoneLayout.t);
  applyPhoneLayout.t = setTimeout(() => (gal.relayout(), boardGal?.relayout()), 60);
}

function setupTouch() {
  // floating "back to top" once you've scrolled a good way
  document.getElementById('views').addEventListener('scroll', (e) => {
    const t = e.target;
    if (t?.classList?.contains('gal') || t?.id === 'v-other') fab.hidden = !isPhone() || t.scrollTop < 900;
  }, { capture: true, passive: true });

  // pull down at the top of the results to run the search again
  let pull = null;
  const roamScroller = scroller;
  roamScroller.addEventListener('touchstart', (e) => {
    pull = roamScroller.scrollTop <= 0 && e.touches.length === 1 && isTouch() ? { y: e.touches[0].clientY, dy: 0 } : null;
  }, { passive: true });
  roamScroller.addEventListener('touchmove', (e) => {
    if (!pull) return;
    const dy = e.touches[0].clientY - pull.y;
    if (dy <= 0 || roamScroller.scrollTop > 0) { pull = null; return void ptr.classList.remove('pulling'); }
    pull.dy = dy;
    const k = Math.min(1, dy / 110);
    ptr.classList.add('pulling');
    ptr.style.setProperty('--k', k);
    ptr.classList.toggle('ready', k >= 1);
  }, { passive: true });
  const endPull = () => {
    if (!pull) return;
    const go = pull.dy >= 110;
    pull = null;
    ptr.classList.remove('pulling', 'ready');
    if (go) {
      haptic('tick');
      ptr.classList.add('spin');
      setTimeout(() => ptr.classList.remove('spin'), 900);
      navigateRoam({});
    }
  };
  roamScroller.addEventListener('touchend', endPull, { passive: true });
  roamScroller.addEventListener('touchcancel', endPull, { passive: true });

  // system Back: close whatever is on top, else step back through the app, else let the OS minimise it
  onBack(() => {
    if (!cloak.hidden) return true; // the panic screen stays until it is double-tapped
    const layer = menuOpen() || document.querySelector('.pop, .sheet-back, .dlg-back, .help-back, .settings.in') || viewer.isOpen || reader.isOpen;
    if (layer) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    }
    const g = currentGallery();
    if (g?.selectMode) return g.setSelectMode(false), selBtn.classList.remove('on'), true;
    if (document.activeElement?.matches?.('input,textarea')) return document.activeElement.blur(), true;
    if (navDepth > 0) return history.back(), true;
    return false;
  });

  // Android-only niceties
  if (isAndroid()) {
    const apply = () => native.secure(S('privacyScreen'));
    apply();
    on('settings', (e) => e.detail.key === 'privacyScreen' && apply());
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (S('autoCloak') && cloak.hidden) toggleCloak();
    } else refreshAll(); // stale follows only
  });
  // the on-screen keyboard: get the tab bar out of the way while typing
  let kbdT;
  document.addEventListener('focusin', (e) => { if (e.target.matches?.('input,textarea') && isPhone()) { clearTimeout(kbdT); document.documentElement.classList.add('kbd'); } });
  document.addEventListener('focusout', () => { clearTimeout(kbdT); kbdT = setTimeout(() => document.documentElement.classList.remove('kbd'), 120); });
  // touch: the panic screen is left with a double-tap (there is no ` key)
  let lastTap = 0;
  cloak.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    const now = performance.now();
    if (now - lastTap < 380) toggleCloak();
    lastTap = now;
  });
}

function shareText(text, title) {
  if (isAndroid()) return native.share(text, title);
  if (navigator.share) return navigator.share({ title, text, url: text }).catch(() => {});
  copyText(text);
  toast('Link copied', { ms: 1400 });
}
M.share = (post) => shareText(post.url, `${getProvider(post.provider).name} #${post.id}`);

/* ================================================================== boot */
function boot() {
  initTitlebar();
  applyTheme();
  initTopo();
  buildRail();
  paintDial();
  paintFollowBadge();
  paintPoolBadge();
  // saved pools and comics are checked for new pages shortly after start, then every half hour
  setTimeout(() => library.all().length && refreshLib().catch(() => {}), 7000);
  setInterval(() => !document.hidden && library.all().length && refreshLib().catch(() => {}), 30 * 60 * 1000);
  st.filters = defaultFilters();
  searchBar.setFilters(st.filters);
  applyGalleryClasses();
  // history entries are numbered so the system Back button knows how deep we are
  history.replaceState({ n: 0 }, '');
  addEventListener('hashchange', () => {
    const st = history.state;
    if (st && typeof st.n === 'number') navDepth = st.n; // back / forward
    else history.replaceState({ n: ++navDepth }, ''); // a fresh push
  });
  addEventListener('hashchange', applyRoute);
  if (!location.hash) history.replaceState(history.state, '', '#/roam?p=' + prov.id);
  onLayout(() => applyPhoneLayout());
  applyPhoneLayout();
  setupTouch();
  startAutoSync();
  startAutoUpdateCheck((section) => openSettings(section));
  applyRoute();
  // quietly keep followed artists fresh
  setTimeout(() => refreshAll(), 4500);
  setInterval(() => refreshAll(), 30 * 60 * 1000);
}
boot();
