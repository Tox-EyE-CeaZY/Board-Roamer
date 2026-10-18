import { h, ago, fmtNum, pretty, download, pickFile, hash01, clamp } from './util.js';
import { icon } from './icons.js';
import { boards, postKey, S, exportAll, importAll, tagc, emit, folders } from './store.js';
import { newFolder, moveEntry, folderCard, draggableItem, folderMenu } from './folders.js';
import { getProvider, Feed } from './providers.js';
import { announce } from './notify.js';
import { Gallery } from './gallery.js';
import { toast, promptText, confirmDlg, popover, segmented } from './ui.js';
import { downloadMany, selBar, openExternal } from './actions.js';
import { bindContext } from './ctxmenu.js';
import { pinPopover, quickPin } from './pins.js';
import { dialog } from './ui.js';

const HUES = [128, 35, 200, 330, 85, 260, 10, 170];

/* ------------------------------------------------------------------ live boards: is there anything new? */
const STALE = 30 * 60 * 1000;
let running = false;

/** Look at the newest few posts of a live board's search. The first look is a baseline: what is already there is not "new". */
export async function checkBoard(b) {
  const had = b.newCount || 0;
  try {
    const prov = getProvider(b.provider);
    const ratings = S('filters').ratings;
    const feed = new Feed(prov, b.terms, { ...S('filters'), ...b.filters, order: '', ratings: { ...ratings, ...(b.filters || {}).ratings } });
    feed.limit = 8;
    const posts = (await prov.page(feed)).filter((p) => feed.filters.ratings[p.rating]).sort((x, y) => y.id - x.id);
    const latest = posts[0];
    const patch = { checked: Date.now(), err: '' };
    if (latest) patch.latestId = Math.max(latest.id, b.latestId || 0);
    if (!b.seenId && latest) Object.assign(patch, { seenId: latest.id, newCount: 0 });
    else patch.newCount = posts.filter((p) => p.id > b.seenId).length;
    boards.patch(b.id, patch);
    return patch.newCount > had;
  } catch (e) {
    boards.patch(b.id, { checked: Date.now(), err: e.message });
    return false;
  }
}

/** Check live boards one by one (the proxy paces the requests). Only stale ones unless forced. */
export async function refreshBoards({ force = false } = {}) {
  if (running) return;
  const list = boards.all().filter((b) => b.kind === 'smart' && b.terms?.length && (force || !b.checked || Date.now() - b.checked > STALE));
  if (!list.length) return;
  running = true;
  let fresh = 0;
  for (const b of list) if (boards.get(b.id) && (await checkBoard(boards.get(b.id)))) fresh++;
  running = false;
  if (fresh) announce('boards');
}

function tagline(b) {
  return b.terms.map((t) => (t.op === '+' ? '' : t.op === '-' ? '−' : '≈') + pretty(t.t));
}

/**
 * The stack of polaroids on a board card. Covers are taken from a longer list than is shown: if one cannot be loaded
 * (after trying the sample, the thumbnail, then the local proxy) its slot is dropped and the next picture moves up,
 * so a card never shows a broken-image icon.
 */
