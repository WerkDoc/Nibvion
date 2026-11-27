// ================= Dateien: Ordner & ID-Ordner =================
// Ordner liegen im Store „assets“ ({ kind: 'folder', type: 'normal' | 'id' }), Dokumente merken
// sich ihren Ordner in meta.folder (bei ID-Ordnern zusätzlich meta.idCat). Alles bleibt lokal.
import { db, uid } from './db.js';
import { icon } from './icons.js';
import { sheet, toast, busy, haptic, esc, fmtDate, fmtSize, promptDlg, confirmDlg } from './ui.js';
import { isDeleted, moveToTrash, TRASH_DAYS } from './trash.js';
import { shareBytes, downloadBytes } from './editor.js';
import { visibleDocs, isLockedFolder, isOpenFolder, unlockFolder, leftFolder, lockSheet, onLockChange, refreshLocks } from './lock.js';
import { springFrames, reducedMotion } from './fx.js';

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
// Dateien aus gesperrten (nicht entsperrten) Ordnern bleiben verborgen
async function liveDocs() { return visibleDocs((await db.all('docs')).filter(d => !isDeleted(d))); }

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

export function initFiles(c) {
  ctx = c;
  refreshLocks().catch(() => {});
  onLockChange(() => { if (document.body.dataset.tab === 'files') renderFiles(); ctx.renderRecents?.(); ctx.onLock?.(); });
}
/** Tab „Dateien“ verlassen → offenen gesperrten Ordner wieder sperren */
export function leaveFiles() { if (cur) leftFolder(cur); }

export function openFolder(id, cat = null) { cur = id; curCat = cat; renderFiles(); }

