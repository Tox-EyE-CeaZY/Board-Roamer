import { h, download, pickFile, copyText, ago } from './util.js';
import { RELEASES_URL } from './version.js';
import { syncConfig, setSyncConfig, parsePairing, ping, syncNow, onSyncStatus, hostConfig, armCreds, claimCreds } from './sync.js';
import { icon } from './icons.js';
import { S, setS, exportAll, importAll, wipe, DEFAULTS } from './store.js';
import { providerList, getProvider, call } from './providers.js';
import { segmented, toast, confirmDlg } from './ui.js';
import { reveal, openExternal } from './actions.js';
import { checkForUpdate, installUpdate, onUpdate, appInfo } from './updates.js';
import { isPhone, isTouch, isAndroid, native } from './platform.js';
import { isNative } from './titlebar.js';

let panel = null;

const THEMES = [['night', 'Night Survey', '#0a1113', '#c8ff3d', 128], ['paper', 'Paper Chart', '#ece5d3', '#e8431c', 35], ['violet', 'Ultraviolet', '#0d0a18', '#ff5fd2', 335]];

let offStatus = null, offUpd = null;
export function closeSettings() {
  if (!panel) return;
  offStatus?.();
  offUpd?.();
  const p = panel;
  panel = null;
  p.classList.remove('in');
  setTimeout(() => p.remove(), 260);
}

