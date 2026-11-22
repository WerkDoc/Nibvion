// ================= Scanner: Kanten erkennen, entzerren, aufbereiten =================
// Alles lokal, ohne Bibliothek. Ecken werden normiert (0..1) in der Reihenfolge
// oben-links, oben-rechts, unten-rechts, unten-links gespeichert.
import { icon } from './icons.js';
import { loadImage, haptic } from './ui.js';

export const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
const isFull = c => c.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 1e-3 && Math.abs(p[1] - FULL[i][1]) < 1e-3);

// ---------- Bild laden ----------
export async function loadFileImage(file) {
  const url = URL.createObjectURL(file);
  const img = await loadImage(url);
  return { img, url };
}

export function toCanvas(img, maxSide) {
  const w = img.videoWidth || img.naturalWidth || img.width, h = img.videoHeight || img.naturalHeight || img.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0; const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// ---------- Kanten erkennen ----------
// detectQuad: Ecken oder null (kein Dokument gefunden). detectCorners: mit Rückfall auf ganzes Bild.
export function detectCorners(img) { return detectQuad(img) || FULL.map(p => [...p]); }

export function detectQuad(img, maxSide = 360) {
  try {
    const c = toCanvas(img, maxSide), w = c.width, h = c.height, N = w * h;
    const d = c.getContext('2d').getImageData(0, 0, w, h).data;
    const g = new Float32Array(N);
    for (let i = 0; i < N; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    const b = boxBlur(boxBlur(g, w, h, 2), w, h, 2);
    // Otsu-Schwelle
    const hist = new Array(256).fill(0);
    for (let i = 0; i < N; i++) hist[b[i] | 0]++;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = N - wB; if (!wF) break;
      sB += t * hist[t];
      const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > best) { best = v; thr = t; }
    }
    // Größte helle Fläche (Papier) suchen
    const lab = new Int32Array(N); let bestLab = 0, bestN = 0, cur = 0;
    const stack = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      if (lab[i] || b[i] <= thr) continue;
      cur++; let sp = 0, n = 0; stack[sp++] = i; lab[i] = cur;
      while (sp) {
        const p = stack[--sp]; n++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && !lab[p - 1] && b[p - 1] > thr) { lab[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && !lab[p + 1] && b[p + 1] > thr) { lab[p + 1] = cur; stack[sp++] = p + 1; }
        if (y > 0 && !lab[p - w] && b[p - w] > thr) { lab[p - w] = cur; stack[sp++] = p - w; }
        if (y < h - 1 && !lab[p + w] && b[p + w] > thr) { lab[p + w] = cur; stack[sp++] = p + w; }
      }
      if (n > bestN) { bestN = n; bestLab = cur; }
    }
    if (bestN < N * 0.12 || bestN > N * 0.97) return null;
    // Extrempunkte als Ecken
    let tl = [0, 0, 1e9], tr = [0, 0, -1e9], br = [0, 0, -1e9], bl = [0, 0, 1e9];
    for (let i = 0; i < N; i++) {
      if (lab[i] !== bestLab) continue;
      const x = i % w, y = (i / w) | 0, s = x + y, df = x - y;
      if (s < tl[2]) tl = [x, y, s];
      if (s > br[2]) br = [x, y, s];
      if (df > tr[2]) tr = [x, y, df];
      if (df < bl[2]) bl = [x, y, df];
    }
    const q = [tl, tr, br, bl].map(([x, y]) => [Math.min(1, Math.max(0, (x + 0.5) / w)), Math.min(1, Math.max(0, (y + 0.5) / h))]);
    return quadArea(q) > 0.12 ? q : null;
  } catch { return null; }
}

