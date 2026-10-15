// replaceChildren/append/prepend turn null and false into the words "null"/"false". Many views build their
// children conditionally (cond ? node : null), so make the DOM calls ignore empty values everywhere.
for (const m of ['replaceChildren', 'append', 'prepend']) {
  const native = Element.prototype[m];
  Element.prototype[m] = function (...nodes) {
    return native.apply(this, nodes.filter((n) => n != null && n !== false));
  };
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Tiny hyperscript: h('div', {class:'x', onclick:fn, style:{...}}, child, [children], 'text') */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') typeof v === 'string' ? (el.style.cssText = v) : Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const pretty = (t) => String(t).replace(/_/g, ' ');

export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}

export function fmtNum(n) {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function fmtBytes(b) {
  if (!b) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < 3) (b /= 1024), i++;
  return b.toFixed(i ? 1 : 0) + ' ' + u[i];
}

export function fmtDur(s) {
  s = Math.round(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function ago(ts) {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (isNaN(d)) return '';
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 86400 * 30) return Math.floor(d / 86400) + 'd ago';
  if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + 'mo ago';
  return (d / 86400 / 365).toFixed(1).replace(/\.0$/, '') + 'y ago';
}

export const fmtDate = (ts) => {
  const d = new Date(ts);
  return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export async function copyText(text) {
  if (window.AndroidBridge?.copy) { try { window.AndroidBridge.copy(text); return; } catch { /* fall through */ } }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = h('textarea', { style: 'position:fixed;opacity:0' });
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
}

export function download(name, text, type = 'application/json') {
  // inside the Android app a blob download goes nowhere; the shell files it under Downloads instead
  if (window.AndroidBridge?.saveText) { try { window.AndroidBridge.saveText(name, text, type); return; } catch { /* fall back to a normal download */ } }
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 500);
}

export function pickFile(accept) {
  return new Promise((res) => {
    const i = h('input', { type: 'file', accept, style: 'display:none' });
    i.onchange = () => res(i.files[0] || null);
    document.body.append(i);
    i.click();
    setTimeout(() => i.remove(), 60000);
  });
}

/** Deterministic 0..1 from a string (for stable per-board tilt etc.) */
export function hash01(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return ((x >>> 0) % 10000) / 10000;
}
