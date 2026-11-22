// ================= Scanner: Kanten erkennen, entzerren, aufbereiten =================
// Alles lokal, ohne Bibliothek. Ecken werden normiert (0..1) in der Reihenfolge
// oben-links, oben-rechts, unten-rechts, unten-links gespeichert.
import { icon } from './icons.js';
import { loadImage, haptic } from './ui.js';

export const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
export const isFull = c => c.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 1e-3 && Math.abs(p[1] - FULL[i][1]) < 1e-3);

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

// Erkennung in 3 Schritten:
//  1. „Papier-Wert“ je Pixel: hell UND farblos (Holz, Karton, Tisch sind farbig → fallen raus)
//  2. Mehrere Schwellen × größte Flächen → je ein bestes Viereck (aus der konvexen Hülle);
//     bewertet nach Füllgrad (Rechteckigkeit) und Kontrast entlang aller vier Kanten
//  3. Feinjustierung: jede Kante auf höherer Auflösung an den stärksten Hell/Dunkel-Sprung gelegt
export function detectQuad(img, maxSide = 360) {
  try {
    const fine = maxSide >= 440;
    const c = toCanvas(img, maxSide), w = c.width, h = c.height, N = w * h;
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const pv = paperValues(d, N);
    const b = boxBlur(boxBlur(pv, w, h, 1), w, h, 2);
    // Zweiter Kanal gegen Schatten: Wert relativ zum hellsten Wert der Umgebung.
    // Neben dem Blatt wird der Tisch dadurch dunkel, auch wenn er im Schatten liegt.
    const mx = maxFilter(b, w, h, Math.max(4, Math.round(Math.max(w, h) * 0.05)));
    const nb = new Float32Array(N);
    for (let i = 0; i < N; i++) nb[i] = 230 * b[i] / Math.max(20, mx[i]);
    const lab = new Int32Array(N), stack = new Int32Array(N);
    let best = null;
    const t0 = otsu(b, N), t1 = otsu(nb, N);
    // Dritter Kanal: Flächen zwischen Kanten (helligkeitsunabhängig, findet auch weißes Blatt auf hellem Tisch)
    const lb = boxBlur(pv, w, h, 1), eg = new Float32Array(N);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, lg = v => Math.log(v + 8);
      const gx = lg(lb[i + 1]) - lg(lb[i - 1]), gy = lg(lb[i + w]) - lg(lb[i - w]);
      if (gx * gx + gy * gy > 0.05 * 0.05) { eg[i] = 1; eg[i - 1] = eg[i + 1] = eg[i - w] = eg[i + w] = 1; }
    }
    // vom Bildrand aus über kantenfreie Pixel füllen = Tisch; Rest = Blatt samt Inhalt
    const rg = new Float32Array(N).fill(255), st = new Int32Array(N); let sp = 0;
    const seed = i => { if (!eg[i] && rg[i]) { rg[i] = 0; st[sp++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed(N - w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (sp) {
      const q = st[--sp], x = q % w;
      if (x > 0) seed(q - 1); if (x < w - 1) seed(q + 1); if (q >= w) seed(q - w); if (q < N - w) seed(q + w);
    }
    // Vierter Kanal: reine Helligkeit – für farbiges Papier (gelb, rosa, blau …)
    const lv = new Float32Array(N);
    for (let i = 0; i < N; i++) lv[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    const lumB = boxBlur(boxBlur(lv, w, h, 1), w, h, 2), t2 = otsu(lumB, N);
    // Fünfter Kanal: Farbähnlichkeit zur Bildmitte (das Blatt liegt meist mittig) – trennt z. B.
    // gelbes Papier von hautfarbenem/hölzernem Hintergrund gleicher Helligkeit
    const ref = centerColor(d, w, h);
    const ccB = boxBlur(boxBlur(colorSim(d, N, ref), w, h, 1), w, h, 2), t3 = otsu(ccB, N);
    const runs = [[b, t0], [b, t0 + 14], [b, t0 + 28], [nb, t1], [nb, t1 - 15], [rg, 128],
      [lumB, t2, 1], [lumB, t2 + 20, 1], [lumB, t2 + 40, 1],
      [ccB, t3, 2], [ccB, Math.max(t3, 175), 2]];
    for (const [src, t, lum] of runs) {
      lab.fill(0); const comps = [];
      let cur = 0;
      for (let i = 0; i < N; i++) {
        if (lab[i] || src[i] <= t) continue;
        cur++; let sp = 0, n = 0; stack[sp++] = i; lab[i] = cur;
        while (sp) {
          const q = stack[--sp]; n++;
          const x = q % w;
          if (x > 0 && !lab[q - 1] && src[q - 1] > t) { lab[q - 1] = cur; stack[sp++] = q - 1; }
          if (x < w - 1 && !lab[q + 1] && src[q + 1] > t) { lab[q + 1] = cur; stack[sp++] = q + 1; }
          if (q >= w && !lab[q - w] && src[q - w] > t) { lab[q - w] = cur; stack[sp++] = q - w; }
          if (q < N - w && !lab[q + w] && src[q + w] > t) { lab[q + w] = cur; stack[sp++] = q + w; }
        }
        if (n > N * 0.06) comps.push([cur, n]);
      }
      comps.sort((x, y) => y[1] - x[1]);
      for (const [id, n] of comps.slice(0, 3)) {
        if (n > N * 0.97) continue;
        const quad = hullQuad(lab, id, w, h);
        if (!quad) continue;
        const qa = polyArea(quad);
        if (qa < N * 0.1) continue;
        const fill = Math.min(1, n / qa);
        const con = edgeContrast(lum === 1 ? lumB : lum === 2 ? ccB : b, w, h, quad) * (lum === 2 ? 0.2 : lum ? 0.85 : 1);
        // Fläche innen einfarbig? (Blatt + angrenzender Tisch/Haut gleicher Helligkeit → Abzug)
        const mix = mixedColor(d, w, h, quad, ref);
        const score = fill ** 3 * Math.sqrt(qa / N) * con * Math.max(0.05, 1 - 2.5 * mix);
        if (!best || score > best.score) best = { score, quad, fill, con, lum };
      }
    }
    if (!best || best.fill < 0.72 || best.con < 6) return null;
    let quad = best.quad;
    if (fine) quad = refineQuad(img, quad, w, h, best.lum, ref) || quad;
    const q = quad.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
    return quadArea(q) > 0.1 ? q : null;
  } catch (e) { console.warn(e); return null; }
}

// Hell und farblos = Papier
function paperValues(d, N) {
  const pv = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], bl = d[i * 4 + 2];
    const L = r * 0.299 + g * 0.587 + bl * 0.114;
    const ch = Math.max(r, g, bl) - Math.min(r, g, bl);
    pv[i] = Math.max(0, L - 1.1 * Math.max(0, ch - 12));
  }
  return pv;
}

function maxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0; const a = Math.max(0, x - r), z = Math.min(w - 1, x + r);
      for (let k = a; k <= z; k += 2) if (src[row + k] > m) m = src[row + k];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0; const a = Math.max(0, y - r), z = Math.min(h - 1, y + r);
      for (let k = a; k <= z; k += 2) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

// Anteil heller Pixel im Viereck, deren Farbton deutlich von der Blattfarbe (Bildmitte) abweicht
function mixedColor(d, w, h, q, ref) {
  const [R, G, B] = ref, S = R + G + B + 1, rr = R / S, rg = G / S, rb = B / S, Lr = R * 0.3 + G * 0.59 + B * 0.11;
  let n = 0, bad = 0;
  for (let j = 1; j < 24; j++) for (let i = 1; i < 24; i++) {
    const u = i / 24, v = j / 24;
    const x = (1 - u) * (1 - v) * q[0][0] + u * (1 - v) * q[1][0] + u * v * q[2][0] + (1 - u) * v * q[3][0];
    const y = (1 - u) * (1 - v) * q[0][1] + u * (1 - v) * q[1][1] + u * v * q[2][1] + (1 - u) * v * q[3][1];
    const o = (Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))) * 4;
    const r = d[o], g = d[o + 1], b = d[o + 2], L = r * 0.3 + g * 0.59 + b * 0.11;
    if (L < Lr * 0.55) continue;                       // Schrift/Schatten ignorieren
    const s2 = r + g + b + 1; n++;
    if (Math.hypot(r / s2 - rr, g / s2 - rg, b / s2 - rb) > 0.045) bad++;
  }
  return n ? bad / n : 0;
}

