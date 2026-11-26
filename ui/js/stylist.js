/* ==========================================================================================================================
   Runs the style model (TinyCLIP's picture half, in a worker) over thumbnails. The profile it feeds is style.js.

   Easy on the device:
   - nothing is loaded until something needs it, and the worker is closed after a quiet spell;
   - one picture at a time, with a rest after each that is twice as long as the work was (so at most about a third of one core);
   - candidates are only looked at while the Feed is on screen, fewer on slow devices, none on a low battery;
   - results are kept for the session, and nothing about the pictures leaves the device.
   ========================================================================================================================== */
const url = (p) => new URL(p, import.meta.url).href;
const FILES = {
  worker: url('./styleworker.js'),
  ort: url('../vendor/ort/ort.wasm.min.mjs'),
  mjs: url('../vendor/ort/ort-wasm-simd-threaded.mjs'),
  wasm: url('../vendor/ort/ort-wasm-simd-threaded.wasm'),
  model: url('../vendor/style/tinyclip-vision.onnx'),
};
const KEEP = 900; // fingerprints remembered this session (about 2 MB)
const IDLE = 90000;
/** Who goes first: what you just reacted to, then the sample of your favorites, then posts that may come up. */
export const NOW = 0, SEED = 1, MAYBE = 2;

const cache = new Map(); // key -> Float32Array
const failed = new Set();
const jobs = new Map(); // key -> job
const times = [];
const listeners = [];
let worker = null, starting = null, broken = false, running = false, idleT = 0, pending = null, seq = 0, battery = null;
let done = 0;

navigator.getBattery?.().then((b) => (battery = b)).catch(() => {});
document.addEventListener('visibilitychange', () => !document.hidden && pump());

const keyOf = (p) => (p.provider === 'e926' ? 'e621' : p.provider) + ':' + p.id;
export const peek = (post) => cache.get(keyOf(post)) || null;
/** Told about every new fingerprint: (post, vector). */
export const onFingerprint = (fn) => listeners.push(fn);
const median = () => (times.length ? [...times].sort((a, b) => a - b)[times.length >> 1] : 0);
export const stats = () => ({ done, ms: Math.round(median()), waiting: jobs.size, broken, running: !!worker });

/** How many candidates to look at each time you move on: fewer where each one costs more. */
export function quota() {
  if (broken || (battery && !battery.charging && battery.level <= 0.2)) return 0;
  const ms = median();
  return ms < 350 ? 4 : ms < 800 ? 2 : ms < 2000 ? 1 : 0;
}

const bytes = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u.split('/').pop()}: ${r.status}`);
  return r.arrayBuffer();
};

function start() {
  return (starting ||= (async () => {
    const made = [];
    const blob = async (u, type) => {
      const x = URL.createObjectURL(new Blob([await bytes(u)], { type }));
      made.push(x);
      return x;
    };
    try {
      const [code, ort, mjs, wasm, model] = await Promise.all([
        blob(FILES.worker, 'text/javascript'), blob(FILES.ort, 'text/javascript'), blob(FILES.mjs, 'text/javascript'), blob(FILES.wasm, 'application/wasm'), bytes(FILES.model),
      ]);
      const w = new Worker(code, { type: 'module' });
      await new Promise((ok, no) => {
        const t = setTimeout(() => no(new Error('timed out')), 90000);
        w.onerror = (e) => (clearTimeout(t), no(new Error(e.message || 'worker failed')));
        w.onmessage = ({ data }) => (clearTimeout(t), data.type === 'ready' ? ok() : no(new Error(data.error)));
        w.postMessage({ type: 'init', ort, mjs, wasm, model }, [model]);
      });
      w.onmessage = ({ data }) => pending?.id === data.id && pending.finish(data);
      w.onerror = () => pending?.finish({ error: 'worker failed', fatal: true });
      worker = w;
    } catch (e) {
      broken = true; // the Feed carries on with tags alone
      console.warn('style fingerprint is off:', e.message);
    } finally {
      made.forEach((x) => URL.revokeObjectURL(x));
      starting = null;
    }
  })());
}

function stop() {
  worker?.terminate();
  worker = null;
}

async function work(job) {
  const r = await fetch('/img?u=' + encodeURIComponent(job.thumb)); // through the app, so the pixels can be read
  if (!r.ok) throw new Error('thumbnail ' + r.status);
  const blob = await r.blob();
  if (!worker) await start();
  if (!worker) throw new Error('no model');
  const id = ++seq;
  const out = await new Promise((resolve) => {
    const t = setTimeout(() => pending?.finish({ error: 'timed out', fatal: true }), 30000);
    pending = { id, finish: (d) => (clearTimeout(t), (pending = null), resolve(d)) };
    worker.postMessage({ id, blob });
  });
  if (out.fatal) stop();
  if (out.error) throw new Error(out.error);
  times.push(out.ms);
  if (times.length > 15) times.shift();
  return out.vec;
}

/** The next job that may run now. */
function next() {
  let best = null;
  for (const j of jobs.values()) {
    if (j.rank === MAYBE && !j.when?.()) continue;
    if (!best || j.rank < best.rank) best = j;
  }
  return best;
}

async function pump() {
  if (running || document.hidden) return;
  const job = next();
  if (!job) return;
  running = true;
  clearTimeout(idleT);
  const began = performance.now();
  let vec = null;
  try {
    vec = await work(job);
    done++;
    cache.set(job.key, vec);
    while (cache.size > KEEP) cache.delete(cache.keys().next().value);
    listeners.forEach((fn) => fn(job.post, vec));
  } catch {
    if (!broken) failed.add(job.key);
  }
  jobs.delete(job.key);
  job.waiting.forEach((f) => f(vec));
  if (broken) { // nobody is left waiting
    for (const j of jobs.values()) j.waiting.forEach((f) => f(null));
    jobs.clear();
  }
  const rest = job.rank === NOW ? 60 : Math.max(250, (performance.now() - began) * 0.3, median() * 2);
  setTimeout(() => {
    running = false;
    if (next()) pump();
    else idleT = setTimeout(() => !running && !jobs.size && stop(), IDLE);
  }, rest);
}

function add(post, rank, when) {
  const key = keyOf(post);
  let job = jobs.get(key);
  if (!job) jobs.set(key, (job = { key, post, thumb: post.thumb, rank, when, waiting: [] }));
  else if (rank < job.rank) job.rank = rank;
  return job;
}
const usable = (post) => !broken && /^https?:\/\//.test(post.thumb || '') && !failed.has(keyOf(post));

/** The fingerprint of a post: at once if known, otherwise when the model gets to it. Null if it cannot be had. */
export function fingerprint(post, rank = NOW) {
  const have = peek(post);
  if (have || !usable(post)) return Promise.resolve(have);
  const job = add(post, rank);
  return new Promise((resolve) => (job.waiting.push(resolve), pump()));
}

/** Posts that may come up soon, replacing the last such list. `when()` says whether anyone is looking. */
export function consider(posts, when) {
  for (const [k, j] of jobs) if (j.rank === MAYBE && !j.waiting.length) jobs.delete(k);
  for (const p of posts) if (!peek(p) && usable(p)) add(p, MAYBE, when);
  pump();
}