export function openSettings(section) {
  if (panel) return closeSettings();
  const body = h('div', { class: 'st-body' });
  const sec = (id, title, ...kids) => h('section', { class: 'st-sec', id: 'st-' + id }, h('h3', {}, title), kids);
  const toggle = (label, key, hint) => {
    const b = h('button', { class: 'tgl' + (S(key) ? ' on' : ''), role: 'switch', onclick: () => { setS(key, !S(key)); b.classList.toggle('on', S(key)); } }, h('i'));
    return h('div', { class: 'st-row' }, h('div', {}, h('b', {}, label), hint ? h('small', {}, hint) : null), b);
  };
  const slider = (label, key, min, max, step, fmt = (v) => v) => {
    const out = h('output', {}, fmt(S(key)));
    const i = h('input', { type: 'range', min, max, step, value: S(key), oninput: () => { setS(key, +i.value); out.textContent = fmt(+i.value); } });
    return h('div', { class: 'st-row col' }, h('div', { class: 'st-line' }, h('b', {}, label), out), i);
  };
  const sectionTabs = () => {
    const row = h('div', { class: 'f-chips' });
    const paint = () => row.replaceChildren(...[['boards', 'Boards'], ['follows', 'Follows'], ['pools', 'Pools'], ['trail', 'Trail']].map(([id, label]) =>
      h('button', { class: 'btn' + ((S('tabSections') || []).includes(id) ? ' primary' : ''), onclick: () => {
        const cur = S('tabSections') || [];
        setS('tabSections', cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
        paint();
      } }, label)));
    paint();
    return h('div', { class: 'st-row col' }, h('div', { class: 'st-line' }, h('b', {}, 'Sections in their own tab'), h('small', {}, 'Picking Follows (say) keeps it in a tab of its own: opening it switches there, and artists you open from it start new tabs. Needs tabs on')), row);
  };
  const seg = (label, key, opts, hint) => h('div', { class: 'st-row col' }, h('div', { class: 'st-line' }, h('b', {}, label), hint ? h('small', {}, hint) : null), segmented(opts, S(key), (v) => setS(key, v)));

  /* --- source */
  const provBox = h('div', { class: 'prov-list' });
  const credBox = h('div', {});
  const paintProv = () => {
    provBox.replaceChildren(...providerList.map((p) => h('button', { class: 'prov-card' + (S('provider') === p.id ? ' on' : ''), style: `--ph:${p.color}`, onclick: () => { setS('provider', p.id); paintProv(); paintCreds(); } },
      h('i', { class: 'prov-dot' }, p.short), h('div', {}, h('b', {}, p.name), h('small', {}, p.sub)))));
  };
  const paintCreds = () => {
    const p = getProvider(S('provider'));
    const creds = { ...(S('creds') || {}) };
    const c = creds[p.credKey] || {};
    const save = () => { creds[p.credKey] = { user: user.value.trim(), key: key.value.trim() }; setS('creds', creds); };
    const label = p.engine === 'gb' ? ['User ID', 'API key'] : ['Username', 'API key'];
    const user = h('input', { class: 'input', placeholder: label[0], value: c.user || '', spellcheck: 'false', oninput: save });
    const key = h('input', { class: 'input', placeholder: label[1], type: 'password', value: c.key || '', spellcheck: 'false', oninput: save });
    const help = { e621: 'e621.net → Account → Manage API Access', e926: 'Same account and key as e621', danbooru: 'Danbooru → My Account → API Key', gelbooru: 'gelbooru.com → Settings → Options → API Access Credentials', safebooru: 'Not needed' }[p.id];
    credBox.replaceChildren(
      h('div', { class: 'st-note' }, p.needsKey ? h('b', {}, 'This site requires credentials. ') : null, `Optional for most sites — needed for favorites, votes and your own blacklist. ${help ? `Find them at: ${help}.` : ''}`),
      p.id === 'safebooru' ? null : h('div', { class: 'two' }, user, key),
      p.id === 'e621' || p.id === 'e926' ? h('div', { class: 'row-btns' },
        h('button', { class: 'btn', onclick: async () => {
          try {
            const bl = await getProvider('e621').accountBlacklist();
            setS('blacklist', bl);
            ta.value = bl.join('\n');
            toast(`Imported ${bl.length} blacklist lines from your account`);
          } catch (e) { toast(e.message, { kind: 'err' }); }
        } }, 'Import my blacklist'),
        h('button', { class: 'btn', onclick: async () => {
          try { await call(p, `${p.web}/posts.json?limit=1`); toast('Connection works ✓'); } catch (e) { toast(e.message, { kind: 'err' }); }
        } }, 'Test connection')) : null,
    );
  };
  paintProv();

  /* --- sync */
  const syncBox = h('div', { class: 'sync-box' });
  const paintSync = async () => {
    offStatus?.();
    offStatus = null;
    const status = h('div', { class: 'st-note sync-status' }, '');
    const watch = () => (offStatus = onSyncStatus((st) => {
      status.classList.toggle('bad', !!st.error);
      status.textContent = st.phase === 'syncing' ? 'Syncing…' : st.error ? st.msg : st.last ? `${st.msg || 'Synced'} · ${ago(st.last)}` : 'Not synced yet';
    }));
    const what = h('div', { class: 'st-note' }, 'Syncs boards and pins, follows, the trail, reading progress and your look and search settings. Logins, layout sizes and phone options stay on each device. Deleting something on one device deletes it everywhere.');
    if (isAndroid()) {
      const c = syncConfig();
      const addr = h('input', { class: 'input', placeholder: '100.x.x.x:4622', value: c.url.replace(/^http:\/\//, ''), spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', inputmode: 'url' });
      const code = h('input', { class: 'input mono', placeholder: 'XXXXX-XXXXX', value: c.code, spellcheck: 'false', autocapitalize: 'characters', autocomplete: 'off' });
      const spread = (el) => el.addEventListener('input', () => { const p = parsePairing(el.value); if (p.url && p.code) (addr.value = p.url.replace(/^http:\/\//, ''), code.value = p.code); });
      spread(addr); spread(code);
      const connect = h('button', { class: 'btn primary', onclick: async () => {
        const p = parsePairing(addr.value + ' ' + code.value);
        if (!p.url || !p.code) return toast('Enter the address and the code shown on your computer', { kind: 'err' });
        connect.disabled = true;
        const keep = syncConfig();
        setSyncConfig({ url: p.url, code: p.code });
        try {
          const info = await ping();
          setSyncConfig({ host: info.host || '' });
          toast('Connected to ' + (info.host || 'your desktop'));
          // first connection only: the desktop can hand over its logins once. They never travel with normal syncing.
          const private_ = /^http:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(p.url);
          if (private_ || await confirmDlg('Copy your login too?', 'This connection is not encrypted (it is not Tailscale). Your e621 username and API key would cross the network in plain text. Copy them anyway?', 'Copy login')) {
            try { if (await claimCreds()) toast('Copied your login from the computer', { ms: 2600 }); } catch { /* the library can still sync */ }
          }
          await syncNow();
        } catch (e) {
          setSyncConfig({ url: keep.url, code: keep.code });
          toast(e.message, { kind: 'err' });
        }
        connect.disabled = false;
        paintSync();
      } }, c.url ? 'Reconnect & sync' : 'Connect & sync');
      const auto = () => { const b = h('button', { class: 'tgl' + (c.auto ? ' on' : ''), role: 'switch', onclick: () => { setSyncConfig({ auto: !syncConfig().auto }); b.classList.toggle('on', syncConfig().auto); } }, h('i')); return h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Sync automatically'), h('small', {}, 'When the app opens and after you change something')), b); };
      syncBox.replaceChildren(
        h('div', { class: 'st-note' }, c.url ? `Paired with ${c.host || c.url}.` : 'On your computer open Settings → Sync, turn on sharing, then enter the address and code it shows.'),
        h('div', { class: 'two' }, addr, code),
        h('div', { class: 'row-btns' }, connect,
          c.url ? h('button', { class: 'btn', onclick: async () => { try { await syncNow(); } catch { /* shown as a toast */ } } }, 'Sync now') : null,
          c.url ? h('button', { class: 'btn danger', onclick: () => { setSyncConfig({ url: '', code: '', host: '', last: 0 }); paintSync(); } }, 'Disconnect') : null),
        c.url ? auto() : null, status, what);
      watch();
      return;
    }
    // desktop: share this library
    let cf;
    try { cf = await hostConfig(); } catch { cf = null; }
    if (!cf) return syncBox.replaceChildren(h('div', { class: 'st-note' }, 'Sync needs the Board Roamer desktop app.'));
    const flip = h('button', { class: 'tgl' + (cf.enabled ? ' on' : ''), role: 'switch', onclick: async () => {
      try { await hostConfig({ enabled: !cf.enabled }); } catch (e) { toast(e.message, { kind: 'err' }); }
      paintSync();
    } }, h('i'));
    const rows = [h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Share this library'), h('small', {}, 'Lets your other devices on this network or Tailscale sync with this app')), flip)];
    if (cf.enabled) {
      const lines = cf.addrs.length ? cf.addrs : [{ ip: '(address not found)', kind: '' }];
      rows.push(
        h('div', { class: 'sync-code' }, h('small', {}, 'Pairing code'), h('b', {}, cf.token)),
        ...lines.map((a) => h('button', { class: 'sync-addr', title: 'Copy address and code', onclick: async () => { await copyText(`${a.ip}:${cf.port} ${cf.token}`); toast('Copied. Paste it on your phone'); } },
          h('span', {}, `${a.ip}:${cf.port}`), h('small', {}, a.kind === 'tailscale' ? 'Tailscale' : a.kind === 'lan' ? 'Same Wi-Fi' : ''), h('i', { html: icon('copy', 14) }))),
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn', onclick: async () => { try { await syncNow(); } catch { /* toast shows it */ } } }, 'Sync now'),
          h('button', { class: 'btn', onclick: async () => { await hostConfig({ regen: true }); toast('New code made. Devices must re-enter it'); paintSync(); } }, 'New code')),
        h('div', { class: 'st-row' }, h('div', {}, h('b', {}, cf.credsArmed ? 'Login ready for the next device' : 'Login not offered'), h('small', {}, cf.credsArmed ? 'The next device to connect gets your usernames and API keys once. Then they are forgotten, and never sync again.' : 'Your logins stay on this computer. Offer them once for a new device if you want it signed in too.')),
          h('button', { class: 'btn', onclick: async () => { try { toast((await armCreds()) ? 'Login will go to the next device that connects' : 'There is no login saved to offer', { ms: 2600 }); } catch (e) { toast(e.message, { kind: 'err' }); } paintSync(); } }, cf.credsArmed ? 'Offer again' : 'Offer login')),
        cf.devices.length ? h('div', { class: 'st-note' }, 'Connected: ' + cf.devices.map((d) => `${d.name} (${d.ago < 90 ? 'just now' : Math.round(d.ago / 60) + ' min ago'})`).join(', ')) : h('div', { class: 'st-note' }, 'No device has connected yet.'),
        status,
        h('div', { class: 'st-note' }, 'The first time, Windows may ask to allow Board Roamer on the network. Allow it for private networks. Tailscale traffic is encrypted; on plain Wi-Fi the code protects access but the data is not encrypted, so prefer Tailscale on shared networks.'));
      watch();
    }
    rows.push(what);
    syncBox.replaceChildren(...rows);
  };
  paintSync();

  /* --- background (desktop app only) */
  const bgBox = h('div', { class: 'bg-box' });
  const paintBg = async () => {
    let c;
    try { c = await (await fetch('/app/config')).json(); } catch { c = null; }
    if (!c) return bgBox.replaceChildren(h('div', { class: 'st-note' }, 'Background options need the Board Roamer desktop app.'));
    const post = async (patch) => {
      try {
        const r = await fetch('/app/config', { method: 'POST', body: JSON.stringify(patch) });
        const j = await r.json();
        if (j.error) throw new Error(j.error);
      } catch (e) { toast(e.message, { kind: 'err' }); }
      paintBg();
    };
    const trayName = c.os === 'macos' ? 'the menu bar' : 'the system tray';
    const row = (title, hint, on, fn) => { const b = h('button', { class: 'tgl' + (on ? ' on' : ''), role: 'switch', onclick: fn }, h('i')); return h('div', { class: 'st-row' }, h('div', {}, h('b', {}, title), h('small', {}, hint)), b); };
    const modes = [['tray', 'Closed (in the tray)'], ['minimized', 'Minimized'], ['open', 'Open']];
    bgBox.replaceChildren(
      row('Keep running when the window is closed', c.tray ? `Board Roamer stays in ${trayName}, so your other devices can still sync with it. Quit from the tray icon.` : `Needs ${trayName}, which this system did not provide. Closing the window quits the app.`, c.background && c.tray, () => post({ background: !c.background })),
      row('Start when I sign in', 'Starts with your computer so syncing is ready before you open anything', c.autostart, () => post({ autostart: !c.autostart })),
      h('div', { class: 'st-row col' }, h('div', { class: 'st-line' }, h('b', {}, 'When it starts at sign-in'), h('small', {}, c.startMode === 'tray' && !c.tray ? 'No tray here, so it will start minimized' : 'How the window looks')),
        segmented(modes, c.startMode, (v) => post({ startMode: v }))));
  };
  paintBg();

  /* --- updates */
  const updBox = h('div', { class: 'upd-box' });
  offUpd?.();
  offUpd = onUpdate((u) => {
    const kids = [];
    kids.push(h('div', { class: 'upd-ver' }, h('b', {}, 'Board Roamer ' + (u.current || '…')), h('small', {}, [u.os, u.arch].filter(Boolean).join(' · '))));
    if (u.available) {
      kids.push(h('div', { class: 'upd-new' },
        h('b', {}, `Version ${u.latest.version} is available`),
        u.latest.published ? h('small', {}, ago(u.latest.published)) : null,
        u.latest.notes ? h('p', {}, u.latest.notes) : null,
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn primary', disabled: u.installing, onclick: () => installUpdate() }, u.installing ? (u.progress ? `Downloading… ${u.progress}%` : 'Working…') : 'Update now'),
          h('button', { class: 'btn', onclick: () => openExternal(u.latest.url) }, 'Release notes'))));
    } else if (u.latest && !u.checking && !u.error) {
      kids.push(h('div', { class: 'st-note' }, `You have the newest version${u.checked ? ` (checked ${ago(u.checked)})` : ''}.`));
    }
    if (u.checking) kids.push(h('div', { class: 'st-note' }, 'Checking GitHub…'));
    if (u.error) kids.push(h('div', { class: 'st-note upd-err' }, u.error));
    kids.push(h('div', { class: 'row-btns' },
      h('button', { class: 'btn', disabled: u.checking || u.installing, onclick: () => checkForUpdate({ force: true }) }, u.checking ? 'Checking…' : 'Check now'),
      h('button', { class: 'btn', onclick: () => openExternal(RELEASES_URL) }, 'All releases')));
    updBox.replaceChildren(...kids);
  });
  appInfo().then(() => checkForUpdate().catch(() => {}));

  /* --- starred */
  const starBox = h('div', { class: 'star-list' });
  const paintStars = () => {
    const list = S('starred') || [];
    starBox.replaceChildren(...(list.length ? list.map((x) => h('span', { class: `chip cat-${x.cat || 'general'} op-inc` },
      h('span', { class: 'op' }, '★'), h('span', { class: 'ct' }, x.t.replace(/_/g, ' ')),
      h('button', { class: 'x', title: 'Remove', html: icon('close', 11), onclick: () => { setS('starred', list.filter((y) => y !== x)); paintStars(); } }))) : [h('div', { class: 'st-note' }, 'Nothing starred yet. Star artists and tags from the viewer tag list or the card above the gallery. They appear when you focus the search box, and starred artists power the Following route.')]));
  };
  paintStars();

  /* --- blacklist */
  const ta = h('textarea', { class: 'input mono', rows: 6, spellcheck: 'false', placeholder: 'one rule per line, e.g.\ngore\nscat -rating:e\nscore:<-5\nwolf solo #blur\n# comments start with #', oninput: () => setS('blacklist', ta.value.split('\n')) });
  ta.value = S('blacklist').join('\n');

  const themeRow = h('div', { class: 'theme-row' }, THEMES.map(([id, name, bg, ac, hue]) => h('button', { class: 'theme-card' + (S('theme') === id ? ' on' : ''), style: `--tb:${bg};--ta:${ac}`, onclick: (e) => { setS('theme', id); setS('hue', hue); [...e.currentTarget.parentElement.children].forEach((c) => c.classList.toggle('on', c === e.currentTarget)); } }, h('i'), h('span', {}, name))));

  body.append(
    sec('source', 'Source', provBox, credBox,
      h('div', { class: 'st-row col' }, h('div', { class: 'st-line' }, h('b', {}, 'User-Agent'), h('small', {}, 'e621 asks for a descriptive one')),
        h('input', { class: 'input', value: S('ua'), placeholder: 'BoardRoamer/0.1 (by yourname on e621)', spellcheck: 'false', oninput: (e) => setS('ua', e.target.value.trim()) }))),
    sec('look', 'Look', themeRow, slider('Accent hue', 'hue', 0, 360, 1, (v) => v + '°'), toggle('Topographic backdrop', 'topo'), toggle('Film grain', 'grain'),
      seg('Tabs', 'tabs', [['off', 'Off'], ['auto', 'Auto'], ['always', 'Always']], 'Auto shows the tab bar once you open a second tab: right-click or long-press anything and choose Open in new tab, middle-click a section, or press Ctrl+T'),
      toggle('Reopen my tabs when the app starts', 'restoreTabs'),
      ...(isPhone() ? [] : [sectionTabs(), seg('Follows freshness', 'followsFresh', [[2, '2 min'], [10, '10 min'], [30, '30 min']], 'How old the last check can be before Follows looks for new posts again when you open or return to it')])),
    sec('gallery', 'Gallery',
      seg('Layout', 'layout', [['masonry', 'Masonry'], ['rows', 'Rows'], ['grid', 'Grid']]),
      slider('Tile size', 'density', 130, 520, 10, (v) => v + 'px'), slider('Gap', 'gap', 0, 28, 1, (v) => v + 'px'),
      seg('Thumbnails', 'thumbQ', [['sharp', 'Sharp'], ['fast', 'Fast']], 'Sharp loads the 850px sample on big tiles'),
      toggle('Always show stats on tiles', 'showMeta'), toggle('Blur thumbnails until hovered', 'blurThumbs', 'Handy in public')),
    (isTouch() || isPhone()) ? sec('phone', 'Phone & touch',
      seg('Columns', 'mobileCols', [[1, '1'], [2, '2'], [3, '3'], [4, '4']], 'In the gallery when the phone is upright. One more when sideways'),
      seg('Double-tap a picture', 'dtap', [['like', 'Like'], ['zoom', 'Zoom']], 'Like favorites and upvotes it. Triple-tap pins it. Pinch always zooms'),
      toggle('Haptic feedback', 'haptics', 'A small buzz on long-press and refresh'),
      toggle('Keep the screen on', 'keepAwake', 'While a video plays or a comic is open'),
      toggle('Cloak when I switch away', 'autoCloak', 'Shows the plain document the moment the app leaves the screen'),
      isAndroid() ? toggle('Privacy screen', 'privacyScreen', 'Hides the app in the app switcher and blocks screenshots') : null,
      h('div', { class: 'row-btns' }, h('button', { class: 'btn', onclick: () => (closeSettings(), setTimeout(showHelp, 280)) }, 'Gestures & shortcuts'))) : null,
    sec('viewer', 'Viewer',
      toggle('Load original after preview', 'fullOriginal', 'Turn off to save bandwidth'), toggle('Autoplay videos', 'autoplay'), toggle('Start videos muted', 'muted'),
      seg('Mouse wheel', 'wheel', [['zoom', 'Zoom'], ['nav', 'Next / prev']], 'Hold Ctrl for the other'),
      slider('Slideshow delay', 'slideshowSec', 2, 30, 1, (v) => v + 's')),
    sec('starred', 'Starred', starBox),
    sec('filters', 'Blacklist', ta,
      seg('Blacklisted posts', 'blacklistMode', [['veil', 'Veil'], ['hide', 'Hide'], ['off', 'Off']], 'Veil keeps a click-to-reveal placeholder'),
      h('div', { class: 'st-note' }, 'Rules match like e621: space-separated tags must all match, -tag must be absent. Also supports rating:e and score:<N. Put #blur at the end of a line to blur those posts instead of hiding them. They stay blurred until you tap reveal, even when blacklisted posts are set to Hide or Off.')),
    sec('sync', 'Sync', syncBox),
    isNative() && !isAndroid() ? sec('background', 'Background', bgBox) : null,
    sec('updates', 'Updates', updBox, toggle('Check for updates automatically', 'autoUpdate', 'Looks at this project’s GitHub releases when the app opens. Nothing is installed without your say-so')),
    sec('data', 'Data',
      toggle('Embed tags & source in saved files', 'embedMeta', 'Artist, tags, post link and the site’s MD5 go inside the image or video (XMP), so it can always be traced back'),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn', onclick: () => download('board-roamer-backup.json', exportAll()) }, 'Export backup'),
        h('button', { class: 'btn', onclick: async () => { const f = await pickFile('.json'); if (!f) return; try { importAll(await f.text()); toast('Imported — reloading…'); setTimeout(() => location.reload(), 700); } catch (e) { toast(e.message, { kind: 'err' }); } } }, 'Import backup'),
        h('button', { class: 'btn', onclick: () => fetch('/open?reveal=downloads', { method: 'POST' }) }, 'Downloads folder')),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn', onclick: () => (wipe('tags'), toast('Tag memory cleared')) }, 'Forget tag info'),
        h('button', { class: 'btn', onclick: () => (wipe('trail'), toast('Trail cleared')) }, 'Clear trail'),
        h('button', { class: 'btn danger', onclick: () => { Object.keys(DEFAULTS).forEach((k) => k !== 'creds' && k !== 'blacklist' && setS(k, structuredClone(DEFAULTS[k]))); toast('Settings reset — reloading…'); setTimeout(() => location.reload(), 700); } }, 'Reset settings'))),
  );

  paintCreds();
  panel = h('aside', { class: 'settings' },
    h('div', { class: 'st-head' }, h('h2', {}, 'Settings'), h('button', { class: 'ibtn', html: icon('close', 18), onclick: closeSettings })),
    h('nav', { class: 'st-nav' }, ['source', 'look', 'gallery', ...((isTouch() || isPhone()) ? ['phone'] : []), 'viewer', 'starred', 'filters', 'sync', ...(isNative() && !isAndroid() ? ['background'] : []), 'updates', 'data'].map((s) => h('button', { onclick: () => document.getElementById('st-' + s)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, s === 'filters' ? 'blacklist' : s))),
    body);
  document.body.append(panel);
  requestAnimationFrame(() => panel?.classList.add('in'));
  if (section) setTimeout(() => document.getElementById('st-' + section)?.scrollIntoView(), 50);
}

/* ------------------------------------------------------------------ shortcuts sheet */
const SHORTCUTS = [
  ['Everywhere', [['/', 'Focus the search'], ['1 – 5', 'Roam · Boards · Follows · Pools · Trail'], [',', 'Settings'], ['Ctrl+T', 'New tab'], ['Ctrl+W', 'Close tab'], ['Ctrl+Tab', 'Next tab (Ctrl+Shift+Tab: previous)'], ['Ctrl+Shift+T', 'Reopen closed tab'], ['Middle-click', 'Open a section or card in a new tab'], ['`', 'Cloak the screen (panic)'], ['?', 'This sheet'], ['Right-click', 'Menu for whatever is under the pointer']]],
  ['Gallery', [['Click', 'Open in viewer'], ['Arrows + Enter', 'Move and open'], ['Ctrl / Shift click', 'Select (range)'], ['Middle click', 'Open on site'], ['S', 'Toggle selection mode'], ['Esc', 'Leave selection']]],
  ['Viewer', [['← → / A D / J K', 'Previous / next'], ['PgUp / PgDn', 'Previous / next page in the pool'], ['Home / End', 'First / last'], ['Scroll / + −', 'Zoom (smooth)'], ['Z / double-click', 'Fit ⇄ 100%'], ['0', 'Reset view'], ['R', 'Rotate'], ['F', 'True fullscreen'], ['P', 'Slideshow']]],
  ['Viewer actions', [['B', 'Pin to a board'], ['V', 'Favorite'], ['U', 'Upvote'], ['S', 'Save to Downloads'], ['C', 'Copy link'], ['O', 'Open on site'], ['I', 'Info panel'], ['T', 'Filmstrip']]],
  ['Video', [['Space / click', 'Play · pause'], ['Shift + ← →', 'Seek 5 seconds'], ['↑ ↓', 'Volume'], ['M', 'Mute'], ['L', 'Loop'], [', .', 'Step one frame'], ['[ ]', 'Slower · faster'], ['Double-click', 'Fullscreen']]],
  ['Comic reader', [['← → (or A D)', 'Turn page — flips for manga'], ['Space / Shift+Space', 'Next / previous'], ['1 2 3', 'One page · two pages · scroll'], ['R', 'Reading direction'], ['C', 'First page alone'], ['W', 'Cycle fit'], ['+ − 0', 'Zoom'], ['G', 'Go to page'], ['T', 'Thumbnails'], ['F', 'Fullscreen'], ['V', 'Open page in viewer']]],
  ['Search', [['Space / Enter', 'Turn text into a chip'], ['-tag', 'Exclude'], ['~tag', 'Match any of'], ['Tab', 'Take first suggestion'], ['Backspace', 'Remove last chip'], ['Double-click chip', 'Edit it']]],
];

const GESTURES = [
  ['Gallery', [['Tap', 'Open a post'], ['Long-press', 'Menu: pin, save, share, follow…'], ['Pull down', 'Run the search again'], ['Long-press → Select', 'Then tap to pick several']]],
  ['Viewer', [['Swipe sideways', 'Previous / next'], ['Swipe down', 'Close'], ['Swipe up', 'Info, tags and boards'], ['Pinch', 'Zoom in and out'], ['Double-tap', 'Like: favorite + upvote (or zoom, in Settings)'], ['Triple-tap', 'Quick pin'], ['Tap', 'Hide / show the controls']]],
  ['Video', [['Double-tap the sides', 'Back / forward 10 s'], ['Double-tap the middle', 'Play · pause'], ['Tap', 'Show the controls'], ['⛶ button', 'Fullscreen, turns sideways']]],
  ['Comic reader', [['Tap the sides', 'Turn the page'], ['Swipe sideways', 'Turn the page'], ['Pinch · double-tap', 'Zoom, then drag to look around'], ['Tap the middle', 'Controls'], ['Layout button', 'One page · two pages · scroll']]],
  ['Everywhere', [['Back button', 'Closes the top layer, then goes back'], ['Double-tap the cloak', 'Leave the plain-document screen']]],
];

export function showHelp() {
  const back = h('div', { class: 'help-back', onpointerdown: (e) => e.target === back && close() });
  const close = () => { back.classList.remove('in'); setTimeout(() => back.remove(), 200); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); close(); } };
  const groups = (list) => h('div', { class: 'help-grid' }, list.map(([t, rows]) => h('div', {}, h('h4', {}, t), rows.map(([k, d]) => h('div', { class: 'hk' }, h('kbd', {}, k), h('span', {}, d))))));
  const touch = isTouch() || isPhone();
  back.append(h('div', { class: 'help cut' },
    h('div', { class: 'help-head' }, h('h2', {}, touch ? 'Gestures' : 'Keyboard'), touch ? h('button', { class: 'ibtn', 'aria-label': 'Close', onclick: close, html: icon('close', 20) }) : null),
    touch ? groups(GESTURES) : groups(SHORTCUTS),
    touch ? h('details', { class: 'help-kb' }, h('summary', {}, 'Hardware keyboard shortcuts'), groups(SHORTCUTS)) : null,
  ));
  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => back.classList.add('in'));
}