// Median-Farbe im mittleren Bildbereich (helle Pixel bevorzugt, Text ignorieren)
function centerColor(d, w, h) {
  const rs = [], gs = [], bs = [];
  for (let y = Math.round(h * 0.35); y < h * 0.65; y += 2) for (let x = Math.round(w * 0.35); x < w * 0.65; x += 2) {
    const o = (y * w + x) * 4; rs.push(d[o]); gs.push(d[o + 1]); bs.push(d[o + 2]);
  }
  const L = rs.map((r, i) => r * 0.3 + gs[i] * 0.59 + bs[i] * 0.11), idx = L.map((_, i) => i).sort((a, b) => L[b] - L[a]);
  const top = idx.slice(0, Math.max(1, Math.round(idx.length * 0.6)));   // hellere 60 % = Papier, nicht Schrift
  const med = a => { const v = top.map(i => a[i]).sort((x, y) => x - y); return v[v.length >> 1]; };
  return [med(rs), med(gs), med(bs)];
}
// 255 = gleiche Farbe wie die Mitte. Farbton (unabhängig von Helligkeit/Schatten) zählt stark,
// deutlich dunklere Pixel zählen zusätzlich als „anders“
function colorSim(d, N, ref) {
  const v = new Float32Array(N), [R, G, B] = ref, S = R + G + B + 1;
  const rr = R / S, rg = G / S, rb = B / S, Lr = R * 0.3 + G * 0.59 + B * 0.11 + 1;
  for (let i = 0; i < N; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], bl = d[i * 4 + 2], s = r + g + bl + 1;
    const cd = Math.hypot(r / s - rr, g / s - rg, bl / s - rb);
    const L = r * 0.3 + g * 0.59 + bl * 0.11;
    const dark = Math.max(0, 0.6 - L / Lr);
    v[i] = Math.max(0, 255 - cd * 1500 - dark * 500);
  }
  return v;
}

