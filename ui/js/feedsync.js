/**
 * Carries what the Feed learned through the app's sync: reads it out of this device's storage into a ledger (feedmerge.js), and puts a
 * merged one back. A device keeps a ledger only once it has synced; until then none of this costs anything.
 */
import { kv, syncParts } from './store.js';
import { uid } from './util.js';
import { fold, materialize, emptyLedger } from './feedmerge.js';

/** The engine fills these in: write out what it holds in memory; read an account's model again. */
export const engine = { flush() {}, reload() {} };

export const deviceId = () => {
  let id = kv.get('feed:device', '');
  if (!id) kv.set('feed:device', (id = uid() + uid()));
  return id;
};
export const ledgerOf = (cred) => kv.get('feed:sync:' + cred, null);

const live = (cred) => ({
  taste: kv.get('feed:t:' + cred, null), likes: kv.get('feed:likes:' + cred, []), seen: kv.get('feed:seen:' + cred, []),
  hidden: kv.get('feed:hide:' + cred, []), comics: kv.get('feed:comics:' + cred, []), mood: kv.get('feed:mood:' + cred, null), style: kv.get('feed:style:' + cred, null),
});

/** Put what changed here into the stored ledger (`into: 'base'` for what was read from your favorites). */
export function foldAccount(cred, into) {
  const L = fold(ledgerOf(cred), live(cred), deviceId(), { into });
  kv.set('feed:sync:' + cred, L);
  return L;
}

/** "Forget my taste": a new, empty generation, which replaces the older ones on every device at the next sync. */
export function resetLedger(cred) {
  if (ledgerOf(cred)) kv.set('feed:sync:' + cred, emptyLedger(Date.now()));
}

/** Every account this device has learned something about. */
const accounts = () => [...new Set(Object.keys(localStorage).map((k) => /^br1:feed:(?:t|sync):(.+)$/.exec(k)?.[1]).filter(Boolean))].sort();

syncParts.feed = {
  snapshot() {
    engine.flush();
    const out = {};
    for (const cred of accounts()) out[cred] = foldAccount(cred);
    const nofollow = [...kv.get('feed:nofollow', [])].sort();
    return Object.keys(out).length || nofollow.length ? { accounts: out, nofollow } : undefined;
  },
  apply(feed) {
    for (const [cred, L] of Object.entries(feed.accounts || {})) {
      const before = ledgerOf(cred);
      // forgotten on another device: today's mood, the style and the record of what was read go too
      if (before && L.gen > before.gen) for (const k of ['mood', 'style', 'learn']) kv.del(`feed:${k}:${cred}`);
      kv.set('feed:sync:' + cred, L);
      const m = materialize(L);
      kv.set('feed:t:' + cred, m.taste);
      kv.set('feed:likes:' + cred, m.likes);
      kv.set('feed:seen:' + cred, m.seen);
      kv.set('feed:hide:' + cred, m.hidden);
      kv.set('feed:comics:' + cred, m.comics);
      engine.reload(cred);
    }
    if (feed.nofollow) kv.set('feed:nofollow', feed.nofollow);
  },
};
