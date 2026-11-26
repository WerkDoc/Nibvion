// ================= Dateien: Ordner & ID-Ordner =================
// Ordner liegen im Store „assets“ ({ kind: 'folder', type: 'normal' | 'id' }), Dokumente merken
// sich ihren Ordner in meta.folder (bei ID-Ordnern zusätzlich meta.idCat). Alles bleibt lokal.
import { db, uid } from './db.js';
import { icon } from './icons.js';
import { sheet, toast, busy, haptic, esc, fmtDate, fmtSize, promptDlg, confirmDlg } from './ui.js';
import { isDeleted, moveToTrash, TRASH_DAYS } from './trash.js';
import { shareBytes } from './editor.js';

export const ID_CATS = [
  { id: 'idcard', label: 'ID-Karte', sub: 'Personalausweis', icon: 'user', c: 'c-blue', sides: 2 },
  { id: 'driver', label: 'Führerschein', icon: 'wheel', c: 'c-orange', sides: 2 },
  { id: 'passport', label: 'Reisepass', sub: 'Datenseite', icon: 'globe', c: 'c-violet', sides: 1 },
  { id: 'bank', label: 'Bankkarte', icon: 'card', c: 'c-green', sides: 2 },
  { id: 'cert', label: 'Zertifikat', sub: 'Urkunden, Zeugnisse (A4)', icon: 'award', c: 'c-amber', sides: 0 },
  { id: 'other', label: 'Andere Ausweise', sub: 'Mitglieds-, Versichertenkarte …', icon: 'badge', c: 'c-gray', sides: 2 },
];
export const idCat = id => ID_CATS.find(c => c.id === id) || ID_CATS[ID_CATS.length - 1];

// Farb-Tags: Dokumente merken sich meta.tags = ['red', …], Ordner meta.color = 'blue'
export const TAGS = [
  { id: 'red', label: 'Rot', c: '#ff453a' }, { id: 'orange', label: 'Orange', c: '#ff9f0a' }, { id: 'yellow', label: 'Gelb', c: '#ffd60a' },
  { id: 'green', label: 'Grün', c: '#30d158' }, { id: 'blue', label: 'Blau', c: '#0a84ff' }, { id: 'purple', label: 'Lila', c: '#bf5af2' },
];
const tagC = id => TAGS.find(t => t.id === id)?.c;
let filt = null;       // Filter: null = alle, 'fav' oder Tag-ID

let ctx = {};
let cur = null;        // offener Ordner (id) oder null = Übersicht
let curCat = null;     // offene Kategorie im ID-Ordner
let sel = null;        // Auswahlmodus: Set mit Dokument-IDs (null = aus)
let shown = [];        // gerade sichtbare Dokumente (für „Alles auswählen“)
const $ = id => document.getElementById(id);

