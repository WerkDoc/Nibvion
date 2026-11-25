// ================= Scan übersetzen (wie CamScanner) =================
// Foto → TextIn-KI liest Zeilen mit Positionen → Zeilen zu Absätzen → DeepL übersetzt →
// Übersetzung wird an derselben Stelle ins Bild geschrieben (Hintergrund + Schriftfarbe gemessen).
import { icon } from './icons.js';
import { toast, busy, sheet, esc, haptic, today } from './ui.js';
import { settings } from './settings.js';
import { onlineReady, onlineOcr, onlineTranslate } from './online.js';
import { render as renderScan, cropEditor } from './scanner.js';
import { aiScan } from './aifx.js';
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
export function groupLines(lines, W, H) {
  const L = lines.map(l => ({ t: l.t, x0: l.b[0] * W, y0: l.b[1] * H, x1: l.b[2] * W, y1: l.b[3] * H, h: Math.max(4, (l.h || (l.b[3] - l.b[1]) * 0.8) * H) }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const blocks = [];
  for (const l of L) {
    let best = null;
    for (const b of blocks) {
      const last = b.lines[b.lines.length - 1];
      const lh = last.y1 - last.y0;
      const gap = l.y0 - last.y1;
      const sameSize = Math.abs(l.h - b.h) / Math.max(l.h, b.h) < 0.2;
      const ov = Math.min(l.x1, b.x1) - Math.max(l.x0, b.x0);
      const aligned = Math.abs(l.x0 - b.x0) < b.h * 3 || Math.abs((l.x0 + l.x1) / 2 - (b.x0 + b.x1) / 2) < b.h * 2;
      if (sameSize && gap > -lh * 0.4 && gap < lh * 0.9 && ov > Math.min(l.x1 - l.x0, b.x1 - b.x0) * 0.3 && aligned) { best = b; break; }
    }
    if (best) {
      const prev = best.lines[best.lines.length - 1].t;
      best.text = /[-‐]$/.test(prev) && /^\p{Ll}/u.test(l.t) ? best.text.replace(/[-‐]$/, '') + l.t : best.text + ' ' + l.t;
      best.lines.push(l); best.x0 = Math.min(best.x0, l.x0); best.x1 = Math.max(best.x1, l.x1); best.y1 = Math.max(best.y1, l.y1);
      best.h = (best.h * (best.lines.length - 1) + l.h) / best.lines.length;
    } else blocks.push({ text: l.t, lines: [l], x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, h: l.h });
  }
  // Nur Zahlen/Zeichen nicht übersetzen
  blocks.forEach(b => { b.skip = !/\p{L}{2,}/u.test(b.text); });
  return blocks;
}

// ---------- Farben messen ----------
const lum = p => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11;
export function measure(data, W, H, b) {
  const pad = Math.max(2, b.h * 0.35);
  const x0 = Math.max(0, Math.floor(b.x0 - pad)), y0 = Math.max(0, Math.floor(b.y0 - pad)), x1 = Math.min(W - 1, Math.ceil(b.x1 + pad)), y1 = Math.min(H - 1, Math.ceil(b.y1 + pad));
  const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const ring = [];
  const step = Math.max(1, Math.round((x1 - x0 + y1 - y0) / 160));
  for (let x = x0; x <= x1; x += step) ring.push(px(x, y0), px(x, y1));
  for (let y = y0; y <= y1; y += step) ring.push(px(x0, y), px(x1, y));
  const med = k => { const v = ring.map(p => p[k]).sort((a, c) => a - c); return v[v.length >> 1]; };
  const bg = [med(0), med(1), med(2)], lb = lum(bg);
  // Schrift: die stärkste Abweichung vom Hintergrund (heller oder dunkler) – Licht/Schatten im Foto zählt weniger
  // Hintergrund-Streuung am Rand messen: Schrift = was deutlich darüber bzw. darunter liegt
  const rl = ring.map(lum).sort((a, c) => a - c);
  const r5 = rl[Math.floor(rl.length * 0.08)], r95 = rl[Math.floor(rl.length * 0.92)];
  const all = [];
  const st2 = Math.max(1, Math.round(Math.sqrt((x1 - x0) * (y1 - y0) / 6000)));
  for (let y = y0; y <= y1; y += st2) for (let x = x0; x <= x1; x += st2) { const p = px(x, y); all.push([lum(p), p]); }
  const L1 = all.filter(([l]) => l > r95 + 25), D1 = all.filter(([l]) => l < r5 - 25);
  const lightText = L1.length >= D1.length;
  const grp = (lightText ? L1 : D1).sort((a, c) => lightText ? c[0] - a[0] : a[0] - c[0]);
  const top = grp.slice(0, Math.max(1, Math.round(grp.length * 0.5)));
  const ink = top.length > 3 ? [0, 1, 2].map(k => Math.round(top.reduce((s, q) => s + q[1][k], 0) / top.length))
    : lb > 128 ? [20, 20, 24] : [250, 250, 250];
  return { bg, ink, box: [x0, y0, x1, y1] };
}
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;

// Fläche unter dem alten Text füllen: Verlauf aus den Randfarben (passt zu Licht & Schatten im Foto)
function fillBox(src, out, W, m) {
  const [x0, y0, x1, y1] = m.box, bw = x1 - x0 + 1, bh = y1 - y0 + 1, lb = lum(m.bg);
  const at = (x, y) => { const i = (y * W + x) * 4; const p = [src[i], src[i + 1], src[i + 2]]; return Math.abs(lum(p) - lb) > 40 ? m.bg : p; };
  const smooth = arr => { const r = Math.max(2, Math.round(arr.length / 30)), o = []; for (let i = 0; i < arr.length; i++) { let s0 = 0, s1 = 0, s2 = 0, n = 0; for (let k = Math.max(0, i - r); k <= Math.min(arr.length - 1, i + r); k++) { s0 += arr[k][0]; s1 += arr[k][1]; s2 += arr[k][2]; n++; } o.push([s0 / n, s1 / n, s2 / n]); } return o; };
  const T = smooth(Array.from({ length: bw }, (_, i) => at(x0 + i, y0))), B = smooth(Array.from({ length: bw }, (_, i) => at(x0 + i, y1)));
  const Lc = smooth(Array.from({ length: bh }, (_, j) => at(x0, y0 + j))), R = smooth(Array.from({ length: bh }, (_, j) => at(x1, y0 + j)));
  for (let j = 0; j < bh; j++) {
    const v = bh > 1 ? j / (bh - 1) : 0;
    for (let i = 0; i < bw; i++) {
      const u = bw > 1 ? i / (bw - 1) : 0, o = ((y0 + j) * W + x0 + i) * 4;
      // Gewicht: näher am linken/rechten Rand → waagerecht, näher an oben/unten → senkrecht
      const wh = 1 / (Math.min(u, 1 - u) * bw + 1), wv = 1 / (Math.min(v, 1 - v) * bh + 1), sw = wh + wv;
      for (let k = 0; k < 3; k++) {
        const hz = Lc[j][k] * (1 - u) + R[j][k] * u, vt = T[i][k] * (1 - v) + B[i][k] * v;
        out[o + k] = (hz * wh + vt * wv) / sw;
      }
    }
  }
}

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

/** Übersetzung ins Bild schreiben. */
export function paintTranslation(src, blocks, texts) {
  const W = src.width, H = src.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); x.drawImage(src, 0, 0);
  const data = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const outImg = x.getImageData(0, 0, W, H);
  const ms = blocks.map((b, i) => (b.skip || !texts[i]) ? null : measure(data, W, H, b));
  ms.forEach(m => m && fillBox(data, outImg.data, W, m));
  x.putImageData(outImg, 0, 0);
  const hs = blocks.map(b => b.h).sort((a, b) => a - b), medH = hs[hs.length >> 1] || 10;
  const FONT = '-apple-system, "SF Pro Text", Helvetica, Arial, sans-serif';
  blocks.forEach((b, i) => {
    const t = texts[i]; if (b.skip || !t) return;
    const m = ms[i];
    // Schriftgröße so wählen, dass der Absatz in den Kasten passt
    const bold = b.h > medH * 1.25 ? 700 : b.h > medH * 1.1 ? 600 : 500;
    // einzeilige Kästen (Überschriften) dürfen nach rechts etwas breiter werden
    const bw0 = b.x1 - b.x0, maxW = b.lines.length === 1 ? Math.max(bw0, Math.min(W * 0.96 - b.x0, bw0 * 2)) : Math.max(bw0, b.h * 4);
    const maxH = (b.y1 - b.y0) * 1.12 + b.h * 0.3;
    let fs = b.h * 1.4, lines;
    for (let k = 0; k < 30; k++) {
      x.font = `${bold} ${fs}px ${FONT}`;
      lines = wrap(x, t, maxW);
      if (lines.length * fs * 1.2 <= maxH || fs < b.h * 0.55) break;
      fs *= 0.94;
    }
    x.fillStyle = rgb(m.ink); x.textBaseline = 'top';
    const lh = fs * 1.2, top = b.y0 + ((b.y1 - b.y0) - lines.length * lh) / 2 + fs * 0.06;
    lines.forEach((ln, j) => x.fillText(ln, b.x0, top + j * lh));
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
    if (!p.src) { p.src = renderScan(p.it, 'color', 2400); p.url = p.src.toDataURL('image/jpeg', 0.9); }
    show();
    if (p.res[resKey()]) return;
    const fx = aiScan(frame, { src: p.src, text: 'Nibvion AI übersetzt' });
    try {
      if (!p.blocks) p.blocks = groupLines(await onlineOcr(p.src), p.src.width, p.src.height);
      const todo = p.blocks.map((b, i) => [b, i]).filter(([b]) => !b.skip);
      const tr = todo.length ? await onlineTranslate(todo.map(([b]) => b.text), target, source) : [];
      const base = target.split('-')[0], texts = [];
      // schon in der Zielsprache → Original im Bild lassen
      todo.forEach(([b, i], k) => { const r = tr[k]; texts[i] = !r ? '' : (r.lang === base && r.text.trim() === b.text.trim()) ? '' : r.text; });
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
