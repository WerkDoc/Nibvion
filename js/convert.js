// ================= Office → PDF (Word, Excel) =================
// Alles lokal im Browser: Das Dokument wird als HTML gesetzt (docx-preview bzw. eigener
// Tabellen-Renderer), seitenweise gerastert (html2canvas) und mit einer unsichtbaren
// Textebene (durchsuchbar & markierbar) per pdf-lib zu einem PDF zusammengesetzt.
// Bibliotheken werden erst bei Bedarf aus lib/ nachgeladen.

// ---------- Bibliotheken bei Bedarf laden ----------
const pending = {};
export function loadLib(name) {
  if (!pending[name]) pending[name] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL(`../lib/${name}`, import.meta.url).href;
    s.onload = () => res();
    s.onerror = () => { delete pending[name]; s.remove(); rej(new Error('Bibliothek konnte nicht geladen werden: ' + name)); };
    document.head.appendChild(s);
  });
  return pending[name];
}

export class ConvertError extends Error { constructor(m) { super(m); this.name = 'ConvertError'; } }
const fail = msg => { throw new ConvertError(msg); };
const tick = () => new Promise(r => setTimeout(r, 0));

// ---------- Schrift-Ersatz (iPhone hat kein Calibri/Cambria) ----------
// Ersatzschriften mit size-adjust, damit Zeilen- und Seitenumbrüche möglichst wie in Office bleiben.
const FONT_CSS = `
@font-face{font-family:"NibFB Calibri";src:local("Arial"),local("ArialMT"),local("Liberation Sans"),local("LiberationSans"),local("Helvetica");size-adjust:91%;font-weight:400}
@font-face{font-family:"NibFB Calibri";src:local("Arial Bold"),local("Arial-BoldMT"),local("Liberation Sans Bold"),local("LiberationSans-Bold"),local("Helvetica Bold"),local("Helvetica-Bold");size-adjust:87.5%;font-weight:700}
@font-face{font-family:"NibFB Cambria";src:local("Times New Roman"),local("TimesNewRomanPSMT"),local("Liberation Serif"),local("LiberationSerif");size-adjust:105.5%;font-weight:400}
@font-face{font-family:"NibFB Cambria";src:local("Times New Roman Bold"),local("TimesNewRomanPS-BoldMT"),local("Liberation Serif Bold"),local("LiberationSerif-Bold");size-adjust:103%;font-weight:700}`;
const FB = {
  'calibri': ['Carlito', 'NibFB Calibri'],
  'calibri light': ['Carlito', 'NibFB Calibri'],
  'cambria': ['Caladea', 'NibFB Cambria'],
  'aptos': ['Helvetica Neue', 'Arial'],
  'aptos narrow': ['Arial Narrow', 'Helvetica Neue'],
  'segoe ui': ['Helvetica Neue', 'Arial'],
  'tahoma': ['Verdana'],
  'century gothic': ['Avenir Next', 'Futura'],
  'franklin gothic book': ['Avenir Next', 'Helvetica Neue'],
  'garamond': ['Georgia', 'Times New Roman'],
  'book antiqua': ['Palatino', 'Georgia'],
  'consolas': ['Menlo', 'Courier New'],
};
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i;
const SERIF = /times|cambria|caladea|georgia|garamond|palatino|antiqua|constantia|serif/i;
function patchFamily(v) {
  if (/var\(/.test(v)) return v;
  const imp = /!important/i.test(v);
  const fams = v.replace(/!important/i, '').split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const f of fams) {
    out.push(f);
    for (const x of FB[f.replace(/^["']|["']$/g, '').toLowerCase()] || []) out.push(`"${x}"`);
  }
  if (!out.some(f => GENERIC.test(f))) out.push(SERIF.test(fams[0] || '') ? 'serif' : /consolas|courier|mono/i.test(fams[0] || '') ? 'monospace' : 'sans-serif');
  return out.join(', ') + (imp ? ' !important' : '');
}
const familyCss = name => patchFamily(`"${String(name || 'Calibri').replace(/"/g, '')}"`);

function ensureFonts() {
  if (document.getElementById('nib-fontfb')) return;
  const st = document.createElement('style'); st.id = 'nib-fontfb'; st.textContent = FONT_CSS;
  document.head.appendChild(st);
}

// ---------- Unsichtbare Arbeitsfläche ----------
function makeHost(cls) {
  ensureFonts();
  const h = document.createElement('div');
  h.className = 'cv-host ' + cls;
  document.body.appendChild(h);
  return h;
}

async function ready(root) {
  await Promise.all([...root.querySelectorAll('img')].map(i => i.complete
    ? (i.decode ? i.decode().catch(() => {}) : null)
    : new Promise(r => { i.onload = i.onerror = r; })));
  try { await document.fonts.ready; } catch {}
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// ---------- Rastern ----------
const DENSITY = 2;          // Canvas-Pixel je CSS-Pixel bei 100 % (≈ 192 dpi)
const MAX_AREA = 14e6;      // iOS-Canvas-Grenze (~16,7 MP) mit Reserve

async function snap(el, p) {
  // Immer die Arbeitsfläche (liegt bei 0/0) rendern – Ausschnitt relativ dazu
  const host = el.closest('.cv-host') || el;
  const r = host.getBoundingClientRect(), e = el.getBoundingClientRect();
  const ox = e.left - r.left, oy = e.top - r.top;
  let scale = DENSITY * p.k / 0.75;
  const area = p.w * p.h * scale * scale;
  if (area > MAX_AREA) scale *= Math.sqrt(MAX_AREA / area);
  return window.html2canvas(host, {
    x: ox + p.x, y: oy + p.y,
    width: Math.ceil(p.w), height: Math.ceil(p.h),
    scale, backgroundColor: '#ffffff', logging: false, useCORS: true, imageTimeout: 10000,
    windowWidth: Math.max(window.innerWidth, Math.ceil(r.right) + 20),
    windowHeight: Math.max(window.innerHeight, Math.ceil(r.bottom) + 20),
    ignoreElements: n => n.id === 'app' || n.id === 'sheet-layer' || n.id === 'splash' || n.id === 'toast' || (n.classList && n.classList.contains('busy')),
    onclone: d => d.querySelectorAll('.cv-host').forEach(h => { h.style.opacity = '1'; }),
  });
}

function canvasJpeg(c) {
  return new Promise((res, rej) => c.toBlob(b => b
    ? b.arrayBuffer().then(a => res(new Uint8Array(a)), rej)
    : rej(new Error('Seite konnte nicht gerendert werden')), 'image/jpeg', 0.8));
}

// ---------- Textebene ----------
function collectRuns(root) {
  const base = root.getBoundingClientRect();
  const out = [], styles = new Map(), range = document.createRange();
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    const s = n.nodeValue;
    if (!s || !/\S/.test(s)) continue;
    const pe = n.parentElement;
    if (!pe || pe.closest('style,script')) continue;
    let st = styles.get(pe);
    if (!st) {
      const cs = getComputedStyle(pe);
      st = { fs: parseFloat(cs.fontSize) || 12, vis: cs.visibility !== 'hidden' && cs.display !== 'none' };
      styles.set(pe, st);
    }
    if (!st.vis) continue;
    const re = /\S+/g;
    for (let m; (m = re.exec(s));) {
      range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length);
      const rects = range.getClientRects();
      if (!rects.length) continue;
      const b = rects[0];
      if (b.width < 0.3 || b.height < 0.3) continue;
      out.push({ t: m[0], x: b.left - base.left, y: b.top - base.top, w: b.width, h: b.height, fs: st.fs });
    }
  }
  return out;
}

const okChar = new Map();
const SUBST = { '−': '-', '‐': '-', '‑': '-', ' ': ' ', ' ': ' ', ' ': ' ', '→': '->', '•': '•', '✓': 'v', '✔': 'v' };
function safeText(font, s) {
  let o = '';
  for (const ch of s) {
    let ok = okChar.get(ch);
    if (ok === undefined) { try { font.encodeText(ch); font.widthOfTextAtSize(ch, 10); ok = true; } catch { ok = false; } okChar.set(ch, ok); }
    if (ok) o += ch;
    else if (SUBST[ch]) o += SUBST[ch];
  }
  return o;
}

function textLayer(page, font, fkey, runs, p, pageH) {
  const L = window.PDFLib;
  const ops = [];
  for (const r of runs) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    if (cx < p.x || cx > p.x + p.w || cy < p.y || cy > p.y + p.h) continue;
    const t = safeText(font, r.t);
    if (!t.trim()) continue;
    const size = Math.max(1, r.fs * p.k);
    const nat = font.widthOfTextAtSize(t, size);
    if (!nat) continue;
    const sq = Math.min(400, Math.max(20, (r.w * p.k) / nat * 100));
    const x = p.dx + (r.x - p.x) * p.k;
    const top = p.dy + (r.y - p.y) * p.k;
    const y = pageH - (top + r.h * p.k * 0.8);
    ops.push(L.setCharacterSqueeze(sq), L.setFontAndSize(fkey, size), L.setTextMatrix(1, 0, 0, 1, x, y), L.showText(font.encodeText(t + ' ')));
  }
  if (!ops.length) return;
  page.pushOperators(L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible), ...ops, L.endText(), L.popGraphicsState());
}

// ---------- PDF zusammensetzen ----------
// pages: [{ w, h (pt), parts: [{ el, x, y, w, h (CSS-px im Element), dx, dy (pt auf der Seite), k (pt je px), key? }] }]
async function assemble(pages, onProgress, title) {
  const { PDFDocument, StandardFonts } = window.PDFLib;
  const doc = await PDFDocument.create();
  doc.setProducer('Nibvion'); doc.setCreator('Nibvion');
  if (title) doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const imgs = new Map(), runs = new Map();
  for (let i = 0; i < pages.length; i++) {
    onProgress && onProgress(i + 1, pages.length);
    await tick();
    const pg = pages[i];
    const page = doc.addPage([pg.w, pg.h]);
    const fkey = page.node.newFontDictionary(font.name, font.ref);
    for (const p of pg.parts) {
      if (p.w < 1 || p.h < 1) continue;
      let img = p.key ? imgs.get(p.key) : null;
      if (!img) {
        const c = await snap(p.el, p);
        img = await doc.embedJpg(await canvasJpeg(c));
        c.width = c.height = 0;
        if (p.key) imgs.set(p.key, img);
      }
      page.drawImage(img, { x: p.dx, y: pg.h - p.dy - p.h * p.k, width: p.w * p.k, height: p.h * p.k });
      if (!runs.has(p.el)) runs.set(p.el, collectRuns(p.el));
      textLayer(page, font, fkey, runs.get(p.el), p, pg.h);
    }
  }
  return doc.save();
}

const isZip = buf => { if (buf.byteLength < 4) return false; const b = new Uint8Array(buf, 0, 4); return b[0] === 0x50 && b[1] === 0x4B; };
const isOle = buf => { if (buf.byteLength < 4) return false; const b = new Uint8Array(buf, 0, 4); return b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0; };

// =====================================================================
//                               WORD
// =====================================================================
export async function wordToPdf(buf, { onProgress, title } = {}) {
  if (isOle(buf)) fail('Altes Word-Format (.doc) wird nicht unterstützt. Bitte in Word als .docx speichern.');
  if (!isZip(buf)) fail('Keine Word-Datei (.docx)');
  await Promise.all([loadLib('jszip.min.js'), loadLib('html2canvas.min.js')]);
  await loadLib('docx-preview.min.js');
  const host = makeHost('cv-word');
  try {
    try {
      await window.docx.renderAsync(buf, host, host, {
        className: 'docx', inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false,
        breakPages: true, ignoreLastRenderedPageBreak: false, experimental: true, trimXmlDeclaration: true,
        useBase64URL: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
        renderComments: false, renderChanges: false, debug: false,
      });
    } catch (e) { console.warn(e); fail('Word-Datei konnte nicht gelesen werden'); }
    // Schriften mit Ersatzschriften ergänzen
    host.querySelectorAll('style').forEach(st => {
      st.textContent = st.textContent
        .replace(/(--docx-[\w-]*font)\s*:\s*([^;}]+)/g, (m, k, v) => `${k}: ${patchFamily(v)}`)
        .replace(/font-family\s*:\s*([^;}]+)/gi, (m, v) => `font-family: ${patchFamily(v)}`);
    });
    host.querySelectorAll('[style*="font-family"]').forEach(el => { el.style.fontFamily = patchFamily(el.style.fontFamily); });
    await ready(host);

    const secs = [...host.querySelectorAll('section.docx')];
    if (!secs.length) fail('Das Dokument ist leer');
    const pages = [];
    for (const s of secs) {
      const cs = getComputedStyle(s);
      const W = s.offsetWidth, H = s.offsetHeight;
      const PH = parseFloat(cs.minHeight) || W * 1.4142;
      const wPt = W * 0.75, hPt = PH * 0.75;
      if (H <= PH + 1) { pages.push({ w: wPt, h: hPt, parts: [{ el: s, x: 0, y: 0, w: W, h: PH, dx: 0, dy: 0, k: 0.75 }] }); continue; }
      // Leichter Überlauf (z. B. Ersatzschrift): Seite minimal verkleinern statt neue Seite
      if (H <= PH * 1.08) {
        const k = 0.75 * PH / H;
        pages.push({ w: wPt, h: hPt, parts: [{ el: s, x: 0, y: 0, w: W, h: H, dx: (wPt - W * k) / 2, dy: 0, k }] });
        continue;
      }
      // Lange Seite (ohne gespeicherte Seitenumbrüche): an Zeilengrenzen aufteilen
      const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
      const obst = obstacles(s);
      let start = 0, first = true;
      while (start < H - 1) {
        if (!first && !obst.some(([a, b]) => b > start + 1)) break;
        const top = first ? 0 : padT;
        const avail = PH - padB - top;
        let end = start + avail;
        end = end >= H ? H : cutAt(obst, start, end, avail);
        pages.push({ w: wPt, h: hPt, parts: [{ el: s, x: 0, y: start, w: W, h: end - start, dx: 0, dy: top * 0.75, k: 0.75 }] });
        start = end; first = false;
      }
    }
    return await assemble(pages, onProgress, title);
  } finally { host.remove(); }
}

