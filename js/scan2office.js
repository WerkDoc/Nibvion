// ================= Scan → Word / Excel =================
// Aus Texterkennung (Wörter mit Position) und dem Bild selbst wird das Layout rekonstruiert:
// Tabellen über die gezeichneten Linien (inkl. verbundener Zellen), Absätze, Überschriften,
// Fettschrift, Ausrichtung und Spalten (z. B. Seitenleiste eines Briefs).
// Alles lokal: .docx mit JSZip, .xlsx mit ExcelJS.
import { loadLib } from './convert.js';

const xesc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const SIDES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];

// ======================= Analyse =======================

function inkMask(canvas) {
  const W = canvas.width, H = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const N = W * H, g = new Uint8Array(N), hist = new Array(256).fill(0);
  for (let i = 0; i < N; i++) { const v = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; g[i] = v; hist[v]++; }
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = N - wB; if (!wF) break;
    sB += t * hist[t]; const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  thr = Math.min(thr, 170);
  const ink = new Uint8Array(N);
  for (let i = 0; i < N; i++) ink[i] = g[i] < thr ? 1 : 0;
  return { ink, W, H };
}

// Lange waagerechte / senkrechte Linien finden
function findLines({ ink, W, H }) {
  const hs = [], vs = [];
  const minH = Math.max(80, W * 0.06), minV = Math.max(60, H * 0.018);
  for (let y = 1; y < H - 1; y++) {
    let start = -1, gap = 0;
    for (let x = 0; x <= W; x++) {
      const on = x < W && (ink[y * W + x] || ink[(y - 1) * W + x] || ink[(y + 1) * W + x]);
      if (on) { if (start < 0) start = x; gap = 0; }
      else if (start >= 0) {
        if (++gap > 3 || x === W) { const end = x - gap; if (end - start >= minH) hs.push({ y, x0: start, x1: end }); start = -1; gap = 0; }
      }
    }
  }
  for (let x = 1; x < W - 1; x++) {
    let start = -1, gap = 0;
    for (let y = 0; y <= H; y++) {
      const on = y < H && (ink[y * W + x] || ink[y * W + x - 1] || ink[y * W + x + 1]);
      if (on) { if (start < 0) start = y; gap = 0; }
      else if (start >= 0) {
        if (++gap > 3 || y === H) { const end = y - gap; if (end - start >= minV) vs.push({ x, y0: start, y1: end }); start = -1; gap = 0; }
      }
    }
  }
  const merge = (arr, pos, a0, a1) => {
    arr.sort((p, q) => p[pos] - q[pos] || p[a0] - q[a0]);
    const out = [];
    for (const s of arr) {
      const m = out.find(o => Math.abs(o[pos] - s[pos]) <= 6 && s[a0] <= o[a1] + 8 && s[a1] >= o[a0] - 8);
      if (m) { m[pos] = (m[pos] * m.n + s[pos]) / (m.n + 1); m.n++; m[a0] = Math.min(m[a0], s[a0]); m[a1] = Math.max(m[a1], s[a1]); }
      else out.push({ ...s, n: 1 });
    }
    return out;
  };
  return { hs: merge(hs, 'y', 'x0', 'x1'), vs: merge(vs, 'x', 'y0', 'y1') };
}

function cluster(vals, tol) {
  const s = [...vals].sort((a, b) => a - b), out = [];
  for (const v of s) { const l = out[out.length - 1]; if (l && v - l.v <= tol) { l.v = (l.v * l.n + v) / (l.n + 1); l.n++; } else out.push({ v, n: 1 }); }
  return out.map(o => o.v);
}

