import { S, tagc } from './store.js';

/* Tag categories, in display order */
export const CATS = ['artist', 'contributor', 'copyright', 'character', 'species', 'general', 'lore', 'meta', 'invalid'];
export const CAT_LABEL = {
  artist: 'Artists', contributor: 'Contributors', copyright: 'Copyrights', character: 'Characters', species: 'Species',
  general: 'General', lore: 'Lore', meta: 'Meta', invalid: 'Invalid',
};
export const catName = (c) => (c === 'species' ? 'Species' : (CAT_LABEL[c] || 'Tag').replace(/s$/, ''));
const E6_CAT = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'species', 6: 'invalid', 7: 'meta', 8: 'lore' };
const DB_CAT = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' };
const STR_CAT = { tag: 'general', general: 'general', artist: 'artist', copyright: 'copyright', character: 'character', metadata: 'meta', meta: 'meta', species: 'species' };
const SKIP_ARTISTS = new Set(['conditional_dnp', 'unknown_artist', 'anonymous_artist', 'unknown_artist_signature', 'sound_warning', 'epilepsy_warning', 'third-party_edit', 'avoid_posting', 'jumpscare_warning']);

export class ApiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}

const mediaKind = (ext) => (['webm', 'mp4', 'mov'].includes(ext) ? 'video' : ext === 'gif' ? 'anim' : ext === 'swf' ? 'flash' : 'image');
const ratingOf = (r) => ({ g: 's', s: 's', safe: 's', general: 's', sensitive: 's', q: 'q', questionable: 'q', e: 'e', explicit: 'e' })[String(r).toLowerCase()] || 'q';

/* ------------------------------------------------------------------ transport */
function credsFor(prov) {
  return (S('creds') || {})[prov.credKey] || {};
}

export async function call(prov, url, { method = 'GET', body, retry = 1 } = {}) {
  const c = credsFor(prov);
  const headers = { 'x-br-ua': S('ua') || `BoardRoamer/0.1 (by ${c.user || 'anonymous'})` };
  if (prov.auth === 'basic' && c.user && c.key) headers['x-br-auth'] = 'Basic ' + btoa(`${c.user}:${c.key}`);
  let r;
  try {
    r = await fetch('/proxy?u=' + encodeURIComponent(url), { method, headers, body });
  } catch (e) {
    throw new ApiError('Cannot reach the local proxy — is the app still running?');
  }
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!r.ok || data?.success === false) {
    if ((r.status === 429 || r.status === 503) && retry > 0) {
      await new Promise((res) => setTimeout(res, 1600));
      return call(prov, url, { method, body, retry: retry - 1 });
    }
    const msg = data?.message || data?.error || data?.reason || (r.status === 403 ? 'Access denied (403)' : r.status === 401 ? 'Authentication required (401)' : `HTTP ${r.status}`);
    throw new ApiError(prov.needsKey && r.status === 401 ? `${prov.name} needs an API key — add it in Settings.` : String(msg), r.status);
  }
  if (data == null && text.trim()) {
    // Gelbooru-family returns XML or empty text when something is off
    if (/<error|<response/.test(text)) throw new ApiError(prov.needsKey ? `${prov.name} needs an API key — add it in Settings.` : 'Unexpected response');
    return [];
  }
  return data ?? [];
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
const e6thumb = (md5, kind, ext) => `https://static1.e621.net/data/${kind ? kind + '/' : ''}${md5.slice(0, 2)}/${md5.slice(2, 4)}/${md5}.${ext}`;

