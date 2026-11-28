// ================= Scan-Ansicht (Vollbild) =================
// Große Seitenvorschau zum Durchwischen, Filter mit Vorschau, Regler, Werkzeugleiste.
// Schließen/Herunterwischen fragt „Verwerfen / Weiter bearbeiten“.
import { icon } from './icons.js';
import { sheet, toast, busy, haptic, pickFiles, spinRotate, imgLoaded } from './ui.js';
import { render as renderScan, enhance, FILTERS, cropEditor, detectCorners, loadFileImage, FULL, NO_ADJ } from './scanner.js';
import { scanLaser, springFrames, reducedMotion } from './fx.js';
import { liveScanner, cameraSupported } from './camera.js';
import { ensureAI, edgeCut, aiPref, setAiPref, aiLoaded } from './ai.js';
import { ensureEnhance, enhReady, enhLoaded } from './aienhance.js';
import { ensureOnline, onlineDone, onlineReady, onlineMode, onlineHas, ONLINE_MODES } from './online.js';
import { settings } from './settings.js';
import { savePrefs } from './cloud.js';

const BIG = 1400;                       // Kantenlänge der großen Vorschau
const tick = () => new Promise(r => setTimeout(r, 16));

function discardDlg() {
  return new Promise(res => {
    let v = false;
    sheet({
      title: 'Scan verwerfen?',
      html: `<p style="color:var(--text2);margin:0 2px 6px;line-height:1.45">Die gescannten Seiten wurden noch nicht als PDF gespeichert.</p>
        <div class="btn-row"><button class="btn" data-k>Weiter bearbeiten</button><button class="btn danger" data-d>Verwerfen</button></div>`,
      onMount(el, api) {
        el.querySelector('[data-k]').onclick = () => api.close();
        el.querySelector('[data-d]').onclick = () => { v = true; api.close(); };
      },
      onClose: () => res(v),
    });
  });
}

/**
 * opts: { kind: 'scan'|'images', items, filter, adj, ocrOn, onSave(items, filter, adj, ocrOn), onText(items, filter, adj), onFilter(f), onOcr(v) }
 */
