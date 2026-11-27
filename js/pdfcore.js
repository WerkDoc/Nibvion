// pdf.js (Anzeige) + pdf-lib (Schreiben)
import * as pdfjsLib from '../lib/pdf.min.js';
import { dataUrlToBytes, loadImage } from './ui.js';
import { geom, labelBox, linesPath, fillPath, dotsPath, MEASURE_COLOR } from './measure.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.js', import.meta.url).href;
export { pdfjsLib };

const L = () => window.PDFLib;

// iPhone/iPad: OffscreenCanvas & ImageDecoder in pdf.js führen in WebKit bei bildlastigen PDFs
// (Buchcover, Fotos) zu extremem Speicherverbrauch → iOS beendet die App. Deshalb dort aus.
export const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Type3-Schriften (z. B. calibre/Chrome-PDFs: OTF-Schriften werden dort als Type3 gespeichert):
// pdf.js setzt pro Buchstabe einen Clip auf die d1-Box. Bei 4000+ Buchstaben pro Seite sprengt
// das auf iOS (CoreGraphics-Clipmasken) den Speicher – und schneidet Kanten dünner Glyphen ab.
// Für reine Vektor-Glyphen (ohne Bilder) ist der Clip überflüssig → entfernen.
const O = pdfjsLib.OPS;
const IMG_OPS = new Set([O.paintImageMaskXObject, O.paintImageMaskXObjectGroup, O.paintImageMaskXObjectRepeat,
  O.paintImageXObject, O.paintImageXObjectRepeat, O.paintInlineImageXObject, O.paintInlineImageXObjectGroup,
  O.paintSolidColorImageMask]);
function stripType3Clips(font) {
  const cp = font?.charProcOperatorList;
  if (!cp || typeof cp !== 'object') return;
  for (const g of Object.values(cp)) {
    const fn = g?.fnArray, args = g?.argsArray;
    if (!fn || fn[0] !== O.setCharWidthAndBounds || fn.some(f => IMG_OPS.has(f))) continue;
    fn.shift(); args?.shift?.();
  }
}
let objsPatched = false;
async function patchObjs(pdf) {
  if (objsPatched || !pdf.numPages) return;
  try {
    const proto = Object.getPrototypeOf((await pdf.getPage(1)).commonObjs);
    if (objsPatched || typeof proto?.resolve !== 'function') return;
    const resolve = proto.resolve;
    proto.resolve = function (id, data) {
      if (data?.charProcOperatorList) { try { stripType3Clips(data); } catch {} }
      return resolve.call(this, id, data);
    };
    objsPatched = true;
  } catch {}
}

/** loadPdf(bytes, { safe }) – safe: Notfallmodus für PDFs, die schon einmal abgestürzt sind */
export async function loadPdf(bytes, opts) {
  const pdf = await openPdf(bytes, opts);
  await patchObjs(pdf);
  return pdf;
}
function openPdf(bytes, { safe = false } = {}) {
  return pdfjsLib.getDocument({
    data: new Uint8Array(bytes.slice(0)), isEvalSupported: false, useSystemFonts: true,
    isOffscreenCanvasSupported: !IOS, isImageDecoderSupported: !IOS,
    // iOS: eingebettete Schriften NICHT als Web-Fonts (FontFace) in Safari laden, sondern als
    // Vektorpfade zeichnen. WebKit stürzt bei manchen eingebetteten Schriften (z. B. InDesign-PDFs
    // mit Palatino/CFF-Fonts) ab – Rechnungen mit Standardschriften waren nie betroffen.
    disableFontFace: IOS,
    // Riesige Einzelbilder (> Pixel) werden übersprungen statt den Speicher zu sprengen
    maxImageSize: safe ? 1.6e7 : IOS ? 6e7 : -1,
    canvasMaxAreaInBytes: IOS ? (safe ? 32 : 96) * 1024 * 1024 : -1,
  }).promise;
}

export function closePdf(pdf) { try { pdf?.loadingTask?.destroy(); } catch {} }

export async function renderThumb(pdf, pageNo = 1, width = 220) {
  const p = await pdf.getPage(pageNo);
  const v = p.getViewport({ scale: 1 });
  const vp = p.getViewport({ scale: width / v.width });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await p.render({ canvasContext: ctx, viewport: vp }).promise;
  const url = c.toDataURL('image/jpeg', 0.78);
  c.width = c.height = 0; p.cleanup();
  return url;
}

