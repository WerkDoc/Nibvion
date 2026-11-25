// ================= „Nibvion AI analysiert“ – Scan-Effekt (wie CamScanner) =================
// Abgedunkelte Seite, eine Lichtlinie läuft von oben nach unten, alles Geschriebene darüber
// schimmert türkis-blau, kleine Funken, in der Mitte ein drehender Ring mit Stern + Text.
import { reducedMotion } from './ui.js';

const STAR = '<svg viewBox="0 0 24 24"><path d="M12 1.5c.6 5.6 4.9 9.9 10.5 10.5-5.6.6-9.9 4.9-10.5 10.5C11.4 16.9 7.1 12.6 1.5 12 7.1 11.4 11.4 7.1 12 1.5z"/></svg>';

// Schrift (dunkle Pixel gegenüber der Umgebung) als leuchtende Maske
function glyphMask(src) {
  if (!src || !src.width || !src.height) return null;
  const s = Math.min(1, 720 / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  try { x.drawImage(src, 0, 0, w, h); } catch { return null; }
  const id = x.getImageData(0, 0, w, h), d = id.data, n = w * h;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
  // Summenbild für den Mittelwert der Umgebung
  const I = new Float64Array((w + 1) * (h + 1));
  for (let yy = 0; yy < h; yy++) { let row = 0; for (let xx = 0; xx < w; xx++) { row += L[yy * w + xx]; I[(yy + 1) * (w + 1) + xx + 1] = I[yy * (w + 1) + xx + 1] + row; } }
  const r = Math.max(6, Math.round(Math.min(w, h) / 40));
  for (let yy = 0; yy < h; yy++) {
    const a = Math.max(0, yy - r), b = Math.min(h, yy + r + 1);
    for (let xx = 0; xx < w; xx++) {
      const l = Math.max(0, xx - r), rr = Math.min(w, xx + r + 1);
      const m = (I[b * (w + 1) + rr] - I[a * (w + 1) + rr] - I[b * (w + 1) + l] + I[a * (w + 1) + l]) / ((b - a) * (rr - l));
      const i = yy * w + xx, ink = L[i] < m - 22 && L[i] < m * 0.86;
      d[i * 4] = 90; d[i * 4 + 1] = 245; d[i * 4 + 2] = 255; d[i * 4 + 3] = ink ? 255 : 0;
    }
  }
  x.putImageData(id, 0, 0);
  const o = document.createElement('canvas'); o.width = w; o.height = h;
  const ox = o.getContext('2d');
  ox.shadowColor = 'rgba(60,220,255,.95)'; ox.shadowBlur = Math.max(2, w / 260);
  ox.drawImage(c, 0, 0); ox.shadowBlur = 0; ox.globalAlpha = .9; ox.drawImage(c, 0, 0);
  return o;
}

/**
 * Effekt über `host` legen (host braucht position: relative/absolute).
 * src: Canvas/Bild der Seite (für die leuchtende Schrift). Gibt { setText, finish(ms), remove } zurück.
 */
export function aiScan(host, { src = null, text = 'Nibvion AI analysiert', cls = '' } = {}) {
  const el = document.createElement('div'); el.className = 'scan-fx aifx ' + cls;
  const dots = Array.from({ length: 16 }, () => `<i style="left:${(Math.random() * 96 + 2).toFixed(1)}%;top:${(Math.random() * 96 + 2).toFixed(1)}%;animation-delay:${(Math.random() * 2).toFixed(2)}s;animation-duration:${(1.4 + Math.random() * 1.4).toFixed(2)}s"></i>`).join('');
  el.innerHTML = `<div class="aifx-dim"></div><div class="aifx-glyph"></div><div class="aifx-band"></div><div class="aifx-dots">${dots}</div>
    <div class="aifx-center"><div class="aifx-ring"><span class="aifx-star">${STAR}</span></div><div class="aifx-txt"></div></div>`;
  el.querySelector('.aifx-txt').textContent = text;
  host.appendChild(el);
  // Maske erst nach dem ersten Bild berechnen, damit die Animation sofort startet
  // src darf auch eine Funktion sein (Seite wird evtl. erst gleich gezeichnet) → bis zu 3 Versuche
  const tryMask = (n = 0) => {
    if (!el.isConnected) return;
    const s0 = typeof src === 'function' ? src() : src;
    const m = s0 && s0.width ? glyphMask(s0) : null;
    if (m) el.querySelector('.aifx-glyph').appendChild(m);
    else if (n < 3) setTimeout(() => tryMask(n + 1), 500);
  };
  requestAnimationFrame(() => setTimeout(tryMask, 0));
  requestAnimationFrame(() => el.classList.add('on'));

  const LOOP = 2000;
  let t0 = performance.now(), fin = null, stopped = false;
  const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const frame = now => {
    if (stopped || !el.isConnected) return;
    let p;
    if (fin) { p = Math.min(1, (now - fin.t0) / fin.ms); if (p >= 1) { fin.done(); return; } }
    else p = ease(((now - t0) % LOOP) / LOOP);
    el.style.setProperty('--p', p.toFixed(4));
    requestAnimationFrame(frame);
  };
  if (reducedMotion()) el.style.setProperty('--p', '1'); else requestAnimationFrame(frame);

  const remove = () => { stopped = true; el.classList.add('out'); el.classList.remove('on'); setTimeout(() => el.remove(), 420); };
  return {
    el,
    setText(t) { el.querySelector('.aifx-txt').textContent = t; },
    /** Letzter Durchlauf von oben nach unten (ms), danach ausblenden. */
    finish(ms = 1100) {
      if (fin || stopped) return Promise.resolve();
      el.classList.add('final');
      if (reducedMotion()) { remove(); return Promise.resolve(); }
      return new Promise(res => { fin = { t0: performance.now(), ms, done: () => { remove(); res(); } }; });
    },
    remove,
  };
}
