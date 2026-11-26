// ================= Nibvion FX – Federphysik, Stempel, Scan-Laser, Glanz, Verpuffen =================
// Alles läuft über transform/opacity (GPU) bzw. Canvas. Bei „Bewegung reduzieren“ (iOS-Einstellung)
// werden die Effekte übersprungen oder auf ein kurzes Überblenden reduziert.
export const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

// ---------------------------------------------------------------------------------
// Feder (gedämpfter harmonischer Oszillator) – liefert Werte 0 → 1 über die Zeit
// ---------------------------------------------------------------------------------
/** spring({ stiffness, damping, mass }) → { at(t in s) → 0..1(+Überschwingen), dur (s) } */
export function spring({ stiffness = 260, damping = 24, mass = 1, velocity = 0 } = {}) {
  const w0 = Math.sqrt(stiffness / mass), zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const v0 = -velocity;
  let at;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    at = t => 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0 - v0) / wd) * Math.sin(wd * t));
  } else {
    at = t => 1 - Math.exp(-w0 * t) * (1 + (w0 - v0) * t);
  }
  // Dauer: bis die Feder auf 0,1 % ruht
  let dur = 0;
  for (let t = 0; t < 4; t += 1 / 120) { if (Math.abs(1 - at(t)) > 0.001) dur = t; }
  return { at, dur: Math.max(0.12, dur + 1 / 60) };
}

/** CSS-`linear()`-Easing aus einer Feder (Safari 17.2+); sonst Fallback-cubic-bezier */
export function springCss(opts, fallback = 'cubic-bezier(.32,1.15,.4,1)') {
  const s = spring(opts);
  let ok = false;
  try { ok = CSS.supports('transition-timing-function', 'linear(0, 1)'); } catch {}
  if (!ok) return { easing: fallback, ms: Math.round(Math.min(600, s.dur * 1000)) };
  const n = 48, pts = [];
  for (let k = 0; k <= n; k++) pts.push(+s.at((k / n) * s.dur).toFixed(4));
  pts[n] = 1;
  return { easing: `linear(${pts.join(', ')})`, ms: Math.round(s.dur * 1000) };
}

/** Keyframes für WAAPI aus einer Feder: map(v) → Keyframe-Objekt */
export function springFrames(opts, map, steps = 40) {
  const s = spring(opts), out = [];
  for (let k = 0; k <= steps; k++) { const t = k / steps; out.push({ ...map(k === steps ? 1 : s.at(t * s.dur), t), offset: t }); }
  return { frames: out, ms: Math.round(s.dur * 1000) };
}

// Globale Federn als CSS-Variablen (Sheets, Werkzeugleisten, Menüs)
export function installSprings() {
  const root = document.documentElement.style;
  const sheetIn = springCss({ stiffness: 320, damping: 30 });           // iOS-Sheet: weich, kaum Überschwingen
  const pop = springCss({ stiffness: 420, damping: 22 });               // Werkzeuge, Menüs: knackig
  root.setProperty('--spring-sheet', sheetIn.easing); root.setProperty('--spring-sheet-ms', sheetIn.ms + 'ms');
  root.setProperty('--spring-pop', pop.easing); root.setProperty('--spring-pop-ms', pop.ms + 'ms');
}

// ---------------------------------------------------------------------------------
// Stempel: Absenken mit Feder + Tinten-Ring
// ---------------------------------------------------------------------------------
/**
 * Lässt einen Stempel auf die Seite „fallen“. `host` ist das Seiten-Element (position:relative),
 * `box` die Position in CSS-Pixeln relativ zu host, `src` das Stempelbild.
 * `hide`/`show` blenden das echte Objekt währenddessen aus.
 */