// Tabellen = zusammenhängende Gitter aus waagerechten und senkrechten Linien
function findTables({ hs, vs }, W) {
  const T = 10;
  const n = hs.length + vs.length, parent = [...Array(n).keys()];
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  hs.forEach((h, i) => vs.forEach((v, j) => {
    if (v.x >= h.x0 - T && v.x <= h.x1 + T && h.y >= v.y0 - T && h.y <= v.y1 + T) parent[find(i)] = find(hs.length + j);
  }));
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, { h: [], v: [] }); i < hs.length ? groups.get(r).h.push(hs[i]) : groups.get(r).v.push(vs[i - hs.length]); }
  const tables = [];
  for (const g of groups.values()) {
    if (g.h.length < 2 || g.v.length < 2) continue;
    const x0 = Math.min(...g.h.map(h => h.x0), ...g.v.map(v => v.x)), x1 = Math.max(...g.h.map(h => h.x1), ...g.v.map(v => v.x));
    const y0 = Math.min(...g.v.map(v => v.y0), ...g.h.map(h => h.y)), y1 = Math.max(...g.v.map(v => v.y1), ...g.h.map(h => h.y));
    if (x1 - x0 < W * 0.15 || y1 - y0 < 30) continue;
    const ys = cluster(g.h.filter(h => h.x1 - h.x0 > (x1 - x0) * 0.25).map(h => h.y), 10);
    const xs = cluster(g.v.filter(v => v.y1 - v.y0 > 20).map(v => v.x), 10);
    if (!ys.length || !xs.length) continue;
    if (ys[0] - y0 > 12) ys.unshift(y0);
    if (y1 - ys[ys.length - 1] > 12) ys.push(y1);
    if (xs[0] - x0 > 12) xs.unshift(x0);
    if (x1 - xs[xs.length - 1] > 12) xs.push(x1);
    if (ys.length < 2 || xs.length < 2) continue;
    // Verbundene Zellen: fehlt die senkrechte Linie in einer Zeile → zusammenfassen
    const rows = [];
    for (let r = 0; r < ys.length - 1; r++) {
      const a = ys[r], b = ys[r + 1], hgt = b - a;
      if (hgt < 8) continue;
      const cells = [];
      let start = 0;
      for (let c = 1; c <= xs.length - 1; c++) {
        const edge = c === xs.length - 1;
        const has = edge || g.v.some(v => Math.abs(v.x - xs[c]) < 10 && v.y0 <= a + hgt * 0.35 && v.y1 >= b - hgt * 0.35);
        if (has) { cells.push({ c0: start, c1: c, x0: xs[start], x1: xs[c], y0: a, y1: b, words: [] }); start = c; }
      }
      rows.push({ y0: a, y1: b, cells });
    }
    if (!rows.length) continue;
    tables.push({ type: 'table', x0, x1, y0, y1, xs, rows });
  }
  return tables;
}

/** Vor der Texterkennung: Linien finden und aus einer Kopie entfernen (Tabellenlinien stören die Erkennung) */
export function prepare(canvas) {
  const mask = inkMask(canvas);
  const lines = findLines(mask);
  const oc = document.createElement('canvas'); oc.width = canvas.width; oc.height = canvas.height;
  const g = oc.getContext('2d'); g.drawImage(canvas, 0, 0); g.fillStyle = '#fff';
  for (const h of lines.hs) g.fillRect(h.x0 - 3, h.y - 6, h.x1 - h.x0 + 6, 12);
  for (const v of lines.vs) g.fillRect(v.x - 6, v.y0 - 3, 12, v.y1 - v.y0 + 6);
  return { mask, lines, ocrCanvas: oc };
}

function wordStroke(w, mask) {
  const { ink, W } = mask;
  const { x0, y0, x1, y1 } = w.bbox;
  let on = 0, edges = 0;
  for (let y = y0; y < y1; y++) {
    let prev = 0;
    for (let x = x0; x < x1; x++) { const v = ink[y * W + x]; on += v; if (v && !prev) edges++; prev = v; }
  }
  return edges ? on / edges : 0;           // mittlere Strichstärke (Pixel)
}