function quadArea(q) {
  let a = 0; for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

// ---------- Perspektive entzerren ----------
function squareToQuad(p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

// ---------- Echtes Seitenverhältnis ----------
// Aus den 4 Ecken im Foto und der Kamerageometrie (Zhang & He, „Whiteboard Scanning“)
// wird das wahre Breite/Höhe-Verhältnis des Blatts berechnet. Ohne das wirken schräg
// fotografierte Blätter gestaucht, weil entfernte Kanten im Foto kürzer erscheinen.
export function aspectRatio(P, W, H) {
  const cx = W / 2, cy = H / 2;
  const m = p => [p[0] - cx, p[1] - cy, 1];
  const m1 = m(P[0]), m2 = m(P[1]), m3 = m(P[3]), m4 = m(P[2]);   // oben-links, oben-rechts, unten-links, unten-rechts
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]), n3 = m3.map((v, i) => k3 * v - m1[i]);
  const long = Math.max(W, H);
  let f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  const f = Math.sqrt(f2);
  // Unplausibel (fast frontal fotografiert, Rundungsfehler) → typische Handy-Brennweite annehmen
  if (!isFinite(f) || f < long * 0.45 || f > long * 3) f2 = (0.82 * long) ** 2;
  const r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / f2 + n2[2] ** 2) / Math.sqrt((n3[0] ** 2 + n3[1] ** 2) / f2 + n3[2] ** 2);
  return isFinite(r) && r > 0 ? r : null;
}

export function warp(img, corners, maxSide = 2200) {
  if (isFull(corners)) return toCanvas(img, maxSide);
  const src = toCanvas(img, Math.max(maxSide * 1.25, 1200));
  const sw = src.width, sh = src.height;
  const P = corners.map(([x, y]) => [x * sw, y * sh]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let w = Math.max(dist(P[0], P[1]), dist(P[3], P[2])), h = Math.max(dist(P[0], P[3]), dist(P[1], P[2]));
  // Seitenverhältnis korrigieren (Fläche bleibt etwa gleich)
  const edgeR = w / h, r = aspectRatio(P, sw, sh);
  if (r && r / edgeR < 2.2 && edgeR / r < 2.2) { const base = Math.sqrt(w * h); w = base * Math.sqrt(r); h = base / Math.sqrt(r); }
  const k = Math.min(1, maxSide / Math.max(w, h)); w = Math.max(8, Math.round(w * k)); h = Math.max(8, Math.round(h * k));
  const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const octx = out.getContext('2d'); const od = octx.createImageData(w, h); const o = od.data;
  const [a, b, c, d, e, f, g, hh] = squareToQuad(P);
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h;
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w, z = g * u + hh * v + 1;
      let x = (a * u + b * v + c) / z - 0.5, y = (d * u + e * v + f) / z - 0.5;
      x = Math.min(sw - 1.001, Math.max(0, x)); y = Math.min(sh - 1.001, Math.max(0, y));
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const p00 = (y0 * sw + x0) * 4, p10 = p00 + 4, p01 = p00 + sw * 4, p11 = p01 + 4;
      const q = (j * w + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const t = sd[p00 + ch] * (1 - fx) + sd[p10 + ch] * fx, bt = sd[p01 + ch] * (1 - fx) + sd[p11 + ch] * fx;
        o[q + ch] = t * (1 - fy) + bt * fy;
      }
      o[q + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

// ---------- Begradigen (Rest-Schräglage, Trapez, Wölbung) ----------
// Nach dem Entzerren über die 4 Ecken bleiben oft leichte Schräglagen oder eine Wölbung
// (z. B. Etikett auf rundem Karton). Die Richtung der Textzeilen und Linien wird in
// mehreren Feldern gemessen (Projektionsprofil) und daraus ein Verschiebungsfeld gebaut,
// das alle Zeilen waagerecht und senkrechte Linien senkrecht zieht.
export function inkPoints(c, x0, y0, x1, y1, thr, data, W, maxN) {
  // Zufällige Stichprobe (ein festes Raster würde 0° vortäuschen)
  let ink = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * W + x) * 4;
    if (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < thr) ink.push(x, y);
  }
  const n = ink.length / 2;
  if (n <= maxN) return ink;
  const out = [], p = maxN / n;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < ink.length; k += 2) if (rnd() < p) out.push(ink[k], ink[k + 1]);
  return out;
}
export function bestAngle(pts, vertical, maxDeg = 6, stepDeg = 0.2) {
  const n = pts.length / 2;
  if (n < 150) return null;
  let minR = 1e9, maxR = -1e9;
  for (let i = 0; i < pts.length; i += 2) { const v = vertical ? pts[i] : pts[i + 1]; if (v < minR) minR = v; if (v > maxR) maxR = v; }
  let ext = 0; for (let i = 0; i < pts.length; i += 2) ext = Math.max(ext, Math.abs(vertical ? pts[i + 1] : pts[i]));
  const pad = Math.ceil(ext * Math.tan(maxDeg * Math.PI / 180)) + 4;
  const size = Math.ceil(maxR - minR) + pad * 2 + 2;
  const bins = new Float32Array(size);
  const scores = [];
  for (let a = -maxDeg; a <= maxDeg + 1e-9; a += stepDeg) {
    const t = a * Math.PI / 180, sn = Math.sin(t), cs = Math.cos(t);
    bins.fill(0);
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      const r = vertical ? x * cs + y * sn : y * cs - x * sn;
      bins[Math.round(r - minR) + pad]++;
    }
    // Schärfe des Profils: Summe der quadrierten Sprünge (Linien/Zeilen ergeben scharfe Spitzen)
    let sc = 0; for (let k = 1; k < size; k++) { const d = bins[k] - bins[k - 1]; sc += d * d; }
    scores.push(sc);
  }
  let bi = 0; for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
  // Parabel-Feinjustierung zwischen den Nachbarwinkeln
  let off = 0;
  if (bi > 0 && bi < scores.length - 1) { const l = scores[bi - 1], c = scores[bi], r = scores[bi + 1], den = l - 2 * c + r; if (den < 0) off = 0.5 * (l - r) / den; }
  const mean = scores.reduce((x, y) => x + y, 0) / scores.length;
  return { angle: -maxDeg + (bi + off) * stepDeg, conf: scores[bi] / mean };
}

