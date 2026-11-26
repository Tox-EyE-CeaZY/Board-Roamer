/* The Feed screen: one post at a time, full screen, swipe for the next. What to show comes from feedengine.js. */
import { h, pretty, fmtNum, copyText } from './util.js';
import { icon } from './icons.js';
import { S, setS, on, subs, tagc, voted, saved, boards, postKey, kv } from './store.js';
import { getProvider, providerList, isBlurred, CATS, CAT_LABEL } from './providers.js';
import { toast, popover, closePopover, confirmDlg, segmented } from './ui.js';
import { quickPin } from './pins.js';
import { follow } from './follows.js';
import { renderDText } from './dtext.js';
import { openArtistPage } from './artistpage.js';
import { haptic, isAndroid, isTouch, native } from './platform.js';
import {
  SUGGEST_AT, POOL_LOW, modelOf, srcOf, srcs, enabled, needsKeyMissing, markShown, refill, followTick, nextPost, whyOf, learnAccount, canLearn, learning,
  isLiked, isUp, isDown, notInterested, suggestions, dismissSuggestion, heaviestTags, ensureCats, mediaSrc, smallVideo, dropPools,
} from './feedengine.js';

const MODES = [['follows', 'Following'], ['foryou', 'For you'], ['new', 'New'], ['hot', 'Hot']];
const MENU_HINT = 'Swipe a post to the left for its artist. Press and hold it for more. Hold two fingers on it to hide the buttons.';
const viewerOpen = () => { const v = document.getElementById('viewer'); return !!v && !v.hidden && v.classList.contains('in'); };
const mode = () => S('feedMode') || 'foryou';
const cleanDesc = (s) => String(s || '').replace(/"([^"]+)":\S+/g, '$1').replace(/\[\/?[a-z0-9]+([=,][^\]]*)?\]/gi, '').replace(/\s+/g, ' ').trim();
const signedIn = (prov) => { const c = (S('creds') || {})[prov.credKey]; return !!(c?.user && c?.key); };

/**
 * @param list  leave out for the Feed itself. With it, the same screen shows a fixed list in order (an artist's posts): nothing is
 *              picked, learned from watching, or fetched here. { title, start, posts(), more(), onClose() }
 * @returns     { index(), destroy() }
 */
