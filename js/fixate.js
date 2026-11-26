// ================= Fixieren / Flatten („Vertrags-Export“) =================
// 1) Formularfelder: form.flatten() (vorher Feld-Darstellungen aktualisieren)
// 2) Alle übrigen Anmerkungen mit Darstellung (/AP): Kommentare, Markierungen, Stempel,
//    Zeichnungen, Unterschriften anderer Apps … werden als Form-XObject fest in die Seite
//    gezeichnet und danach entfernt. Links bleiben klickbar, alles andere ist weg.
//    (Nibvion-Ebenen werden vorher vom Editor mit flatten() eingebrannt.)
// 3) Optional rastern: jede Seite hochauflösend als Bild-Seite → nichts mehr zerlegbar.
import { pdfjsLib, loadPdf, closePdf } from './pdfcore.js';

const L = () => window.PDFLib;

/** Zahlen zum Anzeigen: { fields, annots } */
export async function countEditable(pdf) {
  let fields = 0, annots = 0;
  try { const fo = await pdf.getFieldObjects(); if (fo) fields = Object.keys(fo).length; } catch {}
  const n = Math.min(pdf.numPages, 300);
  for (let i = 1; i <= n; i++) {
    try { const a = await (await pdf.getPage(i)).getAnnotations(); annots += a.filter(x => !['Link', 'Widget', 'Popup'].includes(x.subtype)).length; } catch {}
  }
  return { fields, annots };
}

const num = o => (o && typeof o.asNumber === 'function') ? o.asNumber() : (typeof o?.numberValue === 'number' ? o.numberValue : NaN);
const arr = (doc, o) => { const a = o instanceof L().PDFRef ? doc.context.lookup(o) : o; return a instanceof L().PDFArray ? a.asArray().map(x => num(doc.context.lookup(x) ?? x)) : null; };

/** Anmerkungen einer Seite einbrennen (auch Widgets, falls form.flatten scheitert) */
function burnAnnots(doc, page, { widgets }) {
  const { PDFName, PDFDict, PDFRef, PDFStream, PDFArray, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = L();
  const ctx = doc.context;
  const annotsObj = page.node.lookup(PDFName.of('Annots'));
  if (!(annotsObj instanceof PDFArray)) return 0;
  const keep = [], ops = [];
  let burned = 0;
  for (let k = 0; k < annotsObj.size(); k++) {
    const ref = annotsObj.get(k);
    const a = ctx.lookup(ref);
    if (!(a instanceof PDFDict)) continue;
    const sub = a.lookup(PDFName.of('Subtype'))?.toString?.() || '';
    if (sub === '/Link') { keep.push(ref); continue; }
    if (sub === '/Popup') continue;                                  // Kommentar-Fenster: weg
    if (sub === '/Widget' && !widgets) { keep.push(ref); continue; }
    const F = num(a.lookup(PDFName.of('F'))) | 0;
    if (F & 2 || F & 32) continue;                                   // versteckt / nicht anzeigen
    // Darstellung finden: /AP /N (bei Zuständen über /AS)
    const ap = a.lookup(PDFName.of('AP'));
    let n = ap instanceof PDFDict ? ap.get(PDFName.of('N')) : null;
    let nObj = n ? ctx.lookup(n) : null;
    if (nObj instanceof PDFDict && !(nObj instanceof PDFStream)) {
      const as = a.lookup(PDFName.of('AS'));
      n = as ? nObj.get(as) : null; nObj = n ? ctx.lookup(n) : null;
    }
    if (!(nObj instanceof PDFStream)) { if (sub === '/Widget' || sub === '/Text' || sub === '/FreeText') continue; keep.push(ref); continue; }
    const rect = arr(doc, a.get(PDFName.of('Rect')));
    const bbox = arr(doc, nObj.dict.get(PDFName.of('BBox'))) || rect;
    if (!rect || !bbox || rect.some(isNaN) || bbox.some(isNaN)) continue;
    const m = arr(doc, nObj.dict.get(PDFName.of('Matrix'))) || [1, 0, 0, 1, 0, 0];
    // BBox mit Matrix transformieren → Rechteck auf Rect abbilden (PDF 1.7, 12.5.5)
    const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const tx0 = Math.min(...pts.map(p => p[0])), tx1 = Math.max(...pts.map(p => p[0])), ty0 = Math.min(...pts.map(p => p[1])), ty1 = Math.max(...pts.map(p => p[1]));
    const rx0 = Math.min(rect[0], rect[2]), rx1 = Math.max(rect[0], rect[2]), ry0 = Math.min(rect[1], rect[3]), ry1 = Math.max(rect[1], rect[3]);
    if (tx1 - tx0 < 1e-6 || ty1 - ty0 < 1e-6) continue;
    const sx = (rx1 - rx0) / (tx1 - tx0), sy = (ry1 - ry0) / (ty1 - ty0);
    if (!nObj.dict.get(PDFName.of('Subtype'))) nObj.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    if (!nObj.dict.get(PDFName.of('Type'))) nObj.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
    const xref = n instanceof PDFRef ? n : ctx.register(nObj);
    const name = page.node.newXObject('NibFlat', xref);
    ops.push(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy), drawObject(name), popGraphicsState());
    burned++;
  }
  if (ops.length) page.pushOperators(...ops);
  if (keep.length) page.node.set(PDFName.of('Annots'), ctx.obj(keep)); else page.node.delete(PDFName.of('Annots'));
  return burned;
}