/** Analysiert eine Seite. canvas = gelesenes Bild, blocks = Tesseract-Struktur, prep = Ergebnis von prepare() */
export function analyzePage(canvas, blocks, prep) {
  const mask = prep?.mask || inkMask(canvas), W = mask.W;
  const tables = findTables(prep?.lines || findLines(mask), W);
  const inTable = (x, y) => tables.find(t => x > t.x0 && x < t.x1 && y > t.y0 && y < t.y1);

  // Wörter sammeln, Tabellenwörter den Zellen zuordnen
  const lines = [];
  for (const b of blocks) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const ws = (l.words || []).filter(w => w.text && w.text.trim() && w.confidence >= 35 && (/[\p{L}\p{N}]/u.test(w.text) || w.confidence >= 70));
    const keep = [];
    for (const w of ws) {
      const cx = (w.bbox.x0 + w.bbox.x1) / 2, cy = (w.bbox.y0 + w.bbox.y1) / 2;
      const t = inTable(cx, cy);
      if (t) {
        const row = t.rows.find(r => cy >= r.y0 && cy <= r.y1);
        const cell = row && row.cells.find(c => cx >= c.x0 && cx <= c.x1);
        if (cell) cell.words.push(w);
        continue;
      }
      keep.push(w);
    }
    if (!keep.length) continue;
    // Zeile an großen Lücken teilen (z. B. Fließtext + Seitenleiste in derselben Höhe)
    keep.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const rowH = l.rowAttributes?.rowHeight || (l.bbox.y1 - l.bbox.y0);
    let seg = [keep[0]];
    const flush = () => lines.push({ para: p, words: seg, x0: Math.min(...seg.map(w => w.bbox.x0)), x1: Math.max(...seg.map(w => w.bbox.x1)), y0: Math.min(...seg.map(w => w.bbox.y0)), y1: Math.max(...seg.map(w => w.bbox.y1)), rowH });
    for (let i = 1; i < keep.length; i++) {
      if (keep[i].bbox.x0 - keep[i - 1].bbox.x1 > Math.max(rowH * 2.2, W * 0.045)) { flush(); seg = []; }
      seg.push(keep[i]);
    }
    flush();
  }
  // Reste ohne Buchstaben/Ziffern (Punkte, Striche aus Logos) verwerfen
  for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].words.some(w => /[\p{L}\p{N}]/u.test(w.text))) lines.splice(i, 1);
  lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  // Fettschrift über die Strichstärke
  const allWords = [...lines.flatMap(l => l.words), ...tables.flatMap(t => t.rows.flatMap(r => r.cells.flatMap(c => c.words)))];
  allWords.forEach(w => { w.stroke = wordStroke(w, mask); w.h = w.bbox.y1 - w.bbox.y0; });
  const relStroke = w => w.stroke / Math.max(4, w.h);
  const medStroke = median(allWords.filter(w => w.text.length > 2).map(relStroke)) || 0.1;
  allWords.forEach(w => { w.bold = relStroke(w) > medStroke * 1.38; });
  // Kurze Wörter/Zeichen übernehmen die Fettung des Nachbarn
  for (const l of lines) l.words.forEach((w, i) => {
    if (w.text.replace(/[^\p{L}\p{N}]/gu, '').length <= 2) w.bold = i > 0 ? l.words[i - 1].bold : (l.words[1] ? l.words[1].bold : w.bold);
  });

  // Zeilen → Absätze
  const medRow = median(lines.map(l => l.rowH)) || 30;
  const paras = [];
  for (const l of lines) {
    const p = [...paras].reverse().slice(0, 6).find(p => p.src === l.para && Math.abs(l.rowH - p.rowH) < p.rowH * 0.25
      && l.y0 - p.y1 < p.rowH * 0.9 && l.y0 > p.y1 - p.rowH * 0.5
      && Math.min(l.x1, p.x1) - Math.max(l.x0, p.x0) > Math.min(l.x1 - l.x0, p.x1 - p.x0) * 0.3);
    if (p) { p.lines.push(l); p.x0 = Math.min(p.x0, l.x0); p.x1 = Math.max(p.x1, l.x1); p.y1 = l.y1; }
    else paras.push({ type: 'para', src: l.para, lines: [l], x0: l.x0, x1: l.x1, y0: l.y0, y1: l.y1, rowH: l.rowH });
  }
  paras.forEach(p => { p.heading = p.rowH > medRow * 1.3; p.size = p.rowH; });

  // Lesereihenfolge + Spalten (Bänder aus überlappenden Elementen)
  const items = [...paras, ...tables].sort((a, b) => a.y0 - b.y0);
  const bands = [];
  for (const it of items) {
    const b = bands[bands.length - 1];
    if (b && it.y0 < b.y1 - 4) { b.items.push(it); b.y1 = Math.max(b.y1, it.y1); }
    else bands.push({ y0: it.y0, y1: it.y1, items: [it] });
  }
  const flow = [];
  for (const b of bands) {
    if (b.items.length < 2) { flow.push(...b.items); continue; }
    const cols = [];
    for (const it of [...b.items].sort((p, q) => p.x0 - q.x0)) {
      const c = cols.find(c => it.x0 < c.x1 - 8 && it.x1 > c.x0 + 8);
      if (c) { c.items.push(it); c.x0 = Math.min(c.x0, it.x0); c.x1 = Math.max(c.x1, it.x1); }
      else cols.push({ x0: it.x0, x1: it.x1, items: [it] });
    }
    cols.sort((p, q) => p.x0 - q.x0);
    for (let i = 1; i < cols.length; i++) if (cols[i].x0 < cols[i - 1].x1 - 8) { cols[i - 1].items.push(...cols[i].items); cols[i - 1].x1 = Math.max(cols[i - 1].x1, cols[i].x1); cols.splice(i--, 1); }
    if (cols.length < 2) { flow.push(...b.items.sort((p, q) => p.y0 - q.y0)); continue; }
    cols.forEach(c => c.items.sort((p, q) => p.y0 - q.y0));
    flow.push({ type: 'cols', x0: cols[0].x0, x1: cols[cols.length - 1].x1, y0: b.y0, y1: b.y1, cols });
  }
  const has = items.length > 0;
  return {
    W, H: mask.H, flow, tables, medRow,
    contentX0: has ? Math.min(...items.map(i => i.x0)) : W * 0.08,
    contentX1: has ? Math.max(...items.map(i => i.x1)) : W * 0.92,
  };
}

