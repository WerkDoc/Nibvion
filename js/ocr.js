// ================= Texterkennung (OCR) =================
// Gescannte Seiten (ohne Text) werden mit Tesseract (lokal, lib/tesseract/) erkannt.
// Der erkannte Text kommt als unsichtbare Textebene genau über die Wörter –
// die Seite sieht gleich aus, ist aber durchsuchbar, markierbar und kopierbar.
import { pdfjsLib } from './pdfcore.js';

const BASE = new URL('../lib/tesseract/', import.meta.url).href;
const MIN_CHARS = 40;          // Seiten mit weniger Text gelten als „gescannt“
const LONG_SIDE = 2600;        // Render-Größe für die Erkennung (~220 dpi bei A4)

let libP;
function loadLib() {
  return libP ??= new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = document.createElement('script');
    s.src = BASE + 'tesseract.min.js';
    s.onload = () => res();
    s.onerror = () => { libP = null; s.remove(); rej(new Error('Texterkennung konnte nicht geladen werden')); };
    document.head.appendChild(s);
  });
}

// WebAssembly-SIMD vorhanden? (iPhone ab iOS 16.4) → schnellere Variante
function simd() {
  try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); }
  catch { return false; }
}

const tick = () => new Promise(r => setTimeout(r, 0));

async function makeWorker(logger) {
  await loadLib();
  const w = await window.Tesseract.createWorker('deu', 1, {
    workerPath: BASE + 'worker.min.js',
    corePath: BASE + (simd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'),
    langPath: BASE.replace(/\/$/, ''),
    gzip: true,
    workerBlobURL: false,
    logger,
  });
  await w.setParameters({ preserve_interword_spaces: '1' });
  return w;
}

// Erkannten Text in lesbare Absätze bringen (Zeilen zusammenfügen, Silbentrennung auflösen)
function blocksToText(data) {
  const paras = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) {
    let t = '';
    for (const l of p.lines || []) {
      const lt = (l.words || []).filter(w => w.text && w.confidence >= 20).map(w => w.text).join(' ').trim();
      if (!lt) continue;
      if (!t) t = lt;
      else if (/[A-Za-zÄÖÜäöüß]-$/.test(t)) t = t.slice(0, -1) + lt;
      else t += ' ' + lt;
    }
    if (t) paras.push(t.replace(/ {2,}/g, ' '));
  }
  return paras.join('\n\n') || (data.text || '').trim();
}

const okChar = new Map();
function safeText(font, s) {
  let o = '';
  for (const ch of s) {
    let ok = okChar.get(ch);
    if (ok === undefined) { try { font.encodeText(ch); font.widthOfTextAtSize(ch, 10); ok = true; } catch { ok = false; } okChar.set(ch, ok); }
    if (ok) o += ch;
    else if (/[‐‑‒−]/.test(ch)) o += '-';
    else if (/[„“”«»]/.test(ch)) o += '"';
  }
  return o;
}

// Welche Seiten brauchen OCR?
async function scannedPages(pdf) {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    const n = tc.items.reduce((s, it) => s + (it.str ? it.str.replace(/\s/g, '').length : 0), 0);
    if (n < MIN_CHARS) out.push(i);
  }
  return out;
}

export async function needsOcr(bytes) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
  try { return (await scannedPages(pdf)).length; } finally { pdf.loadingTask.destroy(); }
}

/**
 * Erkennt Text auf allen gescannten Seiten und gibt die neue PDF zurück.
 * onProgress(text, anteil 0..1)
 */
