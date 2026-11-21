// ================= Erkannter Text: ansehen, korrigieren, kopieren, teilen =================
import { icon } from './icons.js';
import { sheet, toast, esc, haptic } from './ui.js';
import { downloadBytes } from './editor.js';

export function textSheet(pages, name = 'Text') {
  const multi = pages.length > 1;
  const full = pages.map((t, i) => (multi ? `— Seite ${i + 1} —\n` : '') + (t || '').trim()).join('\n\n').trim();
  sheet({
    title: 'Erkannter Text',
    html: `
      <div class="tv-meta" data-meta></div>
      <textarea class="field tv-area no-swipe" data-t spellcheck="false">${esc(full)}</textarea>
      <div class="tv-actions">
        <button class="tv-btn" data-copy>${icon('copyText')}<span>Kopieren</span></button>
        <button class="tv-btn" data-share>${icon('share')}<span>Teilen</span></button>
        <button class="tv-btn" data-txt>${icon('download')}<span>Als .txt</span></button>
      </div>`,
    onMount(el) {
      const ta = el.querySelector('[data-t]'), meta = el.querySelector('[data-meta]');
      const upd = () => {
        const t = ta.value.trim();
        const words = t ? t.split(/\s+/).length : 0;
        meta.textContent = t ? `${words} Wörter · ${t.length} Zeichen${multi ? ` · ${pages.length} Seiten` : ''} · Antippen zum Korrigieren` : 'Kein Text erkannt';
      };
      ta.oninput = upd; upd();
      el.querySelector('[data-copy]').onclick = async () => {
        try { await navigator.clipboard.writeText(ta.value); }
        catch { ta.focus(); ta.select(); document.execCommand('copy'); ta.blur(); }
        haptic(); toast('Text kopiert');
      };
      el.querySelector('[data-share]').onclick = async () => {
        if (navigator.share) { try { await navigator.share({ text: ta.value, title: name }); } catch {} }
        else { try { await navigator.clipboard.writeText(ta.value); toast('Text kopiert'); } catch {} }
      };
      el.querySelector('[data-txt]').onclick = () => {
        const bytes = new TextEncoder().encode(ta.value);
        const fname = name.replace(/\.pdf$/i, '') + '.txt';
        const file = new File([bytes], fname, { type: 'text/plain' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file] }).catch(() => {});
        else downloadBytes(bytes, fname, 'text/plain');
      };
    },
  });
}
