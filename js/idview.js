// ================= Ausweise: Ansicht, ID-Angaben, Bild-Editor =================
// Ein Ausweis wird als PDF (A4, Vorder- und Rückseite) gespeichert. Zusätzlich bleiben die
// Original-Fotos je Seite erhalten, damit man später neu zuschneiden, filtern und markieren kann:
//   meta.idSides = [{ corners, rot, filter, ov }]           (in „docs“)
//   files `${id}#s${i}` = Original-Foto (JPEG), `${id}#o${i}` = Markierungen (PNG, transparent)
//   meta.idInfo = { name, number, … }  ·  meta.idSize = 'large' | 'orig'  ·  meta.idOcr = erkannte Wörter
import { db } from './db.js';
import { icon } from './icons.js';
import { toast, busy, sheet, confirmDlg, promptDlg, esc, haptic, pickFiles } from './ui.js';
import { loadPdf, closePdf, renderThumb, imagesToPdf } from './pdfcore.js';
import { cropEditor, render, toCanvas, rotateCanvas, loadFileImage } from './scanner.js';
import { settings } from './settings.js';
import { ID_CATS, idCat } from './files.js';
import { shareBytes } from './editor.js';
import { moveToTrash } from './trash.js';
import { liveScanner, cameraSupported, cardCorners } from './camera.js';
import { onlineReady, onlineOcr } from './online.js';
import { reorderPages, titlesSheet, collage, renderLayout, adjOf, defaultTpl, PAGE_SIZES } from './idpages.js';

let ctx = {};
export function initIdView(c) { ctx = c; }

const today = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
const nowHM = () => new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }).replace(':', '.');
const tick = () => new Promise(r => setTimeout(r, 0));
const sideKey = (id, i) => `${id}#s${i}`, ovKey = (id, i) => `${id}#o${i}`;
const sideName = (n, i, title) => title || (n === 1 ? 'Datenseite' : i === 0 ? 'Vorderseite' : i === 1 ? 'Rückseite' : `Seite ${i + 1}`);
const stName = (states, k) => sideName(states.length, k, states[k]?.side?.title);

// ---------- Felder je Ausweis-Art ----------
const FIELDS = {
  idcard: [['name', 'Name', 'Name auf dem Ausweis'], ['number', 'Ausweis-Nr.', 'Nummer oben rechts'], ['birth', 'Geburtsdatum', 'TT.MM.JJJJ'], ['expiry', 'Gültig bis', 'TT.MM.JJJJ']],
  driver: [['name', 'Name', 'Name auf dem Führerschein'], ['number', 'Führerschein-Nr.', 'Feld 5'], ['classes', 'Klassen', 'z. B. B, BE, AM'], ['expiry', 'Gültig bis', 'TT.MM.JJJJ']],
  passport: [['name', 'Name', 'Name im Pass'], ['number', 'Pass-Nr.', 'Nummer oben rechts'], ['birth', 'Geburtsdatum', 'TT.MM.JJJJ'], ['expiry', 'Gültig bis', 'TT.MM.JJJJ']],
  bank: [['name', 'Name', 'Name auf der Karte'], ['number', 'IBAN / Karten-Nr.', 'Nummer auf der Karte'], ['bank', 'Bank', 'Name der Bank'], ['expiry', 'Gültig bis', 'MM/JJ']],
  other: [['name', 'Name', 'Name auf dem Ausweis'], ['number', 'Nummer', 'Nummer auf dem Ausweis'], ['issuer', 'Aussteller', 'z. B. Krankenkasse, Verein'], ['expiry', 'Gültig bis', 'TT.MM.JJJJ']],
};
const fieldsFor = cat => FIELDS[cat] || FIELDS.other;

// ---------- Bilder laden / rendern ----------
const bytesImg = (data, type = 'image/jpeg') => new Promise((res, rej) => {
  const u = URL.createObjectURL(new Blob([data], { type }));
  const im = new Image(); im.onload = () => { res(im); setTimeout(() => URL.revokeObjectURL(u), 1500); }; im.onerror = rej; im.src = u;
});
const canvasBytes = (c, type = 'image/jpeg', q = 0.9) => new Promise(res => c.toBlob(b => b.arrayBuffer().then(res), type, q));
const copyCanvas = (c, w = c.width, h = c.height) => { const o = document.createElement('canvas'); o.width = w; o.height = h; o.getContext('2d').drawImage(c, 0, 0, w, h); return o; };

// Zugeschnittene, gefilterte Seite (ohne Markierungen). 1,2 % Rand weg (Tischreste an der Kante).
function baseCanvas(img, side, maxSide = 1800) {
  const c = render({ img, corners: side.corners, rot: side.rot || 0, straighten: false }, side.filter ?? 'card', maxSide);
  const ix = Math.round(c.width * 0.012), iy = Math.round(c.height * 0.012);
  const o = document.createElement('canvas'); o.width = c.width - 2 * ix; o.height = c.height - 2 * iy;
  o.getContext('2d').drawImage(c, ix, iy, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}
const withOverlay = (base, ov) => { const c = copyCanvas(base); if (ov) c.getContext('2d').drawImage(ov, 0, 0, c.width, c.height); return c; };

async function loadSides(d) {
  const out = [];
  for (let i = 0; i < d.idSides.length; i++) {
    const s = d.idSides[i], f = await db.get('files', sideKey(d.id, i));
    if (!f) continue;
    const img = await bytesImg(f.data);
    let ov = null;
    if (s.ov) { const o = await db.get('files', ovKey(d.id, i)); if (o) ov = await bytesImg(o.data, 'image/png'); }
    out.push({ i, side: { ...s }, img, ov });
  }
  return out;
}
async function finalCanvas(st, maxSide = 2000) { return withOverlay(baseCanvas(st.img, st.side, maxSide), st.ov); }

// ---------- PDF zusammensetzen ----------
async function composePdf(canvases, catId, size = 'large') {
  const urls = [];
  for (let i = 0; i < canvases.length; i += 2) urls.push((await composeSheet(canvases.slice(i, i + 2), catId, size)).toDataURL('image/jpeg', 0.92));   // je 2 Seiten pro Blatt
  return imagesToPdf(urls, { margin: 0 });
}
async function composeSheet(canvases, catId, size) {
  const MM = 10, W = 210 * MM, H = 297 * MM;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  const pass = catId === 'passport';
  const [cw0, ch0] = pass ? [125, 88] : [85.6, 54];
  const n = Math.min(2, canvases.length), gap = 14;
  const sc = size === 'orig' ? 1 : Math.min(170 / cw0, (H / MM - 40 - gap * (n - 1)) / n / ch0);
  const w = cw0 * sc * MM, h = ch0 * sc * MM, r = (pass ? 2 : 3.2) * sc * MM, left = (W - w) / 2;
  let top = size === 'orig' ? 45 * MM : (H - (n * h + (n - 1) * gap * MM)) / 2;
  for (const img of canvases.slice(0, 2)) {
    x.save(); x.beginPath(); x.roundRect(left, top, w, h, r); x.clip();
    x.imageSmoothingQuality = 'high'; x.drawImage(img, left, top, w, h); x.restore();
    x.strokeStyle = 'rgba(0,0,0,.12)'; x.lineWidth = 2; x.beginPath(); x.roundRect(left, top, w, h, r); x.stroke();
    top += h + gap * MM;
    await tick();
  }
  return c;
}

async function writePdf(d, bytes) {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const pdf = await loadPdf(data);
  try { d.thumb = await renderThumb(pdf, 1); } catch {}
  d.pages = pdf.numPages; closePdf(pdf);
  d.size = data.byteLength; d.updated = Date.now(); d.objects = [];
  await db.put('files', { id: d.id, data });
  await db.put('docs', d);
}
async function rebuildPdf(d, states) {
  const cs = []; for (const st of states) { cs.push(await finalCanvas(st)); await tick(); }
  if (d.idLayout) {                             // Collage (Menü „Seiten“)
    const pages = renderLayout(cs, states.map(st => adjOf(st.side)), d.idLayout, 10);
    return writePdf(d, await imagesToPdf(pages.map(c => c.toDataURL('image/jpeg', 0.92)), { mm: (PAGE_SIZES[d.idLayout.size] || PAGE_SIZES.a4).slice(0, 2) }));
  }
  await writePdf(d, await composePdf(cs, d.idCat, d.idSize));
}

// ---------- Aufnahme speichern (aus dem Scanner) ----------
function idReview(list, cat) {
  return new Promise(resolve => {
    let size = settings.get('idSize') || 'large', result = null;
    const sides = list.slice(0, 2);
    sheet({
      title: `${cat.label} prüfen`,
      html: `<div class="idrev">
        ${sides.map((_, i) => `<button class="idrev-card" data-i="${i}"><img alt=""><span class="idrev-lbl">${sideName(sides.length, i)}</span><span class="idrev-edit">${icon('fit')} Kanten</span></button>`).join('')}
        <div class="idrev-size"><span>Größe auf A4</span><div class="seg">
          <button data-s="large">Groß</button><button data-s="orig">Originalgröße</button></div></div>
        <button class="btn primary" data-save>Speichern</button></div>`,
      onMount(el, api) {
        const paint = i => { el.querySelector(`[data-i="${i}"] img`).src = baseCanvas(sides[i].img, sides[i], 900).toDataURL('image/jpeg', 0.85); };
        sides.forEach((_, i) => paint(i));
        const seg = () => el.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', b.dataset.s === size));
        seg();
        el.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { size = b.dataset.s; settings.set('idSize', size); haptic(); seg(); });
        el.querySelectorAll('[data-i]').forEach(b => b.onclick = async () => {
          const it = sides[+b.dataset.i], r = await cropEditor(it);
          if (r) { it.corners = r.corners; it.rot = r.rot; paint(+b.dataset.i); }
        });
        el.querySelector('[data-save]').onclick = () => { result = { size }; api.close(); };
      },
      onClose: () => resolve(result),
    });
  });
}