export async function ocrPdf(bytes, { onProgress, force = false } = {}) {
  const say = (t, f) => onProgress && onProgress(t, f);
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
  let worker;
  try {
    const todo = force ? [...Array(pdf.numPages)].map((_, i) => i + 1) : await scannedPages(pdf);
    if (!todo.length) return { bytes: null, pages: 0, words: 0 };

    say('Texterkennung wird geladen …', 0);
    let cur = 0;
    worker = await makeWorker(m => { if (m.status === 'recognizing text' && cur) say(`Seite ${cur.k} von ${todo.length} wird erkannt …`, (cur.k - 1 + m.progress) / todo.length); });

    const L = window.PDFLib;
    const doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const font = await doc.embedFont(L.StandardFonts.Helvetica);
    let words = 0;

    for (let k = 0; k < todo.length; k++) {
      const no = todo[k];
      cur = { k: k + 1 };
      say(`Seite ${k + 1} von ${todo.length} wird erkannt …`, k / todo.length);
      await tick();
      const page = await pdf.getPage(no);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(LONG_SIDE / Math.max(base.width, base.height), 4);
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const { data } = await worker.recognize(c, {}, { blocks: true, text: false });
      c.width = c.height = 0;
      page.cleanup();

      // Unsichtbare Textebene schreiben
      const pp = doc.getPage(no - 1);
      const fkey = pp.node.newFontDictionary(font.name, font.ref);
      const ops = [];
      for (const b of data.blocks || []) for (const par of b.paragraphs || []) for (const line of par.lines || []) {
        const rowH = line.rowAttributes?.rowHeight || (line.bbox.y1 - line.bbox.y0) * 0.8;
        const bl = line.baseline || { x0: line.bbox.x0, y0: line.bbox.y1, x1: line.bbox.x1, y1: line.bbox.y1 };
        const slope = bl.x1 !== bl.x0 ? (bl.y1 - bl.y0) / (bl.x1 - bl.x0) : 0;
        const ws = (line.words || []).filter(w => w.text && w.text.trim() && w.confidence >= 25);
        ws.forEach((w, wi) => {
          const t = safeText(font, w.text.trim());
          if (!t) return;
          const yb = bl.y0 + slope * (w.bbox.x0 - bl.x0);           // Grundlinie unter dem Wort (Pixel)
          const p0 = vp.convertToPdfPoint(w.bbox.x0, yb);
          const p1 = vp.convertToPdfPoint(w.bbox.x1, yb + slope * (w.bbox.x1 - w.bbox.x0));
          const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
          const len = Math.hypot(dx, dy);
          if (len < 0.5) return;
          const size = Math.max(2, (rowH * 1.08) / scale);
          const nat = font.widthOfTextAtSize(t, size);
          if (!nat) return;
          const sq = Math.min(400, Math.max(20, (len / nat) * 100));
          const cos = dx / len, sin = dy / len;
          const txt = wi < ws.length - 1 ? t + ' ' : t;
          ops.push(L.setCharacterSqueeze(sq), L.setFontAndSize(fkey, size), L.setTextMatrix(cos, sin, -sin, cos, p0[0], p0[1]), L.showText(font.encodeText(txt)));
          words++;
        });
      }
      if (ops.length) pp.pushOperators(L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible), ...ops, L.endText(), L.popGraphicsState());
    }
    say('PDF wird gespeichert …', 1);
    const out = await doc.save();
    return { bytes: out, pages: todo.length, words };
  } finally {
    try { worker && await worker.terminate(); } catch {}
    try { pdf.loadingTask.destroy(); } catch {}
  }
}

/**
 * Text aus Bildern (Canvas) erkennen – für „Text extrahieren“ beim Scannen.
 * Gibt je Seite den Text zurück.
 */
export async function recognizeCanvases(canvases, { onProgress } = {}) {
  const say = (t, f) => onProgress && onProgress(t, f);
  let cur = 0;
  say('Texterkennung wird geladen …', 0);
  const worker = await makeWorker(m => { if (m.status === 'recognizing text' && cur) say(`Seite ${cur} von ${canvases.length} wird gelesen …`, (cur - 1 + m.progress) / canvases.length); });
  try {
    const out = [];
    for (let i = 0; i < canvases.length; i++) {
      cur = i + 1;
      say(`Seite ${cur} von ${canvases.length} wird gelesen …`, i / canvases.length);
      await tick();
      const c = typeof canvases[i] === 'function' ? await canvases[i]() : canvases[i];
      const { data } = await worker.recognize(c, {}, { blocks: true, text: true });
      out.push(blocksToText(data));
    }
    return out;
  } finally { try { await worker.terminate(); } catch {} }
}

/**
 * Wörter mit Position (für Ausweise: Text antippen, Felder ausfüllen).
 * Je Bild: { words: [{ t, b: [x0, y0, x1, y1] normiert }], lines: [Text …] }
 */
