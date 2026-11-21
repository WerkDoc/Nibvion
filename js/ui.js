import { icon, hydrateIcons } from './icons.js';

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
let busyEl;
export function busy(on, text = 'Einen Moment …') {
  if (on) {
    if (!busyEl) {
      busyEl = document.createElement('div'); busyEl.className = 'busy'; document.body.appendChild(busyEl);
      busyEl.innerHTML = `<div class="busy-card"><div class="spinner"></div><div class="busy-text"></div></div>`;
    }
    busyEl.querySelector('.busy-text').textContent = text;   // nur Text tauschen – Spinner läuft weiter
  } else if (busyEl) { busyEl.remove(); busyEl = null; }
}

// ---------- Bottom Sheet ----------
const stack = [];
export function sheet({ title = '', html = '', onMount, onClose, noHead = false } = {}) {
  const layer = document.getElementById('sheet-layer');
  const bd = document.createElement('div'); bd.className = 'backdrop';
  const sh = document.createElement('div'); sh.className = 'sheet';
  sh.innerHTML = `<div class="grab"></div>` + (noHead ? '' :
    `<div class="sheet-head"><div class="sheet-title">${esc(title)}</div><button class="sheet-close" data-close>${icon('x')}</button></div>`) + html;
  layer.append(bd, sh);
  hydrateIcons(sh);
  const api = {
    el: sh,
    close() {
      if (api.closed) return; api.closed = true;
      sh.classList.remove('show'); bd.classList.remove('show');
      setTimeout(() => { sh.remove(); bd.remove(); }, 420);
      const i = stack.indexOf(api); if (i >= 0) stack.splice(i, 1);
      onClose && onClose();
    },
  };
  bd.onclick = () => api.close();
  sh.querySelectorAll('[data-close]').forEach(b => b.onclick = () => api.close());
  // Wischen nach unten zum Schließen
  let sy = null, dy = 0;
  sh.addEventListener('touchstart', e => { if (sh.scrollTop <= 0 && !e.target.closest('textarea,input,canvas,.no-swipe')) { sy = e.touches[0].clientY; dy = 0; } }, { passive: true });
  sh.addEventListener('touchmove', e => { if (sy == null) return; dy = Math.max(0, e.touches[0].clientY - sy); sh.style.transition = 'none'; sh.style.transform = dy ? `translateY(${dy}px)` : ''; }, { passive: true });
  sh.addEventListener('touchend', () => { if (sy == null) return; sh.style.transition = ''; sh.style.transform = ''; if (dy > 110) api.close(); sy = null; });
  stack.push(api);
  requestAnimationFrame(() => requestAnimationFrame(() => { bd.classList.add('show'); sh.classList.add('show'); }));
  onMount && onMount(sh, api);
  return api;
}
export const closeAllSheets = () => [...stack].forEach(s => s.close());

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
