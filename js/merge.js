// ================= Dokumente zusammenführen (wie CamScanner) =================
// Schritt 1: Liste der gewählten PDFs – halten/ziehen zum Sortieren, „Originale behalten“, Datei hinzufügen
// Schritt 2: Vorschau aller Seiten (Seiten sortieren/löschen möglich) → Speichern
import { db } from './db.js';
import { icon } from './icons.js';
import { toast, busy, sheet, esc, fmtDate, haptic } from './ui.js';
import { loadPdf, closePdf, renderThumb, mergePdfs, pagesOp } from './pdfcore.js';
import { reorderPages } from './idpages.js';
import { moveToTrash, isDeleted } from './trash.js';

let ctx = {};
export function initMerge(c) { ctx = c; }

const liveDocs = async () => { const { isHidden } = await import('./lock.js'); return (await db.all('docs')).filter(d => !isDeleted(d) && !isHidden(d)).sort((a, b) => (b.updated || 0) - (a.updated || 0)); };

/** Startet den Ablauf mit den gewählten Dokument-IDs (Reihenfolge = Auswahl). */
export async function mergeFlow(ids, { onDone } = {}) {
  const all = await liveDocs();
  let docs = ids.map(id => all.find(d => d.id === id)).filter(Boolean);
  let keep = true;
  const el = document.createElement('div'); el.className = 'idp mg';
  el.innerHTML = `
    <div class="mg-head"><button class="icon-btn" data-x aria-label="Zurück">${icon('chevronLeft')}</button><div class="mg-title">Zusammenführen</div><span class="mg-sp"></span></div>
    <div class="idp-info">${icon('info')} Halten und ziehen, um die Reihenfolge zu ändern</div>
    <div class="mg-list"></div>
    <div class="mg-foot">
      <label class="mg-keep"><input type="checkbox" checked><span class="mg-box">${icon('check')}</span>Originale behalten</label>
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-add>${icon('filePlus')} Datei hinzufügen</button><button class="btn primary" data-go>${icon('merge')} Zusammenführen</button></div>
    </div>`;
  document.body.appendChild(el);
  const list = el.querySelector('.mg-list');
  const paint = () => {
    list.innerHTML = docs.map((d, i) => `<div class="mg-row" data-i="${i}">
      <div class="doc-thumb" style="background-image:url('${d.thumb || ''}')"></div>
      <div class="mg-info"><div class="doc-name">${esc(d.name.replace(/\.pdf$/i, ''))}</div><div class="doc-meta">${fmtDate(d.updated)} · ${d.pages || 1} S.</div></div>
      <button class="mg-rm" data-rm aria-label="Entfernen">${icon('x')}</button>
      <span class="mg-grip" aria-label="Ziehen"><i></i><i></i><i></i></span></div>`).join('')
      || `<div class="empty" style="border:0">Keine Datei gewählt</div>`;
    list.querySelectorAll('.mg-row').forEach(r => {
      r.onpointerdown = e => press(e, r);
      r.querySelector('[data-rm]').onclick = ev => { ev.stopPropagation(); docs.splice(+r.dataset.i, 1); haptic(); paint(); };
    });
  };
  // Griff sofort ziehen, sonst Zeile 0,35 s halten
  const press = (e, row) => {
    if (e.target.closest('[data-rm]')) return;
    const onGrip = !!e.target.closest('.mg-grip'), x0 = e.clientX, y0 = e.clientY;
    let drag = false, ghost = null, moved = false;
    const start = () => {
      drag = true; haptic();
      const r = row.getBoundingClientRect();
      ghost = row.cloneNode(true); ghost.classList.add('mg-ghost');
      Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
      document.body.appendChild(ghost); row.classList.add('ph'); ghost._dy = y0 - r.top;
    };
    const timer = onGrip ? (start(), 0) : setTimeout(start, 350);
    const mv = ev => {
      if (!drag) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) { clearTimeout(timer); moved = true; } return; }
      ev.preventDefault();
      ghost.style.top = ev.clientY - ghost._dy + 'px';
      const over = [...list.children].find(n => n !== row && (() => { const b = n.getBoundingClientRect(); return ev.clientY > b.top && ev.clientY < b.bottom; })());
      if (over) {
        const rows = [...list.children], a = rows.indexOf(row), b = rows.indexOf(over);
        if (a < b) over.after(row); else over.before(row);
        haptic();
      }
    };
    const up = () => {
      clearTimeout(timer);
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (!drag) return;
      ghost.remove();
      docs = [...list.children].map(n => docs[+n.dataset.i]); paint();
    };
    addEventListener('pointermove', mv, { passive: false }); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  };
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.querySelector('[data-x]').onclick = () => { haptic(); close(); };
  el.querySelector('.mg-keep input').onchange = e => { keep = e.target.checked; haptic(); };
  el.querySelector('[data-add]').onclick = async () => {
    const more = await pickDocs((await liveDocs()).filter(d => !docs.some(x => x.id === d.id)));
    if (more?.length) { docs.push(...more); paint(); }
  };
  el.querySelector('[data-go]').onclick = async () => {
    if (docs.length < 2) return toast('Bitte mindestens 2 Dateien wählen', true);
    busy(true, 'Dokumente werden zusammengeführt …');
    try {
      const bytes = [];
      for (const d of docs) bytes.push(await ctx.docBytes(d));
      const out = await mergePdfs(bytes);
      busy(false);
      preview(out, docs, keep, () => { close(); onDone?.(); });
    } catch (e) { console.error(e); busy(false); toast('Zusammenführen fehlgeschlagen', true); }
  };
  paint();
}