export async function folders() {
  return (await db.all('assets')).filter(a => a.kind === 'folder').sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
async function liveDocs() { return (await db.all('docs')).filter(d => !isDeleted(d)); }

// Ziel für neu erstellte Dokumente: nur solange der Tab „Dateien“ in einem Ordner offen ist
export function fileTarget() {
  if (document.body.dataset.tab !== 'files' || !cur) return null;
  return { folder: cur, idCat: curCat || undefined };
}

export async function createFolder(type = 'normal', name) {
  name ??= await promptDlg(type === 'id' ? 'ID-Ordner erstellen' : 'Ordner erstellen', type === 'id' ? 'Ausweise' : 'Neuer Ordner', 'Erstellen');
  if (!name) return null;
  const f = { id: uid(), kind: 'folder', type, name: name.trim(), created: Date.now() };
  await db.put('assets', f);
  haptic();
  return f;
}

// Ersten ID-Ordner nehmen oder „Ausweise“ anlegen (für den Kamera-Modus „Ausweise“)
export async function ensureIdFolder() {
  const f = (await folders()).find(x => x.type === 'id');
  return f || createFolder('id', 'Ausweise');
}

export function initFiles(c) { ctx = c; }

export function openFolder(id, cat = null) { cur = id; curCat = cat; renderFiles(); }

export async function renderFiles() {
  const list = $('files-list'), head = $('files-head');
  if (!list) return;
  const [fs, docs] = await Promise.all([folders(), liveDocs()]);
  const folder = cur && fs.find(f => f.id === cur);
  if (cur && !folder) { cur = null; curCat = null; }
  const sortDocs = a => a.sort((x, y) => (y.updated || 0) - (x.updated || 0));

  if (!folder) {
    head.innerHTML = sel ? selHead() : `<h1 class="page-title">Dateien</h1><div class="fl-hbtns"><button class="icon-btn" data-sel aria-label="Auswählen">${icon('checkSquare')}</button><button class="icon-btn" data-action="search" aria-label="Suchen">${icon('search')}</button></div>`;
    const ids = new Set(fs.map(f => f.id));
    const count = id => docs.filter(d => d.folder === id).length;
    if (filt) {
      // Filter aktiv: passende Dokumente aus allen Ordnern + Ordner mit dieser Farbe
      const hit = sortDocs(docs.filter(matchFilt));
      const hitF = filt === 'fav' ? [] : fs.filter(f => f.color === filt);
      const t = TAGS.find(x => x.id === filt);
      list.innerHTML = `${filterBar(docs, fs)}
        <div class="section-row"><h2 class="section-title">${t ? `<i class="ff-dot" style="background:${t.c}"></i>${t.label}` : 'Favoriten'} <span class="fl-count">(${hit.length})</span></h2></div>
        <div class="recent-list">
          ${hitF.map(f => folderRow(f, count(f.id), 0)).join('')}
          ${docRows(hit, hitF.length)}
        </div>
        ${!hit.length && !hitF.length ? `<div class="empty">${icon('tag')}<b>Nichts markiert</b>Tippe bei einer Datei auf ⋯ → „Farb-Tags“.</div>` : ''}
        <div class="bottom-space"></div>`;
      bindFolderRows(list, fs); bindFilter(list);
      shown = hit; bindDocRows(list, hit); bindHead(head);
      return;
    }
    const loose = sortDocs(docs.filter(d => !d.folder || !ids.has(d.folder)));
    list.innerHTML = `${filterBar(docs, fs)}
      <div class="fl-cards">
        <button class="fl-card" data-c="docs"><span class="qt-ic c-blue">${icon('filePlus')}</span><span>Dokumente importieren</span></button>
        <button class="fl-card" data-c="imgs"><span class="qt-ic c-teal">${icon('images')}</span><span>Bilder importieren</span></button>
        <button class="fl-card" data-c="new"><span class="qt-ic c-green">${icon('folderPlus')}</span><span>Ordner erstellen</span></button>
      </div>
      <div class="section-row"><h2 class="section-title">Alle <span class="fl-count">(${docs.length})</span></h2></div>
      <div class="recent-list">
        ${fs.map((f, i) => folderRow(f, count(f.id), i)).join('')}
        ${docRows(loose, fs.length)}
      </div>
      ${!fs.length && !loose.length ? `<div class="empty">${icon('folder')}<b>Noch nichts hier</b>Importiere Dokumente oder erstelle einen Ordner.</div>` : ''}
      <div class="bottom-space"></div>`;
    list.querySelector('[data-c="docs"]').onclick = () => ctx.importDocs();
    list.querySelector('[data-c="imgs"]').onclick = () => ctx.importImages();
    list.querySelector('[data-c="new"]').onclick = () => newFolderSheet();
    bindFolderRows(list, fs); bindFilter(list);
    shown = loose; bindDocRows(list, loose); bindHead(head);
    return;
  }

  // ----- in einem Ordner -----
  const inF = docs.filter(d => d.folder === folder.id);
  const cat = folder.type === 'id' && curCat ? idCat(curCat) : null;
  const canSel = !(folder.type === 'id' && !cat);
  if (!canSel) sel = null;
  head.innerHTML = sel ? selHead() : `<button class="icon-btn" data-back aria-label="Zurück">${icon('chevronLeft')}</button>
    <h1 class="page-title fl-title">${esc(cat ? cat.label : folder.name)}</h1>
    ${canSel ? `<button class="icon-btn" data-sel aria-label="Auswählen">${icon('checkSquare')}</button>` : ''}
    <button class="icon-btn" data-fm aria-label="Mehr">${icon('more')}</button>`;
  if (!sel) {
    head.querySelector('[data-back]').onclick = () => { haptic(); filt = null; if (curCat) curCat = null; else cur = null; renderFiles(); };
    head.querySelector('[data-fm]').onclick = () => cat ? catAdd(folder, cat) : folderMenu(folder);
  }
  bindHead(head);

  if (folder.type === 'id' && !cat) {
    const n = id => inF.filter(d => (d.idCat || 'other') === id).length;
    list.innerHTML = `<div class="menu fl-ids">${ID_CATS.map((c, i) => `
        <button class="row" data-cat="${c.id}" style="animation-delay:${i * 35}ms"><span class="row-ic ${c.c}">${icon(c.icon)}</span>
          <span class="row-main"><span class="row-title">${c.label}</span></span>
          <span class="row-end fl-add">${n(c.id) ? `${n(c.id)}` : 'Hinzufügen'} ${icon('chevronRight')}</span></button>`).join('')}</div>
      <div class="bottom-space"></div>
      <button class="fl-fab" data-plus aria-label="Hinzufügen">${icon('plus')}</button>`;
    list.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => {
      haptic();
      const c = idCat(b.dataset.cat);
      if (n(c.id)) { curCat = c.id; renderFiles(); } else ctx.captureId(folder, c);
    });
    list.querySelector('[data-plus]').onclick = () => addIdSheet(folder);
    return;
  }

  shown = sortDocs((cat ? inF.filter(d => (d.idCat || 'other') === cat.id) : inF).filter(matchFilt));
  list.innerHTML = `${inF.some(d => d.tags?.length || d.fav) || filt ? filterBar(inF, []) : ''}
    <div class="fl-actions">
      ${cat ? `<button class="btn primary" data-add>${icon('plus')} ${esc(cat.label)} hinzufügen</button>`
      : `<button class="btn" data-scan>${icon('scan')} Scannen</button><button class="btn" data-imp>${icon('filePlus')} Importieren</button>`}
    </div>
    <div class="recent-list">${docRows(shown, 0)}</div>
    ${!shown.length ? (filt ? `<div class="empty">${icon('tag')}<b>Keine passenden Dateien</b>In diesem Ordner hat keine Datei diesen Filter.</div>` : `<div class="empty">${icon('folder')}<b>Ordner ist leer</b>Scanne oder importiere Dokumente – sie landen direkt hier.</div>`) : ''}
    <div class="bottom-space"></div>`;
  bindFilter(list);
  list.querySelector('[data-scan]')?.addEventListener('click', () => ctx.scan());
  list.querySelector('[data-imp]')?.addEventListener('click', () => ctx.importDocs());
  list.querySelector('[data-add]')?.addEventListener('click', () => ctx.captureId(folder, cat));
  bindDocRows(list, shown);
}