// Zeilen eines Absatzes zu Text-Läufen (fett/normal), Silbentrennung auflösen
function paraRuns(p, colX1 = p.x1) {
  const runs = [];
  const push = (t, bold) => { const l = runs[runs.length - 1]; if (l && l.bold === bold) l.t += t; else runs.push({ t, bold }); };
  p.lines.forEach((l, li) => {
    l.words.forEach((w, wi) => {
      const t = w.text;
      const lastOfLine = wi === l.words.length - 1, lastLine = li === p.lines.length - 1;
      if (lastOfLine && !lastLine && /[A-Za-zÄÖÜäöüß]-$/.test(t)) { push(t.slice(0, -1), !!w.bold); return; }
      // Kurze Zeile (endet weit vor dem rechten Rand) → echter Zeilenumbruch statt Leerzeichen
      // Hätte das erste Wort der nächsten Zeile noch hineingepasst, war der Umbruch gewollt
      const nx = !lastLine && p.lines[li + 1].words[0];
      const shortLine = lastOfLine && nx && (colX1 - l.x1) > (nx.bbox.x1 - nx.bbox.x0) + l.rowH * 0.8;
      push(t + (lastOfLine && lastLine ? '' : shortLine ? '\n' : ' '), !!w.bold);
    });
  });
  return runs;
}
function cellText(cell) {
  const lines = [];
  for (const w of [...cell.words].sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const l = lines.find(l => Math.abs(l.y - cy) < (w.bbox.y1 - w.bbox.y0) * 0.6);
    if (l) l.ws.push(w); else lines.push({ y: cy, ws: [w] });
  }
  lines.forEach(l => l.ws.sort((a, b) => a.bbox.x0 - b.bbox.x0));
  const text = lines.map(l => l.ws.map(w => w.text).join(' ')).join('\n');
  const bold = cell.words.length > 0 && cell.words.filter(w => w.bold).length > cell.words.length / 2;
  let align = 'left';
  if (cell.words.length) {
    const tx0 = Math.min(...cell.words.map(w => w.bbox.x0)), tx1 = Math.max(...cell.words.map(w => w.bbox.x1));
    const lpad = tx0 - cell.x0, rpad = cell.x1 - tx1, cw = cell.x1 - cell.x0;
    if (Math.abs(lpad - rpad) < cw * 0.12 && lpad > cw * 0.12) align = 'center';
    else if (rpad < cw * 0.1 && lpad > cw * 0.3) align = 'right';
  }
  return { text, bold, align };
}
function paraAlign(p, colX0, colX1) {
  const cw = colX1 - colX0, mid = (colX0 + colX1) / 2;
  if (p.lines.length === 1) {
    const l = p.lines[0], c = (l.x0 + l.x1) / 2;
    if (l.x0 - colX0 > cw * 0.15 && Math.abs(c - mid) < cw * 0.04) return 'center';
    if (colX1 - l.x1 < cw * 0.03 && l.x0 - colX0 > cw * 0.4) return 'right';
    return 'left';
  }
  const full = p.lines.slice(0, -1).filter(l => colX1 - l.x1 < cw * 0.04).length;
  return full >= Math.max(1, (p.lines.length - 1) * 0.7) && p.lines.length > 2 ? 'both' : 'left';
}

// ======================= Word (.docx) =======================

