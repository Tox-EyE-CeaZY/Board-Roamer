/**
 * What the Feed has learned, in a form two devices can merge. Pure functions, no browser APIs, so it runs in node.
 *
 * Merging two copies in either order, or twice, gives the same result, and nothing is counted twice:
 *
 *   base      what a device knew before it first synced, and what it reads from your favorites on the sites. Devices read the same
 *             favorites, so copies are combined by taking the larger number for each tag, never by adding.
 *   dev[id]   what happened on one device since (looks, skips, likes), plus its "today" mood and style. Only that device writes its
 *             slot, the newer copy wins, and the Feed adds the slots on top of the base.
 *   likes     the liked posts: the base list, plus every later like or unlike with its time (the latest one counts).
 *   r         your tag ratings: the latest choice for each tag counts.
 *   lists     posts seen, "not interested", comics already offered: put together.
 *   gen       "Forget my taste" starts a new generation, which replaces older ones everywhere.
 *
 * Counts fade with a half-life (taste.js). So that stored numbers never change just because time passed, they are kept as they would
 * have been worth on a fixed day: stored = value * 2^((then - EPOCH) / half-life). Adding and comparing them stays exact.
 */
const EPOCH = Date.UTC(2026, 0, 1);
const HALF = 120 * 86400000;
export const worth = (t) => Math.pow(2, (t - EPOCH) / HALF);
export const SEEN_CAP = 6000, LIKES_CAP = 8000, COMICS_CAP = 400;
const NOISE = 0.002; // smaller differences are rounding, not something that happened
const LEAST = 0.05; // a tag shown less than this (in today's terms) is forgotten
const num = (n) => (typeof n === 'number' && isFinite(n) ? n : 0);
const round = (n) => Math.round(n * 10000) / 10000;

const canon = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
/** Ids in one fixed order; past the cap the lowest (oldest posts) go. */
const union = (a = [], b = [], cap = Infinity) => {
  const all = [...new Set([...a, ...b])].sort((x, y) => Number(x) - Number(y) || (String(x) < String(y) ? -1 : x === y ? 0 : 1));
  return all.length > cap ? all.slice(all.length - cap) : all;
};

const emptyCounts = () => ({ t: {}, a: {}, pl: 0, pn: 0, likes: 0 });
export const emptyLedger = (gen = 0) => ({ gen, base: { ...emptyCounts(), liked: [] }, dev: {}, lm: {}, r: {}, seen: [], hidden: [], comics: [] });

function maxCounts(a, b) {
  const t = { ...a.t };
  for (const [k, [l, n]] of Object.entries(b.t || {})) t[k] = t[k] ? [Math.max(t[k][0], l), Math.max(t[k][1], n)] : [l, n];
  const art = { ...a.a };
  for (const [k, v] of Object.entries(b.a || {})) art[k] = k in art ? Math.max(art[k], v) : v;
  return { t, a: art, pl: Math.max(num(a.pl), num(b.pl)), pn: Math.max(num(a.pn), num(b.pn)), likes: Math.max(num(a.likes), num(b.likes)), liked: union(a.liked, b.liked, LIKES_CAP) };
}
/** Per key, whichever copy `newer` prefers. */
const pick = (a = {}, b = {}, newer) => {
  const out = { ...a };
  for (const k of Object.keys(b)) if (!(k in out) || newer(b[k], out[k])) out[k] = b[k];
  return out;
};

export function mergeLedger(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (num(a.gen) !== num(b.gen)) return num(a.gen) > num(b.gen) ? a : b;
  return {
    gen: num(a.gen),
    base: maxCounts(a.base, b.base),
    dev: pick(a.dev, b.dev, (x, y) => x.rev > y.rev || (x.rev === y.rev && canon(x) > canon(y))),
    lm: pick(a.lm, b.lm, (x, y) => Math.abs(x) > Math.abs(y) || (Math.abs(x) === Math.abs(y) && x > y)),
    r: pick(a.r, b.r, (x, y) => x[1] > y[1] || (x[1] === y[1] && canon(x[0]) > canon(y[0]))),
    seen: union(a.seen, b.seen, SEEN_CAP),
    hidden: union(a.hidden, b.hidden, SEEN_CAP),
    comics: union(a.comics, b.comics, COMICS_CAP),
  };
}

/** The whole Feed section of a sync document: one ledger per account, and the artists you asked not to be suggested. */
export function mergeFeed(a, b) {
  if (!a) return b;
  if (!b) return a;
  const accounts = {};
  for (const k of [...new Set([...Object.keys(a.accounts || {}), ...Object.keys(b.accounts || {})])].sort()) accounts[k] = mergeLedger(a.accounts?.[k], b.accounts?.[k]);
  return { accounts, nofollow: union(a.nofollow, b.nofollow, 300) };
}

/** Base and every device's slot added up, still in stored units. */
function totals(L) {
  const out = emptyCounts();
  for (const part of [L.base, ...Object.values(L.dev)]) {
    for (const [k, [l, n]] of Object.entries(part.t || {})) {
      const e = (out.t[k] ||= [0, 0]);
      e[0] += l;
      e[1] += n;
    }
    for (const [k, v] of Object.entries(part.a || {})) out.a[k] = (out.a[k] || 0) + v;
    out.pl += num(part.pl);
    out.pn += num(part.pn);
    out.likes += num(part.likes);
  }
  return out;
}

