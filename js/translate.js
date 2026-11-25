// ================= Scan übersetzen (wie CamScanner) =================
// Foto → TextIn-KI liest Zeilen mit Positionen → Zeilen zu Absätzen → DeepL übersetzt →
// Übersetzung wird an derselben Stelle ins Bild geschrieben (Hintergrund + Schriftfarbe gemessen).
import { icon } from './icons.js';
import { toast, busy, sheet, esc, haptic, today } from './ui.js';
import { settings } from './settings.js';
import { onlineReady, onlineOcr, onlineTranslate } from './online.js';
import { render as renderScan, cropEditor } from './scanner.js';
import { aiScan } from './aifx.js';
import { inpaintRegion, dilate } from './inpaint.js';
import { shareBytes } from './editor.js';

// [DeepL-Ziel, Name, DeepL-Quelle]
export const LANGS = [
  ['DE', 'Deutsch'], ['EN-GB', 'Englisch', 'EN'], ['FR', 'Französisch'], ['IT', 'Italienisch'], ['ES', 'Spanisch'],
  ['PL', 'Polnisch'], ['RU', 'Russisch'], ['TR', 'Türkisch'], ['UK', 'Ukrainisch'], ['NL', 'Niederländisch'],
  ['PT-PT', 'Portugiesisch', 'PT'], ['CS', 'Tschechisch'], ['RO', 'Rumänisch'], ['HU', 'Ungarisch'], ['EL', 'Griechisch'],
  ['BG', 'Bulgarisch'], ['SV', 'Schwedisch'], ['DA', 'Dänisch'], ['FI', 'Finnisch'], ['NB', 'Norwegisch'],
  ['SK', 'Slowakisch'], ['SL', 'Slowenisch'], ['LT', 'Litauisch'], ['LV', 'Lettisch'], ['ET', 'Estnisch'],
  ['ID', 'Indonesisch'], ['AR', 'Arabisch'], ['ZH-HANS', 'Chinesisch', 'ZH'], ['JA', 'Japanisch'], ['KO', 'Koreanisch'],
];
const srcCode = l => l[2] || l[0];
const langName = code => (LANGS.find(l => srcCode(l) === code || l[0] === code) || [, code])[1];

let ctx = {};
export function initTranslate(c) { ctx = c; }

// ---------- Zeilen → Absätze ----------
// Überschriften bleiben eigene Blöcke, ein Absatz endet nach einer kurzen letzten Zeile
// oder wenn der Abstand größer wird als der übliche Zeilenabstand im Absatz.
export function groupLines(lines, W, H) {
  const L = lines.map(l => ({ t: l.t, x0: l.b[0] * W, y0: l.b[1] * H, x1: l.b[2] * W, y1: l.b[3] * H, h: Math.max(4, (l.h || (l.b[3] - l.b[1]) * 0.8) * H) }))
    .filter(l => l.t && l.t.trim())
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const blocks = [];
  for (const l of L) {
    let best = null;
    for (const b of blocks) {
      const last = b.lines[b.lines.length - 1];
      const lh = Math.max(l.y1 - l.y0, last.y1 - last.y0);
      const gap = l.y0 - last.y1;
      const sameSize = Math.abs(l.h - b.h) / Math.max(l.h, b.h) < 0.2;
      const ov = Math.min(l.x1, b.x1) - Math.max(l.x0, b.x0);
      const aligned = Math.abs(l.x0 - b.x0) < b.h * 2.5 || Math.abs((l.x0 + l.x1) / 2 - (b.x0 + b.x1) / 2) < b.h * 1.5;
      const okGap = gap > -lh * 0.4 && (b.lines.length > 1 ? gap < b.gap + lh * 0.4 : gap < lh * 0.7);
      const ended = b.lines.length > 1 && (last.x1 - last.x0) < (b.x1 - b.x0) * 0.72;
      const heading = b.lines.length === 1 && (l.x1 - l.x0) > (last.x1 - last.x0) * 1.6;
      // Menüs/Listen: kurze Einträge (≤ 3 Wörter) untereinander sind keine Absätze
      const words = t => t.trim().split(/\s+/).length;
      const list = words(last.t) <= 3 && words(l.t) <= 3 && !/[-‐,]$/.test(last.t) && (gap > lh * 0.3 || /^\p{Lu}/u.test(l.t));
      if (sameSize && okGap && !ended && !heading && !list && ov > Math.min(l.x1 - l.x0, b.x1 - b.x0) * 0.3 && aligned) { best = b; break; }
    }
    if (best) {
      const last = best.lines[best.lines.length - 1], prev = last.t, gap = l.y0 - last.y1;
      best.text = /[-‐]$/.test(prev) && /^\p{Ll}/u.test(l.t) ? best.text.replace(/[-‐]$/, '') + l.t : best.text + ' ' + l.t;
      best.gap = best.lines.length > 1 ? (best.gap * (best.lines.length - 1) + gap) / best.lines.length : gap;
      best.lines.push(l); best.x0 = Math.min(best.x0, l.x0); best.x1 = Math.max(best.x1, l.x1); best.y1 = Math.max(best.y1, l.y1);
      best.h = (best.h * (best.lines.length - 1) + l.h) / best.lines.length;
    } else blocks.push({ text: l.t, lines: [l], x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, h: l.h, gap: 0 });
  }
  // Nur Zahlen/Zeichen nicht übersetzen
  blocks.forEach(b => { b.skip = !/\p{L}{2,}/u.test(b.text); });
  return blocks;
}