function docxPara(p, k, colX0, colX1, prevY1) {
  const size = clamp(Math.round(p.size * k * 1.2 * 2) / 2, 6, 40);
  const align = paraAlign(p, colX0, colX1);
  const ind = align === 'left' || align === 'both' ? Math.max(0, Math.round((p.x0 - colX0) * k * 20)) : 0;
  const before = prevY1 == null ? 0 : clamp(Math.round((p.y0 - prevY1) * k * 20 - size * 4), 0, 1200);
  const pitch = p.lines.length > 1 ? (p.lines[p.lines.length - 1].y0 - p.lines[0].y0) / (p.lines.length - 1) * k : size * 1.2;
  const line = clamp(Math.round(pitch / size / 1.17 * 240), 220, 480);
  const sz = Math.round(size * 2);
  const runs = paraRuns(p, colX1).map(r => `<w:r><w:rPr>${r.bold || p.heading ? '<w:b/>' : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>${r.t.split('\n').map(x => `<w:t xml:space="preserve">${xesc(x)}</w:t>`).join('<w:br/>')}</w:r>`).join('');
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="0" w:line="${line}" w:lineRule="auto"/>${ind ? `<w:ind w:left="${ind}"/>` : ''}${align !== 'left' ? `<w:jc w:val="${align}"/>` : ''}</w:pPr>${runs}</w:p>`;
}

function docxTable(t, k, bodySize) {
  const widths = t.xs.slice(1).map((x, i) => Math.max(200, Math.round((x - t.xs[i]) * k * 20)));
  const borders = `<w:tblBorders>${SIDES.map(s => `<w:${s} w:val="single" w:sz="6" w:space="0" w:color="000000"/>`).join('')}</w:tblBorders>`;
  const rows = t.rows.map(r => {
    const h = Math.round((r.y1 - r.y0) * k * 20);
    const cells = r.cells.map(c => {
      const w = widths.slice(c.c0, c.c1).reduce((a, b) => a + b, 0);
      const ct = cellText(c);
      const paras = (ct.text || '').split('\n').map(line => `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/>${ct.align !== 'left' ? `<w:jc w:val="${ct.align}"/>` : ''}</w:pPr>${line ? `<w:r><w:rPr>${ct.bold ? '<w:b/>' : ''}<w:sz w:val="${bodySize * 2}"/><w:szCs w:val="${bodySize * 2}"/></w:rPr><w:t xml:space="preserve">${xesc(line)}</w:t></w:r>` : ''}</w:p>`).join('');
      return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${c.c1 - c.c0 > 1 ? `<w:gridSpan w:val="${c.c1 - c.c0}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>${paras}</w:tc>`;
    }).join('');
    return `<w:tr><w:trPr><w:trHeight w:val="${h}"/></w:trPr>${cells}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblLayout w:type="fixed"/>${borders}<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows}</w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>`;
}

function docxItems(items, k, x0, x1, bodySize) {
  let out = '', prev = null;
  for (const it of items) {
    if (it.type === 'para') { out += docxPara(it, k, x0, x1, prev); prev = it.y1; }
    else if (it.type === 'table') { out += docxTable(it, k, bodySize); prev = it.y1; }
    else if (it.type === 'cols') {
      // Spalten nebeneinander: unsichtbare Tabelle
      const xs = [x0, ...it.cols.slice(1).map((c, i) => (it.cols[i].x1 + c.x0) / 2), x1];
      const widths = xs.slice(1).map((x, i) => Math.max(400, Math.round((x - xs[i]) * k * 20)));
      const tcs = it.cols.map((c, i) => `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/><w:tcBorders>${['top', 'left', 'bottom', 'right'].map(s => `<w:${s} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`).join('')}</w:tcBorders></w:tcPr>${docxItems(c.items, k, xs[i], xs[i + 1], bodySize) || '<w:p/>'}</w:tc>`).join('');
      out += `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${SIDES.map(s => `<w:${s} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`).join('')}</w:tblBorders><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid><w:tr>${tcs}</w:tr></w:tbl>`;
      prev = it.y1;
    }
  }
  return out;
}

