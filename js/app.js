// ================= Nibvion App =================
import { db, uid } from './db.js';
import { icon, hydrateIcons } from './icons.js';
import { toast, busy, sheet, confirmDlg, promptDlg, esc, fmtSize, fmtDate, pickFiles, today, haptic } from './ui.js';
import { loadPdf, closePdf, renderThumb, imagesToPdf, mergePdfs, blankPdf, normalizeImage, flatten, pageInfos } from './pdfcore.js';
import { initEditor, openEditor, shareBytes, downloadBytes } from './editor.js';
import { signatureSheet, stampSheet } from './assets.js';
import { settings, applyTheme } from './settings.js';

export const VERSION = '1.2.1';
const $ = id => document.getElementById(id);

applyTheme();

// ======================= Bibliothek =======================
async function saveNewDoc(bytes, name) {
  const data = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const head = new TextDecoder().decode(new Uint8Array(data.slice(0, 1024)));
  if (!head.includes('%PDF')) throw new Error('Keine PDF-Datei');
  const pdf = await loadPdf(data);
  let thumb = '';
  try { thumb = await renderThumb(pdf, 1); } catch {}
  const id = uid();
  const meta = { id, name: /\.pdf$/i.test(name) ? name : name + '.pdf', size: data.byteLength, pages: pdf.numPages, thumb, objects: [], created: Date.now(), updated: Date.now(), opened: Date.now() };
  closePdf(pdf);
  await db.put('files', { id, data });
  await db.put('docs', meta);
  return id;
}

async function importPdfs(mode) {
  const files = await pickFiles('file-pdf');
  if (!files.length) return;
  busy(true, files.length > 1 ? `${files.length} PDFs werden importiert …` : 'PDF wird importiert …');
  let first = null, fails = 0;
  for (const f of files) {
    try { const id = await saveNewDoc(await f.arrayBuffer(), f.name); first ??= id; }
    catch (e) { console.warn(e); fails++; }
  }
  busy(false);
  if (fails) toast(fails === files.length ? 'Datei konnte nicht gelesen werden' : `${fails} Datei(en) übersprungen`, true);
  await renderRecents();
  if (first) openDoc(first, mode || 'view');
}

function openDoc(id, mode = 'view') { openEditor(id, mode, renderRecents); }

// ======================= Start =======================
const QUICK = [
  { id: 'edit', label: 'PDF bearbeiten', icon: 'textEdit', c: 'c-red' },
  { id: 'comment', label: 'Kommentieren', icon: 'comment', c: 'c-amber' },
  { id: 'draw', label: 'Zeichnen', icon: 'draw', c: 'c-violet' },
  { id: 'sign', label: 'Unter­schreiben', icon: 'sign', c: 'c-green' },
  { id: 'img2pdf', label: 'Bilder → PDF', icon: 'images', c: 'c-blue' },
  { id: 'all', label: 'Alle Werkzeuge', icon: 'grid', c: 'c-gray' },
];

function renderQuick() {
  $('quick-grid').innerHTML = QUICK.map((q, i) => `<button class="qt" data-q="${q.id}" style="animation-delay:${80 + i * 45}ms"><span class="qt-ic ${q.c}">${icon(q.icon)}</span><span>${q.label}</span></button>`).join('');
  $('quick-grid').querySelectorAll('[data-q]').forEach(b => b.onclick = () => runTool(b.dataset.q));
}

