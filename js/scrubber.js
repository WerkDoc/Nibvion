// ================= Schnell-Scrubber (Thumbnail-Leiste wie in iOS-Fotos) =================
// Die Leiste passt immer in die Bildschirmbreite: bei langen PDFs zeigt sie gleichmäßig verteilte
// Stichproben-Seiten, der Finger erreicht aber jede einzelne Seite (x-Position → Seite).
// Vorschaubilder werden nur bei Bedarf gerendert (Warteschlange, veraltete Aufträge fallen weg),
// damit auch 200-Seiten-PDFs nicht ruckeln. Beim Wischen springt die Hauptansicht sofort mit,
// darüber schwebt eine große Vorschau mit Seitenzahl.
const SLOT_W = 26;          // Mindestbreite einer Kachel in der Leiste
let S = null;

/** host: Element, in das die Leiste kommt · api: { pdf(), count(), current(), jump(i), done(i) } */
export function initScrubber(host, api) {
  const el = document.createElement('div');
  el.className = 'scrub'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="scrub-bubble" data-bub><div class="scrub-bimg" data-bimg></div><div class="scrub-bno"><b data-bno>1</b><small data-bof></small></div></div>
    <div class="scrub-bar" data-bar><div class="scrub-track" data-track></div><div class="scrub-cur" data-cur><div class="scrub-cimg" data-cimg></div></div></div>`;
  host.appendChild(el);
  S = { el, api, open: false, pdf: null, cache: new Map(), queue: [], running: false, want: -1, slots: 0, dragging: false, cur: -1, gen: 0 };
  const bar = el.querySelector('[data-bar]');

  const pageAt = x => {
    const r = bar.getBoundingClientRect(), n = api.count();
    return Math.max(0, Math.min(n - 1, Math.floor((x - r.left) / r.width * n)));
  };
  let lastJ = -1, raf = 0, pending = -1;
  const scrubTo = (x) => {
    const i = pageAt(x);
    placeBubble(x, i);
    if (i === lastJ) return;
    lastJ = i; pending = i;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pending >= 0) { api.jump(pending); setCurrent(pending); } });
  };
  bar.addEventListener('pointerdown', e => {
    e.preventDefault(); bar.setPointerCapture(e.pointerId);
    S.dragging = true; lastJ = -1; el.classList.add('drag'); scrubTo(e.clientX);
  });
  bar.addEventListener('pointermove', e => { if (S.dragging) scrubTo(e.clientX); });
  const up = () => {
    if (!S.dragging) return;
    S.dragging = false; el.classList.remove('drag');
    api.done?.(lastJ >= 0 ? lastJ : api.current());
  };
  bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
  window.addEventListener('resize', () => { if (S.open) build(); });
}

// ---------- Vorschaubilder (lazy, mit Warteschlange) ----------
function thumb(i, w, prio = false) {
  const key = `${i}@${w}`;
  if (S.cache.has(key)) return Promise.resolve(S.cache.get(key));
  return new Promise(res => {
    const job = { i, w, key, res, gen: S.gen, prio };
    prio ? S.queue.unshift(job) : S.queue.push(job);
    pump();
  });
}
async function pump() {
  if (S.running) return;
  S.running = true;
  while (S.queue.length) {
    const job = S.queue.shift();
    // Veraltet: anderes Dokument oder Blase zeigt längst eine andere Seite
    if (job.gen !== S.gen || (job.prio && job.i !== S.want && !S.cache.has(job.key))) { job.res(null); continue; }
    if (S.cache.has(job.key)) { job.res(S.cache.get(job.key)); continue; }
    try {
      const pdf = S.pdf, page = await pdf.getPage(job.i + 1);
      const v = page.getViewport({ scale: 1 }), d = Math.min(2, devicePixelRatio || 1);
      const vp = page.getViewport({ scale: job.w * d / v.width });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      if (job.gen !== S.gen) { job.res(null); continue; }
      const url = c.toDataURL('image/jpeg', 0.72); c.width = c.height = 0;
      if (S.cache.size > 400) S.cache.delete(S.cache.keys().next().value);
      S.cache.set(job.key, url); job.res(url);
    } catch { job.res(null); }
    await new Promise(r => setTimeout(r, 0));
  }
  S.running = false;
}
const setImg = (node, url) => { if (url && node.isConnected) { node.style.backgroundImage = `url(${url})`; node.classList.add('ok'); } };

// ---------- Aufbau ----------
function build() {
  const n = S.api.count(), track = S.el.querySelector('[data-track]');
  const w = S.el.querySelector('[data-bar]').clientWidth || 300;
  S.slots = Math.max(1, Math.min(n, Math.floor(w / SLOT_W)));
  const pages = [];
  for (let k = 0; k < S.slots; k++) pages.push(S.slots === 1 ? 0 : Math.round(k * (n - 1) / (S.slots - 1)));
  track.innerHTML = pages.map(p => `<i data-p="${p}"></i>`).join('');
  // Kacheln von der Mitte (aktuelle Seite) nach außen laden
  const cur = S.api.current(), nodes = [...track.children];
  nodes.map((nd, k) => [nd, Math.abs(pages[k] - cur)]).sort((a, b) => a[1] - b[1])
    .forEach(([nd]) => thumb(+nd.dataset.p, 60).then(u => setImg(nd, u)));
  S.cur = -1; setCurrent(cur);
}

function setCurrent(i) {
  if (!S || i === S.cur) return;
  S.cur = i;
  const n = S.api.count(), cur = S.el.querySelector('[data-cur]'), bar = S.el.querySelector('[data-bar]');
  const w = bar.clientWidth;
  cur.style.transform = `translateX(${Math.round((i + 0.5) / n * w)}px)`;
  const img = cur.querySelector('[data-cimg]');
  img.classList.remove('ok'); img.style.backgroundImage = '';
  thumb(i, 60, false).then(u => { if (S.cur === i) setImg(img, u); });
}

function placeBubble(x, i) {
  const b = S.el.querySelector('[data-bub]'), bar = S.el.querySelector('[data-bar]'), r = bar.getBoundingClientRect();
  const bw = b.offsetWidth || 130, half = bw / 2;
  const left = Math.max(half + 6, Math.min(innerWidth - half - 6, x)) - r.left;
  b.style.transform = `translateX(${Math.round(left - half)}px)`;
  S.el.querySelector('[data-bno]').textContent = i + 1;
  S.el.querySelector('[data-bof]').textContent = `von ${S.api.count()}`;
  if (S.want === i) return;
  S.want = i;
  const im = S.el.querySelector('[data-bimg]');
  const key = `${i}@150`;
  if (S.cache.has(key)) { setImg(im, S.cache.get(key)); return; }
  // Sofort das kleine Bild (falls vorhanden) zeigen, dann das scharfe nachladen
  const small = S.cache.get(`${i}@60`);
  im.classList.remove('ok'); im.style.backgroundImage = small ? `url(${small})` : '';
  clearTimeout(S.bubT);
  S.bubT = setTimeout(() => thumb(i, 150, true).then(u => { if (S.want === i) setImg(im, u); }), 40);
}

// ---------- Öffentliche Steuerung ----------
export function scrubberReset(pdf) {
  if (!S) return;
  S.gen++; S.queue.forEach(j => j.res(null)); S.queue = []; S.cache.clear(); S.pdf = pdf; S.want = -1;
  if (S.open) toggleScrubber(false);
}
export function toggleScrubber(on = !S?.open) {
  if (!S) return false;
  if (on && S.api.count() < 2) return false;
  S.open = on;
  S.el.classList.toggle('show', on); S.el.setAttribute('aria-hidden', on ? 'false' : 'true');
  document.getElementById('page-chip')?.classList.toggle('on', on);
  if (on) { S.pdf = S.api.pdf(); requestAnimationFrame(build); }
  return on;
}
export function scrubberSync(i) { if (S?.open && !S.dragging) setCurrent(i); }
export const scrubberOpen = () => !!S?.open;