function lumValues(d, N) {
  const v = new Float32Array(N);
  for (let i = 0; i < N; i++) v[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  return v;
}

function otsu(b, N) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < N; i++) hist[Math.min(255, b[i] | 0)]++;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = N - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

function polyArea(q) {
  let a = 0; for (let i = 0; i < q.length; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % q.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

// Konvexe Hülle der Fläche → Viereck mit größter Fläche (Ecken im Uhrzeigersinn ab oben-links)
function hullQuad(lab, id, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    let l = -1, r = -1; const row = y * w;
    for (let x = 0; x < w; x++) if (lab[row + x] === id) { if (l < 0) l = x; r = x; }
    if (l >= 0) { pts.push([l, y]); if (r !== l) pts.push([r + 1, y]); }
  }
  if (pts.length < 8) return null;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  let H = lo.slice(0, -1).concat(up.slice(0, -1));
  if (H.length < 4) return null;
  if (H.length > 48) { const st = H.length / 48; H = Array.from({ length: 48 }, (_, i) => H[Math.floor(i * st)]); }
  const K = H.length, tri = (a, b, c) => Math.abs(cross(H[a], H[b], H[c])) / 2;
  let best = -1, bq = null;
  for (let i = 0; i < K; i++) for (let k = i + 2; k < K; k++) {
    let m1 = 0, j1 = -1, m2 = 0, j2 = -1;
    for (let j = i + 1; j < k; j++) { const a = tri(i, j, k); if (a > m1) { m1 = a; j1 = j; } }
    for (let j = k + 1; j < K + i; j++) { const jj = j % K; if (jj === i) continue; const a = tri(i, jj, k); if (a > m2) { m2 = a; j2 = jj; } }
    if (j1 >= 0 && j2 >= 0 && m1 + m2 > best) { best = m1 + m2; bq = [H[i], H[j1], H[k], H[j2]]; }
  }
  return bq && orderQuad(bq);
}

function orderQuad(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const s = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // Start = Ecke mit kleinster x+y (oben links); Reihenfolge im Uhrzeigersinn (Bildkoordinaten)
  let k = 0; for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[k][0] + s[k][1]) k = i;
  return [0, 1, 2, 3].map(i => s[(k + i) % 4]);
}