export function scanReview(opts) {
  const { kind } = opts;
  const items = opts.items;
  let filter = opts.filter ?? null;
  let ocrOn = !!opts.ocrOn;
  const adj = { brightness: 0, contrast: 0, sharp: 0, ...(opts.adj || {}) };   // opts.adj: gespeicherte Anpassungen („Scan bearbeiten“)
  let cur = 0, panel = 'filter', liveFailed = !!opts.liveFailed, closed = false;

  const wrap = document.createElement('div');
  wrap.className = 'rv-wrap';
  wrap.innerHTML = `
    <div class="rv-top">
      <div class="rv-grab"></div>
      <button class="rv-round" data-x aria-label="Schließen">${icon('x')}</button>
      <div class="rv-count" data-count></div>
      <button class="rv-save" data-save>${icon('check')} PDF</button>
    </div>
    <div class="rv-stage no-swipe" data-stage></div>
    <div class="rv-panel">
      <div class="rv-tabs">
        <div class="seg" data-tabs><button data-p="filter" class="on">Filter</button><button data-p="adj">Anpassen</button></div>
        <div class="rv-chips">
          <button class="rv-chip rv-chip-c" data-cmp aria-label="Vorher/Nachher">${icon('compare')}<span>Vergleich</span></button>
          <button class="rv-chip" data-ai aria-label="KI-Glätten">${icon('sparkles')}<span>KI</span></button>
          ${kind === 'scan' ? `<button class="rv-chip rv-chip-c" data-ocr aria-label="Text erkennen">${icon('textScan')}<span>Text erkennen</span></button>` : ''}
        </div>
      </div>
      <div class="flt-row no-swipe" data-flt></div>
      <div class="onl-modes" data-om><div class="onl-modes-in no-swipe" data-omr></div></div>
      <div class="rv-adj" data-adj hidden>
        ${[['brightness', 'Helligkeit', -50, 50], ['contrast', 'Kontrast', -50, 50], ['sharp', 'Schärfe', 0, 100]].map(([k, l, mn, mx]) =>
          `<div class="adj-row"><span>${l}</span><input type="range" class="range" min="${mn}" max="${mx}" step="1" value="${adj[k]}" data-a="${k}"><span data-av="${k}">${adj[k]}</span></div>`).join('')}
        <button class="link-btn" data-reset style="padding:2px">Zurücksetzen</button>
      </div>
    </div>
    <div class="rv-tools">
      <button data-t="cam">${icon('scan')}<span>Weitere</span></button>
      <button data-t="lib">${icon('images')}<span>Fotos</span></button>
      <button data-t="rot">${icon('rotate')}<span>Drehen</span></button>
      <button data-t="crop">${icon('fit')}<span>Zuschneiden</span></button>
      <button data-t="text">${icon('share')}<span>Export</span></button>
      <button data-t="del">${icon('trash')}<span>Löschen</span></button>
    </div>`;
  document.body.appendChild(wrap);
  // Passt die Zeile Filter/Anpassen + Chips nicht in die Breite, zeigen „Vergleich“ und „Text erkennen“ nur ihr Symbol
  const tabsRow = wrap.querySelector('.rv-tabs');
  const fitTabs = () => { tabsRow.classList.remove('compact'); if (tabsRow.scrollWidth > tabsRow.clientWidth + 1) tabsRow.classList.add('compact'); };
  new ResizeObserver(fitTabs).observe(tabsRow); fitTabs();
  const stage = wrap.querySelector('[data-stage]'), flt = wrap.querySelector('[data-flt]');

  // ---------- Vorschau ----------
  const aiReady = it => !!(it.ai && it._ai && it._ai.key === JSON.stringify(it.corners));
  const key = it => JSON.stringify([filter, adj, it.rot, it.corners, aiReady(it), filter === 'ai' && enhReady(it), filter === 'online' && onlineMode(it), filter === 'online' && onlineDone(it)]);
  // Filterliste: „Nibvion“ (Online-Scan) nur, wenn in den Einstellungen eingerichtet
  const FL = onlineReady() ? [FILTERS[0], FILTERS[1], ['online', 'Nibvion'], ...FILTERS.slice(2)] : FILTERS;
  const preview = it => {
    const k = key(it);
    if (it._bigKey !== k) { it._big = renderScan(it, filter, BIG, adj).toDataURL('image/jpeg', 0.85); it._bigKey = k; }
    return it._big;
  };
  const thumb = it => { const k = key(it); if (it._thKey !== k) { it._th = renderScan(it, filter, 320, adj).toDataURL('image/jpeg', 0.8); it._thKey = k; } return it._th; };

  const buildStage = () => {
    cmpUnmount?.();
    stage.innerHTML = items.map((_, i) => `<div class="rv-page" data-i="${i}"><img alt=""><div class="rv-spin"></div></div>`).join('')
      || `<div class="rv-empty">${icon('scan')}<b>Keine Seiten</b>Tippe unten auf „Weitere“ oder „Fotos“.</div>`;
    zoomReset(true);
    stage.querySelectorAll('.rv-page').forEach(p => p.onclick = e => pageTap(+p.dataset.i, e));
  };

  // ---------- Zoomen (Zwei-Finger-Zoom, Doppeltipp, Verschieben mit einem Finger) ----------
  // Nur transform auf dem Bild; solange gezoomt ist, wischt die Bühne nicht zur nächsten Seite.
  // Ab 1,6× wird die Seite in höherer Auflösung nachgeladen (sonst wird Schrift pixelig).
  const HI = 3200, ZMAX = 5;
  let Z = null;     // { pg, img, s, tx, ty }
  const zApply = (anim) => {
    if (!Z) return;
    const w = Z.img.clientWidth, h = Z.img.clientHeight;
    Z.s = Math.max(1, Math.min(ZMAX, Z.s));
    Z.tx = Math.min(0, Math.max(w - w * Z.s, Z.tx)); Z.ty = Math.min(0, Math.max(h - h * Z.s, Z.ty));
    Z.img.style.transition = anim ? 'transform .28s var(--ease), opacity .2s' : 'none';
    Z.img.style.transform = `translate3d(${Z.tx}px,${Z.ty}px,0) scale(${Z.s})`;
    const on = Z.s > 1.01;
    Z.pg.classList.toggle('zoomed', on); stage.classList.toggle('zooming', on);
  };
  const zFor = i => {
    const pg = stage.querySelector(`.rv-page[data-i="${i}"]`), img = pg && pg.querySelector('img[src]');
    if (!img) return null;
    if (!Z || Z.img !== img) { zoomReset(true); Z = { pg, img, i, s: 1, tx: 0, ty: 0 }; img.style.transformOrigin = '0 0'; }
    return Z;
  };
  function zoomReset(instant) {
    if (!Z) return;
    const z = Z; Z = null;
    z.img.style.transition = instant ? 'none' : 'transform .28s var(--ease), opacity .2s';
    z.img.style.transform = '';
    z.pg.classList.remove('zoomed'); stage.classList.remove('zooming');
    const it = items[z.i];
    if (it && z.img.dataset.hi) { delete z.img.dataset.hi; z.img.src = preview(it); }
  }
  const zoomed = () => !!(Z && Z.s > 1.01);
  let hiT;
  const hiRes = () => {
    clearTimeout(hiT);
    hiT = setTimeout(() => {
      if (!zoomed()) return;
      const it = items[Z.i], k = key(it);
      if (Z.img.dataset.hi === k) return;
      if (it._hiKey !== k) { it._hi = renderScan(it, filter, HI, adj).toDataURL('image/jpeg', 0.9); it._hiKey = k; }
      if (zoomed()) { Z.img.src = it._hi; Z.img.dataset.hi = k; }
    }, 250);
  };
  // Punkt (Bildschirm) → Bildkoordinaten ohne Zoom
  const zLocal = (z, x, y) => { const r = z.pg.getBoundingClientRect(); return [x - r.left - z.img.offsetLeft, y - z.img.offsetTop - r.top]; };
  const zoomAt = (x, y, to) => {
    const z = Z; const [lx, ly] = zLocal(z, x, y);
    const px = (lx - z.tx) / z.s, py = (ly - z.ty) / z.s;
    z.s = to; z.tx = lx - px * to; z.ty = ly - py * to;
    zApply(true); if (zoomed()) hiRes(); else zoomReset(false);
  };
  // Tippen: einmal → Zuschneiden (kurz verzögert), zweimal → Zoom an/aus
  let tapT = null, tapAt = 0;
  const pageTap = (i, e) => {
    const now = Date.now();
    if (now - tapAt < 320) {
      clearTimeout(tapT); tapT = null; tapAt = 0;
      const z = zFor(i); if (!z) return;
      haptic(); zoomAt(e.clientX, e.clientY, zoomed() ? 1 : 2.5);
      return;
    }
    tapAt = now;
    if (zoomed()) return;                   // gezoomt: einfaches Tippen macht nichts
    clearTimeout(tapT); tapT = setTimeout(() => { tapT = null; if (!zoomed()) openCrop(i); }, 300);
  };
  let G = null;     // laufende Geste
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  stage.addEventListener('touchstart', e => {
    if (cmpOn) return;
    if (e.touches.length === 2) {
      const z = zFor(cur); if (!z) return;
      const [a, b] = e.touches, mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
      const [lx, ly] = zLocal(z, mx, my);
      G = { pinch: true, d0: dist(a, b), s0: z.s, px: (lx - z.tx) / z.s, py: (ly - z.ty) / z.s };
      e.preventDefault();
    } else if (e.touches.length === 1 && zoomed()) {
      const t = e.touches[0];
      G = { pan: true, x0: t.clientX, y0: t.clientY, tx0: Z.tx, ty0: Z.ty };
    }
  }, { passive: false });
  stage.addEventListener('touchmove', e => {
    if (!G || !Z) return;
    e.preventDefault();
    if (G.pinch && e.touches.length >= 2) {
      const [a, b] = e.touches, mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
      let s2 = G.s0 * dist(a, b) / G.d0;
      if (s2 < 1) s2 = 1 - (1 - s2) * 0.35;                    // etwas unter 1 federnd
      const [lx, ly] = zLocal(Z, mx, my);
      Z.s = s2; Z.tx = lx - G.px * s2; Z.ty = ly - G.py * s2;
      Z.img.style.transition = 'none';
      Z.img.style.transform = `translate3d(${Z.tx}px,${Z.ty}px,0) scale(${s2})`;
      Z.pg.classList.add('zoomed'); stage.classList.add('zooming');
    } else if (G.pan && e.touches.length === 1) {
      const t = e.touches[0];
      Z.tx = G.tx0 + t.clientX - G.x0; Z.ty = G.ty0 + t.clientY - G.y0; zApply(false);
    }
  }, { passive: false });
  const gEnd = e => {
    if (!G) return;
    if (G.pinch && e.touches.length === 1 && zoomed()) {   // ein Finger bleibt liegen → weiter verschieben
      const t = e.touches[0]; zApply(true);
      G = { pan: true, x0: t.clientX, y0: t.clientY, tx0: Z.tx, ty0: Z.ty }; return;
    }
    if (e.touches.length) return;
    const was = G; G = null;
    if (!Z) return;
    if (Z.s <= 1.05) zoomReset(false);
    else { zApply(true); if (was.pinch) hiRes(); }
  };
  stage.addEventListener('touchend', gEnd); stage.addEventListener('touchcancel', gEnd);
  wrap.addEventListener('gesturestart', e => e.preventDefault());
  // PC: Strg + Mausrad bzw. Trackpad-Zoom
  stage.addEventListener('wheel', e => {
    if (!e.ctrlKey || cmpOn) return;
    e.preventDefault();
    const z = zFor(cur); if (!z) return;
    const to = Math.max(1, Math.min(ZMAX, z.s * Math.exp(-e.deltaY * 0.01)));
    const [lx, ly] = zLocal(z, e.clientX, e.clientY), px = (lx - z.tx) / z.s, py = (ly - z.ty) / z.s;
    z.s = to; z.tx = lx - px * to; z.ty = ly - py * to; zApply(false);
    if (zoomed()) hiRes(); else zoomReset(true);
  }, { passive: false });
  // PC: gezoomt mit der Maus ziehen
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || !zoomed()) return;
    const x0 = e.clientX, y0 = e.clientY, tx0 = Z.tx, ty0 = Z.ty;
    const mv = ev => { Z && (Z.tx = tx0 + ev.clientX - x0, Z.ty = ty0 + ev.clientY - y0, zApply(false)); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  let drawT;
  const drawVisible = () => {
    clearTimeout(drawT);
    drawT = setTimeout(async () => {
      for (const i of [cur, cur + 1, cur - 1]) {
        const it = items[i], el = stage.querySelector(`.rv-page[data-i="${i}"]`);
        if (!it || !el) continue;
        const img = el.querySelector('img');
        if (it.ai && !aiReady(it)) {
          el.classList.add('busy');
          const first = !aiLoaded();
          if (first) busy(true, 'KI wird geladen … (einmalig ca. 23 MB)');
          try { await ensureAI(it); } catch (e) { console.warn(e); it.ai = false; aiFail(); }
          if (first) busy(false);
          if (it._ai && !it._ai.canvas && !flatShown) { flatShown = true; toast('Seite ist eben – ohne KI wird sie genauer'); }
          if (closed) return;
          if (i === cur) renderFilters();
        }
        if (filter === 'ai' && !enhReady(it)) {
          el.classList.add('busy');
          let pct = el.querySelector('.rv-pct');
          if (!pct) { pct = document.createElement('div'); pct.className = 'rv-pct'; el.appendChild(pct); }
          pct.textContent = '✨ KI-Scan …';
          const first = !enhLoaded();
          if (first) busy(true, 'KI wird geladen … (einmalig ca. 21 MB)');
          try {
            await ensureEnhance(it, (msg, f) => { if (f != null) { if (first) busy(false); pct.textContent = `✨ KI-Scan … ${Math.round(f * 100)} %`; } });
          } catch (e) { console.warn(e); toast('KI-Scan hat nicht geklappt – „Verbessern“ wird verwendet', true); }
          if (first) busy(false);
          pct.remove();
          if (closed) return;
          if (i === cur) renderFilters();
        }
        if (filter === 'online' && !onlineDone(it)) {
          el.classList.add('busy', 'nibopt');
          let pct = el.querySelector('.rv-pct');
          if (!pct) { pct = document.createElement('div'); pct.className = 'rv-pct'; el.appendChild(pct); }
          pct.classList.add('nib'); pct.textContent = 'Wird mit Nibvion optimiert …';
          try { await ensureOnline(it); }
          catch (e) { console.warn(e); toast(`Online-Scan: ${e.message || 'fehlgeschlagen'} – KI-Scan wird verwendet`, true); }
          pct.remove(); el.classList.remove('nibopt');
          if (closed) return;
          if (i === cur) renderFilters();
        }
        if (img.dataset.k === key(it)) { el.classList.remove('busy'); continue; }
        el.classList.add('busy'); await tick();
        img.src = preview(it); img.dataset.k = key(it);
        if (Z && Z.img === img) { delete img.dataset.hi; if (zoomed()) hiRes(); }
        el.classList.remove('busy');
        if (cmpOn && i === cur && !cmp) cmpMount();
        if (closed) return;
      }
    }, 40);
  };
  const updCount = () => {
    wrap.querySelector('[data-count]').textContent = items.length ? `${cur + 1} / ${items.length}` : '0 Seiten';
    wrap.querySelector('[data-save]').disabled = !items.length;
  };
  stage.addEventListener('scroll', () => {
    const i = Math.round(stage.scrollLeft / Math.max(1, stage.clientWidth));
    if (i !== cur && i >= 0 && i < items.length) { zoomReset(true); cur = i; updCount(); drawVisible(); renderFilters(); if (cmpOn) cmpMount(); }
  }, { passive: true });

  // ---------- Scan-Laser, solange eine Seite aufbereitet wird ----------
  const lasers = new Map();
  const laserSync = pg => {
    const img = pg.querySelector('img[src]'), on = pg.classList.contains('busy') && !!img;
    if (on && !lasers.has(pg)) { pg.classList.add('lasering'); lasers.set(pg, scanLaser(pg, img)); }
    if (!on && lasers.has(pg)) { lasers.get(pg)(); lasers.delete(pg); pg.classList.remove('lasering'); }
  };
  new MutationObserver(ms => ms.forEach(m => { if (m.target.classList?.contains('rv-page')) laserSync(m.target); }))
    .observe(stage, { subtree: true, attributes: true, attributeFilter: ['class', 'src'] });

  // ---------- Vorher/Nachher-Vorhang ----------
  // Links: zugeschnittenes Originalfoto (ohne Filter), rechts: aufbereiteter Scan. Der Trenner
  // wird nur per transform verschoben (Clip-Ebene + gegenläufig verschobenes Bild).
  let cmpOn = false, cmp = null;
  const origOf = it => {
    const k = JSON.stringify([it.rot, it.corners, aiReady(it)]);
    if (it._origKey !== k) { it._orig = renderScan(it, '', BIG, NO_ADJ).toDataURL('image/jpeg', 0.85); it._origKey = k; }
    return it._orig;
  };
  function cmpUnmount() { if (!cmp) return; cmp.ro?.disconnect(); cmp.el.remove(); cmp = null; }
  function cmpMount(intro = false) {
    cmpUnmount();
    const it = items[cur], pg = stage.querySelector(`.rv-page[data-i="${cur}"]`), img = pg && pg.querySelector('img');
    if (!it || !img) return;
    const el = document.createElement('div'); el.className = 'rv-cmp';
    el.innerHTML = `<div class="rv-cmp-clip"><img alt="" class="rv-cmp-img"></div>
      <span class="rv-cmp-lbl l">Original</span><span class="rv-cmp-lbl r">Scan</span>
      <div class="rv-cmp-bar"><span class="rv-cmp-grip">${icon('chevronLeft')}${icon('chevronRight')}</span></div>`;
    pg.appendChild(el);
    const clip = el.firstChild, oi = clip.firstChild, bar = el.querySelector('.rv-cmp-bar');
    oi.src = origOf(it);
    const C = cmp = { el, x: 0.5, W: 0, H: 0 };
    const set = x => {
      C.x = Math.max(0, Math.min(1, x));
      const W = C.W;
      clip.style.transform = `translate3d(${((C.x - 1) * W).toFixed(1)}px,0,0)`;
      oi.style.transform = `translate3d(${((1 - C.x) * W).toFixed(1)}px,0,0)`;
      bar.style.transform = `translate3d(${(C.x * W).toFixed(1)}px,0,0)`;
      el.classList.toggle('lo', C.x < 0.18); el.classList.toggle('hi', C.x > 0.82);
    };
    const place = () => {
      const pr = pg.getBoundingClientRect(), r = img.getBoundingClientRect();
      if (!r.width) return;
      C.W = r.width; C.H = r.height;
      el.style.cssText = `left:${r.left - pr.left}px;top:${r.top - pr.top}px;width:${r.width}px;height:${r.height}px`;
      oi.style.width = r.width + 'px'; oi.style.height = r.height + 'px';
      set(C.x);
    };
    place();
    C.ro = new ResizeObserver(place); C.ro.observe(img);
    img.addEventListener('load', place);
    // Ziehen am Trenner (oder irgendwo auf dem Bild)
    let drag = null;
    el.addEventListener('pointerdown', e => {
      e.stopPropagation(); C.anim?.cancel(); drag = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch {}
      const r = el.getBoundingClientRect(); set((e.clientX - r.left) / r.width); el.classList.add('drag'); haptic();
    });
    el.addEventListener('pointermove', e => { if (drag !== e.pointerId) return; const r = el.getBoundingClientRect(); set((e.clientX - r.left) / r.width); });
    const up = e => { if (drag !== e.pointerId) return; drag = null; el.classList.remove('drag'); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('click', e => e.stopPropagation());
    // Einstieg: Trenner gleitet einmal mit Feder hin und her
    if (intro && !reducedMotion()) {
      const sp = springFrames({ stiffness: 120, damping: 11 }, v => ({ v }), 60);
      const t0 = performance.now(), from = 0.12;
      const step = now => {
        if (cmp !== C || drag != null) return;
        const t = (now - t0) / sp.ms; if (t >= 1) { set(0.5); return; }
        const f = sp.frames[Math.min(sp.frames.length - 1, Math.round(t * (sp.frames.length - 1)))].v;
        set(from + (0.5 - from) * f); requestAnimationFrame(step);
      };
      set(from); requestAnimationFrame(step);
    }
  }
  const cmpBtn = wrap.querySelector('[data-cmp]');
  cmpBtn.onclick = () => {
    cmpOn = !cmpOn; haptic(); cmpBtn.classList.toggle('on', cmpOn); zoomReset(true);
    if (cmpOn) cmpMount(true); else cmpUnmount();
  };
  const goTo = i => { cur = Math.max(0, Math.min(items.length - 1, i)); stage.scrollTo({ left: cur * stage.clientWidth, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' }); stage.scrollLeft = cur * stage.clientWidth; updCount(); drawVisible(); renderFilters(); };

  // ---------- Filter ----------
  let fltFor = null, fltPrev = {};
  const renderFilters = () => {
    const it = items[cur];
    const fk = it && JSON.stringify([it._id, it.rot, it.corners, aiReady(it), enhReady(it), onlineMode(it), onlineDone(it)]);
    if (it && fltFor !== fk) {
      fltFor = fk; fltPrev = {};
      const base = renderScan(it, '', 240);
      for (const [k] of FL) {
        const c = document.createElement('canvas'); c.width = base.width; c.height = base.height;
        c.getContext('2d').drawImage(base, 0, 0);
        fltPrev[k] = enhance(c, k).toDataURL('image/jpeg', 0.75);
      }
      if (enhReady(it)) fltPrev.ai = renderScan(it, 'ai', 240).toDataURL('image/jpeg', 0.75);
      if (onlineDone(it)) fltPrev.online = renderScan(it, 'online', 240).toDataURL('image/jpeg', 0.75);
    }
    flt.innerHTML = FL.map(([k, l]) => `<button class="flt ${k === (filter || '') ? 'on' : ''}" data-fk="${k}"><span class="flt-img" style="background-image:url(${fltPrev[k] || ''})"></span>${k === 'online' ? `<span class="flt-nb"><img src="icons/icon-192.png" alt="">${l}</span>` : l}</button>`).join('');   // Nibvion-Scan: mit Logo
    flt.querySelectorAll('[data-fk]').forEach(b => b.onclick = () => {
      filter = b.dataset.fk || null; opts.onFilter && opts.onFilter(filter || ''); haptic();
      renderFilters(); drawVisible();
    });
    renderModes();
  };
  // ---------- Nibvion-Modi (nur bei Filter „Nibvion“) ----------
  // Gilt für alle Seiten dieses Scans und wird neuer Standard (wie in den Einstellungen).
  // Schon berechnete Modi sind mit Punkt markiert – Zurückwechseln geht sofort und kostet nichts.
  const om = wrap.querySelector('[data-om]'), omr = wrap.querySelector('[data-omr]');
  const renderModes = () => {
    const show = filter === 'online' && panel === 'filter' && !!items.length;
    om.classList.toggle('open', show);
    if (!show) return;
    const it = items[cur], m = onlineMode(it);
    omr.innerHTML = ONLINE_MODES.map(([v, l]) => `<button class="onl-m ${v === m ? 'on' : ''} ${onlineHas(it, v) ? 'done' : ''}" data-m="${v}">${l}</button>`).join('');
    omr.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
      const v = b.dataset.m; if (v === m) return;
      haptic();
      items.forEach(x => { x.onlMode = v; });
      settings.set('onlineMode', v); savePrefs().catch(() => {});
      renderFilters(); drawVisible();
      omr.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    });
  };
  let idc = 0;
  let aiOn = aiPref();
  const aiFor = it => { it.ai = aiOn && !edgeCut(it.corners); };
  const tag = list => list.forEach(it => { it._id ??= ++idc; aiFor(it); });
  tag(items);

  // ---------- Panel ----------
  wrap.querySelectorAll('[data-tabs] button').forEach(b => b.onclick = () => {
    panel = b.dataset.p;
    wrap.querySelectorAll('[data-tabs] button').forEach(x => x.classList.toggle('on', x === b));
    flt.hidden = panel !== 'filter'; wrap.querySelector('[data-adj]').hidden = panel !== 'adj'; renderModes();
  });
  wrap.querySelectorAll('[data-a]').forEach(r => r.oninput = () => {
    adj[r.dataset.a] = +r.value; wrap.querySelector(`[data-av="${r.dataset.a}"]`).textContent = r.value; drawVisible();
  });
  wrap.querySelector('[data-reset]').onclick = () => {
    for (const k in adj) adj[k] = 0;
    wrap.querySelectorAll('[data-a]').forEach(r => { r.value = 0; wrap.querySelector(`[data-av="${r.dataset.a}"]`).textContent = '0'; });
    drawVisible();
  };
  const ocrBtn = wrap.querySelector('[data-ocr]');
  const updOcr = () => ocrBtn && ocrBtn.classList.toggle('on', ocrOn);
  if (ocrBtn) ocrBtn.onclick = () => { ocrOn = !ocrOn; opts.onOcr && opts.onOcr(ocrOn); updOcr(); haptic(); toast(ocrOn ? 'Text wird beim Speichern erkannt' : 'Ohne Texterkennung'); };
  updOcr();
  const aiBtn = wrap.querySelector('[data-ai]');
  const updAi = () => aiBtn.classList.toggle('on', aiOn);
  let failShown = false, flatShown = false;
  function aiFail() { if (!failShown) { failShown = true; toast('KI-Glätten hat nicht geklappt – klassische Ansicht', true); } }
  aiBtn.onclick = () => {
    aiOn = !aiOn; setAiPref(aiOn); haptic(); updAi();
    items.forEach(aiFor);
    const cut = aiOn && items.some(it => edgeCut(it.corners));
    toast(!aiOn ? 'KI-Glätten aus' : cut ? 'KI-Glätten an – angeschnittene Seiten bleiben klassisch' : 'KI-Glätten an: gewölbte Seiten werden geglättet');
    drawVisible(); renderFilters();
  };
  updAi();
  // Vor Speichern/Export alle Seiten mit KI fertig berechnen
  const prepAll = async () => {
    const todo = items.filter(it => it.ai && !aiReady(it));
    for (let n = 0; n < todo.length; n++) {
      busy(true, `KI glättet Seite ${n + 1} von ${todo.length} …`);
      try { await ensureAI(todo[n]); } catch (e) { console.warn(e); todo[n].ai = false; aiFail(); }
    }
    if (filter === 'online') {
      const list = items.filter(it => !onlineDone(it));
      for (let n = 0; n < list.length; n++) {
        busy(true, `Nibvion-Scan Seite ${n + 1} von ${list.length} …`);
        try { await ensureOnline(list[n]); }
        catch (e) { console.warn(e); toast(`Online-Scan: ${e.message || 'fehlgeschlagen'}`, true); break; }
      }
    }
    if (filter === 'ai' || (filter === 'online' && items.some(it => !onlineDone(it)))) {
      const list = items.filter(it => !enhReady(it));
      for (let n = 0; n < list.length; n++) {
        busy(true, `✨ KI-Scan Seite ${n + 1} von ${list.length} …`);
        try { await ensureEnhance(list[n], (m, f) => { if (f != null) busy(true, `✨ KI-Scan Seite ${n + 1} von ${list.length} … ${Math.round(f * 100)} %`); }); }
        catch (e) { console.warn(e); toast('KI-Scan hat nicht geklappt – „Verbessern“ wird verwendet', true); break; }
      }
    }
    busy(false);
  };

  // ---------- Werkzeuge ----------
  const refreshAll = (goLast) => { buildStage(); updCount(); if (goLast) requestAnimationFrame(() => goTo(items.length - 1)); else { drawVisible(); renderFilters(); } };
  const addShots = list => { tag(list); items.push(...list); refreshAll(true); };
  const openCrop = async i => {
    const it = items[i]; if (!it) return;
    const r = await cropEditor(it); if (!r) return;
    it.corners = r.corners; it.rot = r.rot; aiFor(it); drawVisible(); renderFilters();
  };
  const addFiles = async (files, auto) => {
    if (!files.length) return;
    busy(true, auto ? 'Ränder werden erkannt …' : 'Bilder werden geladen …');
    const out = [];
    for (const f of files) {
      try { const { img, url } = await loadFileImage(f); out.push({ img, url, corners: auto ? detectCorners(img) : FULL.map(p => [...p]), rot: 0 }); }
      catch { toast('Bild konnte nicht geladen werden', true); }
    }
    busy(false); if (out.length) addShots(out);
  };
  wrap.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
    const t = b.dataset.t, it = items[cur];
    zoomReset(true);
    if (t === 'cam') {
      if (cameraSupported() && !liveFailed) {
        const shots = await liveScanner({ startCount: items.length });
        if (shots === null) { liveFailed = true; addFiles(await pickFiles('file-cam'), true); }
        else if (shots.length) addShots(shots);
      } else addFiles(await pickFiles('file-cam'), true);
    }
    if (t === 'lib') addFiles(await pickFiles('file-img'), true);
    if (!it) return;
    if (t === 'rot') {
      if (it._spin) return; it._spin = true; haptic();
      const pg = stage.querySelector(`.rv-page[data-i="${cur}"]`), img = pg && pg.querySelector('img[src]');
      const apply = () => { it.rot = ((it.rot || 0) + 90) % 360; drawVisible(); renderFilters(); return img && imgLoaded(img); };
      if (img) { const cs = getComputedStyle(pg); await spinRotate(img, pg.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), pg.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom), apply); }
      else apply();
      it._spin = false;
    }
    if (t === 'crop') openCrop(cur);
    if (t === 'del') {
      const [gone] = items.splice(cur, 1); if (gone?.url) setTimeout(() => URL.revokeObjectURL(gone.url), 1000);
      cur = Math.min(cur, items.length - 1); if (cur < 0) cur = 0;
      haptic(); refreshAll(false); requestAnimationFrame(() => goTo(cur));
    }
    if (t === 'text') { await prepAll(); opts.onText(items, filter, adj); }
  });

  // ---------- Schließen ----------
  const close = () => {
    if (closed) return; closed = true;
    lasers.forEach(stop => stop()); lasers.clear(); cmpUnmount(); clearTimeout(tapT); clearTimeout(hiT);
    wrap.classList.add('out'); setTimeout(() => wrap.remove(), 280);
  };
  const askClose = async () => {
    // opts.editing: gespeicherter Scan – Schließen verwirft nichts, das Original bleibt
    if (!items.length || opts.editing || await discardDlg()) {
      items.forEach(it => it.url && setTimeout(() => URL.revokeObjectURL(it.url), 1000));
      close();
    }
  };
  wrap.querySelector('[data-x]').onclick = askClose;
  wrap.querySelector('[data-save]').onclick = async () => {
    if (!items.length) return;
    await prepAll();
    const ok = await opts.onSave(items, filter, adj, ocrOn);
    if (ok !== false) close();
  };
  // Von oben herunterwischen
  const top = wrap.querySelector('.rv-top');
  let sy = null, dy = 0;
  top.addEventListener('touchstart', e => { sy = e.touches[0].clientY; dy = 0; }, { passive: true });
  top.addEventListener('touchmove', e => { if (sy == null) return; dy = Math.max(0, e.touches[0].clientY - sy); wrap.style.transform = `translateY(${dy * 0.5}px)`; wrap.style.transition = 'none'; }, { passive: true });
  top.addEventListener('touchend', () => { if (sy == null) return; wrap.style.transition = ''; wrap.style.transform = ''; if (dy > 90) askClose(); sy = null; });

  buildStage(); updCount(); renderFilters(); drawVisible();
  return { close };
}
