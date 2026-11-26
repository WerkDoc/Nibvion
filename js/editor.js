// ================= Nibvion Editor =================
import { aiScan } from './aifx.js';
import { db, uid } from './db.js';
import { icon, hydrateIcons } from './icons.js';
import { sheet, toast, busy, confirmDlg, promptDlg, esc, pickFiles, today, haptic } from './ui.js';
import { pdfjsLib, IOS, loadPdf, closePdf, pageInfos, flatten, pagesOp, renderThumb, inkPath, normalizeImage, TEXT_ASC, LINE_H, FONT_CSS, pdfFontInfo } from './pdfcore.js';
import { makeSymbol } from './sign.js';
import { signatureSheet, stampSheet, freshStamp } from './assets.js';
import { analyzeAll, blankReview, duplexOrder } from './pageorder.js';
import { initScrubber, toggleScrubber, scrubberReset, scrubberSync } from './scrubber.js';
import { settings } from './settings.js';
import { ocrEditItems, releaseEditOcr } from './ocr.js';
import { stampDrop, poof, flipCapture, flipPlay, reducedMotion as noMotion } from './fx.js';
import { recognize, morph, pathLen } from './shapes.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);

const MODES = {
  view:    { label: 'Ansehen', icon: 'eye', tools: [] },
  edit:    { label: 'Bearbeiten', icon: 'textEdit', tools: [
    { id: 'textedit', label: 'Text ändern', icon: 'textEdit', kind: 'textedit', hint: 'Tippe auf einen Text, um ihn zu ändern' },
    { id: 'text', label: 'Text', icon: 'textPlus', kind: 'place', hint: 'Tippe auf die Stelle für den neuen Text' },
    { id: 'image', label: 'Bild', icon: 'image', kind: 'action' },
    { id: 'whiteout', label: 'Abdecken', icon: 'whiteout', kind: 'drag', hint: 'Ziehe ein Feld über den Bereich' },
    { id: 'select', label: 'Auswahl', icon: 'hand', kind: 'select' },
  ] },
  comment: { label: 'Kommentieren', icon: 'comment', tools: [
    { id: 'highlight', label: 'Markieren', icon: 'highlight', kind: 'drag', hint: 'Über Text ziehen oder auf ein Wort tippen' },
    { id: 'underline', label: 'Unterstreichen', icon: 'underline', kind: 'drag', hint: 'Über Text ziehen' },
    { id: 'strike', label: 'Durchstreichen', icon: 'strike', kind: 'drag', hint: 'Über Text ziehen' },
    { id: 'note', label: 'Notiz', icon: 'note', kind: 'place', hint: 'Tippe auf die Stelle für die Notiz' },
    { id: 'select', label: 'Auswahl', icon: 'hand', kind: 'select' },
  ] },
  draw:    { label: 'Zeichnen', icon: 'draw', tools: [
    { id: 'pen', label: 'Stift', icon: 'pen', kind: 'ink' },
    { id: 'marker', label: 'Marker', icon: 'marker', kind: 'ink' },
    { id: 'eraser', label: 'Radierer', icon: 'eraser', kind: 'eraser' },
    { id: 'select', label: 'Scrollen', icon: 'hand', kind: 'select' },
  ] },
  sign:    { label: 'Füllen & unterschreiben', icon: 'sign', tools: [
    { id: 'signature', label: 'Unterschrift', icon: 'sign', kind: 'action' },
    { id: 'text', label: 'Text', icon: 'text', kind: 'place', hint: 'Tippe auf die Stelle für den Text' },
    { id: 'date', label: 'Datum', icon: 'calendar', kind: 'place', hint: 'Tippe auf die Stelle für das Datum' },
    { id: 'check', label: 'Haken', icon: 'checkSquare', kind: 'place', hint: 'Tippe auf die Stelle für den Haken' },
    { id: 'cross', label: 'Kreuz', icon: 'xSquare', kind: 'place', hint: 'Tippe auf die Stelle für das Kreuz' },
    { id: 'stamp', label: 'Stempel', icon: 'stamp', kind: 'action' },
    { id: 'select', label: 'Auswahl', icon: 'hand', kind: 'select' },
  ] },
};
const DEFAULT_TOOL = { view: null, edit: 'textedit', comment: 'highlight', draw: 'pen', sign: 'select' };
const OPT_TOOLS = ['pen', 'marker', 'highlight', 'underline', 'strike', 'text', 'whiteout', 'note'];

const E = {
  open: false, doc: null, bytes: null, pdf: null, infos: [], objects: [], pages: [],
  mode: 'view', tool: null, zoom: 1, base: 1, sel: null,
  undo: [], redo: [], onClose: null, saveTimer: null, dirtyThumb: false,
};
const scale = () => E.base * E.zoom;
const toolDef = () => MODES[E.mode].tools.find(t => t.id === E.tool);
const kind = () => toolDef()?.kind || (E.mode === 'view' ? 'none' : 'select');

// ======================= Öffnen / Schließen =======================
// Absturzschutz: iOS beendet die App, wenn eine PDF zu viel Speicher braucht. Vor dem Öffnen wird
// eine Markierung gesetzt und nach erfolgreichem Anzeigen wieder entfernt. Steht sie beim nächsten
// Start noch da, öffnet Nibvion danach sparsam (js/app.js → crashCheck).
export const GUARD = 'nibvion.openGuard';
const guardSet = (docId, what) => { try { localStorage.setItem(GUARD, JSON.stringify({ id: docId, what, t: Date.now() })); } catch {} };
const guardClear = () => { try { localStorage.removeItem(GUARD); } catch {} };
const lowMem = () => !!settings.get('lowMem') || safeDoc();
// „Flugschreiber“: jeder Schritt beim Öffnen wird notiert. Beendet iOS die App, zeigt der nächste
// Start (js/app.js → crashCheck), bei welchem Schritt es passiert ist.
export const CRUMB = 'nibvion.crumb';
// Zusätzlich als Cookie: das schreibt Safari sofort (synchron), localStorage dagegen verzögert.
const crumb = step => {
  const v = JSON.stringify({ step, doc: (E.doc?.name || '').slice(0, 60), pages: E.infos?.length || 0, t: Date.now() });
  try { document.cookie = 'nibcrumb=' + encodeURIComponent(v) + ';path=/;max-age=86400;SameSite=Lax'; } catch {}
  try { localStorage.setItem(CRUMB, v); } catch {}
};
// Notfallmodus für einzelne PDFs, bei denen die App trotz Sparmodus abgestürzt ist
const safeDoc = () => !!E.doc && (settings.get('safeDocs') || []).includes(E.doc.id);

export async function openEditor(docId, mode = 'view', onClose, page = 0) {
  guardSet(docId, 'open');
  busy(true, 'PDF wird geladen …');
  try {
    const meta = await db.get('docs', docId);
    const file = await db.get('files', docId);
    if (!meta || !file) throw new Error('Datei nicht gefunden');
    E.doc = meta; E.bytes = file.data; E.objects = meta.objects || [];
    crumb('Datei geladen');
    E.undo = []; E.redo = []; E.sel = null; E.zoom = 1; E.onClose = onClose; E.dirtyThumb = false;
    await loadDocument();
    document.body.classList.add('in-editor');
    $('editor').classList.add('open'); $('editor').setAttribute('aria-hidden', 'false');
    E.open = true;
    setMode(mode === 'pages' ? 'view' : mode, true);
    if (mode === 'pages') pageManager();
    if (page > 0 && E.pages[page]) requestAnimationFrame(() => { const sc = $('ed-scroll'); sc.scrollTop = E.pages[page].el.offsetTop - 12; updPageChip(); });
    meta.opened = Date.now(); db.put('docs', meta);
    const vm = settings.get('viewMode');
    if (mode === 'view' && (vm === 'single' || vm === 'flip')) setTimeout(() => { if (E.open && E.doc?.id === docId) pageView(vm, true); }, 380);
    else setTimeout(() => { if (E.doc?.id === docId) { guardClear(); crumb('ok'); } }, 5000);
  } catch (err) {
    console.error(err); guardClear(); toast('PDF konnte nicht geöffnet werden', true);
  } finally { busy(false); }
}

async function loadDocument() {
  if (E.pdf) closePdf(E.pdf);
  crumb('PDF wird geöffnet');
  E.pdf = await loadPdf(E.bytes, { safe: safeDoc() });
  crumb('Seitenmaße werden gelesen');
  E.infos = await pageInfos(E.pdf);
  crumb('Seiten werden aufgebaut');
  E.tsel = null; hideTselBar(); E.words = {};
  E.text = {}; E.ocr = {}; E.needOcr = {}; E.scanFx = {}; E.ocrGen = (E.ocrGen || 0) + 1; ocrQueue = [];
  buildPages();
  crumb('Seiten aufgebaut');
  scrubberReset(E.pdf);
  loadOutline();
}

// ======================= Inhaltsverzeichnis (PDF-Outline) =======================
// pdf.js liefert doc.getOutline(): [{ title, dest, url, items, bold, italic }]. Ziele (Name oder
// Array) werden in Seitenindex + Höhe auf der Seite aufgelöst; Tippen springt direkt dorthin.
async function loadOutline() {
  const pdf = E.pdf; E.outline = null; E.tocOpen = null;
  const chip = $('toc-chip'); chip.hidden = true;
  let raw = null;
  try { raw = await pdf.getOutline(); } catch {}
  if (!raw?.length || pdf !== E.pdf) return;
  const refCache = new Map();
  const resolve = async dest => {
    try {
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest) || !dest.length) return null;
      const ref = dest[0];
      let page = null;
      if (ref && typeof ref === 'object') {
        const k = `${ref.num}R${ref.gen}`;
        if (!refCache.has(k)) refCache.set(k, await pdf.getPageIndex(ref).catch(() => null));
        page = refCache.get(k);
      } else if (Number.isInteger(ref)) page = ref;
      if (page == null || page < 0 || page >= pdf.numPages) return null;
      // Höhe auf der Seite (nur bei /XYZ und /FitH bzw. /FitBH mit Wert)
      const kind = dest[1]?.name, y = kind === 'XYZ' ? dest[3] : (kind === 'FitH' || kind === 'FitBH') ? dest[2] : null;
      return { page, top: typeof y === 'number' ? y : null };
    } catch { return null; }
  };
  let count = 0;
  const walk = async (items, depth) => {
    const out = [];
    for (const it of items || []) {
      if (++count > 3000) break;
      const t = await resolve(it.dest);
      out.push({ id: count, title: String(it.title || '').replace(/\s+/g, ' ').trim() || 'Ohne Titel', page: t?.page ?? null, top: t?.top ?? null,
        url: it.url || null, bold: !!it.bold, italic: !!it.italic, depth, items: depth < 8 ? await walk(it.items, depth + 1) : [] });
    }
    return out;
  };
  const tree = await walk(raw, 0);
  if (pdf !== E.pdf || !tree.length) return;
  E.outline = tree; E.tocOpen = new Set();
  chip.hidden = false;
}

function tocFlat(nodes = E.outline || [], out = []) { for (const n of nodes) { out.push(n); tocFlat(n.items, out); } return out; }

// Aktuelles Kapitel = letzter Eintrag, dessen Seite ≤ aktueller Seite
function tocCurrent() {
  const cur = currentPage(); let best = null;
  for (const n of tocFlat()) if (n.page != null && n.page <= cur && (!best || n.page >= best.page)) best = n;
  return best;
}

function jumpTo(page, top) {
  const p = E.pages[page]; if (!p) return;
  const sc = $('ed-scroll'), info = E.infos[page];
  let y = 0;
  if (top != null && info && !info.rot) y = Math.max(0, (info.view[3] - top) * scale() - 8);
  sc.scrollTo({ top: Math.max(0, p.el.offsetTop + y - 12), behavior: 'smooth' });
  setTimeout(updPageChip, 450);
}

function tocSheet() {
  if (!E.outline) return toast('Dieses PDF hat kein Inhaltsverzeichnis');
  const flat = tocFlat(), cur = tocCurrent();
  // Pfad zum aktuellen Kapitel aufklappen
  const parents = new Map();
  (function link(nodes, par) { for (const n of nodes) { parents.set(n.id, par); link(n.items, n); } })(E.outline, null);
  for (let p = cur && parents.get(cur.id); p; p = parents.get(p.id)) E.tocOpen.add(p.id);
  const search = flat.length > 20;
  sheet({
    title: 'Inhaltsverzeichnis',
    html: `${search ? `<input class="field toc-q" type="search" placeholder="Kapitel suchen" data-q autocomplete="off">` : ''}
      <div class="toc-meta">${flat.length} ${flat.length === 1 ? 'Eintrag' : 'Einträge'} · ${E.pages.length} Seiten
        ${flat.some(n => n.items.length) ? `<span class="toc-all"><button data-all="1">Alle aufklappen</button><button data-all="0">Zuklappen</button></span>` : ''}</div>
      <div class="menu toc" data-list></div>`,
    onMount(el, api) {
      const list = el.querySelector('[data-list]'), q = el.querySelector('[data-q]');
      list.classList.toggle('nested', flat.some(n => n.items.length));
      const row = (n, depth, show) => {
        const has = n.items.length, open = E.tocOpen.has(n.id);
        const dis = n.page == null;
        return `<div class="toc-row${n === cur ? ' cur' : ''}${dis ? ' dis' : ''}" data-id="${n.id}" style="--d:${depth}">
          ${has && !show ? `<button class="toc-tw${open ? ' open' : ''}" data-tw aria-label="${open ? 'Zuklappen' : 'Aufklappen'}">${icon('chevronRight')}</button>` : '<span class="toc-tw sp"></span>'}
          <button class="toc-main" data-go ${dis ? 'disabled' : ''}><span class="toc-t" style="${n.bold || depth === 0 ? 'font-weight:650;' : ''}${n.italic ? 'font-style:italic;' : ''}">${esc(n.title)}</span>
          <span class="toc-p">${n.page != null ? n.page + 1 : n.url ? icon('globe') : '–'}</span></button></div>`;
      };
      const render = () => {
        const term = (q?.value || '').trim().toLowerCase();
        let html = '';
        if (term) {
          const hits = flat.filter(n => n.title.toLowerCase().includes(term));
          html = hits.map(n => row(n, 0, true)).join('') || `<div class="empty" style="border:0;padding:22px">Kein Kapitel gefunden</div>`;
        } else {
          const rec = (nodes, d) => { for (const n of nodes) { html += row(n, d, false); if (n.items.length && E.tocOpen.has(n.id)) rec(n.items, d + 1); } };
          rec(E.outline, 0);
        }
        list.innerHTML = html;
        list.querySelectorAll('.toc-row').forEach(r => {
          const n = flat.find(x => x.id === +r.dataset.id);
          r.querySelector('[data-tw]')?.addEventListener('click', () => { E.tocOpen.has(n.id) ? E.tocOpen.delete(n.id) : E.tocOpen.add(n.id); haptic(); render(); });
          r.querySelector('[data-go]').onclick = () => {
            if (n.page == null) { if (n.url) window.open(n.url, '_blank', 'noopener'); return; }
            haptic(); api.close(); jumpTo(n.page, n.top);
          };
        });
      };
      if (q) q.oninput = render;
      el.querySelectorAll('[data-all]').forEach(b => b.onclick = () => {
        haptic();
        if (b.dataset.all === '1') flat.forEach(n => n.items.length && E.tocOpen.add(n.id)); else E.tocOpen.clear();
        render();
      });
      render();
      requestAnimationFrame(() => list.querySelector('.toc-row.cur')?.scrollIntoView({ block: 'center' }));
    },
  });
}

