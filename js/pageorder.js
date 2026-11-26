// ================= Duplex-Sortierer & leere Seiten =================
// Duplex: beidseitig ohne Duplex-Einzug gescannt → Vorder- und Rückseiten verzahnen.
//   • Ein PDF: 1. Hälfte = Vorderseiten (1, 3, 5), 2. Hälfte = Rückseiten (meist rückwärts: 6, 4, 2)
//   • Zwei PDFs: A = Vorderseiten, B = Rückseiten (wahlweise rückwärts)
// Leere Seiten: pdf.js-Text + Pixel-Analyse einer kleinen Vorschau (Papier-Rauschen, Durchscheinen,
//   Scanner-Ränder werden ignoriert) → Auswahl mit Vorschaubildern, dann löschen.
import { icon } from './icons.js';
import { toast, busy, sheet, esc, haptic, fmtDate } from './ui.js';
import { loadPdf, closePdf } from './pdfcore.js';

const L = () => window.PDFLib;
let ctx = {};
export function initPageOrder(c) { ctx = c; }

// ---------------------------------------------------------------------------------
// Reihenfolgen
// ---------------------------------------------------------------------------------
/** Ein Stapel mit n Seiten → neue Reihenfolge (0-basierte Indizes) */
export function duplexOrder(n, reverseBacks = true) {
  const nf = Math.ceil(n / 2), fronts = [...Array(nf).keys()], backs = [...Array(n - nf).keys()].map(k => nf + k);
  if (reverseBacks) backs.reverse();
  const out = [];
  for (let k = 0; k < nf; k++) { out.push({ i: fronts[k], side: 'V', sheet: k + 1 }); if (k < backs.length) out.push({ i: backs[k], side: 'R', sheet: k + 1 }); }
  return out;
}
/** Zwei Stapel: A (Vorderseiten, nA) + B (Rückseiten, nB) → [{ src: 'a'|'b', i }] */
export function interleaveOrder(nA, nB, reverseBacks = true) {
  const backs = [...Array(nB).keys()];
  if (reverseBacks) backs.reverse();
  const out = [], m = Math.max(nA, nB);
  for (let k = 0; k < m; k++) {
    if (k < nA) out.push({ src: 'a', i: k, side: 'V', sheet: k + 1 });
    if (k < nB) out.push({ src: 'b', i: backs[k], side: 'R', sheet: k + 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Leere Seiten erkennen
// ---------------------------------------------------------------------------------
export const BLANK_LEVELS = {
  strict: { label: 'Streng', sub: 'Nur wirklich leere Seiten', t: 30, max: 0.0006 },
  normal: { label: 'Normal', sub: 'Leer trotz Papier-Rauschen', t: 48, max: 0.0025 },
  loose: { label: 'Großzügig', sub: 'Auch durchscheinende Rückseiten', t: 80, max: 0.008 },
};

/** Eine Seite analysieren → { thumb, text, dens: Float32Array(256), w, h } */
export async function analyzePage(pdf, no, width = 240) {
  const p = await pdf.getPage(no);
  let text = 0;
  try { const tc = await p.getTextContent(); for (const it of tc.items) text += (it.str || '').replace(/\s+/g, '').length; } catch {}
  const v = p.getViewport({ scale: 1 }), vp = p.getViewport({ scale: width / v.width });
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await p.render({ canvasContext: g, viewport: vp }).promise;
  const { width: W, height: H } = c, d = g.getImageData(0, 0, W, H).data;
  // Rand (Scanner-Schatten, Lochung, Heftklammer) ignorieren
  const mx = Math.round(W * 0.06), my = Math.round(H * 0.05);
  const lum = new Uint8Array(W * H);
  for (let i = 0, k = 0; k < lum.length; i += 4, k++) lum[k] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  // 3×3-Mittelwert gegen Rauschen/Staubkörner, Papierfarbe = 90. Perzentil (helle Seite)
  const hist = new Uint32Array(256), vals = [];
  for (let y = my + 1; y < H - my - 1; y++) for (let x = mx + 1; x < W - mx - 1; x++) {
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) { const o = (y + dy) * W + x; s += lum[o - 1] + lum[o] + lum[o + 1]; }
    const m = (s / 9) | 0; vals.push(m); hist[m]++;
  }
  const n = vals.length || 1;
  let acc = 0, paper = 255;
  for (let l = 0; l < 256; l++) { acc += hist[l]; if (acc >= n * 0.9) { paper = l; break; } }
  // dens[t] = Anteil der Pixel, die mindestens t dunkler als das Papier sind
  const dh = new Uint32Array(256);
  for (const m of vals) dh[Math.max(0, paper - m)]++;
  const dens = new Float32Array(256);
  for (let t = 255, run = 0; t >= 0; t--) { run += dh[t]; dens[t] = run / n; }
  return { thumb: c.toDataURL('image/jpeg', 0.7), text, dens, paper, w: W, h: H };
}

export function isBlank(a, level = 'normal') {
  const L0 = BLANK_LEVELS[level] || BLANK_LEVELS.normal;
  if (a.text > (level === 'loose' ? 2 : 0)) return false;
  if (a.paper < 70) return false;                    // fast komplett dunkle Seite (Foto, Deckblatt)
  return a.dens[L0.t] <= L0.max;
}

/** Alle Seiten prüfen (mit Fortschritt) */
export async function analyzeAll(pdf, onProgress) {
  const res = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i, pdf.numPages);
    try { res.push(await analyzePage(pdf, i)); } catch (e) { console.warn(e); res.push({ thumb: '', text: 1, dens: new Float32Array(256).fill(1), paper: 255 }); }
    if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
  }
  return res;
}

/**
 * Auswahl-Sheet: erkannte leere Seiten vorausgewählt.
 * onApply(Set der 0-basierten Indizes) · opts.copyRow/bindCopy für „Als Kopie speichern“
 */
export function blankReview(an, { onApply, title = 'Leere Seiten', withCopy = false, copy = true }) {
  let level = 'normal', showAll = false;
  const N = an.length;
  const detect = () => new Set(an.map((a, i) => isBlank(a, level) ? i : -1).filter(i => i >= 0));
  let sel = detect();
  sheet({
    title,
    html: `<div class="seg bl-lv" data-lv style="width:100%">${Object.entries(BLANK_LEVELS).map(([k, v]) => `<button data-v="${k}" class="${k === level ? 'on' : ''}">${v.label}</button>`).join('')}</div>
      <p class="bl-sum" data-sum></p>
      <div class="page-grid bl-grid" data-grid></div>
      <button class="bl-all" data-all></button>
      ${withCopy ? ctx.copyRow(copy) : ''}
      <div class="btn-row"><button class="btn danger" data-ok>${icon('trash')} <span data-okl>Löschen</span></button></div>`,
    onMount(el, api) {
      const grid = el.querySelector('[data-grid]'), ok = el.querySelector('[data-ok]');
      if (withCopy) ctx.bindCopy(el, () => copy, v => copy = v);
      const render = () => {
        const found = detect();
        const list = showAll ? an.map((_, i) => i) : [...new Set([...found, ...sel])].sort((a, b) => a - b);
        el.querySelector('[data-sum]').innerHTML = found.size
          ? `<b>${found.size} leere ${found.size === 1 ? 'Seite' : 'Seiten'}</b> von ${N} gefunden · ${BLANK_LEVELS[level].sub}`
          : `Keine leeren Seiten gefunden (${BLANK_LEVELS[level].sub.toLowerCase()}).`;
        grid.innerHTML = list.length ? list.map(i => `<button class="pg bl-pg ${sel.has(i) ? 'on' : ''}" data-i="${i}">
            <div class="pg-img" style="background-image:url(${an[i].thumb})"></div>
            <span class="bl-ck">${icon('check')}</span><div class="pg-n">${i + 1}${found.has(i) ? ' · leer' : ''}</div></button>`).join('')
          : `<div class="bl-none">${icon('check')}<span>Alle Seiten haben Inhalt</span></div>`;
        grid.querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
          const i = +b.dataset.i; sel.has(i) ? sel.delete(i) : sel.add(i); haptic();
          b.classList.toggle('on', sel.has(i)); upd();
        });
        el.querySelector('[data-all]').innerHTML = showAll ? `${icon('chevronLeft')} Nur leere Seiten zeigen` : `${icon('pages')} Alle ${N} Seiten zeigen`;
        upd();
      };
      const upd = () => {
        ok.disabled = !sel.size || sel.size >= N;
        el.querySelector('[data-okl]').textContent = sel.size >= N && N ? 'Mindestens eine Seite muss bleiben' : sel.size ? `${sel.size} ${sel.size === 1 ? 'Seite' : 'Seiten'} löschen` : 'Keine Seite gewählt';
      };
      el.querySelectorAll('[data-lv] button').forEach(b => b.onclick = () => {
        level = b.dataset.v; haptic();
        el.querySelectorAll('[data-lv] button').forEach(x => x.classList.toggle('on', x === b));
        sel = detect(); render();
      });
      el.querySelector('[data-all]').onclick = () => { showAll = !showAll; haptic(); render(); };
      ok.onclick = () => { if (!sel.size || sel.size >= N) return; api.close(); onApply(new Set(sel), copy); };
      render();
    },
  });
}

