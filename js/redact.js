// ================= Schwärzen: Inhalte endgültig entfernen =================
// Bereiche werden auf der Seite aufgezogen oder per Suche gefunden. Beim Anwenden wird jede
// betroffene Seite neu als Bild aufgebaut (Text, Vektoren, Bilder, Formularfelder und Notizen
// darunter sind danach wirklich weg – nicht nur abgedeckt). Seiten ohne Schwärzung bleiben unverändert.
import { icon } from './icons.js';
import { toast, busy, sheet, esc, haptic, confirmDlg } from './ui.js';
import { loadPdf, closePdf, pdfjsLib } from './pdfcore.js';

const L = () => window.PDFLib;

// Schnellsuche nach typischen persönlichen Daten
export const PATTERNS = [
  { id: 'mail', label: 'E-Mails', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { id: 'tel', label: 'Telefon', re: /(?:\+|00)?\d[\d /()-]{6,}\d/g },
  { id: 'iban', label: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  { id: 'date', label: 'Datum', re: /\b\d{1,2}\.\s?\d{1,2}\.\s?(?:\d{4}|\d{2})\b/g },
];

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Fundstellen als normierte Rechtecke {page, x, y, w, h} (0..1 bezogen auf die Seite, oben links)
export async function findBoxes(pdf, re) {
  const out = [];
  const mc = document.createElement('canvas').getContext('2d');
  mc.font = '100px sans-serif';
  const mw = s => mc.measureText(s).width;
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    const tc = await p.getTextContent();
    for (const it of tc.items) {
      const str = it.str;
      if (!str || !str.trim()) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(str))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
        const fh = Math.hypot(tx[2], tx[3]) || 10;
        const ang = Math.atan2(tx[1], tx[0]);
        const W = (it.width || mw(str) / 100 * fh) * vp.scale;
        const total = mw(str) || 1;
        const f0 = mw(str.slice(0, m.index)) / total, f1 = mw(str.slice(0, m.index + m[0].length)) / total;
        const ux = Math.cos(ang), uy = Math.sin(ang), upx = uy, upy = -ux;
        const pts = [];
        for (const f of [f0, f1]) for (const v of [0.92, -0.26]) {
          pts.push([tx[4] + ux * W * f + upx * fh * v, tx[5] + uy * W * f + upy * fh * v]);
        }
        const pad = 1.2;
        const x0 = Math.min(...pts.map(q => q[0])) - pad, x1 = Math.max(...pts.map(q => q[0])) + pad;
        const y0 = Math.min(...pts.map(q => q[1])) - pad, y1 = Math.max(...pts.map(q => q[1])) + pad;
        out.push({ page: i - 1, x: x0 / vp.width, y: y0 / vp.height, w: (x1 - x0) / vp.width, h: (y1 - y0) / vp.height, auto: true });
      }
    }
    p.cleanup();
  }
  return out;
}

// Schwärzungen anwenden → neue PDF-Bytes
export async function applyRedactions(bytes, boxes, { dpi = 200, onProgress } = {}) {
  const { PDFDocument } = L();
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const pdf = await loadPdf(bytes);
  const n = pdf.numPages;
  const byPage = new Map();
  for (const b of boxes) { if (!byPage.has(b.page)) byPage.set(b.page, []); byPage.get(b.page).push(b); }
  try {
    for (let i = 0; i < n; i++) {
      const list = byPage.get(i);
      if (!list) { const [pg] = await out.copyPages(src, [i]); out.addPage(pg); continue; }
      onProgress && onProgress(i + 1, n);
      const p = await pdf.getPage(i + 1);
      const v1 = p.getViewport({ scale: 1 });
      const scale = Math.min(dpi / 72, 4200 / Math.max(v1.width, v1.height));
      const vp = p.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      ctx.fillStyle = '#000';
      for (const b of list) {
        const x = Math.floor(b.x * c.width), y = Math.floor(b.y * c.height);
        ctx.fillRect(x, y, Math.ceil(b.w * c.width) + 1, Math.ceil(b.h * c.height) + 1);
      }
      const jpg = await new Promise((res, rej) => c.toBlob(bl => bl ? bl.arrayBuffer().then(a => res(new Uint8Array(a)), rej) : rej(new Error('JPEG')), 'image/jpeg', 0.9));
      c.width = c.height = 1;
      p.cleanup();
      const img = await out.embedJpg(jpg);
      const page = out.addPage([v1.width, v1.height]);
      page.drawImage(img, { x: 0, y: 0, width: v1.width, height: v1.height });
    }
  } finally { closePdf(pdf); }
  // Keine alten Metadaten übernehmen
  out.setTitle(''); out.setAuthor(''); out.setSubject(''); out.setKeywords([]); out.setProducer('Nibvion'); out.setCreator('Nibvion');
  return out.save();
}

