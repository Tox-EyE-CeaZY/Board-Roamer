/**
 * The Fur Affinity section: its own tab, apart from the boards. Fur Affinity is not a tag board (artists, folders, one
 * big "latest" list, no tag search for apps), so it gets pages that fit it, built from the same parts as everything else:
 * the Gallery and Viewer, the blacklist, rating switches and tile settings, Follows, Boards (pins) and downloads.
 *
 *   #/fa                      Latest (front page) · Browse · Following · Seen (search what you browsed) · Liked here
 *   #/fa/user/<name>          an artist: Gallery · Scraps · Favorites · Folders   (?t=gallery|scraps|favs|folders|folder&f=<id>/<slug>)
 *   #/fa/post/<id>            one submission, opened in the viewer
 *
 * What the app never does by itself (FA's robots.txt closes it to apps): search the site, read the watch feed, favorite or
 * watch for real. Those open Fur Affinity in the browser. Favorites and upvotes here are saved on this device only.
 */
import { h, pretty, fmtNum, ago, debounce } from './util.js';
import { icon } from './icons.js';
import { S, setS, on, subs, kv, tagLinks } from './store.js';
import { getProvider, Feed } from './providers.js';
import { Gallery } from './gallery.js';
import { toast, segmented, dialog } from './ui.js';
import { selBar, openExternal as openExt, downloadMany } from './actions.js';
const openExternal = (u) => openExt(u, true); // this section's own buttons are the ones that leave the app
import { pinPopover, quickPin } from './pins.js';
import { folderCard } from './folders.js';
import { follow, refreshAll } from './follows.js';
import { parseToken } from './search.js';
import { faState, faStatus, faLogin, faVerify, faWatchStart, faWatchNames, faUrl, faIndex, faLikes, faSupported, faBusy, faName } from './fa.js';

const enc = encodeURIComponent;
const RATING_NAMES = [['s', 'General'], ['q', 'Mature'], ['e', 'Adult']];
const FRONT = [['0', 'Art'], ['1', 'Writing'], ['2', 'Music'], ['3', 'Crafts']];

function route() {
  const [path, q = ''] = location.hash.slice(1).split('?');
  return { seg: path.split('/').filter(Boolean).slice(1), p: new URLSearchParams(q) };
}
const hashOf = (path, params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  return '#/fa' + path + (q.toString() ? '?' + q : '');
};

/* ------------------------------------------------------------------ the banner (any screen, while Cloudflare wants a check) */
let banner = null;
export function initFaBanner() {
  if (banner || !faSupported()) return;
  banner = h('button', { class: 'fa-banner', hidden: true, onclick: () => faVerify().then(() => toast('A Fur Affinity window opened. Finish the check there; this closes by itself.', { ms: 4200 })) },
    h('i', { html: icon('info', 15) }), h('span', {}, 'Fur Affinity needs a quick check. ', h('b', {}, 'Tap to verify')));
  document.body.append(banner);
  on('fa-state', () => (banner.hidden = !faState.challenge));
}

/* ------------------------------------------------------------------ small parts */
function statusLine() {
  if (faState.challenge) return 'Waiting for Fur Affinity’s quick check…';
  const bits = [];
  if (faState.connected && faState.loggedIn !== false) bits.push(faState.me ? `Signed in as ${faState.me}` : 'Signed in');
  else if (faState.connected) bits.push('Your Fur Affinity sign-in has expired. Sign in again in Settings');
  else bits.push('Browsing signed out. Mature and Adult art usually needs an account (Settings > Fur Affinity)');
  if (faBusy()) bits.push('Fur Affinity is busy: background checks are paused');
  return bits.join(' · ');
}

/** The same layout and tile-size controls the boards use (the settings are shared, the gallery relayouts itself). */
function sizeTools(getGal) {
  const seg = h('div', { class: 'layout-seg' }, [['masonry', 'masonry'], ['rows', 'rows'], ['grid', 'grid']].map(([v, ic]) =>
    h('button', { 'data-v': v, title: v[0].toUpperCase() + v.slice(1) + ' layout', html: icon(ic, 17), onclick: () => setS('layout', v) })));
  const slider = h('input', { type: 'range', min: 130, max: 520, step: 10, title: 'Tile size', value: S('density'), oninput: debounce((e) => setS('density', +e.target.value), 60) });
  const sel = h('button', { class: 'ibtn', title: 'Select pictures', 'aria-label': 'Select pictures', html: icon('select', 18), onclick: () => { const g = getGal(); if (g) { g.setSelectMode(!g.selectMode); sel.classList.toggle('on', !!g.selectMode); } } });
  const wrap = h('div', { class: 'tools fa-tools' }, seg, slider, sel);
  const paint = () => { seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === S('layout'))); slider.value = S('density'); };
  paint();
  const off = on('settings', () => (wrap.isConnected ? paint() : off()));
  return wrap;
}