// Mittlerer Hell/Dunkel-Unterschied quer zu den Kanten (innen minus außen); Kanten am Bildrand zählen halb
function edgeContrast(b, w, h, q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const at = (x, y) => b[Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))];
  const vals = [];
  for (let e = 0; e < 4; e++) {
    const [x1, y1] = q[e], [x2, y2] = q[(e + 1) % 4];
    const L = Math.hypot(x2 - x1, y2 - y1) || 1;
    let nx = -(y2 - y1) / L, ny = (x2 - x1) / L;
    if ((cx - x1) * nx + (cy - y1) * ny < 0) { nx = -nx; ny = -ny; }    // Normale zeigt nach innen
    const off = Math.max(3, Math.min(w, h) * 0.012);
    let acc = 0, cnt = 0, border = 0;
    for (let k = 1; k < 20; k++) {
      const t = 0.1 + 0.8 * k / 20, x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
      const ox = x - nx * off, oy = y - ny * off;
      if (ox < 1 || oy < 1 || ox > w - 2 || oy > h - 2) { border++; continue; }
      acc += at(x + nx * off, y + ny * off) - at(ox, oy); cnt++;
    }
    vals.push(cnt > 5 ? acc / cnt : (border > 10 ? 12 : 0));
  }
  if (vals.filter(v => v === 12).length >= 3) return 0;          // praktisch ganzes Bild
  vals.sort((a, b) => a - b);
  return Math.max(0, (vals[0] + vals[1]) / 2 * 0.6 + (vals[2] + vals[3]) / 2 * 0.4);
}

// Kanten auf doppelter Auflösung an den stärksten Sprung legen (Gerade per Ausgleich), Ecken = Schnittpunkte
function refineQuad(img, q, w, h, lum, ref) {
  const S = 2, c = toCanvas(img, Math.max(w, h) * S), W = c.width, H = c.height;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const pv = boxBlur(lum === 1 ? lumValues(d, W * H) : lum === 2 ? colorSim(d, W * H, ref) : paperValues(d, W * H), W, H, 1);
  const sx = W / w, sy = H / h;
  const Q = q.map(([x, y]) => [x * sx, y * sy]);
  const cx = Q.reduce((s, p) => s + p[0], 0) / 4, cy = Q.reduce((s, p) => s + p[1], 0) / 4;
  const at = (x, y) => pv[Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))];
  const R = Math.round(Math.max(6, Math.min(W, H) * 0.02));
  const lines = [];
  for (let e = 0; e < 4; e++) {
    const [x1, y1] = Q[e], [x2, y2] = Q[(e + 1) % 4];
    const L = Math.hypot(x2 - x1, y2 - y1) || 1;
    let nx = -(y2 - y1) / L, ny = (x2 - x1) / L;
    if ((cx - x1) * nx + (cy - y1) * ny < 0) { nx = -nx; ny = -ny; }
    const pts = [];
    for (let k = 1; k < 40; k++) {
      const t = 0.08 + 0.84 * k / 40, x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
      let bg = 0, bo = 0;
      for (let o = -R; o <= R; o++) {
        const px = x + nx * o, py = y + ny * o;
        if (px < 2 || py < 2 || px > W - 3 || py > H - 3) continue;
        const g = at(px + nx * 2, py + ny * 2) - at(px - nx * 2, py - ny * 2);
        if (g > bg) { bg = g; bo = o; }
      }
      if (bg > 10) pts.push([x + nx * bo, y + ny * bo]);
    }
    lines.push(pts.length >= 8 ? fitLine(pts) : null);
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = lines[(i + 3) % 4], b = lines[i];
    const p = a && b ? intersect(a, b) : null;
    const o = Q[i];
    out.push(p && Math.hypot(p[0] - o[0], p[1] - o[1]) < R * 2.5 ? p : o);
  }
  return out.map(([x, y]) => [x / sx, y / sy]);
}