async function allDocs() {
  const docs = await db.all('docs');
  return settings.get('sort') === 'name'
    ? docs.sort((a, b) => a.name.localeCompare(b.name, 'de'))
    : docs.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

async function renderRecents() {
  const docs = await allDocs();
  $('btn-sort').textContent = settings.get('sort') === 'name' ? 'Name A–Z' : 'Neueste';
  const list = $('recent-list');
  if (!docs.length) {
    list.innerHTML = `<div class="empty">${icon('file')}<b>Noch keine PDFs</b>Tippe auf „PDF öffnen“ oder das <b style="display:inline;color:var(--accent)">+</b>, um loszulegen.</div>`;
    return;
  }
  list.innerHTML = docs.map((d, i) => `
    <div class="doc-row" data-id="${d.id}" style="animation-delay:${Math.min(i, 8) * 40}ms">
      <div class="doc-thumb" style="background-image:url('${d.thumb || ''}')"></div>
      <button class="doc-info" data-open>
        <div class="doc-name">${esc(d.name)}</div>
        <div class="doc-meta">${fmtDate(d.updated)} · ${fmtSize(d.size || 0)} · ${d.pages || 1} S.${d.objects?.length ? '<span class="doc-badge">bearbeitet</span>' : ''}</div>
      </button>
      <button class="doc-more" data-more aria-label="Mehr">${icon('more')}</button>
    </div>`).join('');
  list.querySelectorAll('.doc-row').forEach(r => {
    const id = r.dataset.id;
    r.querySelector('[data-open]').onclick = () => openDoc(id);
    r.querySelector('.doc-thumb').onclick = () => openDoc(id);
    r.querySelector('[data-more]').onclick = () => docMenu(docs.find(d => d.id === id));
  });
}

function docMenu(d) {
  sheet({
    title: d.name,
    html: `<div class="menu">
      ${[['view', 'Öffnen', 'eye', 'c-blue'], ['edit', 'Bearbeiten', 'textEdit', 'c-red'], ['sign', 'Unterschreiben', 'sign', 'c-green'], ['share', 'Teilen', 'share', 'c-teal'], ['word', 'Als Word exportieren', 'word', 'c-blue'], ['rename', 'Umbenennen', 'rename', 'c-gray'], ['del', 'Löschen', 'trash', 'c-red']]
        .map(([a, l, ic, c]) => `<button class="row" data-a="${a}"><span class="row-ic ${c}">${icon(ic)}</span><span class="row-main"><span class="row-title" ${a === 'del' ? 'style="color:var(--danger)"' : ''}>${l}</span></span></button>`).join('')}
    </div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        const a = b.dataset.a; api.close();
        if (['view', 'edit', 'sign'].includes(a)) return openDoc(d.id, a);
        if (a === 'word') return exportWord(d);
        if (a === 'share') {
          if (d.objects?.length) { openDoc(d.id); return toast('Zum Teilen mit Änderungen: ⋯ → Teilen'); }
          const f = await db.get('files', d.id); return shareBytes(new Uint8Array(f.data), d.name);
        }
        if (a === 'rename') {
          const n = await promptDlg('Umbenennen', d.name.replace(/\.pdf$/i, ''));
          if (n) { d.name = n + '.pdf'; await db.put('docs', d); renderRecents(); }
        }
        if (a === 'del' && await confirmDlg('PDF löschen?', `„${d.name}“ wird von diesem Gerät gelöscht.`)) {
          await db.del('docs', d.id); await db.del('files', d.id); renderRecents(); toast('Gelöscht');
        }
      });
    },
  });
}

// Datei für ein Werkzeug wählen
async function chooseDoc(mode, title = 'Datei wählen') {
  const docs = await allDocs();
  if (!docs.length) return importPdfs(mode);
  sheet({
    title,
    html: `<div class="menu" style="margin-bottom:14px"><button class="row" data-imp><span class="row-ic c-red">${icon('filePlus')}</span><span class="row-main"><span class="row-title">Aus „Dateien“ importieren</span><span class="row-sub">iCloud, Downloads, Mail-Anhänge …</span></span>${icon('chevronRight')}</button></div>
      <div class="lbl" style="margin-top:0">Zuletzt</div>
      <div class="menu">${docs.slice(0, 12).map(d => `<button class="row" data-id="${d.id}"><span class="doc-thumb" style="width:34px;height:44px;background-image:url('${d.thumb || ''}')"></span><span class="row-main"><span class="row-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span><span class="row-sub">${fmtDate(d.updated)}</span></span></button>`).join('')}</div>`,
    onMount(el, api) {
      el.querySelector('[data-imp]').onclick = () => { api.close(); importPdfs(mode); };
      el.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { api.close(); openDoc(b.dataset.id, mode); });
    },
  });
}

// ======================= Werkzeuge =======================
const TOOL_GROUPS = [
  { title: 'Bearbeiten', items: [
    { id: 'edit', label: 'PDF bearbeiten', sub: 'Text ändern, hinzufügen, abdecken', icon: 'textEdit', c: 'c-red' },
    { id: 'comment', label: 'Kommentieren', sub: 'Markieren, unterstreichen, Notizen', icon: 'comment', c: 'c-amber' },
    { id: 'draw', label: 'Zeichnen', sub: 'Stift, Marker, Radierer', icon: 'draw', c: 'c-violet' },
    { id: 'sign', label: 'Füllen & unterschreiben', sub: 'Unterschrift, Datum, Haken, Stempel', icon: 'sign', c: 'c-green' },
    { id: 'pages', label: 'Seiten verwalten', sub: 'Drehen, sortieren, löschen', icon: 'pages', c: 'c-teal' },
  ] },
  { title: 'Erstellen', items: [
    { id: 'scan', label: 'Scannen', sub: 'Mit der Kamera zu PDF', icon: 'scan', c: 'c-violet' },
    { id: 'img2pdf', label: 'Bilder → PDF', sub: 'Fotos & Screenshots zusammenfassen', icon: 'images', c: 'c-blue' },
    { id: 'merge', label: 'PDFs zusammenfügen', sub: 'Mehrere PDFs zu einem', icon: 'merge', c: 'c-orange' },
    { id: 'blank', label: 'Leeres PDF', sub: 'A4-Seite zum Ausfüllen', icon: 'filePlus', c: 'c-gray' },
  ] },
  { title: 'Konvertieren', items: [
    { id: 'pdf2img', label: 'PDF → Bilder', sub: 'Seiten als JPG speichern', icon: 'image', c: 'c-blue' },
    { id: 'word', label: 'Word → PDF', sub: 'DOCX als PDF speichern', icon: 'word', c: 'c-blue' },
    { id: 'excel', label: 'Excel → PDF', sub: 'XLSX, XLS oder CSV als PDF', icon: 'excel', c: 'c-green' },
    { id: 'ppt', label: 'PowerPoint → PDF', icon: 'ppt', c: 'c-orange', soon: true },
    { id: 'pdf2word', label: 'PDF → Word', sub: 'Als bearbeitbare DOCX speichern', icon: 'word', c: 'c-blue' },
  ] },
  { title: 'Vorlagen', items: [
    { id: 'sigs', label: 'Meine Unterschriften', icon: 'sign', c: 'c-green' },
    { id: 'stamps', label: 'Meine Stempel', icon: 'stamp', c: 'c-red' },
  ] },
];

function renderTools() {
  $('tools-list').innerHTML = TOOL_GROUPS.map((g, gi) => `
    <div class="group-title">${g.title}</div>
    <div class="group" style="animation-delay:${gi * 60}ms">${g.items.map(t => `
      <button class="row ${t.soon ? 'disabled' : ''}" data-t="${t.id}">
        <span class="row-ic ${t.c}">${icon(t.icon)}</span>
        <span class="row-main"><span class="row-title">${t.label}</span>${t.sub ? `<span class="row-sub" style="display:block">${t.sub}</span>` : ''}</span>
        <span class="row-end">${t.soon ? '<span class="soon">Bald</span>' : icon('chevronRight')}</span>
      </button>`).join('')}</div>`).join('') + '<div class="bottom-space"></div>';
  $('tools-list').querySelectorAll('[data-t]').forEach(b => b.onclick = () => runTool(b.dataset.t));
}

function runTool(id) {
  haptic();
  switch (id) {
    case 'edit': case 'comment': case 'draw': case 'sign': return chooseDoc(id);
    case 'pages': return chooseDoc('pages', 'Seiten verwalten');
    case 'all': return switchTab('tools');
    case 'scan': return imageSheet('scan');
    case 'img2pdf': return imageSheet('images');
    case 'merge': return mergeSheet();
    case 'blank': return newBlank();
    case 'pdf2img': return pdfToImages();
    case 'word': return officeToPdf('word');
    case 'excel': return officeToPdf('excel');
    case 'pdf2word': return pdfToWordSheet();
    case 'sigs': return signatureSheet(null);
    case 'stamps': return stampSheet(null);
    default: toast('Kommt in einem der nächsten Updates');
  }
}

// ----- Scan / Bilder → PDF -----
async function imageSheet(kind) {
  const items = []; // {file}
  let filter = kind === 'scan' ? 'doc' : null;
  const add = async files => { for (const f of files) items.push({ file: f, url: URL.createObjectURL(f) }); };
  if (kind === 'images') { const fs = await pickFiles('file-img'); if (!fs.length) return; await add(fs); }
  sheet({
    title: kind === 'scan' ? 'Scannen' : 'Bilder → PDF',
    html: `
      <div class="scan-strip no-swipe" data-strip></div>
      <div class="btn-row" style="margin-top:4px">
        <button class="btn" data-cam>${icon('scan')} Kamera</button>
        <button class="btn" data-lib>${icon('images')} Fotos</button>
      </div>
      <div class="row" style="padding:16px 2px 4px;border:0"><div class="row-main"><div class="row-title">Filter</div></div>
        <div class="seg" data-f><button data-v="">Original</button><button data-v="color">Farbe</button><button data-v="doc">Dokument</button></div></div>
      <div class="btn-row"><button class="btn primary" data-ok>${icon('check')} PDF erstellen</button></div>`,
    onMount(el, api) {
      const strip = el.querySelector('[data-strip]');
      const render = () => {
        strip.innerHTML = items.length ? items.map((it, k) => `<div class="scan-item" style="background-image:url(${it.url});filter:${filter === 'doc' ? 'grayscale(1) contrast(1.45) brightness(1.12)' : filter === 'color' ? 'contrast(1.2) brightness(1.06)' : 'none'}"><button class="del" data-d="${k}">${icon('x')}</button></div>`).join('')
          : `<div class="empty" style="width:100%;padding:24px">${kind === 'scan' ? 'Fotografiere dein Dokument – mehrere Seiten möglich.' : 'Noch keine Bilder ausgewählt.'}</div>`;
        strip.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { items.splice(+b.dataset.d, 1); render(); });
        el.querySelectorAll('[data-f] button').forEach(b => b.classList.toggle('on', (b.dataset.v || null) === filter));
      };
      el.querySelector('[data-cam]').onclick = async () => { await add(await pickFiles('file-cam')); render(); };
      el.querySelector('[data-lib]').onclick = async () => { await add(await pickFiles('file-img')); render(); };
      el.querySelectorAll('[data-f] button').forEach(b => b.onclick = () => { filter = b.dataset.v || null; render(); });
      el.querySelector('[data-ok]').onclick = async () => {
        if (!items.length) return toast('Bitte zuerst Bilder hinzufügen', true);
        api.close();
        busy(true, 'PDF wird erstellt …');
        try {
          const urls = [];
          for (const it of items) urls.push((await normalizeImage(it.file, 2000, filter)).url);
          const bytes = await imagesToPdf(urls, { margin: kind === 'scan' ? 0 : 0 });
          const id = await saveNewDoc(bytes, `${kind === 'scan' ? 'Scan' : 'Bilder'} ${today()} ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }).replace(':', '-')}.pdf`);
          busy(false); await renderRecents(); toast('PDF erstellt'); openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('PDF konnte nicht erstellt werden', true); }
      };
      render();
      if (kind === 'scan') setTimeout(() => el.querySelector('[data-cam]').click(), 450);
    },
    onClose: () => items.forEach(it => setTimeout(() => URL.revokeObjectURL(it.url), 3000)),
  });
}

// ----- Zusammenfügen -----
async function mergeSheet() {
  const docs = await allDocs();
  const order = [];
  sheet({
    title: 'PDFs zusammenfügen',
    html: `<p style="color:var(--text2);margin:0 2px 12px;font-size:14px">Tippe die PDFs in der gewünschten Reihenfolge an.</p>
      <div class="menu" data-list style="margin-bottom:12px"></div>
      <div class="btn-row"><button class="btn" data-imp>${icon('filePlus')} Importieren</button><button class="btn primary" data-ok>${icon('merge')} Zusammenfügen</button></div>`,
    onMount(el, api) {
      const list = el.querySelector('[data-list]');
      const render = () => {
        list.innerHTML = docs.length ? docs.map(d => { const n = order.indexOf(d.id); return `<button class="row" data-id="${d.id}"><span class="row-ic ${n >= 0 ? 'c-orange' : 'c-gray'}" style="font-weight:800">${n >= 0 ? n + 1 : icon('file')}</span><span class="row-main"><span class="row-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span><span class="row-sub">${d.pages || 1} Seiten</span></span></button>`; }).join('')
          : `<div class="empty" style="border:0">Noch keine PDFs vorhanden.</div>`;
        list.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { const k = order.indexOf(b.dataset.id); k >= 0 ? order.splice(k, 1) : order.push(b.dataset.id); haptic(); render(); });
      };
      el.querySelector('[data-imp]').onclick = async () => {
        const files = await pickFiles('file-pdf'); if (!files.length) return;
        busy(true, 'Import …');
        for (const f of files) { try { const id = await saveNewDoc(await f.arrayBuffer(), f.name); order.push(id); } catch {} }
        docs.splice(0, docs.length, ...(await allDocs())); busy(false); render(); renderRecents();
      };
      el.querySelector('[data-ok]').onclick = async () => {
        if (order.length < 2) return toast('Bitte mindestens 2 PDFs wählen', true);
        api.close(); busy(true, 'PDFs werden zusammengefügt …');
        try {
          const list = [];
          for (const id of order) list.push((await db.get('files', id)).data);
          const out = await mergePdfs(list);
          const id = await saveNewDoc(out, `Zusammengefügt ${today()}.pdf`);
          busy(false); await renderRecents(); toast('Zusammengefügt'); openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Zusammenfügen fehlgeschlagen', true); }
      };
      render();
    },
  });
}

