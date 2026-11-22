// ================= Nibvion App =================
import { db, uid } from './db.js';
import { icon, hydrateIcons } from './icons.js';
import { toast, busy, sheet, confirmDlg, promptDlg, esc, fmtSize, fmtDate, pickFiles, today, haptic, measureGap, resetDocScroll } from './ui.js';
import { loadPdf, closePdf, renderThumb, imagesToPdf, mergePdfs, blankPdf, normalizeImage, flatten, pageInfos } from './pdfcore.js';
import { detectCorners, cropEditor, loadFileImage, render as renderScan, enhance as enhanceScan, FULL, FILTERS } from './scanner.js';
import { liveScanner, cameraSupported } from './camera.js';
import { textSheet } from './textview.js';
import { scanReview } from './scanreview.js';
import { moveToTrash, purgeExpired, trashSheet, isDeleted, TRASH_DAYS } from './trash.js';
import { searchSheet, extractText } from './search.js';
import { createBackup, shareBackup, readBackup, restoreBackup } from './backup.js';
import { initEditor, openEditor, shareBytes, downloadBytes } from './editor.js';
import { signatureSheet, stampSheet } from './assets.js';
import { settings, applyTheme } from './settings.js';
import { ONLINE_MODES, onlineReady, testOnline } from './online.js';

export const VERSION = '1.17.2';
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
  let pages = [];
  try { pages = await extractText(pdf); } catch {}
  const id = uid();
  const meta = { id, name: /\.pdf$/i.test(name) ? name : name + '.pdf', size: data.byteLength, pages: pdf.numPages, thumb, objects: [], created: Date.now(), updated: Date.now(), opened: Date.now(), textIdx: { size: data.byteLength, pages } };
  closePdf(pdf);
  await db.put('files', { id, data });
  await db.put('docs', meta);
  return id;
}

// Geschützte PDF: Passwort abfragen und entsperrte Kopie speichern
async function importLocked(buf, name) {
  for (let tries = 0; tries < 3; tries++) {
    busy(false);
    const pw = await passwordPrompt(name, tries > 0);
    if (pw == null) return null;
    busy(true, 'PDF wird entsperrt …');
    try {
      const { decryptPdf } = await import('./tools.js');
      return await saveNewDoc(await decryptPdf(buf, pw), name);
    } catch (e) { console.warn(e); }
  }
  busy(false); toast('Passwort falsch', true);
  return null;
}

function passwordPrompt(name, wrong) {
  return new Promise(res => {
    let out = null;
    sheet({
      title: 'Geschützte PDF',
      html: `<p style="color:var(--text2);margin:0 2px 12px;line-height:1.45">„${esc(name)}“ ist mit einem Passwort geschützt.${wrong ? ' <b style="color:var(--danger)">Das Passwort war falsch.</b>' : ''} Nach dem Entsperren wird die PDF ohne Passwort in Nibvion gespeichert.</p>
        <input class="field" type="password" data-in placeholder="Passwort" autocomplete="off">
        <div class="btn-row"><button class="btn" data-c>Abbrechen</button><button class="btn primary" data-ok>${icon('unlock')} Entsperren</button></div>`,
      onMount(el, api) {
        const inp = el.querySelector('[data-in]');
        setTimeout(() => inp.focus(), 350);
        const ok = () => { if (!inp.value) return; out = inp.value; api.close(); };
        inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
        el.querySelector('[data-c]').onclick = () => api.close();
        el.querySelector('[data-ok]').onclick = ok;
      },
      onClose: () => res(out),
    });
  });
}

async function importFile(f) {
  const buf = await f.arrayBuffer();
  try { return await saveNewDoc(buf, f.name); }
  catch (e) {
    if (e?.name === 'PasswordException') return importLocked(buf, f.name);
    throw e;
  }
}

async function importPdfs(mode) {
  const files = await pickFiles('file-pdf');
  if (!files.length) return;
  busy(true, files.length > 1 ? `${files.length} PDFs werden importiert …` : 'PDF wird importiert …');
  let first = null, fails = 0;
  for (const f of files) {
    try { const id = await importFile(f); if (id) first ??= id; busy(true, 'PDF wird importiert …'); }
    catch (e) { console.warn(e); fails++; }
  }
  busy(false);
  if (fails) toast(fails === files.length ? 'Datei konnte nicht gelesen werden' : `${fails} Datei(en) übersprungen`, true);
  await renderRecents();
  if (first) openDoc(first, mode || 'view');
}

function openDoc(id, mode = 'view', page = 0) { openEditor(id, mode, renderRecents, page); }

// ======================= Start =======================
const QUICK = [
  { id: 'edit', label: 'PDF bearbeiten', icon: 'textEdit', c: 'c-red' },
  { id: 'comment', label: 'Kommentieren', icon: 'comment', c: 'c-amber' },
  { id: 'draw', label: 'Zeichnen', icon: 'draw', c: 'c-violet' },
  { id: 'sign', label: 'Unter­schreiben', icon: 'sign', c: 'c-green' },
  { id: 'imgscan', label: 'Bild scannen', icon: 'images', c: 'c-blue' },
  { id: 'all', label: 'Alle Werkzeuge', icon: 'grid', c: 'c-gray' },
];

function renderQuick() {
  $('quick-grid').innerHTML = QUICK.map((q, i) => `<button class="qt" data-q="${q.id}" style="animation-delay:${80 + i * 45}ms"><span class="qt-ic ${q.c}">${icon(q.icon)}</span><span>${q.label}</span></button>`).join('');
  $('quick-grid').querySelectorAll('[data-q]').forEach(b => b.onclick = () => runTool(b.dataset.q));
}