function likedSet(L) {
  const set = new Set(L.base.liked);
  for (const [id, ts] of Object.entries(L.lm)) ts > 0 ? set.add(Number(id)) : set.delete(Number(id));
  return set;
}

/**
 * What the device should now hold, from a ledger: the taste model's saved form and the lists.
 */
export function materialize(L, now = Date.now()) {
  const sum = totals(L), k = worth(now), t = {}, a = {}, r = {};
  const val = (x) => Math.max(0, Math.round((x / k) * 1000) / 1000);
  for (const [tag, [l, n]] of Object.entries(sum.t)) if (val(n) >= LEAST || val(l) >= LEAST) t[tag] = [val(l), val(n)];
  for (const [name, v] of Object.entries(sum.a)) if (val(v) >= 0.2) a[name] = val(v);
  for (const [tag, [v]] of Object.entries(L.r)) if (v) r[tag] = v;
  return {
    taste: { t, a, r, pl: val(sum.pl), pn: val(sum.pn), ts: now, likes: Math.max(0, sum.likes) },
    likes: [...likedSet(L)],
    seen: [...L.seen],
    hidden: [...L.hidden],
    comics: [...L.comics],
  };
}

/**
 * Takes what changed on this device since the ledger was last written and puts it into the ledger: into the device's own slot, or into
 * the base (`into: 'base'`, for what came from your favorites on a site; also used the first time, for everything learned before).
 *
 * @param live    {taste (saved form), likes, seen, hidden, comics, mood, style}
 * @returns       the ledger, changed in place
 */
export function fold(L, live, device, { into = 'dev', now = Date.now() } = {}) {
  const first = !L;
  L ||= emptyLedger();
  if (first) into = 'base';
  const none = !live.taste; // nothing stored is not the same as everything forgotten
  const taste = live.taste || {}, at = taste.ts || now, k = worth(at), had = none ? emptyCounts() : totals(L);
  const slot = L.dev[device] || { rev: 0, ...emptyCounts() };
  const target = into === 'base' ? L.base : slot;
  let changed = false;

  for (const tag of new Set([...Object.keys(taste.t || {}), ...Object.keys(had.t)])) {
    const mine = taste.t?.[tag] || [0, 0], was = had.t[tag] || [0, 0];
    // compare with what the ledger would have put here (negative sums show as 0)
    const d = [0, 1].map((i) => mine[i] - Math.max(0, was[i] / k));
    if (Math.abs(d[0]) <= NOISE && Math.abs(d[1]) <= NOISE) continue;
    // something the ledger holds too faintly to be put on the device has not been "forgotten" by it
    if (!taste.t?.[tag] && was[0] / k < LEAST && was[1] / k < LEAST) continue;
    const e = target.t[tag] || [0, 0];
    target.t[tag] = [0, 1].map((i) => round(e[i] + (Math.abs(d[i]) > NOISE ? d[i] * k : 0)));
    changed = true;
  }
  for (const name of new Set([...Object.keys(taste.a || {}), ...Object.keys(had.a)])) {
    const mine = taste.a?.[name] || 0, d = mine - Math.max(0, (had.a[name] || 0) / k);
    if (Math.abs(d) <= 0.011 || (!mine && (had.a[name] || 0) / k < 0.2)) continue; // the saved form rounds artists to hundredths
    target.a[name] = round((target.a[name] || 0) + d * k);
    changed = true;
  }
  for (const key of ['pl', 'pn']) {
    const d = num(taste[key]) - Math.max(0, had[key] / k);
    if (Math.abs(d) > NOISE) (target[key] = round(num(target[key]) + d * k)), (changed = true);
  }
  const dl = none ? 0 : num(taste.likes) - Math.max(0, had.likes);
  if (dl) (target.likes = num(target.likes) + dl), (changed = true);

  const ratings = taste.r || {};
  for (const tag of none ? [] : new Set([...Object.keys(ratings), ...Object.keys(L.r)])) {
    const mine = ratings[tag] || 0, was = L.r[tag]?.[0] || 0;
    if (mine !== was) L.r[tag] = [mine, first ? 1 : now];
  }

  const held = none ? new Set() : likedSet(L), mine = new Set((live.likes || []).map(Number));
  const gained = [...mine].filter((id) => !held.has(id)), lost = [...held].filter((id) => !mine.has(id));
  if (into === 'base') L.base.liked = union(L.base.liked, gained, LIKES_CAP);
  for (const id of gained) if (into !== 'base' || L.lm[id] < 0) L.lm[id] = now;
  // (a list past its cap drops old entries by itself: that is not an unlike)
  if (mine.size < LIKES_CAP) for (const id of lost) L.lm[id] = -now;

  L.seen = union(L.seen, (live.seen || []).map(Number), SEEN_CAP);
  L.hidden = union(L.hidden, (live.hidden || []).map(Number), SEEN_CAP);
  L.comics = union(L.comics, (live.comics || []).map(String), COMICS_CAP);

  for (const key of ['mood', 'style']) {
    if (live[key] && canon(live[key]) !== canon(slot[key])) (slot[key] = live[key]), (changed = true);
  }
  if (changed && (into !== 'base' || slot.mood || slot.style)) {
    slot.rev = Math.max(slot.rev + 1, now);
    L.dev[device] = slot;
  }
  return L;
}
