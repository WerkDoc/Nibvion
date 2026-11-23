// ================= Dateien: Ordner & ID-Ordner =================
// Ordner liegen im Store „assets“ ({ kind: 'folder', type: 'normal' | 'id' }), Dokumente merken
// sich ihren Ordner in meta.folder (bei ID-Ordnern zusätzlich meta.idCat). Alles bleibt lokal.
import { db, uid } from './db.js';
import { icon } from './icons.js';
import { sheet, toast, haptic, esc, fmtDate, fmtSize, promptDlg, confirmDlg } from './ui.js';
import { isDeleted } from './trash.js';

export const ID_CATS = [
  { id: 'idcard', label: 'ID-Karte', sub: 'Personalausweis', icon: 'user', c: 'c-blue', sides: 2 },
  { id: 'driver', label: 'Führerschein', icon: 'wheel', c: 'c-orange', sides: 2 },
  { id: 'passport', label: 'Reisepass', sub: 'Datenseite', icon: 'globe', c: 'c-violet', sides: 1 },
  { id: 'bank', label: 'Bankkarte', icon: 'card', c: 'c-green', sides: 2 },
  { id: 'cert', label: 'Zertifikat', sub: 'Urkunden, Zeugnisse (A4)', icon: 'award', c: 'c-amber', sides: 0 },
  { id: 'other', label: 'Andere Ausweise', sub: 'Mitglieds-, Versichertenkarte …', icon: 'badge', c: 'c-gray', sides: 2 },
];
export const idCat = id => ID_CATS.find(c => c.id === id) || ID_CATS[ID_CATS.length - 1];

let ctx = {};
let cur = null;        // offener Ordner (id) oder null = Übersicht
let curCat = null;     // offene Kategorie im ID-Ordner
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
    head.innerHTML = `<h1 class="page-title">Dateien</h1><button class="icon-btn" data-action="search" aria-label="Suchen">${icon('search')}</button>`;
    const ids = new Set(fs.map(f => f.id));
    const loose = sortDocs(docs.filter(d => !d.folder || !ids.has(d.folder)));
    const count = id => docs.filter(d => d.folder === id).length;
    list.innerHTML = `
      <div class="fl-cards">
        <button class="fl-card" data-c="docs"><span class="qt-ic c-blue">${icon('filePlus')}</span><span>Dokumente importieren</span></button>
        <button class="fl-card" data-c="imgs"><span class="qt-ic c-teal">${icon('images')}</span><span>Bilder importieren</span></button>
        <button class="fl-card" data-c="new"><span class="qt-ic c-green">${icon('folderPlus')}</span><span>Ordner erstellen</span></button>
      </div>
      <div class="section-row"><h2 class="section-title">Alle <span class="fl-count">(${docs.length})</span></h2></div>
      <div class="recent-list">
        ${fs.map((f, i) => `<div class="doc-row fl-row" data-f="${f.id}" style="animation-delay:${Math.min(i, 8) * 40}ms">
          <span class="fl-ic ${f.type === 'id' ? 'id' : ''}">${icon(f.type === 'id' ? 'idFolder' : 'folder')}</span>
          <button class="doc-info" data-open><div class="doc-name">${esc(f.name)}</div><div class="doc-meta">${f.type === 'id' ? 'ID-Ordner · ' : ''}${count(f.id)} ${count(f.id) === 1 ? 'Dokument' : 'Dokumente'}</div></button>
          <button class="doc-more" data-fmore aria-label="Mehr">${icon('more')}</button></div>`).join('')}
        ${docRows(loose, fs.length)}
      </div>
      ${!fs.length && !loose.length ? `<div class="empty">${icon('folder')}<b>Noch nichts hier</b>Importiere Dokumente oder erstelle einen Ordner.</div>` : ''}
      <div class="bottom-space"></div>`;
    list.querySelector('[data-c="docs"]').onclick = () => ctx.importDocs();
    list.querySelector('[data-c="imgs"]').onclick = () => ctx.importImages();
    list.querySelector('[data-c="new"]').onclick = () => newFolderSheet();
    list.querySelectorAll('[data-f]').forEach(r => {
      const f = fs.find(x => x.id === r.dataset.f);
      r.querySelector('[data-open]').onclick = () => { haptic(); openFolder(f.id); };
      r.querySelector('.fl-ic').onclick = () => { haptic(); openFolder(f.id); };
      r.querySelector('[data-fmore]').onclick = () => folderMenu(f);
    });
    bindDocRows(list, loose);
    return;
  }

  // ----- in einem Ordner -----
  const inF = docs.filter(d => d.folder === folder.id);
  const cat = folder.type === 'id' && curCat ? idCat(curCat) : null;
  head.innerHTML = `<button class="icon-btn" data-back aria-label="Zurück">${icon('chevronLeft')}</button>
    <h1 class="page-title fl-title">${esc(cat ? cat.label : folder.name)}</h1>
    <button class="icon-btn" data-fm aria-label="Mehr">${icon('more')}</button>`;
  head.querySelector('[data-back]').onclick = () => { haptic(); if (curCat) curCat = null; else cur = null; renderFiles(); };
  head.querySelector('[data-fm]').onclick = () => cat ? catAdd(folder, cat) : folderMenu(folder);

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

  const shown = sortDocs(cat ? inF.filter(d => (d.idCat || 'other') === cat.id) : inF);
  list.innerHTML = `
    <div class="fl-actions">
      ${cat ? `<button class="btn primary" data-add>${icon('plus')} ${esc(cat.label)} hinzufügen</button>`
      : `<button class="btn" data-scan>${icon('scan')} Scannen</button><button class="btn" data-imp>${icon('filePlus')} Importieren</button>`}
    </div>
    <div class="recent-list">${docRows(shown, 0)}</div>
    ${!shown.length ? `<div class="empty">${icon('folder')}<b>Ordner ist leer</b>Scanne oder importiere Dokumente – sie landen direkt hier.</div>` : ''}
    <div class="bottom-space"></div>`;
  list.querySelector('[data-scan]')?.addEventListener('click', () => ctx.scan());
  list.querySelector('[data-imp]')?.addEventListener('click', () => ctx.importDocs());
  list.querySelector('[data-add]')?.addEventListener('click', () => ctx.captureId(folder, cat));
  bindDocRows(list, shown);
}

