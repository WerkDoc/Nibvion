// ================= Scanner: Kanten erkennen, entzerren, aufbereiten =================
// Alles lokal, ohne Bibliothek. Ecken werden normiert (0..1) in der Reihenfolge
// oben-links, oben-rechts, unten-rechts, unten-links gespeichert.
import { icon } from './icons.js';
import { loadImage, haptic } from './ui.js';

export const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
const isFull = c => c.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 1e-3 && Math.abs(p[1] - FULL[i][1]) < 1e-3);

// ---------- Bild laden ----------
export async function loadFileImage(file) {
  const url = URL.createObjectURL(file);
  const img = await loadImage(url);
  return { img, url };
}

export function toCanvas(img, maxSide) {
  const w = img.videoWidth || img.naturalWidth || img.width, h = img.videoHeight || img.naturalHeight || img.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0; const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// ---------- Kanten erkennen ----------
// detectQuad: Ecken oder null (kein Dokument gefunden). detectCorners: mit Rückfall auf ganzes Bild.
export function detectCorners(img) { return detectQuad(img) || FULL.map(p => [...p]); }

export function detectQuad(img, maxSide = 360) {
  try {
    const c = toCanvas(img, maxSide), w = c.width, h = c.height, N = w * h;
    const d = c.getContext('2d').getImageData(0, 0, w, h).data;
    const g = new Float32Array(N);
    for (let i = 0; i < N; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    const b = boxBlur(boxBlur(g, w, h, 2), w, h, 2);
    // Otsu-Schwelle
    const hist = new Array(256).fill(0);
    for (let i = 0; i < N; i++) hist[b[i] | 0]++;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = N - wB; if (!wF) break;
      sB += t * hist[t];
      const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > best) { best = v; thr = t; }
    }
    // Größte helle Fläche (Papier) suchen
    const lab = new Int32Array(N); let bestLab = 0, bestN = 0, cur = 0;
    const stack = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      if (lab[i] || b[i] <= thr) continue;
      cur++; let sp = 0, n = 0; stack[sp++] = i; lab[i] = cur;
      while (sp) {
        const p = stack[--sp]; n++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && !lab[p - 1] && b[p - 1] > thr) { lab[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && !lab[p + 1] && b[p + 1] > thr) { lab[p + 1] = cur; stack[sp++] = p + 1; }
        if (y > 0 && !lab[p - w] && b[p - w] > thr) { lab[p - w] = cur; stack[sp++] = p - w; }
        if (y < h - 1 && !lab[p + w] && b[p + w] > thr) { lab[p + w] = cur; stack[sp++] = p + w; }
      }
      if (n > bestN) { bestN = n; bestLab = cur; }
    }
    if (bestN < N * 0.12 || bestN > N * 0.97) return null;
    // Extrempunkte als Ecken
    let tl = [0, 0, 1e9], tr = [0, 0, -1e9], br = [0, 0, -1e9], bl = [0, 0, 1e9];
    for (let i = 0; i < N; i++) {
      if (lab[i] !== bestLab) continue;
      const x = i % w, y = (i / w) | 0, s = x + y, df = x - y;
      if (s < tl[2]) tl = [x, y, s];
      if (s > br[2]) br = [x, y, s];
      if (df > tr[2]) tr = [x, y, df];
      if (df < bl[2]) bl = [x, y, df];
    }
    const q = [tl, tr, br, bl].map(([x, y]) => [Math.min(1, Math.max(0, (x + 0.5) / w)), Math.min(1, Math.max(0, (y + 0.5) / h))]);
    return quadArea(q) > 0.12 ? q : null;
  } catch { return null; }
}

