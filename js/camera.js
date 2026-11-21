// ================= Live-Scanner: Kamera mit Rahmenerkennung =================
// Die Kamera läuft direkt in der App. Alle ~120 ms wird ein verkleinertes Bild auf ein
// Dokument untersucht, der Rahmen wird live eingeblendet. „Auto“ löst aus, sobald das
// Blatt ruhig erkannt ist. Ergebnis: Liste von { img: Canvas, corners, rot }.
import { icon } from './icons.js';
import { haptic, toast } from './ui.js';
import { detectQuad, FULL, render } from './scanner.js';

export const cameraSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

const AUTO_KEY = 'nibvion.camAuto';

export function liveScanner({ startCount = 0 } = {}) {
  return new Promise(async resolve => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
    } catch (e) {
      console.warn(e);
      return resolve(null);           // Aufrufer weicht auf die normale Kamera-Auswahl aus
    }
    const track = stream.getVideoTracks()[0];
    let auto = localStorage.getItem(AUTO_KEY) !== '0';
    let torch = false;
    const items = [];

    const wrap = document.createElement('div');
    wrap.className = 'cam-wrap';
    wrap.innerHTML = `
      <div class="cam-top">
        <button class="cam-round" data-x aria-label="Schließen">${icon('x')}</button>
        <div class="cam-top-r">
          <button class="cam-round" data-torch aria-label="Licht" hidden>${icon('flash')}</button>
          <button class="cam-pill ${auto ? 'on' : ''}" data-auto>Auto</button>
        </div>
      </div>
      <div class="cam-stage">
        <video playsinline muted autoplay></video>
        <svg class="cam-svg"><polygon class="cam-quad"/></svg>
        <div class="cam-flash"></div>
        <div class="cam-hint">Dokument ins Bild halten</div>
      </div>
      <div class="cam-bottom">
        <button class="cam-thumb" data-done aria-label="Fertig"><span class="cam-badge"></span></button>
        <button class="cam-shutter" data-shot aria-label="Aufnehmen"><span></span></button>
        <button class="cam-done" data-done>Fertig</button>
      </div>`;
    document.body.appendChild(wrap);
    const video = wrap.querySelector('video'), svg = wrap.querySelector('.cam-svg'), poly = wrap.querySelector('.cam-quad');
    const hint = wrap.querySelector('.cam-hint'), stage = wrap.querySelector('.cam-stage');
    const thumbBtn = wrap.querySelector('.cam-thumb'), badge = wrap.querySelector('.cam-badge');
    video.srcObject = stream;
    try { await video.play(); } catch {}

    // Licht (nur wenn die Kamera es anbietet)
    try {
      if (track.getCapabilities && track.getCapabilities().torch) {
        const tb = wrap.querySelector('[data-torch]'); tb.hidden = false;
        tb.onclick = async () => {
          torch = !torch;
          try { await track.applyConstraints({ advanced: [{ torch }] }); tb.classList.toggle('on', torch); } catch { torch = false; }
        };
      }
    } catch {}

    const updThumb = () => {
      const n = startCount + items.length;
      badge.textContent = n || '';
      thumbBtn.classList.toggle('has', n > 0);
      wrap.querySelector('.cam-done').classList.toggle('show', n > 0);
      if (items.length) {
        const last = items[items.length - 1];
        thumbBtn.style.backgroundImage = `url(${render(last, 'color', 160).toDataURL('image/jpeg', 0.7)})`;
      }
    };
    updThumb();

    // Videokoordinaten (normiert) → Bildschirm (object-fit: cover)
    const toScreen = ([nx, ny]) => {
      const sw = stage.clientWidth, sh = stage.clientHeight, vw = video.videoWidth || 1, vh = video.videoHeight || 1;
      const s = Math.max(sw / vw, sh / vh), ox = (sw - vw * s) / 2, oy = (sh - vh * s) / 2;
      return [nx * vw * s + ox, ny * vh * s + oy];
    };

    let quad = null, shown = null, stable = 0, armed = true, running = true, last = 0, busy = false;
    const small = document.createElement('canvas');
    const moved = (a, b) => !a || !b ? 1 : Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

    const loop = t => {
      if (!running) return;
      requestAnimationFrame(loop);
      if (video.readyState >= 2 && t - last > 120 && !busy) {
        last = t;
        const vw = video.videoWidth, vh = video.videoHeight, k = 320 / Math.max(vw, vh);
        small.width = Math.round(vw * k); small.height = Math.round(vh * k);
        small.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, small.width, small.height);
        const q = detectQuad(small, 320);
        const mv = moved(q, quad);
        if (q && mv < 0.025) stable++; else stable = 0;
        if (!q || mv > 0.08) armed = true;
        quad = q;
        if (!q) hint.textContent = 'Dokument ins Bild halten';
        else if (auto && armed) hint.textContent = stable >= 3 ? 'Ruhig halten …' : 'Dokument erkannt';
        else hint.textContent = 'Dokument erkannt – auslösen';
        hint.classList.toggle('ok', !!q);
        if (auto && armed && q && stable >= 7) { armed = false; stable = 0; shoot(); }
      }
      // Rahmen weich nachführen
      const sw = stage.clientWidth, sh = stage.clientHeight;
      svg.setAttribute('viewBox', `0 0 ${sw} ${sh}`);
      if (quad) {
        const target = quad.map(toScreen);
        shown = shown ? shown.map((p, i) => [p[0] + (target[i][0] - p[0]) * 0.35, p[1] + (target[i][1] - p[1]) * 0.35]) : target;
        poly.setAttribute('points', shown.map(p => p.join(',')).join(' '));
        poly.classList.add('show');
        poly.classList.toggle('steady', auto && stable >= 3);
      } else { poly.classList.remove('show'); shown = null; }
    };
    requestAnimationFrame(loop);

    const shoot = () => {
      if (video.readyState < 2 || busy) return;
      busy = true;
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      const corners = detectQuad(c, 480) || quad || FULL.map(p => [...p]);
      items.push({ img: c, corners, rot: 0 });
      haptic();
      const fl = wrap.querySelector('.cam-flash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
      thumbBtn.classList.remove('pop'); void thumbBtn.offsetWidth; thumbBtn.classList.add('pop');
      updThumb();
      setTimeout(() => { busy = false; }, 500);
    };

    const close = v => {
      running = false;
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), 250);
      resolve(v);
    };
    wrap.querySelector('[data-shot]').onclick = shoot;
    wrap.querySelectorAll('[data-done]').forEach(b => b.onclick = () => close(items));
    wrap.querySelector('[data-x]').onclick = () => close(items.length ? items : []);
    wrap.querySelector('[data-auto]').onclick = e => {
      auto = !auto; localStorage.setItem(AUTO_KEY, auto ? '1' : '0');
      e.currentTarget.classList.toggle('on', auto); haptic();
      toast(auto ? 'Automatisch auslösen: an' : 'Automatisch auslösen: aus');
    };
    // App im Hintergrund → Kamera freigeben
    const vis = () => { if (document.hidden) close(items); };
    document.addEventListener('visibilitychange', vis, { once: true });
  });
}