export async function closeEditorIfOpen() { if (E.open) await closeEditor(); }

async function closeEditor() {
  await saveNow();
  E.ocrGen++; ocrQueue = []; releaseEditOcr();
  if (E.dirtyThumb) await updateThumb();
  E.open = false;
  toggleScrubber(false);
  $('editor').classList.remove('open'); $('editor').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('in-editor');
  hideSelMenu(); E.tsel = null; hideTselBar(); try { window.speechSynthesis?.cancel(); speaking = false; } catch {}
  setTimeout(() => { if (!E.open) { $('ed-pages').innerHTML = ''; closePdf(E.pdf); E.pdf = null; } }, 500);
  E.onClose && E.onClose();
}

async function updateThumb() {
  try { E.doc.thumb = await renderThumb(E.pdf, 1); await db.put('docs', E.doc); } catch {}
}

// ======================= Speichern / Undo =======================
function scheduleSave() {
  clearTimeout(E.saveTimer);
  E.saveTimer = setTimeout(saveNow, 500);
}
async function saveNow() {
  clearTimeout(E.saveTimer);
  if (!E.doc) return;
  E.doc.objects = E.objects; E.doc.updated = Date.now();
  await db.put('docs', E.doc);
}
function snapshot() {
  E.undo.push(JSON.stringify(E.objects));
  if (E.undo.length > 80) E.undo.shift();
  E.redo = [];
  updUndoBtns();
}
function changed(pages) {
  scheduleSave();
  (pages ?? E.pages.map((_, i) => i)).forEach(renderLayer);
  updUndoBtns();
}
function updUndoBtns() { $('btn-undo').disabled = !E.undo.length; $('btn-redo').disabled = !E.redo.length; }
function undo() {
  if (!E.undo.length) return;
  E.redo.push(JSON.stringify(E.objects)); E.objects = JSON.parse(E.undo.pop()); E.sel = null; hideSelMenu(); changed(); haptic();
}
function redo() {
  if (!E.redo.length) return;
  E.undo.push(JSON.stringify(E.objects)); E.objects = JSON.parse(E.redo.pop()); E.sel = null; hideSelMenu(); changed(); haptic();
}

// ======================= Seiten-Layout =======================
let io;
function buildPages() {
  const wrap = $('ed-pages'); wrap.innerHTML = '';
  wrap.classList.toggle('anim', E.infos.length <= 20);      // Einblend-Animation nur bei kurzen PDFs (iOS-Speicher)
  const sc = $('ed-scroll');
  const maxW = Math.max(...E.infos.map(i => i.w));
  E.base = Math.max(0.2, (sc.clientWidth - 24) / maxW);
  io?.disconnect();
  io = new IntersectionObserver(entries => {
    entries.forEach(en => {
      const i = +en.target.dataset.i;
      if (en.isIntersecting) renderPage(i); else freePage(i);
    });
  }, { root: sc, rootMargin: safeDoc() ? '150px 0px' : lowMem() ? '450px 0px' : '900px 0px' });
  E.pages = E.infos.map((info, i) => {
    const el = document.createElement('div');
    el.className = 'page'; el.dataset.i = i;
    el.style.animationDelay = Math.min(i, 4) * 60 + 'ms';
    el.innerHTML = `<div class="ph">Seite ${i + 1}</div><canvas></canvas><div class="page-num">${i + 1}</div>`;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'layer');
    svg.setAttribute('viewBox', `0 0 ${info.w} ${info.h}`);
    el.appendChild(svg);
    wrap.appendChild(el);
    svg.addEventListener('pointerdown', e => onDown(e, i));
    const pg = { el, canvas: el.querySelector('canvas'), svg, rs: 0, task: null };
    io.observe(el);
    return pg;
  });
  layoutPages();
  E.pages.forEach((_, i) => renderLayer(i));
  sc.scrollTop = 0; sc.scrollLeft = 0;
  updPageChip();
}

function layoutPages() {
  const s = scale();
  E.pages.forEach((p, i) => { p.el.style.width = E.infos[i].w * s + 'px'; p.el.style.height = E.infos[i].h * s + 'px'; });
  $('zoom-label').textContent = Math.round(E.zoom * 100) + '%';
}

// Seiten strikt nacheinander rendern – nie mehrere pdf.js-Renderings gleichzeitig (iOS-Speicher)
let renderChain = Promise.resolve();
function renderPage(i) {
  const pdf = E.pdf;
  renderChain = renderChain.then(() => {
    if (pdf !== E.pdf) return;
    const p = E.pages[i]; if (!p) return;
    const sr = $('ed-scroll').getBoundingClientRect(), r = p.el.getBoundingClientRect();
    if (r.bottom < sr.top - 1000 || r.top > sr.bottom + 1000) return;    // inzwischen weggescrollt
    return renderPageNow(i);
  }).catch(() => {});
  return renderChain;
}
async function renderPageNow(i) {
  const p = E.pages[i], info = E.infos[i]; if (!p || !E.pdf) return;
  if (E.hidden) return;                                   // Editor liegt unter einer Vollbild-Ansicht
  const dpr = Math.min(safeDoc() ? 1.25 : lowMem() ? 2 : 3, window.devicePixelRatio || 1);
  let rs = scale() * dpr;
  const maxPx = safeDoc() ? 1.5e6 : lowMem() ? 4e6 : 9e6;
  if (info.w * info.h * rs * rs > maxPx) rs = Math.sqrt(maxPx / (info.w * info.h));
  if (Math.abs(p.rs - rs) < 0.01) return;
  p.task?.cancel?.();
  let c = null, beat = null;
  const S = `Seite ${i + 1}`;
  // Herzschlag: läuft die App noch, wird der letzte Schritt jede Sekunde mit Wartezeit neu notiert.
  // So zeigt „Letzter Absturz“, ob iOS die App beendet hat (kurze Zeit) oder sie hängen blieb (lange Zeit).
  let step = '', since = Date.now();
  const mark = t => { step = t; since = Date.now(); crumb(t); };
  try {
    beat = setInterval(() => { const s = Math.round((Date.now() - since) / 1000); if (s >= 1) crumb(`${step} (läuft seit ${s} s)`); }, 1000);
    mark(`${S}: wird geladen`);
    const page = await E.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: rs });
    c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    mark(`${S}: Leinwand ${c.width}×${c.height}`);
    const ctx = c.getContext('2d', { willReadFrequently: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    let chunk = 0;
    // Kein separates getOperatorList() mehr: das las jede Seite (inkl. Bilder) ein zweites Mal ein
    p.task = page.render({ canvasContext: ctx, viewport: vp });
    // iOS: zwischen den Abschnitten kurz an Safari zurückgeben (Aufräumen/GC statt Speicherstau)
    p.task.onContinue = cont => { mark(`${S}: zeichnen, Abschnitt ${++chunk}`); IOS ? setTimeout(cont, 0) : cont(); };
    mark(`${S}: zeichnen beginnt`);
    await p.task.promise;
    mark(`${S}: gezeichnet, wird angezeigt`);
    p.task = null;
    const old = p.canvas; p.el.replaceChild(c, old);
    old.width = old.height = 0;
    p.canvas = c; p.rs = rs; c = null;
    p.el.querySelector('.ph')?.remove();
    page.cleanup();                                         // dekodierte Bilder sofort wieder freigeben
    crumb(`${S} fertig`);
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') { console.warn(err); crumb(`${S}: Fehler – ${String(err?.message || err).slice(0, 80)}`); }
  }
  finally { clearInterval(beat); if (c) c.width = c.height = 0; }  // abgebrochene Canvas sofort freigeben (iOS)
}
function freePage(i) {
  const p = E.pages[i]; if (!p || !p.rs) return;
  // Nur weit entfernte Seiten freigeben
  const r = p.el.getBoundingClientRect(), sr = $('ed-scroll').getBoundingClientRect();
  const far = lowMem() ? 1200 : 2500;
  if (r.bottom < sr.top - far || r.top > sr.bottom + far) { p.canvas.width = p.canvas.height = 0; p.rs = 0; }
}
let rerenderT;
function rerenderVisible() {
  clearTimeout(rerenderT);
  rerenderT = setTimeout(() => {
    const sr = $('ed-scroll').getBoundingClientRect();
    E.pages.forEach((p, i) => { const r = p.el.getBoundingClientRect(); if (r.bottom > sr.top - 900 && r.top < sr.bottom + 900) renderPage(i); });
  }, 180);
}

function setZoom(z, cx, cy) {
  z = Math.min(5, Math.max(0.5, z));
  if (Math.abs(z - E.zoom) < 0.001) return;
  const sc = $('ed-scroll'), r = sc.getBoundingClientRect();
  const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
  const ratio = z / E.zoom;
  const cxC = sc.scrollLeft + px, cyC = sc.scrollTop + py;
  E.zoom = z; layoutPages();
  sc.scrollLeft = cxC * ratio - px; sc.scrollTop = cyC * ratio - py;
  E.pages.forEach((_, i) => renderLayer(i));
  rerenderVisible(); placeSelMenu();
}

function currentPage() {
  const sr = $('ed-scroll').getBoundingClientRect(); const mid = sr.top + sr.height / 2;
  let best = 0, bd = 1e9;
  E.pages.forEach((p, i) => { const r = p.el.getBoundingClientRect(); const d = r.top > mid ? r.top - mid : r.bottom < mid ? mid - r.bottom : 0; if (d < bd) { bd = d; best = i; } });
  return best;
}
function updPageChip() { const c = currentPage(); $('page-chip').textContent = `${c + 1} / ${E.pages.length}`; scrubberSync(c); }

// ======================= Modus & Werkzeuge =======================
function setMode(mode, first) {
  E.mode = mode; E.tool = DEFAULT_TOOL[mode];
  if (E.tool === 'textedit') E.scanFx = {};
  $('mode-label').textContent = MODES[mode].label;
  E.sel = null; hideSelMenu(); clearTsel(true); try { window.speechSynthesis?.cancel(); speaking = false; } catch {}
  renderToolbar();
  if (mode === 'edit' || mode === 'comment') E.pages.forEach((_, i) => loadText(i));
  E.pages.forEach((_, i) => renderLayer(i));
  if (!first) haptic();
  showToolHint();
}
function setTool(id) {
  const t = MODES[E.mode].tools.find(x => x.id === id);
  if (t.kind === 'action') return runAction(id);
  const was = E.tool;
  E.tool = (E.tool === id && id !== 'select' && E.mode !== 'edit') ? 'select' : id;
  if (E.tool === 'textedit' && was !== 'textedit') E.scanFx = {};
  E.sel = null; hideSelMenu();
  renderToolbar();
  E.pages.forEach((_, i) => renderLayer(i));
  showToolHint(); haptic();
}
function renderToolbar() {
  const tools = MODES[E.mode].tools;
  $('ed-toolbar').classList.toggle('hidden', !tools.length);
  const pop = E.tbMode !== E.mode; E.tbMode = E.mode;
  $('ed-tools').classList.toggle('tb-anim', pop);
  $('ed-tools').innerHTML = tools.map((t, i) => `<button class="tool ${t.id === E.tool ? 'on' : ''}" data-tool="${t.id}" style="animation-delay:${i * 35}ms">${icon(t.icon)}<span>${t.label}</span></button>`).join('');
  $('ed-tools').querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $('btn-options').style.display = OPT_TOOLS.includes(E.tool) ? '' : 'none';
  $('editor').classList.toggle('drawing', ['ink', 'eraser', 'drag'].includes(kind()));
  updUndoBtns();
}
let hintT;
function hint(msg) {
  const h = $('ed-hint'); h.textContent = msg; h.classList.add('show');
  clearTimeout(hintT); hintT = setTimeout(() => h.classList.remove('show'), 2200);
}
function showToolHint() { const t = toolDef(); if (t?.hint) hint(t.hint); }

function modeSheet() {
  sheet({
    title: 'Werkzeuge',
    html: `<div class="menu">${Object.entries(MODES).map(([k, m]) => `
      <button class="row ${k === E.mode ? 'active' : ''}" data-m="${k}"><span class="row-ic ${modeColor(k)}">${icon(m.icon)}</span><span class="row-main"><span class="row-title">${m.label}</span></span><span class="row-end">${k === E.mode ? icon('check') : ''}</span></button>`).join('')}</div>`,
    onMount(el, api) { el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { api.close(); setMode(b.dataset.m); }); },
  });
}
const modeColor = k => ({ view: 'c-blue', edit: 'c-red', comment: 'c-amber', draw: 'c-violet', sign: 'c-green' }[k]);

// ======================= Text des PDFs =======================
async function loadText(i) {
  if (E.text[i]) return E.text[i];
  E.text[i] = (async () => {
    const page = await E.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    tc.items.forEach((it, k) => {
      if (!it.str || !it.str.trim()) return;
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01 && Math.abs(tx[0]) < 0.01) return;
      const fh = Math.hypot(tx[2], tx[3]); if (fh < 1) return;
      const st = tc.styles[it.fontName] || {};
      let asc = st.ascent ?? 0.8, desc = st.descent ?? -0.2;
      if (!(asc > 0.5 && asc < 1.15)) asc = 0.8;
      if (!(desc < 0 && desc > -0.5)) desc = -0.2;
      let fi = pdfFontInfo(null, st);
      try { const f = page.commonObjs.has(it.fontName) && page.commonObjs.get(it.fontName); fi = pdfFontInfo(f, st); } catch {}
      const w = it.width; if (w < 0.5) return;
      items.push({ key: `${i}:${k}`, str: it.str, x: tx[4], base: tx[5], top: tx[5] - fh * asc, h: fh * (asc - desc), w, size: fh, bold: fi.bold, italic: fi.italic, font: fi.font });
    });
    // Gescannte Seite? Kein Text oder nur eine unsichtbare Texterkennungs-Ebene → zum Ändern selbst lesen
    let invisible = false;
    const chars = items.reduce((n, t) => n + t.str.replace(/\s/g, '').length, 0);
    if (chars >= 5) {
      try {
        const ol = await page.getOperatorList(), OPS = pdfjsLib.OPS;
        for (let k = 0; k < ol.fnArray.length; k++) if (ol.fnArray[k] === OPS.setTextRenderingMode && (ol.argsArray[k][0] & 3) === 3) { invisible = true; break; }
      } catch {}
    }
    E.needOcr[i] = invisible || chars < 5;
    return items;
  })();
  const items = await E.text[i];
  E.text[i] = items;
  renderLayer(i);
  return items;
}
const textItems = i => Array.isArray(E.text[i]) ? E.text[i] : [];
// Für „Text ändern“: bei gescannten Seiten die selbst erkannten Textstücke
const editItems = i => E.needOcr[i] ? (Array.isArray(E.ocr[i]) ? E.ocr[i] : []) : textItems(i);