async function allDocs() {
  const docs = (await db.all('docs')).filter(d => !isDeleted(d));
  return settings.get('sort') === 'name'
    ? docs.sort((a, b) => a.name.localeCompare(b.name, 'de'))
    : docs.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

async function renderRecents() {
  const all = await allDocs();
  const favOnly = settings.get('favOnly');
  const docs = favOnly ? all.filter(d => d.fav) : all;
  $('btn-sort').textContent = settings.get('sort') === 'name' ? 'Name A–Z' : 'Neueste';
  $('btn-fav').innerHTML = icon(favOnly ? 'heartFill' : 'heart');
  $('btn-fav').classList.toggle('on', !!favOnly);
  const list = $('recent-list');
  if (!docs.length) {
    list.innerHTML = favOnly && all.length
      ? `<div class="empty">${icon('heart')}<b>Noch keine Favoriten</b>Tippe bei einer PDF auf ⋯ → „Zu Favoriten hinzufügen“.</div>`
      : `<div class="empty">${icon('file')}<b>Noch keine PDFs</b>Tippe auf „PDF öffnen“ oder das <b style="display:inline;color:var(--accent)">+</b>, um loszulegen.</div>`;
    return;
  }
  list.innerHTML = docs.map((d, i) => `
    <div class="doc-row" data-id="${d.id}" style="animation-delay:${Math.min(i, 8) * 40}ms">
      <div class="doc-thumb" style="background-image:url('${d.thumb || ''}')"></div>
      <button class="doc-info" data-open>
        <div class="doc-name">${d.fav ? `<span class="doc-fav">${icon('heartFill')}</span>` : ''}${esc(d.name)}</div>
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
      ${[['view', 'Öffnen', 'eye', 'c-blue'], ['edit', 'Bearbeiten', 'textEdit', 'c-red'], ['sign', 'Unterschreiben', 'sign', 'c-green'], ['share', 'Teilen', 'share', 'c-teal'],
        ['fav', d.fav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen', d.fav ? 'heartFill' : 'heart', 'c-red'],
        ['ocr', 'Text erkennen (OCR)', 'scan', 'c-teal'],
        ['text', 'Text extrahieren', 'textScan', 'c-blue'],
        ['wm', 'Wasserzeichen', 'drop', 'c-violet'], ['compress', 'Komprimieren', 'compress', 'c-green'], ['protect', 'Mit Passwort schützen', 'shieldLock', 'c-orange'],
        ['word', 'Als Word exportieren', 'word', 'c-blue'], ['excel', 'Als Excel exportieren', 'excel', 'c-green'], ['rename', 'Umbenennen', 'rename', 'c-gray'], ['del', 'Löschen', 'trash', 'c-red']]
        .map(([a, l, ic, c]) => `<button class="row" data-a="${a}"><span class="row-ic ${c}">${icon(ic)}</span><span class="row-main"><span class="row-title" ${a === 'del' ? 'style="color:var(--danger)"' : ''}>${l}</span></span></button>`).join('')}
    </div>`,
    onMount(el, api) {
      el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        const a = b.dataset.a; api.close();
        if (['view', 'edit', 'sign'].includes(a)) return openDoc(d.id, a);
        if (a === 'word') return exportWord(d);
        if (a === 'excel') return exportExcel(d);
        if (a === 'fav') { d.fav = !d.fav; await db.put('docs', d); haptic(); renderRecents(); return toast(d.fav ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt'); }
        if (a === 'wm') return watermarkSheet(d);
        if (a === 'compress') return compressSheet(d);
        if (a === 'ocr') return ocrDoc(d);
        if (a === 'text') return textFromDoc(d);
        if (a === 'protect') return protectSheet(d);
        if (a === 'share') {
          if (d.objects?.length) { openDoc(d.id); return toast('Zum Teilen mit Änderungen: ⋯ → Teilen'); }
          const f = await db.get('files', d.id); return shareBytes(new Uint8Array(f.data), d.name);
        }
        if (a === 'rename') {
          const n = await promptDlg('Umbenennen', d.name.replace(/\.pdf$/i, ''));
          if (n) { d.name = n + '.pdf'; await db.put('docs', d); renderRecents(); }
        }
        if (a === 'del' && await confirmDlg('PDF löschen?', `„${d.name}“ kommt in den Papierkorb und kann ${TRASH_DAYS} Tage lang wiederhergestellt werden.`, 'In den Papierkorb')) {
          await moveToTrash(d.id); renderRecents(); toast('In den Papierkorb verschoben');
        }
      });
    },
  });
}