// ---------- Oberfläche ----------
// ctx: { docBytes, storeResult, renderRecents, openDoc }
export async function redactSheet(d, ctx) {
  if (!d) return;
  busy(true, 'PDF wird geladen …');
  let bytes, pdf;
  try { bytes = await ctx.docBytes(d); pdf = await loadPdf(bytes); }
  catch (e) { console.error(e); busy(false); return toast('PDF konnte nicht geladen werden', true); }
  busy(false);
  const N = pdf.numPages;
  let boxes = [], undo = [], cur = 0, copy = true;
  const cache = new Map();             // Seite → gerendertes Bild
  sheet({
    title: 'Schwärzen',
    html: `<p style="color:var(--text2);margin:0 2px 10px;font-size:14px;line-height:1.4">Ziehe mit dem Finger Rechtecke über alles, was weg soll. Antippen entfernt eine Markierung.</p>
      <div class="rd-search">
        <input class="field" data-q placeholder="Text suchen und schwärzen" autocomplete="off" autocapitalize="off">
        <button class="btn primary" data-find>${icon('search')}</button>
      </div>
      <div class="chips no-swipe" data-pat>${PATTERNS.map(p => `<button class="chip" data-p="${p.id}">${p.label}</button>`).join('')}</div>
      <div class="rd-stage"><canvas data-cv class="rd-canvas"></canvas></div>
      <div class="rd-nav">
        <button class="rd-nb" data-prev>${icon('chevronLeft')}</button>
        <span data-info></span>
        <button class="rd-nb" data-undo>${icon('undo')}</button>
        <button class="rd-nb" data-next>${icon('chevronRight')}</button>
      </div>
      <div class="rd-note">${icon('info')}<span>Seiten mit Schwärzungen werden als Bild neu aufgebaut – der Inhalt darunter ist danach <b>endgültig entfernt</b>. Text auf diesen Seiten lässt sich danach nicht mehr markieren.</span></div>
      <div class="row" style="padding:12px 2px 2px;border:0"><span class="row-main"><span class="row-title">Als Kopie speichern</span><span class="row-sub" style="display:block">Empfohlen – das Original bleibt erhalten</span></span>
        <div class="seg" data-copy><button data-v="1" class="on">An</button><button data-v="0">Aus</button></div></div>
      <div class="btn-row"><button class="btn primary" data-ok>${icon('redact')} Schwärzen anwenden</button></div>`,
    onClose: () => closePdf(pdf),
    onMount(el, api) {
      const cv = el.querySelector('[data-cv]'), g = cv.getContext('2d');
      const info = el.querySelector('[data-info]');
      let base = null, drag = null, renderId = 0;

      const pageImg = async i => {
        if (cache.has(i)) return cache.get(i);
        const p = await pdf.getPage(i + 1);
        const v = p.getViewport({ scale: 1 });
        const s = Math.min(1400 / v.width, 1800 / v.height);
        const vp = p.getViewport({ scale: s });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        await p.render({ canvasContext: x, viewport: vp }).promise;
        cache.set(i, c);
        return c;
      };
      const draw = () => {
        if (!base) return;
        g.drawImage(base, 0, 0);
        const W = cv.width, H = cv.height;
        for (const b of boxes) if (b.page === cur) {
          g.fillStyle = 'rgba(0,0,0,.78)'; g.fillRect(b.x * W, b.y * H, b.w * W, b.h * H);
          g.strokeStyle = '#ff6a5b'; g.lineWidth = Math.max(2, W / 400); g.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
        }
        if (drag?.box) {
          const b = drag.box;
          g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(b.x * W, b.y * H, b.w * W, b.h * H);
          g.setLineDash([8, 6]); g.strokeStyle = '#ff6a5b'; g.lineWidth = Math.max(2, W / 400); g.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H); g.setLineDash([]);
        }
        const k = boxes.filter(b => b.page === cur).length, all = boxes.length;
        info.innerHTML = `Seite ${cur + 1} / ${N}<small>${all ? `${k} hier · ${all} gesamt` : 'noch nichts markiert'}</small>`;
        el.querySelector('[data-prev]').disabled = cur === 0;
        el.querySelector('[data-next]').disabled = cur === N - 1;
        el.querySelector('[data-undo]').disabled = !undo.length;
      };
      const show = async i => {
        cur = i; const id = ++renderId;
        info.innerHTML = `Seite ${cur + 1} / ${N}<small>wird geladen …</small>`;
        const c = await pageImg(i);
        if (id !== renderId) return;
        base = c; cv.width = c.width; cv.height = c.height;
        cv.classList.remove('pop'); void cv.offsetWidth; cv.classList.add('pop');
        draw();
      };

      const pos = e => { const r = cv.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
      cv.addEventListener('pointerdown', e => { e.preventDefault(); cv.setPointerCapture(e.pointerId); drag = { p0: pos(e), box: null }; });
      cv.addEventListener('pointermove', e => {
        if (!drag) return;
        const [x0, y0] = drag.p0, [x1, y1] = pos(e);
        drag.box = { page: cur, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        draw();
      });
      const end = e => {
        if (!drag) return;
        const r = cv.getBoundingClientRect(), b = drag.box;
        if (b && b.w * r.width > 8 && b.h * r.height > 6) { boxes.push(b); undo.push({ add: b }); haptic(); }
        else {                                            // Tippen: Markierung darunter entfernen
          const [x, y] = drag.p0;
          for (let k = boxes.length - 1; k >= 0; k--) {
            const q = boxes[k];
            if (q.page === cur && x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h) { undo.push({ del: q, at: k }); boxes.splice(k, 1); haptic(); break; }
          }
        }
        drag = null; draw();
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', () => { drag = null; draw(); });

      el.querySelector('[data-prev]').onclick = () => cur > 0 && show(cur - 1);
      el.querySelector('[data-next]').onclick = () => cur < N - 1 && show(cur + 1);
      el.querySelector('[data-undo]').onclick = () => {
        const u = undo.pop(); if (!u) return;
        if (u.add) boxes = boxes.filter(b => b !== u.add);
        else if (u.del) boxes.splice(u.at, 0, u.del);
        if (u.many) boxes = boxes.filter(b => !u.many.includes(b));
        haptic(); draw();
      };

      const search = async (re, what) => {
        busy(true, 'Wird gesucht …');
        let found = [];
        try { found = await findBoxes(pdf, re); } catch (e) { console.error(e); }
        busy(false);
        // Doppelte (gleiche Stelle schon markiert) überspringen
        const same = (a, b) => a.page === b.page && Math.abs(a.x - b.x) < 0.003 && Math.abs(a.y - b.y) < 0.003 && Math.abs(a.w - b.w) < 0.003;
        found = found.filter(f => !boxes.some(b => same(b, f)));
        if (!found.length) return toast(`Keine Treffer für ${what}`, true);
        boxes.push(...found); undo.push({ many: found }); haptic();
        const pages = [...new Set(found.map(f => f.page))];
        toast(`${found.length} ${found.length === 1 ? 'Treffer' : 'Treffer'} auf ${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'} markiert`);
        if (!pages.includes(cur)) show(pages[0]); else draw();
      };
      const q = el.querySelector('[data-q]');
      const doFind = () => { const t = q.value.trim(); if (!t) return toast('Bitte einen Suchbegriff eingeben', true); q.blur(); search(new RegExp(escRe(t), 'gi'), `„${t}“`); };
      el.querySelector('[data-find]').onclick = doFind;
      q.onkeydown = e => { if (e.key === 'Enter') doFind(); };
      el.querySelectorAll('[data-pat] .chip').forEach(b => b.onclick = () => { const p = PATTERNS.find(x => x.id === b.dataset.p); search(new RegExp(p.re.source, p.re.flags), p.label); });
      el.querySelectorAll('[data-copy] button').forEach(b => b.onclick = () => { copy = b.dataset.v === '1'; el.querySelectorAll('[data-copy] button').forEach(x => x.classList.toggle('on', x === b)); });

      el.querySelector('[data-ok]').onclick = async () => {
        if (!boxes.length) return toast('Markiere zuerst etwas zum Schwärzen', true);
        const pages = new Set(boxes.map(b => b.page)).size;
        if (!await confirmDlg('Endgültig schwärzen?', `${boxes.length} ${boxes.length === 1 ? 'Stelle' : 'Stellen'} auf ${pages} ${pages === 1 ? 'Seite' : 'Seiten'} werden unwiderruflich entfernt.${copy ? ' Das Original bleibt erhalten.' : ' Das Original wird ersetzt.'}`, 'Schwärzen')) return;
        api.close(); busy(true, 'Wird geschwärzt …');
        try {
          const outBytes = await applyRedactions(bytes, boxes, { onProgress: (i, n) => busy(true, `Seite ${i} von ${n} wird geschwärzt …`) });
          const id = await ctx.storeResult(d, outBytes, 'geschwärzt', copy);
          busy(false); await ctx.renderRecents(); toast('Geschwärzt – Inhalte entfernt'); ctx.openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Schwärzen fehlgeschlagen', true); }
      };
      show(0);
    },
  });
}
