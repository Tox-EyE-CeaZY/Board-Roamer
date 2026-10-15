import { h } from './util.js';
import { icon } from './icons.js';
import { isPhone, haptic } from './platform.js';
import { dragToDismiss } from './ui.js';

/**
 * Themed context menu.
 * items: [{label, icon, kbd, run, danger, disabled, checked, sub:[...]}, {sep:true}, {header:'Text'}, falsy → skipped]
 */
let stack = []; // open menu elements, root first
let cleanup = null;

export function closeMenu() {
  stack.forEach((m) => m.remove());
  stack = [];
  cleanup?.();
  cleanup = null;
}
export const menuOpen = () => stack.length > 0;

function clean(items) {
  const out = [];
  for (const it of items.flat()) {
    if (!it) continue;
    if (it.sep && (!out.length || out[out.length - 1].sep)) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
}

function build(items, level, anchorRow) {
  const el = h('div', { class: 'ctxm', role: 'menu', tabindex: '-1' });
  const rows = [];
  for (const it of clean(items)) {
    if (it.sep) {
      el.append(h('div', { class: 'cm-sep' }));
      continue;
    }
    if (it.header) {
      el.append(h('div', { class: 'cm-head' }, it.header));
      continue;
    }
    const row = h('button', {
      class: 'cm-i' + (it.danger ? ' danger' : '') + (it.disabled ? ' off' : '') + (it.checked ? ' chk' : ''),
      role: 'menuitem', type: 'button',
    },
    h('i', { class: 'cm-ic', html: it.checked ? icon('check', 15) : it.icon ? icon(it.icon, 15) : '' }),
    h('span', { class: 'cm-t' }, it.label),
    it.kbd ? h('kbd', { class: 'cm-k' }, it.kbd) : null,
    it.sub ? h('i', { class: 'cm-arrow', html: icon('right', 12) }) : null);
    row._it = it;
    row.addEventListener('mouseenter', () => {
      if (it.disabled) return;
      focusRow(el, row);
      closeAbove(level);
      if (it.sub) openSub(row, it, level);
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      if (it.sub) return openSub(row, it, level, true);
      closeMenu();
      it.run?.(e);
    });
    el.append(row);
    rows.push(row);
  }
  el._rows = rows;
  return el;
}

function focusRow(el, row) {
  el.querySelectorAll('.cm-i.hi').forEach((r) => r.classList.remove('hi'));
  row?.classList.add('hi');
  el._cur = row;
}

function closeAbove(level) {
  while (stack.length > level + 1) stack.pop().remove();
}

function place(el, x, y, anchorRect) {
  document.body.append(el);
  const w = el.offsetWidth, hh = el.offsetHeight;
  let px = x, py = y;
  if (anchorRect) {
    px = anchorRect.right - 4;
    py = anchorRect.top - 5;
    if (px + w > innerWidth - 6) px = anchorRect.left - w + 4;
  } else if (px + w > innerWidth - 6) px = Math.max(6, x - w);
  if (py + hh > innerHeight - 6) py = Math.max(6, anchorRect ? innerHeight - hh - 6 : y - hh);
  px = Math.max(6, px);
  py = Math.max(6, py);
  el.style.left = px + 'px';
  el.style.top = py + 'px';
}

function openSub(row, it, level, focusFirst) {
  closeAbove(level);
  const sub = build(it.sub, level + 1, row);
  place(sub, 0, 0, row.getBoundingClientRect());
  requestAnimationFrame(() => sub.classList.add('in'));
  stack.push(sub);
  if (focusFirst) focusRow(sub, sub._rows.find((r) => !r._it.disabled));
}

function showSheetMenu(list) {
  const root = h('div', { class: 'sheet-back ctx-sheet', onpointerdown: (e) => e.target === root && closeMenu() });
  const sheet = h('div', { class: 'ctxm sheet', role: 'menu' });
  const grab = h('div', { class: 'sheet-grab' }, h('i'));
  const head = h('div', { class: 'cm-sheet-head' });
  const body = h('div', { class: 'cm-sheet-body' });
  sheet.append(grab, head, body);
  root.append(sheet);
  document.body.append(root);
  const path = [];
  const top = () => path[path.length - 1];
  const back = () => {
    path.pop();
    render(top()?.items || list, top()?.title || null);
  };
  function render(its, title) {
    let rows = clean(its), t = title;
    if (!t && rows[0]?.header) (t = rows[0].header), (rows = rows.slice(1));
    head.hidden = !t && !path.length;
    head.replaceChildren(...(path.length ? [h('button', { class: 'cm-back', 'aria-label': 'Back', onclick: back, html: icon('left', 20) })] : []), ...(t ? [h('b', {}, t)] : []));
    body.replaceChildren(...rows.map((it) => {
      if (it.sep) return h('div', { class: 'cm-sep' });
      if (it.header) return h('div', { class: 'cm-head' }, it.header);
      return h('button', {
        class: 'cm-i' + (it.danger ? ' danger' : '') + (it.disabled ? ' off' : '') + (it.checked ? ' chk' : ''), role: 'menuitem', type: 'button',
        onclick: (e) => {
          if (it.disabled) return;
          if (it.sub) return path.push({ items: it.sub, title: it.label }), render(it.sub, it.label);
          closeMenu();
          it.run?.(e);
        },
      }, h('i', { class: 'cm-ic', html: it.checked ? icon('check', 18) : it.icon ? icon(it.icon, 18) : '' }), h('span', { class: 'cm-t' }, it.label),
      it.sub ? h('i', { class: 'cm-arrow', html: icon('right', 16) }) : null);
    }));
    body.scrollTop = 0;
  }
  render(list);
  requestAnimationFrame(() => { root.classList.add('in'); sheet.classList.add('in'); });
  const key = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    path.length ? back() : closeMenu();
  };
  document.addEventListener('keydown', key, true);
  stack = [root];
  cleanup = () => document.removeEventListener('keydown', key, true);
  dragToDismiss(sheet, grab, () => closeMenu());
}