// Übersetzungen prüfen: Unverändertes (Marken, schon Zielsprache) und erfundene Sätze
// bei abgeschnittenen Wortresten („tes ago“) bleiben im Bild wie im Original.
export function cleanTexts(blocks, raw) {
  const norm = v => (v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return blocks.map((b, i) => {
    const t = raw[i]; if (!t || b.skip) return '';
    const a = norm(b.text), z = norm(t);
    if (!z || a === z) return '';
    if (a.length < 25 && z.length > a.length * 2.5 + 8) return '';        // aus Bruchstück wurde ein ganzer Satz
    if (b.lines.length === 1 && /^\p{Ll}{1,3}\s/u.test(b.text.trim()) && a.length < 10) return '';   // abgeschnittener Wortrest („ays ago“)
    return t;
  });
}

// ---------- Schrift im Bild finden (Maske + Farbe) ----------
const lum = (r, g, b) => r * 0.3 + g * 0.59 + b * 0.11;
export function textMask(data, W, H, b) {
  const pad = Math.max(3, Math.round(b.h * 0.5));
  const x0 = Math.max(0, Math.floor(b.x0 - pad)), y0 = Math.max(0, Math.floor(b.y0 - pad)), x1 = Math.min(W - 1, Math.ceil(b.x1 + pad)), y1 = Math.min(H - 1, Math.ceil(b.y1 + pad));
  const w = x1 - x0 + 1, h = y1 - y0 + 1, N = w * h;
  const Lm = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = ((y + y0) * W + x + x0) * 4; Lm[y * w + x] = lum(data[o], data[o + 1], data[o + 2]); }
  // Hintergrund = weiches Mittel der Umgebung (Radius ≈ Schrifthöhe)
  const r = Math.max(4, Math.round(b.h * 1.1));
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += Lm[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
  const bgL = (x, y) => { const a = Math.max(0, y - r), c = Math.min(h, y + r + 1), l = Math.max(0, x - r), rr = Math.min(w, x + r + 1);
    return (I[c * (w + 1) + rr] - I[a * (w + 1) + rr] - I[c * (w + 1) + l] + I[a * (w + 1) + l]) / ((c - a) * (rr - l)); };
  const dl = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) dl[y * w + x] = Lm[y * w + x] - bgL(x, y);
  // Nur innerhalb der Zeilen suchen
  const inLine = new Uint8Array(N), core = new Uint8Array(N);
  for (const l of b.lines) {
    const e = (l.y1 - l.y0) * 0.22;
    for (let y = Math.max(0, Math.floor(l.y0 - e - y0)); y <= Math.min(h - 1, Math.ceil(l.y1 + e - y0)); y++)
      for (let x = Math.max(0, Math.floor(l.x0 - e - x0)); x <= Math.min(w - 1, Math.ceil(l.x1 + e - x0)); x++) {
        inLine[y * w + x] = 1;
        const yy = y + y0; if (yy > l.y0 + (l.y1 - l.y0) * 0.3 && yy < l.y1 - (l.y1 - l.y0) * 0.3) core[y * w + x] = 1;
      }
  }
  // Hell auf dunkel oder dunkel auf hell? → was im Kern der Zeilen stärker ausschlägt
  let sp = 0, sn = 0;
  for (let i = 0; i < N; i++) if (core[i]) { if (dl[i] > 18) sp += dl[i]; else if (dl[i] < -18) sn -= dl[i]; }
  const pol = sp >= sn ? 1 : -1;
  const vals = []; for (let i = 0; i < N; i++) if (core[i] && pol * dl[i] > 0) vals.push(pol * dl[i]);
  vals.sort((a, c) => a - c);
  const peak = vals[Math.floor(vals.length * 0.9)] || 40, T = Math.max(14, peak * 0.33);
  let mask = new Uint8Array(N); let cnt = 0;
  // Schrift + ihr Schatten/Kontur (Gegenrichtung) gehören beide weg
  for (let i = 0; i < N; i++) if (inLine[i] && (pol * dl[i] > T * 0.75 || -pol * dl[i] > T)) { mask[i] = 1; cnt++; }
  // Schriftfarbe: Kern der Striche (Mitte der Verteilung, nicht die überstrahlten Spitzen)
  const lo = vals[Math.floor(vals.length * 0.6)] || T, hi = vals[Math.floor(vals.length * 0.93)] || peak * 2;
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!core[i]) continue; const v = pol * dl[i]; if (v < Math.max(T, lo) || v > hi) continue;
    const o = ((y + y0) * W + x + x0) * 4; rs += data[o]; gs += data[o + 1]; bs += data[o + 2]; n++;
  }
  let ink = n > 5 ? [rs / n, gs / n, bs / n].map(Math.round) : pol > 0 ? [250, 250, 250] : [25, 25, 28];
  // Rand + Schatten der Buchstaben mit entfernen
  mask = dilate(mask, w, h, Math.max(2, Math.round(b.h * 0.12)));
  return { mask, box: [x0, y0, x1, y1], ink, pol, cnt };
}
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;

