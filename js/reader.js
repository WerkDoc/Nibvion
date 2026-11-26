// ================= Lesemodus (Liquid Mode / Reflow) =================
// Liest den Text jeder Seite über pdf.js (getTextContent) und baut daraus einspaltigen Fließtext:
//  • Zeilen aus Textstücken (gleiche Grundlinie), Spalten über „Gassen“ ohne Text erkannt,
//    Lesereihenfolge: Spalte für Spalte, seitenbreite Zeilen (Titel, Bildunterschriften) trennen Abschnitte
//  • Absätze aus Zeilen (Abstand, Einzug, Schriftgröße), Silbentrennung am Zeilenende wird aufgelöst
//  • Überschriften anhand der Schriftgröße (relativ zur häufigsten Größe = Fließtext)
//  • Kopf-/Fußzeilen, die auf vielen Seiten gleich sind, und Seitenzahlen werden weggelassen
//  • Seiten ohne Text (Scans) erscheinen als Bild
// Die PDF-Datei wird dabei nicht verändert.
import { icon } from './icons.js';
import { haptic, esc } from './ui.js';
import { pdfjsLib } from './pdfcore.js';
import { settings } from './settings.js';

const THEMES = { light: 'Hell', sepia: 'Sepia', dark: 'Dunkel' };
const LINE_H = { 1.4: 'Eng', 1.6: 'Normal', 1.85: 'Weit' };

// ---------------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------------
const norm = s => s.replace(/\s+/g, ' ').trim();

/** Textstücke einer Seite → Zeilen in Lesereihenfolge */
export async function pageLines(pdf, no) {
  const page = await pdf.getPage(no);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim() && !it.hasEOL) { if (it.str === ' ') items.push({ space: true }); continue; }
    const t = pdfjsLib.Util.transform(vp.transform, it.transform);
    if (Math.abs(t[1]) > Math.abs(t[0]) * 0.3) continue;              // gedrehter/senkrechter Text
    const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
    const w = it.width * (vp.scale || 1);
    items.push({ str: it.str, x: t[4], y: t[5], w: w || it.str.length * size * 0.5, size, font: it.fontName });
  }
  // Zeilen: erst nach Grundlinie gruppieren (±35 % Schriftgröße), dann innerhalb der Gruppe
  // an großen Lücken trennen (> 1,15 em) – so bleiben Spalten getrennte Zeilenstücke.
  const parts = items.filter(i => !i.space && i.str.trim()).sort((a, b) => a.y - b.y);
  const rows = [];
  for (const it of parts) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(r.y - it.y) < Math.max(r.size, it.size) * 0.35) { r.items.push(it); r.size = Math.max(r.size, it.size); }
    else rows.push({ y: it.y, size: it.size, items: [it] });
  }
  const lines = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    let ln = null;
    for (const it of r.items) {
      const gap = ln ? it.x - ln.x1 : Infinity;
      if (ln && gap < Math.max(ln.size, it.size) * 1.15 && gap > -Math.max(ln.size, it.size) * 2) {
        ln.parts.push(it); ln.x1 = Math.max(ln.x1, it.x + it.w); ln.size = Math.max(ln.size, it.size); ln.y = Math.max(ln.y, it.y);
      } else {
        ln = { y: it.y, x0: it.x, x1: it.x + it.w, size: it.size, parts: [it] };
        lines.push(ln);
      }
    }
  }
  for (const L of lines) {
    L.parts.sort((a, b) => a.x - b.x);
    let s = '', prev = null;
    for (const p of L.parts) {
      if (prev) {
        const gap = p.x - (prev.x + prev.w);
        if (gap > p.size * 0.18 && !/\s$/.test(s) && !/^\s/.test(p.str)) s += ' ';
      }
      s += p.str; prev = p;
    }
    L.text = norm(s);
    // Schriftgröße der Zeile = häufigste Größe (Initialen o. Ä. nicht überbewerten)
    const sz = {}; L.parts.forEach(p => { const k = Math.round(p.size * 2) / 2; sz[k] = (sz[k] || 0) + p.str.length; });
    L.size = +Object.entries(sz).sort((a, b) => b[1] - a[1])[0][0];
    L.top = L.y - L.size;
  }
  return { lines: lines.filter(l => l.text), w: vp.width, h: vp.height };
}

