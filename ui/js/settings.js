import { h, download, pickFile, copyText, ago } from './util.js';
import { RELEASES_URL } from './version.js';
import { syncConfig, isPaired, unpair, pairWith, parseKey, parseLink, connectionAdvice, ping, syncNow, onSyncStatus, hostConfig, armCreds, claimCreds } from './sync.js';
import { scanQr } from './qrscan.js';
import { icon } from './icons.js';
import { faSupported } from './fa.js';
import { faSettingsBox } from './fapage.js';
import { S, setS, exportAll, importAll, wipe, DEFAULTS, subs, saved } from './store.js';
import { providerList, getProvider, call } from './providers.js';
import { segmented, toast, confirmDlg, dialog } from './ui.js';
import { sendTest } from './notify.js';
import { devices } from './local.js';
import { reveal, openExternal } from './actions.js';
import { checkForUpdate, installUpdate, onUpdate, appInfo } from './updates.js';
import { isPhone, isTouch, isAndroid, native } from './platform.js';
import { isNative } from './titlebar.js';

let panel = null;

const THEMES = [['night', 'Night Survey', '#0a1113', '#c8ff3d', 128], ['paper', 'Paper Chart', '#ece5d3', '#e8431c', 35], ['violet', 'Ultraviolet', '#0d0a18', '#ff5fd2', 335]];

let offStatus = null, offUpd = null, offKey = null;
export function closeSettings() {
  if (!panel) return;
  offStatus?.();
  offUpd?.();
  offKey?.();
  offKey = null;
  const p = panel;
  panel = null;
  p.classList.remove('in');
  setTimeout(() => p.remove(), 260);
}

