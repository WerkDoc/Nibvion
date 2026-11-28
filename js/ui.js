import { icon, hydrateIcons } from './icons.js';
import { installSprings, scanLaser } from './fx.js';

installSprings();

// ---------- Toast ----------
let toastTimer;
export function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.className = err ? 'err' : '';
  t.innerHTML = icon(err ? 'info' : 'check') + `<span>${esc(msg)}</span>`;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2300);
}

// ---------- Busy ----------
// busy(true, text, { scan: bildUrl }) zeigt statt des Spinners eine Seitenvorschau mit Scan-Laser
// (Texterkennung / Aufbereitung). Folgeaufrufe ohne scan tauschen nur den Text.
let busyEl, busyStop = null;
export function busy(on, text = 'Einen Moment …', opts = {}) {
  if (on) {
    if (!busyEl) {
      busyEl = document.createElement('div'); busyEl.className = 'busy'; document.body.appendChild(busyEl);
      busyEl.innerHTML = `<div class="busy-card"><div class="spinner"></div><div class="busy-text"></div></div>`;
    }
    if (opts.scan && !busyEl.querySelector('.busy-scan')) {
      const card = busyEl.querySelector('.busy-card');
      card.classList.add('scanning');
      card.querySelector('.spinner').remove();
      const box = document.createElement('div'); box.className = 'busy-scan';
      box.innerHTML = `<img alt="">`;
      card.prepend(box);
      const img = box.firstChild;
      img.onload = () => { if (busyEl && !busyStop) busyStop = scanLaser(box, img); };
      img.src = opts.scan;
    }
    busyEl.querySelector('.busy-text').textContent = text;   // nur Text tauschen – Spinner/Laser läuft weiter
  } else if (busyEl) {
    busyStop?.(); busyStop = null;
    const b = busyEl; busyEl = null;
    if (b.querySelector('.busy-scan')) { b.classList.add('out'); setTimeout(() => b.remove(), 220); } else b.remove();
  }
}

