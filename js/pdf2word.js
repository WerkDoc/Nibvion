// ================= PDF → Word (.docx) =================
// Lokal im Browser: pdf.js liefert Text (Position, Größe, Schrift) und Bilder,
// daraus werden Absätze, Einzüge, Ausrichtung und Tabulatoren rekonstruiert und
// mit JSZip als bearbeitbare .docx geschrieben. Seiten ohne Text (Scans) werden als Bild übernommen.
import { pdfjsLib } from './pdfcore.js';
import { loadLib, ConvertError } from './convert.js';

const tick = () => new Promise(r => setTimeout(r, 0));
const xesc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tw = pt => Math.round(pt * 20);          // Punkt → Twips
const emu = pt => Math.round(pt * 12700);      // Punkt → EMU
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Symbol-/Wingdings-Zeichen (Private Use Area) → normale Zeichen
const PUA = { 0xF0B7: '•', 0xF0A7: '▪', 0xF0A8: '□', 0xF076: '❖', 0xF0D8: '➢', 0xF0FC: '✓', 0xF0E0: '→', 0xF06C: '●', 0xF06E: '■', 0xF02D: '–' };
const cleanText = s => s.replace(/[-]/g, ch => PUA[ch.charCodeAt(0)] || '•').replace(/­/g, '');

const BULLET = /^\s*([•●▪◦‣■□➢✓\-–·*]|\d{1,2}[.)]|[a-z][.)])\s/;
const NUMERIC = /^[-+]?\s?[\d.,]+\s?(€|EUR|%|Stk\.?)?$/;

function familyOf(name, serif, mono) {
  const n = name || '';
  const known = [
    [/times/i, 'Times New Roman'], [/arial/i, 'Arial'], [/helvetica/i, 'Arial'], [/courier/i, 'Courier New'],
    [/calibri/i, 'Calibri'], [/cambria/i, 'Cambria'], [/georgia/i, 'Georgia'], [/verdana/i, 'Verdana'],
    [/tahoma/i, 'Tahoma'], [/segoe/i, 'Segoe UI'], [/aptos/i, 'Aptos'], [/garamond/i, 'Garamond'],
    [/trebuchet/i, 'Trebuchet MS'], [/liberation ?sans|dejavu ?sans/i, 'Arial'], [/liberation ?serif/i, 'Times New Roman'],
    [/carlito/i, 'Calibri'], [/caladea/i, 'Cambria'],
  ];
  for (const [re, f] of known) if (re.test(n)) return f;
  let base = n.split(/[-,]/)[0].replace(/(MT|PS|Std|Pro|LT)$/,'').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  if (!base || /^(sans-serif|serif|monospace|g_d\d)/i.test(base)) base = '';
  return base || (mono ? 'Courier New' : serif ? 'Times New Roman' : 'Calibri');
}

