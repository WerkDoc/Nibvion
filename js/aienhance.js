// KI-Scan: Erscheinungsbild verbessern wie ein Flachbettscanner (GCDRNet, MIT-Lizenz).
// Zwei kleine Netze: GC-Net schätzt Licht/Schatten, DR-Net macht daraus eine saubere Seite
// (weißes bzw. kräftig farbiges Papier, satte glatte Schrift). Läuft lokal über onnxruntime-web.
// Modelle (~21 MB) werden erst beim ersten Benutzen geladen und bleiben im Cache.
import { render, toCanvas } from './scanner.js';

let ortP = null;
const sess = {};
let loaded = false;
export const enhLoaded = () => loaded;

async function ort() {
  ortP ??= import('../lib/ort/ort.wasm.min.mjs').then(m => {
    const o = m.default || m;
    o.env.wasm.numThreads = 1;
    o.env.wasm.wasmPaths = new URL('../lib/ort/', import.meta.url).href;
    return o;
  });
  return ortP;
}
async function session(name) {
  if (!sess[name]) {
    sess[name] = (async () => {
      const o = await ort();
      const buf = await (await fetch(new URL(`../lib/models/${name}.onnx`, import.meta.url))).arrayBuffer();
      return o.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })();
    sess[name].catch(() => { delete sess[name]; });
  }
  return sess[name];
}

const tick = () => new Promise(r => setTimeout(r, 0));
const up32 = v => Math.ceil(v / 32) * 32;

// Canvas → planare Float-Kanäle in BGR-Reihenfolge (so wurde das Netz trainiert), Werte 0…1
function planes(c) {
  const w = c.width, h = c.height, d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data, N = w * h;
  const p = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) { p[i] = d[i * 4 + 2] / 255; p[N + i] = d[i * 4 + 1] / 255; p[2 * N + i] = d[i * 4] / 255; }
  return p;
}
// Ausschnitt [x0,y0,w,h] aus Kanälen (C×H×W) holen, auf Vielfache von 32 auffüllen (Rand wiederholen)
function cut(src, C, W, H, x0, y0, w, h) {
  const pw = up32(w), ph = up32(h), out = new Float32Array(C * pw * ph);
  for (let c = 0; c < C; c++) for (let y = 0; y < ph; y++) {
    const sy = y0 + Math.min(y, h - 1), so = c * W * H + sy * W + x0, oo = c * pw * ph + y * pw;
    for (let x = 0; x < pw; x++) out[oo + x] = src[so + Math.min(x, w - 1)];
  }
  return { data: out, pw, ph };
}