function obstacles(root) {
  const base = root.getBoundingClientRect().top, out = [];
  const range = document.createRange();
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    if (!/\S/.test(n.nodeValue) || n.parentElement?.closest('style')) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.height > 0) out.push([r.top - base, r.bottom - base]);
  }
  root.querySelectorAll('img,svg,canvas').forEach(e => { const r = e.getBoundingClientRect(); if (r.height > 0) out.push([r.top - base, r.bottom - base]); });
  return out;
}

function cutAt(obst, start, end, avail) {
  let y = end;
  for (let g = 0; g < 400; g++) {
    const hit = obst.find(([a, b]) => a < y - 0.5 && b > y + 0.5);
    if (!hit) break;
    y = hit[0];
  }
  return y - start < avail * 0.35 ? end : y;
}

// =====================================================================
//                               EXCEL
// =====================================================================
const THEME_DEF = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];
const INDEXED = ('000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF '
  + '800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF '
  + '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 '
  + '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333 000000 FFFFFF').split(' ');
const PAPER = { 1: [612, 792], 5: [612, 1008], 8: [841.89, 1190.55], 9: [595.28, 841.89], 11: [419.53, 595.28] };
const BORDER = {
  thin: '1px solid', hair: '1px solid', medium: '2px solid', thick: '3px solid', double: '3px double',
  dashed: '1px dashed', dotted: '1px dotted', mediumDashed: '2px dashed', dashDot: '1px dashed',
  mediumDashDot: '2px dashed', dashDotDot: '1px dotted', mediumDashDotDot: '2px dotted', slantDashDot: '2px dashed',
};
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escH = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function tint(hex, t) {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  }
  l = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  const f = (p, q, x) => { if (x < 0) x += 1; if (x > 1) x -= 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p; };
  let R, G, B;
  if (!s) R = G = B = l;
  else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; R = f(p, q, h + 1 / 3); G = f(p, q, h); B = f(p, q, h - 1 / 3); }
  return [R, G, B].map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

