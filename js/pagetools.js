// ================= Kopf-/Fußzeile & Seitenzahlen · Seiten zuschneiden & auf A4 vereinheitlichen =================
// Alles lokal mit pdf-lib (window.PDFLib). Seitendrehung (/Rotate) wird überall berücksichtigt:
// gerechnet wird in „Ansichts-Koordinaten“ (so wie die Seite angezeigt wird) und dann zurückgerechnet.
import { icon } from './icons.js';
import { toast, busy, sheet, esc, haptic } from './ui.js';
import { settings } from './settings.js';
import { loadPdf, closePdf } from './pdfcore.js';

const L = () => window.PDFLib;
const MM = 72 / 25.4;
const A4 = [595.28, 841.89];
let ctx = {};
export function initPageTools(c) { ctx = c; }

const hexRgb = hex => { const n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const rotOf = page => ((page.getRotation().angle % 360) + 360) % 360;
const boxOf = page => (page.getCropBox ? page.getCropBox() : page.getMediaBox());

// Ansicht (Ursprung unten links, so wie angezeigt) → Seitenkoordinaten (ungedreht, relativ zur Box)
export function viewToPage(rot, w, h, X, Y) {
  if (rot === 90) return [w - Y, X];
  if (rot === 180) return [w - X, h - Y];
  if (rot === 270) return [Y, h - X];
  return [X, Y];
}

// =====================================================================================
// 1) Kopf- & Fußzeile / Seitenzahlen
// =====================================================================================
export const HF_KINDS = [
  ['none', 'Nichts'], ['n/N', '1 / 10'], ['Seite n von N', 'Seite 1 von 10'], ['- n -', '- 1 -'], ['n', '1'],
  ['date', 'Datum'], ['text', 'Eigener Text'],
];
export const HF_COLORS = { schwarz: '#111318', grau: '#6b7280', blau: '#1e5bd8', rot: '#e53935' };
const today = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; };

/** Text eines Bereichs für eine Seite (n = Nummer, N = Gesamtzahl). */
export function hfText(slot, n, N) {
  switch (slot.kind) {
    case 'n/N': return `${n} / ${N}`;
    case 'Seite n von N': return `Seite ${n} von ${N}`;
    case '- n -': return `- ${n} -`;
    case 'n': return String(n);
    case 'date': return today();
    case 'text': return String(slot.text || '').replace(/\{n\}/g, n).replace(/\{N\}/g, N).replace(/\{datum\}/gi, today());
    default: return '';
  }
}

// Welche Seiten bekommen etwas, und welche Nummer?
export function hfPlan(st, total) {
  const from = st.range === 'all' ? 1 : st.range === 'from2' ? 2 : Math.max(1, Math.min(total, +st.from || 1));
  const to = st.range === 'custom' ? Math.max(from, Math.min(total, +st.to || total)) : total;
  const plan = [];
  for (let p = from; p <= to; p++) {
    const n = st.countFromStart ? p - from + 1 : p;
    const N = st.countFromStart ? to - from + 1 : total;
    plan.push({ page: p, n, N });
  }
  return plan;
}

// Positionen in Ansichts-Koordinaten (Punkt, Ursprung unten links)
function hfPlaces(W, H, st, slotKey, textW) {
  const m = (st.margin ?? 12) * MM, sz = st.size;
  const header = slotKey.startsWith('h');
  const al = slotKey.slice(1);                    // L | C | R
  const x = al === 'L' ? m : al === 'R' ? W - m - textW : (W - textW) / 2;
  const y = header ? H - m - sz * 0.72 : m;
  return { x, y };
}
const SLOTS = ['hL', 'hC', 'hR', 'fL', 'fC', 'fR'];