// Datei für ein Werkzeug wählen
async function chooseDoc(mode, title = 'Datei wählen') {
  // Immer das Menü zeigen: iOS öffnet die Dateiauswahl nur direkt nach einem Tipp, nicht nach einer Wartezeit
  const docs = await allDocs();
  sheet({
    title,
    html: `<div class="menu" style="margin-bottom:14px"><button class="row" data-imp><span class="row-ic c-red">${icon('filePlus')}</span><span class="row-main"><span class="row-title">Aus „Dateien“ importieren</span><span class="row-sub">iCloud, Downloads, Mail-Anhänge …</span></span>${icon('chevronRight')}</button></div>
      ${docs.length ? `<div class="lbl" style="margin-top:0">Zuletzt</div>
      <div class="menu">${docs.slice(0, 12).map(d => `<button class="row" data-id="${d.id}"><span class="doc-thumb" style="width:34px;height:44px;background-image:url('${d.thumb || ''}')"></span><span class="row-main"><span class="row-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span><span class="row-sub">${fmtDate(d.updated)}</span></span></button>`).join('')}</div>`
      : `<p style="color:var(--text2);margin:2px 4px 8px;font-size:14px;line-height:1.4">Noch keine PDFs in Nibvion – wähle oben eine Datei aus.</p>`}`,
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
    { id: 'imgscan', label: 'Bild scannen', sub: 'Foto aus der Mediathek: Ränder erkennen, gerade ziehen', icon: 'fit', c: 'c-teal' },
    { id: 'img2pdf', label: 'Bilder → PDF', sub: 'Fotos & Screenshots zusammenfassen', icon: 'images', c: 'c-blue' },
    { id: 'merge', label: 'PDFs zusammenfügen', sub: 'Mehrere PDFs zu einem', icon: 'merge', c: 'c-orange' },
    { id: 'blank', label: 'Leeres PDF', sub: 'A4-Seite zum Ausfüllen', icon: 'filePlus', c: 'c-gray' },
  ] },
  { title: 'Konvertieren', items: [
    { id: 'pdf2img', label: 'PDF → Bilder', sub: 'Seiten als JPG speichern', icon: 'image', c: 'c-blue' },
    { id: 'word', label: 'Word → PDF', sub: 'DOCX als PDF speichern', icon: 'word', c: 'c-blue' },
    { id: 'excel', label: 'Excel → PDF', sub: 'XLSX, XLS oder CSV als PDF', icon: 'excel', c: 'c-green' },
    { id: 'ppt', label: 'PowerPoint → PDF', icon: 'ppt', c: 'c-orange', soon: true },
    { id: 'pdf2word', label: 'PDF → Word', sub: 'Als bearbeitbare DOCX speichern – auch Scans', icon: 'word', c: 'c-blue' },
    { id: 'pdf2excel', label: 'PDF / Scan → Excel', sub: 'Tabellen als bearbeitbare XLSX', icon: 'excel', c: 'c-green' },
  ] },
  { title: 'Schützen & Optimieren', items: [
    { id: 'ocr', label: 'Text erkennen (OCR)', sub: 'Scans durchsuchbar & kopierbar machen', icon: 'scan', c: 'c-teal' },
    { id: 'text', label: 'Text extrahieren', sub: 'Text kopieren, teilen oder als .txt sichern', icon: 'textScan', c: 'c-blue' },
    { id: 'compress', label: 'Komprimieren', sub: 'PDF-Datei verkleinern', icon: 'compress', c: 'c-green' },
    { id: 'wm', label: 'Wasserzeichen', sub: 'z. B. VERTRAULICH, KOPIE, ENTWURF', icon: 'drop', c: 'c-violet' },
    { id: 'protect', label: 'Mit Passwort schützen', sub: 'Nur mit Passwort zu öffnen', icon: 'shieldLock', c: 'c-orange' },
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
    case 'imgscan': return imageSheet('imgscan');
    case 'img2pdf': return imageSheet('images');
    case 'merge': return mergeSheet();
    case 'blank': return newBlank();
    case 'pdf2img': return pdfToImages();
    case 'word': return officeToPdf('word');
    case 'excel': return officeToPdf('excel');
    case 'pdf2word': return pdfToWordSheet();
    case 'pdf2excel': return docPicker('PDF / Scan → Excel', 'Tabellen und Text werden erkannt und als Excel-Datei gespeichert. Am besten klappt es bei Tabellen mit sichtbaren Linien.', exportExcel);
    case 'text': return docPicker('Text extrahieren', 'Der Text der PDF wird angezeigt – gescannte Seiten werden dafür automatisch gelesen.', textFromDoc);
    case 'ocr': return docPicker('Text erkennen (OCR)', 'Gescannte Seiten werden gelesen – danach kannst du den Text suchen, markieren und kopieren. Alles passiert auf dem iPhone.', ocrDoc);
    case 'compress': return docPicker('Komprimieren', 'Bilder in der PDF werden verkleinert – Text bleibt scharf.', compressSheet);
    case 'wm': return docPicker('Wasserzeichen', 'Text quer über alle Seiten, z. B. VERTRAULICH oder KOPIE.', watermarkSheet);
    case 'protect': return docPicker('Mit Passwort schützen', 'Die PDF lässt sich danach nur mit Passwort öffnen.', protectSheet);
    case 'sigs': return signatureSheet(null);
    case 'stamps': return stampSheet(null);
    default: toast('Kommt in einem der nächsten Updates');
  }
}

// ----- Scan / Bilder → PDF -----
// Scan: Live-Kamera mit Rahmenerkennung, danach Vollbild-Ansicht (scanreview.js).
async function imageSheet(kind) {
  const items = [];
  let liveFailed = false;
  if (kind === 'images') {
    const fs = await pickFiles('file-img'); if (!fs.length) return;
    busy(true, 'Bilder werden geladen …');
    for (const f of fs) { try { const { img, url } = await loadFileImage(f); items.push({ img, url, corners: detectCorners(img), rot: 0 }); } catch {} }
    busy(false);
    if (!items.length) return toast('Bilder konnten nicht geladen werden', true);
  } else if (kind === 'imgscan') {
    // Foto aus der Mediathek wie einen Scan behandeln (Ränder, Entzerren, Filter „Verbessern“)
    const fs = await pickFiles('file-img'); if (!fs.length) return;
    busy(true, 'Ränder werden erkannt …');
    for (const f of fs) { try { const { img, url } = await loadFileImage(f); items.push({ img, url, corners: detectCorners(img), rot: 0 }); } catch {} }
    busy(false);
    if (!items.length) return toast('Bilder konnten nicht geladen werden', true);
    kind = 'scan';
  } else if (cameraSupported()) {
    const shots = await liveScanner();
    if (shots === null) liveFailed = true;
    else if (!shots.length) return;
    else items.push(...shots);
  } else liveFailed = true;

  scanReview({
    kind, items, liveFailed,
    filter: kind === 'scan' ? (settings.get('scanFilter') ?? 'color') : null,
    ocrOn: kind === 'scan' && settings.get('scanOcr') !== false,
    onFilter: f => { if (kind === 'scan') settings.set('scanFilter', f); },
    onOcr: v => settings.set('scanOcr', v),
    onText: async (list, filter, adj) => {
      if (!list.length) return toast('Bitte zuerst eine Seite scannen', true);
      const fmt = await new Promise(res => {
        let v = null;
        sheet({
          title: 'Exportieren als',
          html: `<div class="menu">${[['text', 'Text', 'Anzeigen, kopieren, teilen', 'textScan', 'c-teal'], ['word', 'Word (.docx)', 'Absätze, Überschriften, Tabellen', 'word', 'c-blue'], ['excel', 'Excel (.xlsx)', 'Tabellen mit Linien als Zellen', 'excel', 'c-green']]
            .map(([k, t, s, ic, c]) => `<button class="row" data-f="${k}"><span class="row-ic ${c}">${icon(ic)}</span><span class="row-main"><span class="row-title">${t}</span><span class="row-sub">${s}</span></span>${icon('chevronRight')}</button>`).join('')}</div>`,
          onMount(el, api) { el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { v = b.dataset.f; api.close(); }); },
          onClose: () => res(v),
        });
      });
      if (!fmt) return;
      const clean = filter === 'invert' || !filter ? 'doc' : filter;
      if (fmt !== 'text') return scanToOffice(fmt, list.map(it => () => renderScan(it, clean, 2400, adj)), `Scan ${today()}`);
      busy(true, 'Texterkennung wird geladen …');
      try {
        const { recognizeCanvases } = await import('./ocr.js');
        const pages = await recognizeCanvases(list.map(it => () => renderScan(it, filter === 'invert' ? 'doc' : filter, 2400, adj)),
          { onProgress: (t, x) => busy(true, x > 0 && x < 1 ? `${t} ${Math.round(x * 100)} %` : t) });
        busy(false); textSheet(pages, `Scan ${today()}`);
      } catch (e) { console.error(e); busy(false); toast(e?.message?.includes('geladen') ? e.message : 'Texterkennung fehlgeschlagen', true); }
    },
    onSave: async (list, filter, adj, ocrOn) => {
      busy(true, 'PDF wird erstellt …');
      try {
        const urls = [];
        for (const it of list) { urls.push(renderScan(it, filter, 2200, adj).toDataURL('image/jpeg', 0.86)); await new Promise(r => setTimeout(r, 0)); }
        const bytes = await imagesToPdf(urls, { margin: 0 });
        const id = await saveNewDoc(bytes, `${kind === 'scan' ? 'Scan' : 'Bilder'} ${today()} ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }).replace(':', '-')}.pdf`);
        if (kind === 'scan' && ocrOn) await ocrDoc(await db.get('docs', id), { quiet: true });
        busy(false); await renderRecents();
        toast(kind === 'scan' && ocrOn ? 'Scan gespeichert – Text ist durchsuchbar' : 'PDF erstellt');
        list.forEach(it => it.url && setTimeout(() => URL.revokeObjectURL(it.url), 3000));
        openDoc(id);
        return true;
      } catch (e) { console.error(e); busy(false); toast('PDF konnte nicht erstellt werden', true); return false; }
    },
  });
}

