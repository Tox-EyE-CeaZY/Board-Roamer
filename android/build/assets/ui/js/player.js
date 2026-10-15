import { h, clamp, fmtDur } from './util.js';
import { icon } from './icons.js';
import { S, setS } from './store.js';
import { showMenu } from './ctxmenu.js';
import { native, isTouch } from './platform.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * Custom video controls. Replaces the native control bar so it can live inside the viewer chrome
 * (fades with it, shares its fullscreen) and so looping can be handled without the black flash that
 * Chromium shows at the wrap point of a <video loop>.
 *
 * hooks: onEnded() onFullscreen() slideshow():bool
 */
export class Player {
  constructor(video, post, hooks) {
    this.v = video;
    this.post = post;
    this.hooks = hooks;
    this.loop = S('videoLoop');
    this.dead = false;
    this.seeking = false;
    this.quality = 'original';
    this._build();
    this._wire();
    const tick = () => {
      if (this.dead) return;
      this._tick();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------ DOM */
  _build() {
    const b = (name, tip, fn, cls = '') => h('button', { class: 'pc-b ' + cls, title: tip, 'aria-label': tip, onclick: (e) => (e.stopPropagation(), fn(e)), html: icon(name, 19) });
    this.playBtn = b('play', 'Play / pause (Space)', () => this.toggle());
    this.time = h('span', { class: 'pc-time' }, '0:00 / 0:00');
    this.buf = h('div', { class: 'pc-buf' });
    this.fill = h('i', { class: 'pc-fill' });
    this.knob = h('i', { class: 'pc-knob' });
    this.tip = h('span', { class: 'pc-tip' });
    this.seek = h('div', { class: 'pc-seek', role: 'slider', 'aria-label': 'Seek' }, this.buf, this.fill, this.knob, this.tip);
    this.muteBtn = b('sound', 'Mute (M)', () => this.toggleMute());
    this.vol = h('input', { class: 'pc-vol', type: 'range', min: 0, max: 1, step: 0.02, value: S('volume'), 'aria-label': 'Volume', oninput: (e) => this.setVolume(+e.target.value) });
    this.loopBtn = b('loop', 'Loop (L)', () => this.toggleLoop());
    this.speedBtn = h('button', { class: 'pc-b pc-speed', title: 'Playback speed', onclick: (e) => (e.stopPropagation(), this._speedMenu(e.currentTarget)) }, '1×');
    this.qualBtn = h('button', { class: 'pc-b pc-speed', title: 'Quality', hidden: !(this.post.alts?.length), onclick: (e) => (e.stopPropagation(), this._qualityMenu(e.currentTarget)) }, 'HD');
    this.fsBtn = b('fullscreen', 'Fullscreen (F)', () => this.hooks.onFullscreen?.());
    this.mini = h('div', { class: 'pc-mini' }, h('i'));
    this.spin = h('div', { class: 'pc-spin', hidden: true }, h('i'));
    this.center = h('div', { class: 'pc-center' });
    this.bigPlay = h('button', { class: 'pc-bigplay', 'aria-label': 'Play', onclick: (e) => (e.stopPropagation(), this.toggle()), html: icon('play', 36) });
    this.bar = h('div', { class: 'pc-bar' },
      this.playBtn, this.time, this.seek,
      h('div', { class: 'pc-volwrap' }, this.muteBtn, this.vol),
      this.loopBtn, this.speedBtn, this.qualBtn, this.fsBtn);
    this.el = h('div', { class: 'pc paused' }, this.center, this.bigPlay, this.spin, this.bar, this.mini);
    this._paintVol();
    this.loopBtn.classList.toggle('on', this.loop);
  }

  _wire() {
    const v = this.v;
    v.muted = S('muted');
    v.volume = S('volume');
    v.loop = false; // looping is ours
    v.addEventListener('play', () => { this.playBtn.innerHTML = icon('pause', 19); this.el.classList.remove('paused'); native.keepAwake(S('keepAwake')); });
    v.addEventListener('pause', () => { this.playBtn.innerHTML = icon('play', 19); this.el.classList.add('paused'); native.keepAwake(false); });
    v.addEventListener('playing', () => { v.removeAttribute('poster'); this.spin.hidden = true; });
    v.addEventListener('waiting', () => (this.spin.hidden = false));
    v.addEventListener('seeking', () => (this.spin.hidden = v.readyState >= 3));
    v.addEventListener('canplay', () => (this.spin.hidden = true));
    v.addEventListener('volumechange', () => { this._paintVol(); setS('muted', v.muted); if (!v.muted) setS('volume', v.volume); });
    v.addEventListener('ended', () => this._ended());
    v.addEventListener('progress', () => this._paintBuf());
    v.addEventListener('loadedmetadata', () => this._paintBuf());

    // scrubbing
    const at = (e) => {
      const r = this.seek.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1);
    };
    this.seek.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.seek.setPointerCapture(e.pointerId);
      this.seeking = true;
      this._wasPlaying = !v.paused;
      this._scrub(at(e));
    });
    this.seek.addEventListener('pointermove', (e) => {
      const f = at(e);
      this.tip.style.left = f * 100 + '%';
      this.tip.textContent = fmtDur(f * (v.duration || 0));
      if (this.seeking) this._scrub(f);
    });
    const up = (e) => {
      if (!this.seeking) return;
      this.seeking = false;
      this.seek.releasePointerCapture?.(e.pointerId);
    };
    this.seek.addEventListener('pointerup', up);
    this.seek.addEventListener('pointercancel', up);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /* ------------------------------------------------------------ per-frame */
  _tick() {
    const v = this.v, d = v.duration;
    if (d && isFinite(d)) {
      // Wrap a hair before the end: a manual seek to 0 shows the first frame at once, whereas the
      // browser's own loop/ended path can flash a blank frame while it re-opens the decoder.
      if (this.loop && !this.hooks.slideshow?.() && !v.paused && d > 0.4 && v.currentTime >= d - 0.045) v.currentTime = 0;
      if (!this.seeking || true) {
        const f = clamp(v.currentTime / d, 0, 1);
        this.fill.style.width = f * 100 + '%';
        this.knob.style.left = f * 100 + '%';
        this.mini.firstChild.style.width = f * 100 + '%';
      }
      const t = `${fmtDur(v.currentTime)} / ${fmtDur(d)}`;
      if (t !== this._t) this.time.textContent = this._t = t;
    }
  }