function folderRow(f, n, i) {
  return `<div class="doc-row fl-row${sel ? ' off' : ''}" data-f="${f.id}" style="animation-delay:${Math.min(i, 8) * 40}ms">
    <span class="fl-ic ${f.type === 'id' ? 'id' : ''}" ${f.color && tagC(f.color) ? `style="--fc:${tagC(f.color)}"` : ''}>${icon(f.type === 'id' ? 'idFolder' : 'folder')}</span>
    <button class="doc-info" data-open><div class="doc-name">${esc(f.name)}</div><div class="doc-meta">${f.type === 'id' ? 'ID-Ordner · ' : ''}${n} ${n === 1 ? 'Dokument' : 'Dokumente'}</div></button>
    <button class="doc-more" data-fmore aria-label="Mehr">${icon('more')}</button></div>`;
}
function bindFolderRows(list, fs) {
  list.querySelectorAll('[data-f]').forEach(r => {
    const f = fs.find(x => x.id === r.dataset.f); if (!f) return;
    r.querySelector('[data-open]').onclick = () => { haptic(); filt = null; openFolder(f.id); };
    r.querySelector('.fl-ic').onclick = () => { haptic(); filt = null; openFolder(f.id); };
    r.querySelector('[data-fmore]').onclick = () => folderMenu(f);
  });
}

