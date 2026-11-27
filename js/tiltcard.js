// ================= Kippkarte („Apple Wallet“) =================
// Schwebende 3D-Vorschau der ersten Seite: Finger (Pointer) oder Neigung des iPhones
// (DeviceOrientation) kippt die Karte, ein weicher Glanz-Reflex gleitet über das Cover,
// der Tiefenschatten wandert gegenläufig mit. Alles nur transform/opacity → GPU, 60 FPS.
// Die Bewegung läuft über eine kritisch gedämpfte Feder und stoppt, sobald sie ruht.
// Bei „Bewegung reduzieren“ bleibt die Karte ruhig stehen (nur Schatten).
import { reducedMotion } from './fx.js';
import { esc } from './ui.js';

const MAX = 14;             // maximale Neigung in Grad
let gyroAllowed = null;     // null = noch nicht gefragt, true/false = Antwort (iOS fragt einmal je Sitzung)

/**
 * tiltCard(host, { src, ratio, label }) → { setSrc(url), destroy() }
 * host: leerer Container; src: Bild-URL der Seite; ratio: Breite/Höhe der Seite
 */
export function tiltCard(host, { src = '', ratio = 0.707, label = '' } = {}) {
  host.classList.add('tilt-wrap', 'no-swipe');
  host.innerHTML = `<div class="tilt-stage">
      <div class="tilt-shadow"></div>
      <div class="tilt-card" style="aspect-ratio:${Math.max(0.3, Math.min(3, ratio)).toFixed(4)}">
        <img alt="" draggable="false" ${src ? `src="${esc(src)}"` : ''}>
        <div class="tilt-glare"></div><div class="tilt-edge"></div>
      </div>
    </div>${label ? `<div class="tilt-label">${esc(label)}</div>` : ''}`;
  const stage = host.querySelector('.tilt-stage'), card = host.querySelector('.tilt-card');
  const shadow = host.querySelector('.tilt-shadow'), glare = host.querySelector('.tilt-glare'), img = card.querySelector('img');
  img.onload = () => card.classList.add('ready');
  if (src && img.complete) card.classList.add('ready');
  const still = reducedMotion();

  // Zustand: Ziel (tx, ty) und Ist-Wert (x, y) in −1 … 1, Geschwindigkeit (vx, vy)
  const S = { tx: 0, ty: 0, x: 0, y: 0, vx: 0, vy: 0, touch: false, raf: 0, last: 0, gyro: null, base: null, dead: false };

  const paint = () => {
    const rx = (-S.y * MAX).toFixed(2), ry = (S.x * MAX).toFixed(2);
    const m = Math.min(1, Math.hypot(S.x, S.y));
    card.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg) translateZ(0)`;
    // Glanz: Licht kommt von oben-links → Reflex wandert entgegen der Neigung
    glare.style.transform = `translate3d(${(-S.x * 38).toFixed(1)}%, ${(-S.y * 38).toFixed(1)}%, 0)`;
    glare.style.opacity = (0.18 + m * 0.62).toFixed(3);
    shadow.style.transform = `translate3d(${(-S.x * 16).toFixed(1)}px, ${(18 - S.y * 10).toFixed(1)}px, 0) scale(${(0.92 - m * 0.04).toFixed(3)})`;
    shadow.style.opacity = (0.55 - m * 0.12).toFixed(3);
  };

  // Feder: stiffness 170, damping ≈ kritisch → weich, kaum Nachwippen
  const K = 170, D = 2 * Math.sqrt(K) * 0.82;
  const step = now => {
    S.raf = 0; if (S.dead) return;
    const dt = Math.min(1 / 30, (now - (S.last || now)) / 1000 || 1 / 60); S.last = now;
    S.vx += ((S.tx - S.x) * K - S.vx * D) * dt; S.vy += ((S.ty - S.y) * K - S.vy * D) * dt;
    S.x += S.vx * dt; S.y += S.vy * dt;
    paint();
    if (Math.abs(S.tx - S.x) + Math.abs(S.ty - S.y) + Math.abs(S.vx) + Math.abs(S.vy) > 0.0015) S.raf = requestAnimationFrame(step);
    else { S.x = S.tx; S.y = S.ty; S.vx = S.vy = 0; S.last = 0; paint(); }
  };
  const kick = () => { if (!still && !S.raf && !S.dead) { S.last = 0; S.raf = requestAnimationFrame(step); } };
  const target = (x, y) => { S.tx = Math.max(-1, Math.min(1, x)); S.ty = Math.max(-1, Math.min(1, y)); kick(); };

  // ---- Finger / Maus ----
  const fromPointer = e => {
    const r = stage.getBoundingClientRect();
    target(((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2);
  };
  const onDown = e => {
    if (still) return;
    S.touch = true; card.classList.add('touch');
    try { stage.setPointerCapture(e.pointerId); } catch {}
    askGyro();
    fromPointer(e);
  };
  const onMove = e => { if (still) return; if (S.touch || e.pointerType === 'mouse') fromPointer(e); };
  const onUp = () => { S.touch = false; card.classList.remove('touch'); if (!S.gyro) target(0, 0); else applyGyro(); };
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') onUp(); });

  // ---- Neigung (optional) ----
  // Bezugslage = erste Messung → so wie man das iPhone gerade hält, liegt die Karte flach.
  const applyGyro = () => {
    if (S.touch || !S.gyro || !S.base) return;
    const dx = (S.gyro.g - S.base.g) / 22, dy = (S.gyro.b - S.base.b) / 22;
    target(dx, dy);
  };
  const onOrient = e => {
    if (e.beta == null || e.gamma == null) return;
    S.gyro = { b: e.beta, g: e.gamma };
    if (!S.base) S.base = { ...S.gyro };
    // Bezugslage gleitet langsam nach (wer das iPhone dauerhaft anders hält, landet wieder bei flach)
    S.base.b += (S.gyro.b - S.base.b) * 0.004; S.base.g += (S.gyro.g - S.base.g) * 0.004;
    applyGyro();
  };
  const startGyro = () => { if (!still && !S.dead && !S.listening) { S.listening = true; addEventListener('deviceorientation', onOrient); } };
  function askGyro() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE || gyroAllowed === false) return;
    if (gyroAllowed) return startGyro();
    if (typeof DOE.requestPermission === 'function') {
      // iOS: Frage nur direkt nach einem Tipp möglich
      DOE.requestPermission().then(r => { gyroAllowed = r === 'granted'; if (gyroAllowed) startGyro(); }).catch(() => { gyroAllowed = false; });
    } else { gyroAllowed = true; startGyro(); }
  }
  // Android / Desktop: ohne Rückfrage → sofort; iOS: erst nach Erlaubnis (beim ersten Antippen)
  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission !== 'function' && matchMedia('(pointer: coarse)').matches) { gyroAllowed = true; startGyro(); }
  else if (gyroAllowed) startGyro();

  // Begrüßung: kurz einmal schwingen, damit man sieht, dass die Karte lebt
  if (!still) setTimeout(() => { if (!S.touch && !S.gyro) { S.vx = 3.2; S.vy = -2.2; kick(); } }, 380);
  paint();

  return {
    setSrc(url) { if (!url) return; img.onload = () => card.classList.add('ready'); img.src = url; },
    destroy() { S.dead = true; cancelAnimationFrame(S.raf); if (S.listening) removeEventListener('deviceorientation', onOrient); },
  };
}

/** Vorschau-Bild der ersten Seite rendern (Breite in CSS-px × Pixeldichte) */
export async function coverImage(pdf, cssW = 220) {
  const { renderThumb } = await import('./pdfcore.js');
  const w = Math.round(cssW * Math.min(3, Math.max(2, devicePixelRatio || 2)));
  return renderThumb(pdf, 1, w);
}

/** Seitenverhältnis der ersten Seite (berücksichtigt Drehung) */
export async function coverRatio(pdf) {
  try { const p = await pdf.getPage(1); const v = p.getViewport({ scale: 1 }); return v.width / v.height; } catch { return 0.707; }
}

// ================= Teilen-/Export-Dialog mit Kippkarte =================
/**
 * shareDialog({ name, sub, ratio, cover: () => Promise<url>, thumb, getBytes: () => Promise<Uint8Array>,
 *               share(bytes, name), download(bytes, name), extra: [{ id, label, icon, run }] })
 * Die Bytes werden schon beim Öffnen vorbereitet – so ist „Teilen“ beim Tippen sofort bereit
 * (iOS erlaubt navigator.share nur direkt nach einem Tipp).
 */
export async function shareDialog({ name, sub = '', ratio = 0.707, cover, thumb = '', getBytes, share, download }) {
  const { sheet, busy, toast, haptic } = await import('./ui.js');
  const { icon } = await import('./icons.js');
  let bytesP = null;
  const prep = () => (bytesP ??= getBytes().catch(e => { bytesP = null; throw e; }));
  prep().catch(() => {});
  let card = null;
  const run = async (fn, api) => {
    haptic();
    try {
      let b = null;
      const ready = await Promise.race([prep(), new Promise(r => setTimeout(() => r(null), 30))]);
      if (ready) b = ready; else { busy(true, 'PDF wird erstellt …'); b = await prep(); busy(false); }
      api.close(); await fn(b, name);
    } catch (e) { console.error(e); busy(false); toast('Das hat nicht geklappt', true); }
  };
  sheet({
    title: 'Teilen',
    html: `<div class="share-card" data-card></div>
      <div class="share-meta"><b>${esc(name)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
      <div class="btn-row share-btns">
        <button class="btn" data-dl>${icon('download')} Sichern</button>
        <button class="btn primary" data-sh>${icon('share')} Teilen</button>
      </div>`,
    onMount(el, api) {
      card = tiltCard(el.querySelector('[data-card]'), { src: thumb, ratio });
      cover?.().then(u => card?.setSrc(u)).catch(() => {});
      el.querySelector('[data-sh]').onclick = () => run(share, api);
      el.querySelector('[data-dl]').onclick = () => run(download, api);
    },
    onClose: () => { card?.destroy(); card = null; },
  });
}