export async function pageInfos(pdf) {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const v = p.getViewport({ scale: 1 });
    out.push({ w: v.width, h: v.height, rot: ((p.rotate % 360) + 360) % 360, view: [...p.view] });
  }
  return out;
}

// Viewport-Koordinaten (oben-links, Punkte) -> PDF-Koordinaten
function mapper(info) {
  const [x0, y0, x1, y1] = info.view;
  switch (info.rot) {
    case 90: return (x, y) => ({ x: x0 + y, y: y0 + x });
    case 180: return (x, y) => ({ x: x1 - x, y: y0 + y });
    case 270: return (x, y) => ({ x: x1 - y, y: y1 - x });
    default: return (x, y) => ({ x: x0 + x, y: y1 - y });
  }
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return L().rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export function inkPath(pts, sharp = false) {
  if (!pts.length) return '';
  if (sharp && pts.length > 1) {
    // Smart Shapes: exakter Polygonzug (gerade Kanten); geschlossen → Z für saubere Ecke am Start
    const f = q => `${q[0].toFixed(2)} ${q[1].toFixed(2)}`, l = pts[pts.length - 1];
    const closed = pts.length > 3 && Math.hypot(l[0] - pts[0][0], l[1] - pts[0][1]) < 1e-3;
    const body = closed ? pts.slice(0, -1) : pts;
    return 'M' + f(body[0]) + body.slice(1).map(q => ' L' + f(q)).join('') + (closed ? ' Z' : '');
  }
  if (pts.length === 1) { const [x, y] = pts[0]; return `M${x} ${y} L${x + 0.01} ${y}`; }
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const l = pts[pts.length - 1];
  d += ` L${l[0].toFixed(2)} ${l[1].toFixed(2)}`;
  return d;
}

export const TEXT_ASC = 0.8, LINE_H = 1.22;
// Schriftfamilien für Text-Objekte: Vorschau (CSS) und Speichern (PDF-Standardschrift) passen zusammen
export const FONT_CSS = { sans: 'Helvetica, Arial, sans-serif', serif: '"Times New Roman", Times, serif', mono: '"Courier New", Courier, monospace' };
/** Schrift eines PDF-Textstücks erkennen → { font: 'sans'|'serif'|'mono', bold, italic } */
export function pdfFontInfo(fontObj, style) {
  const n = String(fontObj?.name || '') + ' ' + String(fontObj?.fallbackName || '');
  const fam = String(style?.fontFamily || '');
  let font = 'sans';
  if (fontObj?.isMonospace || /courier|mono|consol|menlo|lucida ?console|typewriter|ocr-?b|letter ?gothic/i.test(n) || /monospace/i.test(fam)) font = 'mono';
  else if (/times|serif(?!.*sans)|georgia|garamond|cambria|palatino|book ?antiqua|minion|century/i.test(n) && !/sans/i.test(n)) font = 'serif';
  else if (fontObj?.isSerifFont && !/sans|arial|helvet|calibri|verdana|segoe/i.test(n)) font = 'serif';
  else if (/^serif$/i.test(fam)) font = 'serif';
  return {
    font,
    bold: !!(fontObj?.bold || fontObj?.black) || /bold|black|heavy|semibold|demi/i.test(n),
    italic: !!fontObj?.italic || /italic|oblique/i.test(n),
  };
}

// Objekte dauerhaft ins PDF schreiben
export async function flatten(bytes, objects, infos) {
  const { PDFDocument, StandardFonts, degrees, BlendMode, LineCapStyle, LineJoinStyle, setLineJoin, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = L();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  // Gedrehtes Objekt: Editor dreht im Uhrzeigersinn (y nach unten). Die Abbildung Editor → PDF
  // spiegelt immer (Determinante −1), daher im PDF um −Winkel um die Mitte drehen.
  const rotStart = (page, M, o) => {
    if (!o.rot || (o.type !== 'image' && o.type !== 'text')) return false;
    const c = M(o.x + o.w / 2, o.y + o.h / 2), r = -o.rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(cs, sn, -sn, cs, c.x - c.x * cs + c.y * sn, c.y - c.x * sn - c.y * cs));
    return true;
  };
  const fonts = {};
  const STD = {
    sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
    serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
    mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
  };
  const font = async (bold, fam = 'sans', italic = false) => {
    const name = (STD[fam] || STD.sans)[(bold ? 1 : 0) + (italic ? 2 : 0)];
    return fonts[name] ??= await doc.embedFont(StandardFonts[name]);
  };
  const imgs = {};
  const embedImg = async src => {
    if (imgs[src]) return imgs[src];
    const b = dataUrlToBytes(src);
    imgs[src] = src.startsWith('data:image/png') ? await doc.embedPng(b) : await doc.embedJpg(b);
    return imgs[src];
  };
  const safe = (f, s) => {
    let out = '';
    for (const ch of s) { try { f.encodeText(ch); out += ch; } catch { out += ({ '✓': 'v', '✗': 'x', '–': '-', '—': '-', '„': '"', '“': '"', '”': '"', '‚': "'", '‘': "'", '’': "'" }[ch] ?? '?'); } }
    return out;
  };

  for (const o of objects) {
    const page = pages[o.page]; const info = infos[o.page];
    if (!page || !info) continue;
    const M = mapper(info); const R = degrees(info.rot);
    const rect = (x, y, w, h, opts) => { const p = M(x, y + h); page.drawRectangle({ x: p.x, y: p.y, width: w, height: h, rotate: R, ...opts }); };
    const rotated = rotStart(page, M, o);

    if (o.type === 'text') {
      if (o.cover) rect(o.cover.x, o.cover.y, o.cover.w, o.cover.h, { color: hexToRgb(o.cover.color) });
      if (o.bg) rect(o.x - 4, o.y - 3, o.w + 8, o.h + 6, { color: hexToRgb(o.bg), borderColor: hexToRgb('#e3c34a'), borderWidth: 0.6 });
      const f = await font(o.bold, o.font, o.italic);
      String(o.text).split('\n').forEach((ln, i) => {
        if (!ln) return;
        const p = M(o.x, o.y + o.size * TEXT_ASC + i * o.size * LINE_H);
        page.drawText(safe(f, ln), { x: p.x, y: p.y, size: o.size, font: f, color: hexToRgb(o.color), rotate: R });
      });
    } else if (o.type === 'whiteout') {
      rect(o.x, o.y, o.w, o.h, { color: hexToRgb(o.color) });
    } else if (o.type === 'highlight') {
      rect(o.x, o.y, o.w, o.h, { color: hexToRgb(o.color), opacity: 0.4, blendMode: BlendMode.Multiply });
    } else if (o.type === 'underline' || o.type === 'strike') {
      const yy = o.type === 'underline' ? o.y + o.h - 0.5 : o.y + o.h * 0.55;
      page.drawLine({ start: M(o.x, yy), end: M(o.x + o.w, yy), thickness: Math.max(0.8, o.h * 0.08), color: hexToRgb(o.color) });
    } else if (o.type === 'image') {
      const img = await embedImg(o.src);
      const p = M(o.x, o.y + o.h);
      page.drawImage(img, { x: p.x, y: p.y, width: o.w, height: o.h, rotate: R, opacity: o.opacity ?? 1 });
    } else if (o.type === 'measure') {
      // Maßlinien, Fläche und Labels als Vektoren (gleiche Geometrie wie im Editor)
      const g = geom(o); if (!g.lines.length) continue;
      const origin = M(0, 0), C = hexToRgb(MEASURE_COLOR), at = { x: origin.x, y: origin.y, rotate: R };
      if (g.fill) page.drawSvgPath(fillPath(g), { ...at, color: C, opacity: 0.18, borderWidth: 0 });
      page.drawSvgPath(linesPath(g), { ...at, borderColor: C, borderWidth: g.lw, borderLineCap: LineCapStyle.Round });
      if (g.dots.length) page.drawSvgPath(dotsPath(g, g.lw * 1.6), { ...at, color: hexToRgb('#ffffff'), borderColor: C, borderWidth: g.lw * 0.8 });
      const f = await font(true);
      for (const l of g.labels) {
        const t = safe(f, l.text), box = labelBox(l);
        page.drawSvgPath(box.d, { ...at, color: hexToRgb('#ffffff'), opacity: 0.94, borderColor: C, borderWidth: g.lw * 0.7 });
        // Breite der eingebetteten Schrift statt Canvas-Messung → exakt mittig
        const fw = f.widthOfTextAtSize(t, l.size), a = l.ang * Math.PI / 180;
        const bx = -fw / 2, by = l.size * 0.35, p = M(l.x + bx * Math.cos(a) - by * Math.sin(a), l.y + bx * Math.sin(a) + by * Math.cos(a));
        page.drawText(t, { x: p.x, y: p.y, size: l.size, font: f, color: hexToRgb('#b42a20'), rotate: degrees(info.rot - l.ang) });
      }
    } else if (o.type === 'ink') {
      const origin = M(0, 0);
      if (o.sharp) page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round));
      page.drawSvgPath(inkPath(o.points, o.sharp), {
        x: origin.x, y: origin.y, rotate: R,
        borderColor: hexToRgb(o.color), borderWidth: o.width, borderOpacity: o.opacity ?? 1,
        borderLineCap: LineCapStyle.Round, blendMode: (o.opacity ?? 1) < 1 ? BlendMode.Multiply : undefined,
      });
      if (o.sharp) page.pushOperators(popGraphicsState());
    }
    if (rotated) page.pushOperators(popGraphicsState());
  }
  return doc.save();
}