// ---------- Seite lesen ----------
async function readPage(pdf, no) {
  const page = await pdf.getPage(no);
  const vp = page.getViewport({ scale: 1 });
  const { Util, OPS } = pdfjsLib;
  const ops = await page.getOperatorList();   // lädt auch die Schriften
  const tc = await page.getTextContent();
  const fonts = new Map();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !/\S/.test(it.str)) { if (it.str && items.length) items[items.length - 1].sp = true; continue; }
    const m = Util.transform(vp.transform, it.transform);
    if (Math.abs(m[1]) > Math.abs(m[0]) * 0.5 && Math.abs(m[1]) > 0.5) continue; // gedrehter Text
    const size = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]);
    if (size < 2) continue;
    let f = fonts.get(it.fontName);
    if (!f) {
      let o = null;
      try { if (page.commonObjs.has(it.fontName)) o = page.commonObjs.get(it.fontName); } catch {}
      const nm = String(o?.name || '').replace(/^[A-Z]{6}\+/, '');
      const st = tc.styles[it.fontName] || {};
      f = {
        family: familyOf(nm || st.fontFamily, o?.isSerifFont || /serif/i.test(st.fontFamily || '') && !/sans/i.test(st.fontFamily || ''), o?.isMonospace || /mono/i.test(st.fontFamily || '')),
        bold: !!(o?.bold || o?.black) || /bold|black|heavy|semibold|demi/i.test(nm),
        italic: !!o?.italic || /italic|oblique/i.test(nm),
      };
      fonts.set(it.fontName, f);
    }
    items.push({ s: cleanText(it.str), x: m[4], y: m[5], w: Math.abs(it.width) * (vp.scale || 1), size, f });
  }

  // Bilder: Transformationsmatrix mitverfolgen
  const imgs = [];
  let ctm = vp.transform.slice();
  const stack = [];
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k], a = ops.argsArray[k];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); if (a && a[0]) ctm = Util.transform(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
      if (w < 14 || h < 14) continue;
      let obj = null;
      try {
        if (fn === OPS.paintInlineImageXObject) obj = a[0];
        else { const id = a[0]; const store = String(id).startsWith('g_') ? page.commonObjs : page.objs; if (store.has(id)) obj = store.get(id); }
      } catch {}
      if (obj) imgs.push({ obj, x, y, w, h, flipY: ctm[3] > 0, flipX: ctm[0] < 0 });
    }
  }

  // Seite ohne Text (Scan/Grafik): ganze Seite als Bild
  let full = null;
  if (!items.length) {
    const s = Math.min(2, 1600 / Math.max(vp.width, vp.height) * 1.0 + 0.6);
    const v2 = page.getViewport({ scale: s });
    const c = document.createElement('canvas');
    c.width = Math.ceil(v2.width); c.height = Math.ceil(v2.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: v2 }).promise;
    full = { bytes: await canvasBytes(c, 'image/jpeg'), ext: 'jpeg', w: vp.width, h: vp.height };
    c.width = c.height = 0;
  }
  const images = [];
  if (!full) for (const im of imgs.slice(0, 60)) {
    const b = await imageBytes(im);
    if (b) images.push({ ...b, x: im.x, y: im.y, w: im.w, h: im.h });
  }
  page.cleanup();
  return { W: vp.width, H: vp.height, items, images, full };
}

function canvasBytes(c, type) {
  return new Promise((res, rej) => c.toBlob(b => b ? b.arrayBuffer().then(a => res(new Uint8Array(a)), rej) : rej(new Error('Bild')), type, 0.86));
}

async function imageBytes(im) {
  const o = im.obj;
  const W = o.width, H = o.height;
  if (!W || !H) return null;
  const src = document.createElement('canvas');
  src.width = W; src.height = H;
  const sctx = src.getContext('2d');
  let alpha = false;
  if (o.bitmap) sctx.drawImage(o.bitmap, 0, 0);
  else if (o.data) {
    const id = sctx.createImageData(W, H), d = id.data, s = o.data;
    const kind = o.kind;
    if (kind === 3 || s.length === W * H * 4) { d.set(s.subarray ? s.subarray(0, d.length) : s); alpha = true; }
    else if (kind === 2 || s.length === W * H * 3) { for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { d[i] = s[j]; d[i + 1] = s[j + 1]; d[i + 2] = s[j + 2]; d[i + 3] = 255; } }
    else if (kind === 1) {
      const rb = (W + 7) >> 3;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = (s[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0; const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    } else return null;
    sctx.putImageData(id, 0, 0);
  } else return null;
  // verkleinern, spiegeln, auf Weiß setzen (JPEG) bzw. PNG mit Transparenz
  const sc = Math.min(1, 1800 / Math.max(W, H));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W * sc)); c.height = Math.max(1, Math.round(H * sc));
  const ctx = c.getContext('2d');
  const png = alpha || c.width * c.height < 160000;
  if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.save();
  ctx.translate(im.flipX ? c.width : 0, im.flipY ? c.height : 0);
  ctx.scale(im.flipX ? -1 : 1, im.flipY ? -1 : 1);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  ctx.restore();
  const bytes = await canvasBytes(c, png ? 'image/png' : 'image/jpeg');
  src.width = src.height = c.width = c.height = 0;
  return { bytes, ext: png ? 'png' : 'jpeg' };
}

