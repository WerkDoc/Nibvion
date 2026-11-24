// ================= Backup: alles in eine ZIP-Datei & zurück =================
import { db } from './db.js';
import { loadLib } from './convert.js';
import { downloadBytes } from './editor.js';

const SETTINGS_KEY = 'nibvion.settings';

export async function createBackup(version) {
  await loadLib('jszip.min.js');
  const zip = new window.JSZip();
  const docs = await db.all('docs');
  const assets = await db.all('assets');
  let count = 0;
  for (const d of docs) {
    const f = await db.get('files', d.id);
    if (!f) continue;
    zip.file(`pdf/${d.id}.pdf`, f.data);
    for (const k of (d.idSides || []).flatMap((_, i) => [`${d.id}#s${i}`, `${d.id}#o${i}`])) {   // Ausweis-Fotos
      const x = await db.get('files', k); if (x) zip.file(`id/${encodeURIComponent(k)}`, x.data);
    }
    count++;
  }
  const meta = {
    app: 'Nibvion', format: 1, version, created: Date.now(),
    settings: localStorage.getItem(SETTINGS_KEY),
    docs: docs.map(({ textIdx, ...d }) => d),   // Suchindex wird beim Wiederherstellen neu aufgebaut
    assets,
  };
  zip.file('nibvion-backup.json', JSON.stringify(meta));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  return { bytes, count, assets: assets.length };
}

export async function shareBackup(bytes) {
  const d = new Date();
  const name = `Nibvion-Backup ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.zip`;
  const file = new File([bytes], name, { type: 'application/zip' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  downloadBytes(bytes, name, 'application/zip');
  return true;
}

export async function readBackup(file) {
  await loadLib('jszip.min.js');
  const zip = await window.JSZip.loadAsync(file);
  const mf = zip.file('nibvion-backup.json');
  if (!mf) throw new Error('Keine Nibvion-Sicherung');
  const meta = JSON.parse(await mf.async('string'));
  if (meta.app !== 'Nibvion') throw new Error('Keine Nibvion-Sicherung');
  return { zip, meta };
}

export async function restoreBackup({ zip, meta }) {
  let docs = 0;
  for (const d of meta.docs || []) {
    const pf = zip.file(`pdf/${d.id}.pdf`);
    if (!pf) continue;
    const data = await pf.async('arraybuffer');
    await db.put('files', { id: d.id, data });
    for (const k of (d.idSides || []).flatMap((_, i) => [`${d.id}#s${i}`, `${d.id}#o${i}`])) {
      const x = zip.file(`id/${encodeURIComponent(k)}`); if (x) await db.put('files', { id: k, data: await x.async('arraybuffer') });
    }
    await db.put('docs', d);
    docs++;
  }
  for (const a of meta.assets || []) await db.put('assets', a);
  if (meta.settings) localStorage.setItem(SETTINGS_KEY, meta.settings);
  return { docs, assets: (meta.assets || []).length };
}