export function estimateStraighten(c) {
  try {
    const W = c.width, H = c.height;
    const data = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const hist = new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 16) hist[(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0]++;
    const tot = hist.reduce((x, y) => x + y, 0); let acc = 0, paper = 200;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > tot * 0.35) { paper = v; break; } }
    const thr = paper * 0.62;
    const pts = (x0, y0, x1, y1, n) => inkPoints(c, Math.max(0, x0 | 0), Math.max(0, y0 | 0), Math.min(W, x1 | 0), Math.min(H, y1 | 0), thr, data, W, n);
    const g = bestAngle(pts(0, 0, W, H, 40000), false);
    if (!g || g.conf < 1.15) return null;
    // Verlauf über die Breite (Wölbung) aus überlappenden Spaltenstreifen
    const GX = 6, GY = 4;
    const col = [], row = [];
    for (let i = 0; i < GX; i++) {
      const cx = (i + 0.5) * W / GX, hw = W / GX * 0.9;
      const r = bestAngle(pts(cx - hw, 0, cx + hw, H, 12000), false);
      col.push(r && r.conf > 1.15 ? r.angle : NaN);
    }
    // Verlauf über die Höhe (Trapez) aus überlappenden Zeilenbändern
    for (let j = 0; j < GY; j++) {
      const cy = (j + 0.5) * H / GY, hh = H / GY * 0.75;
      const r = bestAngle(pts(0, cy - hh, W, cy + hh, 12000), false);
      row.push(r && r.conf > 1.15 ? r.angle : NaN);
    }
    const fill = a => a.map(v => isNaN(v) ? g.angle : v);
    const cA = fill(col), rA = fill(row);
    // Einzelne Ausreißer (> 2,5° vom Nachbarschnitt) dämpfen
    const damp = a => a.map((v, i) => { const nb = [a[i - 1], a[i + 1]].filter(x => x != null); const m = nb.reduce((x, y) => x + y, 0) / nb.length; return Math.abs(v - m) > 2.5 ? m : v; });
    const cS = damp(cA), rS = damp(rA);
    const grid = [];
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) grid.push(cS[i] + rS[j] - g.angle);
    // Senkrechte: eigene Messung, sonst mit der Schräglage mitdrehen
    const v = bestAngle(pts(0, 0, W, H, 40000), true);
    const shear = Math.tan(((v && v.conf > 1.4) ? v.angle : g.angle) * Math.PI / 180);
    if (Math.max(...grid.map(Math.abs)) < 0.15 && Math.abs(shear) < 0.003) return null;
    return { GX, GY, grid, shear };
  } catch { return null; }
}