  _ended() {
    const v = this.v;
    if (this.hooks.slideshow?.()) return this.hooks.onEnded?.();
    if (this.loop) {
      v.currentTime = 0;
      v.play().catch(() => {});
    }
  }

  _scrub(f) {
    const v = this.v;
    if (v.duration) v.currentTime = f * v.duration;
  }

  _paintBuf() {
    const v = this.v, d = v.duration;
    if (!d) return;
    this.buf.replaceChildren(...Array.from({ length: v.buffered.length }, (_, i) =>
      h('i', { style: `left:${(v.buffered.start(i) / d) * 100}%;width:${((v.buffered.end(i) - v.buffered.start(i)) / d) * 100}%` })));
  }

  _paintVol() {
    const v = this.v;
    this.muteBtn.innerHTML = icon(v.muted || v.volume === 0 ? 'mute' : 'sound', 19);
    this.vol.value = v.muted ? 0 : v.volume;
    this.vol.style.setProperty('--f', (v.muted ? 0 : v.volume) * 100 + '%');
  }

  /* ------------------------------------------------------------ commands */
  flash(name) {
    this.center.innerHTML = icon(name, 44);
    this.center.classList.remove('go');
    void this.center.offsetWidth;
    this.center.classList.add('go');
  }

  toggle() {
    const v = this.v;
    if (v.paused) (v.play().catch(() => {}), this.flash('play'));
    else (v.pause(), this.flash('pause'));
  }
  seekBy(sec) {
    const v = this.v;
    if (v.duration) v.currentTime = clamp(v.currentTime + sec, 0, v.duration - 0.01);
  }
  step(dir) {
    this.v.pause();
    this.seekBy(dir / 30);
  }
  toggleMute() {
    this.v.muted = !this.v.muted;
  }
  setVolume(x) {
    this.v.volume = x;
    this.v.muted = x === 0;
  }
  volumeBy(d) {
    this.v.muted = false;
    this.setVolume(clamp(this.v.volume + d, 0, 1));
  }
  toggleLoop() {
    this.loop = !this.loop;
    setS('videoLoop', this.loop);
    this.loopBtn.classList.toggle('on', this.loop);
    this.flash('loop');
  }
  setSpeed(x) {
    this.v.playbackRate = x;
    this.speedBtn.textContent = x + '×';
  }
  speedBy(dir) {
    const i = SPEEDS.indexOf(this.v.playbackRate);
    this.setSpeed(SPEEDS[clamp((i < 0 ? 3 : i) + dir, 0, SPEEDS.length - 1)]);
  }

  _speedMenu(btn) {
    const r = btn.getBoundingClientRect();
    showMenu(r.left, r.top, [{ header: 'Speed' }, ...SPEEDS.map((x) => ({ label: x === 1 ? 'Normal' : x + '×', checked: this.v.playbackRate === x, run: () => this.setSpeed(x) }))]);
  }

  _qualityMenu(btn) {
    const r = btn.getBoundingClientRect();
    const opts = [{ label: 'Original', key: 'original', url: this.post.full }, ...this.post.alts.map((a) => ({ label: `${a.label}${a.h ? ` · ${a.h}p` : ''}`, key: a.label, url: a.url }))];
    showMenu(r.left, r.top, [{ header: 'Quality' }, ...opts.map((o) => ({ label: o.label, checked: this.quality === o.key, run: () => this._switch(o) }))]);
  }

  _switch(o) {
    const v = this.v, t = v.currentTime, was = !v.paused;
    this.quality = o.key;
    this.qualBtn.textContent = o.key === 'original' ? 'HD' : o.key.replace(/p$/, '');
    v.src = o.url;
    v.addEventListener('loadedmetadata', () => { v.currentTime = t; if (was) v.play().catch(() => {}); }, { once: true });
  }

  destroy() {
    native.keepAwake(false);
    this.dead = true;
    cancelAnimationFrame(this._raf);
    this.v.pause();
    this.v.removeAttribute('src');
    this.v.load();
    this.el.remove();
  }
}
