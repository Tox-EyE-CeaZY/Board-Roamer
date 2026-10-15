/**
 * Merging two copies of the library. Pure functions, no browser APIs, so the same code can be tested in node.
 *
 * Rules (each one chosen so that merging twice, or in either order, lands on the same result):
 *   settings   the newest change to each setting wins
 *   boards     pin boards combine their pins (a deleted pin stays deleted); saved searches take the newer copy whole
 *   follows    matched by site + tag; "seen" only moves forward; the fresher check supplies thumbnails and counts
 *   trail      one entry per search, newest wins; clearing or removing an entry sticks
 *   reading    the most recent page per comic wins
 *   deletions  remembered as tombstones for 120 days, and a later edit beats an earlier deletion
 */
const postKey = (p) => `${p.provider}:${p.id}`;
const INBOX = 'pins';
const num = (n) => (typeof n === 'number' && isFinite(n) ? n : 0);

/** Stable text form, so two documents can be compared. */
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const same = (a, b) => canon(a) === canon(b);

const maxMap = (a = {}, b = {}) => {
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = Math.max(num(out[k]), num(b[k]));
  return out;
};

function mergeTomb(a = {}, b = {}) {
  return { b: maxMap(a.b, b.b), bp: maxMap(a.bp, b.bp), s: maxMap(a.s, b.s), t: maxMap(a.t, b.t), l: maxMap(a.l, b.l), tc: Math.max(num(a.tc), num(b.tc)) };
}

function mergeSettings(a, b) {
  const settings = {}, settingsT = {};
  const keys = new Set([...Object.keys(a.settings || {}), ...Object.keys(b.settings || {})]);
  for (const k of keys) {
    const ta = num((a.settingsT || {})[k]), tb = num((b.settingsT || {})[k]);
    const ha = k in (a.settings || {}), hb = k in (b.settings || {});
    let pick;
    if (ha && !hb) pick = a;
    else if (hb && !ha) pick = b;
    else if (ta !== tb) pick = ta > tb ? a : b;
    else pick = canon(a.settings[k]) >= canon(b.settings[k]) ? a : b; // a tie: any fixed choice
    settings[k] = pick.settings[k];
    settingsT[k] = Math.max(ta, tb);
  }
  return { settings, settingsT };
}

function mergePins(x, y, tomb) {
  const seen = new Map();
  for (const p of [...(x.posts || []), ...(y.posts || [])]) {
    if (!p) continue;
    const k = postKey(p);
    const old = seen.get(k);
    if (!old || num(p.pinnedAt) > num(old.pinnedAt)) seen.set(k, p);
  }
  return [...seen.entries()]
    .filter(([k, p]) => !tomb.bp[x.id + '|' + k] || num(p.pinnedAt) > num(tomb.bp[x.id + '|' + k]))
    .map(([, p]) => p)
    .sort((p, q) => num(q.pinnedAt) - num(p.pinnedAt) || (postKey(p) < postKey(q) ? -1 : 1));
}

function mergeBoards(a = [], b = [], tomb) {
  const ids = new Map();
  for (const x of a) ids.set(x.id, [x, null]);
  for (const y of b) ids.set(y.id, [ids.get(y.id)?.[0] || null, y]);
  const out = [];
  for (const [id, [x, y]] of ids) {
    const newest = !x ? y : !y ? x : num(y.updated) > num(x.updated) ? y : num(x.updated) > num(y.updated) ? x : canon(x) >= canon(y) ? x : y;
    const dead = num(tomb.b[id]);
    if (id !== INBOX && dead && dead >= num(newest.updated)) continue;
    const board = { ...newest };
    if (newest.kind === 'pins' && x && y) board.posts = mergePins(x, y, tomb);
    else if (newest.kind === 'pins') board.posts = mergePins(newest, { posts: [] }, tomb);
    if (id === INBOX && x && y) (board.inbox = true, board.name = 'Pins');
    out.push(board);
  }
  return out.sort((p, q) => (q.inbox ? 1 : 0) - (p.inbox ? 1 : 0) || num(q.created) - num(p.created) || (p.id < q.id ? -1 : 1));
}

