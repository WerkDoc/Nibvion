// Unterschriften-Pad, Stempel-Generator, Symbole
import { icon, hydrateIcons } from './icons.js';
import { esc, today } from './ui.js';

export const INK_COLORS = ['#111318', '#1d3fae', '#c62828'];

// ---------- Unterschrift zeichnen ----------
export function signaturePad(title = 'Neue Unterschrift') {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'pad-wrap';
    wrap.innerHTML = `
      <div class="pad-head">
        <button class="sheet-close" data-cancel>${icon('x')}</button>
        <div class="sheet-title">${esc(title)}</div>
        <button class="link-btn" data-clear>Löschen</button>
      </div>
      <div class="pad"><canvas></canvas><div class="pad-line"></div><div class="pad-x">×</div><div class="pad-ph">Hier unterschreiben</div></div>
      <div class="pad-foot">
        <div class="colors">${INK_COLORS.map((c, i) => `<button class="color ${i ? '' : 'on'}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
        <button class="btn primary" style="width:auto;padding:14px 26px" data-save>${icon('check')} Übernehmen</button>
      </div>`;
    document.body.appendChild(wrap);
    const pad = wrap.querySelector('.pad'), cv = pad.querySelector('canvas'), ph = pad.querySelector('.pad-ph');
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    let ctx, color = INK_COLORS[0], strokes = [], cur = null;
    const size = () => {
      const r = pad.getBoundingClientRect();
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      redraw();
    };
    const drawStroke = s => {
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
      const p = s.pts;
      if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0].x, p[0].y, p[0].w / 2, 0, 7); ctx.fill(); return; }
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1], b = p[i];
        ctx.lineWidth = b.w; ctx.beginPath();
        if (i > 1) { const z = p[i - 2]; ctx.moveTo((z.x + a.x) / 2, (z.y + a.y) / 2); ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2); }
        else { ctx.moveTo(a.x, a.y); ctx.lineTo((a.x + b.x) / 2, (a.y + b.y) / 2); }
        ctx.stroke();
      }
    };
    const redraw = () => { ctx.clearRect(0, 0, cv.width, cv.height); strokes.forEach(drawStroke); ph.style.opacity = strokes.length ? 0 : 1; };
    const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() }; };
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      const p = pos(e); p.w = 3.2;
      cur = { color, pts: [p] }; strokes.push(cur); redraw();
    });
    cv.addEventListener('pointermove', e => {
      if (!cur) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs) {
        const p = pos(ev), l = cur.pts[cur.pts.length - 1];
        const d = Math.hypot(p.x - l.x, p.y - l.y); if (d < 1.2) continue;
        const v = d / Math.max(1, p.t - l.t);
        const pr = ev.pressure && ev.pointerType === 'pen' ? ev.pressure : null;
        const target = pr ? 1.2 + pr * 4 : Math.max(1.3, Math.min(4.2, 4.4 - v * 1.6));
        p.w = l.w * 0.6 + target * 0.4;
        cur.pts.push(p);
      }
      redraw();
    });
    const end = () => { cur = null; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    wrap.querySelectorAll('[data-c]').forEach(b => b.onclick = () => {
      wrap.querySelectorAll('[data-c]').forEach(x => x.classList.remove('on')); b.classList.add('on');
      color = b.dataset.c; strokes.forEach(s => s.color = color); redraw();
    });
    wrap.querySelector('[data-clear]').onclick = () => { strokes = []; redraw(); };
    const close = v => { window.removeEventListener('resize', size); wrap.remove(); resolve(v); };
    wrap.querySelector('[data-cancel]').onclick = () => close(null);
    wrap.querySelector('[data-save]').onclick = () => {
      if (!strokes.length) return close(null);
      // Auf Inhalt zuschneiden
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      strokes.forEach(s => s.pts.forEach(p => { x0 = Math.min(x0, p.x - p.w); y0 = Math.min(y0, p.y - p.w); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.w); }));
      const pad2 = 4, sc = 3;
      const w = x1 - x0 + pad2 * 2, h = y1 - y0 + pad2 * 2;
      const out = document.createElement('canvas'); out.width = Math.ceil(w * sc); out.height = Math.ceil(h * sc);
      const o = out.getContext('2d'); o.scale(sc, sc); o.translate(-x0 + pad2, -y0 + pad2); o.lineCap = 'round'; o.lineJoin = 'round';
      const keep = ctx; ctx = o; strokes.forEach(drawStroke); ctx = keep;
      close({ src: out.toDataURL('image/png'), w, h });
    };
    requestAnimationFrame(size);
    window.addEventListener('resize', size);
  });
}

// ---------- Stempel ----------
export const STAMP_PRESETS = [
  { text: 'BEZAHLT', color: '#1f9d57' },
  { text: 'ERHALTEN', color: '#1d5fd1' },
  { text: 'GEPRÜFT', color: '#1d5fd1' },
  { text: 'ERLEDIGT', color: '#1f9d57' },
  { text: 'ENTWURF', color: '#8a8f99' },
  { text: 'KOPIE', color: '#8a8f99' },
  { text: 'STORNIERT', color: '#d32f2f' },
  { text: 'ABGELEHNT', color: '#d32f2f' },
  { text: 'DRINGEND', color: '#e65100' },
  { text: 'VERTRAULICH', color: '#d32f2f' },
];
export const STAMP_COLORS = ['#d32f2f', '#1d5fd1', '#1f9d57', '#e65100', '#6a3fd1', '#111318'];

export function makeStamp({ text, color, date = true, sub = '' }) {
  const S = 4;
  const lines = [];
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `800 ${34}px Helvetica, Arial, sans-serif`;
  const tw = meas.measureText(text).width + text.length * 2.5;
  const subTxt = [sub, date ? today() : ''].filter(Boolean).join(' · ');
  meas.font = `600 15px Helvetica, Arial, sans-serif`;
  const sw = subTxt ? meas.measureText(subTxt).width : 0;
  const W = Math.max(tw, sw) + 44, H = subTxt ? 84 : 62;
  const c = document.createElement('canvas'); c.width = W * S; c.height = H * S;
  const g = c.getContext('2d'); g.scale(S, S);
  g.strokeStyle = color; g.fillStyle = color; g.globalAlpha = 0.92;
  const r = 10;
  const rr = (x, y, w, h, lw) => { g.lineWidth = lw; g.beginPath(); g.roundRect(x, y, w, h, r); g.stroke(); };
  rr(3, 3, W - 6, H - 6, 3.2); rr(8, 8, W - 16, H - 16, 1.2);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `800 34px Helvetica, Arial, sans-serif`;
  if ('letterSpacing' in g) g.letterSpacing = '2.5px';
  g.fillText(text, W / 2 + 1, subTxt ? 34 : H / 2 + 1);
  if (subTxt) { if ('letterSpacing' in g) g.letterSpacing = '0.5px'; g.font = `600 15px Helvetica, Arial, sans-serif`; g.fillText(subTxt, W / 2, 62); }
  return { src: c.toDataURL('image/png'), w: W, h: H };
}

// ---------- Symbole (✓ / ✗ / •) ----------
export function makeSymbol(kind, color = '#111318') {
  const S = 6, W = 24;
  const c = document.createElement('canvas'); c.width = c.height = W * S;
  const g = c.getContext('2d'); g.scale(S, S);
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  if (kind === 'check') { g.moveTo(4, 12.5); g.lineTo(9.5, 18); g.lineTo(20, 5.5); g.stroke(); }
  else if (kind === 'cross') { g.moveTo(5, 5); g.lineTo(19, 19); g.moveTo(19, 5); g.lineTo(5, 19); g.stroke(); }
  else { g.arc(12, 12, 5, 0, 7); g.fill(); }
  return { src: c.toDataURL('image/png'), w: W, h: W };
}

export { hydrateIcons };