function xlColor(c, theme) {
  if (!c) return null;
  let hex = null;
  if (c.argb) hex = c.argb.length >= 8 ? c.argb.slice(-6) : c.argb.padStart(6, '0');
  else if (c.theme != null) hex = theme[c.theme] ?? null;
  else if (c.indexed != null) hex = INDEXED[c.indexed] ?? null;
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  if (c.tint) hex = tint(hex, c.tint);
  return '#' + hex;
}

function parseTheme(xml) {
  if (!xml) return THEME_DEF;
  try {
    const d = new DOMParser().parseFromString(xml, 'application/xml');
    const cs = d.getElementsByTagNameNS('*', 'clrScheme')[0];
    if (!cs) return THEME_DEF;
    const get = n => { const c = cs.getElementsByTagNameNS('*', n)[0]?.firstElementChild; return c ? (c.getAttribute('lastClr') || c.getAttribute('val')) : null; };
    return ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map((n, i) => get(n) || THEME_DEF[i]);
  } catch { return THEME_DEF; }
}

// ---------- Zahlenformate (deutsche Darstellung) ----------
const DATE_FIX = {
  'mm-dd-yy': 'dd\\.mm\\.yyyy', 'm/d/yy': 'dd\\.mm\\.yyyy', 'm/d/yyyy': 'dd\\.mm\\.yyyy', 'mm/dd/yy': 'dd\\.mm\\.yyyy', 'mm/dd/yyyy': 'dd\\.mm\\.yyyy',
  'd-mmm-yy': 'dd\\. mmm yy', 'd-mmm': 'dd\\. mmm', 'mmm-yy': 'mmm yy', 'm/d/yy h:mm': 'dd\\.mm\\.yyyy hh:mm', 'm/d/yyyy h:mm': 'dd\\.mm\\.yyyy hh:mm',
  'h:mm AM/PM': 'hh:mm', 'h:mm:ss AM/PM': 'hh:mm:ss',
};
const MONTHS = { January: 'Januar', February: 'Februar', March: 'März', May: 'Mai', June: 'Juni', July: 'Juli', October: 'Oktober', December: 'Dezember', Mar: 'Mär', Oct: 'Okt', Dec: 'Dez' };
const DAYS = { Monday: 'Montag', Tuesday: 'Dienstag', Wednesday: 'Mittwoch', Thursday: 'Donnerstag', Friday: 'Freitag', Saturday: 'Samstag', Sunday: 'Sonntag', Mon: 'Mo', Tue: 'Di', Wed: 'Mi', Thu: 'Do', Fri: 'Fr', Sat: 'Sa', Sun: 'So' };
const swapSep = s => s.replace(/\d[\d,.]*\d|\d/g, m => m.replace(/[,.]/g, c => c === ',' ? '.' : ','));

