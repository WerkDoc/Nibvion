// ================= Papier- & Notizbuch-Generator =================
// Vorlagen (Blanko, Liniert, Kariert, Punktraster, Millimeter, Notenlinien, Cornell) werden mit
// EINER Zeichenfunktion beschrieben und doppelt ausgegeben: als echte Vektorlinien ins PDF
// (pdf-lib, rohe Pfad-Operatoren → winzige Dateien, gestochen scharf) und als Canvas-Vorschau.
import { icon } from './icons.js';
import { sheet, haptic } from './ui.js';
import { settings } from './settings.js';

const MM = 72 / 25.4;
export const SIZES = { a4: { label: 'DIN A4', w: 595.28, h: 841.89 }, a5: { label: 'DIN A5', w: 419.53, h: 595.28 } };
export const TEMPLATES = [
  { id: 'blank', label: 'Blanko' },
  { id: 'lined', label: 'Liniert' },
  { id: 'grid', label: 'Kariert' },
  { id: 'dots', label: 'Punktraster' },
  { id: 'mm', label: 'Millimeter' },
  { id: 'music', label: 'Notenlinien' },
  { id: 'cornell', label: 'Cornell' },
];
export const PAPERS = {
  white: { label: 'Reinweiß', bg: '#ffffff', dark: false },
  cream: { label: 'Warmes Creme', bg: '#fbf5e6', dark: false },
  dark: { label: 'Anthrazit', bg: '#2a2d34', dark: true },
};
// Linienfarbe je Papier (auf Anthrazit heller/kräftiger, damit sie sichtbar bleibt)
export const INKS = {
  gray: { label: 'Grau', light: '#b4b9c3', dark: '#5f6571' },
  blue: { label: 'Hellblau', light: '#93bde4', dark: '#4f7fae' },
  coral: { label: 'Koralle', light: '#ff9a8c', dark: '#d8685b' },
};
const hex = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/**
 * Beschreibt eine Seite über einen „Stift“ (Ursprung OBEN links, Einheit pt):
 *   pen.lines(width, alpha, segs[[x1,y1,x2,y2]…]), pen.dots(r, alpha, pts[[x,y]…]), pen.label(text, x, y, size, alpha)
 */
