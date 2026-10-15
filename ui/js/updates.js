/**
 * Updates from GitHub releases. The page asks the GitHub API what the newest release is; the shell that hosts the page
 * does the install (desktop: replace the program and restart; Android: hand the APK to the system installer).
 */
import { S, emit } from './store.js';
import { isAndroid, native } from './platform.js';
import { REPO, RELEASES_URL, isNewer } from './version.js';

const KEY = 'br1:update';
const EVERY = 6 * 3600 * 1000;

let app = null; // {version, os, arch}
let state = { checking: false, installing: false, progress: 0, latest: null, checked: 0, error: '' };
try { state = { ...state, ...JSON.parse(localStorage.getItem(KEY) || '{}'), checking: false, installing: false, progress: 0 }; } catch { /* first run */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ latest: state.latest, checked: state.checked })); } catch { /* full */ } };

const listeners = new Set();
const push = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn(getUpdateState())); };
export const onUpdate = (fn) => (listeners.add(fn), fn(getUpdateState()), () => listeners.delete(fn));

export async function appInfo() {
  if (app) return app;
  if (isAndroid()) {
    const i = native.info();
    app = { version: i.version || '0.0.0', os: 'android', arch: '' };
  } else {
    try { app = await (await fetch('/update/info')).json(); } catch { app = { version: '0.0.0', os: 'unknown', arch: '' }; }
  }
  return app;
}

/** What is available, relative to what is running. */
export function getUpdateState() {
  const cur = app?.version;
  return { ...state, current: cur, os: app?.os, arch: app?.arch, available: !!(state.latest && cur && isNewer(state.latest.version, cur)) };
}

const stripMd = (t) => String(t || '').replace(/\r/g, '').replace(/^#+\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();

/** Ask GitHub for the newest release. */
export async function checkForUpdate({ force = false } = {}) {
  await appInfo();
  if (state.checking) return getUpdateState();
  if (!force && Date.now() - state.checked < EVERY) return getUpdateState();
  push({ checking: true, error: '' });
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 404) throw new Error('No release has been published yet');
    if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is limiting requests right now. Try again in a while' : `GitHub answered ${res.status}`);
    const j = await res.json();
    const wanted = assetName();
    const asset = (j.assets || []).find((a) => a.name === wanted);
    state.latest = { version: String(j.tag_name || '').replace(/^v/i, ''), name: j.name || j.tag_name, notes: stripMd(j.body).slice(0, 900), url: j.html_url || RELEASES_URL, published: j.published_at, asset: asset ? asset.browser_download_url : null, size: asset ? asset.size : 0 };
    state.checked = Date.now();
    save();
    push({ checking: false });
  } catch (e) {
    push({ checking: false, error: /Failed to fetch|NetworkError/i.test(e.message) ? 'Could not reach GitHub. Check your connection' : e.message });
  }
  return getUpdateState();
}

/** The file in the release that matches this device. */
export function assetName() {
  if (!app) return '';
  if (app.os === 'android') return 'BoardRoamer.apk';
  return `board-roamer-${app.os}-${app.arch}${app.os === 'windows' ? '.exe' : ''}`;
}

/** Download and install. Desktop restarts itself; Android opens the system installer. */
export async function installUpdate() {
  const u = getUpdateState();
  if (!u.available) return;
  if (!u.latest.asset) {
    push({ error: `This release has no ${assetName()} file yet. Open the release page to download it by hand.` });
    return;
  }
  push({ installing: true, progress: 0, error: '' });
  try {
    if (isAndroid()) {
      window.__updProgress = (p) => push({ progress: p });
      const r = await native.installUpdate(u.latest.asset);
      if (r.status === 'permission') push({ error: 'Allow “Install unknown apps” for Board Roamer on the screen that just opened, then come back and tap Update again.' });
      push({ installing: false, progress: 0 });
    } else {
      const res = await fetch('/update/apply', { method: 'POST', body: JSON.stringify({ url: u.latest.asset }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) throw new Error(j.error || 'The update failed');
      emit('toast', { msg: 'Updated. Restarting…', ms: 4000 });
      // the app closes and the new version opens on its own; if it does not, say so
      setTimeout(() => push({ installing: false, error: 'The app should have restarted. Close it and open it again to finish the update.' }), 20000);
    }
  } catch (e) {
    push({ installing: false, progress: 0, error: e.message });
  }
}

/** Quietly check at start (and now and then), and nudge once when something newer exists. */
export function startAutoUpdateCheck(openSettings) {
  const run = async () => {
    if (S('autoUpdate') === false) return;
    const was = getUpdateState().latest?.version;
    const u = await checkForUpdate();
    if (u.available && u.latest.version !== was && u.latest.version !== localStorage.getItem('br1:updNudged')) {
      try { localStorage.setItem('br1:updNudged', u.latest.version); } catch { /* ignore */ }
      emit('toast', { msg: `Board Roamer ${u.latest.version} is available`, ms: 9000, action: { label: 'See update', run: () => openSettings('updates') } });
    }
  };
  setTimeout(run, 9000);
  setInterval(() => !document.hidden && run(), EVERY);
}