async function newBlank() {
  busy(true);
  try { const id = await saveNewDoc(await blankPdf(), `Neues Dokument ${today()}.pdf`); await renderRecents(); busy(false); openDoc(id, 'sign'); }
  catch { busy(false); toast('Fehler', true); }
}

// ----- PDF → Bilder -----
async function pdfToImages() {
  const docs = await allDocs();
  if (!docs.length) return toast('Importiere zuerst ein PDF', true);
  sheet({
    title: 'PDF → Bilder',
    html: `<div class="menu">${docs.slice(0, 15).map(d => `<button class="row" data-id="${d.id}"><span class="doc-thumb" style="width:34px;height:44px;background-image:url('${d.thumb || ''}')"></span><span class="row-main"><span class="row-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span><span class="row-sub">${d.pages || 1} Seiten</span></span></button>`).join('')}</div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-id]').forEach(b => b.onclick = async () => {
        api.close(); busy(true, 'Seiten werden umgewandelt …');
        try {
          const d = docs.find(x => x.id === b.dataset.id);
          const f = await db.get('files', d.id);
          const pdf = await loadPdf(f.data);
          const files = [];
          for (let i = 1; i <= pdf.numPages; i++) {
            const url = await renderThumb(pdf, i, 1600);
            const blob = await (await fetch(url)).blob();
            files.push(new File([blob], `${d.name.replace(/\.pdf$/i, '')}_Seite-${i}.jpg`, { type: 'image/jpeg' }));
          }
          closePdf(pdf); busy(false);
          if (navigator.canShare && navigator.canShare({ files })) { try { await navigator.share({ files }); } catch {} }
          else for (const fl of files) downloadBytes(await fl.arrayBuffer(), fl.name, 'image/jpeg');
        } catch (e) { console.error(e); busy(false); toast('Umwandeln fehlgeschlagen', true); }
      });
    },
  });
}