// ---------- Bottom Sheet ----------
const stack = [];
export function sheet({ title = '', html = '', onMount, onClose, noHead = false } = {}) {
  const layer = document.getElementById('sheet-layer');
  const bd = document.createElement('div'); bd.className = 'backdrop';
  const sh = document.createElement('div'); sh.className = 'sheet';
  sh.innerHTML = `<div class="grab"></div>` + (noHead ? '' :
    `<div class="sheet-head"><div class="sheet-title">${esc(title)}</div><button class="sheet-close" data-close>${icon('x')}</button></div>`) + html;
  // Gestapelte Sheets: jede Ebene liegt samt Hintergrund ÜBER der vorigen – sonst blieb das untere
  // Sheet antippbar (z. B. „Text-Stempel“ mehrfach → mehrere gleiche Fenster übereinander)
  const depth = stack.length; bd.style.setProperty('--sd', depth); sh.style.setProperty('--sd', depth);
  layer.append(bd, sh);
  hydrateIcons(sh);
  const api = {
    el: sh,
    close() {
      if (api.closed) return; api.closed = true;
      sh.style.transition = ''; sh.style.transform = '';
      sh.classList.add('closing'); sh.classList.remove('show'); bd.classList.remove('show');
      setTimeout(() => { sh.remove(); bd.remove(); }, 420);
      const i = stack.indexOf(api); if (i >= 0) stack.splice(i, 1);
      onClose && onClose();
    },
  };
  bd.onclick = () => api.close();
  sh.querySelectorAll('[data-close]').forEach(b => b.onclick = () => api.close());
  // Wischen nach unten zum Schließen – folgt dem Finger (mit Gummiband nach oben),
  // Loslassen: schneller Wisch oder > 110 px schließt, sonst federt das Sheet zurück
  let sy = null, dy = 0, vy = 0, lt = 0, ly = 0, dragging = false;
  const base = () => matchMedia('(min-width: 700px)').matches ? 'translateX(-50%) ' : '';
  sh.addEventListener('touchstart', e => { if (sh.scrollTop <= 0 && !e.target.closest('textarea,input,canvas,.no-swipe')) { sy = ly = e.touches[0].clientY; dy = 0; vy = 0; dragging = false; lt = performance.now(); } }, { passive: true });
  // Nicht passiv: Beim Ziehen des Sheets wird das native Scrollen/Federn des Inhalts verhindert –
  // sonst federt iOS den Inhalt zusätzlich nach unten und oben entsteht eine leere Fläche.
  const scrollable = () => sh.scrollHeight > sh.clientHeight + 1;
  sh.addEventListener('touchmove', e => {
    if (sy == null) return;
    const y = e.touches[0].clientY, raw = y - sy, now = performance.now();
    if (!dragging) {
      if (!raw) return;                                               // iOS: Entscheidung schon beim 1. touchmove, sonst läuft das native Scrollen
      if (sh.scrollTop > 0 || (raw < 0 && scrollable())) { sy = null; return; }   // Inhalt scrollt normal
      dragging = true;
    }
    if (e.cancelable) e.preventDefault();
    vy = vy * 0.5 + ((y - ly) / Math.max(1, now - lt)) * 0.5; ly = y; lt = now;
    dy = raw > 0 ? raw : -Math.sqrt(-raw) * 2.2;                     // nach oben nur leicht (Gummiband)
    sh.style.transition = 'none'; sh.style.transform = dy ? `${base()}translate3d(0,${dy.toFixed(1)}px,0)` : '';
  }, { passive: false });
  const end = () => {
    if (sy == null) return; sy = null; if (!dragging) return; dragging = false;
    if (dy > 110 || (vy > 0.7 && dy > 24)) return api.close();
    sh.style.transition = ''; sh.style.transform = '';
  };
  sh.addEventListener('touchend', end); sh.addEventListener('touchcancel', end);
  stack.push(api);
  onMount && onMount(sh, api);
  // Erst Layout/Inhalt fertig rechnen (noch im Tipp), dann einen Frame zeichnen lassen und
  // danach die Animation starten – so muss iOS während des Hochgleitens nichts mehr aufbauen.
  void sh.offsetHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!api.closed) { bd.classList.add('show'); sh.classList.add('show'); } }));
  return api;
}
export const closeAllSheets = () => [...stack].forEach(s => s.close());
/** Oberstes Menü schließen (Esc am PC). true, wenn eins offen war. */
export const closeTopSheet = () => { const s = stack[stack.length - 1]; if (!s) return false; s.close(); return true; };

// ---------- Dialoge ----------
export function confirmDlg(title, text, okLabel = 'Löschen', danger = true) {
  return new Promise(res => {
    let done = false;
    const s = sheet({
      title, html: `<p style="color:var(--text2);margin:0 2px 6px;line-height:1.45">${esc(text)}</p>
        <div class="btn-row"><button class="btn" data-c>Abbrechen</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`,
      onMount(el, api) {
        el.querySelector('[data-c]').onclick = () => api.close();
        el.querySelector('[data-ok]').onclick = () => { done = true; api.close(); };
      },
      onClose: () => res(done),
    });
  });
}

export function promptDlg(title, value = '', okLabel = 'Speichern', placeholder = '') {
  return new Promise(res => {
    let out = null;
    sheet({
      title, html: `<input class="field" data-in value="${esc(value)}" placeholder="${esc(placeholder)}">
        <div class="btn-row"><button class="btn" data-c>Abbrechen</button><button class="btn primary" data-ok>${esc(okLabel)}</button></div>`,
      onMount(el, api) {
        const inp = el.querySelector('[data-in]');
        setTimeout(() => { inp.focus(); inp.select(); }, 350);
        const ok = () => { out = inp.value.trim(); api.close(); };
        inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
        el.querySelector('[data-c]').onclick = () => api.close();
        el.querySelector('[data-ok]').onclick = ok;
      },
      onClose: () => res(out),
    });
  });
}

