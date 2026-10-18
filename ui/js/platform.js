/**
 * Platform detection + the thin layer to the Android shell (when running inside the APK).
 *
 *   html.phone      narrow screens, or a phone held sideways     → compact layout, sheets, bottom bar
 *   html.landscape  wider than tall
 *   html.touch      the primary pointer is a finger              → no hover affordances, bigger targets
 *   html.android    running inside the Android app
 *
 * Everything degrades gracefully: in a plain browser or the desktop app the bridge calls are no-ops.
 */
const root = document.documentElement;
const mqPhone = matchMedia('(max-width: 700px), (max-height: 500px) and (pointer: coarse)');
const mqTouch = matchMedia('(hover: none) and (pointer: coarse)');
const listeners = new Set();

const A = () => window.AndroidBridge;
export const isAndroid = () => !!A();
export const isPhone = () => mqPhone.matches;
export const isTouch = () => mqTouch.matches || isAndroid();
export const isLandscape = () => innerWidth > innerHeight;

function apply() {
  root.classList.toggle('phone', isPhone());
  root.classList.toggle('touch', isTouch());
  root.classList.toggle('android', isAndroid());
  root.classList.toggle('landscape', isLandscape());
  listeners.forEach((fn) => fn());
}
mqPhone.addEventListener?.('change', apply);
mqTouch.addEventListener?.('change', apply);
addEventListener('resize', apply);
addEventListener('orientationchange', apply);
apply();
export const onLayout = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/* ------------------------------------------------------------------ native calls */
let seq = 0;
const pending = new Map();
// the shell answers asynchronous jobs (saving files…) through this
window.__nativeResult = (id, json) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  try {
    const r = JSON.parse(json);
    r.error ? p.reject(new Error(r.error)) : p.resolve(r);
  } catch (e) {
    p.reject(e);
  }
};

function call(method, ...args) {
  try {
    const b = A();
    return b && typeof b[method] === 'function' ? b[method](...args) : undefined;
  } catch {
    return undefined;
  }
}

/** Does the shell offer this call? (A void Java method answers `undefined`, so the return value cannot tell us.) */
const has = (method) => { try { return typeof A()?.[method] === 'function'; } catch { return false; } };

export const native = {
  /** Save a file into Downloads/Board Roamer (with metadata). Resolves {path, uri, meta}. */
  save(url, name, dir, meta, ua) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      if (!has('save')) return (pending.delete(id), reject(new Error('Saving is not available here')));
      call('save', id, url, name, dir || '', meta ? JSON.stringify(meta) : '', ua || '');
    });
  },
  /** One request to the desktop app on the local network (sync). Resolves {status, rev, body}. */
  http(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      if (!has('http')) return (pending.delete(id), reject(new Error('Network sync is not available here')));
      call('http', id, method, url, JSON.stringify(headers || {}), body || '');
    });
  },
  /** Download the release APK and open Android's installer. Resolves {status: 'installing' | 'permission'}. */
  installUpdate(url) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      if (!has('installUpdate')) return (pending.delete(id), reject(new Error('Updating is not available here')));
      call('installUpdate', id, url);
    });
  },
  /** Notifications on the phone: is it allowed, ask for permission, post one (text only). */
  notifyAllowed: () => (has('notifyAllowed') ? !!call('notifyAllowed') : false),
  requestNotify: () => call('requestNotify'),
  notify: (title, body) => call('notify', title, body),
  /** Hand the background job its watch list (JSON), see watch.js. */
  setWatch: (json) => call('setWatch', json),
  /** Local files on the phone: is access to files allowed, ask for it, and tell the shell how to reach the desktop and other devices. */
  localAccess: () => (has('localAccess') ? !!call('localAccess') : true),
  requestLocalAccess: () => call('requestLocalAccess'),
  setHub: (url, code) => call('setHub', url || '', code || ''),
  setRemotes: (json) => call('setRemotes', json),
  /** Android: offer Board Roamer for links to the supported sites, and open the system screen where that is switched on. */
  setLinks: (on) => call('setLinks', !!on),
  openLinkSettings: () => call('openLinkSettings'),
  open: (url) => call('openUrl', url),
  reveal: (uri) => call('reveal', uri || ''),
  share: (text, title) => call('share', text || '', title || ''),
  shareFile: (url, name) => call('shareFile', url, name || 'image'),
  copy: (text) => call('copy', text),
  haptic: (kind = 'tick') => call('haptic', kind),
  immersive: (on) => call('setImmersive', !!on),
  orientation: (mode) => call('setOrientation', mode), // 'landscape' | 'auto'
  bars: (colorHex, lightIcons) => call('setBars', colorHex, !!lightIcons),
  keepAwake: (on) => call('keepAwake', !!on),
  secure: (on) => call('setSecure', !!on),
  exit: () => call('exitApp'),
  info: () => {
    try { return JSON.parse(call('info') || '{}'); } catch { return {}; }
  },
};

/* ------------------------------------------------------------------ system Back button */
const backHandlers = [];
/** Register a handler that returns true if it consumed Back. Later registrations are asked first. */
export function onBack(fn) {
  backHandlers.unshift(fn);
  return () => backHandlers.splice(backHandlers.indexOf(fn), 1);
}
// the Android shell calls this; it must return true when the page handled the press
window.__back = () => {
  for (const fn of backHandlers) {
    try { if (fn()) return true; } catch { /* keep going */ }
  }
  return false;
};

/* ------------------------------------------------------------------ small touch helpers */
export const haptic = (k) => {
  if (isAndroid()) native.haptic(k);
  else if (isTouch()) navigator.vibrate?.(k === 'heavy' ? 24 : 10);
};