// ----- Word / Excel → PDF -----
async function officeToPdf(kind) {
  const files = await pickFiles(kind === 'word' ? 'file-word' : 'file-excel');
  if (!files.length) return;
  const f = files[0];
  const base = f.name.replace(/\.[^.]+$/, '') || (kind === 'word' ? 'Dokument' : 'Tabelle');
  busy(true, kind === 'word' ? 'Word-Dokument wird gelesen …' : 'Tabelle wird gelesen …');
  let conv, buf;
  try { [conv, buf] = await Promise.all([import('./convert.js'), f.arrayBuffer()]); }
  catch (e) { console.error(e); busy(false); return toast('Datei konnte nicht gelesen werden', true); }
  const progress = (i, n) => busy(true, n > 1 ? `Seite ${i} von ${n} wird erstellt …` : 'PDF wird erstellt …');
  const fail = e => { console.error(e); busy(false); toast(e instanceof conv.ConvertError ? e.message : 'Umwandeln fehlgeschlagen', true); };
  const finish = async bytes => {
    const id = await saveNewDoc(bytes, base + '.pdf');
    busy(false); await renderRecents(); toast('PDF erstellt'); openDoc(id);
  };
  if (kind === 'word') {
    try { await finish(await conv.wordToPdf(buf, { onProgress: progress, title: base })); } catch (e) { fail(e); }
    return;
  }
  let book;
  try { book = await conv.readWorkbook(buf); } catch (e) { return fail(e); }
  busy(false);
  excelOptions(book, base, async opts => {
    busy(true, 'PDF wird erstellt …');
    try { await finish(await conv.excelToPdf(book, { ...opts, onProgress: progress, title: base })); } catch (e) { fail(e); }
  });
}

