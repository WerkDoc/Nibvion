// ================= Ausweise: Ansicht, ID-Angaben, Bild-Editor =================
// Ein Ausweis wird als PDF (A4, Vorder- und Rückseite) gespeichert. Zusätzlich bleiben die
// Original-Fotos je Seite erhalten, damit man später neu zuschneiden, filtern und markieren kann:
//   meta.idSides = [{ corners, rot, filter, ov }]           (in „docs“)
//   files `${id}#s${i}` = Original-Foto (JPEG), `${id}#o${i}` = Markierungen (PNG, transparent)
//   meta.idInfo = { name, number, … }  ·  meta.idSize = 'large' | 'orig'  ·  meta.idOcr = erkannte Wörter
import { db } from './db.js';
import { icon } from './icons.js';
import { toast, busy, sheet, confirmDlg, promptDlg, esc, haptic } from './ui.js';
import { loadPdf, closePdf, renderThumb, imagesToPdf } from './pdfcore.js';
import { cropEditor, render, toCanvas, rotateCanvas } from './scanner.js';
import { settings } from './settings.js';
import { ID_CATS, idCat } from './files.js';
import { shareBytes } from './editor.js';
import { moveToTrash } from './trash.js';

let ctx = {};
export function initIdView(c) { ctx = c; }

const today = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
const nowHM = () => new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }).replace(':', '.');
const tick = () => new Promise(r => setTimeout(r, 0));
const sideKey = (id, i) => `${id}#s${i}`, ovKey = (id, i) => `${id}#o${i}`;
const sideName = (n, i) => n === 1 ? 'Datenseite' : i === 0 ? 'Vorderseite' : 'Rückseite';

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
  return imagesToPdf([c.toDataURL('image/jpeg', 0.92)], { margin: 0 });
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
      ${states.map((st, k) => `<button class="idv-side" data-side="${k}"><img alt="${sideName(states.length, k)}"></button>`).join('')}
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
  const fname = () => `${d.name.replace(/\.pdf$/i, '')} ${sideName(states.length, k)}.jpg`;
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

// ---------- Bild-Editor (Ausschneiden, Filtern, Drehen, Pinsel, Text, Mosaik, Wasserzeichen) ----------
const CARD_FILTERS = [['card', 'Foto'], ['', 'Original'], ['gray', 'Graustufen'], ['bw', 'Schwarz-Weiß']];
const COLORS = ['#111111', '#e11d48', '#2563eb', '#16a34a', '#ffffff'];