function fmtNum(v, fmt) {
  const SSF = window.XLSX.SSF;
  fmt = !fmt ? 'General' : (DATE_FIX[fmt] || fmt);
  let s, date = false;
  try { date = SSF.is_date(fmt); s = SSF.format(fmt, v); }
  catch {
    // z. B. „dd.mm.yyyy“: Punkte als Literal behandeln
    try { fmt = fmt.replace(/(^|[^\\])\./g, '$1\\.'); date = SSF.is_date(fmt); s = SSF.format(fmt, v); }
    catch { s = String(v); date = false; }
  }
  if (date) s = s.replace(/\b[A-Z][a-z]+\b/g, w => MONTHS[w] || DAYS[w] || w);
  else s = swapSep(s);
  const red = v < 0 && /\[(red|rot)\]/i.test(fmt.split(';')[1] || '') || (v < 0 && /^\[(red|rot)\]/i.test(fmt) && !fmt.includes(';'));
  return { t: s, red };
}
const serial = d => d.getTime() / 864e5 + 25569;

// ---------- Datei lesen ----------
function resolvePath(dir, t) {
  if (t.startsWith('/')) return t.slice(1);
  const o = [];
  for (const p of (dir + t).split('/')) { if (p === '..') o.pop(); else if (p && p !== '.') o.push(p); }
  return o.join('/');
}

async function readDrawings(zip) {
  const res = {};
  const xml = async p => { const f = zip.file(p); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null; };
  const rels = async p => {
    const dir = p.replace(/[^/]+$/, '');
    const d = await xml(dir + '_rels/' + p.split('/').pop() + '.rels');
    const m = {};
    if (d) for (const r of d.getElementsByTagNameNS('*', 'Relationship')) {
      if (r.getAttribute('TargetMode') === 'External') continue;
      m[r.getAttribute('Id')] = { type: r.getAttribute('Type') || '', target: resolvePath(dir, r.getAttribute('Target') || '') };
    }
    return m;
  };
  const wb = await xml('xl/workbook.xml');
  if (!wb) return res;
  const wbRels = await rels('xl/workbook.xml');
  for (const s of wb.getElementsByTagNameNS('*', 'sheet')) {
    const sp = wbRels[s.getAttributeNS(R_NS, 'id') || s.getAttribute('r:id')]?.target;
    if (!sp) continue;
    const out = [];
    for (const r of Object.values(await rels(sp))) {
      if (!/\/drawing$/.test(r.type)) continue;
      const d = await xml(r.target);
      if (!d) continue;
      const dr = await rels(r.target);
      for (const a of d.documentElement.children) {
        const ln = a.localName;
        if (!/Anchor$/.test(ln)) continue;
        const blip = a.getElementsByTagNameNS('*', 'blip')[0];
        if (!blip) continue;
        const media = dr[blip.getAttributeNS(R_NS, 'embed') || blip.getAttribute('r:embed')]?.target;
        const f = media && zip.file(media);
        if (!f) continue;
        const mime = /\.png$/i.test(media) ? 'image/png' : /\.jpe?g$/i.test(media) ? 'image/jpeg' : /\.gif$/i.test(media) ? 'image/gif' : /\.(bmp)$/i.test(media) ? 'image/bmp' : null;
        if (!mime) continue;
        const anchor = name => {
          const e = [...a.children].find(x => x.localName === name);
          if (!e) return null;
          const g = n => +([...e.children].find(x => x.localName === n)?.textContent || 0);
          return { c: g('col'), cOff: g('colOff') / 9525, r: g('row'), rOff: g('rowOff') / 9525 };
        };
        const extE = [...a.children].find(x => x.localName === 'ext');
        const posE = [...a.children].find(x => x.localName === 'pos');
        out.push({
          src: `data:${mime};base64,` + await f.async('base64'),
          from: anchor('from'), to: ln === 'twoCellAnchor' ? anchor('to') : null,
          ext: extE ? { w: +extE.getAttribute('cx') / 9525, h: +extE.getAttribute('cy') / 9525 } : null,
          pos: posE ? { x: +posE.getAttribute('x') / 9525, y: +posE.getAttribute('y') / 9525 } : null,
        });
      }
    }
    res[s.getAttribute('name')] = out;
  }
  return res;
}

