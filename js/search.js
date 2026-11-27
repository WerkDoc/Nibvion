// ================= Suche: Dateinamen + Text in den PDFs =================
import { db } from './db.js';
import { icon } from './icons.js';
import { sheet, esc, fmtDate } from './ui.js';
import { loadPdf, closePdf } from './pdfcore.js';

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');

// Text aller Seiten (für die Volltextsuche)
export async function extractText(pdf) {
  const pages = [];
  const n = Math.min(pdf.numPages, 300);
  for (let i = 1; i <= n; i++) {
    try {
      const tc = await (await pdf.getPage(i)).getTextContent();
      let t = '';
      for (const it of tc.items) { if (it.str) t += it.str; t += it.hasEOL ? '\n' : ' '; }
      pages.push(t.replace(/[ \t]+/g, ' ').slice(0, 30000));
    } catch { pages.push(''); }
  }
  return pages;
}

async function ensureIndex(d) {
  if (d.textIdx && d.textIdx.size === d.size) return;
  let pages = [];
  try {
    const f = await db.get('files', d.id);
    if (f) { const pdf = await loadPdf(f.data); pages = await extractText(pdf); closePdf(pdf); }
  } catch {}
  const fresh = await db.get('docs', d.id); if (!fresh) return;
  fresh.textIdx = { size: fresh.size, pages };
  await db.put('docs', fresh);
  d.textIdx = fresh.textIdx;
}

function snippet(text, q) {
  const n = norm(text), i = n.indexOf(q);
  if (i < 0) return '';
  const a = Math.max(0, i - 40), b = Math.min(text.length, i + q.length + 60);
  const pre = (a ? '…' : '') + text.slice(a, i), hit = text.slice(i, i + q.length), post = text.slice(i + q.length, b) + (b < text.length ? '…' : '');
  return `${esc(pre)}<mark>${esc(hit)}</mark>${esc(post)}`.replace(/\n/g, ' ');
}

export function searchSheet(openDoc) {
  let docs = [], q = '', indexing = 0;
  sheet({
    title: 'Suchen',
    html: `
      <div class="search-box">${icon('search')}<input class="search-in" data-q type="search" placeholder="Name oder Text in PDFs" autocomplete="off" enterkeyhint="search"><button class="search-clr" data-clr>${icon('x')}</button></div>
      <div class="search-info" data-info></div>
      <div class="search-res" data-res></div>`,
    async onMount(el, api) {
      const inp = el.querySelector('[data-q]'), res = el.querySelector('[data-res]'), info = el.querySelector('[data-info]');
      setTimeout(() => inp.focus(), 350);
      const run = () => {
        const nq = norm(q.trim());
        el.querySelector('[data-clr]').style.visibility = q ? 'visible' : 'hidden';
        if (!nq) {
          res.innerHTML = docs.length ? '' : `<div class="empty" style="border:0">${icon('file')}<b>Noch keine PDFs</b></div>`;
          info.textContent = indexing ? `Inhalte werden vorbereitet … (${indexing} übrig)` : docs.length ? `${docs.length} PDF(s) durchsuchbar` : '';
          return;
        }
        const hits = [];
        for (const d of docs) {
          const inName = norm(d.name).includes(nq);
          let page = -1, snip = '', count = 0;
          (d.textIdx?.pages || []).forEach((t, i) => {
            const nt = norm(t); if (!nt.includes(nq)) return;
            count += nt.split(nq).length - 1;
            if (page < 0) { page = i; snip = snippet(t, nq); }
          });
          if (inName || page >= 0) hits.push({ d, inName, page, snip, count });
        }
        hits.sort((a, b) => (b.inName - a.inName) || (b.count - a.count));
        info.textContent = `${hits.length} Treffer` + (indexing ? ` · Inhalte werden noch vorbereitet (${indexing})` : '');
        res.innerHTML = hits.length ? hits.slice(0, 60).map((h, k) => `
          <button class="row search-hit" data-k="${k}" style="animation-delay:${Math.min(k, 10) * 25}ms">
            <span class="doc-thumb" style="width:38px;height:50px;background-image:url('${h.d.thumb || ''}')"></span>
            <span class="row-main">
              <span class="row-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${h.inName ? snippet(h.d.name, nq) : esc(h.d.name)}</span>
              ${h.snip ? `<span class="search-snip">${h.snip}</span>` : ''}
              <span class="row-sub">${h.page >= 0 ? `Seite ${h.page + 1}${h.count > 1 ? ` · ${h.count}× gefunden` : ''} · ` : ''}${fmtDate(h.d.updated)}</span>
            </span>
          </button>`).join('') : `<div class="empty" style="border:0">${icon('search')}<b>Nichts gefunden</b>Versuche einen anderen Begriff.</div>`;
        res.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { const h = hits[+b.dataset.k]; api.close(); openDoc(h.d.id, 'view', Math.max(0, h.page)); });
      };
      let t;
      inp.oninput = () => { q = inp.value; clearTimeout(t); t = setTimeout(run, 120); };
      inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };
      el.querySelector('[data-clr]').onclick = () => { inp.value = q = ''; run(); inp.focus(); };
      const { isHidden } = await import('./lock.js');
      docs = (await db.all('docs')).filter(d => !d.deletedAt && !isHidden(d)).sort((a, b) => (b.updated || 0) - (a.updated || 0));
      const todo = docs.filter(d => !(d.textIdx && d.textIdx.size === d.size));
      indexing = todo.length; run();
      for (const d of todo) { if (api.closed) break; await ensureIndex(d); indexing--; run(); }
    },
  });
}
