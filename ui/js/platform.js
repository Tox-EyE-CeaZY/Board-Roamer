/**
 * Platform detection + the thin layer to the Android shell (when running inside the APK).
 *
 *   html.phone      narrow screens, or a phone held sideways     → compact layout, sheets, bottom bar
 *   html.landscape  wider than tall
 *   html.touch      the primary pointer is a finger              → no hover affordances, bigger targets
 *   html.android    running inside the Android app
 *   html.dual       the window is split by a hinge or fold (Surface Duo spanned, tabletop postures)
 *   html.dual-v / html.dual-h   the two screens sit side by side / one above the other
 *   html.short      a very short window (split-screen, a phone held sideways)
 *
 * Everything degrades gracefully: in a plain browser or the desktop app the bridge calls are no-ops.
 */
const root = document.documentElement;
// 560px tall covers a Surface Duo screen held sideways (720 x 540), which is nowhere near a desktop window
const mqPhone = matchMedia('(max-width: 700px), (max-height: 560px) and (pointer: coarse)');
const mqTouch = matchMedia('(hover: none) and (pointer: coarse)');
const listeners = new Set();

const A = () => window.AndroidBridge;
export const isAndroid = () => !!A();
export const isPhone = () => mqPhone.matches || !!panes;
export const isTouch = () => mqTouch.matches || isAndroid();
export const isLandscape = () => (panes ? panes[0].w > panes[0].h : innerWidth > innerHeight); // on a dual-screen device: the main screen

/* ------------------------------------------------------------------ hinges and folds */
/**
 * The two screens of a dual-screen device (or the two halves of a half-open foldable), in CSS pixels, or null.
 * Sources, best first: the web's window segments API, the Android shell (the hinge shows up as a display cutout), and a
 * `?hinge=x,y,w,h` override in the address (or localStorage 'br.hinge') for trying the layout on a desktop browser.
 */
function readHinge() {
  let h = null;
  try {
    const q = new URLSearchParams(location.search).get('hinge') || localStorage.getItem('br.hinge');
    if (q) { const [x, y, w, hh] = q.split(',').map(Number); if (w >= 0 && hh > 0) h = { x, y, w, h: hh }; }
  } catch { /* storage can be blocked */ }
  if (!h) {
    try {
      const segs = typeof window.getWindowSegments === 'function' ? window.getWindowSegments() : null;
      if (segs && segs.length === 2) {
        return [rectOf(segs[0]), rectOf(segs[1])];
      }
    } catch { /* not supported */ }
    try { const j = A() && typeof A().hinge === 'function' ? A().hinge() : ''; if (j) h = JSON.parse(j); } catch { /* old shell */ }
  }
  if (!h || !(h.w >= 0) || !(h.h > 0)) return null;
  const W = innerWidth, H = innerHeight;
  // a hinge runs the full height (screens side by side) or the full width (one above the other)
  if (h.h >= H * 0.9 && h.w < W * 0.3) { const x = Math.max(0, h.x), x2 = Math.min(W, h.x + h.w); return x > 120 && W - x2 > 120 ? [{ x: 0, y: 0, w: x, h: H }, { x: x2, y: 0, w: W - x2, h: H }] : null; }
  if (h.w >= W * 0.9 && h.h < H * 0.3) { const y = Math.max(0, h.y), y2 = Math.min(H, h.y + h.h); return y > 120 && H - y2 > 120 ? [{ x: 0, y: 0, w: W, h: y }, { x: 0, y: y2, w: W, h: H - y2 }] : null; }
  return null;
}
const rectOf = (r) => ({ x: r.x ?? r.left, y: r.y ?? r.top, w: r.width, h: r.height });
let panes = null;
/** [main, detail] screens when the window is split by a hinge, else null. */
export const getPanes = () => panes;
export const isDual = () => !!panes;

function apply() {
  panes = readHinge();
  const dual = !!panes;
  root.classList.toggle('phone', isPhone() || dual); // each screen of a dual-screen device is phone-sized
  root.classList.toggle('dual', dual);
  root.classList.toggle('dual-v', dual && panes[0].y === panes[1].y);
  root.classList.toggle('dual-h', dual && panes[0].y !== panes[1].y);
  root.classList.toggle('short', innerHeight <= 480 || (dual && Math.min(panes[0].h, panes[1].h) <= 480));
  root.classList.toggle('touch', isTouch());
  root.classList.toggle('android', isAndroid());
  root.classList.toggle('landscape', isLandscape());
  ['1', '2'].forEach((n, i) => ['x', 'y', 'w', 'h'].forEach((k) => (panes ? root.style.setProperty(`--p${n}-${k}`, panes[i][k] + 'px') : root.style.removeProperty(`--p${n}-${k}`))));
  listeners.forEach((fn) => fn());
}
mqPhone.addEventListener?.('change', apply);
mqTouch.addEventListener?.('change', apply);
addEventListener('resize', apply);
addEventListener('orientationchange', apply);
window.__layout = apply; // the Android shell calls this when the window or hinge changes
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
  /** Hand the home screen widgets what they show (JSON), see widgets.js. */
  setWidgets: (json) => call('setWidgets', json),
  /** Local files on the phone: is access to files allowed, ask for it, and tell the shell how to reach the desktop and other devices. */
  localAccess: () => (has('localAccess') ? !!call('localAccess') : true),
  requestLocalAccess: () => call('requestLocalAccess'),
  setHub: (url, token, fp) => call('setHub', url || '', token || '', fp || ''),
  /** Pair with a computer: {urls: ['ip:port'], key, fp?, device}. Resolves {id, token, host, hostId, port, fp, url, addrs}. */
  pairHub(req) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      if (!has('pairHub')) return (pending.delete(id), reject(new Error('Pairing is not available here')));
      call('pairHub', id, JSON.stringify(req));
    });
  },
  /** Board Roamer computers announcing themselves on this network. Resolves {hubs: [{id, name, fp, host, port}]}. */
  discoverHubs(ms) {
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, { resolve, reject: () => resolve({ hubs: [] }) });
      if (!has('discoverHubs')) return (pending.delete(id), resolve({ hubs: [] }));
      call('discoverHubs', id, ms || 2500);
    });
  },
  /** This phone's own addresses, and whether Tailscale is up: {addrs, tailscale}. */
  netInfo() {
    try { return has('netInfo') ? JSON.parse(call('netInfo') || '{}') : { addrs: [], tailscale: false }; } catch { return { addrs: [], tailscale: false }; }
  },
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
