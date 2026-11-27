// ================= Dokument-Info & Qualitäts-Check (Preflight) =================
// Alles lokal: Seitenformate (mm + Normformat), Seitenzahl, PDF-Version, Metadaten, eingebettete
// Schriften (pdf-lib: /FontFile*), Formularfelder & Signaturen (pdf.js), Bildauflösung (DPI aus
// Bildgröße in Pixeln und dargestellter Größe über die Transformationsmatrix der Operatorliste).
import { icon } from './icons.js';
import { sheet, esc, fmtSize } from './ui.js';
import { pdfjsLib } from './pdfcore.js';

const L = () => window.PDFLib;
const MM = 25.4 / 72;
const LOW_DPI = 150, MIN_SIZE_MM = 20;

const FORMATS = [
  ['DIN A0', 841, 1189], ['DIN A1', 594, 841], ['DIN A2', 420, 594], ['DIN A3', 297, 420], ['DIN A4', 210, 297], ['DIN A5', 148, 210], ['DIN A6', 105, 148], ['DIN A7', 74, 105],
  ['DIN B4', 250, 353], ['DIN B5', 176, 250], ['DIN C5', 162, 229], ['DIN lang (DL)', 110, 220],
  ['US Letter', 215.9, 279.4], ['US Legal', 215.9, 355.6], ['Tabloid', 279.4, 431.8], ['Executive', 184.2, 266.7],
  ['Visitenkarte', 85, 55], ['Kreditkarte (ID-1)', 85.6, 53.98],
];
export function formatName(wmm, hmm) {
  const a = Math.min(wmm, hmm), b = Math.max(wmm, hmm);
  for (const [n, x, y] of FORMATS) {
    const fa = Math.min(x, y), fb = Math.max(x, y);
    if (Math.abs(a - fa) <= 2.5 && Math.abs(b - fb) <= 2.5) return `${n} ${Math.abs(wmm - hmm) < 1 ? '' : wmm < hmm ? 'hoch' : 'quer'}`.trim();
  }
  return Math.abs(wmm - hmm) < 1 ? 'Quadratisch' : 'Sonderformat';
}
const mm = v => Math.round(v * MM * 10) / 10;
const fmtMM = v => (Math.abs(v - Math.round(v)) < 0.15 ? Math.round(v) : v.toFixed(1)).toLocaleString('de-DE').replace('.', ',');
const ranges = list => {   // [1,2,3,5] → "1–3, 5"
  const out = []; let s = list[0], p = list[0];
  for (const n of list.slice(1).concat(Infinity)) { if (n === p + 1) { p = n; continue; } out.push(s === p ? `${s}` : `${s}–${p}`); s = p = n; }
  return out.join(', ');
};
const pdfDate = s => {
  const m = String(s || '').match(/D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/); if (!m) return '';
  return `${m[3] || '01'}.${m[2] || '01'}.${m[1]}${m[4] ? `, ${m[4]}:${m[5] || '00'}` : ''}`;
};

