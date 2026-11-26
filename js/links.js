// ================= Links verwalten =================
// 1) Erkennen: Text jeder Seite (pdf.js) nach Webadressen (https://…, www.…, domain.de) und E-Mail-
//    Adressen durchsuchen, genaue Position aus den Textstücken berechnen.
// 2) Erstellen: echte klickbare /Link-Annotationen mit /URI-Aktion (pdf-lib) darüberlegen.
// 3) Entfernen: alle vorhandenen Link-Annotationen sowie Start-Aktionen (URI/JavaScript/Launch)
//    aus der PDF löschen – für Datenschutz & Sicherheit.
import { icon } from './icons.js';
import { toast, busy, sheet, esc, haptic } from './ui.js';
import { loadPdf, closePdf, pdfjsLib } from './pdfcore.js';

const L = () => window.PDFLib;
let ctx = {};
export function initLinks(c) { ctx = c; }

const TLD = 'de|com|net|org|eu|io|info|biz|shop|store|app|dev|at|ch|nl|fr|it|es|pl|uk|co|me|tv|online|site|website|digital|tech|cloud|email|gmbh|berlin|hamburg|koeln|bayern|nrw';
const RE = new RegExp(
  '([A-Z0-9._%+-]+@[A-Z0-9-]+(?:\\.[A-Z0-9-]+)*\\.[A-Z]{2,})'                                   // E-Mail
  + '|((?:https?:\\/\\/|www\\.)[^\\s<>"\'´`]+)'                                                   // https://… oder www.…
  + `|(\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLD})(?:\\/[^\\s<>"'´\`]*)?(?![a-z0-9.-]*@))`,   // domain.de/pfad
  'gi');

function cleanUrl(s) {
  // Satzzeichen am Ende abschneiden, Klammern nur wenn unpaarig
  let u = s.replace(/[.,;:!?»«"'„“”]+$/, '');
  while (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
  return u;
}
function toUri(kind, text) {
  if (kind === 'mail') return 'mailto:' + text;
  if (/^https?:\/\//i.test(text)) return text;
  return 'https://' + text;
}
const asciiUri = u => { try { return encodeURI(decodeURI(u)); } catch { return encodeURI(u); } };

/** Links auf einer Seite finden → [{ page, kind, text, uri, rect:[x0,y0,x1,y1] (PDF-Koordinaten) }] */
async function findOnPage(pdf, no) {
  const page = await pdf.getPage(no);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const { Util } = pdfjsLib;
  // Textstücke mit Bildschirm-Koordinaten (oben links)
  const items = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    const t = Util.transform(vp.transform, it.transform);
    if (Math.abs(t[1]) > Math.abs(t[0]) * 0.3) continue;
    const size = Math.hypot(t[2], t[3]) || 10;
    items.push({ str: it.str, x: t[4], y: t[5], w: it.width || it.str.length * size * 0.5, size });
  }
  // Zeilen (gleiche Grundlinie), je Zeile ein String mit Zeichen → Position
  items.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const it of items) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r.y - it.y) < Math.max(r.size, it.size) * 0.35) { r.items.push(it); r.size = Math.max(r.size, it.size); }
    else rows.push({ y: it.y, size: it.size, items: [it] });
  }
  const out = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    let s = ''; const pos = [];          // pos[i] = [x0, x1] des Zeichens
    let prev = null;
    for (const it of r.items) {
      if (prev && it.x - (prev.x + prev.w) > it.size * 0.2 && !/\s$/.test(s)) { s += ' '; pos.push([prev.x + prev.w, it.x]); }
      const cw = it.w / Math.max(1, it.str.length);
      for (let k = 0; k < it.str.length; k++) { s += it.str[k]; pos.push([it.x + cw * k, it.x + cw * (k + 1)]); }
      prev = it;
    }
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(s))) {
      const kind = m[1] ? 'mail' : 'web';
      const raw = m[0], text = kind === 'mail' ? raw : cleanUrl(raw);
      if (!text || text.length < 4) continue;
      if (kind === 'web' && !m[2] && /^\d+(\.\d+)+$/.test(text.split('/')[0])) continue;   // Zahlen wie 1.2.de
      const i0 = m.index, i1 = m.index + text.length - 1;
      const x0 = pos[i0][0], x1 = pos[i1][1];
      const top = r.y - r.size * 0.92, bot = r.y + r.size * 0.25;
      // Bildschirm → PDF-Koordinaten (berücksichtigt Seitendrehung)
      const p = [vp.convertToPdfPoint(x0, top), vp.convertToPdfPoint(x1, bot)];
      const rect = [Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.max(p[0][0], p[1][0]), Math.max(p[0][1], p[1][1])];
      out.push({ page: no - 1, kind, text, uri: toUri(kind, text), rect });
    }
  }
  // vorhandene Links (zum Abgleichen)
  let existing = [];
  try { existing = (await page.getAnnotations()).filter(a => a.subtype === 'Link'); } catch {}
  const overlaps = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
  for (const f of out) f.linked = existing.some(e => e.rect && overlaps(e.rect, f.rect));
  page.cleanup();
  return { found: out, existing: existing.length };
}

