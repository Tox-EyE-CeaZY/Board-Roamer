/**
 * Library sync client. The desktop app is the hub (src/sync.rs): it keeps the merged library on disk.
 * This file runs on every device and does the same dance: pull, merge, apply, push (with a revision check).
 *
 *   desktop   talks to its own hub over loopback, and only bothers while sharing is on
 *   android   talks to the desktop over the local network (Tailscale or Wi-Fi) through the native shell
 */
import { syncData, on } from './store.js';
import { merge, same } from './syncmerge.js';
import { isAndroid, native } from './platform.js';
import { emit } from './store.js';

const KEY = 'br1:syncCfg';
const DEFAULT_PORT = 4622;
const CODE_RE = /\b([A-Z2-9]{5})-?([A-Z2-9]{5})\b/i;

let cfg = { url: '', code: '', auto: true, last: 0, host: '' };
try { cfg = { ...cfg, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* first run */ }
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* storage full */ } };

export const syncConfig = () => ({ ...cfg });
export function setSyncConfig(patch) {
  cfg = { ...cfg, ...patch };
  persist();
  report();
  schedule();
}

/** Understands "100.64.1.2:4622 ABCDE-FGHJK", "ABCDE FGHJK 100.64.1.2", a pasted link, … */
export function parsePairing(text) {
  const t = String(text || '').trim();
  const m = t.match(/(?:https?:\/\/)?((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{2,5}))?/i);
  const rest = m ? t.replace(m[0], ' ') : t;
  const c = rest.match(CODE_RE) || t.match(CODE_RE);
  const host = m && !CODE_RE.test(m[0]) ? m[1] : '';
  return { url: host ? `http://${host}:${m[2] || DEFAULT_PORT}` : '', code: c ? (c[1] + '-' + c[2]).toUpperCase() : '' };
}

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
    if (!cfg.url || !cfg.code) throw new Error('Not connected to a desktop yet');
    const headers = { Authorization: 'Bearer ' + cfg.code, 'X-Device': deviceName() };
    if (rev != null) headers['If-Match'] = String(rev);
    const r = await native.http(method, cfg.url + path, headers, body);
    return { status: r.status, rev: r.rev == null ? null : +r.rev, text: r.body || '' };
  }
  const res = await fetch(path, { method, headers: rev != null ? { 'If-Match': String(rev) } : {}, body });
  const rv = res.headers.get('X-Rev');
  return { status: res.status, rev: rv == null ? null : +rv, text: await res.text() };
}

function check(r, what) {
  if (r.status === 401) throw new Error('That pairing code is wrong. Check the code in Board Roamer on your computer.');
  if (r.status === 429) throw new Error('Too many wrong codes. Wait a minute and try again.');
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
  return info;
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

const active = () => (isAndroid() ? !!(cfg.url && cfg.code && cfg.auto) : hostOn && cfg.auto);

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
  if (!active() || document.hidden || running || Date.now() < backoffUntil) return;
  try {
    const r = await rpc('GET', '/sync/info');
    if (r.status === 200 && r.rev !== lastRev) await syncNow({ quiet: true });
  } catch {
    backoffUntil = Date.now() + 60_000;
    report({ phase: 'error', msg: isAndroid() ? 'Desktop not reachable' : 'Sync paused', error: true });
  }
}

export async function startAutoSync() {
  if (started) return;
  started = true;
  if (!isAndroid()) {
    try { hostOn = (await (await fetch('/sync/config')).json()).enabled; } catch { hostOn = false; }
  }
  const later = () => {
    clearTimeout(timer);
    if (!active() || applying) return;
    timer = setTimeout(() => active() && !document.hidden && Date.now() >= backoffUntil && syncNow({ quiet: true }).catch(() => {}), 6000);
  };
  for (const ev of ['boards', 'subs', 'trail', 'settings', 'reading']) on(ev, later);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && active() && Date.now() - cfg.last > 20_000) syncNow({ quiet: true }).catch(() => {});
  });
  schedule();
  if (active()) setTimeout(() => syncNow({ quiet: true }).catch(() => {}), 2500);
}

/* ------------------------------------------------------------------ desktop: sharing controls */
export async function hostConfig(patch) {
  const res = await fetch('/sync/config', patch ? { method: 'POST', body: JSON.stringify(patch) } : undefined);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  if (patch && 'enabled' in patch) setHostEnabled(j.enabled);
  return j;
}