// ---------- Texterkennung für „Text ändern“ (eine Seite nach der anderen) ----------
let ocrQueue = [], ocrRunning = false;
function ensureOcr(i) {
  if (!E.needOcr[i] || E.ocr[i]) return;
  E.ocr[i] = 'pending';
  ocrQueue.push(i);
  ocrQueue.sort((a, b) => Math.abs(a - currentPage()) - Math.abs(b - currentPage()));
  runOcrQueue();
}
async function runOcrQueue() {
  if (ocrRunning) return;
  ocrRunning = true;
  const gen = E.ocrGen;
  try {
    while (ocrQueue.length && E.open && gen === E.ocrGen) {
      const i = ocrQueue.shift(), p = E.pages[i];
      p?.el.querySelector('.scan-fx .scan-msg')?.replaceChildren('Text wird erkannt …');
      try {
        const page = await E.pdf.getPage(i + 1);
        const base = page.getViewport({ scale: 1 });
        const sc = Math.min(2600 / Math.max(base.width, base.height), 4);
        const vp = page.getViewport({ scale: sc });
        const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        // Tabellenlinien vorher entfernen, sonst werden Zellen nicht gelesen
        let prep = null;
        try { prep = (await import('./scan2office.js')).prepare(c); } catch (e) { console.warn(e); }
        const items = await ocrEditItems(c, sc, `${i}:o`, prep?.ocrCanvas);
        if (prep?.ocrCanvas) prep.ocrCanvas.width = prep.ocrCanvas.height = 0;
        c.width = c.height = 0;
        if (gen !== E.ocrGen) break;
        E.ocr[i] = items;
        if (!items.length) toast(`Seite ${i + 1}: kein Text gefunden`);
      } catch (err) {
        console.warn(err);
        if (gen === E.ocrGen) { E.ocr[i] = []; toast('Texterkennung fehlgeschlagen', true); }
      }
      if (gen === E.ocrGen) renderLayer(i);
    }
  } finally { ocrRunning = false; }
}

// Farben aus dem gerenderten Canvas lesen
function sampleColors(i, box) {
  const p = E.pages[i];
  const out = { bg: '#ffffff', fg: '#111318' };
  if (!p.rs || !p.canvas.width) return out;
  try {
    const s = p.canvas.width / E.infos[i].w;
    const x = Math.max(0, Math.floor((box.x - 1.5) * s)), y = Math.max(0, Math.floor((box.y - 1.5) * s));
    const w = Math.min(p.canvas.width - x, Math.ceil((box.w + 3) * s)), h = Math.min(p.canvas.height - y, Math.ceil((box.h + 3) * s));
    if (w < 2 || h < 2) return out;
    const d = p.canvas.getContext('2d').getImageData(x, y, w, h).data;
    const counts = {};
    const px = (xx, yy) => { const o = (yy * w + xx) * 4; return [d[o], d[o + 1], d[o + 2]]; };
    const add = c => { const k = c.map(v => v >> 3).join(','); counts[k] = counts[k] || { n: 0, c }; counts[k].n++; };
    for (let xx = 0; xx < w; xx++) { add(px(xx, 0)); add(px(xx, h - 1)); }
    for (let yy = 0; yy < h; yy++) { add(px(0, yy)); add(px(w - 1, yy)); }
    const bg = Object.values(counts).sort((a, b) => b.n - a.n)[0].c;
    // Schriftfarbe: Mittel der kräftigsten Schriftpixel (Kern der Striche, nicht ein einzelner Ausreißer)
    const ink = []; let bd = 0;
    for (let yy = 1; yy < h - 1; yy += 1) for (let xx = 1; xx < w - 1; xx += 1) {
      const c = px(xx, yy); const dd = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
      if (dd > 60) ink.push([dd, c]); if (dd > bd) bd = dd;
    }
    const hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    out.bg = hex(bg);
    if (ink.length) {
      ink.sort((a, b) => b[0] - a[0]);
      const top = ink.filter(([dd]) => dd >= bd * 0.8).slice(0, Math.max(3, Math.round(ink.length * 0.35)));
      out.fg = hex([0, 1, 2].map(k => top.reduce((s0, q) => s0 + q[1][k], 0) / top.length));
    }
  } catch {}
  return out;
}

