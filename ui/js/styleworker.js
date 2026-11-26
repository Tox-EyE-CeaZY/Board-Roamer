/* The image model, off the main thread. Started by stylist.js from a blob, so it asks for nothing itself: everything is handed to it. */
const SIZE = 224;
const MEAN = [0.48145466, 0.4578275, 0.40821073], STD = [0.26862954, 0.26130258, 0.27577711]; // what CLIP models expect
let ort = null, session = null, ctx = null;

/** The middle square of a picture, as the model wants it: red, green and blue planes. */
async function pixels(blob) {
  const bmp = await createImageBitmap(blob);
  ctx ||= new OffscreenCanvas(SIZE, SIZE).getContext('2d', { willReadFrequently: true });
  const side = Math.min(bmp.width, bmp.height);
  ctx.fillStyle = '#808080'; // behind transparent art
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bmp.close();
  const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data, n = SIZE * SIZE, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[c * n + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  return out;
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') {
      ort = await import(m.ort);
      ort.env.wasm.numThreads = 1; // one core: the screen keeps the others
      ort.env.wasm.wasmPaths = { mjs: m.mjs, wasm: m.wasm };
      session = await ort.InferenceSession.create(new Uint8Array(m.model));
      return self.postMessage({ type: 'ready' });
    }
    const input = new ort.Tensor('float32', await pixels(m.blob), [1, 3, SIZE, SIZE]);
    const t = performance.now();
    const raw = (await session.run({ pixel_values: input })).image_embeds.data;
    const ms = performance.now() - t;
    let len = 0;
    for (const x of raw) len += x * x;
    len = Math.sqrt(len) || 1;
    const vec = Float32Array.from(raw, (x) => x / len);
    self.postMessage({ type: 'done', id: m.id, vec, ms }, [vec.buffer]);
  } catch (e) {
    self.postMessage({ type: m.type === 'init' ? 'failed' : 'done', id: m.id, error: String(e?.message || e) });
  }
};
