// ================= Stoff-Lesezeichen & Lesefortschritt =================
// Ein Band in Koralle hängt oben rechts in den Seitenbereich. Kurz nach unten ziehen oder
// antippen → es rastet mit einer knackigen Feder ein und merkt sich Seite + Position (am
// Dokument gespeichert). Liegt das Lesezeichen auf einer anderen Seite, hängt es halb herab
// und zeigt die Seitenzahl; Antippen bietet „Zur Seite springen“ oder „Hier setzen“.
// Dazu: feiner Fortschrittsring in der Seitenanzeige und beim Öffnen „Weiter bei Seite …“.
// Nur transform/opacity, Feder über WAAPI – bei „Bewegung reduzieren“ ohne Animation.
import { springFrames, reducedMotion } from './fx.js';
import { haptic, toast } from './ui.js';
import { icon } from './icons.js';

const H = 104;                                   // Länge des Bandes (px), ragt oben aus dem Bild
const DROP = { none: 24, away: 42, here: 66 };   // sichtbare Länge je Zustand

/**
 * initBookmark({ root, scroller, count, here, mark, setMark, jump })
 *  here()  → { page, frac } aktuelle Lese-Position
 *  mark()  → gespeichertes Lesezeichen oder null
 *  setMark(m | null) speichert, jump(m) springt hin
 */