/* ------------------------------------------------------------------ normalizers */
function normE6(p, prov) {
  if (!p || p.flags?.deleted) return null;
  const f = p.file || {};
  const md5 = f.md5;
  const full = f.url || (md5 ? e6thumb(md5, '', f.ext) : null);
  if (!full) return null;
  const kind = mediaKind(f.ext);
  const tags = {};
  for (const c of CATS) tags[c] = p.tags?.[c] ? [...p.tags[c]] : [];
  const artists = tags.artist.filter((a) => !SKIP_ARTISTS.has(a));
  return {
    provider: prov.id, id: p.id, rating: ratingOf(p.rating), w: f.width, h: f.height, ext: f.ext, kind, md5, size: f.size,
    thumb: p.preview?.url || (md5 ? e6thumb(md5, 'preview', 'jpg') : full),
    sample: p.sample?.has ? p.sample.url : kind === 'image' ? full : null,
    full,
    score: p.score?.total ?? 0, up: p.score?.up ?? 0, down: p.score?.down ?? 0, favs: p.fav_count ?? 0,
    tags, artists, sources: p.sources || [], created: p.created_at, desc: p.description || '',
    parent: p.relationships?.parent_id || null, children: p.relationships?.children || [], pools: p.pools || [],
    duration: p.duration || 0, comments: p.comment_count || 0, faved: !!p.is_favorited, url: `${prov.web}/posts/${p.id}`,
    alts: kind === 'video' ? Object.entries(p.sample?.alternates || {}).filter(([, v]) => v?.urls?.some(Boolean)).map(([k, v]) => ({ label: k, url: v.urls.find(Boolean), w: v.width, h: v.height })) : [],
    isComic: tags.general.includes('comic') || tags.meta.includes('comic'),
  };
}

function normDb(p, prov) {
  const full = p.file_url || p.large_file_url;
  if (!p.id || !full) return null;
  const split = (s) => (s ? s.split(' ').filter(Boolean) : []);
  const tags = { artist: split(p.tag_string_artist), copyright: split(p.tag_string_copyright), character: split(p.tag_string_character), general: split(p.tag_string_general), meta: split(p.tag_string_meta) };
  for (const c of CATS) tags[c] ||= [];
  const ext = p.file_ext;
  const kind = mediaKind(ext);
  const playable = ext === 'zip' ? p.large_file_url : full; // ugoira
  return {
    provider: prov.id, id: p.id, rating: ratingOf(p.rating), w: p.image_width, h: p.image_height, ext: ext === 'zip' ? 'webm' : ext,
    kind: ext === 'zip' ? 'video' : kind, md5: p.md5, size: p.file_size,
    thumb: p.preview_file_url || p.large_file_url || full,
    sample: kind === 'image' ? (p.large_file_url && p.large_file_url !== full ? p.large_file_url : full) : null,
    full: playable, score: p.score ?? 0, up: p.up_score ?? 0, down: p.down_score ?? 0, favs: p.fav_count ?? 0,
    tags, artists: tags.artist.filter((a) => !SKIP_ARTISTS.has(a)), sources: p.source ? [p.source] : [], created: p.created_at, desc: '',
    parent: p.parent_id || null, children: [], hasChildren: !!p.has_children, pools: [], duration: 0, comments: 0, faved: false,
    url: `${prov.web}/posts/${p.id}`,
  };
}

function normGb(p, prov) {
  if (!p?.id) return null;
  const dir = p.directory, hash = p.hash || p.md5;
  const isSafe = prov.id === 'safebooru';
  let full = p.file_url || (isSafe ? `https://safebooru.org/images/${dir}/${p.image}` : null);
  if (!full) return null;
  if (full.startsWith('//')) full = 'https:' + full;
  const ext = (p.image || full).split('.').pop().split('?')[0].toLowerCase();
  const kind = mediaKind(ext);
  let sample = p.sample_url || (isSafe && String(p.sample) === '1' ? `https://safebooru.org/samples/${dir}/sample_${hash}.jpg` : null);
  if (sample?.startsWith('//')) sample = 'https:' + sample;
  let thumb = p.preview_url || (isSafe ? `https://safebooru.org/thumbnails/${dir}/thumbnail_${hash}.jpg` : full);
  if (thumb?.startsWith('//')) thumb = 'https:' + thumb;
  const all = String(p.tags || '').split(' ').filter(Boolean);
  const tags = { general: all };
  for (const c of CATS) tags[c] ||= [];
  for (const t of all) {
    const k = tagc.get(prov.id, t);
    if (k && k.cat !== 'general' && tags[k.cat]) (tags[k.cat].push(t), (tags.general = tags.general.filter((x) => x !== t)));
  }
  return {
    provider: prov.id, id: p.id, rating: ratingOf(p.rating), w: +p.width, h: +p.height, ext, kind, md5: hash, size: 0,
    thumb, sample: kind === 'image' ? sample || full : null, full, score: +p.score || 0, up: 0, down: 0, favs: 0, tags,
    artists: tags.artist, sources: p.source ? [p.source] : [], created: p.created_at || (p.change ? p.change * 1000 : ''), desc: '',
    parent: +p.parent_id || null, children: [], hasChildren: p.has_children === 'true' || p.has_children === true, pools: [], duration: 0, comments: 0, faved: false,
    url: prov.id === 'safebooru' ? `${prov.web}/index.php?page=post&s=view&id=${p.id}` : `${prov.web}/index.php?page=post&s=view&id=${p.id}`,
  };
}