export function stampDrop(host, box, src, { hide, show, color = '#ff6a5b', onImpact } = {}) {
  if (!host || reducedMotion() || !host.animate) { onImpact && onImpact(); return Promise.resolve(); }
  hide && hide();
  const g = document.createElement('div');
  g.className = 'fx-stamp';
  g.style.cssText = `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`;
  g.innerHTML = `<img alt="" src="${src}"><i class="fx-stamp-shadow"></i>`;
  host.appendChild(g);
  const img = g.firstChild, sh = g.lastChild;

  // Phase 1: angehoben (groß, Schatten weit) → Phase 2: Aufsetzen mit Feder (Überschwingen < 1)
  const lift = 160;
  const fall = img.animate([
    { transform: 'translate3d(0,-14px,0) scale(1.38)', opacity: 0 },
    { transform: 'translate3d(0,-10px,0) scale(1.3)', opacity: 1, offset: 0.35 },
    { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
  ], { duration: lift, easing: 'cubic-bezier(.55,0,.9,.4)', fill: 'forwards' });
  sh.animate([{ opacity: 0, transform: 'scale(1.25)' }, { opacity: .55, transform: 'scale(1.05)' }], { duration: lift, fill: 'forwards' });

  return new Promise(res => {
    fall.finished.catch(() => {}).then(() => {
      onImpact && onImpact();
      ripple(host, box.x + box.w / 2, box.y + box.h / 2, Math.max(box.w, box.h), color);
      // Nachfedern: Stauchung 0,93 → 1,03 → 1
      const sp = springFrames({ stiffness: 700, damping: 16 }, v => {
        const s = 0.9 + 0.1 * v;
        return { transform: `translate3d(0,0,0) scale(${s.toFixed(4)}, ${(0.86 + 0.14 * v).toFixed(4)})` };
      });
      const settle = img.animate(sp.frames, { duration: sp.ms, fill: 'forwards' });
      sh.animate([{ opacity: .55 }, { opacity: 0 }], { duration: sp.ms, fill: 'forwards' });
      settle.finished.catch(() => {}).then(() => { show && show(); requestAnimationFrame(() => g.remove()); res(); });
    });
  });
}

/** Tinten-Ring (koralle) an einer Stelle */
export function ripple(host, cx, cy, size = 80, color = '#ff6a5b') {
  if (!host || reducedMotion() || !host.animate) return;
  for (const [k, delay] of [[1, 0], [0.62, 70]]) {
    const r = document.createElement('i');
    r.className = 'fx-ripple';
    const d = size * 1.1;
    r.style.cssText = `left:${cx - d / 2}px;top:${cy - d / 2}px;width:${d}px;height:${d}px;--c:${color}`;
    host.appendChild(r);
    r.animate([
      { transform: 'scale(.35)', opacity: .75 * k },
      { transform: `scale(${1.25 + k * 0.6})`, opacity: 0 },
    ], { duration: 620, delay, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'both' }).finished.catch(() => {}).then(() => r.remove());
  }
}

// ---------------------------------------------------------------------------------
// Lichtglanz über ein Element (einmal)
// ---------------------------------------------------------------------------------
export function shine(target, ms = 720) {
  if (!target || reducedMotion() || !target.animate) return Promise.resolve();
  const s = document.createElement('i'); s.className = 'fx-shine';
  target.appendChild(s);
  const a = s.animate([{ transform: 'translate3d(-120%,0,0) skewX(-18deg)', opacity: 0 }, { opacity: 1, offset: .2 }, { opacity: 1, offset: .8 }, { transform: 'translate3d(220%,0,0) skewX(-18deg)', opacity: 0 }],
    { duration: ms, easing: 'cubic-bezier(.4,0,.2,1)' });
  return a.finished.catch(() => {}).then(() => s.remove());
}

// ---------------------------------------------------------------------------------
// Scan-Laser über einem Bild (Canvas-Glow + transform)
// ---------------------------------------------------------------------------------
/**
 * Legt über `target` (Bild/Element) einen leuchtenden Laserstrahl, der auf und ab gleitet.
 * `host` muss position:relative haben und target enthalten. Gibt stop() zurück.
 */
export function scanLaser(host, target = host) {
  if (!host) return () => {};
  const ov = document.createElement('div'); ov.className = 'fx-laser';
  ov.innerHTML = `<div class="fx-laser-tint"></div><div class="fx-laser-beam"><canvas></canvas></div>`;
  host.appendChild(ov);
  const place = () => {
    // Layout-Maße (unabhängig von laufenden transform-Animationen des Containers)
    if (target === host) { ov.style.cssText = 'left:0;top:0;right:0;bottom:0'; return; }
    if (target.offsetParent === host) {
      if (!target.offsetWidth) return;
      ov.style.cssText = `left:${target.offsetLeft}px;top:${target.offsetTop}px;width:${target.offsetWidth}px;height:${target.offsetHeight}px`;
      return;
    }
    const hr = host.getBoundingClientRect(), tr = target.getBoundingClientRect();
    if (!tr.width) return;
    ov.style.cssText = `left:${tr.left - hr.left + host.scrollLeft}px;top:${tr.top - hr.top + host.scrollTop}px;width:${tr.width}px;height:${tr.height}px`;
  };
  place();
  // Strahl einmal ins Canvas zeichnen (weicher Glow) – bewegt wird nur per transform
  const beam = ov.querySelector('.fx-laser-beam'), cv = beam.querySelector('canvas');
  const draw = () => {
    const w = Math.max(40, ov.clientWidth), h = 64, dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const glow = g.createLinearGradient(0, 0, 0, h);
    glow.addColorStop(0, 'rgba(255,106,91,0)'); glow.addColorStop(.5, 'rgba(255,106,91,.38)'); glow.addColorStop(1, 'rgba(255,106,91,0)');
    g.fillStyle = glow; g.fillRect(0, 0, w, h);
    const side = g.createLinearGradient(0, 0, w, 0);
    side.addColorStop(0, 'rgba(255,170,120,0)'); side.addColorStop(.12, 'rgba(255,190,150,1)'); side.addColorStop(.88, 'rgba(255,190,150,1)'); side.addColorStop(1, 'rgba(255,170,120,0)');
    g.shadowColor = 'rgba(255,106,91,.95)'; g.shadowBlur = 12;
    g.fillStyle = side; g.fillRect(0, h / 2 - 1.2, w, 2.4);
    g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(w * .1, h / 2 - .5, w * .8, 1);
  };
  draw();
  let anim = null;
  const run = () => {
    anim?.cancel();
    if (reducedMotion()) { beam.style.transform = `translate3d(0,${ov.clientHeight / 2 - 32}px,0)`; ov.classList.add('still'); return; }
    const H = ov.clientHeight;
    anim = beam.animate([{ transform: 'translate3d(0,-32px,0)' }, { transform: `translate3d(0,${H - 32}px,0)` }],
      { duration: Math.max(1100, Math.min(2200, H * 4)), iterations: Infinity, direction: 'alternate', easing: 'cubic-bezier(.45,.05,.55,.95)' });
  };
  requestAnimationFrame(() => { ov.classList.add('on'); run(); });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { place(); draw(); run(); }) : null;
  ro?.observe(target);
  return () => {
    ro?.disconnect();
    ov.classList.remove('on'); ov.classList.add('out');
    setTimeout(() => { anim?.cancel(); ov.remove(); }, 320);
  };
}

