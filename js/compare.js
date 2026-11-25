// ================= PDFs vergleichen (visueller Diff) =================
// Zwei PDFs wählen (A = Original, B = neue Version) und Seite für Seite vergleichen:
//  • Nebeneinander  • Überlagerung (Schieberegler A ↔ B)  • Unterschiede (Pixel-Diff)
// Beide Seiten werden mit pdf.js auf dieselbe Breite gerendert. Abweichende Pixel:
// Koralle = neu in B, Blau = nur in A (entfernt). Geänderte Stellen bekommen einen Rahmen.
// Im Hintergrund werden alle Seiten grob verglichen → Liste der Seiten mit Änderungen.
import { icon } from './icons.js';
import { toast, busy, sheet, esc, haptic, pickFiles, fmtDate } from './ui.js';
import { loadPdf, closePdf } from './pdfcore.js';

const CORAL = [255, 106, 91], BLUE = [47, 128, 237];
const TOL = 44;            // Farbabstand, ab dem ein Pixel als „anders“ gilt (0–255)

// ---------- Auswahl der zwei Dateien ----------
export async function compareSheet(ctx) {
  const docs = await ctx.allDocs();
  const pick = [];               // [idA, idB]
  sheet({
    title: 'PDFs vergleichen',
    html: `<p style="color:var(--text2);margin:0 2px 12px;font-size:14px;line-height:1.4">Tippe zuerst das <b style="color:var(--text)">Original (A)</b>, dann die <b style="color:var(--text)">neue Version (B)</b> an.</p>
      <div class="menu" data-list style="margin-bottom:12px"></div>
      <div class="btn-row"><button class="btn" data-imp>${icon('filePlus')} Importieren</button><button class="btn primary" data-ok disabled>${icon('compare')} Vergleichen</button></div>`,
    onMount(el, api) {
      const list = el.querySelector('[data-list]'), ok = el.querySelector('[data-ok]');
      const render = () => {
        list.innerHTML = docs.length ? docs.map(d => {
          const n = pick.indexOf(d.id);
          return `<button class="row" data-id="${d.id}"><span class="row-ic ${n === 0 ? 'c-blue' : n === 1 ? 'c-orange' : 'c-gray'}" style="font-weight:800;font-size:15px">${n >= 0 ? 'AB'[n] : icon('file')}</span><span class="row-main"><span class="row-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span><span class="row-sub">${d.pages || 1} Seiten · ${fmtDate(d.updated)}</span></span></button>`;
        }).join('') : `<div class="empty" style="border:0">Noch keine PDFs vorhanden – importiere zwei Dateien.</div>`;
        list.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
          const k = pick.indexOf(b.dataset.id);
          if (k >= 0) pick.splice(k, 1); else { if (pick.length === 2) pick.pop(); pick.push(b.dataset.id); }
          haptic(); render();
        });
        ok.disabled = pick.length !== 2;
      };
      el.querySelector('[data-imp]').onclick = async () => {
        const files = await pickFiles('file-pdf'); if (!files.length) return;
        busy(true, 'Import …');
        for (const f of files) {
          try { const id = await ctx.importFile(f); if (id) { if (pick.length === 2) pick.shift(); pick.push(id); } } catch {}
          busy(true, 'Import …');
        }
        docs.splice(0, docs.length, ...(await ctx.allDocs())); busy(false); render(); ctx.renderRecents();
      };
      ok.onclick = () => {
        if (pick.length !== 2) return;
        api.close();
        const [a, b] = pick.map(id => docs.find(d => d.id === id));
        compareView(a, b, ctx);
      };
      render();
    },
  });
}

