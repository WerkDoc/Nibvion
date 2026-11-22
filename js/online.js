// Online-Scan über TextIn (Technik der CamScanner-Firma INTSIG). Nur wenn in den Einstellungen
// eingerichtet: Das Foto geht über Olegs eigene Supabase-Funktion („textin-scan“) an TextIn.
// Die TextIn-Zugangsdaten liegen nur in Supabase, in der App stehen nur Adresse + eigener Schlüssel.
import { settings } from './settings.js';
import { toCanvas } from './scanner.js';

export const ONLINE_MODES = [['2', 'Verbessern'], ['5', 'Schatten weg'], ['1', 'Aufhellen'], ['3', 'Schwarz-Weiß'], ['4', 'Graustufen']];
export const onlineReady = () => !!(settings.get('onlineUrl') && settings.get('onlineKey'));
export const onlineKey = it => JSON.stringify([it.corners, settings.get('onlineMode') || '2']);
export const onlineDone = it => !!(it._onl && it._onl.key === onlineKey(it));

const MAX = 4000;   // Kantenlänge des hochgeladenen Fotos

async function call(blob, params) {
  const url = new URL(settings.get('onlineUrl'));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { method: 'POST', headers: { 'x-nibvion-key': settings.get('onlineKey'), 'Content-Type': 'application/octet-stream' }, body: blob });
  let j; try { j = await r.json(); } catch { throw new Error(`Online-Scan: keine gültige Antwort (${r.status})`); }
  if (j.code !== 200) {
    const msg = { 401: 'Zugangsschlüssel falsch', 40101: 'TextIn-Zugangsdaten fehlen', 40102: 'TextIn App-ID oder Secret falsch', 40003: 'TextIn-Guthaben aufgebraucht', 40306: 'Zu viele Anfragen – kurz warten' }[j.code];
    throw new Error(msg || j.message || `Fehler ${j.code}`);
  }
  return j.result;
}

/** Holt die Online-Version einer Seite (einmal je Zuschnitt/Modus, Ergebnis in it._onl). */
export async function ensureOnline(it) {
  if (onlineDone(it)) return;
  const key = onlineKey(it);
  if (it._onlP && it._onlPKey === key) return it._onlP;
  it._onlPKey = key;
  it._onlP = (async () => {
    const c = toCanvas(it.img, MAX), W = c.width, H = c.height;
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.93));
    const pos = it.corners.flatMap(([x, y]) => [Math.round(x * W), Math.round(y * H)]);
    const res = await call(blob, {
      enhance_mode: settings.get('onlineMode') || '2', crop_image: 1, dewarp_image: 1, deblur_image: 1,
      correct_direction: 0, jpeg_quality: 95, size_and_positon: [W, H, ...pos].join(','),
    });
    const b64 = res?.image_list?.[0]?.image;
    if (!b64) throw new Error('Online-Scan: kein Bild zurückbekommen');
    const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
    const out = document.createElement('canvas'); out.width = img.naturalWidth; out.height = img.naturalHeight;
    out.getContext('2d').drawImage(img, 0, 0);
    it._onl = { key, ck: JSON.stringify(it.corners), canvas: out };
  })();
  try { await it._onlP; } finally { if (it._onlPKey === key) it._onlP = null; }
}

/** Verbindung prüfen: kleines Testbild senden. */
export async function testOnline() {
  const c = document.createElement('canvas'); c.width = 300; c.height = 400;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 300, 400); x.fillStyle = '#000'; x.font = '28px sans-serif'; x.fillText('Nibvion Test', 40, 200);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  await call(blob, { enhance_mode: 2, crop_image: 0 });
  return true;
}