// ---------------------------------------------------------------------------------
// Verpuffen (Wegschnippen) + FLIP-Nachrücken
// ---------------------------------------------------------------------------------
/** Element nach oben wegschnippen und in Partikeln verpuffen lassen */
export function poof(el, { vy = -1.2, dx = 0 } = {}) {
  if (!el || reducedMotion() || !el.animate) return Promise.resolve();
  const r = el.getBoundingClientRect();
  const fly = el.animate([
    { transform: el.style.transform || 'none', opacity: 1, filter: 'blur(0)' },
    { transform: `translate3d(${dx * 0.4}px,${-r.height * 0.9 + Math.min(0, vy) * 40}px,0) scale(.55) rotate(${dx > 0 ? 8 : -8}deg)`, opacity: 0 },
  ], { duration: 300, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'forwards' });
  // Partikel (Canvas, kurz)
  const cv = document.createElement('canvas'); cv.className = 'fx-puff';
  const S = Math.max(r.width, r.height) * 2, dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = S * dpr; cv.height = S * dpr;
  cv.style.cssText = `left:${r.left + r.width / 2 - S / 2}px;top:${r.top + r.height * 0.15 - S / 2}px;width:${S}px;height:${S}px`;
  document.body.appendChild(cv);
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const parts = Array.from({ length: 26 }, () => {
    const a = Math.random() * Math.PI * 2, v = 40 + Math.random() * 110;
    return { x: S / 2 + (Math.random() - .5) * r.width * .6, y: S / 2 + (Math.random() - .5) * r.height * .25, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, r: 2 + Math.random() * 5, c: Math.random() < .5 ? '255,106,91' : Math.random() < .5 ? '255,179,71' : '200,205,214' };
  });
  const t0 = performance.now(), D = 560;
  const step = now => {
    const t = (now - t0) / D, dt = 1 / 60;
    g.clearRect(0, 0, S, S);
    if (t >= 1) { cv.remove(); return; }
    for (const p of parts) {
      p.vx *= .96; p.vy = p.vy * .96 + 30 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      g.fillStyle = `rgba(${p.c},${(1 - t) * .85})`;
      g.beginPath(); g.arc(p.x, p.y, p.r * (1 - t * .6), 0, 7); g.fill();
    }
    requestAnimationFrame(step);
  };
  setTimeout(() => requestAnimationFrame(step), 120);
  return fly.finished.catch(() => {});
}

/** FLIP: Positionen merken → DOM ändern → mit Feder an neue Stellen gleiten */
export function flipCapture(els) {
  const m = new Map();
  els.forEach(e => { const k = e.dataset.flip; if (k) m.set(k, e.getBoundingClientRect()); });
  return m;
}
export function flipPlay(container, before) {
  if (reducedMotion()) return;
  const sp = springFrames({ stiffness: 380, damping: 28 }, v => ({ v }));
  container.querySelectorAll('[data-flip]').forEach(e => {
    const a = before.get(e.dataset.flip); if (!a || !e.animate) return;
    const b = e.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    e.animate(sp.frames.map(f => ({ transform: `translate3d(${(dx * (1 - f.v)).toFixed(2)}px,${(dy * (1 - f.v)).toFixed(2)}px,0)`, offset: f.offset })), { duration: sp.ms });
  });
}

// Federnde Einblend-Keyframes für WAAPI (gedämpfte Feder ζ≈0.42, kurzes Überschwingen wie iOS „bouncy“).
// base = Grund-Transform (z. B. Zentrierung), from = Start-Skalierung
export const springKeys = (from, base, n = 22) => {
  // gedämpfte Feder ζ≈0.42: kräftiges, kurzes Überschwingen (≈ iOS „bouncy“)
  const z = 0.42, w = 26, wd = w * Math.sqrt(1 - z * z), T = 0.5, out = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n * T, e = k === n ? 1 : 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + z * w / wd * Math.sin(wd * t));
    const sc = from + (1 - from) * e;
    out.push({ transform: `${base} scale(${sc.toFixed(4)})`, opacity: Math.min(1, k / 4) });
  }
  return out;
};