// Gerade durch Punkte (Hauptachse), ein Durchgang Ausreißer entfernen
function fitLine(pts) {
  const fit = P => {
    const n = P.length, mx = P.reduce((s, p) => s + p[0], 0) / n, my = P.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of P) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { mx, my, dx: Math.cos(ang), dy: Math.sin(ang) };
  };
  let l = fit(pts);
  const dist = p => Math.abs((p[0] - l.mx) * l.dy - (p[1] - l.my) * l.dx);
  const ds = pts.map(dist).sort((a, b) => a - b), lim = Math.max(1.5, ds[Math.floor(ds.length * 0.7)] * 2);
  const keep = pts.filter(p => dist(p) <= lim);
  if (keep.length >= 6) l = fit(keep);
  return l;
}
function intersect(a, b) {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.mx - a.mx) * b.dy - (b.my - a.my) * b.dx) / den;
  return [a.mx + a.dx * t, a.my + a.dy * t];
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
  ['', 'Original'], ['ai', '✨ KI-Scan'], ['color', 'Verbessern'], ['gray', 'Graustufen'],
  ['doc', 'Dokument'], ['bw', 'Schwarz-Weiß'], ['invert', 'Umkehren'],
];
export const NO_ADJ = { brightness: 0, contrast: 0, sharp: 0 };

// Papierhelligkeit je Pixel schätzen (für Schattenentfernung)
// Papierhelligkeit je Pixel schätzen (für Schatten/Knicke): auf ~1/6 Größe die Schrift per
// „Schließen“ (Maximum, dann Minimum) entfernen – Kanten von Knicken bleiben scharf, damit
// beide Seiten eines Knicks sauber weiß werden. Danach leicht weichzeichnen und hochskalieren.
function paperLevel(c) {
  const w = c.width, h = c.height;
  const f = Math.max(1, Math.round(Math.max(w, h) / 320));
  const sw = Math.max(8, Math.round(w / f)), sh = Math.max(8, Math.round(h / f));
  const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
  const sctx = sc.getContext('2d'); sctx.imageSmoothingQuality = 'high'; sctx.drawImage(c, 0, 0, sw, sh);
  const sdat = sctx.getImageData(0, 0, sw, sh).data;
  const N = sw * sh, lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = Math.max(sdat[i * 4], sdat[i * 4 + 1], sdat[i * 4 + 2]);
  const r = Math.max(3, Math.round(Math.max(sw, sh) * 0.022));          // größer als Schrifthöhe
  const closed = minFilter(maxFilterExact(lum, sw, sh, r), sw, sh, r);
  const bl = boxBlur(closed, sw, sh, 1);
  for (let i = 0; i < N; i++) { sdat[i * 4] = sdat[i * 4 + 1] = sdat[i * 4 + 2] = Math.max(40, bl[i]); sdat[i * 4 + 3] = 255; }
  sctx.putImageData(new ImageData(sdat, sw, sh), 0, 0);
  const bc = document.createElement('canvas'); bc.width = w; bc.height = h;
  const bctx = bc.getContext('2d'); bctx.imageSmoothingQuality = 'high'; bctx.drawImage(sc, 0, 0, w, h);
  return bctx.getImageData(0, 0, w, h).data;
}

