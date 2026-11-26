// ================= Präsentieren (Vollbild + Laserpointer) =================
// Schwarzer Vollbild-Modus, Seite optimal eingepasst. Blättern: Wischen (Seite folgt dem Finger),
// Tipp auf den linken/rechten Rand, Pfeiltasten. Laserpointer: Canvas-Overlay mit leuchtendem
// roten Punkt und verblassender Spur – das PDF selbst wird nicht verändert.
import { icon } from './icons.js';
import { haptic } from './ui.js';

const TRAIL_MS = 650;

/** presentMode({ pdf, start, title }) → Promise<letzte Seite (0-basiert)> */
export function presentMode({ pdf, start = 0, title = '' }) {
  return new Promise(resolve => {
    const N = pdf.numPages;
    const P = { i: Math.max(0, Math.min(N - 1, start)), laser: false, cache: new Map(), gen: 0, ui: true, hideT: 0, anim: false };
    const el = document.createElement('div'); el.className = 'pres';
    el.innerHTML = `
      <div class="pres-stage" data-stage></div>
      <canvas class="pres-laser" data-laser></canvas>
      <canvas class="pres-spot" data-spot></canvas>
      <div class="pres-shape" data-shape><button data-v="rect" class="on"><i class="sh-r"></i>Rechteck</button><button data-v="ellipse"><i class="sh-e"></i>Kreis</button></div>
      <div class="pres-top">
        <button class="pres-btn" data-x aria-label="Beenden">${icon('x')}</button>
        <div class="pres-title">${title.replace(/[<>&]/g, '')}</div>
        <button class="pres-btn pres-sp" data-sp aria-label="Spotlight / Fokus">${icon('spotlight')}<span>Fokus</span></button>
        <button class="pres-btn pres-lz" data-lz aria-label="Laserpointer"><span class="pres-dot"></span><span>Laser</span></button>
      </div>
      <div class="pres-bottom">
        <button class="pres-btn" data-prev aria-label="Zurück">${icon('chevronLeft')}</button>
        <div class="pres-count" data-count></div>
        <button class="pres-btn" data-next aria-label="Weiter">${icon('chevronRight')}</button>
      </div>
      <div class="pres-hint" data-hint>Laser an – Finger auf den Bildschirm legen</div>`;
    document.body.appendChild(el);
    document.body.classList.add('presenting');
    const $ = s => el.querySelector(s);
    const stage = $('[data-stage]'), lz = $('[data-laser]');
    requestAnimationFrame(() => el.classList.add('show'));

    // Bildschirm anlassen & Vollbild (wo der Browser es erlaubt)
    let wake = null;
    try { navigator.wakeLock?.request('screen').then(w => wake = w).catch(() => {}); } catch {}
    try { if (!window.matchMedia('(display-mode: standalone)').matches) document.documentElement.requestFullscreen?.().catch(() => {}); } catch {}

    // ---------- Seiten rendern ----------
    const size = () => ({ w: stage.clientWidth, h: stage.clientHeight });
    async function render(i) {
      const { w, h } = size(), key = `${i}@${w}x${h}`;
      if (P.cache.has(key)) return P.cache.get(key);
      const job = (async () => {
        const page = await pdf.getPage(i + 1);
        const v = page.getViewport({ scale: 1 });
        const fit = Math.min(w / v.width, h / v.height);
        let dpr = Math.min(3, window.devicePixelRatio || 1);
        if (v.width * v.height * (fit * dpr) ** 2 > 14e6) dpr = Math.sqrt(14e6 / (v.width * v.height)) / fit;
        const vp = page.getViewport({ scale: fit * dpr });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        c.style.width = Math.round(v.width * fit) + 'px'; c.style.height = Math.round(v.height * fit) + 'px';
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        c.className = 'pres-page';
        return c;
      })();
      P.cache.set(key, job);
      job.catch(() => P.cache.delete(key));
      // Speicher klein halten: nur Seiten rund um die aktuelle behalten
      for (const k of [...P.cache.keys()]) { const [pi, sz] = k.split('@'); if (sz !== `${w}x${h}` || Math.abs(+pi - P.i) > 2) P.cache.delete(k); }
      return job;
    }
    const preload = () => { [P.i + 1, P.i - 1, P.i + 2].forEach(k => { if (k >= 0 && k < N) render(k).catch(() => {}); }); };

    async function show(dir = 0) {
      const gen = ++P.gen;
      $('[data-count]').textContent = `${P.i + 1} / ${N}`;
      $('[data-prev]').disabled = P.i <= 0; $('[data-next]').disabled = P.i >= N - 1;
      let c;
      try { c = await render(P.i); } catch (e) { console.error(e); return; }
      if (gen !== P.gen || !el.isConnected) return;
      const old = stage.querySelector('.pres-page:not(.leaving)');
      if (old === c) return;
      c.classList.remove('leaving');
      c.style.transition = 'none';
      c.style.transform = dir ? `translateX(${dir * 40}%)` : 'scale(.97)';
      c.style.opacity = '0';
      stage.appendChild(c);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        c.style.transition = ''; c.style.transform = ''; c.style.opacity = '';
      }));
      if (old) {
        old.classList.add('leaving');
        old.style.transform = dir ? `translateX(${-dir * 40}%)` : 'scale(.97)'; old.style.opacity = '0';
        setTimeout(() => { if (old.classList.contains('leaving')) old.remove(); }, 360);
      }
      preload();
    }
    const go = d => {
      const n = P.i + d; if (n < 0 || n >= N) { bump(d); return; }
      P.i = n; haptic(); spotClear(); show(d); wakeUi();
    };
    const bump = d => { const c = stage.querySelector('.pres-page:not(.leaving)'); if (!c) return; c.style.transform = `translateX(${-d * 3}%)`; setTimeout(() => c.style.transform = '', 160); };

    // ---------- Bedienelemente ein-/ausblenden ----------
    const setUi = on => { P.ui = on; el.classList.toggle('ui-off', !on); };
    const wakeUi = () => { setUi(true); clearTimeout(P.hideT); P.hideT = setTimeout(() => { if (!P.laser && !SP.on) setUi(false); }, 2800); };
    wakeUi();

    // ---------- Laserpointer ----------
    const L = { pts: [], down: false, raf: 0, last: null };
    const fitLaser = () => { const d = Math.min(3, devicePixelRatio || 1); lz.width = innerWidth * d; lz.height = innerHeight * d; lz.getContext('2d').setTransform(d, 0, 0, d, 0, 0); };
    fitLaser();
    function drawLaser() {
      const g = lz.getContext('2d'), now = performance.now();
      g.clearRect(0, 0, lz.width, lz.height);
      L.pts = L.pts.filter(p => now - p.t < TRAIL_MS);
      // Spur: Segmente werden mit dem Alter dünner und blasser
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (let k = 1; k < L.pts.length; k++) {
        const a = L.pts[k - 1], b = L.pts[k];
        if (b.brk) continue;
        const life = 1 - (now - b.t) / TRAIL_MS;
        g.strokeStyle = `rgba(255,${40 + 60 * life | 0},${40 + 40 * life | 0},${(life * 0.85).toFixed(3)})`;
        g.lineWidth = 2 + 7 * life;
        g.shadowColor = 'rgba(255,30,30,.9)'; g.shadowBlur = 14 * life;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      }
      g.shadowBlur = 0;
      // Punkt (leuchtend), blendet nach dem Loslassen sanft aus
      const p = L.last;
      if (p) {
        const age = L.down ? 0 : now - p.up, life = Math.max(0, 1 - age / 380);
        if (life > 0) {
          const r = 16;
          const grd = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.4);
          grd.addColorStop(0, `rgba(255,255,255,${life})`);
          grd.addColorStop(0.18, `rgba(255,60,50,${life})`);
          grd.addColorStop(0.45, `rgba(255,20,20,${0.45 * life})`);
          grd.addColorStop(1, 'rgba(255,0,0,0)');
          g.fillStyle = grd; g.beginPath(); g.arc(p.x, p.y, r * 2.4, 0, 7); g.fill();
        } else L.last = null;
      }
      if (L.pts.length || L.down || L.last) L.raf = requestAnimationFrame(drawLaser); else L.raf = 0;
    }
    const kick = () => { if (!L.raf) L.raf = requestAnimationFrame(drawLaser); };
    const addPt = (e, brk) => { const p = { x: e.clientX, y: e.clientY, t: performance.now(), brk }; L.pts.push(p); L.last = p; kick(); };
    lz.addEventListener('pointerdown', e => { if (!P.laser) return; e.preventDefault(); lz.setPointerCapture(e.pointerId); L.down = true; addPt(e, true); $('[data-hint]').classList.remove('show'); });
    lz.addEventListener('pointermove', e => { if (!P.laser || !L.down) return; const co = e.getCoalescedEvents?.(); for (const ce of co?.length ? co : [e]) addPt(ce); });
    const up = () => { if (!L.down) return; L.down = false; if (L.last) L.last.up = performance.now(); kick(); };
    lz.addEventListener('pointerup', up); lz.addEventListener('pointercancel', up);
    const setLaser = on => {
      if (on && SP.on) setSpot(false);
      P.laser = on; haptic();
      el.classList.toggle('laser-on', on);
      $('[data-lz]').classList.toggle('on', on);
      const h = $('[data-hint]'); h.classList.toggle('show', on);
      if (on) { setUi(true); clearTimeout(P.hideT); setTimeout(() => h.classList.remove('show'), 2200); }
      else { L.pts = []; L.last = null; wakeUi(); }
    };
    $('[data-lz]').onclick = e => { e.stopPropagation(); setLaser(!P.laser); };

    // ---------- Spotlight / Fokus ----------
    // Rechteck oder Kreis aufziehen → Rest der Folie dunkelt mit Feder ab, der Bereich bleibt hell
    // (weiche Kante, warmer Lichtschein). Antippen setzt zurück. Canvas-Overlay, Folie bleibt unverändert.
    const sp = $('[data-spot]');
    const fitSpot = () => { const d = Math.min(3, devicePixelRatio || 1); sp.width = innerWidth * d; sp.height = innerHeight * d; sp.getContext('2d').setTransform(d, 0, 0, d, 0, 0); };
    fitSpot();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shapePath = (g, s, scale = 1) => {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2, w = s.w * scale, h = s.h * scale;
      g.beginPath();
      if (s.shape === 'ellipse') g.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      else { const r = Math.min(26, w / 5, h / 5); g.roundRect ? g.roundRect(cx - w / 2, cy - h / 2, w, h, r) : g.rect(cx - w / 2, cy - h / 2, w, h); }
    };
    function drawSpot() {
      const g = sp.getContext('2d'), W = innerWidth, H = innerHeight;
      g.clearRect(0, 0, W, H);
      const k = SP.k, s = SP.cur;
      if (s && k > 0.002) {
        const a = Math.min(1, Math.max(0, k)), scale = 1 + (1 - k) * 0.55;    // Loch zieht sich auf den Bereich zusammen
        g.save();
        g.fillStyle = `rgba(6,7,10,${(0.76 * a).toFixed(3)})`; g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'destination-out';
        g.shadowColor = 'rgba(0,0,0,1)'; g.shadowBlur = 34;
        shapePath(g, s, scale); g.fill(); g.fill();
        g.restore();
        // Lichtschein am Rand
        g.save();
        g.strokeStyle = `rgba(255,236,205,${(0.55 * a).toFixed(3)})`; g.lineWidth = 2;
        g.shadowColor = `rgba(255,190,130,${(0.9 * a).toFixed(3)})`; g.shadowBlur = 26;
        shapePath(g, s, scale * 1.01); g.stroke(); g.stroke();
        g.restore();
      }
      const d = SP.drag;
      if (d && d.moved) {
        const r = norm(d);
        g.save(); g.setLineDash([7, 6]); g.lineDashOffset = -performance.now() / 30;
        g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 2; g.shadowColor = 'rgba(255,140,100,.9)'; g.shadowBlur = 12;
        shapePath(g, r); g.stroke(); g.restore();
      }
    }
    const SP = { on: false, shape: 'rect', cur: null, k: 0, v: 0, target: 0, raf: 0, drag: null };
    const norm = d => {
      let x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      if (SP.shape === 'ellipse' && d.sq) { const m = Math.max(w, h); x = d.x0 - m * (d.x1 < d.x0); y = d.y0 - m * (d.y1 < d.y0); w = h = m; }
      if (w < 44) { x -= (44 - w) / 2; w = 44; } if (h < 44) { y -= (44 - h) / 2; h = 44; }
      return { x, y, w, h, shape: SP.shape };
    };
    function spotLoop() {
      let last = performance.now();
      const K = 210, C = 2 * Math.sqrt(K) * 0.62;       // unterkritisch → kurzes Nachfedern
      const step = now => {
        const dt = Math.min(0.032, (now - last) / 1000); last = now;
        if (reduce) { SP.k = SP.target; SP.v = 0; }
        else { SP.v += (K * (SP.target - SP.k) - C * SP.v) * dt; SP.k += SP.v * dt; }
        drawSpot();
        const still = Math.abs(SP.target - SP.k) < 0.002 && Math.abs(SP.v) < 0.01;
        if (still && !SP.drag) { SP.k = SP.target; if (!SP.k) SP.cur = null; drawSpot(); SP.raf = 0; return; }
        SP.raf = requestAnimationFrame(step);
      };
      if (!SP.raf) SP.raf = requestAnimationFrame(step);
    }
    function spotClear() { if (!SP.cur) return; SP.target = 0; spotLoop(); }
    sp.addEventListener('pointerdown', e => {
      if (!SP.on) return; e.preventDefault(); sp.setPointerCapture(e.pointerId);
      SP.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false, sq: SP.shape === 'ellipse' };
      $('[data-hint]').classList.remove('show'); spotLoop();
    });
    sp.addEventListener('pointermove', e => {
      const d = SP.drag; if (!d || e.pointerId !== d.id) return;
      d.x1 = e.clientX; d.y1 = e.clientY;
      if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) > 12) d.moved = true;
    });
    const spUp = e => {
      const d = SP.drag; if (!d || e.pointerId !== d.id) return;
      SP.drag = null;
      if (!d.moved || e.type === 'pointercancel') { spotClear(); haptic(); return; }      // Antippen → zurücksetzen
      SP.cur = norm(d); SP.k = 0; SP.v = 0; SP.target = 1; haptic(); spotLoop();
    };
    sp.addEventListener('pointerup', spUp); sp.addEventListener('pointercancel', spUp);
    const shapeBar = $('[data-shape]');
    shapeBar.querySelectorAll('button').forEach(b => b.onclick = e => {
      e.stopPropagation(); haptic(); SP.shape = b.dataset.v;
      shapeBar.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      if (SP.cur) { SP.cur = { ...SP.cur, shape: SP.shape }; drawSpot(); }
    });
    function setSpot(on) {
      if (on && P.laser) setLaser(false);
      SP.on = on; haptic();
      el.classList.toggle('spot-on', on);
      $('[data-sp]').classList.toggle('on', on);
      const h = $('[data-hint]');
      if (on) { h.textContent = 'Bereich aufziehen – Antippen setzt zurück'; h.classList.add('show'); setUi(true); clearTimeout(P.hideT); setTimeout(() => h.classList.remove('show'), 2400); }
      else { spotClear(); h.textContent = 'Laser an – Finger auf den Bildschirm legen'; wakeUi(); }
    }
    $('[data-sp]').onclick = e => { e.stopPropagation(); setSpot(!SP.on); };

    // ---------- Gesten: Wischen & Rand-Tipp ----------
    let t0 = null;
    stage.addEventListener('pointerdown', e => {
      if (P.laser || SP.on) return;
      t0 = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, moved: false };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', e => {
      if (!t0 || e.pointerId !== t0.id) return;
      const dx = e.clientX - t0.x;
      if (Math.abs(dx) > 8) t0.moved = true;
      const c = stage.querySelector('.pres-page:not(.leaving)');
      if (c && t0.moved) { const edge = (dx > 0 && P.i === 0) || (dx < 0 && P.i === N - 1); c.style.transition = 'none'; c.style.transform = `translateX(${edge ? dx * 0.25 : dx}px)`; }
    });
    const end = e => {
      if (!t0 || e.pointerId !== t0.id) return;
      const dx = e.clientX - t0.x, dy = e.clientY - t0.y, dt = performance.now() - t0.t, moved = t0.moved; t0 = null;
      const c = stage.querySelector('.pres-page:not(.leaving)');
      if (c) { c.style.transition = ''; }
      if (moved && Math.abs(dx) > Math.abs(dy) && (Math.abs(dx) > 70 || (Math.abs(dx) > 25 && dt < 250))) { go(dx < 0 ? 1 : -1); return; }
      if (c) c.style.transform = '';
      if (!moved && dt < 400) {
        const w = innerWidth;
        if (e.clientX < w * 0.25) go(-1);
        else if (e.clientX > w * 0.75) go(1);
        else { P.ui ? (clearTimeout(P.hideT), setUi(false)) : wakeUi(); }
      }
    };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', e => { if (t0) { t0.moved = false; end(e); } });

    $('[data-prev]').onclick = e => { e.stopPropagation(); go(-1); };
    $('[data-next]').onclick = e => { e.stopPropagation(); go(1); };
    const key = e => {
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); go(1); }
      else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); go(-1); }
      else if (e.key === 'Home') { P.i = 0; show(-1); }
      else if (e.key === 'End') { P.i = N - 1; show(1); }
      else if (e.key.toLowerCase() === 'l') setLaser(!P.laser);
      else if (e.key.toLowerCase() === 'f') setSpot(!SP.on);
      else if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', key);
    let rzT = 0;
    const onResize = () => { clearTimeout(rzT); rzT = setTimeout(() => { fitLaser(); fitSpot(); SP.cur = null; SP.k = SP.target = 0; drawSpot(); P.cache.clear(); stage.innerHTML = ''; show(); }, 150); };
    window.addEventListener('resize', onResize);

    function close() {
      document.removeEventListener('keydown', key); window.removeEventListener('resize', onResize);
      cancelAnimationFrame(L.raf); cancelAnimationFrame(SP.raf); clearTimeout(P.hideT); P.gen++;
      try { wake?.release(); } catch {}
      try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch {}
      el.classList.remove('show'); document.body.classList.remove('presenting');
      setTimeout(() => { el.remove(); P.cache.clear(); }, 300);
      resolve(P.i);
    }
    $('[data-x]').onclick = e => { e.stopPropagation(); close(); };
    show();
  });
}