function ratingChips(onChange) {
  const wrap = h('div', { class: 'fa-ratings', title: 'Which ratings to show. This is the same setting as the boards use' });
  const paint = () => wrap.replaceChildren(...RATING_NAMES.map(([k, label]) => h('button', { class: 'fa-rt r-' + k + (S('filters').ratings[k] ? ' on' : ''), title: `${label}: ${S('filters').ratings[k] ? 'shown' : 'hidden'}`, onclick: () => {
    const f = S('filters');
    setS('filters', { ...f, ratings: { ...f.ratings, [k]: !f.ratings[k] } });
    paint();
    onChange();
  } }, label)));
  paint();
  return wrap;
}

const crumb = (text, run) => h('button', { class: 'btn fback', html: icon('left', 16) + `<span>${text}</span>`, onclick: run });

function feedFor(src, terms = []) {
  const f = new Feed(getProvider('fa'), terms, { order: '', score: 0, ratings: S('filters').ratings, media: '', shape: '', age: '' });
  f.fa = src;
  return f;
}

/** A name box with suggestions from what was seen. `pick(name)` runs on Enter or a tap. */
function nameBox(placeholder, pick, { artistsOnly = false } = {}) {
  const input = h('input', { class: 'input', placeholder, spellcheck: 'false' });
  const dd = h('div', { class: 'fadd-dd cut', hidden: true });
  const names = () => {
    const w = input.value.trim().toLowerCase().split(/\s+/).pop().replace(/^[-~]/, '');
    if (w.length < 2) return [];
    return faIndex.tags(w, 8).filter((t) => !artistsOnly || t.isArtist !== false);
  };
  input.addEventListener('input', debounce(() => {
    const list = names();
    dd.replaceChildren(...list.map((t) => h('button', { class: 'sg', onpointerdown: (e) => { e.preventDefault(); pick(t.name, input); dd.hidden = true; } }, h('i', { class: 'dot' }), h('span', { class: 'sg-n' }, pretty(t.name)), h('span', { class: 'sg-k' }, fmtNum(t.count)))));
    dd.hidden = !list.length;
  }, 120));
  input.addEventListener('blur', () => setTimeout(() => (dd.hidden = true), 150));
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && input.value.trim()) pick(input.value.trim(), input, true); });
  return { input, el: h('div', { class: 'fadd' }, input, dd) };
}

/* ------------------------------------------------------------------ the grid every page here shows */
function makeGrid(ctx, { top = [] } = {}) {
  const scroller = h('div', { class: 'gal' + (S('blurThumbs') ? ' blur' : '') + (S('showMeta') ? ' meta-on' : '') });
  let feed = null, run = 0, busy = false;
  const gal = new Gallery(scroller, {
    onOpen: (vi, tile) => ctx.openViewer(gal, vi, tile),
    onNeedMore: () => more(),
    onPin: (ps) => quickPin(ps),
    onOpenSite: (p) => openExternal(p.url),
    onSelect: (n) => bar.update(n),
  });
  gal.provId = 'fa';
  const bar = selBar(gal, [
    { label: 'Pin', icon: 'pin', run: (sel, el) => pinPopover(el, sel) },
    { label: 'Download', icon: 'download', run: (sel) => downloadMany(sel) },
  ]);
  if (top.length) scroller.prepend(...top);

  const foot = (text, ...more) => gal.setFoot(h('div', { class: 'foot-end' }, h('i', { html: icon('paw', 16) }), text, ...more));
  const failed = (e) => {
    if (e.needsLogin) return gal.setFoot(h('div', { class: 'empty-state err' }, h('div', { class: 'es-art', html: icon('user', 56) }), h('h2', {}, 'Sign in to Fur Affinity'), h('p', {}, 'This page needs your account.'), h('button', { class: 'btn primary', onclick: () => faLogin() }, 'Sign in')));
    gal.setFoot(h('div', { class: 'empty-state err' }, h('h2', {}, e.robots ? 'Opens in your browser' : 'That did not load'), h('p', {}, e.message),
      h('div', { class: 'row-btns' }, e.paused ? null : h('button', { class: 'btn', onclick: () => more() }, 'Try again'))));
  };
  async function more(force) {
    if (!feed || feed.done || busy || (feed.hold && !force)) return;
    feed.hold = false;
    busy = true;
    const mine = run;
    foot(faState.challenge ? 'Waiting for Fur Affinity’s quick check…' : 'Loading…');
    try {
      const posts = await feed.next();
      if (mine !== run) return;
      gal.append(posts);
      if (feed.done) foot(gal.length ? 'That is everything' : feed.fa?.kind === 'liked' ? 'Nothing liked here yet' : 'Nothing to show');
      else if (feed.hold) gal.setFoot(h('div', { class: 'foot-end' }, h('button', { class: 'btn primary', onclick: () => more(true) }, 'Load more')))
      else if (!posts.length) foot('');
      else gal.setFoot(h('div'));
      gal.hooks && feed.pageInfo && ctx.faPageInfo?.(feed.pageInfo);
    } catch (e) {
      if (mine === run) failed(e);
    } finally {
      busy = false;
    }
  }
  const off = on('fa-state', () => {
    if (!scroller.isConnected) return off();
    if (!faState.challenge && busy === false && feed && !feed.done && !gal.length) more();
  });
  return {
    scroller, gal, bar,
    load(f) {
      feed = f;
      run++;
      busy = false;
      gal.setItems([]);
      more();
    },
    get feed() { return feed; },
    reload: () => feed && feed.fa && (feed = feedFor(feed.fa, feed.terms), run++, busy = false, gal.setItems([]), more()),
  };
}