// Zeichnungen entfernen, bevor ExcelJS liest (Bilder lesen wir selbst – robuster)
async function stripDrawings(zip) {
  for (const p of Object.keys(zip.files)) {
    if (/^xl\/drawings\/(_rels\/)?[^/]+\.xml(\.rels)?$/.test(p)) zip.remove(p);
    else if (/^xl\/worksheets\/[^/]+\.xml$/.test(p)) {
      const x = await zip.file(p).async('string');
      const y = x.replace(/<(?:\w+:)?drawing\b[^>]*\/>/g, '');
      if (y !== x) zip.file(p, y);
    } else if (/^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(p)) {
      const x = await zip.file(p).async('string');
      const y = x.replace(/<Relationship\b[^>]*relationships\/drawing"[^>]*\/>/g, '');
      if (y !== x) zip.file(p, y);
    }
  }
  return zip.generateAsync({ type: 'arraybuffer' });
}

export async function readWorkbook(buf) {
  await Promise.all([loadLib('xlsx.core.min.js'), loadLib('jszip.min.js')]);
  if (isZip(buf)) {
    try {
      const zip = await window.JSZip.loadAsync(buf);
      if (zip.file('xl/workbook.xml')) {
        const theme = parseTheme(await zip.file('xl/theme/theme1.xml')?.async('string'));
        let images = {};
        try { images = await readDrawings(zip); } catch (e) { console.warn('Bilder', e); }
        await loadLib('exceljs.min.js');
        const clean = await stripDrawings(zip);
        const wb = new window.ExcelJS.Workbook();
        await wb.xlsx.load(clean);
        const sheets = wb.worksheets.filter(ws => ws.state !== 'hidden' && ws.state !== 'veryHidden')
          .map(ws => fromExcelJS(ws, theme, images[ws.name] || [])).filter(Boolean);
        if (sheets.length) return { sheets };
      }
    } catch (e) { console.warn('ExcelJS → SheetJS', e); }
  }
  const sheets = isZip(buf) || isOle(buf) ? fromSheetJS(buf) : fromCsv(buf);
  if (!sheets.length) fail('Die Tabelle ist leer oder konnte nicht gelesen werden');
  return { sheets };
}

function fontOf(f, theme) {
  if (!f) return {};
  return {
    name: f.name, size: f.size, bold: !!f.bold, italic: !!f.italic, strike: !!f.strike,
    under: f.underline === true || f.underline === 'single' || f.underline === 'singleAccounting' ? 'underline' : f.underline === 'double' || f.underline === 'doubleAccounting' ? 'underline double' : '',
    color: xlColor(f.color, theme), vert: f.vertAlign,
  };
}

function fromExcelJS(ws, theme, images) {
  const MAXR = 6000, MAXC = 250;
  const cells = new Map();
  let r1 = Infinity, c1 = Infinity, r2 = 0, c2 = 0;
  const grow = (r, c) => { r1 = Math.min(r1, r); c1 = Math.min(c1, c); r2 = Math.max(r2, r); c2 = Math.max(c2, c); };
  const nR = Math.min(ws.rowCount || 0, MAXR);
  for (let r = 1; r <= nR; r++) {
    const row = ws.findRow ? ws.findRow(r) : ws.getRow(r);
    if (!row) continue;
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (c > MAXC) return;
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) { if (hasBox(cell)) grow(r, c); return; }
      const txt = cellText(cell);
      if (txt?.rich) { txt.html = txt.rich.map(rt => `<span style="${fontCss(fontOf(rt.font, theme))}">${escH(rt.text ?? '')}</span>`).join(''); txt.t = txt.rich.map(rt => rt.text ?? '').join(''); delete txt.rich; }
      const st = cellStyle(cell, theme);
      if (txt || st.fill || st.b) {
        cells.set(r + ':' + c, { ...(txt || {}), st });
        grow(r, c);
      }
    });
  }
  const merges = Object.values(ws._merges || {}).map(m => m.model || m).filter(m => m && m.top)
    .map(m => ({ r1: m.top, c1: m.left, r2: m.bottom, c2: m.right }));
  merges.forEach(m => { if (cells.has(m.r1 + ':' + m.c1)) { grow(m.r1, m.c1); grow(m.r2, m.c2); } });
  // Bilder erweitern den Druckbereich
  for (const im of images) {
    if (im.from) grow(im.from.r + 1, im.from.c + 1);
    if (im.to) grow(Math.max(1, im.to.r + (im.to.rOff > 0 ? 1 : 0)), Math.max(1, im.to.c + (im.to.cOff > 0 ? 1 : 0)));
  }
  const ps = ws.pageSetup || {};
  // Druckbereich
  const pa = String(ps.printArea || '').split(/&&|,/)[0].replace(/^.*!/, '').replace(/\$/g, '');
  const pm = pa.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (pm) { c1 = colNum(pm[1]); r1 = +pm[2]; c2 = colNum(pm[3]); r2 = +pm[4]; }
  if (!isFinite(r1)) return null;

  const colW = {}, colHidden = new Set(), rowH = {}, rowHidden = new Set();
  const defW = ws.properties?.defaultColWidth;
  for (let c = c1; c <= c2; c++) {
    const col = ws.getColumn(c);
    if (col.hidden) colHidden.add(c);
    const w = col.width ?? defW;
    colW[c] = w ? Math.max(0, Math.trunc(((256 * w + 18) / 256) * 7)) : 64;
  }
  const defH = ws.properties?.defaultRowHeight || 15;
  for (let r = r1; r <= r2; r++) {
    const row = ws.findRow ? ws.findRow(r) : ws.getRow(r);
    if (row?.hidden) rowHidden.add(r);
    rowH[r] = (row?.height || defH) * 4 / 3;
  }
  // Rahmen verbundener Zellen: rechts/unten von den Randzellen übernehmen
  for (const m of merges) {
    const k = m.r1 + ':' + m.c1;
    const cell = cells.get(k);
    if (!cell) continue;
    const b = { ...(cell.st.b || {}) };
    const rb = cellStyle(ws.getCell(m.r1, m.c2), theme).b, bb = cellStyle(ws.getCell(m.r2, m.c1), theme).b;
    if (rb?.right) b.right = rb.right;
    if (bb?.bottom) b.bottom = bb.bottom;
    cell.st.b = Object.keys(b).length ? b : null;
  }
  const titles = String(ps.printTitlesRow || '').replace(/\$/g, '').match(/^(\d+):(\d+)$/);
  return {
    name: ws.name, r1, c1, r2, c2, cells, merges, colW, colHidden, rowH, rowHidden, images,
    setup: {
      paper: ps.paperSize, orient: ps.orientation, fit: !!ps.fitToPage, fitW: ps.fitToWidth ?? 1, fitH: ps.fitToHeight ?? 1,
      scale: ps.scale || 100, hCenter: !!ps.horizontalCentered, grid: !!ps.showGridLines,
      margins: ps.margins || null, titles: titles ? [+titles[1], +titles[2]] : null,
    },
  };
}

const colNum = s => s.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const hasBox = cell => { const f = cell.fill; return (f && f.type === 'pattern' && f.pattern && f.pattern !== 'none') || (cell.border && Object.values(cell.border).some(x => x && x.style)); };

