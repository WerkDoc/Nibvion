// ================= Scan-Originale =================
// Beim Speichern eines Scans werden die Original-Fotos samt Zuschnitt, Drehung, Filter und
// Anpassungen aufgehoben (IndexedDB-Store „scans“, Schlüssel = Dokument-ID). So lässt sich der
// Scan später über „Scan bearbeiten“ wieder in der Scan-Ansicht öffnen und neu verbessern.
// Nur lokal: der Store ist nicht Teil der Cloud (cloud.js synct nur docs/files/assets) → rawPut/rawDel.
import { db } from './db.js';
import { toCanvas } from './scanner.js';
import { loadImage } from './ui.js';
import { settings } from './settings.js';

export const keepScansOn = () => settings.get('keepScans') !== false;

const toBlob = (c, q = 0.92) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Bild konnte nicht gespeichert werden')), 'image/jpeg', q));

// Original-Foto: wenn möglich die unveränderte Datei, sonst das Kamerabild als JPEG
async function srcBlob(it) {
  if (it.url) { try { const b = await (await fetch(it.url)).blob(); if (b.size) return b; } catch {} }
  return toBlob(toCanvas(it.img, 4000), 0.93);
}

async function blobCanvas(b) {
  const url = URL.createObjectURL(b);
  try {
    const im = await loadImage(url);
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    c.getContext('2d').drawImage(im, 0, 0);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

/** Originale zu einem gespeicherten Scan ablegen. size = Größe der PDF danach (erkennt spätere Änderungen). */
export async function keepScan(docId, items, { kind = 'scan', filter, adj, ocr, size }) {
  const pages = [];
  for (const it of items) {
    const p = { img: await srcBlob(it), corners: it.corners, rot: it.rot || 0, ai: !!it.ai };
    if (it.straighten !== undefined) p.straighten = it.straighten;
    if (it.card) p.card = it.card;
    // Teure Ergebnisse mitnehmen: Online-Scan kostet Guthaben, KI-Scan dauert
    try { if (it._onl?.canvas) p.onl = { key: it._onl.key, ck: it._onl.ck, img: await toBlob(it._onl.canvas) }; } catch {}
    try { if (it._enh?.canvas) p.enh = { key: it._enh.key, img: await toBlob(it._enh.canvas) }; } catch {}
    pages.push(p);
  }
  const old = await db.get('scans', docId);
  await db.rawPut('scans', { id: docId, kind, pages, filter, adj: { ...adj }, ocr: !!ocr, size, created: old?.created || Date.now(), updated: Date.now() });
}

/** Gespeicherten Scan als Seiten für die Scan-Ansicht laden (oder null). */
export async function loadScan(docId) {
  const s = await db.get('scans', docId);
  if (!s?.pages?.length) return null;
  const items = [];
  for (const p of s.pages) {
    const url = URL.createObjectURL(p.img);
    const img = await loadImage(url);
    const it = { img, url, corners: p.corners.map(q => [...q]), rot: p.rot || 0, ai: !!p.ai };
    if (p.straighten !== undefined) it.straighten = p.straighten;
    if (p.card) it.card = p.card;
    try { if (p.onl) it._onl = { key: p.onl.key, ck: p.onl.ck, canvas: await blobCanvas(p.onl.img) }; } catch {}
    try { if (p.enh) it._enh = { key: p.enh.key, canvas: await blobCanvas(p.enh.img) }; } catch {}
    items.push(it);
  }
  return { ...s, items };
}

export async function hasScan(docId) {
  try { return (await db.keys('scans')).includes(docId); } catch { return false; }
}
export const dropScan = docId => db.rawDel('scans', docId).catch(() => {});

/** Anzahl und Größe aller Originale (für die Einstellungen). */
export async function scanUsage() {
  let n = 0, bytes = 0;
  try {
    for (const s of await db.all('scans')) {
      n++;
      for (const p of s.pages || []) bytes += (p.img?.size || 0) + (p.onl?.img?.size || 0) + (p.enh?.img?.size || 0);
    }
  } catch {}
  return { n, bytes };
}
export async function clearScans() { for (const id of await db.keys('scans')) await db.rawDel('scans', id); }

/** Originale entfernen, deren Dokument es nicht mehr gibt (z. B. auf anderem Gerät gelöscht). */
export async function pruneScans() {
  try {
    const docs = new Set(await db.keys('docs'));
    for (const id of await db.keys('scans')) if (!docs.has(id)) await db.rawDel('scans', id);
  } catch (e) { console.warn(e); }
}