function filterBar(docs, fs) {
  const n = id => id === 'fav' ? docs.filter(d => d.fav).length : docs.filter(d => d.tags?.includes(id)).length + fs.filter(f => f.color === id).length;
  const anyFav = docs.some(d => d.fav);
  return `<div class="fl-filter" data-filter>
    <button class="ff-chip${!filt ? ' on' : ''}" data-ft="">Alle</button>
    ${anyFav || filt === 'fav' ? `<button class="ff-chip${filt === 'fav' ? ' on' : ''}" data-ft="fav">${icon('heartFill')}Favoriten</button>` : ''}
    ${TAGS.map(t => { const c = n(t.id); return `<button class="ff-chip ff-tag${filt === t.id ? ' on' : ''}${c ? '' : ' empty'}" data-ft="${t.id}" style="--tc:${t.c}" aria-label="${t.label}"><i></i><span>${t.label}</span>${c ? `<small>${c}</small>` : ''}</button>`; }).join('')}
  </div>`;
}
function bindFilter(list) {
  list.querySelectorAll('[data-ft]').forEach(b => b.onclick = () => {
    const v = b.dataset.ft || null; haptic();
    filt = filt === v ? null : v; renderFiles();
    requestAnimationFrame(() => document.querySelector('[data-filter] .ff-chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }));
  });
}
const matchFilt = d => !filt || (filt === 'fav' ? d.fav : d.tags?.includes(filt));

function docRows(docs, offset) {
  return docs.map((d, i) => `
    <div class="doc-row${sel?.has(d.id) ? ' sel-on' : ''}" data-id="${d.id}" style="animation-delay:${sel ? 0 : Math.min(i + offset, 8) * 40}ms">
      <div class="doc-thumb" style="background-image:url('${d.thumb || ''}')"></div>
      <button class="doc-info" data-open>
        <div class="doc-name">${d.fav ? `<span class="doc-fav">${icon('heartFill')}</span>` : ''}${esc(d.name)}</div>
        <div class="doc-meta">${d.tags?.length ? `<span class="doc-tags">${d.tags.map(t => tagC(t) ? `<i style="background:${tagC(t)}"></i>` : '').join('')}</span>` : ''}${fmtDate(d.updated)} · ${fmtSize(d.size || 0)} · ${d.pages || 1} S.</div>
      </button>
      ${sel ? `<span class="sel-ck">${icon('check')}</span>` : `<button class="doc-more" data-more aria-label="Mehr">${icon('more')}</button>`}
    </div>`).join('');
}
function bindDocRows(list, docs) {
  list.querySelectorAll('.doc-row[data-id]').forEach(r => {
    const d = docs.find(x => x.id === r.dataset.id); if (!d) return;
    if (sel) { r.onclick = () => toggle(d.id, r); return; }
    r.querySelector('[data-open]').onclick = () => { if (!r._lp) ctx.openDoc(d.id); };
    r.querySelector('.doc-thumb').onclick = () => { if (!r._lp) ctx.openDoc(d.id); };
    r.querySelector('[data-more]').onclick = () => ctx.docMenu(d);
    // lange drücken → Auswahlmodus mit diesem Dokument
    r.onpointerdown = e => {
      if (e.target.closest('[data-more]')) return;
      r._lp = false; const x0 = e.clientX, y0 = e.clientY;
      const t = setTimeout(() => { r._lp = true; startSel([d.id]); }, 500);
      const end = () => { clearTimeout(t); r.removeEventListener('pointerup', end); r.removeEventListener('pointercancel', end); r.removeEventListener('pointermove', mv); };
      const mv = ev => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) end(); };
      r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end); r.addEventListener('pointermove', mv);
    };
    r.oncontextmenu = e => e.preventDefault();
  });
}

// ---------- Auswahlmodus (Teilen, Verschieben, Zusammenführen, Löschen) ----------
const selHead = () => `<button class="link-btn sel-cancel" data-cancel>Abbrechen</button>
  <div class="sel-count">${sel.size} ausgewählt</div>
  <button class="link-btn sel-all" data-all>${shown.length && shown.every(d => sel.has(d.id)) ? 'Keine' : 'Alle auswählen'}</button>`;