// ---------- Rendern & Diff ----------
async function renderPage(pdf, no, width) {
  const p = await pdf.getPage(no);
  const v1 = p.getViewport({ scale: 1 });
  const vp = p.getViewport({ scale: width / v1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(width); c.height = Math.max(1, Math.round(vp.height));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await p.render({ canvasContext: g, viewport: vp }).promise;
  return c;
}

function blank(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  return c;
}

// Beide Seiten auf dieselbe Größe bringen (weiß auffüllen)
function pixels(c, w, h) {
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const g = t.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  if (c) g.drawImage(c, 0, 0);
  const d = g.getImageData(0, 0, w, h).data;
  t.width = t.height = 0;
  return d;
}

/** Pixel-Diff zweier Canvas gleicher Breite → { canvas, ratio, boxes } (canvas nur wenn draw) */
export function diffCanvases(ca, cb, { draw = true, cell = 0 } = {}) {
  const w = Math.max(ca?.width || 0, cb?.width || 0), h = Math.max(ca?.height || 0, cb?.height || 0);
  const A = pixels(ca, w, h), B = pixels(cb, w, h);
  const out = draw ? new ImageData(w, h) : null, O = out?.data;
  const cs = cell || Math.max(6, Math.round(w / 90));       // Raster für Markierungsrahmen
  const gw = Math.ceil(w / cs), gh = Math.ceil(h / cs), grid = new Uint8Array(gw * gh);
  let diff = 0, ink = 0;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const ar = A[i], ag = A[i + 1], ab = A[i + 2], br = B[i], bg = B[i + 1], bb = B[i + 2];
      const la = (ar * 77 + ag * 150 + ab * 29) >> 8, lb = (br * 77 + bg * 150 + bb * 29) >> 8;
      if (la < 235 || lb < 235) ink++;
      const d = Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb));
      if (d > TOL) {
        diff++; grid[((y / cs) | 0) * gw + ((x / cs) | 0)] = 1;
        if (O) { const col = lb <= la ? CORAL : BLUE; O[i] = col[0]; O[i + 1] = col[1]; O[i + 2] = col[2]; O[i + 3] = 255; }
      } else if (O) {
        // Unveränderter Inhalt blass im Hintergrund
        const l = 255 - ((255 - Math.min(la, lb)) * 0.22);
        O[i] = O[i + 1] = O[i + 2] = l; O[i + 3] = 255;
      }
    }
  }
  // Zusammenhängende Zellen (mit 1 Zelle Abstand) zu Rahmen bündeln
  const boxes = [], seen = new Uint8Array(gw * gh);
  for (let s = 0; s < grid.length; s++) {
    if (!grid[s] || seen[s]) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    const st = [s]; seen[s] = 1;
    while (st.length) {
      const k = st.pop(), gx = k % gw, gy = (k / gw) | 0; n++;
      if (gx < x0) x0 = gx; if (gx > x1) x1 = gx; if (gy < y0) y0 = gy; if (gy > y1) y1 = gy;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = gx + dx, ny = gy + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const q = ny * gw + nx; if (grid[q] && !seen[q]) { seen[q] = 1; st.push(q); }
      }
    }
    boxes.push({ x: x0 * cs, y: y0 * cs, w: (x1 - x0 + 1) * cs, h: (y1 - y0 + 1) * cs, n });
  }
  const ratio = diff / Math.max(1, ink || w * h);
  if (!draw) return { ratio, diff, boxes };
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.putImageData(out, 0, 0);
  const pad = Math.max(4, w / 200);
  g.lineWidth = Math.max(2, w / 360); g.strokeStyle = 'rgba(255,106,91,.95)'; g.fillStyle = 'rgba(255,106,91,.07)';
  for (const b of boxes) {
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad), bw = Math.min(w - x, b.w + pad * 2), bh = Math.min(h - y, b.h + pad * 2);
    g.beginPath(); g.roundRect ? g.roundRect(x, y, bw, bh, pad) : g.rect(x, y, bw, bh); g.fill(); g.stroke();
  }
  return { canvas: c, ratio, diff, boxes };
}

const pct = r => r <= 0 ? '0 %' : r < 0.001 ? '< 0,1 %' : (Math.min(100, r * 100)).toFixed(r < 0.1 ? 1 : 0).replace('.', ',') + ' %';

