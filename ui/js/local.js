/**
 * Local: browse the pictures and videos in folders you picked, on this device or on another device you sync with,
 * the way a phone's gallery does. Turn it on in Settings > Local. Nothing is copied or changed: files are read where they
 * are, folders appear like boards, and you can tag pictures (the tags stay in Board Roamer, never in the file).
 *
 * Every device answers the same three questions (see src/local.rs and Local.java): /local/list, /local/file, /local/thumb.
 * Another device is reached through `/remote/<id>/local/...`, which the app forwards with your pairing code.
 *
 * Routes:  #/local                      the devices
 *          #/local/<device>             that device's folders
 *          #/local/<device>?r=<root>&d=<sub/folder>
 */
import { h, ago, fmtNum, debounce } from './util.js';
import { icon } from './icons.js';
import { S, localMeta, on } from './store.js';
import { CATS } from './providers.js';
import { Gallery } from './gallery.js';
import { toast, promptText, segmented } from './ui.js';
import { selBar } from './actions.js';
import { folderCard } from './folders.js';
import { isAndroid, native } from './platform.js';
import { syncConfig, hubDevices } from './sync.js';

const enc = encodeURIComponent;
const SORTS = [['new', 'Newest'], ['old', 'Oldest'], ['name', 'A–Z'], ['size', 'Biggest'], ['shuffle', 'Shuffle']];
const ownName = () => (isAndroid() ? native.info().device || 'This phone' : '');

/* ------------------------------------------------------------------ devices */
let deviceCache = { at: 0, list: [] };

/** This device, then every other device that is sharing its folders. */
export async function devices(force = false) {
  if (!force && Date.now() - deviceCache.at < 15_000) return deviceCache.list;
  const list = [{ id: 'me', name: 'This device', base: '', here: true }];
  try {
    if (isAndroid()) {
      const cfg = syncConfig();
      if (cfg.url && cfg.code) {
        const j = await hubDevices();
        const remotes = { hub: cfg.url, code: cfg.code, devices: {} };
        if (j.hostShare) list.push({ id: 'hub', name: j.host, base: '/remote/hub' });
        for (const d of j.devices || []) {
          if (d.name === ownName()) continue;
          remotes.devices[d.name] = `http://${d.addr}:${d.port}`;
          list.push({ id: d.name, name: d.name, base: '/remote/' + enc(d.name) });
        }
        native.setRemotes(JSON.stringify(remotes));
      }
    } else {
      const j = await (await fetch('/sync/config')).json();
      for (const d of j.devices || []) if (d.share) list.push({ id: d.name, name: d.name, base: '/remote/' + enc(d.name) });
    }
  } catch { /* offline: just this device */ }
  deviceCache = { at: Date.now(), list };
  return list;
}

