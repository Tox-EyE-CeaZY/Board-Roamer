/**
 * Android only: feed the home screen widgets (see Widgets.java). The widgets cannot run the page, so a small summary of
 * what they show (follows, saved pools, Local folders, the accent colour) is handed over whenever any of it changes.
 * Each entry carries the hash the app opens when it is tapped.
 */
import { S, subs, library, on } from './store.js';
import { getProvider } from './providers.js';
import { debounce } from './util.js';
import { isAndroid, native } from './platform.js';
import { devices } from './local.js';

const MAX = 12;
const enc = encodeURIComponent;
let last = '';
let folders = []; // Local folders on every reachable device, kept from the last good look so a sleeping device doesn't empty the widget

/** oklch -> '#rrggbb' (the app's accent is defined in oklch; the widget needs plain colours). */
function oklch(L, C, hue) {
  const a = C * Math.cos((hue * Math.PI) / 180), b = C * Math.sin((hue * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return '#' + lin.map((x) => Math.round(Math.max(0, Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)) * 255).toString(16).padStart(2, '0')).join('');
}

function build() {
  const hue = +S('hue') || 128;
  const fl = subs.all().slice().sort((a, b) => (b.newCount || 0) - (a.newCount || 0) || (Date.parse(b.latestAt) || 0) - (Date.parse(a.latestAt) || 0)).slice(0, MAX).map((f) => {
    const prov = getProvider(f.p);
    return { n: f.t.replace(/_/g, ' '), new: f.newCount || 0, pic: f.thumbs?.[0] || '', adult: !!prov.adult, site: prov.short || '', hash: `#/roam?p=${prov.id}&q=${enc(f.t)}` };
  });
  const lib = library.all().slice().sort((a, b) => library.newPages(b) - library.newPages(a) || (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0)).slice(0, MAX).map((f) => {
    const prov = getProvider(f.p);
    return { n: f.name, new: library.newPages(f), count: f.count || 0, pic: f.cover || '', adult: !!prov.adult, hash: `#/pool/${f.pid}?p=${f.p}` };
  });
  return {
    v: 1, hue, accent: oklch(0.88, 0.2, hue), accentInk: oklch(0.18, 0.05, hue), blur: !!S('blurThumbs'),
    followTotal: subs.all().length, followNew: subs.unseen(), libTotal: library.all().length, libNew: library.unseen(),
    local: S('localOn') ? folders : [],
    follows: fl, library: lib,
  };
}

function push() {
  const json = JSON.stringify(build());
  if (json === last) return;
  last = json;
  native.setWidgets(json);
}

/** Look at every device's chosen folders (cheap: names only). */
async function lookAtFolders() {
  if (!S('localOn')) return;
  try {
    const devs = await devices(true);
    const got = await Promise.all(devs.map(async (d) => {
      try {
        const j = await (await fetch(`${d.base}/local/list?root=`)).json();
        const dn = d.here ? (isAndroid() ? 'This phone' : 'This computer') : d.name;
        return { d, list: (j.folders || []).map((f) => ({ n: f.name, sub: dn, dev: d.id, hash: `#/local/${enc(d.id)}?r=${enc(f.id)}` })) };
      } catch { return { d, list: null }; }
    }));
    const keep = folders.filter((f) => got.some((g) => g.list === null && g.d.id === f.dev)); // unreachable: keep what we knew
    folders = [...got.flatMap((g) => g.list || []), ...keep].slice(0, 24);
    // every device's folders open on that device's own screen if it has none chosen
    for (const g of got) if (g.list && !g.list.length) folders.push({ n: g.d.here ? 'This phone' : g.d.name, sub: 'No folders chosen', dev: g.d.id, hash: `#/local/${enc(g.d.id)}` });
  } catch { /* offline: keep the last look */ }
  later();
}

const later = debounce(push, 2500);

export function startWidgets() {
  if (!isAndroid()) return;
  for (const e of ['subs', 'library']) on(e, later);
  on('settings', (e) => ['hue', 'blurThumbs', 'localOn'].includes(e.detail.key) && (later(), e.detail.key === 'localOn' && lookAtFolders()));
  later();
  setTimeout(lookAtFolders, 4000);
  setInterval(() => !document.hidden && lookAtFolders(), 5 * 60 * 1000);
}