// ----- Text extrahieren (aus einer PDF) -----
async function textFromDoc(d) {
  if (!d) return;
  busy(true, 'Text wird gelesen …');
  try {
    const { extractPdfText } = await import('./ocr.js');
    const f = await db.get('files', d.id);
    const pages = await extractPdfText(f.data, { onProgress: (t, x) => busy(true, x > 0 && x < 1 ? `${t} ${Math.round(x * 100)} %` : t) });
    busy(false); textSheet(pages, d.name);
  } catch (e) { console.error(e); busy(false); toast(e?.message?.includes('geladen') ? e.message : 'Text konnte nicht gelesen werden', true); }
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
        for (const f of files) { try { const id = await importFile(f); if (id) order.push(id); } catch {} busy(true, 'Import …'); }
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

// ----- Datei für ein Werkzeug wählen -----
async function docPicker(title, desc, onPick) {
  const docs = await allDocs();
  sheet({
    title,
    html: `<p style="color:var(--text2);margin:0 2px 12px;font-size:14px;line-height:1.4">${desc}</p>
      <div class="menu" style="margin-bottom:14px"><button class="row" data-imp><span class="row-ic c-red">${icon('filePlus')}</span><span class="row-main"><span class="row-title">PDF aus „Dateien“ wählen</span></span>${icon('chevronRight')}</button></div>
      ${docs.length ? `<div class="lbl" style="margin-top:0">Zuletzt</div><div class="menu">${docs.slice(0, 15).map(d => `<button class="row" data-id="${d.id}"><span class="doc-thumb" style="width:34px;height:44px;background-image:url('${d.thumb || ''}')"></span><span class="row-main"><span class="row-title" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.fav ? '♥ ' : ''}${esc(d.name)}</span><span class="row-sub">${d.pages || 1} Seiten · ${fmtSize(d.size || 0)}</span></span></button>`).join('')}</div>` : ''}`,
    onMount(el, api) {
      el.querySelector('[data-imp]').onclick = async () => {
        api.close();
        const files = await pickFiles('file-pdf');
        if (!files.length) return;
        let id;
        busy(true, 'PDF wird importiert …');
        try { id = await importFile(files[0]); }
        catch { busy(false); return toast('Datei konnte nicht gelesen werden', true); }
        busy(false);
        if (!id) return;
        await renderRecents();
        onPick(await db.get('docs', id));
      };
      el.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { api.close(); onPick(docs.find(d => d.id === b.dataset.id)); });
    },
  });
}

// ----- PDF → Word -----
function pdfToWordSheet() {
  return docPicker('PDF → Word', 'Text, Absätze, Spalten und Bilder werden als bearbeitbare Word-Datei (.docx) übernommen.', exportWord);
}

// Aktuelle Bytes eines Dokuments inkl. Änderungen aus dem Editor
async function docBytes(d) {
  let bytes = (await db.get('files', d.id)).data;
  if (d.objects?.length) {
    const pdf = await loadPdf(bytes);
    const infos = await pageInfos(pdf);
    closePdf(pdf);
    bytes = await flatten(bytes, d.objects, infos);
  }
  return bytes;
}

// Ergebnis speichern: als Kopie oder das Dokument ersetzen
async function storeResult(d, bytes, suffix, asCopy) {
  const base = d.name.replace(/\.pdf$/i, '');
  if (asCopy) return saveNewDoc(bytes, `${base} (${suffix}).pdf`);
  const data = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const pdf = await loadPdf(data);
  let thumb = d.thumb;
  try { thumb = await renderThumb(pdf, 1); } catch {}
  const meta = { ...d, size: data.byteLength, pages: pdf.numPages, thumb, objects: [], updated: Date.now() };
  closePdf(pdf);
  await db.put('files', { id: d.id, data });
  await db.put('docs', meta);
  return d.id;
}

const copyRow = on => `<div class="row" style="padding:12px 2px 2px;border:0"><span class="row-main"><span class="row-title">Als Kopie speichern</span><span class="row-sub" style="display:block">Aus: Original wird ersetzt</span></span>
  <div class="seg" data-copy><button data-v="1" class="${on ? 'on' : ''}">An</button><button data-v="0" class="${on ? '' : 'on'}">Aus</button></div></div>`;
function bindCopy(el, get, set) {
  el.querySelectorAll('[data-copy] button').forEach(b => b.onclick = () => { set(b.dataset.v === '1'); el.querySelectorAll('[data-copy] button').forEach(x => x.classList.toggle('on', (x.dataset.v === '1') === get())); });
}