async function api(dev, path, params) {
  const r = await fetch(`${dev.base}/local/${path}?${new URLSearchParams(params)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const thumbUrl = (dev, root, path, s = 480) => `${dev.base}/local/thumb?root=${enc(root)}&path=${enc(path)}&s=${s}`;
const fileUrl = (dev, root, path) => `${dev.base}/local/file?root=${enc(root)}&path=${enc(path)}`;

/* ------------------------------------------------------------------ files as posts (so the gallery and viewer just work) */
/** Downloads from before metadata was embedded still say where they came from in their name: e6_123456_artist+other.jpg */
const SITES = { e6: ['e621', 'https://e621.net/posts/'], e9: ['e926', 'https://e926.net/posts/'], db: ['Danbooru', 'https://danbooru.donmai.us/posts/'], gb: ['Gelbooru', 'https://gelbooru.com/index.php?page=post&s=view&id='], sb: ['Safebooru', 'https://safebooru.org/index.php?page=post&s=view&id='] };
function fromName(name) {
  const m = /^(e6|e9|db|gb|sb)_(\d+)(?:_(.+))?\.[a-z0-9]+$/i.exec(name);
  if (!m) return null;
  const [site, base] = SITES[m[1].toLowerCase()];
  return { site, id: m[2], url: base + m[2], artists: m[3] ? m[3].split('+').filter(Boolean) : [], tags: [] };
}

function toPost(dev, root, rel, f) {
  const path = rel ? `${rel}/${f.name}` : f.name;
  const key = `${dev.id}|${root}|${path}`;
  const kind = f.kind === 'video' ? 'video' : f.ext === 'gif' ? 'anim' : 'image';
  const m = f.meta || fromName(f.name);
  const tags = Object.fromEntries(CATS.map((c) => [c, []]));
  for (const [c, list] of Object.entries(m?.byCat || {})) if (Array.isArray(list)) (tags[c] ||= []).push(...list);
  if (!Object.values(tags).some((l) => l.length)) tags.general.push(...(m?.tags || []));
  const embedded = [...tags.general]; // what the file itself says; your own tags are added on top
  tags.general = [...new Set([...embedded, ...localMeta.tags(key)])];
  const artists = (m?.artists || []).filter(Boolean);
  if (artists.length && !tags.artist.length) tags.artist.push(...artists);
  return {
    provider: 'local', id: path, rating: ['s', 'q', 'e'].includes(m?.rating) ? m.rating : 's', w: f.w || 1280, h: f.h || 720, ext: f.ext, kind, md5: m?.md5 || '', size: f.size,
    thumb: thumbUrl(dev, root, path), sample: kind === 'image' ? thumbUrl(dev, root, path, 1800) : null, full: fileUrl(dev, root, path),
    score: +m?.score || 0, up: 0, down: 0, favs: 0, tags, artists, sources: m?.sources || [], created: f.mtime ? new Date(f.mtime * 1000).toISOString() : '', desc: m?.site ? `${m.site} #${m.id}` : path,
    parent: null, children: [], pools: [], duration: 0, comments: 0, faved: false, url: m?.url || '', alts: [], isComic: false, _key: key, _name: f.name, _from: m?.site ? `${m.site} #${m.id}` : '', _embedded: embedded,
  };
}

/* ------------------------------------------------------------------ the screen */
const crumb = (text, run) => h('button', { class: 'btn fback', html: icon('left', 16) + `<span>${text}</span>`, onclick: run });

function emptyOff(root, ctx) {
  root.replaceChildren(h('div', { class: 'empty-state' },
    h('div', { class: 'es-art', html: icon('folder', 56) }),
    h('h2', {}, 'Local is off'),
    h('p', {}, 'Browse the pictures and videos on this device, and on the other devices you sync with, like a gallery. Pick the folders yourself; nothing is copied or changed.'),
    h('button', { class: 'btn primary', onclick: () => ctx.openSettings?.('local') }, 'Turn it on in Settings')));
}

export function renderLocal(root, ctx, { devId, rootId, rel }) {
  if (!S('localOn')) return (emptyOff(root, ctx), null);
  if (!devId) return (renderDevices(root, ctx), null);
  return renderFolder(root, ctx, devId, rootId || '', rel || '');
}

function renderDevices(root, ctx) {
  const grid = h('div', { class: 'fgrid' });
  const head = h('div', { class: 'vhead' },
    h('div', {}, h('h1', {}, 'Local'), h('p', {}, 'Pictures and videos on your devices')),
    h('div', { class: 'vhead-act' },
      h('button', { class: 'btn', html: icon('refresh', 16) + '<span>Refresh</span>', onclick: () => paint(true) }),
      h('button', { class: 'btn', html: icon('settings', 16) + '<span>Choose folders</span>', onclick: () => ctx.openSettings?.('local') })));
  root.replaceChildren(head, grid);
  const paint = async (force) => {
    const list = await devices(force);
    if (!root.contains(grid)) return;
    grid.replaceChildren(...list.map((d) => {
      const el = folderCard({ id: d.id, name: d.here ? (isAndroid() ? 'This phone' : 'This computer') : d.name }, { count: 0, noun: 'folder', covers: [], onOpen: () => ctx.go(`#/local/${enc(d.id)}`) });
      el.dataset.hash = `#/local/${enc(d.id)}`;
      api(d, 'list', { root: '' }).then((j) => {
        el.querySelector('.fl-meta').textContent = `${j.folders.length} folder${j.folders.length === 1 ? '' : 's'}`;
        el.querySelector('.fl-thumbs').replaceChildren(...j.folders.flatMap((f) => f.covers.map((c) => thumbUrl(d, f.id, c, 160))).slice(0, 3).map((u) => h('img', { src: u, alt: '', draggable: 'false', onerror: (e) => e.target.remove() })));
      }).catch((e) => { el.querySelector('.fl-meta').textContent = d.here ? 'no folders chosen yet' : 'not reachable'; el.title = e.message; });
      return el;
    }));
  };
  paint();
}

