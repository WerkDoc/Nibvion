// ================= GIF89a-Encoder (reines JS, ohne Bibliothek) =================
// • Farbreduktion pro Bild: Median-Cut über ein 15-Bit-Histogramm (32 768 Fächer) → bis 256 Farben
//   (lokale Farbtabelle je Frame – Text bleibt scharf, Fotos sehen gut aus)
// • Zuordnung Pixel → Palette über eine 32 768er Nachschlagetabelle (schnell)
// • LZW-Kompression nach GIF-Spezifikation, Endlosschleife über NETSCAPE2.0-Block
//
//   const enc = new GifEncoder(w, h, { loop: true });
//   enc.addFrame(imageData, delayMs); …; const bytes = enc.finish();

class ByteOut {
  constructor() { this.buf = new Uint8Array(1 << 20); this.n = 0; }
  grow(k) { if (this.n + k <= this.buf.length) return; let s = this.buf.length * 2; while (s < this.n + k) s *= 2; const b = new Uint8Array(s); b.set(this.buf.subarray(0, this.n)); this.buf = b; }
  byte(v) { this.grow(1); this.buf[this.n++] = v & 255; }
  word(v) { this.byte(v); this.byte(v >> 8); }
  bytes(a) { this.grow(a.length); this.buf.set(a, this.n); this.n += a.length; }
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  out() { return this.buf.slice(0, this.n); }
}

// ---------------------------------------------------------------------------------
// Palette (Median-Cut)
// ---------------------------------------------------------------------------------
function quantize(rgba, maxColors = 256) {
  const hist = new Uint32Array(32768);
  for (let i = 0; i < rgba.length; i += 4) hist[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)]++;
  const cols = [];
  for (let k = 0; k < 32768; k++) if (hist[k]) cols.push(k);
  const boxes = [{ c: cols }];
  const stats = b => {
    let r0 = 31, r1 = 0, g0 = 31, g1 = 0, b0 = 31, b1 = 0, n = 0;
    for (const k of b.c) {
      const r = k >> 10, g = (k >> 5) & 31, bb = k & 31, w = hist[k];
      if (r < r0) r0 = r; if (r > r1) r1 = r; if (g < g0) g0 = g; if (g > g1) g1 = g; if (bb < b0) b0 = bb; if (bb > b1) b1 = bb; n += w;
    }
    b.n = n; b.rr = r1 - r0; b.gr = g1 - g0; b.br = b1 - b0;
    b.score = Math.max(b.rr * 1.0, b.gr * 1.2, b.br * 0.8) * Math.sqrt(n);
  };
  stats(boxes[0]);
  while (boxes.length < maxColors) {
    let bi = -1, best = 0;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].c.length > 1 && boxes[i].score > best) { best = boxes[i].score; bi = i; }
    if (bi < 0) break;
    const b = boxes[bi];
    const ch = b.gr * 1.2 >= b.rr && b.gr * 1.2 >= b.br * 0.8 ? 1 : b.rr >= b.br * 0.8 ? 0 : 2;
    const key = ch === 0 ? k => k >> 10 : ch === 1 ? k => (k >> 5) & 31 : k => k & 31;
    b.c.sort((x, y) => key(x) - key(y));
    // am gewichteten Median teilen
    let acc = 0, half = b.n / 2, cut = 1;
    for (let i = 0; i < b.c.length; i++) { acc += hist[b.c[i]]; if (acc >= half) { cut = Math.max(1, Math.min(b.c.length - 1, i + 1)); break; } }
    const a = { c: b.c.slice(0, cut) }, c = { c: b.c.slice(cut) };
    stats(a); stats(c);
    boxes.splice(bi, 1, a, c);
  }
  const pal = new Uint8Array(256 * 3);
  boxes.forEach((b, i) => {
    let r = 0, g = 0, bl = 0, n = 0;
    for (const k of b.c) { const w = hist[k]; r += (k >> 10) * w; g += ((k >> 5) & 31) * w; bl += (k & 31) * w; n += w; }
    pal[i * 3] = Math.round((r / n) * 255 / 31); pal[i * 3 + 1] = Math.round((g / n) * 255 / 31); pal[i * 3 + 2] = Math.round((bl / n) * 255 / 31);
  });
  // Nachschlagetabelle: nur für vorkommende Farben die nächste Palettenfarbe suchen
  const lut = new Uint8Array(32768), N = boxes.length;
  for (const k of cols) {
    const r = ((k >> 10) * 255 / 31), g = (((k >> 5) & 31) * 255 / 31), b = ((k & 31) * 255 / 31);
    let bi = 0, bd = Infinity;
    for (let i = 0; i < N; i++) {
      const dr = r - pal[i * 3], dg = g - pal[i * 3 + 1], db = b - pal[i * 3 + 2];
      const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
      if (d < bd) { bd = d; bi = i; }
    }
    lut[k] = bi;
  }
  return { pal, lut, n: N };
}

// ---------------------------------------------------------------------------------
// LZW
// ---------------------------------------------------------------------------------
function lzw(indices, minCode, out) {
  out.byte(minCode);
  const clear = 1 << minCode, eoi = clear + 1;
  let codeSize = minCode + 1, next = eoi + 1;
  const dict = new Map();
  let cur = 0, bits = 0;
  const block = new Uint8Array(255); let bn = 0;
  const flushBlock = () => { if (!bn) return; out.byte(bn); out.bytes(block.subarray(0, bn)); bn = 0; };
  const emit = code => {
    cur |= code << bits; bits += codeSize;
    while (bits >= 8) { block[bn++] = cur & 255; if (bn === 255) flushBlock(); cur >>>= 8; bits -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear); dict.clear(); codeSize = minCode + 1; next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) { block[bn++] = cur & 255; if (bn === 255) flushBlock(); }
  flushBlock();
  out.byte(0);
}

// ---------------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------------
export class GifEncoder {
  constructor(w, h, { loop = true } = {}) {
    this.w = w; this.h = h; this.o = new ByteOut();
    const o = this.o;
    o.str('GIF89a'); o.word(w); o.word(h);
    o.byte(0x00); o.byte(0); o.byte(0);                         // keine globale Farbtabelle
    if (loop) { o.byte(0x21); o.byte(0xff); o.byte(11); o.str('NETSCAPE2.0'); o.byte(3); o.byte(1); o.word(0); o.byte(0); }
  }
  /** imageData: ImageData (w×h), delay in ms */
  addFrame(imageData, delay) {
    const o = this.o, px = imageData.data;
    const { pal, lut } = quantize(px);
    const n = this.w * this.h, idx = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) idx[i] = lut[((px[j] >> 3) << 10) | ((px[j + 1] >> 3) << 5) | (px[j + 2] >> 3)];
    // Graphic Control Extension
    o.byte(0x21); o.byte(0xf9); o.byte(4); o.byte(0x04); o.word(Math.max(2, Math.round(delay / 10))); o.byte(0); o.byte(0);
    // Image Descriptor mit lokaler Farbtabelle (256 Einträge)
    o.byte(0x2c); o.word(0); o.word(0); o.word(this.w); o.word(this.h); o.byte(0x80 | 7);
    o.bytes(pal);
    lzw(idx, 8, o);
  }
  finish() { this.o.byte(0x3b); return this.o.out(); }
}
