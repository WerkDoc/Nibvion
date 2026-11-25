// ================= Ausweis-Editor: Menü „Seiten“ (wie CamScanner) =================
// • Seiten neu anordnen (halten + ziehen, auswählen, löschen)
// • Kollagen: Raster-Vorlagen (2×1 … 3×3, 8×1, 1×8) und Ausweis-Vorlagen in Originalgröße,
//   Bild antippen → verschieben, zoomen (zwei Finger), drehen, tauschen; Wasserzeichen, Seitengröße
// • Seitentitel: Namen je Seite (Anzeige, Dateinamen beim Teilen)
// Layout liegt in meta.idLayout = { tpl, size, wm }, Anpassungen je Seite in side.col = { z, dx, dy, r }.
import { icon } from './icons.js';
import { toast, sheet, confirmDlg, promptDlg, esc, haptic, ROT_MS, easeInOut, reducedMotion } from './ui.js';
import { rotateCanvas } from './scanner.js';
import { settings } from './settings.js';

export const PAGE_SIZES = { a4: [210, 297, 'A4'], a5: [148, 210, 'A5'], letter: [215.9, 279.4, 'Letter'] };
export const GRID_TPLS = ['2x1', '1x2', '1x3', '3x1', '1x4', '4x1', '2x2', '2x3', '3x2', '3x3', '8x1', '1x8'];
export const ID_TPLS = [['driver', 'Führerschein', 85.6, 54], ['passport', 'Reisepass', 125, 88], ['idcard', 'ID-Karte', 85.6, 54]];
const isId = tpl => ID_TPLS.some(t => t[0] === tpl);
export const defaultTpl = (catId, idSize) => idSize === 'orig' ? (catId === 'passport' ? 'passport' : catId === 'driver' ? 'driver' : 'idcard') : '2x1';
const NOADJ = { z: 1, dx: 0, dy: 0, r: 0 };
export const adjOf = side => ({ ...NOADJ, ...(side?.col || {}) });

// ---------- Layout berechnen (mm) ----------
export function layoutPages(layout, n) {
  const [W, H] = PAGE_SIZES[layout.size] || PAGE_SIZES.a4;
  const pages = [];
  if (isId(layout.tpl)) {
    const [, , cw, ch] = ID_TPLS.find(t => t[0] === layout.tpl);
    const gap = 14, top = Math.max(12, Math.min(45, (H - 2 * ch - gap) / 2));
    for (let i = 0; i < Math.max(1, n); i += 2) {
      const cells = [];
      for (let j = 0; j < 2; j++) cells.push({ x: (W - cw) / 2, y: top + j * (ch + gap), w: cw, h: ch, rad: layout.tpl === 'passport' ? 2 : 3.2, idx: i + j });
      pages.push({ W, H, cells });
    }
    return pages;
  }
  const [R, C] = layout.tpl.split('x').map(Number), M = 12, G = 6;
  const cw = (W - 2 * M - (C - 1) * G) / C, ch = (H - 2 * M - (R - 1) * G) / R, per = R * C;
  for (let i = 0; i < Math.max(1, n); i += per) {
    const cells = [];
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) cells.push({ x: M + c * (cw + G), y: M + r * (ch + G), w: cw, h: ch, rad: 0, idx: i + r * C + c });
    pages.push({ W, H, cells });
  }
  return pages;
}

export function drawWatermark(x, W, H, txt) {
  if (!txt) return;
  const fs = Math.round(W / 18);
  x.save(); x.font = `700 ${fs}px -apple-system, Helvetica, Arial, sans-serif`; x.fillStyle = 'rgba(90,90,90,.3)';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.translate(W / 2, H / 2); x.rotate(-24 * Math.PI / 180);
  const tw = x.measureText(txt).width + fs * 2.2, D = Math.hypot(W, H);
  let row = 0;
  for (let yy = -D / 2; yy <= D / 2; yy += fs * 2.6, row++) for (let xx = -D / 2 + (row % 2 ? tw / 2 : 0); xx <= D / 2; xx += tw) x.fillText(txt, xx, yy);
  x.restore();
}