export async function addHeaderFooter(bytes, st) {
  const { PDFDocument, StandardFonts, rgb, degrees } = L();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(st.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  const pages = doc.getPages();
  const [r, g, b] = hexRgb(st.color);
  const clean = s => { let o = ''; for (const ch of s) { try { font.encodeText(ch); o += ch; } catch {} } return o; };
  for (const { page: pn, n, N } of hfPlan(st, pages.length)) {
    const page = pages[pn - 1], box = boxOf(page), rot = rotOf(page);
    const w = box.width, h = box.height, [W, H] = rot % 180 ? [h, w] : [w, h];
    for (const k of SLOTS) {
      const slot = st.slots[k]; if (!slot || slot.kind === 'none') continue;
      const t = clean(hfText(slot, n, N)); if (!t.trim()) continue;
      const tw = font.widthOfTextAtSize(t, st.size);
      const { x, y } = hfPlaces(W, H, st, k, tw);
      const [px, py] = viewToPage(rot, w, h, x, y);
      page.drawText(t, { x: box.x + px, y: box.y + py, size: st.size, font, color: rgb(r, g, b), rotate: degrees(rot) });
    }
  }
  return doc.save();
}

// Vorschau: Seite als Bild + Text darüber (gleiche Rechnung wie beim Speichern)
function drawHfPreview(c2, img, W, H, st, n, N, active) {
  const c = c2.canvas, k = c.width / W;
  c2.clearRect(0, 0, c.width, c.height);
  c2.drawImage(img, 0, 0, c.width, c.height);
  // Randlinien andeuten
  const m = (st.margin ?? 12) * MM * k;
  c2.save(); c2.strokeStyle = 'rgba(255,106,91,.35)'; c2.setLineDash([5, 5]); c2.lineWidth = 1;
  c2.beginPath(); c2.moveTo(0, m); c2.lineTo(c.width, m); c2.moveTo(0, c.height - m); c2.lineTo(c.width, c.height - m); c2.stroke(); c2.restore();
  if (!active) { c2.fillStyle = 'rgba(255,255,255,.55)'; c2.fillRect(0, 0, c.width, c.height); return; }
  c2.fillStyle = st.color; c2.textBaseline = 'alphabetic';
  c2.font = `${st.bold ? 700 : 400} ${st.size * k}px Helvetica, Arial, sans-serif`;
  for (const key of SLOTS) {
    const slot = st.slots[key]; if (!slot || slot.kind === 'none') continue;
    const t = hfText(slot, n, N); if (!t.trim()) continue;
    const tw = c2.measureText(t).width / k;
    const { x, y } = hfPlaces(W, H, st, key, tw);
    c2.fillText(t, x * k, c.height - y * k);
  }
}

async function loadPreview(bytes) {
  const pdf = await loadPdf(bytes.slice ? bytes.slice(0) : bytes);
  return {
    pdf, total: pdf.numPages,
    async page(no, width = 900) {
      const p = await pdf.getPage(no), v = p.getViewport({ scale: 1 });
      const vp = p.getViewport({ scale: width / v.width });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: x, viewport: vp }).promise;
      return { img: c, W: v.width, H: v.height };
    },
  };
}