/** Schriften über pdf-lib (Seiten- und Form-XObject-Ressourcen) */
function fontsOf(bytesDoc) {
  const { PDFName, PDFDict, PDFArray, PDFStream } = L();
  const ctx = bytesDoc.context, seen = new Map(), visited = new Set();
  const scanRes = (res, page, depth) => {
    if (!(res instanceof PDFDict) || depth > 4) return;
    const fonts = res.lookup(PDFName.of('Font'));
    if (fonts instanceof PDFDict) for (const [, ref] of fonts.entries()) {
      const f = ctx.lookup(ref); if (!(f instanceof PDFDict)) continue;
      const key = ref.toString();
      let rec = seen.get(key);
      if (!rec) {
        const sub = (f.lookup(PDFName.of('Subtype'))?.toString() || '').slice(1);
        let base = (f.lookup(PDFName.of('BaseFont'))?.toString() || '').slice(1) || (sub === 'Type3' ? 'Type3-Schrift' : 'Unbenannt');
        let desc = f.lookup(PDFName.of('FontDescriptor'));
        if (sub === 'Type0') {
          const df = f.lookup(PDFName.of('DescendantFonts'));
          const d0 = df instanceof PDFArray ? ctx.lookup(df.get(0)) : null;
          if (d0 instanceof PDFDict) desc = d0.lookup(PDFName.of('FontDescriptor'));
        }
        const embedded = sub === 'Type3' || (desc instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some(k => desc.get(PDFName.of(k))));
        const subset = /^[A-Z]{6}\+/.test(base);
        const name = base.replace(/^[A-Z]{6}\+/, '').replace(/#20/g, ' ');
        rec = { name, type: { TrueType: 'TrueType', Type1: 'Type 1', Type0: 'CID/Type 0', Type3: 'Type 3', MMType1: 'Multiple Master' }[sub] || sub, embedded, subset, pages: new Set() };
        seen.set(key, rec);
      }
      rec.pages.add(page);
    }
    const xo = res.lookup(PDFName.of('XObject'));
    if (xo instanceof PDFDict) for (const [, ref] of xo.entries()) {
      const k = ref.toString(); if (visited.has(k)) continue; visited.add(k);
      const x = ctx.lookup(ref);
      if (x instanceof PDFStream && x.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Form') scanRes(x.dict.lookup(PDFName.of('Resources')), page, depth + 1);
    }
  };
  bytesDoc.getPages().forEach((p, i) => { try { scanRes(p.node.Resources(), i + 1, 0); } catch {} });
  // gleiche Schrift (Name + Einbettung) zusammenfassen
  const merged = new Map();
  for (const r of seen.values()) {
    const k = r.name + '|' + r.embedded;
    const m = merged.get(k); if (m) { r.pages.forEach(p => m.pages.add(p)); m.subset ||= r.subset; } else merged.set(k, { ...r, pages: new Set(r.pages) });
  }
  return [...merged.values()].sort((a, b) => a.embedded - b.embedded || a.name.localeCompare(b.name));
}

/** Bilder einer Seite mit effektiver Auflösung */
async function imagesOf(page, no) {
  const OPS = pdfjsLib.OPS, ops = await page.getOperatorList();
  const out = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k], args = ops.argsArray[k];
    if (fn === OPS.save) stack.push(m);
    else if (fn === OPS.restore) m = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(m); if (args?.[0]) m = mul(m, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) m = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      let w = args?.[1], h = args?.[2];
      if (fn === OPS.paintInlineImageXObject && args?.[0]) { w = args[0].width; h = args[0].height; }
      if (!w || !h) continue;
      const dw = Math.hypot(m[0], m[1]), dh = Math.hypot(m[2], m[3]);   // dargestellte Größe in pt
      if (dw < 1 || dh < 1) continue;
      const dpi = Math.round(Math.min(w / (dw / 72), h / (dh / 72)));
      out.push({ page: no, w, h, wmm: dw * MM, hmm: dh * MM, dpi });
    }
  }
  return out;
}

export async function analyze(pdf, bytes, onProgress) {
  const R = { pages: pdf.numPages, size: bytes?.byteLength || bytes?.length || 0, sizes: [], images: [], fonts: [], fields: [], textless: [] };
  // Metadaten
  try {
    const md = await pdf.getMetadata(); const i = md.info || {};
    Object.assign(R, { version: i.PDFFormatVersion, title: i.Title, author: i.Author, producer: i.Producer, creator: i.Creator, created: pdfDate(i.CreationDate), modified: pdfDate(i.ModDate),
      linearized: i.IsLinearized, acro: i.IsAcroFormPresent, xfa: i.IsXFAPresent, signed: i.IsSignaturesPresent, encrypted: !!i.EncryptFilterName });
  } catch {}
  if (!R.version && bytes) { const h = new TextDecoder().decode(new Uint8Array(bytes.buffer || bytes, 0, 16)); R.version = h.match(/%PDF-(\d\.\d)/)?.[1]; }
  try { R.outline = !!(await pdf.getOutline())?.length; } catch {}
  // Seiten: Größe, Text, Bilder
  const N = Math.min(pdf.numPages, 300);
  for (let i = 1; i <= N; i++) {
    onProgress?.(i, N);
    const p = await pdf.getPage(i);
    const v = p.getViewport({ scale: 1 });
    R.sizes.push({ page: i, w: mm(v.width), h: mm(v.height) });
    try { const tc = await p.getTextContent(); if (!tc.items.some(t => t.str?.trim())) R.textless.push(i); } catch {}
    try { R.images.push(...await imagesOf(p, i)); } catch (e) { console.warn(e); }
    p.cleanup();
    if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
  }
  R.partial = N < pdf.numPages;
  // Formularfelder & Signaturen
  try {
    const fo = await pdf.getFieldObjects();
    if (fo) for (const [name, arr] of Object.entries(fo)) { const f = arr[0]; R.fields.push({ name, type: f.type, value: f.value }); }
  } catch {}
  // Schriften
  if (bytes) {
    try {
      const doc = await L().PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      R.fonts = fontsOf(doc);
    } catch (e) { console.warn(e); }
  }
  return R;
}