/* ------------------------------------------------------------------ first visit */
async function intro() {
  if (kv.get('faIntro', false)) return;
  kv.set('faIntro', true);
  await dialog({
    title: 'Fur Affinity in Board Roamer',
    body: h('div', { class: 'dlg-text' },
      h('p', {}, 'Fur Affinity has its own section here, apart from the boards. You browse the front page, artists’ galleries, scraps and favorites, and open pictures in the same viewer.'),
      h('p', {}, 'Fur Affinity asks apps to go gently and to stay off its search, its watch feed and its favorite and watch buttons. So Board Roamer keeps to one request a second, and those three open Fur Affinity in your browser.'),
      h('p', {}, h('b', {}, 'Favorites and upvotes you give here are saved in Board Roamer only, not on Fur Affinity.'), ' “Seen” lets you search everything you have browsed, on this device, without asking the site.')),
    actions: [{ label: 'Got it', value: true, cls: 'primary' }],
  });
}

function emptyOff(root, ctx) {
  root.replaceChildren(h('div', { class: 'empty-state' },
    h('div', { class: 'es-art', html: icon('paw', 56) }),
    h('h2', {}, faSupported() ? 'Fur Affinity is off' : 'Not on Android yet'),
    h('p', {}, faSupported() ? 'A section for Fur Affinity, separate from the boards: the front page, artists’ galleries, scraps and favorites. Turn it on in Settings.' : 'The Fur Affinity section needs the desktop app for now.'),
    faSupported() ? h('button', { class: 'btn primary', onclick: () => ctx.openSettings?.('fa') }, 'Turn it on in Settings') : null));
}

/* ------------------------------------------------------------------ entry */
export function renderFa(root, ctx) {
  if (!faSupported() || !S('faOn')) return (emptyOff(root, ctx), null);
  initFaBanner();
  faStatus();
  intro();
  const { seg, p } = route();
  if (seg[0] === 'user' && seg[1]) return renderUser(root, ctx, decodeURIComponent(seg[1]).toLowerCase(), p);
  return renderHome(root, ctx, p);
}

/* ------------------------------------------------------------------ home */
function renderHome(root, ctx, p) {
  const tab = ['front', 'browse', 'following', 'seen', 'liked'].includes(p.get('t')) ? p.get('t') : 'front';
  const section = FRONT.some(([v]) => v === p.get('s')) ? p.get('s') : '0';
  const q = p.get('q') || '';
  const status = h('p', {}, statusLine());
  const off = on('fa-state', () => (root.contains(status) ? (status.textContent = statusLine()) : off()));

  const tabs = segmented([['front', 'Latest'], ['browse', 'Browse'], ['following', 'Following'], ['seen', 'Seen'], ['liked', 'Liked here']], tab, (v) => ctx.go(hashOf('', { t: v === 'front' ? '' : v })));
  const open = nameBox('Open an artist…  e.g. a user name', (name, input, enter) => {
    const user = faName(name);
    if (user) ctx.go(hashOf('/user/' + enc(user)));
  });
  const head = h('div', { class: 'vhead' },
    h('div', {}, h('h1', {}, 'Fur Affinity'), status),
    h('div', { class: 'vhead-act' }, open.el,
      h('button', { class: 'btn', title: 'Open Fur Affinity in your browser', html: icon('external', 16) + '<span>Site</span>', onclick: () => openExternal(faUrl.front()) }),
      h('button', { class: 'ibtn', title: 'Fur Affinity settings', html: icon('settings', 18), onclick: () => ctx.openSettings?.('fa') })));

  const bits = [tabs];
  if (tab === 'front') bits.push(segmented(FRONT, section, (v) => ctx.go(hashOf('', { s: v === '0' ? '' : v }))));
  const grid = makeGrid(ctx);
  const reload = () => grid.reload();
  bits.push(h('div', { class: 'fa-fill' }), sizeTools(() => grid.gal), ratingChips(reload));
  const bar = h('div', { class: 'fa-bar' }, ...bits);
  root.replaceChildren(head, bar);

  if (tab === 'following') {
    root.append(followingPane(ctx));
    return null;
  }
  if (tab === 'seen') {
    const row = h('div', { class: 'fa-seenbar' });
    const box = nameBox('Search what you have browsed: tags, an artist, rating:q  (- excludes)', (name, input, enter) => {
      if (enter) return ctx.go(hashOf('', { t: 'seen', q: input.value.trim() }));
      const words = input.value.trim().split(/\s+/);
      words.pop();
      input.value = [...words, name].join(' ') + ' ';
      input.focus();
    });
    box.input.value = q;
    const siteBtn = h('button', { class: 'btn', title: 'Fur Affinity’s own search does not let apps in, so it opens in your browser', html: icon('external', 15) + '<span>Search on Fur Affinity</span>', onclick: () => (box.input.value.trim() ? openExternal(faUrl.search(box.input.value.trim())) : toast('Type something to search for', { ms: 1400 })) });
    row.append(box.el, h('button', { class: 'btn primary', html: icon('search', 15) + '<span>Search</span>', onclick: () => ctx.go(hashOf('', { t: 'seen', q: box.input.value.trim() })) }), siteBtn,
      h('small', { class: 'dim' }, `${fmtNum(faIndex.size())} submissions remembered on this device`));
    root.append(row);
  }
  root.append(grid.scroller, grid.bar);

  const terms = q.split(/\s+/).map(parseToken).filter(Boolean);
  if (tab === 'seen' && !faIndex.size()) {
    grid.gal.setFoot(h('div', { class: 'empty-state' }, h('div', { class: 'es-art', html: icon('search', 56) }), h('h2', {}, 'Nothing seen yet'), h('p', {}, 'Browse Latest or an artist’s gallery and every submission you see becomes searchable here, by tag, artist, rating or title, even offline.')));
    return grid.gal;
  }
  if (tab === 'seen' && !terms.length) {
    grid.gal.setFoot(h('div', { class: 'empty-state' }, h('div', { class: 'es-art', html: icon('search', 56) }), h('h2', {}, 'Search what you have seen'), h('p', {}, 'Type tags or an artist name. Tags work like the boards: a word must match, -word must not. Fur Affinity’s own search opens on the site.')));
    return grid.gal;
  }
  const src = { front: { kind: 'front', section: +section }, browse: { kind: 'browse' }, seen: { kind: 'seen' }, liked: { kind: 'liked' } }[tab];
  grid.load(feedFor(src, terms));
  return grid.gal;
}

