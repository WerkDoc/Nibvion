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
    await loadLib();
    let cur = 0;
    worker = await window.Tesseract.createWorker('deu', 1, {
      workerPath: BASE + 'worker.min.js',
      corePath: BASE + (simd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'),
      langPath: BASE.replace(/\/$/, ''),
      gzip: true,
      workerBlobURL: false,
      logger: m => { if (m.status === 'recognizing text' && cur) say(`Seite ${cur.k} von ${todo.length} wird erkannt …`, (cur.k - 1 + m.progress) / todo.length); },
    });
    await worker.setParameters({ preserve_interword_spaces: '1' });

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