export function describe(tpl, W, H, pen) {
  const m = 12 * MM;                                  // Rand
  const k = Math.min(1, W / SIZES.a4.w) ** 0.5;       // A5 etwas feiner
  const hl = (y0, y1, step, x0 = m, x1 = W - m) => { const s = []; for (let y = y0; y <= y1 + 0.01; y += step) s.push([x0, y, x1, y]); return s; };
  const vl = (x0, x1, step, y0 = m, y1 = H - m) => { const s = []; for (let x = x0; x <= x1 + 0.01; x += step) s.push([x, y0, x, y1]); return s; };
  // Raster an den Rand angepasst: ganze Kästchen, mittig
  const fit = (len, step) => { const n = Math.floor((len - 2 * m) / step); return { n, off: (len - n * step) / 2 }; };
  switch (tpl) {
    case 'blank': return;
    case 'lined': {
      const step = 8 * MM * k, top = 22 * MM * k;
      pen.lines(0.55, 0.9, hl(top, H - 12 * MM * k, step, m * 0.8, W - m * 0.8));
      pen.lines(0.7, 0.75, [[m + 14 * MM * k, m * 0.6, m + 14 * MM * k, H - m * 0.6]]);       // Randlinie
      return;
    }
    case 'grid': case 'dots': {
      const step = 5 * MM, fx = fit(W, step), fy = fit(H, step);
      if (tpl === 'grid') pen.lines(0.4, 0.85, [...hl(fy.off, H - fy.off, step, fx.off, W - fx.off), ...vl(fx.off, W - fx.off, step, fy.off, H - fy.off)]);
      else { const p = []; for (let y = fy.off; y <= H - fy.off + 0.01; y += step) for (let x = fx.off; x <= W - fx.off + 0.01; x += step) p.push([x, y]); pen.dots(0.75, 1, p); }
      return;
    }
    case 'mm': {
      const step = MM, fx = fit(W, 10 * MM), fy = fit(H, 10 * MM);
      const x0 = fx.off, x1 = W - fx.off, y0 = fy.off, y1 = H - fy.off;
      const fine = [], mid = [], bold = [];
      for (let i = 0, x = x0; x <= x1 + 0.01; i++, x += step) (i % 10 === 0 ? bold : i % 5 === 0 ? mid : fine).push([x, y0, x, y1]);
      for (let i = 0, y = y0; y <= y1 + 0.01; i++, y += step) (i % 10 === 0 ? bold : i % 5 === 0 ? mid : fine).push([x0, y, x1, y]);
      pen.lines(0.18, 0.7, fine); pen.lines(0.4, 0.85, mid); pen.lines(0.7, 1, bold);
      return;
    }
    case 'music': {
      const gap = 2 * MM * k, staff = gap * 4, between = 11 * MM * k, top = 18 * MM * k;
      const n = Math.floor((H - top - 14 * MM * k + between) / (staff + between));
      const used = n * staff + (n - 1) * between, start = top + (H - top - 14 * MM * k - used) / 2;
      const s = [];
      for (let i = 0; i < n; i++) { const y = start + i * (staff + between); for (let j = 0; j < 5; j++) s.push([m, y + j * gap, W - m, y + j * gap]); }
      pen.lines(0.55, 1, s);
      return;
    }
    case 'cornell': {
      const head = 24 * MM * k, cue = W * 0.3, sum = H * 0.2, step = 8 * MM * k;
      pen.lines(0.5, 0.55, hl(head + step, H - sum - step * 0.5, step, cue + 3 * MM, W - m * 0.8));
      pen.lines(1.1, 1, [[m * 0.8, head, W - m * 0.8, head], [cue, head, cue, H - sum], [m * 0.8, H - sum, W - m * 0.8, H - sum]]);
      const fs = 7.5 * k;
      pen.label('Thema · Datum', m * 0.8, head - 4 * MM * k, fs, 0.9);
      pen.label('Stichworte & Fragen', m * 0.8, head + 5 * MM * k, fs, 0.9);
      pen.label('Notizen', cue + 3 * MM, head + 5 * MM * k, fs, 0.9);
      pen.label('Zusammenfassung', m * 0.8, H - sum + 5 * MM * k, fs, 0.9);
      return;
    }
  }
}

const colorsOf = o => {
  const p = PAPERS[o.paper] || PAPERS.white, ink = INKS[o.ink] || INKS.gray;
  return { bg: p.bg, ink: p.dark ? ink.dark : ink.light, dark: p.dark };
};

// ---------- PDF-Ausgabe (Vektor) ----------
/** Fügt `n` Vorlagenseiten an ein pdf-lib-Dokument an (an Position `at`, sonst ans Ende) */
export async function addPaperPages(doc, o, at = null) {
  const L = window.PDFLib;
  const { W, H } = o;
  const c = colorsOf(o);
  const [ir, ig, ib] = hex(c.ink), [br, bg, bb] = hex(c.bg);
  const needFont = o.tpl === 'cornell';
  const font = needFont ? await doc.embedFont(L.StandardFonts.Helvetica) : null;
  for (let p = 0; p < o.n; p++) {
    const page = at == null ? doc.addPage([W, H]) : doc.insertPage(at + p, [W, H]);
    const ops = [L.pushGraphicsState()];
    if (o.paper !== 'white') ops.push(L.setFillingRgbColor(br, bg, bb), L.rectangle(0, 0, W, H), L.fill());
    ops.push(L.setStrokingRgbColor(ir, ig, ib));
    // Einheitliche Deckkraft über die Farbe (Mischung mit dem Papier) statt ExtGState → überall gleich
    const mix = a => [br + (ir - br) * a, bg + (ig - bg) * a, bb + (ib - bb) * a];
    const labels = [];
    describe(o.tpl, W, H, {
      lines(w, a, segs) {
        if (!segs.length) return;
        ops.push(L.setStrokingRgbColor(...mix(a)), L.setLineWidth(w), L.setLineCap(L.LineCapStyle.Butt));
        for (const [x1, y1, x2, y2] of segs) ops.push(L.moveTo(+x1.toFixed(2), +(H - y1).toFixed(2)), L.lineTo(+x2.toFixed(2), +(H - y2).toFixed(2)));
        ops.push(L.stroke());
      },
      dots(r, a, pts) {
        // Punkt = Strich der Länge 0 mit runder Kappe → 1 Pfad für alle Punkte
        ops.push(L.setStrokingRgbColor(...mix(a)), L.setLineWidth(r * 2), L.setLineCap(L.LineCapStyle.Round));
        for (const [x, y] of pts) { const X = +x.toFixed(2), Y = +(H - y).toFixed(2); ops.push(L.moveTo(X, Y), L.lineTo(X, Y)); }
        ops.push(L.stroke());
      },
      label(t, x, y, size, a) { labels.push([t, x, y, size, a]); },
    });
    ops.push(L.popGraphicsState());
    page.pushOperators(...ops);
    for (const [t, x, y, size, a] of labels) page.drawText(t, { x, y: H - y, size, font, color: L.rgb(...mix(a)) });
  }
}

