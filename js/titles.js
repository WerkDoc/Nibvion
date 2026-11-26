// ================= Smart-Umbenennen („Titel vorschlagen“) =================
// Liest die erste Seite über pdf.js: größte/oberste Überschrift + erkannte Dokumentart
// (Rechnung, Angebot, Vertrag …) mit Nummer, Absender-Firma und Datum → saubere Dateinamen.
import { icon } from './icons.js';
import { sheet, esc, haptic } from './ui.js';
import { pageLines } from './reader.js';

const TYPES = ['Verdienstabrechnung', 'Gehaltsabrechnung', 'Lohnabrechnung', 'Auftragsbestätigung', 'Kostenvoranschlag', 'Reparaturauftrag', 'Arbeitsvertrag', 'Mietvertrag',
  'Kaufvertrag', 'Gutschrift', 'Rechnung', 'Angebot', 'Lieferschein', 'Mahnung', 'Zahlungserinnerung', 'Quittung', 'Kündigung', 'Bescheid', 'Kontoauszug', 'Bestellung',
  'Bestellbestätigung', 'Garantie', 'Vollmacht', 'Bewerbung', 'Zeugnis', 'Protokoll', 'Vertrag', 'Invoice', 'Receipt', 'Offer'];
const LEGAL = /\b(GmbH(?:\s*&\s*Co\.?\s*KG)?|UG(?:\s*\(haftungsbeschränkt\))?|AG|KG|OHG|e\.\s?K\.|e\.\s?V\.|GbR|Ltd\.?|Inc\.?|LLC|S\.A\.|B\.V\.|SE)\b/;

export function cleanName(s) {
  return String(s || '')
    .replace(/\s*:\s+/g, ' – ')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s\-–_.,;]+|[\s\-–_.,;:]+$/g, '')
    .slice(0, 80).trim();
}
const isoDate = s => { const m = s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/); if (!m) return ''; const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; };

/** Vorschläge für die erste Seite → string[] (bestes zuerst) */
export async function suggestTitles(pdf) {
  const { lines, h } = await pageLines(pdf, 1);
  if (!lines.length) return [];
  const out = [];
  const full = lines.map(l => l.text).join('\n');
  // 1) Dokumentart mit Nummer / Firma / Datum
  const type = TYPES.find(t => new RegExp(`\\b${t}\\b`, 'i').test(full));
  if (type) {
    const num = full.match(new RegExp(`(?:${type}s?|Beleg|Auftrags|Angebots|Vertrags|Kunden)?[-\\s]*(?:nummer|nr\\.?|no\\.?)\\s*[:#.]?\\s*([A-Z0-9][A-Z0-9\\-/.]{2,24})`, 'i'))?.[1]
      || full.match(new RegExp(`\\b${type}\\s*[:#]?\\s*([A-Z]{0,4}[-]?\\d[\\d\\-/.]{2,20})`, 'i'))?.[1];
    const firm = lines.map(l => l.text).find(t => LEGAL.test(t) && t.length < 90);
    let company = firm ? firm.split(/\s+[|·•]\s+|,\s+/)[0].replace(/\(haftungsbeschränkt\)/i, '').replace(LEGAL, '').replace(/\s+/g, ' ').trim() : '';
    if (company.split(' ').length > 4) company = company.split(' ').slice(0, 3).join(' ');
    const date = isoDate(full.match(new RegExp(`(?:${type}s?datum|Datum|vom)\\s*[:]?\\s*(\\d{1,2}\\.\\d{1,2}\\.\\d{2,4})`, 'i'))?.[1] || full);
    const label = type[0].toUpperCase() + type.slice(1);
    if (company && date) out.push(`${label} ${company} ${date}`);
    if (num) out.push(`${label} ${num.replace(/[.]+$/, '')}${company ? ' ' + company : ''}`);
    if (!company && date) out.push(`${label} ${date}`);
  }
  // 2) Größte Überschrift im oberen Teil (bis zu 2 Zeilen gleicher Größe)
  const cand = lines.filter(l => l.y < h * 0.7 && /[A-Za-zÄÖÜäöü]{3}/.test(l.text) && !/^\d/.test(l.text) && l.text.length < 120);
  if (cand.length) {
    const maxS = Math.max(...cand.map(l => l.size));
    const body = cand.map(l => l.size).sort((a, b) => a - b)[Math.floor(cand.length / 2)];
    const heads = cand.filter(l => l.size >= maxS * 0.95).sort((a, b) => a.y - b.y);
    let t = heads[0].text;
    const nx = heads[1];
    if (nx && nx.y - heads[0].y < heads[0].size * 1.8 && (t + ' ' + nx.text).length < 90) t += ' ' + nx.text;
    if (maxS > body * 1.15 || !out.length) out.push(t);
    // zweitgrößte Überschrift (z. B. wenn die größte nur ein Logo-Schriftzug ist)
    const second = cand.filter(l => l.size < maxS * 0.95 && l.size > body * 1.2).sort((a, b) => b.size - a.size || a.y - b.y)[0];
    if (second) out.push(heads[0].text.split(' ').length <= 2 ? `${second.text} ${heads[0].text}` : second.text);
  }
  // 3) Erste sinnvolle Zeile
  const first = lines.find(l => l.text.length > 8 && /[A-Za-zÄÖÜäöü]{4}/.test(l.text) && !LEGAL.test(l.text));
  if (first) out.push(first.text);
  return [...new Set(out.map(cleanName).filter(s => s.length >= 3))].slice(0, 4);
}

