// KI-Glätten: entzerrt gewölbte/geknickte Seiten mit einem kleinen neuronalen Netz (UVDoc, MIT-Lizenz).
// Läuft komplett lokal im Browser über onnxruntime-web (WebAssembly). Modell + Laufzeit (~23 MB)
// werden erst beim ersten Benutzen geladen und danach vom Service Worker zwischengespeichert.
import { toCanvas, warp, isFull as isFullQuad } from './scanner.js';

const IN_W = 488, IN_H = 712;          // Eingabegröße des Modells (Hochformat)
let sessionP = null, ortMod = null;

export function aiLoaded() { return !!sessionP; }

async function session(onProgress) {
  if (!sessionP) {
    sessionP = (async () => {
      onProgress?.('KI wird geladen …');
      ortMod = await import('../lib/ort/ort.wasm.min.mjs');
      const ort = ortMod.default || ortMod;
      ort.env.wasm.numThreads = 1;                 // GitHub Pages: kein SharedArrayBuffer
      ort.env.wasm.wasmPaths = new URL('../lib/ort/', import.meta.url).href;
      const buf = await (await fetch(new URL('../lib/models/uvdoc.onnx', import.meta.url))).arrayBuffer();
      return ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })();
    sessionP.catch(() => { sessionP = null; });
  }
  return sessionP;
}

// Ausschnitt um die erkannten Ecken mit etwas Rand – das Netz braucht die Blattkanten.
function looseCrop(img, corners, maxSide) {
  const src = toCanvas(img, maxSide);
  if (isFullQuad(corners)) return src;
  const W = src.width, H = src.height;
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const mx = (x1 - x0) * 0.06, my = (y1 - y0) * 0.06;
  x0 = Math.max(0, x0 - mx); x1 = Math.min(1, x1 + mx); y0 = Math.max(0, y0 - my); y1 = Math.min(1, y1 + my);
  const c = document.createElement('canvas');
  c.width = Math.round((x1 - x0) * W); c.height = Math.round((y1 - y0) * H);
  c.getContext('2d').drawImage(src, x0 * W, y0 * H, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

// Liefert eine geglättete Seite (Canvas) in der Größe outW × outH.
export async function aiFlatten(img, corners, outW, outH, onProgress) {
  const s = await session(onProgress);
  const ort = ortMod.default || ortMod;
  onProgress?.('KI glättet die Seite …');
  const src = looseCrop(img, corners, 2400);
  let sw = src.width, sh = src.height;
  // Querformat drehen, das Modell ist auf Hochformat trainiert
  const land = sw > sh;
  let base = src;
  if (land) {
    base = document.createElement('canvas'); base.width = sh; base.height = sw;
    const bx = base.getContext('2d'); bx.translate(sh, 0); bx.rotate(Math.PI / 2); bx.drawImage(src, 0, 0);
    [sw, sh] = [sh, sw];
  }
  const small = document.createElement('canvas'); small.width = IN_W; small.height = IN_H;
  const sx = small.getContext('2d'); sx.drawImage(base, 0, 0, IN_W, IN_H);
  const px = sx.getImageData(0, 0, IN_W, IN_H).data, N = IN_W * IN_H;
  const inp = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) { inp[i] = px[i * 4] / 255; inp[N + i] = px[i * 4 + 1] / 255; inp[2 * N + i] = px[i * 4 + 2] / 255; }
  const res = await s.run({ img: new ort.Tensor('float32', inp, [1, 3, IN_H, IN_W]) });
  const grid = res.grid.data, GH = res.grid.dims[2], GW = res.grid.dims[3];
  await new Promise(r => setTimeout(r, 0));

  // Ausgabe im Modell-Hochformat berechnen, danach ggf. zurückdrehen
  let ow = land ? outH : outW, oh = land ? outW : outH;
  const sd = base.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas'); out.width = ow; out.height = oh;
  const octx = out.getContext('2d'); const od = octx.createImageData(ow, oh); const o = od.data;
  const G = GW * GH;
  for (let j = 0; j < oh; j++) {
    const gy = j / (oh - 1) * (GH - 1), gy0 = Math.min(GH - 2, gy | 0), fy = gy - gy0;
    for (let i = 0; i < ow; i++) {
      const gx = i / (ow - 1) * (GW - 1), gx0 = Math.min(GW - 2, gx | 0), fx = gx - gx0;
      const k = gy0 * GW + gx0;
      const bl = (c) => (grid[c * G + k] * (1 - fx) + grid[c * G + k + 1] * fx) * (1 - fy)
        + (grid[c * G + k + GW] * (1 - fx) + grid[c * G + k + GW + 1] * fx) * fy;
      let x = (bl(0) + 1) / 2 * (sw - 1), y = (bl(1) + 1) / 2 * (sh - 1);
      const q = (j * ow + i) * 4; o[q + 3] = 255;
      if (x < 0 || y < 0 || x > sw - 1 || y > sh - 1) { o[q] = o[q + 1] = o[q + 2] = 255; continue; }
      x = Math.min(sw - 1.001, x); y = Math.min(sh - 1.001, y);
      const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0;
      const p00 = (y0 * sw + x0) * 4, p10 = p00 + 4, p01 = p00 + sw * 4, p11 = p01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        o[q + ch] = (sd[p00 + ch] * (1 - ax) + sd[p10 + ch] * ax) * (1 - ay) + (sd[p01 + ch] * (1 - ax) + sd[p11 + ch] * ax) * ay;
      }
    }
  }
  octx.putImageData(od, 0, 0);
  if (!land) return out;
  const back = document.createElement('canvas'); back.width = outW; back.height = outH;
  const b = back.getContext('2d'); b.translate(0, outH); b.rotate(-Math.PI / 2); b.drawImage(out, 0, 0);
  return back;
}

// Seite am Bildrand angeschnitten? Dann fehlen dem Netz die Blattkanten – klassisch bleibt besser.
export function edgeCut(corners) {
  if (isFullQuad(corners)) return false;
  return corners.some(([x, y]) => x < 0.015 || y < 0.015 || x > 0.985 || y > 0.985);
}

// Merkt sich, ob „KI-Glätten“ eingeschaltet bleiben soll
const PREF = 'nibvion.ai';
export function aiPref() { try { return localStorage.getItem(PREF) === '1'; } catch { return false; } }
export function setAiPref(v) { try { localStorage.setItem(PREF, v ? '1' : '0'); } catch {} }

// Berechnet die geglättete Seite für ein Scan-Element (einmal je Zuschnitt).
export async function ensureAI(item, onProgress) {
  if (!item.ai) return false;
  const key = JSON.stringify(item.corners);
  if (item._ai && item._ai.key === key) return true;
  const ref = warp(item.img, item.corners, 600);              // nur für das Seitenverhältnis
  const r = ref.width / ref.height, L = 2200;
  const w = Math.round(r >= 1 ? L : L * r), h = Math.round(r >= 1 ? L / r : L);
  const canvas = await aiFlatten(item.img, item.corners, w, h, onProgress);
  item._ai = { key, canvas };
  return true;
}