// ---------- Text umbrechen ----------
function wrap(x, text, maxW) {
  const words = text.split(/\s+/).filter(Boolean), out = [];
  let line = '';
  for (let w of words) {
    const t = line ? line + ' ' + w : w;
    if (x.measureText(t).width <= maxW) { line = t; continue; }
    if (line) out.push(line);
    while (x.measureText(w).width > maxW && w.length > 1) {      // sehr lange Wörter trennen
      let k = w.length - 1; while (k > 1 && x.measureText(w.slice(0, k) + '-').width > maxW) k--;
      out.push(w.slice(0, k) + '-'); w = w.slice(k);
    }
    line = w;
  }
  if (line) out.push(line);
  return out;
}

/** Übersetzung ins Bild schreiben: alte Schrift wegretuschieren, neue in gemessener Farbe/Größe. */
export function paintTranslation(src, blocks, texts) {
  const W = src.width, H = src.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); x.drawImage(src, 0, 0);
  const data = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const outImg = x.getImageData(0, 0, W, H);
  const act = blocks.map((b, i) => (!b.skip && texts[i]) ? textMask(data, W, H, b) : null);
  act.forEach(m => { if (m) inpaintRegion(outImg.data, W, H, m.mask, m.box); });
  x.putImageData(outImg, 0, 0);
  const FONT = '-apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';
  // Schriftgröße aus der Breite des Originaltexts (misst sich an der echten Schrift, auch bei Screenshots)
  const sizeOf = b => {
    x.font = `500 100px ${FONT}`;
    const rs = b.lines.filter((l, k) => b.lines.length === 1 || k < b.lines.length - 1 || (l.x1 - l.x0) > (b.x1 - b.x0) * 0.9)
      .map(l => { const mw = x.measureText(l.t.trim()).width; return mw > 0 ? 100 * (l.x1 - l.x0) / mw : 0; }).filter(v => v > 0).sort((p, q) => p - q);
    const fw = rs.length ? rs[rs.length >> 1] : 0;
    const boxH = Math.min(...b.lines.map(l => l.y1 - l.y0));
    const fh = Math.max(b.h * 1.25, boxH * 0.9);                 // Obergrenze aus der Zeilenhöhe
    return fw ? Math.min(fw, fh * 1.15) : b.h * 1.3;
  };
  const sizes = blocks.map((b, i) => act[i] ? sizeOf(b) : 0);
  const sv = blocks.map(sizeOf).sort((p, q) => p - q), medS = sv[sv.length >> 1] || 20;
  blocks.forEach((b, i) => {
    const t = texts[i], m = act[i]; if (!m) return;
    const fs0 = sizes[i];
    const bold = fs0 > medS * 1.3 && b.lines.length <= 2 ? 700 : 500;
    const bw0 = b.x1 - b.x0;
    // Platz nach rechts (einzeilig) bis zum nächsten Block in derselben Höhe
    let right = W * 0.98;
    for (const o of blocks) if (o !== b && o.x0 >= b.x1 - 2 && Math.min(o.y1, b.y1) > Math.max(o.y0, b.y0)) right = Math.min(right, o.x0 - fs0 * 0.4);
    const maxW = b.lines.length === 1 ? Math.max(bw0, Math.min(right - b.x0, bw0 * 2.4)) : bw0;
    // Platz nach unten bis zum nächsten Block darunter
    let below = H - b.y1;
    for (const o of blocks) if (o !== b && o.y0 >= b.y1 - 2 && Math.min(o.x1, b.x1) > Math.max(o.x0, b.x0)) below = Math.min(below, o.y0 - b.y1);
    const pitch = b.lines.length > 1 ? (b.lines[b.lines.length - 1].y1 - b.lines[0].y1) / (b.lines.length - 1) : fs0 * 1.25;
    const maxH = (b.y1 - b.y0) + Math.max(0, below - fs0 * 0.5) * 0.8;
    let fs = fs0, lines, lh;
    for (let k = 0; k < 40; k++) {
      x.font = `${bold} ${fs}px ${FONT}`;
      lines = wrap(x, t, maxW);
      lh = b.lines.length > 1 ? Math.max(fs * 1.12, Math.min(pitch, fs * 1.5)) : fs * 1.2;
      // einzeilige Einträge (Menüs, Knöpfe) bleiben einzeilig – lieber etwas kleiner
      const fits = b.lines.length === 1 ? lines.length === 1 || fs < fs0 * 0.72 && lines.length * lh <= maxH : lines.length * lh <= maxH + lh * 0.25;
      if (fits || fs < fs0 * 0.6) break;
      fs *= 0.95;
    }
    x.fillStyle = rgb(m.ink); x.textBaseline = 'alphabetic';
    // Grundlinie: Unterkante der Schrift ohne Unterlängen ≈ Zeilenbox unten minus ~20 % der Schriftgröße
    const l0 = b.lines[0], base0 = Math.min(l0.y1 - fs0 * 0.18, l0.y0 + fs0 * 0.95);
    lines.forEach((ln, j) => x.fillText(ln, b.x0, base0 + j * lh));
  });
  return c;
}