function normPool(j) {
  const ids = j.post_ids || [];
  return { id: j.id, name: String(j.name || '').replace(/_/g, ' '), desc: j.description || '', cat: j.category || 'collection', ids, count: j.post_count ?? ids.length, updated: j.updated_at, created: j.created_at, active: j.is_active !== false, creator: j.creator_name || '' };
}

/* ------------------------------------------------------------------ provider table */
const E6_SORT = [['', 'Newest'], ['id', 'Oldest'], ['score', 'Top score'], ['favcount', 'Most faved'], ['random', 'Shuffle'], ['mpixels', 'Largest image'], ['filesize', 'Biggest file'], ['comment_bumped', 'Fresh comments']];
const DB_SORT = [['', 'Newest'], ['score', 'Top score'], ['favcount', 'Most faved'], ['rank', 'Trending'], ['random', 'Shuffle'], ['filesize', 'Biggest file']];
const GB_SORT = [['', 'Newest'], ['score', 'Top score'], ['random', 'Shuffle']];

function dateFilter(age) {
  return age ? [`date:${age}`] : [];
}

const e6 = {
  engine: 'e6', credKey: 'e621', auth: 'basic', web: 'https://e621.net', short: 'e6', color: 214, maxTags: 40, pageSize: 75,
  sorts: E6_SORT, shapes: true, ages: true, media: true, pageNumberCap: 750, fav: true, vote: true, dossier: true, wiki: true, pools: true,
  filterTags(f) {
    const t = [];
    if (f.order) t.push(`order:${f.order}`);
    if (f.score > 0) t.push(`score:>=${f.score}`);
    const on = Object.entries(f.ratings).filter(([, v]) => v).map(([k]) => k);
    if (on.length === 1) t.push(`rating:${on[0]}`);
    else if (on.length === 2) t.push(`-rating:${['s', 'q', 'e'].find((x) => !on.includes(x))}`);
    if (f.media === 'still') t.push('-animated');
    if (f.media === 'animated') t.push('animated');
    if (f.media === 'video') t.push('type:webm');
    if (f.shape === 'wide') t.push('ratio:>1');
    if (f.shape === 'tall') t.push('ratio:<1');
    if (f.shape === 'square') t.push('ratio:1');
    return [...t, ...dateFilter(f.age)];
  },
  async page(feed) {
    const useCursor = !feed.tags.some((t) => /^order:/.test(t));
    const q = { tags: feed.tags.join(' '), limit: feed.limit || this.pageSize };
    if (useCursor) feed.cursor && (q.page = 'b' + feed.cursor);
    else q.page = feed.pageNo;
    const j = await call(this, `${this.web}/posts.json?${qs(q)}`);
    const raw = j.posts || [];
    if (useCursor && raw.length) feed.cursor = Math.min(...raw.map((p) => p.id));
    feed.pageNo++;
    if (!raw.length || (!useCursor && feed.pageNo > this.pageNumberCap)) feed.done = true;
    return raw.map((p) => normE6(p, this)).filter(Boolean);
  },
  async post(id) {
    const j = await call(this, `${this.web}/posts/${id}.json`);
    return normE6(j.post, this);
  },
  async autocomplete(q) {
    const j = await call(this, `${this.web}/tags/autocomplete.json?${qs({ 'search[name_matches]': q, expiry: 7 })}`);
    return (Array.isArray(j) ? j : []).slice(0, 14).map((t) => ({ name: t.name, count: t.post_count, cat: E6_CAT[t.category] || 'general', alias: t.antecedent_name }));
  },
  async tagInfo(name) {
    const j = await call(this, `${this.web}/tags.json?${qs({ 'search[name_matches]': name, limit: 5 })}`);
    const t = (Array.isArray(j) ? j : []).find((x) => x.name === name);
    return t ? { name, count: t.post_count, cat: E6_CAT[t.category] || 'general' } : null;
  },
  async artist(name) {
    const j = await call(this, `${this.web}/artists.json?${qs({ 'search[name]': name, limit: 1 })}`);
    const a = Array.isArray(j) ? j.find((x) => x.name === name) : null;
    if (!a) return null;
    return { name: a.name, other: a.other_names || [], group: a.group_name || '', urls: (a.urls || []).filter((u) => u.is_active !== false).map((u) => (typeof u === 'string' ? u : u.url)), id: a.id, web: `${this.web}/artists/${a.id}` };
  },
  async wiki(name) {
    const j = await call(this, `${this.web}/wiki_pages.json?${qs({ 'search[title]': name, limit: 1 })}`);
    return Array.isArray(j) && j[0] ? j[0].body : null;
  },
  /* ---- pools ---- */
  async pool(id) {
    const j = await call(this, `${this.web}/pools/${id}.json`);
    return j?.id ? normPool(j) : null;
  },
  /** Posts of a pool, in pool order. */
  async poolPosts(pool, onProgress) {
    const got = new Map();
    for (let page = 1; page <= 12 && got.size < pool.ids.length; page++) {
      const j = await call(this, `${this.web}/posts.json?${qs({ tags: `pool:${pool.id}`, limit: 320, page })}`);
      const raw = j.posts || [];
      for (const r of raw) {
        const n = normE6(r, this);
        if (n) got.set(n.id, n);
      }
      onProgress?.(got.size, pool.ids.length);
      if (raw.length < 320) break;
    }
    return pool.ids.map((i) => got.get(i)).filter(Boolean);
  },
  async poolsSearch({ q = '', category = '', order = 'updated_at', page = 1 } = {}) {
    const o = { 'search[order]': order, limit: 36, page };
    if (q) o['search[name_matches]'] = `*${q.replace(/\s+/g, '_')}*`;
    if (category) o['search[category]'] = category;
    const j = await call(this, `${this.web}/pools.json?${qs(o)}`);
    return (Array.isArray(j) ? j : []).map(normPool);
  },
  /** Fetch several posts by id in one request (used for pool covers). */
  async postsByIds(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      const tags = chunk.length === 1 ? `id:${chunk[0]}` : chunk.map((x) => `~id:${x}`).join(' ');
      const j = await call(this, `${this.web}/posts.json?${qs({ tags, limit: 40 })}`);
      for (const r of j.posts || []) {
        const n = normE6(r, this);
        if (n) out.push(n);
      }
    }
    return out;
  },
  async setFav(post, on) {
    if (on) await call(this, `${this.web}/favorites.json?post_id=${post.id}`, { method: 'POST' });
    else await call(this, `${this.web}/favorites/${post.id}.json`, { method: 'DELETE' });
  },
  async setVote(post, score) {
    await call(this, `${this.web}/posts/${post.id}/votes.json?${qs({ score, no_unvote: 'false' })}`, { method: 'POST' });
  },
  async accountBlacklist() {
    const c = credsFor(this);
    if (!c.user) throw new ApiError('Add your username and API key first.');
    const j = await call(this, `${this.web}/users/${encodeURIComponent(c.user)}.json`);
    if (j.blacklisted_tags == null) throw new ApiError('Could not read the blacklist — check the API key.');
    return String(j.blacklisted_tags).split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  },
};