export async function headerFooterSheet(d) {
  if (!d) return;
  busy(true, 'Vorschau wird geladen …');
  let bytes, pv;
  try { bytes = await ctx.docBytes(d); pv = await loadPreview(bytes); }
  catch (e) { console.error(e); busy(false); return toast('PDF konnte nicht geladen werden', true); }
  busy(false);
  const saved = settings.get('hfState');
  const st = Object.assign({
    slots: { hL: { kind: 'none' }, hC: { kind: 'none' }, hR: { kind: 'none' }, fL: { kind: 'none' }, fC: { kind: 'n/N' }, fR: { kind: 'none' } },
    size: 10, color: HF_COLORS.schwarz, bold: false, margin: 12, range: 'all', from: 1, to: pv.total, countFromStart: false, copy: true,
  }, saved || {}, { to: pv.total, copy: true });
  let area = 'f', cur = 1, cache = {};
  const total = pv.total;
  sheet({
    title: 'Kopf- & Fußzeile',
    html: `<div class="wm-prev hf-prev"><canvas data-cv></canvas></div>
      <div class="hf-pager"><button data-pp>${icon('chevronLeft')}</button><span data-pn></span><button data-np>${icon('chevronRight')}</button></div>
      <div class="seg hf-area" data-area><button data-v="h">Kopfzeile</button><button data-v="f">Fußzeile</button></div>
      <div class="hf-slots" data-slots></div>
      <div class="lbl">Inhalt <span data-slotname style="float:right;color:var(--text)"></span></div>
      <div class="chips no-swipe" data-kinds>${HF_KINDS.map(([k, l]) => `<button class="chip" data-k="${k}">${l}</button>`).join('')}</div>
      <input class="field" data-txt placeholder="z. B. RepairMobile · {datum} · Seite {n}" maxlength="80" hidden>
      <div class="hf-hint" data-hint hidden>Platzhalter: {n} Seite, {N} Seitenzahl gesamt, {datum}</div>
      <div class="lbl">Schriftgröße <span data-szv style="float:right;color:var(--text)"></span></div>
      <input type="range" class="range" data-sz min="6" max="24" step="0.5">
      <div class="lbl">Abstand zum Rand <span data-mgv style="float:right;color:var(--text)"></span></div>
      <input type="range" class="range" data-mg min="4" max="35" step="1">
      <div class="row" style="padding:12px 2px 2px;border:0"><span class="row-main"><span class="row-title">Farbe</span></span>
        <div class="colors" data-cols style="margin:0">${Object.entries(HF_COLORS).map(([n, c]) => `<button class="color" data-c="${c}" aria-label="${n}" style="background:${c}"></button>`).join('')}</div>
        <button class="toggle" data-bold style="margin-left:8px">${icon('bold')}</button></div>
      <div class="lbl">Seiten</div>
      <div class="seg" data-range style="display:flex"><button data-v="all">Alle</button><button data-v="from2">Ab Seite 2</button><button data-v="custom">Bereich</button></div>
      <div class="hf-custom" data-custom hidden>
        <label>von <input class="field" type="number" inputmode="numeric" data-from min="1" max="${total}"></label>
        <label>bis <input class="field" type="number" inputmode="numeric" data-to min="1" max="${total}"></label>
      </div>
      <div class="row" style="padding:12px 2px 2px;border:0"><span class="row-main"><span class="row-title">Zählung bei 1 beginnen</span><span class="row-sub" style="display:block">z. B. Deckblatt nicht mitzählen</span></span>
        <div class="seg" data-cfs><button data-v="1">An</button><button data-v="0">Aus</button></div></div>
      ${ctx.copyRow(st.copy)}
      <div class="btn-row"><button class="btn primary" data-ok>${icon('pages')} Anwenden</button></div>`,
    onMount(el, api) {
      const cv = el.querySelector('[data-cv]'), c2 = cv.getContext('2d');
      const txt = el.querySelector('[data-txt]');
      let slot = 'fC';
      const plan = () => hfPlan(st, total);
      const draw = async () => {
        const pg = cache[cur] || (cache[cur] = await pv.page(cur));
        if (cv.width !== 900) cv.width = 900;
        const hgt = Math.round(900 * pg.H / pg.W); if (cv.height !== hgt) cv.height = hgt;
        const pl = plan().find(p => p.page === cur);
        drawHfPreview(c2, pg.img, pg.W, pg.H, st, pl?.n, pl?.N, !!pl);
        el.querySelector('[data-pn]').textContent = `Seite ${cur} von ${total}${pl ? '' : ' · ohne'}`;
      };
      const paint = () => {
        el.querySelectorAll('[data-area] button').forEach(b => b.classList.toggle('on', b.dataset.v === area));
        const names = { L: 'Links', C: 'Mitte', R: 'Rechts' };
        el.querySelector('[data-slots]').innerHTML = ['L', 'C', 'R'].map(a => {
          const k = area + a, s0 = st.slots[k];
          const lbl = s0.kind === 'none' ? '–' : s0.kind === 'text' ? (s0.text || 'Text') : (HF_KINDS.find(x => x[0] === s0.kind) || [, ''])[1];
          return `<button class="hf-slot ${k === slot ? 'on' : ''} ${s0.kind !== 'none' ? 'set' : ''}" data-slot="${k}"><span>${names[a]}</span><b>${esc(lbl)}</b></button>`;
        }).join('');
        el.querySelectorAll('[data-slot]').forEach(b => b.onclick = () => { slot = b.dataset.slot; haptic(); paint(); });
        el.querySelector('[data-slotname]').textContent = `${area === 'h' ? 'Kopfzeile' : 'Fußzeile'} ${names[slot[1]].toLowerCase()}`;
        const sk = st.slots[slot];
        el.querySelectorAll('[data-kinds] .chip').forEach(b => b.classList.toggle('on', b.dataset.k === sk.kind));
        txt.hidden = sk.kind !== 'text'; el.querySelector('[data-hint]').hidden = sk.kind !== 'text';
        if (sk.kind === 'text' && document.activeElement !== txt) txt.value = sk.text || '';
        el.querySelector('[data-szv]').textContent = String(st.size).replace('.', ',') + ' pt';
        el.querySelector('[data-mgv]').textContent = st.margin + ' mm';
        el.querySelectorAll('[data-cols] .color').forEach(b => b.classList.toggle('on', b.dataset.c === st.color));
        el.querySelector('[data-bold]').classList.toggle('on', st.bold);
        el.querySelectorAll('[data-range] button').forEach(b => b.classList.toggle('on', b.dataset.v === st.range));
        el.querySelector('[data-custom]').hidden = st.range !== 'custom';
        el.querySelectorAll('[data-cfs] button').forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === st.countFromStart));
        draw();
      };
      el.querySelectorAll('[data-area] button').forEach(b => b.onclick = () => { area = b.dataset.v; slot = area + slot[1]; haptic(); paint(); });
      el.querySelectorAll('[data-kinds] .chip').forEach(b => b.onclick = () => {
        st.slots[slot] = { kind: b.dataset.k, text: st.slots[slot].text || '' }; haptic(); paint();
        if (b.dataset.k === 'text') setTimeout(() => txt.focus(), 50);
      });
      txt.oninput = () => { st.slots[slot].text = txt.value; paint(); };
      const sz = el.querySelector('[data-sz]'), mg = el.querySelector('[data-mg]');
      sz.value = st.size; mg.value = st.margin;
      sz.oninput = () => { st.size = +sz.value; paint(); };
      mg.oninput = () => { st.margin = +mg.value; paint(); };
      el.querySelectorAll('[data-cols] .color').forEach(b => b.onclick = () => { st.color = b.dataset.c; paint(); });
      el.querySelector('[data-bold]').onclick = () => { st.bold = !st.bold; paint(); };
      el.querySelectorAll('[data-range] button').forEach(b => b.onclick = () => {
        st.range = b.dataset.v; haptic();
        if (st.range === 'from2' && cur === 1 && total > 1) cur = 2;
        paint();
      });
      const fi = el.querySelector('[data-from]'), ti = el.querySelector('[data-to]');
      fi.value = st.from; ti.value = st.to;
      fi.oninput = () => { st.from = Math.max(1, Math.min(total, +fi.value || 1)); paint(); };
      ti.oninput = () => { st.to = Math.max(1, Math.min(total, +ti.value || total)); paint(); };
      el.querySelectorAll('[data-cfs] button').forEach(b => b.onclick = () => { st.countFromStart = b.dataset.v === '1'; paint(); });
      el.querySelector('[data-pp]').onclick = () => { if (cur > 1) { cur--; draw(); } };
      el.querySelector('[data-np]').onclick = () => { if (cur < total) { cur++; draw(); } };
      ctx.bindCopy(el, () => st.copy, v => { st.copy = v; });
      el.querySelector('[data-ok]').onclick = async () => {
        if (!SLOTS.some(k => st.slots[k].kind !== 'none' && (st.slots[k].kind !== 'text' || st.slots[k].text?.trim()))) return toast('Bitte einen Inhalt wählen', true);
        if (!plan().length) return toast('Kein Seitenbereich gewählt', true);
        const { copy, to, ...keep } = st; settings.set('hfState', keep);
        api.close(); busy(true, 'Kopf- & Fußzeilen werden gesetzt …');
        try {
          const out = await addHeaderFooter(bytes, st);
          const id = await ctx.storeResult(d, out, 'Seitenzahlen', st.copy);
          busy(false); await ctx.renderRecents(); toast('Kopf- & Fußzeile eingefügt'); ctx.openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Einfügen fehlgeschlagen', true); }
      };
      paint();
    },
    onClose() { closePdf(pv.pdf); },
  });
}