/** Werkzeug „Leere Seiten entfernen“ für ein gespeichertes Dokument */
export async function blankTool(d) {
  if (!d) return;
  busy(true, 'PDF wird geladen …');
  let bytes, pdf, an;
  try {
    bytes = await ctx.docBytes(d);
    pdf = await loadPdf(bytes.slice ? bytes.slice(0) : bytes);
    an = await analyzeAll(pdf, (i, n) => busy(true, `Seite ${i} von ${n} wird geprüft …`));
  } catch (e) { console.error(e); busy(false); closePdf(pdf); return toast('PDF konnte nicht geprüft werden', true); }
  closePdf(pdf); busy(false);
  if (an.length < 2) return toast('Das PDF hat nur eine Seite');
  blankReview(an, {
    title: 'Leere Seiten entfernen', withCopy: true, copy: false,
    async onApply(del, copy) {
      busy(true, 'Seiten werden gelöscht …');
      try {
        const keep = an.map((_, i) => i).filter(i => !del.has(i));
        const out = await reorderBytes(bytes, keep);
        const id = await ctx.storeResult(d, out, 'ohne leere Seiten', copy);
        busy(false); await ctx.renderRecents();
        toast(`${del.size} ${del.size === 1 ? 'leere Seite' : 'leere Seiten'} entfernt`);
        ctx.openDoc(id);
      } catch (e) { console.error(e); busy(false); toast('Seiten konnten nicht gelöscht werden', true); }
    },
  });
}

