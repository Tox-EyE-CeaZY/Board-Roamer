import { h, $ } from './util.js';
import { icon } from './icons.js';
import { on } from './store.js';
import { isPhone } from './platform.js';

/* ---------------------------------------------------------------- toasts */
export function toast(msg, opts = {}) {
  const host = $('#toasts');
  const t = h('div', { class: 'toast ' + (opts.kind || '') }, h('span', { class: 'toast-msg' }, msg));
  if (opts.action) {
    t.append(h('button', { class: 'toast-act', onclick: () => (opts.action.run(), kill()) }, opts.action.label));
  }
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  const kill = () => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
  };
  setTimeout(kill, opts.ms || 3200);
  return kill;
}
on('toast', (e) => toast(e.detail.msg, e.detail));

/* ---------------------------------------------------------------- popover */
let openPop = null;
export function closePopover() {
  if (!openPop) return;
  const p = openPop;
  openPop = null;
  document.removeEventListener('pointerdown', p.away, true);
  document.removeEventListener('keydown', p.key, true);
  if (p.root) {
    p.root.classList.remove('in');
    setTimeout(() => p.root.remove(), 230);
  } else p.el.remove();
  p.onClose?.();
}

/** Drag a bottom sheet down by its handle to dismiss it (fast flicks count too). */
export function dragToDismiss(sheet, handle, onClose) {
  let st = null;
  handle.style.touchAction = 'none';
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture?.(e.pointerId);
    st = { y: e.clientY, t: performance.now(), dy: 0, v: 0 };
    sheet.style.transition = 'none';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!st) return;
    const dy = Math.max(0, e.clientY - st.y), now = performance.now();
    st.v = (dy - st.dy) / Math.max(1, now - st.t);
    st.dy = dy;
    st.t = now;
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!st) return;
    const { dy, v } = st;
    st = null;
    sheet.style.transition = '';
    if (dy > 90 || v > 0.7) onClose();
    else sheet.style.transform = '';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function phoneSheet(content, { cls = '', onClose } = {}) {
  const root = h('div', { class: 'sheet-back', onpointerdown: (e) => e.target === root && closePopover() });
  const grab = h('div', { class: 'sheet-grab' }, h('i'));
  const el = h('div', { class: 'pop sheet ' + cls }, grab, h('div', { class: 'sheet-body' }, content));
  root.append(el);
  document.body.append(root);
  requestAnimationFrame(() => { root.classList.add('in'); el.classList.add('in'); });
  const key = (e) => {
    if (e.key === 'Escape') (e.stopPropagation(), closePopover());
  };
  document.addEventListener('keydown', key, true);
  dragToDismiss(el, grab, () => closePopover());
  el.reposition = () => {};
  openPop = { el, root, key, away: () => {}, onClose };
  return el;
}

/** Show `content` anchored to `anchor` (a bottom sheet on phones). align: 'left'|'right'; dir: 'down'|'up' */
export function popover(anchor, content, { align = 'left', dir = 'down', cls = '', onClose } = {}) {
  closePopover();
  if (isPhone()) return phoneSheet(content, { cls, onClose });
  const el = h('div', { class: 'pop ' + cls }, content);
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, hh = el.offsetHeight;
    let x = align === 'right' ? r.right - w : r.left;
    x = Math.max(8, Math.min(innerWidth - w - 8, x));
    let y = dir === 'up' ? r.top - hh - 8 : r.bottom + 8;
    if (y + hh > innerHeight - 8) y = Math.max(8, r.top - hh - 8);
    if (y < 8) y = 8;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  };
  place();
  requestAnimationFrame(() => (el.classList.add('in'), place()));
  const away = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const key = (e) => {
    if (e.key === 'Escape') (e.stopPropagation(), closePopover());
  };
  document.addEventListener('pointerdown', away, true);
  document.addEventListener('keydown', key, true);
  openPop = { el, away, key, onClose };
  el.reposition = place;
  return el;
}

/* ---------------------------------------------------------------- dialogs */
export function dialog({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    const close = (v) => {
      back.classList.remove('in');
      setTimeout(() => back.remove(), 220);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') (e.stopPropagation(), close(null));
    };
    const box = h('div', { class: 'dlg cut' + (wide ? ' wide' : '') },
      h('div', { class: 'dlg-title' }, title),
      h('div', { class: 'dlg-body' }, body),
      h('div', { class: 'dlg-actions' }, actions.map((a) => h('button', { class: 'btn ' + (a.cls || ''), onclick: () => close(a.value) }, a.label))),
    );
    const back = h('div', { class: 'dlg-back', onpointerdown: (e) => e.target === back && close(null) }, box);
    document.body.append(back);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => back.classList.add('in'));
    setTimeout(() => box.querySelector('input,textarea')?.focus(), 60);
  });
}

export async function promptText(title, value = '', placeholder = '') {
  const input = h('input', { class: 'input', value, placeholder, spellcheck: 'false' });
  const form = h('form', { onsubmit: (e) => e.preventDefault() }, input);
  const p = dialog({ title, body: form, actions: [{ label: 'Cancel', value: null }, { label: 'Confirm', value: true, cls: 'primary' }] });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && document.querySelector('.dlg .btn.primary')?.click());
  const ok = await p;
  return ok ? input.value.trim() : null;
}

export async function confirmDlg(title, text, label = 'Delete') {
  return (await dialog({ title, body: h('p', { class: 'dlg-text' }, text), actions: [{ label: 'Cancel', value: false }, { label, value: true, cls: 'primary danger' }] })) === true;
}

/* ---------------------------------------------------------------- bits */
export const iconBtn = (name, label, onclick, cls = '') =>
  h('button', { class: 'ibtn ' + cls, title: label, 'aria-label': label, onclick, html: icon(name, 18) });

export const stamp = (r) => h('span', { class: 'stamp r-' + r, title: { s: 'Safe', q: 'Questionable', e: 'Explicit' }[r] }, r.toUpperCase());

export function segmented(options, value, onChange, cls = '') {
  const el = h('div', { class: 'seg ' + cls });
  const paint = (v) => [...el.children].forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
  for (const [v, label] of options) {
    el.append(h('button', { type: 'button', 'data-v': v, class: 'seg-b', onclick: () => (paint(v), onChange(v)) }, label));
  }
  paint(value);
  return el;
}