/**
 * bytes (Nibvion-Ebenen bereits eingebrannt) → fixiertes PDF
 * opts: { raster: false, dpi: 200, title, onProgress(text) }
 */
export async function fixatePdf(bytes, { raster = false, dpi = 200, title = '', onProgress } = {}) {
  const { PDFDocument, PDFName, StandardFonts } = L();
  onProgress?.('Formularfelder werden fixiert …');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let formOk = true, fields = 0;
  try {
    const form = doc.getForm(); fields = form.getFields().length;
    if (fields) {
      try { form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica)); } catch (e) { console.warn(e); }
      form.flatten({ updateFieldAppearances: false });
    }
  } catch (e) { console.warn('form.flatten', e); formOk = false; }
  onProgress?.('Kommentare & Ebenen werden eingebrannt …');
  let burned = 0;
  for (const p of doc.getPages()) { try { burned += burnAnnots(doc, p, { widgets: true }); } catch (e) { console.warn(e); } }
  // Formular-Reste entfernen, damit kein Viewer mehr Felder anbietet
  try { doc.catalog.delete(PDFName.of('AcroForm')); } catch {}
  try { doc.setProducer('Nibvion'); doc.setModificationDate(new Date()); if (title) doc.setTitle(title); } catch {}
  let out = await doc.save();
  if (!raster) return { bytes: out, fields, burned, formOk };

  // ---------- Rastern ----------
  const pdf = await loadPdf(out.slice(0));
  try {
    const res = await PDFDocument.create();
    const scale = dpi / 72;
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(`Seite ${i} von ${pdf.numPages} wird gerastert …`);
      const page = await pdf.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      let s = scale;
      if (v1.width * v1.height * s * s > 16e6) s = Math.sqrt(16e6 / (v1.width * v1.height));   // iOS-Canvas-Grenze
      const vp = page.getViewport({ scale: s });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      c.width = c.height = 0; page.cleanup();
      const img = await res.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      const pg = res.addPage([v1.width, v1.height]);
      pg.drawImage(img, { x: 0, y: 0, width: v1.width, height: v1.height });
      await new Promise(r => setTimeout(r, 0));
    }
    res.setProducer('Nibvion'); res.setCreator('Nibvion – gerastert'); if (title) res.setTitle(title);
    out = await res.save();
  } finally { closePdf(pdf); }
  return { bytes: out, fields, burned, formOk, raster: true };
}