// ----- Wasserzeichen -----
const WM_TEXTS = ['VERTRAULICH', 'KOPIE', 'ENTWURF', 'BEZAHLT', 'ORIGINAL', 'MUSTER'];
async function watermarkSheet(d) {
  if (!d) return;
  busy(true, 'Vorschau wird geladen …');
  let bytes, img, pw, ph, tools;
  try {
    [bytes, tools] = await Promise.all([docBytes(d), import('./tools.js')]);
    const pdf = await loadPdf(bytes);
    const p1 = await pdf.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    pw = vp.width; ph = vp.height;
    img = await new Promise(async (res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = await renderThumb(pdf, 1, 900); });
    closePdf(pdf);
  } catch (e) { console.error(e); busy(false); return toast('PDF konnte nicht geladen werden', true); }
  busy(false);
  const st = { text: settings.get('wmText') || 'VERTRAULICH', opacity: settings.get('wmOpacity') ?? 0.25, color: settings.get('wmColor') || tools.WM_COLORS.rot, diagonal: settings.get('wmDiag') ?? true, scale: 1, copy: true };
  sheet({
    title: 'Wasserzeichen',
    html: `<div class="wm-prev"><canvas data-cv></canvas></div>
      <div class="lbl">Text</div>
      <input class="field" data-t maxlength="40" value="${esc(st.text)}" autocapitalize="characters">
      <div class="chips no-swipe" data-chips>${WM_TEXTS.map(t => `<button class="chip" data-v="${t}">${t}</button>`).join('')}</div>
      <div class="lbl">Farbe</div>
      <div class="colors" data-cols>${Object.entries(tools.WM_COLORS).map(([n, c]) => `<button class="color" data-c="${c}" aria-label="${n}" style="background:${c}"></button>`).join('')}</div>
      <div class="lbl">Deckkraft <span data-ov style="float:right;color:var(--text)"></span></div>
      <input type="range" class="range" data-o min="5" max="80" step="1">
      <div class="lbl">Größe</div>
      <input type="range" class="range" data-s min="40" max="130" step="1" value="100">
      <div class="row" style="padding:14px 2px 2px;border:0"><span class="row-main"><span class="row-title">Ausrichtung</span></span>
        <div class="seg" data-dir><button data-v="1">Diagonal</button><button data-v="0">Waagerecht</button></div></div>
      ${copyRow(st.copy)}
      <div class="btn-row"><button class="btn primary" data-ok>${icon('drop')} Wasserzeichen anwenden</button></div>`,
    onMount(el, api) {
      const cv = el.querySelector('[data-cv]');
      cv.width = 900; cv.height = Math.round(900 * ph / pw);
      const ctx = cv.getContext('2d');
      const inp = el.querySelector('[data-t]'), op = el.querySelector('[data-o]'), sz = el.querySelector('[data-s]');
      op.value = Math.round(st.opacity * 100);
      const draw = () => {
        tools.drawWatermarkPreview(ctx, img, pw, ph, st);
        el.querySelector('[data-ov]').textContent = Math.round(st.opacity * 100) + ' %';
        el.querySelectorAll('[data-chips] .chip').forEach(b => b.classList.toggle('on', b.dataset.v === st.text));
        el.querySelectorAll('[data-cols] .color').forEach(b => b.classList.toggle('on', b.dataset.c === st.color));
        el.querySelectorAll('[data-dir] button').forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === st.diagonal));
      };
      inp.oninput = () => { st.text = inp.value; draw(); };
      el.querySelectorAll('[data-chips] .chip').forEach(b => b.onclick = () => { st.text = b.dataset.v; inp.value = st.text; haptic(); draw(); });
      el.querySelectorAll('[data-cols] .color').forEach(b => b.onclick = () => { st.color = b.dataset.c; draw(); });
      el.querySelectorAll('[data-dir] button').forEach(b => b.onclick = () => { st.diagonal = b.dataset.v === '1'; draw(); });
      op.oninput = () => { st.opacity = op.value / 100; draw(); };
      sz.oninput = () => { st.scale = sz.value / 100; draw(); };
      bindCopy(el, () => st.copy, v => { st.copy = v; });
      el.querySelector('[data-ok]').onclick = async () => {
        if (!st.text.trim()) return toast('Bitte einen Text eingeben', true);
        settings.set('wmText', st.text); settings.set('wmOpacity', st.opacity); settings.set('wmColor', st.color); settings.set('wmDiag', st.diagonal);
        api.close(); busy(true, 'Wasserzeichen wird gesetzt …');
        try {
          const out = await tools.addWatermark(bytes, st);
          const id = await storeResult(d, out, 'Wasserzeichen', st.copy);
          busy(false); await renderRecents(); toast('Wasserzeichen gesetzt'); openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Wasserzeichen fehlgeschlagen', true); }
      };
      draw();
    },
  });
}

// ----- Texterkennung (OCR) -----
async function ocrDoc(d, { quiet = false } = {}) {
  if (!d) return;
  busy(true, 'Seiten werden geprüft …');
  try {
    const { ocrPdf } = await import('./ocr.js');
    const f = await db.get('files', d.id);
    const res = await ocrPdf(f.data, { onProgress: (t, x) => busy(true, x > 0 && x < 1 ? `${t} ${Math.round(x * 100)} %` : t) });
    if (!res.pages) { if (!quiet) { busy(false); toast('Diese PDF enthält bereits Text'); } return; }
    const data = res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength);
    await db.put('files', { id: d.id, data });
    const fresh = await db.get('docs', d.id);
    fresh.size = data.byteLength; fresh.updated = Date.now(); delete fresh.textIdx;
    await db.put('docs', fresh);
    if (quiet) return;
    busy(false); await renderRecents();
    toast(res.words ? `Text auf ${res.pages} ${res.pages === 1 ? 'Seite' : 'Seiten'} erkannt – jetzt durchsuchbar` : 'Kein Text erkannt', !res.words);
  } catch (e) {
    console.error(e); if (!quiet) busy(false);
    toast(e?.message?.includes('geladen') ? e.message : 'Texterkennung fehlgeschlagen', true);
  }
}