function bindHead(head) {
  head.querySelector('[data-sel]')?.addEventListener('click', () => startSel([]));
  head.querySelector('[data-cancel]')?.addEventListener('click', () => { haptic(); endSel(); });
  head.querySelector('[data-all]')?.addEventListener('click', () => {
    const all = shown.length && shown.every(d => sel.has(d.id));
    shown.forEach(d => all ? sel.delete(d.id) : sel.add(d.id)); haptic(); renderFiles();
  });
  paintBar();
}
function startSel(ids) { sel = new Set(ids); haptic(); document.body.classList.add('selecting'); renderFiles(); }
export function endSel() { sel = null; document.body.classList.remove('selecting'); document.getElementById('sel-bar')?.classList.remove('on'); renderFiles(); }
export const selecting = () => !!sel;
function toggle(id, row) {
  sel.has(id) ? sel.delete(id) : sel.add(id); haptic();
  row.classList.toggle('sel-on', sel.has(id));
  const h = $('files-head'); h.innerHTML = selHead(); bindHead(h);
}
function paintBar() {
  let bar = document.getElementById('sel-bar');
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'sel-bar'; bar.className = 'sel-bar';
    bar.innerHTML = [['share', 'share', 'Teilen'], ['move', 'folderMove', 'Verschieben'], ['merge', 'merge', 'Zusammen&shy;führen'], ['del', 'trash', 'Löschen'], ['more', 'more', 'Mehr']]
      .map(([a, ic, l]) => `<button data-sa="${a}">${icon(ic)}<span>${l}</span></button>`).join('');
    document.body.appendChild(bar);
    bar.querySelectorAll('[data-sa]').forEach(b => b.onclick = () => selAction(b.dataset.sa));
  }
  bar.classList.toggle('on', !!sel);
  if (!sel) return;
  const n = sel.size;
  bar.querySelectorAll('[data-sa]').forEach(b => { b.disabled = b.dataset.sa === 'merge' ? n < 2 : !n; });
}
async function selDocs() {
  const all = await liveDocs();
  return shown.filter(d => sel.has(d.id)).map(d => all.find(x => x.id === d.id)).filter(Boolean);
}
async function selAction(a) {
  if (!sel?.size) return;
  haptic();
  const docs = await selDocs();
  if (a === 'merge') { if (docs.length < 2) return toast('Bitte mindestens 2 Dateien wählen', true); const ids = docs.map(d => d.id); return ctx.merge(ids); }
  if (a === 'move') return moveDocSheet(docs, () => { endSel(); ctx.renderRecents?.(); });
  if (a === 'del') {
    if (!await confirmDlg(`${docs.length} ${docs.length === 1 ? 'Datei' : 'Dateien'} löschen?`, `Sie kommen in den Papierkorb und können ${TRASH_DAYS} Tage lang wiederhergestellt werden.`, 'In den Papierkorb')) return;
    await moveToTrash(docs.map(d => d.id)); toast('In den Papierkorb verschoben'); endSel(); ctx.renderRecents?.(); return;
  }
  if (a === 'share') {
    busy(true, 'Wird vorbereitet …');
    try {
      const files = [];
      for (const d of docs) files.push(new File([await ctx.docBytes(d)], /\.pdf$/i.test(d.name) ? d.name : d.name + '.pdf', { type: 'application/pdf' }));
      busy(false);
      if (files.length > 1 && navigator.canShare?.({ files })) { try { await navigator.share({ files }); } catch {} }
      else for (const f of files) await shareBytes(new Uint8Array(await f.arrayBuffer()), f.name);
    } catch (e) { console.error(e); busy(false); toast('Teilen fehlgeschlagen', true); }
    return;
  }
  if (a === 'more') {
    const allFav = docs.every(d => d.fav);
    sheet({
      title: `${docs.length} ausgewählt`,
      html: `<div class="menu"><button class="row" data-m="fav"><span class="row-ic c-red">${icon(allFav ? 'heartFill' : 'heart')}</span><span class="row-main"><span class="row-title">${allFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}</span></span></button>
        <button class="row" data-m="tags"><span class="row-ic c-orange">${icon('tag')}</span><span class="row-main"><span class="row-title">Farb-Tags</span></span></button></div>`,
      onMount(el, api) {
        el.querySelector('[data-m="tags"]').onclick = () => { api.close(); tagSheet(docs, () => { endSel(); ctx.renderRecents?.(); }); };
        el.querySelector('[data-m="fav"]').onclick = async () => {
          api.close();
          for (const d of docs) { d.fav = !allFav; await db.put('docs', d); }
          toast(allFav ? 'Aus Favoriten entfernt' : 'Zu Favoriten hinzugefügt'); endSel(); ctx.renderRecents?.();
        };
      },
    });
  }
}

