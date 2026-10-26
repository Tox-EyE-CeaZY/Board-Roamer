import { h, sleep } from './util.js';
import { icon } from './icons.js';
import { S, postKey, saved } from './store.js';
import { getProvider } from './providers.js';
import { toast } from './ui.js';
import { isAndroid, native } from './platform.js';

export let lastMeta = 'off';

export function fileName(p) {
  const prov = getProvider(p.provider);
  return `${prov.short}_${p.id}${p.artists?.length ? '_' + p.artists.slice(0, 2).join('+') : ''}.${p.ext}`;
}

/** Everything worth keeping inside the file, so it can be traced back to its post later. */
export function metaOf(p) {
  const prov = getProvider(p.provider);
  return {
    site: prov.name, siteId: p.provider, id: p.id, url: p.url, md5: p.md5 || '', fullUrl: p.full,
    artists: p.artists || [], tags: Object.values(p.tags || {}).flat(), tagsByCategory: p.tags,
    rating: p.rating, score: p.score, favs: p.favs, sources: p.sources || [], posted: p.created || '',
    desc: p.desc || '', pools: p.pools || [], parent: p.parent || null, width: p.w, height: p.h, ext: p.ext, savedBy: 'Board Roamer',
  };
}

export async function savePost(p, { dir = '', name = '' } = {}) {
  if (isAndroid()) {
    // the Android shell downloads, embeds the metadata and files it under Downloads/Board Roamer
    const r = await native.save(p.full, name || fileName(p), dir, S('embedMeta') ? metaOf(p) : null, S('ua'));
    lastMeta = r.meta;
    saved.add(p);
    return r.path;
  }
  const r = await fetch(`/save?u=${encodeURIComponent(p.full)}&name=${encodeURIComponent(name || fileName(p))}${dir ? '&dir=' + encodeURIComponent(dir) : ''}`, { method: 'POST', headers: { 'x-br-ua': S('ua') || '', 'content-type': 'application/json' }, body: S('embedMeta') ? JSON.stringify(metaOf(p)) : '' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'download failed');
  lastMeta = j.meta;
  saved.add(p);
  return j.path;
}

export const reveal = (path) => (isAndroid() ? native.reveal(path) : fetch('/open?reveal=' + encodeURIComponent(path), { method: 'POST' }));
export const openExternal = (url) => (isAndroid() ? native.open(url) : fetch('/open?u=' + encodeURIComponent(url), { method: 'POST' }));

/** opts.dir saves into a sub-folder; opts.numbered prefixes 001_, 002_… (keeps pool/comic order). */
export async function downloadMany(posts, opts = {}) {
  if (!posts.length) return;
  let ok = 0, last = '';
  const kill = toast(`Saving 0 / ${posts.length}…`, { ms: 600000 });
  const msg = document.querySelector('#toasts .toast:last-child .toast-msg');
  const pad = String(posts.length).length;
  let n = 0;
  for (const p of posts) {
    n++;
    try {
      last = await savePost(p, { dir: opts.dir, name: opts.numbered ? `${String(n).padStart(Math.max(3, pad), '0')}_${p.id}.${p.ext}` : '' });
      ok++;
    } catch {}
    if (msg) msg.textContent = `Saving ${ok} / ${posts.length}…`;
    await sleep(50);
  }
  kill();
  toast(`Saved ${ok} of ${posts.length} to Downloads\\Board Roamer${opts.dir ? '\\' + opts.dir : ''}`, { action: last ? { label: 'Show', run: () => reveal(last) } : null, ms: 6000 });
}

/** Floating action bar shown while selecting tiles. */
export function selBar(gallery, actions) {
  const count = h('b', { class: 'sb-n' }, '0');
  const bar = h('div', { class: 'selbar cut', hidden: true },
    h('div', { class: 'sb-count' }, count, h('span', {}, ' selected')),
    h('button', { class: 'btn', onclick: () => gallery.selectAll() }, 'All'),
    h('button', { class: 'btn', onclick: () => gallery.clearSel() }, 'None'),
    h('span', { class: 'vw-sep' }),
    actions.map((a) => h('button', { class: 'btn ' + (a.cls || ''), onclick: () => { const sel = gallery.selected(); if (sel.length) a.run(sel, bar); }, html: icon(a.icon, 16) + `<span>${a.label}</span>` })),
    h('span', { class: 'vw-sep' }),
    h('button', { class: 'btn primary', onclick: () => gallery.setSelectMode(false) }, 'Done'),
  );
  bar.update = (n) => {
    count.textContent = n;
    bar.hidden = !gallery.selectMode;
    bar.classList.toggle('empty', n === 0);
  };
  return bar;
}

export { postKey };