// ----- Komprimieren -----
function compressSheet(d) {
  if (!d) return;
  let level = 'standard', copy = true;
  const opts = [['standard', 'Standard', 'Ausgewogene Qualität und Größe'], ['stark', 'Stark', 'Kleinste Datei, Bilder etwas unschärfer'], ['leicht', 'Leicht', 'Beste Qualität, etwas größere Datei']];
  sheet({
    title: 'Komprimieren',
    html: `<p style="color:var(--text2);margin:0 2px 12px;font-size:14px;line-height:1.4">„${esc(d.name)}“ · aktuell <b style="color:var(--text)">${fmtSize(d.size || 0)}</b><br>Fotos und Scans in der PDF werden verkleinert, Text bleibt gestochen scharf.</p>
      <div class="menu" data-lv>${opts.map(([v, t, sub]) => `<button class="row" data-v="${v}"><span class="row-main"><span class="row-title">${t}</span><span class="row-sub" style="display:block">${sub}</span></span><span class="radio"></span></button>`).join('')}</div>
      ${copyRow(copy)}
      <div class="btn-row"><button class="btn primary" data-ok>${icon('compress')} PDF komprimieren</button></div>`,
    onMount(el, api) {
      const render = () => el.querySelectorAll('[data-lv] .row').forEach(b => b.classList.toggle('sel', b.dataset.v === level));
      el.querySelectorAll('[data-lv] .row').forEach(b => b.onclick = () => { level = b.dataset.v; haptic(); render(); });
      bindCopy(el, () => copy, v => { copy = v; });
      el.querySelector('[data-ok]').onclick = async () => {
        api.close(); busy(true, 'PDF wird komprimiert …');
        try {
          const tools = await import('./tools.js');
          const before = await docBytes(d);
          const res = await tools.compressPdf(before, level, (i, n) => busy(true, `Bild ${i} von ${n} wird verkleinert …`));
          const a = (d.objects?.length ? before.byteLength : d.size) || before.byteLength, b = res.bytes.byteLength;
          if (b >= a * 0.97) { busy(false); return toast(res.images ? 'Die PDF ist bereits gut komprimiert' : 'Keine Bilder zum Verkleinern gefunden'); }
          const id = await storeResult(d, res.bytes, 'komprimiert', copy);
          busy(false); await renderRecents();
          toast(`${fmtSize(a)} → ${fmtSize(b)} (−${Math.round((1 - b / a) * 100)} %)`);
        } catch (e) { console.error(e); busy(false); toast('Komprimieren fehlgeschlagen', true); }
      };
      render();
    },
  });
}

// ----- Passwort -----
function protectSheet(d) {
  if (!d) return;
  sheet({
    title: 'Mit Passwort schützen',
    html: `<div class="prot-ic">${icon('shieldLock')}</div>
      <p style="color:var(--text2);margin:0 4px 14px;line-height:1.45;text-align:center;font-size:14px">Wer die Datei öffnet, muss das Passwort eingeben. Gut merken – es lässt sich <b style="color:var(--text)">nicht wiederherstellen</b>. Deine PDF in Nibvion bleibt ungeschützt, geschützt wird die Datei, die du teilst oder sicherst.</p>
      <input class="field" type="password" data-p1 placeholder="Passwort (mind. 4 Zeichen)" autocomplete="new-password">
      <input class="field" type="password" data-p2 placeholder="Passwort wiederholen" autocomplete="new-password" style="margin-top:10px">
      <div class="row" style="padding:12px 2px 2px;border:0"><span class="row-main"><span class="row-title">Passwort anzeigen</span></span>
        <div class="seg" data-show><button data-v="0" class="on">Aus</button><button data-v="1">An</button></div></div>
      <div class="btn-row"><button class="btn primary" data-ok disabled>${icon('lock')} Geschützt teilen / sichern</button></div>`,
    onMount(el, api) {
      const p1 = el.querySelector('[data-p1]'), p2 = el.querySelector('[data-p2]'), ok = el.querySelector('[data-ok]');
      const check = () => { ok.disabled = !(p1.value.length >= 4 && p1.value === p2.value); };
      p1.oninput = p2.oninput = check;
      el.querySelectorAll('[data-show] button').forEach(b => b.onclick = () => {
        const on = b.dataset.v === '1';
        p1.type = p2.type = on ? 'text' : 'password';
        el.querySelectorAll('[data-show] button').forEach(x => x.classList.toggle('on', x === b));
      });
      ok.onclick = async () => {
        if (ok.disabled) return;
        const pw = p1.value;
        api.close(); busy(true, 'PDF wird verschlüsselt …');
        try {
          const tools = await import('./tools.js');
          const out = await tools.encryptPdf(await docBytes(d), pw);
          busy(false);
          toast('PDF ist geschützt (AES-256)');
          await shareBytes(out, d.name.replace(/\.pdf$/i, '') + ' (geschützt).pdf');
        } catch (e) { console.error(e); busy(false); toast('Verschlüsseln fehlgeschlagen', true); }
      };
      setTimeout(() => p1.focus(), 350);
    },
  });
}

// ----- Scan → Word / Excel (Layout-Erkennung) -----
const MIME = { word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
function pdfCanvases(bytes) {
  // Liefert Funktionen, die die Seiten nacheinander rendern (spart Speicher)
  const list = [];
  const pdfP = loadPdf(bytes);
  return (async () => {
    const pdf = await pdfP;
    for (let i = 1; i <= pdf.numPages; i++) list.push(async () => {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(2400 / Math.max(base.width, base.height), 4) });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return c;
    });
    return list;
  })();
}
async function scanToOffice(fmt, sources, baseName) {
  busy(true, 'Texterkennung wird geladen …');
  try {
    const list = await sources;
    const { recognizeLayout } = await import('./ocr.js');
    const conv = await import('./scan2office.js');
    const res = await recognizeLayout(list, { prepare: conv.prepare, onProgress: (t, x) => busy(true, x > 0 && x < 1 ? `${t} ${Math.round(x * 100)} %` : t) });
    busy(true, 'Layout und Tabellen werden erkannt …');
    await new Promise(r => setTimeout(r, 30));
    const pages = res.map(r => conv.analyzePage(r.canvas, r.blocks, r.prep));
    busy(true, fmt === 'word' ? 'Word-Datei wird erstellt …' : 'Excel-Datei wird erstellt …');
    const bytes = fmt === 'word' ? await conv.pagesToDocx(pages) : await conv.pagesToXlsx(pages);
    busy(false);
    const tables = pages.reduce((n, p) => n + p.tables.length, 0);
    if (fmt === 'excel' && !tables) toast('Keine Tabellenlinien gefunden – Text wurde zeilenweise übernommen');
    await shareBytes(bytes, baseName.replace(/\.pdf$/i, '') + (fmt === 'word' ? '.docx' : '.xlsx'), MIME[fmt]);
  } catch (e) {
    console.error(e); busy(false);
    toast(e?.message?.includes('geladen') ? e.message : 'Umwandeln fehlgeschlagen', true);
  }
}
async function exportExcel(d) {
  if (!d) return;
  busy(true, 'PDF wird vorbereitet …');
  try { const bytes = await docBytes(d); busy(false); await scanToOffice('excel', pdfCanvases(bytes), d.name); }
  catch (e) { console.error(e); busy(false); toast('Umwandeln fehlgeschlagen', true); }
}