function newFolderSheet() {
  sheet({
    title: 'Ordner erstellen',
    html: `<div class="fl-new">
      <button data-t="normal"><span class="fl-ic">${icon('folder')}</span><b>Ordner</b><small>Für beliebige Dokumente</small></button>
      <button data-t="id"><span class="fl-ic id">${icon('idFolder')}</span><b>ID-Ordner</b><small>Ausweis, Führerschein, Reisepass, Karten</small></button>
    </div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
        api.close();
        const f = await createFolder(b.dataset.t);
        if (f) { toast(`„${f.name}“ erstellt`); openFolder(f.id); }
      });
    },
  });
}

function addIdSheet(folder) {
  sheet({
    title: 'Weitere ID-Karten hinzufügen',
    html: `<div class="menu">${ID_CATS.map(c => `<button class="row" data-cat="${c.id}"><span class="row-ic ${c.c}">${icon(c.icon)}</span><span class="row-main"><span class="row-title">${c.label}</span>${c.sub ? `<span class="row-sub">${c.sub}</span>` : ''}</span>${icon('chevronRight')}</button>`).join('')}</div>`,
    onMount(el, api) { el.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { api.close(); ctx.captureId(folder, idCat(b.dataset.cat)); }); },
  });
}
function catAdd(folder, cat) { ctx.captureId(folder, cat); }

function folderMenu(f) {
  sheet({
    title: f.name,
    html: `<div class="menu">
      <button class="row" data-a="open"><span class="row-ic c-blue">${icon('folder')}</span><span class="row-main"><span class="row-title">Öffnen</span></span></button>
      <button class="row" data-a="rename"><span class="row-ic c-gray">${icon('rename')}</span><span class="row-main"><span class="row-title">Umbenennen</span></span></button>
      <button class="row" data-a="color"><span class="row-ic c-orange">${icon('tag')}</span><span class="row-main"><span class="row-title">Farbe</span></span>${f.color ? `<i class="ff-dot" style="background:${tagC(f.color)}"></i>` : ''}</button>
      <button class="row" data-a="del"><span class="row-ic c-red">${icon('trash')}</span><span class="row-main"><span class="row-title" style="color:var(--danger)">Ordner löschen</span><span class="row-sub">Die Dokumente bleiben erhalten</span></span></button>
    </div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        api.close();
        const a = b.dataset.a;
        if (a === 'open') return openFolder(f.id);
        if (a === 'color') return folderColorSheet(f);
        if (a === 'rename') {
          const n = await promptDlg('Ordner umbenennen', f.name);
          if (n) { f.name = n.trim(); await db.put('assets', f); renderFiles(); }
        }
        if (a === 'del' && await confirmDlg('Ordner löschen?', `„${f.name}“ wird entfernt. Die Dokumente darin bleiben erhalten und erscheinen unter „Alle“.`, 'Ordner löschen')) {
          for (const d of await db.all('docs')) if (d.folder === f.id) { delete d.folder; delete d.idCat; await db.put('docs', d); }
          await db.del('assets', f.id);
          if (cur === f.id) { cur = null; curCat = null; }
          toast('Ordner gelöscht'); renderFiles();
        }
      });
    },
  });
}