// Verschiebungsfeld anwenden: Ausgabe(x,y) = Eingabe(x + u(y), y + v(x,y))
export function applyStraighten(c, st) {
  if (!st) return c;
  const W = c.width, H = c.height, { GX, GY, grid, shear } = st;
  const S = 64;
  // v je Band: v(x) = ∫ tan θ dx ab Bildmitte
  const bandV = [];
  for (let gy = 0; gy < GY; gy++) {
    const slope = x => {
      const fx = clampN(x / W * GX - 0.5, 0, GX - 1), i = Math.floor(fx), f = fx - i;
      const a = grid[gy * GX + i], b = grid[gy * GX + Math.min(GX - 1, i + 1)];
      return Math.tan((a + (b - a) * f) * Math.PI / 180);
    };
    const vs = new Float32Array(S + 1);
    for (let k = 1; k <= S; k++) { const xa = (k - 1) / S * W, xb = k / S * W; vs[k] = vs[k - 1] + (slope(xa) + slope(xb)) / 2 * (xb - xa); }
    const mid = vs[S >> 1];
    for (let k = 0; k <= S; k++) vs[k] -= mid;
    bandV.push(vs);
  }
  const vAt = (x, y) => {
    const fy = clampN(y / H * GY - 0.5, 0, GY - 1), j = Math.floor(fy), g = fy - j, j2 = Math.min(GY - 1, j + 1);
    const fx = clampN(x / W * S, 0, S), k = Math.min(S - 1, Math.floor(fx)), f = fx - k;
    const a = bandV[j][k] + (bandV[j][k + 1] - bandV[j][k]) * f, b = bandV[j2][k] + (bandV[j2][k + 1] - bandV[j2][k]) * f;
    return a + (b - a) * g;
  };
  const sd = c.getContext('2d').getImageData(0, 0, W, H).data;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const octx = out.getContext('2d'), od = octx.createImageData(W, H), o = od.data;
  // v auf grobem Raster vorberechnen (schnell), dazwischen linear
  const RX = Math.min(W, 128), RY = Math.min(H, 128);
  const vg = new Float32Array((RX + 1) * (RY + 1));
  for (let j = 0; j <= RY; j++) for (let i = 0; i <= RX; i++) vg[j * (RX + 1) + i] = vAt(i / RX * W, j / RY * H);
  for (let y = 0; y < H; y++) {
    const fy = y / H * RY, j = Math.min(RY - 1, Math.floor(fy)), gy = fy - j;
    const u = -(y - H / 2) * shear;
    for (let x = 0; x < W; x++) {
      const fx = x / W * RX, i = Math.min(RX - 1, Math.floor(fx)), gx = fx - i;
      const p = j * (RX + 1) + i;
      const v = (vg[p] * (1 - gx) + vg[p + 1] * gx) * (1 - gy) + (vg[p + RX + 1] * (1 - gx) + vg[p + RX + 2] * gx) * gy;
      let sx = x + u, sy = y + v;
      const q = (y * W + x) * 4;
      if (sx < 0 || sy < 0 || sx > W - 1.001 || sy > H - 1.001) { o[q] = o[q + 1] = o[q + 2] = 255; o[q + 3] = 255; continue; }
      const x0 = sx | 0, y0 = sy | 0, ax = sx - x0, ay = sy - y0;
      const p00 = (y0 * W + x0) * 4, p10 = p00 + 4, p01 = p00 + W * 4, p11 = p01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const t = sd[p00 + ch] * (1 - ax) + sd[p10 + ch] * ax, b = sd[p01 + ch] * (1 - ax) + sd[p11 + ch] * ax;
        o[q + ch] = t * (1 - ay) + b * ay;
      }
      o[q + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}
const clampN = (v, a, b) => v < a ? a : v > b ? b : v;

export function rotateCanvas(c, deg) {
  deg = ((deg % 360) + 360) % 360; if (!deg) return c;
  const o = document.createElement('canvas');
  o.width = deg % 180 ? c.height : c.width; o.height = deg % 180 ? c.width : c.height;
  const x = o.getContext('2d'); x.translate(o.width / 2, o.height / 2); x.rotate(deg * Math.PI / 180);
  x.drawImage(c, -c.width / 2, -c.height / 2);
  return o;
}

// ---------- Aufbereiten (Schatten raus, Papier weiß) ----------
export const FILTERS = [
  ['', 'Original'], ['color', 'Verbessern'], ['gray', 'Graustufen'],
  ['doc', 'Dokument'], ['bw', 'Schwarz-Weiß'], ['invert', 'Umkehren'],
];
export const NO_ADJ = { brightness: 0, contrast: 0, sharp: 0 };

// Papierhelligkeit je Pixel schätzen (für Schattenentfernung)
function paperLevel(c) {
  const w = c.width, h = c.height;
  const sw = Math.max(8, Math.round(w / 24)), sh = Math.max(8, Math.round(h / 24));
  const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
  const sctx = sc.getContext('2d'); sctx.drawImage(c, 0, 0, sw, sh);
  const sdat = sctx.getImageData(0, 0, sw, sh).data;
  const lum = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) lum[i] = Math.max(sdat[i * 4], sdat[i * 4 + 1], sdat[i * 4 + 2]);
  const mx = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(sw - 1, Math.max(0, x + dx)), yy = Math.min(sh - 1, Math.max(0, y + dy)); m = Math.max(m, lum[yy * sw + xx]);
    }
    mx[y * sw + x] = m;
  }
  const bl = boxBlur(mx, sw, sh, 2);
  for (let i = 0; i < sw * sh; i++) { sdat[i * 4] = sdat[i * 4 + 1] = sdat[i * 4 + 2] = Math.max(40, bl[i]); sdat[i * 4 + 3] = 255; }
  sctx.putImageData(new ImageData(sdat, sw, sh), 0, 0);
  const bc = document.createElement('canvas'); bc.width = w; bc.height = h;
  const bctx = bc.getContext('2d'); bctx.imageSmoothingQuality = 'high'; bctx.drawImage(sc, 0, 0, w, h);
  return bctx.getImageData(0, 0, w, h).data;
}