export async function scanLinks(pdf, onProgress) {
  const found = []; let existing = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i, pdf.numPages);
    try { const r = await findOnPage(pdf, i); found.push(...r.found); existing += r.existing; } catch (e) { console.warn(e); }
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }
  return { found, existing };
}

/** Link-Annotationen hinzufügen */
export async function addLinks(bytes, links) {
  const { PDFDocument, PDFName, PDFString, PDFArray } = L();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages(), ctx2 = doc.context;
  for (const l of links) {
    const page = pages[l.page]; if (!page) continue;
    const pad = 1;
    const annot = ctx2.obj({
      Type: 'Annot', Subtype: 'Link',
      Rect: [l.rect[0] - pad, l.rect[1] - pad, l.rect[2] + pad, l.rect[3] + pad],
      Border: [0, 0, 0], F: 4,
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(asciiUri(l.uri)) },
    });
    const ref = ctx2.register(annot);
    let arr = page.node.lookup(PDFName.of('Annots'));
    if (!(arr instanceof PDFArray)) { arr = ctx2.obj([]); page.node.set(PDFName.of('Annots'), arr); }
    arr.push(ref);
  }
  return doc.save();
}

/** Alle Links + gefährliche Start-Aktionen entfernen → { bytes, links, actions } */
export async function removeLinks(bytes) {
  const { PDFDocument, PDFName, PDFArray, PDFDict } = L();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let links = 0, actions = 0;
  for (const page of doc.getPages()) {
    const arr = page.node.lookup(PDFName.of('Annots'));
    if (arr instanceof PDFArray) {
      const keep = [];
      for (let k = 0; k < arr.size(); k++) {
        const ref = arr.get(k), a = doc.context.lookup(ref);
        if (a instanceof PDFDict && a.lookup(PDFName.of('Subtype'))?.toString() === '/Link') { links++; continue; }
        keep.push(ref);
      }
      if (keep.length) page.node.set(PDFName.of('Annots'), doc.context.obj(keep)); else page.node.delete(PDFName.of('Annots'));
    }
    if (page.node.get(PDFName.of('AA'))) { page.node.delete(PDFName.of('AA')); actions++; }
  }
  const cat = doc.catalog;
  const oa = cat.lookup(PDFName.of('OpenAction'));
  if (oa instanceof PDFDict) {
    const s = oa.lookup(PDFName.of('S'))?.toString();
    if (['/URI', '/JavaScript', '/Launch', '/SubmitForm', '/ImportData'].includes(s)) { cat.delete(PDFName.of('OpenAction')); actions++; }
  }
  if (cat.get(PDFName.of('AA'))) { cat.delete(PDFName.of('AA')); actions++; }
  const names = cat.lookup(PDFName.of('Names'));
  if (names instanceof PDFDict && names.get(PDFName.of('JavaScript'))) { names.delete(PDFName.of('JavaScript')); actions++; }
  return { bytes: await doc.save(), links, actions };
}