function minFilter(src, w, h, r) {
  const neg = src.map(v => -v);
  return maxFilterExact(neg, w, h, r).map(v => -v);
}
// exakter (nicht ausgedünnter) Maximum-Filter, getrennt nach Zeilen/Spalten
function maxFilterExact(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = -Infinity; const a = Math.max(0, x - r), z = Math.min(w - 1, x + r);
    for (let k = a; k <= z; k++) if (src[y * w + k] > m) m = src[y * w + k];
    tmp[y * w + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = -Infinity; const a = Math.max(0, y - r), z = Math.min(h - 1, y + r);
    for (let k = a; k <= z; k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
    out[y * w + x] = m;
  }
  return out;
}

// Papierfarbe schätzen (Median heller Hintergrund-Pixel). Nur wenn deutlich farbig:
// wb = Weißabgleich (Papier → weiß), out = kräftige Papierfarbe für die Ausgabe
function paperTint(d, bg) {
  const rs = [], gs = [], bs = [];
  const step = Math.max(4, Math.floor(d.length / 4 / 40000)) * 4;
  for (let i = 0; i < d.length; i += step) {
    const k = 255 / bg[i], r = d[i] * k, g = d[i + 1] * k, b = d[i + 2] * k;
    if (r * 0.299 + g * 0.587 + b * 0.114 > 225) { rs.push(r); gs.push(g); bs.push(b); }
  }
  if (rs.length < 200) return null;
  const med = a => a.sort((x, y) => x - y)[a.length >> 1];
  const P = [med(rs), med(gs), med(bs)];
  if (Math.max(...P) - Math.min(...P) < 28) return null;                 // weißes/graues Papier
  const L = P[0] * 0.299 + P[1] * 0.587 + P[2] * 0.114;
  let out = P.map(v => L + (v - L) * 1.5);                                // etwas kräftiger
  const m = Math.max(...out); out = out.map(v => Math.max(0, Math.min(255, v * 252 / m)));
  return { wb: P.map(v => 255 / Math.max(40, Math.min(255, v))), out };
}

function thicken(d, w, h, bg) {
  const N = w * h, L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / bg[i * 4];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = L[i];
    if (l > 0.9) continue;
    let m = l;
    for (let k of [i - 1, i + 1, i - w, i + w]) if (L[k] < m) m = L[k];
    if (m >= l - 0.02) continue;
    const f = (l * 0.55 + m * 0.45) / l;                          // etwas Richtung dunkelster Nachbar
    d[i * 4] *= f; d[i * 4 + 1] *= f; d[i * 4 + 2] *= f;
  }
}