export function openSettings(section) {
  if (panel) return closeSettings();
  const body = h('div', { class: 'st-body' });
  const sec = (id, title, ...kids) => h('section', { class: 'st-sec', id: 'st-' + id }, h('h3', {}, title), kids);
  const toggle = (label, key, hint, after) => {
    const b = h('button', { class: 'tgl' + (S(key) ? ' on' : ''), role: 'switch', onclick: () => { setS(key, !S(key)); b.classList.toggle('on', S(key)); after?.(S(key)); } }, h('i'));
    return h('div', { class: 'st-row' }, h('div', {}, h('b', {}, label), hint ? h('small', {}, hint) : null), b);
  };
  const slider = (label, key, min, max, step, fmt = (v) => v) => {
    const out = h('output', {}, fmt(S(key)));
    const i = h('input', { type: 'range', min, max, step, value: S(key), oninput: () => { setS(key, +i.value); out.textContent = fmt(+i.value); } });
    return h('div', { class: 'st-row col' }, h('div', { class: 'st-line' }, h('b', {}, label), out), i);
  };
  const savedNote = h('div', { class: 'st-note' });
  const refreshSavedNote = () => {
    const n = saved.count(), kb = saved.bytes() / 1024;
    savedNote.textContent = n ? `${n.toLocaleString()} saved post${n === 1 ? '' : 's'} remembered, using ${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB on this device.` : 'No saved posts remembered yet.';
  };
  refreshSavedNote();
  const seg = (label, key, opts, hint) => h('div', { class: 'st-row col' }, h('div', { class: 'st-line' }, h('b', {}, label), hint ? h('small', {}, hint) : null), segmented(opts, S(key), (v) => setS(key, v)));

  /* --- local files */
  const localBox = h('div', { class: 'st-local' });
  const localApi = async (patch = {}) => {
    const q = new URLSearchParams();
    if (patch.share != null) q.set('share', patch.share ? '1' : '0');
    if (patch.add) (q.set('add', patch.add.path), patch.add.name && q.set('name', patch.add.name));
    if (patch.remove) q.set('remove', patch.remove);
    return (await fetch('/local/config' + (q.toString() ? '?' + q : ''))).json();
  };
  const pickFolder = async () => {
    const view = { path: '' };
    const body = h('div', { class: 'lpick' });
    const draw = async (path) => {
      const j = await (await fetch('/local/dirs?path=' + encodeURIComponent(path))).json().catch(() => ({}));
      if (j.error) return toast(j.error, { kind: 'err' });
      view.path = j.path || '';
      const entry = (label, p, ic = 'folder') => h('button', { onclick: () => draw(p) }, h('i', { html: icon(ic, 15) }), h('span', {}, label));
      body.replaceChildren(
        h('div', { class: 'lpick-path' }, view.path || 'Choose a place to start'),
        h('div', { class: 'lpick-list' },
          view.path ? entry('Up one level', j.parent || '', 'up') : null,
          ...(j.places || []).map((pl) => entry(pl.name, pl.path)),
          ...(j.dirs || []).map((d) => entry(d.name, d.path))));
    };
    await draw('');
    const pick = await dialog({ title: 'Choose a folder', body, actions: [{ label: 'Cancel', value: null }, { label: 'Use this folder', value: true, cls: 'primary' }] });
    return pick && view.path ? view.path : null;
  };
  const paintLocal = async () => {
    const c = await localApi().catch(() => null);
    if (!c) return localBox.replaceChildren(h('div', { class: 'st-note' }, 'Local files need the desktop or Android app.'));
    const needsAccess = isAndroid() && !native.localAccess();
    localBox.replaceChildren(
      needsAccess ? h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Allow access to files'), h('small', {}, 'Android needs your OK to read folders outside the app. Grant “All files access”, then come back')),
        h('button', { class: 'btn primary', onclick: () => { native.requestLocalAccess(); toast('Turn on access, then return here', { ms: 3200 }); } }, 'Allow')) : null,
      h('div', { class: 'lroots' }, c.roots.length ? c.roots.map((r) => h('div', { class: 'lroot' }, h('i', { html: icon('folder', 16) }), h('b', {}, r.name), h('small', {}, r.ok ? r.path : r.path + ' (missing)'),
        h('button', { class: 'ibtn', title: 'Stop using this folder', html: icon('close', 15), onclick: async () => { await localApi({ remove: r.id }); paintLocal(); } }))) : [h('div', { class: 'st-note' }, 'No folders yet. Add your Pictures folder, or any folder, or the whole storage. Subfolders show up like boards.')]),
      h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Add a folder'), h('small', {}, 'Folders inside it appear as boards of their own')),
        h('button', { class: 'btn', html: icon('plus', 16) + '<span>Choose…</span>', onclick: async () => { const p = await pickFolder(); if (p) { await localApi({ add: { path: p } }); paintLocal(); } } })),
      c.quick.length ? h('div', { class: 'f-chips' }, c.quick.filter((q) => !c.roots.some((r) => r.path === q.path)).map((q) => h('button', { class: 'chip', onclick: async () => { await localApi({ add: { path: q.path, name: q.name } }); paintLocal(); } }, '+ ' + q.name))) : null,
      h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Let my other devices browse these folders'), h('small', {}, 'Needs sync set up (it uses the same pairing code). Read-only, and only while Board Roamer is open here')),
        (() => { const b = h('button', { class: 'tgl' + (c.share ? ' on' : ''), role: 'switch', onclick: async () => { const n = await localApi({ share: !b.classList.contains('on') }); b.classList.toggle('on', n.share); } }, h('i')); return b; })()));
  };
  paintLocal();

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
    const label = p.engine === 'gb' ? ['User ID', 'API key'] : p.engine === 'pm' ? ['Username (optional)', 'API key (optional)'] : ['Username', 'API key'];
    const user = h('input', { class: 'input', placeholder: label[0], value: c.user || '', spellcheck: 'false', oninput: save });
    const key = h('input', { class: 'input', placeholder: label[1], type: 'password', value: c.key || '', spellcheck: 'false', oninput: save });
    const help = { e621: 'e621.net → Account → Manage API Access', e926: 'Same account and key as e621', danbooru: 'Danbooru → My Account → API Key', gelbooru: 'gelbooru.com → Settings → Options → API Access Credentials', safebooru: 'Not needed', derpibooru: 'Optional. derpibooru.org → Account → Settings → API key. With a key your own filter applies; without one everything shows and the rating switches decide' }[p.id];
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
    const TAILSCALE = 'https://tailscale.com/download';
    if (isAndroid()) {
      const c = syncConfig();
      const finish = async (host) => {
        toast('Paired with ' + host);
        // first connection only: the computer can hand over its logins once, over the encrypted connection. They never travel with normal syncing.
        try { if (await claimCreds()) toast('Copied your login from the computer', { ms: 2600 }); } catch { /* the library can still sync */ }
        try { await syncNow(); } catch { /* shown as a toast */ }
      };
      const run = async (btn, job) => {
        btn.disabled = true;
        try { await finish(await job()); } catch (e) { toast(e.message, { kind: 'err' }); }
        btn.disabled = false;
        paintSync();
      };
      const scan = h('button', { class: 'btn primary', onclick: () => run(scan, async () => {
        const text = await scanQr();
        if (text == null) throw new Error('Cancelled');
        if (!parseLink(text)) throw new Error('That is not the pairing code from Board Roamer on your computer');
        return pairWith({ link: text });
      }) }, isPaired() ? 'Pair with another computer' : 'Scan the code on your computer');
      const parts = [
        h('div', { class: 'st-note' }, isPaired()
          ? `Paired with ${c.host || 'your computer'}. It is found automatically on your home network.`
          : c.old ? 'Sync now pairs with a QR code and is encrypted, so this phone has to be paired again. On your computer open Settings → Sync and choose Add a phone, then scan the code.'
            : 'On your computer open Settings → Sync, turn on sharing and choose Add a phone. Then scan the code it shows.'),
        h('div', { class: 'row-btns' }, scan,
          isPaired() ? h('button', { class: 'btn', onclick: async () => { try { await syncNow(); } catch { /* shown as a toast */ } } }, 'Sync now') : null,
          isPaired() ? h('button', { class: 'btn danger', onclick: () => { unpair(); paintSync(); } }, 'Forget this computer') : null)];
      // can't scan? the same pairing by typing the code, picking the computer from the ones found on this network
      let pick = null, adviceFn = null;
      const key = h('input', { class: 'input mono', placeholder: 'ABCD-EFGH-JKLM-NPQR', spellcheck: 'false', autocapitalize: 'characters', autocomplete: 'off' });
      const addr = h('input', { class: 'input', placeholder: 'Address, only if it is not found (192.168.1.20:4622)', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', inputmode: 'url' });
      const found = h('div', { class: 'pair-found' }, h('small', { class: 'st-note' }, 'Looking for computers on this network…'));
      const typed = h('button', { class: 'btn', onclick: () => {
        const k = parseKey(key.value);
        if (!k) return toast('Type the 16-character code from your computer', { kind: 'err' });
        if (!pick && !addr.value.trim()) return toast('Choose your computer from the list, or type its address', { kind: 'err' });
        run(typed, () => pairWith({ key: k, address: addr.value.trim(), found: pick }));
      } }, 'Pair with this code');
      parts.push(h('details', { class: 'st-more' }, h('summary', {}, 'Can\u2019t scan? Type the code instead'), found, key, addr, h('div', { class: 'row-btns' }, typed)));
      native.discoverHubs(2500).then(({ hubs }) => {
        if (!found.isConnected) return;
        if (!hubs.length) return found.replaceChildren(h('small', { class: 'st-note' }, 'No computer answered on this network. You can still scan its code, or type its address.'));
        if (hubs.length === 1) pick = hubs[0];
        const chips = hubs.map((x) => { const b = h('button', { class: 'chip' + (pick === x ? ' on' : ''), onclick: () => { pick = x; chips.forEach((c2) => c2.classList.toggle('on', c2 === b)); } }, x.name); return b; });
        found.replaceChildren(...chips);
        found.append(h('small', { class: 'st-note' }, hubs.length > 1 ? 'More than one computer is sharing here. Choose yours; it still needs its own code.' : 'Found on this network. It still needs its code.'));
      });
      if (isPaired()) {
        parts.push(h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Sync automatically'), h('small', {}, 'When the app opens and after you change something')),
          (() => { const b = h('button', { class: 'tgl' + (c.auto ? ' on' : ''), role: 'switch', onclick: () => { setSyncConfig({ auto: !syncConfig().auto }); b.classList.toggle('on', syncConfig().auto); } }, h('i')); return b; })()));
        parts.push(status);
        const adv = h('div', { class: 'st-note' });
        const paintAdvice = (st) => {
          if (!st.error) return adv.replaceChildren();
          const a = connectionAdvice();
          adv.replaceChildren(a.text, ' ', a.kind !== 'none' ? h('button', { class: 'btn', onclick: () => openExternal(TAILSCALE) }, 'Get Tailscale') : '');
        };
        parts.push(adv);
        adviceFn = paintAdvice;
      }
      parts.push(what);
      syncBox.replaceChildren(...parts);
      if (isPaired()) {
        watch();
        const off = offStatus, stop = onSyncStatus(adviceFn);
        offStatus = () => { off?.(); stop(); };
      }
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
    const rows = [h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Share this library'), h('small', {}, 'Lets your phones sync with this app. Same Wi-Fi at home; with Tailscale, anywhere')), flip)];
    if (cf.enabled) {
      const name = h('input', { class: 'input', value: cf.host, maxlength: '40', spellcheck: 'false', onchange: async () => { try { await hostConfig({ name: name.value }); toast('Phones will see this computer as ' + (name.value.trim() || cf.computer)); } catch (e) { toast(e.message, { kind: 'err' }); } } });
      rows.push(h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Name shown on phones'), h('small', {}, 'Helps phones tell computers apart on a shared network')), name));
      if (cf.offer) {
        const left = h('small', {}, '');
        const qr = h('div', { class: 'pair-qr' },
          h('img', { alt: 'Pairing code', src: '/sync/qr?t=' + Date.now() }),
          h('div', { class: 'pair-txt' },
            h('div', { style: 'font-weight:700' }, 'Scan this with Board Roamer on your phone'),
            h('small', {}, 'Settings → Sync → Scan the code on your computer. The code works once.'),
            h('small', {}, 'Cannot scan? Type this on the phone:'),
            h('b', {}, cf.offer.key),
            left,
            h('div', { class: 'row-btns' },
              h('button', { class: 'btn', onclick: async () => { await copyText(cf.offer.link); toast('Pairing link copied'); } }, 'Copy pairing link'),
              h('button', { class: 'btn', onclick: async () => { await hostConfig({ cancelPair: true }); paintSync(); } }, 'Cancel'))));
        rows.push(qr);
        let left_s = cf.offer.expiresIn;
        const known = cf.devices.length;
        const tick = setInterval(async () => {
          if (!qr.isConnected) return clearInterval(tick);
          left_s -= 2;
          left.textContent = left_s > 0 ? `Valid for another ${Math.ceil(left_s / 60)} min` : 'Expired';
          try {
            const n = await hostConfig();
            if (!n.offer || n.devices.length !== known) {
              clearInterval(tick);
              if (n.devices.length > known) toast('Paired with ' + n.devices[n.devices.length - 1].name);
              paintSync();
            }
          } catch { /* the app is closing */ }
        }, 2000);
        left.textContent = `Valid for another ${Math.ceil(left_s / 60)} min`;
      } else {
        rows.push(h('div', { class: 'row-btns' }, h('button', { class: 'btn primary', onclick: async () => { try { await hostConfig({ pair: true }); } catch (e) { toast(e.message, { kind: 'err' }); } paintSync(); } }, 'Add a phone')));
      }
      if (cf.devices.length) {
        rows.push(h('div', { class: 'st-note' }, 'Paired phones'));
        for (const d of cf.devices) {
          rows.push(h('div', { class: 'st-row' }, h('div', {}, h('b', {}, d.name), h('small', {}, d.ago == null ? 'Not seen since sharing started' : d.ago < 90 ? 'Connected just now' : `Last seen ${Math.round(d.ago / 60)} min ago`)),
            h('button', { class: 'btn danger', onclick: async () => { if (await confirmDlg('Unpair ' + d.name + '?', 'It stops syncing with this computer until you pair it again with a new code.', 'Unpair')) { await hostConfig({ revoke: d.id }); paintSync(); } } }, 'Unpair')));
        }
        if (cf.devices.length > 1) rows.push(h('div', { class: 'row-btns' }, h('button', { class: 'btn danger', onclick: async () => { if (await confirmDlg('Unpair all phones?', 'Every phone has to be paired again with a new code.', 'Unpair all')) { await hostConfig({ revokeAll: true }); paintSync(); } } }, 'Unpair all')));
      } else if (!cf.offer) rows.push(h('div', { class: 'st-note' }, 'No phone is paired yet.'));
      rows.push(
        h('div', { class: 'st-row' }, h('div', {}, h('b', {}, cf.credsArmed ? 'Login ready for the next phone' : 'Login not offered'), h('small', {}, cf.credsArmed ? 'The next phone to pair gets your usernames and API keys once, over the encrypted connection. Then they are forgotten, and never sync again.' : 'Your logins stay on this computer. Offer them once for a new phone if you want it signed in too.')),
          h('button', { class: 'btn', onclick: async () => { try { toast((await armCreds()) ? 'Login will go to the next phone that pairs' : 'There is no login saved to offer', { ms: 2600 }); } catch (e) { toast(e.message, { kind: 'err' }); } paintSync(); } }, cf.credsArmed ? 'Offer again' : 'Offer login')),
        h('div', { class: 'row-btns' }, h('button', { class: 'btn', onclick: async () => { try { await syncNow(); } catch { /* toast shows it */ } } }, 'Sync now')),
        cf.tailscale ? h('div', { class: 'st-note' }, 'Tailscale is on this computer, so paired phones that also have Tailscale can sync from anywhere.')
          : h('div', { class: 'st-note' }, 'To sync away from home, install Tailscale (free) on this computer and your phone. Paired phones then find this computer by themselves. ', h('button', { class: 'btn', onclick: () => openExternal(TAILSCALE) }, 'Get Tailscale')),
        h('div', { class: 'st-note' }, cf.addrs.length ? 'This computer: ' + cf.addrs.map((a) => `${a.ip}:${cf.port}`).join(', ') : 'No network address found.'),
        status,
        h('div', { class: 'st-note' }, 'The connection is encrypted, and each phone only trusts this computer\u2019s own certificate. The first time, Windows may ask to allow Board Roamer on the network: allow it for private networks. Another computer with Board Roamer on the same network is not a problem: each one needs its own code.'));
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
      seg('Home screen', 'homeView', [['feed', 'Feed'], ['roam', 'Roam'], ['follows', 'Follows'], ['boards', 'Boards'], ['pools', 'Pools'], ['trail', 'Trail']], 'Where Board Roamer opens. Applies on this device'),
      seg('Tabs', 'tabs', [['off', 'Off'], ['auto', 'Auto'], ['always', 'Always']], 'Auto shows the tab bar once you open a second tab: right-click or long-press anything and choose Open in new tab, middle-click a section, or press Ctrl+T'),
      toggle('Reopen my tabs when the app starts', 'restoreTabs'),
      ...(isPhone() ? [] : [toggle('Pinned Main tab', 'mainTab', 'The first tab is your home: Feed, Roam, Follows, Boards, Pools and Trail open there. Artists, boards and pools you open from it get their own tabs'), seg('Follows freshness', 'followsFresh', [[2, '2 min'], [10, '10 min'], [30, '30 min']], 'How old the last check can be before Follows looks for new posts again when you open or return to it')]),
      toggle('New-post counters on live boards', 'boardCounters', 'The “N new” mark on live board cards, on their chips above the gallery, and the count next to Boards. To hide it for just one board, right-click or long-press that board')),
    sec('notifications', 'Notifications',
      toggle('Notify me about new content', 'notify', 'A system notification when a check finds something new while the app is in the background. Words only, never a picture', async (on) => {
        if (!on) return;
        if (isAndroid() && !native.notifyAllowed()) { native.requestNotify(); toast('Allow notifications in the prompt, then press the test button', { ms: 3600 }); }
        if (S('notifyNames') || subs.all().length === 0) return;
        const names = await dialog({
          title: 'Name artists in notifications?',
          body: [h('p', { class: 'dlg-text' }, 'Notifications can say “New posts from your follows”, or name who posted: “New posts from {artist}”.'),
            h('p', { class: 'dlg-text' }, 'Names can show on a lock screen or in a screen share. You can change this any time here.')],
          actions: [{ label: 'Keep it generic', value: false }, { label: 'Show names', value: true, cls: 'primary' }],
        });
        if (names) setS('notifyNames', true);
      }),
      toggle('Follows', 'notifyFollows', 'New posts from artists you follow'),
      toggle('Live boards', 'notifyBoards', 'New posts matching a live board’s search'),
      toggle('Pools', 'notifyPools', 'New pages in saved pools and comics'),
      toggle('Show artist names', 'notifyNames', 'Off: “New posts from your follows”. On: “New posts from {artist}”. Boards and pools never name themselves'),
      h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Try it'), h('small', {}, isAndroid() ? 'On the lock screen, only “New activity” is shown' : 'Sends a notification now. Checks run about every 30 minutes while the app is open')),
        h('button', { class: 'btn', onclick: () => (isAndroid() && !native.notifyAllowed() ? (native.requestNotify(), toast('Allow notifications first', { ms: 2400 })) : sendTest()) }, 'Send a test'))),
    sec('local', 'Local',
      toggle('Local files', 'localOn', 'A gallery of the pictures and videos in folders you choose, on this device and on the other devices you sync with. Nothing is copied or changed, and tags stay in Board Roamer'),
      localBox),
    faSupported() ? sec('fa', 'Fur Affinity',
      toggle('Fur Affinity section', 'faOn', 'A separate place to browse furaffinity.net with the gallery, viewer, follows and filters you already know. It reads the site slowly, one request a second, and never uses its search, watch feed or notes'),
      toggle('Check followed artists in the background', 'faFollowCheck', 'Off by default so nothing is requested from Fur Affinity unless you ask. Checks pause while the site is busy'),
      seg('Check each artist about every', 'faFollowEvery', [[30, '30 min'], [60, 'Hour'], [180, '3 hours']], 'A few artists at a time, a second apart, so the site never gets a burst. Pictures and results are kept on this device, so opening Following asks the site for nothing'),
      faSettingsBox()) : null,
    sec('gallery', 'Gallery',
      seg('Layout', 'layout', [['masonry', 'Masonry'], ['rows', 'Rows'], ['grid', 'Grid']]),
      slider('Tile size', 'density', 130, 520, 10, (v) => v + 'px'), slider('Gap', 'gap', 0, 28, 1, (v) => v + 'px'),
      seg('Thumbnails', 'thumbQ', [['sharp', 'Sharp'], ['fast', 'Fast']], 'Sharp loads the 850px sample on big tiles'),
      toggle('Always show stats on tiles', 'showMeta'), toggle('Blur thumbnails until hovered', 'blurThumbs', 'Handy in public')),
    isAndroid() ? sec('links', 'Links',
      toggle('Open booru links in Board Roamer', 'openLinks', 'Links to posts, searches and pools on e621, e926, Danbooru, Gelbooru, Safebooru and Derpibooru offer Board Roamer. You can also paste any of them into the search box'),
      h('div', { class: 'st-row' }, h('div', {}, h('b', {}, 'Make it the default'), h('small', {}, 'Android only opens links straight in an app once you allow it: turn on “Open supported links” on the screen this opens')),
        h('button', { class: 'btn', onclick: () => native.openLinkSettings() }, 'Open settings'))) : null,
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
      seg('Opening a post', 'lightbox', [['classic', 'Viewer'], ['feed', 'Feed style']], 'Feed style shows it full screen like the Feed, one post at a time. Pools, comics and slideshows always use the viewer'),
      seg('Viewer scrolls', 'lightboxScroll', [['horizontal', 'Sideways'], ['vertical', 'Up / down']], 'Which way you swipe, drag or press the arrow keys to reach the next post'),
      seg('Mouse wheel', 'wheel', [['zoom', 'Zoom'], ['nav', 'Next / prev']], 'Hold Ctrl for the other'),
      slider('Slideshow delay', 'slideshowSec', 2, 30, 1, (v) => v + 's')),
    sec('starred', 'Starred', starBox),
    sec('filters', 'Blacklist', ta,
      seg('Blacklisted posts', 'blacklistMode', [['veil', 'Veil'], ['hide', 'Hide'], ['off', 'Off']], 'Veil keeps a click-to-reveal placeholder'),
      h('div', { class: 'st-note' }, 'Rules match like e621: space-separated tags must all match, -tag must be absent. Also supports rating:e and score:<N. Put #blur at the end of a line to blur those posts instead of hiding them. They stay blurred until you tap reveal, even when blacklisted posts are set to Hide or Off.'),
      seg('Comics and pools: "mostly"', 'poolMostly', [[50, 'Over half'], [66, 'Over 2/3'], [80, 'Over 80%']], 'How many of its pages must match before a pool counts as made of that. Then it is hidden (or veiled) in the pool list, or, for a #blur rule, it says so and offers one button that unblurs every page'),
      seg('Comics and pools: blurred-pages warning', 'poolWarn', [[1, 'Any page'], [15, '15%'], [30, '30%']], 'From this share of #blur pages a pool is flagged as having blurred pages. Fewer than that are just blurred one by one'),
      h('div', { class: 'st-note' }, 'One page you don’t like never hides a whole comic: hide rules only take a pool out of the list when most of its pages match, and the matching pages are still veiled or hidden on their own.')),
    sec('sync', 'Sync', syncBox),
    isNative() && !isAndroid() ? sec('background', 'Background', bgBox) : null,
    sec('updates', 'Updates', updBox, toggle('Check for updates automatically', 'autoUpdate', 'Looks at this project’s GitHub releases when the app opens. Nothing is installed without your say-so')),
    sec('data', 'Data',
      toggle('Embed tags & source in saved files', 'embedMeta', 'Artist, tags, post link and the site’s MD5 go inside the image or video (XMP), so it can always be traced back'),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn', onclick: () => download('board-roamer-backup.json', exportAll()) }, 'Export backup'),
        h('button', { class: 'btn', onclick: async () => { const f = await pickFile('.json'); if (!f) return; try { importAll(await f.text()); toast('Imported — reloading…'); setTimeout(() => location.reload(), 700); } catch (e) { toast(e.message, { kind: 'err' }); } } }, 'Import backup'),
        h('button', { class: 'btn', onclick: () => fetch('/open?reveal=downloads', { method: 'POST' }) }, 'Downloads folder')),
      h('div', { class: 'st-row col' }, h('div', { class: 'st-line' }, h('b', {}, 'Remember what you saved'), h('small', {}, 'Posts you saved to Downloads get a small mark in galleries. The list is only post numbers, so keeping it costs next to nothing')), segmented([['never', 'Keep it'], ['monthly', 'Forget after a month']], S('savedClear'), (v) => { setS('savedClear', v); saved.prune(); refreshSavedNote(); })),
      savedNote,
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn', onclick: () => (wipe('tags'), toast('Tag memory cleared')) }, 'Forget tag info'),
        h('button', { class: 'btn', onclick: () => { saved.clear(); refreshSavedNote(); toast('Saved-posts memory cleared'); } }, 'Forget saved posts'),
        h('button', { class: 'btn', onclick: () => (wipe('trail'), toast('Trail cleared')) }, 'Clear trail'),
        h('button', { class: 'btn danger', onclick: () => { Object.keys(DEFAULTS).forEach((k) => k !== 'creds' && k !== 'blacklist' && setS(k, structuredClone(DEFAULTS[k]))); toast('Settings reset — reloading…'); setTimeout(() => location.reload(), 700); } }, 'Reset settings'))),
  );

  paintCreds();

  /* --- categories: a menu of areas, each one a page holding everything for that area */
  const phone = isPhone();
  const CATS = [
    ['sources', 'Sources', 'Booru site and logins, Fur Affinity, local folders', ['source', 'fa', 'local']],
    ['look', 'Look & layout', 'Theme, home screen, tabs, gallery', ['look', 'gallery']],
    ['viewer', 'Viewer', 'Videos, zoom, scrolling, how a post opens', ['viewer']],
    ['filters', 'Blacklist & starred', 'Hidden tags and rules, starred artists and tags', ['filters', 'starred']],
    ['notifications', 'Notifications', 'New posts from follows, boards and pools', ['notifications']],
    ['device', 'This device', 'Touch, privacy, links, running in the background', ['phone', 'links', 'background']],
    ['sync', 'Sync', 'Pair your phone and computer', ['sync']],
    ['updates', 'Updates', 'Version and update checks', ['updates']],
    ['data', 'Data & backup', 'Backups, saved files, reset', ['data']],
  ];
  const secEl = (id) => body.querySelector('#st-' + id);
  const cats = CATS.map(([id, title, hint, ids]) => ({ id, title, hint, secs: ids.map(secEl).filter(Boolean) })).filter((c) => c.secs.length);
  cats.forEach((c) => c.secs.forEach((e) => body.append(e)));
  const catOf = (secId) => cats.find((c) => c.secs.some((e) => e.id === 'st-' + secId));
  let cur = null;
  const title = h('h2', {}, 'Settings');
  const back = h('button', { class: 'ibtn st-back', 'aria-label': 'Back to Settings', html: icon('left', 20), onclick: () => show(null) });
  const items = cats.map((c) => h('button', { class: 'st-item', onclick: () => show(c.id) }, h('div', {}, h('b', {}, c.title), h('small', {}, c.hint)), h('i', { class: 'st-chev', html: icon('right', 16) })));
  const menu = h('nav', { class: 'st-menu' }, items);
  const show = (id, scrollTo) => {
    cur = id || (phone ? null : cats[0].id);
    const c = cats.find((x) => x.id === cur);
    cats.forEach((k) => k.secs.forEach((e) => { e.hidden = k !== c; }));
    items.forEach((el, i) => el.classList.toggle('on', cats[i] === c));
    panel.classList.toggle('page', !!c);
    body.classList.toggle('single', !!c && c.secs.length === 1);
    title.textContent = phone && c ? c.title : 'Settings';
    back.hidden = !(phone && c);
    body.scrollTop = 0;
    if (scrollTo) secEl(scrollTo)?.scrollIntoView();
  };
  // Back / Esc: on a phone a page goes back to the menu first
  const onKey = (e) => {
    if (e.key !== 'Escape' || !phone || !cur || !panel) return;
    e.preventDefault(); e.stopPropagation();
    show(null);
  };
  window.addEventListener('keydown', onKey, true);
  // a press on the app behind the panel closes it (dialogs, menus, toasts and the Settings buttons themselves don't count)
  const onOutside = (e) => {
    if (!panel || panel.contains(e.target) || e.target.closest?.('.dlg-back, .help-back, .sheet-back, .pop, #toasts, .ctx, [aria-label="Settings"], [title^="Settings"]')) return;
    closeSettings();
  };
  const armOutside = setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 50);
  offKey = () => { window.removeEventListener('keydown', onKey, true); clearTimeout(armOutside); document.removeEventListener('pointerdown', onOutside, true); };

  panel = h('aside', { class: 'settings' + (phone ? ' phone-nav' : ' wide') },
    h('div', { class: 'st-head' }, back, title, h('button', { class: 'ibtn st-x', 'aria-label': 'Close settings', html: icon('close', 18), onclick: closeSettings })),
    h('div', { class: 'st-main' }, menu, body));
  document.body.append(panel);
  const target = section ? catOf(section) : null;
  show(target?.id, section);
  requestAnimationFrame(() => panel?.classList.add('in'));
}

/* ------------------------------------------------------------------ shortcuts sheet */
const SHORTCUTS = [
  ['Feed', [['↓ / J  ·  ↑ / K', 'Next · previous'], ['L', 'Like (and teach the Feed)'], ['X', 'Not interested'], ['Enter', 'Open the post'], ['Double-click', 'Like']]],
  ['Everywhere', [['/', 'Focus the search'], ['1 – 6', 'Feed · Roam · Follows · Boards · Pools · Trail'], [',', 'Settings'], ['Ctrl+T', 'New tab'], ['Ctrl+W', 'Close tab'], ['Ctrl+Tab', 'Next tab (Ctrl+Shift+Tab: previous)'], ['Ctrl+Shift+T', 'Reopen closed tab'], ['Middle-click', 'Open a section or card in a new tab'], ['`', 'Cloak the screen (panic)'], ['?', 'This sheet'], ['Right-click', 'Menu for whatever is under the pointer']]],
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
