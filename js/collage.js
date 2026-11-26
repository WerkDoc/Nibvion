// ================= Foto-Collage & Magazin-Layout (Bilder → Magazin-PDF) =================
// Mehrere Fotos → Seiten im Layout „Vollbild“, „2×2“, „Titel + 2“, „3er-Streifen“ oder „Polaroid“.
// Einstellbar: Abstand, Abrundung, Hintergrund (Weiß/Anthrazit/Creme), Bildunterschriften.
// Vorschau (Canvas) und PDF (pdf-lib) zeichnen aus derselben Seitenbeschreibung → was du siehst,
// kommt so ins PDF. Fotos werden je Feld passend zugeschnitten und als JPEG (≈ 300 DPI) eingebettet;
// Bildunterschriften sind echter, durchsuchbarer Text.

import { icon } from './icons.js';
import { sheet, toast, busy, haptic, pickFiles, promptDlg, today, loadImage } from './ui.js';

const L = () => window.PDFLib;
const A4 = [595.28, 841.89];
export const BGS = { white: { label: 'Weiß', c: '#ffffff', ink: '#2b2f38' }, anth: { label: 'Anthrazit', c: '#2a2d34', ink: '#f2f2f2' }, cream: { label: 'Creme', c: '#f5eee0', ink: '#4a4237' } };
export const LAYOUTS = [
  { id: 'single', label: 'Vollbild', per: 1 },
  { id: 'grid', label: '2 × 2', per: 4 },
  { id: 'hero', label: 'Titel + 2', per: 3 },
  { id: 'strip', label: '3er-Streifen', per: 3 },
  { id: 'polaroid', label: 'Polaroid', per: 4 },
];
const POLA_ROT = [-2.6, 2.1, 1.5, -2.2];
const SHADOW = [[1.2, 0.05], [2.4, 0.045], [3.8, 0.04], [5.4, 0.03]];   // [Ausdehnung pt, Deckkraft]

// ---------- Seitenaufbau (reine Geometrie, gemeinsam für Vorschau und PDF) ----------
function slots(layout, k, b, g) {
  const R = (x, y, w, h) => ({ x, y, w, h });
  if (k <= 1) return [R(b.x, b.y, b.w, b.h)];
  if (layout === 'strip' || k === 2) {
    const h = (b.h - g * (k - 1)) / k;
    return Array.from({ length: k }, (_, i) => R(b.x, b.y + i * (h + g), b.w, h));
  }
  if (layout === 'hero' || (layout === 'grid' && k === 3)) {
    const th = (b.h - g) * 0.6, bh = b.h - g - th, w2 = (b.w - g) / 2;
    return [R(b.x, b.y, b.w, th), R(b.x, b.y + th + g, w2, bh), R(b.x + w2 + g, b.y + th + g, w2, bh)];
  }
  const w2 = (b.w - g) / 2, h2 = (b.h - g) / 2;          // 2×2 (auch Polaroid mit 3–4)
  return [R(b.x, b.y, w2, h2), R(b.x + w2 + g, b.y, w2, h2), R(b.x, b.y + h2 + g, w2, h2), R(b.x + w2 + g, b.y + h2 + g, w2, h2)].slice(0, k);
}

