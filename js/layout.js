// ================= Doppelseiten teilen & Poster-Druck (Kacheln) =================
// Doppelseiten: Buch-/Heft-Scans (Querformat) in der Mitte teilen – Seiten werden mit pdf-lib
//   kopiert und MediaBox/CropBox auf die linke bzw. rechte Hälfte gesetzt (berücksichtigt /Rotate).
// Poster: eine große Seite auf mehrere DIN-A4-Blätter verteilen, mit Kleberand (Überlappung),
//   Schnittmarken, Blatt-Beschriftung und optionaler Übersichtsseite.
import { icon } from './icons.js';
import { toast, busy, sheet, haptic } from './ui.js';
import { loadPdf, closePdf } from './pdfcore.js';

const L = () => window.PDFLib;
const MM = 72 / 25.4;
const A4 = [595.28, 841.89];
let ctx = {};
export function initLayout(c) { ctx = c; }

const cm = pt => (pt / MM / 10).toLocaleString('de-DE', { maximumFractionDigits: 1 });

// Sichtbare Größe einer Seite (nach /Rotate)
function visBox(page) {
  const b = page.getCropBox(), rot = ((page.getRotation().angle % 360) + 360) % 360;
  const side = rot === 90 || rot === 270;
  return { b, rot, w: side ? b.height : b.width, h: side ? b.width : b.height };
}

// ---------------------------------------------------------------------------------
// Doppelseiten teilen
// ---------------------------------------------------------------------------------
/** Plan: für jede Seite → 1 oder 2 Ausgabeseiten */
export function spreadPlan(sizes, { mode = 'landscape', rtl = false }) {
  const out = [];
  sizes.forEach(({ w, h }, i) => {
    const split = mode === 'all' || w > h * 1.05;
    if (!split) out.push({ i, part: 'full' });
    else if (rtl) out.push({ i, part: 'right' }, { i, part: 'left' });
    else out.push({ i, part: 'left' }, { i, part: 'right' });
  });
  return out;
}

/** bytes → geteilte PDF. shift: Teilungslinie in % der Breite (−15 … +15) */
export async function splitSpreads(bytes, { mode = 'landscape', rtl = false, shift = 0 } = {}) {
  const { PDFDocument } = L();
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const sizes = src.getPages().map(p => visBox(p));
  const plan = spreadPlan(sizes, { mode, rtl });
  const out = await PDFDocument.create();
  const copies = await out.copyPages(src, plan.map(p => p.i));
  plan.forEach((p, k) => {
    const pg = copies[k];
    out.addPage(pg);
    if (p.part === 'full') return;
    const { b, rot } = sizes[p.i];
    const f = 0.5 + shift / 100;
    // sichtbar „links“ in Benutzerkoordinaten je nach Drehung
    let box;
    const leftVis = p.part === 'left';
    if (rot === 0 || rot === 180) {
      const mid = b.x + b.width * (rot === 0 ? f : 1 - f);
      const lowSide = rot === 0 ? leftVis : !leftVis;                 // niedrige x-Werte
      box = lowSide ? [b.x, b.y, mid - b.x, b.height] : [mid, b.y, b.x + b.width - mid, b.height];
    } else {
      // 90°: sichtbar links = kleine y-Werte · 270°: sichtbar links = große y-Werte
      const mid = b.y + b.height * (rot === 90 ? f : 1 - f);
      const lowSide = rot === 90 ? leftVis : !leftVis;
      box = lowSide ? [b.x, b.y, b.width, mid - b.y] : [b.x, mid, b.width, b.y + b.height - mid];
    }
    pg.setMediaBox(...box); pg.setCropBox(...box);
    try { pg.setTrimBox(...box); pg.setBleedBox(...box); pg.setArtBox(...box); } catch {}
  });
  return { bytes: await out.save(), from: sizes.length, to: plan.length, split: plan.filter(p => p.part === 'left').length };
}

async function thumbCanvas(pdf, no, width) {
  const p = await pdf.getPage(no), v = p.getViewport({ scale: 1 }), vp = p.getViewport({ scale: width / v.width });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await p.render({ canvasContext: g, viewport: vp }).promise;
  return { c, w: v.width, h: v.height };
}