// Bild in eine Zelle zeichnen: einpassen, dann Zoom/Verschieben/Drehen
const rotCache = new WeakMap();
function rotated(img, r) {
  if (!r) return img;
  let m = rotCache.get(img); if (!m) rotCache.set(img, m = {});
  return m[r] ||= rotateCanvas(img, r);
}
function drawCell(x, img, a, cx, cy, cw, ch, rad, border) {
  const im = rotated(img, a.r || 0);
  let s = Math.min(cw / im.width, ch / im.height) * (a.z || 1);
  const w = im.width * s, h = im.height * s;
  x.save(); x.beginPath(); x.roundRect ? x.roundRect(cx, cy, cw, ch, rad) : x.rect(cx, cy, cw, ch); x.clip();
  x.imageSmoothingQuality = 'high';
  if (a.ra) {
    // Dreh-Animation: a.ra läuft von −90° auf 0°, Größe gleitet von alter zu neuer Einpassung
    const t = 1 + a.ra / 90, s0 = Math.min(cw / im.height, ch / im.width) * (a.z || 1), k = (s0 + (s - s0) * t) / s;
    x.translate(cx + cw / 2 + (a.dx || 0) * cw, cy + ch / 2 + (a.dy || 0) * ch); x.rotate(a.ra * Math.PI / 180); x.scale(k, k);
    x.drawImage(im, -w / 2, -h / 2, w, h);
  } else x.drawImage(im, cx + (cw - w) / 2 + (a.dx || 0) * cw, cy + (ch - h) / 2 + (a.dy || 0) * ch, w, h);
  x.restore();
  if (border) { x.strokeStyle = 'rgba(0,0,0,.12)'; x.lineWidth = Math.max(1, cw / 400); x.beginPath(); x.roundRect ? x.roundRect(cx, cy, cw, ch, rad) : x.rect(cx, cy, cw, ch); x.stroke(); }
}

/** Seiten als Canvas (pxPerMm: 10 ≈ 254 dpi fürs PDF). */
export function renderLayout(imgs, adjs, layout, pxPerMm = 10, pages = layoutPages(layout, imgs.length)) {
  return pages.map(p => {
    const c = document.createElement('canvas'); c.width = Math.round(p.W * pxPerMm); c.height = Math.round(p.H * pxPerMm);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    for (const cell of p.cells) {
      const img = imgs[cell.idx]; if (!img) continue;
      drawCell(x, img, adjs[cell.idx] || NOADJ, cell.x * pxPerMm, cell.y * pxPerMm, cell.w * pxPerMm, cell.h * pxPerMm, cell.rad * pxPerMm, isId(layout.tpl));
    }
    drawWatermark(x, c.width, c.height, layout.wm);
    return c;
  });
}

// ---------- Tipp-Einblendung (einmalig) ----------
export function showTip(key, title, text, anchor) {
  const k = 'tip_' + key;
  if (settings.get(k)) return Promise.resolve();
  return new Promise(res => {
    const el = document.createElement('div'); el.className = 'idp-tip' + (anchor ? ' has-hole' : '');
    // Text über bzw. unter dem hervorgehobenen Bereich
    const pos = !anchor ? '' : anchor.top > innerHeight / 2 ? `position:fixed;left:24px;right:24px;margin:auto;bottom:${innerHeight - anchor.top + 28}px` : `position:fixed;left:24px;right:24px;margin:auto;top:${anchor.top + anchor.height + 28}px`;
    el.innerHTML = `${anchor ? `<div class="idp-tip-hole" style="left:${anchor.left}px;top:${anchor.top}px;width:${anchor.width}px;height:${anchor.height}px"></div>` : ''}
      <div class="idp-tip-box" style="${pos}"><b>${esc(title)}</b><p>${esc(text)}</p><button>Verstanden</button></div>`;
    document.body.appendChild(el);
    el.querySelector('button').onclick = () => { settings.set(k, 1); haptic(); el.classList.add('out'); setTimeout(() => el.remove(), 200); res(); };
  });
}

