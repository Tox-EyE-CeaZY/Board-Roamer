import { h, ago, pretty, fmtNum, debounce, copyText } from './util.js';
import { icon } from './icons.js';
import { S, setS, subs, on, emit, tagc } from './store.js';
import { getProvider, Feed } from './providers.js';
import { toast, segmented, confirmDlg } from './ui.js';
import { openExternal } from './actions.js';
import { showMenu, bindContext } from './ctxmenu.js';
import { isPhone } from './platform.js';
import { announce } from './notify.js';

const staleMs = () => (S('followsFresh') || 20) * 60 * 1000;
let running = false;

/* ================================================================== checking for new posts */
export async function checkSub(f) {
  const had = f.newCount || 0; // subs.update changes f in place, so remember it now
  const prov = getProvider(f.p);
  const ratings = S('filters').ratings;
  const feed = new Feed(prov, [{ t: f.t, op: '+' }], { order: '', score: 0, ratings, media: '', shape: '', age: '' });
  feed.limit = 8; // a handful is enough to know what's new — keeps the check cheap
  try {
    const posts = (await prov.page(feed)).filter((p) => ratings[p.rating]).sort((a, b) => b.id - a.id);
    const latest = posts[0];
    const patch = { checked: Date.now(), err: '', thumbs: posts.slice(0, 4).map((p) => p.thumb) };
    if (latest) Object.assign(patch, { latestId: Math.max(latest.id, f.latestId || 0), latestAt: latest.created });
    // the very first check is a baseline: nothing already there counts as "new"
    if (!f.seenId && latest) Object.assign(patch, { seenId: latest.id, newCount: 0 });
    else patch.newCount = posts.filter((p) => p.id > f.seenId).length;
    if (!f.count) {
      try {
        const info = await prov.tagInfo?.(f.t);
        if (info) (patch.count = info.count), tagc.set(prov.id, f.t, info);
      } catch {}
    }
    subs.update(f.id, patch);
    return patch.newCount > had; // more than last time: worth a notification
  } catch (e) {
    subs.update(f.id, { checked: Date.now(), err: e.message });
    return false;
  }
}

/** Check followed artists one by one (the proxy paces the requests). Only stale ones unless forced. */
export async function refreshAll({ force = false, only = null } = {}) {
  if (running) return;
  const list = (only || subs.all()).filter((f) => force || !f.checked || Date.now() - f.checked > staleMs());
  if (!list.length) return;
  running = true;
  let done = 0;
  const fresh = [];
  emit('subs-progress', { running: true, done, total: list.length });
  for (const f of list) {
    if (!subs.get(f.id)) continue;
    if (await checkSub(subs.get(f.id))) fresh.push(f.t);
    emit('subs-progress', { running: true, done: ++done, total: list.length });
  }
  running = false;
  if (fresh.length) announce('follows', fresh);
  emit('subs-progress', { running: false, done, total: list.length });
}
export const isRefreshing = () => running;

export function follow(tag, provId) {
  const prov = getProvider(provId);
  const had = subs.find(prov.credKey, tag);
  if (had) {
    subs.remove(had.id);
    toast(`Unfollowed ${pretty(tag)}`, { ms: 1600 });
    return false;
  }
  const f = subs.add({ p: prov.credKey, t: tag, cat: 'artist' });
  toast(`Following ${pretty(tag)} — new posts will show up in Follows`, { ms: 2200 });
  checkSub(f); // baseline right away
  return true;
}

/* ================================================================== view */
const BUCKETS = [['Today', 1], ['This week', 7], ['This month', 31], ['Earlier this year', 365], ['Long quiet', Infinity]];

function bucketOf(f) {
  if (!f.latestAt) return 'Not checked yet';
  const days = (Date.now() - new Date(f.latestAt).getTime()) / 864e5;
  return BUCKETS.find(([, d]) => days <= d)[0];
}