export function showMenu(x, y, items) {
  closeMenu();
  const list = clean(items);
  if (!list.length) return;
  if (isPhone()) return showSheetMenu(list);
  const el = build(list, 0);
  place(el, x, y);
  requestAnimationFrame(() => el.classList.add('in'));
  stack = [el];
  el.focus({ preventScroll: true });

  const onDown = (e) => {
    if (!stack.some((m) => m.contains(e.target))) closeMenu();
  };
  const onKey = (e) => {
    const top = stack[stack.length - 1];
    const rows = top._rows.filter((r) => !r._it.disabled);
    const i = rows.indexOf(top._cur);
    const stop = () => (e.preventDefault(), e.stopPropagation());
    if (e.key === 'Escape') { stop(); stack.length > 1 ? stack.pop().remove() : closeMenu(); }
    else if (e.key === 'ArrowDown') { stop(); focusRow(top, rows[(i + 1) % rows.length]); }
    else if (e.key === 'ArrowUp') { stop(); focusRow(top, rows[(i - 1 + rows.length) % rows.length]); }
    else if (e.key === 'ArrowRight' && top._cur?._it.sub) { stop(); top._cur.click(); }
    else if (e.key === 'ArrowLeft' && stack.length > 1) { stop(); stack.pop().remove(); }
    else if (e.key === 'Enter' || e.key === ' ') { stop(); top._cur?.click(); }
    else if (e.key === 'Tab') stop();
  };
  const onBlur = () => closeMenu();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  addEventListener('blur', onBlur);
  addEventListener('resize', onBlur);
  document.addEventListener('wheel', onBlur, { passive: true, capture: true });
  cleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('blur', onBlur);
    removeEventListener('resize', onBlur);
    document.removeEventListener('wheel', onBlur, true);
  };
}

/** Attach a context menu: builder(event) → items (or empty to fall through to the default). */
export function bindContext(el, builder) {
  el.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input,textarea,[contenteditable="true"]')) return;
    const items = builder(e);
    if (!items || !clean(items).length) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, items);
  });
}


/* ------------------------------------------------------------------ long-press = right-click on touch screens */
let lpAt = -1e9;
let suppressClickUntil = 0;
/** When the last long-press fired (other gesture code ignores the tap that ends it). */
export const lastLongPress = () => lpAt;
const LP_MS = 480, LP_SLOP = 10;
let lpTimer = 0, lpStart = null;
const lpCancel = () => { clearTimeout(lpTimer); lpStart = null; };

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || !e.isPrimary) return lpCancel();
  if (e.target.closest?.('input,textarea,select,[contenteditable="true"],.pc-seek,.rd-slider,.sheet,.ctxm,.rz')) return lpCancel();
  lpStart = { x: e.clientX, y: e.clientY, target: e.target };
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    if (!lpStart) return;
    const { x, y, target } = lpStart;
    lpStart = null;
    lpAt = performance.now();
    suppressClickUntil = lpAt + 900;
    haptic('heavy');
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 2 }));
  }, LP_MS);
}, true);
document.addEventListener('pointermove', (e) => {
  if (lpStart && Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > LP_SLOP) lpCancel();
}, true);
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, lpCancel, true));
document.addEventListener('scroll', lpCancel, true);
// the tap that ends a long-press must not also "click" whatever is underneath
document.addEventListener('click', (e) => {
  if (e.isTrusted && performance.now() < suppressClickUntil) (e.preventDefault(), e.stopPropagation());
}, true);
// the browser may also raise its own contextmenu after our long-press: swallow that duplicate
document.addEventListener('contextmenu', (e) => {
  if (e.isTrusted && performance.now() - lpAt < 1500) (e.preventDefault(), e.stopImmediatePropagation());
}, true);