const db = {
  engine: 'db', credKey: 'danbooru', auth: 'basic', web: 'https://danbooru.donmai.us', short: 'db', color: 18, maxTags: 2, pageSize: 60,
  sorts: DB_SORT, shapes: true, ages: true, media: true, pageNumberCap: 1000, fav: true, vote: false, dossier: false, wiki: false, counts: true,
  filterTags(f) {
    const t = [];
    if (f.order) t.push(`order:${f.order}`);
    if (f.score > 0) t.push(`score:>=${f.score}`);
    if (f.media === 'still') t.push('-animated');
    if (f.media === 'animated') t.push('animated');
    if (f.media === 'video') t.push('video');
    if (f.shape === 'wide') t.push('ratio:>1');
    if (f.shape === 'tall') t.push('ratio:<1');
    if (f.shape === 'square') t.push('ratio:1');
    const age = { day: '1d', week: '1w', month: '1mo', year: '1y' }[f.age];
    if (age) t.push(`age:<${age}`);
    return t;
  },
  async page(feed) {
    const useCursor = !feed.tags.some((t) => /^order:/.test(t));
    const q = { tags: feed.tags.join(' '), limit: feed.limit || this.pageSize };
    if (useCursor) feed.cursor && (q.page = 'b' + feed.cursor);
    else q.page = feed.pageNo;
    const raw = await call(this, `${this.web}/posts.json?${qs(q)}`);
    if (useCursor && raw.length) feed.cursor = Math.min(...raw.map((p) => p.id));
    feed.pageNo++;
    if (!raw.length || (!useCursor && feed.pageNo > this.pageNumberCap)) feed.done = true;
    return raw.map((p) => normDb(p, this)).filter(Boolean);
  },
  async post(id) {
    return normDb(await call(this, `${this.web}/posts/${id}.json`), this);
  },
  async count(tags) {
    const j = await call(this, `${this.web}/counts/posts.json?${qs({ tags: tags.join(' ') })}`);
    return j?.counts?.posts ?? null;
  },
  async autocomplete(q) {
    const j = await call(this, `${this.web}/autocomplete.json?${qs({ 'search[query]': q, 'search[type]': 'tag_query', limit: 12 })}`);
    return (Array.isArray(j) ? j : []).map((t) => ({ name: t.value, count: t.post_count, cat: DB_CAT[t.category] || 'general', alias: t.antecedent }));
  },
  async tagInfo(name) {
    const j = await call(this, `${this.web}/tags.json?${qs({ 'search[name_matches]': name, limit: 5 })}`);
    const t = (Array.isArray(j) ? j : []).find((x) => x.name === name);
    return t ? { name, count: t.post_count, cat: DB_CAT[t.category] || 'general' } : null;
  },
  async setFav(post, on) {
    if (on) await call(this, `${this.web}/favorites.json?post_id=${post.id}`, { method: 'POST' });
    else await call(this, `${this.web}/favorites/${post.id}.json`, { method: 'DELETE' });
  },
};