export function enhance(c, mode, adj = NO_ADJ) {
  const { brightness = 0, contrast = 0, sharp = 0 } = adj || NO_ADJ;
  if (!mode && !brightness && !contrast && !sharp) return c;
  const w = c.width, h = c.height, ctx = c.getContext('2d');
  const id = ctx.getImageData(0, 0, w, h), d = id.data;
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
  if (mode) {
    const bg = paperLevel(c);
    const curve = (v, lo, hi) => clamp((v - lo) * 255 / (hi - lo));
    for (let i = 0; i < d.length; i += 4) {
      const k = 255 / bg[i];
      if (mode === 'color') {
        // Verbessern: Papier reinweiß, Schrift kräftig dunkel, Farben bleiben (z. B. blaue Unterschrift)
        const r = d[i] * k, g = d[i + 1] * k, b = d[i + 2] * k;
        const L = r * 0.299 + g * 0.587 + b * 0.114;
        const t = clamp((L - 55) / (222 - 55) * 255) / 255;
        const nl = 255 * Math.pow(t, 1.65);                 // Mitteltöne dunkler, Weiß sättigt
        if (nl >= 250) { d[i] = d[i + 1] = d[i + 2] = 255; continue; }
        const sat = 1.25 * (1 - t * 0.6);
        d[i] = clamp(nl + (r - L) * sat); d[i + 1] = clamp(nl + (g - L) * sat); d[i + 2] = clamp(nl + (b - L) * sat);
      } else {
        const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * k;
        let v;
        if (mode === 'gray') v = curve(g, 25, 248);
        else if (mode === 'bw') v = clamp((g - 150) * 7 + 128);       // weiches Schwellwert-S/W (glatte Kanten)
        else { const t = clamp((g - 60) / (225 - 60) * 255) / 255; v = 255 * Math.pow(t, 1.9); }   // doc & invert: Schwarz auf Weiß
        if (mode === 'invert') v = 255 - v;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
  }
  // Schärfe (Unscharf maskieren auf der Helligkeit) – Verbessern/Dokument immer etwas nachgeschärft
  const autoSharp = mode === 'color' || mode === 'doc' || mode === 'invert' ? 22 : 0;
  const sharpAll = sharp + autoSharp;
  if (sharpAll > 0) {
    const N = w * h, L = new Float32Array(N);
    for (let i = 0; i < N; i++) L[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    const B = boxBlur(L, w, h, 1), amt = sharpAll / 40;
    for (let i = 0; i < N; i++) {
      const dl = (L[i] - B[i]) * amt;
      d[i * 4] = clamp(d[i * 4] + dl); d[i * 4 + 1] = clamp(d[i * 4 + 1] + dl); d[i * 4 + 2] = clamp(d[i * 4 + 2] + dl);
    }
  }
  if (brightness || contrast) {
    const cf = (100 + contrast * 1.5) / 100, br = brightness * 1.6;
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - 128) * cf + 128 + br;
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

export function render(item, filter, maxSide, adj) {
  let c = warp(item.img, item.corners, maxSide);
  // Begradigen: Feld einmal je Zuschnitt auf kleiner Kopie schätzen, dann in jeder Größe anwenden
  if (item.straighten !== false) {
    const key = JSON.stringify(item.corners);
    if (item._stKey !== key) { item._st = estimateStraighten(warp(item.img, item.corners, 1000)); item._stKey = key; }
    if (item._st) c = applyStraighten(c, item._st);
  }
  c = rotateCanvas(c, item.rot || 0);
  return enhance(c, filter, adj);
}

// ---------- Zuschneiden (Vollbild) ----------
export function cropEditor(item) {
  return new Promise(resolve => {
    let corners = item.corners.map(p => [...p]);
    let rot = item.rot || 0;
    const wrap = document.createElement('div');
    wrap.className = 'pad-wrap crop-wrap';
    wrap.innerHTML = `
      <div class="pad-head">
        <button class="sheet-close" data-x>${icon('x')}</button>
        <div class="sheet-title">Zuschneiden</div>
        <button class="link-btn" data-ok>Fertig</button>
      </div>
      <div class="crop-stage no-swipe"><canvas class="crop-img"></canvas><svg class="crop-svg"></svg><div class="loupe"><canvas></canvas></div></div>
      <div class="crop-foot">
        <button class="crop-btn" data-auto>${icon('sparkles')}<span>Automatisch</span></button>
        <button class="crop-btn" data-full>${icon('fit')}<span>Ganzes Bild</span></button>
        <button class="crop-btn" data-rot>${icon('rotate')}<span>Drehen <b data-rv>${rot}°</b></span></button>
      </div>`;
    document.body.appendChild(wrap);
    const stage = wrap.querySelector('.crop-stage'), cv = wrap.querySelector('.crop-img'), svg = wrap.querySelector('.crop-svg');
    const loupe = wrap.querySelector('.loupe'), lc = loupe.querySelector('canvas');
    const src = toCanvas(item.img, 1600);
    let box = { x: 0, y: 0, w: 1, h: 1 };
    const layout = () => {
      const r = stage.getBoundingClientRect();
      const s = Math.min(r.width / src.width, r.height / src.height);
      box = { w: src.width * s, h: src.height * s }; box.x = (r.width - box.w) / 2; box.y = (r.height - box.h) / 2;
      const dpr = Math.min(2, devicePixelRatio || 1);
      cv.width = box.w * dpr; cv.height = box.h * dpr;
      Object.assign(cv.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
      cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
      svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
      draw();
    };
    const P = i => [box.x + corners[i][0] * box.w, box.y + corners[i][1] * box.h];
    const draw = () => {
      const pts = [0, 1, 2, 3].map(P);
      const poly = pts.map(p => p.join(',')).join(' ');
      const r = stage.getBoundingClientRect();
      svg.innerHTML = `<path class="crop-shade" fill-rule="evenodd" d="M0 0H${r.width}V${r.height}H0Z M${pts.map(p => p.join(' ')).join(' L')}Z"/>
        <polygon class="crop-line" points="${poly}"/>` +
        pts.map((p, i) => `<circle class="crop-h" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="15"/>`).join('');
    };
    let drag = null;
    svg.addEventListener('pointerdown', e => {
      const r = stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let bi = -1, bd = 60;
      for (let i = 0; i < 4; i++) { const p = P(i), dd = Math.hypot(p[0] - x, p[1] - y); if (dd < bd) { bd = dd; bi = i; } }
      if (bi < 0) return;
      const p = P(bi); drag = { i: bi, ox: p[0] - x, oy: p[1] - y };
      svg.setPointerCapture(e.pointerId); e.preventDefault(); haptic(); move(e);
    });
    const move = e => {
      if (!drag) return;
      const r = stage.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left + drag.ox - box.x) / box.w));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top + drag.oy - box.y) / box.h));
      corners[drag.i] = [x, y]; draw();
      // Lupe
      const Z = 2.4, L = 110, ldpr = Math.min(2, devicePixelRatio || 1);
      lc.width = lc.height = L * ldpr; const g = lc.getContext('2d');
      const sx = x * src.width, sy = y * src.height, sz = L / (Z * box.w / src.width);
      g.fillStyle = '#000'; g.fillRect(0, 0, lc.width, lc.height);
      g.drawImage(src, sx - sz / 2, sy - sz / 2, sz, sz, 0, 0, lc.width, lc.height);
      g.strokeStyle = '#ff6a5b'; g.lineWidth = 2 * ldpr; g.beginPath();
      g.moveTo(lc.width / 2, lc.height / 2 - 12 * ldpr); g.lineTo(lc.width / 2, lc.height / 2 + 12 * ldpr);
      g.moveTo(lc.width / 2 - 12 * ldpr, lc.height / 2); g.lineTo(lc.width / 2 + 12 * ldpr, lc.height / 2); g.stroke();
      const px = box.x + x * box.w, py = box.y + y * box.h;
      loupe.style.left = (px < r.width / 2 ? r.width - L - 12 : 12) + 'px';
      loupe.style.top = Math.max(8, Math.min(r.height - L - 8, py - L - 40)) + 'px';
      loupe.classList.add('show');
    };
    svg.addEventListener('pointermove', move);
    const up = () => { drag = null; loupe.classList.remove('show'); };
    svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
    const close = v => { removeEventListener('resize', layout); wrap.remove(); resolve(v); };
    wrap.querySelector('[data-x]').onclick = () => close(null);
    wrap.querySelector('[data-ok]').onclick = () => close({ corners, rot });
    wrap.querySelector('[data-auto]').onclick = () => { corners = detectCorners(item.img); draw(); haptic(); };
    wrap.querySelector('[data-full]').onclick = () => { corners = FULL.map(p => [...p]); draw(); haptic(); };
    wrap.querySelector('[data-rot]').onclick = () => { rot = (rot + 90) % 360; wrap.querySelector('[data-rv]').textContent = rot + '°'; haptic(); };
    addEventListener('resize', layout);
    requestAnimationFrame(layout);
  });
}
