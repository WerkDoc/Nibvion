// pdf.js (Anzeige) + pdf-lib (Schreiben)
import * as pdfjsLib from '../lib/pdf.min.js';
import { dataUrlToBytes, loadImage } from './ui.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.js', import.meta.url).href;
export { pdfjsLib };

const L = () => window.PDFLib;

export function loadPdf(bytes) {
  return pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false, useSystemFonts: true }).promise;
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
  return c.toDataURL('image/jpeg', 0.78);
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

export function inkPath(pts) {
  if (!pts.length) return '';
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

// Objekte dauerhaft ins PDF schreiben
export async function flatten(bytes, objects, infos) {
  const { PDFDocument, StandardFonts, degrees, BlendMode, LineCapStyle } = L();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const fonts = {};
  const font = async bold => fonts[bold ? 1 : 0] ??= await doc.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
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

    if (o.type === 'text') {
      if (o.cover) rect(o.cover.x, o.cover.y, o.cover.w, o.cover.h, { color: hexToRgb(o.cover.color) });
      if (o.bg) rect(o.x - 4, o.y - 3, o.w + 8, o.h + 6, { color: hexToRgb(o.bg), borderColor: hexToRgb('#e3c34a'), borderWidth: 0.6 });
      const f = await font(o.bold);
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
    } else if (o.type === 'ink') {
      const origin = M(0, 0);
      page.drawSvgPath(inkPath(o.points), {
        x: origin.x, y: origin.y, rotate: R,
        borderColor: hexToRgb(o.color), borderWidth: o.width, borderOpacity: o.opacity ?? 1,
        borderLineCap: LineCapStyle.Round, blendMode: (o.opacity ?? 1) < 1 ? BlendMode.Multiply : undefined,
      });
    }
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