// ---------- Ansicht ----------
export async function translateFlow(items) {
  if (!items?.length) return;
  if (!onlineReady()) {
    return sheet({
      title: 'Übersetzen einrichten',
      html: `<p style="color:var(--text2);margin:0 2px 14px;font-size:15px;line-height:1.45">Zum Übersetzen braucht Nibvion den <b>Online-Scan</b> (TextIn liest den Text) und einen kostenlosen <b>DeepL</b>-Schlüssel in deiner Supabase-Funktion.<br><br>Einstellungen → Online-Scan → Einrichten. Die Anleitung steht in <code>supabase/README.md</code>.</p>`,
    });
  }
  let target = settings.get('trTarget') || 'DE', source = settings.get('trSource') || '';
  const pages = items.map(it => ({ it, src: null, blocks: null, res: {} }));
  let cur = 0, showOrig = false, gen = 0;
  const el = document.createElement('div'); el.className = 'idp tr';
  el.innerHTML = `
    <div class="mg-head tr-head"><button class="icon-btn" data-x aria-label="Zurück">${icon('chevronLeft')}</button>
      <div class="tr-langs"><button data-l="src"></button><span class="tr-arrow">→</span><button data-l="dst"></button></div><span class="mg-sp"></span></div>
    <div class="tr-stage"><div class="tr-frame"><img alt=""></div></div>
    <div class="tr-sub"><div class="tr-pager"><button data-prev>${icon('chevronLeft')}</button><span data-n></span><button data-next>${icon('chevronRight')}</button></div>
      <button class="tr-orig" data-orig>${icon('eye')}<span>Original</span></button></div>
    <div class="tr-bar">
      <button data-a="crop">${icon('fit')}<span>Zuschneiden</span></button>
      <button data-a="share">${icon('share')}<span>Teilen</span></button>
      <button data-a="read">${icon('book')}<span>Lesemodus</span></button>
      <button class="tr-ok" data-a="save" aria-label="Als PDF speichern">${icon('check')}</button>
    </div>`;
  document.body.appendChild(el);
  const frame = el.querySelector('.tr-frame'), img = frame.querySelector('img'), stage = el.querySelector('.tr-stage');
  const labels = () => {
    el.querySelector('[data-l="src"]').innerHTML = `${source ? langName(source) : 'Automatisch'} ${icon('chevronDown')}`;
    el.querySelector('[data-l="dst"]').innerHTML = `${langName(target)} ${icon('chevronDown')}`;
  };
  const fit = () => {
    const p = pages[cur]; if (!p.src) return;
    const r = stage.getBoundingClientRect(), s = Math.min((r.width - 32) / p.src.width, (r.height - 16) / p.src.height);
    Object.assign(frame.style, { width: p.src.width * s + 'px', height: p.src.height * s + 'px' });
  };
  const resKey = () => `${source}>${target}`;
  const show = () => {
    const p = pages[cur], r = p.res[resKey()];
    img.src = (!showOrig && r ? r.url : p.url) || '';
    el.querySelector('[data-n]').textContent = `${cur + 1}/${pages.length}`;
    el.querySelector('.tr-pager').hidden = pages.length < 2;
    const ob = el.querySelector('[data-orig]');
    ob.classList.toggle('on', showOrig); ob.innerHTML = `${icon(showOrig ? 'eyeOff' : 'eye')}<span>Original</span>`;
    ob.disabled = !r;
    fit();
  };
  const run = async () => {
    const p = pages[cur], my = ++gen;
    if (!p.src) { p.src = renderScan(p.it, '', 2400); p.url = p.src.toDataURL('image/jpeg', 0.9); }
    show();
    if (p.res[resKey()]) return;
    const fx = aiScan(frame, { src: p.src, text: 'Nibvion AI übersetzt' });
    try {
      if (!p.blocks) p.blocks = groupLines(await onlineOcr(p.src), p.src.width, p.src.height);
      const todo = p.blocks.map((b, i) => [b, i]).filter(([b]) => !b.skip);
      const tr = todo.length ? await onlineTranslate(todo.map(([b]) => b.text), target, source) : [];
      const base = target.split('-')[0], texts = [];
      // schon in der Zielsprache → Original im Bild lassen
      todo.forEach(([, i], k) => { texts[i] = tr[k]?.text || ''; });
      const clean = cleanTexts(p.blocks, texts); clean.forEach((v, i) => { texts[i] = v; });
      const out = paintTranslation(p.src, p.blocks, texts);
      p.res[resKey()] = { canvas: out, url: out.toDataURL('image/jpeg', 0.9), texts, lang: tr[0]?.lang };
      if (my !== gen || !el.isConnected) { fx.remove(); return; }
      showOrig = false;
      await fx.finish(900);
      show();
      if (!todo.length) toast('Kein Text gefunden');
    } catch (e) { console.warn(e); fx.remove(); toast(e.message || 'Übersetzung fehlgeschlagen', true); }
  };
  const pickLang = which => {
    const list = which === 'src' ? [['', 'Automatisch erkennen'], ...LANGS.map(l => [srcCode(l), l[1]])] : LANGS.map(l => [l[0], l[1]]);
    const curV = which === 'src' ? source : target;
    sheet({
      title: which === 'src' ? 'Ausgangssprache' : 'Übersetzen in',
      html: `<div class="menu tr-lang-list">${list.map(([c, n]) => `<button class="row" data-c="${c}"><span class="row-main"><span class="row-title">${n}</span></span>${c === curV ? icon('check') : ''}</button>`).join('')}</div>`,
      onMount(s, api) {
        s.querySelectorAll('[data-c]').forEach(b => b.onclick = () => {
          api.close(); haptic();
          if (which === 'src') { source = b.dataset.c; settings.set('trSource', source); } else { target = b.dataset.c; settings.set('trTarget', target); }
          labels(); run();
        });
      },
    });
  };
  const close = () => { gen++; el.classList.add('out'); setTimeout(() => el.remove(), 220); removeEventListener('resize', fit); };
  el.querySelector('[data-x]').onclick = () => { haptic(); close(); };
  el.querySelector('[data-l="src"]').onclick = () => pickLang('src');
  el.querySelector('[data-l="dst"]').onclick = () => pickLang('dst');
  el.querySelector('[data-prev]').onclick = () => { if (cur > 0) { cur--; showOrig = false; run(); } };
  el.querySelector('[data-next]').onclick = () => { if (cur < pages.length - 1) { cur++; showOrig = false; run(); } };
  el.querySelector('[data-orig]').onclick = () => { showOrig = !showOrig; haptic(); show(); };
  el.querySelector('[data-a="crop"]').onclick = async () => {
    const p = pages[cur];
    const r = await cropEditor({ img: p.it.img, corners: p.it.corners, rot: p.it.rot || 0 });
    if (!r) return;
    Object.assign(p.it, { corners: r.corners, rot: r.rot }); p.src = null; p.blocks = null; p.res = {}; run();
  };
  el.querySelector('[data-a="share"]').onclick = async () => {
    const r = pages[cur].res[resKey()]; if (!r) return toast('Einen Moment – wird noch übersetzt');
    const blob = await new Promise(res => r.canvas.toBlob(res, 'image/jpeg', 0.9));
    shareBytes(new Uint8Array(await blob.arrayBuffer()), `Übersetzung ${today()}.jpg`, 'image/jpeg');
  };
  el.querySelector('[data-a="read"]').onclick = () => readMode(pages, resKey, target);
  el.querySelector('[data-a="save"]').onclick = async () => {
    const done = pages.map(p => p.res[resKey()]).filter(Boolean);
    if (!done.length) return toast('Einen Moment – wird noch übersetzt');
    busy(true, 'PDF wird erstellt …');
    try {
      const bytes = await ctx.imagesToPdf(done.map(r => r.url), { margin: 0 });
      const id = await ctx.saveNewDoc(bytes, `Übersetzung ${today()}.pdf`);
      busy(false); close(); toast('Übersetzung gespeichert'); ctx.openDoc(id);
    } catch (e) { console.error(e); busy(false); toast('Speichern fehlgeschlagen', true); }
  };
  addEventListener('resize', fit);
  labels(); requestAnimationFrame(run);
}

