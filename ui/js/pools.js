import { h, ago, pretty, fmtNum, debounce, copyText } from './util.js';
import { icon } from './icons.js';
import { S, setS, reading, library, on, emit, poolUnblur } from './store.js';
import { toggleLibrary, renderLibrary } from './library.js';
import { getProvider, isBlurred, compileBlacklist } from './providers.js';
import { poolWeight, poolNotice, ruleList, unblurKey } from './poolweight.js';
import { Gallery } from './gallery.js';
import { toast, segmented } from './ui.js';
import { downloadMany, selBar, openExternal } from './actions.js';
import { pinPopover, quickPin } from './pins.js';
import { showMenu, bindContext } from './ctxmenu.js';
import { isPhone } from './platform.js';
import { popover } from './ui.js';

/* ================================================================== data */
const metaCache = new Map(); // key -> Promise<pool>
const fullCache = new Map(); // key -> {pool, posts, kind}
const keyOf = (prov, id) => `${prov.credKey}:${id}`;
export const poolKey = (prov, id) => `${prov.credKey}:pool:${id}`;
/** Where a pool lives on the site (Derpibooru's comics are a tag search, not /pools/<id>). */
export const poolWeb = (prov, id) => (prov.poolUrl ? prov.poolUrl(id) : `${prov.web}/pools/${id}`);

export function poolInfo(prov, id) {
  const k = keyOf(prov, id);
  if (!metaCache.has(k)) metaCache.set(k, prov.pool(id).catch((e) => (metaCache.delete(k), Promise.reject(e))));
  return metaCache.get(k);
}

/** Comics tag every page `comic`; ordinary pools (collections / series of loose art) don't. */
export function kindOf(pool, posts) {
  if (posts.length) {
    const c = posts.filter((p) => p.isComic).length;
    if (c / posts.length >= 0.5) return 'comic';
  }
  return pool.cat === 'series' ? 'series' : 'collection';
}
export const KIND_LABEL = { comic: 'Comic', series: 'Series', collection: 'Collection' };

/** Opening a saved pool counts as seeing its pages. */
function touchLibrary(prov, pool, kind) {
  const f = library.find(prov.credKey, pool.id);
  if (!f) return;
  const patch = { count: Math.max(f.count, pool.count), updated: pool.updated || f.updated, name: pool.name, seenCount: Math.max(f.seenCount, pool.count) };
  if (kind && f.kind !== kind) patch.kind = kind;
  library.update(f.id, patch, true);
  library.update(f.id, {});
}

export async function loadPool(prov, id, onProgress) {
  const k = keyOf(prov, id);
  const saved = library.find(prov.credKey, id);
  if (fullCache.has(k) && saved && saved.count > fullCache.get(k).pool.count) (fullCache.delete(k), metaCache.delete(k)); // the library saw new pages since
  if (fullCache.has(k)) return fullCache.get(k);
  const pool = await poolInfo(prov, id);
  const posts = await prov.poolPosts(pool, onProgress);
  const res = { pool, posts, kind: kindOf(pool, posts) };
  fullCache.set(k, res);
  touchLibrary(prov, pool, res.kind);
  return res;
}

/** Every page we have for a pool: all of them once it was opened, else null. */
const loadedPages = (prov, id) => fullCache.get(keyOf(prov, id))?.posts || null;