// Vom Bildrand aus zusammenhängende dunkle Flächen in einem schmalen Randstreifen → Papierfarbe
function cleanBorders(d, w, h, fill) {
  const band = Math.max(4, Math.round(Math.min(w, h) * 0.03)), N = w * h;
  const dark = i => d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114 < 200;
  const seen = new Uint8Array(N), st = new Int32Array(N); let sp = 0;
  const inBand = (x, y) => x < band || y < band || x >= w - band || y >= h - band;
  const push = (x, y) => { const i = y * w + x; if (!seen[i] && inBand(x, y) && dark(i)) { seen[i] = 1; st[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (sp) {
    const i = st[--sp], x = i % w, y = (i / w) | 0;
    d[i * 4] = fill[0]; d[i * 4 + 1] = fill[1]; d[i * 4 + 2] = fill[2];
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  // äußerster Rand (1 %) – dort steht nie Text, nur Krümel der Blattkante
  const e = Math.max(2, Math.round(Math.min(w, h) * 0.01));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= e && y >= e && x < w - e && y < h - e) { x = w - e - 1; continue; }
    const i = y * w + x; d[i * 4] = fill[0]; d[i * 4 + 1] = fill[1]; d[i * 4 + 2] = fill[2];
  }
}

export function enhance(c, mode, adj = NO_ADJ) {
  if (mode === 'ai' || mode === 'online') mode = 'color';   // ohne KI-/Online-Ergebnis: wie „Verbessern“
  const { brightness = 0, contrast = 0, sharp = 0 } = adj || NO_ADJ;
  if (!mode && !brightness && !contrast && !sharp) return c;
  const w = c.width, h = c.height, ctx = c.getContext('2d');
  const id = ctx.getImageData(0, 0, w, h), d = id.data;
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
  let paperFill = null;
  if (mode) {
    const bg = paperLevel(c);
    // Dünne, blasse Schrift etwas kräftiger: Schrift-Pixel mit dem dunkelsten Nachbarn mischen
    if (mode === 'color' || mode === 'doc' || mode === 'invert') thicken(d, w, h, bg);
    const curve = (v, lo, hi) => clamp((v - lo) * 255 / (hi - lo));
    // Farbiges Papier (gelb, rosa …)? Dann Papierfarbe kräftig behalten statt zu Weiß auszubleichen
    const tint = mode === 'color' ? paperTint(d, bg) : null;
    if (tint) paperFill = tint.out;
    const [wr, wg, wb] = tint ? tint.wb : [1, 1, 1];
    for (let i = 0; i < d.length; i += 4) {
      const k = 255 / bg[i];
      if (mode === 'color') {
        // Verbessern: Papier reinweiß (bzw. kräftige Papierfarbe), Schrift kräftig dunkel, Farben bleiben
        const r = d[i] * k * wr, g = d[i + 1] * k * wg, b = d[i + 2] * k * wb;
        const L = r * 0.299 + g * 0.587 + b * 0.114;
        // Papier ab 86 % Helligkeit reinweiß (Knick-Reste, Struktur weg); graue Schrift kräftig dunkel
        const t = clamp((L - 90) / (219 - 90) * 255) / 255;
        const nl = 255 * Math.pow(t, 2.1);
        if (tint) {
          const sat = 1.25 * (1 - t * 0.6), T = tint.out;
          const rr = nl >= 250 ? 255 : clamp(nl + (r - L) * sat), gg = nl >= 250 ? 255 : clamp(nl + (g - L) * sat), bb = nl >= 250 ? 255 : clamp(nl + (b - L) * sat);
          d[i] = rr * T[0] / 255; d[i + 1] = gg * T[1] / 255; d[i + 2] = bb * T[2] / 255;
          continue;
        }
        if (nl >= 250) { d[i] = d[i + 1] = d[i + 2] = 255; continue; }
        const sat = 1.25 * (1 - t * 0.6);
        d[i] = clamp(nl + (r - L) * sat); d[i + 1] = clamp(nl + (g - L) * sat); d[i + 2] = clamp(nl + (b - L) * sat);
      } else {
        const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * k;
        let v;
        if (mode === 'gray') v = curve(g, 25, 248);
        else if (mode === 'bw') v = clamp((g - 150) * 7 + 128);       // weiches Schwellwert-S/W (glatte Kanten)
        else { const t = clamp((g - 95) / (218 - 95) * 255) / 255; v = 255 * Math.pow(t, 2.2); }   // doc & invert: Schwarz auf Weiß
        if (mode === 'invert') v = 255 - v;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
  }
  // Dunkle Ränder (Tisch, Schatten an der Blattkante) entfernen
  if (mode && mode !== 'invert') cleanBorders(d, w, h, mode === 'color' && paperFill ? paperFill : [255, 255, 255]);
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
  // Online-Scan (js/online.js): fertiges Ergebnis von TextIn, nur noch drehen + eigene Anpassungen
  if (filter === 'online') {
    if (item._onl && item._onl.ck === JSON.stringify(item.corners)) return enhance(rotateCanvas(toCanvas(item._onl.canvas, maxSide), item.rot || 0), '', adj);
    filter = 'ai';
  }
  // KI-Scan (js/aienhance.js): fertiges KI-Ergebnis verwenden, danach wie „Verbessern“ nachschärfen
  if (filter === 'ai' && item._enh && item._enh.key === JSON.stringify([item.corners, item.rot || 0, !!(item.ai && item._ai?.canvas)])) {
    return enhance(toCanvas(item._enh.canvas, maxSide), 'color', adj);
  }
  // KI-geglättete Seite (js/ai.js) verwenden, wenn vorhanden und zum Zuschnitt passend
  if (item.ai && item._ai?.canvas && item._ai.key === JSON.stringify(item.corners)) {
    return enhance(rotateCanvas(toCanvas(item._ai.canvas, maxSide), item.rot || 0), filter, adj);
  }
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
