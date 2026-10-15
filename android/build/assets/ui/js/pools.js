import { h, ago, pretty, fmtNum, debounce, copyText } from './util.js';
import { icon } from './icons.js';
import { S, reading } from './store.js';
import { getProvider } from './providers.js';
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

export async function loadPool(prov, id, onProgress) {
  const k = keyOf(prov, id);
  if (fullCache.has(k)) return fullCache.get(k);
  const pool = await poolInfo(prov, id);
  const posts = await prov.poolPosts(pool, onProgress);
  const res = { pool, posts, kind: kindOf(pool, posts) };
  fullCache.set(k, res);
  return res;
}

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
  const act = h('div', { class: 'vhead-act' },
    kind === 'comic' && h('button', { class: 'btn primary big', html: icon('book', 17) + `<span>${resume ? `Continue · page ${prog.i + 1}` : 'Read'}</span>`, onclick: () => ctx.readPool(id, posts[resume ? prog.i : 0]?.id) }),
    kind === 'comic' && resume && h('button', { class: 'btn', onclick: () => ctx.readPool(id, posts[0]?.id) }, 'Start over'),
    kind !== 'comic' && h('button', { class: 'btn primary', html: icon('play', 16) + '<span>Slideshow</span>', onclick: () => ctx.openViewer(gal, 0, null, true, { pool, kind }) }),
    kind !== 'comic' && h('button', { class: 'btn', html: icon('eye', 16) + '<span>Open first</span>', onclick: () => ctx.openViewer(gal, 0, null, false, { pool, kind }) }),
    h('div', { class: 'jump' }, pageInput, h('button', { class: 'btn', onclick: jump }, 'Go')),
    h('button', { class: 'btn', title: 'Select pages', html: icon('select', 16) + '<span>Select</span>', onclick: () => gal.setSelectMode(!gal.selectMode) }),
    h('button', { class: 'btn', title: 'Save every page, numbered, into a folder', html: icon('download', 16) + '<span>Save all</span>', onclick: () => downloadMany(posts, { dir: pool.name, numbered: true }) }),
    h('button', { class: 'btn', title: 'Pin every page to a board', html: icon('pin', 16) + '<span>Pin all</span>', onclick: (e) => pinPopover(e.currentTarget, posts) }),
    h('button', { class: 'ibtn', title: 'Open on site', html: icon('external', 18), onclick: () => openExternal(`${prov.web}/pools/${id}`) }),
  );
  const desc = dtext(pool.desc);
  headHost.replaceChildren(
    h('div', { class: 'vhead bd pool-head' },
      h('button', { class: 'ibtn', title: 'All pools', html: icon('left', 20), onclick: () => ctx.go('#/pools') }),
      h('div', { class: 'bd-title' },
        h('h1', { class: 'bd-name' }, pool.name),
        h('div', { class: 'pool-meta' }, kindBadge(kind), h('span', {}, `${fmtNum(posts.length)}${posts.length !== pool.count ? ` of ${pool.count}` : ''} pages`), pool.updated ? h('span', {}, `updated ${ago(pool.updated)}`) : null, pool.creator ? h('span', {}, `by ${pool.creator}`) : null, !pool.active ? h('span', { class: 'inactive' }, 'inactive') : null)),
      act),
    desc ? h('details', { class: 'pool-desc' }, h('summary', {}, 'About this pool'), h('p', {}, desc.slice(0, 1800))) : null,
  );
  const ctxItems = () => [
    { label: 'Copy pool link', icon: 'link', run: () => (copyText(`${prov.web}/pools/${id}`), toast('Link copied', { ms: 1200 })) },
    { label: 'Copy pool name', icon: 'copy', run: () => copyText(pool.name) },
    { label: 'Open on site', icon: 'external', run: () => openExternal(`${prov.web}/pools/${id}`) },
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
  const st = { q: '', category: '', order: 'updated_at', page: 1, comicsOnly: false, items: [], covers: new Map(), done: false, loading: false };
  const grid = h('div', { class: 'pgrid' });
  const more = h('button', { class: 'btn', onclick: () => load() }, 'Load more');
  const note = h('div', { class: 'pools-note' });
  const shelf = h('div', { class: 'shelf', hidden: true });

  const search = h('input', { class: 'input', placeholder: 'Search pools by name…', spellcheck: 'false', value: '', oninput: debounce((e) => { st.q = e.target.value.trim(); reset(); }, 450) });
  const head = h('div', { class: 'vhead' },
    h('div', {}, h('h1', {}, 'Pools'), h('p', {}, 'Comics and collections, auto-sorted')),
    h('div', { class: 'vhead-act' }, search));
  const catOpts = [['', 'All'], ['series', 'Series'], ['collection', 'Collections']];
  const orderOpts = [['updated_at', 'Recently updated'], ['created_at', 'Newest'], ['name', 'Name'], ['post_count', 'Biggest']];
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
  root.replaceChildren(h('div', { class: 'pools-page' }, head, ctl, shelf, grid, h('div', { class: 'pools-foot' }, note, more)));

  if (!prov.pools) {
    grid.replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'es-art', html: icon('pool', 56) }), h('h2', {}, 'Pools live on e621'), h('p', {}, `${prov.name} doesn’t have pools. Switch the source to e621 or e926.`)));
    more.hidden = true;
    ctl.hidden = true;
    return;
  }

  /* continue-reading shelf */
  const recent = Object.entries(reading.all()).filter(([k, v]) => k.includes(':pool:') && v.name && v.i < (v.total || 1) - 1).sort((a, b) => b[1].ts - a[1].ts).slice(0, 8);
  if (recent.length) {
    shelf.hidden = false;
    shelf.append(h('h3', {}, 'Continue reading'), h('div', { class: 'shelf-row' }, recent.map(([k, v]) =>
      h('button', { class: 'shelf-card', title: v.name, onclick: () => ctx.readPool(v.pool, null, v.prov) },
        h('div', { class: 'sc-img' }, v.cover ? h('img', { src: v.cover, alt: '', draggable: 'false' }) : null, h('i', { class: 'sc-bar' }, h('b', { style: `width:${Math.min(100, ((v.i + 1) / (v.total || 1)) * 100)}%` }))),
        h('span', {}, v.name), h('small', {}, `page ${v.i + 1} of ${v.total}`)))));
  }

  const card = (pool) => {
    const cover = h('div', { class: 'pc-cover' }, h('i', { class: 'pc-ph', html: icon('pool', 30) }));
    const badge = h('span', { class: 'kind kind-' + (pool.cat === 'series' ? 'series' : 'collection'), html: icon('pool', 12) + (pool.cat === 'series' ? 'SERIES' : 'COLLECTION') });
    const el = h('article', { class: 'pcard', tabindex: 0, 'data-id': pool.id, onclick: () => ctx.go(`#/pool/${pool.id}?p=${prov.id}`), onkeydown: (e) => e.key === 'Enter' && ctx.go(`#/pool/${pool.id}?p=${prov.id}`) },
      cover, h('div', { class: 'pc-info' }, h('h3', {}, pool.name), h('div', { class: 'pc-meta' }, badge, h('span', {}, `${fmtNum(pool.count)} pages`), h('span', {}, ago(pool.updated)))));
    el._pool = pool;
    el._cover = cover;
    el._badge = badge;
    return el;
  };

  const paintCover = (el) => {
    const pool = el._pool, p = st.covers.get(pool.ids[0]);
    if (!p) return;
    el._cover.replaceChildren(h('img', { src: p.sample || p.thumb, alt: '', loading: 'lazy', draggable: 'false', onload: (e) => e.target.classList.add('ready') }));
    if (p.isComic) {
      el._comic = true;
      el._badge.className = 'kind kind-comic';
      el._badge.innerHTML = icon('book', 12) + 'COMIC';
    }
    applyFilter();
  };

  const applyFilter = () => {
    for (const el of grid.children) el.hidden = st.comicsOnly && !el._comic;
    const shown = [...grid.children].filter((e) => !e.hidden).length;
    note.textContent = st.items.length ? `${shown} shown${st.comicsOnly ? ' (comics only)' : ''}` : '';
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
      if (list.length < 36) st.done = true;
      st.items.push(...list);
      const els = list.map(card);
      grid.append(...els);
      if (!st.items.length) grid.replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'No pools found'), h('p', {}, 'Try a different name or clear the filters.')));
      applyFilter();
      // covers: first page of each pool, in as few requests as possible
      const ids = list.map((p) => p.ids[0]).filter(Boolean);
      prov.postsByIds(ids).then((posts) => {
        if (myGen !== st.gen) return;
        posts.forEach((p) => st.covers.set(p.id, p));
        els.forEach(paintCover);
      }).catch(() => {});
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
      el._comic && { label: 'Read', icon: 'book', run: () => ctx.readPool(pool.id, pool.ids[0], prov.id) },
      { sep: true },
      { label: 'Open on site', icon: 'external', run: () => openExternal(`${prov.web}/pools/${pool.id}`) },
      { label: 'Copy pool link', icon: 'link', run: () => (copyText(`${prov.web}/pools/${pool.id}`), toast('Link copied', { ms: 1200 })) },
      { label: 'Copy name', icon: 'copy', run: () => copyText(pool.name) },
    ];
  });
  st.gen = 0;
  load();
}
