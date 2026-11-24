// ================= PDF aufteilen =================
// Jede Seite einzeln, alle X Seiten, eigene Bereiche („1-3, 5, 8-10“) oder ausgewählte Seiten
// herausziehen. Die Teile werden als neue PDFs gespeichert (im selben Ordner wie das Original).
import { icon } from './icons.js';
import { toast, busy, sheet, esc, haptic } from './ui.js';
import { loadPdf, closePdf, renderThumb } from './pdfcore.js';

const L = () => window.PDFLib;

// „1-3, 5, 8-“ → [[0,1,2],[4],[7,…]] (Seiten 0-basiert); Fehler als Text
export function parseRanges(text, n) {
  const groups = [];
  for (const raw of String(text).split(/[;,]/)) {
    const s = raw.trim().replace(/\s+/g, '').replace(/[–—]/g, '-');
    if (!s) continue;
    const m = s.match(/^(\d*)-(\d*)$|^(\d+)$/);
    if (!m) return { error: `„${raw.trim()}“ verstehe ich nicht` };
    let a, b;
    if (m[3]) a = b = +m[3];
    else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
    if (a < 1 || b < 1 || a > n || b > n) return { error: `Seite ${Math.max(a, b) > n ? Math.max(a, b) : Math.min(a, b)} gibt es nicht (1–${n})` };
    const g = [];
    if (a <= b) for (let i = a; i <= b; i++) g.push(i - 1);
    else for (let i = a; i >= b; i--) g.push(i - 1);
    groups.push(g);
  }
  if (!groups.length) return { error: 'Bitte Seiten angeben, z. B. 1-3, 4-6' };
  return { groups };
}

export function everyN(n, k) {
  const g = [];
  for (let i = 0; i < n; i += k) g.push(Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j));
  return g;
}

const label = g => {
  // [0,1,2,4] → „1-3, 5“
  const parts = []; let s = g[0], p = g[0];
  for (let k = 1; k <= g.length; k++) {
    if (k < g.length && g[k] === p + 1) { p = g[k]; continue; }
    parts.push(s === p ? `${s + 1}` : `${s + 1}-${p + 1}`);
    if (k < g.length) { s = p = g[k]; }
  }
  return parts.join(', ');
};
export { label as groupLabel };

export async function splitPdf(bytes, groups) {
  const { PDFDocument } = L();
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = [];
  for (const g of groups) {
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(src, g);
    pages.forEach(p => doc.addPage(p));
    out.push(await doc.save());
  }
  return out;
}