/** photos: [{ w, h, caption }] · opt: { layout, gap, radius, bg, captions } → Seiten [{ W, H, bg, els }] */
export function buildPages(photos, opt) {
  const lay = LAYOUTS.find(l => l.id === opt.layout) || LAYOUTS[1];
  const bg = BGS[opt.bg] || BGS.white, g = opt.gap, r = opt.radius, pages = [];
  for (let s = 0; s < photos.length; s += lay.per) {
    const idx = photos.slice(s, s + lay.per).map((_, j) => s + j);
    let [W, H] = A4;
    if (lay.id === 'single') { const p = photos[idx[0]]; if (p.w > p.h * 1.05) [W, H] = [H, W]; }   // Querformat-Foto → Querformat-Seite
    const m = lay.id === 'polaroid' ? Math.max(g, 18) : g;
    const box = { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
    const els = [];
    if (lay.id === 'polaroid') {
      slots('grid', idx.length, box, Math.max(g, 10)).forEach((c, j) => {
        const k = idx[j], cap = opt.captions;
        // Rahmen: quadratisches Foto, schmale Ränder, breiter unterer Rand (Platz für Unterschrift)
        const side = 0.065, top = 0.065, bottom = cap ? 0.28 : 0.2;
        const p = Math.min(c.w * 0.9 / (1 + 2 * side), c.h * 0.9 / (1 + top + bottom));
        const fw = p * (1 + 2 * side), fh = p * (1 + top + bottom);
        const cx = c.x + c.w / 2, cy = c.y + c.h / 2, rot = POLA_ROT[(k) % 4];
        const fr = Math.min(r, 4) * 0.5;
        const at = (dx, dy) => { const a = rot * Math.PI / 180; return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)]; };
        els.push({ t: 'shadow', cx, cy: cy + 2.2, w: fw, h: fh, r: fr, rot });
        els.push({ t: 'rect', cx, cy, w: fw, h: fh, r: fr, rot, fill: '#ffffff' });
        const [ix, iy] = at(0, -fh / 2 + p * top + p / 2);
        els.push({ t: 'img', k, cx: ix, cy: iy, w: p, h: p, r: 0, rot });
        if (cap && photos[k].caption) {
          const [tx, ty] = at(0, fh / 2 - p * bottom / 2 + p * 0.005);
          els.push({ t: 'text', s: photos[k].caption, cx: tx, cy: ty, size: Math.max(7, Math.min(15, p * 0.075)), maxW: p * 0.96, rot, color: '#33363d' });
        }
      });
    } else {
      slots(lay.id, idx.length, box, g).forEach((c, j) => {
        const rr = Math.min(r, c.w / 2, c.h / 2);
        els.push({ t: 'img', k: idx[j], cx: c.x + c.w / 2, cy: c.y + c.h / 2, w: c.w, h: c.h, r: g === 0 && lay.id === 'single' ? 0 : rr, rot: 0 });
      });
    }
    pages.push({ W, H, bg: bg.c, els });
  }
  return pages;
}

// Ausschnitt (object-fit: cover, mittig) des Fotos für ein Feld w×h
function coverCrop(iw, ih, w, h) {
  const a = w / h;
  if (iw / ih > a) { const sw = ih * a; return [(iw - sw) / 2, 0, sw, ih]; }
  const sh = iw / a; return [0, (ih - sh) / 2, iw, sh];
}
function rrPath(ctx, w, h, r) {
  const x = -w / 2, y = -h / 2; r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}
