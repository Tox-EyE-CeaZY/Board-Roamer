/**
 * Library sync client. The desktop app is the hub (src/sync.rs): it keeps the merged library on disk.
 * This file runs on every device and does the same dance: pull, merge, apply, push (with a revision check).
 *
 *   desktop   talks to its own hub over loopback, and only bothers while sharing is on
 *   android   talks to the desktop through the native shell, over HTTPS to ONE certificate (the fingerprint from the QR code)
 *
 * Pairing (android): scan the QR code the computer shows, or type its code. The phone remembers the computer's id, certificate
 * fingerprint and a device token. Later it finds the computer again by id on the network (mDNS, in the shell), then by the
 * addresses it knew, Tailscale ones included, so the same pairing works at home and, with Tailscale, anywhere.
 */
import { syncData, on, S, setS } from './store.js';
import { merge, same } from './syncmerge.js';
import { isAndroid, native } from './platform.js';
import { emit } from './store.js';

const KEY = 'br1:syncCfg';
const FEED_EVERY = 3 * 60000; // the Feed learns with every swipe: that is sent at most this often, and when the app is put away
const KEY_RE = /\b([A-Z2-9]{4})-?([A-Z2-9]{4})-?([A-Z2-9]{4})-?([A-Z2-9]{4})\b/i;

let cfg = { id: '', host: '', fp: '', token: '', port: 0, addrs: [], url: '', auto: true, last: 0, old: false };
try {
  cfg = { ...cfg, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  // before 2.13 a phone was paired with an address and a code over plain http: it has to pair again (scan the code)
  if (cfg.url && !cfg.fp) cfg = { ...cfg, url: '', code: undefined, token: '', old: true };
} catch { /* first run */ }
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* storage full */ } };

export const syncConfig = () => ({ ...cfg });
export const isPaired = () => !!(cfg.url && cfg.token && cfg.fp);
export function setSyncConfig(patch) {
  cfg = { ...cfg, ...patch };
  persist();
  if (isAndroid()) native.setHub(cfg.url, cfg.token, cfg.fp); // the shell reaches the computer for Local files and announces this phone
  report();
  schedule();
}

