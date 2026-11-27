// ================= PowerPoint (.pptx) → PDF =================
// Alles lokal: Die PPTX (ZIP mit XML) wird selbst gelesen – Folien, Layouts, Master, Theme
// (Farben, Schriften), Formen (Vorgaben + eigene Pfade), Bilder (mit Zuschnitt), Tabellen,
// SmartArt (über die mitgespeicherte Zeichnung) und Text mit Vererbung der Textformate
// (Master → Layout → Folie). Jede Folie wird auf ein Canvas gezeichnet und mit einer
// unsichtbaren Textebene (durchsuchbar & markierbar) per pdf-lib ins PDF gesetzt.
// Nicht unterstützt: Diagramme (Charts), Videos, EMF/WMF-Grafiken, 3D, Effekte.
import { loadLib, ConvertError, ensureFonts, familyCss, textLayer, canvasJpeg, isZip, isOle } from './convert.js';

const EMU = 12700;                                   // EMU je Punkt
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const fail = m => { throw new ConvertError(m); };
const tick = () => new Promise(r => setTimeout(r, 0));

// ---------- XML-Helfer (Namensräume über localName) ----------
const kids = (el, n) => el ? [...el.children].filter(c => c.localName === n) : [];
const kid = (el, n) => { if (!el) return null; for (const c of el.children) if (c.localName === n) return c; return null; };
const path = (el, ...ns) => { for (const n of ns) { el = kid(el, n); if (!el) return null; } return el; };
const num = (el, n, d = 0) => { const v = el?.getAttribute(n); return v == null || v === '' ? d : +v; };
const att = (el, n, d = null) => { const v = el?.getAttribute(n); return v == null ? d : v; };
const rid = (el, n) => el?.getAttributeNS(RNS, n) || el?.getAttribute('r:' + n) || null;
const bool = v => v === '1' || v === 'true';

// ---------- Farben ----------
const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500', navy: '000080', silver: 'C0C0C0' };
const hex2 = h => { h = (h || '000000').replace('#', ''); return { r: parseInt(h.slice(0, 2), 16) || 0, g: parseInt(h.slice(2, 4), 16) || 0, b: parseInt(h.slice(4, 6), 16) || 0, a: 1 }; };
function rgb2hsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hsl2rgb(h, s, l) {
  if (!s) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const f = (p, q, t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return { r: Math.round(f(p, q, h + 1 / 3) * 255), g: Math.round(f(p, q, h) * 255), b: Math.round(f(p, q, h - 1 / 3) * 255) };
}
const clamp01 = v => Math.max(0, Math.min(1, v));
const toL = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const toS = l => { l = clamp01(l); return 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055); };
const COLOR_TAGS = /^(srgbClr|schemeClr|sysClr|prstClr|scrgbClr|hslClr)$/;
/** Farbe aus einem Element, das ein *Clr-Kind enthält (solidFill, fontRef, gs …) */
function colorOf(el, T, phClr = null) {
  if (!el) return null;
  const c = COLOR_TAGS.test(el.localName) ? el : [...el.children].find(x => COLOR_TAGS.test(x.localName));
  if (!c) return null;
  let col;
  switch (c.localName) {
    case 'srgbClr': col = hex2(att(c, 'val')); break;
    case 'sysClr': col = hex2(att(c, 'lastClr') || (att(c, 'val') === 'window' ? 'FFFFFF' : '000000')); break;
    case 'prstClr': col = hex2(PRESET[att(c, 'val')] || '000000'); break;
    case 'scrgbClr': col = { r: num(c, 'r') / 1e5 * 255, g: num(c, 'g') / 1e5 * 255, b: num(c, 'b') / 1e5 * 255, a: 1 }; break;
    case 'hslClr': col = { ...hsl2rgb(num(c, 'hue') / 21600000, num(c, 'sat') / 1e5, num(c, 'lum') / 1e5), a: 1 }; break;
    default: {
      const v = att(c, 'val');
      if (v === 'phClr') { col = phClr ? { ...phClr } : hex2('000000'); break; }
      col = hex2(T.scheme(v));
    }
  }
  for (const m of c.children) {
    const v = num(m, 'val') / 1e5;
    switch (m.localName) {
      case 'alpha': col.a = clamp01(v); break;
      // tint/shade rechnet Office im linearen Farbraum
      case 'tint': for (const k of 'rgb') col[k] = toS(1 - (1 - toL(col[k])) * v); break;
      case 'shade': for (const k of 'rgb') col[k] = toS(toL(col[k]) * v); break;
      case 'lumMod': case 'lumOff': case 'satMod': case 'satOff': case 'hueOff': case 'hueMod': {
        let [h, s, l] = rgb2hsl(col);
        if (m.localName === 'lumMod') l *= v; else if (m.localName === 'lumOff') l += v;
        else if (m.localName === 'satMod') s *= v; else if (m.localName === 'satOff') s += v;
        else if (m.localName === 'hueOff') h += num(m, 'val') / 21600000; else h *= v;
        Object.assign(col, hsl2rgb(((h % 1) + 1) % 1, clamp01(s), clamp01(l))); break;
      }
      case 'gray': { const g = col.r * .3 + col.g * .59 + col.b * .11; col.r = col.g = col.b = g; break; }
      case 'inv': col.r = 255 - col.r; col.g = 255 - col.g; col.b = 255 - col.b; break;
    }
  }
  return col;
}
const css = c => c ? `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${(c.a ?? 1).toFixed(3)})` : 'transparent';

// ---------- Füllungen & Linien ----------
const FILLS = /^(noFill|solidFill|gradFill|blipFill|pattFill|grpFill)$/;
function fillOf(spPr, T, phClr) {
  const f = spPr && [...spPr.children].find(x => FILLS.test(x.localName));
  if (!f) return null;
  switch (f.localName) {
    case 'noFill': return { type: 'none' };
    case 'solidFill': return { type: 'solid', c: colorOf(f, T, phClr) };
    case 'gradFill': {
      const stops = kids(kid(f, 'gsLst'), 'gs').map(g => ({ pos: num(g, 'pos') / 1e5, c: colorOf(g, T, phClr) })).sort((a, b) => a.pos - b.pos);
      const lin = kid(f, 'lin'), pth = kid(f, 'path');
      return stops.length ? { type: 'grad', stops, ang: lin ? num(lin, 'ang') / 60000 : 90, radial: !!pth && !lin } : null;
    }
    case 'blipFill': return { type: 'img', blip: f };
    case 'pattFill': return { type: 'solid', c: colorOf(kid(f, 'fgClr'), T, phClr) || colorOf(kid(f, 'bgClr'), T, phClr) };
    case 'grpFill': return { type: 'grp' };
  }
  return null;
}

// ---------- Vorgabe-Formen ----------
function adjOf(geom, name, d) {
  for (const gd of kids(kid(geom, 'avLst'), 'gd')) if (att(gd, 'name') === name) { const m = /val\s+(-?\d+)/.exec(att(gd, 'fmla') || ''); if (m) return +m[1]; }
  return d;
}
const LINES = /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/;
function presetPath(ctx, prst, w, h, geom) {
  const ss = Math.min(w, h), a = (n, d) => adjOf(geom, n, d);
  const P = pts => { ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); };
  const rr = r => { r = Math.min(r, w / 2, h / 2); ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r); ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.closePath(); };
  switch (prst) {
    case 'ellipse': case 'flowChartConnector': case 'donut': case 'cloud': case 'wedgeEllipseCallout': case 'flowChartOr': case 'smileyFace':
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); return;
    case 'roundRect': case 'flowChartAlternateProcess': case 'wedgeRoundRectCallout': return rr(ss * a('adj', 16667) / 1e5);
    case 'flowChartTerminator': return rr(Math.min(w, h) / 2);
    case 'round2SameRect': case 'round1Rect': case 'snipRoundRect': return rr(ss * a('adj1', 16667) / 1e5);
    case 'triangle': case 'flowChartExtract': { const x = w * a('adj', 50000) / 1e5; return P([[x, 0], [w, h], [0, h]]); }
    case 'flowChartMerge': return P([[0, 0], [w, 0], [w / 2, h]]);
    case 'rtTriangle': return P([[0, 0], [w, h], [0, h]]);
    case 'diamond': case 'flowChartDecision': return P([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case 'parallelogram': case 'flowChartInputOutput': { const o = ss * a('adj', 25000) / 1e5; return P([[o, 0], [w, 0], [w - o, h], [0, h]]); }
    case 'trapezoid': case 'flowChartManualOperation': { const o = ss * a('adj', 25000) / 1e5; return P([[o, 0], [w - o, 0], [w, h], [0, h]]); }
    case 'pentagon': case 'homePlate': { const o = ss * a('adj', 50000) / 1e5; return P([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h]]); }
    case 'chevron': { const o = ss * a('adj', 50000) / 1e5; return P([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h], [o, h / 2]]); }
    case 'hexagon': { const o = ss * a('adj', 25000) / 1e5; return P([[o, 0], [w - o, 0], [w, h / 2], [w - o, h], [o, h], [0, h / 2]]); }
    case 'octagon': { const o = ss * a('adj', 29289) / 1e5; return P([[o, 0], [w - o, 0], [w, o], [w, h - o], [w - o, h], [o, h], [0, h - o], [0, o]]); }
    case 'plus': case 'mathPlus': { const o = ss * a('adj', 25000) / 1e5; return P([[o, 0], [w - o, 0], [w - o, o], [w, o], [w, h - o], [w - o, h - o], [w - o, h], [o, h], [o, h - o], [0, h - o], [0, o], [o, o]]); }
    case 'rightArrow': case 'leftArrow': case 'upArrow': case 'downArrow': {
      const hor = prst === 'rightArrow' || prst === 'leftArrow';
      const L = hor ? w : h, B = hor ? h : w, t = B * a('adj1', 50000) / 1e5, hd = Math.min(L, ss * a('adj2', 50000) / 1e5);
      let pts = [[0, (B - t) / 2], [L - hd, (B - t) / 2], [L - hd, 0], [L, B / 2], [L - hd, B], [L - hd, (B + t) / 2], [0, (B + t) / 2]];
      if (prst === 'leftArrow') pts = pts.map(([x, y]) => [L - x, y]);
      if (!hor) pts = pts.map(([x, y]) => [y, x]);
      if (prst === 'upArrow') pts = pts.map(([x, y]) => [x, h - y]);
      return P(pts);
    }
    case 'leftRightArrow': { const t = h * a('adj1', 50000) / 1e5, hd = Math.min(w / 2, ss * a('adj2', 50000) / 1e5); return P([[0, h / 2], [hd, 0], [hd, (h - t) / 2], [w - hd, (h - t) / 2], [w - hd, 0], [w, h / 2], [w - hd, h], [w - hd, (h + t) / 2], [hd, (h + t) / 2], [hd, h]]); }
    case 'star5': {
      const pts = []; for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.2 : 0.5, an = -Math.PI / 2 + i * Math.PI / 5; pts.push([w / 2 + Math.cos(an) * w * r, h / 2 + Math.sin(an) * h * r * 1.05 + h * 0.03]); } return P(pts);
    }
    case 'heart': ctx.moveTo(w / 2, h / 4); ctx.bezierCurveTo(w / 2, 0, 0, 0, 0, h / 4); ctx.bezierCurveTo(0, h / 2, w / 2, h * .75, w / 2, h); ctx.bezierCurveTo(w / 2, h * .75, w, h / 2, w, h / 4); ctx.bezierCurveTo(w, 0, w / 2, 0, w / 2, h / 4); ctx.closePath(); return;
    case 'snip1Rect': { const o = ss * a('adj', 16667) / 1e5; return P([[0, 0], [w - o, 0], [w, o], [w, h], [0, h]]); }
    case 'snip2SameRect': { const o = ss * a('adj1', 16667) / 1e5; return P([[o, 0], [w - o, 0], [w, o], [w, h], [0, h], [0, o]]); }
    case 'flowChartDocument': ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h * .83); ctx.bezierCurveTo(w * .75, h * .7, w * .5, h * 1.05, 0, h * .9); ctx.closePath(); return;
    case 'can': case 'flowChartMagneticDisk': { const e = h * Math.min(.25, a('adj', 25000) / 1e5); ctx.moveTo(0, e / 2); ctx.ellipse(w / 2, e / 2, w / 2, e / 2, 0, Math.PI, 0); ctx.lineTo(w, h - e / 2); ctx.ellipse(w / 2, h - e / 2, w / 2, e / 2, 0, 0, Math.PI); ctx.closePath(); return; }
    case 'line': case 'straightConnector1': case 'bentConnector2': case 'bentConnector3': case 'curvedConnector3':
      ctx.moveTo(0, 0); ctx.lineTo(w, h); return;
    default: ctx.rect(0, 0, w, h);
  }
}

