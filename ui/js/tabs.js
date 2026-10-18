/**
 * Tabs. Optional, and out of the way until wanted:
 *   Settings > Tabs:  Off | Auto (the bar appears once there is a second tab) | Always
 * Ways to get one: "Open in new tab" in any right-click / long-press menu, middle-click or Ctrl+click on a section or card,
 * Ctrl+T, or the + button. Each tab remembers its own place (search, loaded results, scroll) so switching is instant.
 *
 * This file owns the list of tabs and the controls. The app supplies the parts that touch its own state:
 *   titleFor(hash)   a name for a route
 *   newHash()        where a brand new tab starts
 *   snapshot()       capture the screen that is about to be left -> {scroll, thumb, roam?}
 *   show(tab)        navigate to a tab and restore its snapshot
 */
import { h, uid } from './util.js';
import { icon } from './icons.js';
import { S, on } from './store.js';
import { toast, popover, closePopover } from './ui.js';
import { showMenu } from './ctxmenu.js';

const KEY = 'br1:tabs';
const VIEW_ICON = { roam: 'roam', boards: 'boards', board: 'pin', follows: 'bell', pools: 'book', pool: 'pool', trail: 'trail' };

let tabs = [];
let activeId = null;
let closed = []; // for "reopen closed tab"
let hooks = null;
let strip = null;

/** Phone: the tab-count button for the app bar (the app places it). */
export const tabsButton = h('button', { class: 'tabs-btn', 'aria-label': 'Tabs', hidden: true, onclick: () => openSwitcher() }, h('span', {}, '1'));

/* ------------------------------------------------------------------ state */
const mode = () => S('tabs') || 'auto';
export const tabsEnabled = () => mode() !== 'off';
const shown = () => tabsEnabled() && (mode() === 'always' || tabs.length > 1);
const kindOf = (hash) => String(hash || '').replace(/^#\/?/, '').split(/[/?]/)[0] || 'roam';
const cur = () => tabs.find((t) => t.id === activeId);

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ tabs: tabs.map(({ snap, ...t }) => t), active: activeId })); } catch { /* storage full */ }
}

function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (j && Array.isArray(j.tabs)) {
      tabs = j.tabs.filter((t) => t && t.hash).map((t) => ({ id: t.id || uid(), hash: t.hash, title: t.title || '', thumb: t.thumb || '' }));
      activeId = j.active;
    }
  } catch { /* start with one tab */ }
}

const make = (hash, extra = {}) => ({ id: uid(), hash, title: hooks.titleFor(hash), thumb: '', ...extra });

function ensure() {
  if (!tabs.length) {
    const t = make(location.hash || '#/roam');
    tabs.push(t);
    activeId = t.id;
  }
  if (!tabs.some((t) => t.id === activeId)) activeId = tabs[0].id;
}

/* ------------------------------------------------------------------ what the app calls */
/** At startup: where should the app begin? (the tab that was open last time) */
export function bootHash() {
  load();
  if (!tabsEnabled() || S('restoreTabs') === false) { tabs = []; activeId = null; persist(); return null; }
  return (tabs.find((t) => t.id === activeId) || tabs[0])?.hash || null;
}

/** After every navigation: the active tab always shows wherever you are. */
export function noteRoute({ hash, title, thumb }) {
  ensure();
  const t = cur();
  t.hash = hash;
  if (title) t.title = title;
  if (thumb) t.thumb = thumb;
  persist();
  paint();
}

/** A better name arrived (a pool's name once it has loaded). */
export function setTitle(title) {
  const t = cur();
  if (!t || !title) return;
  t.title = title;
  persist();
  paint();
}

export const tabCount = () => tabs.length;

/** Open a route in a new tab (in the background unless asked otherwise). */
export function open(hash, { background = true, title = '', thumb = '' } = {}) {
  if (!tabsEnabled()) return toast('Tabs are turned off. Turn them on in Settings > Look.', { ms: 3200 });
  ensure();
  const t = make(hash, { ...(title ? { title } : {}), thumb });
  tabs.splice(tabs.findIndex((x) => x.id === activeId) + 1, 0, t);
  persist();
  paint();
  if (!background) return switchTo(t.id);
  toast(`Opened “${t.title || 'a page'}” in a new tab`, { ms: 3000, action: { label: 'Switch', run: () => switchTo(t.id) } });
}

/** Go to the first tab whose route matches, or open one (in the foreground) if there is none. */
export function focus(match, hash, { title = '' } = {}) {
  ensure();
  const t = tabs.find((x) => match(x.hash));
  if (t) return switchTo(t.id);
  open(hash, { background: false, title });
}

export const newTab = () => open(hooks.newHash(), { background: false });

export function switchTo(id) {
  ensure();
  if (id === activeId) return;
  const next = tabs.find((t) => t.id === id);
  if (!next) return;
  const prev = cur();
  if (prev) {
    prev.snap = hooks.snapshot();
    if (prev.snap?.thumb) prev.thumb = prev.snap.thumb;
  }
  activeId = id;
  persist();
  paint();
  hooks.show(next);
}

export function close(id) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [gone] = tabs.splice(i, 1);
  closed = [...closed, { hash: gone.hash, title: gone.title }].slice(-10);
  if (id === activeId) {
    const next = tabs[Math.min(i, tabs.length - 1)];
    activeId = next.id;
    persist();
    paint();
    hooks.show(next);
  } else {
    persist();
    paint();
  }
}

const closeMany = (keep) => {
  const ids = tabs.filter((t) => !keep(t)).map((t) => t.id);
  ids.filter((id) => id !== activeId).forEach(close);
  if (ids.includes(activeId) && tabs.length > 1) close(activeId);
};