async function exportWord(d) {
  if (!d) return;
  busy(true, 'Word-Datei wird erstellt …');
  try {
    const bytes = await docBytes(d);   // inkl. Änderungen aus dem Editor
    const name = d.name.replace(/\.pdf$/i, '') + '.docx';
    // Gescannte PDF → Layout-Erkennung (Texterkennung, Tabellen, Absätze)
    const { needsOcr } = await import('./ocr.js');
    const scanned = await needsOcr(bytes);
    if (scanned && scanned >= (d.pages || 1)) { busy(false); return scanToOffice('word', pdfCanvases(bytes), d.name); }
    const conv = await import('./pdf2word.js');
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
        <button data-t="imgscan"><span class="qt-ic c-teal">${icon('fit')}</span>Bild scannen</button>
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
  const all = await db.all('docs');
  const docs = all.filter(d => !isDeleted(d)), trashed = all.length - docs.length;
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

    <div class="group-title">Online-Scan (TextIn · CamScanner-Technik)</div>
    <div class="group">
      <button class="row" data-s="online"><span class="row-ic c-blue">${icon('sparkles')}</span><span class="row-main"><span class="row-title">${onlineReady() ? 'Eingerichtet' : 'Einrichten'}</span><span class="row-sub" style="display:block">${onlineReady() ? 'Filter „☁️ Online“ in der Scan-Ansicht' : 'Optional – Fotos werden dafür an TextIn gesendet'}</span></span><span class="row-end">${icon('chevronRight')}</span></button>
      ${onlineReady() ? `<div class="row"><span class="row-ic c-violet">${icon('sparkles')}</span><span class="row-main"><span class="row-title">Modus</span></span>
        <select class="field" data-om style="width:auto;max-width:170px;padding:6px 10px">${ONLINE_MODES.map(([v, l]) => `<option value="${v}" ${(settings.get('onlineMode') || '2') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
    </div>

    <div class="group-title">Speicher</div>
    <div class="group">
      <div class="row"><span class="row-ic c-teal">${icon('storage')}</span><span class="row-main"><span class="row-title">Belegt</span><span class="row-sub" style="display:block">${docs.length} Dokument(e)</span></span><span class="row-end">${usage}</span></div>
      <button class="row" data-s="backup"><span class="row-ic c-blue">${icon('archive')}</span><span class="row-main"><span class="row-title">Backup erstellen</span><span class="row-sub" style="display:block">${settings.get('lastBackup') ? 'Zuletzt: ' + fmtDate(settings.get('lastBackup')) : 'Alle PDFs, Unterschriften & Stempel als ZIP sichern'}</span></span><span class="row-end">${icon('chevronRight')}</span></button>
      <button class="row" data-s="restore"><span class="row-ic c-violet">${icon('restore')}</span><span class="row-main"><span class="row-title">Backup wiederherstellen</span><span class="row-sub" style="display:block">ZIP-Datei aus „Dateien“ oder iCloud wählen</span></span><span class="row-end">${icon('chevronRight')}</span></button>
      <button class="row" data-s="trash"><span class="row-ic c-orange">${icon('trash')}</span><span class="row-main"><span class="row-title">Papierkorb</span><span class="row-sub" style="display:block">${trashed ? `${trashed} PDF(s) · ${TRASH_DAYS} Tage wiederherstellbar` : `Gelöschte PDFs ${TRASH_DAYS} Tage wiederherstellen`}</span></span><span class="row-end">${trashed ? `<span class="soon">${trashed}</span>` : ''}${icon('chevronRight')}</span></button>
      <button class="row" data-s="wipe"><span class="row-ic c-red">${icon('trash')}</span><span class="row-main"><span class="row-title" style="color:var(--danger)">Alle Dokumente löschen</span></span></button>
    </div>

    <div class="group-title">Info</div>
    <div class="group">
      <div class="row"><span class="row-ic c-green">${icon('shield')}</span><span class="row-main"><span class="row-title">100 % lokal & privat</span><span class="row-sub" style="display:block">Keine Werbung, kein Abo, keine Cloud – alles bleibt auf deinem Gerät${onlineReady() ? ' (außer beim Filter „☁️ Online“)' : ''}.</span></span></div>
      <button class="row" data-s="install"><span class="row-ic c-blue">${icon('info')}</span><span class="row-main"><span class="row-title">Zum Home-Bildschirm</span><span class="row-sub" style="display:block">So installierst du Nibvion als App</span></span><span class="row-end">${icon('chevronRight')}</span></button>
    </div>
    <div class="about"><img src="icons/logo.png" alt="">Nibvion ${VERSION}<br>PDF Tools · Stamp &amp; Edit</div>
    <div class="bottom-space"></div>`;
  const root = $('settings-list');
  root.querySelectorAll('[data-theme] button').forEach(b => b.onclick = () => { settings.set('theme', b.dataset.v); applyTheme(); renderSettings(); });
  root.querySelectorAll('[data-sd] button').forEach(b => b.onclick = () => { settings.set('stampDate', b.dataset.v === '1'); renderSettings(); });
  root.querySelector('[data-om]')?.addEventListener('change', e => { settings.set('onlineMode', e.target.value); toast('Modus gespeichert'); });
  root.querySelectorAll('[data-s]').forEach(b => b.onclick = async () => {
    const s = b.dataset.s;
    if (s === 'sigs') signatureSheet(null);
    if (s === 'online') onlineSheet();
    if (s === 'stamps') stampSheet(null);
    if (s === 'name') { const n = await promptDlg('Zusatzzeile in Stempeln', settings.get('stampName'), 'Speichern', 'z. B. Firmenname'); if (n !== null) { settings.set('stampName', n); renderSettings(); } }
    if (s === 'backup') {
      busy(true, 'Backup wird erstellt …');
      try {
        const r = await createBackup(VERSION); busy(false);
        if (!r.count && !r.assets) return toast('Es gibt noch nichts zu sichern', true);
        if (await shareBackup(r.bytes)) { settings.set('lastBackup', Date.now()); renderSettings(); toast(`${r.count} PDF(s) gesichert`); }
      } catch (e) { console.error(e); busy(false); toast('Backup fehlgeschlagen', true); }
    }
    if (s === 'restore') {
      const [f] = await pickFiles('file-zip'); if (!f) return;
      busy(true, 'Backup wird gelesen …');
      let bk;
      try { bk = await readBackup(f); } catch (e) { busy(false); return toast('Das ist keine Nibvion-Sicherung', true); }
      busy(false);
      const n = (bk.meta.docs || []).length;
      if (!(await confirmDlg('Backup wiederherstellen?', `Die Sicherung vom ${fmtDate(bk.meta.created)} enthält ${n} PDF(s). Sie werden zu deinen PDFs hinzugefügt – gleiche Dokumente werden durch den Stand aus der Sicherung ersetzt.`, 'Wiederherstellen', false))) return;
      busy(true, 'Wird wiederhergestellt …');
      try {
        const r = await restoreBackup(bk); busy(false);
        toast(`${r.docs} PDF(s) wiederhergestellt`);
        setTimeout(() => location.reload(), 900);
      } catch (e) { console.error(e); busy(false); toast('Wiederherstellen fehlgeschlagen', true); }
    }
    if (s === 'trash') trashSheet(() => { renderSettings(); renderRecents(); });
    if (s === 'wipe' && await confirmDlg('Alle Dokumente löschen?', `Alle PDFs kommen in den Papierkorb und können ${TRASH_DAYS} Tage lang wiederhergestellt werden. Unterschriften und Stempel bleiben erhalten.`, 'In den Papierkorb')) {
      const ids = (await db.all('docs')).filter(d => !isDeleted(d)).map(d => d.id);
      await moveToTrash(ids); renderSettings(); renderRecents(); toast(`${ids.length} PDF(s) in den Papierkorb verschoben`);
    }
    if (s === 'install') sheet({ title: 'Als App installieren', html: `<ol style="color:var(--text2);line-height:1.8;padding-left:20px;margin:0 0 8px">
      <li>Seite in <b style="color:var(--text)">Safari</b> öffnen</li><li>Auf <b style="color:var(--text)">Teilen</b> ${icon('share', 'inline')} tippen</li><li><b style="color:var(--text)">„Zum Home-Bildschirm“</b> wählen</li></ol>` });
  });
}

// Online-Scan einrichten: Adresse der eigenen Supabase-Funktion + eigener Schlüssel
function onlineSheet() {
  const sh = sheet({ title: 'Online-Scan einrichten', html: `
    <p style="color:var(--text2);margin:0 0 12px;line-height:1.5">Für den Filter „☁️ Online“ wird das Foto über deine Supabase-Funktion <b style="color:var(--text)">textin-scan</b> an TextIn (CamScanner-Technik) gesendet. Ohne Einrichtung bleibt alles lokal.</p>
    <input class="field" data-u placeholder="https://….supabase.co/functions/v1/textin-scan" value="${esc(settings.get('onlineUrl') || '')}" autocapitalize="off" autocorrect="off" spellcheck="false" style="margin-bottom:10px">
    <input class="field" type="password" data-k placeholder="Zugangsschlüssel (NIBVION_KEY)" value="${esc(settings.get('onlineKey') || '')}" autocomplete="off">
    <div class="btn-row" style="margin-top:14px">${onlineReady() ? '<button class="btn" data-del>Entfernen</button>' : ''}<button class="btn" data-test>Testen</button><button class="btn primary" data-ok>${icon('check')} Speichern</button></div>` });
  const get = () => [sh.el.querySelector('[data-u]').value.trim(), sh.el.querySelector('[data-k]').value.trim()];
  const save = () => { const [u, k] = get(); settings.set('onlineUrl', u); settings.set('onlineKey', k); };
  sh.el.querySelector('[data-ok]').onclick = () => { save(); sh.close(); renderSettings(); toast(onlineReady() ? 'Online-Scan eingerichtet' : 'Gespeichert'); };
  sh.el.querySelector('[data-test]').onclick = async () => {
    const [u, k] = get(); if (!u || !k) return toast('Bitte Adresse und Schlüssel eintragen', true);
    save(); busy(true, 'Verbindung wird getestet …');
    try { await testOnline(); busy(false); toast('Verbindung klappt ✓'); }
    catch (e) { busy(false); toast(e.message || 'Verbindung fehlgeschlagen', true); }
  };
  const del = sh.el.querySelector('[data-del]');
  if (del) del.onclick = () => { settings.set('onlineUrl', ''); settings.set('onlineKey', ''); sh.close(); renderSettings(); toast('Online-Scan entfernt'); };
}

// ======================= Tabs =======================
const TABS = ['tools', 'home', 'settings'];
function switchTab(tab) {
  resetDocScroll();
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === tab));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelector('.tab-indicator').style.transform = `translateX(${TABS.indexOf(tab) * 100}%)`;
  document.body.classList.toggle('tab-home', tab === 'home');   // „+“ nur auf der Startseite
  if (tab === 'settings') renderSettings();
  haptic();
}

// ======================= Start =======================
async function init() {
  measureGap();
  try { await purgeExpired(); } catch {}
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
    if (a === 'search') searchSheet(openDoc);
    if (a === 'toggle-sort') { settings.set('sort', settings.get('sort') === 'name' ? 'new' : 'name'); renderRecents(); }
    if (a === 'toggle-fav') { settings.set('favOnly', !settings.get('favOnly')); haptic(); renderRecents(); }
  });
  await renderRecents();
  try { navigator.storage?.persist?.(); } catch {}
  setTimeout(() => { $('splash').classList.add('hide'); document.documentElement.classList.remove('splashing'); applyTheme(); }, 650);
  setTimeout(() => $('splash').remove(), 1300);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // Kein automatisches Neuladen bei Updates mehr (das verursachte den doppelten Startbildschirm):
    // App-Dateien kommen ohnehin zuerst aus dem Netz, der neue Service Worker gilt ab dem nächsten Start.
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();

export { openDoc, saveNewDoc };