const svgRR = (w, h, r) => {
  const x = -w / 2, y = -h / 2, k = 0.5523; r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r < 0.01) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  return `M${x + r} ${y}H${x + w - r}C${x + w - r + r * k} ${y} ${x + w} ${y + r - r * k} ${x + w} ${y + r}V${y + h - r}C${x + w} ${y + h - r + r * k} ${x + w - r + r * k} ${y + h} ${x + w - r} ${y + h}H${x + r}C${x + r - r * k} ${y + h} ${x} ${y + h - r + r * k} ${x} ${y + h - r}V${y + r}C${x} ${y + r - r * k} ${x + r - r * k} ${y} ${x + r} ${y}Z`;
};
// Bildunterschrift auf Breite kürzen (gleiche Zeichenkette für Vorschau und PDF)
const mctx = document.createElement('canvas').getContext('2d');
const CAP_FONT = s => `500 ${s}px Helvetica, Arial, sans-serif`;
function fitText(s, size, maxW) {
  mctx.font = CAP_FONT(size);
  if (mctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && mctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

/** Vorschau einer Seite auf ein Canvas (k = Skalierung pt → px) */
export function drawPage(ctx, pg, k, imgs) {
  ctx.save(); ctx.scale(k, k);
  ctx.fillStyle = pg.bg; ctx.fillRect(0, 0, pg.W, pg.H);
  for (const e of pg.els) {
    ctx.save(); ctx.translate(e.cx, e.cy); ctx.rotate((e.rot || 0) * Math.PI / 180);
    if (e.t === 'shadow') { for (const [d, o] of SHADOW) { ctx.fillStyle = `rgba(0,0,0,${o})`; rrPath(ctx, e.w + 2 * d, e.h + 2 * d, e.r + d); ctx.fill(); } }
    else if (e.t === 'rect') { ctx.fillStyle = e.fill; rrPath(ctx, e.w, e.h, e.r); ctx.fill(); }
    else if (e.t === 'img') {
      const im = imgs[e.k]; rrPath(ctx, e.w, e.h, e.r); ctx.clip();
      if (im) { const [sx, sy, sw, sh] = coverCrop(im.width, im.height, e.w, e.h); ctx.drawImage(im, sx, sy, sw, sh, -e.w / 2, -e.h / 2, e.w, e.h); }
      else { ctx.fillStyle = '#ccc'; ctx.fill(); }
    } else if (e.t === 'text') {
      ctx.font = CAP_FONT(e.size); ctx.fillStyle = e.color; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(fitText(e.s, e.size, e.maxW), 0, e.size * 0.35);
    }
    ctx.restore();
  }
  ctx.restore();
}

/** PDF erzeugen. loadFull(k) → Promise<HTMLImageElement|Canvas> (Original in voller Größe) */
export async function buildPdf(pages, loadFull, { dpi = 300, onProgress } = {}) {
  const P = L();
  const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, moveTo, lineTo, appendBezierCurve, closePath, clip, endPath } = P;
  const doc = await PDFDocument.create();
  doc.setTitle(`Collage ${today()}`); doc.setProducer('Nibvion'); doc.setCreator('Nibvion');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const chars = new Set(font.getCharacterSet());
  const hex = h => { const n = parseInt(h.slice(1), 16); return rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); };
  const total = pages.reduce((s, p) => s + p.els.filter(e => e.t === 'img').length, 0);
  let done = 0;
  for (const pg of pages) {
    const page = doc.addPage([pg.W, pg.H]);
    page.drawRectangle({ x: 0, y: 0, width: pg.W, height: pg.H, color: hex(pg.bg) });
    for (const e of pg.els) {
      const a = -(e.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, e.cx, pg.H - e.cy), concatTransformationMatrix(c, s, -s, c, 0, 0));
      if (e.t === 'shadow') for (const [d, o] of SHADOW) page.drawSvgPath(svgRR(e.w + 2 * d, e.h + 2 * d, e.r + d), { x: 0, y: 0, color: rgb(0, 0, 0), opacity: o });
      else if (e.t === 'rect') page.drawSvgPath(svgRR(e.w, e.h, e.r), { x: 0, y: 0, color: hex(e.fill) });
      else if (e.t === 'img') {
        const src = await loadFull(e.k);
        const [sx, sy, sw, sh] = coverCrop(src.width, src.height, e.w, e.h);
        const scale = Math.min(1, (e.w / 72 * dpi) / sw);
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(sw * scale)); cv.height = Math.max(1, Math.round(sh * scale));
        const cx = cv.getContext('2d'); cx.imageSmoothingQuality = 'high';
        cx.drawImage(src, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        const jpg = await new Promise((res, rej) => cv.toBlob(b => b ? b.arrayBuffer().then(x => res(new Uint8Array(x)), rej) : rej(new Error('JPEG')), 'image/jpeg', 0.9));
        cv.width = cv.height = 1;
        const img = await doc.embedJpg(jpg);
        // abgerundeter Zuschnitt als Clip-Pfad (lokale Koordinaten, y nach oben)
        const w = e.w, h = e.h, x = -w / 2, y = -h / 2, r = Math.max(0, Math.min(e.r, w / 2, h / 2)), q = r * 0.5523;
        if (r > 0.01) page.pushOperators(
          moveTo(x + r, y), lineTo(x + w - r, y), appendBezierCurve(x + w - r + q, y, x + w, y + r - q, x + w, y + r),
          lineTo(x + w, y + h - r), appendBezierCurve(x + w, y + h - r + q, x + w - r + q, y + h, x + w - r, y + h),
          lineTo(x + r, y + h), appendBezierCurve(x + r - q, y + h, x, y + h - r + q, x, y + h - r),
          lineTo(x, y + r), appendBezierCurve(x, y + r - q, x + r - q, y, x + r, y), closePath(), clip(), endPath());
        page.drawImage(img, { x, y, width: w, height: h });
        onProgress?.(++done, total);
      } else if (e.t === 'text') {
        const str = [...fitText(e.s, e.size, e.maxW)].map(ch => chars.has(ch.codePointAt(0)) ? ch : (ch === '…' ? '...' : '?')).join('');
        const tw = font.widthOfTextAtSize(str, e.size);
        page.drawText(str, { x: -tw / 2, y: -e.size * 0.35, size: e.size, font, color: hex(e.color) });
      }
      page.pushOperators(popGraphicsState());
    }
  }
  return doc.save();
}

