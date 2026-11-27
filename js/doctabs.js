// ================= Dokument-Tabs: einblendbare Leiste unter der Editor-Kopfzeile =================
// Zeigt die offenen PDFs (max. 4) als Chips mit Mini-Cover. Antippen wechselt, „×“ schließt,
// „+“ öffnet ein weiteres PDF. Die Leiste liegt als Overlay über der Werkzeugleiste und gleitet
// nur per transform/opacity herein; der Seitenbereich wechselt mit einer kurzen Wisch-Blende.
import { icon } from './icons.js';
import { esc, haptic } from './ui.js';
import { reducedMotion, springFrames, flipCapture, flipPlay } from './fx.js';

export function initTabs(o) {
  const bar = document.createElement('div');
  bar.className = 'ed-tabbar'; bar.setAttribute('aria-hidden', 'true');
  bar.innerHTML = `<div class="dt-scroll"></div>`;
  o.root.appendChild(bar);
  const row = bar.firstChild;
  let open = false, outAnim = null, lastN = 0, hideT = 0;

  const short = n => String(n || '').replace(/\.pdf$/i, '');
  const render = () => {
    const L = o.list(), cur = o.current();
    const before = flipCapture([...row.children]);
    row.innerHTML = L.map(t => `<div class="dt-tab${t.id === cur ? ' on' : ''}" data-flip="${esc(t.id)}" data-id="${esc(t.id)}" role="button" aria-label="${esc(short(t.name))}">
        <span class="dt-thumb" style="background-image:url('${t.thumb || ''}')"></span>
        <span class="dt-name">${esc(short(t.name))}</span>
        <button class="dt-x" data-x aria-label="Tab schließen">${icon('x')}</button></div>`).join('')
      + `<button class="dt-add" data-flip="+" data-add aria-label="PDF öffnen">${icon('plus')}</button>`;
    flipPlay(row, before);
    row.querySelectorAll('.dt-tab').forEach(el => {
      el.onclick = e => {
        if (e.target.closest('[data-x]')) return;
        haptic();
        if (el.dataset.id !== o.current()) { o.open(el.dataset.id); clearTimeout(hideT); hideT = setTimeout(hide, 900); }
      };
      el.querySelector('[data-x]').onclick = async e => {
        e.stopPropagation(); haptic();
        if (!reducedMotion() && el.animate) {
          await el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.6) translate3d(0,-6px,0)' }], { duration: 170, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
        }
        o.close(el.dataset.id);
      };
    });
    row.querySelector('[data-add]').onclick = () => { haptic(); hide(); o.add(); };
    // Zähler im Kopf
    if (o.count) {
      o.count.textContent = String(Math.max(1, L.length));
      if (L.length !== lastN && lastN && !reducedMotion() && o.count.animate) {
        const sp = springFrames({ stiffness: 600, damping: 14 }, v => ({ transform: `scale(${(1.35 - 0.35 * v).toFixed(3)})` }), 30);
        o.count.animate(sp.frames, { duration: sp.ms });
      }
      lastN = L.length;
      o.count.parentElement.classList.toggle('multi', L.length > 1);
    }
    requestAnimationFrame(() => row.querySelector('.dt-tab.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }));
  };
  const show = () => { open = true; render(); bar.classList.add('show'); bar.setAttribute('aria-hidden', 'false'); o.count?.parentElement.classList.add('on'); };
  function hide() { clearTimeout(hideT); open = false; bar.classList.remove('show'); bar.setAttribute('aria-hidden', 'true'); o.count?.parentElement.classList.remove('on'); }
  // Tipp in den Seitenbereich schließt die Leiste
  o.root.addEventListener('pointerdown', e => { if (open && !bar.contains(e.target) && !e.target.closest('[data-action="ed-tabs"]')) hide(); }, true);

  return {
    render, hide,
    toggle() { open ? hide() : show(); },
    setTop(px) { bar.style.top = px + 'px'; },
    /** Seitenbereich ausblenden (Richtung dir = ±1), liefert Promise */
    animOut(el, dir) {
      if (!el.animate) return Promise.resolve();
      outAnim?.cancel();
      const rm = reducedMotion();
      outAnim = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: rm ? 'none' : `translate3d(${-dir * 34}px,0,0) scale(.985)` }],
        { duration: rm ? 90 : 150, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
      return outAnim.finished.catch(() => {});
    },
    animIn(el, dir) {
      const a = outAnim; outAnim = null;
      if (!el.animate) { a?.cancel(); return; }
      const rm = reducedMotion();
      const sp = rm ? null : springFrames({ stiffness: 340, damping: 30 }, v => ({ opacity: Math.min(1, v * 1.6), transform: `translate3d(${(dir * 34 * (1 - v)).toFixed(2)}px,0,0)` }), 30);
      const inA = rm ? el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 }) : el.animate(sp.frames, { duration: sp.ms });
      a?.cancel();
      inA.onfinish = () => inA.cancel();
    },
  };
}