function coverStack(b) {
  const prox = (u) => '/img?u=' + encodeURIComponent(u);
  const cands = (b.kind === 'pins'
    ? b.posts.slice(0, 12).map((p) => [p.sample || p.thumb, p.thumb, p.thumb && prox(p.thumb)])
    : (b.cover || []).slice(0, 12).map((u) => [u, prox(u)])
  ).map((c) => [...new Set(c.filter(Boolean))]).filter((c) => c.length);
  const stack = h('div', { class: 'bc-stack' });
  const emptyNote = (text) => h('div', { class: 'bc-empty' }, h('i', { html: icon(b.kind === 'smart' ? 'compass' : 'pin', 34) }), h('span', {}, text));
  if (!cands.length) {
    stack.append(emptyNote(b.kind === 'smart' ? 'run it once to get a cover' : b.inbox ? 'tap the pin on anything to drop it here' : 'empty — pin something'));
    return stack;
  }
  const tilt = (i) => (hash01(b.id + i) - 0.5) * 14;
  const slots = [];
  let next = 0, note = null;
  const layout = () => {
    slots.forEach((el, i) => {
      const n = slots.length;
      el.style.cssText = `--r:${tilt(i)}deg;--i:${i};--n:${n};--t:${8 + (i % 2) * 7}%;--x:${n === 1 ? 27 : 4 + i * (46 / (n - 1))}%`;
    });
  };
  const add = () => {
    if (next >= cands.length) return false;
    const srcs = cands[next++];
    let k = 0;
    const img = h('img', { alt: '', draggable: 'false', decoding: 'async' });
    const slot = h('div', { class: 'bc-photo' }, img);
    img.onload = () => slot.classList.add('ready');
    img.onerror = () => {
      if (++k < srcs.length) return void (img.src = srcs[k]);
      const at = slots.indexOf(slot);
      if (at >= 0) slots.splice(at, 1);
      slot.remove();
      if (!add() && !slots.length && !note) stack.append((note = emptyNote('covers could not load')));
      layout();
    };
    slots.push(slot);
    stack.append(slot);
    img.src = srcs[0];
    return true;
  };
  for (let i = 0; i < 4; i++) add();
  layout();
  return stack;
}

function card(b, ctx) {
  const stack = coverStack(b);
  const meta = b.kind === 'pins'
    ? h('div', { class: 'bc-meta' }, b.inbox ? h('span', { class: 'quick' }, 'QUICK PIN') : null, `${b.posts.length} pin${b.posts.length === 1 ? '' : 's'}`, h('span', {}, ago(b.updated)))
    : h('div', { class: 'bc-meta' }, h('span', { class: 'live' }, 'LIVE'), b.newCount ? h('span', { class: 'new', title: `${b.newCount} new since you last looked` }, `${b.newCount >= 8 ? '8+' : b.newCount} new`) : null, h('span', {}, getProvider(b.provider).name));
  const chips = b.kind === 'smart'
    ? h('div', { class: 'bc-tags' }, tagline(b).slice(0, 6).map((t) => h('span', {}, t)), b.terms.length > 6 ? h('span', {}, `+${b.terms.length - 6}`) : null)
    : null;
  const el = h('article', { class: 'bcard' + (b.inbox ? ' inbox' : '') + (b.kind === 'smart' ? ' live' : ''), 'data-id': b.id, style: `--bh:${b.hue}`, tabindex: 0 }, stack,
    h('div', { class: 'bc-info' }, h('h3', {}, b.name), meta, chips),
    b.inbox ? null : h('div', { class: 'bc-act' },
      h('button', { title: 'Rename', html: icon('edit', 15), onclick: async (e) => { e.stopPropagation(); const n = await promptText('Rename board', b.name); if (n) { boards.update(b.id, { name: n }); ctx.refresh(); } } }),
      h('button', { title: 'Colour', html: icon('flame', 15), onclick: (e) => { e.stopPropagation(); huePop(e.currentTarget, b, ctx); } }),
      h('button', { title: 'Delete', html: icon('trash', 15), onclick: async (e) => { e.stopPropagation(); if (await confirmDlg('Delete board?', `“${b.name}” and its ${b.kind === 'pins' ? b.posts.length + ' pins' : 'saved search'} will be removed.`)) { boards.remove(b.id); ctx.refresh(); } } }),
    ),
  );
  el.dataset.hash = b.kind === 'smart' ? ctx.roamHash(b.terms, b.filters, b.provider) : `#/board/${b.id}`;
  const open = () => (b.kind === 'smart' ? ctx.runSmart(b) : ctx.go(`#/board/${b.id}`));
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => e.key === 'Enter' && open());
  return el;
}

function huePop(anchor, b, ctx) {
  popover(anchor, h('div', { class: 'huepick' }, HUES.map((hue) => h('button', { style: `--bh:${hue}`, class: hue === b.hue ? 'on' : '', onclick: () => { boards.update(b.id, { hue }); ctx.refresh(); } }))), { align: 'right' });
}

