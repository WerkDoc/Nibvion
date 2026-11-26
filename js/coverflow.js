// ================= 3D-Cover-Flow (Startseite „Zuletzt“, Seiten verwalten) =================
// Die mittlere Karte steht groß im Fokus, Nachbarn kippen per CSS-3D (perspective/rotateY) weg.
// Wischen mit Trägheit, Einrasten per gedämpfter Feder. Nur transform/opacity → GPU, 60 FPS.
// coverFlow(host, items, { cover(item) → HTML, caption(item) → HTML, onOpen(i), onMore(i), start })

import { haptic } from './ui.js';
import { reducedMotion } from './fx.js';

const VIS = 5;                       // so viele Karten links/rechts werden gezeichnet

export function coverFlow(host, items, opt = {}) {
  host.innerHTML = `<div class="cf" tabindex="0" role="listbox" aria-label="${opt.label || 'Dokumente'}">
      <div class="cf-stage"></div>
    </div>
    <div class="cf-cap" aria-live="polite"></div>
    <div class="cf-dots"></div>`;
  const root = host.querySelector('.cf'), stage = host.querySelector('.cf-stage'), cap = host.querySelector('.cf-cap'), dots = host.querySelector('.cf-dots');
  const n = items.length;
  const cards = items.map((it, i) => {
    const c = document.createElement('button');
    c.className = 'cf-card'; c.dataset.i = i; c.setAttribute('role', 'option');
    c.innerHTML = opt.cover ? opt.cover(it, i) : '';
    stage.appendChild(c);
    return c;
  });
  dots.innerHTML = n > 1 && n <= 24 ? items.map(() => '<i></i>').join('') : '';
  const dotEls = [...dots.children];

  let pos = Math.max(0, Math.min(n - 1, opt.start || 0)), vel = 0, target = pos, raf = 0, focus = -1, W = 0;
  const reduced = reducedMotion();

  const measure = () => { W = Math.min(root.clientWidth || 320, 520); };
  // Karte bei Abstand d (in Karten) zur Mitte: weich zwischen „flach im Fokus“ und „weggekippt“
  function layout() {
    const cw = W * 0.46, spread = cw * 0.62, step = cw * 0.24;
    for (let i = 0; i < n; i++) {
      const c = cards[i], d = i - pos, ad = Math.abs(d);
      if (ad > VIS + 0.5) { if (c.style.visibility !== 'hidden') c.style.visibility = 'hidden'; continue; }
      c.style.visibility = '';
      const k = Math.min(1, ad), s = Math.sign(d);
      const x = s * (k * spread + Math.max(0, ad - 1) * step);
      const z = -k * cw * 0.55 - Math.max(0, ad - 1) * 18;
      const ry = -s * k * 58;
      c.style.transform = `translate3d(${x.toFixed(1)}px,0,${z.toFixed(1)}px) rotateY(${ry.toFixed(2)}deg)`;
      c.style.zIndex = String(100 - Math.round(ad * 10));
      c.style.opacity = ad > VIS - 1 ? Math.max(0, VIS + 0.5 - ad) / 1.5 : 1;
      c.style.setProperty('--shade', (k * 0.45).toFixed(3));
    }
    const f = Math.round(pos);
    if (f !== focus && f >= 0 && f < n) {
      if (focus >= 0) { cards[focus]?.classList.remove('on'); dotEls[focus]?.classList.remove('on'); cards[focus]?.setAttribute('aria-selected', 'false'); }
      focus = f; cards[f].classList.add('on'); cards[f].setAttribute('aria-selected', 'true'); dotEls[f]?.classList.add('on');
      cap.innerHTML = opt.caption ? opt.caption(items[f], f) : '';
      cap.querySelector('[data-cf-more]')?.addEventListener('click', e => { e.stopPropagation(); opt.onMore?.(f); });
      cap.querySelector('[data-cf-open]')?.addEventListener('click', () => opt.onOpen?.(f));
      opt.onFocus?.(f);
    }
  }

  // ---- Feder zum Ziel (leicht unterdämpft, ζ≈0.8 → kaum spürbares Nachfedern) ----
  let last = 0;
  function tick(now) {
    const dt = Math.min(0.034, (now - (last || now)) / 1000 || 1 / 60); last = now;
    const k = 170, c = 2 * 0.8 * Math.sqrt(k);
    vel += (-k * (pos - target) - c * vel) * dt;
    pos += vel * dt;
    if (Math.abs(pos - target) < 0.0015 && Math.abs(vel) < 0.01) { pos = target; vel = 0; layout(); raf = 0; last = 0; return; }
    layout(); raf = requestAnimationFrame(tick);
  }
  function goTo(i, v = vel) {
    const t = Math.max(0, Math.min(n - 1, Math.round(i)));
    if (t !== target) haptic();
    target = t; vel = v;
    if (reduced) { pos = target; vel = 0; layout(); return; }
    if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
  }

  // ---- Wischen: direkt folgen, beim Loslassen Trägheit hochrechnen und einrasten ----
  let drag = null;
  root.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancelAnimationFrame(raf); raf = 0;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, p: pos, moved: false, axis: null, hist: [[performance.now(), e.clientX]] };
  });
  root.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.axis && Math.hypot(dx, dy) > 8) {
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.axis === 'x') { drag.moved = true; try { root.setPointerCapture(e.pointerId); } catch {} }
      else { drag = null; goTo(pos, 0); return; }            // senkrecht → Seite scrollen lassen
    }
    if (drag.axis !== 'x') return;
    const unit = W * 0.3;
    let p = drag.p - dx / unit;
    if (p < 0) p = -Math.pow(-p, 0.6) * 0.5; else if (p > n - 1) p = n - 1 + Math.pow(p - n + 1, 0.6) * 0.5;   // Gummiband
    pos = p; layout();
    drag.hist.push([performance.now(), e.clientX]); if (drag.hist.length > 6) drag.hist.shift();
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) return goTo(pos, 0);
    const h = d.hist, a = h[0], b = h[h.length - 1], dt = Math.max(16, b[0] - a[0]);
    const v = -((b[1] - a[1]) / dt) * 1000 / (W * 0.3);              // Karten pro Sekunde
    const fresh = performance.now() - b[0] < 80;
    const proj = pos + (fresh ? v * 0.22 : 0);                         // Trägheit: kurz weiterrollen
    goTo(proj, fresh ? v : 0);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('click', e => {
    const c = e.target.closest('.cf-card'); if (!c) return;
    if (Math.abs(pos - target) > 0.05 && raf) return;
    const i = +c.dataset.i;
    if (i === Math.round(pos)) opt.onOpen?.(i); else goTo(i, 0);
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { goTo(target + 1, 0); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { goTo(target - 1, 0); e.preventDefault(); }
    if (e.key === 'Enter') opt.onOpen?.(Math.round(pos));
  });
  let wheelT = 0;
  root.addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
    e.preventDefault();
    const now = performance.now(); if (now - wheelT < 160) return; wheelT = now;
    goTo(target + Math.sign(e.deltaX), 0);
  }, { passive: false });
  dots.addEventListener('click', e => { const k = dotEls.indexOf(e.target); if (k >= 0) goTo(k, 0); });

  const ro = new ResizeObserver(() => { measure(); layout(); });
  ro.observe(root);
  measure(); layout();
  // Auftritt: Karten fächern sich aus der Mitte auf
  if (!reduced && n > 1) { const t = pos; pos = Math.min(n - 1, t + 1.4); goTo(t, 0); }

  return {
    goTo: i => goTo(i, 0),
    get index() { return Math.round(target); },
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); host.innerHTML = ''; },
  };
}