export async function renderFiles() {
  const list = $('files-list'), head = $('files-head');
  if (!list) return;
  const [fs, docs] = await Promise.all([folders(), liveDocs()]);
  let folder = cur && fs.find(f => f.id === cur);
  if (cur && (!folder || !isOpenFolder(cur))) { cur = null; curCat = null; folder = null; sel = null; }
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
    head.querySelector('[data-back]').onclick = () => { haptic(); filt = null; if (curCat) curCat = null; else { const was = cur; cur = null; leftFolder(was); } renderFiles(); };
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
  const lk = isLockedFolder(f.id), shut = lk && !isOpenFolder(f.id);
  return `<div class="doc-row fl-row${sel ? ' off' : ''}${lk ? ' locked' : ''}${shut ? ' shut' : ''}" data-f="${f.id}" style="animation-delay:${Math.min(i, 8) * 40}ms">
    <span class="fl-ic ${f.type === 'id' ? 'id' : ''}" ${f.color && tagC(f.color) ? `style="--fc:${tagC(f.color)}"` : ''}>${icon(f.type === 'id' ? 'idFolder' : 'folder')}${lk ? `<i class="fl-lock">${icon(shut ? 'lock' : 'unlock')}</i>` : ''}</span>
    <button class="doc-info" data-open><div class="doc-name">${esc(f.name)}</div><div class="doc-meta">${f.type === 'id' ? 'ID-Ordner · ' : ''}${shut ? 'Gesperrt' : `${n} ${n === 1 ? 'Dokument' : 'Dokumente'}${lk ? ' · entsperrt' : ''}`}</div></button>
    <button class="doc-more" data-fmore aria-label="Mehr">${icon('more')}</button></div>`;
}
function bindFolderRows(list, fs) {
  list.querySelectorAll('[data-f]').forEach(r => {
    const f = fs.find(x => x.id === r.dataset.f); if (!f) return;
    // Gesperrt: Face ID / PIN direkt aus dem Tipp heraus starten
    const go = () => { haptic(); filt = null; if (isOpenFolder(f.id)) return openFolder(f.id); unlockFolder(f).then(ok => ok && openFolder(f.id)); };
    r.querySelector('[data-open]').onclick = go;
    r.querySelector('.fl-ic').onclick = go;
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
export function endSel() { sel = null; document.body.classList.remove('selecting'); renderFiles(); }
export const selecting = () => !!sel;
function toggle(id, row) {
  sel.has(id) ? sel.delete(id) : sel.add(id); haptic();
  row.classList.toggle('sel-on', sel.has(id));
  const h = $('files-head'); h.innerHTML = selHead(); bindHead(h);
}
// Schwebende Aktionsleiste: fährt mit Feder hoch, sobald etwas ausgewählt ist
const BAR = [
  ['merge', 'merge', 'Zusammen&shy;führen'], ['move', 'folderMove', 'Verschieben'], ['tag', 'tag', 'Farb-Tag'],
  ['compress', 'compress', 'Kompri&shy;mieren'], ['zip', 'archive', 'ZIP'], ['del', 'trash', 'Löschen'], ['more', 'more', 'Mehr'],
];
let barShown = false;
function paintBar() {
  let bar = document.getElementById('sel-bar');
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'sel-bar'; bar.className = 'sel-bar';
    bar.innerHTML = `<div class="sb-info" data-info></div><div class="sb-btns">${BAR.map(([a, ic, l]) => `<button data-sa="${a}"${a === 'del' ? ' class="danger"' : ''}>${icon(ic)}<span>${l}</span></button>`).join('')}</div>`;
    document.body.appendChild(bar);
    bar.querySelectorAll('[data-sa]').forEach(b => b.onclick = () => selAction(b.dataset.sa));
  }
  const n = sel?.size || 0, show = !!sel && n > 0;
  if (show) {
    bar.querySelectorAll('[data-sa]').forEach(b => { b.disabled = b.dataset.sa === 'merge' ? n < 2 : false; });
    const docs = shown.filter(d => sel.has(d.id));
    const size = docs.reduce((a, d) => a + (d.size || 0), 0);
    bar.querySelector('[data-info]').textContent = `${n} ${n === 1 ? 'PDF' : 'PDFs'} · ${fmtSize(size)}${n < 2 ? ' · Zusammenführen ab 2' : ''}`;
  }
  if (show === barShown) return;
  barShown = show;
  bar.classList.toggle('on', show);
  // Einfahren mit iOS-Feder (WAAPI), Ausfahren schnell
  if (show && !reducedMotion() && bar.animate) {
    const sp = springFrames({ stiffness: 380, damping: 24 }, v => ({ transform: `translate3d(0,${((1 - v) * 130).toFixed(2)}%,0) scale(${(0.94 + 0.06 * v).toFixed(4)})`, opacity: Math.min(1, v * 2.2) }), 40);
    bar.animate(sp.frames, { duration: sp.ms });
    bar.querySelectorAll('[data-sa]').forEach((b, i) => b.animate([{ transform: 'translate3d(0,14px,0) scale(.8)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, delay: 60 + i * 28, easing: 'cubic-bezier(.3,1.4,.5,1)', fill: 'backwards' }));
  }
}
async function selDocs() {
  // Reihenfolge = Auswahl-Reihenfolge (wichtig fürs Zusammenführen)
  const all = await liveDocs();
  return [...sel].map(id => all.find(x => x.id === id)).filter(Boolean);
}
const pdfName = d => /\.pdf$/i.test(d.name) ? d.name : d.name + '.pdf';
async function selAction(a) {
  if (!sel?.size) return;
  haptic();
  const docs = await selDocs();
  const done = () => { endSel(); ctx.renderRecents?.(); };
  if (a === 'merge') { if (docs.length < 2) return toast('Bitte mindestens 2 Dateien wählen', true); return ctx.merge(docs.map(d => d.id)); }
  if (a === 'move') return moveDocSheet(docs, done);
  if (a === 'tag') return tagSheet(docs, done);
  if (a === 'compress') return compressMany(docs, done);
  if (a === 'zip') return zipMany(docs);
  if (a === 'del') {
    if (!await confirmDlg(`${docs.length} ${docs.length === 1 ? 'Datei' : 'Dateien'} löschen?`, `Sie kommen in den Papierkorb und können ${TRASH_DAYS} Tage lang wiederhergestellt werden.`, 'In den Papierkorb')) return;
    await moveToTrash(docs.map(d => d.id)); toast('In den Papierkorb verschoben'); done(); return;
  }
  if (a === 'more') {
    const allFav = docs.every(d => d.fav);
    sheet({
      title: `${docs.length} ausgewählt`,
      html: `<div class="menu"><button class="row" data-m="share"><span class="row-ic c-blue">${icon('share')}</span><span class="row-main"><span class="row-title">Als einzelne PDFs teilen</span></span></button>
        <button class="row" data-m="fav"><span class="row-ic c-red">${icon(allFav ? 'heartFill' : 'heart')}</span><span class="row-main"><span class="row-title">${allFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}</span></span></button></div>`,
      onMount(el, api) {
        el.querySelector('[data-m="share"]').onclick = () => { api.close(); shareMany(docs); };
        el.querySelector('[data-m="fav"]').onclick = async () => {
          api.close();
          for (const d of docs) { d.fav = !allFav; await db.put('docs', d); }
          toast(allFav ? 'Aus Favoriten entfernt' : 'Zu Favoriten hinzugefügt'); done();
        };
      },
    });
  }
}
async function shareMany(docs) {
  busy(true, 'Wird vorbereitet …');
  try {
    const files = [];
    for (const d of docs) files.push(new File([await ctx.docBytes(d)], pdfName(d), { type: 'application/pdf' }));
    busy(false);
    if (files.length > 1 && navigator.canShare?.({ files })) { try { await navigator.share({ files }); } catch {} }
    else for (const f of files) await shareBytes(new Uint8Array(await f.arrayBuffer()), f.name);
  } catch (e) { console.error(e); busy(false); toast('Teilen fehlgeschlagen', true); }
}

// ---------- Stapel: Komprimieren ----------
function compressMany(docs, onDone) {
  let level = 'standard', copy = false, running = false;
  sheet({
    title: `${docs.length} ${docs.length === 1 ? 'PDF' : 'PDFs'} komprimieren`,
    html: `<div class="seg bt-seg" data-lv><button data-v="leicht">Leicht</button><button data-v="standard">Standard</button><button data-v="stark">Stark</button></div>
      <div class="bt-list">${docs.map((d, i) => `<div class="bt-it" data-i="${i}"><span class="doc-thumb" style="width:30px;height:40px;background-image:url('${d.thumb || ''}')"></span><div><b>${esc(d.name)}</b><small data-m>${fmtSize(d.size || 0)}</small></div><span class="wf-state"></span></div>`).join('')}</div>
      <div class="wf-prog"><div class="wf-bar"><i data-bar></i></div><span data-pct>0 %</span></div>
      <div class="row" style="padding:6px 2px 2px;border:0"><span class="row-main"><span class="row-title">Als Kopien speichern</span><span class="row-sub" style="display:block">Aus: Originale werden ersetzt</span></span>
        <div class="seg" data-copy><button data-v="1">An</button><button data-v="0">Aus</button></div></div>
      <div class="btn-row"><button class="btn primary" data-go>${icon('compress')} Komprimieren</button></div>`,
    onMount(el, api) {
      const paint = () => {
        el.querySelectorAll('[data-lv] button').forEach(b => b.classList.toggle('on', b.dataset.v === level));
        el.querySelectorAll('[data-copy] button').forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === copy));
      };
      el.querySelectorAll('[data-lv] button').forEach(b => b.onclick = () => { if (!running) { level = b.dataset.v; haptic(); paint(); } });
      el.querySelectorAll('[data-copy] button').forEach(b => b.onclick = () => { if (!running) { copy = b.dataset.v === '1'; haptic(); paint(); } });
      const bar = el.querySelector('[data-bar]'), pct = el.querySelector('[data-pct]');
      const setP = p => { bar.style.transform = `scaleX(${p.toFixed(4)})`; pct.textContent = Math.round(p * 100) + ' %'; };
      const go = el.querySelector('[data-go]');
      go.onclick = async () => {
        if (running) return;
        if (go.dataset.done) return api.close();
        running = true; go.disabled = true; go.innerHTML = `<span class="wf-spin"></span> Läuft …`;
        const { compressPdf } = await import('./tools.js');
        let before = 0, after = 0, n = 0;
        for (let i = 0; i < docs.length; i++) {
          const d = docs[i], row = el.querySelector(`.bt-it[data-i="${i}"]`), m = row.querySelector('[data-m]');
          row.classList.add('run'); row.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
          try {
            const b = new Uint8Array(await ctx.docBytes(d));
            const r = await compressPdf(b, level, (k, t) => { m.textContent = `Bild ${k} von ${t} …`; setP((i + k / Math.max(1, t)) / docs.length); });
            const out = r.bytes;
            before += b.byteLength;
            if (out.byteLength < b.byteLength * 0.97) { await ctx.storeResult(d, out, 'komprimiert', copy); after += out.byteLength; n++; m.textContent = `${fmtSize(b.byteLength)} → ${fmtSize(out.byteLength)}`; }
            else { after += b.byteLength; m.textContent = 'Schon gut komprimiert'; }
            row.classList.add('ok');
          } catch (e) { console.error(e); row.classList.add('err'); m.textContent = 'Fehlgeschlagen'; }
          row.classList.remove('run'); setP((i + 1) / docs.length);
        }
        running = false; go.disabled = false; go.dataset.done = '1'; go.innerHTML = `${icon('check')} Fertig`; haptic();
        toast(n ? `${n} ${n === 1 ? 'PDF' : 'PDFs'} verkleinert · −${fmtSize(Math.max(0, before - after))}` : 'Alle PDFs waren schon gut komprimiert');
      };
      paint();
    },
    onClose: () => { if (!running) onDone?.(); },
  });
}

// ---------- Stapel: ZIP ----------
async function zipMany(docs) {
  busy(true, 'ZIP wird gepackt …');
  let bytes, name;
  try {
    const { loadLib } = await import('./convert.js');
    await loadLib('jszip.min.js');
    const zip = new window.JSZip(), used = new Set();
    for (let i = 0; i < docs.length; i++) {
      busy(true, `PDF ${i + 1} von ${docs.length} wird gepackt …`);
      let n = pdfName(docs[i]).replace(/[\\/:*?"<>|]/g, '_'), k = 2;
      while (used.has(n.toLowerCase())) n = pdfName(docs[i]).replace(/\.pdf$/i, '') + ` (${k++}).pdf`;
      used.add(n.toLowerCase());
      zip.file(n, await ctx.docBytes(docs[i]), { date: new Date(docs[i].updated || Date.now()) });
    }
    // PDFs sind schon komprimiert → nur leicht packen (schnell)
    bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } }, m => busy(true, `ZIP wird erstellt … ${Math.round(m.percent)} %`));
    const d = new Date();
    name = `Nibvion ${docs.length} PDFs ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}.zip`;
  } catch (e) { console.error(e); busy(false); return toast('ZIP konnte nicht erstellt werden', true); }
  busy(false);
  // Teilen erst nach einem Tipp (iOS verlangt eine Nutzeraktion)
  sheet({
    title: 'ZIP ist fertig',
    html: `<div class="zip-card"><span class="zip-ic">${icon('archive')}</span><div><b>${esc(name)}</b><span>${docs.length} PDFs · ${fmtSize(bytes.byteLength)}</span></div></div>
      <div class="btn-row"><button class="btn" data-dl>${icon('download')} Sichern</button><button class="btn primary" data-sh>${icon('share')} Teilen</button></div>`,
    onMount(el, api) {
      el.querySelector('[data-sh]').onclick = () => { api.close(); shareBytes(bytes, name, 'application/zip'); };
      el.querySelector('[data-dl]').onclick = () => { api.close(); downloadBytes(bytes, name, 'application/zip'); };
    },
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
      <button class="row" data-a="color"><span class="row-ic c-orange">${icon('tag')}</span><span class="row-main"><span class="row-title">Farbe</span></span>${f.color ? `<i class="ff-dot" style="background:${tagC(f.color)}"></i>` : ''}</button>
      <button class="row" data-a="lock"><span class="row-ic c-violet">${icon('lock')}</span><span class="row-main"><span class="row-title">${f.lock?.hash ? 'Sperre verwalten' : 'Ordner sperren'}</span><span class="row-sub">${f.lock?.hash ? 'PIN, Face ID, wieder sperren, entfernen' : 'Mit PIN oder Face ID / Touch ID'}</span></span>${f.lock?.hash ? `<span class="row-end lk-on">${icon('lock')}</span>` : ''}</button>
      <button class="row" data-a="del"><span class="row-ic c-red">${icon('trash')}</span><span class="row-main"><span class="row-title" style="color:var(--danger)">Ordner löschen</span><span class="row-sub">Die Dokumente bleiben erhalten</span></span></button>
    </div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        api.close();
        const a = b.dataset.a;
        if (a === 'open') return isOpenFolder(f.id) ? openFolder(f.id) : unlockFolder(f).then(ok => ok && openFolder(f.id));
        if (a === 'lock') return lockSheet(f, () => renderFiles());
        // Löschen gibt die Dateien frei → bei gesperrten Ordnern erst entsperren
        if (a === 'del' && !isOpenFolder(f.id) && !(await unlockFolder(f))) return;
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
