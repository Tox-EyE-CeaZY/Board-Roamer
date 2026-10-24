import { h, clamp, fmtNum, fmtDur, pretty } from './util.js';
import { icon } from './icons.js';
import { S, postKey, boards } from './store.js';
import { blacklistHit, compileBlacklist, isBlurred } from './providers.js';
import { showMenu } from './ctxmenu.js';
import { isPhone, isLandscape } from './platform.js';
import { postMenu } from './menus.js';

/**
 * Virtualized gallery. Layout is computed up-front from the known width/height of each post
 * (so nothing jumps when images load) and only tiles near the viewport exist in the DOM.
 */
export class Gallery {
  constructor(scroller, hooks) {
    this.scroller = scroller;
    this.hooks = hooks; // onOpen(viewIndex, tileEl) onNeedMore() onPin(posts, anchor) onSelect(n)
    this.canvas = h('div', { class: 'gal-canvas' });
    this.foot = h('div', { class: 'gal-foot' });
    scroller.append(this.canvas, this.foot);
    this.items = [];
    this.rects = [];
    this.live = new Map();
    this.sel = new Set();
    this.selectMode = false;
    this.hiddenCount = 0;
    this.rules = [];
    this.W = 0;
    this._lastSel = -1;
    this._raf = 0;
    scroller.addEventListener('scroll', () => this._schedule(), { passive: true });
    new ResizeObserver(() => this._onResize()).observe(scroller);
    this.canvas.addEventListener('click', (e) => this._click(e));
    this.numbered = false; // show page numbers (pools)
    this.isNew = null; // (post) => bool — NEW marker for posts you haven't seen from followed artists
    this.canvas.addEventListener('contextmenu', (e) => this._context(e));
    this.canvas.addEventListener('auxclick', (e) => {
      const t = e.target.closest('.tile');
      if (t && e.button === 1) {
        e.preventDefault();
        this.hooks.onOpenSite?.(this.items[+t.dataset.i].post);
      }
    });
    this.setBlacklist();
  }

  setBlacklist() {
    this.rules = S('blacklistMode') === 'off' ? [] : compileBlacklist(S('blacklist'));
  }

  get length() {
    return this.items.length;
  }

  /** Height of whatever sits above the tiles inside the same scroller (Local's folders). 0 everywhere else. */
  _off() {
    return Math.max(0, this.canvas.offsetTop - 4);
  }

  clear() {
    this.items = [];
    this.rects = [];
    this.focusI = null;
    this.hiddenCount = 0;
    this.sel.clear();
    this._reset();
    this.scroller.scrollTop = 0;
    this.hooks.onSelect?.(0);
  }

  setItems(posts) {
    this.clear();
    this.append(posts);
  }

  append(posts) {
    const mode = S('blacklistMode');
    for (const p of posts) {
      const hit = blacklistHit(p, this.rules);
      if (hit && mode === 'hide') {
        this.hiddenCount++;
        continue;
      }
      this.items.push({ post: p, hit, revealed: false });
    }
    this._layout(this._startFor());
    this.render();
  }

