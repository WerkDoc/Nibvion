// ================= Smart Shapes: grobe Zeichnung → saubere Form =================
// Lokale Form-Analyse (kein Netz): gerade Linie, Pfeil, Rechteck, Dreieck, Kreis/Oval.
// recognize(points) → { kind, label, pts } oder null. pts ist ein Polygonzug in denselben
// Koordinaten wie die Eingabe; geschlossene Formen enden auf ihrem Startpunkt.
// morph() blendet den freien Strich mit einer Feder-Bewegung in die Form über (60 FPS, rAF).

const D = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const LABEL = { line: 'Linie', arrow: 'Pfeil', rect: 'Rechteck', square: 'Quadrat', tri: 'Dreieck', circle: 'Kreis', ellipse: 'Oval' };

export function pathLen(p) { let l = 0; for (let i = 1; i < p.length; i++) l += D(p[i - 1], p[i]); return l; }

/** Polygonzug gleichmäßig nach Bogenlänge auf n Punkte verteilen */
export function resample(p, n) {
  if (p.length < 2) return Array.from({ length: n }, () => [...(p[0] || [0, 0])]);
  const L = pathLen(p), step = L / (n - 1), out = [[...p[0]]];
  let acc = 0, i = 1, prev = p[0];
  while (out.length < n - 1 && i < p.length) {
    const d = D(prev, p[i]);
    if (acc + d >= step && d > 0) {
      const t = (step - acc) / d, q = [prev[0] + (p[i][0] - prev[0]) * t, prev[1] + (p[i][1] - prev[1]) * t];
      out.push(q); prev = q; acc = 0;
    } else { acc += d; prev = p[i]; i++; }
  }
  while (out.length < n) out.push([...p[p.length - 1]]);
  return out;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
// Ramer-Douglas-Peucker → Indizes der Eckpunkte
function rdp(p, eps, a = 0, b = p.length - 1, out = new Set([0, p.length - 1])) {
  let m = -1, md = 0;
  for (let i = a + 1; i < b; i++) { const d = segDist(p[i], p[a], p[b]); if (d > md) { md = d; m = i; } }
  if (md > eps) { out.add(m); rdp(p, eps, a, m, out); rdp(p, eps, m, b, out); }
  return out;
}
const angDeg = (a, b, c) => {     // Richtungsänderung bei b (0° = geradeaus)
  const u = Math.atan2(b[1] - a[1], b[0] - a[0]), v = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(v - u) * 180 / Math.PI; if (d > 180) d = 360 - d; return d;
};
const snapAng = (a, step, tol) => { const s = Math.round(a / step) * step; return Math.abs(a - s) < tol ? s : a; };

/** Hauptfunktion. minSize = kleinste sinnvolle Formgröße (in Eingabe-Einheiten) */
export function recognize(raw, minSize = 10) {
  if (!raw || raw.length < 5) return null;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of raw) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (diag < minSize) return null;
  const L = pathLen(raw), p0 = raw[0], pN = raw[raw.length - 1];
  const closed = D(p0, pN) < Math.max(0.2 * diag, minSize * 0.4) && L > 1.6 * diag;
  return closed ? closedShape(raw, diag) : openShape(raw, L);
}