// ======================= Oberfläche =======================
const LAYOUT_ICON = {
  single: '<rect x="5" y="3" width="14" height="18" rx="1.5"/>',
  grid: '<rect x="4" y="3" width="7" height="8.5" rx="1"/><rect x="13" y="3" width="7" height="8.5" rx="1"/><rect x="4" y="12.5" width="7" height="8.5" rx="1"/><rect x="13" y="12.5" width="7" height="8.5" rx="1"/>',
  hero: '<rect x="4" y="3" width="16" height="10" rx="1"/><rect x="4" y="14.5" width="7.2" height="6.5" rx="1"/><rect x="12.8" y="14.5" width="7.2" height="6.5" rx="1"/>',
  strip: '<rect x="4" y="3" width="16" height="5.2" rx="1"/><rect x="4" y="9.4" width="16" height="5.2" rx="1"/><rect x="4" y="15.8" width="16" height="5.2" rx="1"/>',
  polaroid: '<g transform="rotate(-6 8 8)"><rect x="3" y="3" width="9" height="11" rx=".6"/><rect x="4.2" y="4.2" width="6.6" height="6.6"/></g><g transform="rotate(5 16 15)"><rect x="11.5" y="9.5" width="9" height="11" rx=".6"/><rect x="12.7" y="10.7" width="6.6" height="6.6"/></g>',
};
const lIcon = id => `<svg viewBox="0 0 24 24" class="ico" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${LAYOUT_ICON[id]}</svg>`;

async function loadPhotos(files) {
  const out = [];
  for (const f of files) {
    const url = URL.createObjectURL(f);
    try {
      const img = await loadImage(url);
      const w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, 1000 / Math.max(w, h));
      const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      out.push({ file: f, w, h, prev: c, caption: '' });
    } catch {} finally { URL.revokeObjectURL(url); }
    await new Promise(r => setTimeout(r, 0));
  }
  return out;
}

