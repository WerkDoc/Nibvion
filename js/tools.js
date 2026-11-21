// ================= PDF-Werkzeuge: Wasserzeichen, Komprimieren, Passwort =================
// Alles lokal. Wasserzeichen & Komprimieren mit pdf-lib (window.PDFLib),
// Passwort (AES-256) mit @cantoo/pdf-lib (lib/pdf-lib-crypt.esm.min.js, erst bei Bedarf geladen).

const L = () => window.PDFLib;

// ---------- Wasserzeichen ----------
export const WM_COLORS = { rot: '#e53935', grau: '#7d8592', blau: '#1e5bd8', schwarz: '#111318' };

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Lage des Textes in Ansichts-Koordinaten (Ursprung unten links, Punkt) berechnen
export function wmLayout(W, H, textWidthAt1, { diagonal = true, scale = 1 } = {}) {
  const a = diagonal ? Math.atan2(H, W) : 0;
  const len = diagonal ? Math.hypot(W, H) : W;
  let size = (len * 0.62 * scale) / textWidthAt1;
  size = Math.min(size, (diagonal ? 0.22 : 0.16) * Math.min(W, H) * 2.2 * scale, 220);
  const tw = textWidthAt1 * size, cap = size * 0.72;
  const cos = Math.cos(a), sin = Math.sin(a);
  const x = W / 2 - (tw / 2) * cos + (cap / 2) * sin;
  const y = H / 2 - (tw / 2) * sin - (cap / 2) * cos;
  return { x, y, size, angle: a * 180 / Math.PI };
}

export async function addWatermark(bytes, { text, opacity = 0.25, color = WM_COLORS.rot, diagonal = true, scale = 1 }) {
  const { PDFDocument, StandardFonts, degrees, rgb } = L();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const t = cleanWinAnsi(font, text);
  if (!t.trim()) throw new Error('Kein Text');
  const w1 = font.widthOfTextAtSize(t, 1);
  const [r, g, b] = hexRgb(color);
  for (const page of doc.getPages()) {
    const box = page.getCropBox ? page.getCropBox() : page.getMediaBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const w = box.width, h = box.height;
    const [W, H] = rot % 180 ? [h, w] : [w, h];
    const l = wmLayout(W, H, w1, { diagonal, scale });
    // Ansicht → Seitenkoordinaten (Seitendrehung berücksichtigen)
    let px, py, ang;
    if (rot === 90) { px = w - l.y; py = l.x; ang = l.angle + 90; }
    else if (rot === 180) { px = w - l.x; py = h - l.y; ang = l.angle + 180; }
    else if (rot === 270) { px = l.y; py = h - l.x; ang = l.angle + 270; }
    else { px = l.x; py = l.y; ang = l.angle; }
    page.drawText(t, { x: box.x + px, y: box.y + py, size: l.size, font, color: rgb(r, g, b), opacity, rotate: degrees(ang) });
  }
  return doc.save();
}

function cleanWinAnsi(font, s) {
  let o = '';
  for (const ch of s) { try { font.encodeText(ch); o += ch; } catch {} }
  return o;
}

