// ================= Nibvion Editor =================
import { db, uid } from './db.js';
import { icon, hydrateIcons } from './icons.js';
import { sheet, toast, busy, confirmDlg, promptDlg, esc, pickFiles, today, haptic } from './ui.js';
import { pdfjsLib, loadPdf, closePdf, pageInfos, flatten, pagesOp, renderThumb, inkPath, normalizeImage, TEXT_ASC, LINE_H } from './pdfcore.js';
import { makeSymbol } from './sign.js';
import { signatureSheet, stampSheet, freshStamp } from './assets.js';
import { settings } from './settings.js';

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
export async function openEditor(docId, mode = 'view', onClose) {
  busy(true, 'PDF wird geladen …');
  try {
    const meta = await db.get('docs', docId);
    const file = await db.get('files', docId);
    if (!meta || !file) throw new Error('Datei nicht gefunden');
    E.doc = meta; E.bytes = file.data; E.objects = meta.objects || [];
    E.undo = []; E.redo = []; E.sel = null; E.zoom = 1; E.onClose = onClose; E.dirtyThumb = false;
    await loadDocument();
    document.body.classList.add('in-editor');
    $('editor').classList.add('open'); $('editor').setAttribute('aria-hidden', 'false');
    E.open = true;
    setMode(mode === 'pages' ? 'view' : mode, true);
    if (mode === 'pages') pageManager();
    meta.opened = Date.now(); db.put('docs', meta);
  } catch (err) {
    console.error(err); toast('PDF konnte nicht geöffnet werden', true);
  } finally { busy(false); }
}

async function loadDocument() {
  if (E.pdf) closePdf(E.pdf);
  E.pdf = await loadPdf(E.bytes);
  E.infos = await pageInfos(E.pdf);
  E.text = {};
  buildPages();
}

async function closeEditor() {
  await saveNow();
  if (E.dirtyThumb) await updateThumb();
  E.open = false;
  $('editor').classList.remove('open'); $('editor').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('in-editor');
  hideSelMenu();
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
  const sc = $('ed-scroll');
  const maxW = Math.max(...E.infos.map(i => i.w));
  E.base = Math.max(0.2, (sc.clientWidth - 24) / maxW);
  io?.disconnect();
  io = new IntersectionObserver(entries => {
    entries.forEach(en => {
      const i = +en.target.dataset.i;
      if (en.isIntersecting) renderPage(i); else freePage(i);
    });
  }, { root: sc, rootMargin: '900px 0px' });
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

async function renderPage(i) {
  const p = E.pages[i], info = E.infos[i]; if (!p || !E.pdf) return;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  let rs = scale() * dpr;
  const maxPx = 9e6;
  if (info.w * info.h * rs * rs > maxPx) rs = Math.sqrt(maxPx / (info.w * info.h));
  if (Math.abs(p.rs - rs) < 0.01) return;
  p.task?.cancel?.();
  try {
    const page = await E.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: rs });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    p.task = page.render({ canvasContext: ctx, viewport: vp });
    await p.task.promise;
    p.task = null;
    const old = p.canvas; p.el.replaceChild(c, old);
    old.width = old.height = 0;
    p.canvas = c; p.rs = rs;
    p.el.querySelector('.ph')?.remove();
  } catch (err) { if (err?.name !== 'RenderingCancelledException') console.warn(err); }
}
function freePage(i) {
  const p = E.pages[i]; if (!p || !p.rs) return;
  // Nur weit entfernte Seiten freigeben
  const r = p.el.getBoundingClientRect(), sr = $('ed-scroll').getBoundingClientRect();
  if (r.bottom < sr.top - 2500 || r.top > sr.bottom + 2500) { p.canvas.width = p.canvas.height = 0; p.rs = 0; }
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
function updPageChip() { $('page-chip').textContent = `${currentPage() + 1} / ${E.pages.length}`; }

// ======================= Modus & Werkzeuge =======================
function setMode(mode, first) {
  E.mode = mode; E.tool = DEFAULT_TOOL[mode];
  $('mode-label').textContent = MODES[mode].label;
  E.sel = null; hideSelMenu();
  renderToolbar();
  if (mode === 'edit' || mode === 'comment') E.pages.forEach((_, i) => loadText(i));
  E.pages.forEach((_, i) => renderLayer(i));
  if (!first) haptic();
  showToolHint();
}
function setTool(id) {
  const t = MODES[E.mode].tools.find(x => x.id === id);
  if (t.kind === 'action') return runAction(id);
  E.tool = (E.tool === id && id !== 'select' && E.mode !== 'edit') ? 'select' : id;
  E.sel = null; hideSelMenu();
  renderToolbar();
  E.pages.forEach((_, i) => renderLayer(i));
  showToolHint(); haptic();
}
function renderToolbar() {
  const tools = MODES[E.mode].tools;
  $('ed-toolbar').classList.toggle('hidden', !tools.length);
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
      let bold = false;
      try { const f = page.commonObjs.has(it.fontName) && page.commonObjs.get(it.fontName); bold = /bold|black|heavy|semibold|demi/i.test(f?.name || ''); } catch {}
      const w = it.width; if (w < 0.5) return;
      items.push({ key: `${i}:${k}`, str: it.str, x: tx[4], base: tx[5], top: tx[5] - fh * asc, h: fh * (asc - desc), w, size: fh, bold });
    });
    return items;
  })();
  const items = await E.text[i];
  E.text[i] = items;
  renderLayer(i);
  return items;
}
const textItems = i => Array.isArray(E.text[i]) ? E.text[i] : [];

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
    let best = null, bd = -1;
    for (let yy = 1; yy < h - 1; yy += 1) for (let xx = 1; xx < w - 1; xx += 1) {
      const c = px(xx, yy); const dd = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
      if (dd > bd) { bd = dd; best = c; }
    }
    const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
    out.bg = hex(bg); if (best && bd > 60) out.fg = hex(best);
  } catch {}
  return out;
}