export const dtext = (t) => String(t || '').replace(/thumb #\d+/g, '').replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (m, a, b) => b || a).replace(/"([^"]+)":\S+/g, '$1').replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, '').replace(/^h\d\.\s*/gm, '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();

const kindBadge = (kind) => h('span', { class: 'kind kind-' + kind, html: icon(kind === 'comic' ? 'book' : 'pool', 12) + KIND_LABEL[kind].toUpperCase() });

/* ================================================================== one pool */
export async function renderPoolView(root, id, ctx) {
  const prov = getProvider(ctx.provId);
  const scroller = h('div', { class: 'gal' + (S('blurThumbs') ? ' blur' : '') + (S('showMeta') ? ' meta-on' : '') });
  const headHost = h('div', {}, h('div', { class: 'vhead bd' }, h('button', { class: 'ibtn', title: 'All pools', html: icon('left', 20), onclick: () => ctx.go('#/pools') }), h('div', { class: 'bd-title' }, h('h1', { class: 'bd-name' }, 'Loading pool…'), h('span', { class: 'bd-count' }, 'fetching pages'))));
  root.replaceChildren(headHost, scroller);
  if (!prov.pools) {
    headHost.replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'Pools need e621'), h('p', {}, `${prov.name} doesn’t have pools.`), h('button', { class: 'btn primary', onclick: () => ctx.go('#/roam') }, 'Back')));
    return null;
  }
  let data;
  try {
    data = await loadPool(prov, id, (n, t) => { const c = headHost.querySelector('.bd-count'); if (c) c.textContent = `${n} / ${t} pages`; });
  } catch (e) {
    headHost.replaceChildren(h('div', { class: 'empty-state err' }, h('h2', {}, 'Couldn’t load that pool'), h('p', {}, e.message), h('button', { class: 'btn primary', onclick: () => ctx.go('#/pools') }, 'All pools')));
    return null;
  }
  if (!root.isConnected || root.querySelector('.gal') !== scroller) return null; // user navigated away
  const { pool, posts, kind } = data;
  emit('tab-title', { title: pool.name }); // the tab takes the pool's name
  const rkey = poolKey(prov, id);
  const prog = reading.get(rkey);
  const gal = new Gallery(scroller, {
    onOpen: (vi, tile) => ctx.openViewer(gal, vi, tile, false, { pool, kind }),
    onNeedMore: () => {},
    onPin: (ps) => quickPin(ps),
    onOpenSite: (p) => openExternal(p.url),
    onSelect: (n) => bar.update(n),
  });
  gal.numbered = true;
  scroller.classList.add('numbered');
  const bar = selBar(gal, [
    { label: 'Download', icon: 'download', run: (sel) => downloadMany(sel, { dir: pool.name, numbered: true }) },
    { label: 'Pin', icon: 'pin', run: (sel, el) => pinPopover(el, sel) },
  ]);
  const pageInput = h('input', { class: 'input num', type: 'number', min: 1, max: posts.length, placeholder: 'Page', title: 'Jump to a page', onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') jump(); } });
  const jump = () => {
    const n = Math.round(+pageInput.value);
    if (!n || n < 1 || n > posts.length) return toast(`Pick a page between 1 and ${posts.length}`, { kind: 'err', ms: 1600 });
    kind === 'comic' ? ctx.readPool(id, posts[n - 1].id) : ctx.openViewer(gal, n - 1, null, false, { pool, kind });
  };
  const resume = prog && prog.i > 0 && prog.i < posts.length - 1;
  const inLib = () => !!library.find(prov.credKey, id);
  const libBtn = h('button', { class: 'btn', onclick: () => { toggleLibrary(prov, { pool, kind, cover: posts[0]?.sample || posts[0]?.thumb }); paintLib(); } });
  const paintLib = () => {
    libBtn.classList.toggle('on', inLib());
    libBtn.innerHTML = icon('folder', 16) + `<span>${inLib() ? 'In library' : 'Add to library'}</span>`;
    libBtn.title = inLib() ? 'Saved. New pages will be flagged on the Pools tab. Click to remove' : 'Keep this and get told when pages are added';
  };
  paintLib();
  const act = h('div', { class: 'vhead-act' },
    kind === 'comic' && h('button', { class: 'btn primary big', html: icon('book', 17) + `<span>${resume ? `Continue · page ${prog.i + 1}` : 'Read'}</span>`, onclick: () => ctx.readPool(id, posts[resume ? prog.i : 0]?.id) }),
    kind === 'comic' && resume && h('button', { class: 'btn', onclick: () => ctx.readPool(id, posts[0]?.id) }, 'Start over'),
    kind !== 'comic' && h('button', { class: 'btn primary', html: icon('play', 16) + '<span>Slideshow</span>', onclick: () => ctx.openViewer(gal, 0, null, true, { pool, kind }) }),
    kind !== 'comic' && h('button', { class: 'btn', html: icon('eye', 16) + '<span>Open first</span>', onclick: () => ctx.openViewer(gal, 0, null, false, { pool, kind }) }),
    libBtn,
    h('div', { class: 'jump' }, pageInput, h('button', { class: 'btn', onclick: jump }, 'Go')),
    h('button', { class: 'btn', title: 'Select pages', html: icon('select', 16) + '<span>Select</span>', onclick: () => gal.setSelectMode(!gal.selectMode) }),
    h('button', { class: 'btn', title: 'Save every page, numbered, into a folder', html: icon('download', 16) + '<span>Save all</span>', onclick: () => downloadMany(posts, { dir: pool.name, numbered: true }) }),
    h('button', { class: 'btn', title: 'Pin every page to a board', html: icon('pin', 16) + '<span>Pin all</span>', onclick: (e) => pinPopover(e.currentTarget, posts) }),
    h('button', { class: 'ibtn', title: 'Open on site', html: icon('external', 18), onclick: () => openExternal(poolWeb(prov, id)) }),
  );
  const desc = dtext(pool.desc);
  // how much of it the blacklist covers: a warning, or (mostly #blur) one button that unblurs every page
  const noteHost = h('div', { class: 'pool-note-host' });
  const paintNote = () => noteHost.replaceChildren(poolNotice(poolWeight(posts), { provId: prov.id, poolId: pool.id, kind, onChange: () => (paintNote(), gal.repaint()) }) || '');
  paintNote();
  const offNote = on('settings', (e) => {
    if (!root.isConnected || !root.contains(noteHost)) return offNote();
    if (['blacklist', 'blacklistMode', 'poolMostly', 'poolWarn'].includes(e.detail.key)) paintNote();
  });
  headHost.replaceChildren(
    h('div', { class: 'vhead bd pool-head' },
      h('button', { class: 'ibtn', title: 'All pools', html: icon('left', 20), onclick: () => ctx.go('#/pools') }),
      h('div', { class: 'bd-title' },
        h('h1', { class: 'bd-name' }, pool.name),
        h('div', { class: 'pool-meta' }, kindBadge(kind), h('span', {}, `${fmtNum(posts.length)}${posts.length !== pool.count ? ` of ${pool.count}` : ''} pages`), pool.updated ? h('span', {}, `updated ${ago(pool.updated)}`) : null, pool.creator ? h('span', {}, `by ${pool.creator}`) : null, !pool.active ? h('span', { class: 'inactive' }, 'inactive') : null)),
      act),
    desc ? h('details', { class: 'pool-desc' }, h('summary', {}, 'About this pool'), h('p', {}, desc.slice(0, 1800))) : null,
    noteHost,
  );
  const ctxItems = () => [
    { label: 'Copy pool link', icon: 'link', run: () => (copyText(poolWeb(prov, id)), toast('Link copied', { ms: 1200 })) },
    { label: 'Copy pool name', icon: 'copy', run: () => copyText(pool.name) },
    { label: 'Open on site', icon: 'external', run: () => openExternal(poolWeb(prov, id)) },
    { label: inLib() ? 'Remove from library' : 'Add to library', icon: 'folder', run: () => { toggleLibrary(prov, { pool, kind, cover: posts[0]?.sample || posts[0]?.thumb }); paintLib(); } },
    { sep: true },
    kind === 'comic' && { label: 'Read', icon: 'book', run: () => ctx.readPool(id, posts[0]?.id) },
    { label: 'Save all pages', icon: 'download', run: () => downloadMany(posts, { dir: pool.name, numbered: true }) },
  ];
  bindContext(headHost, ctxItems);
  root.append(bar);
  requestAnimationFrame(() => {
    gal.setItems(posts);
    gal.setFoot(h('div', { class: 'foot-end' }, h('i', { html: icon(kind === 'comic' ? 'book' : 'pool', 16) }), `${posts.length} pages`));
  });
  gal.pool = { pool, kind, prov };
  return gal;
}

/* ================================================================== all pools */
export function renderPools(root, ctx) {
  const prov = getProvider(ctx.provId);
  const st = { q: '', category: '', order: 'updated_at', page: 1, comicsOnly: false, items: [], covers: new Map(), samples: new Map(), done: false, loading: false };
  const grid = h('div', { class: 'pgrid' });
  const more = h('button', { class: 'btn', onclick: () => load() }, 'Load more');
  const note = h('div', { class: 'pools-note' });
  const shelf = h('div', { class: 'shelf', hidden: true });
  const libHost = h('div', { class: 'lib-host', hidden: true });

  const search = h('input', { class: 'input', placeholder: 'Search pools by name…', spellcheck: 'false', value: '', oninput: debounce((e) => { st.q = e.target.value.trim(); reset(); }, 450) });
  const tabs = segmented([['browse', 'Browse'], ['library', 'Library']], S('poolsTab'), (v) => { setS('poolsTab', v); applyTab(); }, 'lib-tabs');
  const paintTabs = () => {
    const b = tabs.querySelector('[data-v="library"]'), n = library.all().length, fresh = library.unseen();
    b.replaceChildren('Library', n ? h('span', { class: 'tab-n' }, String(n)) : null, fresh ? h('i', { class: 'tab-dot', title: `${fresh} with new pages` }) : null);
  };
  const head = h('div', { class: 'vhead' },
    h('div', {}, h('h1', {}, 'Pools'), h('p', {}, 'Comics and collections, auto-sorted')),
    h('div', { class: 'vhead-act' }, tabs, search));
  const catOpts = [['', 'All'], ['series', 'Series'], ['collection', 'Collections']];
  const orderOpts = prov.poolOrders || [['updated_at', 'Recently updated'], ['created_at', 'Newest'], ['name', 'Name'], ['post_count', 'Biggest']];
  const coverOf = (pool) => st.covers.get(pool.ids[0]) || st.covers.get('pool:' + pool.id);
  const comicsToggle = () => h('label', { class: 'tgl-row' }, h('button', { class: 'tgl' + (st.comicsOnly ? ' on' : ''), role: 'switch', onclick: (e) => { st.comicsOnly = !st.comicsOnly; e.currentTarget.classList.toggle('on', st.comicsOnly); applyFilter(); paintBadge(); } }, h('i')), h('span', {}, 'Comics only'));
  const filterBtn = h('button', { class: 'btn', 'aria-label': 'Filters', html: icon('sliders', 17) + '<span>Filters</span>', onclick: (e) => {
    const row = (l, ...c) => h('div', { class: 'frow' }, h('label', {}, l), h('div', {}, c));
    popover(e.currentTarget, h('div', { class: 'fpanel' },
      row('Type', segmented(catOpts, st.category, (v) => { st.category = v; reset(); paintBadge(); })),
      row('Order', segmented(orderOpts, st.order, (v) => { st.order = v; reset(); paintBadge(); }, 'wrap')),
      row('Show', comicsToggle())), { cls: 'wide-pop', align: 'right' });
  } });
  const paintBadge = () => {
    const n = (st.category ? 1 : 0) + (st.order !== 'updated_at' ? 1 : 0) + (st.comicsOnly ? 1 : 0);
    filterBtn.querySelector('span').textContent = n ? `Filters · ${n}` : 'Filters';
    filterBtn.classList.toggle('primary', n > 0);
  };
  const ctl = isPhone()
    ? h('div', { class: 'pools-ctl compact' }, filterBtn)
    : h('div', { class: 'pools-ctl' },
      segmented(catOpts, st.category, (v) => { st.category = v; reset(); }),
      segmented(orderOpts, st.order, (v) => { st.order = v; reset(); }),
      comicsToggle());
  const foot = h('div', { class: 'pools-foot' }, note, more);
  root.replaceChildren(h('div', { class: 'pools-page' }, head, ctl, shelf, grid, foot, libHost));
  const applyTab = () => {
    const lib = S('poolsTab') === 'library';
    ctl.hidden = lib || !prov.pools;
    shelf.hidden = lib || !shelf.childElementCount;
    grid.hidden = lib;
    foot.hidden = lib;
    search.hidden = lib;
    libHost.hidden = !lib;
    tabs.querySelectorAll('.seg-b').forEach((b) => b.classList.toggle('on', b.dataset.v === S('poolsTab')));
    if (lib) renderLibrary(libHost, ctx);
    paintTabs();
  };
  const offLib = on('library', () => (root.isConnected && root.contains(tabs) ? paintTabs() : offLib()));

  if (!prov.pools) {
    grid.replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'es-art', html: icon('pool', 56) }), h('h2', {}, 'Pools live on e621'), h('p', {}, `${prov.name} doesn’t have pools. Switch the source to e621 or e926.`)));
    more.hidden = true;
    ctl.hidden = true;
    applyTab();
    return;
  }

  /* continue-reading shelf */
  const recent = Object.entries(reading.all()).filter(([k, v]) => k.includes(':pool:') && v.name && v.i < (v.total || 1) - 1).sort((a, b) => b[1].ts - a[1].ts).slice(0, 8);
  if (recent.length) {
    shelf.hidden = false;
    shelf.append(h('h3', {}, 'Continue reading'), h('div', { class: 'shelf-row' }, recent.map(([k, v]) =>
      h('button', { class: 'shelf-card', title: v.name, 'data-key': k, 'data-hash': `#/pool/${v.pool}?p=${v.prov}`, onclick: () => ctx.readPool(v.pool, null, v.prov) },
        h('div', { class: 'sc-img' }, v.cover ? h('img', { src: v.cover, alt: '', draggable: 'false' }) : null, h('i', { class: 'sc-bar' }, h('b', { style: `width:${Math.min(100, ((v.i + 1) / (v.total || 1)) * 100)}%` }))),
        h('span', {}, v.name), h('small', {}, `page ${v.i + 1} of ${v.total}`)))));
  }

  // right-click / long-press a "Continue reading" card: browse the pool, start over, save it to the library…
  bindContext(shelf, (e) => {
    const el = e.target.closest('.shelf-card');
    const v = el && reading.get(el.dataset.key);
    if (!v) return null;
    const pv = getProvider(v.prov);
    const web = poolWeb(pv, v.pool);
    const inLib = () => !!library.find(pv.credKey, v.pool);
    return [
      { header: v.name },
      { label: `Continue · page ${v.i + 1} of ${v.total}`, icon: 'book', run: () => ctx.readPool(v.pool, null, v.prov) },
      { label: 'Browse this pool', icon: 'pool', run: () => ctx.go(`#/pool/${v.pool}?p=${v.prov}`) },
      ctx.tabsOn?.() && { label: 'Browse in new tab', icon: 'plus', run: () => ctx.openTab(`#/pool/${v.pool}?p=${v.prov}`, v.name, v.cover) },
      { label: 'Start over', icon: 'refresh', run: () => ctx.go(`#/pool/${v.pool}?p=${v.prov}&read=0`) },
      { sep: true },
      { label: inLib() ? 'Remove from library' : 'Add to library', icon: 'folder', run: () => toggleLibrary(pv, { pool: { id: v.pool, name: v.name, count: v.total, updated: null, cat: 'collection' }, kind: v.kind || 'comic', cover: v.cover }) },
      { label: 'Open on site', icon: 'external', run: () => openExternal(web) },
      { label: 'Copy pool link', icon: 'link', run: () => (copyText(web), toast('Link copied', { ms: 1200 })) },
    ];
  });

  const card = (pool) => {
    const libBtn = h('button', { class: 'lib-add', 'aria-label': 'Add to library', onclick: (e) => { e.stopPropagation(); addToLib(el); } });
    const cover = h('div', { class: 'pc-cover' }, h('i', { class: 'pc-ph', html: icon('pool', 30) }), h('div', { class: 'lib-act' }, libBtn));
    const badge = h('span', { class: 'kind kind-' + (pool.cat === 'series' ? 'series' : 'collection'), html: icon('pool', 12) + (pool.cat === 'series' ? 'SERIES' : 'COLLECTION') });
    const flag = h('span', { class: 'pc-flag', hidden: true });
    const el = h('article', { class: 'pcard', tabindex: 0, 'data-id': pool.id, 'data-hash': `#/pool/${pool.id}?p=${prov.id}`, onclick: () => ctx.go(`#/pool/${pool.id}?p=${prov.id}`), onkeydown: (e) => e.key === 'Enter' && ctx.go(`#/pool/${pool.id}?p=${prov.id}`) },
      cover, h('div', { class: 'pc-info' }, h('h3', {}, pool.name), h('div', { class: 'pc-meta' }, badge, h('span', {}, `${fmtNum(pool.count)} pages`), h('span', {}, ago(pool.updated)), flag)));
    el._flag = flag;
    el._pool = pool;
    el._cover = cover;
    el._badge = badge;
    el._libBtn = libBtn;
    paintLibBtn(el);
    return el;
  };

  const paintLibBtn = (el) => {
    const on_ = !!library.find(prov.credKey, el._pool.id);
    el._libBtn.classList.toggle('on', on_);
    el._libBtn.innerHTML = icon('folder', 15);
    el._libBtn.title = on_ ? 'In your library. Click to remove' : 'Add to library';
  };
  const addToLib = (el) => {
    const pool = el._pool, p = coverOf(pool);
    toggleLibrary(prov, { pool, kind: el._comic ? 'comic' : pool.cat === 'series' ? 'series' : 'collection', cover: p && (p.sample || p.thumb) });
    paintLibBtn(el);
  };
  const offBtns = on('library', () => (root.isConnected && root.contains(grid) ? [...grid.children].forEach((el) => el._libBtn && paintLibBtn(el)) : offBtns()));

  const paintCover = (el) => {
    const pool = el._pool, p = coverOf(pool);
    if (!p) return;
    el._cover.querySelector('.pc-ph')?.remove();
    el._cover.querySelector('img')?.remove();
    el._cover.prepend(h('img', { src: p.sample || p.thumb, alt: '', loading: 'lazy', draggable: 'false', onload: (e) => e.target.classList.add('ready') }));
    paintWeight(el);
    if (p.isComic) {
      el._comic = true;
      el._badge.className = 'kind kind-comic';
      el._badge.innerHTML = icon('book', 12) + 'COMIC';
    }
    applyFilter();
  };

  /* ---- blacklist weight: judged from a sample of each pool's pages (every page once the pool was opened) */
  const blOn = () => !!(S('blacklist') || []).length && (S('blacklistMode') !== 'off' || compileBlacklist(S('blacklist'), 'blur').length > 0);
  const weightOf = (pool) => {
    const all = loadedPages(prov, pool.id);
    if (all) return poolWeight(all);
    const smp = st.samples.get(pool.id);
    // too few pages seen to call a big pool "mostly" anything
    return smp && (smp.length >= 5 || smp.length >= (pool.count || pool.ids?.length || 0)) ? poolWeight(smp, true) : null;
  };
  const paintWeight = (el) => {
    const pool = el._pool, w = blOn() ? weightOf(pool) : null;
    const un = poolUnblur.has(unblurKey(prov.id, pool.id)), est = w?.sampled ? ' (judged from a sample of its pages)' : '';
    el._bl = w?.hide === 'mostly' ? S('blacklistMode') : null; // 'hide' takes the card out, 'veil' covers it
    const img = el._cover.querySelector('img'), p = coverOf(pool);
    img?.classList.toggle('blurred', (w?.blur === 'mostly' && !un) || (!!p && isBlurred(p)));
    el._cover.querySelector('.pc-veil')?.remove();
    if (el._bl === 'veil' && !el._revealed) {
      el._cover.append(h('button', { class: 'pc-veil', title: 'Show this pool', onclick: (e) => { e.stopPropagation(); el._revealed = true; paintWeight(el); } },
        h('i', { html: icon('cloak', 22) }), h('b', {}, 'Mostly blacklisted'), h('small', {}, ruleList(w.hideRules, 1).slice(0, 40))));
    }
    const f = el._flag;
    f.hidden = true;
    if (w?.blur === 'mostly' && !un) Object.assign(f, { hidden: false, className: 'pc-flag mostly', title: `Mostly ${ruleList(w.blurRules)}, which you blur${est}. Open it to unblur every page at once.` }), (f.innerHTML = icon('cloak', 11) + 'MOSTLY BLURRED');
    else if (w?.blur === 'warn' || (w?.blur === 'mostly' && un)) Object.assign(f, { hidden: false, className: 'pc-flag warn', title: `Has pages blurred by your blacklist: ${ruleList(w.blurRules)}${est}` }), (f.innerHTML = icon('cloak', 11) + 'BLURRED PAGES');
  };
  const judge = (els) => {
    if (!blOn() || !prov.poolSamples) return;
    const todo = els.filter((el) => !st.samples.has(el._pool.id) && !loadedPages(prov, el._pool.id)).map((el) => el._pool);
    if (!todo.length) return els.forEach(paintWeight), applyFilter();
    const myGen = st.gen;
    const have = new Map([...st.covers].filter(([k]) => typeof k === 'number'));
    prov.poolSamples(todo, 8, have).then((found) => {
      found.forEach((posts, id) => st.samples.set(id, posts));
      if (myGen !== st.gen) return;
      els.forEach(paintWeight);
      applyFilter();
    }).catch(() => {});
  };
  const offW = on('settings', (e) => {
    if (!root.isConnected || !root.contains(grid)) return offW();
    if (!['blacklist', 'blacklistMode', 'poolMostly', 'poolWarn'].includes(e.detail.key)) return;
    const els = [...grid.children].filter((el) => el._pool);
    els.forEach(paintWeight);
    applyFilter();
    judge(els);
  });

  const applyFilter = () => {
    let gone = 0;
    for (const el of grid.children) {
      const out = el._bl === 'hide';
      gone += out ? 1 : 0;
      el.hidden = (st.comicsOnly && !el._comic) || out;
    }
    const shown = [...grid.children].filter((e) => !e.hidden).length;
    note.textContent = st.items.length ? `${shown} shown${st.comicsOnly ? ' (comics only)' : ''}${gone ? ` · ${gone} hidden by blacklist (mostly made of what you blacklisted)` : ''}` : '';
  };

  async function load() {
    if (st.loading || st.done) return;
    st.loading = true;
    more.disabled = true;
    more.textContent = 'Loading…';
    const myGen = st.gen;
    try {
      const list = await prov.poolsSearch({ q: st.q, category: st.category, order: st.order, page: st.page });
      if (myGen !== st.gen) return;
      st.page++;
      if (!(list.more ?? list.length >= 36)) st.done = true;
      st.items.push(...list);
      const els = list.map(card);
      grid.append(...els);
      if (!st.items.length) grid.replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'No pools found'), h('p', {}, 'Try a different name or clear the filters.')));
      applyFilter();
      // covers: first page of each pool, in as few requests as possible
      if (prov.poolCovers) { // a site whose pools have no single cover post to look up (Derpibooru comics)
        prov.poolCovers(list).then((found) => {
          if (myGen !== st.gen) return;
          found.forEach((p, id) => st.covers.set('pool:' + id, p));
          els.forEach(paintCover);
          judge(els);
        }).catch(() => judge(els));
        return;
      }
      const ids = list.map((p) => p.ids[0]).filter(Boolean);
      prov.postsByIds(ids).then((posts) => {
        if (myGen !== st.gen) return;
        posts.forEach((p) => st.covers.set(p.id, p));
        els.forEach(paintCover);
        judge(els);
      }).catch(() => judge(els));
    } catch (e) {
      note.textContent = e.message;
    } finally {
      st.loading = false;
      more.disabled = false;
      more.textContent = 'Load more';
      more.hidden = st.done;
    }
  }

  function reset() {
    st.gen = (st.gen || 0) + 1;
    st.page = 1;
    st.done = false;
    st.items = [];
    st.loading = false;
    grid.replaceChildren();
    load();
  }

  bindContext(grid, (e) => {
    const el = e.target.closest('.pcard');
    if (!el) return null;
    const pool = el._pool;
    return [
      { header: pool.name },
      { label: 'Open pool', icon: 'pool', run: () => ctx.go(`#/pool/${pool.id}?p=${prov.id}`) },
      ctx.tabsOn?.() && { label: 'Open in new tab', icon: 'plus', run: () => ctx.openTab(`#/pool/${pool.id}?p=${prov.id}`, pool.name, (coverOf(pool) || {}).sample || (coverOf(pool) || {}).thumb) },
      el._comic && { label: 'Read', icon: 'book', run: () => ctx.readPool(pool.id, pool.ids[0], prov.id) },
      { label: library.find(prov.credKey, pool.id) ? 'Remove from library' : 'Add to library', icon: 'folder', run: () => addToLib(el) },
      { sep: true },
      { label: 'Open on site', icon: 'external', run: () => openExternal(poolWeb(prov, pool.id)) },
      { label: 'Copy pool link', icon: 'link', run: () => (copyText(poolWeb(prov, pool.id)), toast('Link copied', { ms: 1200 })) },
      { label: 'Copy name', icon: 'copy', run: () => copyText(pool.name) },
    ];
  });
  st.gen = 0;
  load();
  applyTab();
}