// ctx: { docBytes, saveNewDoc, renderRecents, openDoc }
export async function splitSheet(d, ctx) {
  if (!d) return;
  busy(true, 'PDF wird geladen …');
  let bytes, pdf;
  try { bytes = await ctx.docBytes(d); pdf = await loadPdf(bytes); }
  catch (e) { console.error(e); busy(false); return toast('PDF konnte nicht geladen werden', true); }
  busy(false);
  const n = pdf.numPages;
  if (n < 2) { closePdf(pdf); return toast('Die PDF hat nur eine Seite', true); }
  let mode = 'single', k = Math.min(2, n), ranges = '', sel = new Set(), rest = false;
  const base = d.name.replace(/\.pdf$/i, '');
  const MODES = [
    ['single', 'Jede Seite einzeln', `${n} PDFs mit je einer Seite`],
    ['every', 'Alle X Seiten', 'Gleich große Teile'],
    ['ranges', 'Eigene Bereiche', 'z. B. 1-3, 4-6, 7'],
    ['pick', 'Seiten herausziehen', 'Ausgewählte Seiten als eigene PDF'],
  ];
  sheet({
    title: 'PDF aufteilen',
    html: `<p style="color:var(--text2);margin:0 2px 12px;font-size:14px;line-height:1.4">„${esc(d.name)}“ · <b style="color:var(--text)">${n} Seiten</b></p>
      <div class="menu" data-modes>${MODES.map(([v, t, s]) => `<button class="row" data-v="${v}"><span class="row-main"><span class="row-title">${t}</span><span class="row-sub" style="display:block">${s}</span></span><span class="radio"></span></button>`).join('')}</div>
      <div data-opt></div>
      <div class="sp-sum" data-sum></div>
      <div class="btn-row"><button class="btn primary" data-ok>${icon('split')} Aufteilen</button></div>`,
    onClose: () => closePdf(pdf),
    onMount(el, api) {
      const opt = el.querySelector('[data-opt]'), sum = el.querySelector('[data-sum]');
      const thumbs = [];
      const groups = () => {
        if (mode === 'single') return { groups: everyN(n, 1) };
        if (mode === 'every') return { groups: everyN(n, k) };
        if (mode === 'ranges') return parseRanges(ranges, n);
        const s = [...sel].sort((a, b) => a - b);
        if (!s.length) return { error: 'Tippe die Seiten an, die du herausziehen willst' };
        const g = [s];
        if (rest) { const r = [...Array(n).keys()].filter(i => !sel.has(i)); if (r.length) g.push(r); }
        return { groups: g };
      };
      const summary = () => {
        const r = groups();
        if (r.error) { sum.innerHTML = `<span class="sp-err">${esc(r.error)}</span>`; return; }
        const g = r.groups;
        sum.innerHTML = `Ergibt <b>${g.length} ${g.length === 1 ? 'PDF' : 'PDFs'}</b>${g.length <= 8 ? ': ' + g.map(x => `<span class="sp-tag">S. ${label(x)}</span>`).join('') : ''}`;
      };
      const loadThumbs = async () => {
        for (let i = 0; i < n; i++) {
          if (api.closed || mode !== 'pick') return;
          if (thumbs[i]) continue;
          try { thumbs[i] = await renderThumb(pdf, i + 1, 200); } catch { thumbs[i] = ''; }
          const t = opt.querySelector(`[data-p="${i}"] .pg-img`);
          if (t) t.style.backgroundImage = `url('${thumbs[i]}')`;
        }
      };
      const renderOpt = () => {
        if (mode === 'every') {
          opt.innerHTML = `<div class="row" style="padding:14px 2px 4px;border:0"><span class="row-main"><span class="row-title">Seiten pro PDF</span></span>
            <div class="sp-step"><button data-m>${icon('minus')}</button><b data-k>${k}</b><button data-p>${icon('plus')}</button></div></div>`;
          opt.querySelector('[data-m]').onclick = () => { if (k > 1) { k--; haptic(); renderOpt(); } };
          opt.querySelector('[data-p]').onclick = () => { if (k < n - 1) { k++; haptic(); renderOpt(); } };
        } else if (mode === 'ranges') {
          opt.innerHTML = `<div class="lbl">Bereiche (jeder Bereich wird eine PDF)</div>
            <input class="field" data-r placeholder="z. B. 1-3, 4-6, 7-${n}" inputmode="text" autocomplete="off" value="${esc(ranges)}">`;
          const inp = opt.querySelector('[data-r]');
          inp.oninput = () => { ranges = inp.value; summary(); };
          setTimeout(() => inp.focus(), 250);
        } else if (mode === 'pick') {
          opt.innerHTML = `<div class="sp-grid no-swipe">${Array.from({ length: n }, (_, i) => `<button class="sp-pg ${sel.has(i) ? 'on' : ''}" data-p="${i}"><span class="pg-img" style="${thumbs[i] ? `background-image:url('${thumbs[i]}')` : ''}"></span><span class="sp-n">${i + 1}</span><span class="sp-ck">${icon('check')}</span></button>`).join('')}</div>
            <div class="row" style="padding:12px 2px 2px;border:0"><span class="row-main"><span class="row-title">Restliche Seiten auch speichern</span><span class="row-sub" style="display:block">Als zweite PDF</span></span>
              <div class="seg" data-rest><button data-v="0" class="${rest ? '' : 'on'}">Aus</button><button data-v="1" class="${rest ? 'on' : ''}">An</button></div></div>`;
          opt.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { const i = +b.dataset.p; sel.has(i) ? sel.delete(i) : sel.add(i); b.classList.toggle('on', sel.has(i)); haptic(); summary(); });
          opt.querySelectorAll('[data-rest] button').forEach(b => b.onclick = () => { rest = b.dataset.v === '1'; opt.querySelectorAll('[data-rest] button').forEach(x => x.classList.toggle('on', x === b)); summary(); });
          loadThumbs();
        } else opt.innerHTML = '';
        summary();
      };
      const setMode = v => {
        mode = v;
        el.querySelectorAll('[data-modes] .row').forEach(b => b.classList.toggle('sel', b.dataset.v === mode));
        renderOpt();
      };
      el.querySelectorAll('[data-modes] .row').forEach(b => b.onclick = () => { haptic(); setMode(b.dataset.v); });

      el.querySelector('[data-ok]').onclick = async () => {
        const r = groups();
        if (r.error) return toast(r.error, true);
        const g = r.groups;
        if (g.length > 60) return toast('Höchstens 60 Teile auf einmal', true);
        api.close(); busy(true, 'PDF wird aufgeteilt …');
        try {
          const parts = await splitPdf(bytes, g);
          const opts = d.folder ? { folder: d.folder, idCat: d.idCat } : {};
          let first = null;
          for (let i = 0; i < parts.length; i++) {
            busy(true, `Teil ${i + 1} von ${parts.length} wird gespeichert …`);
            const nm = mode === 'pick' && i === 1 ? `${base} (Rest).pdf` : `${base} (${g[i].length === 1 ? 'Seite' : 'Seiten'} ${label(g[i])}).pdf`;
            const id = await ctx.saveNewDoc(parts[i], nm, opts);
            first = first || id;
          }
          busy(false); await ctx.renderRecents();
          toast(parts.length === 1 ? 'Neue PDF erstellt' : `${parts.length} PDFs erstellt`);
          if (parts.length === 1) ctx.openDoc(first);
        } catch (e) { console.error(e); busy(false); toast('Aufteilen fehlgeschlagen', true); }
      };
      setMode('single');
    },
  });
}