// ======================= Objekte =======================
const mctx = document.createElement('canvas').getContext('2d');
function measure(o) {
  if (o.type !== 'text') return o;
  mctx.font = `${o.bold ? '700' : '400'} ${o.size}px Helvetica, Arial, sans-serif`;
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

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  parent && parent.appendChild(n);
  return n;
}

function drawObj(o, parent) {
  const g = el('g', { class: 'obj', 'data-id': o.id }, parent);
  switch (o.type) {
    case 'text': {
      if (o.cover) el('rect', { x: o.cover.x, y: o.cover.y, width: o.cover.w, height: o.cover.h, fill: o.cover.color }, g);
      if (o.bg) el('rect', { x: o.x - 4, y: o.y - 3, width: o.w + 8, height: o.h + 6, rx: 2, fill: o.bg, stroke: '#e3c34a', 'stroke-width': 0.6 }, g);
      el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: 'transparent' }, g);
      const t = el('text', { 'font-family': 'Helvetica, Arial, sans-serif', 'font-size': o.size, 'font-weight': o.bold ? 700 : 400, fill: o.color, style: 'white-space:pre' }, g);
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
      const d = inkPath(o.points);
      el('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(o.width, 12 / scale()), 'stroke-linecap': 'round' }, g);
      el('path', { d, fill: 'none', stroke: o.color, 'stroke-width': o.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': o.opacity ?? 1, style: (o.opacity ?? 1) < 1 ? 'mix-blend-mode:multiply' : null }, g);
      break;
    }
  }
  return g;
}

function renderLayer(i) {
  const p = E.pages[i]; if (!p) return;
  const svg = p.svg; svg.textContent = '';
  if (E.mode === 'edit' && E.tool === 'textedit') {
    const replaced = new Set(E.objects.filter(o => o.srcKey).map(o => o.srcKey));
    textItems(i).forEach(t => { if (!replaced.has(t.key)) el('rect', { class: 'titem', x: t.x - 0.5, y: t.top - 0.5, width: t.w + 1, height: t.h + 1, rx: 0.8, 'data-key': t.key }, svg); });
  }
  E.objects.filter(o => o.page === i).forEach(o => drawObj(o, svg));
  const s = E.sel && byId(E.sel);
  if (s && s.page === i) {
    const b = bbox(s), pad = 4 / scale(), r = 9 / scale();
    el('rect', { class: 'selbox', x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, rx: 3 / scale() }, svg);
    el('circle', { class: 'handle', cx: b.x + b.w + pad, cy: b.y + b.h + pad, r, 'data-handle': 1 }, svg);
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
  const k = kind(); if (k === 'none') return;
  const [x, y] = svgPt(e, i);
  const target = e.target;
  const svg = E.pages[i].svg;
  const begin = (g) => { G = { ...g, page: i, pid: e.pointerId, sx: x, sy: y, moved: false }; try { svg.setPointerCapture(e.pointerId); } catch {} };

  if (target.dataset?.handle && E.sel) {
    const o = byId(E.sel); snapshot();
    return begin({ type: 'resize', obj: o, orig: JSON.parse(JSON.stringify(o)), b: bbox(o) });
  }
  if (k === 'ink') {
    snapshot();
    const isM = E.tool === 'marker';
    const o = { id: uid(), type: 'ink', page: i, points: [[x, y]], color: settings.get(isM ? 'markerColor' : 'penColor'), width: settings.get(isM ? 'markerWidth' : 'penWidth'), opacity: isM ? 0.45 : 1 };
    E.objects.push(o);
    const g = drawObj(o, svg);
    e.preventDefault();
    return begin({ type: 'ink', obj: o, paths: g.querySelectorAll('path') });
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
      break;
    }
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
  }
}

function onUp(e) {
  activePointers.delete(e.pointerId);
  if (!G || e.pointerId !== G.pid) return;
  const g = G; G = null;
  switch (g.type) {
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
    case 'tap': if (!g.moved) g.fn(); break;
  }
}
function cancelGesture() {
  if (!G) return;
  const g = G; G = null;
  if (g.type === 'ink') { E.objects = E.objects.filter(o => o !== g.obj); E.undo.pop(); renderLayer(g.page); }
  if (g.type === 'drag') g.draft.remove();
  if (g.type === 'erase') g.dot.remove();
  if (g.type === 'move' && g.snap) { Object.assign(g.obj, g.orig); E.undo.pop(); renderLayer(g.page); }
}
window.addEventListener('pointermove', onMove, { passive: false });
window.addEventListener('pointerup', onUp);
window.addEventListener('pointercancel', e => { activePointers.delete(e.pointerId); if (G && G.pid === e.pointerId) { if (G.type === 'tap') G = null; else onUp(e); } });

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
function eraseAt(i, x, y) {
  const r = 10 / scale();
  const before = E.objects.length;
  E.objects = E.objects.filter(o => !(o.page === i && o.type === 'ink' && o.points.some(([px, py]) => Math.hypot(px - x, py - y) < r + o.width / 2)));
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
  const b = bbox(o), svg = E.pages[o.page].svg, ctm = svg.getScreenCTM();
  const p = new DOMPoint(b.x + b.w / 2, b.y).matrixTransform(ctm);
  const er = $('editor').getBoundingClientRect();
  const acts = [];
  if (o.type === 'text') acts.push(['edit', 'Bearbeiten', 'rename']);
  if (o.type !== 'ink') acts.push(['dup', 'Duplizieren', 'copy']);
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
function addCentered(base) {
  const i = currentPage(); const [cx, cy] = visibleCenter(i);
  const info = E.infos[i];
  let w = base.w, h = base.h;
  const maxW = info.w * 0.6; if (w > maxW) { h *= maxW / w; w = maxW; }
  snapshot();
  const o = { id: uid(), page: i, type: 'image', ...base, w, h, x: cx - w / 2, y: cy - h / 2 };
  E.objects.push(o); E.dirtyThumb = true;
  if (E.tool !== 'select') { E.tool = 'select'; renderToolbar(); }
  select(o.id); changed([i]); haptic();
  hint('Verschieben oder an der Ecke skalieren');
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
  const it = textItems(i).find(t => t.key === key); if (!it) return;
  const ex = E.objects.find(o => o.srcKey === key);
  if (ex) { select(ex.id); return openTextEditor(ex, false); }
  const cols = sampleColors(i, { x: it.x, y: it.top, w: it.w, h: it.h });
  const size = Math.round(it.size * 10) / 10;
  snapshot();
  const o = measure({
    id: uid(), type: 'text', page: i, srcKey: key, x: it.x, y: it.base - size * TEXT_ASC, size, bold: it.bold,
    color: cols.fg, text: it.str.replace(/\s+$/, ''),
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
        <div class="colors" style="flex:1;justify-content:flex-end;flex-wrap:nowrap;gap:7px">${TEXT_COLORS.slice(0, 5).map(c => `<button class="color ${c === o.color ? 'on' : ''}" data-c="${c}" style="background:${c};width:28px;height:28px;flex:none"></button>`).join('')}</div>
      </div>
      <div class="btn-row"><button class="btn danger" data-del style="flex:0 0 auto;width:56px">${icon('trash')}</button><button class="btn primary" data-ok>${icon('check')} Fertig</button></div>`,
    onMount(el, api) {
      const ta = el.querySelector('[data-t]');
      const upd = () => { measure(o); renderLayer(o.page); };
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 380);
      ta.oninput = () => { o.text = ta.value; upd(); };
      el.querySelectorAll('[data-s]').forEach(b => b.onclick = () => {
        o.size = Math.max(4, Math.min(120, Math.round((o.size + (+b.dataset.s) * (o.size < 14 ? 0.5 : 1)) * 2) / 2));
        el.querySelector('[data-sz]').textContent = fmtSz(o.size); upd();
      });
      el.querySelector('[data-b]').onclick = e => { o.bold = !o.bold; e.currentTarget.classList.toggle('on', o.bold); upd(); };
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
    pen: { title: 'Stift', key: 'penColor', cols: PEN_COLORS, w: 'penWidth', min: 0.5, max: 8, step: 0.5 },
    marker: { title: 'Marker', key: 'markerColor', cols: HL_COLORS, w: 'markerWidth', min: 4, max: 30, step: 1 },
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
      ${cfg.size ? `<div class="lbl">Schriftgröße <span data-wv>${settings.get('textSize')}</span> pt</div><input type="range" class="range" min="6" max="36" step="0.5" value="${settings.get('textSize')}" data-sz>` : ''}`,
    onMount(el) {
      el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { el.querySelectorAll('[data-c]').forEach(x => x.classList.remove('on')); b.classList.add('on'); settings.set(cfg.key, b.dataset.c); });
      const w = el.querySelector('[data-w]'); if (w) w.oninput = () => { settings.set(cfg.w, +w.value); el.querySelector('[data-wv]').textContent = w.value; };
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
  if (id === 'stamp') stampSheet(a => { const st = freshStamp(a); const W = a.image ? 130 : st.w * 0.55; addCentered({ src: st.src, w: W, h: W * st.h / st.w, opacity: a.image ? 1 : 0.95 }); });
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
      <div class="menu-grid" style="margin-bottom:16px">
        <button data-a="share"><span class="qt-ic c-blue">${icon('share')}</span>Teilen</button>
        <button data-a="download"><span class="qt-ic c-green">${icon('download')}</span>Sichern</button>
        <button data-a="pages"><span class="qt-ic c-violet">${icon('pages')}</span>Seiten</button>
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
            const n = await promptDlg('Umbenennen', E.doc.name.replace(/\.pdf$/i, ''));
            if (n) { E.doc.name = n + '.pdf'; await saveNow(); toast('Umbenannt'); }
          }
          if (a === 'delete') {
            if (await confirmDlg('PDF löschen?', `„${E.doc.name}“ wird von diesem Gerät gelöscht.`)) {
              await db.del('docs', E.doc.id); await db.del('files', E.doc.id);
              E.doc = null; E.dirtyThumb = false; closeEditor(); toast('Gelöscht');
            }
          }
        } catch (err) { console.error(err); busy(false); toast('Das hat nicht geklappt', true); }
      });
    },
  });
}

