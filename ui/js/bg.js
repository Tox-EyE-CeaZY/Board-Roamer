// Generative topographic-map background: fbm value-noise, iso-lines with constant pixel width.
const canvas = document.getElementById('topo');
const ctx = canvas.getContext('2d');
let seed = Math.random() * 1000;

function hash(x, y) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const sm = (t) => t * t * (3 - 2 * t);
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
function fbm(x, y) {
  return vnoise(x, y) * 0.55 + vnoise(x * 2.1 + 5.2, y * 2.1 + 1.3) * 0.28 + vnoise(x * 4.3 + 9.1, y * 4.3 + 7.7) * 0.12 + vnoise(x * 8.7, y * 8.7) * 0.05;
}

export function paintTopo() {
  const cs = getComputedStyle(document.documentElement);
  const col = cs.getPropertyValue('--topo-rgb').trim() || '120 200 180';
  const [r, g, b] = col.split(/\s+/).map(Number);
  const scale = 0.5;
  const w = Math.ceil((innerWidth + 120) * scale), hh = Math.ceil((innerHeight + 120) * scale);
  canvas.width = w;
  canvas.height = hh;
  const img = ctx.createImageData(w, hh);
  const LEVELS = 16, F = 1 / 230 / scale;
  const field = new Float32Array(w * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) field[y * w + x] = fbm(x * F, y * F) * LEVELS;
  for (let y = 1; y < hh - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, v = field[i];
      const gx = field[i + 1] - field[i - 1], gy = field[i + w] - field[i - w];
      const grad = Math.hypot(gx, gy) * 0.5 + 1e-4;
      const f = v - Math.floor(v);
      const dist = Math.min(f, 1 - f) / grad; // distance to nearest iso-line in px
      let a = Math.max(0, 1 - dist / 0.9);
      if (a <= 0) continue;
      const major = Math.floor(v + 0.5) % 4 === 0 ? 1 : 0.55; // every 4th line is an index contour
      const o = i * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b;
      img.data[o + 3] = a * 255 * major;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function initTopo() {
  let t;
  paintTopo();
  addEventListener('resize', () => (clearTimeout(t), (t = setTimeout(paintTopo, 300))));
  // gentle parallax so the map feels like a surface under the glass
  addEventListener('pointermove', (e) => {
    const x = (e.clientX / innerWidth - 0.5) * -22, y = (e.clientY / innerHeight - 0.5) * -22;
    canvas.style.transform = `translate(${x - 30}px, ${y - 30}px)`;
  }, { passive: true });
}