/**
 * Umbenennen-Dialog mit „Titel vorschlagen“.
 * getPdf: async () => ({ pdf, done() })  → resolve(neuer Name ohne .pdf | null)
 */
export function renameSheet(value, getPdf, { title = 'Umbenennen', okLabel = 'Speichern' } = {}) {
  return new Promise(res => {
    let out = null;
    sheet({
      title,
      html: `<input class="field" data-in value="${esc(value)}" autocomplete="off">
        <button class="ts-btn" data-sug>${icon('wand')}<span>Titel vorschlagen</span></button>
        <div class="ts-list" data-list></div>
        <div class="btn-row"><button class="btn" data-c>Abbrechen</button><button class="btn primary" data-ok>${esc(okLabel)}</button></div>`,
      onMount(el, api) {
        const inp = el.querySelector('[data-in]'), list = el.querySelector('[data-list]'), btn = el.querySelector('[data-sug]');
        setTimeout(() => { inp.focus(); inp.select(); }, 350);
        const ok = () => { out = cleanName(inp.value); api.close(); };
        inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
        el.querySelector('[data-c]').onclick = () => api.close();
        el.querySelector('[data-ok]').onclick = ok;
        btn.onclick = async () => {
          haptic(); btn.classList.add('busy'); btn.disabled = true;
          let sug = [];
          try { const { pdf, done } = await getPdf(); try { sug = await suggestTitles(pdf); } finally { done?.(); } } catch (e) { console.warn(e); }
          btn.classList.remove('busy'); btn.disabled = false;
          if (!sug.length) { list.innerHTML = `<p class="ts-none">Kein Text auf der ersten Seite gefunden – bei Scans zuerst „Text erkennen (OCR)“.</p>`; return; }
          list.innerHTML = sug.map((s, i) => `<button class="ts-chip" data-s="${i}" style="animation-delay:${i * 50}ms">${icon('sparkles')}<span>${esc(s)}</span></button>`).join('');
          list.querySelectorAll('[data-s]').forEach(b => b.onclick = () => {
            haptic(); inp.value = sug[+b.dataset.s];
            list.querySelectorAll('.ts-chip').forEach(x => x.classList.toggle('on', x === b));
          });
          // ersten Vorschlag direkt übernehmen
          inp.value = sug[0]; list.firstElementChild.classList.add('on');
        };
      },
      onClose: () => res(out || null),
    });
  });
}