export async function spreadSheet(d) {
  if (!d) return;
  busy(true, 'PDF wird geladen …');
  let bytes, pdf, sizes, sample = null;
  try {
    bytes = await ctx.docBytes(d);
    pdf = await loadPdf(bytes.slice ? bytes.slice(0) : bytes);
    sizes = [];
    for (let i = 1; i <= pdf.numPages; i++) { const v = (await pdf.getPage(i)).getViewport({ scale: 1 }); sizes.push({ w: v.width, h: v.height }); }
    const si = sizes.findIndex(s => s.w > s.h * 1.05);
    sample = { i: si >= 0 ? si : 0, ...(await thumbCanvas(pdf, (si >= 0 ? si : 0) + 1, 520)) };
  } catch (e) { console.error(e); busy(false); closePdf(pdf); return toast('PDF konnte nicht geladen werden', true); }
  busy(false);
  const S = { mode: sizes.some(s => s.w > s.h * 1.05) ? 'landscape' : 'all', rtl: false, shift: 0, copy: true };
  const seg = (k, opts, cur) => `<div class="seg sp-seg" data-${k}>${opts.map(([v, l]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  sheet({
    title: 'Doppelseiten teilen',
    html: `<div class="sp-prev" data-prev><div class="sp-img"><img data-img alt=""><div class="sp-line" data-line></div><span class="sp-n l" data-nl>1</span><span class="sp-n r" data-nr>2</span></div><small data-cap></small></div>
      <div class="lbl">Welche Seiten?</div>${seg('mode', [['landscape', 'Nur Querformat'], ['all', 'Alle Seiten']], S.mode)}
      <div class="lbl">Lesereihenfolge</div>${seg('dir', [['ltr', 'Links → Rechts'], ['rtl', 'Rechts → Links']], 'ltr')}
      <div class="lbl sp-lbl">Teilungslinie <span data-shv>Mitte</span></div>
      <input type="range" class="range" min="-15" max="15" step="0.5" value="0" data-shift>
      <div class="sp-sum" data-sum></div>
      ${ctx.copyRow(true)}
      <div class="btn-row"><button class="btn primary" data-ok>${icon('split')} Teilen</button></div>`,
    onMount(el, api) {
      const $ = s => el.querySelector(s);
      $('[data-img]').src = sample.c.toDataURL('image/jpeg', 0.8);
      ctx.bindCopy(el, () => S.copy, v => S.copy = v);
      const upd = () => {
        const plan = spreadPlan(sizes, S), split = plan.filter(p => p.part === 'left').length;
        const willSplit = S.mode === 'all' || sample.w > sample.h * 1.05;
        $('[data-line]').style.left = (50 + S.shift) + '%';
        $('[data-line]').hidden = !willSplit;
        $('[data-nl]').hidden = $('[data-nr]').hidden = !willSplit;
        $('[data-nl]').textContent = S.rtl ? '2' : '1'; $('[data-nr]').textContent = S.rtl ? '1' : '2';
        $('[data-cap]').textContent = `Vorschau: Seite ${sample.i + 1}${willSplit ? '' : ' (wird nicht geteilt)'}`;
        $('[data-shv]').textContent = S.shift ? `${S.shift > 0 ? '+' : ''}${String(S.shift).replace('.', ',')} %` : 'Mitte';
        $('[data-sum]').innerHTML = split
          ? `<b>${sizes.length}</b> ${sizes.length === 1 ? 'Seite' : 'Seiten'} <span>→</span> <b>${plan.length}</b> Seiten <small>(${split} ${split === 1 ? 'Doppelseite' : 'Doppelseiten'} geteilt)</small>`
          : `<span class="warn">Keine Querformat-Seiten gefunden – wähle „Alle Seiten“.</span>`;
        $('[data-ok]').disabled = !split;
      };
      el.querySelectorAll('[data-mode] button, [data-dir] button').forEach(b => b.onclick = () => {
        const g = b.parentElement; g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); haptic();
        if (g.dataset.mode !== undefined) S.mode = b.dataset.v; else S.rtl = b.dataset.v === 'rtl';
        upd();
      });
      $('[data-shift]').oninput = e => { S.shift = +e.target.value; upd(); };
      $('[data-ok]').onclick = async () => {
        api.close(); busy(true, 'Seiten werden geteilt …');
        try {
          const r = await splitSpreads(bytes, S);
          const id = await ctx.storeResult(d, r.bytes, 'Einzelseiten', S.copy);
          busy(false); await ctx.renderRecents();
          toast(`${r.from} → ${r.to} Seiten`); ctx.openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Teilen fehlgeschlagen', true); }
      };
      upd();
    },
    onClose() { closePdf(pdf); },
  });
}

// ---------------------------------------------------------------------------------
// Poster-Druck (Kacheln)
// ---------------------------------------------------------------------------------
/**
 * Raster berechnen. src: { w, h } in pt (sichtbar)
 * opts: { mode: 'grid'|'scale', cols, rows, scale (%), overlap (mm), margin (mm), orient: 'auto'|'p'|'l' }
 */
export function posterPlan(src, o) {
  const ov = o.overlap * MM, m = o.margin * MM;
  const calc = ([pw, ph]) => {
    const cw = pw - 2 * m, ch = ph - 2 * m, sx = cw - ov, sy = ch - ov;
    let s, cols, rows;
    if (o.mode === 'grid') {
      cols = o.cols; rows = o.rows;
      s = Math.min((cols * sx + ov) / src.w, (rows * sy + ov) / src.h);
    } else {
      s = o.scale / 100;
      cols = Math.max(1, Math.ceil((src.w * s - ov) / sx - 1e-6)); rows = Math.max(1, Math.ceil((src.h * s - ov) / sy - 1e-6));
    }
    const W = src.w * s, H = src.h * s, totW = cols * sx + ov, totH = rows * sy + ov;
    return { pw, ph, cw, ch, sx, sy, s, cols, rows, W, H, offX: (totW - W) / 2, offY: (totH - H) / 2, ov, m, sheets: cols * rows };
  };
  const P = calc(A4), Lq = calc([A4[1], A4[0]]);
  if (o.orient === 'p') return P;
  if (o.orient === 'l') return Lq;
  // automatisch: weniger Blätter, bei Gleichstand größerer Maßstab
  return Lq.sheets < P.sheets || (Lq.sheets === P.sheets && Lq.s > P.s * 1.01) ? Lq : P;
}

const tileName = (r, c) => String.fromCharCode(65 + (r % 26)) + (c + 1);

export async function makePoster(bytes, pageIndex, o) {
  const { PDFDocument, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = L();
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const sp = src.getPage(pageIndex);
  const vb = visBox(sp);
  const P = posterPlan({ w: vb.w, h: vb.h }, o);
  const out = await PDFDocument.create();
  const b = vb.b;
  const emb = await out.embedPage(sp, { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height });
  const font = await out.embedFont(StandardFonts.Helvetica), bold = await out.embedFont(StandardFonts.HelveticaBold);
  const gray = rgb(0.55, 0.57, 0.6), dark = rgb(0.2, 0.21, 0.24), accent = rgb(1, 0.416, 0.357);
  const s = P.s;
  // Seite (mit /Rotate) so zeichnen, dass ihr sichtbares Rechteck links unten bei (X, Y) liegt
  const drawSrc = (pg, X, Y) => {
    const w = b.width * s, h = b.height * s;
    const at = { 0: [X, Y, 0], 90: [X, Y + w, -90], 180: [X + w, Y + h, 180], 270: [X + h, Y, 90] }[vb.rot];
    pg.drawPage(emb, { x: at[0], y: at[1], xScale: s, yScale: s, rotate: degrees(at[2]) });
  };

  // ---------- Übersichtsseite ----------
  if (o.overview) {
    const pg = out.addPage(A4[0] < A4[1] && P.W > P.H ? [A4[1], A4[0]] : A4);
    const [W, H] = [pg.getWidth(), pg.getHeight()];
    pg.drawText('Poster-Druck – Übersicht', { x: 40, y: H - 52, size: 18, font: bold, color: dark });
    pg.drawText(`${P.cols} × ${P.rows} Blätter DIN A4 ${P.pw > P.ph ? 'quer' : 'hoch'} · Postergröße ${cm(P.W)} × ${cm(P.H)} cm · Maßstab ${Math.round(s * 100)} %`, { x: 40, y: H - 72, size: 10, font, color: gray });
    pg.drawText(`Kleberand ${o.overlap} mm: Rand an der markierten Linie abschneiden und auf das Nachbarblatt kleben.`, { x: 40, y: H - 86, size: 10, font, color: gray });
    const totW = P.cols * P.sx + P.ov, totH = P.rows * P.sy + P.ov;
    const k = Math.min((W - 80) / totW, (H - 150) / totH), ox = (W - totW * k) / 2, oy = 40 + ((H - 150) - totH * k) / 2;
    const ks = s * k;
    const w = b.width * ks, h = b.height * ks, X = ox + P.offX * k, Y = oy + (totH - P.offY - P.H) * k;
    const at = { 0: [X, Y, 0], 90: [X, Y + w, -90], 180: [X + w, Y + h, 180], 270: [X + h, Y, 90] }[vb.rot];
    pg.drawPage(emb, { x: at[0], y: at[1], xScale: ks, yScale: ks, rotate: degrees(at[2]), opacity: 0.85 });
    for (let r = 0; r < P.rows; r++) for (let c = 0; c < P.cols; c++) {
      const x = ox + c * P.sx * k, y = oy + (totH - (r * P.sy + P.ch - 0 * P.ov)) * k;
      pg.drawRectangle({ x, y, width: P.cw * k, height: P.ch * k, borderColor: accent, borderWidth: 0.8, opacity: 0, borderOpacity: 0.9 });
      const t = tileName(r, c), ts = Math.min(22, P.cw * k * 0.22);
      pg.drawText(t, { x: x + P.cw * k / 2 - bold.widthOfTextAtSize(t, ts) / 2, y: y + P.ch * k / 2 - ts / 3, size: ts, font: bold, color: accent, opacity: 0.85 });
    }
  }

  // ---------- Kacheln ----------
  const markLen = Math.min(P.m * 0.8, 6 * MM), cutW = 0.35;
  for (let r = 0; r < P.rows; r++) for (let c = 0; c < P.cols; c++) {
    const pg = out.addPage([P.pw, P.ph]);
    const { pw, ph, m, cw, ch, ov } = P;
    // Inhalt: Ausschnitt des Posters, auf den druckbaren Bereich begrenzt
    pg.pushOperators(pushGraphicsState(), rectangle(m, m, cw, ch), clip(), endPath());
    const X = m + P.offX - c * P.sx, Ytop = ph - m - (P.offY - r * P.sy);
    drawSrc(pg, X, Ytop - P.H);
    pg.pushOperators(popGraphicsState());
    if (!o.marks) continue;
    // Schnittmarken an den Ecken des Inhaltsbereichs (im Rand)
    const line = (x1, y1, x2, y2, col = dark, wdt = cutW, dash) => pg.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: wdt, color: col, dashArray: dash });
    for (const [x, y] of [[m, m], [m + cw, m], [m, m + ch], [m + cw, m + ch]]) {
      const dx = x === m ? -1 : 1, dy = y === m ? -1 : 1;
      line(x, y + dy * 2, x, y + dy * (2 + markLen)); line(x + dx * 2, y, x + dx * (2 + markLen), y);
    }
    // Kleberand: Linie im Rand, wo das Nachbarblatt überlappt (rechts / unten haben Nachbarn)
    if (ov > 0) {
      const dash = [2, 2];
      if (c < P.cols - 1) { line(m + cw - ov, ph - m + 2, m + cw - ov, ph - 2, accent, 0.6, dash); line(m + cw - ov, 2, m + cw - ov, m - 2, accent, 0.6, dash); }
      if (r < P.rows - 1) { line(2, m + ov, m - 2, m + ov, accent, 0.6, dash); line(pw - m + 2, m + ov, pw - 2, m + ov, accent, 0.6, dash); }
      if (c > 0) pg.drawText('Kleberand', { x: m + 2, y: ph - m + 2.5, size: 5, font, color: accent });
    }
    // Beschriftung + Mini-Lageplan
    const lab = `${tileName(r, c)}  ·  Zeile ${r + 1} von ${P.rows}, Spalte ${c + 1} von ${P.cols}`;
    const fs = Math.min(6.5, m * 0.42);
    pg.drawText(lab, { x: m + markLen + 6, y: Math.max(2, m / 2 - fs / 3), size: fs, font, color: gray });
    const cell = Math.min(4, (m - 4) / Math.max(P.rows, 1)), mx = pw - m - markLen - 6 - P.cols * cell, my = Math.max(1.5, (m - P.rows * cell) / 2);
    for (let rr = 0; rr < P.rows; rr++) for (let cc = 0; cc < P.cols; cc++) {
      pg.drawRectangle({ x: mx + cc * cell, y: my + (P.rows - 1 - rr) * cell, width: cell - 0.6, height: cell - 0.6, color: rr === r && cc === c ? accent : rgb(0.85, 0.86, 0.88) });
    }
  }
  out.setTitle('Poster'); out.setProducer('Nibvion');
  return { bytes: await out.save(), plan: P };
}

export async function posterSheet(d) {
  if (!d) return;
  busy(true, 'PDF wird geladen …');
  let bytes, pdf;
  try { bytes = await ctx.docBytes(d); pdf = await loadPdf(bytes.slice ? bytes.slice(0) : bytes); }
  catch (e) { console.error(e); busy(false); closePdf(pdf); return toast('PDF konnte nicht geladen werden', true); }
  const N = pdf.numPages;
  const S = { page: 0, mode: 'grid', cols: 2, rows: 2, scale: 100, overlap: 10, margin: 6, orient: 'auto', marks: true, overview: true };
  let T = null;
  const loadThumb = async () => { T = await thumbCanvas(pdf, S.page + 1, 360); };
  try { await loadThumb(); } catch { busy(false); closePdf(pdf); return toast('Seite konnte nicht gezeichnet werden', true); }
  busy(false);
  const opt = (k, list, cur, fmt = v => v) => `<div class="seg ps-seg" data-k="${k}">${list.map(v => `<button data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${fmt(v)}</button>`).join('')}</div>`;
  sheet({
    title: 'Poster-Druck (Kacheln)',
    html: `
      ${N > 1 ? `<div class="ps-pages"><button class="icon-btn" data-pg="-1">${icon('chevronLeft')}</button><span data-pgl></span><button class="icon-btn" data-pg="1">${icon('chevronRight')}</button></div>` : ''}
      <div class="ps-prev"><canvas data-cv></canvas></div>
      <div class="ps-sum" data-sum></div>
      ${opt('mode', ['grid', 'scale'], 'grid', v => v === 'grid' ? 'Raster' : 'Maßstab')}
      <div data-grid>
        <div class="ps-row"><span>Raster</span>${opt('preset', ['1x2', '2x2', '2x3', '3x3', '4x4'], '2x2', v => v.replace('x', '×'))}</div>
        <div class="ps-row"><span>Spalten × Zeilen</span><div class="ps-step"><button data-st="cols:-1">−</button><b data-cols></b><button data-st="cols:1">+</button><i>×</i><button data-st="rows:-1">−</button><b data-rows></b><button data-st="rows:1">+</button></div></div>
      </div>
      <div data-scalebox hidden>
        <div class="ps-row"><span>Maßstab</span><b class="ps-val" data-scv></b></div>
        <input type="range" class="range" min="25" max="400" step="5" value="100" data-scale>
        <div class="ps-hint" data-orig></div>
      </div>
      <div class="ps-row"><span>Kleberand</span>${opt('overlap', [0, 5, 10, 15, 20], 10, v => v + ' mm')}</div>
      <div class="ps-row"><span>Papier A4</span>${opt('orient', ['auto', 'p', 'l'], 'auto', v => ({ auto: 'Auto', p: 'Hoch', l: 'Quer' })[v])}</div>
      <div class="ps-row"><span>Schnittmarken & Beschriftung</span>${opt('marks', ['1', '0'], '1', v => v === '1' ? 'An' : 'Aus')}</div>
      <div class="ps-row"><span>Übersichtsseite</span>${opt('overview', ['1', '0'], '1', v => v === '1' ? 'An' : 'Aus')}</div>
      <div class="btn-row"><button class="btn primary" data-ok>${icon('grid')} Poster erstellen</button></div>`,
    onMount(el, api) {
      const $ = s => el.querySelector(s), cv = $('[data-cv]');
      const draw = () => {
        const P = posterPlan({ w: T.w, h: T.h }, S);
        const totW = P.cols * P.sx + P.ov, totH = P.rows * P.sy + P.ov;
        const box = cv.parentElement.clientWidth || 320, maxH = 260, dpr = Math.min(2, devicePixelRatio || 1);
        const k = Math.min(box / totW, maxH / totH);
        cv.width = Math.round(totW * k * dpr); cv.height = Math.round(totH * k * dpr);
        cv.style.width = Math.round(totW * k) + 'px'; cv.style.height = Math.round(totH * k) + 'px';
        const g = cv.getContext('2d'); g.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
        g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, 0, totW, totH);
        g.drawImage(T.c, P.offX, P.offY, P.W, P.H);
        for (let r = 0; r < P.rows; r++) for (let c = 0; c < P.cols; c++) {
          const x = c * P.sx, y = r * P.sy;
          if (P.ov) { g.fillStyle = 'rgba(255,106,91,.16)'; if (c < P.cols - 1) g.fillRect(x + P.cw - P.ov, y, P.ov, P.ch); if (r < P.rows - 1) g.fillRect(x, y + P.ch - P.ov, P.cw, P.ov); }
          g.strokeStyle = '#ff6a5b'; g.lineWidth = 1.6 / k; g.strokeRect(x, y, P.cw, P.ch);
          g.fillStyle = 'rgba(255,106,91,.95)'; g.font = `800 ${Math.min(P.cw, P.ch) * 0.16}px -apple-system, Helvetica, Arial`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(tileName(r, c), x + P.cw / 2, y + P.ch / 2);
        }
        const sheets = P.sheets + (S.overview ? 1 : 0);
        $('[data-sum]').innerHTML = `<b>${P.sheets} ${P.sheets === 1 ? 'Blatt' : 'Blätter'}</b> A4 ${P.pw > P.ph ? 'quer' : 'hoch'} (${P.cols} × ${P.rows})${S.overview ? ' + Übersicht' : ''}<span>Poster ${cm(P.W)} × ${cm(P.H)} cm · Maßstab ${Math.round(P.s * 100)} %</span>`;
        if (P.sheets > 100) $('[data-sum]').innerHTML += `<span class="warn">Sehr viele Blätter – Maßstab verkleinern.</span>`;
        $('[data-ok]').disabled = P.sheets > 400;
        $('[data-ok]').lastChild.textContent = ` ${sheets} Seiten erstellen`;
        $('[data-cols]').textContent = S.cols; $('[data-rows]').textContent = S.rows;
        $('[data-scv]').textContent = S.scale + ' %';
        $('[data-orig]').textContent = `Original: ${cm(T.w)} × ${cm(T.h)} cm · 100 % = Originalgröße`;
        el.querySelectorAll('[data-k=preset] button').forEach(b => b.classList.toggle('on', b.dataset.v === `${S.cols}x${S.rows}`));
        $('[data-grid]').hidden = S.mode !== 'grid'; $('[data-scalebox]').hidden = S.mode !== 'scale';
        if ($('[data-pgl]')) $('[data-pgl]').textContent = `Seite ${S.page + 1} von ${N}`;
      };
      el.querySelectorAll('.ps-seg').forEach(g => g.querySelectorAll('button').forEach(b => b.onclick = () => {
        g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); haptic();
        const k = g.dataset.k, v = b.dataset.v;
        if (k === 'preset') { const [c, r] = v.split('x').map(Number); S.cols = c; S.rows = r; }
        else if (k === 'overlap') S.overlap = +v;
        else if (k === 'marks' || k === 'overview') S[k] = v === '1';
        else S[k] = v;
        draw();
      }));
      el.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { const [k, dv] = b.dataset.st.split(':'); S[k] = Math.max(1, Math.min(10, S[k] + +dv)); haptic(); draw(); });
      $('[data-scale]').oninput = e => { S.scale = +e.target.value; draw(); };
      el.querySelectorAll('[data-pg]').forEach(b => b.onclick = async () => {
        const n = S.page + +b.dataset.pg; if (n < 0 || n >= N) return;
        S.page = n; haptic(); await loadThumb(); draw();
      });
      $('[data-ok]').onclick = async () => {
        api.close(); busy(true, 'Poster wird erstellt …');
        try {
          const r = await makePoster(bytes, S.page, S);
          const base = d.name.replace(/\.pdf$/i, '');
          const id = await ctx.saveNewDoc(r.bytes, `${base} – Poster ${r.plan.cols}×${r.plan.rows}.pdf`);
          busy(false); await ctx.renderRecents();
          toast(`${r.plan.sheets} Blätter erstellt – in Originalgröße (100 %) drucken`); ctx.openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Poster konnte nicht erstellt werden', true); }
      };
      requestAnimationFrame(draw);
    },
    onClose() { closePdf(pdf); },
  });
}