// =====================================================================================
// 2) Zuschneiden & auf A4 vereinheitlichen
// =====================================================================================
// Zuschnitt als Anteile der angezeigten Seite: { l, t, r, b } (0 … <0.5)
export function applyCrop(page, f) {
  const box = boxOf(page), rot = rotOf(page), w = box.width, h = box.height;
  const [W, H] = rot % 180 ? [h, w] : [w, h];
  const X0 = f.l * W, X1 = W - f.r * W, Y0 = f.b * H, Y1 = H - f.t * H;   // Ansicht, Ursprung unten links
  const a = viewToPage(rot, w, h, X0, Y0), c = viewToPage(rot, w, h, X1, Y1);
  const x = box.x + Math.min(a[0], c[0]), y = box.y + Math.min(a[1], c[1]);
  const cw = Math.abs(c[0] - a[0]), ch = Math.abs(c[1] - a[1]);
  if (cw < 10 || ch < 10) return;
  page.setMediaBox(x, y, cw, ch);
  page.setCropBox(x, y, cw, ch);
  try { page.setTrimBox(x, y, cw, ch); page.setBleedBox(x, y, cw, ch); page.setArtBox(x, y, cw, ch); } catch {}
}

/** crops: Array (pro Seite) von {l,t,r,b} oder null */
export async function cropPdf(bytes, crops) {
  const { PDFDocument } = L();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  doc.getPages().forEach((p, i) => { const f = crops[i]; if (f && (f.l || f.t || f.r || f.b)) applyCrop(p, f); });
  return doc.save();
}