  /** Posts reachable from the viewer (veiled posts are skipped until revealed). */
  viewList() {
    return this.items.filter((it) => !it.hit || it.revealed).map((it) => it.post);
  }
  viewIndexOf(i) {
    const it = this.items[i];
    return this.items.slice(0, i).filter((x) => !x.hit || x.revealed).length;
  }
  itemIndexOfView(v) {
    let n = -1;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.hit || it.revealed) n++;
      if (n === v) return i;
    }
    return -1;
  }

  /* ----------------------------------------------------------- layout */
  _cfg() {
    const phone = isPhone();
    const gap = phone ? 6 : S('gap'), mode = S('layout');
    const W = this.canvas.clientWidth || this.scroller.clientWidth - (phone ? 16 : 40);
    let target = S('density');
    let n = Math.max(1, Math.round((W + gap) / (target + gap)));
    if (phone) {
      // phones pick a column count instead of a pixel size: predictable, and tiles stay thumb-sized
      n = clamp(S('mobileCols') + (isLandscape() ? 1 : 0), 1, 6);
      target = (W - gap * (n - 1)) / n;
    }
    return { gap, mode, W, target, n };
  }

  _reset() {
    this.cfg = this._cfg();
    this.W = this.cfg.W;
    this.colH = new Array(this.cfg.n).fill(0);
    this.rowStart = 0;
    this.rects.length = 0;
    this.live.forEach((el) => el.remove());
    this.live.clear();
    this.canvas.style.height = '0px';
  }

  _startFor() {
    return this.cfg?.mode === 'rows' ? this.rowStart : this.rects.length;
  }

  _layout(from = 0) {
    if (!this.cfg || from === 0 && this.rects.length === 0) this._reset();
    const { mode, gap, W, n, target } = this.cfg;
    const items = this.items;
    if (mode === 'rows') {
      this.rects.length = from;
      const T = target * 0.78;
      let i = from;
      while (i < items.length) {
        let sum = 0, j = i;
        while (j < items.length) {
          sum += this._ar(items[j].post);
          j++;
          if (sum * T + gap * (j - i - 1) >= W) break;
        }
        const k = j - i, full = sum * T + gap * (k - 1) >= W;
        const rowH = full ? (W - gap * (k - 1)) / sum : T;
        const y = this._rowBottom(i);
        let x = 0;
        for (let q = i; q < j; q++) {
          const w = this._ar(items[q].post) * rowH;
          this.rects[q] = { x, y, w, h: rowH };
          x += w + gap;
        }
        if (full) this.rowStart = j;
        i = j;
      }
      const last = this.rects[this.rects.length - 1];
      this.height = last ? last.y + last.h : 0;
    } else {
      const colW = (W - gap * (n - 1)) / n;
      for (let i = from; i < items.length; i++) {
        const p = items[i].post;
        const asp = mode === 'grid' ? 1 : clamp(p.h / p.w || 1, 0.38, 2.6);
        let c = 0;
        for (let k = 1; k < n; k++) if (this.colH[k] < this.colH[c] - 0.5) c = k;
        const hgt = colW * asp;
        this.rects[i] = { x: c * (colW + gap), y: this.colH[c], w: colW, h: hgt };
        this.colH[c] += hgt + gap;
      }
      this.height = Math.max(0, ...this.colH) - gap;
    }
    this.canvas.style.height = Math.max(0, this.height) + 'px';
  }

  _rowBottom(i) {
    if (i === 0) return 0;
    const prev = this.rects[i - 1];
    // Rows are contiguous: bottom of the row containing i-1
    return prev.y + prev.h + this.cfg.gap;
  }

  _ar(p) {
    return clamp((p.w || 1) / (p.h || 1), 0.45, 3.4);
  }

  relayout() {
    const anchor = this.height ? Math.max(0, this.scroller.scrollTop - this._off()) / this.height : 0;
    this._reset();
    this._layout(0);
    this.scroller.scrollTop = anchor * this.height + this._off();
    this.render();
  }

  _onResize() {
    const w = this.canvas.clientWidth;
    if (!w || Math.abs(w - this.W) < 2) return this._schedule();
    cancelAnimationFrame(this._rz);
    this._rz = requestAnimationFrame(() => this.relayout());
  }

  /* ----------------------------------------------------------- render */
  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
      this._maybeMore();
    });
  }

  _maybeMore() {
    const s = this.scroller;
    if (s.scrollTop + s.clientHeight > (this.height || 0) - s.clientHeight * 1.6) this.hooks.onNeedMore?.();
  }

  render() {
    const s = this.scroller, off = this._off(), top = Math.max(0, s.scrollTop - off), bot = s.scrollTop + s.clientHeight - off, buf = 700;
    const need = new Set();
    for (let i = 0; i < this.rects.length; i++) {
      const r = this.rects[i];
      if (r && r.y + r.h >= top - buf && r.y <= bot + buf) need.add(i);
    }
    for (const [i, el] of this.live) {
      if (!need.has(i)) (el.remove(), this.live.delete(i));
    }
    for (const i of need) if (!this.live.has(i)) this._mount(i);
    this._maybeMore();
  }

  /** Mount the visible tiles again (after something that changes how they look, like unblurring a whole comic). */
  repaint() {
    this.live.forEach((el) => el.remove());
    this.live.clear();
    this.render();
  }

  refreshMarks() {
    for (const [i, el] of this.live) {
      const it = this.items[i];
      el.classList.toggle('pinned', boards.inAny(postKey(it.post)));
    }
  }

  _src(post, r) {
    if (S('thumbQ') === 'fast' || post.kind === 'video') return post.thumb;
    const px = r.w * (devicePixelRatio || 1);
    return post.sample && px > 260 ? post.sample : post.thumb;
  }

  _mount(i) {
    const it = this.items[i], p = it.post, r = this.rects[i];
    const key = postKey(p);
    const el = h('div', { class: 'tile', 'data-i': i, style: `transform:translate(${r.x}px,${r.y}px);width:${r.w}px;height:${r.h}px` });
    el.classList.toggle('sel', this.sel.has(key));
    el.classList.toggle('pinned', boards.inAny(key));
    const clip = h('div', { class: 'tile-clip' });
    if (it.hit && !it.revealed) {
      el.classList.add('veiled');
      clip.append(h('div', { class: 'veil' }, h('i', { html: icon('cloak', 22) }), h('b', {}, 'Veiled'), h('small', {}, pretty(it.hit).slice(0, 40))));
    } else {
      const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
      img.onload = () => el.classList.add('ready');
      let tries = 0;
      img.onerror = () => {
        // sample -> preview -> preview through the local proxy (sends the site's own Referer)
        if (tries === 0 && p.thumb && img.src !== p.thumb) (tries = 1), (img.src = p.thumb);
        else if (tries < 2) (tries = 2), (img.src = '/img?u=' + encodeURIComponent(p.thumb));
        else el.classList.add('broken');
      };
      img.src = this._src(p, r);
      clip.append(img);
      if (isBlurred(p)) el.classList.add('blurred');
      el.append(
        h('span', { class: 'stamp r-' + p.rating }, p.rating.toUpperCase()),
      );
      const badges = [];
      if (el.classList.contains('blurred')) badges.push(h('span', { class: 'badge blurtag', title: 'Blurred by a #blur rule', html: icon('cloak', 11) + 'BLUR' }));
      if (p.kind === 'video') badges.push(h('span', { class: 'badge', html: icon('play', 11) + (p.duration ? fmtDur(p.duration) : p.ext.toUpperCase()) }));
      else if (p.kind === 'anim') badges.push(h('span', { class: 'badge' }, 'GIF'));
      else if (p.kind === 'flash') badges.push(h('span', { class: 'badge' }, 'SWF'));
      if (p.pools?.length) badges.push(h('span', { class: 'badge pool' + (p.isComic ? ' comic' : ''), title: p.isComic ? 'Comic page' : 'In a pool', html: icon(p.isComic ? 'book' : 'pool', 11) + (p.isComic ? 'COMIC' : 'POOL') }));
      else if (p.isComic) badges.push(h('span', { class: 'badge pool comic', title: 'Comic page', html: icon('book', 11) + 'COMIC' }));
      if (p.also?.length) badges.push(h('span', { class: 'badge also', title: 'Same picture on ' + [p.provider, ...p.also.map((a) => a.provider)].join(', '), html: icon('link', 11) + (p.also.length + 1) }));
      if (this.isNew?.(p)) { el.classList.add('fresh'); badges.push(h('span', { class: 'badge fresh', html: icon('sparkle', 11) + 'NEW' })); }
      if (p.children?.length || p.hasChildren) badges.push(h('span', { class: 'badge', title: 'Has child posts' }, '⧉'));
      if (p.parent) badges.push(h('span', { class: 'badge', title: 'Has a parent post' }, '↰'));
      el.append(
        h('div', { class: 'badges' }, badges),
        this.numbered ? h('span', { class: 'pgn' }, i + 1) : null,
        h('i', { class: 'pinmark', html: icon('pin', 13) }),
        h('i', { class: 'selbox', html: icon('check', 14) }),
        h('div', { class: 'tile-meta' },
          h('span', { class: 'm-art' }, p.artists[0] ? pretty(p.artists[0]) : '#' + p.id),
          h('span', { class: 'm-n' }, h('span', { html: icon('up', 10) }), fmtNum(p.score), p.favs ? h('span', { html: icon('heart', 10) }) : null, p.favs ? fmtNum(p.favs) : null),
        ),
        h('div', { class: 'tile-act' },
          h('button', { class: 'ta', 'data-a': 'pin', title: 'Pin — right-click for other boards', html: icon('pin', 15) }),
          h('button', { class: 'ta', 'data-a': 'site', title: 'Open on site', html: icon('external', 15) }),
        ),
      );
    }
    el.prepend(clip);
    this.canvas.append(el);
    this.live.set(i, el);
  }

  /* ----------------------------------------------------------- interaction */
  _click(e) {
    const t = e.target.closest('.tile');
    if (!t) return;
    const i = +t.dataset.i, it = this.items[i];
    const act = e.target.closest('[data-a]')?.dataset.a;
    if (act === 'pin') return this.hooks.onPin?.([it.post], e.target.closest('.ta'));
    if (act === 'site') return this.hooks.onOpenSite?.(it.post);
    if (it.hit && !it.revealed) {
      it.revealed = true;
      this.live.get(i)?.remove();
      this.live.delete(i);
      this._mount(i);
      return;
    }
    if (this.selectMode || e.ctrlKey || e.metaKey) {
      if (!this.selectMode) this.setSelectMode(true);
      return this._toggleSel(i, e.shiftKey);
    }
    this.hooks.onOpen?.(this.viewIndexOf(i), t);
  }

  _context(e) {
    const t = e.target.closest('.tile');
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const i = +t.dataset.i, it = this.items[i];
    if (it.hit && !it.revealed) {
      return showMenu(e.clientX, e.clientY, [{ label: 'Reveal this post', icon: 'eye', run: () => t.click() }, { label: 'Open on site', icon: 'external', run: () => this.hooks.onOpenSite?.(it.post) }]);
    }
    showMenu(e.clientX, e.clientY, [
      ...postMenu(it.post, { gallery: this, open: () => this.hooks.onOpen?.(this.viewIndexOf(i), t) }),
      ...(this.hooks.contextExtra?.(it.post, this) || []),
      { sep: true },
      { label: this.selectMode ? 'Toggle selection' : 'Select', icon: 'select', kbd: 'S', run: () => { if (!this.selectMode) this.setSelectMode(true); this._toggleSel(i, false); } },
    ]);
  }

  setSelectMode(on) {
    this.selectMode = on;
    this.scroller.classList.toggle('selecting', on);
    if (!on) this.clearSel();
  }

  _toggleSel(i, range) {
    const keys = [];
    if (range && this._lastSel >= 0) {
      const [a, b] = [this._lastSel, i].sort((x, y) => x - y);
      for (let k = a; k <= b; k++) keys.push(postKey(this.items[k].post));
      keys.forEach((k) => this.sel.add(k));
    } else {
      const k = postKey(this.items[i].post);
      this.sel.has(k) ? this.sel.delete(k) : this.sel.add(k);
    }
    this._lastSel = i;
    this._paintSel();
  }

  selectAll() {
    this.items.forEach((it) => this.sel.add(postKey(it.post)));
    this._paintSel();
  }
  clearSel() {
    this.sel.clear();
    this._paintSel();
  }
  _paintSel() {
    for (const [i, el] of this.live) el.classList.toggle('sel', this.sel.has(postKey(this.items[i].post)));
    this.hooks.onSelect?.(this.sel.size);
  }
  selected() {
    return this.items.map((it) => it.post).filter((p) => this.sel.has(postKey(p)));
  }

  /* ----------------------------------------------------------- keyboard focus */
  moveFocus(dx, dy) {
    if (!this.items.length) return;
    if (this.focusI == null || !this.rects[this.focusI]) {
      // start from the first tile that is visible
      const top = Math.max(0, this.scroller.scrollTop - this._off());
      this.focusI = Math.max(0, this.rects.findIndex((r) => r.y + r.h > top + 10));
      return this._paintFocus();
    }
    const c = this.rects[this.focusI];
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < this.rects.length; i++) {
      if (i === this.focusI) continue;
      const r = this.rects[i];
      const ox = r.x + r.w / 2 - cx, oy = r.y + r.h / 2 - cy;
      const along = dx ? ox * dx : oy * dy, across = dx ? Math.abs(oy) : Math.abs(ox);
      if (along <= 4) continue;
      const score = along + across * 2.2;
      if (score < bestScore) (bestScore = score), (best = i);
    }
    if (best >= 0) this.focusI = best;
    else if (dy > 0) this.hooks.onNeedMore?.();
    this._paintFocus();
  }

  _paintFocus() {
    this.live.forEach((el) => el.classList.remove('kf'));
    this.scrollTo(this.focusI, false);
    const r = this.rects[this.focusI], s = this.scroller;
    const off = this._off();
    if (r.y + off < s.scrollTop + 8) s.scrollTop = Math.max(0, r.y + off - 24);
    else if (r.y + off + r.h > s.scrollTop + s.clientHeight - 8) s.scrollTop = r.y + off + r.h - s.clientHeight + 90;
    this.render();
    this.live.get(this.focusI)?.classList.add('kf');
  }

  openFocused() {
    if (this.focusI == null) return false;
    const el = this.live.get(this.focusI);
    const it = this.items[this.focusI];
    if (!it) return false;
    if (this.selectMode) return (this._toggleSel(this.focusI, false), true);
    if (it.hit && !it.revealed) return (el?.click(), true);
    this.hooks.onOpen?.(this.viewIndexOf(this.focusI), el);
    return true;
  }

  /* ----------------------------------------------------------- helpers for viewer */
  tileRect(itemIndex) {
    const r = this.rects[itemIndex];
    if (!r) return null;
    const c = this.canvas.getBoundingClientRect();
    return { left: c.left + r.x, top: c.top + r.y, width: r.w, height: r.h };
  }

  scrollTo(itemIndex, center = true) {
    const r = this.rects[itemIndex];
    if (!r) return;
    const s = this.scroller;
    const off = this._off();
    const y = off + (center ? r.y - (s.clientHeight - r.h) / 2 : r.y);
    const inView = r.y + off > s.scrollTop && r.y + off + r.h < s.scrollTop + s.clientHeight;
    if (!inView) s.scrollTop = Math.max(0, y);
    this.render();
  }

  setFoot(node) {
    this.foot.replaceChildren(...(node ? [].concat(node) : []));
  }
}