function excelOptions(book, base, go) {
  const on = book.sheets.map(() => true);
  let orient = 'auto', grid = book.sheets.some(s => s.setup?.grid);
  sheet({
    title: 'Excel → PDF',
    html: `<p style="color:var(--text2);margin:0 2px 12px;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(base)}</p>
      ${book.sheets.length > 1 ? `<div class="lbl" style="margin-top:0">Tabellenblätter</div><div class="menu" data-sheets></div>` : ''}
      <div class="menu" style="margin-top:12px">
        <div class="row"><span class="row-ic c-blue">${icon('pages')}</span><span class="row-main"><span class="row-title">Ausrichtung</span></span>
          <div class="seg" data-o>${[['auto', 'Auto'], ['portrait', 'Hoch'], ['landscape', 'Quer']].map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</div></div>
        <div class="row"><span class="row-ic c-gray">${icon('grid')}</span><span class="row-main"><span class="row-title">Gitternetz</span></span>
          <div class="seg" data-g><button data-v="0">Aus</button><button data-v="1">An</button></div></div>
      </div>
      <div class="btn-row"><button class="btn primary" data-ok>${icon('check')} PDF erstellen</button></div>`,
    onMount(el, api) {
      const list = el.querySelector('[data-sheets]');
      const render = () => {
        if (list) {
          list.innerHTML = book.sheets.map((s, i) => `<button class="row" data-i="${i}"><span class="row-ic ${on[i] ? 'c-green' : 'c-gray'}">${icon(on[i] ? 'check' : 'excel')}</span><span class="row-main"><span class="row-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${on[i] ? '' : 'color:var(--text3)'}">${esc(s.name)}</span></span></button>`).join('');
          list.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { on[+b.dataset.i] = !on[+b.dataset.i]; haptic(); render(); });
        }
        el.querySelectorAll('[data-o] button').forEach(b => b.classList.toggle('on', b.dataset.v === orient));
        el.querySelectorAll('[data-g] button').forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === grid));
      };
      el.querySelectorAll('[data-o] button').forEach(b => b.onclick = () => { orient = b.dataset.v; render(); });
      el.querySelectorAll('[data-g] button').forEach(b => b.onclick = () => { grid = b.dataset.v === '1'; render(); });
      el.querySelector('[data-ok]').onclick = () => {
        const sheets = on.map((v, i) => v ? i : -1).filter(i => i >= 0);
        if (!sheets.length) return toast('Bitte mindestens ein Blatt wählen', true);
        api.close(); go({ sheets, orient, grid });
      };
      render();
    },
  });
}