// ctx (aus app.js): { saveNewDoc, renderRecents, openDoc }
export async function collageSheet(_d, ctx) {
  const fs = await pickFiles('file-img'); if (!fs.length) return;
  busy(true, 'Fotos werden geladen …');
  let photos = await loadPhotos(fs);
  busy(false);
  if (!photos.length) return toast('Fotos konnten nicht geladen werden', true);
  const st = { layout: photos.length === 1 ? 'single' : photos.length === 3 ? 'hero' : 'grid', gap: 14, radius: 8, bg: 'white', captions: true };
  let pages = [], raf = 0;

  sheet({
    title: 'Foto-Collage',
    html: `<div class="cl-prev no-swipe" data-prev></div>
      <div class="cl-count" data-count></div>
      <div class="lbl" style="margin-top:6px">Layout</div>
      <div class="cl-lays" data-lays>${LAYOUTS.map(l => `<button class="cl-lay" data-l="${l.id}">${lIcon(l.id)}<span>${l.label}</span></button>`).join('')}</div>
      <div class="lbl">Abstand <span data-gv></span></div>
      <input type="range" class="range" min="0" max="40" step="1" data-gap>
      <div class="lbl">Abrundung <span data-rv></span></div>
      <input type="range" class="range" min="0" max="24" step="1" data-rad>
      <div class="lbl">Hintergrund</div>
      <div class="cl-bgs" data-bgs>${Object.entries(BGS).map(([k, b]) => `<button class="cl-bg" data-b="${k}"><span style="background:${b.c}"></span>${b.label}</button>`).join('')}</div>
      <div class="row cl-caprow" data-caprow style="padding:14px 2px 2px;border:0"><span class="row-main"><span class="row-title">Bildunterschriften</span><span class="row-sub" style="display:block">Tippe in der Vorschau auf ein Foto, um den Text zu ändern</span></span>
        <div class="seg" data-cap><button data-v="1">An</button><button data-v="0">Aus</button></div></div>
      <div class="btn-row"><button class="btn" data-add>${icon('plus')} Fotos</button><button class="btn primary" data-ok>${icon('filePlus')} PDF erstellen</button></div>`,
    onClose: () => { cancelAnimationFrame(raf); photos.forEach(p => { p.prev.width = p.prev.height = 1; }); },
    onMount(el, api) {
      const prev = el.querySelector('[data-prev]');
      const gap = el.querySelector('[data-gap]'), rad = el.querySelector('[data-rad]');
      gap.value = st.gap; rad.value = st.radius;

      const sync = () => {
        el.querySelectorAll('[data-l]').forEach(b => b.classList.toggle('on', b.dataset.l === st.layout));
        el.querySelectorAll('[data-b]').forEach(b => b.classList.toggle('on', b.dataset.b === st.bg));
        el.querySelectorAll('[data-cap] button').forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === st.captions));
        el.querySelector('[data-caprow]').hidden = st.layout !== 'polaroid';
        el.querySelector('[data-gv]').textContent = `${st.gap} pt`;
        el.querySelector('[data-rv]').textContent = `${st.radius} pt`;
      };
      // Vorschau: Seiten-Canvas wiederverwenden, nur neu zeichnen (rAF, max. 1× pro Frame)
      const render = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          pages = buildPages(photos.map(p => ({ w: p.w, h: p.h, caption: p.caption })), st);
          const dpr = Math.min(2, devicePixelRatio || 1);
          while (prev.children.length > pages.length) prev.lastChild.remove();
          pages.forEach((pg, i) => {
            let cv = prev.children[i];
            if (!cv) { cv = document.createElement('canvas'); cv.className = 'cl-page'; prev.appendChild(cv); }
            const hPx = 236, k = hPx / pg.H;
            const w = Math.round(pg.W * k * dpr), h = Math.round(hPx * dpr);
            if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
            cv.style.width = `${Math.round(pg.W * k)}px`; cv.style.height = `${hPx}px`; cv.dataset.i = i;
            drawPage(cv.getContext('2d'), pg, k * dpr, photos.map(p => p.prev));
          });
          el.querySelector('[data-count]').textContent = `${photos.length} ${photos.length === 1 ? 'Foto' : 'Fotos'} · ${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'} · A4`;
        });
      };
      sync(); render();

      el.querySelector('[data-lays]').onclick = e => { const b = e.target.closest('[data-l]'); if (!b) return; st.layout = b.dataset.l; haptic(); sync(); render(); };
      el.querySelector('[data-bgs]').onclick = e => { const b = e.target.closest('[data-b]'); if (!b) return; st.bg = b.dataset.b; haptic(); sync(); render(); };
      el.querySelectorAll('[data-cap] button').forEach(b => b.onclick = () => { st.captions = b.dataset.v === '1'; haptic(); sync(); render(); });
      gap.oninput = () => { st.gap = +gap.value; sync(); render(); };
      rad.oninput = () => { st.radius = +rad.value; sync(); render(); };

      // Antippen in der Vorschau: Bildunterschrift (Polaroid) bearbeiten
      prev.addEventListener('click', async e => {
        const cv = e.target.closest('.cl-page'); if (!cv || st.layout !== 'polaroid' || !st.captions) return;
        const pg = pages[+cv.dataset.i], r = cv.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width * pg.W, y = (e.clientY - r.top) / r.height * pg.H;
        const hit = pg.els.filter(q => q.t === 'rect').find(q => Math.abs(x - q.cx) < q.w / 2 && Math.abs(y - q.cy) < q.h / 2);
        if (!hit) return;
        const img = pg.els.find(q => q.t === 'img' && Math.hypot(q.cx - hit.cx, q.cy - hit.cy) < hit.h / 2);
        if (!img) return;
        haptic();
        const v = await promptDlg('Bildunterschrift', photos[img.k].caption, 'Übernehmen', 'z. B. Sommer 2026 am See');
        if (v == null) return;
        photos[img.k].caption = v.trim().slice(0, 80); render();
      });

      el.querySelector('[data-add]').onclick = async () => {
        const more = await pickFiles('file-img'); if (!more.length) return;
        busy(true, 'Fotos werden geladen …'); photos = photos.concat(await loadPhotos(more)); busy(false);
        render(); requestAnimationFrame(() => prev.scrollTo({ left: prev.scrollWidth, behavior: 'smooth' }));
      };

      el.querySelector('[data-ok]').onclick = async () => {
        haptic();
        busy(true, 'Collage wird erstellt …');
        try {
          let cache = null;
          const loadFull = async k => {
            if (cache?.k === k) return cache.img;
            const url = URL.createObjectURL(photos[k].file);
            try { const img = await loadImage(url); cache = { k, img }; return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
          };
          const bytes = await buildPdf(pages, loadFull, { onProgress: (a, b) => busy(true, `Collage wird erstellt … ${a}/${b}`) });
          const id = await ctx.saveNewDoc(bytes, `Collage ${today()}.pdf`);
          busy(false); api.close();
          await ctx.renderRecents(); toast('Collage-PDF erstellt'); ctx.openDoc(id);
        } catch (err) { console.error(err); busy(false); toast('Collage konnte nicht erstellt werden', true); }
      };
    },
  });
}
