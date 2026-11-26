// ================= Seitenansicht: Einzelseite / Buch-Umblättern (3D) =================
// Vollbild-Ansicht über dem Editor. Seiten werden per pdf.js auf Canvas gerendert und als Bild
// (Blob-URL) in die Flächen gelegt – so können die Streifen beim Umblättern dasselbe Bild teilen.
//  • „Einzelseite“: Seite folgt dem Finger und gleitet mit Federphysik zur nächsten
//  • „Buch“: 3D-Umblättern mit Biegung und Falz-Schatten (js/pageflip.js)
//  • „Endlos“: zurück zum normalen Scrollen im Editor
import { icon } from './icons.js';
import { haptic } from './ui.js';
import { createFlip } from './pageflip.js';
import { reducedMotion, springFrames } from './fx.js';

export const VIEW_MODES = [['scroll', 'Endlos'], ['single', 'Einzelseite'], ['flip', 'Buch']];

/** flipView({ pdf, start, title, mode }) → Promise<{ page, mode }> (mode = gewählter Modus beim Verlassen) */
export function flipView({ pdf, start = 0, title = '', mode = 'flip' }) {
  return new Promise(resolve => {
    const N = pdf.numPages;
    const V = { i: Math.max(0, Math.min(N - 1, start)), mode, cache: new Map(), dims: new Map(), W: 0, H: 0, flip: null, alive: true, ui: true };
    const el = document.createElement('div'); el.className = 'fv';
    el.innerHTML = `
      <div class="fv-top">
        <button class="fv-btn" data-x aria-label="Zurück">${icon('chevronLeft')}</button>
        <div class="fv-title">${title.replace(/[<>&]/g, '')}</div>
        <div class="fv-seg" data-seg>${VIEW_MODES.map(([k, l]) => `<button data-m="${k}">${l}</button>`).join('')}<i class="fv-seg-ind"></i></div>
      </div>
      <div class="fv-stage" data-stage><div class="pf-book" data-book><div class="pf-base" data-base></div></div></div>
      <div class="fv-bottom"><div class="fv-count" data-count></div></div>`;
    document.body.appendChild(el);
    const $ = s => el.querySelector(s);
    const stage = $('[data-stage]'), book = $('[data-book]'), base = $('[data-base]');
    requestAnimationFrame(() => el.classList.add('show'));

    // ---------- Seitengröße & Rendern ----------
    const dims = async i => {
      if (V.dims.has(i)) return V.dims.get(i);
      const p = await pdf.getPage(i + 1), v = p.getViewport({ scale: 1 });
      const d = { w: v.width, h: v.height }; V.dims.set(i, d); return d;
    };
    async function layout() {
      const d = await dims(V.i);
      const sw = stage.clientWidth - 28, sh = stage.clientHeight - 24;
      const k = Math.min(sw / d.w, sh / d.h);
      const W = Math.round(d.w * k), H = Math.round(d.h * k);
      if (W === V.W && H === V.H) return;
      V.W = W; V.H = H;
      book.style.width = W + 'px'; book.style.height = H + 'px';
      for (const [, job] of V.cache) job.then(u => u && URL.revokeObjectURL(u)).catch(() => {});
      V.cache.clear();
    }
    // Seite i passend in W×H (eigene Größe, zentriert)
    const fitIn = (d, W, H) => { const k = Math.min(W / d.w, H / d.h); const w = d.w * k, h = d.h * k; return { w, h, x: (W - w) / 2, y: (H - h) / 2 }; };
    function render(i) {
      const key = `${i}@${V.W}x${V.H}`;
      if (V.cache.has(key)) return V.cache.get(key);
      const W = V.W, H = V.H;
      const job = (async () => {
        const page = await pdf.getPage(i + 1);
        const v = page.getViewport({ scale: 1 }); V.dims.set(i, { w: v.width, h: v.height });
        const f = fitIn({ w: v.width, h: v.height }, W, H);
        let dpr = Math.min(3, devicePixelRatio || 1);
        const sc = f.w / v.width;
        if (v.width * v.height * (sc * dpr) ** 2 > 12e6) dpr = Math.sqrt(12e6 / (v.width * v.height)) / sc;
        const vp = page.getViewport({ scale: sc * dpr });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
        c.width = c.height = 0;
        return blob ? URL.createObjectURL(blob) : null;
      })();
      V.cache.set(key, job);
      job.catch(() => V.cache.delete(key));
      // nur Seiten rund um die aktuelle behalten
      for (const k of [...V.cache.keys()]) {
        const [pi, sz] = k.split('@');
        if (sz !== `${W}x${H}` || Math.abs(+pi - V.i) > 3) { V.cache.get(k).then(u => u && setTimeout(() => URL.revokeObjectURL(u), 1500)).catch(() => {}); V.cache.delete(k); }
      }
      return job;
    }
    const preload = () => [V.i + 1, V.i - 1, V.i + 2].forEach(k => { if (k >= 0 && k < N) render(k).catch(() => {}); });

    /** Fläche für Seite i, Ausschnitt x0..x0+sw (für Streifen) */
    function face(i, x0 = 0, sw = V.W, W = V.W, H = V.H) {
      const f = document.createElement('div'); f.className = 'pf-img';
      f.style.width = sw + 'px'; f.style.height = H + 'px';
      render(i).then(async u => {
        if (!u) return;
        const r = fitIn(await dims(i), W, H);
        f.style.backgroundImage = `url(${u})`;
        f.style.backgroundSize = `${r.w}px ${r.h}px`;
        f.style.backgroundPosition = `${r.x - x0}px ${r.y}px`;
      }).catch(() => {});
      return f;
    }
    function setBase(i) { base.replaceChildren(face(i)); }

    // ---------- Modus ----------
    const count = () => { $('[data-count]').textContent = `${V.i + 1} / ${N}`; };
    const segInd = () => {
      const b = el.querySelector(`[data-m="${V.mode}"]`), ind = $('.fv-seg-ind');
      el.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b));
      if (b) ind.style.transform = `translate3d(${b.offsetLeft}px,0,0)`, ind.style.width = b.offsetWidth + 'px';
    };
    const commit = i => { V.i = i; count(); preload(); haptic(); };
    function setMode(m) {
      V.mode = m; segInd();
      V.flip?.destroy(); V.flip = null;
      el.classList.toggle('m-flip', m === 'flip'); el.classList.toggle('m-single', m === 'single');
      if (m === 'flip') {
        V.flip = createFlip({
          book, surface: stage, strips: 16, face, setBase,
          count: () => N, index: () => V.i, commit,
          onTap: x => { if (x > 0.72) V.flip.go(1); else if (x < 0.28) V.flip.go(-1); else toggleUi(); },
          onEdge: () => nudge(),
        });
      }
    }
    el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
      haptic();
      if (b.dataset.m === 'scroll') return close('scroll');
      setMode(b.dataset.m);
    });
    const toggleUi = () => { V.ui = !V.ui; el.classList.toggle('ui-off', !V.ui); };
    const nudge = () => { if (!reducedMotion()) book.animate([{ transform: 'translate3d(0,0,0)' }, { transform: 'translate3d(-8px,0,0)' }, { transform: 'translate3d(5px,0,0)' }, { transform: 'translate3d(0,0,0)' }], { duration: 320, easing: 'ease-out' }); };

    // ---------- Einzelseite: Seite folgt dem Finger, Feder zum Ziel ----------
    let sd = null, sAnim = null;
    const neigh = document.createElement('div'); neigh.className = 'pf-neigh';
    book.appendChild(neigh);
    function slideTo(d, fromDx, v = 0) {
      const W = V.W + 24, ni = V.i + d;
      const target = d ? -d * W : 0;
      if (reducedMotion()) {
        base.style.transform = neigh.style.transform = '';
        if (d) { setBase(ni); commit(ni); book.animate?.([{ opacity: .4 }, { opacity: 1 }], { duration: 160 }); }
        neigh.replaceChildren(); return;
      }
      const sp = springFrames({ stiffness: 300, damping: 30, velocity: v }, x => ({ x }));
      const at = x => fromDx + (target - fromDx) * x;
      const nOff = d ? d * W : (fromDx < 0 ? W : -W);
      sAnim = base.animate(sp.frames.map(f => ({ transform: `translate3d(${at(f.x).toFixed(1)}px,0,0)`, offset: f.offset })), { duration: sp.ms, fill: 'forwards' });
      neigh.animate(sp.frames.map(f => ({ transform: `translate3d(${(at(f.x) + nOff).toFixed(1)}px,0,0)`, offset: f.offset })), { duration: sp.ms, fill: 'forwards' });
      sAnim.finished.catch(() => {}).then(() => {
        if (d) { setBase(ni); commit(ni); }
        base.getAnimations().forEach(a => a.cancel()); neigh.getAnimations().forEach(a => a.cancel());
        base.style.transform = ''; neigh.style.transform = ''; neigh.replaceChildren(); sAnim = null;
      });
    }
    stage.addEventListener('pointerdown', e => {
      if (V.mode !== 'single' || sAnim) return;
      sd = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), d: 0, lx: e.clientX, lt: performance.now(), v: 0 };
    });
    stage.addEventListener('pointermove', e => {
      if (!sd || e.pointerId !== sd.id) return;
      const dx = e.clientX - sd.x;
      if (!sd.d) {
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(e.clientY - sd.y)) return;
        sd.d = dx < 0 ? 1 : -1;
        try { stage.setPointerCapture(e.pointerId); } catch {}
        const ni = V.i + sd.d;
        if (ni >= 0 && ni < N) { neigh.replaceChildren(face(ni)); sd.ok = true; }
      }
      const now = performance.now(); sd.v = (e.clientX - sd.lx) / Math.max(1, now - sd.lt); sd.lx = e.clientX; sd.lt = now;
      const W = V.W + 24, off = sd.ok ? dx : dx * 0.25;      // am Anfang/Ende: Gummiband
      base.style.transform = `translate3d(${off}px,0,0)`;
      if (sd.ok) neigh.style.transform = `translate3d(${off + sd.d * W}px,0,0)`;
      sd.off = off;
    });
    const sUp = e => {
      if (!sd || e.pointerId !== sd.id) return;
      const g = sd; sd = null;
      if (!g.d) {
        if (performance.now() - g.t < 350) {
          const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
          if (x > 0.72 && V.i < N - 1) { neigh.replaceChildren(face(V.i + 1)); slideTo(1, 0, 0); }
          else if (x < 0.28 && V.i > 0) { neigh.replaceChildren(face(V.i - 1)); slideTo(-1, 0, 0); }
          else toggleUi();
        }
        return;
      }
      const W = V.W + 24, fling = Math.abs(g.v) > 0.45;
      const go = g.ok && (fling ? Math.sign(-g.v) === g.d : Math.abs(g.off) > W * 0.3);
      slideTo(go ? g.d : 0, g.off || 0, -g.v * 1000 / W);
    };
    stage.addEventListener('pointerup', sUp); stage.addEventListener('pointercancel', sUp);

    // ---------- Tasten / Schließen ----------
    const key = e => {
      if (e.key === 'Escape') close();
      const d = e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' ? 1 : e.key === 'ArrowLeft' || e.key === 'PageUp' ? -1 : 0;
      if (!d) return;
      if (V.mode === 'flip') V.flip?.go(d);
      else if (!sAnim && V.i + d >= 0 && V.i + d < N) { neigh.replaceChildren(face(V.i + d)); slideTo(d, 0, 0); }
    };
    document.addEventListener('keydown', key);
    const onResize = async () => { await layout(); setBase(V.i); setMode(V.mode); };
    window.addEventListener('resize', onResize);
    function close(m = V.mode) {
      if (!V.alive) return; V.alive = false;
      V.flip?.destroy();
      document.removeEventListener('keydown', key); window.removeEventListener('resize', onResize);
      el.classList.remove('show');
      setTimeout(() => { el.remove(); for (const [, j] of V.cache) j.then(u => u && URL.revokeObjectURL(u)).catch(() => {}); }, 340);
      resolve({ page: V.i, mode: m });
    }
    $('[data-x]').onclick = () => { haptic(); close(); };

    (async () => {
      await layout(); setBase(V.i); count(); setMode(V.mode); preload();
      requestAnimationFrame(segInd);
    })();
  });
}