// ---------- Zeilen & Absätze ----------
function buildLines(items) {
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    let L = null;
    for (let j = lines.length - 1; j >= Math.max(0, lines.length - 5); j--) {
      const l = lines[j];
      if (Math.abs(l.y - it.y) <= Math.min(l.size, it.size) * 0.4) { L = l; break; }
    }
    if (!L) { L = { y: it.y, size: it.size, items: [] }; lines.push(L); }
    L.items.push(it);
    if (it.size > L.size) { L.size = it.size; L.y = it.y; }
  }
  lines.sort((a, b) => a.y - b.y);
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    // Segmente (große Lücken → Tabulator)
    const segs = [];
    let seg = null, prev = null;
    for (const it of l.items) {
      const gap = prev ? it.x - (prev.x + prev.w) : 0;
      if (!seg || gap > Math.max(it.size * 1.8, 16)) { seg = { x: it.x, end: it.x + it.w, runs: [] }; segs.push(seg); prev = null; }
      let t = it.s;
      if (prev && !/\s$/.test(prev.s) && !/^\s/.test(t) && (gap > it.size * 0.16 || prev.sp)) t = ' ' + t;
      const key = `${it.f.family}|${it.f.bold}|${it.f.italic}|${Math.round(it.size * 2)}`;
      const last = seg.runs[seg.runs.length - 1];
      if (last && last.key === key) last.t += t;
      else seg.runs.push({ key, t, f: it.f, size: it.size });
      seg.end = Math.max(seg.end, it.x + it.w);
      prev = it;
    }
    for (const s of segs) { s.runs.forEach(r => { r.t = r.t.replace(/ {2,}/g, ' '); }); s.text = s.runs.map(r => r.t).join(''); }
    l.segs = segs;
    l.x = segs[0].x; l.right = segs[segs.length - 1].end;
    l.text = segs.map(s => s.text).join(' ');
    // dominante Größe
    const cnt = new Map();
    for (const it of l.items) cnt.set(it.size, (cnt.get(it.size) || 0) + it.s.length);
    l.dsize = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return lines;
}

function buildParas(lines, mL, cR) {
  const paras = [];
  let P = null;
  for (const l of lines) {
    const prev = P && P.lines[P.lines.length - 1];
    let brk = !P;
    if (!brk) {
      const tab = l.segs.length > 1 || prev.segs.length > 1;
      const d = l.y - prev.y;
      const exp = P.lines.length > 1 ? P.lead : prev.dsize * 1.45;
      const ref = P.lines.length > 1 ? P.lines[1].x : null;
      brk = tab
        || d > exp * 1.3 + 0.5 || d < prev.dsize * 0.6
        || Math.abs(l.dsize - prev.dsize) > 0.9
        || BULLET.test(l.text)
        || (ref != null ? Math.abs(l.x - ref) > l.dsize * 0.8 : ((l.x > prev.x + l.dsize * 2.2 && !BULLET.test(prev.text)) || l.x < prev.x - l.dsize * 6))
        || prev.right < cR - Math.max(70, (cR - mL) * 0.22)
        || (prev.segs[0].runs[0].f.bold !== l.segs[0].runs[0].f.bold && P.lines.length === 1 && prev.text.length < 90);
    }
    if (brk) { P = { lines: [l], lead: 0 }; paras.push(P); }
    else {
      // Silbentrennung am Zeilenende zusammenziehen
      const lastSeg = prev.segs[prev.segs.length - 1], lastRun = lastSeg.runs[lastSeg.runs.length - 1];
      if (/[a-zäöüß]-$/.test(lastRun.t) && /^[a-zäöüß]/.test(l.text)) { lastRun.t = lastRun.t.slice(0, -1); l.joinNoSpace = true; }
      P.lines.push(l);
      P.lead = (P.lines[P.lines.length - 1].y - P.lines[0].y) / (P.lines.length - 1);
    }
  }
  return paras;
}