function followingPane(ctx) {
  const wrap = h('div', { class: 'fa-follow' });
  const list = () => subs.all().filter((f) => f.p === 'fa');
  const paint = () => {
    const fl = list();
    wrap.replaceChildren(
      h('div', { class: 'fa-fl-head' },
        h('p', {}, fl.length ? `${fl.length} artist${fl.length === 1 ? '' : 's'} you follow here. Following is Board Roamer’s own list; Fur Affinity’s watch feed opens on the site.` : 'You are not following anyone from Fur Affinity yet. Open an artist and tap Follow.'),
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn' + (fl.length ? '' : ' primary'), html: icon('download', 15) + '<span>Import my watch list</span>', title: 'Reads the watch list page you can see in the Fur Affinity window, once, when you tap', onclick: () => importWatchList(paint) }),
          fl.length ? h('button', { class: 'btn primary', html: icon('refresh', 15) + '<span>Check for new</span>', onclick: async (e) => { e.currentTarget.disabled = true; await refreshAll({ force: true, only: fl }); paint(); } }) : null,
          h('button', { class: 'btn', html: icon('external', 15) + '<span>My watch feed on Fur Affinity</span>', title: 'Fur Affinity does not let apps read it, so it opens in your browser', onclick: () => openExternal(P_WATCH) }))),
      h('div', { class: 'fa-fl-grid' }, fl.sort((a, b) => (b.newCount || 0) - (a.newCount || 0) || a.t.localeCompare(b.t)).map((f) => h('button', { class: 'fa-fl', onclick: () => ctx.go(hashOf('/user/' + enc(f.t))) },
        h('span', { class: 'fa-fl-thumbs' }, (f.thumbs || []).slice(0, 3).map((u) => h('img', { src: u, alt: '', loading: 'lazy', draggable: 'false', onerror: (e) => e.target.remove() }))),
        h('b', {}, pretty(f.t)), h('small', {}, f.err ? f.err : f.newCount ? `${f.newCount} new` : f.checked ? 'checked ' + ago(f.checked) : 'not checked yet')))));
  };
  paint();
  const off = on('subs-progress', () => (wrap.isConnected ? paint() : off()));
  return wrap;
}
const P_WATCH = 'https://www.furaffinity.net/msg/submissions/';
const P_BUDDY = 'https://www.furaffinity.net/controls/buddylist/';