// ---------- Oberfläche ----------
export async function linksSheet(d) {
  if (!d) return;
  busy(true, 'PDF wird durchsucht …');
  let bytes, pdf, res;
  try {
    bytes = await ctx.docBytes(d);
    pdf = await loadPdf(bytes.slice ? bytes.slice(0) : bytes);
    res = await scanLinks(pdf, (i, n) => busy(true, `Seite ${i} von ${n} wird durchsucht …`));
  } catch (e) { console.error(e); busy(false); closePdf(pdf); return toast('PDF konnte nicht durchsucht werden', true); }
  closePdf(pdf); busy(false);
  const { found, existing } = res;
  const sel = new Set(found.map((f, i) => f.linked ? -1 : i).filter(i => i >= 0));
  let copy = false;
  sheet({
    title: 'Links verwalten',
    html: `
      <div class="lk-sum">
        <div><b>${found.length}</b><span>${found.length === 1 ? 'Adresse' : 'Adressen'} im Text gefunden</span></div>
        <div><b>${existing}</b><span>${existing === 1 ? 'Link' : 'Links'} bereits im PDF</span></div>
      </div>
      ${found.length ? `<div class="lk-head"><span>Klickbar machen</span><button class="link-btn" data-all></button></div>
      <div class="menu lk-list" data-list>${found.map((f, i) => `
        <button class="lk-row${sel.has(i) ? ' on' : ''}${f.linked ? ' done' : ''}" data-i="${i}">
          <span class="lk-ck">${icon('check')}</span>
          <span class="lk-ic ${f.kind}">${icon(f.kind === 'mail' ? 'mail' : 'globe')}</span>
          <span class="lk-main"><span class="lk-t">${esc(f.text)}</span><span class="lk-s">Seite ${f.page + 1}${f.linked ? ' · bereits verlinkt' : ''}</span></span>
        </button>`).join('')}</div>` : `<div class="empty" style="border:0;padding:20px 0">${icon('globe')}<b>Keine Webadressen gefunden</b>Gescannte Seiten zuerst mit „Text erkennen (OCR)“ durchsuchbar machen.</div>`}
      ${ctx.copyRow(false)}
      <div class="btn-row">${found.length ? `<button class="btn primary" data-add>${icon('link')} <span data-addl></span></button>` : ''}</div>
      <div class="btn-row" style="margin-top:8px"><button class="btn danger-soft" data-rm ${existing ? '' : 'disabled'}>${icon('linkOff')} Alle Links aus PDF entfernen</button></div>
      <p class="lk-note">Entfernen löscht alle vorhandenen Link-Flächen sowie automatisch startende Web-/Skript-Aktionen – nützlich, bevor du ein PDF weitergibst.</p>`,
    onMount(el, api) {
      ctx.bindCopy(el, () => copy, v => copy = v);
      const upd = () => {
        const n = sel.size;
        const add = el.querySelector('[data-add]');
        if (add) { add.disabled = !n; el.querySelector('[data-addl]').textContent = n ? `${n} ${n === 1 ? 'Link' : 'Links'} erstellen` : 'Keine Adresse gewählt'; }
        const all = el.querySelector('[data-all]');
        if (all) all.textContent = n === found.length ? 'Keine' : 'Alle';
      };
      el.querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
        const i = +b.dataset.i; sel.has(i) ? sel.delete(i) : sel.add(i); haptic();
        b.classList.toggle('on', sel.has(i)); upd();
      });
      el.querySelector('[data-all]')?.addEventListener('click', () => {
        const allOn = sel.size === found.length; sel.clear(); if (!allOn) found.forEach((_, i) => sel.add(i));
        el.querySelectorAll('[data-i]').forEach(b => b.classList.toggle('on', sel.has(+b.dataset.i))); haptic(); upd();
      });
      el.querySelector('[data-add]')?.addEventListener('click', async () => {
        const list = found.filter((_, i) => sel.has(i)); if (!list.length) return;
        api.close(); busy(true, 'Links werden erstellt …');
        try {
          const out = await addLinks(bytes, list);
          const id = await ctx.storeResult(d, out, 'mit Links', copy);
          busy(false); await ctx.renderRecents();
          toast(`${list.length} ${list.length === 1 ? 'Link' : 'Links'} erstellt`); ctx.openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Links konnten nicht erstellt werden', true); }
      });
      el.querySelector('[data-rm]').onclick = async () => {
        api.close(); busy(true, 'Links werden entfernt …');
        try {
          const r = await removeLinks(bytes);
          const id = await ctx.storeResult(d, r.bytes, 'ohne Links', copy);
          busy(false); await ctx.renderRecents();
          toast(`${r.links} ${r.links === 1 ? 'Link' : 'Links'} entfernt${r.actions ? ` · ${r.actions} Start-Aktion${r.actions === 1 ? '' : 'en'}` : ''}`); ctx.openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Links konnten nicht entfernt werden', true); }
      };
      upd();
    },
  });
}