// ----- PDF → Word -----
async function pdfToWordSheet() {
  const docs = await allDocs();
  sheet({
    title: 'PDF → Word',
    html: `<p style="color:var(--text2);margin:0 2px 12px;font-size:14px;line-height:1.4">Text, Absätze, Spalten und Bilder werden als bearbeitbare Word-Datei (.docx) übernommen.</p>
      <div class="menu" style="margin-bottom:14px"><button class="row" data-imp><span class="row-ic c-red">${icon('filePlus')}</span><span class="row-main"><span class="row-title">PDF aus „Dateien“ wählen</span></span>${icon('chevronRight')}</button></div>
      ${docs.length ? `<div class="lbl" style="margin-top:0">Zuletzt</div><div class="menu">${docs.slice(0, 15).map(d => `<button class="row" data-id="${d.id}"><span class="doc-thumb" style="width:34px;height:44px;background-image:url('${d.thumb || ''}')"></span><span class="row-main"><span class="row-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span><span class="row-sub">${d.pages || 1} Seiten</span></span></button>`).join('')}</div>` : ''}`,
    onMount(el, api) {
      el.querySelector('[data-imp]').onclick = async () => {
        api.close();
        const files = await pickFiles('file-pdf');
        if (!files.length) return;
        let id;
        busy(true, 'PDF wird importiert …');
        try { id = await saveNewDoc(await files[0].arrayBuffer(), files[0].name); }
        catch { busy(false); return toast('Datei konnte nicht gelesen werden', true); }
        await renderRecents();
        exportWord(await db.get('docs', id));
      };
      el.querySelectorAll('[data-id]').forEach(b => b.onclick = async () => { api.close(); exportWord(docs.find(d => d.id === b.dataset.id)); });
    },
  });
}