// ---------- Seiten neu anordnen ----------
/** items: [{ src (dataURL), title }] → { order: [alte Indizes in neuer Reihenfolge] } oder null */
export function reorderPages(items) {
  return new Promise(resolve => {
    let order = items.map((_, i) => i), sel = new Set();
    const el = document.createElement('div'); el.className = 'idp';
    el.innerHTML = `
      <div class="idp-head"><button class="link-btn danger" data-del hidden>${icon('trash')} Löschen</button><div class="idp-count"></div><button class="link-btn" data-all>Alles auswählen</button></div>
      <div class="idp-info">${icon('info')} Halten und ziehen, um neu anzuordnen</div>
      <div class="idp-grid"></div>
      <div class="idp-bar"><button class="icon-btn" data-x aria-label="Abbrechen">${icon('x')}</button><span>Seiten neu anordnen</span><button class="icon-btn" data-ok aria-label="Übernehmen">${icon('check')}</button></div>`;
    document.body.appendChild(el);
    const grid = el.querySelector('.idp-grid');
    const paint = () => {
      grid.innerHTML = order.map((oi, j) => `<div class="idp-cell${sel.has(oi) ? ' sel' : ''}" data-o="${oi}">
        <div class="idp-th"><img src="${items[oi].src}" alt="" draggable="false"><span class="idp-ck">${icon('check')}</span></div>
        <div class="idp-num">${j + 1}</div>${items[oi].title ? `<div class="idp-ttl">${esc(items[oi].title)}</div>` : ''}</div>`).join('');
      el.querySelector('.idp-count').textContent = sel.size ? `${sel.size} ausgewählt` : `${order.length} Seite${order.length === 1 ? '' : 'n'}`;
      el.querySelector('[data-all]').textContent = sel.size === order.length ? 'Auswahl aufheben' : 'Alles auswählen';
      el.querySelector('[data-del]').hidden = !sel.size;
      grid.querySelectorAll('.idp-cell').forEach(c => c.onpointerdown = e => press(e, c));
    };
    // Tippen = auswählen, halten (0,35 s) = ziehen
    const press = (e, cell) => {
      const oi = +cell.dataset.o, x0 = e.clientX, y0 = e.clientY;
      let drag = false, ghost = null, moved = false;
      const timer = setTimeout(() => {
        drag = true; haptic();
        const r = cell.getBoundingClientRect();
        ghost = cell.cloneNode(true); ghost.classList.add('idp-ghost');
        Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
        document.body.appendChild(ghost); cell.classList.add('ph');
        ghost._dx = x0 - r.left; ghost._dy = y0 - r.top;
      }, 350);
      const mv = ev => {
        if (!drag) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) { clearTimeout(timer); moved = true; } return; }
        ev.preventDefault();
        ghost.style.left = ev.clientX - ghost._dx + 'px'; ghost.style.top = ev.clientY - ghost._dy + 'px';
        const over = document.elementsFromPoint(ev.clientX, ev.clientY).find(n => n.classList?.contains('idp-cell') && n !== cell && !n.classList.contains('idp-ghost'));
        if (over) {
          const a = order.indexOf(oi), b = order.indexOf(+over.dataset.o);
          order.splice(a, 1); order.splice(b, 0, oi); haptic();
          const cells = [...grid.children], target = cells[b];
          if (a < b) target.after(cell); else target.before(cell);
          [...grid.children].forEach((c, j) => c.querySelector('.idp-num').textContent = j + 1);
        }
      };
      const up = () => {
        clearTimeout(timer);
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
        if (drag) { ghost.remove(); paint(); return; }
        if (!moved) { sel.has(oi) ? sel.delete(oi) : sel.add(oi); haptic(); paint(); }
      };
      addEventListener('pointermove', mv, { passive: false }); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    };
    const close = v => { el.classList.add('out'); setTimeout(() => el.remove(), 220); resolve(v); };
    el.querySelector('[data-all]').onclick = () => { sel = sel.size === order.length ? new Set() : new Set(order); haptic(); paint(); };
    el.querySelector('[data-del]').onclick = async () => {
      if (sel.size >= order.length) return toast('Mindestens eine Seite muss bleiben', true);
      if (!await confirmDlg(`${sel.size} Seite${sel.size === 1 ? '' : 'n'} löschen?`, 'Die Seite wird beim Speichern aus dem Ausweis entfernt.', 'Löschen')) return;
      order = order.filter(o => !sel.has(o)); sel.clear(); paint();
    };
    el.querySelector('[data-x]').onclick = () => close(null);
    el.querySelector('[data-ok]').onclick = () => close({ order });
    paint();
  });
}

// ---------- Seitentitel ----------
export function titlesSheet(items, defName) {
  return new Promise(resolve => {
    let out = null;
    sheet({
      title: 'Seitentitel',
      html: `<p class="cloud-note" style="margin-top:0">Der Titel erscheint in der Ansicht und als Dateiname, wenn du eine Seite als Bild teilst.</p>
        ${items.map((it, i) => `<label class="idp-trow"><img src="${it.src}" alt=""><input class="field" data-t="${i}" value="${esc(it.title || '')}" placeholder="${esc(defName(i))}" autocomplete="off"></label>`).join('')}
        <button class="btn primary" data-ok style="margin-top:6px">${icon('check')} Übernehmen</button>`,
      onMount(el, api) {
        el.querySelector('[data-ok]').onclick = () => { out = items.map((_, i) => el.querySelector(`[data-t="${i}"]`).value.trim()); api.close(); };
      },
      onClose: () => resolve(out),
    });
  });
}