async function reorderBytes(bytes, idx) {
  const { PDFDocument } = L();
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  (await out.copyPages(src, idx)).forEach(p => out.addPage(p));
  return out.save();
}

// ---------------------------------------------------------------------------------
// Duplex-Werkzeug
// ---------------------------------------------------------------------------------
async function thumbsOf(pdf, width = 130, onEach) {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i), v = p.getViewport({ scale: 1 }), vp = p.getViewport({ scale: width / v.width });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: g, viewport: vp }).promise;
    out.push(c.toDataURL('image/jpeg', 0.7)); onEach?.(i, pdf.numPages);
  }
  return out;
}

/** Vorschau-Kacheln für eine Reihenfolge */
export function duplexPreviewHtml(list, thumb, max = 60) {
  const shown = list.slice(0, max);
  return shown.map((p, k) => `<div class="pg dx-pg ${p.side === 'R' ? 'back' : ''}" style="animation-delay:${Math.min(k, 24) * 18}ms">
      <div class="pg-img" style="background-image:url(${thumb(p) || ''})"></div>
      <span class="dx-side">${p.side === 'V' ? 'Vorne' : 'Hinten'} ${p.sheet}</span>
      <div class="pg-n">${k + 1}<small>${p.src ? p.src.toUpperCase() + ' ' : 'aus '}S. ${p.i + 1}</small></div></div>`).join('')
    + (list.length > max ? `<div class="dx-more">+ ${list.length - max} weitere</div>` : '');
}

