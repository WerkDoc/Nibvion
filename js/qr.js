// ================= QR-Code-Encoder (lokal, ohne Bibliothek) =================
// Kompakte Umsetzung des QR-Standards (ISO/IEC 18004) nach dem bekannten Aufbau von
// Project Nayuki „QR Code generator“ (MIT-Lizenz): Byte-Modus (UTF-8), Version 1–40,
// Fehlerkorrektur L/M/Q/H, automatische Masken-Wahl.
// qrMatrix(text, ecl) → { size, get(x, y) }  ·  qrCanvas(…) / qrSvg(…) zum Zeichnen.

const ECC = { L: [1, 0], M: [0, 1], Q: [3, 2], H: [2, 3] };       // [Format-Bits, Tabellen-Index]
// Fehlerkorrektur-Codewörter je Block [L, M, Q, H] und Anzahl Blöcke, Index = Version
const ECC_CW = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const ECC_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
const dataCw = (ver, e) => Math.floor(rawModules(ver) / 8) - ECC_CW[e][ver] * ECC_BLOCKS[e][ver];

// --- Reed-Solomon über GF(256), Polynom 0x11D ---
function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 255; }
function rsDivisor(deg) {
  const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => r[i] ^= gfMul(c, f)); }
  return r;
}

function utf8(s) { return Array.from(new TextEncoder().encode(s)); }

/** QR-Matrix für Text (Byte-Modus). ecl: 'L' | 'M' | 'Q' | 'H' */
export function qrMatrix(text, ecl = 'M', { minVer = 1, maxVer = 40, boost = true } = {}) {
  const bytes = utf8(String(text ?? ''));
  let e = ECC[ecl] ? ecl : 'M', ver, bits;
  for (ver = minVer; ; ver++) {
    const cap = dataCw(ver, ECC[e][1]) * 8;
    const used = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (used <= cap) { bits = used; break; }
    if (ver >= maxVer) throw new Error('Text zu lang für einen QR-Code');
  }
  // Fehlerkorrektur erhöhen, wenn es ohne größere Version passt
  const ORDER = ['L', 'M', 'Q', 'H'];
  if (boost) for (const k of ORDER.slice(ORDER.indexOf(e) + 1)) if (bits <= dataCw(ver, ECC[k][1]) * 8) e = k;
  const ei = ECC[e][1];

  // Bitstrom
  const bb = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bb.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver <= 9 ? 8 : 16); bytes.forEach(b => put(b, 8));
  const cap = dataCw(ver, ei) * 8;
  put(0, Math.min(4, cap - bb.length));
  put(0, (8 - bb.length % 8) % 8);
  for (let p = 0xEC; bb.length < cap; p ^= 0xEC ^ 0x11) put(p, 8);
  const data = [];
  for (let i = 0; i < bb.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bb[i + j]; data.push(v); }

  // Blöcke + Fehlerkorrektur, verschachteln
  const nb = ECC_BLOCKS[ei][ver], ecLen = ECC_CW[ei][ver], raw = Math.floor(rawModules(ver) / 8);
  const nShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
  const div = rsDivisor(ecLen), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - ecLen + (i < nShort ? 0 : 1)); k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const cw = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecLen || j >= nShort) cw.push(b[i]); });

  // Matrix aufbauen
  const size = ver * 4 + 17;
  const M = Array.from({ length: size }, () => new Array(size).fill(false));
  const F = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, v) => { M[y][x] = v; F[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (x, y) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy; if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // Ausrichtungsmuster
  const al = [];
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2, step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    al.push(6); for (let p = size - 7; al.length < n; p -= step) al.splice(1, 0, p);
  }
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = mask => {
    const d = (ECC[e][0] << 3) | mask; let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, bit = i => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) { const v = ((b >>> i) & 1) !== 0, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, v); set(c, a, v); }
  }
  // Daten im Zickzack
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!F[y][x] && i < cw.length * 8) { M[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }
  // Masken
  const MASKS = [(x, y) => (x + y) % 2, (x, y) => y % 2, (x, y) => x % 3, (x, y) => (x + y) % 3, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2,
    (x, y) => x * y % 2 + x * y % 3, (x, y) => (x * y % 2 + x * y % 3) % 2, (x, y) => ((x + y) % 2 + x * y % 3) % 2];
  const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && MASKS[m](x, y) === 0) M[y][x] = !M[y][x]; };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) { applyMask(m); drawFormat(m); const p = penalty(M, size); if (p < bestP) { bestP = p; best = m; } applyMask(m); }
  applyMask(best); drawFormat(best);
  return { size, version: ver, ecl: e, get: (x, y) => x >= 0 && y >= 0 && x < size && y < size && M[y][x] };
}

function penalty(M, n) {
  let r = 0;
  const runs = line => {
    let s = 0, run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line(i) === line(i - 1)) run++;
      else { if (run >= 5) s += run - 2; run = 1; }
    }
    // Finder-ähnliche Muster 1:1:3:1:1 mit 4 hellen Modulen daneben
    for (let i = 0; i + 6 < n; i++) {
      if (line(i) && !line(i + 1) && line(i + 2) && line(i + 3) && line(i + 4) && !line(i + 5) && line(i + 6)) {
        const before = [1, 2, 3, 4].every(k => i - k < 0 || !line(i - k)), after = [7, 8, 9, 10].every(k => i + k >= n || !line(i + k));
        if (before) s += 40; if (after) s += 40;
      }
    }
    return s;
  };
  for (let y = 0; y < n; y++) r += runs(x => M[y][x]);
  for (let x = 0; x < n; x++) r += runs(y => M[y][x]);
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (M[y][x]) dark++;
    if (x < n - 1 && y < n - 1) { const c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) r += 3; }
  }
  const total = n * n, k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return r + Math.max(0, k) * 10;
}

/** Canvas mit scharfen Modulen. bg: Farbe oder null (= transparent) */
export function qrCanvas(qr, { scale = 16, margin = 4, color = '#000', bg = '#fff' } = {}) {
  const n = qr.size + margin * 2, c = document.createElement('canvas');
  c.width = c.height = n * scale;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); }
  g.fillStyle = color;
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.get(x, y)) g.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
  return c;
}

/** SVG (Vektor) – ein Pfad, Module als Rechtecke */
export function qrSvg(qr, { margin = 4, color = '#000', bg = '#fff' } = {}) {
  const n = qr.size + margin * 2; let d = '';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.get(x, y)) d += `M${x + margin} ${y + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">${bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : ''}<path d="${d}" fill="${color}"/></svg>`;
}

// ---------- Inhalte nach Standard ----------
const wifiEsc = s => String(s).replace(/([\\;,:"])/g, '\\$1');
/** WLAN-Zugang: WIFI:T:WPA;S:<ssid>;P:<pass>;H:true;; */
export function wifiPayload({ ssid, pass = '', sec = 'WPA', hidden = false }) {
  const T = sec === 'nopass' || sec === 'open' ? 'nopass' : sec;
  return `WIFI:T:${T};S:${wifiEsc(ssid)};${T === 'nopass' ? '' : `P:${wifiEsc(pass)};`}${hidden ? 'H:true;' : ''};`;
}
export function urlPayload(u) {
  const s = String(u).trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'mailto:' + s;
  if (/^\+?[\d\s/()-]{6,}$/.test(s)) return 'tel:' + s.replace(/[^\d+]/g, '');
  return 'https://' + s;
}