// ---------- Kollagen ----------
const tplIcon = tpl => {
  if (isId(tpl)) {
    const p = tpl === 'passport';
    return `<svg viewBox="0 0 40 48"><rect x="4" y="3" width="32" height="42" rx="2" class="pg"/>
      <rect x="9" y="${p ? 7 : 8}" width="22" height="${p ? 15 : 13}" rx="1.5" class="fl"/><rect x="9" y="${p ? 26 : 25}" width="22" height="${p ? 15 : 13}" rx="1.5" class="fl"/>
      <path d="M12 ${p ? 12 : 12}h9M12 ${p ? 16 : 16}h7M12 ${p ? 31 : 30}h9M12 ${p ? 35 : 34}h6" class="ln"/><circle cx="26" cy="${p ? 14 : 13.5}" r="2.4" class="dot"/></svg>`;
  }
  const [R, C] = tpl.split('x').map(Number), g = 2, w = (32 - (C - 1) * g) / C, h = (32 - (R - 1) * g) / R;
  let s = '';
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) s += `<rect x="${4 + c * (w + g)}" y="${4 + r * (h + g)}" width="${w}" height="${h}" rx="1.5"/>`;
  return `<svg viewBox="0 0 40 40">${s}</svg>`;
};

/**
 * items: [{ ref, img (Canvas, fertige Seite), adj }]
 * opts: { layout, catId, addPage: async () => ({ ref, img, adj }) | null }
 * → { layout, items } oder null
 */