// Eigene Pfade (custGeom)
function customPath(ctx, geom, w, h) {
  let any = false;
  for (const p of kids(kid(geom, 'pathLst'), 'path')) {
    const pw = num(p, 'w', 0) || w * EMU, ph = num(p, 'h', 0) || h * EMU;
    const sx = w / pw, sy = h / ph;
    let cx = 0, cy = 0;
    const pt = el => { const q = kid(el, 'pt') || el; return [num(q, 'x') * sx, num(q, 'y') * sy]; };
    for (const c of p.children) {
      switch (c.localName) {
        case 'moveTo': { const [x, y] = pt(c); ctx.moveTo(x, y); cx = x; cy = y; any = true; break; }
        case 'lnTo': { const [x, y] = pt(c); ctx.lineTo(x, y); cx = x; cy = y; break; }
        case 'cubicBezTo': { const q = kids(c, 'pt').map(e => [num(e, 'x') * sx, num(e, 'y') * sy]); if (q.length === 3) { ctx.bezierCurveTo(q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1]); [cx, cy] = q[2]; } break; }
        case 'quadBezTo': { const q = kids(c, 'pt').map(e => [num(e, 'x') * sx, num(e, 'y') * sy]); if (q.length === 2) { ctx.quadraticCurveTo(q[0][0], q[0][1], q[1][0], q[1][1]); [cx, cy] = q[1]; } break; }
        case 'arcTo': {
          const wr = num(c, 'wR') * sx, hr = num(c, 'hR') * sy, st = num(c, 'stAng') / 60000 * Math.PI / 180, sw = num(c, 'swAng') / 60000 * Math.PI / 180;
          const ox = cx - wr * Math.cos(st), oy = cy - hr * Math.sin(st);
          if (wr > 0 && hr > 0) ctx.ellipse(ox, oy, wr, hr, 0, st, st + sw, sw < 0);
          cx = ox + wr * Math.cos(st + sw); cy = oy + hr * Math.sin(st + sw); break;
        }
        case 'close': ctx.closePath(); break;
      }
    }
  }
  return any;
}

// ---------- Textformate (Vererbung) ----------
function pProps(pPr, T) {
  if (!pPr) return { p: {}, r: {} };
  const p = {};
  const a = n => pPr.getAttribute(n);
  if (a('algn')) p.algn = a('algn');
  if (a('marL') != null) p.marL = +a('marL') / EMU;
  if (a('indent') != null) p.indent = +a('indent') / EMU;
  const sp = (n) => { const e = kid(pPr, n); if (!e) return undefined; const pc = kid(e, 'spcPct'), pt = kid(e, 'spcPts'); return pc ? { pct: num(pc, 'val') / 1e5 } : pt ? { pts: num(pt, 'val') / 100 } : undefined; };
  const ln = sp('lnSpc'), bf = sp('spcBef'), af = sp('spcAft');
  if (ln) p.lnSpc = ln; if (bf) p.spcBef = bf; if (af) p.spcAft = af;
  if (kid(pPr, 'buNone')) p.bu = { type: 'none' };
  else if (kid(pPr, 'buChar')) p.bu = { type: 'char', ch: att(kid(pPr, 'buChar'), 'char', '•') };
  else if (kid(pPr, 'buAutoNum')) { const b = kid(pPr, 'buAutoNum'); p.bu = { type: 'num', scheme: att(b, 'type', 'arabicPeriod'), start: num(b, 'startAt', 1) }; }
  if (kid(pPr, 'buFont')) p.buFont = att(kid(pPr, 'buFont'), 'typeface');
  if (kid(pPr, 'buClr')) p.buClr = colorOf(kid(pPr, 'buClr'), T);
  if (kid(pPr, 'buSzPct')) p.buSz = num(kid(pPr, 'buSzPct'), 'val') / 1e5;
  return { p, r: rProps(kid(pPr, 'defRPr'), T) };
}
function rProps(rPr, T) {
  if (!rPr) return {};
  const r = {};
  const a = n => rPr.getAttribute(n);
  if (a('sz')) r.sz = +a('sz') / 100;
  if (a('b') != null) r.b = bool(a('b'));
  if (a('i') != null) r.i = bool(a('i'));
  if (a('u') != null) r.u = a('u') !== 'none';
  if (a('strike') != null) r.strike = a('strike') !== 'noStrike';
  if (a('baseline')) r.base = +a('baseline') / 1e5;
  if (a('cap')) r.cap = a('cap');
  if (a('spc') && Math.abs(+a('spc')) >= 30) r.spc = +a('spc') / 100;      // winzige Korrekturen ignorieren
  const f = kid(rPr, 'solidFill'); if (f) r.color = colorOf(f, T);
  else if (kid(rPr, 'noFill')) r.color = { r: 0, g: 0, b: 0, a: 0 };
  else { const g = kid(rPr, 'gradFill'); if (g) { const s = kid(kid(g, 'gsLst'), 'gs'); if (s) r.color = colorOf(s, T); } }
  const lat = kid(rPr, 'latin'); if (lat) r.font = att(lat, 'typeface');
  if (kid(rPr, 'hlinkClick') && !r.color) r.link = true;
  return r;
}
/** Formate einer Ebene aus einer lstStyle / txStyles-Gruppe */
function lvlOf(list, lvl, T) {
  if (!list) return { p: {}, r: {} };
  const e = kid(list, `lvl${lvl + 1}pPr`) || (lvl === 0 ? kid(list, 'defPPr') : null);
  return pProps(e, T);
}
const merge = (...xs) => { const o = { p: {}, r: {} }; for (const x of xs) if (x) { Object.assign(o.p, x.p); Object.assign(o.r, x.r); } return o; };

// Körper-Eigenschaften
function bodyProps(bp, base = {}) {
  const o = { ...base };
  if (!bp) return o;
  for (const [k, d] of [['lIns', 'l'], ['tIns', 't'], ['rIns', 'r'], ['bIns', 'b']]) if (bp.getAttribute(k) != null) o[d] = num(bp, k) / EMU;
  if (bp.getAttribute('anchor')) o.anchor = att(bp, 'anchor');
  if (bp.getAttribute('wrap')) o.wrap = att(bp, 'wrap');
  if (bp.getAttribute('vert')) o.vert = att(bp, 'vert');
  if (bp.getAttribute('anchorCtr') != null) o.anchorCtr = bool(att(bp, 'anchorCtr'));
  const na = kid(bp, 'normAutofit');
  if (na) { o.fontScale = num(na, 'fontScale', 1e5) / 1e5; o.lnRed = num(na, 'lnSpcReduction', 0) / 1e5; }
  else if (kid(bp, 'noAutofit') || kid(bp, 'spAutoFit')) { o.fontScale = 1; o.lnRed = 0; }
  return o;
}