/** What the pairing QR code says: boardroamer://pair?v=1&id=…&n=<name>&k=<key>&fp=<sha256>&a=ip:port,ip:port */
export function parseLink(text) {
  const t = String(text || '').trim();
  if (!/^boardroamer:\/\/pair\?/i.test(t)) return null;
  const q = new URLSearchParams(t.slice(t.indexOf('?') + 1));
  const key = (q.get('k') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fp = (q.get('fp') || '').toLowerCase();
  const id = q.get('id') || '';
  if (!key || !/^[0-9a-f]{64}$/.test(fp) || !id) return null;
  return { id, name: q.get('n') || 'your computer', key, fp, addrs: (q.get('a') || '').split(',').filter(Boolean) };
}

/** A typed code (the same key, without the rest): "ABCD-EFGH-JKLM-NPQR". */
export function parseKey(text) {
  const m = String(text || '').match(KEY_RE);
  return m ? m.slice(1, 5).join('-').toUpperCase() : '';
}

const hostOf = (addr) => String(addr).replace(/^https?:\/\//, '');
const ipsOf = (addrs) => (addrs || []).map((a) => (typeof a === 'string' ? a : a.ip)).filter(Boolean);

/** Pair with a computer. `how` is {link} (the QR code's text) or {key, address?, id?} (typed). Resolves the computer's name. */
export async function pairWith(how) {
  let key, fp = '', urls = [];
  if (how.link) {
    const l = parseLink(how.link);
    if (!l) throw new Error('That is not a Board Roamer pairing code');
    key = l.key; fp = l.fp;
    urls = l.addrs.slice();
    // the network may know a better address than the one that was on screen
    try { const f = (await native.discoverHubs(1800)).hubs.find((x) => x.id === l.id); if (f) urls.unshift(`${f.host}:${f.port}`); } catch { /* the QR code's own addresses */ }
  } else {
    key = how.key;
    if (how.address) urls.push(hostOf(how.address).includes(':') ? hostOf(how.address) : hostOf(how.address) + ':4622');
    if (how.found) urls.push(`${how.found.host}:${how.found.port}`);
  }
  if (!urls.length) throw new Error('No computer was found on this network. Check you are on the same Wi-Fi, or scan the code instead');
  const r = await native.pairHub({ urls, key, fp, device: deviceName() });
  setSyncConfig({ id: r.hostId, host: r.host, fp: r.fp, token: r.token, port: r.port, url: r.url, addrs: ipsOf(r.addrs), old: false, last: 0 });
  return r.host;
}

/** Forget the computer (this phone stays listed there until it is removed on the computer too). */
export const unpair = () => setSyncConfig({ id: '', host: '', fp: '', token: '', port: 0, addrs: [], url: '', last: 0, old: false });

/* ------------------------------------------------------------------ status */
const listeners = new Set();
let state = { phase: 'idle', msg: '', error: false };
function report(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn({ ...state, last: cfg.last, host: cfg.host }));
}
export const onSyncStatus = (fn) => (listeners.add(fn), fn({ ...state, last: cfg.last, host: cfg.host }), () => listeners.delete(fn));


/* ------------------------------------------------------------------ transport */
const deviceName = () => (isAndroid() ? native.info().device || 'Android phone' : 'Desktop');

async function rpc(method, path, { body, rev } = {}) {
  if (isAndroid()) {
    if (!isPaired()) throw new Error('Not paired with a computer yet');
    const headers = { Authorization: 'Bearer ' + cfg.token, 'X-Device': deviceName() };
    if (rev != null) headers['If-Match'] = String(rev);
    let r;
    try {
      r = await native.http(method, cfg.url + path, headers, body);
    } catch (e) {
      // not reachable where it was last seen: look for it again (same network, or its other addresses), then retry once
      if (!(await findHub())) throw e;
      r = await native.http(method, cfg.url + path, headers, body);
    }
    return { status: r.status, rev: r.rev == null ? null : +r.rev, text: r.body || '' };
  }
  const res = await fetch(path, { method, headers: rev != null ? { 'If-Match': String(rev) } : {}, body });
  const rv = res.headers.get('X-Rev');
  return { status: res.status, rev: rv == null ? null : +rv, text: await res.text() };
}

/* ------------------------------------------------------------------ finding the computer again */
let finding = null;
/** Where is the paired computer now? Ask the network for its id (mDNS), then try the addresses we knew, Tailscale included.
 *  The certificate is pinned, so a wrong guess can only fail, never reach somebody else's computer. */
function findHub() {
  if (finding) return finding;
  finding = (async () => {
    const tried = new Set([cfg.url]);
    const cands = [];
    try {
      const f = (await native.discoverHubs(2500)).hubs.find((x) => x.id === cfg.id);
      if (f) cands.push(`https://${f.host}:${f.port}`);
    } catch { /* no discovery on this network */ }
    for (const ip of cfg.addrs || []) cands.push(`https://${ip}:${cfg.port || 4622}`);
    for (const url of cands) {
      if (tried.has(url)) continue;
      tried.add(url);
      try {
        const r = await native.http('GET', url + '/sync/info', { Authorization: 'Bearer ' + cfg.token, 'X-Device': deviceName() }, '');
        if (r.status === 200) { learn(r.body); setSyncConfig({ url }); return true; }
      } catch { /* next one */ }
    }
    return false;
  })().finally(() => { finding = null; });
  return finding;
}

/** The computer's own report of itself keeps our addresses current (a Tailscale one shows up as soon as it is installed there). */
function learn(text) {
  try {
    const i = JSON.parse(text);
    if (i.id && i.id !== cfg.id) return;
    const addrs = ipsOf(i.addrs);
    if (addrs.length && addrs.join() !== (cfg.addrs || []).join()) { cfg.addrs = addrs; persist(); }
    if (i.host && i.host !== cfg.host) { cfg.host = i.host; persist(); }
    if (i.port && i.port !== cfg.port) { cfg.port = i.port; persist(); }
  } catch { /* an older computer */ }
}

/** What to tell the person when the computer cannot be reached. */
export function connectionAdvice() {
  let net = { tailscale: false };
  try { net = native.netInfo(); } catch { /* not on the phone */ }
  const hubTs = (cfg.addrs || []).some((ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip));
  if (!net.tailscale) return { kind: 'phone', text: 'Not at home? Install Tailscale (free) on this phone and on your computer, and syncing works from anywhere with the same pairing.' };
  if (!hubTs) return { kind: 'computer', text: 'Tailscale is on this phone, but not on your computer. Install it there too, and sign in to the same account.' };
  return { kind: 'none', text: 'Tailscale is on, but the computer does not answer. Is Board Roamer open there with sharing turned on?' };
}

function check(r, what) {
  if (r.status === 401) throw new Error('The computer no longer knows this phone. Pair again: scan its code in Settings → Sync.');
  if (r.status === 429) throw new Error('Too many wrong attempts. Wait a minute and try again.');
  if (r.status >= 400) {
    let m = '';
    try { m = JSON.parse(r.text).error; } catch { /* not json */ }
    throw new Error(m || `${what} failed (${r.status})`);
  }
}

/** Ask the hub who it is (also proves the address and code work). */
export async function ping() {
  const r = await rpc('GET', '/sync/info');
  check(r, 'Connecting');
  const info = JSON.parse(r.text);
  if (info.app !== 'board-roamer-sync') throw new Error('That address is not a Board Roamer desktop');
  if (isAndroid()) learn(r.text);
  return info;
}

/** Phone: which devices share their folders (the desktop itself and other phones), with the addresses to reach them. */
export async function hubDevices() {
  const r = await rpc('GET', '/sync/devices');
  check(r, 'Listing devices');
  return JSON.parse(r.text);
}

/* ------------------------------------------------------------------ the sync itself */
let running = null;
let applying = false;
let lastRev = -1;

export function syncNow({ quiet = false } = {}) {
  if (running) return running;
  running = (async () => {
    report({ phase: 'syncing', msg: 'Syncing…', error: false });
    const before = syncData.counts();
    let pushed = false, pulled = false;
    try {
      for (let attempt = 0; ; attempt++) {
        const g = await rpc('GET', '/sync/doc');
        check(g, 'Reading the library');
        const remote = g.status === 200 && g.text ? JSON.parse(g.text) : null;
        const rev = g.rev || 0;
        const local = syncData.snapshot();
        const merged = merge(local, remote);
        if (remote && !same(merged, local)) {
          applying = true;
          try { syncData.apply(merged); } finally { applying = false; }
          pulled = true;
        }
        if (remote && same(merged, remote)) { lastRev = rev; break; }
        const p = await rpc('PUT', '/sync/doc', { body: JSON.stringify(merged), rev });
        if (p.status === 409 && attempt < 3) continue; // someone else synced in between; go round again
        check(p, 'Saving the library');
        lastRev = p.rev ?? rev + 1;
        pushed = true;
        break;
      }
      const after = syncData.counts();
      const bits = [];
      const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
      if (after.pins > before.pins) bits.push(plural(after.pins - before.pins, 'new pin'));
      if (after.boards > before.boards) bits.push(plural(after.boards - before.boards, 'new board'));
      if (after.follows > before.follows) bits.push(plural(after.follows - before.follows, 'new follow'));
      const brief = pulled ? (bits.length ? bits.join(', ') : 'updated') : pushed ? 'sent your changes' : 'already up to date';
      cfg.last = Date.now();
      persist();
      report({ phase: 'idle', msg: 'Synced · ' + brief, error: false });
      if (pulled && (!quiet || bits.length)) emit('toast', { msg: 'Synced from your ' + (isAndroid() ? 'desktop' : 'other device') + ' · ' + brief });
      return { pulled, pushed, brief };
    } catch (e) {
      const msg = e && e.message ? e.message : 'Sync failed';
      report({ phase: 'error', msg, error: true });
      backoffUntil = Date.now() + 60_000;
      if (!quiet) emit('toast', { msg, kind: 'err' });
      throw e;
    } finally {
      running = null;
    }
  })();
  running.catch(() => {});
  return running;
}

/* ------------------------------------------------------------------ automatic sync */
let hostOn = false; // desktop: is sharing on
let backoffUntil = 0;
let timer = 0, poll = 0, started = false;

const active = () => (isAndroid() ? isPaired() && cfg.auto : hostOn && cfg.auto);

/** The desktop tells the sync client whether sharing is on (settings panel calls this). */
export function setHostEnabled(on) {
  hostOn = !!on;
  schedule();
}

function schedule() {
  clearInterval(poll);
  poll = 0;
  if (!active()) return;
  poll = setInterval(tick, 20_000);
}

async function tick() {
  // on a computer the window may be hidden in the tray on purpose: keep syncing. A phone in the background should not.
  if (!active() || (isAndroid() && document.hidden) || running || Date.now() < backoffUntil) return;
  try {
    const r = await rpc('GET', '/sync/info');
    if (r.status === 200 && isAndroid()) learn(r.text);
    if (r.status === 200 && r.rev !== lastRev) await syncNow({ quiet: true });
  } catch {
    backoffUntil = Date.now() + 60_000;
    report({ phase: 'error', msg: isAndroid() ? 'Computer not reachable' : 'Sync paused', error: true });
  }
}

export async function startAutoSync() {
  if (started) return;
  started = true;
  if (isAndroid()) native.setHub(cfg.url, cfg.token, cfg.fp);
  if (!isAndroid()) {
    try { hostOn = (await (await fetch('/sync/config')).json()).enabled; } catch { hostOn = false; }
  }
  const later = () => {
    clearTimeout(timer);
    if (!active() || applying) return;
    timer = setTimeout(() => active() && !(isAndroid() && document.hidden) && Date.now() >= backoffUntil && syncNow({ quiet: true }).catch(() => {}), 6000);
  };
  for (const ev of ['boards', 'subs', 'trail', 'settings', 'reading']) on(ev, later);
  let learned = false, feedTimer = 0;
  const sendFeed = () => {
    clearTimeout(feedTimer);
    feedTimer = 0;
    if (!learned || !active() || applying || Date.now() < backoffUntil) return;
    learned = false;
    syncNow({ quiet: true }).catch(() => (learned = true));
  };
  on('feed-state', () => {
    learned = true;
    if (active() && !feedTimer) feedTimer = setTimeout(sendFeed, Math.max(6000, cfg.last + FEED_EVERY - Date.now()));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sendFeed();
    else if (active() && Date.now() - cfg.last > 20_000) syncNow({ quiet: true }).catch(() => {});
  });
  schedule();
  if (active()) setTimeout(() => syncNow({ quiet: true }).catch(() => {}), 2500);
}

/* ------------------------------------------------------------------ logins: handed over once, never synced */
/** Desktop: make the logins available to the NEXT device that connects (held in memory by the app, taken once). */
export async function armCreds() {
  const creds = Object.fromEntries(Object.entries(S('creds') || {}).filter(([, v]) => v && (v.user || v.key)));
  const body = Object.keys(creds).length ? JSON.stringify(creds) : '{}';
  const r = await fetch('/sync/creds', { method: 'PUT', body });
  return (await r.json()).armed === true;
}

/** Phone, first connection only: ask the desktop for its logins. Resolves true when some arrived. */
export async function claimCreds() {
  const r = await rpc('GET', '/sync/creds');
  if (r.status !== 200 || !r.text) return false;
  const got = JSON.parse(r.text);
  const mine = { ...(S('creds') || {}) };
  let n = 0;
  for (const [k, v] of Object.entries(got)) if (v && (v.user || v.key)) { mine[k] = { user: v.user || '', key: v.key || '' }; n++; }
  if (n) setS('creds', mine);
  return n > 0;
}

/* ------------------------------------------------------------------ desktop: sharing controls */
export async function hostConfig(patch) {
  const res = await fetch('/sync/config', patch ? { method: 'POST', body: JSON.stringify(patch) } : undefined);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  if (patch && 'enabled' in patch) setHostEnabled(j.enabled);
  // turning sharing on, or opening a pairing, is the moment to offer the login to the next device
  if (patch && (patch.enabled === true || patch.pair)) { try { await armCreds(); j.credsArmed = true; } catch { /* the app will say so */ } }
  return j;
}