function docRows(docs, offset) {
  return docs.map((d, i) => `
    <div class="doc-row" data-id="${d.id}" style="animation-delay:${Math.min(i + offset, 8) * 40}ms">
      <div class="doc-thumb" style="background-image:url('${d.thumb || ''}')"></div>
      <button class="doc-info" data-open>
        <div class="doc-name">${d.fav ? `<span class="doc-fav">${icon('heartFill')}</span>` : ''}${esc(d.name)}</div>
        <div class="doc-meta">${fmtDate(d.updated)} · ${fmtSize(d.size || 0)} · ${d.pages || 1} S.</div>
      </button>
      <button class="doc-more" data-more aria-label="Mehr">${icon('more')}</button>
    </div>`).join('');
}
function bindDocRows(list, docs) {
  list.querySelectorAll('.doc-row[data-id]').forEach(r => {
    const d = docs.find(x => x.id === r.dataset.id); if (!d) return;
    r.querySelector('[data-open]').onclick = () => ctx.openDoc(d.id);
    r.querySelector('.doc-thumb').onclick = () => ctx.openDoc(d.id);
    r.querySelector('[data-more]').onclick = () => ctx.docMenu(d);
  });
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
      <button class="row" data-a="del"><span class="row-ic c-red">${icon('trash')}</span><span class="row-main"><span class="row-title" style="color:var(--danger)">Ordner löschen</span><span class="row-sub">Die Dokumente bleiben erhalten</span></span></button>
    </div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        api.close();
        const a = b.dataset.a;
        if (a === 'open') return openFolder(f.id);
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
        if (folderId) d.folder = folderId; else delete d.folder;
        if (cat) d.idCat = cat; else delete d.idCat;
        await db.put('docs', d); haptic();
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
