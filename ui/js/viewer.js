import { h, clamp, fmtNum, fmtBytes, fmtDate, ago, copyText, pretty } from './util.js';
import { icon } from './icons.js';
import { S, setS, boards, postKey, tagc } from './store.js';
import { CATS, CAT_LABEL, getProvider, isBlurred } from './providers.js';
import { toast, stamp, closePopover } from './ui.js';
import { pinContent, pinPopover, quickPin } from './pins.js';
import { Player } from './player.js';
import { bindContext, showMenu, menuOpen, lastLongPress } from './ctxmenu.js';
import { isPhone, isTouch, isAndroid, haptic, native } from './platform.js';
import { toggleFullscreen, isFullscreen, setFullscreen } from './titlebar.js';

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

export class Viewer {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.list = [];
    this.i = 0;
    this.open_ = false;
    // view transform: current (sc, tx, ty, rot) eases toward the target (t*)
    this.sc = this.tsc = 1;
    this.tx = this.ttx = 0;
    this.ty = this.tty = 0;
    this.rot = this.trot = 0;
    this.fit = 1;
    this.mode = 'fit'; // fit | free
    this.tab = 'tags';
    this.playing = false;
    this.pointers = new Map();
    this.stack = []; // saved lists when stepping into a pool
    this.poolCtx = null;
    this.sheetOpen = false; // phone: the info sheet
    this.swx = this.swy = 0; // live swipe offsets (touch)
    this._unblur = new Set(); // posts the viewer chose to reveal this session
    this._lastTouch = -1e9;
    this._build();
    this._sheetDrag();
    this._onKey = (e) => this._key(e);
    new ResizeObserver(() => this.open_ && this._relayoutMedia()).observe(this.stage);
  }

  get post() { return this.list[this.i]; }
  get isOpen() { return this.open_; }
  get isVideo() { return this.post?.kind === 'video'; }

  /* ============================================================ structure */
  _build() {
    const btn = (name, tip, fn, cls = '') => h('button', { class: 'vbtn ' + cls, title: tip, 'aria-label': tip, onclick: fn, html: icon(name, 19) });
    this.bg = h('div', { class: 'vw-bg' });
    this.counter = h('span', { class: 'vw-count' });
    this.title = h('div', { class: 'vw-title' });
    this.poolBar = h('div', { class: 'vw-pool', hidden: true });
    this.stage = h('div', { class: 'vw-stage' });
    this.ring = h('div', { class: 'vw-ring', hidden: true }, h('i'), h('span', {}, 'original'));
    this.zoomTag = h('div', { class: 'vw-zoom', hidden: true });
    this.prevBtn = h('button', { class: 'vw-nav prev', title: 'Previous (←)', onclick: () => this.go(-1), html: icon('left', 26) });
    this.nextBtn = h('button', { class: 'vw-nav next', title: 'Next (→)', onclick: () => this.go(1), html: icon('right', 26) });
    this.ripple = h('div', { class: 'vw-ripple' });
    this.stage.append(this.ring, this.zoomTag, this.prevBtn, this.nextBtn, this.ripple);
    this.panel = h('aside', { class: 'vw-panel' });
    this.film = h('div', { class: 'vw-film' });
    this.prog = h('div', { class: 'vw-prog' }, h('i'));

    this.bFav = btn('heart', 'Favorite (V)', () => this.toggleFav(), 'fav');
    this.bUp = btn('up', 'Upvote (U)', () => this.upvote(), 'v-desk');
    this.bPin = btn('pin', 'Pin (B) — long-press or right-click for other boards', () => (quickPin([this.post]), setTimeout(() => this._paintToggles(), 60)));
    bindContext(this.bPin, () => this.hooks.postMenu?.(this.post, { viewer: this }));
    this.bPlay = btn('play', 'Slideshow (P)', () => this.toggleSlideshow(), 'v-desk');
    this.bPanel = btn('info', 'Info panel (I)', () => this.togglePanel(), 'v-desk');
    this.bFilm = btn('film', 'Filmstrip (T)', () => this.toggleFilm(), 'v-desk');
    this.bFs = btn('fullscreen', 'Fullscreen (F)', () => this.fullscreen(), 'v-desk');
    this.bSave = btn('download', 'Download', () => this.download(), 'v-phone'); // phones only: the desktop one sits with the other tools
    this.bMore = btn('more', 'More', (e) => this._moreMenu(e.currentTarget), 'v-more');
    this.scrim = h('div', { class: 'vw-scrim', onclick: () => performance.now() - (this._sheetAt || 0) > 450 && this.closeSheet() }); // (the click that ends the opening tap lands here too)

    const top = h('div', { class: 'vw-top' },
      btn('close', 'Close (Esc)', () => this.close()), this.counter, this.title, this.poolBar,
      h('div', { class: 'vw-spacer' }),
      this.bFav, this.bUp, this.bPin, this.bSave,
      h('span', { class: 'vw-sep' }),
      btn('zoomIn', 'Zoom: fit ⇄ 100% (Z)', () => this.cycleZoom(), 'v-desk'),
      btn('rotate', 'Rotate (R)', () => this.rotate(), 'v-desk'),
      this.bFs, this.bPlay, this.bFilm,
      h('span', { class: 'vw-sep' }),
      btn('download', 'Download to your Downloads folder (S)', () => this.download(), 'v-desk'),
      btn('copy', 'Copy post link (C)', () => this.copyLink(), 'v-desk'),
      btn('external', 'Open on site (O)', () => this.openSite(), 'v-desk'),
      this.bPanel,
      btn('keyboard', 'Shortcuts (?)', () => this.help(), 'v-desk'),
      this.bMore,
    );
    this.root.append(this.bg, top, h('div', { class: 'vw-main' }, this.stage, this.panel), this.film, this.prog, this.scrim);
    this.root.hidden = true;

    const s = this.stage;
    s.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    s.addEventListener('pointerdown', (e) => this._pdown(e));
    s.addEventListener('pointermove', (e) => this._pmove(e));
    s.addEventListener('pointerup', (e) => this._pup(e));
    s.addEventListener('pointercancel', (e) => this._pup(e));
    s.addEventListener('dblclick', (e) => performance.now() - this._lastTouch > 700 && this._dbl(e));
    s.addEventListener('auxclick', (e) => e.button === 1 && (e.preventDefault(), this.resetView()));
    this.root.addEventListener('pointermove', (e) => this._moved(e));
    this.root.addEventListener('pointerdown', () => {
      this._hiddenAtDown = this._chromeHidden(); // a tap that merely reveals the controls must not hide them again
      this._wake();
    });

    bindContext(this.root, (e) => this._menuFor(e));
  }

  /* ============================================================ chrome visibility */
  _moved(e) {
    const p = this._lastPtr;
    this._lastPtr = [e.clientX, e.clientY];
    if (p && Math.abs(p[0] - e.clientX) + Math.abs(p[1] - e.clientY) < 3) return; // sub-pixel jitter
    this._wake();
  }

  _wake() {
    this.root.classList.remove('idle', 'immersive');
    clearTimeout(this._idle);
    const video = this.isVideo && this.player && !this.player.v.paused;
    if (this.playing || video) {
      this._idle = setTimeout(() => {
        if (menuOpen() || document.querySelector('.pop,.dlg-back,.help-back')) return this._wake();
        if (!isTouch() && this.root.querySelector('.vw-panel:hover, .pc-bar:hover, .vw-top:hover, .vw-film:hover')) return this._wake(); // (on a touch screen :hover sticks to whatever was last touched)
        this.root.classList.add('idle');
        // videos pull the whole chrome away so the picture can take the window
        if (this.isVideo && this.player && !this.player.v.paused) this.root.classList.add('immersive');
      }, this.isVideo ? 2600 : 2800);
    }
  }

  /* ============================================================ open / close */
  async open(list, index, fromRect) {
    this.list = list;
    this.stack = [];
    this.poolCtx = null;
    this.i = clamp(index, 0, list.length - 1);
    this.open_ = true;
    this.root.hidden = false;
    this.root.classList.toggle('no-panel', !S('panelOpen'));
    this.root.classList.toggle('no-film', !(isPhone() ? S('filmPhone') : S('filmstrip')));
    this.root.classList.remove('sheet-open', 'chrome-off');
    this.sheetOpen = false;
    this.swx = this.swy = 0; // a swipe-down that closed it last time must not displace the next picture
    this.root.style.removeProperty('--vbg-a');
    document.addEventListener('keydown', this._onKey, true);
    requestAnimationFrame(() => this.root.classList.add('in'));
    this.show(0, fromRect);
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    this.stopSlideshow();
    closePopover();
    document.removeEventListener('keydown', this._onKey, true);
    if (isFullscreen()) setFullscreen(false);
    native.orientation('auto');
    this.root.classList.remove('in', 'idle', 'immersive', 'sheet-open', 'chrome-off');
    this.sheetOpen = false;
    clearTimeout(this._idle);
    setTimeout(() => {
      if (!this.open_) {
        this.root.hidden = true;
        this.swx = this.swy = 0;
        this.root.style.removeProperty('--vbg-a');
        this._clearMedia();
      }
    }, 240);
    this.hooks.onClose?.();
  }

  setList(list) {
    if (this.poolCtx) {
      if (this.stack[0]) this.stack[0].list = list;
      return;
    }
    const cur = this.post && postKey(this.post);
    this.list = list;
    const idx = list.findIndex((p) => postKey(p) === cur);
    if (idx >= 0) this.i = idx;
    this.counter.textContent = this._counterText();
    this._renderFilm();
  }

  _counterText() {
    return `${this.i + 1} / ${this.list.length}`;
  }

  /* ============================================================ navigation */
  async go(d, fromX = 0) {
    const n = this.i + d;
    if (n < 0) return (this._springBack(), this._bump(-1));
    if (n >= this.list.length) {
      if (this.poolCtx) return (this._springBack(), this._bump(1));
      const before = this.list.length;
      await this.hooks.onNeedMore?.();
      if (this.list.length <= before) return (this._springBack(), this._bump(1));
    }
    this.i = n;
    this.show(d, undefined, fromX);
  }

  jump(i) {
    if (i === this.i) return;
    const d = i > this.i ? 1 : -1;
    this.i = clamp(i, 0, this.list.length - 1);
    this.show(d);
  }

  _bump(d) {
    this.stage.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-d * 18}px)` }, { transform: 'translateX(0)' }], { duration: 260, easing: 'ease-out' });
    toast(this.poolCtx ? (d > 0 ? 'Last page of the pool' : 'First page of the pool') : d > 0 ? 'End of the trail' : 'First post', { ms: 1200 });
  }

  /* ============================================================ showing a post */
  _clearMedia() {
    this._upgrade = null;
    this.player?.destroy();
    this.player = null;
    this.media?.remove();
    this.media = null;
  }

  /** Swap the backdrop only when the new picture is decoded; changing it earlier flashes the whole screen on a phone. */
  _setBg(url) {
    this._bgWant = url;
    if (!url) return void (this.bg.style.backgroundImage = 'none');
    const apply = () => { if (this._bgWant === url) this.bg.style.backgroundImage = `url("${url}")`; };
    const im = new Image();
    im.src = url;
    im.decode ? im.decode().then(apply, apply) : (im.onload = apply);
  }

  async show(dir, fromRect, fromX = 0) {
    const post = this.post;
    if (!post) return;
    const token = (this._tok = {});
    this._settle();
    this.swx = this.swy = 0;
    this.root.style.removeProperty('--vbg-a');
    this.rot = this.trot = 0;
    this.mode = 'fit';
    this.tx = this.ttx = this.ty = this.tty = 0;
    this.counter.textContent = this._counterText();
    this.hooks.onNavigate?.(post, this.i);
    const blurred = isBlurred(post) && !this._unblur.has(postKey(post));
    this._setBg(blurred ? '' : post.thumb);
    const artist = post.artists.length ? post.artists.slice(0, 3).map(pretty).join(', ') : 'unknown artist';
    this.title.replaceChildren(h('b', {}, artist), h('span', {}, `#${post.id} · ${post.provider}`));
    this._paintToggles();

    const old = this.media, oldPlayer = this.player;
    this.player = null;
    const el = this._makeMedia(post);
    this.media = el;
    this.stage.prepend(el);
    if (this.player) this.stage.append(this.player.el);
    this._guard(post, el, blurred);
    this._relayoutMedia(true);
    const slide = !!(dir && isTouch() && old && !fromRect);
    if (fromRect && post.kind !== 'video') this._flip(el, fromRect);
    else if (slide) {
      // the two pictures travel together, one screen apart, starting from wherever the finger let go
      const span = this.stage.clientWidth + 24, ms = 280, ease = 'cubic-bezier(.22,.8,.24,1)';
      const mk = (node, from, to, keep) => {
        const a = node.animate([{ translate: `${from}px 0` }, { translate: `${to}px 0` }], { duration: ms, easing: ease, fill: keep ? 'forwards' : 'none' });
        (this._anims ||= new Set()).add(a);
        const done = () => this._anims?.delete(a);
        a.addEventListener('finish', done);
        a.addEventListener('cancel', done);
        return a;
      };
      mk(el, fromX + dir * span, 0, false);
      const out = mk(old, 0, -dir * span - fromX, true); // `old` already sits at the finger's offset via its transform
      out.addEventListener('finish', () => old.remove());
      out.addEventListener('cancel', () => old.remove());
    } else if (dir && isTouch()) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
    else el.animate([{ opacity: 0, filter: 'blur(8px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 260, easing: 'ease-out' });
    if (old) {
      old.style.pointerEvents = 'none';
      oldPlayer ? oldPlayer.destroy() : old.pause?.();
      if (!slide) old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).onfinish = () => old.remove();
    }
    this.root.classList.toggle('is-video', this.isVideo);
    // while the pictures are sliding, keep the main thread free: the panel and filmstrip can catch up a beat later
    const later = (fn) => (slide ? requestAnimationFrame(() => setTimeout(() => token === this._tok && fn(), 0)) : fn());
    later(() => { this._renderPanel(); this._renderFilm(); this._renderPoolBar(token); this._preload(); });
    this._wake();
    if (this.i >= this.list.length - 6 && !this.poolCtx) this.hooks.onNeedMore?.();
    if (this.playing) this._armSlide(token);
  }

  /** A #blur post stays blurred (and a video silent and paused) until it is deliberately revealed. */
  _guard(post, el, blurred) {
    this.stage.querySelector('.vw-blur')?.remove();
    this.root.classList.toggle('blur-on', blurred);
    if (!blurred) return;
    el.classList.add('blurred');
    const vid = el.tagName === 'VIDEO';
    if (vid) { el.muted = true; el.pause(); el.addEventListener('play', () => el.classList.contains('blurred') && el.pause()); }
    const reveal = () => {
      this._unblur.add(postKey(post));
      el.classList.remove('blurred');
      this.root.classList.remove('blur-on');
      this.bg.style.backgroundImage = `url("${post.thumb}")`;
      btn.remove();
      this._renderFilm();
      if (vid && S('autoplay')) el.play().catch(() => {});
    };
    const btn = h('button', { class: 'vw-blur', type: 'button', onclick: (e) => (e.stopPropagation(), reveal()) }, h('i', { html: icon('eye', 22) }), h('b', {}, 'Blurred'), h('small', {}, isTouch() ? 'Tap to reveal' : 'Click to reveal'));
    this.stage.append(btn);
  }

  /** Jump any running slide to its end (a new touch should find the picture at rest). */
  _settle() {
    if (!this._anims?.size) return;
    for (const a of [...this._anims]) { try { a.finish(); } catch { /* already done */ } }
    this._anims.clear();
  }

  _makeMedia(post) {
    if (post.kind === 'video') {
      const v = h('video', { class: 'media vid', src: post.full, poster: post.thumb, playsinline: true, preload: 'auto' });
      this.player = new Player(v, post, {
        slideshow: () => this.playing,
        onEnded: () => this.go(1),
        onFullscreen: () => this.fullscreen(),
      });
      v.addEventListener('play', () => this._wake());
      v.addEventListener('pause', () => this._wake());
      v.addEventListener('loadedmetadata', () => { if (!post.w && v.videoWidth) { post.w = v.videoWidth; post.h = v.videoHeight; this._relayoutMedia(); } });
      if (S('autoplay')) v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
      return v;
    }
    if (post.kind === 'flash') {
      return h('div', { class: 'media flash' }, h('b', {}, 'Flash file'), h('p', {}, 'Browsers can’t play .swf any more.'), h('button', { class: 'btn primary', onclick: () => this.openSite() }, 'Open on site'));
    }
    // animated GIFs go straight to the real file: a static "sample" would swap in noticeably later
    const first = post.kind === 'anim' ? post.full : post.sample || post.full;
    const img = h('img', { class: 'media', alt: '', draggable: 'false', src: first });
    // until the picture itself has loaded, show the thumbnail (already in memory from the gallery) instead of a blank box
    if (post.thumb && post.thumb !== first) {
      img.style.cssText = `background:url("${post.thumb}") center/100% 100% no-repeat`;
      img.addEventListener('load', () => (img.style.background = ''), { once: true });
    }
    // The full-size original is only a sharper copy. Swapping it in by changing `src` blanks the picture while a
    // multi-megapixel image decodes (the screen flashes), so it is decoded off to the side first and then swapped in one go.
    // On a touch screen it waits until you actually zoom in: at fit size it looks the same and costs a huge GPU layer.
    this._upgrade = null;
    if (S('fullOriginal') && post.full !== first && post.kind !== 'anim') {
      let started = false;
      const upgrade = async () => {
        if (started || this.media !== img) return;
        started = true;
        this.ring.hidden = false;
        try {
          const next = img.cloneNode(false); // same size, position and transform as the one on screen
          next.style.background = '';
          next.src = post.full;
          await next.decode();
          if (this.media === img && img.isConnected) {
            img.replaceWith(next);
            this.media = next;
            this._paint();
          }
        } catch { /* keep the sample: the original would not load */ }
        this.ring.hidden = true;
      };
      this._upgrade = upgrade;
      if (isTouch()) this.ring.hidden = true;
      else upgrade();
    } else this.ring.hidden = true;
    img.addEventListener('load', () => {
      if (!post.w && img.naturalWidth) { post.w = img.naturalWidth; post.h = img.naturalHeight; this._relayoutMedia(); }
    });
    let fails = 0;
    img.addEventListener('error', () => {
      fails++;
      img.src = fails === 1 ? '/img?u=' + encodeURIComponent(post.sample || post.full) : fails === 2 ? post.thumb : img.src;
    });
    return img;
  }

  _flip(el, r) {
    const s = this.stage.getBoundingClientRect();
    const dx = r.left + r.width / 2 - (s.left + s.width / 2), dy = r.top + r.height / 2 - (s.top + s.height / 2);
    const nw = this.post.w || r.width;
    const from = `translate(${dx}px,${dy}px) rotate(0deg) scale(${r.width / nw})`;
    el.animate([{ transform: from, opacity: 0.7 }, { transform: el.style.transform, opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.85,.25,1)' });
  }

  /* ============================================================ transform (smooth) */
  _dims() {
    const p = this.post;
    const nw = p.w || this.media?.naturalWidth || this.media?.videoWidth || 800;
    const nh = p.h || this.media?.naturalHeight || this.media?.videoHeight || 800;
    return Math.round(this.trot / 90) % 2 ? [nh, nw] : [nw, nh];
  }

  /** Re-measure the stage and snap (used on resize/new post, so growing panels stay in lock-step). */
  _relayoutMedia(reset) {
    const m = this.media;
    if (!m || !this.post) return;
    const p = this.post;
    if (p.kind === 'flash') return;
    const nw = p.w || m.naturalWidth || m.videoWidth || 800, nh = p.h || m.naturalHeight || m.videoHeight || 800;
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    m.style.width = nw + 'px';
    m.style.height = nh + 'px';
    m.style.marginLeft = -nw / 2 + 'px';
    m.style.marginTop = -nh / 2 + 'px';
    const [ew, eh] = this._dims();
    this.fit = Math.min(sw / ew, sh / eh, p.kind === 'video' ? 6 : 5);
    if (this.mode === 'fit' || reset) {
      this.sc = this.tsc = this.fit;
      this.tx = this.ttx = this.ty = this.tty = 0;
    }
    this._clampTarget();
    this.tx = clamp(this.tx, ...this._bounds(this.sc, 'x'));
    this.ty = clamp(this.ty, ...this._bounds(this.sc, 'y'));
    this.rot = this.trot;
    this._paint();
  }

  _bounds(sc, axis) {
    const [ew, eh] = this._dims();
    const m = axis === 'x' ? Math.max(0, (ew * sc - this.stage.clientWidth) / 2) : Math.max(0, (eh * sc - this.stage.clientHeight) / 2);
    return [-m, m];
  }

  _clampTarget() {
    this.ttx = clamp(this.ttx, ...this._bounds(this.tsc, 'x'));
    this.tty = clamp(this.tty, ...this._bounds(this.tsc, 'y'));
  }

  /** Just the transform: nothing else may change while a finger is dragging the picture. */
  _paintSwipe() {
    const m = this.media;
    if (!m) return;
    const k = this.swy ? 1 - Math.min(Math.abs(this.swy) / 1400, 0.14) : 1;
    m.style.transform = `translate(${this.tx + this.swx}px,${this.ty + this.swy}px) rotate(${this.rot}deg) scale(${this.sc * k})`;
  }

  _paint() {
    const m = this.media;
    if (!m) return;
    const k = this.swy ? 1 - Math.min(Math.abs(this.swy) / 1400, 0.14) : 1;
    m.style.transform = `translate(${this.tx + this.swx}px,${this.ty + this.swy}px) rotate(${this.rot}deg) scale(${this.sc * k})`;
    this.stage.classList.toggle('zoomed', this.tsc > this.fit * 1.02);
    this.zoomTag.textContent = this.mode === 'fit' ? 'FIT' : Math.round(this.tsc * 100) + '%';
    this.zoomTag.hidden = false;
  }

  /** Ease the current values toward the targets: scroll-wheel notches become a glide, not steps. */
  _kick() {
    if (this._zr) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      const k = 1 - Math.exp(-dt / 78);
      this.sc += (this.tsc - this.sc) * k;
      this.tx += (this.ttx - this.tx) * k;
      this.ty += (this.tty - this.ty) * k;
      this.rot += (this.trot - this.rot) * (1 - Math.exp(-dt / 110));
      const done = Math.abs(this.tsc - this.sc) < this.tsc * 0.0006 && Math.abs(this.ttx - this.tx) < 0.2 && Math.abs(this.tty - this.ty) < 0.2 && Math.abs(this.trot - this.rot) < 0.05;
      if (done) {
        this.sc = this.tsc; this.tx = this.ttx; this.ty = this.tty; this.rot = this.trot;
        this._zr = 0;
        return this._paint();
      }
      this._paint();
      this._zr = requestAnimationFrame(step);
    };
    this._zr = requestAnimationFrame(step);
  }

  zoomAt(factor, cx, cy) {
    if (this._upgrade && factor > 1) this._upgrade(); // zooming in: now the original is worth having
    const next = clamp(this.tsc * factor, this.fit * 0.4, 24);
    const k = next / this.tsc;
    this.ttx = cx - (cx - this.ttx) * k;
    this.tty = cy - (cy - this.tty) * k;
    this.tsc = next;
    this.mode = Math.abs(next - this.fit) < this.fit * 0.01 ? 'fit' : 'free';
    if (this.mode === 'fit') (this.tsc = this.fit), (this.ttx = this.tty = 0);
    this._clampTarget();
    this._kick();
  }

  _stagePoint(e) {
    const r = this.stage.getBoundingClientRect();
    return [e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)];
  }

  _wheel(e) {
    if (e.target.closest('.vw-panel,.pc')) return;
    e.preventDefault();
    if (S('wheel') === 'nav' && !e.ctrlKey) {
      const now = performance.now();
      if (now - (this._wt || 0) > 220) {
        this._wt = now;
        this.go(e.deltaY > 0 ? 1 : -1);
      }
      return;
    }
    const [cx, cy] = this._stagePoint(e);
    // pixel-mode deltas (mice) come in 100s; clamp so one notch is a gentle ~12% step
    const d = clamp(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY, -240, 240);
    this.zoomAt(Math.exp(-d * 0.0012), cx, cy);
  }

  _dbl(e) {
    if (this.isVideo) {
      if (e.target.closest('.pc')) return;
      if (this.mode !== 'fit') return this.resetView(); // zoomed in: a double-click goes back to fit; otherwise it is fullscreen
      return this.fullscreen();
    }
    if (!e.target.closest('.media')) return;
    const [cx, cy] = this._stagePoint(e);
    if (this.mode === 'fit' && this.fit < 1) this.zoomAt(1 / this.tsc, cx, cy);
    else if (this.mode === 'fit') this.zoomAt(2.5, cx, cy);
    else this.resetView();
  }

  cycleZoom() {
    if (this.mode === 'fit') this.zoomAt(this.fit < 1 ? 1 / this.tsc : 2, 0, 0);
    else this.resetView();
  }

  resetView() {
    this.mode = 'fit';
    this.tsc = this.fit;
    this.ttx = this.tty = 0;
    this._kick();
  }

  rotate() {
    if (this.isVideo) return;
    this.trot += 90;
    const [ew, eh] = this._dims();
    this.fit = Math.min(this.stage.clientWidth / ew, this.stage.clientHeight / eh, 5);
    if (this.mode === 'fit') (this.tsc = this.fit), (this.ttx = this.tty = 0);
    this._clampTarget();
    this._kick();
  }

  _pdown(e) {
    if (e.target.closest('button,.pc,.vw-panel')) return;
    this.stage.setPointerCapture?.(e.pointerId);
    if (!this.pointers.size) this._settle();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now();
    this._drag = { x: e.clientX, y: e.clientY, tx: this.ttx, ty: this.tty, moved: false, video: e.target.tagName === 'VIDEO', touch: e.pointerType === 'touch', axis: null, t0: now, lx: e.clientX, ly: e.clientY, lt: now, vx: 0, vy: 0 };
    if (this.pointers.size === 2) {
      this._pinch = this._pdist();
      this._drag.axis = 'pinch'; // two fingers: never a swipe
      this.swx = this.swy = 0;
    }
  }

  _pdist() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _pmove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && this._pinch) {
      const d = this._pdist();
      const [a, b] = [...this.pointers.values()];
      const r = this.stage.getBoundingClientRect();
      this.zoomAt(d / this._pinch, (a.x + b.x) / 2 - (r.left + r.width / 2), (a.y + b.y) / 2 - (r.top + r.height / 2));
      this._pinch = d;
      return;
    }
    const d = this._drag;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > (d.touch ? 8 : 4)) d.moved = true;
    const now = performance.now();
    if (now > d.lt) {
      d.vx = 0.6 * d.vx + 0.4 * ((e.clientX - d.lx) / (now - d.lt));
      d.vy = 0.6 * d.vy + 0.4 * ((e.clientY - d.ly) / (now - d.lt));
      d.lx = e.clientX; d.ly = e.clientY; d.lt = now;
    }
    // one finger on an un-zoomed picture: the picture follows the finger sideways (previous / next) or vertically (close / info)
    if (d.touch && d.moved && d.axis !== 'pinch' && !this.stage.classList.contains('zoomed') && this.pointers.size === 1) {
      if (!d.axis) d.axis = Math.abs(dx) > Math.abs(dy) * 1.1 ? 'x' : 'y';
      if (d.axis === 'x') this.swx = dx * (this.i === 0 && dx > 0 || this.i === this.list.length - 1 && dx < 0 ? 0.35 : 1);
      else if (d.axis === 'y') {
        this.swy = dy;
        this.root.style.setProperty('--vbg-a', Math.max(0.2, 0.97 - Math.max(0, dy) / 520));
      }
      this._paintSwipe();
      return;
    }
    if (this.stage.classList.contains('zoomed') && d.moved) {
      // dragging is direct (no easing) so the picture sticks to the pointer
      this.ttx = this.tx = clamp(this._drag.tx + dx, ...this._bounds(this.tsc, 'x'));
      this.tty = this.ty = clamp(this._drag.ty + dy, ...this._bounds(this.tsc, 'y'));
      this._paint();
      this.stage.classList.add('panning');
    }
  }

  _pup(e) {
    const d = this._drag;
    this.pointers.delete(e.pointerId);
    this._pinch = 0;
    if (this.pointers.size === 1 && d) {
      // One finger of a pinch lifted. The drag record still starts where the *other* finger first landed, so the finger that
      // stays down would pan the picture by the distance between the two (it darts sideways). Restart it from where it is now.
      const [rest] = this.pointers.values();
      Object.assign(d, { x: rest.x, y: rest.y, lx: rest.x, ly: rest.y, lt: performance.now(), vx: 0, vy: 0, tx: this.ttx, ty: this.tty, moved: false, axis: 'pinch' });
    }
    this.stage.classList.remove('panning');
    if (d?.touch) {
      this._lastTouch = performance.now();
      if (this._touchUp(e, d)) return void (!this.pointers.size && (this._drag = null));
    } else if (d && !d.moved && d.video && this.player && e.button === 0) this.player.toggle(); // click the picture = play/pause
    if (d && !d.touch && !this.stage.classList.contains('zoomed') && d.moved) {
      const dx = e.clientX - d.x;
      if (Math.abs(dx) > 90 && Math.abs(e.clientY - d.y) < 80) this.go(dx < 0 ? 1 : -1); // mouse drag swipe
    }
    if (!this.pointers.size) this._drag = null;
  }

  /** A finger lifted. Returns true when the gesture was fully handled here. */
  _touchUp(e, d) {
    if (performance.now() - lastLongPress() < 900) return this._springBack(), true; // the lift that ends a long-press
    if (d.axis === 'x' || d.axis === 'y') {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      this.root.style.removeProperty('--vbg-a');
      if (d.axis === 'x' && (Math.abs(dx) > 70 || Math.abs(d.vx) > 0.5) && Math.sign(dx || d.vx) !== 0) {
        const dir = (dx || d.vx) < 0 ? 1 : -1; // swiping left shows the next one
        const edge = dir > 0 ? this.i >= this.list.length - 1 && this.poolCtx : this.i === 0;
        if (edge) return this._bump(dir), this._springBack(), true;
        this.go(dir, this.swx);
        return true;
      }
      if (d.axis === 'y' && (dy > 130 || d.vy > 0.7)) return this.close(), true;
      if (d.axis === 'y' && (dy < -70 || d.vy < -0.6) && isPhone()) return this._springBack(), this.openSheet(), true;
      return this._springBack(), true;
    }
    if (d.moved || d.axis === 'pinch') {
      if (!this.pointers.size) this._springBack();
      return true;
    }
    if (this.pointers.size) return true; // another finger is still down
    // pictures: one tap hides the controls, two likes it (favorite + upvote), three pins it
    if (!this.isVideo && S('dtap') !== 'zoom') return this._tapSeq(e), true;
    // a tap: single (after a beat, in case it becomes a double) or double
    const now = performance.now(), prev = this._lastTap;
    if (prev && now - prev.t < 300 && Math.hypot(prev.x - e.clientX, prev.y - e.clientY) < 44) {
      clearTimeout(this._tapTimer);
      this._lastTap = null;
      this._doubleTap(e);
    } else {
      this._lastTap = { t: now, x: e.clientX, y: e.clientY };
      const hidden = this._hiddenAtDown;
      this._tapTimer = setTimeout(() => { this._lastTap = null; this._singleTap(hidden); }, 260);
    }
    return true;
  }

  _springBack() {
    const m = this.media;
    if (!m || (!this.swx && !this.swy)) return (this.swx = this.swy = 0), true;
    m.style.transition = 'transform .26s cubic-bezier(.2,.8,.2,1)';
    this.swx = this.swy = 0;
    this._paint();
    setTimeout(() => m && (m.style.transition = ''), 300);
    return true;
  }

  _chromeHidden() {
    const c = this.root.classList;
    return c.contains('immersive') || c.contains('idle') || c.contains('chrome-off');
  }

  /** Tap the picture: hide or reveal the controls. */
  _singleTap(hiddenAtDown) {
    if (!isTouch() || !this.open_) return;
    if (this.sheetOpen) return this.closeSheet();
    if (hiddenAtDown) {
      this.root.classList.remove('chrome-off', 'immersive', 'idle');
      this._wake();
    } else {
      clearTimeout(this._idle);
      this.root.classList.add('chrome-off');
      if (this.isVideo && this.player && !this.player.v.paused) this.root.classList.add('immersive');
    }
  }

  /**
   * Counting taps on a picture: one hides the controls, two like it, three pin it. The like waits a moment to make sure
   * no third tap follows, so a triple-tap only ever pins.
   */
  _tapSeq(e) {
    const now = performance.now(), t = this._taps;
    const near = t && now - t.t < 300 && Math.hypot(t.x - e.clientX, t.y - e.clientY) < 60;
    if (near && t.n === 1) {
      clearTimeout(this._tapTimer);
      const x = e.clientX, y = e.clientY;
      this._taps = { n: 2, t: now, x, y };
      clearTimeout(this._likeTimer);
      this._likeTimer = setTimeout(() => { if (this._taps?.n === 2) this._taps = null; this._like(x, y); }, 310);
    } else if (near && t.n === 2) {
      clearTimeout(this._likeTimer); // it was the start of a triple-tap: the like never happens
      this._taps = { n: 3, t: now, x: e.clientX, y: e.clientY };
      this._pinTap(e.clientX, e.clientY);
    } else {
      this._taps = { n: 1, t: now, x: e.clientX, y: e.clientY };
      const hidden = this._hiddenAtDown;
      this._tapTimer = setTimeout(() => { if (this._taps?.n === 1) this._taps = null; this._singleTap(hidden); }, 260);
    }
  }

  /** A heart (or pin) that pops where the finger is and floats away. */
  _burst(x, y, kind) {
    const r = this.stage.getBoundingClientRect();
    const el = h('div', { class: 'vw-burst ' + kind, style: `left:${x - r.left}px;top:${y - r.top}px;--rot:${(Math.random() - 0.5) * 24}deg`, html: icon(kind === 'pin' ? 'pin' : 'heart', 96) });
    this.stage.append(el);
    setTimeout(() => el.remove(), 900);
  }

  /** Double-tap: favorite + upvote. It only ever adds, so a stray double-tap cannot un-like something. */
  async _like(x, y) {
    const p = this.post;
    if (!p) return;
    const prov = getProvider(p.provider);
    this._burst(x, y, 'heart');
    haptic('tick');
    if (!prov.fav && !prov.vote) {
      if (!this._noLikeHint) { this._noLikeHint = true; toast(`${prov.name} has no favorites to like. Triple-tap pins the picture instead`, { ms: 3200 }); }
      return;
    }
    const c = (S('creds') || {})[prov.credKey];
    if (!c?.user || !c?.key) {
      if (!this._noKeyHint) { this._noKeyHint = true; toast('Add your username + API key in Settings to favorite and upvote from a double-tap.', { kind: 'err', ms: 4200 }); }
      return;
    }
    const jobs = [];
    if (prov.fav && !p.faved) jobs.push(prov.setFav(p, true).then(() => { p.faved = true; p.favs += 1; this._paintToggles(); }));
    if (prov.vote && !p._voted) jobs.push(prov.setVote(p, 1, true).then(() => { Object.defineProperty(p, '_voted', { value: true, enumerable: false, writable: true, configurable: true }); }));
    if (!jobs.length) return;
    try {
      await Promise.all(jobs);
      if (!this._likedHint) { this._likedHint = true; toast('Liked: added to your favorites and upvoted', { ms: 1800 }); }
    } catch (e) {
      toast(e.message, { kind: 'err' });
    }
  }

  /** Triple-tap: quick pin (tap three times again to unpin; the toast has Undo). */
  _pinTap(x, y) {
    if (!this.post) return;
    this._burst(x, y, 'pin');
    haptic('heavy');
    quickPin([this.post]);
    setTimeout(() => this._paintToggles(), 60);
  }

  _doubleTap(e) {
    if (this.isVideo && this.player) {
      const r = this.stage.getBoundingClientRect(), f = (e.clientX - r.left) / r.width;
      if (f < 0.34) (this.player.seekBy(-10), this._rip('left', '−10 s'));
      else if (f > 0.66) (this.player.seekBy(10), this._rip('right', '+10 s'));
      else this.player.toggle();
      return;
    }
    this._dbl({ target: this.media || this.stage, clientX: e.clientX, clientY: e.clientY });
  }

  _rip(side, text) {
    const r = this.ripple;
    r.className = 'vw-ripple ' + side;
    r.textContent = text;
    void r.offsetWidth;
    r.classList.add('go');
  }

  /* ---- the info sheet (phones) */
  openSheet() {
    if (!isPhone()) return;
    this.sheetOpen = true;
    this._sheetAt = performance.now();
    this.root.classList.add('sheet-open');
    this.root.classList.remove('chrome-off', 'immersive', 'idle');
  }
  closeSheet() {
    this.sheetOpen = false;
    this.root.classList.remove('sheet-open');
  }
  toggleSheet() {
    this.sheetOpen ? this.closeSheet() : this.openSheet();
  }

  /** Drag the sheet by its handle / summary row; flick to open or close. */
  _sheetDrag() {
    const panel = this.panel;
    let s = null;
    panel.addEventListener('pointerdown', (e) => {
      if (!isPhone() || !e.target.closest('.pn-grab,.pn-score')) return;
      panel.setPointerCapture?.(e.pointerId);
      s = { y: e.clientY, ly: e.clientY, lt: performance.now(), v: 0, dy: 0, moved: false, open: this.sheetOpen, max: panel.offsetHeight - 70 };
      panel.style.transition = 'none';
    });
    panel.addEventListener('pointermove', (e) => {
      if (!s) return;
      const raw = e.clientY - s.y;
      if (Math.abs(raw) > 6) s.moved = true;
      const now = performance.now();
      if (now > s.lt) s.v = 0.6 * s.v + 0.4 * ((e.clientY - s.ly) / (now - s.lt));
      s.ly = e.clientY; s.lt = now;
      s.dy = s.open ? Math.max(0, raw) : Math.max(-s.max, Math.min(0, raw));
      panel.style.setProperty('--dy', s.dy + 'px');
    });
    const end = () => {
      if (!s) return;
      const { moved, dy, v, open } = s;
      s = null;
      panel.style.transition = '';
      panel.style.removeProperty('--dy');
      if (!moved) return this.toggleSheet();
      if (open) (dy > 70 || v > 0.6 ? this.closeSheet() : this.openSheet());
      else (dy < -50 || v < -0.5 ? this.openSheet() : this.closeSheet());
    };
    panel.addEventListener('pointerup', end);
    panel.addEventListener('pointercancel', end);
  }

  _moreMenu(btn) {
    const r = btn.getBoundingClientRect();
    showMenu(r.right, r.bottom, this._menuFor({ target: this.stage }));
  }

  /* ============================================================ preloading */
  _preload() {
    for (const o of [1, 2, -1]) {
      const p = this.list[this.i + o];
      if (p && p.kind !== 'video') {
        const im = new Image();
        im.src = p.kind === 'anim' ? p.full : p.sample || p.full;
        im.decode?.().catch(() => {});
        if (o === 1 && !isTouch() && S('fullOriginal') && p.full !== (p.sample || p.full) && p.kind !== 'anim') {
          const big = new Image();
          big.src = p.full;
        }
      }
    }
  }

  /* ============================================================ slideshow */
  toggleSlideshow() {
    this.playing ? this.stopSlideshow() : this.startSlideshow();
  }

  startSlideshow() {
    this.playing = true;
    this.root.classList.add('playing');
    this._paintToggles();
    this._armSlide(this._tok);
    this._wake();
    toast(`Slideshow · ${S('slideshowSec')}s per image`, { ms: 1600 });
  }

  stopSlideshow() {
    this.playing = false;
    clearTimeout(this._slide);
    this.root.classList.remove('playing');
    this.prog.firstChild.style.transition = 'none';
    this.prog.firstChild.style.width = '0';
    this._paintToggles();
  }

  _armSlide(token) {
    clearTimeout(this._slide);
    const bar = this.prog.firstChild;
    bar.style.transition = 'none';
    bar.style.width = '0';
    if (this.post.kind === 'video') return; // advances on 'ended'
    const ms = S('slideshowSec') * 1000;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.transition = `width ${ms}ms linear`;
      bar.style.width = '100%';
    }));
    this._slide = setTimeout(() => this._tok === token && this.playing && this.go(1), ms);
  }

  /* ============================================================ toggles / actions */
  _paintToggles() {
    const p = this.post;
    if (!p) return;
    const prov = getProvider(p.provider);
    this.bFav.hidden = !prov.fav;
    this.bUp.hidden = !prov.vote;
    this.bSave.hidden = p.kind === 'flash';
    this.bFav.classList.toggle('on', !!p.faved);
    this.bPin.classList.toggle('on', boards.inAny(postKey(p)));
    this.bPlay.innerHTML = icon(this.playing ? 'pause' : 'play', 19);
    this.bPlay.classList.toggle('on', this.playing);
    this.bPanel.classList.toggle('on', S('panelOpen'));
    this.bFilm.classList.toggle('on', isPhone() ? S('filmPhone') : S('filmstrip'));
    this.bFs.classList.toggle('on', isFullscreen());
  }

  togglePanel() {
    setS('panelOpen', !S('panelOpen'));
    this.root.classList.toggle('no-panel', !S('panelOpen'));
    this._paintToggles();
  }

  toggleFilm() {
    const key = isPhone() ? 'filmPhone' : 'filmstrip';
    setS(key, !S(key));
    this.root.classList.toggle('no-film', !S(key));
    this._paintToggles();
  }

  /** True fullscreen: the window itself takes over the screen (title bar included). */
  fullscreen() {
    const entering = !isFullscreen();
    if (isAndroid()) native.orientation(entering && this.isVideo && (this.post.w || 1) >= (this.post.h || 1) ? 'landscape' : 'auto');
    toggleFullscreen();
    setTimeout(() => this._paintToggles(), 120);
    this._wake();
  }

  async toggleFav() {
    const p = this.post, prov = getProvider(p.provider);
    const c = (S('creds') || {})[prov.credKey];
    if (!c?.user || !c?.key) return toast('Add your username + API key in Settings to favorite posts.', { kind: 'err' });
    const want = !p.faved;
    try {
      await prov.setFav(p, want);
      p.faved = want;
      p.favs += want ? 1 : -1;
      toast(want ? 'Added to your favorites' : 'Removed from favorites', { ms: 1400 });
      this._paintToggles();
      this._renderPanel();
    } catch (e) {
      toast(e.message, { kind: 'err' });
    }
  }

  async upvote() {
    const p = this.post, prov = getProvider(p.provider);
    const c = (S('creds') || {})[prov.credKey];
    if (!c?.user || !c?.key) return toast('Add your username + API key in Settings to vote.', { kind: 'err' });
    try {
      await prov.setVote(p, 1);
      toast('Upvoted', { ms: 1200 });
    } catch (e) {
      toast(e.message, { kind: 'err' });
    }
  }

  download() {
    this.hooks.savePost?.(this.post);
  }

  copyLink() {
    copyText(this.post.url);
    toast('Post link copied', { ms: 1400 });
  }

  openSite() {
    fetch('/open?u=' + encodeURIComponent(this.post.url), { method: 'POST' });
  }

  help() {
    this.hooks.onHelp?.();
  }

  /* ============================================================ pools */
  async _renderPoolBar(token) {
    const post = this.post, prov = getProvider(post.provider);
    const bar = this.poolBar;
    this._poolGo = null;
    if (!prov.pools || !(post.pools?.length || this.poolCtx)) return void (bar.hidden = true);
    const id = this.poolCtx?.id ?? post.pools[0];
    let pool;
    try {
      pool = await this.hooks.poolInfo?.(prov, id);
    } catch {}
    if (!pool || this._tok !== token) return;
    const pos = pool.ids.indexOf(post.id);
    const comic = post.isComic || this.poolCtx?.kind === 'comic';
    const go = (d) => {
      const t = pool.ids[pos + d];
      if (!t) return toast(d > 0 ? 'Last page of the pool' : 'First page of the pool', { ms: 1100 });
      if (this.poolCtx?.id === id) {
        const j = this.list.findIndex((p) => p.id === t);
        if (j >= 0) return this.jump(j);
      }
      this.hooks.enterPool?.(id, t);
    };
    this._poolGo = go;
    const more = post.pools.length > 1;
    bar.replaceChildren(
      h('i', { class: 'vp-ic', html: icon(comic ? 'book' : 'pool', 15) }),
      h('button', { class: 'vp-name', title: 'Open the pool', onclick: () => this.hooks.openPoolPage?.(id) }, h('em', {}, comic ? 'COMIC' : 'POOL'), pool.name),
      h('span', { class: 'vp-pos' }, pos >= 0 ? `${pos + 1}/${pool.ids.length}` : `–/${pool.ids.length}`),
      h('button', { class: 'vp-b', title: 'Previous page in pool (PgUp)', disabled: pos <= 0, onclick: () => go(-1), html: icon('left', 14) }),
      h('button', { class: 'vp-b', title: 'Next page in pool (PgDn)', disabled: pos < 0 || pos >= pool.ids.length - 1, onclick: () => go(1), html: icon('right', 14) }),
      comic ? h('button', { class: 'vp-read', title: 'Read as a comic', onclick: () => this.hooks.readPool?.(id, post.id), html: icon('book', 14) + '<span>Read</span>' }) : null,
      more ? h('button', { class: 'vp-b', title: 'Other pools this post is in', onclick: (e) => this._poolsMenu(e.currentTarget), html: icon('more', 14) }) : null,
      this.poolCtx && !this.poolCtx.root ? h('button', { class: 'vp-b', title: 'Leave pool mode', onclick: () => this.leavePool(), html: icon('close', 13) }) : null,
    );
    bar.hidden = false;
  }

  async _poolsMenu(btn) {
    const prov = getProvider(this.post.provider);
    const items = await Promise.all(this.post.pools.map(async (id) => {
      const p = await this.hooks.poolInfo?.(prov, id).catch(() => null);
      return { label: p ? `${p.name} (${p.count})` : `Pool #${id}`, icon: 'pool', run: () => this.hooks.enterPool?.(id, this.post.id) };
    }));
    const r = btn.getBoundingClientRect();
    showMenu(r.left, r.bottom, [{ header: 'In pools' }, ...items]);
  }

  /** Swap the viewer's list for a pool's pages (keeps the old one so you can step back out). */
  enterPool(pool, posts, startId, kind) {
    if (!posts.length) return;
    if (!this.poolCtx) this.stack.push({ list: this.list, i: this.i });
    this.poolCtx = { id: pool.id, name: pool.name, kind };
    this.list = posts;
    const j = posts.findIndex((p) => p.id === startId);
    this.i = j >= 0 ? j : 0;
    this.show(0);
  }

  leavePool() {
    const s = this.stack.pop();
    this.poolCtx = null;
    if (s) {
      this.list = s.list;
      this.i = s.i;
    }
    this.show(0);
  }

  /* ============================================================ keys */
  _key(e) {
    if (e.target.matches('input,textarea,select')) return;
    const k = e.key.toLowerCase();
    const stop = () => (e.preventDefault(), e.stopPropagation());
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'escape') {
      if (document.querySelector('.pop,.dlg-back,.help-back') || menuOpen()) return;
      stop();
      if (this.sheetOpen) return this.closeSheet();
      if (isFullscreen()) return setFullscreen(false), this._paintToggles();
      return this.close();
    }
    if (document.querySelector('.dlg-back,.help-back') || menuOpen()) return;
    const pl = this.isVideo ? this.player : null;
    const nav = (d) => () => this.go(d);
    const map = {
      arrowright: () => (e.shiftKey && pl ? pl.seekBy(5) : this.go(1)), d: nav(1), j: nav(1),
      arrowleft: () => (e.shiftKey && pl ? pl.seekBy(-5) : this.go(-1)), a: nav(-1), k: nav(-1),
      arrowup: () => pl?.volumeBy(0.05), arrowdown: () => pl?.volumeBy(-0.05),
      pageup: () => (this._poolGo ? this._poolGo(-1) : this.go(-1)), pagedown: () => (this._poolGo ? this._poolGo(1) : this.go(1)),
      home: () => this.jump(0), end: () => this.jump(this.list.length - 1),
      i: () => this.togglePanel(), f: () => this.fullscreen(), z: () => this.cycleZoom(), r: () => this.rotate(),
      b: () => (quickPin([this.post]), setTimeout(() => this._paintToggles(), 60)), p: () => this.toggleSlideshow(), t: () => this.toggleFilm(),
      o: () => this.openSite(), c: () => this.copyLink(), v: () => this.toggleFav(), u: () => this.upvote(),
      '0': () => this.resetView(), '+': () => this.zoomAt(1.25, 0, 0), '=': () => this.zoomAt(1.25, 0, 0), '-': () => this.zoomAt(0.8, 0, 0),
      '?': () => this.help(), s: () => this.download(),
      m: () => pl?.toggleMute(), l: () => pl?.toggleLoop(),
      ',': () => pl?.step(-1), '.': () => pl?.step(1), '[': () => pl?.speedBy(-1), ']': () => pl?.speedBy(1),
      ' ': () => (pl ? pl.toggle() : this.toggleSlideshow()),
    };
    const fn = map[e.key === ' ' ? ' ' : k.length === 1 || k.startsWith('arrow') || k.startsWith('page') || k === 'home' || k === 'end' ? k : ''];
    if (fn) {
      stop();
      fn();
      this._wake();
    }
  }

  /* ============================================================ context menu */
  _menuFor(e) {
    const t = e.target;
    const row = t.closest('.trow');
    if (row) return this.hooks.tagMenu?.(row.dataset.tag, row.dataset.cat, this.post.provider);
    const fs = t.closest('.fs');
    if (fs) return this.hooks.postMenu?.(this.list[+fs.dataset.i], { viewer: this });
    if (t.closest('.vw-panel')) {
      return [{ label: 'Copy all tags', icon: 'copy', run: () => (copyText(Object.values(this.post.tags).flat().join(' ')), toast('All tags copied', { ms: 1200 })) },
        { label: 'Copy artist tags', icon: 'copy', disabled: !this.post.artists.length, run: () => copyText(this.post.artists.join(' ')) }];
    }
    const p = this.post;
    const pl = this.isVideo ? this.player : null;
    const phone = isPhone();
    const media = [
      phone && { label: 'Info & tags', icon: 'info', run: () => this.openSheet() },
      phone && { label: S('filmPhone') ? 'Hide filmstrip' : 'Show filmstrip', icon: 'film', run: () => this.toggleFilm() },
      phone && { sep: true },
      pl && { label: pl.v.paused ? 'Play' : 'Pause', icon: pl.v.paused ? 'play' : 'pause', kbd: 'Space', run: () => pl.toggle() },
      pl && { label: 'Loop', icon: 'loop', checked: pl.loop, kbd: 'L', run: () => pl.toggleLoop() },
      pl && { label: 'Speed', icon: 'speed', sub: [0.25, 0.5, 1, 1.5, 2].map((x) => ({ label: x + '×', checked: pl.v.playbackRate === x, run: () => pl.setSpeed(x) })) },
      pl && { label: pl.v.muted ? 'Unmute' : 'Mute', icon: pl.v.muted ? 'sound' : 'mute', kbd: 'M', run: () => pl.toggleMute() },
      pl && { sep: true },
      p.kind !== 'flash' && { label: this.mode === 'fit' ? 'Zoom to 100%' : 'Fit to window', icon: 'zoomIn', kbd: 'Z', run: () => this.cycleZoom() },
      !pl && p.kind !== 'flash' && { label: 'Rotate', icon: 'rotate', kbd: 'R', run: () => this.rotate() },
      { label: isFullscreen() ? 'Exit fullscreen' : 'Fullscreen', icon: 'fullscreen', kbd: 'F', run: () => this.fullscreen() },
      { label: this.playing ? 'Stop slideshow' : 'Start slideshow', icon: this.playing ? 'pause' : 'play', kbd: 'P', run: () => this.toggleSlideshow() },
      { label: 'Previous', icon: 'left', kbd: '←', disabled: this.i === 0, run: () => this.go(-1) },
      { label: 'Next', icon: 'right', kbd: '→', run: () => this.go(1) },
      { sep: true },
    ];
    return [...media, ...(this.hooks.postMenu?.(p, { viewer: this }) || [])];
  }

  /* ============================================================ side panel */
  _renderPanel() {
    const p = this.post;
    if (!p) return;
    const prov = getProvider(p.provider);
    const tabs = [['tags', 'Tags', p.tags && Object.values(p.tags).flat().length], ['info', 'Info'], ['pins', 'Boards']];
    const head = h('div', { class: 'pn-tabs' }, tabs.map(([id, label, n]) =>
      h('button', { class: 'pn-tab' + (this.tab === id ? ' on' : ''), onclick: () => { this.tab = id; this._renderPanel(); } }, label, n ? h('sup', {}, n) : null)));
    const score = h('div', { class: 'pn-score' },
      stamp(p.rating),
      h('span', { class: 'sc', title: `${p.up} up / ${p.down} down` }, h('i', { html: icon('up', 13) }), fmtNum(p.score)),
      h('span', { class: 'sc fv' + (p.faved ? ' on' : ''), title: 'Favorites' }, h('i', { html: icon('heart', 13) }), fmtNum(p.favs)),
      h('span', { class: 'sc dim' }, `${p.w}×${p.h}`),
      h('span', { class: 'sc dim' }, p.ext.toUpperCase()),
    );
    let body;
    if (this.tab === 'tags') body = this._tagsTab(p, prov);
    else if (this.tab === 'info') body = this._infoTab(p, prov);
    else body = pinContent([p], { after: () => (this._paintToggles(), this.hooks.onPinChange?.()) });
    const also = p.also?.length ? h('div', { class: 'also-row' }, h('small', {}, 'Same picture on'),
      p.also.map((a) => h('button', { class: 'chipbtn', title: `${a.w}×${a.h}`, onclick: () => this.hooks.onLink?.(a.url) }, a.name, h('i', { html: icon('external', 11) })))) : null;
    this.panel.replaceChildren(h('div', { class: 'pn-grab' }, h('i')), head, score, also, h('div', { class: 'pn-body' }, body));
  }

  _tagsTab(p, prov) {
    const wrap = h('div', { class: 'tags' });
    for (const cat of CATS) {
      const list = p.tags[cat];
      if (!list?.length) continue;
      const artist = cat === 'artist';
      wrap.append(h('div', { class: `tg-group cat-${cat}` },
        h('h4', {}, CAT_LABEL[cat], h('sup', {}, list.length)),
        list.map((t) => {
          const info = tagc.get(prov.id, t);
          const on = artist ? this.hooks.isFollowing?.(t, p.provider) : this.hooks.isStarred?.(t, p.provider);
          return h('div', { class: 'trow', 'data-tag': t, 'data-cat': cat },
            h('button', { class: 'tname', title: 'Search only this tag', onclick: () => this.hooks.onTag(t, 'only') }, pretty(t)),
            info?.count ? h('span', { class: 'tcount' }, fmtNum(info.count)) : null,
            h('span', { class: 'tbtns' },
              h('button', {
                title: artist ? (on ? 'Unfollow artist' : 'Follow artist') : on ? 'Unstar' : 'Star — pin to your quick list', class: on ? 'starred' : '',
                onclick: () => ((artist ? this.hooks.onFollow : this.hooks.onStar)?.(t, p.provider), this._renderPanel()), html: icon(artist ? (on ? 'bellOn' : 'bell') : 'star', 12),
              }),
              h('button', { title: 'Add to search', onclick: () => this.hooks.onTag(t, 'add'), html: icon('plus', 12) }),
              h('button', { title: 'Exclude from search', onclick: () => this.hooks.onTag(t, 'exclude'), html: icon('minus', 12) }),
              h('button', { title: 'Copy tag', onclick: () => (copyText(t), toast('Copied', { ms: 900 })), html: icon('copy', 12) })),
          );
        }),
      ));
    }
    const a0 = p.artists[0];
    const fol = a0 && this.hooks.isFollowing?.(a0, p.provider);
    wrap.append(h('div', { class: 'tg-foot' },
      h('button', { class: 'btn', onclick: () => (copyText(Object.values(p.tags).flat().join(' ')), toast('All tags copied', { ms: 1200 })) }, 'Copy all tags'),
      h('button', { class: 'btn', onclick: () => this.hooks.onTag(a0, 'only'), disabled: !a0 }, 'More from artist'),
      a0 ? h('button', { class: 'btn' + (fol ? ' primary' : ''), onclick: () => (this.hooks.onFollow?.(a0, p.provider), this._renderPanel()), html: icon(fol ? 'bellOn' : 'bell', 15) + `<span>${fol ? 'Following' : 'Follow'}</span>` }) : null));
    return wrap;
  }

  _infoTab(p, prov) {
    const row = (k, v) => v == null || v === '' ? null : h('div', { class: 'ir' }, h('span', {}, k), h('b', {}, v));
    const openSrc = (s) => fetch('/open?u=' + encodeURIComponent(s), { method: 'POST' });
    const src = p.sources.length ? h('div', { class: 'srcs' }, p.sources.slice(0, 8).map((s) =>
      /^https?:/.test(s)
        ? h('a', { href: '#', title: s, onclick: (e) => (e.preventDefault(), openSrc(s)), oncontextmenu: (e) => (e.preventDefault(), e.stopPropagation(), showMenu(e.clientX, e.clientY, [{ label: 'Open in browser', icon: 'external', run: () => openSrc(s) }, { label: 'Copy link', icon: 'copy', run: () => copyText(s) }])) }, host(s), h('i', { html: icon('external', 11) }))
        : h('span', {}, s))) : null;
    const poolBox = h('div', { class: 'rels' });
    for (const id of p.pools || []) {
      const b = h('button', { class: 'chipbtn', onclick: () => this.hooks.enterPool?.(id, p.id) }, 'pool #' + id);
      poolBox.append(b);
      this.hooks.poolInfo?.(prov, id).then((pl) => pl && (b.textContent = `${pl.name} · ${pl.count}`)).catch(() => {});
    }
    return h('div', { class: 'info' },
      row('Post', `#${p.id}`), row('Site', prov.name),
      row('Posted', p.created ? `${fmtDate(p.created)} · ${ago(p.created)}` : ''),
      row('Dimensions', `${p.w} × ${p.h}  (${(p.w / p.h).toFixed(2)})`),
      row('File', `${p.ext.toUpperCase()} · ${fmtBytes(p.size)}`),
      row('Score', `${p.score}  (+${p.up} / ${p.down})`),
      row('Favorites', fmtNum(p.favs)), row('Comments', p.comments || ''),
      p.duration ? row('Duration', Math.round(p.duration) + 's') : null,
      src ? h('div', { class: 'ir col' }, h('span', {}, 'Sources'), src) : null,
      (p.parent || p.children?.length || p.hasChildren) ? h('div', { class: 'ir col' }, h('span', {}, 'Relations'), h('div', { class: 'rels' },
        p.parent ? h('button', { class: 'chipbtn', onclick: () => this.hooks.onTag('parent:' + p.parent, 'only') }, '↰ parent #' + p.parent) : null,
        (p.children?.length || p.hasChildren) ? h('button', { class: 'chipbtn', onclick: () => this.hooks.onTag('parent:' + p.id, 'only') }, `⧉ children${p.children?.length ? ' (' + p.children.length + ')' : ''}`) : null)) : null,
      p.pools?.length ? h('div', { class: 'ir col' }, h('span', {}, 'Pools'), poolBox) : null,
      p.desc ? h('div', { class: 'ir col' }, h('span', {}, 'Description'), h('p', { class: 'desc' }, p.desc.replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, '').trim().slice(0, 900))) : null,
    );
  }

  /* ============================================================ filmstrip */
  _renderFilm() {
    if (!this.open_ && this.root.hidden) return;
    const a = Math.max(0, this.i - 30), b = Math.min(this.list.length, this.i + 40);
    const frag = [];
    for (let k = a; k < b; k++) {
      const p = this.list[k];
      frag.push(h('button', { class: 'fs' + (k === this.i ? ' cur' : ''), 'data-i': k, onclick: () => this.jump(k) }, h('img', { src: p.thumb, alt: '', loading: 'lazy', draggable: 'false', class: isBlurred(p) && !this._unblur.has(postKey(p)) ? 'blurred' : '' }), this.poolCtx ? h('i', { class: 'fs-n' }, k + 1) : null));
    }
    this.film.replaceChildren(...frag);
    this.film.querySelector('.cur')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
}