export async function recognizeWords(canvases, { onProgress } = {}) {
  const worker = await makeWorker(m => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); });
  try {
    const out = [];
    for (const c of canvases) {
      await tick();
      const { data } = await worker.recognize(c, {}, { blocks: true, text: true });
      const words = [], lines = [];
      for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
        lines.push((l.text || '').trim());
        for (const w of l.words || []) {
          const t = (w.text || '').trim(); if (!t || w.confidence < 35) continue;
          words.push({ t, b: [w.bbox.x0 / c.width, w.bbox.y0 / c.height, w.bbox.x1 / c.width, w.bbox.y1 / c.height] });
        }
      }
      out.push({ words, lines });
    }
    return out;
  } finally { try { await worker.terminate(); } catch {} }
}

/**
 * Text einer PDF: Seiten mit Textebene direkt, gescannte Seiten per Texterkennung.
 */
export async function extractPdfText(bytes, { onProgress } = {}) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
  try {
    const texts = [], needs = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      let t = '', chars = 0;
      for (const it of tc.items) { if (it.str) { t += it.str; chars += it.str.replace(/\s/g, '').length; } t += it.hasEOL ? '\n' : (it.str && !it.str.endsWith(' ') ? ' ' : ''); }
      texts.push(t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
      if (chars < MIN_CHARS) needs.push(i);
    }
    if (needs.length) {
      const render = no => async () => {
        const page = await pdf.getPage(no);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(LONG_SIDE / Math.max(base.width, base.height), 4) });
        const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        return c;
      };
      const res = await recognizeCanvases(needs.map(render), { onProgress });
      needs.forEach((no, k) => { texts[no - 1] = res[k]; });
    }
    return texts;
  } finally { try { pdf.loadingTask.destroy(); } catch {} }
}

/**
 * Wie recognizeCanvases, liefert aber die Struktur (Blöcke → Absätze → Zeilen → Wörter mit Position)
 * und das gelesene Bild – für Scan → Word/Excel.
 */
export async function recognizeLayout(canvases, { onProgress, prepare } = {}) {
  const say = (t, f) => onProgress && onProgress(t, f);
  let cur = 0;
  say('Texterkennung wird geladen …', 0);
  const worker = await makeWorker(m => { if (m.status === 'recognizing text' && cur) say(`Seite ${cur} von ${canvases.length} wird gelesen …`, (cur - 1 + m.progress) / canvases.length); });
  try {
    const out = [];
    for (let i = 0; i < canvases.length; i++) {
      cur = i + 1;
      say(`Seite ${cur} von ${canvases.length} wird gelesen …`, i / canvases.length);
      await tick();
      const c = typeof canvases[i] === 'function' ? await canvases[i]() : canvases[i];
      const prep = prepare ? prepare(c) : null;
      const { data } = await worker.recognize(prep ? prep.ocrCanvas : c, {}, { blocks: true, text: false });
      if (prep) prep.ocrCanvas.width = prep.ocrCanvas.height = 0;
      out.push({ canvas: c, prep, blocks: data.blocks || [] });
    }
    return out;
  } finally { try { await worker.terminate(); } catch {} }
}

// ================= Text ändern auf gescannten Seiten =================
// Für „Text ändern“ im Editor: Seite lesen und in bearbeitbare Textstücke zerlegen
// (eine Zeile, an großen Lücken getrennt – so wird jede Tabellenzelle ein eigenes Stück).
let edWorkerP = null, edIdle = null;
function edWorker() {
  clearTimeout(edIdle);
  edWorkerP ??= makeWorker(() => {});
  edWorkerP.catch(() => { edWorkerP = null; });
  return edWorkerP;
}
export function releaseEditOcr() {
  clearTimeout(edIdle);
  const p = edWorkerP; edWorkerP = null;
  p?.then(w => w.terminate()).catch(() => {});
}

/**
 * canvas: gerenderte Seite, s: Canvas-Pixel je PDF-Einheit.
 * Gibt Textstücke im Format des Editors zurück (x, top, w, h, base, size, str, bold).
 */