// Aufzählungen
const ROMAN = n => { const m = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [v, r] of m) while (n >= v) { s += r; n -= v; } return s; };
function autoNum(scheme, n) {
  const al = n => { let s = ''; while (n > 0) { n--; s = String.fromCharCode(97 + n % 26) + s; n = Math.floor(n / 26); } return s; };
  let core = /^alphaLc/.test(scheme) ? al(n) : /^alphaUc/.test(scheme) ? al(n).toUpperCase() : /^romanLc/.test(scheme) ? ROMAN(n) : /^romanUc/.test(scheme) ? ROMAN(n).toUpperCase() : String(n);
  if (/ParenBoth$/.test(scheme)) return `(${core})`;
  if (/ParenR$/.test(scheme)) return core + ')';
  if (/Plain$/.test(scheme)) return core;
  return core + '.';
}
const WING = { '§': '▪', 'Ø': '➢', 'ü': '✔', 'v': '❖', 'n': '■', 'l': '●', 'Ÿ': '•', 'ð': '➔', 'q': '❑', 'o': '○', 'ª': '▪', '·': '•', 'à': '➔', 'Ü': '➢', 'w': '◆', 'u': '◆' };

// =====================================================================
export async function pptxToPdf(buf, { onProgress, onWarn, title, width = 1920 } = {}) {
  if (isOle(buf)) fail('Altes PowerPoint-Format (.ppt) wird nicht unterstützt. Bitte in PowerPoint oder Keynote als .pptx speichern.');
  if (!isZip(buf)) fail('Keine PowerPoint-Datei (.pptx)');
  await loadLib('jszip.min.js');
  if (!window.PDFLib) await loadLib('pdf-lib.min.js');
  let zip;
  try { zip = await window.JSZip.loadAsync(buf); } catch { fail('PowerPoint-Datei konnte nicht gelesen werden'); }
  const xmlCache = new Map();
  const xml = async p => {
    if (!p) return null;
    if (xmlCache.has(p)) return xmlCache.get(p);
    const f = zip.file(p); let d = null;
    if (f) { const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml'); d = doc.getElementsByTagName('parsererror').length ? null : doc.documentElement; }
    xmlCache.set(p, d); return d;
  };
  const resolve = (from, target) => {
    if (/^[a-z]+:/i.test(target)) return null;
    const parts = (target.startsWith('/') ? target.slice(1) : from.replace(/[^/]*$/, '') + target).split('/');
    const out = []; for (const s of parts) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
    return out.join('/');
  };
  const relCache = new Map();
  const rels = async p => {
    if (relCache.has(p)) return relCache.get(p);
    const r = await xml(p.replace(/([^/]*)$/, '_rels/$1.rels'));
    const m = new Map();
    for (const e of kids(r, 'Relationship')) m.set(att(e, 'Id'), { type: (att(e, 'Type') || '').replace(/^.*\//, ''), target: att(e, 'TargetMode') === 'External' ? null : resolve(p, att(e, 'Target') || '') });
    relCache.set(p, m); return m;
  };
  const relOfType = (m, t) => [...m.values()].find(r => r.type === t)?.target || null;

  // ---- Präsentation ----
  const ctPath = 'ppt/presentation.xml';
  const pres = await xml(ctPath);
  if (!pres) fail('PowerPoint-Datei ist beschädigt (presentation.xml fehlt)');
  const sz = kid(pres, 'sldSz');
  const SW = num(sz, 'cx', 9144000) / EMU, SH = num(sz, 'cy', 6858000) / EMU;
  const presRels = await rels(ctPath);
  const slidePaths = kids(kid(pres, 'sldIdLst'), 'sldId').map(e => presRels.get(rid(e, 'id'))?.target).filter(Boolean);
  if (!slidePaths.length) fail('Die Präsentation enthält keine Folien');
  const defaultText = kid(pres, 'defaultTextStyle');

  // ---- Schriften vorab laden (Canvas zeichnet nur geladene Webfonts) ----
  ensureFonts();
  const fontLoads = new Set();
  const fam = name => familyCss(name);
  const want = (name, b, i) => { const k = `${i ? 'italic ' : ''}${b ? 700 : 400} 20px ${fam(name)}`; if (!fontLoads.has(k)) { fontLoads.add(k); try { return document.fonts.load(k); } catch {} } return null; };

  // ---- Theme / Master / Layout je Folie ----
  const ctxCache = new Map();
  async function masterCtx(layoutPath) {
    if (ctxCache.has(layoutPath)) return ctxCache.get(layoutPath);
    const layout = await xml(layoutPath);
    const lRels = await rels(layoutPath);
    const masterPath = relOfType(lRels, 'slideMaster');
    const master = await xml(masterPath);
    const mRels = masterPath ? await rels(masterPath) : new Map();
    const theme = await xml(relOfType(mRels, 'theme'));
    const scheme = {};
    for (const c of path(theme, 'themeElements', 'clrScheme')?.children || []) {
      const v = kid(c, 'srgbClr') ? att(kid(c, 'srgbClr'), 'val') : kid(c, 'sysClr') ? att(kid(c, 'sysClr'), 'lastClr') : null;
      if (v) scheme[c.localName] = v;
    }
    const fs = path(theme, 'themeElements', 'fontScheme');
    const fonts = { major: att(path(fs, 'majorFont', 'latin'), 'typeface') || 'Calibri Light', minor: att(path(fs, 'minorFont', 'latin'), 'typeface') || 'Calibri' };
    const fmt = path(theme, 'themeElements', 'fmtScheme');
    const lnStyles = kids(kid(fmt, 'lnStyleLst'), 'ln');
    const bgStyles = [...(kid(fmt, 'bgFillStyleLst')?.children || [])];
    const fillStyles = [...(kid(fmt, 'fillStyleLst')?.children || [])];
    const cm = kid(master, 'clrMap');
    const map = {}; if (cm) for (const a of cm.attributes) map[a.name] = a.value;
    const T = {
      fonts, lnStyles, bgStyles, fillStyles, map,
      scheme(v) {
        const m = map[v] || ({ bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[v]) || v;
        return scheme[m] || scheme[v] || '000000';
      },
      font(f) { if (!f) return fonts.minor; if (f === '+mj-lt' || f === '+mj-ea') return fonts.major; if (f[0] === '+') return fonts.minor; return f; },
    };
    const out = { layout, layoutPath, lRels, master, masterPath, mRels, T, txStyles: kid(master, 'txStyles') };
    ctxCache.set(layoutPath, out); return out;
  }

  // Platzhalter in Layout/Master suchen
  const phOf = sp => { const nv = [...sp.children].find(c => /^nv/.test(c.localName)); return path(nv, 'nvPr', 'ph'); };
  const phKey = ph => ({ type: att(ph, 'type', 'obj'), idx: att(ph, 'idx') });
  const MASTER_TYPE = t => ({ ctrTitle: 'title', subTitle: 'body', obj: 'body', tbl: 'body', chart: 'body', clipArt: 'body', dgm: 'body', media: 'body', pic: 'body' }[t] || t);
  function findPh(tree, key, byIdx) {
    if (!tree) return null;
    const all = [];
    (function walk(n) { for (const c of n.children) { if (c.localName === 'sp' || c.localName === 'pic') { const ph = phOf(c); if (ph) all.push([c, phKey(ph)]); } else if (c.localName === 'grpSp') walk(c); } })(tree);
    if (byIdx && key.idx != null) { const m = all.find(([, k]) => k.idx === key.idx); if (m) return m[0]; }
    const t = byIdx ? key.type : MASTER_TYPE(key.type);
    return (all.find(([, k]) => k.type === t) || all.find(([, k]) => MASTER_TYPE(k.type) === t))?.[0] || null;
  }

  // Bilder
  const imgCache = new Map();
  const warn = new Set();
  async function image(p) {
    if (!p) return null;
    if (imgCache.has(p)) return imgCache.get(p);
    const pr = (async () => {
      const f = zip.file(p); if (!f) return null;
      const ext = (p.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
      if (['emf', 'wmf', 'tif', 'tiff', 'wdp'].includes(ext)) { warn.add('Einige Grafiken (EMF/WMF/TIFF) konnten nicht übernommen werden'); return null; }
      const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', webp: 'image/webp' }[ext] || 'image/png';
      const blob = new Blob([await f.async('arraybuffer')], { type });
      const url = URL.createObjectURL(blob);
      try {
        const im = new Image(); im.decoding = 'async'; im.src = url;
        await im.decode();
        return im;
      } catch { return null; } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
    })();
    imgCache.set(p, pr); return pr;
  }

  // ---- PDF ----
  const { PDFDocument, StandardFonts } = window.PDFLib;
  const doc = await PDFDocument.create();
  doc.setProducer('Nibvion'); doc.setCreator('Nibvion');
  if (title) doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const S = width / SW;                                  // Pixel je Punkt
  const cv = document.createElement('canvas');
  cv.width = Math.round(SW * S); cv.height = Math.round(SH * S);
  const g = cv.getContext('2d');

  let shown = 0, hidden = 0;
  for (let si = 0; si < slidePaths.length; si++) {
    onProgress && onProgress(si + 1, slidePaths.length);
    await tick();
    const sp = slidePaths[si];
    const slide = await xml(sp);
    if (!slide) continue;
    if (att(slide, 'show') === '0') { hidden++; continue; }
    const sRels = await rels(sp);
    const L = await masterCtx(relOfType(sRels, 'slideLayout'));
    const T = L.T;
    // Folien-eigene Farbzuordnung (clrMapOvr)
    const ovr = path(slide, 'clrMapOvr', 'overrideClrMapping');
    const Ts = ovr ? { ...T, map: Object.fromEntries([...ovr.attributes].map(a => [a.name, a.value])), scheme: T.scheme } : T;
    if (ovr) { const m = Ts.map; Ts.scheme = v => { const k = m[v] || v; return T.scheme(k); }; }
    const runs = [];
    const slideNo = si + 1;

    // ---- Zeichnen ----
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.setTransform(S, 0, 0, S, 0, 0);

    const R = { T: Ts, sRels, L, slideNo, runs };
    await drawBackground(R, [slide, L.layout, L.master]);
    const showMaster = att(slide, 'showMasterSp') !== '0';
    if (showMaster && att(L.layout, 'showMasterSp') !== '0') await drawTree(R, path(L.master, 'cSld', 'spTree'), { src: 'master', rels: L.mRels, relBase: L.masterPath });
    if (showMaster) await drawTree(R, path(L.layout, 'cSld', 'spTree'), { src: 'layout', rels: L.lRels, relBase: L.layoutPath });
    await drawTree(R, path(slide, 'cSld', 'spTree'), { src: 'slide', rels: sRels, relBase: sp });

    // ---- Seite ins PDF ----
    const page = doc.addPage([SW, SH]);
    const img = await doc.embedJpg(await canvasJpeg(cv));
    page.drawImage(img, { x: 0, y: 0, width: SW, height: SH });
    if (runs.length) {
      const fkey = page.node.newFontDictionary(font.name, font.ref);
      textLayer(page, font, fkey, runs, { x: 0, y: 0, w: SW, h: SH, dx: 0, dy: 0, k: 1 }, SH);
    }
    shown++;
  }
  cv.width = cv.height = 0;
  if (!shown) fail(hidden ? 'Alle Folien sind ausgeblendet' : 'Die Präsentation enthält keine Folien');
  if (warn.size && onWarn) onWarn([...warn]);
  return doc.save();

  // =================== Zeichen-Funktionen ===================
  async function drawBackground(R, chain) {
    for (const node of chain) {
      const bg = path(node, 'cSld', 'bg');
      if (!bg) continue;
      const bgPr = kid(bg, 'bgPr'), ref = kid(bg, 'bgRef');
      let f = null, rels = null, base = null;
      if (bgPr) { f = fillOf(bgPr, R.T); }
      else if (ref) {
        const idx = num(ref, 'idx'), c = colorOf(ref, R.T);
        const st = idx >= 1001 ? R.T.bgStyles[idx - 1001] : idx > 0 ? R.T.fillStyles[idx - 1] : null;
        if (st?.localName === 'gradFill') { const wrap = { children: [st] }; f = fillOf(wrap, R.T, c); } else f = { type: 'solid', c };
      }
      if (!f) continue;
      rels = node === chain[0] ? R.sRels : node === R.L.layout ? R.L.lRels : R.L.mRels;
      base = node === chain[0] ? null : node === R.L.layout ? R.L.layoutPath : R.L.masterPath;
      g.save(); g.beginPath(); g.rect(0, 0, SW, SH);
      await paintFill(f, 0, 0, SW, SH, rels);
      g.restore();
      return;
    }
  }

  async function paintFill(f, x, y, w, h, relMap) {
    if (!f || f.type === 'none' || f.type === 'grp') return false;
    if (f.type === 'solid') { if (!f.c) return false; g.fillStyle = css(f.c); g.fill(); return true; }
    if (f.type === 'grad') {
      let gr;
      if (f.radial) gr = g.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.hypot(w, h) / 2);
      else {
        const an = f.ang * Math.PI / 180, cx = x + w / 2, cy = y + h / 2;
        const len = Math.abs(w * Math.cos(an)) + Math.abs(h * Math.sin(an));
        gr = g.createLinearGradient(cx - Math.cos(an) * len / 2, cy - Math.sin(an) * len / 2, cx + Math.cos(an) * len / 2, cy + Math.sin(an) * len / 2);
      }
      for (const s of f.stops) gr.addColorStop(clamp01(s.pos), css(s.c));
      g.fillStyle = gr; g.fill(); return true;
    }
    if (f.type === 'img') {
      const im = await image(relMap?.get(rid(kid(f.blip, 'blip'), 'embed'))?.target);
      if (!im) return false;
      g.save(); g.clip();
      drawCropped(im, kid(f.blip, 'srcRect'), x, y, w, h, kid(f.blip, 'blip'));
      g.restore(); return true;
    }
    return false;
  }

  function drawCropped(im, src, x, y, w, h, blip) {
    const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
    if (!iw || !ih) return;
    let l = num(src, 'l') / 1e5, t = num(src, 't') / 1e5, r = num(src, 'r') / 1e5, b = num(src, 'b') / 1e5;
    // Negative Werte = Rand um das Bild (Bild kleiner im Rahmen)
    const sx = Math.max(0, l) * iw, sy = Math.max(0, t) * ih, sw = iw * (1 - Math.max(0, l) - Math.max(0, r)), sh = ih * (1 - Math.max(0, t) - Math.max(0, b));
    const fw = 1 - l - r, fh = 1 - t - b;
    const dx = x + (l < 0 ? -l / fw * w : 0), dy = y + (t < 0 ? -t / fh * h : 0);
    const dw = w * (1 - Math.min(0, l) * -1 / fw - Math.min(0, r) * -1 / fw), dh = h * (1 - Math.min(0, t) * -1 / fh - Math.min(0, b) * -1 / fh);
    const alpha = kid(blip, 'alphaModFix');
    if (alpha) g.globalAlpha *= num(alpha, 'amt', 1e5) / 1e5;
    if (sw > 0 && sh > 0) g.drawImage(im, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  // Formbaum zeichnen
  async function drawTree(R, tree, src) {
    if (!tree) return;
    for (const el of tree.children) await drawNode(R, el, src);
  }

  async function drawNode(R, el, src) {
    switch (el.localName) {
      case 'sp': case 'cxnSp': return drawShape(R, el, src);
      case 'pic': return drawPic(R, el, src);
      case 'grpSp': return drawGroup(R, el, src);
      case 'graphicFrame': return drawFrame(R, el, src);
      case 'AlternateContent': {
        const fb = kid(el, 'Fallback'), ch = kid(el, 'Choice');
        const use = fb && [...fb.children].length ? fb : ch;
        if (use) for (const c of use.children) await drawNode(R, c, src);
      }
    }
  }

  // Geometrie eines Elements (mit Platzhalter-Vererbung)
  function xfrmOf(el, spPr, inh) {
    let x = kid(spPr, 'xfrm');
    if (!x || !kid(x, 'off')) for (const e of inh) { const t = kid(kid(e, 'spPr'), 'xfrm'); if (t && kid(t, 'off')) { x = t; break; } }
    return box(x);
  }
  function box(x) {
    if (!x) return null;
    const off = kid(x, 'off'), ext = kid(x, 'ext');
    return { x: num(off, 'x') / EMU, y: num(off, 'y') / EMU, w: num(ext, 'cx') / EMU, h: num(ext, 'cy') / EMU, rot: num(x, 'rot') / 60000, flipH: bool(att(x, 'flipH')), flipV: bool(att(x, 'flipV')) };
  }
  function enter(b) {
    g.save();
    g.translate(b.x + b.w / 2, b.y + b.h / 2);
    if (b.rot) g.rotate(b.rot * Math.PI / 180);
    g.scale(b.flipH ? -1 : 1, b.flipV ? -1 : 1);
    g.translate(-b.w / 2, -b.h / 2);
  }

  async function drawShape(R, sp, src) {
    const ph = phOf(sp);
    // Platzhalter auf Layout/Master werden nur als Vorlage benutzt, nicht gezeichnet
    if (ph && src.src !== 'slide') return;
    const key = ph ? phKey(ph) : null;
    const inh = [];
    if (key && src.src === 'slide') {
      const lp = findPh(path(R.L.layout, 'cSld', 'spTree'), key, true); if (lp) inh.push(lp);
      const lk = lp ? phKey(phOf(lp)) : key;
      const mp = findPh(path(R.L.master, 'cSld', 'spTree'), lk, false); if (mp) inh.push(mp);
    }
    const spPr = kid(sp, 'spPr');
    const b = xfrmOf(sp, spPr, inh);
    if (!b) return;
    const style = kid(sp, 'style');
    const T = R.T;
    // Füllung
    let f = fillOf(spPr, T);
    if (!f) for (const e of inh) { f = fillOf(kid(e, 'spPr'), T); if (f) break; }
    if (!f && style) { const fr = kid(style, 'fillRef'); if (fr && num(fr, 'idx') > 0) { const c = colorOf(fr, T); const st = T.fillStyles[num(fr, 'idx') - 1]; f = st && /^(gradFill|solidFill)$/.test(st.localName) ? fillOf({ children: [st] }, T, c) : { type: 'solid', c }; } }
    // Linie
    let ln = kid(spPr, 'ln'); if (!ln) for (const e of inh) { ln = kid(kid(e, 'spPr'), 'ln'); if (ln) break; }
    const line = lineOf(ln, style, T);
    // Geometrie
    let geom = kid(spPr, 'prstGeom'), cust = kid(spPr, 'custGeom');
    if (!geom && !cust) for (const e of inh) { geom = kid(kid(e, 'spPr'), 'prstGeom'); cust = kid(kid(e, 'spPr'), 'custGeom'); if (geom || cust) break; }
    const prst = geom ? att(geom, 'prst', 'rect') : cust ? null : 'rect';
    const isLine = prst && LINES.test(prst) || sp.localName === 'cxnSp';

    enter(b);
    g.beginPath();
    let ok = true;
    if (cust) ok = customPath(g, cust, b.w, b.h); else presetPath(g, prst, b.w, b.h, geom);
    if (ok && !isLine && f) await paintFill(f, 0, 0, b.w, b.h, src.rels);
    if (ok && line) {
      g.lineWidth = line.w; g.strokeStyle = css(line.c); g.setLineDash(line.dash.map(d => d * line.w)); g.lineCap = line.cap; g.lineJoin = 'round';
      g.stroke(); g.setLineDash([]);
      if (isLine) arrows(ln, line, b);
    }
    g.restore();
    // Text (Spiegelung nicht auf den Text anwenden)
    const tx = kid(sp, 'txBody');
    const txx = kid(sp, 'txXfrm');          // SmartArt: eigener Textrahmen
    const tb = txx ? box(txx) : b;
    if (tx) await drawText(R, tx, tb || b, { ph: key, inh, style, src });
  }

  function lineOf(ln, style, T) {
    if (ln && kid(ln, 'noFill')) return null;
    let c = ln ? colorOf(kid(ln, 'solidFill'), T) : null;
    if (!c && ln) { const gf = kid(ln, 'gradFill'); if (gf) c = colorOf(kid(kid(gf, 'gsLst'), 'gs'), T); }
    let w = ln && ln.getAttribute('w') != null ? num(ln, 'w') / EMU : null;
    const lr = style && kid(style, 'lnRef');
    if (!c && lr && num(lr, 'idx') > 0) { const ph = colorOf(lr, T), st = T.lnStyles[num(lr, 'idx') - 1]; c = colorOf(kid(st, 'solidFill'), T, ph) || ph; }
    if (w == null && lr && num(lr, 'idx') > 0) { const st = T.lnStyles[num(lr, 'idx') - 1]; w = st ? num(st, 'w', 9525) / EMU : 0.75; }
    if (!c) return null;
    const dash = { dash: [4, 3], sysDash: [3, 1], dot: [1, 1], sysDot: [1, 1], lgDash: [8, 3], dashDot: [4, 3, 1, 3], lgDashDot: [8, 3, 1, 3], sysDashDot: [3, 1, 1, 1] }[att(path(ln, 'prstDash'), 'val')] || [];
    return { c, w: Math.max(0.25, w ?? 0.75), dash, cap: att(ln, 'cap') === 'rnd' ? 'round' : 'butt' };
  }
  function arrows(ln, line, b) {
    const head = (el, x, y, ang) => {
      const t = att(el, 'type'); if (!t || t === 'none') return;
      const s = Math.max(3, line.w * 3.2);
      g.save(); g.translate(x, y); g.rotate(ang); g.beginPath();
      if (t === 'oval') g.ellipse(0, 0, s / 2, s / 2, 0, 0, 7);
      else { g.moveTo(0, 0); g.lineTo(-s, -s / 2); if (t === 'stealth') g.lineTo(-s * .65, 0); g.lineTo(-s, s / 2); g.closePath(); }
      g.fillStyle = css(line.c); g.fill(); g.restore();
    };
    g.save(); enter(b);
    const an = Math.atan2(b.h, b.w);
    head(kid(ln, 'tailEnd'), b.w, b.h, an);
    head(kid(ln, 'headEnd'), 0, 0, an + Math.PI);
    g.restore(); g.restore();
  }

  async function drawPic(R, pic, src) {
    const ph = phOf(pic);
    if (ph && src.src !== 'slide') return;
    const inh = [];
    if (ph) { const lp = findPh(path(R.L.layout, 'cSld', 'spTree'), phKey(ph), true); if (lp) inh.push(lp); }
    const spPr = kid(pic, 'spPr');
    const b = xfrmOf(pic, spPr, inh); if (!b) return;
    const bf = kid(pic, 'blipFill'), blip = kid(bf, 'blip');
    const target = src.rels.get(rid(blip, 'embed'))?.target;
    if (!target) { if (rid(blip, 'link')) warn.add('Verknüpfte Bilder (nicht eingebettet) fehlen'); return; }
    const im = await image(target);
    enter(b);
    g.beginPath();
    const geom = kid(spPr, 'prstGeom');
    presetPath(g, geom ? att(geom, 'prst', 'rect') : 'rect', b.w, b.h, geom);
    if (im) { g.save(); g.clip(); drawCropped(im, kid(bf, 'srcRect'), 0, 0, b.w, b.h, blip); g.restore(); }
    const line = lineOf(kid(spPr, 'ln'), kid(pic, 'style'), R.T);
    if (line) { g.lineWidth = line.w; g.strokeStyle = css(line.c); g.stroke(); }
    g.restore();
    if (kid(path(pic, 'nvPicPr', 'nvPr'), 'videoFile') || kid(path(pic, 'nvPicPr', 'nvPr'), 'audioFile')) warn.add('Videos und Töne wurden als Standbild übernommen');
  }

  async function drawGroup(R, grp, src) {
    const x = path(grp, 'grpSpPr', 'xfrm');
    if (!x) { for (const c of grp.children) await drawNode(R, c, src); return; }
    const off = kid(x, 'off'), ext = kid(x, 'ext'), co = kid(x, 'chOff'), ce = kid(x, 'chExt');
    const b = { x: num(off, 'x') / EMU, y: num(off, 'y') / EMU, w: num(ext, 'cx') / EMU, h: num(ext, 'cy') / EMU, rot: num(x, 'rot') / 60000, flipH: bool(att(x, 'flipH')), flipV: bool(att(x, 'flipV')) };
    const cw = num(ce, 'cx') / EMU || b.w, chh = num(ce, 'cy') / EMU || b.h;
    enter(b);
    g.scale(b.w / (cw || 1), b.h / (chh || 1));
    g.translate(-num(co, 'x') / EMU, -num(co, 'y') / EMU);
    for (const c of grp.children) await drawNode(R, c, src);
    g.restore();
  }

  async function drawFrame(R, fr, src) {
    const x = kid(fr, 'xfrm'); if (!x) return;
    const off = kid(x, 'off'), ext = kid(x, 'ext');
    const b = { x: num(off, 'x') / EMU, y: num(off, 'y') / EMU, w: num(ext, 'cx') / EMU, h: num(ext, 'cy') / EMU };
    const gd = path(fr, 'graphic', 'graphicData');
    const uri = att(gd, 'uri') || '';
    const tbl = kid(gd, 'tbl');
    if (tbl) return drawTable(R, tbl, b);
    if (/diagram/.test(uri)) {
      // SmartArt: PowerPoint speichert eine fertige Zeichnung (diagrams/drawingN.xml)
      const ids = kid(gd, 'relIds');
      const dm = src.rels.get(rid(ids, 'dm'))?.target;
      let drawingPath = null;
      if (dm) {
        const data = await xml(dm);
        const ext2 = data && [...data.getElementsByTagName('*')].find(e => e.localName === 'dataModelExt');
        if (ext2) drawingPath = src.rels.get(att(ext2, 'relId'))?.target;
      }
      if (!drawingPath) drawingPath = [...src.rels.values()].find(r => r.type === 'diagramDrawing')?.target;
      const dr = await xml(drawingPath);
      const tree = path(dr, 'spTree');
      if (!tree) { warn.add('Einige SmartArt-Grafiken konnten nicht übernommen werden'); return; }
      const dRels = await rels(drawingPath);
      g.save(); g.translate(b.x, b.y);
      await drawTree(R, tree, { src: 'drawing', rels: dRels, relBase: drawingPath });
      g.restore();
      return;
    }
    if (/chart/.test(uri)) {
      const cid = rid(kid(gd, 'chart'), 'id'), cp = cid && src.rels.get(cid)?.target;
      const ok = cp && await drawChart(R, b, await xml(cp)).catch(e => { console.warn(e); return false; });
      if (!ok) warn.add('Einige Diagramme konnten nicht übernommen werden');
      return;
    }
    // Eingebettete Objekte: Vorschaubild, falls vorhanden
    const pic = [...gd.getElementsByTagName('*')].find(e => e.localName === 'pic');
    if (pic) await drawPic(R, pic, src).catch(() => {});
  }

  // ---------------- Diagramme (aus den gespeicherten Werten) ----------------
  async function drawChart(R, b, cs) {
    const ch = kid(cs, 'chart'); if (!ch) return false;
    const T = R.T, plot = kid(ch, 'plotArea');
    const TYPES = ['barChart', 'bar3DChart', 'lineChart', 'line3DChart', 'areaChart', 'area3DChart', 'pieChart', 'pie3DChart', 'doughnutChart', 'scatterChart'];
    const types = [...(plot?.children || [])].filter(c => TYPES.includes(c.localName));
    if (!types.length) return false;
    const vals = el => { const c = path(el, 'numRef', 'numCache') || kid(el, 'numLit'); const out = []; for (const p of kids(c, 'pt')) out[num(p, 'idx')] = +(kid(p, 'v')?.textContent); out.length = Math.max(out.length, num(kid(c, 'ptCount'), 'val', out.length)); return out; };
    const strs = el => { const c = path(el, 'strRef', 'strCache') || path(el, 'numRef', 'numCache') || kid(el, 'strLit') || path(el, 'multiLvlStrRef', 'multiLvlStrCache', 'lvl'); const out = []; for (const p of kids(c, 'pt')) out[num(p, 'idx')] = kid(p, 'v')?.textContent ?? ''; return out; };
    const accent = i => { const base = hex2(T.scheme('accent' + ((i % 6) + 1))); const k = Math.floor(i / 6); if (!k) return base; const [h, s2, l] = rgb2hsl(base); return { ...hsl2rgb(h, s2, clamp01(k % 2 ? l * 0.6 : l + (1 - l) * 0.4)), a: 1 }; };
    const serColor = (ser, i) => { const sp = kid(ser, 'spPr'); return colorOf(kid(sp, 'solidFill'), T) || colorOf(kid(kid(sp, 'ln'), 'solidFill'), T) || accent(i); };
    const series = [];
    for (const t of types) for (const ser of kids(t, 'ser')) series.push({ t, ser, name: strs(kid(ser, 'tx'))[0] || '', cats: strs(kid(ser, 'cat') || kid(ser, 'xVal')), v: vals(kid(ser, 'val') || kid(ser, 'yVal')), color: serColor(ser, num(kid(ser, 'idx'), 'val', series.length)) });
    if (!series.length) return false;
    const main = types[0].localName;
    const isPie = /pie|doughnut/.test(main);
    const baseSz = (num(path(cs, 'txPr', 'p', 'pPr', 'defRPr'), 'sz', 1000) || 1000) / 100;
    const fs = Math.max(6, Math.min(baseSz, b.h / 14));
    const txt = hex2('595959'), grid = hex2('D9D9D9');
    const ff = fam(T.fonts.minor);
    g.save(); g.beginPath(); g.rect(b.x, b.y, b.w, b.h); g.clip();
    // Hintergrund
    const csSp = kid(cs, 'spPr'), bgF = fillOf(csSp, T);
    if (bgF) { g.beginPath(); g.rect(b.x, b.y, b.w, b.h); await paintFill(bgF, b.x, b.y, b.w, b.h, null); }
    let x0 = b.x + b.w * 0.03, x1 = b.x + b.w * 0.97, y0 = b.y + b.h * 0.04, y1 = b.y + b.h * 0.96;
    // Titel
    const tEl = kid(ch, 'title');
    let title = tEl ? [...tEl.getElementsByTagName('*')].filter(e => e.localName === 't').map(e => e.textContent).join('') : '';
    if (!title && tEl) title = series.length === 1 ? series[0].name : '';
    if (!tEl && att(kid(ch, 'autoTitleDeleted'), 'val') === '0' && series.length === 1) title = series[0].name;
    if (title) {
      g.font = `700 ${(fs * 1.4).toFixed(1)}px ${ff}`; g.fillStyle = css(hex2('404040')); g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText(title, (x0 + x1) / 2, y0, x1 - x0); y0 += fs * 2.1;
    }
    // Legende
    const lg = kid(ch, 'legend');
    const lpos = lg ? att(kid(lg, 'legendPos'), 'val', 'r') : null;
    const entries = isPie ? series[0].cats.map((c, i) => ({ name: c ?? '', color: ptColor(series[0], i) })) : series.map(s2 => ({ name: s2.name, color: s2.color }));
    g.font = `400 ${fs.toFixed(1)}px ${ff}`; g.textBaseline = 'middle';
    if (lg && entries.length) {
      const sw = fs * 0.8;
      if (lpos === 'r' || lpos === 'l') {
        const w = Math.min((x1 - x0) * 0.35, Math.max(...entries.map(e => g.measureText(e.name).width)) + sw + fs);
        const lx = lpos === 'r' ? x1 - w : x0, h = entries.length * fs * 1.5, ly = (y0 + y1) / 2 - h / 2;
        entries.forEach((e, i) => { g.fillStyle = css(e.color); g.fillRect(lx, ly + i * fs * 1.5 + fs * 0.35, sw, sw); g.fillStyle = css(txt); g.textAlign = 'left'; g.fillText(e.name, lx + sw + fs * 0.4, ly + i * fs * 1.5 + fs * 0.75, w - sw - fs * 0.4); });
        if (lpos === 'r') x1 -= w + fs; else x0 += w + fs;
      } else {
        const ws = entries.map(e => sw + fs * 0.4 + g.measureText(e.name).width + fs);
        const tot = ws.reduce((a, c) => a + c, 0); let lx = Math.max(x0, (x0 + x1) / 2 - tot / 2);
        const ly = lpos === 't' ? y0 + fs * 0.6 : y1 - fs * 0.6;
        entries.forEach((e, i) => { g.fillStyle = css(e.color); g.fillRect(lx, ly - sw / 2, sw, sw); g.fillStyle = css(txt); g.textAlign = 'left'; g.fillText(e.name, lx + sw + fs * 0.4, ly); lx += ws[i]; });
        if (lpos === 't') y0 += fs * 1.8; else y1 -= fs * 1.8;
      }
    }
    function ptColor(s2, i) {
      const dp = kids(s2.ser, 'dPt').find(d => num(kid(d, 'idx'), 'val') === i);
      const c = dp && colorOf(kid(kid(dp, 'spPr'), 'solidFill'), T);
      return c || (att(kid(s2.t, 'varyColors'), 'val') !== '0' || isPie ? accent(i) : s2.color);
    }
    if (isPie) {
      const s2 = series[0], vs = s2.v.map(v => Math.max(0, +v || 0)), sum = vs.reduce((a, c) => a + c, 0) || 1;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = Math.min(x1 - x0, y1 - y0) / 2 * 0.92;
      const hole = /doughnut/.test(main) ? num(kid(types[0], 'holeSize'), 'val', 50) / 100 : 0;
      let a = -Math.PI / 2 + num(kid(types[0], 'firstSliceAng'), 'val', 0) * Math.PI / 180;
      vs.forEach((v, i) => {
        const da = v / sum * Math.PI * 2; if (!da) return;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * r * hole, cy + Math.sin(a) * r * hole);
        g.arc(cx, cy, r, a, a + da); if (hole) g.arc(cx, cy, r * hole, a + da, a, true); else g.lineTo(cx, cy);
        g.closePath(); g.fillStyle = css(ptColor(s2, i)); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = Math.max(0.5, r / 120); g.stroke();
        a += da;
      });
      g.restore(); return true;
    }
    // Achsen-Chart
    const cats = series.reduce((m, s2) => s2.cats.length > m.length ? s2.cats : m, []);
    const n = Math.max(cats.length, ...series.map(s2 => s2.v.length));
    const bar = types.find(t => /bar/.test(t.localName));
    const horiz = bar && att(kid(bar, 'barDir'), 'val') === 'bar';
    const grouping = att(kid(types[0], 'grouping'), 'val', 'clustered');
    const stacked = /stacked/i.test(grouping), pct = grouping === 'percentStacked';
    let lo = 0, hi = 0;
    if (stacked) for (let i = 0; i < n; i++) { let p = 0, q = 0; for (const s2 of series) { const v = +s2.v[i] || 0; if (v >= 0) p += v; else q += v; } if (pct) { hi = 1; } else { hi = Math.max(hi, p); lo = Math.min(lo, q); } }
    else for (const s2 of series) for (const v of s2.v) if (Number.isFinite(+v)) { hi = Math.max(hi, +v); lo = Math.min(lo, +v); }
    const valAx = kid(plot, 'valAx'), sc = kid(valAx, 'scaling');
    if (kid(sc, 'max')) hi = num(kid(sc, 'max'), 'val'); if (kid(sc, 'min')) lo = num(kid(sc, 'min'), 'val');
    if (hi === lo) hi = lo + 1;
    const raw = (hi - lo) / 6, mag = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw) || raw;
    if (!kid(sc, 'max')) hi = Math.ceil(hi / step - 1e-9) * step; if (!kid(sc, 'min')) lo = Math.floor(lo / step + 1e-9) * step;
    const fmt = v => pct ? Math.round(v * 100) + ' %' : (Math.abs(v) >= 1000 ? v.toLocaleString('de-DE') : String(+v.toFixed(6)).replace('.', ','));
    const ticks = []; for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(+v.toFixed(10));
    g.font = `400 ${fs.toFixed(1)}px ${ff}`;
    const showVal = att(kid(valAx, 'delete'), 'val') !== '1', catAx = kid(plot, 'catAx') || kid(plot, 'dateAx'), showCat = att(kid(catAx, 'delete'), 'val') !== '1';
    const lblW = showVal ? Math.max(...ticks.map(t => g.measureText(fmt(t)).width)) + fs * 0.6 : 0;
    const catW = horiz && showCat ? Math.min((x1 - x0) * 0.3, Math.max(0, ...cats.map(c => g.measureText(String(c ?? '')).width)) + fs * 0.6) : 0;
    const px0 = x0 + (horiz ? catW : lblW), px1 = x1, py0 = y0 + fs * 0.5, py1 = y1 - (showCat || horiz ? fs * 1.6 : fs * 0.4);
    const vPos = v => horiz ? px0 + (v - lo) / (hi - lo) * (px1 - px0) : py1 - (v - lo) / (hi - lo) * (py1 - py0);
    // Gitter & Werte
    g.lineWidth = Math.max(0.4, fs / 16);
    for (const t of ticks) {
      const p = vPos(t);
      if (kid(valAx, 'majorGridlines')) { g.strokeStyle = css(grid); g.beginPath(); if (horiz) { g.moveTo(p, py0); g.lineTo(p, py1); } else { g.moveTo(px0, p); g.lineTo(px1, p); } g.stroke(); }
      if (showVal) { g.fillStyle = css(txt); if (horiz) { g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(fmt(t), p, py1 + fs * 0.3); } else { g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(fmt(t), px0 - fs * 0.3, p); } }
    }
    const slot = (horiz ? py1 - py0 : px1 - px0) / Math.max(1, n);
    const cPos = i => horiz ? py0 + slot * (i + 0.5) : px0 + slot * (i + 0.5);
    if (showCat) {
      g.fillStyle = css(txt);
      for (let i = 0; i < n; i++) {
        const c = String(cats[i] ?? i + 1);
        if (horiz) { g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(c, px0 - fs * 0.3, cPos(i), catW); }
        else { g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(c, cPos(i), py1 + fs * 0.3, slot * 0.98); }
      }
    }
    // Achsenlinie
    g.strokeStyle = css(hex2('BFBFBF')); g.beginPath();
    if (horiz) { g.moveTo(vPos(Math.max(lo, 0)), py0); g.lineTo(vPos(Math.max(lo, 0)), py1); } else { g.moveTo(px0, vPos(Math.max(lo, 0))); g.lineTo(px1, vPos(Math.max(lo, 0))); }
    g.stroke();
    // Balken
    const barSer = series.filter(s2 => /bar/.test(s2.t.localName));
    if (barSer.length) {
      const gap = num(kid(bar, 'gapWidth'), 'val', 150) / 100;
      const groupW = slot / (1 + gap), k = stacked ? 1 : barSer.length, bw = groupW / k;
      for (let i = 0; i < n; i++) {
        let pos = 0, neg = 0;
        const tot = pct ? barSer.reduce((a, s2) => a + Math.abs(+s2.v[i] || 0), 0) || 1 : 1;
        barSer.forEach((s2, si) => {
          let v = +s2.v[i]; if (!Number.isFinite(v)) return; v /= tot;
          let a0, a1;
          if (stacked) { if (v >= 0) { a0 = pos; pos += v; a1 = pos; } else { a0 = neg; neg += v; a1 = neg; } } else { a0 = Math.max(lo, 0); a1 = v; }
          const c0 = cPos(i) - groupW / 2 + (stacked ? 0 : si * bw);
          const p0 = vPos(a0), p1 = vPos(a1);
          g.fillStyle = css(barSer.length === 1 && att(kid(bar, 'varyColors'), 'val') === '1' ? accent(i) : s2.color);
          if (horiz) g.fillRect(Math.min(p0, p1), c0, Math.abs(p1 - p0), bw * 0.98); else g.fillRect(c0, Math.min(p0, p1), bw * 0.98, Math.abs(p1 - p0));
        });
      }
    }
    // Linien & Flächen
    let acc = new Array(n).fill(0);
    for (const s2 of series.filter(s3 => /line|area|scatter/.test(s3.t.localName))) {
      const area = /area/.test(s2.t.localName);
      const pts = [];
      for (let i = 0; i < n; i++) { let v = +s2.v[i]; if (!Number.isFinite(v)) continue; if (stacked) { acc[i] += v; v = acc[i]; } pts.push([cPos(i), vPos(v)]); }
      if (!pts.length) continue;
      g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
      if (area) { g.lineTo(pts[pts.length - 1][0], vPos(Math.max(lo, 0))); g.lineTo(pts[0][0], vPos(Math.max(lo, 0))); g.closePath(); g.fillStyle = css({ ...s2.color, a: 0.85 }); g.fill(); continue; }
      g.strokeStyle = css(s2.color); g.lineWidth = Math.max(1, fs / 6); g.lineJoin = 'round'; g.stroke();
      if (att(path(s2.ser, 'marker', 'symbol'), 'val') !== 'none') for (const [x, y] of pts) { g.beginPath(); g.arc(x, y, Math.max(1.5, fs / 5), 0, 7); g.fillStyle = css(s2.color); g.fill(); }
    }
    g.restore();
    return true;
  }

  // ---------------- Tabellen ----------------
  async function drawTable(R, tbl, b) {
    const T = R.T;
    const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map(c => num(c, 'w') / EMU);
    const rows = kids(tbl, 'tr');
    const tp = kid(tbl, 'tblPr');
    const firstRow = bool(att(tp, 'firstRow')), bandRow = bool(att(tp, 'bandRow'));
    const styled = !!kid(tp, 'tableStyleId');
    const acc = hex2(T.scheme('accent1'));
    const tint = (c, k) => ({ r: c.r + (255 - c.r) * k, g: c.g + (255 - c.g) * k, b: c.b + (255 - c.b) * k, a: 1 });
    // Zeilenhöhen: max(angegeben, Textbedarf)
    const heights = [];
    for (let ri = 0; ri < rows.length; ri++) {
      let h = num(rows[ri], 'h') / EMU;
      let ci = 0;
      for (const tc of kids(rows[ri], 'tc')) {
        const span = num(tc, 'gridSpan', 1);
        if (!bool(att(tc, 'hMerge')) && !bool(att(tc, 'vMerge')) && num(tc, 'rowSpan', 1) === 1) {
          const w = cols.slice(ci, ci + span).reduce((a, c) => a + c, 0);
          const pr = kid(tc, 'tcPr');
          const ins = { l: num(pr, 'marL', 91440) / EMU, r: num(pr, 'marR', 91440) / EMU, t: num(pr, 'marT', 45720) / EMU, b: num(pr, 'marB', 45720) / EMU };
          const need = measureText(R, kid(tc, 'txBody'), w - ins.l - ins.r, cellStyle(ri));
          h = Math.max(h, need + ins.t + ins.b);
        }
        ci += span;
      }
      heights.push(h);
    }
    function cellStyle(ri) { return styled && firstRow && ri === 0 ? { color: { r: 255, g: 255, b: 255, a: 1 }, b: true } : null; }
    let y = b.y;
    for (let ri = 0; ri < rows.length; ri++) {
      let x = b.x, ci = 0;
      for (const tc of kids(rows[ri], 'tc')) {
        const span = num(tc, 'gridSpan', 1), rs = num(tc, 'rowSpan', 1);
        const w = cols.slice(ci, ci + span).reduce((a, c) => a + c, 0);
        const h = heights.slice(ri, ri + rs).reduce((a, c) => a + c, 0);
        if (!bool(att(tc, 'hMerge')) && !bool(att(tc, 'vMerge'))) {
          const pr = kid(tc, 'tcPr');
          let f = fillOf(pr, T);
          if (!f && styled) {
            if (firstRow && ri === 0) f = { type: 'solid', c: acc };
            else { const k = bandRow && (ri - (firstRow ? 1 : 0)) % 2 === 0 ? 0.6 : 0.8; f = { type: 'solid', c: tint(acc, k) }; }
          }
          g.save(); g.beginPath(); g.rect(x, y, w, h);
          await paintFill(f, x, y, w, h, null);
          g.restore();
          // Rahmen
          const edges = [['lnL', x, y, x, y + h], ['lnR', x + w, y, x + w, y + h], ['lnT', x, y, x + w, y], ['lnB', x, y + h, x + w, y + h]];
          for (const [n, x1, y1, x2, y2] of edges) {
            const l = lineOf(kid(pr, n), null, T) || (styled ? { c: { r: 255, g: 255, b: 255, a: 1 }, w: 1, dash: [], cap: 'butt' } : null);
            if (!l) continue;
            g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.lineWidth = l.w; g.strokeStyle = css(l.c); g.stroke();
          }
          const ins = { l: num(pr, 'marL', 91440) / EMU, r: num(pr, 'marR', 91440) / EMU, t: num(pr, 'marT', 45720) / EMU, b: num(pr, 'marB', 45720) / EMU };
          const tx = kid(tc, 'txBody');
          if (tx) await drawText(R, tx, { x, y, w, h, rot: 0 }, { cell: { ins, anchor: att(pr, 'anchor', 't'), over: cellStyle(ri) } });
        }
        x += w; ci += span;
      }
      y += heights[ri];
    }
  }

  // ---------------- Text ----------------
  function textChain(R, o) {
    // Reihenfolge (außen → innen): Präsentations-Standard, Formvorlage (fontRef), Master-Textformate,
    // Platzhalter-Vorlagen (Master → Layout), eigene lstStyle – danach Absatz (pPr) und Lauf (rPr)
    const T = R.T;
    let master = null;
    if (o.ph) {
      const t = o.ph.type;
      master = kid(R.L.txStyles, /^(title|ctrTitle)$/.test(t) ? 'titleStyle' : /^(dt|ftr|sldNum|hdr)$/.test(t) ? 'otherStyle' : 'bodyStyle');
    }
    const fr = o.style ? kid(o.style, 'fontRef') : null;
    const ref = { p: {}, r: {} };
    if (fr) { const c = colorOf(fr, T); if (c) ref.r.color = c; ref.r.font = att(fr, 'idx') === 'major' ? '+mj-lt' : '+mn-lt'; }
    const lists = [];
    for (let i = (o.inh || []).length - 1; i >= 0; i--) lists.push(path(o.inh[i], 'txBody', 'lstStyle'));
    return (lvl, own) => merge(lvlOf(defaultText, lvl, T), ref, master ? lvlOf(master, lvl, T) : null, ...lists.map(l => lvlOf(l, lvl, T)), lvlOf(own, lvl, T));
  }

  // Absätze in Zeilen umbrechen; liefert { lines, height }
  function layout(R, tx, width, o) {
    const T = R.T;
    const chain = textChain(R, o);
    const own = kid(tx, 'lstStyle');
    let bp = {};
    for (let i = (o.inh || []).length - 1; i >= 0; i--) bp = bodyProps(path(o.inh[i], 'txBody', 'bodyPr'), bp);
    bp = bodyProps(kid(tx, 'bodyPr'), bp);
    const scale = bp.fontScale ?? 1, lnRed = bp.lnRed ?? 0;
    const wrap = bp.wrap !== 'none';
    const lines = [];
    let height = 0, numCount = {}, firstPara = true;
    for (const p of kids(tx, 'p')) {
      const pPr = kid(p, 'pPr');
      const lvl = num(pPr, 'lvl', 0);
      const base = chain(lvl, own);
      const pp = { ...base.p, ...pProps(pPr, T).p };
      const pr = { ...base.r, ...pProps(pPr, T).r };
      // Läufe → Wörter
      const toks = [];
      const style = rPr => {
        const r = { ...pr, ...(o.cell?.over || {}), ...rProps(rPr, T) };
        if (o.cell?.over && rPr && kid(rPr, 'solidFill')) r.color = rProps(rPr, T).color;
        const sz = (r.sz || 18) * scale;
        const face = T.font(r.font);
        return { sz, b: !!r.b, i: !!r.i, u: !!r.u, strike: !!r.strike, base: r.base || 0, cap: r.cap, color: r.link && !kid(rPr, 'solidFill') ? hex2(T.scheme('hlink')) : r.color || hex2(T.scheme('tx1')), face, spc: r.spc || 0 };
      };
      let maxSz = 0;
      for (const r of p.children) {
        if (r.localName === 'r' || r.localName === 'fld') {
          const st = style(kid(r, 'rPr'));
          let t = kid(r, 't')?.textContent ?? '';
          if (r.localName === 'fld' && /slidenum/i.test(att(r, 'type') || '')) t = String(R.slideNo);
          t = t.replace(/\t/g, '    ');
          if (st.cap === 'all') t = t.toUpperCase();
          for (const part of t.split(/(\s+)/)) if (part) toks.push({ t: part, st, sp: /^\s+$/.test(part) });
          maxSz = Math.max(maxSz, st.sz);
        } else if (r.localName === 'br') { toks.push({ br: true, st: style(kid(r, 'rPr')) }); }
      }
      const endSt = style(kid(p, 'endParaRPr'));
      if (!maxSz) maxSz = endSt.sz;
      const hasText = toks.some(t => t.t && !t.sp);
      // Aufzählungszeichen
      let bullet = null;
      const bu = pp.bu;
      if (hasText && bu && bu.type !== 'none' && !o.cell) {
        const st0 = toks.find(t => t.st)?.st || endSt;
        let ch = '';
        if (bu.type === 'char') { ch = bu.ch; if (/wingdings|symbol/i.test(pp.buFont || '')) ch = WING[ch] || '•'; }
        else { numCount[lvl] = (numCount[lvl] ?? (bu.start - 1)) + 1; ch = autoNum(bu.scheme, numCount[lvl]); }
        bullet = { t: ch, st: { ...st0, sz: st0.sz * (pp.buSz || 1), color: pp.buClr || st0.color, face: bu.type === 'char' && !/wingdings|symbol/i.test(pp.buFont || '') && pp.buFont && pp.buFont[0] !== '+' ? pp.buFont : st0.face, u: false, strike: false } };
      } else if (bu?.type !== 'num') { for (const k in numCount) if (+k >= lvl) delete numCount[k]; }
      const marL = pp.marL ?? 0, ind = pp.indent ?? 0;
      // Abstände
      const lnPct = pp.lnSpc?.pct != null ? Math.max(0.5, pp.lnSpc.pct - lnRed) : null;
      const lineH = sz => pp.lnSpc?.pts ? pp.lnSpc.pts * scale : sz * 1.2 * (lnPct ?? 1);
      const spc = (v, sz) => !v ? 0 : v.pts != null ? v.pts : v.pct * sz * 1.2;
      if (!firstPara) height += spc(pp.spcBef, maxSz);
      firstPara = false;
      // Messen
      for (const t of toks) if (t.t) { g.font = fontCss(t.st); t.w = g.measureText(t.t).width + t.st.spc * t.t.length; }
      if (bullet) { g.font = fontCss(bullet.st); bullet.w = g.measureText(bullet.t).width; }
      // Erste Zeile: Zeichen bei marL+indent, Text bei marL (bzw. direkt hinter dem Zeichen)
      const bx = marL + ind;
      const firstX = bullet ? Math.max(marL, bx + bullet.w + (marL - bx >= bullet.w ? 0 : bullet.st.sz * 0.3)) : Math.max(0, bx);
      const lx = first => first ? firstX : marL;
      let line = { items: [], w: 0, sz: 0, first: true };
      const push = () => {
        while (line.items.length && line.items[line.items.length - 1].sp) line.items.pop();
        line.w = line.items.reduce((a, t) => a + t.w, 0);
        const sz = line.sz || maxSz, lh = lineH(sz), x = lx(line.first);
        lines.push({ items: line.items, w: line.w, x, avail: width - x, y: height, lh, sz, algn: pp.algn || 'l', bullet: line.first ? bullet : null, bx });
        height += lh;
        line = { items: [], w: 0, sz: 0, first: false };
      };
      for (const t of toks) {
        if (t.br) { line.sz = Math.max(line.sz, t.st.sz); push(); continue; }
        if (t.sp && !line.items.length) continue;
        if (wrap && !t.sp && line.items.length && line.w + t.w > width - lx(line.first) + 0.01) push();
        if (wrap && !t.sp && t.w > width - lx(line.first) && t.t.length > 1) {
          // überlanges Wort zeichenweise trennen
          g.font = fontCss(t.st);
          let chunk = '';
          for (const ch of t.t) {
            if (chunk && line.w + g.measureText(chunk + ch).width > width - lx(line.first)) {
              const w = g.measureText(chunk).width; line.items.push({ ...t, t: chunk, w }); line.w += w; line.sz = Math.max(line.sz, t.st.sz); push(); chunk = ch;
            } else chunk += ch;
          }
          if (chunk) { const w = g.measureText(chunk).width; line.items.push({ ...t, t: chunk, w }); line.w += w; line.sz = Math.max(line.sz, t.st.sz); }
          continue;
        }
        line.items.push(t); line.w += t.w; line.sz = Math.max(line.sz, t.st.sz);
      }
      if (line.items.length || line.first) { line.sz = line.sz || endSt.sz; push(); }
      height += spc(pp.spcAft, maxSz);
    }
    return { lines, height, bp };
  }

  function fontCss(st) { return `${st.i ? 'italic ' : ''}${st.b ? 700 : 400} ${Math.max(0.5, st.sz * (st.base ? 0.65 : 1)).toFixed(2)}px ${fam(st.face)}`; }

  function measureText(R, tx, width, over) {
    if (!tx) return 0;
    return layout(R, tx, width, { cell: { over } }).height;
  }

  async function drawText(R, tx, b, o) {
    if (!kids(tx, 'p').some(p => [...p.getElementsByTagName('*')].some(e => e.localName === 't' && e.textContent.trim()))) return;
    // Schriften laden (einmalig je Schnitt)
    const loads = [];
    for (const f of new Set([...tx.getElementsByTagName('*')].filter(e => e.localName === 'latin').map(e => R.T.font(att(e, 'typeface'))).concat([R.T.fonts.minor, R.T.fonts.major])))
      for (const bb of [0, 1]) { const p = want(f, bb, 0); if (p) loads.push(p); }
    if (loads.length) await Promise.race([Promise.all(loads).catch(() => {}), new Promise(r => setTimeout(r, 1500))]);

    let ins, anchor;
    let bpInh = {};
    if (o.cell) { ins = o.cell.ins; anchor = o.cell.anchor; }
    const vert = (() => { let bp = {}; for (let i = (o.inh || []).length - 1; i >= 0; i--) bp = bodyProps(path(o.inh[i], 'txBody', 'bodyPr'), bp); return bodyProps(kid(tx, 'bodyPr'), bp); })();
    bpInh = vert;
    if (!ins) ins = { l: bpInh.l ?? 7.2, r: bpInh.r ?? 7.2, t: bpInh.t ?? 3.6, b: bpInh.b ?? 3.6 };
    if (!anchor) anchor = bpInh.anchor || 't';
    const rotated = bpInh.vert === 'vert' || bpInh.vert === 'eaVert' ? 90 : bpInh.vert === 'vert270' ? 270 : 0;
    const bw = rotated ? b.h : b.w, bh = rotated ? b.w : b.h;
    const W = Math.max(1, bw - ins.l - ins.r);
    const L2 = layout(R, tx, W, o);
    const top = anchor === 'ctr' ? ins.t + (bh - ins.t - ins.b - L2.height) / 2 : anchor === 'b' ? bh - ins.b - L2.height : ins.t;
    g.save();
    g.translate(b.x + b.w / 2, b.y + b.h / 2);
    const rot = (b.rot || 0) + rotated + (b.flipV ? 180 : 0);
    if (rot) g.rotate(rot * Math.PI / 180);
    g.translate(-bw / 2, -bh / 2);
    const M = g.getTransform();
    const straight = Math.abs(M.b) < 1e-6 && Math.abs(M.c) < 1e-6;
    g.textBaseline = 'alphabetic';
    for (const ln of L2.lines) {
      const free = ln.avail - ln.w;
      let x = ins.l + ln.x + (ln.algn === 'ctr' ? free / 2 : ln.algn === 'r' ? free : 0);
      const base = top + ln.y + ln.lh * 0.78 + Math.max(0, (ln.lh - ln.sz * 1.2)) * 0.1;
      if (ln.bullet) {
        g.font = fontCss(ln.bullet.st); g.fillStyle = css(ln.bullet.st.color);
        g.fillText(ln.bullet.t, ins.l + ln.bx, base);
      }
      for (const t of ln.items) {
        const st = t.st;
        if (!t.sp) {
          g.font = fontCss(st); g.fillStyle = css(st.color);
          const by = base - (st.base ? st.sz * st.base : 0);
          if (st.spc && 'letterSpacing' in g) { g.letterSpacing = st.spc + 'px'; g.fillText(t.t, x, by); g.letterSpacing = '0px'; }
          else if (st.spc) { let cx = x; for (const ch of t.t) { g.fillText(ch, cx, by); cx += g.measureText(ch).width + st.spc; } }
          else g.fillText(t.t, x, by);
          if (straight && (st.color.a ?? 1) > 0.05) {
            const p1 = M.transformPoint(new DOMPoint(x, by - st.sz * 0.8)), p2 = M.transformPoint(new DOMPoint(x + t.w, by + st.sz * 0.2));
            R.runs.push({ t: t.t, x: p1.x / S, y: p1.y / S, w: (p2.x - p1.x) / S, h: (p2.y - p1.y) / S, fs: st.sz * Math.abs(M.a) / S });
          }
        }
        if (st.u || st.strike) {
          g.strokeStyle = css(st.color); g.lineWidth = Math.max(0.5, st.sz / 18);
          g.beginPath();
          if (st.u) { g.moveTo(x, base + st.sz * 0.12); g.lineTo(x + t.w, base + st.sz * 0.12); }
          if (st.strike) { g.moveTo(x, base - st.sz * 0.3); g.lineTo(x + t.w, base - st.sz * 0.3); }
          g.stroke();
        }
        x += t.w;
      }
    }
    g.restore();
  }
}
