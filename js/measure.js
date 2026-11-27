// ================= Messen & Maßstab =================
// Messobjekte im Editor: { type: 'measure', kind: 'line' | 'path' | 'area', page, pts: [[x,y]…] (Seiten-
// Ansichtskoordinaten in pt), fs (Label-Größe), sc: { mmPerPt, unit, ratio } }.
// geom(o) beschreibt Linien, Endstriche, Fläche und Labels – daraus zeichnen der Editor (SVG) und
// das Einbrennen (pdf-lib, Vektoren) identisch. Dazu: Maßstab-Rechnung, Winkel-Einrasten, Lupe.

export const MEASURE_COLOR = '#ff5a4f';
export const PT_MM = 25.4 / 72;                          // 1 pt = 0,3528 mm (72 pt = 25,4 mm)
export const UNITS = { mm: 1, cm: 10, m: 1000, km: 1e6 };
export const PRESETS = [1, 10, 20, 50, 100, 200, 500];
export const DEFAULT_SCALE = { mmPerPt: PT_MM, unit: 'cm', ratio: 1 };

/** Maßstab aus Plan-Verhältnis 1:N */
export const ratioScale = (n, unit) => ({ mmPerPt: PT_MM * n, unit, ratio: n });
/** Maßstab aus Kalibrierung: Strecke lenPt (pt) entspricht value (unit) */
export const calScale = (lenPt, value, unit) => ({ mmPerPt: value * UNITS[unit] / lenPt, unit, ratio: null, cal: true });
export const approxRatio = sc => sc.mmPerPt / PT_MM;
export function scaleName(sc) {
  if (!sc) return '1:1';
  if (sc.ratio) return `1:${sc.ratio}`;
  const n = approxRatio(sc);
  return `≈ 1:${n >= 10 ? Math.round(n).toLocaleString('de-DE') : n.toLocaleString('de-DE', { maximumFractionDigits: 2 })}`;
}

const num = v => {
  const a = Math.abs(v), d = a >= 1000 ? 0 : a >= 100 ? 1 : 2;
  return v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const fmtLen = (pt, sc) => `${num(pt * sc.mmPerPt / UNITS[sc.unit])} ${sc.unit}`;
export const fmtArea = (pt2, sc) => `${num(pt2 * sc.mmPerPt * sc.mmPerPt / (UNITS[sc.unit] ** 2))} ${sc.unit}²`;

// ---------- Geometrie ----------
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const pathLen = (pts, closed = false) => { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); if (closed && pts.length > 2) s += dist(pts[pts.length - 1], pts[0]); return s; };
export const polyArea = pts => { let s = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(s / 2); };
function centroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += f; cx += (pts[j][0] + pts[i][0]) * f; cy += (pts[j][1] + pts[i][1]) * f;
  }
  if (Math.abs(a) < 1e-6) { const n = pts.length; return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n]; }
  return [cx / (3 * a), cy / (3 * a)];
}
// Label-Winkel immer lesbar (nie auf dem Kopf)
const upright = (a, b) => { let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang <= -90) ang += 180; return ang; };
export const labelSize = (w, h) => Math.max(7, Math.min(44, Math.min(w, h) / 52));

/** → { lw, lines: [[x1,y1,x2,y2]], dots: [[x,y]], fill: pts | null, labels: [{ x, y, ang, text, size, main }] } */
export function geom(o) {
  const sc = o.sc || DEFAULT_SCALE, fs = o.fs || 9, pts = o.pts || [];
  const lw = Math.max(0.5, fs * 0.11), tick = fs * 0.55;
  const out = { lw, lines: [], dots: [], fill: null, labels: [] };
  if (pts.length < 2) return out;
  const seg = (a, b) => out.lines.push([a[0], a[1], b[0], b[1]]);
  const ticks = (a, b, at) => {
    const L = dist(a, b) || 1, nx = -(b[1] - a[1]) / L * tick, ny = (b[0] - a[0]) / L * tick;
    for (const p of at) out.lines.push([p[0] - nx, p[1] - ny, p[0] + nx, p[1] + ny]);
  };
  if (o.kind === 'line') {
    const [a, b] = pts;
    seg(a, b); ticks(a, b, [a, b]);
    out.labels.push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, ang: upright(a, b), text: fmtLen(dist(a, b), sc), size: fs, main: true });
  } else if (o.kind === 'path') {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]; seg(a, b);
      if (pts.length > 2) out.labels.push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, ang: upright(a, b), text: fmtLen(dist(a, b), sc), size: fs * 0.78 });
    }
    ticks(pts[0], pts[1], [pts[0]]); ticks(pts[pts.length - 2], pts[pts.length - 1], [pts[pts.length - 1]]);
    out.dots = pts.slice(1, -1);
    const last = pts[pts.length - 1];
    out.labels.push(pts.length > 2
      ? { x: last[0], y: last[1] - fs * 1.9, ang: 0, text: 'Gesamt ' + fmtLen(pathLen(pts), sc), size: fs, main: true }
      : { x: (pts[0][0] + last[0]) / 2, y: (pts[0][1] + last[1]) / 2, ang: upright(pts[0], last), text: fmtLen(pathLen(pts), sc), size: fs, main: true });
  } else if (o.kind === 'area') {
    for (let i = 0; i < pts.length; i++) seg(pts[i], pts[(i + 1) % pts.length]);
    out.dots = pts.slice();
    if (pts.length >= 3) {
      out.fill = pts;
      const [cx, cy] = centroid(pts);
      out.labels.push({ x: cx, y: cy - fs * 0.45, ang: 0, text: fmtArea(polyArea(pts), sc), size: fs * 1.12, main: true });
      out.labels.push({ x: cx, y: cy + fs * 1.15, ang: 0, text: 'U ' + fmtLen(pathLen(pts, true), sc), size: fs * 0.78 });
    }
  }
  return out;
}
/** Hauptwert eines Messobjekts als Text (Liste, Vorschau) */
export function valueOf(o) {
  const sc = o.sc || DEFAULT_SCALE;
  if (o.kind === 'area') return o.pts.length >= 3 ? fmtArea(polyArea(o.pts), sc) : '–';
  return fmtLen(pathLen(o.pts), sc);
}