// Weitere Dateien auswählen (mehrere, in Tipp-Reihenfolge) oder vom Gerät importieren
function pickDocs(cands) {
  return new Promise(res => {
    const order = [];
    let done = false;
    sheet({
      title: 'Datei hinzufügen',
      html: `<div class="menu" data-l style="margin-bottom:12px"></div>
        <div class="btn-row"><button class="btn" data-imp>${icon('upload')} Vom Gerät</button><button class="btn primary" data-ok>Hinzufügen</button></div>`,
      onMount(el, api) {
        const l = el.querySelector('[data-l]');
        const paint = () => {
          l.innerHTML = cands.length ? cands.map(d => { const n = order.indexOf(d); return `<button class="row" data-id="${d.id}"><span class="doc-thumb" style="width:34px;height:44px;background-image:url('${d.thumb || ''}')"></span><span class="row-main"><span class="row-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span><span class="row-sub">${d.pages || 1} Seiten</span></span><span class="mg-num${n >= 0 ? ' on' : ''}">${n >= 0 ? n + 1 : ''}</span></button>`; }).join('')
            : `<div class="empty" style="border:0">Keine weiteren PDFs vorhanden.</div>`;
          l.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { const d = cands.find(x => x.id === b.dataset.id), k = order.indexOf(d); k >= 0 ? order.splice(k, 1) : order.push(d); haptic(); paint(); });
        };
        el.querySelector('[data-imp]').onclick = async () => {
          const ids = await ctx.importPdfs(); if (!ids?.length) return;
          const all = await liveDocs();
          for (const id of ids) { const d = all.find(x => x.id === id); if (d) { cands.unshift(d); order.push(d); } }
          paint();
        };
        el.querySelector('[data-ok]').onclick = () => { done = true; api.close(); res(order); };
        paint();
      },
      onClose() { if (!done) res(null); },
    });
  });
}

// Schritt 2: alle Seiten ansehen, optional sortieren, dann speichern
async function preview(bytes, docs, keep, finish) {
  let pages = [], order = null;
  const el = document.createElement('div'); el.className = 'idp mg mg-pv';
  el.innerHTML = `
    <div class="mg-head"><button class="icon-btn" data-x aria-label="Zurück">${icon('chevronLeft')}</button><div class="mg-title">Dokumente zusammenführen</div><button class="icon-btn" data-sort aria-label="Seiten sortieren">${icon('pages')}</button></div>
    <div class="idp-grid mg-grid"></div>
    <div class="mg-foot"><button class="btn primary" data-save>${icon('download')} Speichern</button></div>`;
  document.body.appendChild(el);
  const grid = el.querySelector('.mg-grid');
  const paint = () => {
    const ord = order || pages.map((_, i) => i);
    grid.innerHTML = ord.map((i, j) => `<div class="idp-cell"><div class="idp-th mg-th">${pages[i] ? `<img src="${pages[i]}" alt="">` : '<span class="mg-load"></span>'}</div><div class="idp-num">${j + 1}</div></div>`).join('');
  };
  const pdf = await loadPdf(bytes);
  pages = new Array(pdf.numPages).fill(null); paint();
  let gone = false;
  (async () => {
    for (let i = 0; i < pdf.numPages && !gone; i++) {
      try { pages[i] = await renderThumb(pdf, i + 1, 360); } catch {}
      const img = grid.children[(order || pages.map((_, k) => k)).indexOf(i)]?.querySelector('.mg-th');
      if (img && pages[i]) img.innerHTML = `<img src="${pages[i]}" alt="">`;
    }
    closePdf(pdf);
  })();
  const close = () => { gone = true; el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.querySelector('[data-x]').onclick = () => { haptic(); close(); };
  el.querySelector('[data-sort]').onclick = async () => {
    if (pages.some(p => !p)) return toast('Einen Moment, die Vorschau lädt noch …');
    const ord = order || pages.map((_, i) => i);
    const r = await reorderPages(ord.map(i => ({ src: pages[i] })), { delText: 'Die Seite wird aus dem zusammengeführten Dokument entfernt.' });
    if (r) { order = r.order.map(k => ord[k]); paint(); }
  };
  el.querySelector('[data-save]').onclick = async () => {
    busy(true, 'Wird gespeichert …');
    try {
      const out = order ? await pagesOp(bytes, { order: order.map(i => ({ i })) }) : bytes;
      const first = docs[0], same = docs.every(d => d.folder === first.folder);
      const name = `${first.name.replace(/\.pdf$/i, '')} (zusammengeführt).pdf`;
      const id = await ctx.saveNewDoc(out, name, same && first.folder ? { folder: first.folder, idCat: first.idCat } : {});
      if (!keep) await moveToTrash(docs.map(d => d.id));
      busy(false); close(); finish();
      toast(keep ? 'Zusammengeführt' : 'Zusammengeführt – Originale im Papierkorb');
      ctx.openDoc(id);
    } catch (e) { console.error(e); busy(false); toast('Speichern fehlgeschlagen', true); }
  };
}