/** Neues PDF mit Vorlage */
export async function paperPdf(o) {
  const doc = await window.PDFLib.PDFDocument.create();
  doc.setProducer('Nibvion'); doc.setCreator('Nibvion');
  doc.setTitle(`${TEMPLATES.find(t => t.id === o.tpl)?.label || 'Papier'} ${SIZES[o.size]?.label || ''}`.trim());
  await addPaperPages(doc, o);
  return doc.save();
}

/** Vorlagenseiten in vorhandene PDF-Bytes einfügen (nach Seite `after`, 0-basiert; null = ans Ende) */
export async function insertPaper(bytes, o, after = null) {
  const doc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  await addPaperPages(doc, o, after == null ? null : after + 1);
  return doc.save();
}

// ---------- Canvas-Vorschau ----------
export function drawPreview(cv, o, cssW) {
  const { W, H } = o, dpr = Math.min(3, devicePixelRatio || 1);
  const pw = cssW, ph = Math.round(cssW * H / W);
  cv.width = Math.round(pw * dpr); cv.height = Math.round(ph * dpr);
  cv.style.width = pw + 'px'; cv.style.height = ph + 'px';
  const g = cv.getContext('2d'), s = cv.width / W, c = colorsOf(o);
  const [br, bgc, bb] = hex(c.bg), [ir, ig, ib] = hex(c.ink);
  const mix = a => `rgb(${Math.round((br + (ir - br) * a) * 255)},${Math.round((bgc + (ig - bgc) * a) * 255)},${Math.round((bb + (ib - bb) * a) * 255)})`;
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = c.bg; g.fillRect(0, 0, cv.width, cv.height);
  g.setTransform(s, 0, 0, s, 0, 0);
  const minW = 0.6 / s;                               // Vorschau: Linien mind. ~0,6 Gerätepixel
  describe(o.tpl, W, H, {
    lines(w, a, segs) { g.strokeStyle = mix(a); g.lineWidth = Math.max(w, minW); g.lineCap = 'butt'; g.beginPath(); for (const [x1, y1, x2, y2] of segs) { g.moveTo(x1, y1); g.lineTo(x2, y2); } g.stroke(); },
    dots(r, a, pts) { g.fillStyle = mix(a); const rr = Math.max(r, minW * 0.7); g.beginPath(); for (const [x, y] of pts) { g.moveTo(x + rr, y); g.arc(x, y, rr, 0, 7); } g.fill(); },
    label(t, x, y, size, a) { g.fillStyle = mix(a); g.font = `${size}px -apple-system, Helvetica, Arial, sans-serif`; g.fillText(t, x, y); },
  });
}

// ---------- Auswahl-Sheet ----------
/**
 * paperSheet({ title, okLabel, sizes: ['a4','a5'] | ['doc','a4','a5'], docSize: {w,h}, maxPages })
 * → Promise<{ tpl, paper, ink, n, size, W, H } | null>
 */