/** Spalten erkennen und Zeilen in Lesereihenfolge bringen */
export function readingOrder(lines, W) {
  if (lines.length < 6) return lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const x0 = Math.min(...lines.map(l => l.x0)), x1 = Math.max(...lines.map(l => l.x1)), tw = x1 - x0;
  // Abdeckung der x-Achse durch schmale Zeilen (breite Zeilen sind Titel o. Ä.)
  const narrow = lines.filter(l => l.x1 - l.x0 < tw * 0.62);
  const N = Math.max(1, Math.ceil(tw)), cov = new Uint16Array(N + 1);
  for (const l of narrow) for (let x = Math.max(0, Math.floor(l.x0 - x0)); x <= Math.min(N, Math.ceil(l.x1 - x0)); x++) cov[x]++;
  // Gassen: Bereiche (fast) ohne Abdeckung, ≥ 7 pt breit, nicht am Rand. Einzelne Zeilen dürfen
  // hineinragen (zentrierte Titel, Bildunterschriften) – sie werden später als seitenbreit behandelt.
  const tol = Math.max(1, Math.floor(narrow.length * 0.05));
  const gutters = [];
  for (let x = Math.round(tw * 0.15); x < tw * 0.85; x++) {
    if (cov[x] > tol) continue;
    let e = x; while (e < N && cov[e] <= tol) e++;
    if (e - x >= 7) {
      const mid = x0 + (x + e) / 2;
      const left = narrow.filter(l => l.x1 <= mid).length, right = narrow.filter(l => l.x0 >= mid).length;
      if (left >= 3 && right >= 3) gutters.push(mid);
    }
    x = e;
  }
  if (!gutters.length) return lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const col = l => { let c = 0; for (const g of gutters) if (l.x0 >= g - 2) c++; return c; };
  const spans = l => gutters.some(g => l.x0 < g - 2 && l.x1 > g + 2);
  // Abschnitte zwischen seitenbreiten Zeilen: darin Spalte für Spalte lesen
  const sorted = lines.sort((a, b) => a.y - b.y || a.x0 - b.x0), out = [];
  let seg = [];
  const flush = () => { for (let c = 0; c <= gutters.length; c++) out.push(...seg.filter(l => col(l) === c)); seg = []; };
  for (const l of sorted) { if (spans(l)) { flush(); out.push(l); } else seg.push(l); }
  flush();
  out.forEach(l => l.col = spans(l) ? -1 : col(l));
  return out;
}