async function newBoard(ctx) {
  const kind = await dialog({
    title: 'New board',
    body: [
      h('p', { class: 'dlg-text' }, h('b', {}, 'Pin board'), ' — a collection you drop posts into by hand: references, favourites, things to read.'),
      h('p', { class: 'dlg-text' }, h('b', {}, 'Live board'), ' — a saved search that refreshes itself. Make one by searching for something and pressing the save button.'),
    ],
    actions: [{ label: 'Cancel', value: null }, { label: 'Live board', value: 'live' }, { label: 'Pin board', value: 'pins', cls: 'primary' }],
  });
  if (kind === 'live') {
    toast('Search for something, then press the save button to keep it as a live board.', { ms: 4200 });
    return ctx.go('#/roam');
  }
  if (kind !== 'pins') return;
  const n = await promptText('Name your pin board', '', 'e.g. Wallpapers, To read, Reference…');
  if (n) ctx.go('#/board/' + boards.create(n, 'pins').id);
}

export function renderBoards(root, ctx) {
  const open = folders.get(new URLSearchParams(location.hash.split('?')[1] || '').get('f'));
  const inFolder = (b) => (open ? b.folder === open.id : !b.folder || !folders.get(b.folder));
  const list = boards.all().filter(inFolder);
  const pinBoards = list.filter((b) => b.kind === 'pins').sort((a, c) => (c.inbox ? 1 : 0) - (a.inbox ? 1 : 0) || c.updated - a.updated);
  const live = list.filter((b) => b.kind === 'smart');
  const head = h('div', { class: 'vhead' },
    h('div', {}, h('h1', {}, open ? open.name : 'Boards'), h('p', {}, `${pinBoards.length} pin board${pinBoards.length === 1 ? '' : 's'} · ${live.length} live search${live.length === 1 ? '' : 'es'}`)),
    h('div', { class: 'vhead-act' },
      open ? h('button', { class: 'btn fback', title: 'Back to all boards. Drop a board here to take it out of the folder', html: icon('left', 16) + '<span>All boards</span>', onclick: () => ctx.go('#/boards'),
        ondragover: (e) => e.preventDefault(), ondrop: (e) => { const id = e.dataTransfer.getData('text/x-br-item'); if (id) (boards.update(id, { folder: null }), ctx.refresh()); } }) : null,
      h('button', { class: 'btn', html: icon('folder', 16) + '<span>New folder</span>', onclick: async () => { const f = await newFolder('boards'); if (f) ctx.refresh(); } }),
      h('button', { class: 'btn', html: icon('download', 16) + '<span>Export</span>', onclick: () => { download('board-roamer-backup.json', exportAll()); toast('Backup saved via your browser download'); } }),
      h('button', { class: 'btn', html: icon('folder', 16) + '<span>Import</span>', onclick: async () => { const f = await pickFile('.json'); if (!f) return; try { importAll(await f.text()); toast('Imported'); ctx.refresh(); } catch (e) { toast('Import failed: ' + e.message, { kind: 'err' }); } } }),
      h('button', { class: 'btn primary', html: icon('plus', 16) + '<span>New board</span>', onclick: () => newBoard(ctx) }),
    ),
  );
  const section = (title, hint, items, empty) => [
    h('div', { class: 'bsec' }, h('h3', {}, title), h('span', {}, hint)),
    items.length ? h('div', { class: 'bgrid' }, items.map((b) => card(b, ctx))) : empty,
  ];
  const folderTiles = open ? [] : folders.all('boards').map((f) => {
    const inside = boards.all().filter((x) => x.folder === f.id);
    return folderCard(f, {
      count: inside.length, noun: 'board',
      covers: inside.map((x) => (x.kind === 'pins' ? x.posts[0]?.thumb : (x.cover || [])[0])).filter(Boolean),
      onOpen: () => ctx.go('#/boards?f=' + f.id),
      onDrop: (id) => { boards.update(id, { folder: f.id }); ctx.refresh(); },
    });
  });
  const grid = h('div', { class: 'bwrap' },
    ...(folderTiles.length ? [h('div', { class: 'bsec' }, h('h3', {}, 'Folders'), h('span', {}, 'drag a board onto a folder, or right-click it and choose Move to folder')), h('div', { class: 'fgrid' }, folderTiles)] : []),
    ...section('Pins', 'one tap on any pin button drops a post into the first board; right-click or long-press to choose another', pinBoards, null),
    ...section('Live boards', 'saved searches that refresh themselves', live,
      h('div', { class: 'bhint' }, h('i', { html: icon('compass', 22) }), h('p', {}, 'None yet. Search for something and press the save button (next to the search bar) to keep it here.'))));
  root.replaceChildren(head, grid);
  grid.querySelectorAll('.bcard').forEach((el) => !el.classList.contains('inbox') && draggableItem(el, el.dataset.id));
  bindContext(grid, (e) => {
    const fl = e.target.closest('.fldr');
    if (fl && folders.get(fl.dataset.folder)) return folderMenu(folders.get(fl.dataset.folder), ctx.refresh);
    const el = e.target.closest('.bcard');
    if (!el) return null;
    const b = boards.get(el.dataset.id);
    if (!b) return null;
    const dup = () => {
      const c = boards.create(b.name + ' copy', b.kind, { hue: b.hue, provider: b.provider, terms: b.terms && JSON.parse(JSON.stringify(b.terms)), filters: b.filters && JSON.parse(JSON.stringify(b.filters)), cover: b.cover });
      if (b.kind === 'pins') boards.add(c.id, b.posts.slice().reverse());
      ctx.refresh();
    };
    return [
      { header: b.name },
      { label: b.kind === 'smart' ? 'Run this search' : 'Open board', icon: b.kind === 'smart' ? 'compass' : 'boards', run: () => (b.kind === 'smart' ? ctx.runSmart(b) : ctx.go('#/board/' + b.id)) },
      ctx.tabsOn?.() && { label: 'Open in new tab', icon: 'plus', run: () => ctx.openTab(el.dataset.hash, b.name, b.kind === 'pins' ? b.posts[0]?.thumb : (b.cover || [])[0]) },
      b.kind === 'pins' && b.posts.length && { label: 'Slideshow', icon: 'play', run: () => ctx.go('#/board/' + b.id) },
      { sep: true },
      !b.inbox && { label: 'Rename', icon: 'edit', run: async () => { const n = await promptText('Rename board', b.name); if (n) { boards.update(b.id, { name: n }); ctx.refresh(); } } },
      !b.inbox && moveEntry('boards', b, (fid) => { boards.update(b.id, { folder: fid }); ctx.refresh(); }),
      !b.inbox && { label: 'Colour', icon: 'flame', sub: HUES.map((hue) => ({ label: `Hue ${hue}°`, checked: hue === b.hue, run: () => { boards.update(b.id, { hue }); ctx.refresh(); } })) },
      !b.inbox && { label: 'Duplicate', icon: 'copy', run: dup },
      { label: 'Export this board', icon: 'download', run: () => { download(`board-${b.name.replace(/\W+/g, '-')}.json`, JSON.stringify({ app: 'board-roamer', v: 2, boards: [b] }, null, 1)); toast('Board exported'); } },
      b.kind === 'smart' && { label: 'Copy search as text', icon: 'link', run: () => navigator.clipboard.writeText(b.terms.map((t) => (t.op === '+' ? '' : t.op) + t.t).join(' ')) },
      !b.inbox && { sep: true },
      !b.inbox && { label: 'Delete', icon: 'trash', danger: true, run: async () => { if (await confirmDlg('Delete board?', `“${b.name}” will be removed.`)) { boards.remove(b.id); ctx.refresh(); } } },
      b.inbox && b.posts.length && { sep: true },
      b.inbox && b.posts.length && { label: 'Empty the Pins board', icon: 'trash', danger: true, run: async () => { if (await confirmDlg('Empty Pins?', `All ${b.posts.length} pins will be removed from this board.`, 'Empty')) { boards.removePosts(b.id, b.posts.map(postKey)); ctx.refresh(); } } },
    ];
  });
}

