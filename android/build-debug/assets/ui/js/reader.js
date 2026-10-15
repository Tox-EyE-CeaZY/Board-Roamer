import { h, clamp, debounce, copyText } from './util.js';
import { icon } from './icons.js';
import { S, setS, reading } from './store.js';
import { toast } from './ui.js';
import { showMenu, bindContext, menuOpen, lastLongPress } from './ctxmenu.js';
import { isFullscreen, setFullscreen, toggleFullscreen } from './titlebar.js';
import { postMenu } from './menus.js';
import { isPhone, isTouch, isAndroid, native } from './platform.js';

const WIDE = 1.15; // a page wider than this ratio is already a spread: show it alone

/**
 * Comic reader. Pages come from a pool (posts in order). Three layouts:
 *   single  – one page at a time
 *   double  – two-page spreads (optionally cover alone, wide pages alone)
 *   scroll  – continuous vertical strip (webtoon style)
 * Reading direction can be flipped for manga. Progress is remembered per pool.
 */
export class ComicReader {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks; // onClose() onPage(i) savePost(p) openInViewer(post, i)
    this.pages = [];
    this.i = 0;
    this.zoom = 1;
    this.open_ = false;
    this.ptrs = new Map();
    this._lastTouch = -1e9;
    this._build();
    this._onKey = (e) => this._key(e);
  }

  get isOpen() { return this.open_; }
  get mode() { return S('readerMode'); }
  get rtl() { return S('readerRtl'); }

  /* ============================================================ structure */
  _build() {
    const b = (name, tip, fn, cls = '') => h('button', { class: 'rbtn ' + cls, title: tip, 'aria-label': tip, onclick: fn, html: icon(name, 19) });
    this.title = h('div', { class: 'rd-title' });
    this.label = h('div', { class: 'rd-label' });
    this.mBtns = {
      single: b('page', 'One page (1)', () => this.setMode('single'), 'r-desk'),
      double: b('spread', 'Two pages (2)', () => this.setMode('double'), 'r-desk'),
      scroll: b('scroll', 'Continuous scroll (3)', () => this.setMode('scroll'), 'r-desk'),
    };
    this.modeBtn = b('page', 'Change layout', () => { const o = ['single', 'double', 'scroll']; this.setMode(o[(o.indexOf(this.mode) + 1) % o.length]); }, 'r-phone');
    this.rtlBtn = b('swap', 'Reading direction (R)', () => this.setRtl(!this.rtl), 'r-desk');
    this.thumbBtn = b('film', 'Thumbnails (T)', () => this.toggleThumbs(), 'r-desk');
    this.fsBtn = b('fullscreen', 'Fullscreen (F)', () => this.fullscreen());
    this.top = h('div', { class: 'rd-top' },
      b('close', 'Close (Esc)', () => this.close()), this.title, h('div', { class: 'vw-spacer' }), this.label,
      h('span', { class: 'vw-sep' }),
      this.mBtns.single, this.mBtns.double, this.mBtns.scroll, this.modeBtn, this.rtlBtn,
      b('zoomIn', 'Fit mode (W)', (e) => this._fitMenu(e.currentTarget), 'r-desk'),
      this.thumbBtn, this.fsBtn,
      b('more', 'More', (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.right - 200, r.bottom, this._menu()); }));
    this.stage = h('div', { class: 'rd-stage' });
    this.endCard = h('div', { class: 'rd-end', hidden: true });
    this.slider = h('input', { class: 'rd-slider', type: 'range', min: 1, max: 1, value: 1, 'aria-label': 'Page', oninput: (e) => this.goto(+e.target.value - 1, true) });
    this.jump = h('input', { class: 'rd-jump', type: 'number', min: 1, placeholder: '#', title: 'Go to page (G)', onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') { this.goto(+e.target.value - 1); e.target.blur(); } else if (e.key === 'Escape') e.target.blur(); } });
    this.label2 = h('span', { class: 'rd-label2' });
    this.bottom = h('div', { class: 'rd-bottom' },
      b('left', 'Previous page', () => this.step(this.rtl ? 1 : -1), 'r-desk'),
      this.label2, this.slider, this.jump,
      b('right', 'Next page', () => this.step(this.rtl ? -1 : 1), 'r-desk'));
    this.film = h('div', { class: 'rd-film' });
    this.pageNo = h('div', { class: 'rd-pageno' });
    this.root.append(this.stage, this.top, this.bottom, this.film, this.pageNo, this.endCard);
    this.root.hidden = true;

    // input
    this.stage.addEventListener('pointerdown', (e) => this._pdown(e));
    this.stage.addEventListener('pointermove', (e) => this._pmove(e));
    this.stage.addEventListener('pointerup', (e) => this._pup(e));
    this.stage.addEventListener('pointercancel', (e) => this._pcancel(e));
    this.stage.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    this.root.addEventListener('pointermove', () => this._wake());
    bindContext(this.root, () => this._menu());
  }

  /* ============================================================ open / close */
  open({ pool, posts, index = 0, key, prov, kind }) {
    this.pool = pool;
    this.pages = posts;
    this.key = key;
    this.prov = prov;
    this.kind = kind;
    this.open_ = true;
    this.zoom = 1;
    this.root.hidden = false;
    this.root.classList.toggle('no-film', !S('readerThumbs'));
    this.title.replaceChildren(h('b', {}, pool.name), h('span', {}, `${posts.length} pages`));
    this.slider.max = posts.length;
    this.jump.max = posts.length;
    this.endCard.hidden = true;
    document.addEventListener('keydown', this._onKey, true);
    native.keepAwake(S('keepAwake'));
    requestAnimationFrame(() => this.root.classList.add('in'));
    this.i = clamp(index, 0, posts.length - 1);
    this._rebuildSpreads();
    this.render(0);
    this._wake();
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    this._saveProgress.flush();
    document.removeEventListener('keydown', this._onKey, true);
    if (isFullscreen()) setFullscreen(false);
    native.keepAwake(false);
    this._cancelFling();
    this.root.classList.remove('in', 'rd-idle');
    clearTimeout(this._idleT);
    this._io?.disconnect();
    setTimeout(() => {
      if (!this.open_) {
        this.root.hidden = true;
        this.stage.replaceChildren();
      }
    }, 240);
    this.hooks.onClose?.();
  }

  /* ============================================================ layout model */
  _rebuildSpreads() {
    const pg = this.pages, n = pg.length;
    const wide = (p) => (p.w || 1) / (p.h || 1) > WIDE;
    if (this.mode !== 'double') {
      this.spreads = pg.map((_, i) => [i]);
      return;
    }
    const sp = [];
    let i = 0;
    if (S('readerCover') && n) (sp.push([0]), (i = 1));
    while (i < n) {
      if (wide(pg[i]) || i === n - 1 || wide(pg[i + 1])) (sp.push([i]), i++);
      else (sp.push([i, i + 1]), (i += 2));
    }
    this.spreads = sp;
  }

  _spreadOf(page) {
    const k = this.spreads.findIndex((s) => s.includes(page));
    return k < 0 ? 0 : k;
  }

  /* ============================================================ rendering */
  render(dir = 0) {
    this.root.dataset.mode = this.mode;
    this.root.classList.toggle('rtl', this.rtl);
    for (const [m, btn] of Object.entries(this.mBtns)) btn.classList.toggle('on', this.mode === m);
    this.rtlBtn.classList.toggle('on', this.rtl);
    this.modeBtn.innerHTML = icon({ single: 'page', double: 'spread', scroll: 'scroll' }[this.mode], 19);
    this.rtlBtn.title = this.rtl ? 'Right-to-left (manga) — click for left-to-right' : 'Left-to-right — click for right-to-left (manga)';
    this.thumbBtn.classList.toggle('on', !!S('readerThumbs'));
    this.fsBtn.classList.toggle('on', isFullscreen());
    this.slider.style.direction = this.rtl ? 'rtl' : 'ltr';
    this.endCard.hidden = true;
    this._io?.disconnect();
    this._ioLoad?.disconnect();
    if (this.mode === 'scroll') this._renderScroll();
    else this._renderSpread(dir);
    this._paintChrome();
    this._renderFilm();
    this._preload();
  }

  _img(post, eager = true) {
    const img = h('img', { class: 'rd-img', alt: '', draggable: 'false' });
    img.style.aspectRatio = `${post.w || 3} / ${post.h || 4}`;
    const first = post.sample || post.full;
    img.src = first;
    if (S('fullOriginal') && post.full !== first) {
      const big = new Image();
      big.onload = () => img.isConnected && (img.src = post.full);
      big.src = post.full;
    }
    img.onerror = () => { if (!img._tried) { img._tried = true; img.src = '/img?u=' + encodeURIComponent(post.full); } };
    img.addEventListener('load', () => img.classList.add('ready'));
    return img;
  }

  _renderSpread(dir) {
    const idx = this.spreads[this._spreadOf(this.i)];
    this.i = idx[0];
    const order = this.rtl ? [...idx].reverse() : idx;
    const spread = h('div', { class: 'rd-spread', style: `--n:${idx.length}` }, order.map((k) => {
      const img = this._img(this.pages[k]);
      img.dataset.page = k;
      return img;
    }));
    this.stage.className = `rd-stage fit-${S('readerFit')}` + (this.zoom > 1 ? ' zoomed' : '');
    this.stage.style.setProperty('--z', this.zoom);
    const old = this.stage.firstChild;
    this.stage.replaceChildren(spread);
    this.stage.scrollTop = 0;
    this.stage.scrollLeft = 0;
    const sign = (dir || 0) * (this.rtl ? -1 : 1);
    if (dir) spread.animate([{ opacity: 0, transform: `translateX(${sign * (isTouch() ? 56 : 28)}px)` }, { opacity: 1, transform: 'none' }], { duration: 230, easing: 'cubic-bezier(.2,.8,.2,1)' });
    else spread.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
    void old;
  }

  _renderScroll() {
    const col = h('div', { class: 'rd-col' });
    const wrap = this.pages.map((p, k) => {
      const box = h('div', { class: 'rd-pg', 'data-page': k, style: `aspect-ratio:${p.w || 3} / ${p.h || 4}` });
      col.append(box);
      return box;
    });
    this.stage.className = 'rd-stage scroll';
    this.stage.replaceChildren(col);
    const loadBox = (box) => {
      if (box.firstChild) return;
      const img = this._img(this.pages[+box.dataset.page]);
      img.style.aspectRatio = '';
      box.append(img);
    };
    this._ioLoad = new IntersectionObserver((es) => es.forEach((en) => en.isIntersecting && loadBox(en.target)), { root: this.stage, rootMargin: '1800px 0px' });
    wrap.forEach((b) => this._ioLoad.observe(b));
    // which page is in the middle of the screen?
    this._io = new IntersectionObserver((es) => {
      for (const en of es) if (en.isIntersecting) { this._scrollPage = +en.target.dataset.page; }
      if (this._scrollPage != null && this._scrollPage !== this.i) {
        this.i = this._scrollPage;
        this._paintChrome();
        this._renderFilm(true);
        this._saveProgress();
      }
    }, { root: this.stage, rootMargin: '-48% 0px -48% 0px', threshold: 0 });
    wrap.forEach((b) => this._io.observe(b));
    wrap[this.i] && requestAnimationFrame(() => (this.stage.scrollTop = wrap[this.i].offsetTop - 8));
  }

  _paintChrome() {
    const n = this.pages.length;
    const idx = this.mode === 'scroll' ? [this.i] : this.spreads[this._spreadOf(this.i)];
    const txt = idx.length > 1 ? `${idx[0] + 1}–${idx[1] + 1}` : `${idx[0] + 1}`;
    this.label.textContent = `Page ${txt} / ${n}`;
    this.label2.textContent = `${txt} / ${n}`;
    this.pageNo.textContent = `${txt} / ${n}`;
    this.slider.value = idx[0] + 1;
    this.slider.style.setProperty('--f', ((idx[0] + 1) / n) * 100 + '%');
    this.jump.value = '';
    this.jump.placeholder = String(idx[0] + 1);
    this.hooks.onPage?.(this.i);
    this._saveProgress();
  }

  _saveProgress = debounce(() => {
    if (!this.key) return;
    reading.set(this.key, { i: this.i, total: this.pages.length, name: this.pool.name, cover: this.pages[0]?.thumb, pool: this.pool.id, prov: this.prov.id, kind: this.kind });
  }, 400);

  _preload() {
    if (this.mode === 'scroll') return;
    const cur = this._spreadOf(this.i);
    for (const k of [cur + 1, cur + 2, cur - 1]) {
      for (const pi of this.spreads[k] || []) {
        const p = this.pages[pi];
        const im = new Image();
        im.src = S('fullOriginal') ? p.full : p.sample || p.full;
      }
    }
  }

  _renderFilm(soft) {
    if (!S('readerThumbs')) return;
    const a = Math.max(0, this.i - 40), z = Math.min(this.pages.length, this.i + 60);
    if (soft && this.film.firstChild && +this.film.firstChild.dataset.i <= this.i - 5 && +this.film.lastChild.dataset.i >= this.i + 5) {
      this.film.querySelectorAll('.cur').forEach((e) => e.classList.remove('cur'));
      const c = this.film.querySelector(`[data-i="${this.i}"]`);
      c?.classList.add('cur');
      return c?.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
    const cur = this.mode === 'scroll' ? [this.i] : this.spreads[this._spreadOf(this.i)];
    const frag = [];
    for (let k = a; k < z; k++) {
      frag.push(h('button', { class: 'fs' + (cur.includes(k) ? ' cur' : ''), 'data-i': k, onclick: () => this.goto(k) }, h('img', { src: this.pages[k].thumb, alt: '', loading: 'lazy', draggable: 'false' }), h('i', { class: 'fs-n' }, k + 1)));
    }
    this.film.replaceChildren(...frag);
    this.film.querySelector('.cur')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  /* ============================================================ navigation */
  goto(page, fromSlider) {
    if (!(page >= 0)) return;
    page = clamp(Math.round(page), 0, this.pages.length - 1);
    if (this.mode === 'scroll') {
      const box = this.stage.querySelector(`.rd-pg[data-page="${page}"]`);
      if (box) this.stage.scrollTo({ top: box.offsetTop - 8, behavior: fromSlider ? 'auto' : 'smooth' });
      this.i = page;
      this._paintChrome();
      return;
    }
    const dir = page > this.i ? 1 : page < this.i ? -1 : 0;
    this.i = page;
    this.zoom = 1;
    this.render(fromSlider ? 0 : dir);
  }

  /** dir = +1 → next in reading order, −1 → previous (already direction-corrected by callers). */
  step(dir) {
    if (this.mode === 'scroll') {
      this.stage.scrollBy({ top: dir * this.stage.clientHeight * 0.85, behavior: 'smooth' });
      return;
    }
    const k = this._spreadOf(this.i) + dir;
    if (k < 0) return toast('This is the first page', { ms: 1000 });
    if (k >= this.spreads.length) return this._showEnd();
    this.zoom = 1;
    this.i = this.spreads[k][0];
    this.render(dir);
  }

  _showEnd() {
    reading.set(this.key, { i: this.pages.length - 1, total: this.pages.length, name: this.pool.name, cover: this.pages[0]?.thumb, pool: this.pool.id, prov: this.prov.id, kind: this.kind });
    this.endCard.replaceChildren(
      h('div', { class: 'rde cut' },
        h('i', { class: 'es-art', html: icon('book', 44) }),
        h('h2', {}, 'End of the pool'),
        h('p', {}, `${this.pool.name} · ${this.pages.length} pages`),
        h('div', { class: 'row-btns center' },
          h('button', { class: 'btn', onclick: () => ((this.endCard.hidden = true), this.goto(0)) }, 'Back to start'),
          h('button', { class: 'btn', onclick: () => this.hooks.openInViewer?.(this.pages[this.pages.length - 1], this.pages.length - 1) }, 'Open in viewer'),
          h('button', { class: 'btn primary', onclick: () => this.close() }, 'Close reader'))));
    this.endCard.hidden = false;
  }

  /* ============================================================ settings */
  setMode(m) {
    if (S('readerMode') === m) return;
    setS('readerMode', m);
    this._rebuildSpreads();
    this.zoom = 1;
    this.render(0);
    toast({ single: 'One page at a time', double: 'Two-page spreads', scroll: 'Continuous scroll' }[m], { ms: 1100 });
  }

  setRtl(on) {
    setS('readerRtl', on);
    this.render(0);
    toast(on ? 'Right-to-left (manga)' : 'Left-to-right', { ms: 1100 });
  }

  setFit(f) {
    setS('readerFit', f);
    this.zoom = 1;
    this.render(0);
  }

  setCover(on) {
    setS('readerCover', on);
    this._rebuildSpreads();
    this.render(0);
  }

  toggleThumbs() {
    setS('readerThumbs', !S('readerThumbs'));
    this.root.classList.toggle('no-film', !S('readerThumbs'));
    this._renderFilm();
    this._paintChrome();
    this.thumbBtn.classList.toggle('on', !!S('readerThumbs'));
  }

  fullscreen() {
    toggleFullscreen();
    setTimeout(() => this.fsBtn.classList.toggle('on', isFullscreen()), 150);
  }

  _fitMenu(btn) {
    const r = btn.getBoundingClientRect();
    showMenu(r.left, r.bottom, [{ header: 'Fit' }, ...[['page', 'Whole page'], ['width', 'Fit width'], ['height', 'Fit height'], ['orig', 'Original size']].map(([k, l]) => ({ label: l, checked: S('readerFit') === k, run: () => this.setFit(k) }))]);
  }

  _menu() {
    const pg = this.pages[this.i];
    return [
      { label: 'Next page', icon: 'right', kbd: this.rtl ? '←' : '→', run: () => this.step(1) },
      { label: 'Previous page', icon: 'left', kbd: this.rtl ? '→' : '←', run: () => this.step(-1) },
      { label: 'Go to page…', icon: 'list', kbd: 'G', run: () => (this.jump.focus(), this.jump.select()) },
      { sep: true },
      { label: 'Layout', icon: 'spread', sub: [['single', 'One page', '1'], ['double', 'Two pages', '2'], ['scroll', 'Continuous scroll', '3']].map(([k, l, kb]) => ({ label: l, kbd: kb, checked: this.mode === k, run: () => this.setMode(k) })) },
      { label: 'Fit', icon: 'zoomIn', sub: [['page', 'Whole page'], ['width', 'Fit width'], ['height', 'Fit height'], ['orig', 'Original size']].map(([k, l]) => ({ label: l, checked: S('readerFit') === k, run: () => this.setFit(k) })) },
      { label: 'Right-to-left (manga)', icon: 'swap', kbd: 'R', checked: this.rtl, run: () => this.setRtl(!this.rtl) },
      { label: 'First page alone (two-page)', icon: 'page', kbd: 'C', checked: S('readerCover'), run: () => this.setCover(!S('readerCover')) },
      { label: 'Thumbnails', icon: 'film', kbd: 'T', checked: !!S('readerThumbs'), run: () => this.toggleThumbs() },
      { label: isFullscreen() ? 'Exit fullscreen' : 'Fullscreen', icon: 'fullscreen', kbd: 'F', run: () => this.fullscreen() },
      { sep: true },
      ...(pg ? [{ header: `Page ${this.i + 1}` }, ...postMenu(pg, { open: () => this.hooks.openInViewer?.(pg, this.i) })] : []),
      { sep: true },
      { label: 'Close reader', icon: 'close', kbd: 'Esc', run: () => this.close() },
    ];
  }

  /* ============================================================ chrome + input */
  _wake() {
    this.root.classList.remove('rd-idle');
    clearTimeout(this._idleT);
    this._idleT = setTimeout(() => {
      if (menuOpen() || this.root.querySelector('.rd-top:hover,.rd-bottom:hover,.rd-film:hover') || document.activeElement === this.jump) return this._wake();
      this.root.classList.add('rd-idle');
    }, 2600);
  }

  /* ---- pointer input: mouse drag-pan, and the full set of touch gestures ---- */
  _cancelFling() {
    cancelAnimationFrame(this._flingRaf);
    this._flingRaf = 0;
  }

  _canPan() {
    return this.mode !== 'scroll' && (this.zoom > 1.01 || S('readerFit') !== 'page');
  }

  _pdist() {
    const [a, b] = [...this.ptrs.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _pdown(e) {
    this._cancelFling();
    this.stage.setPointerCapture?.(e.pointerId);
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now();
    this._drag = { x: e.clientX, y: e.clientY, sl: this.stage.scrollLeft, st: this.stage.scrollTop, moved: false, touch: e.pointerType === 'touch', axis: null, lx: e.clientX, ly: e.clientY, lt: now, vx: 0, vy: 0 };
    if (this.ptrs.size === 2 && this.mode !== 'scroll') {
      this._pinch = { d: this._pdist(), z: this.zoom };
      this._drag.axis = 'pinch';
      this._resetSlide();
    }
  }

  _pmove(e) {
    if (!this.ptrs.has(e.pointerId)) return;
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pinch && this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()];
      this.setZoomAt(this._pinch.z * (this._pdist() / this._pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const d = this._drag;
    if (!d || d.axis === 'pinch') return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y, now = performance.now();
    if (Math.abs(dx) + Math.abs(dy) > (d.touch ? 8 : 5)) d.moved = true;
    if (now > d.lt) {
      d.vx = 0.6 * d.vx + 0.4 * ((e.clientX - d.lx) / (now - d.lt));
      d.vy = 0.6 * d.vy + 0.4 * ((e.clientY - d.ly) / (now - d.lt));
      d.lx = e.clientX; d.ly = e.clientY; d.lt = now;
    }
    if (this.mode === 'scroll') return; // the browser scrolls the strip itself
    if (d.moved && this._canPan()) {
      this.stage.scrollLeft = d.sl - dx;
      this.stage.scrollTop = d.st - dy;
      this.stage.classList.add('panning');
    } else if (d.touch && d.moved) {
      // un-zoomed page: it follows the finger sideways; letting go far enough (or flicking) turns the page
      d.axis ||= Math.abs(dx) > Math.abs(dy) * 1.1 ? 'x' : 'y';
      const sp = this.stage.firstChild;
      if (d.axis === 'x' && sp) {
        sp.style.transition = 'none';
        sp.style.transform = `translateX(${dx}px)`;
        sp.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / 700));
      }
    }
  }

  _resetSlide() {
    const sp = this.stage.firstChild;
    if (!sp?.style) return;
    sp.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1), opacity .24s';
    sp.style.transform = '';
    sp.style.opacity = '';
    setTimeout(() => sp.style && (sp.style.transition = ''), 280);
  }

  _pcancel(e) {
    this.ptrs.delete(e.pointerId);
    if (!this.ptrs.size) this._pinch = null;
    this._drag = null;
    this.stage.classList.remove('panning');
    this._resetSlide();
  }

  _pup(e) {
    const d = this._drag;
    this.ptrs.delete(e.pointerId);
    this.stage.classList.remove('panning');
    if (d?.touch) this._lastTouch = performance.now();
    if (this._pinch || d?.axis === 'pinch') {
      // the fingers of a pinch never count as taps or swipes
      if (this.ptrs.size < 2) this._pinch = null;
      if (!this.ptrs.size) this._drag = null;
      return;
    }
    this._drag = this.ptrs.size ? d : null;
    if (!d || e.button > 0) return;
    if (performance.now() - lastLongPress() < 900) return this._resetSlide(); // the lift that ends a long-press

    if (d.touch) {
      if (d.axis === 'x') {
        const dx = e.clientX - d.x;
        if (Math.abs(dx) > 64 || Math.abs(d.vx) > 0.5) {
          const forward = (dx || d.vx) < 0; // finger moves left → next page (flipped for manga)
          const dir = forward ? (this.rtl ? -1 : 1) : this.rtl ? 1 : -1;
          this._resetSlide();
          return this.step(dir);
        }
        return this._resetSlide();
      }
      if (d.moved) {
        if (this._canPan() && Math.hypot(d.vx, d.vy) > 0.25) this._fling(d.vx, d.vy);
        return this._resetSlide();
      }
      // a tap: double-tap zooms, a single tap turns the page / toggles the controls after a beat
      const now = performance.now(), prev = this._lastTap;
      if (prev && now - prev.t < 300 && Math.hypot(prev.x - e.clientX, prev.y - e.clientY) < 44 && this.mode !== 'scroll') {
        clearTimeout(this._tapTimer);
        this._lastTap = null;
        return this.setZoomAt(this.zoom > 1.05 ? 1 : 2.4, e.clientX, e.clientY, true);
      }
      this._lastTap = { t: now, x: e.clientX, y: e.clientY };
      const f = (e.clientX - this.stage.getBoundingClientRect().left) / this.stage.getBoundingClientRect().width;
      this._tapTimer = setTimeout(() => { this._lastTap = null; this._tap(f); }, this.mode === 'scroll' ? 0 : 260);
      return;
    }
    if (d.moved) return;
    this._tap((e.clientX - this.stage.getBoundingClientRect().left) / this.stage.getBoundingClientRect().width);
  }

  /** Tap zones: outer thirds turn the page, the middle toggles the controls. */
  _tap(f) {
    if (!this.open_) return;
    if (this.mode === 'scroll') return this.root.classList.toggle('rd-idle');
    if (f < 0.3) this.step(this.rtl ? 1 : -1);
    else if (f > 0.7) this.step(this.rtl ? -1 : 1);
    else this.root.classList.toggle('rd-idle');
  }

  /** Let a zoomed page coast after a flick. */
  _fling(vx, vy) {
    this._cancelFling();
    let last = performance.now();
    const s = this.stage;
    const tick = (now) => {
      const dt = Math.min(40, now - last);
      last = now;
      s.scrollLeft -= vx * dt;
      s.scrollTop -= vy * dt;
      const k = Math.pow(0.0025, dt / 1000);
      vx *= k; vy *= k;
      this._flingRaf = Math.hypot(vx, vy) > 0.03 ? requestAnimationFrame(tick) : 0;
    };
    this._flingRaf = requestAnimationFrame(tick);
  }

  _wheel(e) {
    if (this.mode === 'scroll') {
      if (e.ctrlKey) { e.preventDefault(); }
      return;
    }
    if (e.ctrlKey) {
      e.preventDefault();
      this.setZoomAt(this.zoom * Math.exp(-clamp(e.deltaY, -200, 200) * 0.0015), e.clientX, e.clientY);
      return;
    }
    // plain wheel flips pages when the page isn't scrollable (or is already at its edge)
    const s = this.stage;
    const can = s.scrollHeight > s.clientHeight + 4;
    const atEnd = s.scrollTop + s.clientHeight >= s.scrollHeight - 2, atTop = s.scrollTop <= 0;
    if (can && !((e.deltaY > 0 && atEnd) || (e.deltaY < 0 && atTop))) return;
    e.preventDefault();
    const now = performance.now();
    if (now - (this._wt || 0) < 260) return;
    this._wt = now;
    this.step(e.deltaY > 0 ? 1 : -1);
  }

  /** Zoom keeping the point under (cx, cy) where it is. */
  setZoomAt(z, cx, cy, animate) {
    const s = this.stage, r = s.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const fx = (s.scrollLeft + px) / Math.max(1, s.scrollWidth), fy = (s.scrollTop + py) / Math.max(1, s.scrollHeight);
    if (animate) s.classList.add('zooming');
    this.setZoom(z);
    s.scrollLeft = fx * s.scrollWidth - px;
    s.scrollTop = fy * s.scrollHeight - py;
    if (animate) setTimeout(() => s.classList.remove('zooming'), 260);
  }

  setZoom(z) {
    this.zoom = clamp(z, 1, 5);
    this.stage.classList.toggle('zoomed', this.zoom > 1.01);
    this.stage.style.setProperty('--z', this.zoom);
  }

  _key(e) {
    if (e.target.matches('input,textarea,select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (menuOpen() || document.querySelector('.dlg-back,.help-back')) return;
    const k = e.key.toLowerCase();
    const stop = () => (e.preventDefault(), e.stopPropagation());
    if (!this.endCard.hidden && k !== 'escape' && k !== 'enter') this.endCard.hidden = true;
    const fwd = this.rtl ? -1 : 1;
    const map = {
      escape: () => (isFullscreen() ? (setFullscreen(false), this.fsBtn.classList.remove('on')) : this.close()),
      arrowright: () => this.step(fwd), arrowleft: () => this.step(-fwd),
      d: () => this.step(fwd), a: () => this.step(-fwd),
      ' ': () => this.step(e.shiftKey ? -1 : 1), pagedown: () => this.step(1), pageup: () => this.step(-1),
      arrowdown: () => (this.mode === 'scroll' ? this.stage.scrollBy({ top: 120, behavior: 'smooth' }) : this._vscroll(1)),
      arrowup: () => (this.mode === 'scroll' ? this.stage.scrollBy({ top: -120, behavior: 'smooth' }) : this._vscroll(-1)),
      home: () => this.goto(0), end: () => this.goto(this.pages.length - 1),
      '1': () => this.setMode('single'), '2': () => this.setMode('double'), '3': () => this.setMode('scroll'),
      r: () => this.setRtl(!this.rtl), c: () => this.setCover(!S('readerCover')), t: () => this.toggleThumbs(), f: () => this.fullscreen(),
      w: () => this.setFit({ page: 'width', width: 'height', height: 'orig', orig: 'page' }[S('readerFit')]),
      '+': () => this.setZoom(this.zoom * 1.25), '=': () => this.setZoom(this.zoom * 1.25), '-': () => this.setZoom(this.zoom / 1.25), '0': () => this.setZoom(1),
      g: () => (this.jump.focus(), this.jump.select()),
      v: () => this.hooks.openInViewer?.(this.pages[this.i], this.i),
      o: () => fetch('/open?u=' + encodeURIComponent(this.pages[this.i].url), { method: 'POST' }),
      s: () => this.hooks.savePost?.(this.pages[this.i]),
      enter: () => (this.endCard.hidden = true),
    };
    const fn = map[e.key === ' ' ? ' ' : k.length === 1 || k.startsWith('arrow') || k.startsWith('page') || ['home', 'end', 'escape', 'enter'].includes(k) ? k : ''];
    if (fn) {
      stop();
      fn();
      this._wake();
    }
  }

  _vscroll(d) {
    // arrow up/down scroll a zoomed/tall page, otherwise act like previous/next
    const s = this.stage;
    if (s.scrollHeight > s.clientHeight + 4) s.scrollBy({ top: d * 120, behavior: 'smooth' });
    else this.step(d);
  }
}