/** Zeilen → Blöcke (Überschriften, Absätze, Listenpunkte) */
function blocks(lines, body) {
  const res = [];
  let cur = null;
  const isBullet = t => /^([•●▪◦‣∙·\-–—*]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+/.test(t);
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k], prev = lines[k - 1];
    const rel = l.size / body;
    const head = rel >= 1.16 && l.text.length < 160;
    const level = rel >= 1.65 ? 1 : rel >= 1.32 ? 2 : 3;
    const gap = prev ? l.top - prev.y : 0;
    const sameCol = prev && prev.col === l.col;
    const headCont = cur && cur.head && head && sameCol && Math.abs(l.size - prev.size) < 0.5 && gap < l.size * 0.9;
    // Stück derselben Zeile (Blocksatz mit großen Wortabständen)
    if (cur && prev && sameCol && Math.abs(l.y - prev.y) < l.size * 0.35 && l.x0 > prev.x0) {
      cur.text += ' ' + l.text; cur.maxX1 = Math.max(cur.maxX1, l.x1);
      lines[k] = { ...l, x0: prev.x0 };            // für den nächsten Vergleich wie eine ganze Zeile behandeln
      continue;
    }
    // Absatz läuft in der nächsten Spalte weiter (kein Satzende, gleiche Schrift, kein Listenpunkt)
    const colCont = cur && !cur.head && !head && prev && !sameCol && Math.abs(l.size - prev.size) < body * 0.12
      && !/[.!?:;"“”)]$/.test(prev.text) && !isBullet(l.text);
    const newPara = !headCont && !colCont && (!cur || head || cur.head || !sameCol || Math.abs(l.size - prev.size) > body * 0.12
      || gap > l.size * 0.75 || gap < -l.size * 0.5 || isBullet(l.text)
      || (l.x0 - prev.x0 > l.size * 1.2 && /[.!?:]$/.test(prev.text))      // Einzug nach Satzende
      || (prev.x1 < cur.maxX1 - l.size * 6 && /[.!?:]$/.test(prev.text)));  // kurze letzte Zeile
    if (newPara) {
      cur = { head, level, text: l.text, size: l.size, maxX1: l.x1, bullet: isBullet(l.text) };
      res.push(cur);
    } else {
      // Silbentrennung auflösen: „Ver-\nsicherung“ → „Versicherung“
      if (/[a-zäöüß]-$/i.test(cur.text) && /^[a-zäöüß]/.test(l.text)) cur.text = cur.text.slice(0, -1) + l.text;
      else cur.text += ' ' + l.text;
      cur.maxX1 = Math.max(cur.maxX1, l.x1);
    }
  }
  return res;
}

/** Ganzes Dokument analysieren (seitenweise, mit Rückruf für schrittweise Anzeige) */
export async function analyzeDoc(pdf, onPage, isCancelled) {
  const pages = [];
  // Erst alle Zeilen holen (schnell), dann Kopf-/Fußzeilen ermitteln
  for (let i = 1; i <= pdf.numPages; i++) {
    if (isCancelled?.()) return;
    try { pages.push(await pageLines(pdf, i)); } catch { pages.push({ lines: [], w: 1, h: 1 }); }
    if (i <= 3 || i === pdf.numPages) {
      // erste Seiten sofort zeigen
      if (i === Math.min(3, pdf.numPages)) emit(0, i);
    }
    if (i % 8 === 0) await new Promise(r => setTimeout(r, 0));
  }
  let shown = Math.min(3, pdf.numPages);
  emit(shown, pdf.numPages);

  function emit(from, to) {
    // Kopf-/Fußzeilen: Text im oberen/unteren 8 %, der (ohne Ziffern) auf ≥ 40 % der Seiten vorkommt
    const key = t => t.replace(/\d+/g, '#').toLowerCase();
    const cnt = {};
    pages.forEach(p => new Set(p.lines.filter(l => l.top < p.h * 0.08 || l.y > p.h * 0.92).map(l => key(l.text))).forEach(k => cnt[k] = (cnt[k] || 0) + 1));
    const rep = new Set(Object.entries(cnt).filter(([, n]) => pages.length >= 2 && n >= Math.max(2, pages.length * 0.4)).map(([k]) => k));
    // Fließtext-Größe = häufigste Größe (nach Zeichen)
    const sz = {};
    pages.forEach(p => p.lines.forEach(l => { const k = Math.round(l.size * 2) / 2; sz[k] = (sz[k] || 0) + l.text.length; }));
    const body = +(Object.entries(sz).sort((a, b) => b[1] - a[1])[0]?.[0] || 10);
    for (let i = from; i < to; i++) {
      const p = pages[i];
      const kept = p.lines.filter(l => {
        const edge = l.top < p.h * 0.08 || l.y > p.h * 0.92;
        if (!edge) return true;
        if (/^(seite\s*)?\d{1,4}(\s*(\/|von|of)\s*\d{1,4})?$/i.test(l.text) || /^[-–]\s*\d+\s*[-–]$/.test(l.text)) return false;
        return !rep.has(key(l.text));
      });
      const ordered = readingOrder(kept, p.w);
      onPage(i, blocks(ordered, body), ordered.length === 0);
    }
  }
}