export async function pagesToDocx(pages) {
  await loadLib('jszip.min.js');
  let body = '';
  pages.forEach((pg, i) => {
    const land = pg.W > pg.H * 1.1;
    const pw = land ? 841.89 : 595.28, ph = land ? 595.28 : 841.89;
    const k = pw / pg.W;
    const mL = clamp(pg.contentX0 * k - 4, 28, 72), mR = clamp((pg.W - pg.contentX1) * k - 4, 20, 72);
    const bodySize = clamp(Math.round(pg.medRow * k * 1.2), 7, 14);
    body += docxItems(pg.flow, k, pg.contentX0, pg.contentX1, bodySize);
    const sect = `<w:sectPr><w:pgSz w:w="${Math.round(pw * 20)}" w:h="${Math.round(ph * 20)}"${land ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="850" w:right="${Math.round(mR * 20)}" w:bottom="850" w:left="${Math.round(mL * 20)}" w:header="425" w:footer="425" w:gutter="0"/></w:sectPr>`;
    body += i < pages.length - 1 ? `<w:p><w:pPr>${sect}</w:pPr></w:p>` : sect;
  });
  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'uint8array', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

// ======================= Excel (.xlsx) =======================

function toNumber(s) {
  const t = s.trim();
  if (!/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(t) && !/^-?\d+(,\d+)?$/.test(t)) return null;
  const n = parseFloat(t.replace(/\./g, '').replace(',', '.'));
  if (!isFinite(n)) return null;
  const dec = t.includes(',') ? t.split(',')[1].length : 0;
  return { n, fmt: dec ? '#,##0.' + '0'.repeat(dec) : (t.includes('.') ? '#,##0' : '0') };
}

export async function pagesToXlsx(pages) {
  await loadLib('exceljs.min.js');
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Nibvion';
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  pages.forEach((pg, pi) => {
    const ws = wb.addWorksheet(pages.length > 1 ? `Seite ${pi + 1}` : 'Tabelle');
    const k = 595.28 / pg.W;
    const main = [...pg.tables].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
    const nCols = Math.max(1, ...pg.tables.map(t => t.xs.length - 1));
    if (main) main.xs.slice(1).forEach((x, i) => { ws.getColumn(i + 1).width = clamp(Math.round((x - main.xs[i]) * k / 5.6), 6, 80); });
    else ws.getColumn(1).width = 95;
    const totalChars = main ? main.xs.slice(1).reduce((a, x, i) => a + (x - main.xs[i]) * k / 5.6, 0) : 95;
    const flat = [];
    const walk = list => list.forEach(it => it.type === 'cols' ? it.cols.forEach(c => walk(c.items)) : flat.push(it));
    walk(pg.flow);
    flat.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    let row = 1, prevY1 = null;
    for (const it of flat) {
      if (it.type === 'para') {
        if (prevY1 != null && it.y0 - prevY1 > pg.medRow * 1.6) row++;
        const runs = paraRuns(it, pg.contentX1);
        const text = runs.map(r => r.t).join('');
        const size = clamp(Math.round(it.size * k * 1.2), 7, 28);
        const cell = ws.getCell(row, 1);
        cell.value = text;
        cell.font = { name: 'Arial', size, bold: it.heading || runs.every(r => r.bold) };
        cell.alignment = { wrapText: true, vertical: 'top', horizontal: paraAlign(it, pg.contentX0, pg.contentX1) === 'center' ? 'center' : 'left' };
        if (nCols > 1) ws.mergeCells(row, 1, row, nCols);
        const lines = Math.max(it.lines.length, Math.ceil(text.length * (size / 10) / Math.max(10, totalChars)));
        ws.getRow(row).height = Math.max(15, lines * size * 1.35);
        row++; prevY1 = it.y1;
      } else if (it.type === 'table') {
        if (prevY1 != null) row++;
        for (const r of it.rows) {
          for (const c of r.cells) {
            const ct = cellText(c);
            const cell = ws.getCell(row, c.c0 + 1);
            const num = ct.text && !ct.text.includes('\n') ? toNumber(ct.text) : null;
            if (num) { cell.value = num.n; cell.numFmt = num.fmt; } else cell.value = ct.text || null;
            cell.font = { name: 'Arial', size: 10, bold: ct.bold };
            cell.alignment = { wrapText: true, vertical: 'middle', horizontal: num ? 'right' : ct.align };
            if (c.c1 - c.c0 > 1) ws.mergeCells(row, c.c0 + 1, row, c.c1);
            for (let cc = c.c0 + 1; cc <= c.c1; cc++) ws.getCell(row, cc).border = { top: thin, left: thin, bottom: thin, right: thin };
          }
          ws.getRow(row).height = clamp((r.y1 - r.y0) * k, 15, 120);
          row++;
        }
        prevY1 = it.y1;
      }
    }
    if (row === 1) ws.getCell(1, 1).value = '(Kein Text erkannt)';
  });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