// Vorschau auf ein Canvas zeichnen (Seite 1 als Bild schon vorhanden)
export function drawWatermarkPreview(ctx, img, pageW, pageH, { text, opacity, color, diagonal, scale }) {
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (!text.trim()) return;
  const k = c.width / pageW;
  ctx.save();
  ctx.font = '700 100px Helvetica, Arial, sans-serif';
  const w1 = ctx.measureText(text).width / 100;
  const l = wmLayout(pageW, pageH, w1, { diagonal, scale });
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  ctx.font = `700 ${l.size * k}px Helvetica, Arial, sans-serif`;
  ctx.translate(l.x * k, c.height - l.y * k);
  ctx.rotate(-l.angle * Math.PI / 180);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

// ---------- Komprimieren ----------
export const COMPRESS = {
  stark: { max: 1100, q: 0.5 },
  standard: { max: 1600, q: 0.66 },
  leicht: { max: 2400, q: 0.82 },
};

function canvasJpeg(c, q) {
  return new Promise((res, rej) => c.toBlob(b => b ? b.arrayBuffer().then(a => res(new Uint8Array(a)), rej) : rej(new Error('JPEG')), 'image/jpeg', q));
}

export async function compressPdf(bytes, level = 'standard', onProgress) {
  const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFNumber, PDFBool, decodePDFRawStream } = L();
  const cfg = COMPRESS[level] || COMPRESS.standard;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const N = n => PDFName.of(n);
  const name = v => (v instanceof PDFName ? v.asString() : v && v.toString ? v.toString() : '');
  const images = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (name(d.get(N('Subtype'))) !== '/Image') continue;
    images.push([ref, obj]);
  }
  let done = 0, changed = 0;
  for (const [ref, obj] of images) {
    onProgress && onProgress(++done, images.length);
    try {
      const d = obj.dict;
      const lookup = k => doc.context.lookup(d.get(N(k)));
      if (lookup('ImageMask') instanceof PDFBool && lookup('ImageMask').asBoolean()) continue;
      if (d.get(N('Decode')) || d.get(N('Mask'))) continue;
      const bpc = lookup('BitsPerComponent');
      if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8) continue;
      const W = lookup('Width')?.asNumber?.(), H = lookup('Height')?.asNumber?.();
      if (!W || !H || W * H < 40000) continue;      // kleine Bilder lohnen nicht
      // Farbraum
      let cs = lookup('ColorSpace'), comps = 0;
      if (cs instanceof PDFName) comps = { '/DeviceRGB': 3, '/DeviceGray': 1 }[cs.asString()] || 0;
      else if (cs instanceof PDFArray && name(cs.get(0)) === '/ICCBased') {
        const icc = doc.context.lookup(cs.get(1));
        const n = icc?.dict ? doc.context.lookup(icc.dict.get(N('N')))?.asNumber?.() : 0;
        comps = n === 3 || n === 1 ? n : 0;
      }
      if (!comps) continue;                          // CMYK, Indexed … lieber nicht anfassen
      // Filter (auch Ketten wie ASCII85 + DCT)
      let f = lookup('Filter');
      const filters = f instanceof PDFArray ? f.asArray().map(x => name(doc.context.lookup(x))) : f ? [name(f)] : [];
      const DECODABLE = ['/FlateDecode', '/ASCII85Decode', '/ASCIIHexDecode', '/LZWDecode', '/RunLengthDecode'];
      const decodeWith = list => {
        if (!list.length) return obj.contents;
        const td = d.clone(doc.context);
        td.set(N('Filter'), list.length === 1 ? N(list[0].slice(1)) : doc.context.obj(list.map(x => N(x.slice(1)))));
        return decodePDFRawStream(PDFRawStream.of(td, obj.contents)).decode();
      };
      let source;
      if (filters.length && filters[filters.length - 1] === '/DCTDecode' && filters.slice(0, -1).every(x => DECODABLE.includes(x))) {
        const jpg = decodeWith(filters.slice(0, -1));
        source = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' }));
      } else if (filters.length && filters.every(x => DECODABLE.includes(x))) {
        const parms = lookup('DecodeParms');
        const pd = parms instanceof PDFArray ? doc.context.lookup(parms.get(parms.size() - 1)) : parms;
        if (pd && pd.get && doc.context.lookup(pd.get(N('Predictor')))?.asNumber?.() > 1) continue;
        const raw = decodeWith(filters);
        if (raw.length < W * H * comps) continue;
        const id = new ImageData(W, H);
        for (let i = 0, j = 0; i < W * H; i++) {
          const o = i * 4;
          if (comps === 3) { id.data[o] = raw[j++]; id.data[o + 1] = raw[j++]; id.data[o + 2] = raw[j++]; }
          else { id.data[o] = id.data[o + 1] = id.data[o + 2] = raw[j++]; }
          id.data[o + 3] = 255;
        }
        source = await createImageBitmap(id);
      } else continue;
      const s = Math.min(1, cfg.max / Math.max(W, H));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(W * s)); c.height = Math.max(1, Math.round(H * s));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(source, 0, 0, c.width, c.height);
      source.close && source.close();
      const jpg = await canvasJpeg(c, cfg.q);
      c.width = c.height = 0;
      if (jpg.length > obj.contents.length * 0.9) continue;
      const nd = d.clone(doc.context);
      nd.set(N('Filter'), N('DCTDecode'));
      nd.delete(N('DecodeParms'));
      nd.set(N('Width'), PDFNumber.of(Math.round(W * s)));
      nd.set(N('Height'), PDFNumber.of(Math.round(H * s)));
      nd.set(N('ColorSpace'), N('DeviceRGB'));
      nd.set(N('BitsPerComponent'), PDFNumber.of(8));
      nd.delete(N('Length'));
      doc.context.assign(ref, PDFRawStream.of(nd, jpg));
      changed++;
    } catch (e) { console.warn('Bild übersprungen', e); }
  }
  const out = await doc.save({ useObjectStreams: true });
  return { bytes: out.length < bytes.byteLength ? out : new Uint8Array(bytes), images: images.length, changed };
}

// ---------- Passwort ----------
let crypt;
const loadCrypt = () => crypt ??= import('../lib/pdf-lib-crypt.esm.min.js');

function randomPw() {
  const a = new Uint8Array(18); crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a));
}

export async function encryptPdf(bytes, password) {
  const C = await loadCrypt();
  const doc = await C.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  doc.encrypt({
    userPassword: password,
    ownerPassword: randomPw(),
    permissions: { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true },
  });
  return doc.save();
}

export async function decryptPdf(bytes, password) {
  const C = await loadCrypt();
  const doc = await C.PDFDocument.load(bytes, { password });
  return doc.save();
}