function renderFolder(root, ctx, devId, rootId, rel) {
  const state = { filter: '', sort: S('localSort') || 'new', files: [], dev: null, token: 0 };
  const scroller = h('div', { class: 'gal' + (S('blurThumbs') ? ' blur' : '') + (S('showMeta') ? ' meta-on' : '') });
  const folderRow = h('div', { class: 'fgrid' });
  const status = h('p', {});
  const title = h('h1', {}, '…');
  const inputEl = h('input', { class: 'input', placeholder: 'Filter by name or tag…', spellcheck: 'false', oninput: debounce((e) => { state.filter = e.target.value.trim().toLowerCase(); fill(); }, 120) });

  const gal = new Gallery(scroller, {
    onOpen: (vi, tile) => ctx.openViewer(gal, vi, tile),
    onNeedMore: () => {},
    onPin: () => toast('Pinning is not available for local files yet', { ms: 2200 }),
    onSelect: (n) => bar.update(n),
    onOpenSite: () => {},
    contextExtra: (p) => [{ label: 'Edit tags…', icon: 'edit', run: () => editTags([p]) }],
  });
  const bar = selBar(gal, [
    { label: 'Add tags', icon: 'plus', run: (sel) => editTags(sel, 'add') },
    { label: 'Remove tags', icon: 'minus', run: (sel) => editTags(sel, 'remove') },
  ]);

  const words = (s) => s.split(/[\s,]+/).map((t) => t.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
  async function editTags(posts, mode = 'set') {
    const first = posts[0];
    const text = await promptText(mode === 'add' ? 'Add tags' : mode === 'remove' ? 'Remove tags' : 'Your tags', mode === 'set' ? localMeta.tags(first._key).join(' ') : '', 'space-separated, e.g. wallpaper cat');
    if (text == null) return;
    const w = words(text);
    for (const p of posts) {
      const have = localMeta.tags(p._key);
      const next = mode === 'add' ? [...new Set([...have, ...w])] : mode === 'remove' ? have.filter((t) => !w.includes(t)) : [...new Set(w)];
      localMeta.setTags(p._key, next);
      p.tags.general = [...new Set([...p._embedded, ...next])];
    }
    if (mode !== 'set') gal.setSelectMode(false);
    fill();
    toast(mode === 'remove' ? 'Tags removed' : 'Tags saved', { ms: 1200 });
  }

  const sorted = () => {
    const l = state.files.slice();
    const t = (p) => Date.parse(p.created) || 0;
    if (state.sort === 'old') l.sort((a, b) => t(a) - t(b));
    else if (state.sort === 'name') l.sort((a, b) => a._name.localeCompare(b._name, undefined, { numeric: true }));
    else if (state.sort === 'size') l.sort((a, b) => b.size - a.size);
    else if (state.sort === 'shuffle') l.sort(() => Math.random() - 0.5);
    else l.sort((a, b) => t(b) - t(a));
    return l;
  };
  function fill() {
    const q = state.filter;
    const list = sorted().filter((p) => !q || p._name.toLowerCase().includes(q) || Object.values(p.tags).some((l) => l.some((t) => t.includes(q))));
    gal.setItems(list);
    if (!list.length && !q && folderRow.childElementCount) return gal.setFoot(h('div')); // just folders here: no "empty" message under them
    gal.setFoot(list.length ? h('div', { class: 'foot-end' }, h('i', { html: icon('folder', 16) }), `${fmtNum(list.length)} ${list.length === 1 ? 'file' : 'files'}`)
      : h('div', { class: 'empty-state' }, h('div', { class: 'es-art', html: icon('folder', 56) }), h('h2', {}, q ? 'Nothing matches' : state.files.length ? 'Nothing here' : 'No pictures or videos in this folder')));
  }

  const toParent = () => {
    if (rel) return ctx.go(`#/local/${enc(devId)}?r=${enc(rootId)}${rel.includes('/') ? '&d=' + enc(rel.slice(0, rel.lastIndexOf('/'))) : ''}`);
    return ctx.go(rootId ? `#/local/${enc(devId)}` : '#/local');
  };
  const head = h('div', { class: 'vhead bd' },
    crumb(rootId ? (rel ? 'Up' : 'Folders') : 'Devices', toParent),
    h('div', { class: 'bd-title' }, title, status),
    h('div', { class: 'vhead-act' },
      inputEl,
      segmented(SORTS, state.sort, (v) => { state.sort = v; fill(); }),
      h('button', { class: 'btn', html: icon('select', 16) + '<span>Select</span>', onclick: () => gal.setSelectMode(!gal.selectMode) }),
      h('button', { class: 'ibtn', title: 'Refresh', html: icon('refresh', 18), onclick: () => load() })));
  scroller.prepend(folderRow); // folders and files share one scroll area, folders on top
  root.replaceChildren(head, scroller, bar);

  const subHash = (name) => `#/local/${enc(devId)}?r=${enc(rootId)}&d=${enc(rel ? rel + '/' : '')}${enc(name)}`.replace(/%2F/g, '%2F');

  async function load() {
    const mine = ++state.token;
    status.textContent = 'Loading…';
    try {
      const dev = (await devices()).find((d) => d.id === devId);
      if (!dev) throw new Error('That device is not sharing right now');
      state.dev = dev;
      const j = await api(dev, 'list', rootId ? { root: rootId, path: rel } : { root: '' });
      if (mine !== state.token || !root.contains(scroller)) return;
      const rootName = rootId ? '' : '';
      title.textContent = rel ? rel.split('/').pop() : rootId ? (await rootLabel(dev)) : dev.here ? (isAndroid() ? 'This phone' : 'This computer') : dev.name;
      state.files = j.files.map((f) => toPost(dev, rootId, rel, f));
      folderRow.hidden = !j.folders.length;
      folderRow.replaceChildren(...j.folders.map((f) => {
        const childRoot = rootId || f.id;
        const childRel = rootId ? (rel ? `${rel}/${f.name}` : f.name) : '';
        const hash = rootId ? subHash(f.name) : `#/local/${enc(devId)}?r=${enc(f.id)}`;
        const el = folderCard({ id: f.id || f.name, name: f.name }, {
          count: f.count, noun: 'file',
          covers: f.covers.map((c) => thumbUrl(dev, childRoot, childRel ? `${childRel}/${c}` : c, 160)),
          onOpen: () => ctx.go(hash),
        });
        el.dataset.hash = hash;
        return el;
      }));
      const nf = j.folders.length;
      status.textContent = [nf ? `${nf} folder${nf === 1 ? '' : 's'}` : '', state.files.length ? `${fmtNum(state.files.length)} file${state.files.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || (j.roots ? 'No folders chosen yet. Choose some in Settings > Local' : 'Empty');
      fill();
    } catch (e) {
      status.textContent = e.message;
      gal.setItems([]);
    }
  }
  async function rootLabel(dev) {
    try { return (await api(dev, 'list', { root: '' })).folders.find((f) => f.id === rootId)?.name || 'Folder'; } catch { return 'Folder'; }
  }
  const off = on('localmeta', () => (root.contains(scroller) ? null : off()));
  const offFilter = on('local-filter', (e) => { if (!root.contains(scroller)) return offFilter(); inputEl.value = e.detail.tag; state.filter = e.detail.tag.toLowerCase(); fill(); });
  load();
  return gal;
}