// ---------- Tastatur (iOS) ----------
if (window.visualViewport) {
  const upd = () => {
    const vv = window.visualViewport;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', kb + 'px');
    document.documentElement.classList.toggle('kb-open', kb > 0);
  };
  visualViewport.addEventListener('resize', upd);
  visualViewport.addEventListener('scroll', upd);
}

// ---------- iOS: Seite nach der Tastatur zurücksetzen ----------
// iOS schiebt beim Öffnen der Tastatur das ganze Dokument nach oben und setzt es in
// Home-Bildschirm-Apps nicht immer zurück. Die Tab-Leiste sieht dann normal aus,
// aber Tipps landen daneben (Tabs „reagieren nicht“). Deshalb immer auf 0 zurück.
const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable); };
export function resetDocScroll() {
  if (typing()) return;
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  if (document.documentElement.scrollTop) document.documentElement.scrollTop = 0;
  if (document.body.scrollTop) document.body.scrollTop = 0;
}
document.addEventListener('focusout', () => { setTimeout(resetDocScroll, 60); setTimeout(resetDocScroll, 400); });
window.addEventListener('scroll', () => { if (!typing()) resetDocScroll(); }, { passive: true });
if (window.visualViewport) visualViewport.addEventListener('resize', () => setTimeout(resetDocScroll, 80));
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(resetDocScroll, 50); });

// ---------- iOS-Streifen unten ----------
// Ursache war die Statusleiste im Modus „black-translucent“ (iOS 26 kürzt die App dann unten
// um die Statusleisten-Höhe). Mit „default“ tritt das nicht mehr auf – Funktion bleibt als No-op.
export function measureGap() { document.documentElement.classList.remove('ios-gap'); }

// ---------- Helfer ----------
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
export function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'Heute, ' + time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Gestern, ' + time;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ', ' + time;
}
export const today = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
export function pickFiles(inputId) {
  return new Promise(res => {
    const inp = document.getElementById(inputId);
    inp.value = '';
    inp.onchange = () => res([...inp.files]);
    inp.click();
  });
}
export function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
export function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
export function dataUrlToBytes(u) {
  const b = atob(u.split(',')[1]); const a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}
export function haptic() { try { navigator.vibrate && navigator.vibrate(8); } catch {} }

// ---------- Sanftes Drehen ----------
export const ROT_MS = 480;
export const ROT_EASE = 'cubic-bezier(.45,0,.2,1)';
export const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
export const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * Element langsam um 90° drehen und dabei in die freie Fläche (aw × ah) einpassen.
 * Danach `apply()` (zeichnet das neue, gedrehte Bild) – die Drehung bleibt stehen, bis
 * `ready` (Promise, optional) erfüllt ist, damit nichts zurückspringt.
 */
export async function spinRotate(el, aw, ah, apply, deg = 90) {
  const r = el && el.getBoundingClientRect();
  if (!el || !el.animate || reducedMotion() || !r.width || !r.height) { await apply(); return; }
  const k = Math.min(aw / r.height, ah / r.width);
  const anim = el.animate([{ transform: 'none' }, { transform: `rotate(${deg}deg) scale(${k})` }], { duration: ROT_MS, easing: ROT_EASE, fill: 'forwards' });
  try { await anim.finished; } catch {}
  const ready = await apply();
  try { if (ready && ready.then) await Promise.race([ready, new Promise(r => setTimeout(r, 2500))]); } catch {}
  requestAnimationFrame(() => anim.cancel());
}

/** Wartet, bis ein <img> sein neues Bild geladen hat. */
export const imgLoaded = img => new Promise(res => {
  const done = () => { img.removeEventListener('load', done); img.removeEventListener('error', done); res(); };
  img.addEventListener('load', done); img.addEventListener('error', done);
});