// Lesemodus: nur der übersetzte Text, gut lesbar, kopierbar
function readMode(pages, resKey, target) {
  const parts = [];
  pages.forEach(p => {
    const r = p.res[resKey()]; if (!r || !p.blocks) return;
    const hs = p.blocks.map(b => b.h).sort((a, b) => a - b), med = hs[hs.length >> 1] || 1;
    p.blocks.forEach((b, i) => {
      const t = b.skip || !r.texts[i] ? b.text : r.texts[i]; if (!t) return;
      parts.push({ t, head: b.h > med * 1.35 });
    });
  });
  if (!parts.length) return toast('Noch keine Übersetzung da');
  const el = document.createElement('div'); el.className = 'idp tr-read';
  el.innerHTML = `<div class="mg-head"><button class="icon-btn" data-x aria-label="Zurück">${icon('chevronLeft')}</button><div class="mg-title">${esc(langName(target))}</div><button class="icon-btn" data-copy aria-label="Kopieren">${icon('copy')}</button></div>
    <div class="tr-read-body">${parts.map(p => p.head ? `<h3>${esc(p.t)}</h3>` : `<p>${esc(p.t)}</p>`).join('')}</div>`;
  document.body.appendChild(el);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.querySelector('[data-x]').onclick = () => { haptic(); close(); };
  el.querySelector('[data-copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(parts.map(p => p.t).join('\n\n')); toast('Text kopiert'); } catch { toast('Kopieren nicht möglich', true); }
  };
}