export function renderFollows(root, ctx) {
  const st = { q: '', sel: new Set(), selecting: false };
  const host = h('div', { class: 'fgrid-host' });
  const sub = h('p', {});
  const progress = h('div', { class: 'f-progress', hidden: true }, h('i'));
  const refreshBtn = h('button', { class: 'btn', title: 'Check everyone for new posts', onclick: () => refreshAll({ force: true }), html: icon('refresh', 16) + '<span>Refresh</span>' });
  const blendBtn = h('button', { class: 'btn primary', onclick: () => ctx.feedOf(st.sel.size ? subs.all().filter((f) => st.sel.has(f.id)) : subs.all()), html: icon('bell', 16) + '<span>Open feed</span>' });
  const selBtn = h('button', { class: 'btn', onclick: () => { st.selecting = !st.selecting; st.sel.clear(); paint(); }, html: icon('select', 16) + '<span>Select</span>' });

  /* follow-an-artist box (uses the active source's autocomplete, artists only) */
  const addIn = h('input', { class: 'input', placeholder: 'Follow an artist…  type a name', spellcheck: 'false' });
  const dd = h('div', { class: 'fadd-dd cut', hidden: true });
  let reqId = 0;
  addIn.addEventListener('input', debounce(async () => {
    const q = addIn.value.trim().toLowerCase().replace(/\s+/g, '_');
    if (q.length < 2) return (dd.hidden = true);
    const my = ++reqId;
    const prov = getProvider(ctx.provId);
    try {
      const res = (await prov.autocomplete(q)).filter((t) => t.cat === 'artist');
      if (my !== reqId) return;
      dd.replaceChildren(...(res.length ? res.map((t) => h('button', { class: 'sg cat-artist', onpointerdown: (e) => { e.preventDefault(); addIn.value = ''; dd.hidden = true; follow(t.name, prov.id); } },
        h('i', { class: 'dot' }), h('span', { class: 'sg-n' }, pretty(t.name)), h('span', { class: 'sg-k' }, fmtNum(t.count)))) : [h('div', { class: 'pm-empty' }, 'No artist by that name')]));
      dd.hidden = false;
    } catch { dd.hidden = true; }
  }, 220));
  addIn.addEventListener('blur', () => setTimeout(() => (dd.hidden = true), 150));
  addIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && addIn.value.trim()) { follow(addIn.value.trim().toLowerCase().replace(/\s+/g, '_'), ctx.provId); addIn.value = ''; dd.hidden = true; }
  });
  const filterIn = h('input', { class: 'input', placeholder: 'Filter…', spellcheck: 'false', oninput: debounce((e) => { st.q = e.target.value.trim().toLowerCase(); paint(); }, 120) });

  const sorts = [['latest', 'Latest activity'], ['unseen', 'Unseen first'], ['name', 'A–Z'], ['posts', 'Most posts'], ['added', 'Recently followed']];
  const sortSeg = segmented(sorts, S('subSort'), (v) => { setS('subSort', v); paint(); });
  const groupTgl = h('button', { class: 'tgl' + (S('subGroup') ? ' on' : ''), role: 'switch', title: 'Group by how recent', onclick: (e) => { setS('subGroup', !S('subGroup')); e.currentTarget.classList.toggle('on', S('subGroup')); paint(); } }, h('i'));

  // on a phone the sorting options fold into one button + a sheet, leaving room for the artists themselves
  const sortBtn = h('button', { class: 'btn sortbtn', 'aria-label': 'Sort and options', html: icon('list', 17) + '<span></span>', onclick: (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.bottom, [
      { header: 'Sort by' },
      ...sorts.map(([v, l]) => ({ label: l, checked: S('subSort') === v, run: () => { setS('subSort', v); paintSort(); paint(); } })),
      { sep: true },
      { label: 'Group by how recent', checked: S('subGroup'), run: () => { setS('subGroup', !S('subGroup')); paint(); } },
      { label: 'Mark everything seen', icon: 'check', run: () => { subs.markAllSeen(); toast('Everything marked as seen', { ms: 1400 }); } },
    ]);
  } });
  const paintSort = () => (sortBtn.querySelector('span').textContent = sorts.find(([v]) => v === S('subSort'))[1]);
  paintSort();
  root.replaceChildren(
    h('div', { class: 'vhead' },
      h('div', {}, h('h1', {}, 'Follows'), sub),
      h('div', { class: 'vhead-act' }, h('div', { class: 'fadd' }, addIn, dd), refreshBtn, selBtn, blendBtn)),
    progress,
    isPhone()
      ? h('div', { class: 'pools-ctl compact' }, sortBtn, filterIn)
      : h('div', { class: 'pools-ctl' }, sortSeg, h('label', { class: 'tgl-row' }, groupTgl, h('span', {}, 'Group by recency')), h('div', { class: 'spacer' }), filterIn,
        h('button', { class: 'btn', onclick: () => { subs.markAllSeen(); toast('Everything marked as seen', { ms: 1400 }); }, html: icon('check', 16) + '<span>Mark all seen</span>' })),
    host);

  const key = (f) => ({
    latest: -(f.latestAt ? new Date(f.latestAt).getTime() : 0),
    unseen: -((f.newCount || 0) * 1e13) - (f.latestAt ? new Date(f.latestAt).getTime() : 0) / 1e3,
    name: f.t,
    posts: -(f.count || 0),
    added: -f.added,
  }[S('subSort')]);

  const cache = new Map(); // id -> {sig, thumbSig, el}
  const sigOf = (f) => JSON.stringify([f.newCount, f.latestAt, f.err, f.count, !!f.checked, (f.thumbs || []).join('|'), st.sel.has(f.id), st.selecting]);
  const cardFor = (f) => {
    const sig = sigOf(f), hit = cache.get(f.id);
    if (hit && hit.sig === sig) return hit.el;
    const thumbSig = (f.thumbs || []).join('|');
    const el = card(f);
    // same pictures as before: keep the old, already-decoded thumbnails so nothing re-fades
    const keep = hit?.thumbSig === thumbSig ? hit.el.querySelector('.fc-thumbs') : null;
    if (keep) el.querySelector('.fc-thumbs').replaceWith(keep);
    if (st.painted) el.style.animation = 'none';
    else el.addEventListener('animationend', () => (el.style.animation = 'none'), { once: true }); // moving a card must not replay its entrance
    cache.set(f.id, { sig, thumbSig, el });
    return el;
  };

  const card = (f) => {
    const prov = getProvider(f.p);
    const thumbs = (f.thumbs || []).slice(0, 4);
    const el = h('article', { 'data-hash': ctx.roamHash([{ t: f.t, op: '+' }], {}, prov.id), class: 'fcard' + (f.newCount ? ' has-new' : '') + (f.err ? ' errd' : '') + (st.sel.has(f.id) ? ' sel' : ''), tabindex: 0, 'data-id': f.id, style: `--ph:${prov.color}` },
      h('div', { class: 'fc-thumbs' }, thumbs.length ? thumbs.map((s) => h('img', { src: s, alt: '', loading: 'lazy', draggable: 'false', onload: (e) => e.target.classList.add('ready') })) : h('i', { class: 'fc-empty', html: icon('user', 26) })),
      f.newCount ? h('span', { class: 'fc-new', title: `${f.newCount} new since you last looked`, html: icon('sparkle', 12) + (f.newCount >= 8 ? '8+' : f.newCount) + ' new' }) : null,
      h('div', { class: 'fc-body' },
        h('h3', {}, pretty(f.t), h('span', { class: 'prov' }, prov.short)),
        h('div', { class: 'fc-meta' },
          f.err ? h('span', { class: 'bad', title: f.err }, 'couldn’t check') : f.latestAt ? h('span', {}, `latest ${ago(f.latestAt)}`) : h('span', {}, f.checked ? 'no posts' : 'checking…'),
          f.count ? h('span', {}, `${fmtNum(f.count)} posts`) : null)),
      h('div', { class: 'fc-act' },
        f.newCount ? h('button', { title: 'Mark seen', html: icon('check', 15), onclick: (e) => (e.stopPropagation(), subs.markSeen(f.id)) }) : null,
        h('button', { title: 'Open on site', html: icon('external', 15), onclick: (e) => (e.stopPropagation(), openExternal(`${prov.web}/posts?tags=${encodeURIComponent(f.t)}`)) }),
        h('button', { title: 'Unfollow', html: icon('bellOn', 15), onclick: async (e) => { e.stopPropagation(); if (await confirmDlg('Unfollow?', `Stop following ${pretty(f.t)}?`, 'Unfollow')) subs.remove(f.id); } })),
      st.selecting ? h('i', { class: 'fc-sel', html: icon('check', 14) }) : null);
    const open = () => {
      if (st.selecting) { st.sel.has(f.id) ? st.sel.delete(f.id) : st.sel.add(f.id); return paint(true); }
      ctx.openFollow(f);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => e.key === 'Enter' && open());
    return el;
  };

  function paint(keepScroll) {
    const top = root.scrollTop;
    const all = subs.all();
    const unseen = subs.unseen();
    sub.textContent = all.length ? `${all.length} artist${all.length === 1 ? '' : 's'}${unseen ? ` · ${unseen} new post${unseen === 1 ? '' : 's'}` : ' · all caught up'}` : 'Follow artists to see what’s new from them';
    selBtn.classList.toggle('on', st.selecting);
    blendBtn.querySelector('span').textContent = st.sel.size ? `Feed of ${st.sel.size}` : 'Open feed';
    blendBtn.disabled = !all.length;
    if (!all.length) {
      host.replaceChildren(h('div', { class: 'empty-state' },
        h('div', { class: 'es-art', html: icon('bell', 64) }),
        h('h2', {}, 'Nobody followed yet'),
        h('p', {}, 'Follow an artist from the box above, from the bell next to an artist in the viewer, or from their card in the gallery. New posts are checked in the background and sorted here by latest activity.'),
        h('button', { class: 'btn primary', onclick: () => ctx.go('#/roam') }, 'Go roaming')));
      return;
    }
    let list = all.filter((f) => !st.q || f.t.includes(st.q));
    const k = (f) => key(f);
    list = list.sort((a, b) => (typeof k(a) === 'string' ? k(a).localeCompare(k(b)) : k(a) - k(b)));
    const groups = [];
    if (S('subSort') === 'latest' && S('subGroup')) {
      const order = ['Today', 'This week', 'This month', 'Earlier this year', 'Long quiet', 'Not checked yet'];
      const by = new Map();
      list.forEach((f) => { const b = bucketOf(f); (by.get(b) || by.set(b, []).get(b)).push(f); });
      order.forEach((b) => by.has(b) && groups.push([b, by.get(b)]));
    } else groups.push([null, list]);
    host.replaceChildren(...groups.flatMap(([label, items]) => [
      label && h('div', { class: 'f-group' }, h('span', {}, label), h('b', {}, items.length)),
      h('div', { class: 'fgrid' }, items.map(cardFor)),
    ]).filter(Boolean));
    for (const id of [...cache.keys()]) if (!subs.get(id)) cache.delete(id);
    st.painted = true;
    if (!list.length) host.replaceChildren(h('div', { class: 'empty-state' }, h('h2', {}, 'No match'), h('p', {}, 'Nobody followed matches that filter.')));
    if (keepScroll) root.scrollTop = top;
  }

  bindContext(host, (e) => {
    const el = e.target.closest('.fcard');
    if (!el) return null;
    const f = subs.get(el.dataset.id);
    if (!f) return null;
    const prov = getProvider(f.p);
    return [
      { header: pretty(f.t) },
      { label: 'Open', icon: 'eye', run: () => ctx.openFollow(f) },
      ctx.tabsOn?.() && { label: 'Open in new tab', icon: 'plus', run: () => ctx.openTab(el.dataset.hash, pretty(f.t), f.thumbs?.[0]) },
      f.newCount && { label: 'Mark seen', icon: 'check', run: () => subs.markSeen(f.id) },
      { label: 'Check now', icon: 'refresh', run: () => checkSub(f).then(() => toast('Checked', { ms: 1000 })) },
      { sep: true },
      { label: 'Select', icon: 'select', run: () => { st.selecting = true; st.sel.add(f.id); paint(true); } },
      { label: 'Open on site', icon: 'external', run: () => openExternal(`${prov.web}/posts?tags=${encodeURIComponent(f.t)}`) },
      { label: 'Copy name', icon: 'copy', run: () => copyText(f.t) },
      { sep: true },
      { label: 'Unfollow', icon: 'bellOn', danger: true, run: async () => { if (await confirmDlg('Unfollow?', `Stop following ${pretty(f.t)}?`, 'Unfollow')) subs.remove(f.id); } },
    ];
  });

  // live updates while this view is on screen
  const alive = () => root.isConnected && root.contains(host);
  const repaint = debounce(() => alive() && paint(true), 180);
  const offs = [on('subs', () => (alive() ? repaint() : offs.forEach((o) => o()))),
    on('subs-progress', (e) => {
      if (!alive()) return;
      const { running: r, done, total } = e.detail;
      progress.hidden = !r;
      progress.firstChild.style.width = (done / total) * 100 + '%';
      refreshBtn.disabled = r;
      refreshBtn.querySelector('span').textContent = r ? `Checking ${done}/${total}` : 'Refresh';
    })];
  paint();
  refreshAll(); // stale ones, quietly
  // a Follows tab left open in the background: catch up as soon as you come back to the window
  const onFocus = () => (alive() ? refreshAll() : removeEventListener('focus', onFocus));
  addEventListener('focus', onFocus);
}