// ---------- Darstellung ----------
export function preflightSheet(R, name, card = null) {
  // Seitenformate gruppieren
  const groups = [];
  for (const s of R.sizes) {
    const g = groups.find(x => Math.abs(x.w - s.w) < 0.6 && Math.abs(x.h - s.h) < 0.6);
    g ? g.pages.push(s.page) : groups.push({ w: s.w, h: s.h, pages: [s.page] });
  }
  const sigs = R.fields.filter(f => f.type === 'signature');
  const formFields = R.fields.filter(f => f.type !== 'signature');
  const filled = formFields.filter(f => f.value && f.value !== 'Off' && f.value !== '').length;
  const big = R.images.filter(im => Math.max(im.wmm, im.hmm) >= MIN_SIZE_MM);
  const low = big.filter(im => im.dpi < LOW_DPI).sort((a, b) => a.dpi - b.dpi);
  const STD14 = /^(Helvetica|Times|Courier|Symbol|ZapfDingbats|Arial|TimesNewRoman)(PS)?(MT)?([,-]?(Bold|Italic|Oblique|Roman|BoldItalic|BoldOblique))*$/i;
  R.fonts.forEach(f => f.std = !f.embedded && STD14.test(f.name.replace(/\s+/g, '')));
  const notEmb = R.fonts.filter(f => !f.embedded && !f.std), stdNot = R.fonts.filter(f => f.std);
  const issues = [];
  if (low.length) issues.push(['warn', `${low.length} ${low.length === 1 ? 'Bild liegt' : 'Bilder liegen'} unter ${LOW_DPI} DPI – kann beim Drucken unscharf werden`]);
  if (notEmb.length) issues.push(['warn', `${notEmb.length} ${notEmb.length === 1 ? 'Schrift ist' : 'Schriften sind'} nicht eingebettet – kann auf anderen Geräten anders aussehen`]);
  if (stdNot.length) issues.push(['info', `${stdNot.length} ${stdNot.length === 1 ? 'Standardschrift' : 'Standardschriften'} (z. B. ${esc(stdNot[0].name)}) nicht eingebettet – meist unkritisch, Druckereien verlangen aber oft eingebettete Schriften`]);
  if (groups.length > 1) issues.push(['info', `Gemischte Seitenformate (${groups.length} verschiedene)`]);
  if (R.textless.length && R.textless.length === R.sizes.length) issues.push(['info', 'Kein durchsuchbarer Text – „Text erkennen (OCR)“ macht ihn durchsuchbar']);
  else if (R.textless.length) issues.push(['info', `Seite ${ranges(R.textless)} ohne Text (Scan/Bild)`]);
  if (R.xfa) issues.push(['warn', 'XFA-Formular – wird nicht von allen Programmen unterstützt']);
  const ok = !issues.some(i => i[0] === 'warn');
  const dpiCls = d => d < LOW_DPI ? 'bad' : d < 220 ? 'mid' : 'good';
  const row = (k, v) => v ? `<div class="pf-kv"><span>${k}</span><b>${v}</b></div>` : '';

  sheet({
    title: 'Dokument-Info & Qualitäts-Check',
    html: `${card ? '<div class="share-card pf-card" data-card></div>' : ''}
      <div class="pf-score ${ok ? 'ok' : 'warn'}">
        <span class="pf-badge">${icon(ok ? 'check' : 'info')}</span>
        <div><b>${ok ? 'Druckbereit' : `${issues.filter(i => i[0] === 'warn').length} ${issues.filter(i => i[0] === 'warn').length === 1 ? 'Hinweis' : 'Hinweise'} zum Drucken`}</b>
          <small>${esc(name)}</small></div>
      </div>
      ${issues.length ? `<div class="pf-issues">${issues.map(([t, m]) => `<div class="pf-is ${t}">${icon(t === 'warn' ? 'info' : 'eye')}<span>${m}</span></div>`).join('')}</div>` : ''}

      <div class="pf-sec"><h3>${icon('file')} Seiten</h3>
        ${groups.map(g => `<div class="pf-size"><div class="pf-paper" style="aspect-ratio:${g.w}/${g.h}"></div><div><b>${fmtMM(g.w)} × ${fmtMM(g.h)} mm</b><span>${formatName(g.w, g.h)} · ${groups.length > 1 ? `Seite ${ranges(g.pages)}` : `${g.pages.length} ${g.pages.length === 1 ? 'Seite' : 'Seiten'}`}</span></div></div>`).join('')}
        ${R.partial ? `<p class="pf-note">Geprüft wurden die ersten ${R.sizes.length} von ${R.pages} Seiten.</p>` : ''}
      </div>

      <div class="pf-sec"><h3>${icon('info')} Datei</h3>
        ${row('Seitenzahl', R.pages)}${row('Dateigröße', fmtSize(R.size))}${row('PDF-Version', R.version ? 'PDF ' + R.version : '')}
        ${row('Titel', esc(R.title || ''))}${row('Autor', esc(R.author || ''))}${row('Erstellt mit', esc(R.creator || ''))}${row('PDF-Erzeuger', esc(R.producer || ''))}
        ${row('Erstellt', R.created)}${row('Geändert', R.modified)}
        ${row('Lesezeichen', R.outline ? 'vorhanden' : '')}${row('Für Web optimiert', R.linearized ? 'ja' : '')}${row('Verschlüsselt', R.encrypted ? 'ja' : '')}
      </div>

      <div class="pf-sec"><h3>${icon('text')} Schriftarten <span class="pf-cnt">${R.fonts.length}</span></h3>
        ${R.fonts.length ? R.fonts.map(f => `<div class="pf-font"><span class="pf-dot ${f.embedded ? 'good' : f.std ? 'mid' : 'bad'}"></span><div><b>${esc(f.name)}</b><span>${f.type}${f.embedded ? (f.subset ? ' · eingebettet (Teilmenge)' : ' · eingebettet') : f.std ? ' · Standardschrift, nicht eingebettet' : ' · <em>nicht eingebettet</em>'} · S. ${ranges([...f.pages].sort((a, b) => a - b))}</span></div></div>`).join('')
          : `<p class="pf-note">Keine Schriften – das Dokument besteht nur aus Bildern/Grafik.</p>`}
      </div>

      <div class="pf-sec"><h3>${icon('form')} Formular & Signaturen</h3>
        ${row('Formularfelder', formFields.length ? `${formFields.length} (${filled} ausgefüllt)` : 'keine')}
        ${row('Signaturfelder', sigs.length ? `${sigs.length}${R.signed ? ' · digital signiert' : ''}` : (R.signed ? 'digital signiert' : 'keine'))}
        ${sigs.length || R.signed ? `<p class="pf-note">Änderungen am PDF können eine digitale Signatur ungültig machen.</p>` : ''}
      </div>

      <div class="pf-sec"><h3>${icon('image')} Bildauflösung <span class="pf-cnt">${R.images.length}</span></h3>
        ${big.length ? `<div class="pf-legend"><span><i class="bad"></i>&lt; ${LOW_DPI} DPI</span><span><i class="mid"></i>${LOW_DPI}–220</span><span><i class="good"></i>≥ 220 DPI</span></div>
          ${(low.length ? low : big.slice().sort((a, b) => a.dpi - b.dpi)).slice(0, 30).map(im => `<div class="pf-img"><span class="pf-dpi ${dpiCls(im.dpi)}">${im.dpi}<small>DPI</small></span><div><b>Seite ${im.page}</b><span>${im.w} × ${im.h} px · dargestellt ${fmtMM(Math.round(im.wmm))} × ${fmtMM(Math.round(im.hmm))} mm</span></div></div>`).join('')}
          ${low.length && big.length > low.length ? `<p class="pf-note">${big.length - low.length} weitere ${big.length - low.length === 1 ? 'Bild ist' : 'Bilder sind'} scharf genug.</p>` : ''}
          ${!low.length ? `<p class="pf-note good">${icon('check')} Alle Bilder haben mindestens ${LOW_DPI} DPI.</p>` : ''}`
          : `<p class="pf-note">${R.images.length ? 'Nur kleine Bilder (Logos, Symbole) – unkritisch.' : 'Keine Bilder im Dokument.'}</p>`}
      </div>`,
    onMount(el) { if (card) card.mount(el.querySelector('[data-card]')); },
    onClose() { card?.unmount?.(); },
  });
}