function openShape(p, L) {
  const p0 = p[0], pN = p[p.length - 1], chord = D(p0, pN);
  // gerade Linie
  if (chord > 0) {
    let dev = 0; for (const q of p) dev = Math.max(dev, segDist(q, p0, pN));
    if (dev < 0.065 * chord && L < 1.18 * chord) {
      // fast waagerecht/senkrecht/45° → einrasten
      const a = Math.atan2(pN[1] - p0[1], pN[0] - p0[0]) * 180 / Math.PI, s = snapAng(a, 45, 4) * Math.PI / 180;
      const m = [(p0[0] + pN[0]) / 2, (p0[1] + pN[1]) / 2], h = chord / 2;
      return { kind: 'line', label: LABEL.line, pts: [[m[0] - Math.cos(s) * h, m[1] - Math.sin(s) * h], [m[0] + Math.cos(s) * h, m[1] + Math.sin(s) * h]] };
    }
  }
  // Pfeil: gerader Schaft bis zur Spitze (weitester Punkt vom Start), danach kurze Spitzen-Striche
  let ti = 0, td = 0;
  p.forEach(q => { td = Math.max(td, D(q, p0)); });
  ti = p.findIndex(q => D(q, p0) >= 0.97 * td);           // erster Besuch der Spitze (Spitze oft doppelt gezogen)
  const tip = p[ti], shaft = D(tip, p0);
  if (shaft <= 0 || ti < 3 || ti > p.length - 3) return null;
  let dev = 0; for (let i = 0; i <= ti; i++) dev = Math.max(dev, segDist(p[i], p0, tip));
  if (dev > 0.09 * shaft) return null;
  const tail = p.slice(ti), tl = pathLen(tail);
  if (tl < 0.12 * shaft) return null;
  const ux = (tip[0] - p0[0]) / shaft, uy = (tip[1] - p0[1]) / shaft;
  let head = 0, left = 0, right = 0;
  for (const q of tail) {
    const dx = q[0] - tip[0], dy = q[1] - tip[1], d = Math.hypot(dx, dy);
    if (d > 0.55 * shaft) return null;                      // läuft weit weg → kein Pfeil
    if (dx * ux + dy * uy > 0.08 * shaft) return null;       // Spitze muss nach hinten zeigen
    head = Math.max(head, d);
    const side = dx * -uy + dy * ux; if (side > 0.04 * shaft) right++; else if (side < -0.04 * shaft) left++;
  }
  if (!left && !right) return null;
  const hs = Math.max(0.1 * shaft, Math.min(0.32 * shaft, head));
  const a = snapAng(Math.atan2(uy, ux) * 180 / Math.PI, 45, 4) * Math.PI / 180;
  const T = [p0[0] + Math.cos(a) * shaft, p0[1] + Math.sin(a) * shaft], W = 28 * Math.PI / 180;
  const w1 = [T[0] - Math.cos(a - W) * hs, T[1] - Math.sin(a - W) * hs], w2 = [T[0] - Math.cos(a + W) * hs, T[1] - Math.sin(a + W) * hs];
  return { kind: 'arrow', label: LABEL.arrow, pts: [[...p0], T, w1, T, w2] };
}

function closedShape(raw, diag) {
  const N = 72, p = resample(raw, N);
  // ---- Ellipse über Hauptachsen (PCA) ----
  let cx = 0, cy = 0; p.forEach(([x, y]) => { cx += x; cy += y; }); cx /= N; cy /= N;
  let sxx = 0, syy = 0, sxy = 0; p.forEach(([x, y]) => { const dx = x - cx, dy = y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; });
  let th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(th), s = Math.sin(th);
  let vu = 0, vv = 0; const uv = p.map(([x, y]) => { const dx = x - cx, dy = y - cy, u = dx * c + dy * s, v = -dx * s + dy * c; vu += u * u; vv += v * v; return [u, v]; });
  let a = Math.sqrt(2 * vu / N), b = Math.sqrt(2 * vv / N);
  if (a > 0 && b > 0) {
    const rs = uv.map(([u, v]) => Math.hypot(u / a, v / b)), mr = rs.reduce((q, r) => q + r, 0) / N;
    a *= mr; b *= mr;
  }
  const ellErr = a > 0 && b > 0 ? uv.reduce((q, [u, v]) => q + Math.abs(Math.hypot(u / a, v / b) - 1), 0) / N : 1;

  // ---- Ecken (RDP auf der geschlossenen Schleife) ----
  let far = 0, fd = 0; p.forEach((q, i) => { const d = Math.hypot(q[0] - cx, q[1] - cy); if (d > fd) { fd = d; far = i; } });
  const loop = [...p.slice(far), ...p.slice(0, far), p[far]];
  let idx = [...rdp(loop, 0.075 * diag)].sort((x, y) => x - y);
  let v = idx.slice(0, -1).map(i => loop[i]);
  // fast gerade Eckpunkte und Doppelpunkte entfernen
  for (let k = 0, changed = true; changed && v.length > 2 && k < 20; k++) {
    changed = false;
    for (let i = 0; i < v.length; i++) {
      const A = v[(i - 1 + v.length) % v.length], B = v[i], C = v[(i + 1) % v.length];
      if (angDeg(A, B, C) < 28 || D(A, B) < 0.12 * diag) { v.splice(i, 1); changed = true; break; }
    }
  }

  const ellipse = () => {
    let A = a, B = b, t = th;
    if (Math.min(A, B) / Math.max(A, B) > 0.86) { A = B = (A + B) / 2; t = 0; }
    else t = snapAng(t * 180 / Math.PI, 90, 10) * Math.PI / 180;
    const kind = A === B ? 'circle' : 'ellipse', ct = Math.cos(t), st = Math.sin(t), pts = [];
    for (let i = 0; i <= 72; i++) { const w = i / 72 * Math.PI * 2, u = Math.cos(w) * A, vv2 = Math.sin(w) * B; pts.push([cx + u * ct - vv2 * st, cy + u * st + vv2 * ct]); }
    pts[72] = [...pts[0]];
    return { kind, label: LABEL[kind], pts };
  };

  if (ellErr < 0.075) return ellipse();
  if (v.length === 3) return { kind: 'tri', label: LABEL.tri, pts: [...v.map(q => [...q]), [...v[0]]] };
  if (v.length === 4) {
    const ok = v.every((B, i) => Math.abs(angDeg(v[(i + 3) % 4], B, v[(i + 1) % 4]) - 90) < 32);
    if (ok) {
      // Ausrichtung aus den vier Kanten (Winkel modulo 90° gemittelt), nahe 0° → gerade
      let sx = 0, sy = 0;
      for (let i = 0; i < 4; i++) { const A = v[i], B = v[(i + 1) % 4], w = Math.atan2(B[1] - A[1], B[0] - A[0]) * 4, l = D(A, B); sx += Math.cos(w) * l; sy += Math.sin(w) * l; }
      let r = Math.atan2(sy, sx) / 4; r = snapAng(r * 180 / Math.PI, 90, 9) * Math.PI / 180;
      const rc = Math.cos(r), rsn = Math.sin(r);
      const pr = v.map(([x, y]) => [(x - cx) * rc + (y - cy) * rsn, -(x - cx) * rsn + (y - cy) * rc]);
      const us = pr.map(q => q[0]).sort((x, y) => x - y), vs = pr.map(q => q[1]).sort((x, y) => x - y);
      let u0 = (us[0] + us[1]) / 2, u1 = (us[2] + us[3]) / 2, v0 = (vs[0] + vs[1]) / 2, v1 = (vs[2] + vs[3]) / 2;
      let kind = 'rect';
      const W = u1 - u0, H = v1 - v0;
      if (Math.abs(W - H) / Math.max(W, H) < 0.1) { const m = (W + H) / 4, mu = (u0 + u1) / 2, mv = (v0 + v1) / 2; u0 = mu - m; u1 = mu + m; v0 = mv - m; v1 = mv + m; kind = 'square'; }
      const back = ([u, w]) => [cx + u * rc - w * rsn, cy + u * rsn + w * rc];
      const pts = [[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]].map(back);
      return { kind, label: LABEL[kind], pts };
    }
  }
  if (ellErr < 0.13) return ellipse();
  return null;
}

