/**
 * Android only: tell the app's background job what to look for while the app is closed (see Watch.java).
 * The job cannot run the page, so each follow, live board and saved pool is described as the exact request to make
 * plus how much has been seen already. This is resent (debounced) whenever any of that changes.
 */
import { S, subs, boards, library, on } from './store.js';
import { getProvider, Feed } from './providers.js';
import { debounce } from './util.js';
import { isAndroid, native } from './platform.js';

let last = '';

function auth(prov) {
  const c = (S('creds') || {})[prov.credKey] || {};
  return prov.auth === 'basic' && c.user && c.key ? 'Basic ' + btoa(`${c.user}:${c.key}`) : '';
}

/** The request the page's own check would make, as {url, eng}. */
function postsRequest(prov, terms, filters) {
  const feed = new Feed(prov, terms, filters);
  if (prov.engine === 'pm') return { url: prov.pageUrl(feed, 8), eng: 'pm' };
  const q = new URLSearchParams(prov.engine === 'gb'
    ? { page: 'dapi', s: 'post', q: 'index', json: 1, limit: 8, pid: 0, tags: feed.tags.join(' '), ...(prov.creds?.() || {}) }
    : { tags: feed.tags.join(' '), limit: 8 });
  return { url: `${prov.web}/${prov.engine === 'gb' ? 'index.php' : 'posts.json'}?${q}`, eng: prov.engine === 'gb' ? 'gb' : 'posts' };
}

function build() {
  const items = [];
  const ratings = S('filters').ratings;
  if (S('notifyFollows')) {
    for (const f of subs.all()) {
      const prov = getProvider(f.p);
      items.push({ key: 'f:' + f.id, kind: 'follow', name: f.t.replace(/_/g, ' '), seen: f.seenId || 0, auth: auth(prov), ...postsRequest(prov, [{ t: f.t, op: '+' }], { order: '', score: 0, ratings, media: '', shape: '', age: '' }) });
    }
  }
  if (S('notifyBoards')) {
    for (const b of boards.all()) {
      if (b.kind !== 'smart' || !b.terms?.length) continue;
      const prov = getProvider(b.provider);
      items.push({ key: 'b:' + b.id, kind: 'board', seen: b.seenId || 0, auth: auth(prov), ...postsRequest(prov, b.terms, { ...S('filters'), ...b.filters, order: '', ratings: { ...ratings, ...(b.filters || {}).ratings } }) });
    }
  }
  if (S('notifyPools')) {
    for (const f of library.all()) {
      const prov = getProvider(f.p);
      if (!prov.pools) continue;
      items.push({ key: 'p:' + f.id, kind: 'pool', seen: f.seenCount || 0, auth: auth(prov), ...(prov.poolCountUrl ? { url: prov.poolCountUrl(f.pid), eng: 'pmpool' } : { url: `${prov.web}/pools/${f.pid}.json`, eng: 'pool' }) });
    }
  }
  const c = (S('creds') || {})[getProvider(S('provider')).credKey] || {};
  return { notify: !!S('notify'), names: !!S('notifyNames'), ua: S('ua') || `BoardRoamer/0.1 (by ${c.user || 'anonymous'})`, items };
}

function push() {
  const json = JSON.stringify(build());
  if (json === last) return;
  last = json;
  native.setWatch(json);
}

export function startWatch() {
  if (!isAndroid()) return;
  const later = debounce(push, 2500);
  for (const e of ['subs', 'boards', 'library']) on(e, later);
  on('settings', (e) => (e.detail.key.startsWith('notify') || e.detail.key === 'creds' || e.detail.key === 'ua') && later());
  later();
}