// Dokument in einen Ordner verschieben (bei ID-Ordnern zusätzlich die Art wählen)
export async function moveDocSheet(d, onDone) {
  const many = Array.isArray(d) ? d : [d];
  if (Array.isArray(d)) d = many.length === 1 ? many[0] : { folder: many.every(x => x.folder === many[0].folder) ? many[0].folder : '?' };
  const fs = await folders();
  sheet({
    title: 'In Ordner verschieben',
    html: `<div class="menu">
      <button class="row" data-f=""><span class="row-ic c-gray">${icon('file')}</span><span class="row-main"><span class="row-title">Ohne Ordner</span></span>${!d.folder ? icon('check') : ''}</button>
      ${fs.map(f => `<button class="row" data-f="${f.id}"><span class="row-ic ${f.type === 'id' ? 'c-teal' : 'c-green'}">${icon(f.type === 'id' ? 'idFolder' : 'folder')}</span><span class="row-main"><span class="row-title">${esc(f.name)}</span></span>${d.folder === f.id ? icon('check') : ''}</button>`).join('')}
      <button class="row" data-new><span class="row-ic c-green">${icon('folderPlus')}</span><span class="row-main"><span class="row-title">Neuer Ordner …</span></span></button>
    </div>`,
    onMount(el, api) {
      const put = async (folderId, cat) => {
        for (const x of many) {
          if (folderId) x.folder = folderId; else delete x.folder;
          if (cat) x.idCat = cat; else delete x.idCat;
          await db.put('docs', x);
        }
        haptic();
        toast(folderId ? 'Verschoben' : 'Aus dem Ordner genommen');
        onDone?.(); renderFiles();
      };
      el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
        api.close();
        const f = fs.find(x => x.id === b.dataset.f);
        if (!f || f.type !== 'id') return put(b.dataset.f, null);
        sheet({
          title: 'Art des Ausweises',
          html: `<div class="menu">${ID_CATS.map(c => `<button class="row" data-cat="${c.id}"><span class="row-ic ${c.c}">${icon(c.icon)}</span><span class="row-main"><span class="row-title">${c.label}</span></span></button>`).join('')}</div>`,
          onMount(el2, api2) { el2.querySelectorAll('[data-cat]').forEach(x => x.onclick = () => { api2.close(); put(f.id, x.dataset.cat); }); },
        });
      });
      el.querySelector('[data-new]').onclick = async () => { api.close(); const f = await createFolder('normal'); if (f) put(f.id, null); };
    },
  });
}

// ---------- Farb-Tags ----------
/** Tags für ein oder mehrere Dokumente setzen (Mehrfachauswahl: an = alle haben den Tag) */
export function tagSheet(docs, onDone) {
  docs = Array.isArray(docs) ? docs : [docs];
  const state = t => { const n = docs.filter(d => d.tags?.includes(t)).length; return n === docs.length ? 'on' : n ? 'some' : ''; };
  sheet({
    title: docs.length === 1 ? 'Farb-Tags' : `Farb-Tags für ${docs.length} Dateien`,
    html: `<div class="tg-grid" data-grid></div>
      <p class="tg-note">Tags erscheinen als Punkte neben dem Dateinamen. Unter „Dateien“ kannst du oben danach filtern.</p>
      <div class="btn-row"><button class="btn" data-clear>${icon('x')} Alle entfernen</button><button class="btn primary" data-ok>${icon('check')} Fertig</button></div>`,
    onMount(el, api) {
      const grid = el.querySelector('[data-grid]');
      const render = () => {
        grid.innerHTML = TAGS.map(t => `<button class="tg-b ${state(t.id)}" data-t="${t.id}" style="--tc:${t.c}"><i>${icon('check')}</i><span>${t.label}</span></button>`).join('');
        grid.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
          const t = b.dataset.t, add = state(t) !== 'on'; haptic();
          for (const d of docs) {
            const set = new Set(d.tags || []); add ? set.add(t) : set.delete(t);
            d.tags = TAGS.map(x => x.id).filter(x => set.has(x));
            if (!d.tags.length) delete d.tags;
            await db.put('docs', d);
          }
          render(); renderFiles();
        });
      };
      el.querySelector('[data-clear]').onclick = async () => { for (const d of docs) if (d.tags) { delete d.tags; await db.put('docs', d); } haptic(); render(); renderFiles(); };
      el.querySelector('[data-ok]').onclick = () => api.close();
      render();
    },
    onClose: () => onDone?.(),
  });
}

function folderColorSheet(f) {
  sheet({
    title: `Farbe für „${f.name}“`,
    html: `<div class="tg-grid">${TAGS.map(t => `<button class="tg-b ${f.color === t.id ? 'on' : ''}" data-t="${t.id}" style="--tc:${t.c}"><i>${icon('check')}</i><span>${t.label}</span></button>`).join('')}
      <button class="tg-b none ${!f.color ? 'on' : ''}" data-t="" style="--tc:var(--text3)"><i>${icon('check')}</i><span>Keine</span></button></div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
        haptic(); if (b.dataset.t) f.color = b.dataset.t; else delete f.color;
        await db.put('assets', f); api.close(); renderFiles();
      });
    },
  });
}