function imageEditor(k) {
  const { states, d } = view;
  // Arbeitskopie je Seite: Basis + Markierungs-Ebene
  const work = states.map(st => {
    const base = baseCanvas(st.img, st.side, 1600);
    const ov = document.createElement('canvas'); ov.width = base.width; ov.height = base.height;
    if (st.ov) ov.getContext('2d').drawImage(st.ov, 0, 0, ov.width, ov.height);
    return { st, side: { ...st.side, corners: st.side.corners.map(p => [...p]) }, base, ov, undo: [], dirty: false, hasOv: !!st.ov };
  });
  let tab = 'img', tool = null, color = COLORS[1];
  const el = document.createElement('div'); el.className = 'ide';
  el.innerHTML = `
    <div class="ide-head"><button class="icon-btn" data-x aria-label="Abbrechen">${icon('x')}</button><div class="ide-title">Bearbeiten</div><button class="btn primary ide-done" data-ok>Fertig</button></div>
    <div class="ide-stage no-swipe"><div class="ide-frame"><canvas class="ide-base"></canvas><canvas class="ide-ov"></canvas></div></div>
    <div class="ide-pager"><button data-prev>${icon('chevronLeft')}</button><span data-count></span><button data-next>${icon('chevronRight')}</button></div>
    <div class="ide-colors" hidden>${COLORS.map(c => `<button data-c="${c}" style="background:${c}"></button>`).join('')}</div>
    <div class="ide-panel">
      <div class="ide-tabs"><button data-tab="img">Bild</button><button data-tab="mark">Markup</button></div>
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
    co.width = w.ov.width; co.height = w.ov.height; drawOv();
    el.querySelector('[data-count]').textContent = work.length > 1 ? `${k + 1}/${work.length}` : '';
    el.querySelector('.ide-pager').hidden = work.length < 2;
  };
  const drawOv = () => { const x = co.getContext('2d'); x.clearRect(0, 0, co.width, co.height); x.drawImage(W().ov, 0, 0); };
  const snap = () => { const w = W(); w.undo.push(copyCanvas(w.ov)); if (w.undo.length > 15) w.undo.shift(); w.dirty = true; w.hasOv = true; };

  const TOOLS = {
    img: [['crop', 'fit', 'Ausschneiden'], ['filter', 'sliders', 'Filtern'], ['rot', 'rotate', 'Drehen']],
    mark: [['pen', 'pen', 'Pinsel'], ['text', 'textPlus', 'Text'], ['mosaic', 'grid', 'Mosaik'], ['wm', 'drop', 'Wasserzeichen'], ['eraser', 'eraser', 'Radierer'], ['undo', 'undo', 'Zurück']],
  };
  const paintTools = () => {
    el.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    el.querySelector('.ide-tools').innerHTML = TOOLS[tab].map(([id, ic, l]) => `<button data-t="${id}" class="${tool === id ? 'on' : ''}">${icon(ic)}<span>${l}</span></button>`).join('');
    el.querySelector('.ide-colors').hidden = !(tool === 'pen' || tool === 'text');
    el.querySelectorAll('[data-c]').forEach(b => b.classList.toggle('on', b.dataset.c === color));
    el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => action(b.dataset.t));
    co.style.pointerEvents = tool ? 'auto' : 'none';
  };
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; tool = null; haptic(); paintTools(); });
  el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { color = b.dataset.c; haptic(); paintTools(); });

  const rebuildBase = (keepOv = true, rotDeg = 0) => {
    const w = W(), old = w.ov;
    w.base = baseCanvas(w.st.img, w.side, 1600);
    let nov = document.createElement('canvas'); nov.width = w.base.width; nov.height = w.base.height;
    if (keepOv && w.hasOv) { const r = rotDeg ? rotateCanvas(old, rotDeg) : old; nov.getContext('2d').drawImage(r, 0, 0, nov.width, nov.height); }
    else w.hasOv = false;
    w.ov = nov; w.undo = []; w.dirty = true; layout();
  };

  const action = async t => {
    haptic();
    const w = W();
    if (t === 'crop') {
      if (w.hasOv && !await confirmDlg('Markierungen entfernen?', 'Beim Zuschneiden werden Pinsel, Text und Mosaik dieser Seite entfernt.', 'Weiter')) return;
      const r = await cropEditor({ img: w.st.img, corners: w.side.corners, rot: w.side.rot || 0 });
      if (r) { w.side.corners = r.corners; w.side.rot = r.rot; rebuildBase(false); }
      return;
    }
    if (t === 'rot') { w.side.rot = ((w.side.rot || 0) + 90) % 360; return rebuildBase(true, 90); }
    if (t === 'filter') return filterSheet();
    if (t === 'undo') { if (!w.undo.length) return toast('Nichts rückgängig zu machen'); w.ov = w.undo.pop(); w.dirty = true; return drawOv(); }
    if (t === 'wm') return watermark();
    tool = tool === t ? null : t; paintTools();
    if (tool === 'text') toast('Auf das Bild tippen, wo der Text hin soll');
    if (tool === 'mosaic') toast('Über Bereiche wischen, die unkenntlich werden sollen');
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
    if (tool === 'text') {
      const txt = await promptDlg('Text hinzufügen', '', 'Hinzufügen', 'Text');
      if (!txt || !txt.trim()) return;
      snap();
      const x = w.ov.getContext('2d'), fs = Math.round(w.ov.width / 24);
      x.font = `600 ${fs}px -apple-system, Helvetica, Arial, sans-serif`; x.fillStyle = color; x.textBaseline = 'middle';
      txt.trim().split('\n').forEach((ln, i) => x.fillText(ln, p[0], p[1] + i * fs * 1.2));
      return drawOv();
    }
    snap(); last = p; mosaicDone = new Set(); baseData = null;
    if (tool === 'mosaic') { mosaicAt(p); drawOv(); }
  });
  co.addEventListener('pointermove', e => {
    if (!last) return;
    const p = pt(e), w = W(), x = w.ov.getContext('2d');
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
  const up = () => { last = null; };
  co.addEventListener('pointerup', up); co.addEventListener('pointercancel', up);

  el.querySelector('[data-prev]').onclick = () => { if (k > 0) { k--; haptic(); layout(); } };
  el.querySelector('[data-next]').onclick = () => { if (k < work.length - 1) { k++; haptic(); layout(); } };
  const close = () => { removeEventListener('resize', layout); el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.querySelector('[data-x]').onclick = async () => {
    if (work.some(w => w.dirty) && !await confirmDlg('Änderungen verwerfen?', 'Deine Bearbeitung geht verloren.', 'Verwerfen')) return;
    close();
  };
  el.querySelector('[data-ok]').onclick = async () => {
    if (!work.some(w => w.dirty)) return close();
    busy(true, 'Wird gespeichert …');
    try {
      for (const w of work) {
        if (!w.dirty) continue;
        const i = w.st.i, empty = !w.hasOv;
        w.st.side = { ...w.side, ov: !empty };
        if (empty) { w.st.ov = null; await db.del('files', ovKey(d.id, i)); }
        else { await db.put('files', { id: ovKey(d.id, i), data: await canvasBytes(w.ov, 'image/png') }); w.st.ov = copyCanvas(w.ov); }
        d.idSides[i] = w.st.side;
      }
      delete d.idOcr;                           // Bild geändert → Texterkennung neu
      await rebuildPdf(d, states);
      busy(false); toast('Gespeichert'); close(); paintView();
    } catch (e) { console.error(e); busy(false); toast('Speichern fehlgeschlagen', true); }
  };
  addEventListener('resize', layout);
  paintTools();
  requestAnimationFrame(layout);
}

// ---------- ID-Angaben (Formular + Text antippen) ----------
const fixDigits = s => s.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
const yymmdd = (s, future) => {
  if (!/^\d{6}$/.test(s)) return '';
  const yy = +s.slice(0, 2), now = new Date().getFullYear() % 100;
  const y = future ? 2000 + yy : (yy > now ? 1900 + yy : 2000 + yy);
  return `${s.slice(4, 6)}.${s.slice(2, 4)}.${y}`;
};
const titleCase = s => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
const BANKS = ['ING', 'Sparkasse', 'Volksbank', 'Raiffeisenbank', 'Commerzbank', 'Deutsche Bank', 'Postbank', 'DKB', 'N26', 'Comdirect', 'Consorsbank', 'HypoVereinsbank', 'Santander', 'Targobank', 'PSD Bank', 'Sparda-Bank', 'BW-Bank', 'Revolut', 'Wise', 'C24', 'Norisbank', '1822direkt', 'Barclays', 'Hanseatic Bank', 'Advanzia', 'American Express', 'Trade Republic', 'Openbank', 'Tomorrow', 'Vivid'];

// Aus erkanntem Text Felder vorschlagen (MRZ bei Ausweis/Pass, IBAN/Bank bei Bankkarten)
function guessInfo(catId, ocr) {
  const lines = ocr.flatMap(o => o.lines), words = ocr.flatMap(o => o.words.map(w => w.t));
  const all = lines.join('\n'), out = {};
  const mrz = lines.map(l => l.toUpperCase().replace(/\s+/g, '').replace(/[«]/g, '<<')).filter(l => l.length >= 25 && (l.match(/</g) || []).length >= 2);
  // Ausweis (TD1, 3 × 30 Zeichen)
  const l1 = mrz.find(l => /^I[D<]/.test(l)), i1 = mrz.indexOf(l1);
  if (l1) {
    if (l1.slice(5, 14).replace(/</g, '').length >= 8) out.number = l1.slice(5, 14).replace(/</g, '').replace(/O/g, '0');
    const l2 = mrz[i1 + 1], l3 = mrz[i1 + 2];
    if (l2) { const f = fixDigits(l2.slice(0, 15)); out.birth = yymmdd(f.slice(0, 6)); out.expiry = yymmdd(f.slice(8, 14), true); }
    if (l3 && l3.includes('<<')) { const [sn, gn] = l3.split('<<').filter(Boolean); if (sn) out.name = titleCase(((gn || '').replace(/</g, ' ') + ' ' + sn.replace(/</g, ' ')).trim()); }
  }
  // Reisepass (TD3, 2 × 44)
  const p1 = mrz.find(l => /^P[A-Z<]/.test(l));
  if (p1) {
    const p2 = mrz[mrz.indexOf(p1) + 1], [sn, gn] = p1.slice(5).split('<<').filter(Boolean);
    if (sn) out.name = titleCase(((gn || '').replace(/</g, ' ') + ' ' + sn.replace(/</g, ' ')).trim());
    if (p2) { out.number = p2.slice(0, 9).replace(/</g, '').replace(/O/g, '0'); const f = fixDigits(p2); out.birth = yymmdd(f.slice(13, 19)); out.expiry = yymmdd(f.slice(21, 27), true); }
  }
  // MRZ hat keine Umlaute: SCHAEFER → Schäfer, wenn die Vorderseite es so schreibt
  if (out.name) {
    const um = s => s.replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS');
    out.name = out.name.split(' ').map(p => { const w = words.find(x => /[ÄÖÜß]/.test(x) && um(x.toUpperCase()) === p.toUpperCase()); return w ? titleCase(w) : p; }).join(' ');
  }
  if (catId === 'bank' || !out.number) {
    const iban = all.replace(/[Oo]/g, '0').match(/\b([A-Z]{2}\d{2}(?:\s?[0-9A-Z]{4}){3,7}(?:\s?[0-9A-Z]{1,3})?)\b/);
    if (iban && catId === 'bank') out.number = iban[1].replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
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
  return out;
}

async function infoForm(autoFill) {
  const d = view.d;
  let cat = d.idCat || 'other';
  const vals = { ...(d.idInfo || {}) };
  let focus = 'name', ocr = d.idOcr || null;
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
    el.querySelectorAll('[data-f]').forEach(i => { i.oninput = () => { vals[i.dataset.f] = i.value; }; i.onfocus = () => { focus = i.dataset.f; }; });
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
      host.innerHTML = o.words.map((w, j) => `<button data-w="${j}" style="left:${w.b[0] * 100}%;top:${w.b[1] * 100}%;width:${(w.b[2] - w.b[0]) * 100}%;height:${(w.b[3] - w.b[1]) * 100}%"></button>`).join('');
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
    const g = guessInfo(cat, ocr); let n = 0;
    for (const [k] of fieldsFor(cat)) if (g[k] && (!onlyEmpty || !vals[k])) { vals[k] = g[k]; n++; }
    paintFields();
    toast(n ? `${n} ${n === 1 ? 'Feld' : 'Felder'} ausgefüllt – bitte prüfen` : 'Nichts Passendes gefunden – Text auf dem Bild antippen', !n);
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
  // Texterkennung im Hintergrund (lokal, Tesseract)
  try {
    const { recognizeWords } = await import('./ocr.js');
    const cs = view.states.map(st => baseCanvas(st.img, st.side, 1800));
    ocr = await recognizeWords(cs, { onProgress: p => { const h = el.querySelector('[data-hint]'); if (h) h.textContent = `Text wird erkannt … ${Math.round(p * 100)} %`; } });
    d.idOcr = ocr; await db.put('docs', d);
    if (!el.isConnected) return;
    paintBoxes(); if (autoFill) applyGuess(true);
  } catch (e) { console.warn(e); if (el.isConnected) { ocr = null; paintBoxes(); } }
}