export async function duplexSheet() {
  const docs = await ctx.allDocs();
  const S = { mode: 'one', reverse: true, copy: true, pick: [], data: {} };   // data[id] = { pdf, bytes, thumbs }
  sheet({
    title: 'Duplex sortieren',
    html: `<div class="seg dx-mode" data-mode style="width:100%"><button data-v="one" class="on">Ein PDF</button><button data-v="two">Zwei PDFs</button></div>
      <p class="dx-hint" data-hint></p>
      <div class="menu dx-list" data-list></div>
      <div class="row" style="padding:12px 2px 2px;border:0"><span class="row-main"><span class="row-title">Rückseiten rückwärts</span><span class="row-sub" data-revsub style="display:block"></span></span>
        <div class="seg" data-rev><button data-v="1" class="on">An</button><button data-v="0">Aus</button></div></div>
      <div data-copywrap>${ctx.copyRow(true)}</div>
      <div class="lbl" data-plbl hidden>Neue Reihenfolge</div>
      <p class="dx-warn" data-warn hidden></p>
      <div class="page-grid dx-grid" data-prev></div>
      <div class="btn-row"><button class="btn" data-imp>${icon('filePlus')} Importieren</button><button class="btn primary" data-ok disabled>${icon('pages')} Sortieren</button></div>`,
    onMount(el, api) {
      const $ = s => el.querySelector(s);
      ctx.bindCopy($('[data-copywrap]'), () => S.copy, v => S.copy = v);
      const need = () => S.mode === 'one' ? 1 : 2;
      const plan = () => {
        if (S.pick.length < need() || S.pick.some(id => !S.data[id]?.thumbs)) return null;
        if (S.mode === 'one') return duplexOrder(S.data[S.pick[0]].pdf.numPages, S.reverse);
        return interleaveOrder(S.data[S.pick[0]].pdf.numPages, S.data[S.pick[1]].pdf.numPages, S.reverse);
      };
      const thumbFor = p => S.mode === 'one' ? S.data[S.pick[0]].thumbs[p.i] : S.data[S.pick[p.src === 'a' ? 0 : 1]].thumbs[p.i];
      const renderList = () => {
        $('[data-hint]').innerHTML = S.mode === 'one'
          ? 'Wähle den gescannten Stapel: <b>erst alle Vorderseiten, dann alle Rückseiten</b> (Stapel umgedreht und nochmal eingelegt).'
          : 'Tippe zuerst das PDF mit den <b>Vorderseiten (A)</b>, dann das mit den <b>Rückseiten (B)</b> an.';
        $('[data-revsub]').textContent = S.mode === 'one'
          ? (S.reverse ? 'z. B. 1, 3, 5 · 6, 4, 2 → 1–6 (Stapel umgedreht)' : 'z. B. 1, 3, 5 · 2, 4, 6 → 1–6')
          : (S.reverse ? 'Rückseiten-PDF beginnt mit der letzten Rückseite' : 'Rückseiten-PDF beginnt mit der ersten Rückseite');
        $('[data-copywrap]').hidden = S.mode === 'two';
        const list = $('[data-list]');
        list.innerHTML = docs.length ? docs.slice(0, 30).map(d => {
          const k = S.pick.indexOf(d.id), tag = k < 0 ? '' : S.mode === 'one' ? '✓' : 'AB'[k];
          return `<button class="row" data-id="${d.id}"><span class="doc-thumb" style="width:34px;height:44px;background-image:url('${d.thumb || ''}')">${tag ? `<b class="dx-tag ${S.mode === 'two' ? 'ab' + k : ''}">${tag}</b>` : ''}</span><span class="row-main"><span class="row-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span><span class="row-sub">${d.pages || 1} Seiten · ${fmtDate(d.updated)}</span></span></button>`;
        }).join('') : `<div class="empty" style="border:0">Noch keine PDFs – importiere den Scan.</div>`;
        list.querySelectorAll('[data-id]').forEach(b => b.onclick = () => toggle(b.dataset.id));
        renderPrev();
      };
      const renderPrev = () => {
        const pl = plan(), prev = $('[data-prev]'), warn = $('[data-warn]');
        $('[data-plbl]').hidden = !pl; $('[data-ok]').disabled = !pl;
        if (!pl) { prev.innerHTML = S.pick.length >= need() ? `<div class="dx-more">${icon('search')} Vorschau wird erstellt …</div>` : ''; warn.hidden = true; return; }
        let w = '';
        if (S.mode === 'one') { const n = S.data[S.pick[0]].pdf.numPages; if (n < 2) w = 'Das PDF hat nur eine Seite.'; else if (n % 2) w = `Ungerade Seitenzahl (${n}) – die letzte Vorderseite bleibt ohne Rückseite. Prüfe, ob eine Seite fehlt.`; }
        else { const a = S.data[S.pick[0]].pdf.numPages, b = S.data[S.pick[1]].pdf.numPages; if (a !== b) w = `A hat ${a}, B hat ${b} Seiten – überzählige Seiten kommen ans Ende.`; }
        warn.hidden = !w; warn.textContent = w;
        prev.innerHTML = duplexPreviewHtml(pl, thumbFor);
        $('[data-ok]').disabled = S.mode === 'one' && S.data[S.pick[0]].pdf.numPages < 2;
      };
      const load = async id => {
        if (S.data[id]) return;
        const d = docs.find(x => x.id === id);
        S.data[id] = { loading: true };
        try {
          const bytes = await ctx.docBytes(d), pdf = await loadPdf(bytes.slice ? bytes.slice(0) : bytes);
          S.data[id] = { bytes, pdf, doc: d };
          S.data[id].thumbs = await thumbsOf(pdf, 130);
        } catch (e) { console.error(e); delete S.data[id]; S.pick = S.pick.filter(x => x !== id); toast('PDF konnte nicht geladen werden', true); }
        if (!api.closed) renderList();
      };
      const toggle = id => {
        haptic();
        const k = S.pick.indexOf(id);
        if (k >= 0) S.pick.splice(k, 1);
        else { if (S.pick.length >= need()) S.pick.shift(); S.pick.push(id); }
        renderList(); S.pick.forEach(load);
      };
      el.querySelectorAll('[data-mode] button').forEach(b => b.onclick = () => {
        S.mode = b.dataset.v; haptic();
        el.querySelectorAll('[data-mode] button').forEach(x => x.classList.toggle('on', x === b));
        S.pick = S.pick.slice(0, need()); renderList();
      });
      el.querySelectorAll('[data-rev] button').forEach(b => b.onclick = () => {
        S.reverse = b.dataset.v === '1'; haptic();
        el.querySelectorAll('[data-rev] button').forEach(x => x.classList.toggle('on', x === b));
        renderList();
      });
      $('[data-imp]').onclick = async () => {
        const ids = await ctx.importPdfs(); if (!ids.length) return;
        docs.splice(0, docs.length, ...(await ctx.allDocs()));
        for (const id of ids) { if (S.pick.length >= need()) S.pick.shift(); S.pick.push(id); }
        renderList(); S.pick.forEach(load);
      };
      $('[data-ok]').onclick = async () => {
        const pl = plan(); if (!pl) return;
        api.close(); busy(true, 'Seiten werden sortiert …');
        try {
          let id;
          if (S.mode === 'one') {
            const D = S.data[S.pick[0]];
            id = await ctx.storeResult(D.doc, await reorderBytes(D.bytes, pl.map(p => p.i)), 'sortiert', S.copy);
          } else {
            const { PDFDocument } = L();
            const [A, B] = S.pick.map(x => S.data[x]);
            const out = await PDFDocument.create();
            const sa = await PDFDocument.load(A.bytes, { ignoreEncryption: true }), sb = await PDFDocument.load(B.bytes, { ignoreEncryption: true });
            const pa = await out.copyPages(sa, sa.getPageIndices()), pb = await out.copyPages(sb, sb.getPageIndices());
            pl.forEach(p => out.addPage((p.src === 'a' ? pa : pb)[p.i]));
            id = await ctx.saveNewDoc(await out.save(), `${A.doc.name.replace(/\.pdf$/i, '')} (beidseitig).pdf`);
          }
          busy(false); await ctx.renderRecents();
          toast(`${pl.length} Seiten in richtiger Reihenfolge`);
          ctx.openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Sortieren fehlgeschlagen', true); }
      };
      renderList();
    },
    onClose() { Object.values(S.data).forEach(x => x.pdf && closePdf(x.pdf)); },
  });
}