function cellText(cell) {
  let v = cell.value;
  if (v == null || v === '') return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (v.richText) return { rich: v.richText };
    if ('formula' in v || 'sharedFormula' in v) {
      v = v.result;
      if (v == null || v === '') return null;
      if (typeof v === 'object' && !(v instanceof Date)) return v.error ? { t: v.error } : null;
    } else if (v.hyperlink !== undefined || v.text !== undefined) {
      v = v.text;
      if (v && typeof v === 'object' && v.richText) return { rich: v.richText };
      if (v == null) return null;
    } else if (v.error) return { t: v.error };
    else return null;
  }
  if (v instanceof Date) { const f = fmtNum(serial(v), cell.numFmt && cell.numFmt !== 'General' ? cell.numFmt : 'mm-dd-yy'); return { t: f.t, num: true }; }
  if (typeof v === 'number') { const f = fmtNum(v, cell.numFmt); return { t: f.t, num: true, red: f.red }; }
  if (typeof v === 'boolean') return { t: v ? 'WAHR' : 'FALSCH', bool: true };
  return { t: String(v) };
}

function cellStyle(cell, theme) {
  const st = { font: fontOf(cell.font, theme) };
  const f = cell.fill;
  if (f && f.type === 'pattern' && f.pattern && f.pattern !== 'none') {
    st.fill = xlColor(f.fgColor, theme) || (f.pattern === 'solid' ? null : xlColor(f.bgColor, theme));
    if (!st.fill && f.pattern === 'solid') st.fill = null;
  } else if (f && f.type === 'gradient' && f.stops?.length) st.fill = xlColor(f.stops[0].color, theme);
  const b = cell.border;
  if (b) {
    const o = {};
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const s = b[side];
      if (s && s.style && BORDER[s.style]) o[side] = `${BORDER[s.style]} ${xlColor(s.color, theme) || '#000'}`;
    }
    st.b = Object.keys(o).length ? o : null;
  }
  const a = cell.alignment || {};
  st.h = a.horizontal; st.v = a.vertical; st.wrap = !!a.wrapText || a.horizontal === 'justify' || a.vertical === 'justify';
  st.indent = a.indent || 0;
  return st;
}

function fromSheetJS(buf) {
  const X = window.XLSX;
  let wb;
  try { wb = X.read(new Uint8Array(buf), { type: 'array', cellStyles: true, cellNF: true, cellDates: false }); }
  catch (e) { console.warn(e); fail('Datei konnte nicht gelesen werden'); }
  const out = [];
  wb.SheetNames.forEach((name, i) => {
    if (wb.Workbook?.Sheets?.[i]?.Hidden) return;
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return;
    const rg = X.utils.decode_range(ws['!ref']);
    const r1 = rg.s.r + 1, c1 = rg.s.c + 1, r2 = Math.min(rg.e.r + 1, 6000), c2 = Math.min(rg.e.c + 1, 250);
    const cells = new Map();
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const cell = ws[X.utils.encode_cell({ r: r - 1, c: c - 1 })];
      if (!cell) continue;
      let t = cell.w ?? (cell.v != null ? X.utils.format_cell(cell) : '');
      const num = cell.t === 'n' || cell.t === 'd';
      if (cell.t === 'n') t = fmtNum(cell.v, cell.z).t;
      if (cell.t === 'b') t = cell.v ? 'WAHR' : 'FALSCH';
      const s = cell.s || {};
      const fill = s.patternType && s.patternType !== 'none' && s.fgColor?.rgb ? '#' + String(s.fgColor.rgb).slice(-6) : null;
      if (t === '' && !fill) continue;
      // Schriftfarbe ist hier unbekannt: auf dunkler Füllung weiß schreiben
      const dark = fill && (() => { const n = parseInt(fill.slice(1), 16); return ((n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) < 110; })();
      cells.set(r + ':' + c, { t: String(t), num, st: { font: dark ? { color: '#ffffff' } : {}, fill } });
    }
    const colW = {}, colHidden = new Set(), rowH = {}, rowHidden = new Set();
    for (let c = c1; c <= c2; c++) {
      const col = ws['!cols']?.[c - 1];
      if (col?.hidden) colHidden.add(c);
      colW[c] = col?.wpx ?? (col?.wch != null ? Math.trunc(col.wch * 7 + 5) : col?.width != null ? Math.trunc(((256 * col.width + 18) / 256) * 7) : 64);
    }
    for (let r = r1; r <= r2; r++) {
      const row = ws['!rows']?.[r - 1];
      if (row?.hidden) rowHidden.add(r);
      rowH[r] = row?.hpx ?? (row?.hpt ? row.hpt * 4 / 3 : 20);
    }
    const merges = (ws['!merges'] || []).map(m => ({ r1: m.s.r + 1, c1: m.s.c + 1, r2: m.e.r + 1, c2: m.e.c + 1 }));
    if (!cells.size) return;
    out.push({ name, r1, c1, r2, c2, cells, merges, colW, colHidden, rowH, rowHidden, images: [], setup: { fit: false, scale: 100, grid: false } });
  });
  return out;
}

// CSV (Semikolon, Komma oder Tab; UTF-8 oder Windows-1252) – selbst gelesen, damit Umlaute und Dezimalkommas stimmen
function fromCsv(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
  text = text.replace(/^\uFEFF/, '');
  if (/^\s*</.test(text) || /\u0000/.test(text.slice(0, 2000))) fail('Dateiformat wird nicht unterstützt');
  const first = text.split(/\r?\n/, 1)[0];
  const cnt = ch => first.split(ch).length - 1;
  const sep = [';', '\t', ','].sort((a, b) => cnt(b) - cnt(a))[0];
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length && rows.length < 6000; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every(x => x.trim() === '')) rows.pop();
  if (!rows.length) return [];
  const nC = Math.min(250, Math.max(...rows.map(r => r.length)));
  const cells = new Map(), colW = {}, rowH = {}, maxLen = new Array(nC + 1).fill(0);
  rows.forEach((r, i) => {
    rowH[i + 1] = 20;
    r.slice(0, nC).forEach((v, j) => {
      if (v === '') return;
      maxLen[j + 1] = Math.max(maxLen[j + 1], v.length);
      cells.set(`${i + 1}:${j + 1}`, { t: v, num: /^[-+]?[\d.,]+\s*(€|%|EUR)?$/.test(v.trim()), st: { font: i === 0 ? { bold: true } : {} } });
    });
  });
  for (let c = 1; c <= nC; c++) colW[c] = Math.min(320, Math.max(48, maxLen[c] * 7 + 12));
  return [{ name: 'CSV', r1: 1, c1: 1, r2: rows.length, c2: nC, cells, merges: [], colW, colHidden: new Set(), rowH, rowHidden: new Set(), images: [], setup: { fit: false, scale: 100, grid: true } }];
}