// ======================= Seiten verwalten =======================
async function pageManager() {
  let order = E.infos.map((_, i) => ({ i, rot: 0 }));
  const thumbs = [];
  for (let i = 0; i < E.infos.length; i++) thumbs[i] = await renderThumb(E.pdf, i + 1, 180);
  let blank = false;
  sheet({
    title: 'Seiten verwalten',
    html: `<div class="page-grid" data-grid></div>
      <div class="btn-row"><button class="btn" data-blank>${icon('plus')} Leere Seite</button><button class="btn primary" data-ok>${icon('check')} Übernehmen</button></div>`,
    onMount(el, api) {
      const grid = el.querySelector('[data-grid]');
      const render = () => {
        grid.innerHTML = order.map((p, k) => `
          <div class="pg"><div class="pg-img" style="background-image:url(${thumbs[p.i]});transform:rotate(${p.rot}deg)"></div>
          <div class="pg-n">${k + 1}</div>
          <div class="pg-acts"><button data-l="${k}" ${k ? '' : 'disabled style="opacity:.3"'}>${icon('chevronLeft')}</button><button data-r="${k}">${icon('rotate')}</button><button data-d="${k}">${icon('trash')}</button></div></div>`).join('')
          + (blank ? `<div class="pg"><div class="pg-img"></div><div class="pg-n">Neu</div></div>` : '');
        grid.querySelectorAll('[data-l]').forEach(b => b.onclick = () => { const k = +b.dataset.l; if (!k) return; [order[k - 1], order[k]] = [order[k], order[k - 1]]; render(); });
        grid.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { order[+b.dataset.r].rot = (order[+b.dataset.r].rot + 90) % 360; render(); });
        grid.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { if (order.length <= 1) return toast('Mindestens eine Seite muss bleiben', true); order.splice(+b.dataset.d, 1); render(); });
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
  sc.addEventListener('scroll', () => { updPageChip(); if (E.sel) placeSelMenu(); }, { passive: true });
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