export function renderFeed(root, ctx, list = null) {
  const solo = !!list;
  const view = {
    items: [], // {post, kind, why}
    rr: 0,
    idx: 0,
    busy: false,
    clean: false, // buttons hidden by you
    artist: null, // the artist page, while it covers the Feed
    active: () => root.isConnected && !root.hidden && !document.hidden && document.body.dataset.view === 'feed' && !view.artist && !viewerOpen(),
  };
  const cards = []; // one slot per item; only the ones near the screen have content
  const scroller = h('div', { class: 'fd-scroll', tabindex: '0' });
  const empty = h('div', { class: 'fd-empty' });
  const pullEl = h('div', { class: 'fd-pull', html: icon('refresh', 20) });

  /* ---------------------------------------------------------------- top bar */
  const tabs = h('div', { class: 'fd-tabs' }, MODES.map(([k, label]) => h('button', { 'data-m': k, onclick: () => setMode(k) }, label)));
  const paintTabs = () => tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode()));
  const menuBtn = h('button', { class: 'fd-ib fd-menu', title: 'Feed settings', 'aria-label': 'Feed settings', html: icon('sliders', 20), onclick: (e) => feedSettings(e.currentTarget) });
  const cloakBtn = h('button', { class: 'fd-ib', title: 'Cloak the screen', 'aria-label': 'Cloak the screen', html: icon('cloak', 20), onclick: () => ctx.cloak?.() });
  const top = solo
    ? h('div', { class: 'fd-top' }, h('button', { class: 'fd-ib', title: 'Back', 'aria-label': 'Back', html: icon('left', 20), onclick: () => list.onClose() }), h('div', { class: 'fd-solo-title' }, list.title), cloakBtn)
    : h('div', { class: 'fd-top' }, cloakBtn, tabs, menuBtn);
  const el = h('div', { class: 'fd' }, scroller, top, pullEl, empty);
  root.replaceChildren(el);
  el.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && el.classList.contains('idle') && wake());

  const setMode = (k) => {
    if (k === mode()) return;
    setS('feedMode', k);
    paintTabs();
    refreshFeed({ fromScratch: true });
  };
  const paintSuggest = () => menuBtn.classList.toggle('dot', suggestions().length > 0);

  /* ---------------------------------------------------------------- showing and hiding the buttons */
  let idleT = 0;
  const landscape = () => document.documentElement.classList.contains('phone') && innerWidth > innerHeight;
  /** While a video plays (or the phone is sideways) the buttons fade after a moment; any touch brings them back. */
  function wake() {
    el.classList.remove('idle');
    clearTimeout(idleT);
    if (view.artist) return;
    idleT = setTimeout(() => {
      const card = cardAt(view.idx), v = card?.querySelector('video');
      const busy = card?.querySelector('.fd-tags.open, .fd-desc.open') || document.querySelector('.sheet-back, .pop');
      if (!busy && ((v && !v.paused) || (!v && landscape()))) el.classList.add('idle');
    }, landscape() ? 1800 : 3000);
  }
  const setClean = (v) => {
    view.clean = v;
    el.classList.toggle('clean', v);
    if (v) toast('Buttons hidden. Tap to bring them back', { ms: 1600 });
    else wake();
  };

  /* ---------------------------------------------------------------- cards */
  const cardAt = (i) => cards[i]?.firstChild || null;
  const indexOf = (card) => cards.indexOf(card.parentElement);

  const paintState = (card, p) => {
    if (!card) return;
    const q = (s) => card.querySelector(s);
    q('.fd-btn.like')?.classList.toggle('on', isLiked(p));
    q('.fd-btn.up')?.classList.toggle('on', isUp(p));
    q('.fd-btn.down')?.classList.toggle('on', isDown(p));
    const got = saved.has(p), dl = q('.fd-btn.dl');
    if (dl && dl.classList.contains('on') !== got) (dl.classList.toggle('on', got), (dl.innerHTML = icon(got ? 'check' : 'download', 24)));
    if (dl) dl.title = got ? 'Already downloaded' : 'Download (D)';
    const chip = q('.fd-saved');
    if (chip) chip.hidden = !got;
    q('.fd-btn.pin')?.classList.toggle('on', boards.inAny(postKey(p)));
  };
  const paintAll = () => view.items.forEach((it, i) => paintState(cardAt(i), it.post));

  const railButton = (cls, label, ic, run) => h('button', { class: 'fd-btn ' + cls, title: label, 'aria-label': label, html: icon(ic, 24), onclick: (e) => (e.stopPropagation(), wake(), run(e.currentTarget)) });

  const buildCard = (i) => {
    const it = view.items[i];
    const p = it.post, prov = getProvider(p.provider);
    const blurred = isBlurred(p);
    let media;
    if (p.kind === 'video') {
      media = h('video', { class: 'fd-media', loop: true, playsinline: true, muted: true, preload: 'metadata', poster: p.thumb });
      media.muted = S('muted') !== false;
      // start the fade timer when it first plays, not again each time it loops
      media.addEventListener('playing', () => { if (!media.dataset.woke && cardAt(view.idx)?.contains(media)) (media.dataset.woke = '1'), wake(); });
    } else media = h('img', { class: 'fd-media', alt: '', draggable: 'false', decoding: 'async' });
    media.dataset.src = mediaSrc(p);
    const stage = h('div', { class: 'fd-stage' + (blurred ? ' blur' : '') }, media);
    const like = railButton('like', 'Like (L)', 'heart', () => toggleLike(p));
    like.append(h('small', {}, fmtNum(p.favs)));
    const card = h('section', { class: 'fd-card', style: `--ph:${prov.color}` },
      h('img', { class: 'fd-bg', src: p.thumb, alt: '', draggable: 'false' }),
      stage,
      h('div', { class: 'fd-shade' }),
      buildInfo(it),
      h('div', { class: 'fd-rail' },
        like,
        railButton('up', 'Upvote (U)', 'up', () => upvote(p)),
        railButton('down', 'Downvote (X)', 'down', () => downvote(indexOf(card))),
        railButton('dl', 'Download (D)', 'download', () => download(p)),
        railButton('share', 'Share', 'share', () => ctx.share?.(p)),
        railButton('pin', 'Pin', 'pin', () => (quickPin([p]), setTimeout(() => paintState(card, p), 60))),
        p.kind === 'video' ? railButton('sound', 'Sound', media.muted ? 'mute' : 'sound', (b) => { media.muted = !media.muted; setS('muted', media.muted); b.innerHTML = icon(media.muted ? 'mute' : 'sound', 24); }) : null,
        p.kind === 'video' && isAndroid() && p.w > p.h ? railButton('rotate', 'Turn sideways', 'rotate', () => turn()) : null),
      h('button', { class: 'fd-zoomreset', hidden: true, onclick: (e) => (e.stopPropagation(), card._zoom?.reset()) }, 'Reset zoom'),
      blurred ? h('button', { class: 'fd-reveal', onclick: (e) => (e.stopPropagation(), stage.classList.remove('blur'), e.currentTarget.remove()) }, 'Blurred: tap to show') : null);
    attachZoom(card, stage, media);
    attachGestures(card, stage, media, p);
    attachSwipe(card, p);
    paintState(card, p);
    return card;
  };

  /** Artist, description and the heaviest tags: redrawn if tag categories arrive late. */
  const buildInfo = (it) => {
    const p = it.post, prov = getProvider(p.provider);
    const art = p.artists.slice(0, 2);
    return h('div', { class: 'fd-info' },
      h('div', { class: 'fd-chips-row' },
        it.why ? h('div', { class: 'fd-why ' + it.kind }, it.why) : null,
        h('div', { class: 'fd-site' }, prov.short),
        h('div', { class: 'fd-saved', hidden: !saved.has(p), html: icon('check', 12) + '<span>Downloaded</span>' })),
      art.length ? h('div', { class: 'fd-art' }, art.map((a) => h('span', { class: 'fd-who' }, h('button', { onclick: (e) => (e.stopPropagation(), openArtist(p, a)) }, pretty(a)), followButton(p, a)))) : h('div', { class: 'fd-art' }, h('span', {}, 'unknown artist')),
      descBox(p),
      tagBox(p, heaviestTags(p)));
  };

  /** Two lines of the description; tap for all of it. */
  const descBox = (p) => {
    const short = cleanDesc(p.desc);
    if (!short) return null;
    const box = h('div', { class: 'fd-desc', role: 'button', tabindex: 0 });
    let open = false;
    const paint = () => {
      box.classList.toggle('open', open);
      if (!open) return box.replaceChildren(h('span', {}, short.slice(0, 220)));
      box.replaceChildren(h('div', { class: 'fd-desc-full' }, renderDText(p.desc, { prov: getProvider(p.provider) })), h('b', {}, 'Show less'));
    };
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      const link = e.target.closest('a');
      if (open && link) return;
      open = !open;
      paint();
      wake();
    });
    paint();
    return box;
  };

  const isFollowed = (prov, name) => !!subs.find(prov.credKey, name);
  /** "Follow" next to an artist you don't follow yet; it says so when you keep liking their work. */
  const followButton = (p, name) => {
    const prov = getProvider(p.provider);
    if (isFollowed(prov, name)) return null;
    const keen = (modelOf(prov).taste.a[name] || 0) >= SUGGEST_AT;
    return h('button', { class: 'fd-follow' + (keen ? ' keen' : ''), onclick: (e) => { e.stopPropagation(); follow(name, prov.id); e.currentTarget.remove(); paintSuggest(); } }, keen ? 'Follow · you like them' : 'Follow');
  };

  const refreshInfo = (it) => {
    const old = cardAt(view.items.indexOf(it))?.querySelector('.fd-info');
    if (old && !old.querySelector('.fd-tags.open, .fd-desc.open')) old.replaceWith(buildInfo(it));
  };

  /** The heaviest few tags like hashtags, and a button that opens the full list (grouped by category, in a scroll box). */
  const tagBox = (p, heavy) => {
    const box = h('div', { class: 'fd-tags' });
    const chip = (t, cat) => h('button', { class: cat ? 'c-' + cat : '', onclick: (e) => (e.stopPropagation(), openSearch(p, t)) }, '#' + pretty(t));
    const total = Object.entries(p.tags).filter(([c]) => c !== 'artist').reduce((n, [, l]) => n + l.length, 0);
    let all = false;
    const paint = () => {
      box.classList.toggle('open', all);
      if (!all) {
        box.replaceChildren(...heavy.map((t) => chip(t)), total > heavy.length ? h('button', { class: 'fd-more', onclick: (e) => (e.stopPropagation(), (all = true), paint(), wake()) }, `View all ${total}`) : null);
        return;
      }
      const groups = CATS.filter((c) => c !== 'artist' && p.tags[c]?.length).map((c) => h('div', { class: 'fd-tg' }, h('small', {}, CAT_LABEL[c] || c), h('div', {}, p.tags[c].map((t) => chip(t, c)))));
      box.replaceChildren(h('div', { class: 'fd-allscroll' }, groups), h('button', { class: 'fd-more', onclick: (e) => (e.stopPropagation(), (all = false), paint(), wake()) }, 'Show fewer'));
    };
    paint();
    box.addEventListener('click', (e) => e.stopPropagation());
    return box;
  };

  /* ---------------------------------------------------------------- touch: zoom, taps, holds */
  /** Pinch to zoom (images and video), drag to pan while zoomed. It stays where you leave it; "Reset zoom", a double-tap or moving to another card puts it back. */
  const attachZoom = (card, stage, media) => {
    const z = { s: 1, x: 0, y: 0, moved: false };
    const pill = card.querySelector('.fd-zoomreset');
    const apply = () => {
      media.style.transform = z.s === 1 && !z.x && !z.y ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
      pill.hidden = z.s <= 1.02;
      scroller.style.overflowY = z.s > 1.02 ? 'hidden' : '';
    };
    const clampPan = () => {
      const r = stage.getBoundingClientRect();
      const mx = ((z.s - 1) * r.width) / 2, my = ((z.s - 1) * r.height) / 2;
      z.x = Math.max(-mx, Math.min(mx, z.x));
      z.y = Math.max(-my, Math.min(my, z.y));
    };
    const rel = (t) => { const r = stage.getBoundingClientRect(); return { x: t.clientX - r.left - r.width / 2, y: t.clientY - r.top - r.height / 2 }; };
    let pinch = null, pan = null; // listeners sit on the whole card: a second finger often lands on the buttons
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    card.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        scroller.style.overflowY = 'hidden'; // a swipe that had just begun must not carry on
        const [a, b] = e.touches, ma = rel(a), mb = rel(b);
        pinch = { d: dist(a, b), s: z.s, x: z.x, y: z.y, mid: { x: (ma.x + mb.x) / 2, y: (ma.y + mb.y) / 2 } };
        pan = null;
        z.moved = true;
      } else if (e.touches.length === 1) {
        z.moved = false;
        if (z.s > 1.02) pan = { px: e.touches[0].clientX, py: e.touches[0].clientY, x: z.x, y: z.y };
      }
    }, { passive: true });
    card.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches, ma = rel(a), mb = rel(b), mid = { x: (ma.x + mb.x) / 2, y: (ma.y + mb.y) / 2 };
        if (Math.abs(dist(a, b) - pinch.d) < 12 && z.s <= 1.02) return; // two resting fingers are a hold, not a pinch
        const s = Math.max(1, Math.min(8, (pinch.s * dist(a, b)) / pinch.d));
        const k = s / pinch.s;
        z.s = s;
        z.x = mid.x - (pinch.mid.x - pinch.x) * k;
        z.y = mid.y - (pinch.mid.y - pinch.y) * k;
        clampPan();
        apply();
      } else if (pan && e.touches.length === 1 && z.s > 1.02) {
        e.preventDefault();
        const t = e.touches[0];
        if (Math.abs(t.clientX - pan.px) + Math.abs(t.clientY - pan.py) > 4) z.moved = true;
        z.x = pan.x + t.clientX - pan.px;
        z.y = pan.y + t.clientY - pan.py;
        clampPan();
        apply();
      }
    }, { passive: false });
    card.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 0) pan = null;
      if (z.s <= 1.02) z.reset();
    }, { passive: true });
    card.addEventListener('touchcancel', () => { pinch = null; pan = null; }, { passive: true });
    // desktop: ctrl + wheel (or a trackpad pinch) zooms, plain wheel pans while zoomed
    stage.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && z.s <= 1.02) return;
      e.preventDefault();
      if (e.ctrlKey) {
        const m = rel(e), s = Math.max(1, Math.min(8, z.s * Math.exp(-e.deltaY * 0.01))), k = s / z.s;
        z.x = m.x - (m.x - z.x) * k;
        z.y = m.y - (m.y - z.y) * k;
        z.s = s;
      } else (z.x -= e.deltaX), (z.y -= e.deltaY);
      clampPan();
      apply();
    }, { passive: false });
    z.reset = () => { z.s = 1; z.x = 0; z.y = 0; apply(); };
    z.zoomed = () => z.s > 1.02;
    card._zoom = z;
  };

  /**
   * Tap: pause a video / open a picture. Double-tap: what you chose in the Feed settings. Press and hold: the post's menu. Two fingers held still: hide the buttons.
   * A tap that only brings hidden buttons back does nothing else.
   */
  const attachGestures = (card, stage, media, p) => {
    let tapAt = 0, tapT = 0, holdT = 0, held = false, start = null;
    const stop = () => clearTimeout(holdT);
    const spread = (e) => (e.touches.length === 2 ? Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) : 0);
    stage.addEventListener('touchstart', (e) => {
      stop();
      if (e.touches.length === 1) held = false;
      start = { n: e.touches.length, x: e.touches[0].clientX, y: e.touches[0].clientY, d: spread(e) };
      if (e.touches.length === 1 && !card._zoom.zoomed()) holdT = setTimeout(() => ((held = true), haptic('heavy'), postMenu(indexOf(card), stage)), 500);
      else if (e.touches.length === 2) holdT = setTimeout(() => ((held = true), haptic('heavy'), setClean(!view.clean)), 450);
    }, { passive: true });
    // the second finger may land on a button, outside the stage
    card.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2 && !stage.contains(e.target)) {
        stop();
        start = { n: 2, x: e.touches[0].clientX, y: e.touches[0].clientY, d: spread(e) };
        holdT = setTimeout(() => ((held = true), haptic('heavy'), setClean(!view.clean)), 450);
      }
    }, { passive: true });
    card.addEventListener('touchmove', (e) => {
      if (!start) return;
      const moved = Math.hypot(e.touches[0].clientX - start.x, e.touches[0].clientY - start.y);
      if (moved > 12 || (start.n === 2 && Math.abs(spread(e) - start.d) > 14)) stop();
    }, { passive: true });
    for (const ev of ['touchend', 'touchcancel']) card.addEventListener(ev, stop, { passive: true });
    stage.addEventListener('contextmenu', (e) => (e.preventDefault(), !isTouch() && postMenu(indexOf(card), stage)));
    stage.addEventListener('click', (e) => {
      if (held || card._zoom.moved) return void ((held = false), (card._zoom.moved = false)); // a hold, drag or pinch is not a tap
      if (stage.classList.contains('blur')) return;
      if (view.clean) return setClean(false);
      const faded = el.classList.contains('idle');
      wake();
      const now = Date.now();
      if (card._zoom.zoomed()) {
        if (now - tapAt < 300) (card._zoom.reset(), (tapAt = 0));
        else tapAt = now;
        return;
      }
      if (now - tapAt < 300) {
        clearTimeout(tapT);
        tapAt = 0;
        doubleTap(card, p, e);
        return;
      }
      tapAt = now;
      tapT = setTimeout(() => {
        if (faded) return;
        if (p.kind === 'video') togglePlay(media);
        else openIt(indexOf(card));
      }, 300);
    });
  };

  /** A swipe in from the right opens the artist's page. */
  const attachSwipe = (card, p) => {
    let start = null;
    card.addEventListener('touchstart', (e) => {
      start = e.touches.length === 1 && !card._zoom.zoomed() && !e.target.closest('.fd-allscroll, .fd-desc.open') ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    card.addEventListener('touchend', (e) => {
      if (!start) return;
      const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y;
      start = null;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.7) return;
      if (solo) dx > 0 && list.onClose(); // swipe right: back to the grid
      else if (dx < 0) openArtist(p);
    }, { passive: true });
    card.addEventListener('touchcancel', () => (start = null), { passive: true });
  };

  function openArtist(p, name) {
    if (solo) return list.onClose(); // already inside an artist's posts: their page is right behind
    const names = p.artists?.length ? p.artists : name ? [name] : [];
    if (!names.length) return toast('No artist is tagged on this post', { ms: 1800 });
    if (view.artist) return;
    hush(true);
    view.clean = false;
    el.classList.remove('clean', 'idle'); // the page lies inside this screen and must not fade with it
    clearTimeout(idleT);
    view.artist = openArtistPage(el, ctx, {
      provId: p.provider, names, name: name || names[0],
      onFollow: () => (paintSuggest(), view.items.forEach(refreshInfo)),
      onClose: () => { view.artist = null; wake(); fill(); },
      openReel: (host, l) => renderFeed(host, ctx, l),
    });
  }

  const togglePlay = (v) => {
    if (v.paused) (delete v.dataset.userPaused, v.play().catch(() => {}));
    else (v.dataset.userPaused = '1', v.pause());
    wake();
  };

  /** The Feed's own double-tap (Feed settings): favorite, upvote, both or downvote. It only ever adds, so a stray one undoes nothing. */
  function doubleTap(card, p, e) {
    const does = S('feedDtap') || 'both';
    burst(card, e, does === 'up' ? 'up' : does === 'down' ? 'down' : 'heart');
    if (does === 'down') {
      if (!isDown(p)) downvote(indexOf(card));
    } else if (does === 'up') {
      if (!isUp(p)) upvote(p, { keep: true });
    } else if (!isLiked(p)) toggleLike(p, { vote: does === 'both' });
    else if (does === 'both' && !isUp(p)) upvote(p, { keep: true }); // a favorite already: the upvote is still missing
  }

  const burst = (card, e, shape = 'heart') => {
    const r = card.getBoundingClientRect();
    const b = h('div', { class: 'fd-burst ' + shape, html: icon(shape, 90), style: `left:${e.clientX - r.left}px;top:${e.clientY - r.top}px` });
    card.append(b);
    haptic('tick');
    setTimeout(() => b.remove(), 800);
  };

  /** Press-and-hold (or right-click) menu. */
  function postMenu(i, anchor) {
    const p = view.items[i]?.post;
    if (!p) return;
    el.classList.remove('idle');
    const item = (label, ic, run, hint) => h('button', { class: 'fd-mi', onclick: () => (closePopover(), run()) }, h('i', { html: icon(ic, 20) }), h('div', {}, h('b', {}, label), hint ? h('small', {}, hint) : null));
    popover(anchor, h('div', { class: 'fd-set fd-actions' },
      item('Not interested', 'close', () => skip(i), 'Fewer like this. Nothing is sent to the site'),
      item(view.clean ? 'Show buttons' : 'Hide buttons', 'eye', () => setClean(!view.clean), 'Or hold two fingers on the post'),
      !solo && p.artists.length ? item('Artist page', 'user', () => openArtist(p), 'Or swipe the post to the left') : null,
      item('Rate its tags', 'tag', () => setTimeout(() => tagSheet(menuBtn, p), 60), 'Tell the Feed what you want more or less of'),
      item('Open post', 'fit', () => openIt(i)),
      item('Share link', 'share', () => ctx.share?.(p)),
      isAndroid() ? item(p.kind === 'video' ? 'Share video' : 'Share picture', 'share', () => native.shareFile(p.kind === 'video' ? mediaSrc(p) : p.sample || p.full, `${p.provider}_${p.id}.${p.ext}`)) : null,
      item('Copy link', 'link', () => (copyText(p.url), toast('Post link copied', { ms: 1400 })))), { align: 'left', cls: 'fd-pop' });
  }

  /* ---------------------------------------------------------------- the strip of cards */
  const mountCard = (i) => {
    if (i < 0 || i >= view.items.length) return;
    const slot = cards[i];
    if (slot && !slot.firstChild) slot.append(buildCard(i));
  };
  const unmountCard = (i) => {
    const slot = cards[i];
    if (slot?.firstChild) {
      slot.querySelectorAll('video').forEach((v) => (v.pause(), v.removeAttribute('src'), v.load()));
      slot.replaceChildren();
    }
  };
  /** Only the video on screen may play (and so make sound). */
  const hush = (all = false) => {
    const keep = all ? null : cardAt(view.idx);
    scroller.querySelectorAll('video').forEach((v) => !keep?.contains(v) && !v.paused && v.pause());
  };
  const loadMedia = (i, play) => {
    const m = cardAt(i)?.querySelector('.fd-media');
    if (!m || !m.dataset.src) return;
    if (m.tagName === 'VIDEO' && i > view.idx + 1) return; // only this video and the next one: the others would just compete for the connection
    if (!m.getAttribute('src')) m.src = m.dataset.src;
    if (m.tagName === 'VIDEO') {
      // the next video starts buffering early, but only a small one: a big file would crowd out the pictures and burn mobile data
      if (i === view.idx + 1 && smallVideo(view.items[i]?.post)) m.preload = 'auto';
      if (play && view.active() && !m.dataset.userPaused) m.play().catch(() => {});
      else m.pause();
    }
  };

  const addSlot = () => {
    const slot = h('div', { class: 'fd-slot' });
    cards.push(slot);
    scroller.append(slot);
  };

  /* --- keeping the queue stocked */
  const ahead = () => Math.max(14, (S('feedPreload') || 20) + 4); // cards lined up past the one on screen, so a swipe never waits for the network
  const withTimeout = (pr, ms) => Promise.race([pr, new Promise((r) => setTimeout(() => r(null), ms))]);
  let run = 0; // a refresh starts a new run: picks still on their way from the old one are dropped
  /** A fixed list: show what there is, and ask for the next page as the end comes near. */
  async function fillList() {
    const append = () => {
      const posts = list.posts();
      if (posts.length <= view.items.length) return false;
      for (const post of posts.slice(view.items.length)) (view.items.push({ post, kind: 'list', why: '' }), addSlot());
      return true;
    };
    if (append()) syncWindow();
    paintEmpty();
    if (view.busy || view.items.length - view.idx > 8) return;
    view.busy = true;
    try {
      await list.more();
      if (root.isConnected && append()) syncWindow();
    } finally {
      view.busy = false;
      paintEmpty();
    }
    if (!view.items.length) return;
    if (!activePostSet) activate(0);
  }
  async function fill() {
    if (solo) return fillList();
    if (view.busy) return void (view.again = true); // run once more when the current round ends
    view.busy = true;
    try {
      do {
        view.again = false;
        while (view.items.length < view.idx + ahead()) {
          if (!root.isConnected) return;
          if (view.items.length > view.idx + 1 && !view.active()) break; // nothing is looking: do not spend requests
          const mine = run;
          const got = await withTimeout(nextPost(view), 40000);
          if (mine !== run) continue;
          if (!got) break;
          const { post, kind } = got;
          view.items.push({ post, kind, why: whyOf(post, kind) });
          addSlot();
          paintEmpty();
          if (view.items.length === 1) activate(0);
          else syncWindow();
        }
      } while (view.again && root.isConnected);
    } finally {
      view.busy = false;
      paintEmpty();
    }
    catsNear();
    if (view.items.length < view.idx + ahead()) retry();
  }
  let retryT = 0;
  function retry() {
    clearTimeout(retryT);
    retryT = setTimeout(() => root.isConnected && (view.active() || !view.items.length) && fill(), 6000);
  }
  const paintEmpty = () => {
    const list = enabled();
    if (view.items.length) return void (empty.hidden = true);
    empty.hidden = false;
    if (solo) return empty.replaceChildren(h('div', { class: 'fd-loading' }, h('i'), h('b', {}, 'Loading…')));
    const say = (title, text, spin = true) => empty.replaceChildren(h('div', { class: 'fd-loading' }, spin ? h('i') : null, h('b', {}, title), h('small', {}, text)));
    if (mode() === 'follows' && !view.busy) {
      if (!list.some((p) => subs.all().some((f) => f.p === p.credKey))) return say('Follow some artists first', 'Their new posts show up here.', false);
      return say('Looking for new posts', 'Checking the artists you follow, a few at a time.');
    }
    if (list.length && list.every(needsKeyMissing)) return say('Add an API key for this site', 'Open the Feed settings and pick another site, or add the key in app settings.', false);
    if (list.some((p) => srcOf(p).cool > Date.now())) return say('The site asked us to slow down', 'Trying again shortly. Requests are spaced out on purpose.');
    say('Tuning your feed…', 'Fetching a first batch.');
  };

  /* Pictures are downloaded well before they are needed, nearest first, a few at a time (they come from the sites' file servers, not the API). */
  const warmed = new Map(); // url -> Image, kept so the download is not dropped
  let warming = 0;
  function warm() {
    if (!root.isConnected) return;
    const next = view.items.slice(view.idx + 1, view.idx + 1 + (S('feedPreload') || 20)).map((x) => (x.post.kind === 'video' ? x.post.thumb : mediaSrc(x.post)));
    while (warming < 4) {
      const url = next.find((u) => u && !warmed.has(u));
      if (!url) break;
      const img = new Image();
      warmed.set(url, img);
      warming++;
      img.onload = img.onerror = () => { warming--; warm(); };
      img.src = url;
    }
    while (warmed.size > 120) warmed.delete(warmed.keys().next().value);
  }
  const syncWindow = () => {
    for (let i = 0; i < cards.length; i++) {
      if (Math.abs(i - view.idx) <= 2) mountCard(i);
      else unmountCard(i);
    }
    hush();
    for (let k = 0; k <= 1; k++) loadMedia(view.idx + k, k === 0);
    loadMedia(view.idx + 2, false);
    warm();
  };

  /* ---------------------------------------------------------------- what is on screen now: learn from it */
  let since = 0, catBusy = false, activePost = null, activePostSet = false;
  /** Categories for the cards about to be seen, where a site sends none: one paced request, then their text is redrawn. */
  async function catsNear() {
    if (catBusy) return;
    catBusy = true;
    try {
      const near = view.items.slice(view.idx, view.idx + 7);
      if (await ensureCats(near.map((x) => x.post))) near.forEach(refreshInfo);
    } finally {
      catBusy = false;
    }
  }
  function activate(i) {
    leave();
    if (i !== view.idx) cardAt(view.idx)?._zoom?.reset();
    view.idx = i;
    const it = view.items[i];
    syncWindow();
    // each video starts with the sound setting as it is now
    const v = cardAt(i)?.querySelector('video');
    if (v) {
      v.muted = S('muted') !== false;
      delete v.dataset.woke;
      const b = cardAt(i).querySelector('.fd-btn.sound');
      if (b) b.innerHTML = icon(v.muted ? 'mute' : 'sound', 24);
    }
    if (it) paintState(cardAt(i), it.post);
    wake();
    activePostSet = true;
    fill();
    catsNear();
    if (solo) return; // going through someone's posts teaches the Feed nothing (a like still does)
    since = Date.now();
    activePost = it?.post || null;
    if (it) markShown(it.post);
    if (i % 5 === 0) paintSuggest();
    if (i === 12 && !kv.get('feed:hint:tags', false)) { // said once, ever
      kv.set('feed:hint:tags', true);
      toast('Tip: you can tell the Feed which tags you like', { ms: 5000, action: { label: 'Your tags', run: () => tagSheet(menuBtn) } });
    }
    for (const p of enabled()) { // keep the pool deep: one refill at a time, paced by the gate
      const src = srcOf(p);
      if (!needsKeyMissing(p) && src.pool.length < POOL_LOW && !src.filling && src.cool <= Date.now() && view.active()) refill(src, view);
    }
  }
  function leave() {
    unturn();
    if (!activePost) return;
    const ms = Date.now() - since, p = activePost, m = modelOf(p.provider);
    const liked = m.likes.has(p.id);
    const vid = cardAt(view.idx)?.querySelector('video');
    if (ms < 1100 && !liked) m.taste.learn(p, { n: 0.3, post_n: 0 }); // flicked past
    else if (!liked && !document.hidden) {
      const watched = vid ? ms > Math.min(14000, (vid.duration || 8) * 1000 * 0.9) : ms > 7000;
      if (watched) m.taste.learn(p, { l: 0.25, n: 0, post_n: 0 }); // stayed a while: a little in its favor
    }
    m.save();
    activePost = null;
  }

  let ticking = 0, resizing = 0;
  const settle = () => {
    if (Date.now() < resizing) return;
    const hgt = scroller.clientHeight || 1;
    const i = Math.round(scroller.scrollTop / hgt);
    if (i !== view.idx && i >= 0 && i < view.items.length) activate(i);
  };
  // a short timer rather than a frame callback: frames are not delivered while the window is in the background
  scroller.addEventListener('scroll', () => { clearTimeout(ticking); ticking = setTimeout(settle, 60); }, { passive: true });
  // turning the phone changes the height of every card: stay on the same one
  let lastH = 0;
  const sizer = new ResizeObserver(() => {
    const hgt = scroller.clientHeight;
    if (!hgt || hgt === lastH) return;
    if (lastH) {
      resizing = Date.now() + 500;
      scroller.scrollTop = view.idx * hgt;
      setTimeout(() => (scroller.scrollTop = view.idx * scroller.clientHeight), 250);
      wake();
    }
    lastH = hgt;
  });
  sizer.observe(scroller);

  /* ---------------------------------------------------------------- sideways video */
  let turned = false;
  function turn() {
    turned = !turned;
    native.orientation(turned ? 'landscape' : 'auto');
  }
  function unturn() {
    if (turned) (turned = false), native.orientation('auto');
  }

  /* ---------------------------------------------------------------- actions */
  const goTo = (i) => {
    i = Math.max(0, Math.min(cards.length - 1, i));
    const y = i * scroller.clientHeight;
    scroller.scrollTo({ top: y, behavior: 'smooth' });
    clearTimeout(view.snapT); // some web views drop a smooth scroll that snap points interrupt: finish it by hand
    view.snapT = setTimeout(() => Math.abs(scroller.scrollTop - y) > 2 && scroller.scrollTo({ top: y, behavior: 'instant' }), 650);
  };
  const repaint = (p) => view.items.forEach((it, i) => it.post === p && paintState(cardAt(i), p));
  const setUp = (p, on) => {
    voted.set(p, on);
    p.myVote = on ? 1 : 0;
  };

  /** The heart: favorite it, and (like a double-tap in the viewer) upvote it too, unless `vote` is off. Both buttons show what happened. */
  async function toggleLike(p, { vote = true } = {}) {
    const m = modelOf(p.provider), prov = getProvider(p.provider);
    const want = !isLiked(p);
    if (want) { m.likes.add(p.id); m.taste.learn(p, { l: 1, n: 0, post_n: 0 }); }
    else { m.likes.delete(p.id); p.faved = false; m.taste.learn(p, { l: -1, n: 0, post_n: 0 }); }
    haptic(want ? 'tick' : 'soft');
    m.save();
    const online = signedIn(prov) && S('feedSyncLikes');
    if (want && vote && prov.vote && !signedIn(prov)) setUp(p, true); // signed out: remembered here
    repaint(p);
    if (online) {
      const jobs = [];
      if (prov.fav) jobs.push(prov.setFav(p, want).then(() => { p.faved = want; }));
      if (want && vote && prov.vote && !isUp(p)) jobs.push(prov.setVote(p, 1, true).then(() => setUp(p, true)));
      const failed = (await Promise.allSettled(jobs)).find((r) => r.status === 'rejected');
      if (failed) toast(`Liked here, but ${prov.name} said: ${failed.reason.message}`, { kind: 'err', ms: 3600 });
      repaint(p);
    } else if (want && !signedIn(prov) && !view.hintLike && (prov.fav || prov.vote)) {
      view.hintLike = true;
      toast('Saved to your taste. Sign in under Settings to favorite on the site too', { ms: 3200 });
    }
  }

  /** The arrow toggles; `keep` (a double-tap) only ever adds, even if the site already had your vote. */
  async function upvote(p, { keep = false } = {}) {
    const m = modelOf(p.provider), prov = getProvider(p.provider);
    let on = keep || !isUp(p);
    haptic('tick');
    if (prov.vote && signedIn(prov) && S('feedSyncLikes')) {
      try {
        const r = await prov.setVote(p, 1, keep);
        if (r?.our_score != null) on = r.our_score > 0;
      } catch (e) {
        return toast(`${prov.name} said: ${e.message}`, { kind: 'err', ms: 3600 });
      }
    }
    setUp(p, on);
    if (on && !m.likes.has(p.id)) m.taste.learn(p, { l: 0.8, n: 0, post_n: 0 });
    m.save();
    toast(on ? 'Upvoted' : 'Upvote removed', { ms: 1100 });
    repaint(p);
  }

  async function downvote(i) {
    const p = view.items[i]?.post;
    if (!p) return;
    const prov = getProvider(p.provider);
    haptic('tick');
    notInterested(p);
    voted.set(p, false);
    p.myVote = -1;
    repaint(p);
    toast('Downvoted. Fewer like this', { ms: 1400 });
    goTo(i + 1);
    if (prov.vote && signedIn(prov) && S('feedSyncLikes')) {
      try {
        const r = await prov.setVote(p, -1, true);
        if (r?.our_score != null) p.myVote = r.our_score;
      } catch (e) {
        toast(`${prov.name} said: ${e.message}`, { kind: 'err', ms: 3000 });
      }
    }
  }

  /** "Not interested": teaches the Feed, tells the site nothing. */
  function skip(i) {
    const p = view.items[i]?.post;
    if (!p) return;
    notInterested(p);
    haptic('tick');
    toast('Got it, fewer like this', { ms: 1400 });
    goTo(i + 1);
  }

  async function download(p, again = false) {
    if (saved.has(p) && !again) return void toast('Already downloaded', { action: { label: 'Download again', run: () => download(p, true) }, ms: 3500 });
    await ctx.savePost?.(p);
    repaint(p);
  }

  function openIt(i) {
    hush(true);
    const g = {
      viewList: () => view.items.map((x) => x.post),
      itemIndexOfView: (v) => v,
      viewIndexOf: (v) => v,
      scrollTo: (n) => { scroller.scrollTop = n * scroller.clientHeight; },
      refreshMarks() {},
    };
    ctx.openViewer(g, i, null);
  }

  function openSearch(p, t) {
    hush(true);
    ctx.go(ctx.roamHash([{ t, op: '+' }], null, p.provider));
  }

  /* ---------------------------------------------------------------- outside events */
  const offs = [
    // likes made anywhere (the viewer's heart, double-tap, upvote) teach the Feed too
    on('post-like', (e) => {
      const { post, on: yes, vote } = e.detail;
      const m = modelOf(post.provider);
      if (!vote) {
        if (yes && !m.likes.has(post.id)) { m.likes.add(post.id); m.taste.learn(post, { l: 1, n: 0, post_n: 0 }); }
        else if (!yes && m.likes.has(post.id)) { m.likes.delete(post.id); m.taste.learn(post, { l: -1, n: 0, post_n: 0 }); }
      } else if (yes && !m.likes.has(post.id)) m.taste.learn(post, { l: 0.7, n: 0, post_n: 0 });
      m.save();
      repaint(post);
    }),
    on('saved', paintAll),
    on('pins-changed', paintAll),
    on('feed-learn', (e) => !e.detail.running && paintSuggest()),
  ];

  const onKey = (e) => {
    if (!view.active() || e.ctrlKey || e.metaKey || e.altKey || e.target.matches?.('input,textarea,select,[contenteditable]')) return;
    const p = view.items[view.idx]?.post;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'j' || k === 'PageDown') (e.preventDefault(), goTo(view.idx + 1));
    else if (k === 'ArrowUp' || k === 'k' || k === 'PageUp') (e.preventDefault(), goTo(view.idx - 1));
    else if (k === 'l' || k === 'L') p && toggleLike(p);
    else if (k === 'x' || k === 'X') downvote(view.idx);
    else if (k === 'n' || k === 'N') skip(view.idx);
    else if (k === 'u' || k === 'U') p && upvote(p);
    else if (k === 'h' || k === 'H') setClean(!view.clean);
    else if (k === 'Enter') (e.preventDefault(), openIt(view.idx));
    else if (k === 'ArrowRight' && !solo) p && (e.preventDefault(), openArtist(p));
    else if (k === 'd' || k === 'D') p && download(p);
    else if (k === ' ') {
      const v = cardAt(view.idx)?.querySelector('video');
      if (v) (e.preventDefault(), togglePlay(v));
    }
  };
  addEventListener('keydown', onKey);

  /* tapping Feed again while on it: the first tap says so, the second refreshes */
  let tappedFeed = 0;
  const onRetap = (e) => {
    if (solo || !e.target.closest?.('a[data-view="feed"]')) return; // the nav link only: <body> carries data-view too
    if (view.artist) return (e.preventDefault(), e.stopPropagation(), view.artist.close());
    if (!view.active()) return;
    e.preventDefault();
    e.stopPropagation();
    if (Date.now() - tappedFeed < 3000) {
      tappedFeed = 0;
      refreshFeed();
    } else {
      tappedFeed = Date.now();
      toast('Tap Feed again to refresh', { ms: 2200 });
    }
  };
  document.addEventListener('click', onRetap, true);

  /* ---------------------------------------------------------------- your say on tags */
  const SAYS = [[-2, 'Never'], [-1, 'Less'], ['n', 'Neutral'], [1, 'More'], [2, 'Love']];
  /** One row per tag: what was learned about it, and buttons to overrule that. */
  const tagRow = (prov, tag) => {
    const m = modelOf(prov), row = h('div', { class: 'fd-tr', 'data-tag': tag });
    const paint = () => {
      const said = m.taste.r[tag] || 0, lift = m.taste.lift(tag);
      const cat = tagc.get(prov.id, tag)?.cat || 'general';
      const learned = !m.taste.t[tag] ? 'not seen much yet' : m.taste.likes < 4 ? 'not enough to say yet' : lift > 0.8 ? 'you like it a lot' : lift > 0.25 ? 'you like it' : lift < -0.6 ? 'you tend to skip it' : lift < -0.2 ? 'not your favorite' : 'no strong opinion';
      row.replaceChildren(
        h('div', { class: 'fd-tr-name' }, h('b', { style: `color:var(--c-${cat})` }, pretty(tag)), h('small', {}, said ? 'set by you' : learned),
          h('i', { class: 'fd-meter' + (lift < 0 ? ' neg' : '') }, h('i', { style: `width:${m.taste.likes < 4 ? 0 : Math.round(Math.min(1, Math.abs(lift) / (lift < 0 ? 1.5 : 3)) * 100)}%` }))),
        h('div', { class: 'fd-says' }, SAYS.map(([v, label]) => h('button', { class: (said === v ? 'on ' : '') + (v < 0 ? 'neg' : ''), onclick: (e) => { e.stopPropagation(); m.taste.say(tag, said === v ? 0 : v); m.save(); if (v === -2 && said !== v) dropUpcoming(true); paint(); } }, label))));
    };
    paint();
    return row;
  };
  /** The tags sheet: everything the Feed has an opinion on, or every tag of one post (by category), and a box to find or add a tag. */
  function tagSheet(anchor, post) {
    el.classList.remove('idle');
    const provs = post ? [getProvider(post.provider)] : enabled().filter((p, i, a) => a.findIndex((x) => x.credKey === p.credKey) === i);
    let prov = provs[0];
    const list = h('div', { class: 'fd-trs' });
    const total = post ? Object.values(post.tags).reduce((n, l) => n + l.length, 0) : 0;
    const paint = () => {
      if (post) {
        return list.replaceChildren(...CATS.filter((c) => post.tags[c]?.length).flatMap((c) => [h('div', { class: 'fd-sub' }, CAT_LABEL[c] || c), ...post.tags[c].map((t) => tagRow(prov, t))]));
      }
      const tags = modelOf(prov).taste.opinions().map((x) => x.tag);
      list.replaceChildren(...(tags.length ? tags.map((t) => tagRow(prov, t)) : [h('small', {}, 'Nothing learned yet. Add a tag above, or like a few posts.')]));
    };
    const input = h('input', { class: 'input', placeholder: 'Find or add a tag, e.g. dragon', spellcheck: 'false', autocapitalize: 'off' });
    const typed = () => input.value.trim().toLowerCase().replace(/\s+/g, '_');
    /** Typing narrows the list; the category headings go while it does. */
    const filter = () => {
      const q = typed();
      list.querySelectorAll('.fd-tr').forEach((row) => (row.hidden = !!q && !row.dataset.tag.includes(q)));
      list.querySelectorAll('.fd-sub').forEach((head) => (head.hidden = !!q));
    };
    const add = () => {
      const t = typed();
      if (!t) return;
      input.value = '';
      list.querySelector(':scope > small')?.remove(); // the "nothing yet" line
      [...list.querySelectorAll('.fd-tr')].find((row) => row.dataset.tag === t)?.remove();
      list.prepend(tagRow(prov, t));
      filter();
    };
    input.addEventListener('input', filter);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), add()));
    const pickSite = provs.length > 1 ? segmented(provs.map((p) => [p.id, p.name]), prov.id, (v) => { prov = getProvider(v); paint(); }) : null;
    paint();
    popover(anchor, h('div', { class: 'fd-set' },
      h('h4', {}, post ? `All ${total} tags on this post` : 'Your tags'),
      h('small', { class: 'fd-hint' }, 'Never hides every post with the tag. Less and More nudge the Feed. Neutral means the tag does not count either way. Tap again to take it back.'),
      pickSite,
      h('div', { class: 'fd-add' }, input, h('button', { class: 'btn', onclick: add }, 'Add')),
      list), { align: 'right', cls: 'fd-pop' });
  }

  /* ---------------------------------------------------------------- settings */
  const suggestList = () => {
    const list = h('div', { class: 'fd-sugg-list' });
    const paint = () => {
      const items = suggestions();
      list.replaceChildren(...(items.length ? items.map((s) => h('div', { class: 'fd-sugg', style: `--ph:${s.prov.color}` },
        h('button', { class: 'fd-sugg-name', onclick: () => (closePopover(), openArtist({ provider: s.prov.id }, s.name)) }, h('b', {}, pretty(s.name)), h('small', {}, `${s.prov.name} · liked ${Math.round(s.v)}`)),
        h('button', { class: 'btn primary', onclick: () => { follow(s.name, s.prov.id); paint(); paintSuggest(); } }, 'Follow'),
        h('button', { class: 'ibtn', title: 'Not this one', 'aria-label': 'Dismiss', html: icon('close', 16), onclick: () => { dismissSuggestion(s.key); paint(); paintSuggest(); } }))) : [h('small', {}, 'Nobody to suggest right now.')]));
    };
    paint();
    return list;
  };

  function feedSettings(anchor) {
    el.classList.remove('idle');
    const body = h('div', { class: 'fd-set' });
    const row = (label, hint, ctl) => h('div', { class: 'fd-row' }, h('div', {}, h('b', {}, label), hint ? h('small', {}, hint) : null), ctl);
    const tgl = (key, after) => { const b = h('button', { class: 'tgl' + (S(key) ? ' on' : ''), role: 'switch', onclick: () => { setS(key, !S(key)); b.classList.toggle('on', S(key)); after?.(); } }, h('i')); return b; };
    const sites = h('div', { class: 'fd-sites' });
    const paintSites = () => {
      const picked = new Set(S('feedSources') || []);
      sites.replaceChildren(...providerList.map((p) => h('button', { class: 'fd-chip' + (picked.has(p.id) ? ' on' : ''), style: `--ph:${p.color}`, title: p.name + (needsKeyMissing(p) ? ' (needs an API key)' : ''), onclick: () => (toggleSource(p), paintSites()) }, h('b', {}, p.short), h('span', {}, p.name))));
    };
    paintSites();
    const out = h('output', {}, (S('feedExplore') || 0) + '%');
    const sl = h('input', { type: 'range', min: 0, max: 60, step: 5, value: S('feedExplore') || 0, oninput: () => { setS('feedExplore', +sl.value); out.textContent = sl.value + '%'; } });
    const provs = enabled();
    const stats = h('div', { class: 'fd-stats' });
    const paintStats = () => {
      stats.replaceChildren(...provs.map((p) => {
        const m = modelOf(p), t = m.taste;
        const likes = t.interests(undefined, 6, (f) => tagc.get(p.id, f)?.cat ?? null).map((x) => pretty(x.tag));
        const can = canLearn(p);
        return h('div', { class: 'fd-stat', style: `--ph:${p.color}` },
          h('div', { class: 'fd-stat-h' }, h('i', { class: 'prov-dot' }, p.short), h('b', {}, p.name), h('small', {}, `${m.likes.size} liked · ${Math.round(t.pn)} shown`)),
          h('p', {}, likes.length ? 'Learning: ' + likes.join(', ') : t.ready ? 'Still finding your pattern.' : 'Not enough yet: like a few things' + (can ? ', or read your favorites below.' : '.')),
          can ? h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; await learnAccount(p, { force: true }); paintStats(); } }, learning.has(p.credKey) ? 'Reading…' : 'Read my favorites again') : h('small', { class: 'dim' }, p.fav || p.vote ? 'Sign in under Settings to learn from your favorites' : `${p.name} has no favorites: hearts in the Feed teach it`));
      }));
    };
    paintStats();
    const wanted = suggestions().length;
    body.append(
      h('h4', {}, 'Your Feed'),
      h('small', { class: 'fd-hint' }, MENU_HINT),
      h('div', { class: 'fd-sub' }, 'Sites'), sites,
      h('div', { class: 'fd-col' }, h('div', {}, h('b', {}, 'Double-tap does'), h('small', {}, 'Only in the Feed. The viewer keeps its own setting')),
        segmented([['fav', 'Favorite'], ['up', 'Upvote'], ['both', 'Both'], ['down', 'Downvote']], S('feedDtap') || 'both', (v) => setS('feedDtap', v))),
      row('Exploring', 'How much is deliberately outside your taste', h('div', { class: 'fd-slide' }, sl, out)),
      row('Preload ahead', 'How many posts download before you reach them (more uses more data)', segmented([[8, '8'], [20, '20'], [40, '40']], S('feedPreload') || 20, (v) => { setS('feedPreload', v); fill(); warm(); })),
      row('New from follows', 'Mix in fresh posts from artists you follow', tgl('feedFollows')),
      row('Likes go to the site', 'Hearts and votes also happen there when you are signed in', tgl('feedSyncLikes')),
      row('Learn from my favorites', 'Reads your favorites and upvotes once, then a quick top-up every 12 hours', tgl('feedLearn', () => autoLearn())),
      wanted ? h('h4', {}, 'Artists you keep liking') : null,
      wanted ? suggestList() : null,
      h('button', { class: 'btn primary', onclick: () => (closePopover(), tagSheet(menuBtn)) }, 'Your tags: rate what you like'),
      stats,
      h('div', { class: 'fd-btnrow' },
        h('button', { class: 'btn', onclick: () => (closePopover(), refreshFeed()) }, 'Refresh feed'),
        h('button', { class: 'btn', onclick: () => (closePopover(), ctx.openSettings?.()) }, 'App settings')),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmDlg('Forget what the Feed learned?', 'This clears taste and the list of posts already shown, on this device. Favorites on the sites are not touched.', 'Forget')) return;
        provs.forEach((p) => modelOf(p).reset());
        closePopover();
        refreshFeed({ fromScratch: true });
        toast('Feed taste reset');
        autoLearn();
      } }, 'Forget my taste on this device'));
    popover(anchor, body, { align: 'right', cls: 'fd-pop' });
  }

  function toggleSource(p) {
    const cur = new Set(S('feedSources') || []);
    if (cur.has(p.id)) {
      if (cur.size === 1) return toast('The Feed needs at least one site', { ms: 1800 });
      cur.delete(p.id);
    } else {
      cur.add(p.id);
      if (needsKeyMissing(p)) toast(`${p.name} needs an API key: add it in Settings`, { kind: 'err', ms: 3000 });
    }
    setS('feedSources', [...cur]);
    dropUpcoming();
    autoLearn();
    fill();
  }

  /* ---------------------------------------------------------------- starting over */
  let lastRefresh = 0;
  /** New cards (what was already shown stays seen). In For you the posts already fetched are reused, so it is instant. */
  function refreshFeed({ fromScratch = false } = {}) {
    if (!fromScratch && Date.now() - lastRefresh < 4000) return toast('Just refreshed', { ms: 1200 });
    lastRefresh = Date.now();
    leave();
    run++;
    const keepPool = !fromScratch && mode() === 'foryou';
    if (!keepPool) dropPools({ all: true });
    view.items.length = 0;
    while (cards.length) (unmountCard(cards.length - 1), cards.pop().remove());
    view.idx = 0;
    scroller.scrollTop = 0;
    paintEmpty();
    for (const p of enabled()) !needsKeyMissing(p) && followTick(srcOf(p), view);
    fill();
    for (const p of enabled()) { // and a fresh batch behind the cards already on screen
      const src = srcOf(p);
      if (!needsKeyMissing(p) && !src.filling && src.cool <= Date.now()) refill(src, view);
    }
  }

  /** Drops the cards picked ahead: those from sites that are no longer on, or (recheck) any that now carry a banned tag. */
  function dropUpcoming(recheck = false) {
    const keep = new Set(enabled().map((p) => p.id));
    run++;
    const tail = view.items.splice(view.idx + 1).filter((x) => keep.has(x.post.provider) && !(recheck && modelOf(x.post.provider).taste.banned(x.post)));
    while (cards.length > view.items.length) (unmountCard(cards.length - 1), cards.pop().remove());
    for (const x of tail) (view.items.push(x), addSlot());
    dropPools();
    syncWindow();
    paintEmpty();
    if (recheck) fill();
  }

  /* pull down on the first card to refresh */
  let pull = null;
  scroller.addEventListener('touchstart', (e) => { pull = !solo && scroller.scrollTop <= 0 && e.touches.length === 1 ? { y: e.touches[0].clientY, dy: 0 } : null; }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!pull) return;
    pull.dy = e.touches[0].clientY - pull.y;
    if (pull.dy < 0 || scroller.scrollTop > 0 || e.touches.length > 1) return (pull = null), pullEl.classList.remove('show');
    pullEl.style.setProperty('--p', Math.min(1, pull.dy / 110));
    pullEl.classList.toggle('show', pull.dy > 12);
    pullEl.classList.toggle('go', pull.dy > 110);
  }, { passive: true });
  const endPull = () => {
    const go = pull && pull.dy > 110;
    pull = null;
    pullEl.classList.remove('show', 'go');
    if (go) (haptic('tick'), refreshFeed());
  };
  scroller.addEventListener('touchend', endPull, { passive: true });
  scroller.addEventListener('touchcancel', () => (pull = null, pullEl.classList.remove('show', 'go')), { passive: true });

  function autoLearn() {
    if (!S('feedLearn')) return;
    for (const p of enabled()) if (canLearn(p)) learnAccount(p);
  }

  /* --- background upkeep while the Feed is open: follow checks, a top-up of pools */
  const upkeep = setInterval(() => {
    if (solo || !view.active()) return;
    for (const p of enabled()) {
      if (needsKeyMissing(p)) continue;
      const src = srcOf(p);
      followTick(src, view);
      if (src.pool.length < POOL_LOW && !src.filling && src.cool <= Date.now()) refill(src, view);
    }
    if (view.items.length < view.idx + ahead()) fill();
  }, 20000);
  const onVis = () => { if (!document.hidden) { fill(); loadMedia(view.idx, true); } else hush(true); };
  document.addEventListener('visibilitychange', onVis);
  // leaving for another screen: silence at once
  const onHash = () => setTimeout(() => { if (!view.active()) (hush(true), unturn()); }, 0);
  addEventListener('hashchange', onHash);
  // pause video when the viewer or another page covers the feed, and resume when it comes back
  let gone = false;
  function destroy() {
    if (gone) return;
    gone = true;
    clearInterval(watch);
    clearInterval(upkeep);
    clearTimeout(idleT);
    offs.forEach((off) => off());
    sizer.disconnect();
    removeEventListener('keydown', onKey);
    removeEventListener('hashchange', onHash);
    document.removeEventListener('click', onRetap, true);
    document.removeEventListener('visibilitychange', onVis);
    view.artist?.close();
    hush(true);
    leave();
  }
  const watch = setInterval(() => {
    if (!root.isConnected) return destroy();
    if (!view.active()) return hush(true);
    hush();
    const v = cardAt(view.idx)?.querySelector('video');
    if (v && v.paused && !v.dataset.userPaused) v.play().catch(() => {});
  }, 700);

  /* ---------------------------------------------------------------- go */
  const handle = { index: () => view.idx, destroy };
  if (solo) {
    for (const post of list.posts()) (view.items.push({ post, kind: 'list', why: '' }), addSlot());
    const at = Math.max(0, Math.min(list.start || 0, view.items.length - 1));
    view.idx = at;
    scroller.scrollTop = at * scroller.clientHeight;
    if (view.items.length) activate(at);
    else fill();
    return handle;
  }
  paintTabs();
  paintEmpty();
  paintSuggest();
  setTimeout(autoLearn, 15000); // reading favorites can wait: the first cards come first
  setTimeout(() => { for (const p of enabled()) !needsKeyMissing(p) && followTick(srcOf(p), view); }, mode() === 'follows' ? 0 : 8000);
  fill();
  return handle;
}