function quadArea(q) {
  let a = 0; for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

// ---------- Perspektive entzerren ----------
function squareToQuad(p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

export function warp(img, corners, maxSide = 2200) {
  if (isFull(corners)) return toCanvas(img, maxSide);
  const src = toCanvas(img, Math.max(maxSide * 1.25, 1200));
  const sw = src.width, sh = src.height;
  const P = corners.map(([x, y]) => [x * sw, y * sh]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let w = Math.max(dist(P[0], P[1]), dist(P[3], P[2])), h = Math.max(dist(P[0], P[3]), dist(P[1], P[2]));
  const k = Math.min(1, maxSide / Math.max(w, h)); w = Math.max(8, Math.round(w * k)); h = Math.max(8, Math.round(h * k));
  const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const octx = out.getContext('2d'); const od = octx.createImageData(w, h); const o = od.data;
  const [a, b, c, d, e, f, g, hh] = squareToQuad(P);
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h;
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w, z = g * u + hh * v + 1;
      let x = (a * u + b * v + c) / z - 0.5, y = (d * u + e * v + f) / z - 0.5;
      x = Math.min(sw - 1.001, Math.max(0, x)); y = Math.min(sh - 1.001, Math.max(0, y));
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const p00 = (y0 * sw + x0) * 4, p10 = p00 + 4, p01 = p00 + sw * 4, p11 = p01 + 4;
      const q = (j * w + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const t = sd[p00 + ch] * (1 - fx) + sd[p10 + ch] * fx, bt = sd[p01 + ch] * (1 - fx) + sd[p11 + ch] * fx;
        o[q + ch] = t * (1 - fy) + bt * fy;
      }
      o[q + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

export function rotateCanvas(c, deg) {
  deg = ((deg % 360) + 360) % 360; if (!deg) return c;
  const o = document.createElement('canvas');
  o.width = deg % 180 ? c.height : c.width; o.height = deg % 180 ? c.width : c.height;
  const x = o.getContext('2d'); x.translate(o.width / 2, o.height / 2); x.rotate(deg * Math.PI / 180);
  x.drawImage(c, -c.width / 2, -c.height / 2);
  return o;
}

// ---------- Aufbereiten (Schatten raus, Papier weiß) ----------
export const FILTERS = [
  ['', 'Original'], ['color', 'Verbessern'], ['gray', 'Graustufen'],
  ['doc', 'Dokument'], ['bw', 'Schwarz-Weiß'], ['invert', 'Umkehren'],
];
export const NO_ADJ = { brightness: 0, contrast: 0, sharp: 0 };

// Papierhelligkeit je Pixel schätzen (für Schattenentfernung)
function paperLevel(c) {
  const w = c.width, h = c.height;
  const sw = Math.max(8, Math.round(w / 24)), sh = Math.max(8, Math.round(h / 24));
  const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
  const sctx = sc.getContext('2d'); sctx.drawImage(c, 0, 0, sw, sh);
  const sdat = sctx.getImageData(0, 0, sw, sh).data;
  const lum = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) lum[i] = Math.max(sdat[i * 4], sdat[i * 4 + 1], sdat[i * 4 + 2]);
  const mx = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(sw - 1, Math.max(0, x + dx)), yy = Math.min(sh - 1, Math.max(0, y + dy)); m = Math.max(m, lum[yy * sw + xx]);
    }
    mx[y * sw + x] = m;
  }
  const bl = boxBlur(mx, sw, sh, 2);
  for (let i = 0; i < sw * sh; i++) { sdat[i * 4] = sdat[i * 4 + 1] = sdat[i * 4 + 2] = Math.max(40, bl[i]); sdat[i * 4 + 3] = 255; }
  sctx.putImageData(new ImageData(sdat, sw, sh), 0, 0);
  const bc = document.createElement('canvas'); bc.width = w; bc.height = h;
  const bctx = bc.getContext('2d'); bctx.imageSmoothingQuality = 'high'; bctx.drawImage(sc, 0, 0, w, h);
  return bctx.getImageData(0, 0, w, h).data;
}

export function enhance(c, mode, adj = NO_ADJ) {
  const { brightness = 0, contrast = 0, sharp = 0 } = adj || NO_ADJ;
  if (!mode && !brightness && !contrast && !sharp) return c;
  const w = c.width, h = c.height, ctx = c.getContext('2d');
  const id = ctx.getImageData(0, 0, w, h), d = id.data;
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
  if (mode) {
    const bg = paperLevel(c);
    const curve = (v, lo, hi) => clamp((v - lo) * 255 / (hi - lo));
    for (let i = 0; i < d.length; i += 4) {
      const k = 255 / bg[i];
      if (mode === 'color') {
        d[i] = curve(d[i] * k, 40, 245); d[i + 1] = curve(d[i + 1] * k, 40, 245); d[i + 2] = curve(d[i + 2] * k, 40, 245);
      } else {
        const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * k;
        let v;
        if (mode === 'gray') v = curve(g, 25, 248);
        else if (mode === 'bw') v = clamp((g - 150) * 7 + 128);       // weiches Schwellwert-S/W (glatte Kanten)
        else v = curve(g, 70, 232);                                    // doc & invert
        if (mode === 'invert') v = 255 - v;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
  }
  // Schärfe (Unscharf maskieren auf der Helligkeit)
  if (sharp > 0) {
    const N = w * h, L = new Float32Array(N);
    for (let i = 0; i < N; i++) L[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    const B = boxBlur(L, w, h, 1), amt = sharp / 40;
    for (let i = 0; i < N; i++) {
      const dl = (L[i] - B[i]) * amt;
      d[i * 4] = clamp(d[i * 4] + dl); d[i * 4 + 1] = clamp(d[i * 4 + 1] + dl); d[i * 4 + 2] = clamp(d[i * 4 + 2] + dl);
    }
  }
  if (brightness || contrast) {
    const cf = (100 + contrast * 1.5) / 100, br = brightness * 1.6;
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - 128) * cf + 128 + br;
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

export function render(item, filter, maxSide, adj) {
  const c = rotateCanvas(warp(item.img, item.corners, maxSide), item.rot || 0);
  return enhance(c, filter, adj);
}

// ---------- Zuschneiden (Vollbild) ----------
export function cropEditor(item) {
  return new Promise(resolve => {
    let corners = item.corners.map(p => [...p]);
    let rot = item.rot || 0;
    const wrap = document.createElement('div');
    wrap.className = 'pad-wrap crop-wrap';
    wrap.innerHTML = `
      <div class="pad-head">
        <button class="sheet-close" data-x>${icon('x')}</button>
        <div class="sheet-title">Zuschneiden</div>
        <button class="link-btn" data-ok>Fertig</button>
      </div>
      <div class="crop-stage no-swipe"><canvas class="crop-img"></canvas><svg class="crop-svg"></svg><div class="loupe"><canvas></canvas></div></div>
      <div class="crop-foot">
        <button class="crop-btn" data-auto>${icon('sparkles')}<span>Automatisch</span></button>
        <button class="crop-btn" data-full>${icon('fit')}<span>Ganzes Bild</span></button>
        <button class="crop-btn" data-rot>${icon('rotate')}<span>Drehen <b data-rv>${rot}°</b></span></button>
      </div>`;
    document.body.appendChild(wrap);
    const stage = wrap.querySelector('.crop-stage'), cv = wrap.querySelector('.crop-img'), svg = wrap.querySelector('.crop-svg');
    const loupe = wrap.querySelector('.loupe'), lc = loupe.querySelector('canvas');
    const src = toCanvas(item.img, 1600);
    let box = { x: 0, y: 0, w: 1, h: 1 };
    const layout = () => {
      const r = stage.getBoundingClientRect();
      const s = Math.min(r.width / src.width, r.height / src.height);
      box = { w: src.width * s, h: src.height * s }; box.x = (r.width - box.w) / 2; box.y = (r.height - box.h) / 2;
      const dpr = Math.min(2, devicePixelRatio || 1);
      cv.width = box.w * dpr; cv.height = box.h * dpr;
      Object.assign(cv.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
      cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
      svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
      draw();
    };
    const P = i => [box.x + corners[i][0] * box.w, box.y + corners[i][1] * box.h];
    const draw = () => {
      const pts = [0, 1, 2, 3].map(P);
      const poly = pts.map(p => p.join(',')).join(' ');
      const r = stage.getBoundingClientRect();
      svg.innerHTML = `<path class="crop-shade" fill-rule="evenodd" d="M0 0H${r.width}V${r.height}H0Z M${pts.map(p => p.join(' ')).join(' L')}Z"/>
        <polygon class="crop-line" points="${poly}"/>` +
        pts.map((p, i) => `<circle class="crop-h" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="15"/>`).join('');
    };
    let drag = null;
    svg.addEventListener('pointerdown', e => {
      const r = stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let bi = -1, bd = 60;
      for (let i = 0; i < 4; i++) { const p = P(i), dd = Math.hypot(p[0] - x, p[1] - y); if (dd < bd) { bd = dd; bi = i; } }
      if (bi < 0) return;
      const p = P(bi); drag = { i: bi, ox: p[0] - x, oy: p[1] - y };
      svg.setPointerCapture(e.pointerId); e.preventDefault(); haptic(); move(e);
    });
    const move = e => {
      if (!drag) return;
      const r = stage.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left + drag.ox - box.x) / box.w));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top + drag.oy - box.y) / box.h));
      corners[drag.i] = [x, y]; draw();
      // Lupe
      const Z = 2.4, L = 110, ldpr = Math.min(2, devicePixelRatio || 1);
      lc.width = lc.height = L * ldpr; const g = lc.getContext('2d');
      const sx = x * src.width, sy = y * src.height, sz = L / (Z * box.w / src.width);
      g.fillStyle = '#000'; g.fillRect(0, 0, lc.width, lc.height);
      g.drawImage(src, sx - sz / 2, sy - sz / 2, sz, sz, 0, 0, lc.width, lc.height);
      g.strokeStyle = '#ff6a5b'; g.lineWidth = 2 * ldpr; g.beginPath();
      g.moveTo(lc.width / 2, lc.height / 2 - 12 * ldpr); g.lineTo(lc.width / 2, lc.height / 2 + 12 * ldpr);
      g.moveTo(lc.width / 2 - 12 * ldpr, lc.height / 2); g.lineTo(lc.width / 2 + 12 * ldpr, lc.height / 2); g.stroke();
      const px = box.x + x * box.w, py = box.y + y * box.h;
      loupe.style.left = (px < r.width / 2 ? r.width - L - 12 : 12) + 'px';
      loupe.style.top = Math.max(8, Math.min(r.height - L - 8, py - L - 40)) + 'px';
      loupe.classList.add('show');
    };
    svg.addEventListener('pointermove', move);
    const up = () => { drag = null; loupe.classList.remove('show'); };
    svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
    const close = v => { removeEventListener('resize', layout); wrap.remove(); resolve(v); };
    wrap.querySelector('[data-x]').onclick = () => close(null);
    wrap.querySelector('[data-ok]').onclick = () => close({ corners, rot });
    wrap.querySelector('[data-auto]').onclick = () => { corners = detectCorners(item.img); draw(); haptic(); };
    wrap.querySelector('[data-full]').onclick = () => { corners = FULL.map(p => [...p]); draw(); haptic(); };
    wrap.querySelector('[data-rot]').onclick = () => { rot = (rot + 90) % 360; wrap.querySelector('[data-rv]').textContent = rot + '°'; haptic(); };
    addEventListener('resize', layout);
    requestAnimationFrame(layout);
  });
}