// ---------- Tabelle als HTML setzen ----------
const H_ALIGN = { left: 'left', center: 'center', right: 'right', justify: 'justify', fill: 'left', centerContinuous: 'center', distributed: 'center' };
const V_ALIGN = { top: 'top', middle: 'middle', center: 'middle', bottom: 'bottom', justify: 'top', distributed: 'middle' };

function fontCss(f) {
  let s = '';
  if (f.name) s += `font-family:${familyCss(f.name).replace(/"/g, "'")};`;
  if (f.size) s += `font-size:${f.size}pt;`;
  if (f.bold) s += 'font-weight:700;';
  if (f.italic) s += 'font-style:italic;';
  const dec = [f.under ? 'underline' : '', f.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (dec) s += `text-decoration:${dec};${f.under === 'underline double' ? 'text-decoration-style:double;' : ''}`;
  if (f.color) s += `color:${f.color};`;
  if (f.vert === 'superscript') s += 'vertical-align:super;font-size:smaller;';
  if (f.vert === 'subscript') s += 'vertical-align:sub;font-size:smaller;';
  return s;
}

function cellHtml(cell) {
  return cell.html ?? escH(cell.t ?? '');
}

function renderSheet(m, container, { grid }) {
  const cols = [], rows = [];
  for (let c = m.c1; c <= m.c2; c++) if (!m.colHidden.has(c) && m.colW[c] > 0) cols.push(c);
  for (let r = m.r1; r <= m.r2; r++) if (!m.rowHidden.has(r)) rows.push(r);
  if (!cols.length || !rows.length) return null;
  const colSet = new Set(cols), rowSet = new Set(rows);
  const span = new Map(), covered = new Set();
  for (const g of m.merges) {
    const r1 = Math.max(g.r1, m.r1), c1 = Math.max(g.c1, m.c1), r2 = Math.min(g.r2, m.r2), c2 = Math.min(g.c2, m.c2);
    if (r1 > r2 || c1 > c2) continue;
    const vr = rows.filter(r => r >= r1 && r <= r2), vc = cols.filter(c => c >= c1 && c <= c2);
    if (!vr.length || !vc.length) continue;
    span.set(vr[0] + ':' + vc[0], { rs: vr.length, cs: vc.length, src: g.r1 + ':' + g.c1, w: vc.reduce((s, c) => s + m.colW[c], 0) });
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (!(r === vr[0] && c === vc[0])) covered.add(r + ':' + c);
  }
  const hasText = k => { const x = m.cells.get(k); return !!(x && x.t != null && x.t !== ''); };
  const free = (r, c) => colSet.has(c) && !covered.has(r + ':' + c) && !span.has(r + ':' + c) && !hasText(r + ':' + c);

  const defFont = `font-family:${familyCss('Calibri').replace(/"/g, "'")};font-size:11pt;`;
  const gridBg = grid ? 'background-image:linear-gradient(#d4d4d4,#d4d4d4),linear-gradient(#d4d4d4,#d4d4d4);background-size:1px 100%,100% 1px;background-position:right top,left bottom;background-repeat:no-repeat;' : '';
  const TW = cols.reduce((s, c) => s + m.colW[c], 0);
  let h = `<div class="xl-sheet" style="width:${TW}px"><table class="xl" style="width:${TW}px;${defFont}${grid ? 'border-top:1px solid #d4d4d4;border-left:1px solid #d4d4d4;' : ''}"><colgroup>${cols.map(c => `<col style="width:${m.colW[c]}px">`).join('')}</colgroup><tbody>`;
  for (const r of rows) {
    h += `<tr style="height:${m.rowH[r].toFixed(2)}px">`;
    for (const c of cols) {
      const k = r + ':' + c;
      if (covered.has(k)) continue;
      const sp = span.get(k);
      const cell = m.cells.get(sp ? sp.src : k) || null;
      const st = cell?.st || {};
      let tdS = gridBg;
      if (st.fill) tdS += `background-color:${st.fill};`;
      if (st.b) for (const [side, v] of Object.entries(st.b)) tdS += `border-${side}:${v};`;
      const font = st.font || {};
      const fcss = fontCss(font) + (cell?.red ? 'color:#ff0000;' : '');
      let ha = H_ALIGN[st.h] || (cell?.num ? 'right' : cell?.bool ? 'center' : 'left');
      const va = V_ALIGN[st.v] || 'bottom';
      tdS += `vertical-align:${va};`;
      const attrs = sp ? `${sp.rs > 1 ? ` rowspan="${sp.rs}"` : ''}${sp.cs > 1 ? ` colspan="${sp.cs}"` : ''}` : '';
      if (!cell || cell.t == null || cell.t === '') { h += `<td${attrs} style="${tdS}"></td>`; continue; }
      const ind = st.indent ? (ha === 'right' ? `padding-right:${st.indent * 9 + 2}px;` : `padding-left:${st.indent * 9 + 2}px;`) : '';
      const html = cellHtml(cell);
      if (st.wrap) {
        h += `<td${attrs} style="${tdS}${fcss}"><div class="w" style="text-align:${ha};${ind}">${html}</div></td>`;
        continue;
      }
      const cw = sp ? sp.w : m.colW[c];
      let L = 0, R = 0;
      if (!sp) {
        const eL = [], eR = [];
        if (ha === 'right' || ha === 'center') for (let cc = c - 1; cc >= m.c1; cc--) { if (m.colHidden.has(cc)) continue; if (!free(r, cc)) break; eL.push(m.colW[cc]); }
        if (ha === 'left' || ha === 'center' || ha === 'justify') for (let cc = c + 1; cc <= m.c2; cc++) { if (m.colHidden.has(cc)) continue; if (!free(r, cc)) break; eR.push(m.colW[cc]); }
        L = eL.reduce((s, x) => s + x, 0); R = eR.reduce((s, x) => s + x, 0);
        if (ha === 'center') { L = R = Math.min(L, R); }
      }
      h += `<td${attrs} style="${tdS}${fcss}"><div class="o" style="width:${cw + L + R}px;margin-left:${-L}px;text-align:${ha === 'justify' ? 'left' : ha};${ind}">${html}</div></td>`;
    }
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  container.insertAdjacentHTML('beforeend', h);
  const wrap = container.lastElementChild;
  const table = wrap.firstElementChild;
  return { wrap, table, cols, rows, TW };
}

function placeImages(m, sh) {
  if (!m.images.length) return;
  const base = sh.table.getBoundingClientRect();
  const trs = sh.table.rows;
  const rowTop = new Map();
  sh.rows.forEach((r, i) => rowTop.set(r, trs[i].getBoundingClientRect().top - base.top));
  const bottom = base.height;
  const colLeft = c => {
    let x = 0;
    if (c < m.c1) { for (let cc = c; cc < m.c1; cc++) x -= (m.colW[cc] ?? 64); return x; }
    for (let cc = m.c1; cc < c; cc++) if (!m.colHidden.has(cc)) x += m.colW[cc] ?? 64;
    return x;
  };
  const rowY = r => {
    if (rowTop.has(r)) return rowTop.get(r);
    if (r < m.r1) return -(m.r1 - r) * 20;
    for (let rr = r; rr <= m.r2; rr++) if (rowTop.has(rr)) return rowTop.get(rr);
    return bottom + (r - m.r2 - 1) * 20;
  };
  let maxB = 0;
  for (const im of m.images) {
    let x, y, w, h;
    if (im.from) { x = colLeft(im.from.c + 1) + im.from.cOff; y = rowY(im.from.r + 1) + im.from.rOff; }
    else if (im.pos) { x = im.pos.x; y = im.pos.y; }
    else continue;
    if (im.to) { w = colLeft(im.to.c + 1) + im.to.cOff - x; h = rowY(im.to.r + 1) + im.to.rOff - y; }
    else if (im.ext) { w = im.ext.w; h = im.ext.h; }
    if (!(w > 1 && h > 1)) continue;
    const img = document.createElement('img');
    img.src = im.src; img.alt = '';
    img.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    sh.wrap.appendChild(img);
    maxB = Math.max(maxB, y + h);
  }
  if (maxB > bottom) sh.wrap.style.minHeight = maxB + 'px';
}

export async function excelToPdf(book, { sheets = null, orient = 'auto', grid = false, onProgress, title } = {}) {
  await Promise.all([loadLib('html2canvas.min.js'), loadLib('xlsx.core.min.js')]);
  const host = makeHost('cv-excel');
  try {
    const list = book.sheets.filter((s, i) => !sheets || sheets.includes(i));
    if (!list.length) fail('Kein Tabellenblatt ausgewählt');
    const pages = [];
    list.forEach(m => { m._sh = renderSheet(m, host, { grid: grid || m.setup.grid }); });
    await ready(host);
    list.forEach(m => m._sh && placeImages(m, m._sh));
    await ready(host);

    for (const m of list) {
      const sh = m._sh;
      if (!sh) continue;
      delete m._sh;
      const base = sh.wrap.getBoundingClientRect();
      const TW = sh.TW, TH = sh.wrap.offsetHeight;
      const trs = sh.table.rows;
      const rr = sh.rows.map((r, i) => { const b = trs[i].getBoundingClientRect(); return { r, top: b.top - base.top, bot: b.bottom - base.top }; });
      const su = m.setup;
      const P = PAPER[su.paper] || PAPER[9];
      const mg = su.margins || {};
      const ml = (mg.left ?? 0.7) * 72, mr = (mg.right ?? 0.7) * 72, mt = (mg.top ?? 0.75) * 72, mb = (mg.bottom ?? 0.75) * 72;
      const lay = o => {
        const [pw, ph] = o === 'landscape' ? [P[1], P[0]] : [P[0], P[1]];
        const cw = pw - ml - mr, ch = ph - mt - mb;
        let s = su.fit ? 1 : (su.scale || 100) / 100;
        if (su.fit && su.fitH > 0) s = Math.min(s, ch * su.fitH / (TH * 0.75));
        s = Math.min(s, cw / (TW * 0.75));   // immer auf Seitenbreite einpassen
        return { o, pw, ph, cw, ch, s: Math.max(0.05, s) };
      };
      let L;
      if (orient === 'portrait' || orient === 'landscape') L = lay(orient);
      else if (su.orient === 'landscape') L = lay('landscape');
      else { const p = lay('portrait'), q = lay('landscape'); L = p.s < 0.75 && q.s > p.s * 1.1 ? q : p; }
      const k = 0.75 * L.s;
      const capPx = L.ch / k;
      const dx = ml + (su.hCenter ? Math.max(0, (L.cw - TW * k) / 2) : 0);
      // Wiederholungszeilen
      let head = null;
      if (su.titles) {
        const tr = rr.filter(x => x.r >= su.titles[0] && x.r <= su.titles[1]);
        if (tr.length) { head = { y: tr[0].top, h: tr[tr.length - 1].bot - tr[0].top, last: tr[tr.length - 1].r }; if (head.h > capPx * 0.5) head = null; }
      }
      let i = 0, n = 0;
      while (i < rr.length) {
        const rep = head && n > 0 && rr[i].r > head.last;
        const cap = capPx - (rep ? head.h : 0);
        const y0 = n === 0 ? 0 : rr[i].top;
        let j = i;
        while (j < rr.length && rr[j].bot - y0 <= cap + 0.5) j++;
        if (j === i) j = i + 1;
        const y1 = j >= rr.length ? Math.max(rr[rr.length - 1].bot, Math.min(TH, y0 + cap)) : rr[j - 1].bot;
        const parts = [];
        let dy = mt;
        if (rep) { parts.push({ el: sh.wrap, x: 0, y: head.y, w: TW, h: head.h, dx, dy, k, key: `t${m.name}` }); dy += head.h * k; }
        parts.push({ el: sh.wrap, x: 0, y: y0, w: TW, h: Math.min(y1 - y0, cap), dx, dy, k });
        pages.push({ w: L.pw, h: L.ph, parts });
        i = j; n++;
      }
    }
    if (!pages.length) fail('Keine druckbaren Inhalte gefunden');
    return await assemble(pages, onProgress, title);
  } finally { host.remove(); }
}
