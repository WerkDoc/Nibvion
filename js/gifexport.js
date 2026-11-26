// ================= PDF → Animiertes GIF / Slideshow =================
// Seiten werden über pdf.js gerendert, zu einer Zeitleiste aus Standbildern + Übergängen
// zusammengesetzt und mit dem eigenen GIF89a-Encoder (js/gif.js) komplett lokal kodiert.
// Die Live-Vorschau spielt exakt dieselbe Zeitleiste ab, die später im GIF landet.
import { icon } from './icons.js';
import { sheet, toast, busy, haptic, esc } from './ui.js';
import { loadPdf, closePdf } from './pdfcore.js';
import { db } from './db.js';
import { shareBytes, downloadBytes } from './editor.js';
import { GifEncoder } from './gif.js';

const RES = { small: { label: 'Kompakt', px: 480 }, hd: { label: 'HD', px: 960 } };
const FX = { cut: 'Hart', fade: 'Überblenden', slide: 'Schieben' };
const TRANS_FRAMES = 8, TRANS_MS = 50;           // Übergang: 8 Bilder à 50 ms = 0,4 s

/** "1-3, 5" → [0,1,2,4] */
function parsePages(str, n) {
  const out = [];
  for (const part of String(str).split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/); if (!m) continue;
    let a = +m[1], b = m[2] ? +m[2] : a; if (a > b) [a, b] = [b, a];
    for (let k = Math.max(1, a); k <= Math.min(n, b); k++) if (!out.includes(k - 1)) out.push(k - 1);
  }
  return out;
}
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export async function gifSheet(d) {
  if (!d) return;
  let pdf;
  try { const f = await db.get('files', d.id); pdf = await loadPdf(f.data); }
  catch (e) { console.error(e); return toast('PDF konnte nicht geladen werden', true); }
  const N = pdf.numPages;
  const S = { pages: `1-${Math.min(N, 10)}`, dur: 1.5, fx: 'fade', res: 'small', loop: true };
  const cache = new Map();          // `${i}@${W}x${H}` → Canvas
  let timer = 0, alive = true, gen = 0;

  sheet({
    title: 'PDF → Animiertes GIF',
    html: `<div class="gif-prev no-swipe"><canvas data-cv></canvas><div class="gif-badge" data-badge></div><button class="gif-replay" data-replay hidden>${icon('rotate')}</button></div>
      <div class="gif-opts">
        <div class="adj-row"><span>Seiten</span><input class="field gif-pages" data-pages value="${esc(S.pages)}" inputmode="numeric" placeholder="z. B. 1-3, 5"><span class="gif-of">von ${N}</span></div>
        <div class="adj-row"><span>Dauer</span><input type="range" class="range" min="0.5" max="5" step="0.5" value="${S.dur}" data-dur><span data-durv></span></div>
        <div class="gif-row"><span>Übergang</span><div class="seg" data-fx>${Object.entries(FX).map(([k, l]) => `<button data-v="${k}" class="${k === S.fx ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="gif-row"><span>Auflösung</span><div class="seg" data-res>${Object.entries(RES).map(([k, o]) => `<button data-v="${k}" class="${k === S.res ? 'on' : ''}">${o.label}</button>`).join('')}</div></div>
        <div class="gif-row"><span>Endlosschleife</span><div class="seg" data-loop><button data-v="1" class="on">An</button><button data-v="0">Aus</button></div></div>
      </div>
      <div class="btn-row"><button class="btn" data-save>${icon('download')} Sichern</button><button class="btn primary" data-share>${icon('share')} Teilen</button></div>`,
    onMount(el, api) {
      const cv = el.querySelector('[data-cv]'), badge = el.querySelector('[data-badge]'), replay = el.querySelector('[data-replay]');
      const durv = () => el.querySelector('[data-durv]').textContent = S.dur.toLocaleString('de-DE') + ' s';
      durv();
      const seg = (sel, key, conv = v => v) => el.querySelectorAll(`${sel} button`).forEach(b => b.onclick = () => {
        haptic(); S[key] = conv(b.dataset.v);
        el.querySelectorAll(`${sel} button`).forEach(x => x.classList.toggle('on', x === b)); restart();
      });
      seg('[data-fx]', 'fx'); seg('[data-res]', 'res'); seg('[data-loop]', 'loop', v => v === '1');
      el.querySelector('[data-dur]').oninput = e => { S.dur = +e.target.value; durv(); restart(); };
      let pT; el.querySelector('[data-pages]').oninput = e => { S.pages = e.target.value; clearTimeout(pT); pT = setTimeout(restart, 450); };
      replay.onclick = () => { haptic(); restart(); };

      // ---------- Vorschau ----------
      async function restart() {
        const my = ++gen; clearTimeout(timer); replay.hidden = true;
        const list = parsePages(S.pages, N);
        if (!list.length) { badge.textContent = 'Keine gültigen Seiten'; return; }
        const { W, H } = await frameSize(list[0]);
        if (my !== gen) return;
        // Vorschau in halber CSS-Größe der Sheet-Breite, intern volle Auflösung
        cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        badge.textContent = `${list.length} ${list.length === 1 ? 'Seite' : 'Seiten'} · ${W}×${H}`;
        const tl = timeline(list);
        let k = 0;
        const step = async () => {
          if (my !== gen || !alive) return;
          const fr = tl[k];
          await drawFrame(g, fr, W, H);
          if (my !== gen) return;
          k++;
          if (k >= tl.length) { if (!S.loop) { replay.hidden = false; return; } k = 0; }
          timer = setTimeout(step, fr.delay);
        };
        step();
      }
      restart();

      const run = async share => {
        const list = parsePages(S.pages, N);
        if (!list.length) return toast('Bitte gültige Seiten angeben, z. B. 1-3', true);
        gen++; clearTimeout(timer);
        try {
          const bytes = await encode(list);
          const name = d.name.replace(/\.pdf$/i, '') + '.gif';
          if (share) await shareBytes(bytes, name, 'image/gif'); else downloadBytes(bytes, name, 'image/gif');
          toast(`GIF erstellt (${(bytes.length / 1048576).toFixed(1).replace('.', ',')} MB)`);
        } catch (e) { console.error(e); busy(false); toast('GIF konnte nicht erstellt werden', true); }
        restart();
      };
      el.querySelector('[data-save]').onclick = () => run(false);
      el.querySelector('[data-share]').onclick = () => run(true);
    },
    onClose() { alive = false; gen++; clearTimeout(timer); setTimeout(() => { cache.clear(); closePdf(pdf); }, 500); },
  });

  // ---------- Seiten & Zeitleiste ----------
  async function frameSize(first) {
    const p = await pdf.getPage(first + 1), v = p.getViewport({ scale: 1 });
    const k = RES[S.res].px / Math.max(v.width, v.height);
    return { W: Math.round(v.width * k) & ~1, H: Math.round(v.height * k) & ~1 };
  }
  async function pageCanvas(i, W, H) {
    const key = `${i}@${W}x${H}`;
    if (cache.has(key)) return cache.get(key);
    const job = (async () => {
      const p = await pdf.getPage(i + 1), v = p.getViewport({ scale: 1 });
      const k = Math.min(W / v.width, H / v.height), vp = p.getViewport({ scale: k });
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
      const pc = document.createElement('canvas'); pc.width = Math.round(vp.width); pc.height = Math.round(vp.height);
      const pg = pc.getContext('2d'); pg.fillStyle = '#fff'; pg.fillRect(0, 0, pc.width, pc.height);
      await p.render({ canvasContext: pg, viewport: vp }).promise;
      g.drawImage(pc, Math.round((W - pc.width) / 2), Math.round((H - pc.height) / 2));
      return c;
    })();
    cache.set(key, job);
    return job;
  }
  /** Liste aus Standbildern und Übergangsbildern */
  function timeline(list) {
    const tl = [];
    list.forEach((pi, k) => {
      tl.push({ a: pi, delay: Math.round(S.dur * 1000) });
      const nx = k < list.length - 1 ? list[k + 1] : S.loop && list.length > 1 ? list[0] : null;
      if (nx == null || S.fx === 'cut') return;
      for (let f = 1; f < TRANS_FRAMES; f++) tl.push({ a: pi, b: nx, t: ease(f / TRANS_FRAMES), fx: S.fx, delay: TRANS_MS });
    });
    return tl;
  }
  async function drawFrame(g, fr, W, H) {
    const A = await pageCanvas(fr.a, W, H);
    g.globalAlpha = 1; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    if (fr.b == null) { g.drawImage(A, 0, 0); return; }
    const B = await pageCanvas(fr.b, W, H);
    if (fr.fx === 'fade') { g.drawImage(A, 0, 0); g.globalAlpha = fr.t; g.drawImage(B, 0, 0); g.globalAlpha = 1; }
    else {
      const x = Math.round(W * fr.t);
      g.drawImage(A, -x, 0); g.drawImage(B, W - x, 0);
      g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(W - x - 2, 0, 2, H);     // feine Kante zwischen den Seiten
    }
  }
  async function encode(list) {
    busy(true, 'GIF wird erstellt …');
    const { W, H } = await frameSize(list[0]);
    const tl = timeline(list);
    const enc = new GifEncoder(W, H, { loop: S.loop });
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    for (let k = 0; k < tl.length; k++) {
      busy(true, `GIF wird erstellt … ${Math.round(k / tl.length * 100)} %`);
      await drawFrame(g, tl[k], W, H);
      enc.addFrame(g.getImageData(0, 0, W, H), tl[k].delay);
      await new Promise(r => setTimeout(r, 0));
    }
    const out = enc.finish();
    busy(false);
    return out;
  }
}