// ---------- Kopf-/Fußzeilen erkennen (wiederholen sich auf den meisten Seiten) ----------
function detectHF(pages, mL, cR) {
  const n = pages.length;
  if (n < 2) return null;
  const need = Math.max(2, Math.ceil(n * 0.5));
  const res = {};
  for (const zone of ['header', 'footer']) {
    // Nur Zeilenblöcke direkt am Seitenrand, die durch eine Lücke vom Fließtext getrennt sind
    const blocks = pages.map(p => {
      const ls = zone === 'header' ? p.lines : [...p.lines].reverse();
      const inZ = l => zone === 'header' ? l.y < p.H * 0.15 : l.y > p.H * 0.85;
      const out = [];
      for (let i = 0; i < ls.length; i++) {
        const l = ls[i];
        if (!inZ(l)) return [];
        out.push(l);
        const nx = ls[i + 1];
        if (!nx) break;
        if (Math.abs(nx.y - l.y) > Math.max(l.dsize, nx.dsize) * 1.55) return out;
      }
      return out;
    });
    const inBlock = (p, l) => blocks[pages.indexOf(p)].includes(l);
    const inZone = inBlock;
    const key = l => l.text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    const cnt = new Map();
    pages.forEach((p, pi) => {
      const seen = new Set();
      for (const l of p.lines) if (inZone(p, l)) { const k = key(l) + '@' + Math.round(l.y / 8); if (!seen.has(k)) { seen.add(k); cnt.set(k, (cnt.get(k) || 0) + 1); } }
    });
    const keys = new Set([...cnt.entries()].filter(([k, c]) => c >= need).map(([k]) => k));
    if (!keys.size) continue;
    let sample = null, samplePage = 0;
    const byKey = new Map();   // Schlüssel → [{page, nums}]
    pages.forEach((p, pi) => {
      const hit = p.lines.filter(l => inZone(p, l) && keys.has(key(l) + '@' + Math.round(l.y / 8)));
      hit.forEach(l => { const k = key(l); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push({ page: pi + 1, nums: (l.text.match(/\d+/g) || []).map(Number) }); });
      if (hit.length && !sample) { sample = hit; samplePage = pi + 1; }
      p.lines = p.lines.filter(l => !hit.includes(l));
    });
    // Seitenzahl: die Zahl, die auf jeder Seite der Seitennummer entspricht
    for (const l of sample) {
      const occ = byKey.get(key(l)) || [];
      if (occ.length < 2) continue;
      const n = occ[0].nums.length;
      for (let i = 0; i < n; i++) if (occ.every(o => o.nums[i] === o.page)) { l.pageNumIdx = i; break; }
    }
    const paras = sample.map(l => ({ lines: [l], lead: 0 }));   // in Kopf-/Fußzeilen jede Zeile als eigener Absatz
    res[zone] = { paras, page: samplePage, top: sample[0].y - sample[0].dsize, bottom: sample[sample.length - 1].y + sample[sample.length - 1].dsize * 0.3 };
  }
  return res.header || res.footer ? res : null;
}

// ---------- DOCX schreiben ----------
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function runXml(r, body, t) {
  const f = r.f;
  let p = `<w:rFonts w:ascii="${xesc(f.family)}" w:hAnsi="${xesc(f.family)}" w:cs="${xesc(f.family)}"/>`;
  if (f.bold) p += '<w:b/><w:bCs/>';
  if (f.italic) p += '<w:i/><w:iCs/>';
  const sz = Math.max(2, Math.round(r.size * 2));
  if (sz !== body) p += `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`;
  return `<w:r><w:rPr>${p}</w:rPr><w:t xml:space="preserve">${xesc(t)}</w:t></w:r>`;
}