/** One-time import: nothing is requested from the site. The person opens their own watch list in their browser and pastes it. */
async function importWatchList(done) {
  const have = new Set(subs.all().filter((f) => f.p === 'fa').map((f) => f.t));
  const area = h('textarea', { class: 'input', rows: 8, placeholder: 'Paste here…', spellcheck: 'false', style: 'width:100%;font:12px var(--f-mono)' });
  const list = h('div', { class: 'fa-imp', hidden: true });
  let picks = [];
  const preview = () => {
    // typed one per line; a paste is read from its links (see the paste handler), never by guessing at words
    const names = [...new Set(area.value.split(/\r?\n/).map((l) => l.trim().toLowerCase().replace(/^[@~]+/, '')).filter((l) => /^[a-z0-9][a-z0-9_.~-]{0,39}$/.test(l)))].filter((n) => !have.has(n) && n !== (faState.me || '').toLowerCase());
    picks = names.map((n) => ({ n, on: true }));
    list.hidden = !names.length;
    list.replaceChildren(h('p', { class: 'st-note' }, `${names.length} name${names.length === 1 ? '' : 's'} found. Untick anything that is not an artist.`),
      h('div', { class: 'fa-imp-grid' }, picks.map((p) => h('label', { class: 'fa-imp-i' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (p.on = e.target.checked) }), p.n))));
  };
  area.addEventListener('input', debounce(preview, 200));
  area.addEventListener('paste', async (e) => {
    const html = e.clipboardData?.getData('text/html');
    e.preventDefault();
    if (!html) { status.textContent = 'That copy had no links in it, so the artists can not be told apart from the other words on the page. Use the button above, or type one name per line.'; return; }
    const P = await import('./fa-parse.js');
    const names = P.parseWatchNames(P.parseHtml(html), 'body');
    area.value = names.join('\n');
    status.textContent = names.length ? `Read ${names.length} names from the pasted page.` : 'No artists were found in that. Is it the watch list page?';
    preview();
  });
  const status = h('p', { class: 'st-note' }, '');
  let timer = 0;
  const auto = h('button', { class: 'btn primary', html: icon('download', 15) + '<span>Open my watch list and import it</span>', onclick: async () => {
    auto.disabled = true;
    status.textContent = 'A Fur Affinity window opened. Sign in there if it asks; the list is read once the page shows it.';
    await faWatchStart();
    clearInterval(timer);
    const t0 = Date.now();
    timer = setInterval(async () => {
      const names = await faWatchNames();
      if (names) { clearInterval(timer); auto.disabled = false; const me = (faState.me || '').toLowerCase(); area.value = names.filter((n) => n !== me).join('\n'); status.textContent = names.length ? `Read ${names.length} names from your watch list.` : 'The list looked empty.'; preview(); }
      else if (Date.now() - t0 > 5 * 60_000 || !auto.isConnected) { clearInterval(timer); auto.disabled = false; if (auto.isConnected) status.textContent = 'Nothing arrived. You can try again, or paste the list below.'; }
    }, 1500);
  } });
  const body = h('div', { class: 'dlg-text' },
    h('p', {}, 'Board Roamer opens your own watch list page in its Fur Affinity window, the same page you would open yourself, and reads the names you see there. It makes that one visit only when you tap, and follows nothing until you confirm the list.'),
    h('div', { class: 'row-btns' }, auto, h('button', { class: 'btn', onclick: () => openExternal(P_BUDDY), html: icon('external', 14) + '<span>Open it in my browser</span>' })),
    status,
    h('details', {}, h('summary', {}, 'Or paste the page by hand'), h('p', { class: 'st-note' }, 'Select the whole watch list page in your browser (Ctrl+A), copy it (Ctrl+C), and paste it here. The artists are read from the page’s links.'), area),
    list);
  const r = await dialog({ title: 'Import my watch list', body, wide: true, actions: [{ label: 'Cancel', value: false }, { label: 'Follow these artists', cls: 'primary', value: true }] });
  clearInterval(timer);
  if (!r) return;
  const add = picks.filter((p) => p.on && !have.has(p.n));
  for (const p of add) subs.add({ p: 'fa', t: p.n, cat: 'artist' }); // no check per artist: "Check for new" (or the background option) does that, one request a second
  toast(add.length ? `Following ${add.length} artist${add.length === 1 ? '' : 's'} from your watch list. Press “Check for new” when you want to look for new art` : 'Nothing new to add', { ms: 3600 });
  done?.();
}


/** A user page that would not load: a friendly "no such user" for 400/404, otherwise the plain error. */
function missingUser(e, name, ctx) {
  const gone = /HTTP (400|404)|not found|no such/i.test(e.message || '');
  if (!gone) return h('div', { class: 'empty-state err' }, h('h2', {}, 'That did not load'), h('p', {}, e.message));
  const tried = faName(name);
  return h('div', { class: 'empty-state err' }, h('h2', {}, 'No artist called “' + name + '” on Fur Affinity'),
    h('p', {}, 'Fur Affinity names have no spaces or underscores (“barbie wire” is “barbiewire”). Check the spelling, or look the artist up on e621 to find their Fur Affinity link.'),
    h('div', { class: 'row-btns' },
      h('button', { class: 'btn', onclick: () => ctx.go('#/fa') }, 'Back'),
      h('button', { class: 'btn primary', html: icon('search', 15) + '<span>Search e621 for “' + tried + '”</span>', onclick: async () => { const t = await pickE621Artist(tried); if (t) ctx.go(ctx.roamHash([{ t, op: '+' }], null, 'e621')); } })));
}

/** Which e621 artist tag does this Fur Affinity name mean? Asks when unsure; remembers the answer. */
async function pickE621Artist(name) {
  const e6 = getProvider('e621');
  const bare = faName(name);
  const seen = new Map();
  for (const q of new Set([name, bare, bare + '*'])) {
    try { for (const t of await e6.autocomplete(q)) if (t.cat === 'artist' && !seen.has(t.name)) seen.set(t.name, t); } catch {}
  }
  const norm = (t) => faName(t.replace(/_\(artist\)$/, ''));
  const list = [...seen.values()].filter((t) => norm(t.name).includes(bare) || bare.includes(norm(t.name))).sort((a, b) => (norm(b.name) === bare) - (norm(a.name) === bare) || (b.count || 0) - (a.count || 0)).slice(0, 8);
  const link = (t) => (tagLinks.link([{ key: 'fa', tag: name }, { key: 'e621', tag: t }]), t);
  if (list.length === 1 && norm(list[0].name) === bare) return link(list[0].name);
  if (!list.length) return bare;
  const rows = list.map((t, i) => h('label', { class: 'pick-row' }, h('input', { type: 'radio', name: 'e6pick', value: t.name, checked: i === 0 }), h('span', {}, pretty(t.name)), h('span', { class: 'dim' }, ' · ' + fmtNum(t.count || 0) + ' posts')));
  const body = h('div', {}, h('p', {}, 'Which e621 tag is “' + name + '”?'), ...rows);
  const r = await dialog({ title: 'Which artist?', body, actions: [{ label: 'Cancel', value: null }, { label: 'Search “' + bare + '” as typed', value: 'raw' }, { label: 'Search this one', cls: 'primary', value: 'ok' }] });
  if (r === 'raw') return bare;
  if (r !== 'ok') return null;
  const pick = body.querySelector('input:checked');
  return pick ? link(pick.value) : null;
}

