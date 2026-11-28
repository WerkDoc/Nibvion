// ================= Bedienung am PC (Maus & Tastatur) =================
// Greift nur auf Geräten mit Maus (hover + feiner Zeiger) – am iPhone passiert hier nichts.
// - Klasse .desk an <html> (CSS: Layout für breite Fenster, Hover, schmale Scrollbalken)
// - Dateien per Drag & Drop ins Fenster ziehen (wie „Öffnen mit“ / Teilen → incoming.js)
// - Tastenkürzel: Strg+O öffnen, Strg+F suchen, Esc schließt das oberste Menü
import { icon } from './icons.js';
import { closeTopSheet } from './ui.js';
import { handleFiles } from './incoming.js';

export const isDesk = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

export function initDesk({ importPdfs, search }) {
  if (!isDesk()) return;
  document.documentElement.classList.add('desk');
  const sub = document.querySelector('.hero-sub');
  if (sub) sub.textContent = 'Vom PC öffnen oder hierher ziehen';

  // ---------- Drag & Drop ----------
  const ov = document.createElement('div');
  ov.className = 'drop-ov';
  ov.innerHTML = `<div>${icon('filePlus')}<b>Loslassen zum Öffnen</b><span>PDF, Bilder, Word, Excel, PowerPoint</span></div>`;
  document.body.appendChild(ov);
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  const hide = () => { depth = 0; ov.classList.remove('show'); };
  addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; ov.classList.add('show'); });
  addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--depth <= 0) hide(); });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); hide();
    const files = [...e.dataTransfer.files];
    if (files.length) handleFiles(files);
  });

  // ---------- Tastenkürzel ----------
  addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (!e.defaultPrevented && closeTopSheet()) e.preventDefault(); return; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (document.body.classList.contains('in-editor')) return;   // im Editor gelten dessen Tasten
    const k = e.key.toLowerCase();
    const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
    if (k === 'o') { e.preventDefault(); importPdfs(); }
    if (k === 'f' && !typing) { e.preventDefault(); search(); }
  });
}
