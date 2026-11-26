// ================= 3D-Umblättern (wie Apple Bücher) =================
// Die umgeschlagene Seite („Blatt“) besteht aus N senkrechten Streifen, die ineinander verschachtelt
// je ein Stück weiter um die Y-Achse gedreht sind (preserve-3d). Dadurch biegt sich das Papier
// beim Blättern rund durch. Pro Bild werden nur transform und opacity gesetzt (GPU), dazu ein
// mitlaufender Falz-Schatten auf der darunterliegenden Seite. Rückseite: durchscheinendes Papier.
//
// createFlip({ book, surface, strips, face(i, x0, sw, W, H) → Element, setBase(i), count(), index(),
//              commit(i), onTap(xRatio) }) → { go(dir), destroy(), busy() }
import { reducedMotion } from './fx.js';

const MAX_BEND = 46;           // stärkste Durchbiegung (Grad, über alle Streifen) in der Mitte des Umblätterns
const rad = d => d * Math.PI / 180;

export function createFlip(o) {
  const { book, surface = book, strips = 14 } = o;
  const host = document.createElement('div'); host.className = 'pf-leafhost';
  const cast = document.createElement('div'); cast.className = 'pf-cast';
  book.append(cast, host);

  let leaf = null;         // { strips: [{ el, dark, paper }], i }
  let A = 0, vA = 0;       // Winkel (0 = flach rechts, 180 = umgeschlagen links), Winkelgeschw. (°/s)
  let dir = 0, raf = 0, drag = null, from = 0;

  // ---------- Blatt bauen ----------
  function build(i) {
    clear();
    const W = book.clientWidth, H = book.clientHeight, n = reducedMotion() ? 1 : strips, sw = W / n;
    let parent = host;
    const list = [];
    for (let k = 0; k < n; k++) {
      const st = document.createElement('div'); st.className = 'pf-strip';
      st.style.cssText = `width:${sw + (k < n - 1 ? 1.5 : 0)}px;height:${H}px;left:${k ? sw : 0}px`;
      const f = document.createElement('div'); f.className = 'pf-face';
      f.appendChild(o.face(i, k * sw, sw + 1.5, W, H));
      const dark = document.createElement('i'); dark.className = 'pf-dark';
      const paper = document.createElement('i'); paper.className = 'pf-paper';
      f.append(dark, paper); st.appendChild(f); parent.appendChild(st); parent = st;
      list.push({ el: st, dark, paper });
    }
    leaf = { strips: list, i, W, sw };
    host.classList.add('on');
  }
  function clear() { host.textContent = ''; host.classList.remove('on'); leaf = null; cast.style.opacity = 0; }

  // ---------- Winkel anwenden ----------
  function apply() {
    if (!leaf) return;
    const n = leaf.strips.length, p = A / 180;
    const bend = n > 1 ? Math.sin(p * Math.PI) * MAX_BEND * (dir > 0 ? 1 : 0.85) : 0;
    const d = n > 1 ? bend / (n - 1) : 0, r0 = A - bend / 2;
    let edge = 0;
    for (let k = 0; k < n; k++) {
      const s = leaf.strips[k], a = r0 + k * d;
      s.el.style.transform = `rotateY(${(-(k ? d : r0)).toFixed(3)}deg)`;
      const c = Math.cos(rad(a)), sn = Math.abs(Math.sin(rad(a)));
      // Vorderseite dunkelt zur Biegung hin ab, Rückseite = durchscheinendes Papier mit leichtem Schatten
      s.dark.style.opacity = (c > 0 ? 0.34 * Math.pow(sn, 1.4) + 0.06 * (k / n) * sn : 0.14 * sn).toFixed(3);
      s.paper.style.opacity = c > 0 ? 0 : 0.9;
      edge += leaf.sw * c;
    }
    // Falz-Schatten auf der darunterliegenden Seite – wandert mit der Blattkante
    const W = leaf.W, s = Math.sin(rad(A));
    if (edge > 0) {
      cast.style.opacity = (0.9 * Math.min(1, s * 1.6)).toFixed(3);
      cast.style.transform = `translate3d(${edge.toFixed(1)}px,0,0) scaleX(${(0.35 + s * 1.2).toFixed(3)})`;
    } else {
      cast.style.opacity = (0.5 * s).toFixed(3);
      cast.style.transform = `translate3d(0,0,0) scaleX(${(0.25 + s * 0.6).toFixed(3)})`;
    }
    book.style.setProperty('--pf-lift', (s * 0.35).toFixed(3));
  }

  // ---------- Federanimation zum Ziel ----------
  function animateTo(target, done) {
    cancelAnimationFrame(raf);
    let last = performance.now();
    const k = 150, c = 2 * Math.sqrt(k) * 0.92;                     // leicht unterkritisch gedämpft
    const step = now => {
      const dt = Math.min(0.032, (now - last) / 1000); last = now;
      const acc = k * (target - A) - c * vA;
      vA += acc * dt; A += vA * dt;
      if (A > 180) { A = 180; vA = Math.min(0, vA) * -0.15; }        // kleines Abfedern am Anschlag
      if (A < 0) { A = 0; vA = Math.max(0, vA) * -0.15; }
      apply();
      if (Math.abs(target - A) < 0.25 && Math.abs(vA) < 8) { A = target; apply(); raf = 0; done(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  // ---------- Start / Ende ----------
  const can = d => { const i = o.index(); return d > 0 ? i < o.count() - 1 : i > 0; };
  function begin(d) {
    dir = d; vA = 0;
    const i = o.index();
    if (d > 0) { build(i); o.setBase(i + 1); A = 0; }
    else { build(i - 1); A = 180; }
    from = A; apply();
  }
  function finish(commit) {
    const i = o.index(), d = dir;
    const target = d > 0 ? (commit ? 180 : 0) : (commit ? 0 : 180);
    animateTo(target, () => {
      if (d > 0) { if (commit) o.commit(i + 1); else o.setBase(i); }
      else if (commit) { o.setBase(i - 1); o.commit(i - 1); }
      requestAnimationFrame(clear); dir = 0;
    });
  }

  // Ohne Bewegung (prefers-reduced-motion): kurzes Überblenden
  function instant(d) {
    const i = o.index() + d;
    book.animate?.([{ opacity: .4 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    o.setBase(i); o.commit(i);
  }

  function go(d) {
    if (raf || drag || !can(d)) return false;
    if (reducedMotion()) { instant(d); return true; }
    begin(d); vA = d > 0 ? 260 : -260; finish(true);
    return true;
  }

  // ---------- Gesten ----------
  const down = e => {
    if (e.button > 0 || drag) return;
    if (raf) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), lt: performance.now(), la: 0, d: 0, moved: false };
  };
  const move = e => {
    const g = drag; if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.d) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.1) { if (Math.hypot(dx, dy) > 10) g.moved = true; return; }
      g.moved = true;
      const d = dx < 0 ? 1 : -1;
      if (!can(d)) { g.d = 'blocked'; return; }
      g.d = d;
      if (!reducedMotion()) { try { surface.setPointerCapture(e.pointerId); } catch {} begin(d); }
    }
    if (g.d === 'blocked' || reducedMotion()) return;
    const W = book.clientWidth;
    // vorwärts folgt die Blattkante dem Finger, rückwärts kommt die Seite zügiger von links herein
    const edge = g.d > 0 ? W + dx * 1.3 : -W + dx * 2.1;
    const nA = Math.acos(Math.max(-1, Math.min(1, edge / W))) * 180 / Math.PI;
    const now = performance.now(), dt = Math.max(1, now - g.lt) / 1000;
    vA = vA * 0.6 + ((nA - A) / dt) * 0.4; g.lt = now;
    A = nA; apply();
  };
  const up = e => {
    const g = drag; if (!g || e.pointerId !== g.id) return;
    drag = null;
    if (!g.d) {
      if (!g.moved && performance.now() - g.t < 350) {
        const r = surface.getBoundingClientRect();
        o.onTap && o.onTap((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      }
      return;
    }
    if (g.d === 'blocked') { o.onEdge && o.onEdge(); return; }
    if (reducedMotion()) { instant(g.d); return; }
    const fling = Math.abs(vA) > 240;
    const commit = g.d > 0 ? (fling ? vA > 0 : A > 70) : (fling ? vA < 0 : A < 110);
    finish(e.type === 'pointercancel' ? false : commit);
  };
  surface.addEventListener('pointerdown', down);
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', up);
  surface.addEventListener('pointercancel', up);

  return {
    go,
    busy: () => !!(raf || drag),
    destroy() {
      cancelAnimationFrame(raf);
      surface.removeEventListener('pointerdown', down); surface.removeEventListener('pointermove', move);
      surface.removeEventListener('pointerup', up); surface.removeEventListener('pointercancel', up);
      host.remove(); cast.remove();
    },
  };
}