export async function saveIdCard(list, cat, folder) {
  const pass = cat.id === 'passport';
  // hochkant fotografiert → quer drehen (Karten sind immer quer)
  for (const it of list) {
    it.filter = 'card'; it.straighten = false; it.rot ||= 0;
    if (!pass && !it.rot) { const t = baseCanvas(it.img, it, 300); if (t.height > t.width) it.rot = 90; }
  }
  const ok = await idReview(list, cat);
  if (!ok) { list.forEach(it => it.url && URL.revokeObjectURL(it.url)); return; }
  busy(true, `${cat.label} wird erstellt …`);
  try {
    const sides = list.slice(0, cat.sides || 2);
    const cs = []; for (const it of sides) { cs.push(baseCanvas(it.img, it, 2000)); await tick(); }
    const bytes = await composePdf(cs, cat.id, ok.size);
    const id = await ctx.saveNewDoc(bytes, `${cat.label} ${today()} ${nowHM()}.pdf`, { folder: folder.id, idCat: cat.id });
    const d = await db.get('docs', id);
    d.idSides = []; d.idSize = ok.size;
    for (let i = 0; i < sides.length; i++) {
      const it = sides[i];
      await db.put('files', { id: sideKey(id, i), data: await canvasBytes(toCanvas(it.img, 2600), 'image/jpeg', 0.9) });
      d.idSides.push({ corners: it.corners, rot: it.rot || 0, filter: 'card', ov: false });
    }
    await db.put('docs', d);
    busy(false); await ctx.refresh();
    toast(`${cat.label} gespeichert in „${folder.name}“`);
    list.forEach(it => it.url && setTimeout(() => URL.revokeObjectURL(it.url), 3000));
    openIdView(id);
  } catch (e) { console.error(e); busy(false); toast('Ausweis konnte nicht gespeichert werden', true); }
}

// Beim Löschen/Sichern: zusätzliche Dateien eines Ausweises
export const idFileKeys = d => (d?.idSides || []).flatMap((_, i) => [sideKey(d.id, i), ovKey(d.id, i)]);

// ---------- Ansicht ----------
let view = null;
const hidden = () => !!settings.get('idHide');

export async function openIdView(id) {
  const d = await db.get('docs', id);
  if (!d?.idSides?.length) return ctx.openPdf(id);
  busy(true, 'Wird geöffnet …');
  let states;
  try { states = await loadSides(d); } catch (e) { console.error(e); busy(false); return ctx.openPdf(id); }
  busy(false);
  if (!states.length) return ctx.openPdf(id);
  view?.el.remove();
  const el = document.createElement('div'); el.className = 'idv';
  document.body.appendChild(el); document.body.classList.add('idv-open');
  view = { el, d, states };
  d.opened = Date.now(); db.put('docs', d);
  paintView();
}

function closeView() {
  if (!view) return;
  const el = view.el; view = null;
  el.classList.add('out'); setTimeout(() => el.remove(), 260);
  document.body.classList.remove('idv-open');
  ctx.refresh();
}

function infoRows(d) {
  const info = d.idInfo || {};
  return fieldsFor(d.idCat).filter(([k]) => info[k]).map(([k, l]) =>
    `<button class="idv-row" data-copy="${esc(k)}"><span>${l}</span><b class="idv-val">${esc(hidden() ? '•'.repeat(Math.min(12, info[k].length)) : info[k])}</b>${icon('copy')}</button>`).join('');
}

function paintView() {
  const { el, d, states } = view, cat = idCat(d.idCat), filled = !!infoRows(d);
  el.classList.toggle('hide', hidden());
  el.innerHTML = `
    <div class="idv-head">
      <button class="icon-btn" data-back aria-label="Zurück">${icon('chevronLeft')}</button>
      <button class="idv-title" data-rename>${esc(d.name.replace(/\.pdf$/i, ''))}</button>
      <button class="icon-btn" data-more aria-label="Mehr">${icon('more')}</button>
    </div>
    <div class="idv-scroll">
      <div class="idv-info">
        <div class="idv-info-head"><b>${esc(cat.label)}</b><button class="icon-btn sm" data-eye aria-label="${hidden() ? 'Anzeigen' : 'Verbergen'}">${icon(hidden() ? 'eyeOff' : 'eye')}</button></div>
        ${filled ? `<div class="idv-rows">${infoRows(d)}</div><button class="link-btn" data-fill>Bearbeiten</button>`
          : `<button class="btn primary idv-fill" data-fill>Ausfüllen</button><div class="idv-sub">ID-Angaben eingeben</div>`}
      </div>
      ${states.map((st, k) => `<button class="idv-side" data-side="${k}"><img alt="${esc(stName(states, k))}">${st.side.title ? `<span class="idv-side-ttl">${esc(st.side.title)}</span>` : ''}</button>`).join('')}
      <div class="idv-space"></div>
    </div>
    <div class="idv-bar">
      <button class="idv-tb" data-edit>${icon('edit')}<span>Bearbeiten</span></button>
      <button class="idv-tb" data-pdf>${icon('file')}<span>PDF öffnen</span></button>
      <button class="btn primary idv-share" data-share>${icon('share')} Teilen</button>
    </div>`;
  states.forEach((st, k) => { el.querySelector(`[data-side="${k}"] img`).src = withOverlay(baseCanvas(st.img, st.side, 1200), st.ov).toDataURL('image/jpeg', 0.86); });
  el.querySelector('[data-back]').onclick = () => { haptic(); closeView(); };
  el.querySelector('[data-eye]').onclick = () => { settings.set('idHide', !hidden()); haptic(); paintView(); };
  el.querySelector('[data-fill]').onclick = () => infoForm(!filled);
  el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(d.idInfo[b.dataset.copy]); haptic(); toast('Kopiert'); } catch { toast('Kopieren nicht möglich', true); }
  });
  el.querySelectorAll('[data-side]').forEach(b => b.onclick = () => sideViewer(+b.dataset.side));
  el.querySelector('[data-edit]').onclick = () => imageEditor(0);
  el.querySelector('[data-pdf]').onclick = () => { const id = d.id; closeView(); ctx.openPdf(id); };
  el.querySelector('[data-share]').onclick = sharePdf;
  el.querySelector('[data-rename]').onclick = rename;
  el.querySelector('[data-more]').onclick = moreMenu;
}