// Seiten-Operationen (auf bereits eingebrannten Bytes)
export async function pagesOp(bytes, ops) {
  const { PDFDocument, degrees } = L();
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const idx = ops.order; // [{i, rot}]
  const copied = await out.copyPages(src, idx.map(p => p.i));
  copied.forEach((pg, k) => {
    const add = idx[k].rot || 0;
    if (add) pg.setRotation(degrees((pg.getRotation().angle + add) % 360));
    out.addPage(pg);
  });
  if (ops.blankAfter != null) {
    const ref = out.getPage(Math.min(ops.blankAfter, out.getPageCount() - 1));
    const { width, height } = ref.getSize();
    out.insertPage(ops.blankAfter + 1, [width, height]);
  }
  return out.save();
}

export async function mergePdfs(list) {
  const { PDFDocument } = L();
  const out = await PDFDocument.create();
  for (const b of list) {
    const src = await PDFDocument.load(b, { ignoreEncryption: true });
    const pgs = await out.copyPages(src, src.getPageIndices());
    pgs.forEach(p => out.addPage(p));
  }
  return out.save();
}

// Bilder -> PDF (A4, eingepasst)
export async function imagesToPdf(dataUrls, { fit = 'a4', margin = 0, mm = null } = {}) {
  const { PDFDocument } = L();
  const doc = await PDFDocument.create();
  for (const u of dataUrls) {
    const b = dataUrlToBytes(u);
    const img = u.startsWith('data:image/png') ? await doc.embedPng(b) : await doc.embedJpg(b);
    if (mm) {                                    // feste Seitengröße in mm (Bild füllt die Seite)
      const W = mm[0] * 72 / 25.4, H = mm[1] * 72 / 25.4;
      doc.addPage([W, H]).drawImage(img, { x: 0, y: 0, width: W, height: H });
    } else if (fit === 'a4') {
      const land = img.width > img.height;
      const W = land ? 841.89 : 595.28, H = land ? 595.28 : 841.89;
      const s = Math.min((W - 2 * margin) / img.width, (H - 2 * margin) / img.height);
      const w = img.width * s, h = img.height * s;
      const pg = doc.addPage([W, H]);
      pg.drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
    } else {
      const pg = doc.addPage([img.width * 0.75, img.height * 0.75]);
      pg.drawImage(img, { x: 0, y: 0, width: img.width * 0.75, height: img.height * 0.75 });
    }
  }
  return doc.save();
}

export async function blankPdf() {
  const { PDFDocument } = L();
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  return doc.save();
}

// Bild normalisieren (HEIC/riesige Fotos -> JPEG, max. Kantenlänge)
export async function normalizeImage(file, max = 2200, filter = null) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    if (filter === 'doc') ctx.filter = 'grayscale(1) contrast(1.45) brightness(1.12)';
    else if (filter === 'color') ctx.filter = 'contrast(1.2) brightness(1.06) saturate(1.1)';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const isPng = file.type === 'image/png' && !filter;
    return { url: isPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.86), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}