export function paperSheet({ title = 'Neues Papier', okLabel = 'Erstellen', sizes = ['a4', 'a5'], docSize = null, maxPages = 50 } = {}) {
  const saved = settings.get('paperOpts') || {};
  const o = { tpl: 'lined', paper: 'white', ink: 'gray', n: 1, size: sizes[0], ...saved };
  if (!sizes.includes(o.size)) o.size = sizes[0];
  o.n = Math.max(1, Math.min(maxPages, +o.n || 1));
  const dims = () => o.size === 'doc' && docSize ? { W: docSize.w, H: docSize.h } : { W: SIZES[o.size].w, H: SIZES[o.size].h };
  let result = null;
  return new Promise(res => sheet({
    title,
    html: `<div class="pp-prev"><canvas data-big></canvas></div>
      <div class="lbl">Vorlage</div>
      <div class="pp-tpls no-swipe" data-tpls>${TEMPLATES.map(t => `<button class="pp-tpl" data-t="${t.id}"><canvas></canvas><span>${t.label}</span></button>`).join('')}</div>
      <div class="lbl">Papier</div>
      <div class="pp-sw" data-paper>${Object.entries(PAPERS).map(([k, p]) => `<button data-v="${k}"><i style="background:${p.bg}"></i>${p.label}</button>`).join('')}</div>
      <div class="lbl">Linien</div>
      <div class="pp-sw" data-ink>${Object.entries(INKS).map(([k, p]) => `<button data-v="${k}"><i style="background:${p.light}"></i>${p.label}</button>`).join('')}</div>
      <div class="pp-row">
        <div><div class="lbl">Format</div><div class="seg" data-size>${sizes.map(s => `<button data-v="${s}">${s === 'doc' ? 'Wie PDF' : SIZES[s].label.replace('DIN ', '')}</button>`).join('')}</div></div>
        <div><div class="lbl">Seiten</div><div class="pp-step"><button data-dn aria-label="Weniger">${icon('minus')}</button><input data-n type="number" inputmode="numeric" min="1" max="${maxPages}"><button data-up aria-label="Mehr">${icon('plus')}</button></div></div>
      </div>
      <div class="btn-row"><button class="btn primary" data-ok>${icon('filePlus')} <span data-okl></span></button></div>`,
    onMount(el, api) {
      const big = el.querySelector('[data-big]'), nIn = el.querySelector('[data-n]');
      const paint = (thumbs = false) => {
        const d = dims(), base = { ...o, ...d };
        drawPreview(big, base, Math.min(150, (el.clientWidth || 340) * 0.4));
        big.parentElement.classList.toggle('dark', PAPERS[o.paper].dark);
        if (thumbs) el.querySelectorAll('[data-t]').forEach(b => drawPreview(b.querySelector('canvas'), { ...base, tpl: b.dataset.t }, 58));
        el.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === o.tpl));
        for (const k of ['paper', 'ink', 'size']) el.querySelectorAll(`[data-${k}] [data-v]`).forEach(b => b.classList.toggle('on', b.dataset.v === o[k]));
        nIn.value = o.n;
        el.querySelector('[data-okl]').textContent = `${okLabel} · ${o.n} ${o.n === 1 ? 'Seite' : 'Seiten'}`;
      };
      el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { o.tpl = b.dataset.t; haptic(); paint(); });
      for (const k of ['paper', 'ink', 'size']) el.querySelectorAll(`[data-${k}] [data-v]`).forEach(b => b.onclick = () => { o[k] = b.dataset.v; haptic(); paint(true); });
      const setN = v => { o.n = Math.max(1, Math.min(maxPages, Math.round(+v) || 1)); paint(); };
      el.querySelector('[data-dn]').onclick = () => { haptic(); setN(o.n - 1); };
      el.querySelector('[data-up]').onclick = () => { haptic(); setN(o.n + 1); };
      nIn.onchange = () => setN(nIn.value);
      el.querySelector('[data-ok]').onclick = () => {
        settings.set('paperOpts', { tpl: o.tpl, paper: o.paper, ink: o.ink, n: o.n, size: o.size === 'doc' ? (saved.size || 'a4') : o.size });
        result = { ...o, ...dims() }; api.close();
      };
      paint(true);
    },
    onClose: () => res(result),
  }));
}

export const paperName = o => `${TEMPLATES.find(t => t.id === o.tpl)?.label || 'Papier'} ${o.size === 'doc' ? '' : SIZES[o.size]?.label.replace('DIN ', '') || ''}`.trim();