/** Verbessert eine (bereits entzerrte) Seite. Gibt ein neues Canvas gleicher Größe zurück. */
export async function aiEnhance(canvas, onProgress) {
  const o = await ort();
  onProgress?.(loaded ? null : 'KI wird geladen … (einmalig ca. 21 MB)');
  const [gc, dr] = await Promise.all([session('gcnet'), session('drnet')]);
  loaded = true;
  const W = canvas.width, H = canvas.height, N = W * H;
  // 1) Licht/Schatten auf kleiner Kopie (ist glatt) und hochrechnen
  const s = 512 / Math.max(W, H), sw = Math.max(32, Math.round(W * s)), sh = Math.max(32, Math.round(H * s));
  const small = toCanvas(canvas, Math.max(sw, sh));
  const sp = planes(small), sc = cut(sp, 3, small.width, small.height, 0, 0, small.width, small.height);
  const shR = (await gc.run({ input: new o.Tensor('float32', sc.data, [1, 3, sc.ph, sc.pw]) })).output.data;
  await tick();
  // 2) Eingang für DR-Net: Original + Original/Schatten (6 Kanäle)
  const x = planes(canvas), inp = new Float32Array(6 * N);
  inp.set(x, 0);
  const fx = small.width / W, fy = small.height / H;
  for (let y = 0; y < H; y++) {
    const gy = Math.min(small.height - 1.001, Math.max(0, (y + 0.5) * fy - 0.5)), y0 = gy | 0, ay = gy - y0;
    for (let xx = 0; xx < W; xx++) {
      const gx = Math.min(small.width - 1.001, Math.max(0, (xx + 0.5) * fx - 0.5)), x0 = gx | 0, ax = gx - x0;
      const i = y * W + xx;
      for (let c = 0; c < 3; c++) {
        const b = c * sc.ph * sc.pw, k = y0 * sc.pw + x0;
        const v = (shR[b + k] * (1 - ax) + shR[b + k + 1] * ax) * (1 - ay) + (shR[b + k + sc.pw] * (1 - ax) + shR[b + k + sc.pw + 1] * ax) * ay;
        inp[(3 + c) * N + i] = Math.min(1, Math.max(0, x[c * N + i] / Math.max(1e-3, v)));
      }
    }
  }
  // 3) DR-Net in Kacheln (schneller und sparsamer), mit Überlappung gegen Nähte
  const T = 512, O = 48, step = T - 2 * O;
  const out = new Float32Array(3 * N);
  const tiles = [];
  for (let y0 = 0; y0 < H; y0 += step) for (let x0 = 0; x0 < W; x0 += step) tiles.push([x0, y0]);
  let n = 0;
  for (const [x0, y0] of tiles) {
    onProgress?.(null, ++n / tiles.length);
    const xa = Math.max(0, x0 - O), ya = Math.max(0, y0 - O), xb = Math.min(W, x0 + step + O), yb = Math.min(H, y0 + step + O);
    const t = cut(inp, 6, W, H, xa, ya, xb - xa, yb - ya);
    const r = (await dr.run({ input: new o.Tensor('float32', t.data, [1, 6, t.ph, t.pw]) })).output.data;
    const hh = Math.min(step, H - y0), ww = Math.min(step, W - x0), cy = y0 - ya, cx = x0 - xa;
    for (let c = 0; c < 3; c++) for (let y = 0; y < hh; y++) {
      const so = c * t.ph * t.pw + (cy + y) * t.pw + cx, oo = c * N + (y0 + y) * W + x0;
      for (let k = 0; k < ww; k++) out[oo + k] = r[so + k];
    }
    await tick();
  }
  // BGR-Kanäle zurück ins Bild
  const res = document.createElement('canvas'); res.width = W; res.height = H;
  const rc = res.getContext('2d'), id = rc.createImageData(W, H), d = id.data;
  const cl = v => v < 0 ? 0 : v > 1 ? 255 : v * 255;
  for (let i = 0; i < N; i++) { d[i * 4] = cl(out[2 * N + i]); d[i * 4 + 1] = cl(out[N + i]); d[i * 4 + 2] = cl(out[i]); d[i * 4 + 3] = 255; }
  rc.putImageData(id, 0, 0);
  return res;
}

// ---------- Anbindung an Scan-Elemente ----------
export const enhKey = it => JSON.stringify([it.corners, it.rot || 0, !!(it.ai && it._ai?.canvas)]);
export const enhReady = it => !!(it._enh && it._enh.key === enhKey(it));
const SIDE = 2400;                     // höhere Auflösung = feinere Schrift (Zeit ist zweitrangig)
/** Berechnet die KI-verbesserte Seite einmal je Zuschnitt/Drehung (Ergebnis in it._enh). */
export async function ensureEnhance(it, onProgress) {
  if (enhReady(it)) return;
  const key = enhKey(it);
  if (it._enhP && it._enhPKey === key) return it._enhP;      // läuft schon
  it._enhPKey = key;
  it._enhP = (async () => {
    const base = render(it, '', SIDE);
    const canvas = await aiEnhance(base, onProgress);
    it._enh = { key, canvas };
  })();
  try { await it._enhP; } finally { if (it._enhPKey === key) it._enhP = null; }
}