const gbBase = (id, web, extra = {}) => ({
  engine: 'gb', credKey: id, auth: 'query', web, short: id === 'gelbooru' ? 'gb' : 'sb', color: id === 'gelbooru' ? 220 : 150, maxTags: 99, pageSize: 60,
  sorts: GB_SORT, shapes: false, ages: false, media: true, pageNumberCap: 1e9, fav: false, vote: false, dossier: false, wiki: false,
  creds() {
    const c = credsFor(this);
    return c.user && c.key ? { user_id: c.user, api_key: c.key } : {};
  },
  filterTags(f) {
    const t = [];
    if (f.order) t.push(f.order === 'random' ? 'sort:random' : `sort:${f.order}:desc`);
    if (f.score > 0) t.push(`score:>=${f.score}`);
    if (f.media === 'animated') t.push('animated');
    if (f.media === 'video') t.push('video');
    if (f.media === 'still') t.push('-animated');
    return t;
  },
  async page(feed) {
    const q = { page: 'dapi', s: 'post', q: 'index', json: 1, limit: feed.limit || this.pageSize, pid: feed.pageNo, tags: feed.tags.join(' '), ...this.creds() };
    const j = await call(this, `${this.web}/index.php?${qs(q)}`);
    const raw = Array.isArray(j) ? j : j.post ? (Array.isArray(j.post) ? j.post : [j.post]) : [];
    if (j?.['@attributes']?.count != null) feed.total = +j['@attributes'].count;
    feed.pageNo++;
    if (raw.length < 1) feed.done = true;
    const posts = raw.map((p) => normGb(p, this)).filter(Boolean);
    await this.resolveCats(posts);
    return posts;
  },
  async post(id) {
    const q = { page: 'dapi', s: 'post', q: 'index', json: 1, limit: 1, tags: `id:${id}`, ...this.creds() };
    const j = await call(this, `${this.web}/index.php?${qs(q)}`);
    const raw = Array.isArray(j) ? j : j.post ? [].concat(j.post) : [];
    const p = raw[0] && normGb(raw[0], this);
    if (p) await this.resolveCats([p]);
    return p;
  },
  async resolveCats(posts) {
    // The post list has no tag categories; look unknown ones up in batches and regroup.
    const unknown = new Set();
    for (const p of posts) for (const t of p.tags.general) if (!tagc.get(this.id, t)) unknown.add(t);
    const names = [...unknown].slice(0, 60);
    if (names.length && this.id === 'gelbooru') {
      try {
        const j = await call(this, `${this.web}/index.php?${qs({ page: 'dapi', s: 'tag', q: 'index', json: 1, names: names.join(' '), ...this.creds() })}`);
        const list = Array.isArray(j) ? j : [].concat(j.tag || []);
        for (const t of list) tagc.set(this.id, t.name, { cat: { 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' }[t.type] || 'general', count: t.count });
      } catch {}
    }
    for (const p of posts) {
      const keep = [];
      for (const t of p.tags.general) {
        const k = tagc.get(this.id, t);
        if (k && k.cat !== 'general' && p.tags[k.cat]) p.tags[k.cat].push(t);
        else keep.push(t);
      }
      p.tags.general = keep;
      p.artists = p.tags.artist.filter((a) => !SKIP_ARTISTS.has(a));
    }
  },
  async autocomplete(q) {
    if (this.id === 'safebooru') {
      const j = await call(this, `${this.web}/autocomplete.php?${qs({ q })}`);
      return (Array.isArray(j) ? j : []).map((t) => {
        const m = /\((\d+)\)\s*$/.exec(t.label || '');
        return { name: t.value, count: m ? +m[1] : 0, cat: 'general' };
      });
    }
    const j = await call(this, `${this.web}/index.php?${qs({ page: 'autocomplete2', term: q, type: 'tag_query', limit: 12 })}`);
    return (Array.isArray(j) ? j : []).map((t) => ({ name: t.value, count: +t.post_count || 0, cat: STR_CAT[t.category] || 'general' }));
  },
  async tagInfo() {
    return null;
  },
  ...extra,
});

export const providers = {
  e621: { id: 'e621', name: 'e621', sub: 'furry art archive', adult: true, ...e6 },
  e926: { id: 'e926', name: 'e926', sub: 'e621, safe-only', adult: false, ...e6, web: 'https://e926.net', short: 'e9', color: 160 },
  danbooru: { id: 'danbooru', name: 'Danbooru', sub: 'anime art · 2 tag limit signed out', adult: true, ...db },
  gelbooru: { id: 'gelbooru', name: 'Gelbooru', sub: 'needs a free API key', adult: true, needsKey: true, ...gbBase('gelbooru', 'https://gelbooru.com') },
  safebooru: { id: 'safebooru', name: 'Safebooru', sub: 'anime art, safe-only', adult: false, ...gbBase('safebooru', 'https://safebooru.org') },
};
providers.e926.credKey = 'e621';
export const providerList = Object.values(providers);
export const getProvider = (id) => providers[id] || providers.e621;

/* ------------------------------------------------------------------ query building */
export function termsToTags(terms) {
  return terms.map((t) => (t.op === '-' ? '-' : t.op === '~' ? '~' : '') + t.t);
}

export function buildQuery(prov, terms, filters) {
  const tags = termsToTags(terms);
  // Sort/filter syntax the user typed by hand wins over the filter popover.
  const typed = (re) => terms.some((t) => re.test(t.t));
  const extra = prov.filterTags(filters).filter((x) => {
    if (/^(order|sort):/.test(x) && typed(/^(order|sort):/)) return false;
    if (/^score:/.test(x) && typed(/^score:/)) return false;
    if (/rating:/.test(x) && typed(/^rating:/)) return false;
    return true;
  });
  return [...tags, ...extra];
}

/* ------------------------------------------------------------------ blacklist */
export function compileBlacklist(lines) {
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const parts = l.split(/\s+/);
      return { line: l, pos: parts.filter((p) => !p.startsWith('-') && !p.startsWith('~')), neg: parts.filter((p) => p.startsWith('-')).map((p) => p.slice(1)), any: parts.filter((p) => p.startsWith('~')).map((p) => p.slice(1)) };
    });
}

export function blacklistHit(post, rules) {
  if (!rules.length) return null;
  // cached on the post but NOT enumerable, so it can never leak into saved boards / JSON copies
  if (!(post._set instanceof Set)) Object.defineProperty(post, '_set', { value: new Set([...Object.values(post.tags).flat(), 'rating:' + post.rating, `type:${post.ext}`]), enumerable: false, writable: true, configurable: true });
  const set = post._set;
  const has = (t) => {
    if (set.has(t)) return true;
    const m = /^score:([<>]=?)(-?\d+)$/.exec(t);
    if (m) return m[1] === '<' ? post.score < +m[2] : m[1] === '<=' ? post.score <= +m[2] : m[1] === '>' ? post.score > +m[2] : post.score >= +m[2];
    return false;
  };
  for (const r of rules) {
    if (r.pos.every(has) && !r.neg.some(has) && (!r.any.length || r.any.some(has))) return r.line;
  }
  return null;
}

/* ------------------------------------------------------------------ feed */
export class Feed {
  constructor(prov, terms, filters) {
    this.prov = prov;
    this.terms = terms;
    this.filters = filters;
    this.tags = buildQuery(prov, terms, filters);
    this.pageNo = prov.engine === 'gb' ? 0 : 1;
    this.cursor = null;
    this.done = false;
    this.total = null;
    this.seen = new Set();
    this.limit = null;
    this.busy = false;
    this.loaded = 0;
    this.pagesFetched = 0;
  }

  /** Fetch until a useful batch is found (client-side rating filtering can empty a page). */
  async next(minWanted = 18) {
    if (this.done || this.busy) return [];
    this.busy = true;
    try {
      const out = [];
      const ratings = this.filters.ratings;
      for (let tries = 0; tries < 5 && !this.done && out.length < minWanted; tries++) {
        const batch = await this.prov.page(this);
        this.pagesFetched++;
        for (const p of batch) {
          if (this.seen.has(p.id)) continue;
          this.seen.add(p.id);
          for (const c of CATS) for (const t of p.tags[c]) if (c !== 'general' && c !== 'meta') tagc.set(p.provider, t, { cat: c });
          if (!ratings[p.rating]) continue;
          out.push(p);
        }
        if (!batch.length) this.done = true;
      }
      this.loaded += out.length;
      return out;
    } finally {
      this.busy = false;
    }
  }
}
