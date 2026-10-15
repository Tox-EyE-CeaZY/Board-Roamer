/**
 * The Library: pools and comics you want to keep an eye on. Saving one is like following an artist: the page count is
 * checked now and then, and anything added since you last opened it shows up as "+N new pages".
 */
import { h, ago, fmtNum, debounce, copyText } from './util.js';
import { icon } from './icons.js';
import { S, setS, library, reading, on, emit } from './store.js';
import { getProvider } from './providers.js';
import { toast, confirmDlg } from './ui.js';
import { openExternal } from './actions.js';
import { showMenu, bindContext } from './ctxmenu.js';
import { isPhone } from './platform.js';

const STALE = 30 * 60 * 1000;
let running = false;

export const KIND_NAME = { comic: 'Comic', series: 'Series', collection: 'Collection' };
const readKey = (f) => `${f.p}:pool:${f.pid}`;
const provOf = (f) => getProvider(f.p);

/* ------------------------------------------------------------------ saving */
/** Add or remove a pool. `info` = {pool, kind, cover} from a loaded pool, or just {pool} from a list card. */
export function toggleLibrary(prov, info) {
  const { pool } = info;
  const had = library.find(prov.credKey, pool.id);
  if (had) {
    library.remove(had.id);
    toast(`Removed “${pool.name}” from your library`, { ms: 1800, action: { label: 'Undo', run: () => library.add({ ...had, p: had.p, pid: had.pid }) } });
    return false;
  }
  library.add({ p: prov.credKey, pid: pool.id, name: pool.name, kind: info.kind || (pool.cat === 'series' ? 'series' : 'collection'), cover: info.cover || '', count: pool.count, updated: pool.updated });
  toast(`Saved to your library. New pages will show up on the Pools tab`, { ms: 2600 });
  return true;
}

/* ------------------------------------------------------------------ checking for new pages */
export async function checkLib(f) {
  try {
    const pool = await provOf(f).pool(f.pid);
    if (!pool) throw new Error('This pool no longer exists');
    const patch = { checked: Date.now(), err: '', count: pool.count, updated: pool.updated, name: pool.name };
    if (!f.cover && pool.ids[0]) {
      try {
        const p = (await provOf(f).postsByIds([pool.ids[0]]))[0];
        if (p) patch.cover = p.sample || p.thumb;
      } catch { /* the cover can wait */ }
    }
    library.update(f.id, patch);
  } catch (e) {
    library.update(f.id, { checked: Date.now(), err: e.message });
  }
}

export async function refreshLib({ force = false } = {}) {
  if (running) return;
  const list = library.all().filter((f) => force || !f.checked || Date.now() - f.checked > STALE);
  if (!list.length) return;
  running = true;
  let done = 0;
  emit('lib-progress', { running: true, done, total: list.length });
  for (const f of list) {
    const cur = library.get(f.id);
    if (cur) await checkLib(cur);
    emit('lib-progress', { running: true, done: ++done, total: list.length });
  }
  running = false;
  emit('lib-progress', { running: false, done, total: list.length });
}

/* ------------------------------------------------------------------ the screen */
const SORTS = [['updates', 'Updates first'], ['read', 'Recently read'], ['added', 'Recently saved'], ['name', 'A–Z']];