const subKey = (f) => f.p + ':' + f.t;
function mergeSubs(a = [], b = [], tomb) {
  const map = new Map();
  for (const f of [...a, ...b]) {
    const k = subKey(f);
    const o = map.get(k);
    if (!o) { map.set(k, f); continue; }
    const fresher = num(f.checked) > num(o.checked) ? f : num(f.checked) < num(o.checked) ? o : canon(f) >= canon(o) ? f : o;
    const m = { ...fresher };
    m.id = o.id < f.id ? o.id : f.id; // the same follow on both devices ends up with one id
    m.added = Math.min(num(o.added) || Infinity, num(f.added) || Infinity);
    if (!isFinite(m.added)) m.added = num(o.added) || num(f.added);
    m.seenId = Math.max(num(o.seenId), num(f.seenId));
    m.latestId = Math.max(num(o.latestId), num(f.latestId));
    m.newCount = m.seenId >= m.latestId ? 0 : num(fresher.newCount);
    m.checked = Math.max(num(o.checked), num(f.checked));
    map.set(k, m);
  }
  return [...map.values()]
    .filter((f) => !tomb.s[subKey(f)] || num(f.added) > num(tomb.s[subKey(f)]))
    .sort((p, q) => num(q.added) - num(p.added) || (subKey(p) < subKey(q) ? -1 : 1));
}

const libKey = (f) => f.p + ':' + f.pid;
const when = (v) => (v ? new Date(v).getTime() || 0 : 0);
function mergeLibrary(a = [], b = [], tomb) {
  const map = new Map();
  for (const f of [...a, ...b]) {
    const k = libKey(f);
    const o = map.get(k);
    if (!o) { map.set(k, f); continue; }
    const fresher = num(f.checked) > num(o.checked) ? f : num(f.checked) < num(o.checked) ? o : canon(f) >= canon(o) ? f : o;
    const m = { ...fresher };
    m.id = o.id < f.id ? o.id : f.id;
    m.added = Math.min(num(o.added) || Infinity, num(f.added) || Infinity);
    if (!isFinite(m.added)) m.added = num(o.added) || num(f.added);
    m.count = Math.max(num(o.count), num(f.count));
    m.seenCount = Math.min(m.count, Math.max(num(o.seenCount), num(f.seenCount))); // seen only moves forward
    m.updated = when(o.updated) >= when(f.updated) ? o.updated : f.updated;
    m.checked = Math.max(num(o.checked), num(f.checked));
    if (!m.cover) m.cover = o.cover || f.cover || '';
    map.set(k, m);
  }
  return [...map.values()]
    .filter((f) => !tomb.l[libKey(f)] || num(f.added) > num(tomb.l[libKey(f)]))
    .sort((p, q) => num(q.added) - num(p.added) || (libKey(p) < libKey(q) ? -1 : 1));
}

function mergeTrail(a = [], b = [], tomb) {
  const best = new Map();
  for (const e of [...a, ...b]) {
    const sig = e.provider + '|' + JSON.stringify(e.terms) + '|' + JSON.stringify(e.filters);
    const o = best.get(sig);
    if (!o || num(e.ts) > num(o[0].ts)) best.set(sig, [e, sig]);
  }
  return [...best.values()]
    .filter(([e, sig]) => num(e.ts) > num(tomb.tc) && num(e.ts) > num(tomb.t[sig]))
    .map(([e]) => e)
    .sort((p, q) => num(q.ts) - num(p.ts))
    .slice(0, 250);
}

function mergeReading(a = {}, b = {}) {
  const out = { ...a };
  for (const k of Object.keys(b)) if (!out[k] || num(b[k].ts) > num(out[k].ts)) out[k] = b[k];
  return out;
}

export function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const tomb = mergeTomb(a.tomb, b.tomb);
  return {
    v: 1,
    ...mergeSettings(a, b),
    boards: mergeBoards(a.boards, b.boards, tomb),
    subs: mergeSubs(a.subs, b.subs, tomb),
    library: mergeLibrary(a.library, b.library, tomb),
    trail: mergeTrail(a.trail, b.trail, tomb),
    reading: mergeReading(a.reading, b.reading),
    tomb,
  };
}