export function initBookmark(o) {
  const el = document.createElement('div');
  el.className = 'ribbon'; el.setAttribute('aria-label', 'Lesezeichen'); el.setAttribute('role', 'button');
  el.innerHTML = `<div class="rb-move"><i class="rb-shadow"></i><div class="rb-cloth"><span class="rb-no"></span></div></div>`;
  o.root.appendChild(el);
  const mv = el.firstChild, no = el.querySelector('.rb-no');
  let cur = DROP.none, state = 'none', anim = null, pop = null, resume = null;

  const place = y => { mv.style.transform = `translate3d(0,${(y - H).toFixed(1)}px,0)`; };
  const springTo = (to, { stiffness = 560, damping = 19, sway = 0 } = {}) => {
    anim?.cancel(); anim = null;
    const from = cur; cur = to;
    if (reducedMotion() || !mv.animate || Math.abs(from - to) < 0.5) { place(to); return; }
    const sp = springFrames({ stiffness, damping }, v => ({ transform: `translate3d(0,${(from + (to - from) * v - H).toFixed(2)}px,0) rotate(${(sway * (1 - v)).toFixed(2)}deg)` }), 44);
    place(to);
    anim = mv.animate(sp.frames, { duration: sp.ms });
    anim.onfinish = () => { anim = null; };
  };

  // Liegt das Lesezeichen im sichtbaren Bereich?
  const onScreen = m => {
    if (!m) return false;
    const h = o.here();
    return h.page === m.page && Math.abs(h.frac - m.frac) < 0.35;
  };
  const sync = (instant = false) => {
    const m = o.mark();
    const s = !m ? 'none' : onScreen(m) ? 'here' : 'away';
    no.textContent = m ? String(m.page + 1) : '';
    el.classList.toggle('set', !!m);
    el.dataset.s = s;
    if (s === state && !instant) return;
    state = s;
    if (instant) { anim?.cancel(); cur = DROP[s]; place(cur); }
    else springTo(DROP[s], { stiffness: 420, damping: 24 });
  };

  const setHere = () => {
    const m = { ...o.here(), t: Date.now() };
    o.setMark(m); haptic();
    state = 'here'; no.textContent = String(m.page + 1); el.classList.add('set'); el.dataset.s = 'here';
    // knackig: weiter nach unten schnappen und mit Feder zurück auf „eingerastet“
    springTo(DROP.here, { stiffness: 620, damping: 15, sway: 0 });
    el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
    hideResume();
    o.onChange?.();
  };
  const clear = () => {
    o.setMark(null); haptic();
    state = 'none'; el.classList.remove('set'); el.dataset.s = 'none';
    springTo(DROP.none, { stiffness: 380, damping: 26 });
    toast('Lesezeichen entfernt');
    o.onChange?.();
  };

  // ---- kleines Menü (Lesezeichen liegt woanders) ----
  const hidePop = () => { if (!pop) return; const p = pop; pop = null; p.classList.remove('show'); setTimeout(() => p.remove(), 220); };
  const showPop = () => {
    const m = o.mark(); if (!m) return;
    hidePop();
    pop = document.createElement('div'); pop.className = 'rb-pop';
    pop.innerHTML = `<button data-go>${icon('chevronRight')}<span>Zu Seite ${m.page + 1}</span></button><button data-set>${icon('bookmark')}<span>Hier setzen</span></button>`;
    pop.style.top = (parseFloat(el.style.top) || 0) + DROP.away + 10 + 'px';
    o.root.appendChild(pop);
    requestAnimationFrame(() => pop?.classList.add('show'));
    pop.querySelector('[data-go]').onclick = () => { hidePop(); haptic(); o.jump(m); };
    pop.querySelector('[data-set]').onclick = () => { hidePop(); setHere(); };
  };
  document.addEventListener('pointerdown', e => { if (pop && !pop.contains(e.target) && !el.contains(e.target)) hidePop(); }, true);

  // ---- Ziehen / Tippen ----
  let g = null;
  el.addEventListener('pointerdown', e => {
    e.stopPropagation();
    anim?.cancel(); anim = null; place(cur);
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, base: cur, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dy = e.clientY - g.y, dx = e.clientX - g.x;
    if (Math.abs(dy) > 5 || Math.abs(dx) > 5) g.moved = true;
    if (!g.moved) return;
    // Stoff dehnt sich nach unten (gedämpft), nach oben kaum
    const y = dy > 0 ? g.base + dy * 0.62 / (1 + dy / 260) : g.base + dy * 0.18;
    cur = Math.max(10, y);
    mv.style.transform = `translate3d(0,${(cur - H).toFixed(1)}px,0) rotate(${Math.max(-7, Math.min(7, dx * 0.12)).toFixed(2)}deg)`;
    g.dx = dx; g.dy = dy;
  });
  const end = e => {
    if (!g || (e && e.pointerId !== g.id)) return;
    const t = g; g = null;
    if (!t.moved) {                                      // Tippen
      const m = o.mark();
      if (!m) return setHere();
      if (state === 'here') return clear();
      return showPop();
    }
    if (t.dy > 20) return setHere();                     // kurz nach unten gezogen → einrasten
    springTo(DROP[state], { stiffness: 480, damping: 20, sway: Math.max(-7, Math.min(7, (t.dx || 0) * 0.12)) });
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('click', e => e.stopPropagation());

  // ---- „Weiter bei Seite …“ ----
  const hideResume = () => { if (!resume) return; const r = resume; resume = null; r.classList.remove('show'); setTimeout(() => r.remove(), 300); };
  const offerResume = () => {
    const m = o.mark(); hideResume();
    if (!m || o.count() < 4 || (m.page === 0 && m.frac < 0.2)) return;
    resume = document.createElement('button'); resume.className = 'rb-resume';
    resume.innerHTML = `${icon('bookmark')}<span>Weiter bei Seite ${m.page + 1}</span>${icon('chevronRight')}`;
    o.root.appendChild(resume);
    requestAnimationFrame(() => requestAnimationFrame(() => resume?.classList.add('show')));
    resume.onclick = () => { haptic(); hideResume(); o.jump(m); };
    const r = resume; setTimeout(() => { if (resume === r) hideResume(); }, 8000);
  };

  return {
    sync, offerResume, hideResume, hidePop,
    setTop(px) { el.style.top = px + 'px'; },
    reset() { hidePop(); hideResume(); state = ''; sync(true); },
  };
}

// ---------- Fortschrittsring (Seitenanzeige) ----------
const C = 2 * Math.PI * 7;
export function ringHtml() {
  return `<svg class="pc-ring" viewBox="0 0 18 18" aria-hidden="true"><circle class="pc-track" cx="9" cy="9" r="7"/><circle class="pc-bar" cx="9" cy="9" r="7" transform="rotate(-90 9 9)" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}"/><circle class="pc-mark" cx="9" cy="2" r="1.9" style="opacity:0"/></svg>`;
}
/** p = Fortschritt 0…1, mark = Position des Lesezeichens 0…1 oder null */
export function setRing(svg, p, mark) {
  if (!svg) return;
  svg.querySelector('.pc-bar').setAttribute('stroke-dashoffset', (C * (1 - Math.max(0, Math.min(1, p)))).toFixed(2));
  const mk = svg.querySelector('.pc-mark');
  if (mark == null) mk.style.opacity = '0';
  else { mk.style.opacity = '1'; mk.setAttribute('transform', `rotate(${(mark * 360).toFixed(1)} 9 9)`); }
}
