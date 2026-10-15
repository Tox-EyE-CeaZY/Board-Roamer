import { h } from './util.js';
import { isAndroid, native } from './platform.js';
import { icon } from './icons.js';

/**
 * Custom window chrome. The native window is undecorated (src/main.rs); this draws the title bar,
 * wires min / max / close, dragging, edge-resizing and true fullscreen over wry's IPC channel.
 * In a normal browser (--browser mode) everything here is skipped.
 */
export const isNative = () => typeof window.ipc?.postMessage === 'function';
const send = (m) => window.ipc.postMessage(m);
const root = document.documentElement;

let fs = false;
export const windowCommand = (c) => isNative() && send(c);
export const isFullscreen = () => (isNative() || isAndroid() ? fs : !!document.fullscreenElement);

export function setFullscreen(on) {
  if (isAndroid()) {
    fs = !!on;
    root.classList.toggle('fullscreen', fs);
    native.immersive(fs); // hide the status + navigation bars
  } else if (isNative()) {
    fs = !!on;
    root.classList.toggle('fullscreen', fs);
    send(fs ? 'fs:1' : 'fs:0');
  } else if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
export const toggleFullscreen = () => setFullscreen(!isFullscreen());
document.addEventListener('fullscreenchange', () => {
  if (!isNative()) root.classList.toggle('fullscreen', !!document.fullscreenElement);
});

export function initTitlebar() {
  if (!isNative()) return;
  root.classList.add('native');
  const bar = document.getElementById('titlebar');
  bar.hidden = false;
  const maxBtn = h('button', { class: 'tb-btn', title: 'Maximize', onclick: () => send('max'), html: icon('winMax', 14) });
  const label = h('span', { class: 'tb-ctx' });
  bar.append(
    h('div', { class: 'tb-drag', onmousedown: (e) => e.button === 0 && e.detail === 1 && send('drag'), ondblclick: () => send('max') },
      h('svg', { class: 'tb-mark', viewBox: '0 0 40 40', width: 16, height: 16, html: '<rect x="3" y="3" width="34" height="34" fill="none" stroke="currentColor" stroke-width="3"/><path d="M20 8 25 20 20 32 15 20z" fill="var(--accent)"/>' }),
      h('span', { class: 'tb-name' }, 'BOARD', h('i', {}, '/'), 'ROAMER'),
      label),
    h('div', { class: 'tb-btns' },
      h('button', { class: 'tb-btn', title: 'Minimize', onclick: () => send('min'), html: icon('winMin', 14) }),
      maxBtn,
      h('button', { class: 'tb-btn close', title: 'Close', onclick: () => send('close'), html: icon('close', 14) })),
  );

  // invisible edge handles so the undecorated window can still be resized
  for (const d of ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']) {
    document.body.append(h('i', { class: 'rz rz-' + d, onmousedown: (e) => (e.preventDefault(), send('resize:' + d)) }));
  }

  window.__wstate = (s) => {
    root.classList.toggle('maxed', !!s.max);
    fs = !!s.fs;
    root.classList.toggle('fullscreen', fs);
    maxBtn.innerHTML = icon(s.max ? 'winRestore' : 'winMax', 14);
    maxBtn.title = s.max ? 'Restore' : 'Maximize';
  };

  // keep the OS window title (taskbar / alt-tab) in sync with document.title
  const syncTitle = () => send('title:' + document.title);
  new MutationObserver(syncTitle).observe(document.querySelector('title'), { childList: true });
  syncTitle();

  // short context hint in the bar: current view
  const paint = () => {
    const v = document.body.dataset.view || 'roam';
    label.textContent = { roam: 'roam', boards: 'boards', board: 'board', trail: 'trail', follows: 'follows', pools: 'pools', pool: 'pool' }[v] || v;
  };
  new MutationObserver(paint).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  paint();
}