/* ------------------------------------------------------------------ an artist */
function renderUser(root, ctx, name, p) {
  const tab = ['profile', 'gallery', 'scraps', 'favs', 'folders', 'folder'].includes(p.get('t')) ? p.get('t') : 'profile';
  const prov = getProvider('fa');
  const title = h('h1', {}, pretty(name));
  const sub = h('p', {}, '');
  const stats = h('div', { class: 'fa-stats' });
  const bio = h('div', { class: 'fa-bio', hidden: true });
  const actions = h('div', { class: 'fa-act' });
  const paintFollow = () => {
    const on = !!subs.find('fa', name);
    actions.replaceChildren(
      h('button', { class: 'btn' + (on ? ' primary' : ''), title: 'Board Roamer’s own follow: new posts show up in Follows. It does not watch them on Fur Affinity', onclick: () => (follow(name, 'fa'), setTimeout(paintFollow, 50)), html: icon(on ? 'bellOn' : 'bell', 15) + `<span>${on ? 'Following' : 'Follow'}</span>` }),
      h('button', { class: 'btn', title: 'Fur Affinity does not let apps watch for you: its page opens in your browser', onclick: () => openExternal(faUrl.user(name)), html: icon('eye', 15) + '<span>Watch on Fur Affinity</span>' }),
      h('button', { class: 'btn', onclick: () => openExternal(faUrl.journals(name)), html: icon('book', 15) + '<span>Journals</span>', title: 'Journals open on Fur Affinity' }),
      linked(name));
  };
  const linked = (n) => {
    const e6 = tagLinks.suggest('fa', n, 'e621');
    return h('button', { class: 'btn', title: e6 ? `Same artist on e621 as ${pretty(e6)}` : 'Look for this artist on e621', onclick: async () => {
      const tag = e6 || (await pickE621Artist(n));
      if (tag) ctx.go(ctx.roamHash([{ t: tag, op: '+' }], null, 'e621'));
    }, html: icon('search', 15) + `<span>On e621${e6 ? '' : '?'}</span>` });
  };
  const tabs = segmented([['profile', 'Profile'], ['gallery', 'Gallery'], ['scraps', 'Scraps'], ['favs', 'Favorites'], ['folders', 'Folders']], tab === 'folder' ? 'folders' : tab, (v) => ctx.go(hashOf('/user/' + enc(name), { t: v === 'profile' ? '' : v })));
  const head = h('div', { class: 'vhead bd' },
    crumb('Fur Affinity', () => ctx.go('#/fa')),
    h('div', { class: 'bd-title' }, title, sub),
    h('div', { class: 'vhead-act' }, h('button', { class: 'btn', onclick: () => openExternal(faUrl.user(name)), html: icon('external', 15) + '<span>On Fur Affinity</span>' })));
  const info = h('div', { class: 'fa-user' }, stats, actions, bio);
  const bar = h('div', { class: 'fa-bar' }, tabs, h('div', { class: 'fa-fill' }));
  let grid;
  const rate = ratingChips(() => grid?.reload());
  bar.append(sizeTools(() => grid?.gal), rate);
  paintFollow();
  root.replaceChildren(head);

  const paintInfo = (u) => {
    title.textContent = u.display || pretty(name);
    sub.textContent = [`@${u.lower || name}`, u.title, u.registered ? 'joined ' + new Date(u.registered).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : '', u.watching ? 'you watch them on Fur Affinity' : ''].filter(Boolean).join(' · ');
    const st = u.stats || {};
    if (tab !== 'profile') stats.replaceChildren(...[['Views', st.views], ['Submissions', st.submissions], ['Favs', st.favs], ['Watchers', u.watchers]].filter(([, v]) => v).map(([k, v]) => h('span', { class: 'fa-st' }, h('b', {}, fmtNum(v)), ' ' + k)));
    if (u.bio && tab !== 'profile') (bio.hidden = false), (bio.textContent = u.bio);
    if (u.aliases?.length) sub.textContent += ' · was ' + u.aliases.slice(0, 3).join(', ');
  };

  if (tab === 'profile') {
    root.append(h('div', { class: 'fa-userwrap' }, info), bar);
    const host = h('div', { class: 'fa-profile' }, h('p', { class: 'dim' }, 'Loading the profile…'));
    root.append(host);
    prov.user(name).then((u) => { paintInfo(u); profileBody(host, u, name, ctx); }).catch((e) => host.replaceChildren(missingUser(e, name, ctx)));
    return null;
  }

  if (tab === 'folders') {
    root.append(h('div', { class: 'fa-userwrap' }, info), bar);
    const host = h('div', { class: 'fa-folders' }, h('p', { class: 'dim' }, 'Loading folders…'));
    root.append(host);
    prov.user(name).then(paintInfo).catch(() => {});
    import('./fa.js').then(async ({ faHtml }) => {
      try {
        const P = await import('./fa-parse.js');
        const { doc } = await faHtml(faUrl.gallery(name));
        const groups = P.parseFolders(doc);
        host.replaceChildren(...(groups.length ? groups.map((g) => h('section', { class: 'fa-fgroup' }, h('h3', {}, g.name), h('div', { class: 'fgrid' }, g.folders.map((f) => {
          const hash = hashOf('/user/' + enc(name), { t: 'folder', f: `${f.id}/${f.slug}` });
          const el = folderCard({ id: f.id, name: f.name }, { count: f.count, noun: 'submission', covers: [], onOpen: () => ctx.go(hash) });
          el.dataset.hash = hash;
          return el;
        })))) : [h('div', { class: 'empty-state' }, h('h2', {}, 'No folders'), h('p', {}, 'This artist keeps everything in the main gallery.'))]));
      } catch (e) {
        host.replaceChildren(h('div', { class: 'empty-state err' }, h('h2', {}, 'That did not load'), h('p', {}, e.message)));
      }
    });
    return null;
  }

  const folder = tab === 'folder' ? (() => { const [id, slug] = String(p.get('f') || '').split('/'); return id ? { id, slug: slug || '' } : null; })() : null;
  grid = makeGrid(ctx, { top: [h('div', { class: 'fa-userwrap' }, info)] });
  root.append(bar, grid.scroller, grid.bar);
  const kind = tab === 'folder' ? 'folder' : tab;
  grid.load(feedFor({ kind, user: name, folder }, [{ t: name, op: '+' }]));
  ctx.faPageInfo = (pi) => { if (pi.user?.display && title.textContent === pretty(name)) paintInfo({ ...pi.user, stats: {} }); };
  prov.user(name).then(paintInfo).catch(() => {});
  return grid.gal;
}