export function reopenClosed() {
  const t = closed.pop();
  if (t) open(t.hash, { background: false });
}

const move = (dir) => {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  switchTo(tabs[(i + dir + tabs.length) % tabs.length].id);
};

/* ------------------------------------------------------------------ the bar (computers) */
function tabEl(t) {
  const el = h('div', { class: 'tab-i' + (t.id === activeId ? ' on' : ''), role: 'tab', 'aria-selected': t.id === activeId, 'data-id': t.id, draggable: 'true', title: t.title || 'New tab' },
    h('i', { class: 'ti-ic', html: icon(VIEW_ICON[kindOf(t.hash)] || 'roam', 14) }),
    h('span', { class: 'ti-t' }, t.title || 'New tab'),
    h('button', { class: 'ti-x', 'aria-label': 'Close tab', title: 'Close tab (Ctrl+W)', html: icon('close', 12), onclick: (e) => (e.stopPropagation(), close(t.id)) }));
  el.addEventListener('click', () => switchTo(t.id));
  el.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault()); // no autoscroll on middle-click
  el.addEventListener('auxclick', (e) => e.button === 1 && (e.preventDefault(), close(t.id)));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, tabMenu(t));
  });
  // drag to reorder
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-br-tab', t.id); e.dataTransfer.effectAllowed = 'move'; });
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-br-tab')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    el.classList.toggle('drop-l', e.clientX < r.left + r.width / 2);
    el.classList.toggle('drop-r', e.clientX >= r.left + r.width / 2);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-l', 'drop-r'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/x-br-tab');
    const after = el.classList.contains('drop-r');
    el.classList.remove('drop-l', 'drop-r');
    const from = tabs.findIndex((x) => x.id === id);
    if (from < 0 || id === t.id) return;
    const [m] = tabs.splice(from, 1);
    tabs.splice(tabs.findIndex((x) => x.id === t.id) + (after ? 1 : 0), 0, m);
    persist();
    paint();
  });
  return el;
}

export function tabMenu(t) {
  const i = tabs.findIndex((x) => x.id === t.id);
  return [
    { header: t.title || 'Tab' },
    { label: 'New tab', icon: 'plus', run: () => newTab() },
    { label: 'Duplicate', icon: 'copy', run: () => open(t.hash) },
    { sep: true },
    tabs.length > 1 && { label: 'Close', icon: 'close', run: () => close(t.id) },
    tabs.length > 1 && { label: 'Close other tabs', icon: 'close', run: () => closeMany((x) => x.id === t.id) },
    i < tabs.length - 1 && { label: 'Close tabs to the right', icon: 'close', run: () => closeMany((x) => tabs.indexOf(x) <= i) },
    closed.length > 0 && { sep: true },
    closed.length > 0 && { label: 'Reopen closed tab', icon: 'refresh', run: () => reopenClosed() },
  ];
}

function paint() {
  const on_ = shown();
  document.documentElement.classList.toggle('has-tabs', on_);
  if (strip) {
    strip.hidden = !on_;
    if (on_) {
      strip.replaceChildren(...tabs.map(tabEl), h('button', { class: 'tab-new', 'aria-label': 'New tab', title: 'New tab (Ctrl+T)', html: icon('plus', 15), onclick: () => newTab() }));
      strip.querySelector('.tab-i.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }
  tabsButton.hidden = !on_;
  tabsButton.firstChild.textContent = tabs.length > 99 ? '99+' : tabs.length;
}

/* ------------------------------------------------------------------ the switcher (phones) */
function openSwitcher() {
  const body = h('div', { class: 'tabsheet' });
  const draw = () => {
    const card = (t) => {
      const el = h('div', { class: 'ts-card' + (t.id === activeId ? ' on' : ''), role: 'button', tabindex: 0 },
        t.thumb ? h('img', { src: t.thumb, alt: '', draggable: 'false' }) : h('i', { class: 'ts-ph', html: icon(VIEW_ICON[kindOf(t.hash)] || 'roam', 30) }),
        h('b', {}, t.title || 'New tab'),
        tabs.length > 1 ? h('button', { class: 'ts-x', 'aria-label': 'Close tab', html: icon('close', 15), onclick: (e) => { e.stopPropagation(); close(t.id); draw(); } }) : null);
      el.addEventListener('click', () => { closePopover(); switchTo(t.id); });
      return el;
    };
    body.replaceChildren(
      h('div', { class: 'ts-head' }, h('b', {}, `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`),
        h('button', { class: 'btn primary', html: icon('plus', 15) + '<span>New tab</span>', onclick: () => { closePopover(); newTab(); } })),
      h('div', { class: 'ts-grid' }, tabs.map(card)));
  };
  draw();
  popover(tabsButton, body, { cls: 'tab-pop', align: 'right' });
}

/* ------------------------------------------------------------------ keyboard */
function keys() {
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !tabsEnabled()) return;
    const k = e.key.toLowerCase();
    if (k === 't' && !e.shiftKey) { e.preventDefault(); newTab(); }
    else if (k === 't' && e.shiftKey) { e.preventDefault(); reopenClosed(); }
    else if (k === 'w' && tabs.length > 1) { e.preventDefault(); close(activeId); }
    else if (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') {
      if (tabs.length < 2) return;
      e.preventDefault();
      move(e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1);
    }
  });
}

/* ------------------------------------------------------------------ set up */
export function setupTabs(stripEl, h_) {
  strip = stripEl;
  hooks = h_;
  strip.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  keys();
  on('settings', (e) => {
    if (e.detail.key !== 'tabs') return;
    if (!tabsEnabled() && tabs.length > 1) { // turning tabs off keeps just the one you are on
      tabs = tabs.filter((t) => t.id === activeId);
      persist();
    }
    paint();
  });
  paint();
}