async function sharePdf() {
  const f = await db.get('files', view.d.id);
  if (f) shareBytes(new Uint8Array(f.data), view.d.name);
}
async function rename() {
  const d = view.d, n = await promptDlg('Umbenennen', d.name.replace(/\.pdf$/i, ''), 'Speichern');
  if (!n || !n.trim()) return;
  d.name = n.trim() + '.pdf'; d.updated = Date.now(); await db.put('docs', d); paintView();
}
function moreMenu() {
  const d = view.d;
  sheet({
    title: 'Ausweis',
    html: `<div class="menu">
      <button class="row" data-a="size"><span class="row-ic c-blue">${icon('fit')}</span><span class="row-main"><span class="row-title">Größe auf A4</span><span class="row-sub">${d.idSize === 'orig' ? 'Originalgröße (wie Kopie)' : 'Groß'}</span></span>${icon('chevronRight')}</button>
      <button class="row" data-a="rename"><span class="row-ic c-gray">${icon('rename')}</span><span class="row-main"><span class="row-title">Umbenennen</span></span></button>
      <button class="row" data-a="trash"><span class="row-ic c-red">${icon('trash')}</span><span class="row-main"><span class="row-title">In den Papierkorb</span></span></button></div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        api.close();
        const a = b.dataset.a;
        if (a === 'rename') return rename();
        if (a === 'trash') {
          if (!await confirmDlg('In den Papierkorb?', `„${d.name}“ wird ${30} Tage im Papierkorb aufbewahrt.`, 'Löschen')) return;
          await moveToTrash(d.id); toast('In den Papierkorb verschoben'); return closeView();
        }
        if (a === 'size') {
          d.idSize = d.idSize === 'orig' ? 'large' : 'orig';
          busy(true, 'PDF wird erstellt …');
          try { await rebuildPdf(d, view.states); toast(d.idSize === 'orig' ? 'Originalgröße' : 'Groß'); } catch (e) { console.error(e); toast('Fehler beim Erstellen', true); }
          busy(false); paintView();
        }
      });
    },
  });
}

// ---------- Einzelne Seite ansehen ----------
function sideViewer(k) {
  const { states, d } = view;
  const el = document.createElement('div'); el.className = 'idsv';
  el.innerHTML = `
    <div class="idsv-head"><button class="icon-btn dark" data-x aria-label="Zurück">${icon('chevronLeft')}</button></div>
    <div class="idsv-stage"><img alt=""></div>
    <div class="idsv-count"></div>
    <div class="idsv-bar">
      <button data-edit>${icon('edit')}<span>Bearbeiten</span></button>
      <button data-save>${icon('download')}<span>In Fotos sichern</span></button>
      <button data-share>${icon('share')}<span>Freigeben</span></button>
    </div>`;
  document.body.appendChild(el);
  const img = el.querySelector('img');
  const show = () => {
    img.src = withOverlay(baseCanvas(states[k].img, states[k].side, 1600), states[k].ov).toDataURL('image/jpeg', 0.9);
    el.querySelector('.idsv-count').textContent = states.length > 1 ? `${k + 1}/${states.length}` : '';
  };
  show();
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.querySelector('[data-x]').onclick = close;
  // Wischen: andere Seite
  let sx = null;
  el.querySelector('.idsv-stage').addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  el.querySelector('.idsv-stage').addEventListener('touchend', e => {
    if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null;
    if (Math.abs(dx) < 50) return;
    const n = k + (dx < 0 ? 1 : -1); if (n < 0 || n >= states.length) return;
    k = n; haptic(); show();
  }, { passive: true });
  const jpg = async () => canvasBytes(await finalCanvas(states[k], 2400), 'image/jpeg', 0.93);
  const fname = () => `${d.name.replace(/\.pdf$/i, '')} ${stName(states, k)}.jpg`;
  el.querySelector('[data-save]').onclick = async () => { toast('Im Teilen-Menü „Bild sichern“ wählen'); shareBytes(new Uint8Array(await jpg()), fname(), 'image/jpeg'); };
  el.querySelector('[data-share]').onclick = () => sheet({
    title: 'Freigeben',
    html: `<div class="menu">
      <button class="row" data-f="jpg"><span class="row-ic c-blue">${icon('image')}</span><span class="row-main"><span class="row-title">Diese Seite als Bild</span><span class="row-sub">JPG</span></span></button>
      <button class="row" data-f="pdf"><span class="row-ic c-red">${icon('file')}</span><span class="row-main"><span class="row-title">Ganzer Ausweis als PDF</span><span class="row-sub">Vorder- und Rückseite auf A4</span></span></button></div>`,
    onMount(s, api) { s.querySelectorAll('[data-f]').forEach(b => b.onclick = async () => { api.close(); if (b.dataset.f === 'pdf') sharePdf(); else shareBytes(new Uint8Array(await jpg()), fname(), 'image/jpeg'); }); },
  });
  el.querySelector('[data-edit]').onclick = () => { close(); imageEditor(k); };
}

// ---------- Intelligentes Löschen (Inpainting) ----------
// Füllt die markierte Fläche von außen nach innen mit den umliegenden Farben auf (Zwiebelschalen-
// Verfahren), glättet und legt die Körnung der Umgebung darüber, damit es nicht „verschmiert“ aussieht.
// Ergebnis landet deckend auf der Markierungs-Ebene → Radierer / Zurück funktionieren wie gewohnt.
function smartErase(w, maskC) {
  const Wd = w.ov.width, Hd = w.ov.height;
  const md = maskC.getContext('2d').getImageData(0, 0, Wd, Hd).data;
  let x0 = Wd, y0 = Hd, x1 = -1, y1 = -1;
  for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) if (md[(y * Wd + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return;
  const PAD = 14;
  x0 = Math.max(0, x0 - PAD); y0 = Math.max(0, y0 - PAD); x1 = Math.min(Wd - 1, x1 + PAD); y1 = Math.min(Hd - 1, y1 + PAD);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, N = bw * bh;
  // Aktuelles Bild = Basis + Markierungen
  const comp = document.createElement('canvas'); comp.width = bw; comp.height = bh;
  const cx = comp.getContext('2d'); cx.drawImage(w.base, -x0, -y0); cx.drawImage(w.ov, -x0, -y0);
  const px = cx.getImageData(0, 0, bw, bh).data;
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let i = 0; i < N; i++) { R[i] = px[i * 4]; G[i] = px[i * 4 + 1]; B[i] = px[i * 4 + 2]; }
  // Maske (um 2 px erweitert, damit Ränder von Schrift nicht stehen bleiben)
  let hole = new Uint8Array(N);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) hole[y * bw + x] = md[((y + y0) * Wd + x + x0) * 4 + 3] > 20 ? 1 : 0;
  for (let k = 0; k < 2; k++) {
    const h2 = hole.slice();
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (!hole[y * bw + x]) {
      if ((x > 0 && hole[y * bw + x - 1]) || (x < bw - 1 && hole[y * bw + x + 1]) || (y > 0 && hole[(y - 1) * bw + x]) || (y < bh - 1 && hole[(y + 1) * bw + x])) h2[y * bw + x] = 1;
    }
    hole = h2;
  }
  const fill = hole.slice(), known = new Uint8Array(N);
  let left = 0; for (let i = 0; i < N; i++) { known[i] = hole[i] ? 0 : 1; left += hole[i]; }
  if (left === N) return;
  // Körnung der Umgebung messen (Abweichung vom 3×3-Mittel, nur bekannte Pixel nahe der Maske)
  const sd = [0, 0, 0]; let sn = 0;
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    const i = y * bw + x; if (!known[i]) continue;
    let near = false; for (let d = -6; d <= 6 && !near; d += 3) { const xx = x + d; if (xx >= 0 && xx < bw && hole[i + d]) near = true; const yy = y + d; if (yy >= 0 && yy < bh && hole[yy * bw + x]) near = true; }
    if (!near) continue;
    let mr = 0, mg = 0, mb = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = i + dy * bw + dx; if (known[j]) { mr += R[j]; mg += G[j]; mb += B[j]; c++; } }
    if (c < 5) continue;
    sd[0] += (R[i] - mr / c) ** 2; sd[1] += (G[i] - mg / c) ** 2; sd[2] += (B[i] - mb / c) ** 2; sn++;
  }
  const sdev = sd.map(v => sn ? Math.min(28, Math.sqrt(v / sn) * 1.3) : 0);
  // Echte Körnung der Umgebung merken (Pixel minus 5×5-Mittel), um sie später blockweise hineinzukopieren
  const res = new Float32Array(N * 3), resOk = new Uint8Array(N), srcs = [];
  for (let y = 2; y < bh - 2; y++) for (let x = 2; x < bw - 2; x++) {
    const i = y * bw + x; let ok = true, mr = 0, mg = 0, mb = 0;
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) { const j = i + dy * bw + dx; if (!known[j]) { ok = false; break; } mr += R[j]; mg += G[j]; mb += B[j]; }
    if (!ok) continue;
    res[i * 3] = R[i] - mr / 25; res[i * 3 + 1] = G[i] - mg / 25; res[i * 3 + 2] = B[i] - mb / 25; resOk[i] = 1;
    if (!(x & 3) && !(y & 3)) srcs.push(i);
  }
  // Zwiebelschalen: Ring für Ring von außen nach innen auffüllen
  const RAD = 3;
  for (let guard = 0; left > 0 && guard < 2000; guard++) {
    const ring = [];
    for (let i = 0; i < N; i++) if (!known[i]) {
      const x = i % bw, y = (i / bw) | 0;
      if ((x > 0 && known[i - 1]) || (x < bw - 1 && known[i + 1]) || (y > 0 && known[i - bw]) || (y < bh - 1 && known[i + bw])) ring.push(i);
    }
    if (!ring.length) break;
    const vals = ring.map(i => {
      const x = i % bw, y = (i / bw) | 0; let r = 0, g = 0, b = 0, ws = 0;
      for (let dy = -RAD; dy <= RAD; dy++) { const yy = y + dy; if (yy < 0 || yy >= bh) continue;
        for (let dx = -RAD; dx <= RAD; dx++) { const xx = x + dx; if (xx < 0 || xx >= bw) continue;
          const j = yy * bw + xx; if (!known[j]) continue;
          const wt = 1 / (dx * dx + dy * dy); r += R[j] * wt; g += G[j] * wt; b += B[j] * wt; ws += wt; } }
      return [r / ws, g / ws, b / ws];
    });
    ring.forEach((i, n) => { [R[i], G[i], B[i]] = vals[n]; known[i] = 1; left--; });
  }
  // Glätten: Fläche wie eine gespannte Haut zwischen den Rändern ausgleichen (Laplace), gegen Streifen
  const idx = []; for (let i = 0; i < N; i++) if (fill[i]) idx.push(i);
  const iters = Math.min(400, 60 + Math.round(Math.sqrt(idx.length)));
  for (let it = 0; it < iters; it++) for (const i of idx) {
    const x = i % bw, y = (i / bw) | 0;
    const l = x > 0 ? i - 1 : i, r = x < bw - 1 ? i + 1 : i, u = y > 0 ? i - bw : i, d = y < bh - 1 ? i + bw : i;
    R[i] = (R[l] + R[r] + R[u] + R[d]) / 4; G[i] = (G[l] + G[r] + G[u] + G[d]) / 4; B[i] = (B[l] + B[r] + B[u] + B[d]) / 4;
  }
  // Körnung + weicher Rand, auf die Markierungs-Ebene schreiben
  const oc = w.ov.getContext('2d'), od = oc.getImageData(x0, y0, bw, bh), o = od.data;
  const blk = new Map(), BS = 8;
  const srcFor = (x, y) => { const key = (y >> 3) * 4096 + (x >> 3); if (!blk.has(key)) blk.set(key, srcs.length ? srcs[(Math.random() * srcs.length) | 0] : -1); return blk.get(key); };
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  for (let i = 0; i < N; i++) {
    if (!fill[i]) continue;
    const x = i % bw, y = (i / bw) | 0, j = i * 4, c = srcFor(x, y);
    let nr, ng, nb;
    const sI = c < 0 ? -1 : c + (y % BS) * bw + (x % BS);
    if (sI >= 0 && sI < N && resOk[sI] && (c % bw) + (x % BS) < bw) { nr = res[sI * 3]; ng = res[sI * 3 + 1]; nb = res[sI * 3 + 2]; }
    else { const n = gauss(); nr = n * sdev[0]; ng = n * sdev[1]; nb = n * sdev[2]; }
    o[j] = Math.max(0, Math.min(255, R[i] + nr));
    o[j + 1] = Math.max(0, Math.min(255, G[i] + ng));
    o[j + 2] = Math.max(0, Math.min(255, B[i] + nb));
    o[j + 3] = 255;
  }
  oc.putImageData(od, x0, y0);
}

// ---------- Hilfen für „Text bearbeiten“ / „Erneut aufnehmen“ ----------
// Bereich mit „Tinte“ (stark vom Hintergrund abweichende Pixel) in einem Ausschnitt → [x0,y0,x1,y1] in px
function inkBox(c) {
  const W = c.width, H = c.height, px = c.getContext('2d').getImageData(0, 0, W, H).data, n = W * H, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  // Abweichung vom örtlichen Mittel (Integralbild) – Schatten/Verläufe zählen so nicht als Schrift
  const R = Math.max(4, Math.round(Math.min(W, H) / 5)), I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let rs = 0; for (let x = 0; x < W; x++) { rs += L[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + rs; } }
  const dev = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ax = Math.max(0, x - R), ay = Math.max(0, y - R), bx = Math.min(W, x + R + 1), by = Math.min(H, y + R + 1);
    const m = (I[by * (W + 1) + bx] - I[ay * (W + 1) + bx] - I[by * (W + 1) + ax] + I[ay * (W + 1) + ax]) / ((bx - ax) * (by - ay));
    dev[y * W + x] = Math.abs(L[y * W + x] - m);
  }
  const srt = Float32Array.from(dev).sort();
  const thr = Math.max(18, srt[Math.floor(n * 0.96)] * 0.7);
  const ink = i => dev[i] > thr;
  // Zeilen: dichteste Textzeile finden (Körnung ist viel dünner als Schrift), Lücken bis 2 px überbrücken
  const rows = new Uint32Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink(y * W + x)) rows[y]++;
  const rmax = Math.max(...rows); if (!rmax) return null;
  const ry = rows.indexOf(rmax), rok = y => rows[y] > rmax * 0.15;
  let y0 = ry, y1 = ry;
  while (y0 > 0 && (rok(y0 - 1) || (y0 > 2 && rok(y0 - 2)) || (y0 > 3 && rok(y0 - 3)))) y0--;
  while (y1 < H - 1 && (rok(y1 + 1) || (y1 < H - 3 && rok(y1 + 2)) || (y1 < H - 4 && rok(y1 + 3)))) y1++;
  // Spalten nur in diesen Zeilen
  const cols = new Uint32Array(W);
  for (let y = y0; y <= y1; y++) for (let x = 0; x < W; x++) if (ink(y * W + x)) cols[x]++;
  const cmax = Math.max(...cols), cc = [...cols.keys()].filter(x => cols[x] > Math.max(1, cmax * 0.15));
  if (!cc.length) return null;
  return [cc[0], y0, cc[cc.length - 1] + 1, y1 + 1];
}
// Schriftfarbe in einem Kasten: Pixel, die am stärksten vom Hintergrund abweichen
function inkColor(c, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  const w = Math.max(1, Math.min(c.width - x0, Math.ceil(x1 - x0))), h = Math.max(1, Math.min(c.height - y0, Math.ceil(y1 - y0)));
  const px = c.getContext('2d').getImageData(x0, y0, w, h).data, L = [];
  for (let i = 0; i < px.length; i += 4) L.push([0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2], i]);
  const med = [...L].sort((a, b) => a[0] - b[0])[L.length >> 1][0];
  L.sort((a, b) => Math.abs(b[0] - med) - Math.abs(a[0] - med));
  const n = Math.max(1, Math.round(L.length * 0.12));
  let r = 0, g = 0, b = 0;
  for (let j = 0; j < n; j++) { const i = L[j][1]; r += px[i]; g += px[i + 1]; b += px[i + 2]; }
  const hx = v => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}
// Ein Foto aufnehmen (Live-Kamera im Ausweis-Modus, sonst aus Fotos)
async function takePhoto(catId) {
  const cam = ['idcard', 'driver', 'passport', 'bank', 'other'].includes(catId) ? catId : 'other';
  if (cameraSupported()) {
    const shots = await liveScanner({ mode: 'id', idType: cam, lockMode: true, maxShots: 1 });
    if (shots?.length) return shots[0];
    if (shots) return null;                    // abgebrochen
  }
  const fs = await pickFiles('file-img'); if (!fs.length) return null;
  try {
    const { img, url } = await loadFileImage(fs[0]);
    return { img, url, corners: cardCorners(img, cam === 'passport' ? 125 / 88 : 85.6 / 54), rot: 0, card: true, straighten: false };
  } catch { toast('Bild konnte nicht geladen werden', true); return null; }
}

// ---------- Bild-Editor (Ausschneiden, Filtern, Drehen, Pinsel, Text, Mosaik, Wasserzeichen) ----------
const CARD_FILTERS = [['card', 'Foto'], ['', 'Original'], ['gray', 'Graustufen'], ['bw', 'Schwarz-Weiß']];
const COLORS = ['#111111', '#e11d48', '#2563eb', '#16a34a', '#ffffff'];

function imageEditor(k) {
  const { states, d } = view;
  // Arbeitskopie je Seite: Basis + Markierungs-Ebene
  const mkWork = st => {
    const base = baseCanvas(st.img, st.side, 1600);
    const ov = document.createElement('canvas'); ov.width = base.width; ov.height = base.height;
    if (st.ov) ov.getContext('2d').drawImage(st.ov, 0, 0, ov.width, ov.height);
    return { st, side: { ...st.side, corners: st.side.corners.map(p => [...p]) }, base, ov, undo: [], dirty: false, hasOv: !!st.ov, texts: [] };
  };
  let work = states.map(mkWork);
  let tab = 'img', tool = null, color = COLORS[1];
  let structChanged = false, lay = d.idLayout ? { ...d.idLayout } : null;
  const el = document.createElement('div'); el.className = 'ide';
  el.innerHTML = `
    <div class="ide-head"><button class="icon-btn" data-x aria-label="Abbrechen">${icon('x')}</button><div class="ide-title">Bearbeiten</div><button class="btn primary ide-done" data-ok>Fertig</button></div>
    <div class="ide-stage no-swipe"><div class="ide-frame"><canvas class="ide-base"></canvas><canvas class="ide-ov"></canvas><div class="ide-boxes"></div><div class="ide-texts"></div></div></div>
    <div class="ide-pager"><button data-prev>${icon('chevronLeft')}</button><span data-count></span><button data-next>${icon('chevronRight')}</button></div>
    <div class="ide-colors" hidden>${COLORS.map(c => `<button data-c="${c}" style="background:${c}"></button>`).join('')}</div>
    <div class="ide-panel">
      <div class="ide-tabs"><button data-tab="img">Bild</button><button data-tab="mark">Markup</button><button data-tab="pages">Seiten</button></div>
      <div class="ide-tools"></div>
    </div>`;
  document.body.appendChild(el);
  const frame = el.querySelector('.ide-frame'), cb = el.querySelector('.ide-base'), co = el.querySelector('.ide-ov'), stage = el.querySelector('.ide-stage');
  const W = () => work[k];

  const layout = () => {
    const w = W(), r = stage.getBoundingClientRect();
    const s = Math.min((r.width - 24) / w.base.width, (r.height - 24) / w.base.height);
    Object.assign(frame.style, { width: w.base.width * s + 'px', height: w.base.height * s + 'px' });
    cb.width = w.base.width; cb.height = w.base.height; cb.getContext('2d').drawImage(w.base, 0, 0);
    co.width = w.ov.width; co.height = w.ov.height; drawOv(); requestAnimationFrame(paintTexts);
    el.querySelector('[data-count]').textContent = work.length > 1 ? `${k + 1}/${work.length}` : '';
    el.querySelector('.ide-pager').hidden = work.length < 2;
    paintBoxes();
  };
  // ---- Text als verschiebbare Objekte (erst beim Speichern ins Bild gebrannt) ----
  let selT = null;
  const tl = el.querySelector('.ide-texts');
  const paintTexts = () => {
    const w = W(), sc = frame.clientWidth;
    tl.innerHTML = w.texts.map((t, j) => `<div class="ide-txt${t === selT ? ' sel' : ''}" data-j="${j}" style="left:${t.x * 100}%;top:${t.y * 100}%;color:${t.color};font-size:${t.fs * sc}px;font-weight:${t.wt || 600}">${esc(t.t).replace(/\n/g, '<br>')}</div>`).join('')
      + (selT && w.texts.includes(selT) ? `<div class="ide-tbar" style="left:${selT.x * 100}%;top:${selT.y * 100}%">
          <button data-ta="edit">${icon('edit')}</button><button data-ta="minus">A−</button><button data-ta="plus">A+</button><button data-ta="del">${icon('trash')}</button></div>` : '');
    tl.querySelectorAll('[data-j]').forEach(d => d.onpointerdown = e => textDrag(e, w.texts[+d.dataset.j], d));
    tl.querySelectorAll('[data-ta]').forEach(b => b.onpointerdown = e => { e.stopPropagation(); e.preventDefault(); textAct(b.dataset.ta); });
  };
  const textDrag = (e, t, d) => {
    e.stopPropagation(); e.preventDefault();
    const wasSel = selT === t; selT = t; haptic();
    if (!wasSel) paintTexts();
    const r = frame.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, tx = t.x, ty = t.y;
    let moved = false;
    const mv = ev => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (Math.hypot(dx, dy) > 4) moved = true;
      if (!moved) return;
      t.x = Math.min(0.98, Math.max(-0.2, tx + dx / r.width)); t.y = Math.min(1, Math.max(0, ty + dy / r.height));
      const el2 = tl.querySelector(`[data-j="${W().texts.indexOf(t)}"]`), bar = tl.querySelector('.ide-tbar');
      for (const n of [el2, bar]) if (n) { n.style.left = t.x * 100 + '%'; n.style.top = t.y * 100 + '%'; }
    };
    const upH = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', upH); removeEventListener('pointercancel', upH);
      W().dirty = true;
      if (!moved && wasSel) textAct('edit'); else paintTexts();
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', upH); addEventListener('pointercancel', upH);
  };
  const textAct = async a => {
    const w = W(), t = selT; if (!t) return;
    haptic(); w.dirty = true;
    if (a === 'del') { w.texts.splice(w.texts.indexOf(t), 1); selT = null; }
    if (a === 'plus') t.fs = Math.min(0.2, t.fs * 1.2);
    if (a === 'minus') t.fs = Math.max(0.015, t.fs / 1.2);
    if (a === 'edit') { const v = await promptDlg('Text ändern', t.t, 'Fertig'); if (v != null && v.trim()) t.t = v.trim(); }
    paintTexts();
  };
  const addText = async p => {
    const txt = await promptDlg('Text hinzufügen', '', 'Hinzufügen', 'Text');
    if (!txt || !txt.trim()) return;
    const w = W(), t = { t: txt.trim(), x: p[0] / w.ov.width, y: p[1] / w.ov.height, color, fs: 1 / 24 };
    w.texts.push(t); selT = t; w.dirty = true; paintTexts();
    toast('Text ziehen zum Verschieben · nochmal antippen zum Ändern');
  };
  const drawTexts = (x, texts, Wd, Hd) => {
    for (const t of texts) {
      const fs = t.fs * Wd;
      x.font = `${t.wt || 600} ${fs}px -apple-system, Helvetica, Arial, sans-serif`; x.fillStyle = t.color; x.textBaseline = 'middle';
      const ls = t.t.split('\n'), y0 = t.y * Hd - (ls.length - 1) * fs * 0.6;
      ls.forEach((ln, i) => x.fillText(ln, t.x * Wd, y0 + i * fs * 1.2));
    }
  };
  const burnTexts = w => {
    if (!w.texts.length) return;
    drawTexts(w.ov.getContext('2d'), w.texts, w.ov.width, w.ov.height);
    w.texts = []; w.hasOv = true;
  };
  // Fertiges Bild einer Seite inkl. noch verschiebbarer Texte (für Vorschauen)
  const pageCanvas = w => { const c = withOverlay(w.base, w.ov); drawTexts(c.getContext('2d'), w.texts, c.width, c.height); return c; };
  const thumbOf = w => { const c = pageCanvas(w), s = Math.min(1, 420 / c.width); return copyCanvas(c, Math.round(c.width * s), Math.round(c.height * s)).toDataURL('image/jpeg', 0.8); };
  // Tippen ins Leere: Auswahl aufheben bzw. (Text-Werkzeug) neuen Text setzen
  frame.addEventListener('pointerdown', e => {
    if (e.target.closest('.ide-txt, .ide-tbar')) return;
    if (selT) { selT = null; paintTexts(); e.stopPropagation(); }
  }, true);

  const drawOv = () => { const x = co.getContext('2d'); x.clearRect(0, 0, co.width, co.height); x.drawImage(W().ov, 0, 0); };
  const snap = () => { const w = W(); w.undo.push(copyCanvas(w.ov)); if (w.undo.length > 15) w.undo.shift(); w.dirty = true; w.hasOv = true; };

  const TOOLS = {
    img: [['crop', 'fit', 'Ausschneiden'], ['filter', 'sliders', 'Filtern'], ['rot', 'rotate', 'Drehen'], ['retake', 'scan', 'Erneut aufnehmen']],
    mark: [['pen', 'pen', 'Pinsel'], ['text', 'textPlus', 'Text'], ['textedit', 'textEdit', 'Text bearbeiten'], ['smart', 'sparkles', 'Intelligent löschen'], ['mosaic', 'grid', 'Mosaik'], ['wm', 'drop', 'Wasserzeichen'], ['eraser', 'eraser', 'Radierer'], ['undo', 'undo', 'Zurück']],
    pages: [['reorder', 'pages', 'Seiten neu anordnen'], ['collage', 'grid', 'Kollagen'], ['titles', 'rename', 'Seitentitel']],
  };
  const paintTools = () => {
    el.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    el.querySelector('.ide-tools').innerHTML = TOOLS[tab].map(([id, ic, l]) => `<button data-t="${id}" class="${tool === id ? 'on' : ''}">${icon(ic)}<span>${l}</span></button>`).join('');
    el.querySelector('.ide-colors').hidden = !(tool === 'pen' || tool === 'text' || selT);
    el.querySelectorAll('[data-c]').forEach(b => b.classList.toggle('on', b.dataset.c === color));
    el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => action(b.dataset.t));
    co.style.pointerEvents = tool ? 'auto' : 'none';
    paintBoxes();
  };
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; tool = null; haptic(); paintTools(); });
  el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { color = b.dataset.c; if (selT) { selT.color = color; W().dirty = true; paintTexts(); } haptic(); paintTools(); });

  const rebuildBase = (keepOv = true, rotDeg = 0) => {
    const w = W(), old = w.ov;
    w.base = baseCanvas(w.st.img, w.side, 1600);
    let nov = document.createElement('canvas'); nov.width = w.base.width; nov.height = w.base.height;
    if (keepOv && w.hasOv) { const r = rotDeg ? rotateCanvas(old, rotDeg) : old; nov.getContext('2d').drawImage(r, 0, 0, nov.width, nov.height); }
    else w.hasOv = false;
    w.ov = nov; w.undo = []; w.dirty = true; w.boxes = null; layout();
    if (tool === 'textedit') startTextEdit();
  };

  const action = async t => {
    haptic();
    const w = W();
    if (t === 'crop') {
      if ((w.hasOv || w.texts.length) && !await confirmDlg('Markierungen entfernen?', 'Beim Zuschneiden werden Pinsel, Text und Mosaik dieser Seite entfernt.', 'Weiter')) return;
      const r = await cropEditor({ img: w.st.img, corners: w.side.corners, rot: w.side.rot || 0 });
      if (r) { w.side.corners = r.corners; w.side.rot = r.rot; w.texts = []; selT = null; rebuildBase(false); }
      return;
    }
    if (t === 'rot') { w.side.rot = ((w.side.rot || 0) + 90) % 360; w.texts.forEach(o => { [o.x, o.y] = [1 - o.y, o.x]; }); return rebuildBase(true, 90); }
    if (t === 'filter') return filterSheet();
    if (t === 'undo') { if (!w.undo.length) return toast('Nichts rückgängig zu machen'); w.ov = w.undo.pop(); w.dirty = true; return drawOv(); }
    if (t === 'wm') return watermark();
    if (t === 'retake') return retake();
    if (t === 'reorder') return doReorder();
    if (t === 'collage') return doCollage();
    if (t === 'titles') return doTitles();
    tool = tool === t ? null : t; paintTools();
    if (tool === 'textedit') return startTextEdit();
    if (tool === 'text') toast('Auf das Bild tippen, wo der Text hin soll');
    if (tool !== 'text' && selT) { selT = null; paintTexts(); }
    if (tool === 'mosaic') toast('Über Bereiche wischen, die unkenntlich werden sollen');
    if (tool === 'smart') toast('Über Text oder Flecken wischen – wird mit dem Hintergrund aufgefüllt');
  };

  const filterSheet = () => {
    const w = W();
    sheet({
      title: 'Filter',
      html: `<div class="ide-filters">${CARD_FILTERS.map(([f, l]) => `<button data-f="${f}" class="${(w.side.filter ?? 'card') === f ? 'on' : ''}"><img alt=""><span>${l}</span></button>`).join('')}</div>`,
      onMount(s, api) {
        s.querySelectorAll('[data-f]').forEach(b => {
          b.querySelector('img').src = baseCanvas(w.st.img, { ...w.side, filter: b.dataset.f }, 260).toDataURL('image/jpeg', 0.8);
          b.onclick = () => { w.side.filter = b.dataset.f; api.close(); rebuildBase(true); };
        });
      },
    });
  };

  const watermark = async () => {
    const txt = await promptDlg('Wasserzeichen', settings.get('idWm') || 'Nur zur Vorlage', 'Hinzufügen', 'z. B. Kopie – nur für Mietvertrag');
    if (!txt || !txt.trim()) return;
    settings.set('idWm', txt.trim());
    for (const w of work) {                      // auf alle Seiten
      const cur = k; k = work.indexOf(w); snap(); k = cur;
      const x = w.ov.getContext('2d'), fs = Math.round(w.ov.width / 18);
      x.save(); x.font = `700 ${fs}px -apple-system, Helvetica, Arial, sans-serif`; x.fillStyle = 'rgba(90,90,90,.32)';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.translate(w.ov.width / 2, w.ov.height / 2); x.rotate(-24 * Math.PI / 180);
      const tw = x.measureText(txt).width + fs * 2.2, D = Math.hypot(w.ov.width, w.ov.height);
      for (let yy = -D / 2; yy <= D / 2; yy += fs * 2.6) for (let xx = -D / 2 + ((yy / (fs * 2.6)) % 2 ? tw / 2 : 0); xx <= D / 2; xx += tw) x.fillText(txt.trim(), xx, yy);
      x.restore();
    }
    drawOv(); toast('Wasserzeichen auf allen Seiten');
  };

  // ---- Text bearbeiten: Text erkennen → antippen → ändern. Alter Text wird intelligent entfernt,
  //      neuer Text in passender Farbe/Größe als verschiebbares Objekt eingesetzt. ----
  const bl = el.querySelector('.ide-boxes');
  function paintBoxes() {
    const w = W();
    if (tool !== 'textedit' || !w?.boxes) { bl.innerHTML = ''; bl.classList.remove('on'); return; }
    bl.classList.add('on');
    bl.innerHTML = w.boxes.map((b, j) => `<button data-b="${j}" aria-label="${esc(b.t)}" style="left:${b.b[0] * 100}%;top:${b.b[1] * 100}%;width:${(b.b[2] - b.b[0]) * 100}%;height:${(b.b[3] - b.b[1]) * 100}%"></button>`).join('');
    bl.querySelectorAll('[data-b]').forEach(b => b.onclick = e => { e.stopPropagation(); editBox(+b.dataset.b); });
  }
  async function startTextEdit() {
    const w = W();
    if (selT) { selT = null; paintTexts(); }
    if (!w.boxes) {
      busy(true, 'Text wird erkannt …');
      try {
        const c = withOverlay(w.base, w.ov);
        let done = false;
        if (onlineReady()) {                    // KI von TextIn (CamScanner-Technik), wenn eingerichtet
          busy(true, 'KI liest den Text …');
          try { w.boxes = await onlineOcr(c); done = true; }
          catch (e) { console.warn(e); toast(`Online-KI nicht erreichbar (${e.message}) – lese auf dem Gerät`, true); }
        }
        if (!done) {
          const { recognizeEditLines } = await import('./ocr.js');
          w.boxes = await recognizeEditLines(c, { onProgress: p => busy(true, `Text wird erkannt … ${Math.round(p * 100)} %`) });
        }
      } catch (e) { console.warn(e); busy(false); tool = null; paintTools(); return toast('Texterkennung fehlgeschlagen', true); }
      busy(false);
    }
    if (tool !== 'textedit' || W() !== w) return;
    paintBoxes();
    toast(w.boxes.length ? 'Text antippen zum Ändern – fehlt etwas? Rahmen darum ziehen' : 'Rahmen um den Text ziehen, den du ändern willst');
  }
  async function editBox(j) {
    const w = W(), b = w.boxes[j]; if (!b) return;
    if (await replaceText(w, b, b.t)) { w.boxes.splice(j, 1); paintBoxes(); }
  }
  // Text in einem Kasten ersetzen: alt intelligent entfernen, neu in gemessener Farbe/Größe einsetzen
  async function replaceText(w, b, old) {
    const v = await promptDlg('Text bearbeiten', old, 'Fertig', 'Leer lassen = Text entfernen');
    if (v == null || (old && v === old)) return false;
    const Wd = w.ov.width, Hd = w.ov.height;
    const x0 = b.b[0] * Wd, y0 = b.b[1] * Hd, x1 = b.b[2] * Wd, y1 = b.b[3] * Hd, h = y1 - y0;
    const col = inkColor(withOverlay(w.base, w.ov), x0, y0, x1, y1);
    snap();
    const m = document.createElement('canvas'); m.width = Wd; m.height = Hd;
    const p = Math.max(3, h * 0.22); m.getContext('2d').fillRect(x0 - p, y0 - p, x1 - x0 + 2 * p, h + 2 * p);
    busy(true, 'Text wird ersetzt …'); await tick();
    try { smartErase(w, m); } catch (e) { console.warn(e); }
    busy(false); drawOv();
    if (v.trim()) {
      const th = (b.h || (b.b[3] - b.b[1])) * Hd;
      w.texts.push({ t: v.trim(), x: x0 / Wd, y: (y0 + h / 2) / Hd, color: col, fs: th * 1.15 / Wd, wt: 500 }); paintTexts();
    }
    w.dirty = true; haptic();
    toast(v.trim() ? 'Text ersetzt – antippen zum Verschieben oder Anpassen' : 'Text entfernt');
    return true;
  }
  // Nicht erkannt? Rahmen um den Text ziehen → dieser Ausschnitt wird gezielt gelesen
  async function editRect(r) {
    const w = W(), Wd = w.ov.width, Hd = w.ov.height;
    const x0 = Math.max(0, Math.min(r[0], r[2])), y0 = Math.max(0, Math.min(r[1], r[3])), x1 = Math.min(Wd, Math.max(r[0], r[2])), y1 = Math.min(Hd, Math.max(r[1], r[3]));
    if (x1 - x0 < 12 || y1 - y0 < 8) return;
    const comp = withOverlay(w.base, w.ov), cw = Math.round(x1 - x0), ch = Math.round(y1 - y0);
    const crop = document.createElement('canvas'); crop.width = cw; crop.height = ch;
    crop.getContext('2d').drawImage(comp, x0, y0, cw, ch, 0, 0, cw, ch);
    let box = { b: [x0 / Wd, y0 / Hd, x1 / Wd, y1 / Hd], h: 0 }, txt = '';
    busy(true, 'Text wird gelesen …');
    try {
      const { recognizeEditLines } = await import('./ocr.js');
      const ls = (await recognizeEditLines(crop, { crop: true })).sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0]);
      if (ls.length) {
        txt = ls.map(l => l.t).join(' ');
        const u = [Math.min(...ls.map(l => l.b[0])), Math.min(...ls.map(l => l.b[1])), Math.max(...ls.map(l => l.b[2])), Math.max(...ls.map(l => l.b[3]))];
        box = { b: [(x0 + u[0] * cw) / Wd, (y0 + u[1] * ch) / Hd, (x0 + u[2] * cw) / Wd, (y0 + u[3] * ch) / Hd], h: ls[0].h * ch / Hd };
      } else {                                  // nichts gelesen: Kasten auf die Schrift im Rahmen verkleinern
        const k = inkBox(crop);
        if (k) box = { b: [(x0 + k[0]) / Wd, (y0 + k[1]) / Hd, (x0 + k[2]) / Wd, (y0 + k[3]) / Hd], h: (k[3] - k[1]) / Hd };
      }
    } catch (e) { console.warn(e); }
    busy(false);
    await replaceText(w, box, txt);
  }

  // ---- Erneut aufnehmen: Foto dieser Seite ersetzen ----
  async function retake() {
    const w = W();
    if ((w.hasOv || w.texts.length) && !await confirmDlg('Seite neu aufnehmen?', 'Markierungen und Text dieser Seite werden dabei entfernt.', 'Weiter', false)) return;
    const shot = await takePhoto(d.idCat); if (!shot) return;
    const r = await cropEditor(shot); if (!r) return;
    w.st = { ...w.st, img: shot.img };
    Object.assign(w.side, { corners: r.corners, rot: r.rot });
    w.texts = []; selT = null; w.imgChanged = true;
    rebuildBase(false); paintTexts(); toast(`${sideName(work.length, k, w.side.title)} ersetzt`);
  }
  const newWork = async () => {
    const shot = await takePhoto(d.idCat); if (!shot) return null;
    const r = await cropEditor(shot); if (!r) return null;
    const nw = mkWork({ i: -1, img: shot.img, side: { corners: r.corners, rot: r.rot, filter: 'card', ov: false }, ov: null });
    nw.imgChanged = true; nw.dirty = true;
    return nw;
  };

  // ---- Menü „Seiten“ ----
  async function doReorder() {
    if (selT) { selT = null; paintTexts(); }
    const r = await reorderPages(work.map(w => ({ src: thumbOf(w), title: w.side.title })));
    if (!r) return;
    const nw = r.order.map(i => work[i]);
    if (nw.length === work.length && nw.every((w, i) => w === work[i])) return;
    work = nw; structChanged = true; k = Math.min(k, work.length - 1); layout();
    toast('Übernommen – mit „Fertig“ speichern');
  }
  async function doCollage() {
    if (selT) { selT = null; paintTexts(); }
    const items = work.map(w => ({ ref: w, img: pageCanvas(w), adj: adjOf(w.side) }));
    const r = await collage(items, {
      layout: lay || { tpl: defaultTpl(d.idCat, d.idSize), size: 'a4', wm: '' },
      addPage: async () => { const w = await newWork(); return w && { ref: w, img: pageCanvas(w), adj: adjOf(w.side) }; },
    });
    if (!r) return;
    lay = r.layout;
    work = r.items.map(it => { it.ref.side.col = it.adj; return it.ref; });
    structChanged = true; k = Math.min(k, work.length - 1); layout();
    toast('Collage übernommen – mit „Fertig“ speichern');
  }
  async function doTitles() {
    const r = await titlesSheet(work.map(w => ({ src: thumbOf(w), title: w.side.title || '' })), i => sideName(work.length, i));
    if (!r) return;
    let n = 0;
    r.forEach((t, i) => { if ((work[i].side.title || '') !== t) { work[i].side.title = t; work[i].dirty = true; n++; } });
    if (n) toast('Seitentitel übernommen');
  }

  // Zeichnen auf der Markierungs-Ebene
  let last = null, mosaicDone = null, baseData = null;
  const pt = e => { const r = co.getBoundingClientRect(); return [(e.clientX - r.left) * co.width / r.width, (e.clientY - r.top) * co.height / r.height]; };
  const mosaicAt = ([x, y]) => {
    const w = W(), B = Math.max(8, Math.round(w.ov.width / 70)), R = w.ov.width / 28, oc = w.ov.getContext('2d');
    baseData ||= w.base.getContext('2d').getImageData(0, 0, w.base.width, w.base.height).data;
    for (let by = Math.floor((y - R) / B); by <= Math.floor((y + R) / B); by++) for (let bx = Math.floor((x - R) / B); bx <= Math.floor((x + R) / B); bx++) {
      const key = by * 100000 + bx; if (mosaicDone.has(key)) continue;
      if (Math.hypot(bx * B + B / 2 - x, by * B + B / 2 - y) > R) continue;
      mosaicDone.add(key);
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = by * B; yy < by * B + B; yy += 2) for (let xx = bx * B; xx < bx * B + B; xx += 2) {
        if (xx < 0 || yy < 0 || xx >= w.base.width || yy >= w.base.height) continue;
        const i = (yy * w.base.width + xx) * 4; r += baseData[i]; g += baseData[i + 1]; b += baseData[i + 2]; n++;
      }
      if (!n) continue;
      oc.fillStyle = `rgb(${r / n | 0},${g / n | 0},${b / n | 0})`; oc.fillRect(bx * B, by * B, B, B);
    }
  };
  co.addEventListener('pointerdown', async e => {
    if (!tool) return;
    e.preventDefault(); co.setPointerCapture(e.pointerId);
    const p = pt(e), w = W();
    if (tool === 'text') return addText(p);
    if (tool === 'textedit') { last = p; rectStart = p; return; }
    if (tool === 'smart') { last = p; smartMask = document.createElement('canvas'); smartMask.width = w.ov.width; smartMask.height = w.ov.height; smartStroke(p, p); return; }
    snap(); last = p; mosaicDone = new Set(); baseData = null;
    if (tool === 'mosaic') { mosaicAt(p); drawOv(); }
  });
  // Intelligentes Löschen: Pinselspur als Maske sammeln (halbtransparent anzeigen), beim Loslassen füllen
  let smartMask = null;
  const smartStroke = (a, b) => {
    const m = smartMask.getContext('2d');
    m.strokeStyle = '#ff6a4d'; m.lineCap = m.lineJoin = 'round'; m.lineWidth = smartMask.width / 32;
    m.beginPath(); m.moveTo(a[0], a[1]); m.lineTo(b[0], b[1]); m.stroke();
    drawOv(); const x = co.getContext('2d'); x.save(); x.globalAlpha = 0.5; x.drawImage(smartMask, 0, 0); x.restore();
  };
  co.addEventListener('pointermove', e => {
    if (!last) return;
    const p = pt(e), w = W(), x = w.ov.getContext('2d');
    if (tool === 'smart') { smartStroke(last, p); last = p; return; }
    if (tool === 'textedit') {
      last = p; drawOv();
      const x = co.getContext('2d'); x.save(); x.strokeStyle = '#ff6a5b'; x.lineWidth = co.width / 300; x.setLineDash([co.width / 90, co.width / 150]);
      x.fillStyle = 'rgba(255,106,91,.12)'; x.fillRect(rectStart[0], rectStart[1], p[0] - rectStart[0], p[1] - rectStart[1]);
      x.strokeRect(rectStart[0], rectStart[1], p[0] - rectStart[0], p[1] - rectStart[1]); x.restore();
      return;
    }
    if (tool === 'mosaic') {
      const n = Math.ceil(Math.hypot(p[0] - last[0], p[1] - last[1]) / (w.ov.width / 80)) || 1;
      for (let i = 1; i <= n; i++) mosaicAt([last[0] + (p[0] - last[0]) * i / n, last[1] + (p[1] - last[1]) * i / n]);
    } else {
      x.save();
      if (tool === 'eraser') x.globalCompositeOperation = 'destination-out';
      x.strokeStyle = color; x.lineCap = x.lineJoin = 'round';
      x.lineWidth = w.ov.width / (tool === 'eraser' ? 40 : 220);
      x.beginPath(); x.moveTo(last[0], last[1]); x.lineTo(p[0], p[1]); x.stroke(); x.restore();
    }
    last = p; drawOv();
  });
  let rectStart = null;
  const up = () => {
    if (tool === 'textedit' && rectStart && last) {
      const r = [...rectStart, ...last]; rectStart = null; last = null; drawOv();
      editRect(r); return;
    }
    if (tool === 'smart' && smartMask && last) {
      const m = smartMask; smartMask = null; last = null;
      snap(); busy(true, 'Wird entfernt …');
      setTimeout(() => { try { smartErase(W(), m); } catch (e) { console.warn(e); toast('Konnte nicht entfernt werden', true); } busy(false); drawOv(); }, 30);
      return;
    }
    last = null;
  };
  co.addEventListener('pointerup', up); co.addEventListener('pointercancel', up);

  const go = n => { selT = null; k = n; haptic(); layout(); if (tool === 'textedit') startTextEdit(); };
  el.querySelector('[data-prev]').onclick = () => { if (k > 0) go(k - 1); };
  el.querySelector('[data-next]').onclick = () => { if (k < work.length - 1) go(k + 1); };
  const close = () => { removeEventListener('resize', layout); el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.querySelector('[data-x]').onclick = async () => {
    if (work.some(w => w.dirty) && !await confirmDlg('Änderungen verwerfen?', 'Deine Bearbeitung geht verloren.', 'Verwerfen')) return;
    close();
  };
  el.querySelector('[data-ok]').onclick = async () => {
    if (!structChanged && !work.some(w => w.dirty)) return close();
    busy(true, 'Wird gespeichert …');
    try {
      const oldN = d.idSides.length, imgBytes = [];
      // Fotos zuerst einlesen, bevor durch neue Reihenfolge etwas überschrieben wird
      for (let j = 0; j < work.length; j++) {
        const w = work[j];
        if (w.imgChanged) imgBytes[j] = await canvasBytes(toCanvas(w.st.img, 2600), 'image/jpeg', 0.9);
        else if (w.st.i !== j) imgBytes[j] = (await db.get('files', sideKey(d.id, w.st.i)))?.data;
      }
      for (let j = 0; j < work.length; j++) {
        const w = work[j], moved = w.st.i !== j;
        if (imgBytes[j]) await db.put('files', { id: sideKey(d.id, j), data: imgBytes[j] });
        if (w.dirty || moved) {
          burnTexts(w);
          if (w.hasOv) await db.put('files', { id: ovKey(d.id, j), data: await canvasBytes(w.ov, 'image/png') });
          else await db.del('files', ovKey(d.id, j));
        }
        w.st = { ...w.st, i: j, side: { ...w.side, ov: !!w.hasOv }, ov: w.hasOv ? copyCanvas(w.ov) : null };
      }
      for (let j = work.length; j < oldN; j++) { await db.del('files', sideKey(d.id, j)); await db.del('files', ovKey(d.id, j)); }
      d.idSides = work.map(w => w.st.side);
      if (lay) d.idLayout = lay;
      view.states = work.map(w => w.st);
      delete d.idOcr;                           // Bild geändert → Texterkennung neu
      await rebuildPdf(d, view.states);
      busy(false); toast('Gespeichert'); close(); paintView();
    } catch (e) { console.error(e); busy(false); toast('Speichern fehlgeschlagen', true); }
  };
  addEventListener('resize', layout);
  paintTools();
  requestAnimationFrame(layout);
}

// ---------- ID-Angaben (Formular + Text antippen) ----------
const yymmdd = (s, future) => {
  if (!/^\d{6}$/.test(s)) return '';
  const yy = +s.slice(0, 2), now = new Date().getFullYear() % 100;
  const y = future ? 2000 + yy : (yy > now ? 1900 + yy : 2000 + yy);
  return `${s.slice(4, 6)}.${s.slice(2, 4)}.${y}`;
};
const titleCase = s => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
const BANKS = ['ING', 'Sparkasse', 'Volksbank', 'Raiffeisenbank', 'Commerzbank', 'Deutsche Bank', 'Postbank', 'DKB', 'N26', 'Comdirect', 'Consorsbank', 'HypoVereinsbank', 'Santander', 'Targobank', 'PSD Bank', 'Sparda-Bank', 'BW-Bank', 'Revolut', 'Wise', 'C24', 'Norisbank', '1822direkt', 'Barclays', 'Hanseatic Bank', 'Advanzia', 'American Express', 'Trade Republic', 'Openbank', 'Tomorrow', 'Vivid'];

// ---- MRZ: Prüfziffern (7-3-1) machen das Ergebnis sicher ----
const mrzVal = c => c === '<' ? 0 : /\d/.test(c) ? +c : c.charCodeAt(0) - 55;
const mrzCheck = s => [...s].reduce((a, c, i) => a + mrzVal(c) * [7, 3, 1][i % 3], 0) % 10;
const NUM = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', B: '8', G: '6' };
const toNum = s => s.replace(/[A-Z]/g, c => NUM[c] || c);
// Feld + Prüfziffer prüfen; bei Fehler mehrdeutige Zeichen (O/0, I/1 …) einzeln durchprobieren
function fixField(f, ck, digitsOnly) {
  ck = toNum(ck);
  if (digitsOnly) f = toNum(f);
  for (const g of [f, f.replace(/[OQ]/g, '0'), f.replace(/[OQ]/g, '0').replace(/I/g, '1')]) if (mrzCheck(g) === +ck) return { v: g, ok: true };
  const amb = { O: '0', '0': 'O', I: '1', '1': 'I', S: '5', '5': 'S', B: '8', '8': 'B', Z: '2', '2': 'Z', G: '6', '6': 'G', D: '0', Q: '0', U: 'V', V: 'U', K: '<' };
  for (let i = 0; i < f.length; i++) if (amb[f[i]]) {
    const g = f.slice(0, i) + amb[f[i]] + f.slice(i + 1);
    if (mrzCheck(g) === +ck) return { v: g, ok: true };
  }
  return { v: f, ok: false };
}
const normMrz = l => l.toUpperCase().replace(/\s+/g, '').replace(/«/g, '<<').replace(/[^A-Z0-9<]/g, '<');
const ibanOk = s => { const x = s.replace(/\s+/g, ''); if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(x)) return false;
  const r = (x.slice(4) + x.slice(0, 4)).replace(/[A-Z]/g, c => c.charCodeAt(0) - 55); let m = 0; for (const ch of r) m = (m * 10 + +ch) % 97; return m === 1; };

// Aus erkanntem Text Felder vorschlagen (MRZ bei Ausweis/Pass, IBAN/Bank bei Bankkarten)
function guessInfo(catId, ocr) {
  const lines = ocr.flatMap(o => o.lines), words = ocr.flatMap(o => o.words.filter(w => !w.mrz).map(w => w.t));
  const all = lines.join('\n'), out = {}, ok = new Set();
  const mrzOf = o => (o.mrz?.length ? o.mrz : o.lines).map(normMrz).filter(l => l.length >= 25 && (l.match(/</g) || []).length >= 2);
  const mrz = ocr.flatMap(mrzOf);
  const nm = l => { const [sn, gn] = l.split('<<').filter(Boolean); return sn ? titleCase(((gn || '').replace(/</g, ' ') + ' ' + sn.replace(/</g, ' ')).replace(/\s+/g, ' ').trim()) : ''; };
  const dates = (l2, b, e) => {
    const bd = fixField(l2.slice(b, b + 6), l2[b + 6] || '', true), ed = fixField(l2.slice(e, e + 6), l2[e + 6] || '', true);
    out.birth = yymmdd(bd.v); out.expiry = yymmdd(ed.v, true);
    if (bd.ok) ok.add('birth'); if (ed.ok) ok.add('expiry');
  };
  // Ausweis (TD1, 3 × 30 Zeichen)
  const i1 = mrz.findIndex(l => /^[IAC][A-Z<]/.test(l));
  if (i1 >= 0) {
    // doppelt gelesenes oder fehlendes Zeichen in der Nummer: Varianten über die Prüfziffer testen
    const raw = mrz[i1], de = /^I.D/.test(raw), same = (a, b) => a === b || /^[O0Q]{2}$/.test(a + b) || /^[I1]{2}$/.test(a + b);
    const vars = [{ s: raw, sc: 3 }];
    for (let j = 5; j < 16; j++) {
      vars.push({ s: raw.slice(0, j) + raw.slice(j + 1), sc: same(raw[j], raw[j - 1]) || same(raw[j], raw[j + 1]) ? 2 : 0 });   // doppelt gelesen
      vars.push({ s: raw.slice(0, j) + '<' + raw.slice(j), sc: 0 });
    }
    let l1 = raw.padEnd(30, '<'), num = fixField(l1.slice(5, 14), l1[14], false), best = -1;
    for (const { s: vv, sc } of vars) {
      const L = vv.padEnd(30, '<'), r = fixField(de ? L.slice(5, 14).replace(/[OQ]/g, '0') : L.slice(5, 14), L[14], false);
      if (!r.ok || /</.test(r.v.slice(0, 8))) continue;
      const score = sc + (de && /^[CFGHJKLMNPRTVWXYZ0-9]{9}$/.test(r.v) ? 1 : 0);   // deutsche Ausweisnummern: nur diese Zeichen
      if (score > best) { best = score; l1 = L; num = r; }
    }
    let v = num.v;
    if (/^I.D/.test(l1) && !num.ok) v = v.replace(/O/g, '0');   // deutsche Nummern haben kein O
    out.number = v.replace(/</g, ''); if (num.ok) ok.add('number');
    const l2 = mrz.slice(i1 + 1).find(l => /^\d|^[OQDISBZG]/.test(l)), l3 = mrz.slice(i1 + 1).find(l => /^[A-Z]+<</.test(l) && l !== l2);
    if (l2) dates(l2.padEnd(30, '<'), 0, 8);
    if (l3) { out.name = nm(l3); if (out.name) ok.add('name'); }
  }
  // Reisepass (TD3, 2 × 44)
  const p1 = mrz.find(l => /^P[A-Z<]/.test(l) && l.length > 34);
  if (p1) {
    out.name = nm(p1.slice(5)); if (out.name) ok.add('name');
    const p2 = mrz[mrz.indexOf(p1) + 1];
    if (p2) { const l = p2.padEnd(44, '<'), num = fixField(l.slice(0, 9), l[9], false); out.number = num.v.replace(/</g, ''); if (num.ok) ok.add('number'); dates(l, 13, 21); }
  }
  // MRZ hat keine Umlaute: SCHAEFER → Schäfer, wenn die Vorderseite es so schreibt
  if (out.name) {
    const um = s => s.replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS');
    out.name = out.name.split(' ').map(p => { const w = words.find(x => /[ÄÖÜß]/.test(x) && um(x.toUpperCase()) === p.toUpperCase()); return w ? titleCase(w) : p; }).join(' ');
  }
  if (catId === 'bank' || !out.number) {
    // IBAN: alle Kandidaten (auch mit O/0-Verwechslung) über die Prüfsumme testen
    const cands = [...all.toUpperCase().matchAll(/\b([A-Z]{2}[0-9OIL]{2}(?:\s?[0-9A-Z]{2,4}){3,8})/g)].map(m => m[1]);
    for (const c of cands) {
      const x = c.replace(/\s+/g, ''), fixed = x.slice(0, 2) + toNum(x.slice(2));
      const cand = [fixed, x, fixed.slice(0, 22), fixed.slice(0, 22 - 1)].find(ibanOk) || (fixed.startsWith('DE') ? fixed.slice(0, 22) : null);
      if (cand && catId === 'bank') { out.number = cand.replace(/(.{4})/g, '$1 ').trim(); if (ibanOk(cand)) ok.add('number'); break; }
    }
    const bk = BANKS.find(b => new RegExp(`(^|\\W)${b.replace(/[-]/g, '\\-')}(\\W|$)`, 'i').test(all));
    if (bk && catId === 'bank') out.bank = bk === 'ING' && /DiBa/i.test(all) ? 'ING-DiBa' : bk;
    const ex = all.match(/\b(0[1-9]|1[0-2])\s?\/\s?(\d{2})\b/);
    if (ex && catId === 'bank') out.expiry = `${ex[1]}/${ex[2]}`;
    if (catId === 'bank' && !out.name) {
      const skip = /GIRO|MAESTRO|DEBIT|IBAN|VISA|MASTER|BANK|CARD|GÜLTIG|VALID|ING|KARTEN|TELEFON|FRANKFURT|AG\b/;
      const nm = lines.find(l => /^[A-ZÄÖÜ][A-ZÄÖÜ\-]+(\s+[A-ZÄÖÜ][A-ZÄÖÜ\-]+){1,3}$/.test(l.trim()) && !skip.test(l.toUpperCase()));
      if (nm) out.name = titleCase(nm.trim());
    }
  }
  if (catId === 'driver') {
    const n5 = all.match(/\b5\.?\s+([A-Z0-9]{9,12})\b/); if (n5) out.number = n5[1];
    const ln = n => lines.find(l => new RegExp(`^\\s*${n}\\.\\s`).test(l))?.replace(new RegExp(`^\\s*${n}\\.\\s*`), '').trim();
    if (ln(1) || ln(2)) out.name = titleCase(`${ln(2) || ''} ${ln(1) || ''}`.trim());
    const e = all.match(/4b\.?\s*(\d{2}\.\d{2}\.\d{4})/); if (e) out.expiry = e[1];
    const k = ln(9); if (k) out.classes = k.replace(/\s+/g, ', ');
  }
  if (!out.expiry && catId !== 'bank') {
    const ds = [...all.matchAll(/\b(\d{2}\.\d{2}\.\d{4})\b/g)].map(m => m[1]);
    if (ds.length) out.expiry = ds.sort((a, b) => b.split('.').reverse().join('').localeCompare(a.split('.').reverse().join('')))[0];
  }
  out._ok = ok;
  return out;
}

async function infoForm(autoFill) {
  const d = view.d;
  let cat = d.idCat || 'other';
  const vals = { ...(d.idInfo || {}) };
  // Ergebnis merken: v3 = TextIn-KI, v2 = Gerät (mit eingerichteter KI nur v3 übernehmen)
  let focus = 'name', ocr = d.idOcrV === 3 || (d.idOcrV === 2 && !onlineReady()) ? d.idOcr : null;
  const el = document.createElement('div'); el.className = 'idf';
  el.innerHTML = `
    <div class="idf-head"><button class="icon-btn" data-x aria-label="Zurück">${icon('chevronLeft')}</button><div class="idf-title">ID-Info bearbeiten</div><button class="link-btn" data-ok>Speichern</button></div>
    <div class="idf-scroll">
      <div class="idf-fields"></div>
      <div class="idf-hint"><span data-hint>Text wird erkannt …</span><button class="link-btn" data-auto>Ausfüllen</button></div>
      <div class="idf-imgs">${view.states.map((_, k) => `<div class="idf-img" data-k="${k}"><img alt=""><div class="idf-boxes"></div></div>`).join('')}</div>
    </div>`;
  document.body.appendChild(el);
  const paintFields = () => {
    el.querySelector('.idf-fields').innerHTML = `
      <button class="idf-row" data-type><span>ID-Typ</span><b>${esc(idCat(cat).label)}</b>${icon('chevronRight')}</button>
      ${fieldsFor(cat).map(([k, l, ph]) => `<label class="idf-row"><span>${l}</span><input data-f="${k}" value="${esc(vals[k] || '')}" placeholder="${esc(ph)}" autocomplete="off" autocapitalize="${k === 'name' || k === 'bank' ? 'words' : 'characters'}"></label>`).join('')}`;
    el.querySelectorAll('[data-f]').forEach(i => { i.oninput = () => { vals[i.dataset.f] = i.value; i.closest('.idf-row').classList.remove('ok'); }; i.onfocus = () => { focus = i.dataset.f; }; });
    el.querySelector('[data-type]').onclick = () => sheet({
      title: 'ID-Typ',
      html: `<div class="menu">${ID_CATS.filter(c => c.sides > 0).map(c => `<button class="row" data-c="${c.id}"><span class="row-ic ${c.c}">${icon(c.icon)}</span><span class="row-main"><span class="row-title">${c.label}</span></span>${c.id === cat ? icon('check') : ''}</button>`).join('')}</div>`,
      onMount(s, api) { s.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { cat = b.dataset.c; api.close(); paintFields(); }); },
    });
  };
  paintFields();
  view.states.forEach((st, k) => { el.querySelector(`[data-k="${k}"] img`).src = withOverlay(baseCanvas(st.img, st.side, 1200), st.ov).toDataURL('image/jpeg', 0.86); });

  const paintBoxes = () => {
    el.querySelector('[data-hint]').textContent = ocr ? 'Tippen, um Text auf dem Bild auszuwählen' : 'Keine Texterkennung';
    if (!ocr) return;
    ocr.forEach((o, k) => {
      const host = el.querySelector(`[data-k="${k}"] .idf-boxes`); if (!host) return;
      host.innerHTML = o.words.map((w, j) => `<button data-w="${j}" class="${w.mrz ? 'mrz' : ''}" style="left:${w.b[0] * 100}%;top:${w.b[1] * 100}%;width:${(w.b[2] - w.b[0]) * 100}%;height:${(w.b[3] - w.b[1]) * 100}%"></button>`).join('');
      host.querySelectorAll('[data-w]').forEach(b => b.onclick = () => {
        const t = o.words[+b.dataset.w].t, inp = el.querySelector(`[data-f="${focus}"]`) || el.querySelector('[data-f]');
        const k2 = inp.dataset.f;
        vals[k2] = vals[k2] ? `${vals[k2]} ${t}` : t; inp.value = vals[k2];
        b.classList.add('hit'); haptic();
      });
    });
  };
  const applyGuess = (onlyEmpty) => {
    if (!ocr) return toast('Kein Text erkannt', true);
    const g = guessInfo(cat, ocr); let n = 0, v = 0;
    for (const [k] of fieldsFor(cat)) if (g[k] && (!onlyEmpty || !vals[k])) { vals[k] = g[k]; n++; if (g._ok.has(k)) v++; }
    paintFields();
    el.querySelectorAll('[data-f]').forEach(i => i.closest('.idf-row').classList.toggle('ok', g._ok.has(i.dataset.f) && vals[i.dataset.f] === g[i.dataset.f]));
    toast(!n ? 'Nichts Passendes gefunden – Text auf dem Bild antippen'
      : v === n ? `${n} ${n === 1 ? 'Feld' : 'Felder'} ausgefüllt – per Prüfziffer bestätigt ✓`
      : `${n} ${n === 1 ? 'Feld' : 'Felder'} ausgefüllt${v ? `, ${v} bestätigt ✓` : ''} – bitte prüfen`, !n);
  };
  el.querySelector('[data-auto]').onclick = () => { haptic(); applyGuess(false); };
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.querySelector('[data-x]').onclick = close;
  el.querySelector('[data-ok]').onclick = async () => {
    const info = {}; for (const [k] of fieldsFor(cat)) if (vals[k]?.trim()) info[k] = vals[k].trim();
    d.idInfo = info; d.idCat = cat; d.updated = Date.now();
    await db.put('docs', d); haptic(); toast('ID-Angaben gespeichert'); close(); paintView();
  };

  if (ocr) { paintBoxes(); if (autoFill) applyGuess(true); return; }
  // Texterkennung: TextIn-KI (wenn eingerichtet), sonst lokal mit Tesseract
  const hint = t => { const h = el.querySelector('[data-hint]'); if (h) h.textContent = t; };
  try {
    const cs = view.states.map(st => baseCanvas(st.img, st.side, 1800));
    let v = 2;
    ocr = null;
    if (onlineReady()) {
      try {
        hint('KI liest den Text …');
        const isMrz = t => { const x = t.replace(/\s+/g, ''); return x.length >= 25 && (x.match(/</g) || []).length >= 3; };
        const res = [];
        for (const c of cs) {
          const ls = await onlineOcr(c);
          res.push({ words: ls.map(l => ({ t: l.t, b: l.b, mrz: isMrz(l.t) })), lines: ls.map(l => l.t), mrz: ls.filter(l => isMrz(l.t)).map(l => l.t.replace(/\s+/g, '')) });
        }
        ocr = res; v = 3;
      } catch (e) { console.warn(e); toast(`Online-KI nicht erreichbar (${e.message}) – lese auf dem Gerät`, true); }
    }
    if (!ocr) {
      const { recognizeWords } = await import('./ocr.js');
      ocr = await recognizeWords(cs, { onProgress: p => hint(`Text wird erkannt … ${Math.round(p * 100)} %`) });
    }
    d.idOcr = ocr; d.idOcrV = v; await db.put('docs', d);
    if (!el.isConnected) return;
    paintBoxes(); if (autoFill) applyGuess(true);
  } catch (e) { console.warn(e); if (el.isConnected) { ocr = null; paintBoxes(); } }
}