export async function ocrEditItems(canvas, s, keyPrefix, ocrCanvas) {
  const w = await edWorker();
  const { data } = await w.recognize(ocrCanvas || canvas, {}, { blocks: true, text: false });
  edIdle = setTimeout(releaseEditOcr, 90000);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const items = [];
  for (const b of data.blocks || []) for (const par of b.paragraphs || []) for (const line of par.lines || []) {
    const ws = (line.words || []).filter(x => x.text && x.text.trim() && x.confidence >= 30);
    if (!ws.length) continue;
    const rowH = line.rowAttributes?.rowHeight || (line.bbox.y1 - line.bbox.y0) * 0.8;
    const bl = line.baseline || { x0: line.bbox.x0, y0: line.bbox.y1, x1: line.bbox.x1, y1: line.bbox.y1 };
    let slope = bl.x1 !== bl.x0 ? (bl.y1 - bl.y0) / (bl.x1 - bl.x0) : 0;
    if (Math.abs(slope) > 0.06) {
      if (ws.length > 3) continue;                              // wirklich schräge Zeile – nicht bearbeitbar
      slope = 0;                                                // kurze Stücke: Grundlinien-Schätzung unzuverlässig
    }
    // an großen Lücken trennen
    const segs = [[ws[0]]];
    for (let k = 1; k < ws.length; k++) {
      const gap = ws[k].bbox.x0 - ws[k - 1].bbox.x1;
      if (gap > rowH * 1.6) segs.push([ws[k]]); else segs[segs.length - 1].push(ws[k]);
    }
    for (const sg of segs) {
      const str = sg.map(x => x.text.trim()).join(' ');
      if (!/[\p{L}\p{N}]/u.test(str)) continue;
      const x0 = Math.min(...sg.map(x => x.bbox.x0)), x1 = Math.max(...sg.map(x => x.bbox.x1));
      const y0 = Math.min(...sg.map(x => x.bbox.y0)), y1 = Math.max(...sg.map(x => x.bbox.y1));
      const yb = bl.y0 + slope * ((x0 + x1) / 2 - bl.x0);
      const size = Math.max(4, rowH * 1.08);
      items.push({
        key: `${keyPrefix}${items.length}`, str, ocr: true,
        x: x0 / s, w: (x1 - x0) / s, top: y0 / s, h: (y1 - y0) / s, base: yb / s, size: size / s,
        bold: isBold(ctx, x0, y0, x1, y1, size),
      });
    }
  }
  // Tesseract trennt eine Zeile manchmal in zwei „Zeilen“ – Stücke auf gleicher Grundlinie mit kleiner Lücke zusammenfügen
  items.sort((p, q) => p.base - q.base || p.x - q.x);
  const out = [];
  for (const it of items) {
    const prev = out.find(o => Math.abs(o.base - it.base) < Math.min(o.size, it.size) * 0.3 && o.bold === it.bold
      && Math.abs(o.size - it.size) < Math.max(o.size, it.size) * 0.3
      && it.x - (o.x + o.w) > -o.size * 0.3 && it.x - (o.x + o.w) < Math.max(o.size, it.size) * 1.2);
    if (prev) {
      const r = Math.max(prev.x + prev.w, it.x + it.w), b2 = Math.max(prev.top + prev.h, it.top + it.h);
      prev.str += ' ' + it.str; prev.top = Math.min(prev.top, it.top); prev.w = r - prev.x; prev.h = b2 - prev.top;
      prev.size = Math.max(prev.size, it.size);
    } else out.push(it);
  }
  out.forEach((it, k) => { it.key = `${keyPrefix}${k}`; });
  return out;
}

// Fett? Mittlere Strichstärke (Median der waagrechten Tinten-Läufe) im Verhältnis zur Schriftgröße
function isBold(ctx, x0, y0, x1, y1, size) {
  try {
    const W = Math.max(1, Math.round(x1 - x0)), H = Math.max(1, Math.round(y1 - y0));
    const d = ctx.getImageData(Math.round(x0), Math.round(y0), W, H).data;
    let mn = 255, mx = 0;
    for (let i = 0; i < d.length; i += 4) { const v = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx - mn < 60) return false;
    const thr = (mn + mx) / 2, runs = [];
    for (let y = 0; y < H; y += 2) {
      let r = 0;
      for (let x = 0; x <= W; x++) {
        const o = (y * W + x) * 4, dark = x < W && d[o] * 0.3 + d[o + 1] * 0.59 + d[o + 2] * 0.11 < thr;
        if (dark) r++; else if (r) { runs.push(r); r = 0; }
      }
    }
    if (runs.length < 6) return false;
    runs.sort((a, b) => a - b);
    return runs[runs.length >> 1] / size > 0.12;
  } catch { return false; }
}