// ---------- Morph: freier Strich → Form ----------
const signedArea = p => { let s = 0; for (let i = 0; i < p.length - 1; i++) s += p[i][0] * p[i + 1][1] - p[i + 1][0] * p[i][1]; return s / 2; };

/** Zielpunkte so drehen/umkehren, dass sie zur Zeichenrichtung des Strichs passen */
function align(from, shape) {
  const closed = shape.pts.length > 2 && D(shape.pts[0], shape.pts[shape.pts.length - 1]) < 1e-6;
  const n = from.length;
  if (!closed) return resample(shape.pts, n);
  let ring = shape.pts.slice(0, -1);
  if (Math.sign(signedArea([...ring, ring[0]])) !== Math.sign(signedArea([...from, from[0]]))) ring = ring.reverse();
  let k = 0, kd = 1e18; ring.forEach((q, i) => { const d = D(q, from[0]); if (d < kd) { kd = d; k = i; } });
  ring = [...ring.slice(k), ...ring.slice(0, k)];
  return resample([...ring, ring[0]], n);
}

/**
 * Morph-Animation. draw(points) wird pro Frame aufgerufen. Ergebnis: Promise (fertig).
 * Federnd (leicht überschwingend) wie iOS; bei „Bewegung reduzieren“ sofort fertig.
 */
export function morph(fromPts, shape, draw, { ms = 340, reduced = false } = {}) {
  if (reduced || typeof requestAnimationFrame !== 'function') { draw(shape.pts, 1); return Promise.resolve(); }
  const N = 96, A = resample(fromPts, N), B = align(A, shape);
  const t0 = performance.now();
  // gedämpfte Feder: ζ ≈ 0.55 → kurzes, knackiges Überschwingen
  const z = 0.55, w = 4.6 / (z * ms / 1000), wd = w * Math.sqrt(1 - z * z);
  const spring = t => 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + z * w / wd * Math.sin(wd * t));
  return new Promise(res => {
    const frame = now => {
      const t = Math.min(1, (now - t0) / ms), e = t >= 1 ? 1 : spring(t * ms / 1000);
      if (t >= 1) { draw(shape.pts, 1); return res(); }
      draw(A.map((q, i) => [q[0] + (B[i][0] - q[0]) * e, q[1] + (B[i][1] - q[1]) * e]), e);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