export function renderLibrary(root, ctx) {
  const st = { q: '' };
  const grid = h('div', { class: 'pgrid lib-grid' });
  const sub = h('p', { class: 'lib-sub' });
  const progress = h('div', { class: 'f-progress', hidden: true }, h('i'));
  const filterIn = h('input', { class: 'input', placeholder: 'Filter…', spellcheck: 'false', oninput: debounce((e) => { st.q = e.target.value.trim().toLowerCase(); paint(); }, 120) });
  const refreshBtn = h('button', { class: 'btn', title: 'Check everything for new pages', onclick: () => refreshLib({ force: true }), html: icon('refresh', 16) + '<span>Refresh</span>' });
  const seenBtn = h('button', { class: 'btn', onclick: () => { library.markAllSeen(); toast('Everything marked as seen', { ms: 1400 }); }, html: icon('check', 16) + '<span>Mark all seen</span>' });
  const sortBtn = h('button', { class: 'btn sortbtn', 'aria-label': 'Sort', html: icon('list', 17) + '<span></span>', onclick: (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.bottom, [
      { header: 'Sort by' },
      ...SORTS.map(([v, l]) => ({ label: l, checked: S('libSort') === v, run: () => { setS('libSort', v); paintSort(); paint(); } })),
      { sep: true },
      { label: 'Mark everything seen', icon: 'check', run: () => library.markAllSeen() },
    ]);
  } });
  const paintSort = () => (sortBtn.querySelector('span').textContent = (SORTS.find(([v]) => v === S('libSort')) || SORTS[0])[1]);
  paintSort();
  const bar = h('div', { class: 'pools-ctl' + (isPhone() ? ' compact' : '') }, sortBtn, filterIn, h('div', { class: 'spacer' }), !isPhone() && refreshBtn, !isPhone() && seenBtn);
  root.replaceChildren(h('div', { class: 'lib-head' }, sub), progress, bar, grid);

  const sortKey = (f) => {
    const rd = reading.get(readKey(f));
    switch (S('libSort')) {
      case 'read': return -((rd && rd.ts) || 0);
      case 'added': return -f.added;
      case 'name': return f.name.toLowerCase();
      default: return -(library.newPages(f) ? 1e15 : 0) - (f.updated ? new Date(f.updated).getTime() / 1e3 : 0);
    }
  };

  const card = (f) => {
    const prov = provOf(f);
    const n = library.newPages(f);
    const rd = reading.get(readKey(f));
    const pct = rd && rd.total ? Math.min(100, ((rd.i + 1) / rd.total) * 100) : 0;
    const go = () => ctx.go(`#/pool/${f.pid}?p=${prov.id}`);
    const cover = h('div', { class: 'pc-cover' },
      f.cover ? h('img', { src: f.cover, alt: '', loading: 'lazy', draggable: 'false', onload: (e) => e.target.classList.add('ready') }) : h('i', { class: 'pc-ph', html: icon('book', 30) }),
      n ? h('span', { class: 'lib-new', html: icon('sparkle', 12) + `+${n > 99 ? '99+' : n} new` }) : null,
      pct ? h('i', { class: 'lib-prog', title: `Page ${rd.i + 1} of ${rd.total}` }, h('b', { style: `width:${pct}%` })) : null,
      h('div', { class: 'lib-act' },
        n ? h('button', { title: 'Mark seen', 'aria-label': 'Mark seen', html: icon('check', 15), onclick: (e) => (e.stopPropagation(), library.markSeen(f.id)) }) : null,
        h('button', { title: 'Remove from library', 'aria-label': 'Remove from library', html: icon('trash', 15), onclick: async (e) => { e.stopPropagation(); if (await confirmDlg('Remove from library?', `“${f.name}” will no longer be tracked.`, 'Remove')) library.remove(f.id); } })));
    const meta = h('div', { class: 'pc-meta' },
      h('span', { class: 'kind kind-' + f.kind, html: icon(f.kind === 'comic' ? 'book' : 'pool', 12) + (KIND_NAME[f.kind] || 'Pool').toUpperCase() }),
      h('span', {}, `${fmtNum(f.count)} pages`),
      f.err ? h('span', { class: 'bad', title: f.err }, 'couldn’t check') : f.updated ? h('span', {}, ago(f.updated)) : null);
    const status = rd && rd.i > 0 ? h('div', { class: 'lib-read' }, rd.i >= rd.total - 1 && !n ? 'Finished' : `Page ${rd.i + 1} of ${rd.total}`) : null;
    const el = h('article', { class: 'pcard lcard' + (n ? ' has-new' : ''), tabindex: 0, 'data-id': f.id, onclick: go, onkeydown: (e) => e.key === 'Enter' && go() },
      cover, h('div', { class: 'pc-info' }, h('h3', {}, f.name), meta, status));
    return el;
  };

  function paint() {
    const all = library.all();
    const n = library.unseen();
    sub.textContent = all.length ? `${all.length} saved${n ? ` · ${n} with new pages` : ' · all caught up'}` : '';
    seenBtn.disabled = !n;
    if (!all.length) {
      grid.replaceChildren(h('div', { class: 'empty-state' },
        h('div', { class: 'es-art', html: icon('book', 60) }),
        h('h2', {}, 'Your library is empty'),
        h('p', {}, 'Save a pool or comic with the “Add to library” button on its page, or right-click (long-press) any pool in Browse. When new pages appear you’ll see them here and on the Pools tab.'),
        h('button', { class: 'btn primary', onclick: () => { setS('poolsTab', 'browse'); ctx.refresh(); } }, 'Browse pools')));
      return;
    }
    const list = all.filter((f) => !st.q || f.name.toLowerCase().includes(st.q)).sort((a, b) => { const x = sortKey(a), y = sortKey(b); return typeof x === 'string' ? x.localeCompare(y) : x - y; });
    grid.replaceChildren(...(list.length ? list.map(card) : [h('div', { class: 'empty-state' }, h('h2', {}, 'No match'), h('p', {}, 'Nothing in your library matches that filter.'))]));
  }

  bindContext(grid, (e) => {
    const el = e.target.closest('.lcard');
    const f = el && library.get(el.dataset.id);
    if (!f) return null;
    const prov = provOf(f);
    return [
      { header: f.name },
      f.kind === 'comic' && { label: rdOf(f) ? 'Continue reading' : 'Read', icon: 'book', run: () => ctx.readPool(f.pid, null, prov.id) },
      { label: 'Open', icon: 'pool', run: () => ctx.go(`#/pool/${f.pid}?p=${prov.id}`) },
      library.newPages(f) && { label: 'Mark seen', icon: 'check', run: () => library.markSeen(f.id) },
      { label: 'Check now', icon: 'refresh', run: () => checkLib(f).then(() => toast('Checked', { ms: 1000 })) },
      { sep: true },
      { label: 'Open on site', icon: 'external', run: () => openExternal(`${prov.web}/pools/${f.pid}`) },
      { label: 'Copy pool link', icon: 'link', run: () => (copyText(`${prov.web}/pools/${f.pid}`), toast('Link copied', { ms: 1200 })) },
      { sep: true },
      { label: 'Remove from library', icon: 'trash', danger: true, run: async () => { if (await confirmDlg('Remove from library?', `“${f.name}” will no longer be tracked.`, 'Remove')) library.remove(f.id); } },
    ];
  });
  const rdOf = (f) => { const r = reading.get(readKey(f)); return r && r.i > 0; };

  const alive = () => root.isConnected && root.contains(grid);
  const repaint = debounce(() => alive() && paint(), 160);
  const offs = [on('library', () => (alive() ? repaint() : offs.forEach((o) => o()))),
    on('lib-progress', (e) => {
      if (!alive()) return;
      const { running: r, done, total } = e.detail;
      progress.hidden = !r;
      progress.firstChild.style.width = (done / total) * 100 + '%';
      refreshBtn.disabled = r;
      refreshBtn.querySelector('span').textContent = r ? `Checking ${done}/${total}` : 'Refresh';
    })];
  paint();
  refreshLib();
}