/* ------------------------------------------------------------------ one board */
export function renderBoard(root, id, ctx) {
  const b = boards.get(id);
  if (!b || b.kind !== 'pins') {
    root.replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'Board not found'), h('button', { class: 'btn primary', onclick: () => ctx.go('#/boards') }, 'Back to boards')));
    return null;
  }
  let sort = 'new';
  const scroller = h('div', { class: 'gal' + (S('blurThumbs') ? ' blur' : '') + (S('showMeta') ? ' meta-on' : '') });
  const posts = () => {
    const l = b.posts.slice();
    if (sort === 'old') l.reverse();
    if (sort === 'score') l.sort((x, y) => y.score - x.score);
    if (sort === 'shuffle') l.sort(() => Math.random() - 0.5);
    return l;
  };
  const gal = new Gallery(scroller, {
    onOpen: (vi, tile) => ctx.openViewer(gal, vi, tile),
    onNeedMore: () => {},
    onPin: (ps) => quickPin(ps),
    onOpenSite: (p) => openExternal(p.url),
    onSelect: (n) => bar.update(n),
    contextExtra: (p) => [{ label: 'Remove from this board', icon: 'trash', danger: true, run: () => { boards.removePosts(id, [postKey(p)]); fill(); title(); toast('Removed from board', { ms: 1400 }); } }],
  });
  const bar = selBar(gal, [
    { label: 'Download', icon: 'download', run: (sel) => downloadMany(sel) },
    { label: 'Remove', icon: 'trash', cls: 'danger', run: (sel) => { boards.removePosts(id, sel.map(postKey)); gal.setSelectMode(false); fill(); title(); toast(`Removed ${sel.length}`); } },
    { label: 'Move to…', icon: 'pin', run: (sel, el) => pinPopover(el, sel) },
  ]);
  const count = h('span', { class: 'bd-count' });
  const name = h('h1', { class: 'bd-name', title: b.inbox ? 'The built-in Pins board' : 'Click to rename', onclick: async () => { if (b.inbox) return; const n = await promptText('Rename board', b.name); if (n) { boards.update(id, { name: n }); name.textContent = n; } } }, b.name);
  const title = () => (count.textContent = `${b.posts.length} pin${b.posts.length === 1 ? '' : 's'}`);
  const fill = () => {
    gal.setItems(posts());
    gal.setFoot(b.posts.length ? h('div', { class: 'foot-end' }, h('i', { html: icon('pin', 16) }), `${b.posts.length} pinned`) : h('div', { class: 'empty-state' }, h('div', { class: 'es-art', html: icon('pin', 56) }), h('h2', {}, 'Nothing pinned yet'), h('p', {}, 'Press B on any post or use the pin button on a tile.'), h('button', { class: 'btn primary', onclick: () => ctx.go('#/roam') }, 'Go roaming')));
  };
  const head = h('div', { class: 'vhead bd', style: `--bh:${b.hue}` },
    h('button', { class: 'ibtn', title: 'All boards', html: icon('left', 20), onclick: () => ctx.go('#/boards') }),
    h('div', { class: 'bd-title' }, name, count),
    h('div', { class: 'vhead-act' },
      segmented([['new', 'Newest'], ['old', 'Oldest'], ['score', 'Score'], ['shuffle', 'Shuffle']], sort, (v) => { sort = v; fill(); }),
      h('button', { class: 'btn', title: 'Select posts', html: icon('select', 16) + '<span>Select</span>', onclick: () => gal.setSelectMode(!gal.selectMode) }),
      h('button', { class: 'btn', html: icon('play', 16) + '<span>Slideshow</span>', onclick: () => b.posts.length && ctx.openViewer(gal, 0, null, true) }),
      h('button', { class: 'btn', html: icon('download', 16) + '<span>Save all</span>', onclick: () => downloadMany(b.posts) }),
      b.inbox ? null : h('button', { class: 'ibtn', title: 'Delete board', html: icon('trash', 18), onclick: async () => { if (await confirmDlg('Delete board?', `“${b.name}” and its ${b.posts.length} pins will be removed.`)) { boards.remove(id); ctx.go('#/boards'); } } }),
    ),
  );
  root.replaceChildren(head, scroller, bar);
  title();
  requestAnimationFrame(fill);
  return gal;
}

/** Keep a smart board's cover fresh from its latest results. */
export function updateCover(id, posts) {
  const b = boards.get(id);
  if (!b || b.kind !== 'smart') return;
  boards.update(id, { cover: posts.slice(0, 4).map((p) => p.sample || p.thumb) });
}