async function exportWord(d) {
  if (!d) return;
  busy(true, 'Word-Datei wird erstellt …');
  try {
    const conv = await import('./pdf2word.js');
    let bytes = (await db.get('files', d.id)).data;
    if (d.objects?.length) {   // Änderungen aus dem Editor mitnehmen
      const pdf = await loadPdf(bytes);
      const infos = await pageInfos(pdf);
      closePdf(pdf);
      bytes = await flatten(bytes, d.objects, infos);
    }
    const name = d.name.replace(/\.pdf$/i, '') + '.docx';
    const res = await conv.pdfToWord(bytes, { title: d.name.replace(/\.pdf$/i, ''), onProgress: (i, n) => busy(true, n > 1 ? `Seite ${i} von ${n} wird gelesen …` : 'Word-Datei wird erstellt …') });
    busy(false);
    if (res.scanned) toast('Kein Text gefunden (Scan?) – Seiten als Bilder übernommen');
    await shareBytes(res.bytes, name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } catch (e) {
    console.error(e); busy(false);
    toast(e?.name === 'ConvertError' ? e.message : 'Umwandeln fehlgeschlagen', true);
  }
}

// ----- FAB -----
function fabSheet() {
  sheet({
    title: 'Neu',
    html: `
      <div class="lbl" style="margin-top:0">Werkzeuge</div>
      <div class="menu-grid">
        <button data-t="sign"><span class="qt-ic c-green">${icon('sign')}</span>Unterschrift</button>
        <button data-t="scan"><span class="qt-ic c-violet">${icon('scan')}</span>Scan</button>
        <button data-t="merge"><span class="qt-ic c-orange">${icon('merge')}</span>Zusammenfügen</button>
      </div>
      <div class="lbl">Importieren</div>
      <div class="menu-grid">
        <button data-t="import"><span class="qt-ic c-blue">${icon('filePlus')}</span>Datei wählen</button>
        <button data-t="img2pdf"><span class="qt-ic c-teal">${icon('images')}</span>Bilder → PDF</button>
        <button data-t="blank"><span class="qt-ic c-gray">${icon('file')}</span>Leeres PDF</button>
      </div>
      <div class="lbl">Konvertieren</div>
      <div class="menu-grid">
        <button data-t="word"><span class="qt-ic c-blue">${icon('word')}</span>Word zu PDF</button>
        <button data-t="excel"><span class="qt-ic c-green">${icon('excel')}</span>Excel zu PDF</button>
        <button data-t="ppt"><span class="qt-ic c-orange">${icon('ppt')}</span>PPT zu PDF</button>
      </div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { api.close(); b.dataset.t === 'import' ? importPdfs() : runTool(b.dataset.t); });
    },
  });
}

// ======================= Einstellungen =======================
async function renderSettings() {
  let usage = '';
  try { const e = await navigator.storage.estimate(); usage = fmtSize(e.usage || 0); } catch {}
  const docs = await db.all('docs');
  const th = settings.get('theme');
  $('settings-list').innerHTML = `
    <div class="group-title">Darstellung</div>
    <div class="group"><div class="row"><span class="row-ic c-violet">${icon('moon')}</span><span class="row-main"><span class="row-title">Design</span></span>
      <div class="seg" data-theme>${[['dark', 'Dunkel'], ['light', 'Hell'], ['system', 'Auto']].map(([v, l]) => `<button data-v="${v}" class="${th === v ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>

    <div class="group-title">Unterschrift & Stempel</div>
    <div class="group">
      <button class="row" data-s="sigs"><span class="row-ic c-green">${icon('sign')}</span><span class="row-main"><span class="row-title">Meine Unterschriften</span></span><span class="row-end">${icon('chevronRight')}</span></button>
      <button class="row" data-s="stamps"><span class="row-ic c-red">${icon('stamp')}</span><span class="row-main"><span class="row-title">Meine Stempel</span></span><span class="row-end">${icon('chevronRight')}</span></button>
      <button class="row" data-s="name"><span class="row-ic c-blue">${icon('user')}</span><span class="row-main"><span class="row-title">Zusatzzeile in Stempeln</span><span class="row-sub" style="display:block">${esc(settings.get('stampName') || 'Keine – z. B. Firmenname')}</span></span><span class="row-end">${icon('chevronRight')}</span></button>
      <div class="row"><span class="row-ic c-amber">${icon('calendar')}</span><span class="row-main"><span class="row-title">Datum in Stempeln</span></span>
        <div class="seg" data-sd><button data-v="1" class="${settings.get('stampDate') ? 'on' : ''}">An</button><button data-v="0" class="${settings.get('stampDate') ? '' : 'on'}">Aus</button></div></div>
    </div>

    <div class="group-title">Speicher</div>
    <div class="group">
      <div class="row"><span class="row-ic c-teal">${icon('storage')}</span><span class="row-main"><span class="row-title">Belegt</span><span class="row-sub" style="display:block">${docs.length} Dokument(e)</span></span><span class="row-end">${usage}</span></div>
      <button class="row" data-s="wipe"><span class="row-ic c-red">${icon('trash')}</span><span class="row-main"><span class="row-title" style="color:var(--danger)">Alle Dokumente löschen</span></span></button>
    </div>

    <div class="group-title">Info</div>
    <div class="group">
      <div class="row"><span class="row-ic c-green">${icon('shield')}</span><span class="row-main"><span class="row-title">100 % lokal & privat</span><span class="row-sub" style="display:block">Keine Werbung, kein Abo, keine Cloud – alles bleibt auf deinem Gerät.</span></span></div>
      <button class="row" data-s="install"><span class="row-ic c-blue">${icon('info')}</span><span class="row-main"><span class="row-title">Zum Home-Bildschirm</span><span class="row-sub" style="display:block">So installierst du Nibvion als App</span></span><span class="row-end">${icon('chevronRight')}</span></button>
    </div>
    <div class="about"><img src="icons/logo.png" alt="">Nibvion ${VERSION}<br>PDF Tools · Stamp &amp; Edit</div>
    <div class="bottom-space"></div>`;
  const root = $('settings-list');
  root.querySelectorAll('[data-theme] button').forEach(b => b.onclick = () => { settings.set('theme', b.dataset.v); applyTheme(); renderSettings(); });
  root.querySelectorAll('[data-sd] button').forEach(b => b.onclick = () => { settings.set('stampDate', b.dataset.v === '1'); renderSettings(); });
  root.querySelectorAll('[data-s]').forEach(b => b.onclick = async () => {
    const s = b.dataset.s;
    if (s === 'sigs') signatureSheet(null);
    if (s === 'stamps') stampSheet(null);
    if (s === 'name') { const n = await promptDlg('Zusatzzeile in Stempeln', settings.get('stampName'), 'Speichern', 'z. B. RepairMobile'); if (n !== null) { settings.set('stampName', n); renderSettings(); } }
    if (s === 'wipe' && await confirmDlg('Alles löschen?', 'Alle importierten PDFs werden von diesem Gerät gelöscht. Unterschriften und Stempel bleiben erhalten.')) {
      await db.clear('docs'); await db.clear('files'); renderSettings(); renderRecents(); toast('Alle Dokumente gelöscht');
    }
    if (s === 'install') sheet({ title: 'Als App installieren', html: `<ol style="color:var(--text2);line-height:1.8;padding-left:20px;margin:0 0 8px">
      <li>Seite in <b style="color:var(--text)">Safari</b> öffnen</li><li>Auf <b style="color:var(--text)">Teilen</b> ${icon('share', 'inline')} tippen</li><li><b style="color:var(--text)">„Zum Home-Bildschirm“</b> wählen</li></ol>` });
  });
}

// ======================= Tabs =======================
const TABS = ['tools', 'home', 'settings'];
function switchTab(tab) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === tab));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelector('.tab-indicator').style.transform = `translateX(${TABS.indexOf(tab) * 100}%)`;
  document.body.classList.toggle('tab-home', tab === 'home');   // „+“ nur auf der Startseite
  if (tab === 'settings') renderSettings();
  haptic();
}

// ======================= Start =======================
async function init() {
  hydrateIcons(document);
  initEditor();
  renderQuick(); renderTools();
  document.querySelector('.tab-indicator').style.transform = 'translateX(100%)';
  document.body.classList.add('tab-home');
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'import') importPdfs();
    if (a === 'fab') fabSheet();
    if (a === 'go-settings') switchTab('settings');
    if (a === 'toggle-sort') { settings.set('sort', settings.get('sort') === 'name' ? 'new' : 'name'); renderRecents(); }
  });
  await renderRecents();
  try { navigator.storage?.persist?.(); } catch {}
  setTimeout(() => $('splash').classList.add('hide'), 650);
  setTimeout(() => $('splash').remove(), 1300);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !document.body.classList.contains('in-editor')) location.reload();
    });
  }
}
init();

export { openDoc, saveNewDoc };