// Alle Seiten proportional auf A4 skalieren und zentrieren (Hoch-/Querformat wie die Seite, Drehung bleibt)
export async function normalizeA4(bytes) {
  const { PDFDocument, PDFName, PDFArray, PDFNumber } = L();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  for (const page of doc.getPages()) {
    const box = boxOf(page), rot = rotOf(page), w = box.width, h = box.height;
    const [W, H] = rot % 180 ? [h, w] : [w, h];
    const [VW, VH] = W > H ? [A4[1], A4[0]] : A4;                 // Ziel so wie angezeigt
    const [TW, TH] = rot % 180 ? [VH, VW] : [VW, VH];             // Ziel ungedreht
    const s = Math.min(TW / w, TH / h);
    const tx = (TW - w * s) / 2 - box.x * s, ty = (TH - h * s) / 2 - box.y * s;
    if (Math.abs(s - 1) < 0.002 && Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5 && Math.abs(TW - w) < 1 && Math.abs(TH - h) < 1) continue;
    page.scaleContent(s, s);
    page.translateContent(tx, ty);
    // Links/Notizen mitverschieben
    try {
      const annots = page.node.Annots();
      if (annots) for (let k = 0; k < annots.size(); k++) {
        const a = annots.lookup(k); const r = a?.lookup?.(PDFName.of('Rect'), PDFArray); if (!r) continue;
        const v = [0, 1, 2, 3].map(j => r.lookup(j, PDFNumber).asNumber());
        const nv = [v[0] * s + tx, v[1] * s + ty, v[2] * s + tx, v[3] * s + ty];
        a.set(PDFName.of('Rect'), doc.context.obj(nv));
      }
    } catch {}
    page.setMediaBox(0, 0, TW, TH);
    page.setCropBox(0, 0, TW, TH);
    try { page.setTrimBox(0, 0, TW, TH); page.setBleedBox(0, 0, TW, TH); page.setArtBox(0, 0, TW, TH); } catch {}
  }
  return doc.save();
}

// Weiße Ränder im gerenderten Bild finden → {l,t,r,b}
export function detectMargins(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const ink = (x, y) => { const o = (y * w + x) * 4; return d[o] * 0.3 + d[o + 1] * 0.59 + d[o + 2] * 0.11 < 238; };
  const rowHas = y => { let n = 0; for (let x = 2; x < w - 2; x += 1) if (ink(x, y) && ++n > 1) return true; return false; };
  const colHas = x => { let n = 0; for (let y = 2; y < h - 2; y += 1) if (ink(x, y) && ++n > 1) return true; return false; };
  let t = 2; while (t < h - 2 && !rowHas(t)) t++;
  let b = h - 3; while (b > t && !rowHas(b)) b--;
  let l = 2; while (l < w - 2 && !colHas(l)) l++;
  let r = w - 3; while (r > l && !colHas(r)) r--;
  if (t >= b || l >= r) return { l: 0, t: 0, r: 0, b: 0 };
  const pad = Math.round(Math.min(w, h) * 0.02);
  const cl = v => Math.max(0, Math.min(0.45, v));
  return { l: cl((l - pad) / w), t: cl((t - pad) / h), r: cl((w - 1 - r - pad) / w), b: cl((h - 1 - b - pad) / h) };
}