// ---------- Vergleichsansicht ----------
async function compareView(da, db_, ctx) {
  busy(true, 'PDFs werden geladen …');
  let pa, pb;
  try {
    const [ba, bb] = await Promise.all([ctx.docBytes(da), ctx.docBytes(db_)]);
    [pa, pb] = await Promise.all([loadPdf(ba), loadPdf(bb)]);
  } catch (e) {
    console.error(e); busy(false); closePdf(pa); closePdf(pb);
    return toast('PDF konnte nicht geladen werden', true);
  }
  busy(false);
  const N = Math.max(pa.numPages, pb.numPages);
  const nameA = da.name.replace(/\.pdf$/i, ''), nameB = db_.name.replace(/\.pdf$/i, '');
  const S = { page: 0, mode: 'diff', mix: 0.5, zoom: 1, gen: 0, scan: new Array(N).fill(null), alive: true, cache: null };

  const el = document.createElement('div'); el.className = 'idp cmp';
  el.innerHTML = `
    <div class="mg-head"><button class="icon-btn" data-x aria-label="Zurück">${icon('chevronLeft')}</button><div class="mg-title">Vergleichen</div><button class="icon-btn" data-swap aria-label="A und B tauschen">${icon('swap')}</button></div>
    <div class="cmp-names"><span class="cmp-tag a">A</span><span class="cmp-n">${esc(nameA)}</span><span class="cmp-tag b">B</span><span class="cmp-n">${esc(nameB)}</span></div>
    <div class="cmp-modes"><div class="seg" data-mode>
      <button data-v="side">Nebeneinander</button><button data-v="overlay">Überlagerung</button><button data-v="diff" class="on">Unterschiede</button></div></div>
    <div class="cmp-stage" data-stage><div class="cmp-inner" data-inner></div></div>
    <div class="cmp-extra" data-extra></div>
    <div class="cmp-pages" data-pages><span class="cmp-scan">${icon('search')} Seiten werden verglichen …</span></div>
    <div class="idp-bar cmp-bar">
      <button class="icon-btn" data-prev aria-label="Vorherige Seite">${icon('chevronLeft')}</button>
      <span><b data-pno>1 / ${N}</b><small data-pinfo>&nbsp;</small></span>
      <button class="icon-btn" data-next aria-label="Nächste Seite">${icon('chevronRight')}</button>
    </div>`;
  document.body.appendChild(el);
  const $ = s => el.querySelector(s);
  const stage = $('[data-stage]'), inner = $('[data-inner]');

  const close = () => {
    S.alive = false; S.gen++;
    el.classList.add('out'); setTimeout(() => el.remove(), 220);
    freeCache(); closePdf(pa); closePdf(pb);
  };
  const freeCache = () => { if (S.cache) { for (const k of ['a', 'b', 'd']) if (S.cache[k]) S.cache[k].width = S.cache[k].height = 0; S.cache = null; } };
  $('[data-x]').onclick = () => { haptic(); close(); };

  // Renderbreite: Bühnenbreite × Pixeldichte (begrenzt, damit iOS-Canvas-Limits halten)
  const renderW = () => Math.min(1600, Math.round(Math.max(320, stage.clientWidth - 24) * Math.min(2.5, devicePixelRatio || 1)));

  async function load(i) {
    if (S.cache?.i === i && S.cache.w === renderW()) return S.cache;
    freeCache();
    const w = renderW();
    const [a, b] = await Promise.all([
      i < pa.numPages ? renderPage(pa, i + 1, w) : null,
      i < pb.numPages ? renderPage(pb, i + 1, w) : null,
    ]);
    const h = Math.max(a?.height || 0, b?.height || 0) || Math.round(w * 1.414);
    S.cache = { i, w, a: a || blank(w, h), b: b || blank(w, h), onlyA: !b, onlyB: !a, d: null, info: null };
    return S.cache;
  }

  const fitCanvas = (c, cls = '') => { c.className = 'cmp-cv ' + cls; return c; };

  async function show() {
    const gen = ++S.gen, i = S.page;
    $('[data-pno]').textContent = `Seite ${i + 1} / ${N}`;
    $('[data-prev]').disabled = i <= 0; $('[data-next]').disabled = i >= N - 1;
    inner.classList.add('loading');
    let C;
    try { C = await load(i); } catch (e) { console.error(e); if (gen === S.gen) { inner.classList.remove('loading'); toast('Seite konnte nicht gezeichnet werden', true); } return; }
    if (gen !== S.gen || !S.alive) return;
    if (!C.info) { const r = diffCanvases(C.a, C.b, { draw: true }); C.d = r.canvas; C.info = r; S.scan[i] = { ratio: r.ratio, boxes: r.boxes.length, only: C.onlyA ? 'A' : C.onlyB ? 'B' : '' }; paintPages(); }
    inner.classList.remove('loading');
    inner.innerHTML = '';
    inner.className = 'cmp-inner m-' + S.mode;
    inner.style.width = S.zoom * 100 + '%';
    const extra = $('[data-extra]');
    if (S.mode === 'side') {
      const mk = (c, t, cls) => { const f = document.createElement('figure'); f.className = 'cmp-fig ' + cls; f.innerHTML = `<figcaption><span class="cmp-tag ${cls}">${t}</span></figcaption>`; f.prepend(fitCanvas(c)); return f; };
      inner.append(mk(C.a, 'A', 'a'), mk(C.b, 'B', 'b'));
      extra.innerHTML = '';
    } else if (S.mode === 'overlay') {
      const wrap = document.createElement('div'); wrap.className = 'cmp-ov';
      const ca = fitCanvas(C.a), cb = fitCanvas(C.b, 'top');
      cb.style.opacity = S.mix;
      wrap.append(ca, cb); inner.append(wrap);
      extra.innerHTML = `<div class="cmp-mix"><span class="cmp-tag a">A</span><input type="range" class="range" min="0" max="1" step="0.01" value="${S.mix}" data-mix><span class="cmp-tag b">B</span><button class="cmp-blink" data-blink>Blinken</button></div>`;
      const r = extra.querySelector('[data-mix]');
      r.oninput = () => { S.mix = +r.value; cb.style.opacity = S.mix; };
      let blinkT = null;
      extra.querySelector('[data-blink]').onclick = e => {
        haptic();
        if (blinkT) { clearInterval(blinkT); blinkT = null; e.target.classList.remove('on'); cb.style.opacity = S.mix; return; }
        e.target.classList.add('on'); let on = false;
        blinkT = setInterval(() => { if (!cb.isConnected) return clearInterval(blinkT); on = !on; cb.style.opacity = on ? 1 : 0; }, 650);
      };
    } else {
      inner.append(fitCanvas(C.d));
      extra.innerHTML = `<div class="cmp-legend"><span><i style="background:rgb(${CORAL})"></i>Neu in B</span><span><i style="background:rgb(${BLUE})"></i>Nur in A</span></div>`;
    }
    const inf = C.info;
    $('[data-pinfo]').textContent = C.onlyA ? 'Seite fehlt in B' : C.onlyB ? 'Seite fehlt in A' : !inf.diff ? 'Keine Unterschiede' : `${inf.boxes.length} ${inf.boxes.length === 1 ? 'Stelle' : 'Stellen'} geändert · ${pct(inf.ratio)}`;
    $('[data-pinfo]').className = !inf.diff && !C.onlyA && !C.onlyB ? 'same' : 'chg';
  }

  // Leiste der Seiten mit Änderungen
  function paintPages() {
    const box = $('[data-pages]');
    const done = S.scan.every(Boolean);
    const chg = S.scan.map((s, i) => s && (s.ratio > 0 || s.only) ? i : -1).filter(i => i >= 0);
    if (!done && !chg.length) return;
    if (done && !chg.length) { box.innerHTML = `<span class="cmp-same">${icon('check')} Alle ${N} Seiten sind gleich</span>`; return; }
    box.innerHTML = `<span class="cmp-lbl">${done ? `Änderungen auf ${chg.length} von ${N} Seiten` : 'Änderungen:'}</span>` + chg.map(i => {
      const s = S.scan[i];
      return `<button class="cmp-chip ${i === S.page ? 'on' : ''}" data-go="${i}">S. ${i + 1}<small>${s.only ? 'nur ' + s.only : pct(s.ratio)}</small></button>`;
    }).join('') + (done ? '' : `<span class="cmp-scan sm">…</span>`);
    box.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { haptic(); go(+b.dataset.go); });
    box.querySelector('.cmp-chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  // Hintergrund: alle Seiten grob vergleichen (kleine Auflösung)
  async function scanAll() {
    const gen0 = S.scanGen = (S.scanGen || 0) + 1;
    for (let i = 0; i < N; i++) {
      if (!S.alive || S.scanGen !== gen0) return;
      if (S.scan[i]) continue;
      try {
        const w = 420;
        const [a, b] = await Promise.all([i < pa.numPages ? renderPage(pa, i + 1, w) : null, i < pb.numPages ? renderPage(pb, i + 1, w) : null]);
        if (!S.alive || S.scanGen !== gen0) return;
        if (!S.scan[i]) {
          const r = diffCanvases(a, b, { draw: false });
          S.scan[i] = { ratio: r.ratio, boxes: r.boxes.length, only: !b ? 'A' : !a ? 'B' : '' };
        }
        if (a) a.width = a.height = 0; if (b) b.width = b.height = 0;
      } catch (e) { console.warn(e); S.scan[i] = { ratio: 0, boxes: 0, only: '' }; }
      paintPages();
      await new Promise(r => setTimeout(r, 0));
    }
    paintPages();
  }

  const go = i => { if (i < 0 || i >= N || i === S.page) return; S.page = i; show().then(paintPages); stage.scrollTo({ top: 0, left: 0 }); };
  $('[data-prev]').onclick = () => { haptic(); go(S.page - 1); };
  $('[data-next]').onclick = () => { haptic(); go(S.page + 1); };
  el.querySelectorAll('[data-mode] button').forEach(b => b.onclick = () => {
    if (S.mode === b.dataset.v) return;
    el.querySelectorAll('[data-mode] button').forEach(x => x.classList.toggle('on', x === b));
    S.mode = b.dataset.v; haptic(); show();
  });
  $('[data-swap]').onclick = () => {
    haptic();
    [pa, pb] = [pb, pa];
    const [na, nb] = el.querySelectorAll('.cmp-names .cmp-n'); [na.textContent, nb.textContent] = [nb.textContent, na.textContent];
    S.scan = S.scan.map(s => s && { ...s, only: s.only === 'A' ? 'B' : s.only === 'B' ? 'A' : '' });
    freeCache(); show().then(paintPages); scanAll();
  };

  // Wischen links/rechts = Seite wechseln (nur ohne Zoom), Doppeltipp = Zoom
  let sx = null, sy = 0, lastTap = 0, multi = false;
  stage.addEventListener('touchstart', e => { multi = e.touches.length > 1; if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (sx == null || multi || S.zoom > 1) { sx = null; return; }
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy; sx = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) { haptic(); go(S.page + (dx < 0 ? 1 : -1)); }
  }, { passive: true });
  stage.addEventListener('click', e => {
    const now = Date.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      const r = stage.getBoundingClientRect(), fx = (stage.scrollLeft + e.clientX - r.left) / inner.scrollWidth, fy = (stage.scrollTop + e.clientY - r.top) / inner.scrollHeight;
      S.zoom = S.zoom > 1 ? 1 : 2.2; inner.style.width = S.zoom * 100 + '%'; haptic();
      requestAnimationFrame(() => { stage.scrollLeft = fx * inner.scrollWidth - r.width / 2; stage.scrollTop = fy * inner.scrollHeight - r.height / 2; });
    } else lastTap = now;
  });

  await show();
  paintPages();
  scanAll();
}