// ---------------------------------------------------------------------------------
// Ansicht
// ---------------------------------------------------------------------------------
export function readerMode({ pdf, title = '', start = 0 }) {
  return new Promise(resolve => {
    const S = {
      size: settings.get('rdSize') || 19, lh: settings.get('rdLh') || 1.6,
      theme: settings.get('rdTheme') || (document.documentElement.dataset.theme === 'dark' || matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      font: settings.get('rdFont') || 'serif', alive: true, panel: false,
    };
    const el = document.createElement('div');
    el.className = `reader th-${S.theme} f-${S.font}`;
    el.innerHTML = `
      <div class="rd-top">
        <button class="rd-btn" data-x aria-label="Schließen">${icon('chevronLeft')}</button>
        <div class="rd-title"><b>${esc(title)}</b><small data-pos>Lesemodus</small></div>
        <button class="rd-btn rd-aa" data-aa aria-label="Darstellung">Aa</button>
        <div class="rd-prog"><i data-prog></i></div>
      </div>
      <div class="rd-panel" data-panel>
        <div class="rd-row"><button class="rd-sz" data-sz="-1" aria-label="Kleiner">A<small>−</small></button><span class="rd-szv" data-szv></span><button class="rd-sz big" data-sz="1" aria-label="Größer">A<small>+</small></button></div>
        <div class="rd-row"><span class="rd-lbl">Zeilenabstand</span><div class="rd-seg" data-lh>${Object.entries(LINE_H).map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</div></div>
        <div class="rd-row"><span class="rd-lbl">Schrift</span><div class="rd-seg" data-font><button data-v="serif">Serif</button><button data-v="sans">Sans</button></div></div>
        <div class="rd-row rd-themes" data-th>${Object.entries(THEMES).map(([k, l]) => `<button data-v="${k}" class="t-${k}"><i>Aa</i><span>${l}</span></button>`).join('')}</div>
      </div>
      <div class="rd-scroll" data-scroll><article class="rd-art" data-art><div class="rd-load" data-load><span></span><span></span><span></span><p>Text wird aufbereitet …</p></div></article></div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    const $ = s => el.querySelector(s), art = $('[data-art]'), sc = $('[data-scroll]');

    const apply = () => {
      el.className = `reader show th-${S.theme} f-${S.font}${S.panel ? ' panel-on' : ''}`;
      art.style.fontSize = S.size + 'px'; art.style.lineHeight = S.lh;
      $('[data-szv]').textContent = S.size + ' pt';
      el.querySelectorAll('[data-lh] button').forEach(b => b.classList.toggle('on', +b.dataset.v === +S.lh));
      el.querySelectorAll('[data-font] button').forEach(b => b.classList.toggle('on', b.dataset.v === S.font));
      el.querySelectorAll('[data-th] button').forEach(b => b.classList.toggle('on', b.dataset.v === S.theme));
      settings.set('rdSize', S.size); settings.set('rdLh', S.lh); settings.set('rdTheme', S.theme); settings.set('rdFont', S.font);
    };
    // Lesestelle beim Ändern der Schriftgröße halten
    const keepPlace = fn => { const r = sc.scrollTop / Math.max(1, sc.scrollHeight - sc.clientHeight); fn(); apply(); sc.scrollTop = r * (sc.scrollHeight - sc.clientHeight); };
    el.querySelectorAll('[data-sz]').forEach(b => b.onclick = () => { haptic(); keepPlace(() => S.size = Math.max(13, Math.min(34, S.size + 2 * +b.dataset.sz))); });
    el.querySelectorAll('[data-lh] button').forEach(b => b.onclick = () => { haptic(); keepPlace(() => S.lh = +b.dataset.v); });
    el.querySelectorAll('[data-font] button').forEach(b => b.onclick = () => { haptic(); keepPlace(() => S.font = b.dataset.v); });
    el.querySelectorAll('[data-th] button').forEach(b => b.onclick = () => { haptic(); S.theme = b.dataset.v; apply(); });
    $('[data-aa]').onclick = e => { e.stopPropagation(); haptic(); S.panel = !S.panel; apply(); };
    sc.addEventListener('pointerdown', () => { if (S.panel) { S.panel = false; apply(); } });
    apply();

    // ---------- Inhalt ----------
    const sections = [];
    let firstShown = false;
    const renderScan = async (i, box) => {
      try {
        const p = await pdf.getPage(i + 1), v = p.getViewport({ scale: 1 }), w = Math.min(900, art.clientWidth * Math.min(2, devicePixelRatio || 1));
        const vp = p.getViewport({ scale: w / v.width });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        box.innerHTML = ''; c.className = 'rd-img'; box.appendChild(c);
      } catch { box.textContent = 'Seite konnte nicht angezeigt werden'; }
    };
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); renderScan(+e.target.dataset.i, e.target); } }), { root: sc, rootMargin: '600px' });
    const onPage = (i, bl, empty) => {
      if (!S.alive) return;
      if (!firstShown) { firstShown = true; $('[data-load]')?.remove(); }
      const sec = document.createElement('section');
      sec.className = 'rd-page'; sec.dataset.i = i;
      let html = `<div class="rd-pno"><span>Seite ${i + 1}</span></div>`;
      // Absatz von der vorigen Seite fortsetzen (kein Satzende)
      const lastP = sections[i - 1]?.querySelector('p:last-of-type:not(.rd-li)');
      if (!empty && bl.length && !bl[0].head && !bl[0].bullet && lastP && lastP === sections[i - 1].lastElementChild && !/[.!?:;"“”)]$/.test(lastP.textContent)) {
        const t = bl.shift().text;
        lastP.textContent = /[a-zäöüß]-$/i.test(lastP.textContent) && /^[a-zäöüß]/.test(t) ? lastP.textContent.slice(0, -1) + t : lastP.textContent + ' ' + t;
      }
      if (empty) html += `<div class="rd-scan" data-i="${i}"><p>Diese Seite enthält keinen lesbaren Text (Scan oder Bild).</p></div>`;
      else for (const b of bl) {
        const t = esc(b.text);
        if (b.head) html += `<h${b.level + 1} class="rd-h${b.level}">${t}</h${b.level + 1}>`;
        else if (b.bullet) html += `<p class="rd-li">${t}</p>`;
        else html += `<p>${t}</p>`;
      }
      sec.innerHTML = html;
      art.appendChild(sec); sections[i] = sec;
      sec.querySelectorAll('.rd-scan').forEach(n => io.observe(n));
      if (i === start && start > 0) requestAnimationFrame(() => { sc.scrollTop = sec.offsetTop - 10; });
    };
    analyzeDoc(pdf, onPage, () => !S.alive).then(() => {
      if (!S.alive) return;
      if (!art.querySelector('p, h2, h3, h4, .rd-scan')) art.innerHTML = `<div class="rd-empty">${icon('file')}<p>In diesem PDF wurde kein Text gefunden.</p></div>`;
      onScroll();
    }).catch(e => { console.error(e); art.innerHTML = `<div class="rd-empty"><p>Text konnte nicht gelesen werden.</p></div>`; });

    // ---------- Fortschritt & aktuelle Seite ----------
    let cur = start;
    const onScroll = () => {
      const max = sc.scrollHeight - sc.clientHeight;
      $('[data-prog]').style.transform = `scaleX(${max > 0 ? Math.min(1, sc.scrollTop / max) : 0})`;
      const y = sc.scrollTop + 80;
      for (let k = sections.length - 1; k >= 0; k--) if (sections[k] && sections[k].offsetTop <= y) { cur = k; break; }
      $('[data-pos]').textContent = `Lesemodus · Seite ${cur + 1} von ${pdf.numPages}`;
    };
    sc.addEventListener('scroll', onScroll, { passive: true });

    const close = () => {
      S.alive = false; io.disconnect();
      el.classList.remove('show'); setTimeout(() => el.remove(), 300);
      document.removeEventListener('keydown', key);
      resolve(cur);
    };
    const key = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    $('[data-x]').onclick = () => { haptic(); close(); };
  });
}