/* ------------------------------------------------------------------ a profile page, read from the user's own page and laid out here */
function linkify(text) {
  const out = [];
  let at = 0;
  for (const m of String(text).matchAll(/https?:\/\/[^\s<>"')]+/g)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(h('a', { href: '#', onclick: (e) => (e.preventDefault(), openExternal(m[0])) }, m[0]));
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function profileBody(host, u, name, ctx) {
  const open = (id) => ctx.go(hashOf('/user/' + enc(name), { post: id }));
  const card = (title, kids, cls = '', act = null) => h('section', { class: 'fa-card cut ' + cls }, h('header', {}, h('h3', {}, title), act), h('div', { class: 'fa-card-b' }, kids));
  const strip = (title, figs, tab) => figs?.length ? card(title, h('div', { class: 'fa-pf-strip' }, figs.slice(0, 24).map((f) => h('button', { class: 'fa-pf-th r-' + (f.rating || 'general')[0], title: f.title || '', onclick: () => open(f.id) }, h('img', { src: '/img?u=' + encodeURIComponent(f.thumb), alt: '', loading: 'lazy', draggable: 'false', onerror: (e) => e.target.remove() })))), 'wide',
    tab ? h('button', { class: 'btn', onclick: () => ctx.go(hashOf('/user/' + enc(name), { t: tab })) }, 'See all') : null) : null;
  const st = u.stats || {};
  const tiles = [['Views', st.views], ['Submissions', st.submissions], ['Favorites', st.favs], ['Watchers', u.watchers], ['Watching', u.watching_count], ['Comments earned', st['comments earned']], ['Comments made', st['comments made']], ['Journals', st.journals]].filter(([, v]) => v);
  const info = [...(u.fields || []).map(([k, v]) => [k, h('span', {}, ...linkify(v))]), ...(u.contacts || []).map((c) => [c.label, c.url ? h('a', { href: '#', onclick: (e) => (e.preventDefault(), openExternal(c.url)) }, c.text || c.url) : c.text])];
  const site = [['Journals', faUrl.journals(name)], ['Watchers', `https://www.furaffinity.net/watchlist/to/${enc(name)}/`], ['Watching', `https://www.furaffinity.net/watchlist/by/${enc(name)}/`], ['Shouts and comments', faUrl.user(name)]];
  const main = [
    u.featured ? card('Featured', h('button', { class: 'fa-feat', onclick: () => open(u.featured), title: u.featuredTitle || '' },
      u.featuredImg ? (() => {
        // like the site: the picture itself, large, with a quiet placeholder until it arrives (proxy first, then straight from the site)
        const img = h('img', { alt: '', draggable: 'false', decoding: 'async', onload: () => img.classList.add('ready') });
        let tried = 0;
        img.onerror = () => { if (!tried++) img.src = u.featuredImg; else img.remove(); };
        img.src = '/img?u=' + encodeURIComponent(u.featuredImg);
        return img;
      })() : null,
      h('span', {}, u.featuredTitle || 'Open the featured submission')), 'feat') : null,
    u.bio ? card('Profile', h('div', { class: 'fa-pf-bio' }, ...linkify(u.bio))) : null,
    strip('Latest submissions', u.latest, 'gallery'),
    strip('Latest favorites', u.latestFavs, 'favs'),
    u.shouts?.length ? card(`Shouts (${u.shouts.length})`, h('div', { class: 'fa-pf-shouts' }, u.shouts.map((s) => h('div', { class: 'fa-pf-shout' }, h('b', {}, h('a', { href: '#', onclick: (e) => (e.preventDefault(), ctx.go(hashOf('/user/' + enc(s.user)))) }, pretty(s.user))), s.at ? h('small', {}, s.at) : null, h('p', {}, ...linkify(s.text)))))) : null,
  ].filter(Boolean);
  const side = [
    tiles.length ? card('Numbers', h('div', { class: 'fa-tiles' }, tiles.map(([k, v]) => h('div', { class: 'fa-tile' }, h('b', {}, fmtNum(v)), h('small', {}, k))))) : null,
    info.length ? card('Info and contact', h('dl', { class: 'fa-pf-info' }, info.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))) : null,
    card('On Fur Affinity', [h('div', { class: 'fa-site' }, site.map(([l, url]) => h('button', { class: 'btn', onclick: () => openExternal(url), html: icon('external', 14) + `<span>${l}</span>` }))), h('p', { class: 'st-note' }, 'These open in your browser: Fur Affinity asks apps not to read them.')]),
  ].filter(Boolean);
  host.replaceChildren(h('div', { class: 'fa-pf-main' }, main), h('aside', { class: 'fa-pf-side' }, side));
}

/* ------------------------------------------------------------------ settings */
export function faSettingsBox(rerender) {
  const box = h('div', { class: 'st-fa' });
  const paint = async () => {
    await faStatus();
    const sign = faState.connected
      ? [h('div', { class: 'st-row' }, h('div', {}, h('b', {}, faState.loggedIn === false ? 'Sign-in expired' : faState.me ? `Signed in as ${faState.me}` : 'Signed in'), h('small', {}, 'Your session stays on this computer. Board Roamer never sees your password, and it is never synced')),
        h('div', { class: 'row-btns' }, h('button', { class: 'btn', onclick: () => faLogin() }, 'Sign in again'), h('button', { class: 'btn', onclick: async () => { const { faDisconnect } = await import('./fa.js'); await faDisconnect(); paint(); toast('Disconnected from Fur Affinity', { ms: 1600 }); } }, 'Disconnect')))]
      : [h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Sign in to Fur Affinity'), h('small', {}, 'A window opens on Fur Affinity’s own login page. Board Roamer only keeps the session it gives, so Mature and Adult art can show')),
        h('button', { class: 'btn primary', onclick: async () => { await faLogin(); const t = setInterval(async () => { await faStatus(); if (faState.connected || !box.isConnected) { clearInterval(t); paint(); } }, 1500); } }, 'Sign in'))];
    const paste = h('details', { class: 'st-paste' }, h('summary', {}, 'Or paste the two cookies by hand'),
      h('p', { class: 'st-note' }, 'In a browser signed in to Fur Affinity, copy the values of the cookies named a and b. They are kept on this computer only.'),
      (() => {
        const a = h('input', { class: 'input', placeholder: 'cookie a', spellcheck: 'false', autocomplete: 'off' });
        const b = h('input', { class: 'input', placeholder: 'cookie b', spellcheck: 'false', autocomplete: 'off' });
        return h('div', { class: 'row-btns' }, a, b, h('button', { class: 'btn', onclick: async () => { try { const { faPaste } = await import('./fa.js'); await faPaste(a.value.trim(), b.value.trim()); a.value = b.value = ''; toast('Saved', { ms: 1200 }); paint(); } catch (e) { toast(e.message, { kind: 'err' }); } } }, 'Save'));
      })());
    box.replaceChildren(...sign, paste,
      h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Quick check'), h('small', {}, 'If Fur Affinity asks to confirm you are a person, a banner appears. This opens the check on the site; Board Roamer never tries to get past it')), h('button', { class: 'btn', onclick: () => faVerify() }, 'Open the check')),
      h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Remembered submissions'), h('small', {}, `${fmtNum(faIndex.size())} on this device, searchable in Fur Affinity > Seen. ${fmtNum(faLikes.favIds().length)} liked here`)),
        h('button', { class: 'btn', onclick: () => { faIndex.clear(); toast('Cleared', { ms: 1200 }); paint(); } }, 'Forget what I have seen')),
      h('div', { class: 'st-note' }, 'Favorites and upvotes in the Fur Affinity section are saved in Board Roamer only, not on Fur Affinity. Board Roamer keeps to one request a second, never opens Fur Affinity’s search, watch feed, notes or favorite buttons by itself (they open in your browser), and pauses background checks while the site reports 15,000 or more registered users online.'));
  };
  paint();
  return box;
}