// ---------- Winkel einrasten (0° / 45° / 90° …) ----------
export function snapAngle(a, p, on = true, tol = 4) {
  if (!on || !a) return { p, snapped: false };
  const dx = p[0] - a[0], dy = p[1] - a[1], L = Math.hypot(dx, dy);
  if (L < 1e-6) return { p, snapped: false };
  const ang = Math.atan2(dy, dx) * 180 / Math.PI, k = Math.round(ang / 45) * 45;
  if (Math.abs(ang - k) > tol) return { p, snapped: false };
  const r = k * Math.PI / 180;
  return { p: [a[0] + Math.cos(r) * L, a[1] + Math.sin(r) * L], snapped: k };
}

// ---------- Text-Breite für Label-Hintergründe ----------
let mctx = null;
export function textW(text, size) {
  mctx ??= document.createElement('canvas').getContext('2d');
  mctx.font = `700 ${size}px Helvetica, Arial, sans-serif`;
  return mctx.measureText(text).width;
}

// ---------- Präzisions-Lupe ----------
export function createLoupe() {
  const D = 124, Z = 2.6;
  const wrap = document.createElement('div');
  wrap.className = 'ml-loupe';
  const cv = document.createElement('canvas');
  const dpr = Math.min(3, devicePixelRatio || 1);
  cv.width = cv.height = Math.round(D * dpr);
  wrap.appendChild(cv);
  document.body.appendChild(wrap);
  const g = cv.getContext('2d');
  let on = false;
  return {
    /** cx/cy: Fingerposition (Bildschirm), src: gerenderte Seite, rect: ihre Bildschirm-Box, from: Bildschirm-Punkt des Ankers */
    show(cx, cy, src, rect, { from = null, snapped = false } = {}) {
      const W = cv.width, R = D / 2 / Z;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, W);
      if (src && src.width && rect.width) {
        const k = src.width / rect.width;
        try { g.drawImage(src, (cx - rect.left - R) * k, (cy - rect.top - R) * k, 2 * R * k, 2 * R * k, 0, 0, W, W); } catch {}
      }
      const m = W / 2, s = Z * dpr;
      if (from) {
        g.strokeStyle = MEASURE_COLOR; g.lineWidth = 2 * dpr; g.lineCap = 'round';
        g.beginPath(); g.moveTo(m + (from[0] - cx) * s, m + (from[1] - cy) * s); g.lineTo(m, m); g.stroke();
      }
      // Fadenkreuz
      g.strokeStyle = snapped !== false ? '#1f9d57' : MEASURE_COLOR; g.lineWidth = 1.2 * dpr;
      g.beginPath(); g.moveTo(m, m - 18 * dpr); g.lineTo(m, m - 5 * dpr); g.moveTo(m, m + 5 * dpr); g.lineTo(m, m + 18 * dpr);
      g.moveTo(m - 18 * dpr, m); g.lineTo(m - 5 * dpr, m); g.moveTo(m + 5 * dpr, m); g.lineTo(m + 18 * dpr, m); g.stroke();
      g.beginPath(); g.arc(m, m, 1.6 * dpr, 0, 7); g.fillStyle = g.strokeStyle; g.fill();
      // Lage: über dem Finger, oben am Rand seitlich
      let x = cx - D / 2, y = cy - D - 58;
      if (y < 8) { y = Math.max(8, cy - D / 2); x = cx + (cx < innerWidth / 2 ? 44 : -D - 44); }
      x = Math.max(6, Math.min(innerWidth - D - 6, x));
      wrap.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      wrap.classList.toggle('snap', snapped !== false);
      if (!on) { on = true; wrap.classList.add('on'); }
    },
    hide() { if (on) { on = false; wrap.classList.remove('on'); } },
  };
}

// ---------- Label-Hintergrund (abgerundet, gedreht) als SVG-Pfad – für Editor und PDF ----------
export function labelBox(l) {
  const tw = textW(l.text, l.size), w = tw + l.size * 0.9, h = l.size * 1.5, r = h / 2;
  const a = l.ang * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  const P = (x, y) => `${(l.x + x * cs - y * sn).toFixed(2)} ${(l.y + x * sn + y * cs).toFixed(2)}`;
  const X = w / 2, Y = h / 2;
  const d = `M${P(-X + r, -Y)}L${P(X - r, -Y)}A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${P(X - r, Y)}L${P(-X + r, Y)}A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${P(-X + r, -Y)}Z`;
  // Grundlinie links für den Text
  const bx = -tw / 2, by = l.size * 0.35;
  return { d, tw, base: [l.x + bx * cs - by * sn, l.y + bx * sn + by * cs] };
}
/** SVG-Pfad aller Linien / Fläche / Punkte */
export const linesPath = g => g.lines.map(([a, b, c, d]) => `M${a.toFixed(2)} ${b.toFixed(2)}L${c.toFixed(2)} ${d.toFixed(2)}`).join('');
export const fillPath = g => g.fill ? 'M' + g.fill.map(p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join('L') + 'Z' : '';
export const dotsPath = (g, r) => g.dots.map(([x, y]) => `M${(x - r).toFixed(2)} ${y.toFixed(2)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`).join('');
