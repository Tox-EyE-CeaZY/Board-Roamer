/**
 * A small on-device cache for the pictures on Fur Affinity follow cards, so opening Follows shows them at once and asks the
 * site for nothing it already has. Pictures are kept in IndexedDB (best effort: where that is blocked it falls back to the
 * browser's own cache). Anything missing is fetched two at a time, a little apart, never all together.
 */
const DB = 'br-thumbs', STORE = 'p', KEEP = 1500, TRIM_TO = 1200, MAX_BYTES = 600_000;
let dbp = null;
const mem = new Map(); // url -> object URL
const waiting = new Map(); // url -> Promise<string>
const queue = [];
let active = 0;

const open = () => (dbp ||= new Promise((res) => {
  try {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE, { keyPath: 'u' });
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
  } catch { res(null); }
}));
const tx = (db, mode) => db.transaction(STORE, mode).objectStore(STORE);
const wrap = (rq) => new Promise((res) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); });

async function stored(u) {
  const db = await open();
  if (!db) return null;
  try { return await wrap(tx(db, 'readonly').get(u)); } catch { return null; }
}

async function put(u, blob) {
  const db = await open();
  if (!db || blob.size > MAX_BYTES) return;
  try {
    const s = tx(db, 'readwrite');
    s.put({ u, blob, t: Date.now() });
    if (Math.random() < 0.05) trim(db);
  } catch { /* storage full or blocked: the picture still shows this time */ }
}

async function trim(db) {
  try {
    const n = await wrap(tx(db, 'readonly').count());
    if (!n || n <= KEEP) return;
    const all = await wrap(tx(db, 'readonly').getAll());
    all.sort((a, b) => a.t - b.t).slice(0, n - TRIM_TO).forEach((r) => tx(db, 'readwrite').delete(r.u));
  } catch { /* trimming is only tidiness */ }
}

function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift();
    active++;
    (async () => {
      try {
        const r = await fetch('/img?u=' + encodeURIComponent(job.u));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        put(job.u, blob);
        job.res(URL.createObjectURL(blob));
      } catch (e) { job.rej(e); }
      await new Promise((r) => setTimeout(r, 250));
      active--;
      pump();
    })();
  }
}

/** An address the page can show for this picture: from this device when it was fetched before, else fetched once and kept. */
export function thumbSrc(u) {
  if (mem.has(u)) return Promise.resolve(mem.get(u));
  if (waiting.has(u)) return waiting.get(u);
  const p = (async () => {
    const hit = await stored(u);
    if (hit?.blob) return URL.createObjectURL(hit.blob);
    return new Promise((res, rej) => (queue.push({ u, res, rej }), pump()));
  })().then((o) => (mem.set(u, o), waiting.delete(u), o), (e) => (waiting.delete(u), Promise.reject(e)));
  waiting.set(u, p);
  return p;
}

/** An <img> that fills itself from the cache (see thumbSrc). */
export function cachedImg(u, attrs = {}) {
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  Object.assign(img, attrs);
  thumbSrc(u).then((s) => (img.src = s), () => img.remove());
  return img;
}
