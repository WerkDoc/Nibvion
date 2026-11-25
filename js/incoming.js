// ================= Dateien von außen empfangen =================
// 1) Web Share Target: „Teilen → Nibvion“ (sw.js legt die Dateien im Cache „nibvion-share“ ab
//    und leitet auf ?shared=… weiter)
// 2) File Handling API: „Öffnen mit → Nibvion“ (launchQueue, Desktop-Chrome/Edge)
// Danach: PDFs importieren & öffnen, Word/Excel umwandeln, Bilder als PDF oder Scan.
import { icon } from './icons.js';
import { toast, busy, sheet, esc, closeAllSheets } from './ui.js';

const SHARE = 'nibvion-share';
let ctx = {};

const ext = n => (String(n).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
export function kindOf(f) {
  const t = (f.type || '').toLowerCase(), e = ext(f.name);
  if (t === 'application/pdf' || e === 'pdf') return 'pdf';
  if (t.startsWith('image/') || ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tif', 'tiff'].includes(e)) return 'image';
  if (['docx', 'doc'].includes(e) || /wordprocessingml|msword/.test(t)) return 'word';
  if (['xlsx', 'xlsm', 'xls', 'ods', 'csv'].includes(e) || /spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv/.test(t)) return 'excel';
  if (['pptx', 'ppt'].includes(e) || /presentationml|powerpoint/.test(t)) return 'ppt';
  return 'other';
}

export function initIncoming(c) {
  ctx = c;
  // „Öffnen mit“ (auch wenn die App schon läuft – launch_handler: focus-existing)
  if ('launchQueue' in window) {
    try {
      window.launchQueue.setConsumer(async params => {
        if (!params?.files?.length) return;
        const files = [];
        for (const h of params.files) { try { files.push(await h.getFile()); } catch (e) { console.warn(e); } }
        if (files.length) handleFiles(files);
      });
    } catch (e) { console.warn(e); }
  }
  // Geteilte Dateien abholen
  const q = new URLSearchParams(location.search);
  if (q.has('shared')) {
    const v = q.get('shared');
    history.replaceState(null, '', location.pathname);
    if (v === 'error') toast('Geteilte Datei konnte nicht empfangen werden', true);
    else takeShared();
  }
}

async function takeShared() {
  if (!('caches' in window)) return;
  let c;
  try { c = await caches.open(SHARE); } catch { return; }
  const files = []; let meta = {};
  for (const req of await c.keys()) {
    try {
      const res = await c.match(req);
      if (req.url.endsWith('/__share/meta')) { meta = await res.json(); continue; }
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-Name') || 'Datei');
      files.push({ i: +req.url.split('/').pop(), file: new File([blob], name, { type: blob.type || res.headers.get('Content-Type') || '' }) });
    } catch (e) { console.warn(e); }
  }
  try { await caches.delete(SHARE); } catch {}
  files.sort((a, b) => a.i - b.i);
  if (files.length) return handleFiles(files.map(x => x.file));
  // Nur Link/Text geteilt (z. B. aus Safari) – eine PDF-Adresse direkt laden
  const link = meta.url || (String(meta.text || '').match(/https?:\/\/\S+/) || [])[0];
  if (link && /\.pdf(\?|#|$)/i.test(link)) return fetchPdf(link, meta.title);
  if (meta.count === 0 || link || meta.text) toast('Nibvion kann nur Dateien empfangen (PDF, Bilder, Word, Excel)', true);
}

async function fetchPdf(link, title) {
  busy(true, 'PDF wird geladen …');
  try {
    const r = await fetch(link, { mode: 'cors' });
    if (!r.ok) throw new Error(r.status);
    const blob = await r.blob();
    const name = (title || decodeURIComponent(new URL(link).pathname.split('/').pop() || 'Dokument')).replace(/[\\/:*?"<>|]/g, ' ');
    busy(false);
    return handleFiles([new File([blob], /\.pdf$/i.test(name) ? name : name + '.pdf', { type: 'application/pdf' })]);
  } catch (e) {
    console.warn(e); busy(false);
    toast('Die Webseite erlaubt das Laden nicht – bitte die PDF teilen statt des Links', true);
  }
}

/** Eingehende Dateien verarbeiten (auch nutzbar für Drag & Drop) */
export async function handleFiles(files) {
  closeAllSheets();
  ctx.closeEditor && await ctx.closeEditor();
  const g = { pdf: [], image: [], word: [], excel: [], ppt: [], other: [] };
  for (const f of files) g[kindOf(f)].push(f);
  if (g.ppt.length) toast('PowerPoint → PDF kommt in einem der nächsten Updates');
  else if (g.other.length && files.length === g.other.length) return toast(`„${g.other[0].name}“ wird nicht unterstützt`, true);

  // 1) PDFs importieren
  let first = null, fails = 0, n = 0;
  if (g.pdf.length) {
    busy(true, g.pdf.length > 1 ? `${g.pdf.length} PDFs werden importiert …` : 'PDF wird importiert …');
    for (const f of g.pdf) {
      try { const id = await ctx.importFile(f); if (id) { first ??= id; n++; } } catch (e) { console.warn(e); fails++; }
      busy(true, 'PDF wird importiert …');
    }
    busy(false);
    await ctx.renderRecents();
    if (fails) toast(fails === g.pdf.length ? 'PDF konnte nicht gelesen werden' : `${fails} Datei(en) übersprungen`, true);
  }
  const rest = [g.word.length && 'word', g.excel.length && 'excel', g.image.length && 'image'].filter(Boolean);
  if (first && !rest.length) {
    if (n > 1) toast(`${n} PDFs importiert`);
    return ctx.openDoc(first);
  }
  if (n) toast(n > 1 ? `${n} PDFs importiert` : 'PDF importiert');

  // 2) Word / Excel → PDF (je Datei nacheinander)
  for (const f of g.word) await ctx.officeToPdf('word', [f]);
  for (const f of g.excel) await ctx.officeToPdf('excel', [f]);

  // 3) Bilder: als PDF zusammenfassen oder wie einen Scan behandeln
  if (g.image.length) imageChoice(g.image);
}

function imageChoice(imgs) {
  const n = imgs.length;
  sheet({
    title: n > 1 ? `${n} Bilder empfangen` : 'Bild empfangen',
    html: `<p style="color:var(--text2);margin:0 2px 12px;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(imgs.map(f => f.name).join(', '))}</p>
      <div class="menu">
        <button class="row" data-k="images"><span class="row-ic c-blue">${icon('images')}</span><span class="row-main"><span class="row-title">Als PDF speichern</span><span class="row-sub">${n > 1 ? 'Alle Bilder in eine PDF' : 'Bild unverändert als PDF'}</span></span>${icon('chevronRight')}</button>
        <button class="row" data-k="imgscan"><span class="row-ic c-teal">${icon('fit')}</span><span class="row-main"><span class="row-title">Als Scan</span><span class="row-sub">Ränder erkennen, gerade ziehen, verbessern</span></span>${icon('chevronRight')}</button>
      </div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { api.close(); ctx.imageFiles(b.dataset.k, imgs); });
    },
  });
}