export async function cropSheet(d) {
  if (!d) return;
  busy(true, 'Vorschau wird geladen …');
  let bytes, pv;
  try { bytes = await ctx.docBytes(d); pv = await loadPreview(bytes); }
  catch (e) { console.error(e); busy(false); return toast('PDF konnte nicht geladen werden', true); }
  busy(false);
  const total = pv.total, cache = {};
  const crops = Array(total).fill(null);
  let cur = 1, scope = 'all', copy = true, auto = false;
  const f0 = () => ({ l: 0, t: 0, r: 0, b: 0 });
  let f = f0();
  sheet({
    title: 'Seiten zuschneiden',
    html: `<div class="crop-stage no-swipe" data-stage><div class="crop-page" data-page><img alt="" data-img>
        <div class="crop-dim" data-dim></div><div class="crop-box" data-box>
          <i data-h="tl"></i><i data-h="t"></i><i data-h="tr"></i><i data-h="r"></i><i data-h="br"></i><i data-h="b"></i><i data-h="bl"></i><i data-h="l"></i></div></div></div>
      <div class="hf-pager"><button data-pp>${icon('chevronLeft')}</button><span data-pn></span><button data-np>${icon('chevronRight')}</button></div>
      <div class="crop-actions">
        <button class="chip" data-auto>${icon('sparkles')} Weiße Ränder entfernen</button>
        <button class="chip" data-reset>${icon('undo')} Zurücksetzen</button>
      </div>
      <div class="row" style="padding:10px 2px 2px;border:0"><span class="row-main"><span class="row-title">Übernehmen für</span><span class="row-sub" data-scopehint style="display:block"></span></span>
        <div class="seg" data-scope><button data-v="page">Diese Seite</button><button data-v="all">Alle Seiten</button></div></div>
      ${ctx.copyRow(copy)}
      <div class="btn-row"><button class="btn primary" data-ok>${icon('fit')} Zuschneiden</button></div>
      <div class="lbl" style="margin-top:18px">Format vereinheitlichen</div>
      <button class="row crop-a4" data-a4><span class="row-ic c-blue">${icon('file')}</span><span class="row-main"><span class="row-title">Auf DIN A4 vereinheitlichen</span><span class="row-sub">Alle Seiten proportional auf A4 skalieren und zentrieren</span></span>${icon('chevronRight')}</button>`,
    onMount(el, api) {
      const img = el.querySelector('[data-img]'), page = el.querySelector('[data-page]'), boxEl = el.querySelector('[data-box]'), dim = el.querySelector('[data-dim]');
      const paintBox = () => {
        Object.assign(boxEl.style, { left: f.l * 100 + '%', top: f.t * 100 + '%', right: f.r * 100 + '%', bottom: f.b * 100 + '%' });
        // Abdunkeln außerhalb (vier Rechtecke über clip-path)
        const L0 = f.l * 100, T0 = f.t * 100, R0 = 100 - f.r * 100, B0 = 100 - f.b * 100;
        dim.style.clipPath = `polygon(0 0,100% 0,100% 100%,0 100%,0 0,${L0}% ${T0}%,${L0}% ${B0}%,${R0}% ${B0}%,${R0}% ${T0}%,${L0}% ${T0}%)`;
      };
      const show = async () => {
        const pg = cache[cur] || (cache[cur] = await pv.page(cur, 700));
        img.src = pg.img.toDataURL('image/jpeg', 0.85);
        page.style.aspectRatio = `${pg.W} / ${pg.H}`;
        f = crops[cur - 1] ? { ...crops[cur - 1] } : (scope === 'all' && crops.find(Boolean) && !auto ? { ...crops.find(Boolean) } : f0());
        el.querySelector('[data-pn]').textContent = `Seite ${cur} von ${total}`;
        paintBox();
      };
      const hint = () => {
        el.querySelectorAll('[data-scope] button').forEach(b => b.classList.toggle('on', b.dataset.v === scope));
        el.querySelector('[data-scopehint]').textContent = scope === 'all'
          ? (auto ? 'Ränder werden auf jeder Seite einzeln erkannt' : 'Gleicher Zuschnitt auf allen Seiten')
          : `Nur Seite ${cur}`;
      };
      // Ziehen der Kanten/Ecken (und der ganzen Box)
      const drag = (e, h) => {
        e.preventDefault(); e.stopPropagation();
        const r = page.getBoundingClientRect(), s0 = { ...f }, x0 = e.clientX, y0 = e.clientY;
        auto = false; hint();
        const mv = ev => {
          const dx = (ev.clientX - x0) / r.width, dy = (ev.clientY - y0) / r.height, MIN = 0.08;
          const n = { ...s0 };
          if (!h) { // ganze Box verschieben
            const wv = 1 - s0.l - s0.r, hv = 1 - s0.t - s0.b;
            n.l = Math.max(0, Math.min(1 - wv, s0.l + dx)); n.r = 1 - wv - n.l;
            n.t = Math.max(0, Math.min(1 - hv, s0.t + dy)); n.b = 1 - hv - n.t;
          } else {
            if (h.includes('l')) n.l = Math.max(0, Math.min(1 - s0.r - MIN, s0.l + dx));
            if (h.includes('r')) n.r = Math.max(0, Math.min(1 - s0.l - MIN, s0.r - dx));
            if (h.includes('t')) n.t = Math.max(0, Math.min(1 - s0.b - MIN, s0.t + dy));
            if (h.includes('b')) n.b = Math.max(0, Math.min(1 - s0.t - MIN, s0.b - dy));
          }
          f = n; paintBox();
        };
        const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); crops[cur - 1] = { ...f }; };
        addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
      };
      boxEl.querySelectorAll('[data-h]').forEach(hd => hd.onpointerdown = e => drag(e, hd.dataset.h));
      boxEl.onpointerdown = e => { if (!e.target.dataset.h) drag(e, ''); };
      el.querySelector('[data-auto]').onclick = async () => {
        const pg = cache[cur] || (cache[cur] = await pv.page(cur, 700));
        f = detectMargins(pg.img); crops[cur - 1] = { ...f }; auto = true; haptic(); paintBox(); hint();
        if (!(f.l || f.t || f.r || f.b)) toast('Keine weißen Ränder gefunden');
      };
      el.querySelector('[data-reset]').onclick = () => { f = f0(); crops.fill(null); auto = false; haptic(); paintBox(); hint(); };
      el.querySelectorAll('[data-scope] button').forEach(b => b.onclick = () => { scope = b.dataset.v; haptic(); hint(); });
      el.querySelector('[data-pp]').onclick = () => { if (cur > 1) { cur--; show(); hint(); } };
      el.querySelector('[data-np]').onclick = () => { if (cur < total) { cur++; show(); hint(); } };
      ctx.bindCopy(el, () => copy, v => { copy = v; });
      el.querySelector('[data-ok]').onclick = async () => {
        if (!(f.l || f.t || f.r || f.b) && !crops.some(c => c && (c.l || c.t || c.r || c.b))) return toast('Bitte erst den Rahmen ziehen oder „Weiße Ränder entfernen“', true);
        api.close(); busy(true, 'Seiten werden zugeschnitten …');
        try {
          let list;
          if (scope === 'page') { list = Array(total).fill(null); list[cur - 1] = { ...f }; }
          else if (auto) {                       // Ränder je Seite erkennen
            list = [];
            for (let i = 1; i <= total; i++) {
              busy(true, `Ränder werden erkannt … ${i}/${total}`);
              const pg = cache[i] || (cache[i] = await pv.page(i, 700));
              list.push(detectMargins(pg.img));
            }
          } else list = Array(total).fill({ ...f });
          const out = await cropPdf(bytes, list);
          const id = await ctx.storeResult(d, out, 'Zugeschnitten', copy);
          busy(false); await ctx.renderRecents(); toast('Seiten zugeschnitten'); ctx.openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Zuschneiden fehlgeschlagen', true); }
      };
      el.querySelector('[data-a4]').onclick = async () => {
        api.close(); busy(true, 'Seiten werden auf A4 gebracht …');
        try {
          const out = await normalizeA4(bytes);
          const id = await ctx.storeResult(d, out, 'A4', copy);
          busy(false); await ctx.renderRecents(); toast('Alle Seiten auf DIN A4'); ctx.openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Vereinheitlichen fehlgeschlagen', true); }
      };
      show(); hint();
    },
    onClose() { closePdf(pv.pdf); },
  });
}