export function collage(itemsIn, { layout: lay0, addPage }) {
  return new Promise(resolve => {
    let items = itemsIn.map(it => ({ ...it, adj: { ...it.adj } }));
    const layout = { ...lay0 };
    let selIdx = -1, swap = false, dirty = false;
    const el = document.createElement('div'); el.className = 'idc';
    el.innerHTML = `
      <div class="idc-head"><button class="icon-btn" data-x aria-label="Zurück">${icon('chevronLeft')}</button><div class="idc-title">Collage</div><span style="width:40px"></span></div>
      <div class="idc-scroll"></div>
      <div class="idc-selbar" hidden>
        <button data-s="rot">${icon('rotate')}<span>Drehen</span></button>
        <button data-s="swap">${icon('pages')}<span>Tauschen</span></button>
        <button data-s="reset">${icon('fit')}<span>Zurücksetzen</span></button>
        <button data-s="del">${icon('trash')}<span>Entfernen</span></button>
      </div>
      <div class="idc-tpls"><div class="idc-grip"></div>
        <div class="idc-sec">Raster</div><div class="idc-tgrid">${GRID_TPLS.map(t => `<button data-tpl="${t}">${tplIcon(t)}<span>${t.replace('x', '×')}</span></button>`).join('')}</div>
        <div class="idc-sec">Ausweis</div><div class="idc-tgrid">${ID_TPLS.map(([t, l]) => `<button data-tpl="${t}">${tplIcon(t)}<span>${l}</span></button>`).join('')}</div>
      </div>
      <div class="idc-bar">
        <button data-b="tpl" class="on">${icon('grid')}<span>Vorlagen</span></button>
        <button data-b="wm">${icon('drop')}<span>Wasserz. hinzufügen</span></button>
        <button data-b="size"><b class="idc-size"></b><span>Seitengröße</span></button>
        <button data-b="add">${icon('filePlus')}<span>Seite hinzufügen</span></button>
        <button class="idc-ok" data-ok aria-label="Übernehmen">${icon('check')}</button>
      </div>`;
    document.body.appendChild(el);
    const scroll = el.querySelector('.idc-scroll'), tplPanel = el.querySelector('.idc-tpls');
    let pages = [], canvases = [], raf = 0;

    const build = () => {
      pages = layoutPages(layout, items.length);
      scroll.innerHTML = pages.map((p, i) => `<div class="idc-page" style="aspect-ratio:${p.W}/${p.H}"><span class="idc-pno">${i + 1}/${pages.length}</span><canvas data-p="${i}"></canvas></div>`).join('');
      canvases = [...scroll.querySelectorAll('canvas')];
      fit();
      canvases.forEach(c => { c.onpointerdown = e => down(e, c); });
      el.querySelector('.idc-size').textContent = PAGE_SIZES[layout.size][2];
      el.querySelectorAll('[data-tpl]').forEach(b => b.classList.toggle('on', b.dataset.tpl === layout.tpl));
      requestAnimationFrame(draw);
    };
    const draw = () => {
      raf = 0;
      canvases.forEach((c, i) => {
        const p = pages[i], r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
        const ppm = Math.max(2, r.width * dpr / p.W);
        const [pc] = renderLayout(items.map(it => it.img), items.map(it => it.adj), layout, ppm, [p]);
        c.width = pc.width; c.height = pc.height;
        const x = c.getContext('2d'); x.drawImage(pc, 0, 0);
        for (const cell of p.cells) {
          if (cell.idx !== selIdx && !(swap && items[cell.idx])) continue;
          x.save(); x.strokeStyle = cell.idx === selIdx ? '#ff6a5b' : 'rgba(255,106,91,.5)'; x.lineWidth = 3 * dpr;
          if (swap && cell.idx !== selIdx) x.setLineDash([8 * dpr, 6 * dpr]);
          x.strokeRect(cell.x * ppm + 1, cell.y * ppm + 1, cell.w * ppm - 2, cell.h * ppm - 2); x.restore();
        }
      });
      const sb = el.querySelector('.idc-selbar');
      if (sb.hidden !== selIdx < 0) { sb.hidden = selIdx < 0; fit(); raf = requestAnimationFrame(draw); }
      el.querySelector('[data-s="swap"]').classList.toggle('on', swap);
    };
    const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };
    // Blatt so groß wie möglich, aber ganz sichtbar (Seitenverhältnis bleibt)
    const fit = () => {
      const p = pages[0]; if (!p) return;
      const w = Math.min(scroll.clientWidth - 32, 520, (scroll.clientHeight - 28) * p.W / p.H);
      scroll.querySelectorAll('.idc-page').forEach(e => { e.style.width = Math.max(120, w) + 'px'; });
    };
    const onResize = () => { fit(); redraw(); };

    // Zelle treffen
    const hit = (c, e) => {
      const p = pages[+c.dataset.p], r = c.getBoundingClientRect(), mx = (e.clientX - r.left) / r.width * p.W, my = (e.clientY - r.top) / r.height * p.H;
      return { cell: p.cells.find(q => mx >= q.x && mx <= q.x + q.w && my >= q.y && my <= q.y + q.h), p, r };
    };
    const ptrs = new Map();
    let gest = null;
    function down(e, c) {
      const { cell, p, r } = hit(c, e);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture(e.pointerId);
      if (ptrs.size === 2 && gest && gest.idx >= 0) {        // zweiter Finger: Zoom
        const [a, b] = [...ptrs.values()];
        gest.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: items[gest.idx].adj.z };
        return;
      }
      if (!cell || !items[cell.idx]) { if (selIdx >= 0 && !swap) { selIdx = -1; redraw(); } return; }
      if (swap && selIdx >= 0 && cell.idx !== selIdx) {
        [items[selIdx], items[cell.idx]] = [items[cell.idx], items[selIdx]];
        swap = false; selIdx = cell.idx; dirty = true; haptic(); toast('Getauscht'); redraw(); return;
      }
      if (selIdx !== cell.idx) { selIdx = cell.idx; swap = false; haptic(); redraw(); }
      const a = items[cell.idx].adj;
      gest = { idx: cell.idx, x0: e.clientX, y0: e.clientY, dx0: a.dx, dy0: a.dy, cw: cell.w / p.W * r.width, ch: cell.h / p.H * r.height };
      c.onpointermove = mv; c.onpointerup = c.onpointercancel = up;
    }
    function mv(e) {
      if (!gest || !ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const a = items[gest.idx].adj;
      if (gest.pinch && ptrs.size >= 2) {
        const [p1, p2] = [...ptrs.values()];
        a.z = Math.min(4, Math.max(0.3, gest.pinch.z0 * Math.hypot(p1.x - p2.x, p1.y - p2.y) / gest.pinch.d0));
      } else if (!gest.pinch) {
        a.dx = gest.dx0 + (e.clientX - gest.x0) / gest.cw; a.dy = gest.dy0 + (e.clientY - gest.y0) / gest.ch;
      }
      dirty = true; redraw();
    }
    function up(e) {
      ptrs.delete(e.pointerId);
      if (!ptrs.size) gest = null;
      else if (gest) { gest.pinch = null; const [p] = [...ptrs.values()], a = items[gest.idx].adj; Object.assign(gest, { x0: p.x, y0: p.y, dx0: a.dx, dy0: a.dy }); }
    }

    el.querySelectorAll('[data-s]').forEach(b => b.onclick = async () => {
      if (selIdx < 0) return;
      const a = items[selIdx].adj; haptic();
      if (b.dataset.s === 'rot') {
        if (a.ra) return;
        a.r = ((a.r || 0) + 90) % 360; dirty = true;
        if (!reducedMotion()) {
          const t0 = performance.now();
          const step = now => {
            const t = Math.min(1, (now - t0) / ROT_MS);
            if (t < 1) { a.ra = -90 * (1 - easeInOut(t)); requestAnimationFrame(step); } else delete a.ra;
            redraw();
          };
          a.ra = -90; requestAnimationFrame(step);
        }
      }
      if (b.dataset.s === 'reset') { Object.assign(a, NOADJ); dirty = true; }
      if (b.dataset.s === 'swap') { if (items.length < 2) return toast('Nur ein Bild vorhanden', true); swap = !swap; if (swap) toast('Jetzt das andere Bild antippen'); }
      if (b.dataset.s === 'del') {
        if (items.length < 2) return toast('Mindestens eine Seite muss bleiben', true);
        if (!await confirmDlg('Bild entfernen?', 'Die Seite wird beim Speichern aus dem Ausweis entfernt.', 'Entfernen')) return;
        items.splice(selIdx, 1); selIdx = -1; dirty = true; return build();
      }
      redraw();
    });
    el.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => { layout.tpl = b.dataset.tpl; selIdx = -1; swap = false; dirty = true; haptic(); build(); });
    el.querySelector('[data-b="tpl"]').onclick = () => { tplPanel.classList.toggle('hide'); el.querySelector('[data-b="tpl"]').classList.toggle('on', !tplPanel.classList.contains('hide')); haptic(); setTimeout(onResize, 320); };
    el.querySelector('[data-b="wm"]').onclick = async () => {
      const t = await promptDlg('Wasserzeichen', layout.wm || settings.get('idWm') || 'Nur zur Vorlage', layout.wm ? 'Speichern' : 'Hinzufügen', 'Leer lassen = kein Wasserzeichen');
      if (t == null) return;
      layout.wm = t.trim(); if (layout.wm) settings.set('idWm', layout.wm); dirty = true; redraw();
    };
    el.querySelector('[data-b="size"]').onclick = () => sheet({
      title: 'Seitengröße',
      html: `<div class="menu">${Object.entries(PAGE_SIZES).map(([k, [w, h, l]]) => `<button class="row" data-z="${k}"><span class="row-main"><span class="row-title">${l}</span><span class="row-sub">${String(w).replace('.', ',')} × ${String(h).replace('.', ',')} mm</span></span>${layout.size === k ? icon('check') : ''}</button>`).join('')}</div>`,
      onMount(s, api) { s.querySelectorAll('[data-z]').forEach(b => b.onclick = () => { layout.size = b.dataset.z; dirty = true; api.close(); build(); }); },
    });
    el.querySelector('[data-b="add"]').onclick = async () => {
      const it = await addPage?.(); if (!it) return;
      items.push(it); dirty = true; build();
      requestAnimationFrame(() => scroll.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    };
    const close = v => { removeEventListener('resize', onResize); el.classList.add('out'); setTimeout(() => el.remove(), 220); resolve(v); };
    el.querySelector('[data-x]').onclick = async () => { if (dirty && !await confirmDlg('Collage verwerfen?', 'Deine Änderungen an der Collage gehen verloren.', 'Verwerfen')) return; close(null); };
    el.querySelector('[data-ok]').onclick = () => { haptic(); items.forEach(it => delete it.adj.ra); close({ layout, items }); };
    addEventListener('resize', onResize);
    build();
    // Tipps wie bei CamScanner (je einmal)
    setTimeout(async () => {
      await showTip('collageTpl', 'Vorlage auswählen', 'Wählen Sie die benötigte Vorlage.', tplPanel.getBoundingClientRect());
      const c0 = canvases[0], cell = pages[0]?.cells[0];
      if (c0 && cell) {
        const r = c0.getBoundingClientRect(), k = r.width / pages[0].W;
        await showTip('collageMove', 'Tipps für eine Collage', 'Wählen Sie ein Bild, um es zu verschieben, zu zoomen, zu drehen oder neu anzuordnen.', { left: r.left + cell.x * k, top: r.top + cell.y * k, width: cell.w * k, height: cell.h * k });
      }
    }, 450);
  });
}