// ======================= Objekte =======================
const mctx = document.createElement('canvas').getContext('2d');
function measure(o) {
  if (o.type !== 'text') return o;
  mctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? '700' : '400'} ${o.size}px ${FONT_CSS[o.font] || FONT_CSS.sans}`;
  const lines = String(o.text).split('\n');
  o.w = Math.max(o.size * 0.5, ...lines.map(l => mctx.measureText(l).width));
  o.h = o.size * (1 + (lines.length - 1) * LINE_H);
  return o;
}
function bbox(o) {
  if (o.type === 'ink') {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    o.points.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
    const r = o.width / 2; return { x: x0 - r, y: y0 - r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}
const byId = id => E.objects.find(o => o.id === id);

// ---------- Drehen ----------
// Bilder (Stempel, Unterschriften, QR), Texte und Zeichnungen lassen sich am Eck-Punkt drehen.
// Bild/Text: Winkel in o.rot (Grad, im Uhrzeigersinn, um die Mitte). Zeichnung: Punkte werden direkt gedreht.
const canRotate = o => o.type === 'image' || o.type === 'ink' || (o.type === 'text' && !o.cover);
const normDeg = a => { a = ((a % 360) + 540) % 360 - 180; return Math.abs(a) < 0.05 ? 0 : +a.toFixed(2); };
function rotTf(o) {
  if (!o.rot || o.type === 'ink') return null;
  const b = bbox(o);
  return `rotate(${o.rot} ${b.x + b.w / 2} ${b.y + b.h / 2})`;
}
// Achsenparalleles Rechteck um das gedrehte Objekt (für Menü-Position)
function rbbox(o) {
  const b = bbox(o); if (!o.rot || o.type === 'ink') return b;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = o.rot * Math.PI / 180, c = Math.abs(Math.cos(r)), sn = Math.abs(Math.sin(r));
  const w = b.w * c + b.h * sn, h = b.w * sn + b.h * c;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
function rotatePts(pts, cx, cy, deg, f = 1) {
  const r = deg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
  return pts.map(([x, y]) => { const dx = (x - cx) * f, dy = (y - cy) * f; return [cx + dx * c - dy * sn, cy + dx * sn + dy * c]; });
}
let rotTip = null;
function showRotTip(e, deg, f, snapped) {
  if (!rotTip) { rotTip = document.createElement('div'); rotTip.className = 'rot-tip'; $('editor').appendChild(rotTip); }
  const er = $('editor').getBoundingClientRect();
  rotTip.innerHTML = `<b>${Math.round(deg)}°</b><span>${Math.round(f * 100)} %</span>`;
  rotTip.classList.toggle('snap', snapped);
  rotTip.style.left = (e.clientX - er.left) + 'px'; rotTip.style.top = (e.clientY - er.top - 64) + 'px';
  rotTip.classList.add('show');
}
const hideRotTip = () => rotTip?.classList.remove('show');

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  parent && parent.appendChild(n);
  return n;
}

function drawObj(o, parent) {
  const g = el('g', { class: 'obj', 'data-id': o.id, transform: rotTf(o) }, parent);
  switch (o.type) {
    case 'text': {
      if (o.cover) el('rect', { x: o.cover.x, y: o.cover.y, width: o.cover.w, height: o.cover.h, fill: o.cover.color }, g);
      if (o.bg) el('rect', { x: o.x - 4, y: o.y - 3, width: o.w + 8, height: o.h + 6, rx: 2, fill: o.bg, stroke: '#e3c34a', 'stroke-width': 0.6 }, g);
      el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: 'transparent' }, g);
      const t = el('text', { 'font-family': FONT_CSS[o.font] || FONT_CSS.sans, 'font-size': o.size, 'font-weight': o.bold ? 700 : 400, 'font-style': o.italic ? 'italic' : null, fill: o.color, style: 'white-space:pre' }, g);
      String(o.text).split('\n').forEach((ln, k) => { const s = el('tspan', { x: o.x, y: o.y + o.size * TEXT_ASC + k * o.size * LINE_H }, t); s.textContent = ln || ' '; });
      break;
    }
    case 'whiteout': el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: o.color }, g); break;
    case 'highlight': el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: o.color, 'fill-opacity': 0.4, style: 'mix-blend-mode:multiply' }, g); break;
    case 'underline': case 'strike': {
      el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: 'transparent' }, g);
      const yy = o.type === 'underline' ? o.y + o.h - 0.5 : o.y + o.h * 0.55;
      el('line', { x1: o.x, x2: o.x + o.w, y1: yy, y2: yy, stroke: o.color, 'stroke-width': Math.max(0.8, o.h * 0.08) }, g);
      break;
    }
    case 'image': el('image', { href: o.src, x: o.x, y: o.y, width: o.w, height: o.h, preserveAspectRatio: 'none', opacity: o.opacity ?? 1 }, g); break;
    case 'ink': {
      const d = inkPath(o.points, o.sharp);
      el('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(o.width, 12 / scale()), 'stroke-linecap': 'round' }, g);
      el('path', { d, fill: 'none', stroke: o.color, 'stroke-width': o.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': o.opacity ?? 1, style: (o.opacity ?? 1) < 1 ? 'mix-blend-mode:multiply' : null }, g);
      break;
    }
  }
  return g;
}

// ---------- Scan-Animation beim „Text ändern“ („Nibvion AI analysiert“, Linie von oben nach unten) ----------
const SWEEP = 1100;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function scanState(i) {
  const p = E.pages[i];
  const ready = Array.isArray(E.text[i]) && (!E.needOcr[i] || Array.isArray(E.ocr[i]));
  let st = E.scanFx[i];
  if (st === 'done' || st === 'reveal') return st;
  if (reduceMotion()) return (E.scanFx[i] = ready ? 'done' : 'loop');
  E.scanObj ||= {};
  if (!st || !E.scanObj[i]?.el.isConnected) {
    p.el.querySelector('.scan-fx')?.remove();
    E.scanObj[i] = aiScan(p.el, { src: () => p.canvas });
    st = E.scanFx[i] = 'loop';
  }
  if (ready) {
    // letzter Durchlauf: Textfelder erscheinen genau dann, wenn die Linie sie überstreicht
    E.scanFx[i] = 'reveal'; E.scanT0 = E.scanT0 || {}; E.scanT0[i] = performance.now();
    E.scanObj[i].finish(SWEEP).then(() => { if (E.scanFx[i] === 'reveal') E.scanFx[i] = 'done'; });
    return 'reveal';
  }
  return st;
}

function renderLayer(i) {
  const p = E.pages[i]; if (!p) return;
  const svg = p.svg; svg.textContent = '';
  if (E.mode === 'edit' && E.tool === 'textedit') {
    const replaced = new Set(E.objects.filter(o => o.srcKey).map(o => o.srcKey));
    if (E.needOcr[i]) ensureOcr(i);
    const st = scanState(i);
    if (st !== 'loop') {
      const H = E.infos[i]?.h || 842, el0 = st === 'reveal' ? performance.now() - E.scanT0[i] : 0;
      editItems(i).forEach(t => {
        if (replaced.has(t.key)) return;
        const r = el('rect', { class: 'titem' + (st === 'reveal' ? ' rev' : ''), x: t.x - 0.5, y: t.top - 0.5, width: t.w + 1, height: t.h + 1, rx: 0.8, 'data-key': t.key }, svg);
        if (st === 'reveal') r.style.animationDelay = `${Math.round(SWEEP * (t.top + t.h / 2) / H - el0)}ms`;
      });
    }
  } else p.el.querySelector('.scan-fx')?.remove();
  E.objects.filter(o => o.page === i).forEach(o => drawObj(o, svg));
  drawTsel(svg, i);
  const s = E.sel && byId(E.sel);
  if (s && s.page === i) {
    const b = bbox(s), pad = 4 / scale(), r = 9 / scale();
    const sg = el('g', { transform: rotTf(s) }, svg);
    el('rect', { class: 'selbox', x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, rx: 3 / scale() }, sg);
    const hg = el('g', { class: 'handle-g' + (canRotate(s) ? ' rot' : ''), 'data-handle': 1 }, sg);
    el('circle', { class: 'handle', cx: b.x + b.w + pad, cy: b.y + b.h + pad, r, 'data-handle': 1 }, hg);
    if (canRotate(s)) {
      // kleines Dreh-Symbol im Punkt
      const hx = b.x + b.w + pad, hy = b.y + b.h + pad, q = r * 0.5;
      el('path', { class: 'handle-ic', d: `M${hx - q} ${hy + q * 0.2}A${q} ${q} 0 1 1 ${hx + q * 0.25} ${hy + q * 0.95}`, 'data-handle': 1 }, hg);
      el('path', { class: 'handle-ic', d: `M${hx - q * 1.35} ${hy - q * 0.25}L${hx - q} ${hy + q * 0.35}L${hx - q * 0.4} ${hy}`, 'data-handle': 1 }, hg);
    }
  }
}

// ======================= Zeiger-Interaktion =======================
let G = null; // laufende Geste
const activePointers = new Set();
function svgPt(e, i) {
  const svg = E.pages[i].svg; const m = svg.getScreenCTM().inverse();
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
  return [p.x, p.y];
}

function onDown(e, i) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  activePointers.add(e.pointerId);
  if (activePointers.size > 1) { cancelGesture(); return; }
  const k = kind();
  const [x, y] = svgPt(e, i);
  if (k === 'none') {
    if (E.mode !== 'view') return;
    const svg0 = E.pages[i].svg, h = e.target.closest?.('[data-tsh]')?.dataset.tsh;
    if (h && E.tsel?.page === i) {          // Griff ziehen: anderes Ende bleibt fest
      const lo = Math.min(E.tsel.a, E.tsel.b), hi = Math.max(E.tsel.a, E.tsel.b);
      G = { type: 'tsel', page: i, pid: e.pointerId, sx: x, sy: y, moved: false, anchor: h === 'lo' ? hi : lo };
      hideTselBar(); try { svg0.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault(); return;
    }
    G = { type: 'press', page: i, pid: e.pointerId, sx: x, sy: y, cx: e.clientX, cy: e.clientY, moved: false, t0: performance.now() };
    tselStart(i, x, y);
    return;
  }
  const target = e.target;
  const svg = E.pages[i].svg;
  const begin = (g) => { G = { ...g, page: i, pid: e.pointerId, sx: x, sy: y, moved: false }; try { svg.setPointerCapture(e.pointerId); } catch {} };

  if (target.closest?.('[data-handle]') && E.sel) {
    const o = byId(E.sel); snapshot();
    if (canRotate(o)) {
      const b = bbox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      return begin({ type: 'transform', obj: o, orig: JSON.parse(JSON.stringify(o)), cx, cy, a0: Math.atan2(y - cy, x - cx), d0: Math.max(1e-3, Math.hypot(x - cx, y - cy)), snapped: true });
    }
    return begin({ type: 'resize', obj: o, orig: JSON.parse(JSON.stringify(o)), b: bbox(o) });
  }
  if (k === 'ink') {
    snapshot();
    const isM = E.tool === 'marker';
    const o = { id: uid(), type: 'ink', page: i, points: [[x, y]], color: settings.get(isM ? 'markerColor' : 'penColor'), width: settings.get(isM ? 'markerWidth' : 'penWidth'), opacity: isM ? 0.45 : 1 };
    E.objects.push(o);
    const g = drawObj(o, svg);
    e.preventDefault();
    begin({ type: 'ink', obj: o, paths: g.querySelectorAll('path') });
    holdArm(e);
    return;
  }
  if (k === 'eraser') {
    snapshot();
    const dot = el('circle', { class: 'eraser-dot', cx: x, cy: y, r: 10 / scale() }, svg);
    begin({ type: 'erase', dot, removed: 0 }); eraseAt(i, x, y); return;
  }
  if (k === 'drag') {
    const d = el('rect', { class: 'draft', x, y, width: 0, height: 0 }, svg);
    e.preventDefault();
    return begin({ type: 'drag', draft: d });
  }
  const objEl = target.closest?.('.obj');
  if (objEl) {
    const o = byId(objEl.dataset.id);
    if (o) {
      const wasSel = E.sel === o.id;
      select(o.id);
      return begin({ type: 'move', obj: o, orig: JSON.parse(JSON.stringify(o)), wasSel, snap: false });
    }
  }
  if (k === 'textedit' && target.dataset?.key) {
    return begin({ type: 'tap', fn: () => replaceText(i, target.dataset.key) });
  }
  if (k === 'place') return begin({ type: 'tap', fn: () => placeAt(i, x, y) });
  // leere Fläche: Auswahl aufheben (bei Tipp)
  begin({ type: 'tap', fn: () => { if (E.sel) { E.sel = null; hideSelMenu(); renderLayer(i); } } });
}

function onMove(e) {
  if (!G || e.pointerId !== G.pid) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  const [x, y] = svgPt(e, G.page);
  const dx = x - G.sx, dy = y - G.sy;
  if (!G.moved && Math.hypot(dx, dy) * scale() > 4) G.moved = true;
  switch (G.type) {
    case 'ink': {
      const pts = G.obj.points, minD = 0.8 / scale();
      for (const ev of evs) { const p = svgPt(ev, G.page); const l = pts[pts.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1]) >= minD) pts.push(p); }
      const d = inkPath(pts); G.paths.forEach(p => p.setAttribute('d', d));
      if (Math.hypot(e.clientX - G.hold.x, e.clientY - G.hold.y) > 5) holdArm(e);
      break;
    }
    case 'press': if (Math.hypot(e.clientX - G.cx, e.clientY - G.cy) > 8) { clearTimeout(G.timer); G = null; } break;
    case 'tsel': tselMove(x, y); e.preventDefault(); break;
    case 'erase': G.dot.setAttribute('cx', x); G.dot.setAttribute('cy', y); eraseAt(G.page, x, y); break;
    case 'drag': {
      G.draft.setAttribute('x', Math.min(x, G.sx)); G.draft.setAttribute('y', Math.min(y, G.sy));
      G.draft.setAttribute('width', Math.abs(dx)); G.draft.setAttribute('height', Math.abs(dy));
      G.ex = x; G.ey = y; break;
    }
    case 'move': {
      if (!G.moved) return;
      if (!G.snap) { E.undo.push(JSON.stringify(E.objects.map(o => o.id === G.obj.id ? G.orig : o))); E.redo = []; G.snap = true; hideSelMenu(); }
      moveObj(G.obj, G.orig, dx, dy); renderLayer(G.page); break;
    }
    case 'resize': resizeObj(G.obj, G.orig, G.b, x, y); renderLayer(G.page); hideSelMenu(); break;
    case 'transform': transformObj(G, x, y, e); renderLayer(G.page); hideSelMenu(); break;
  }
}

function onUp(e) {
  activePointers.delete(e.pointerId);
  if (!G || e.pointerId !== G.pid) return;
  const g = G; G = null;
  clearTimeout(g.hold?.timer);
  switch (g.type) {
    case 'shaped': g.anim.then(() => { E.dirtyThumb = true; changed([g.page]); }); break;
    case 'ink':
      if (g.obj.points.length < 2 && !g.moved) g.obj.points.push([g.obj.points[0][0] + 0.3, g.obj.points[0][1]]);
      E.dirtyThumb = true; changed([g.page]); break;
    case 'erase': g.dot.remove(); if (!g.removed) E.undo.pop(); changed([g.page]); break;
    case 'drag': g.draft.remove(); finishDrag(g); break;
    case 'move':
      if (g.snap) { changed([g.page]); placeSelMenu(); }
      else if (g.wasSel && g.obj.type === 'text') openTextEditor(g.obj, false);
      else placeSelMenu();
      break;
    case 'resize': changed([g.page]); placeSelMenu(); break;
    case 'transform': hideRotTip(); if (!g.moved) E.undo.pop(); changed([g.page]); placeSelMenu(); break;
    case 'tap': if (!g.moved) g.fn(); break;
    case 'press': clearTimeout(g.timer); if (E.tsel) clearTsel(); break;
    case 'tsel': showTselBar(); break;
  }
}
function cancelGesture() {
  if (!G) return;
  const g = G; G = null;
  clearTimeout(g.hold?.timer);
  if (g.type === 'shaped') g.anim.then(() => { E.dirtyThumb = true; changed([g.page]); });
  if (g.type === 'ink') { E.objects = E.objects.filter(o => o !== g.obj); E.undo.pop(); renderLayer(g.page); }
  if (g.type === 'drag') g.draft.remove();
  if (g.type === 'erase') g.dot.remove();
  if (g.type === 'move' && g.snap) { Object.assign(g.obj, g.orig); E.undo.pop(); renderLayer(g.page); }
  if (g.type === 'transform') { hideRotTip(); Object.assign(g.obj, g.orig); E.undo.pop(); renderLayer(g.page); placeSelMenu(); }
}

// ---------- Smart Shapes: Finger am Ende ~400 ms ruhig halten → Form erkennen und einrasten ----------
const HOLD_MS = 400;
function holdArm(e) {
  if (!G || G.type !== 'ink') return;
  clearTimeout(G.hold?.timer);
  const g = G;
  g.hold = { x: e.clientX, y: e.clientY, timer: setTimeout(() => smartShape(g), HOLD_MS) };
}
function smartShape(g) {
  if (G !== g || g.type !== 'ink' || settings.get('smartShapes') === false) return;
  const o = g.obj, sc = scale();
  if (pathLen(o.points) * sc < 40) return;                        // zu kurz (Punkt, Tippen)
  const shape = recognize(o.points, 18 / sc);
  if (!shape) return;
  // Undo: erst zurück zum freien Strich, dann ganz weg
  E.undo.push(JSON.stringify(E.objects)); if (E.undo.length > 80) E.undo.shift(); E.redo = [];
  const from = o.points.slice();
  o.points = shape.pts; o.sharp = true; o.shape = shape.kind;
  g.type = 'shaped';
  haptic();
  const paths = [...g.paths];
  g.anim = morph(from, shape, pts => { const d = inkPath(pts, true); paths.forEach(p => p.setAttribute('d', d)); }, { reduced: reduceMotion() });
  hint(`${shape.label} erkannt`);
  updUndoBtns();
}
// Treffer auf eine Zeichnung (auch zwischen weit auseinanderliegenden Eckpunkten der Formen)
function inkHit(o, x, y, r) {
  const P = o.points;
  if (P.length === 1) return Math.hypot(P[0][0] - x, P[0][1] - y) < r;
  for (let k = 1; k < P.length; k++) {
    const [ax, ay] = P[k - 1], [bx, by] = P[k], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < r) return true;
  }
  return false;
}
window.addEventListener('pointermove', onMove, { passive: false });
window.addEventListener('pointerup', onUp);
window.addEventListener('pointercancel', e => { activePointers.delete(e.pointerId); if (G && G.pid === e.pointerId) { if (G.type === 'tap') G = null; else if (G.type === 'press') { clearTimeout(G.timer); G = null; } else onUp(e); } });

function moveObj(o, orig, dx, dy) {
  if (o.type === 'ink') o.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
  else { o.x = orig.x + dx; o.y = orig.y + dy; }
}
function resizeObj(o, orig, b, x, y) {
  const nw = Math.max(6, x - b.x), nh = Math.max(4, y - b.y);
  if (o.type === 'text') {
    const f = nw / b.w; o.size = Math.max(4, Math.min(200, orig.size * f)); measure(o);
  } else if (o.type === 'image') {
    const ar = orig.h / orig.w; o.w = nw; o.h = nw * ar;
  } else if (o.type === 'ink') {
    const f = Math.max(0.05, nw / b.w);
    o.points = orig.points.map(([px, py]) => [b.x + (px - b.x) * f, b.y + (py - b.y) * f]);
    o.width = Math.max(0.3, orig.width * f);
  } else { o.w = nw; o.h = nh; }
}
// Eck-Punkt: Abstand zur Mitte = Größe, Winkel zur Mitte = Drehung (rastet bei 0/90/180/270° ein)
function transformObj(g, x, y, e) {
  const o = g.obj, orig = g.orig, { cx, cy } = g;
  const d = Math.hypot(x - cx, y - cy), a = Math.atan2(y - cy, x - cx);
  let f = Math.max(0.08, Math.min(12, d / g.d0));
  let dDeg = (a - g.a0) * 180 / Math.PI;
  const base = o.type === 'ink' ? 0 : (orig.rot || 0);
  let total = base + dDeg;
  const near = Math.round(total / 90) * 90, snap = Math.abs(total - near) < 5;
  if (snap) { total = near; dDeg = near - base; }
  if (snap && !g.snapped) haptic();
  g.snapped = snap;
  if (o.type === 'image') {
    o.w = Math.max(6, orig.w * f); o.h = o.w * orig.h / orig.w; f = o.w / orig.w;
    o.x = cx - o.w / 2; o.y = cy - o.h / 2; o.rot = normDeg(total);
  } else if (o.type === 'text') {
    o.size = Math.max(4, Math.min(200, orig.size * f)); f = o.size / orig.size;
    measure(o); o.x = cx - o.w / 2; o.y = cy - o.h / 2; o.rot = normDeg(total);
  } else if (o.type === 'ink') {
    o.points = rotatePts(orig.points, cx, cy, dDeg, f);
    o.width = Math.max(0.3, orig.width * f);
    g.inkDeg = dDeg;
  }
  if (g.moved || Math.abs(f - 1) > 0.01 || Math.abs(dDeg) > 0.5) { g.moved = true; showRotTip(e, o.type === 'ink' ? normDeg(dDeg) : (o.rot || 0), f, snap); }
}
function eraseAt(i, x, y) {
  const r = 10 / scale();
  const before = E.objects.length;
  E.objects = E.objects.filter(o => !(o.page === i && o.type === 'ink' && inkHit(o, x, y, r + o.width / 2)));
  if (E.objects.length !== before) {
    G.removed += before - E.objects.length;
    const dot = G.dot; renderLayer(i); E.pages[i].svg.appendChild(dot); E.dirtyThumb = true;
  }
}

function finishDrag(g) {
  const i = g.page;
  const x0 = Math.min(g.sx, g.ex ?? g.sx), y0 = Math.min(g.sy, g.ey ?? g.sy);
  const w = Math.abs((g.ex ?? g.sx) - g.sx), h = Math.abs((g.ey ?? g.sy) - g.sy);
  const tiny = w * scale() < 6 && h * scale() < 6;
  if (E.tool === 'whiteout') {
    if (tiny) return hint('Ziehe ein Feld auf');
    snapshot();
    const col = sampleColors(i, { x: x0, y: y0, w, h }).bg;
    const o = { id: uid(), type: 'whiteout', page: i, x: x0, y: y0, w, h, color: col === '#000000' ? '#ffffff' : col };
    E.objects.push(o); E.dirtyThumb = true; select(o.id); changed([i]); return;
  }
  // Markieren / Unterstreichen / Durchstreichen
  const items = textItems(i);
  const rects = [];
  if (tiny) {
    const it = items.find(t => g.sx >= t.x && g.sx <= t.x + t.w && g.sy >= t.top && g.sy <= t.top + t.h);
    if (it) rects.push({ x: it.x, y: it.top, w: it.w, h: it.h });
  } else {
    items.forEach(t => {
      const cy = t.top + t.h / 2;
      if (cy < y0 - 1 || cy > y0 + h + 1) return;
      const a = Math.max(t.x, x0), b = Math.min(t.x + t.w, x0 + w);
      if (b - a > 1) rects.push({ x: a, y: t.top, w: b - a, h: t.h });
    });
    if (!rects.length) rects.push({ x: x0, y: y0, w, h: Math.max(h, 8) });
  }
  if (!rects.length) return hint('Kein Text gefunden – ziehe über den Text');
  snapshot();
  const color = settings.get(E.tool === 'highlight' ? 'hlColor' : 'lineColor');
  rects.forEach(r => E.objects.push({ id: uid(), type: E.tool, page: i, ...r, color }));
  E.dirtyThumb = true; haptic(); changed([i]);
}

// ======================= Text auswählen im Ansehen-Modus =======================
// Lange drücken (≈ 380 ms) auf ein Wort → Auswahl, Ziehen erweitert sie (auch an den Griffen).
// Danach schwebt eine Aktionsleiste darüber (Feder-Animation): Markieren, Unterstreichen,
// Schwärzen, Vorlesen, Kopieren. Markieren/Unterstreichen wischen sich wie ein Filzstift ein.
const TS_PRESS = 380;
function pageWords(i) {
  E.words ||= {};
  if (E.words[i]) return E.words[i];
  const items = textItems(i); if (!items.length) return [];
  const out = [];
  items.forEach(t => {
    mctx.font = `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} 100px ${FONT_CSS[t.font] || FONT_CSS.sans}`;
    const f = t.w / (mctx.measureText(t.str).width || 1);
    const re = /\S+/g; let m;
    while ((m = re.exec(t.str))) {
      const x = t.x + mctx.measureText(t.str.slice(0, m.index)).width * f;
      out.push({ s: m[0], x, w: Math.max(1, mctx.measureText(m[0]).width * f), top: t.top, h: t.h, k: out.length });
    }
  });
  return (E.words[i] = out);
}
const sameLine = (a, b) => Math.abs((a.top + a.h / 2) - (b.top + b.h / 2)) < Math.min(a.h, b.h) * 0.5;
function wordAt(i, x, y, loose) {
  let best = null, bd = 1e9;
  for (const w of pageWords(i)) {
    const dx = x < w.x ? w.x - x : x > w.x + w.w ? x - w.x - w.w : 0;
    const dy = y < w.top ? w.top - y : y > w.top + w.h ? y - w.top - w.h : 0;
    const d = dx + dy * 3; if (d < bd) { bd = d; best = w; }
  }
  return best && (loose || bd < 14 / scale()) ? best : null;
}
function tselWords() {
  const t = E.tsel; if (!t) return [];
  const W = pageWords(t.page), lo = Math.min(t.a, t.b), hi = Math.max(t.a, t.b);
  return W.slice(lo, hi + 1);
}
// Wörter zu Zeilen-Rechtecken zusammenfassen
function tselRects() {
  const rects = [];
  for (const w of tselWords()) {
    const r = rects[rects.length - 1];
    if (r && sameLine(r, w) && w.x >= r.x - 1 && w.x - (r.x + r.w) < w.h * 1.5) {
      const top = Math.min(r.top, w.top), bot = Math.max(r.top + r.h, w.top + w.h);
      r.w = w.x + w.w - r.x; r.top = top; r.h = bot - top;
    } else rects.push({ x: w.x, top: w.top, w: w.w, h: w.h });
  }
  return rects.map(r => ({ x: r.x, y: r.top, w: r.w, h: r.h }));
}
function tselText() {
  let s = '', prev = null;
  for (const w of tselWords()) { s += prev ? (sameLine(prev, w) ? ' ' : '\n') : ''; s += w.s; prev = w; }
  return s.replace(/-\n(?=\p{Ll})/gu, '');                      // Silbentrennung am Zeilenende auflösen
}
function drawTsel(svg, i) {
  const t = E.tsel; if (!t || t.page !== i) return;
  const W = pageWords(i); if (!W.length) return;
  const g = el('g', { class: 'tsel' }, svg);
  tselRects().forEach(r => el('rect', { x: r.x - 0.6, y: r.y - 0.6, width: r.w + 1.2, height: r.h + 1.2, rx: 1.2 }, g));
  const lo = W[Math.min(t.a, t.b)], hi = W[Math.max(t.a, t.b)], s = scale(), hr = 4.5 / s;
  [['lo', lo.x - 0.6, lo.top - 0.6, lo.top + lo.h + 0.6, true], ['hi', hi.x + hi.w + 0.6, hi.top - 0.6, hi.top + hi.h + 0.6, false]].forEach(([k, x, y0, y1, up]) => {
    const hg = el('g', { class: 'tsel-h', 'data-tsh': k }, g);
    el('line', { x1: x, x2: x, y1: y0, y2: y1 }, hg);
    el('circle', { cx: x, cy: up ? y0 - hr * 0.9 : y1 + hr * 0.9, r: hr }, hg);
    el('circle', { class: 'tsel-hit', cx: x, cy: up ? y0 - hr : y1 + hr, r: 16 / s, 'data-tsh': k }, hg);
  });
}
function clearTsel(silent) {
  if (!E.tsel) return;
  const i = E.tsel.page; E.tsel = null; hideTselBar();
  if (!silent) renderLayer(i);
}
function tselStart(i, x, y) {
  const go = () => {
    if (!G || G.type !== 'press' || G.page !== i) return;
    const w = wordAt(i, x, y);
    if (!w) { if (!pageWords(i).length && E.needOcr[i]) hint('Diese Seite hat keinen Text – erst „Text erkennen (OCR)“'); G = null; return; }
    if (E.tsel && E.tsel.page !== i) clearTsel();
    E.tsel = { page: i, a: w.k, b: w.k };
    G.type = 'tsel'; G.anchor = w.k; hideTselBar(); haptic(); renderLayer(i);
  };
  loadText(i).then(() => { G && G.type === 'press' && (G.timer = setTimeout(go, Math.max(0, TS_PRESS - (performance.now() - G.t0)))); });
}
function tselMove(x, y) {
  const w = wordAt(G.page, x, y, true); if (!w) return;
  const b = w.k; if (b === E.tsel.b) return;
  E.tsel.a = G.anchor; E.tsel.b = b; renderLayer(G.page);
}

// ---- schwebende Aktionsleiste mit Feder ----
let tbar = null, speaking = false;
const springKeys = (from, base, n = 22) => {
  // gedämpfte Feder ζ≈0.42: kräftiges, kurzes Überschwingen (≈ iOS „bouncy“)
  const z = 0.42, w = 26, wd = w * Math.sqrt(1 - z * z), T = 0.5, out = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n * T, e = k === n ? 1 : 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + z * w / wd * Math.sin(wd * t));
    const sc = from + (1 - from) * e;
    out.push({ transform: `${base} scale(${sc.toFixed(4)})`, opacity: Math.min(1, k / 4) });
  }
  return out;
};
function showTselBar() {
  const t = E.tsel; if (!t) return;
  const rects = tselRects(); if (!rects.length) return;
  if (!tbar) {
    tbar = document.createElement('div'); tbar.className = 'tselbar'; tbar.setAttribute('role', 'toolbar');
    $('editor').appendChild(tbar);
    tbar.addEventListener('pointerdown', e => e.stopPropagation());
    tbar.addEventListener('click', e => { const b = e.target.closest('[data-ta]'); if (b) { haptic(); tselAction(b.dataset.ta); } });
  }
  const acts = [['hl', 'Markieren', 'highlight'], ['ul', 'Unterstreichen', 'underline'], ['rd', 'Schwärzen', 'redact'], ['tts', speaking ? 'Stopp' : 'Vorlesen', 'speaker'], ['cp', 'Kopieren', 'copy']];
  tbar.innerHTML = acts.map(([a, l, ic]) => `<button data-ta="${a}">${icon(ic)}<span>${l}</span></button>`).join('');
  placeTselBar(true);
}
function placeTselBar(pop) {
  const t = E.tsel; if (!t || !tbar) return;
  const rects = tselRects(); if (!rects.length) return hideTselBar();
  const x0 = Math.min(...rects.map(r => r.x)), x1 = Math.max(...rects.map(r => r.x + r.w));
  const y0 = Math.min(...rects.map(r => r.y)), y1 = Math.max(...rects.map(r => r.y + r.h));
  const ctm = E.pages[t.page].svg.getScreenCTM(), er = $('editor').getBoundingClientRect();
  const a = new DOMPoint((x0 + x1) / 2, y0).matrixTransform(ctm), b = new DOMPoint((x0 + x1) / 2, y1).matrixTransform(ctm);
  const sr = $('ed-scroll').getBoundingClientRect();
  const below = a.y - 20 - 56 < sr.top + 8;
  const top = below ? Math.min(b.y + 22, sr.bottom - 64) : a.y - 20;
  const mw = tbar.offsetWidth || 320;
  tbar.style.left = Math.min(er.width - mw / 2 - 8, Math.max(mw / 2 + 8, a.x - er.left)) + 'px';
  tbar.style.top = (top - er.top) + 'px';
  const base = below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';
  tbar.style.transformOrigin = below ? '50% 0' : '50% 100%';
  tbar.style.transform = base;
  tbar.classList.toggle('below', below);
  if (pop) {
    tbar.classList.add('show');
    tbar.getAnimations?.().forEach(x => x.cancel());
    if (reduceMotion() || !tbar.animate) tbar.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    else tbar.animate(springKeys(0.55, base), { duration: 500, easing: 'linear' });
  }
}
function hideTselBar() { tbar?.classList.remove('show'); }

async function tselAction(a) {
  const t = E.tsel; if (!t) return;
  const i = t.page, rects = tselRects();
  if (a === 'tts') return speak(tselText());
  if (a === 'cp') { try { await navigator.clipboard.writeText(tselText()); toast('Kopiert'); } catch { toast('Kopieren nicht möglich', true); } clearTsel(); return; }
  if (a === 'hl' || a === 'ul') {
    snapshot();
    const type = a === 'hl' ? 'highlight' : 'underline', color = settings.get(a === 'hl' ? 'hlColor' : 'lineColor');
    const objs = rects.map(r => ({ id: uid(), type, page: i, ...r, color }));
    E.objects.push(...objs); E.dirtyThumb = true;
    clearTsel(true); changed([i]);
    feltSweep(i, objs);
    return;
  }
  if (a === 'rd') {
    clearTsel();
    const ok = await confirmDlg('Endgültig schwärzen?', `Der markierte Text wird aus der PDF entfernt – nicht nur abgedeckt. Seite ${i + 1} wird dafür als Bild neu aufgebaut; Text lässt sich auf dieser Seite danach nicht mehr markieren. Das lässt sich nicht rückgängig machen.`, 'Schwärzen');
    if (!ok) return;
    busy(true, 'Wird geschwärzt …');
    try {
      const { applyRedactions } = await import('./redact.js');
      const { w, h } = E.infos[i], pad = 0.8;
      const boxes = rects.map(r => ({ page: i, x: (r.x - pad) / w, y: (r.y - pad) / h, w: (r.w + 2 * pad) / w, h: (r.h + 2 * pad) / h }));
      const out = await applyRedactions(new Uint8Array(E.bytes), boxes);
      E.bytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      await db.put('files', { id: E.doc.id, data: E.bytes });
      E.doc.size = E.bytes.byteLength; await saveNow();
      const top = $('ed-scroll').scrollTop;
      await loadDocument(); setMode(E.mode, true); $('ed-scroll').scrollTop = top;
      await updateThumb(); E.dirtyThumb = false;
      toast('Geschwärzt – Inhalt entfernt'); haptic();
    } catch (err) { console.error(err); toast('Schwärzen fehlgeschlagen', true); }
    finally { busy(false); }
  }
}
function speak(text) {
  const ss = window.speechSynthesis;
  if (!ss) return toast('Vorlesen wird hier nicht unterstützt', true);
  if (speaking) { ss.cancel(); speaking = false; showTselBar(); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  const v = ss.getVoices().find(x => /^de(-|_|$)/i.test(x.lang)); if (v) u.voice = v;
  u.onend = u.onerror = () => { speaking = false; if (E.tsel) showTselBar(); };
  ss.cancel(); ss.speak(u); speaking = true; showTselBar();
}

// ---- Filzstift: Markierung wischt sich Zeile für Zeile von links nach rechts ein ----
function feltSweep(i, objs) {
  const svg = E.pages[i]?.svg; if (!svg || reduceMotion() || !objs.length) return;
  const s = scale();
  const segs = objs.map(o => {
    const g = svg.querySelector(`.obj[data-id="${o.id}"]`); if (!g) return null;
    const id = 'fs-' + o.id, pad = o.h * 0.55;
    const cp = el('clipPath', { id }, svg);
    const r = el('rect', { x: o.x - pad, y: o.y - o.h * 0.12, width: 0, height: o.h * 1.24, rx: pad, ry: o.h * 0.62 }, cp);
    g.setAttribute('clip-path', `url(#${id})`);
    // Strichlänge in Bildschirm-Pixeln → Dauer (schnell wie ein echter Zug: ~1.3 px/ms)
    return { o, g, cp, r, pad, dur: Math.max(110, Math.min(420, o.w * s / 1.3)) };
  }).filter(Boolean);
  if (!segs.length) return;
  const tip = el('ellipse', { class: 'felt-tip', rx: 0, ry: 0, fill: objs[0].color }, svg);
  const GAP = 45;                                           // Stift absetzen zwischen den Zeilen
  const total = segs.reduce((q, x) => q + x.dur + GAP, 0);
  const ease = p => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  const t0 = performance.now();
  const done = () => { segs.forEach(x => { x.g.removeAttribute('clip-path'); x.cp.remove(); }); tip.remove(); };
  const frame = now => {
    if (!svg.isConnected || !tip.isConnected) return done();
    let el0 = now - t0;
    if (el0 >= total) return done();
    for (const x of segs) {
      const full = x.o.w + 2 * x.pad;
      if (el0 >= x.dur + GAP) { x.r.setAttribute('width', full); el0 -= x.dur + GAP; continue; }
      const p = Math.min(1, el0 / x.dur), e = ease(p), wNow = full * e;
      x.r.setAttribute('width', wNow);
      const o = x.o, under = o.type === 'underline';
      const cx = o.x - x.pad + wNow - x.pad * 0.5, cy = under ? o.y + o.h - 0.5 : o.y + o.h / 2 + Math.sin(p * 9) * o.h * 0.03;
      tip.setAttribute('cx', cx); tip.setAttribute('cy', cy);
      tip.setAttribute('rx', under ? 1.6 : o.h * 0.22); tip.setAttribute('ry', under ? 1.6 : o.h * 0.5);
      tip.setAttribute('fill', o.color);
      tip.setAttribute('opacity', p < 1 ? 0.55 : 0);
      break;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ======================= Auswahl =======================
function select(id) {
  const prev = E.sel && byId(E.sel);
  E.sel = id;
  if (prev && prev.page !== byId(id)?.page) renderLayer(prev.page);
  const o = byId(id); if (o) renderLayer(o.page);
  placeSelMenu();
}
function hideSelMenu() { $('selmenu').classList.remove('show'); }
function placeSelMenu() {
  const m = $('selmenu');
  const o = E.sel && byId(E.sel); if (!o) return hideSelMenu();
  const b = rbbox(o), svg = E.pages[o.page].svg, ctm = svg.getScreenCTM();
  const p = new DOMPoint(b.x + b.w / 2, b.y).matrixTransform(ctm);
  const er = $('editor').getBoundingClientRect();
  const acts = [];
  if (o.type === 'text') acts.push(['edit', 'Bearbeiten', 'rename']);
  if (o.type !== 'ink') acts.push(['dup', 'Duplizieren', 'copy']);
  if (canRotate(o)) acts.push(['rot', o.rot ? 'Gerade' : 'Drehen', 'rotate']);
  if (['highlight', 'underline', 'strike', 'ink', 'whiteout'].includes(o.type)) acts.push(['color', 'Farbe', 'sliders']);
  acts.push(['del', 'Löschen', 'trash']);
  m.innerHTML = acts.map(([a, l, ic]) => `<button data-a="${a}" class="${a === 'del' ? 'danger' : ''}">${icon(ic)}${l}</button>`).join('');
  m.querySelectorAll('[data-a]').forEach(btn => btn.onclick = () => selAction(btn.dataset.a));
  const top = Math.max(er.top + 160, p.y - 12);
  const mw = m.offsetWidth || 300;
  m.style.left = Math.min(er.width - mw / 2 - 8, Math.max(mw / 2 + 8, p.x - er.left)) + 'px';
  m.style.top = (top - er.top) + 'px';
  m.classList.add('show');
}
function selAction(a) {
  const o = byId(E.sel); if (!o) return;
  if (a === 'del') { snapshot(); E.objects = E.objects.filter(x => x !== o); E.sel = null; hideSelMenu(); E.dirtyThumb = true; changed([o.page]); haptic(); }
  if (a === 'dup') { snapshot(); const c = JSON.parse(JSON.stringify(o)); c.id = uid(); delete c.srcKey; delete c.cover; c.x += 12; c.y += 12; E.objects.push(c); select(c.id); changed([o.page]); }
  if (a === 'edit') openTextEditor(o, false);
  if (a === 'rot') {
    snapshot(); haptic();
    if (o.type === 'ink') { const b = bbox(o); o.points = rotatePts(o.points, b.x + b.w / 2, b.y + b.h / 2, 90); }
    else o.rot = o.rot ? 0 : 90;      // gedreht → wieder gerade, sonst 90°
    changed([o.page]); placeSelMenu();
  }
  if (a === 'color') colorSheet(o);
}

// ======================= Platzieren =======================
function visibleCenter(i) {
  const p = E.pages[i], sr = $('ed-scroll').getBoundingClientRect(), r = p.el.getBoundingClientRect();
  const cx = (Math.max(r.left, sr.left) + Math.min(r.right, sr.right)) / 2;
  const cy = (Math.max(r.top, sr.top) + Math.min(r.bottom, sr.bottom)) / 2;
  const m = p.svg.getScreenCTM().inverse();
  const q = new DOMPoint(cx, cy).matrixTransform(m);
  return [q.x, q.y];
}
function addCentered(base, fx) {
  const i = currentPage(); const [cx, cy] = visibleCenter(i);
  const info = E.infos[i];
  let w = base.w, h = base.h;
  const maxW = info.w * 0.6; if (w > maxW) { h *= maxW / w; w = maxW; }
  snapshot();
  const o = { id: uid(), page: i, type: 'image', ...base, w, h, x: cx - w / 2, y: cy - h / 2 };
  E.objects.push(o); E.dirtyThumb = true;
  if (E.tool !== 'select') { E.tool = 'select'; renderToolbar(); }
  if (fx === 'stamp' && !noMotion()) { dropStamp(o); return; }
  select(o.id); changed([i]); haptic();
  hint('Verschieben – am Eck-Punkt skalieren & drehen');
}

// Stempel „fällt“ mit Federphysik auf die Seite, Tinten-Ring beim Aufsetzen, dann Auswahl
function dropStamp(o) {
  const i = o.page, p = E.pages[i], s = scale();
  changed([i]);
  const g = () => p.svg.querySelector(`[data-id="${o.id}"]`);
  stampDrop(p.el, { x: o.x * s, y: o.y * s, w: o.w * s, h: o.h * s }, o.src, {
    hide: () => { const n = g(); if (n) n.style.opacity = 0; },
    show: () => { const n = g(); if (n) n.style.opacity = ''; },
    onImpact: () => haptic(),
    color: '#ff6a5b',
  }).then(() => {
    if (!E.open || !byId(o.id)) return;
    select(o.id); changed([i]);
    hint('Verschieben – am Eck-Punkt skalieren & drehen');
  });
}

function placeAt(i, x, y) {
  const t = E.tool;
  if (t === 'check' || t === 'cross') {
    snapshot();
    const s = makeSymbol(t, settings.get('textColor'));
    const sz = 14;
    const o = { id: uid(), type: 'image', page: i, src: s.src, x: x - sz / 2, y: y - sz / 2, w: sz, h: sz };
    E.objects.push(o); E.dirtyThumb = true; select(o.id); changed([i]); haptic(); return;
  }
  const size = settings.get('textSize');
  const o = measure({
    id: uid(), type: 'text', page: i, x, y: y - size * 0.6, size, bold: false,
    color: t === 'note' ? '#222222' : settings.get('textColor'),
    text: t === 'date' ? today() : t === 'note' ? 'Notiz' : '',
    bg: t === 'note' ? '#fff3b0' : null,
  });
  snapshot();
  E.objects.push(o); E.dirtyThumb = true; select(o.id); changed([i]);
  if (t === 'date') return;
  openTextEditor(o, true);
}

async function replaceText(i, key) {
  const it = editItems(i).find(t => t.key === key); if (!it) return;
  const ex = E.objects.find(o => o.srcKey === key);
  if (ex) { select(ex.id); return openTextEditor(ex, false); }
  const cols = sampleColors(i, { x: it.x, y: it.top, w: it.w, h: it.h });
  const size = Math.round(it.size * 10) / 10;
  snapshot();
  const o = measure({
    id: uid(), type: 'text', page: i, srcKey: key, x: it.x, y: it.base - size * TEXT_ASC, size, bold: it.bold,
    font: it.font || 'sans', italic: !!it.italic, color: cols.fg, text: it.str.replace(/\s+$/, ''),
    cover: { x: it.x - 0.8, y: it.top - 0.6, w: it.w + 1.6, h: it.h + 1.2, color: cols.bg },
  });
  E.objects.push(o); E.dirtyThumb = true; select(o.id); changed([i]);
  openTextEditor(o, true, true);
}

// ======================= Text-Editor (Sheet) =======================
const TEXT_COLORS = ['#111318', '#4a4f5a', '#1d3fae', '#c62828', '#1f9d57', '#e65100', '#ffffff'];
function openTextEditor(o, isNew, isReplace) {
  hideSelMenu();
  if (!isNew) snapshot();
  const before = JSON.stringify(o);
  sheet({
    title: isReplace ? 'Text ändern' : o.bg ? 'Notiz' : 'Text',
    html: `
      <textarea class="field" data-t placeholder="Text eingeben …">${esc(o.text)}</textarea>
      <div class="txt-tools" style="margin-top:12px">
        <div class="stepper"><button data-s="-1">${icon('minus')}</button><span data-sz>${fmtSz(o.size)}</span><button data-s="1">${icon('plus')}</button></div>
        <button class="toggle ${o.bold ? 'on' : ''}" data-b>${icon('bold')}</button>
        <button class="toggle ${o.italic ? 'on' : ''}" data-it style="font:italic 600 19px Georgia,serif">I</button>
        <div class="seg txt-fonts">${[['sans', 'Arial'], ['serif', 'Times'], ['mono', 'Courier']].map(([k, n]) => `<button class="${(o.font || 'sans') === k ? 'on' : ''}" data-f="${k}" style="font-family:${FONT_CSS[k].replace(/"/g, '&quot;')}">${n}</button>`).join('')}</div>
        <div class="colors" style="flex:1 0 100%;justify-content:flex-end;flex-wrap:nowrap;gap:7px">${TEXT_COLORS.slice(0, 5).map(c => `<button class="color ${c === o.color ? 'on' : ''}" data-c="${c}" style="background:${c};width:28px;height:28px;flex:none"></button>`).join('')}</div>
      </div>
      <div class="btn-row"><button class="btn danger" data-del style="flex:0 0 auto;width:56px">${icon('trash')}</button><button class="btn primary" data-ok>${icon('check')} Fertig</button></div>`,
    onMount(el, api) {
      const ta = el.querySelector('[data-t]');
      const upd = () => { measure(o); renderLayer(o.page); ta.style.fontFamily = FONT_CSS[o.font] || ''; ta.style.fontStyle = o.italic ? 'italic' : ''; ta.style.fontWeight = o.bold ? '700' : ''; };
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 380);
      ta.oninput = () => { o.text = ta.value; upd(); };
      el.querySelectorAll('[data-s]').forEach(b => b.onclick = () => {
        o.size = Math.max(4, Math.min(120, Math.round((o.size + (+b.dataset.s) * (o.size < 14 ? 0.5 : 1)) * 2) / 2));
        el.querySelector('[data-sz]').textContent = fmtSz(o.size); upd();
      });
      el.querySelector('[data-b]').onclick = e => { o.bold = !o.bold; e.currentTarget.classList.toggle('on', o.bold); upd(); };
      el.querySelector('[data-it]').onclick = e => { o.italic = !o.italic; e.currentTarget.classList.toggle('on', o.italic); upd(); };
      el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { el.querySelectorAll('[data-f]').forEach(x => x.classList.remove('on')); b.classList.add('on'); o.font = b.dataset.f; upd(); });
      ta.style.fontFamily = FONT_CSS[o.font] || ''; ta.style.fontStyle = o.italic ? 'italic' : ''; ta.style.fontWeight = o.bold ? '700' : '';
      el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { el.querySelectorAll('[data-c]').forEach(x => x.classList.remove('on')); b.classList.add('on'); o.color = b.dataset.c; upd(); });
      el.querySelector('[data-del]').onclick = () => { o._del = true; api.close(); };
      el.querySelector('[data-ok]').onclick = () => api.close();
    },
    onClose() {
      const empty = !String(o.text).trim() && !o.cover;
      if (o._del || empty) {
        E.objects = E.objects.filter(x => x !== o); E.sel = null; hideSelMenu();
        if (isNew) E.undo.pop();
      } else if (!isNew && JSON.stringify(o) === before) {
        E.undo.pop();
      } else if (!o.cover && !o.bg) {
        settings.set('textSize', o.size); settings.set('textColor', o.color);
      }
      changed([o.page]);
      if (E.objects.includes(o)) placeSelMenu();
      document.activeElement?.blur?.();
    },
  });
}
const fmtSz = s => String(s).replace('.', ',') + ' pt';

// ======================= Optionen / Farben =======================
const PEN_COLORS = ['#111318', '#1d3fae', '#c62828', '#1f9d57', '#e65100', '#6a3fd1'];
const HL_COLORS = ['#ffd60a', '#7ee081', '#6ec6ff', '#ff8fb1', '#ffab5e'];
function optionsSheet() {
  const t = E.tool;
  const cfg = {
    pen: { title: 'Stift', key: 'penColor', cols: PEN_COLORS, w: 'penWidth', min: 0.5, max: 8, step: 0.5, shapes: true },
    marker: { title: 'Marker', key: 'markerColor', cols: HL_COLORS, w: 'markerWidth', min: 4, max: 30, step: 1, shapes: true },
    highlight: { title: 'Markieren', key: 'hlColor', cols: HL_COLORS },
    underline: { title: 'Unterstreichen', key: 'lineColor', cols: PEN_COLORS },
    strike: { title: 'Durchstreichen', key: 'lineColor', cols: PEN_COLORS },
    text: { title: 'Text', key: 'textColor', cols: TEXT_COLORS.slice(0, 5), size: true },
    note: { title: 'Text', key: 'textColor', cols: TEXT_COLORS.slice(0, 5), size: true },
    whiteout: { title: 'Abdecken', info: 'Die Farbe des Abdeckfelds wird automatisch vom Hintergrund übernommen (z. B. weiß oder grau). Danach kannst du mit „Text“ neuen Inhalt darüber schreiben.' },
  }[t];
  if (!cfg) return;
  sheet({
    title: cfg.title,
    html: cfg.info ? `<p style="color:var(--text2);line-height:1.5;margin:0 2px 6px">${cfg.info}</p>` : `
      <div class="lbl" style="margin-top:0">Farbe</div>
      <div class="colors">${cfg.cols.map(c => `<button class="color ${c === settings.get(cfg.key) ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      ${cfg.w ? `<div class="lbl">Stärke <span data-wv>${settings.get(cfg.w)}</span></div><input type="range" class="range" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${settings.get(cfg.w)}" data-w>` : ''}
      ${cfg.shapes ? `<div class="row" style="padding:14px 2px 2px;border:0"><span class="row-main"><span class="row-title">Smart Shapes</span><span class="row-sub" style="display:block">Form zeichnen und am Ende kurz halten → Linie, Pfeil, Rechteck, Dreieck oder Kreis rasten sauber ein</span></span>
        <div class="seg" data-shapes><button data-v="1" class="${settings.get('smartShapes') !== false ? 'on' : ''}">An</button><button data-v="0" class="${settings.get('smartShapes') === false ? 'on' : ''}">Aus</button></div></div>` : ''}
      ${cfg.size ? `<div class="lbl">Schriftgröße <span data-wv>${settings.get('textSize')}</span> pt</div><input type="range" class="range" min="6" max="36" step="0.5" value="${settings.get('textSize')}" data-sz>` : ''}`,
    onMount(el) {
      el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { el.querySelectorAll('[data-c]').forEach(x => x.classList.remove('on')); b.classList.add('on'); settings.set(cfg.key, b.dataset.c); });
      const w = el.querySelector('[data-w]'); if (w) w.oninput = () => { settings.set(cfg.w, +w.value); el.querySelector('[data-wv]').textContent = w.value; };
      el.querySelectorAll('[data-shapes] button').forEach(b => b.onclick = () => { el.querySelectorAll('[data-shapes] button').forEach(x => x.classList.toggle('on', x === b)); settings.set('smartShapes', b.dataset.v === '1'); haptic(); });
      const sz = el.querySelector('[data-sz]'); if (sz) sz.oninput = () => { settings.set('textSize', +sz.value); el.querySelector('[data-wv]').textContent = sz.value; };
    },
  });
}
function colorSheet(o) {
  const cols = o.type === 'highlight' ? HL_COLORS : o.type === 'whiteout' ? ['#ffffff', '#f2f2f2', '#e6e6e6', '#000000'] : PEN_COLORS;
  snapshot();
  sheet({
    title: 'Farbe',
    html: `<div class="colors">${cols.map(c => `<button class="color ${c === o.color ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>`,
    onMount(el) { el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { el.querySelectorAll('[data-c]').forEach(x => x.classList.remove('on')); b.classList.add('on'); o.color = b.dataset.c; renderLayer(o.page); }); },
    onClose: () => changed([o.page]),
  });
}

// ======================= Aktionen (Bild, Unterschrift, Stempel) =======================
async function runAction(id) {
  if (id === 'image') {
    const [f] = await pickFiles('file-img'); if (!f) return;
    busy(true, 'Bild wird eingefügt …');
    try { const im = await normalizeImage(f, 1800); addCentered({ src: im.url, w: im.w * 0.3, h: im.h * 0.3 }); }
    catch { toast('Bild konnte nicht geladen werden', true); } finally { busy(false); }
  }
  if (id === 'signature') signatureSheet(a => { const W = 140; addCentered({ src: a.src, w: W, h: W * a.h / a.w, kindTag: 'sig' }); });
  if (id === 'stamp') stampSheet(a => { const st = freshStamp(a); const W = a.qr ? 100 : a.image ? 130 : st.w * 0.55; addCentered({ src: st.src, w: W, h: W * st.h / st.w, opacity: a.image || a.qr ? 1 : 0.95 }, 'stamp'); });
}

// ======================= Mehr-Menü / Export =======================
async function exportBytes() {
  await saveNow();
  if (!E.objects.length) return new Uint8Array(E.bytes);
  return flatten(E.bytes, E.objects, E.infos);
}
const pdfName = () => /\.pdf$/i.test(E.doc.name) ? E.doc.name : E.doc.name + '.pdf';

export async function shareBytes(bytes, name, type = 'application/pdf') {
  const file = new File([bytes], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadBytes(bytes, name, type);
}
export function downloadBytes(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function bake(msg = 'Änderungen werden eingebrannt …') {
  if (!E.objects.length) return;
  busy(true, msg);
  try {
    const out = await flatten(E.bytes, E.objects, E.infos);
    E.bytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    E.objects = []; E.undo = []; E.redo = []; E.sel = null; hideSelMenu();
    await db.put('files', { id: E.doc.id, data: E.bytes });
    E.doc.size = E.bytes.byteLength; await saveNow();
    await loadDocument(); setMode(E.mode, true); await updateThumb(); E.dirtyThumb = false;
  } finally { busy(false); }
}

function moreSheet() {
  sheet({
    title: E.doc.name,
    html: `
      <div class="menu-grid" style="margin-bottom:16px${E.outline ? ';grid-template-columns:repeat(4,1fr)' : ''}">
        <button data-a="share"><span class="qt-ic c-blue">${icon('share')}</span>Teilen</button>
        <button data-a="download"><span class="qt-ic c-green">${icon('download')}</span>Sichern</button>
        <button data-a="pages"><span class="qt-ic c-violet">${icon('pages')}</span>Seiten</button>
        ${E.outline ? `<button data-a="toc"><span class="qt-ic c-orange">${icon('toc')}</span>Inhalt</button>` : ''}
      </div>
      <div class="menu" style="margin-bottom:12px">
        <button class="row" data-a="view"><span class="row-ic c-orange">${icon('pages')}</span><span class="row-main"><span class="row-title">Seitenansicht</span><span class="row-sub">${{ single: 'Einzelseite', flip: 'Buch-Umblättern (3D)' }[settings.get('viewMode')] || 'Endlos-Scrollen'} · umschalten</span></span>${icon('chevronRight')}</button>
        <button class="row" data-a="reader"><span class="row-ic c-teal">${icon('book')}</span><span class="row-main"><span class="row-title">Lesemodus</span><span class="row-sub">Fließtext fürs Handy · Schriftgröße & Farben</span></span>${icon('chevronRight')}</button>
        <button class="row" data-a="present"><span class="row-ic c-violet">${icon('present')}</span><span class="row-main"><span class="row-title">Präsentieren</span><span class="row-sub">Vollbild mit Laserpointer</span></span>${icon('chevronRight')}</button>
        <button class="row" data-a="info"><span class="row-ic c-blue">${icon('gauge')}</span><span class="row-main"><span class="row-title">Dokument-Info & Qualitäts-Check</span><span class="row-sub">Format, Schriften, Bildauflösung, Formularfelder</span></span>${icon('chevronRight')}</button>
        <button class="row" data-a="fix"><span class="row-ic c-red">${icon('lock')}</span><span class="row-main"><span class="row-title">Als schreibgeschütztes PDF fixieren</span><span class="row-sub">Flatten: Felder, Stempel, Unterschriften fest einbrennen</span></span>${icon('chevronRight')}</button>
      </div>
      <div class="menu">
        <button class="row" data-a="bake"><span class="row-ic c-orange">${icon('check')}</span><span class="row-main"><span class="row-title">Fertigstellen</span><span class="row-sub">Änderungen fest ins PDF übernehmen</span></span></button>
        <button class="row" data-a="copy"><span class="row-ic c-teal">${icon('copy')}</span><span class="row-main"><span class="row-title">Als Kopie speichern</span></span></button>
        <button class="row" data-a="rename"><span class="row-ic c-gray">${icon('rename')}</span><span class="row-main"><span class="row-title">Umbenennen</span></span></button>
        <button class="row" data-a="delete"><span class="row-ic c-red">${icon('trash')}</span><span class="row-main"><span class="row-title" style="color:var(--danger)">Löschen</span></span></button>
      </div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        const a = b.dataset.a; api.close();
        if (a === 'toc') return tocSheet();
        if (a === 'view') return viewSheet();
        if (a === 'present') return present();
        if (a === 'reader') return reader();
        if (a === 'info') return docInfo();
        if (a === 'fix') return fixSheet();
        try {
          if (a === 'share' || a === 'download') {
            busy(true, 'PDF wird erstellt …');
            const bytes = await exportBytes(); busy(false);
            a === 'share' ? await shareBytes(bytes, pdfName()) : downloadBytes(bytes, pdfName());
          }
          if (a === 'bake') {
            if (!E.objects.length) return toast('Keine offenen Änderungen');
            if (await confirmDlg('Fertigstellen?', 'Alle Änderungen werden fest in das PDF geschrieben und sind danach nicht mehr einzeln verschiebbar.', 'Fertigstellen', false)) { await bake(); toast('Änderungen übernommen'); }
          }
          if (a === 'pages') {
            if (E.objects.length && !(await confirmDlg('Änderungen übernehmen?', 'Zum Verwalten der Seiten werden deine Änderungen zuerst fest ins PDF geschrieben.', 'Weiter', false))) return;
            await bake(); pageManager();
          }
          if (a === 'copy') {
            busy(true, 'Kopie wird erstellt …');
            const bytes = await exportBytes();
            const id = uid(); const name = E.doc.name.replace(/\.pdf$/i, '') + ' (Kopie).pdf';
            const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            await db.put('files', { id, data });
            await db.put('docs', { ...E.doc, id, name, objects: [], created: Date.now(), updated: Date.now(), size: data.byteLength });
            busy(false); toast('Kopie gespeichert');
          }
          if (a === 'rename') {
            const { renameSheet } = await import('./titles.js');
            const n = await renameSheet(E.doc.name.replace(/\.pdf$/i, ''), async () => ({ pdf: E.pdf }));
            if (n) { E.doc.name = n + '.pdf'; await saveNow(); toast('Umbenannt'); }
          }
          if (a === 'delete') {
            if (await confirmDlg('PDF löschen?', `„${E.doc.name}“ kommt in den Papierkorb und kann 30 Tage lang wiederhergestellt werden.`, 'In den Papierkorb')) {
              await saveNow();
              const { moveToTrash } = await import('./trash.js');
              await moveToTrash(E.doc.id);
              E.doc = null; E.dirtyThumb = false; closeEditor(); toast('In den Papierkorb verschoben');
            }
          }
        } catch (err) { console.error(err); busy(false); toast('Das hat nicht geklappt', true); }
      });
    },
  });
}

// ======================= Seitenansicht (Einzelseite / Buch 3D) =======================
function viewSheet() {
  const cur = settings.get('viewMode') || 'scroll';
  const opts = [['scroll', 'Endlos-Scrollen', 'Alle Seiten untereinander – zum Bearbeiten', 'c-blue', 'pages'],
    ['single', 'Einzelseite', 'Seite für Seite wischen', 'c-teal', 'file'],
    ['flip', 'Buch-Umblättern (3D)', 'Seiten biegen sich beim Wischen wie in einem Buch', 'c-orange', 'book']];
  sheet({
    title: 'Seitenansicht',
    html: `<div class="menu">${opts.map(([k, t, sub, c, ic]) => `<button class="row ${k === cur ? 'sel' : ''}" data-v="${k}"><span class="row-ic ${c}">${icon(ic)}</span><span class="row-main"><span class="row-title">${t}</span><span class="row-sub">${sub}</span></span><span class="radio"></span></button>`).join('')}</div>
      <p style="color:var(--text3);font-size:12.5px;margin:12px 2px 0">Die Wahl gilt auch beim nächsten Öffnen einer PDF zum Ansehen.</p>`,
    onMount(el, api) {
      el.querySelectorAll('[data-v]').forEach(b => b.onclick = () => {
        haptic(); const v = b.dataset.v; settings.set('viewMode', v); api.close();
        if (v !== 'scroll') setTimeout(() => pageView(v), 200);
      });
    },
  });
}
async function pageView(mode, auto = false) {
  let pdf = E.pdf, temp = null;
  try {
    if (E.objects.length) { busy(true, 'Ansicht wird vorbereitet …'); temp = pdf = await loadPdf(await exportBytes()); busy(false); }
    const { flipView } = await import('./flipview.js');
    guardSet(E.doc.id, 'view');
    E.hidden = true;
    const r = await flipView({ pdf, start: currentPage(), title: E.doc.name.replace(/\.pdf$/i, ''), mode, lowMem: lowMem(), onReady: () => setTimeout(guardClear, 4000) });
    E.hidden = false; guardClear();
    settings.set('viewMode', r.mode);
    if (!E.open) return;
    if (auto && r.mode !== 'scroll') return closeEditor();
    rerenderVisible();          // „Zurück“ aus der Ansicht → zur Dateiliste
    if (r.page !== currentPage()) { const p = E.pages[r.page]; if (p) $('ed-scroll').scrollTop = Math.max(0, p.el.offsetTop - 12); updPageChip(); rerenderVisible(); }
  } catch (e) { console.error(e); busy(false); toast('Ansicht konnte nicht geöffnet werden', true); }
  finally { E.hidden = false; if (E.open) rerenderVisible(); if (temp) setTimeout(() => closePdf(temp), 600); }
}

// ======================= Präsentieren =======================
async function present() {
  let pdf = E.pdf, temp = null;
  try {
    if (E.objects.length) {       // eigene Ebenen mit anzeigen (ohne das Dokument zu ändern)
      busy(true, 'Präsentation wird vorbereitet …');
      temp = pdf = await loadPdf(await exportBytes());
      busy(false);
    }
    const { presentMode } = await import('./present.js');
    const last = await presentMode({ pdf, start: currentPage(), title: E.doc.name.replace(/\.pdf$/i, '') });
    if (E.open && last !== currentPage()) { const p = E.pages[last]; if (p) $('ed-scroll').scrollTop = Math.max(0, p.el.offsetTop - 12); updPageChip(); rerenderVisible(); }
  } catch (e) { console.error(e); busy(false); toast('Präsentation konnte nicht gestartet werden', true); }
  finally { if (temp) setTimeout(() => closePdf(temp), 400); }
}

// ======================= Dokument-Info & Qualitäts-Check =======================
async function docInfo() {
  busy(true, 'Dokument wird geprüft …');
  try {
    const { analyze, preflightSheet } = await import('./preflight.js');
    const R = await analyze(E.pdf, E.bytes, (i, n) => busy(true, n > 3 ? `Seite ${i} von ${n} wird geprüft …` : 'Dokument wird geprüft …'));
    busy(false);
    preflightSheet(R, E.doc.name);
  } catch (e) { console.error(e); busy(false); toast('Prüfung fehlgeschlagen', true); }
}

// ======================= Lesemodus =======================
async function reader() {
  try {
    const { readerMode } = await import('./reader.js');
    const last = await readerMode({ pdf: E.pdf, start: currentPage(), title: E.doc.name.replace(/\.pdf$/i, '') });
    if (E.open && last !== currentPage()) { const p = E.pages[last]; if (p) $('ed-scroll').scrollTop = Math.max(0, p.el.offsetTop - 12); updPageChip(); rerenderVisible(); }
  } catch (e) { console.error(e); toast('Lesemodus konnte nicht geöffnet werden', true); }
}

// ======================= Fixieren (Flatten) =======================
async function fixSheet() {
  const st = { raster: false, dpi: 200 };
  const { fixatePdf, countEditable } = await import('./fixate.js');
  sheet({
    title: 'PDF fixieren',
    html: `<p class="fx-intro">Alles wird fest in die Seiten eingebrannt – danach gibt es <b>keine bearbeitbaren Formularfelder</b> und <b>keine verschiebbaren Ebenen</b> mehr. Ideal für Verträge und Formulare zum Versenden. Dein Dokument in Nibvion bleibt unverändert.</p>
      <div class="fx-list" data-list>
        <div class="fx-it"><span class="row-ic c-blue">${icon('form')}</span><span>Formularfelder</span><b data-c="fields">…</b></div>
        <div class="fx-it"><span class="row-ic c-green">${icon('sign')}</span><span>Stempel, Unterschriften, Texte, Zeichnungen</span><b>${E.objects.length}</b></div>
        <div class="fx-it"><span class="row-ic c-amber">${icon('comment')}</span><span>Kommentare & Markierungen im PDF</span><b data-c="annots">…</b></div>
      </div>
      <div class="menu fx-opt">
        <div class="row"><span class="row-ic c-red">${icon('shieldLock')}</span><span class="row-main"><span class="row-title">Seiten zusätzlich rastern</span><span class="row-sub">Maximaler Schutz: Seiten werden zu Bildern – Text & Unterschriften lassen sich auch in Profi-Editoren nicht mehr zerlegen</span></span>
          <div class="seg" data-raster><button data-v="1">An</button><button data-v="0" class="on">Aus</button></div></div>
        <div class="row" data-dpirow hidden><span class="row-main"><span class="row-title">Auflösung</span><span class="row-sub" data-dpisub></span></span>
          <div class="seg" data-dpi><button data-v="150">150</button><button data-v="200" class="on">200</button><button data-v="300">300 dpi</button></div></div>
      </div>
      <p class="fx-note" data-note hidden>${icon('info')} Gerasterte Seiten sind nicht mehr durchsuchbar und Text kann nicht kopiert werden. Die Datei wird größer.</p>
      <div class="btn-row"><button class="btn" data-go="copy">${icon('copy')} Als Kopie</button><button class="btn" data-go="download">${icon('download')} Sichern</button></div>
      <div class="btn-row" style="margin-top:8px"><button class="btn primary" data-go="share">${icon('share')} Fixieren & teilen</button></div>`,
    onMount(el, api) {
      const $q = s => el.querySelector(s);
      countEditable(E.pdf).then(c => { if (api.closed) return; $q('[data-c=fields]').textContent = c.fields; $q('[data-c=annots]').textContent = c.annots; }).catch(() => {});
      const dpiSub = () => { $q('[data-dpisub]').textContent = { 150: 'Kleinere Datei', 200: 'Empfohlen – scharf & handlich', 300: 'Druckqualität, große Datei' }[st.dpi]; };
      el.querySelectorAll('[data-raster] button').forEach(btn => btn.onclick = () => {
        st.raster = btn.dataset.v === '1'; haptic();
        el.querySelectorAll('[data-raster] button').forEach(x => x.classList.toggle('on', x === btn));
        $q('[data-dpirow]').hidden = !st.raster; $q('[data-note]').hidden = !st.raster; dpiSub();
      });
      el.querySelectorAll('[data-dpi] button').forEach(b => b.onclick = () => { st.dpi = +b.dataset.v; el.querySelectorAll('[data-dpi] button').forEach(x => x.classList.toggle('on', x === b)); dpiSub(); haptic(); });
      el.querySelectorAll('[data-go]').forEach(b => b.onclick = async () => {
        const how = b.dataset.go; api.close();
        const base = E.doc.name.replace(/\.pdf$/i, ''), name = `${base} (fixiert).pdf`;
        busy(true, 'PDF wird fixiert …');
        try {
          const src = await exportBytes();
          const r = await fixatePdf(src, { raster: st.raster, dpi: st.dpi, title: base, onProgress: t => busy(true, t) });
          busy(false);
          if (how === 'share') await shareBytes(r.bytes, name);
          else if (how === 'download') downloadBytes(r.bytes, name);
          else {
            busy(true, 'Kopie wird gespeichert …');
            const { saveNewDoc } = await import('./app.js');
            await saveNewDoc(r.bytes, name);
            busy(false); toast(st.raster ? 'Gerasterte Kopie gespeichert' : 'Fixierte Kopie gespeichert');
          }
          if (!r.formOk) toast('Einige Formularfelder wurden als Bild eingebrannt');
        } catch (e) { console.error(e); busy(false); toast('Fixieren fehlgeschlagen', true); }
      });
    },
  });
}

// ======================= Seiten verwalten =======================
let pgKey = 0;
async function pageManager() {
  let order = E.infos.map((_, i) => ({ i, rot: 0 }));
  const thumbs = [];
  for (let i = 0; i < E.infos.length; i++) thumbs[i] = await renderThumb(E.pdf, i + 1, 180);
  let blank = false;
  sheet({
    title: 'Seiten verwalten',
    html: `<p class="pm-tip">Tipp: Seite kurz halten und nach oben wegschnippen zum Löschen.</p><div class="pm-tools"><button class="chip" data-findblank>${icon('pageBlank')} Leere Seiten finden</button><button class="chip" data-duplex>${icon('duplex')} Duplex sortieren</button></div>
      <div class="page-grid no-swipe" data-grid></div>
      <div class="btn-row"><button class="btn" data-blank>${icon('plus')} Leere Seite</button><button class="btn primary" data-ok>${icon('check')} Übernehmen</button></div>`,
    onMount(el, api) {
      const grid = el.querySelector('[data-grid]');
      let analysis = null;
      el.querySelector('[data-findblank]').onclick = async () => {
        haptic();
        if (!analysis) {
          busy(true, 'Seiten werden geprüft …');
          try { analysis = await analyzeAll(E.pdf, (i, n) => busy(true, `Seite ${i} von ${n} wird geprüft …`)); }
          catch (e) { console.error(e); busy(false); return toast('Seiten konnten nicht geprüft werden', true); }
          busy(false);
        }
        blankReview(order.map(p => analysis[p.i]), {
          onApply(del) {
            order = order.filter((_, k) => !del.has(k)); render();
            toast(`${del.size} ${del.size === 1 ? 'Seite' : 'Seiten'} entfernt – zum Speichern „Übernehmen“`);
          },
        });
      };
      el.querySelector('[data-duplex]').onclick = () => {
        haptic();
        if (order.length < 2) return toast('Mindestens zwei Seiten nötig', true);
        const ex = rev => duplexOrder(Math.min(order.length, 6), rev).map(p => p.i + 1).join(', ');
        sheet({
          title: 'Duplex sortieren',
          html: `<p style="color:var(--text2);margin:0 2px 12px;font-size:14px;line-height:1.4">Die erste Hälfte sind die Vorderseiten, die zweite Hälfte die Rückseiten. Danach liegen sie abwechselnd: Vorderseite, Rückseite, …${order.length % 2 ? `<br><b style="color:var(--accent)">Achtung: ungerade Seitenzahl (${order.length}).</b>` : ''}</p>
            <div class="menu">
              <button class="row" data-rev="1"><span class="row-ic c-orange">${icon('pages')}</span><span class="row-main"><span class="row-title">Rückseiten rückwärts</span><span class="row-sub">Stapel umgedreht gescannt · ${ex(true)}</span></span>${icon('chevronRight')}</button>
              <button class="row" data-rev="0"><span class="row-ic c-blue">${icon('pages')}</span><span class="row-main"><span class="row-title">Rückseiten in normaler Reihenfolge</span><span class="row-sub">${ex(false)}</span></span>${icon('chevronRight')}</button>
            </div>`,
          onMount(e2, a2) {
            e2.querySelectorAll('[data-rev]').forEach(b => b.onclick = () => {
              a2.close();
              order = duplexOrder(order.length, b.dataset.rev === '1').map(p => order[p.i]); render();
              toast('Neu sortiert – zum Speichern „Übernehmen“');
            });
          },
        });
      };
      const render = () => {
        grid.innerHTML = order.map((p, k) => `
          <div class="pg" data-flip="${p.key ??= ++pgKey}" data-k="${k}"><div class="pg-img" style="background-image:url(${thumbs[p.i]});transform:rotate(${p.rot}deg)"></div>
          <div class="pg-n">${k + 1}</div>
          <div class="pg-acts"><button data-l="${k}" ${k ? '' : 'disabled style="opacity:.3"'}>${icon('chevronLeft')}</button><button data-r="${k}">${icon('rotate')}</button><button data-d="${k}">${icon('trash')}</button></div></div>`).join('')
          + (blank ? `<div class="pg"><div class="pg-img"></div><div class="pg-n">Neu</div></div>` : '');
        grid.querySelectorAll('[data-l]').forEach(b => b.onclick = () => { const k = +b.dataset.l; if (!k) return; [order[k - 1], order[k]] = [order[k], order[k - 1]]; render(); });
        grid.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
          const p = order[+b.dataset.r], im = b.closest('.pg').querySelector('.pg-img');
          p.rot = (p.rot + 90) % 360; haptic();
          // sanft weiterdrehen (Winkel läuft weiter, 270° → 360° statt zurück auf 0°)
          im.dataset.v = (+(im.dataset.v ?? (p.rot + 270) % 360)) + 90; im.style.transform = `rotate(${im.dataset.v}deg)`;
        });
        grid.querySelectorAll('[data-d]').forEach(b => b.onclick = () => removeAt(+b.dataset.d, b.closest('.pg')));
        grid.querySelectorAll('.pg[data-k]').forEach(pg => flickToDelete(pg));
      };
      // Seite entfernen: wegschnippen/verpuffen, übrige Seiten rücken mit Feder nach
      const removeAt = async (k, pg, v) => {
        if (order.length <= 1) { pg && pg.querySelector('.pg-img').animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 300 }); return toast('Mindestens eine Seite muss bleiben', true); }
        haptic();
        if (pg) { pg.style.pointerEvents = 'none'; await poof(pg.querySelector('.pg-img'), v); pg.style.visibility = 'hidden'; }
        const before = flipCapture([...grid.querySelectorAll('[data-flip]')]);
        order.splice(k, 1); render();
        flipPlay(grid, before);
      };
      // Anheben (kurz halten) → nach oben wegschnippen. Schnelles Wischen scrollt weiterhin.
      const flickToDelete = pg => {
        const im = pg.querySelector('.pg-img');
        let st = null;
        const reset = () => { if (!st) return; clearTimeout(st.hold); pg.classList.remove('lift'); st = null; };
        pg.addEventListener('touchstart', e => {
          if (e.touches.length > 1 || e.target.closest('.pg-acts')) return;
          const t = e.touches[0];
          st = { x: t.clientX, y: t.clientY, armed: false, dy: 0, dx: 0, lt: performance.now(), ly: t.clientY, v: 0 };
          st.hold = setTimeout(() => { if (!st) return; st.armed = true; pg.classList.add('lift'); im.style.transform = `rotate(${order[+pg.dataset.k]?.rot || 0}deg) scale(1.06)`; haptic(); }, 220);
        }, { passive: true });
        pg.addEventListener('touchmove', e => {
          if (!st) return;
          const t = e.touches[0], dx = t.clientX - st.x, dy = t.clientY - st.y;
          if (!st.armed) { if (Math.hypot(dx, dy) > 8) reset(); return; }
          e.preventDefault();
          const now = performance.now(); st.v = (t.clientY - st.ly) / Math.max(1, now - st.lt); st.ly = t.clientY; st.lt = now;
          st.dy = Math.min(dy, dy * 0.2); st.dx = dx * 0.35;
          const k = Math.min(1, Math.max(0, -st.dy / 140));
          im.style.transition = 'none';
          im.style.transform = `translate3d(${st.dx}px,${st.dy}px,0) rotate(${((order[+pg.dataset.k]?.rot || 0) + st.dx * 0.08).toFixed(2)}deg) scale(${1.06 - k * 0.12})`;
          im.style.opacity = 1 - k * 0.45;
        }, { passive: false });
        const end = () => {
          if (!st) return;
          const g = st; reset();
          if (!g.armed) return;
          if (g.dy < -70 || (g.v < -0.55 && g.dy < -20)) { removeAt(+pg.dataset.k, pg, { vy: g.v, dx: g.dx }); return; }
          im.style.transition = ''; im.style.opacity = '';
          im.style.transform = `rotate(${order[+pg.dataset.k]?.rot || 0}deg)`; delete im.dataset.v;
        };
        pg.addEventListener('touchend', end); pg.addEventListener('touchcancel', end);
      };
      render();
      el.querySelector('[data-blank]').onclick = () => { blank = true; render(); };
      el.querySelector('[data-ok]').onclick = async () => {
        api.close(); busy(true, 'Seiten werden angepasst …');
        try {
          const out = await pagesOp(E.bytes, { order, blankAfter: blank ? order.length - 1 : null });
          E.bytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
          await db.put('files', { id: E.doc.id, data: E.bytes });
          E.doc.size = E.bytes.byteLength; E.doc.pages = order.length + (blank ? 1 : 0); await saveNow();
          await loadDocument(); setMode(E.mode, true); await updateThumb();
          toast('Seiten aktualisiert');
        } catch (err) { console.error(err); toast('Seiten konnten nicht geändert werden', true); }
        finally { busy(false); }
      };
    },
  });
}

// ======================= Verkabelung =======================
export function initEditor() {
  hydrateIcons($('editor'));
  const sc = $('ed-scroll');
  initScrubber($('editor'), {
    pdf: () => E.pdf, count: () => E.pages.length, current: currentPage,
    jump: i => { const p = E.pages[i]; if (p) sc.scrollTop = Math.max(0, p.el.offsetTop - 12); $('page-chip').textContent = `${i + 1} / ${E.pages.length}`; },
    done: () => { rerenderVisible(); updPageChip(); },
  });
  sc.addEventListener('scroll', () => { updPageChip(); if (E.sel) placeSelMenu(); if (E.tsel && tbar?.classList.contains('show')) placeTselBar(); }, { passive: true });
  sc.addEventListener('contextmenu', e => { if (E.mode === 'view') e.preventDefault(); });
  // Pinch-Zoom
  let pinch = null;
  sc.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      cancelGesture();
      const [a, b] = e.touches; const r = sc.getBoundingClientRect();
      pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: E.zoom, cx: (a.clientX + b.clientX) / 2 - r.left, cy: (a.clientY + b.clientY) / 2 - r.top };
    }
  }, { passive: true });
  sc.addEventListener('touchmove', e => {
    if (G && G.type === 'tsel') { e.preventDefault(); return; }   // Auswahl ziehen statt scrollen
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      setZoom(pinch.z * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d, pinch.cx, pinch.cy);
    }
  }, { passive: false });
  sc.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; });
  // Doppeltipp-Zoom im Ansehen-Modus
  let lastTap = 0;
  sc.addEventListener('click', e => {
    if (E.mode !== 'view') return;
    const now = Date.now();
    if (now - lastTap < 300) { const r = sc.getBoundingClientRect(); setZoom(E.zoom > 1.2 ? 1 : 2, e.clientX - r.left, e.clientY - r.top); lastTap = 0; }
    else lastTap = now;
  });

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-action]')?.dataset.action; if (!a || !E.open) return;
    if (a === 'ed-back') closeEditor();
    if (a === 'ed-mode') modeSheet();
    if (a === 'ed-more') moreSheet();
    if (a === 'ed-toc') { haptic(); tocSheet(); }
    if (a === 'ed-scrub') { haptic(); if (!toggleScrubber() && E.pages.length < 2) toast('Das PDF hat nur eine Seite'); }
    if (a === 'ed-options') optionsSheet();
    if (a === 'undo') undo();
    if (a === 'redo') redo();
    if (a === 'zoom-in') setZoom(Math.round((E.zoom + 0.25) * 4) / 4);
    if (a === 'zoom-out') setZoom(Math.round((E.zoom - 0.25) * 4) / 4);
  });
  window.addEventListener('resize', () => {
    if (!E.open) return;
    const maxW = Math.max(...E.infos.map(i => i.w));
    E.base = Math.max(0.2, (sc.clientWidth - 24) / maxW); layoutPages(); E.pages.forEach((_, i) => renderLayer(i)); rerenderVisible();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && E.open) saveNow(); });
}