function graphic(rid, id, cx, cy) {
  return `<wp:docPr id="${id}" name="Bild ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Bild ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
}
const inlineImg = (rid, id, cx, cy) => `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${graphic(rid, id, cx, cy)}</wp:inline></w:drawing></w:r>`;
const anchorImg = (rid, id, x, y, cx, cy) => `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>${graphic(rid, id, cx, cy)}</wp:anchor></w:drawing></w:r>`;

function percentile(arr, p) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; }

async function buildDocx(pages, title, hf) {
  // Seitenränder und Grundschrift aus dem ganzen Dokument
  const allLines = pages.flatMap(p => p.lines || []);
  const W = pages[0].W, H = pages[0].H;
  const mL = clamp(percentile(allLines.map(l => l.x), 0.08) || 56, 18, W / 3);
  const mR = clamp(W - (percentile(allLines.map(l => l.right), 0.99) || W - 56) - 6, 18, W / 3);
  const mT = clamp(Math.min(...pages.filter(p => p.lines?.length).map(p => p.lines[0].y - p.lines[0].dsize), 1e9) - 2, 18, 110);
  const mB = clamp(H - Math.max(...pages.filter(p => p.lines?.length).map(p => p.lines[p.lines.length - 1].y + 4), 0) - 4, 18, 72);
  const cW = W - mL - mR, cR = W - mR;
  const sizeCnt = new Map();
  for (const l of allLines) for (const it of l.items) sizeCnt.set(Math.round(it.size * 2), (sizeCnt.get(Math.round(it.size * 2)) || 0) + it.s.length);
  const body = [...sizeCnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 22;

  const media = [];
  let imgId = 0;
  const addMedia = (bytes, ext) => { const n = media.length + 1; media.push({ name: `image${n}.${ext}`, bytes, rid: `rIdImg${n}` }); return media[media.length - 1].rid; };

  let xml = '';
  let lastBottom = 0;
  pages.forEach((pg, pi) => {
    const els = [];
    let backs = '';
    if (pg.full) {
      const s = Math.min(cW / pg.full.w, (H - mT - mB - 4) / pg.full.h, 1);
      els.push({ top: mT, bottom: mT + pg.full.h * s, xml: (pre) => `<w:p><w:pPr>${pre}<w:jc w:val="center"/></w:pPr>${inlineImg(addMedia(pg.full.bytes, pg.full.ext), ++imgId, emu(pg.full.w * s), emu(pg.full.h * s))}</w:p>` });
    }
    for (const im of pg.images) {
      // Seitenfüllendes Bild mit Text darüber = Scan mit Texterkennung o. Ä. → nur den Text übernehmen
      if (im.w * im.h > pg.W * pg.H * 0.8 && pg.lines.length) continue;
      if (im.w * im.h > pg.W * pg.H * 0.45 && pg.lines.length) {
        backs += anchorImg(addMedia(im.bytes, im.ext), ++imgId, emu(im.x), emu(im.y), emu(im.w), emu(im.h));
        continue;
      }
      const s = Math.min(1, cW / im.w);
      const ind = clamp(im.x - mL, 0, cW - im.w * s);
      els.push({ top: im.y, bottom: im.y + im.h * s, xml: (pre) => `<w:p><w:pPr>${pre}<w:ind w:left="${tw(ind)}"/></w:pPr>${inlineImg(addMedia(im.bytes, im.ext), ++imgId, emu(im.w * s), emu(im.h * s))}</w:p>` });
    }
    for (const P of pg.paras) {
      const f = P.lines[0], last = P.lines[P.lines.length - 1];
      els.push({ top: f.y - f.dsize * 0.92, bottom: last.y + last.dsize * 0.25, xml: (pre) => paraXml(P, pre) });
    }
    els.sort((a, b) => a.top - b.top);
    let prevBottom = mT;
    const hardBreak = pi > 0 && lastBottom < (H - mB) * 0.8;
    els.forEach((el, i) => {
      const gap = el.top - prevBottom;
      let before = clamp(gap, 0, i === els.length - 1 ? 24 : 48);
      if (i === 0) before = pi === 0 || hardBreak ? clamp(gap, 0, H * 0.6) : clamp(el.top - mT, 0, 14);
      let pre = '';
      if (i === 0 && hardBreak) pre += '<w:pageBreakBefore/>';
      pre += `<w:spacing w:before="${tw(before)}" w:after="0"/>`;
      let x = el.xml(pre);
      if (i === 0 && backs) { x = x.replace('</w:pPr>', '</w:pPr>' + backs); backs = ''; }
      xml += x;
      prevBottom = Math.max(prevBottom, el.bottom);
    });
    if (backs || !els.length) xml += `<w:p><w:pPr>${pi > 0 ? '<w:pageBreakBefore/>' : ''}</w:pPr>${backs}</w:p>`;
    lastBottom = els.length ? Math.max(...els.map(e => e.bottom)) : 0;
  });

  function paraXml(P, pre, hfMode) {
    const L = P.lines, f = L[0];
    const lefts = L.map(l => l.x), rights = L.map(l => l.right);
    // Ausrichtung
    let jc = '';
    const centered = L.every(l => Math.abs((l.x - mL) - (cR - l.right)) < Math.max(10, f.dsize)) && f.x - mL > 24;
    if (f.segs.length === 1 && centered) jc = 'center';
    else if (f.segs.length === 1 && rights.every(r => Math.abs(r - cR) < 8) && Math.min(...lefts) > mL + 40) jc = 'right';
    else if (L.length > 2 && L.slice(0, -1).every(l => Math.abs(l.right - cR) < 6)) jc = 'both';
    // Einzug
    let ind = '';
    if (jc !== 'center' && jc !== 'right') {
      if (L.length > 1) {
        const left = clamp(L[1].x - mL, -mL, cW), first = f.x - L[1].x;
        ind = `<w:ind w:left="${tw(Math.max(0, left))}"${first > 1 ? ` w:firstLine="${tw(first)}"` : first < -1 ? ` w:hanging="${tw(-first)}"` : ''}/>`;
      } else if (f.x - mL > 1) ind = `<w:ind w:left="${tw(f.x - mL)}"/>`;
    }
    // Zeilenabstand
    let spacing = pre;
    if (L.length > 1) {
      const lineV = clamp(Math.round(240 * P.lead / (f.dsize * 1.17)), 200, 720);
      spacing = pre.replace('w:after="0"', `w:after="0" w:line="${lineV}" w:lineRule="auto"`);
    }
    // Tabulatoren für Spalten
    let tabs = '';
    if (f.segs.length > 1) {
      tabs = '<w:tabs>' + f.segs.slice(1).map(s => NUMERIC.test(s.text.trim())
        ? `<w:tab w:val="right" w:pos="${tw(clamp(s.end - mL, 0, cW + 60))}"/>`
        : `<w:tab w:val="left" w:pos="${tw(clamp(s.x - mL, 0, cW + 60))}"/>`).join('') + '</w:tabs>';
    }
    // Überschrift?
    let style = '';
    const sz = Math.round(f.dsize * 2), bold = f.segs[0].runs.every(r => r.f.bold);
    if (L.length <= 3 && f.segs.length === 1 && f.text.length < 140) {
      if (sz >= body * 1.45) style = '<w:pStyle w:val="Heading1"/>';
      else if (sz >= body * 1.15 && bold) style = '<w:pStyle w:val="Heading2"/>';
    }
    let runs = '';
    const field = (r, n) => ['<w:fldChar w:fldCharType="begin"/>', '<w:instrText xml:space="preserve"> PAGE </w:instrText>', '<w:fldChar w:fldCharType="separate"/>']
      .map(x => runXml(r, body, '').replace(/<w:t[^>]*><\/w:t>/, x)).join('') + runXml(r, body, String(n)) + runXml(r, body, '').replace(/<w:t[^>]*><\/w:t>/, '<w:fldChar w:fldCharType="end"/>');
    L.forEach((l, li) => {
      let numNo = 0;
      if (li > 0 && !l.joinNoSpace) runs += runXml(l.segs[0].runs[0], body, ' ');
      l.segs.forEach((s, si) => {
        if (si > 0) runs += '<w:r><w:tab/></w:r>';
        s.runs.forEach((r, ri) => {
          const t = li > 0 && si === 0 && ri === 0 ? r.t.replace(/^\s+/, '') : r.t;
          if (!t) return;
          if (!hfMode || l.pageNumIdx == null) { runs += runXml(r, body, t); return; }
          // n-te Zahl der Zeile durch Seitenzahl-Feld ersetzen
          let pos = 0;
          for (const m of t.matchAll(/\d+/g)) {
            if (numNo++ !== l.pageNumIdx) continue;
            if (m.index > pos) runs += runXml(r, body, t.slice(pos, m.index));
            runs += field(r, m[0]);
            pos = m.index + m[0].length;
          }
          if (pos < t.length) runs += runXml(r, body, t.slice(pos));
        });
      });
    });
    // Reihenfolge laut Word-Schema: pStyle, pageBreakBefore, tabs, spacing, ind, jc
    const pb = spacing.includes('<w:pageBreakBefore/>') ? '<w:pageBreakBefore/>' : '';
    spacing = spacing.replace('<w:pageBreakBefore/>', '');
    return `<w:p><w:pPr>${style}${pb}${tabs}${spacing}${ind}${jc ? `<w:jc w:val="${jc}"/>` : ''}</w:pPr>${runs}</w:p>`;
  }

  const land = W > H;
  const hfXml = (kind, part) => {
    if (!part) return null;
    const inner = part.paras.map(P => paraXml(P, '<w:spacing w:before="0" w:after="0"/>', true)).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${kind} ${NS}>${inner}</w:${kind}>`;
  };
  const headerXml = hfXml('hdr', hf?.header), footerXml = hfXml('ftr', hf?.footer);
  const hDist = hf?.header ? clamp(hf.header.top, 12, mT) : 36;
  const fDist = hf?.footer ? clamp(H - hf.footer.bottom, 12, 72) : 36;
  const mBottom = hf?.footer ? Math.max(mB, H - hf.footer.top + 6) : mB;
  const sect = `<w:sectPr>${headerXml ? '<w:headerReference w:type="default" r:id="rIdHdr"/>' : ''}${footerXml ? '<w:footerReference w:type="default" r:id="rIdFtr"/>' : ''}<w:pgSz w:w="${tw(W)}" w:h="${tw(H)}"${land ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${tw(mT)}" w:right="${tw(mR)}" w:bottom="${tw(mBottom)}" w:left="${tw(mL)}" w:header="${tw(hDist)}" w:footer="${tw(fDist)}" w:gutter="0"/></w:sectPr>`;
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${xml}${sect}</w:body></w:document>`;
  const bodyFont = 'Calibri';
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${bodyFont}" w:hAnsi="${bodyFont}" w:eastAsia="${bodyFont}" w:cs="${bodyFont}"/><w:sz w:val="${body}"/><w:szCs w:val="${body}"/><w:lang w:val="de-DE" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Standard"/><w:next w:val="Standard"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Standard"/><w:next w:val="Standard"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr></w:style>
</w:styles>`;
  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="708"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xesc(title || '')}</dc:title><dc:creator>Nibvion</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${headerXml ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}${footerXml ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${headerXml ? '<Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ''}${footerXml ? '<Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ''}${media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`;

  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', ct);
  zip.file('_rels/.rels', rels);
  zip.file('docProps/core.xml', coreXml);
  zip.file('word/document.xml', docXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/settings.xml', settingsXml);
  zip.file('word/_rels/document.xml.rels', docRels);
  if (headerXml) zip.file('word/header1.xml', headerXml);
  if (footerXml) zip.file('word/footer1.xml', footerXml);
  for (const m of media) zip.file('word/media/' + m.name, m.bytes);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ---------- Öffentliche Funktion ----------
export async function pdfToWord(bytes, { onProgress, title } = {}) {
  await loadLib('jszip.min.js');
  let pdf;
  try { pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false, useSystemFonts: true }).promise; }
  catch (e) { console.warn(e); throw new ConvertError('PDF konnte nicht gelesen werden'); }
  try {
    const pages = [];
    let text = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress && onProgress(i, pdf.numPages);
      await tick();
      const pg = await readPage(pdf, i);
      pg.lines = pg.items.length ? buildLines(pg.items) : [];
      text += pg.items.length;
      pages.push(pg);
    }
    // Absätze erst nach den Rändern (dokumentweit)
    const allLines = pages.flatMap(p => p.lines);
    const W = pages[0].W;
    const mL = clamp(percentile(allLines.map(l => l.x), 0.08) || 56, 18, W / 3);
    const cR = W - clamp(W - (percentile(allLines.map(l => l.right), 0.99) || W - 56) - 6, 18, W / 3);
    const hf = detectHF(pages, mL, cR);
    for (const p of pages) p.paras = buildParas(p.lines, mL, cR);
    const out = await buildDocx(pages, title, hf);
    return { bytes: out, scanned: text === 0 };
  } finally { try { pdf.loadingTask.destroy(); } catch {} }
}
