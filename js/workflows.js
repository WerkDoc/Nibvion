// ================= 1-Tap-Workflows (eigene Makros) =================
// Mehrere vorhandene PDF-Werkzeuge nacheinander auf ein PDF anwenden – in beliebiger
// Reihenfolge, unter eigenem Namen gespeichert (settings → localStorage). Drei Vorlagen sind
// dabei. Ausführung mit Live-Fortschritt je Schritt; Ergebnis als Kopie oder ersetzt das Original.
// Workflows lassen sich auf der Startseite bei den Schnellwerkzeugen anpinnen.
import { icon } from './icons.js';
import { sheet, toast, haptic, esc, confirmDlg, promptDlg, fmtSize } from './ui.js';
import { settings } from './settings.js';
import { uid } from './db.js';
import { loadPdf, closePdf, pagesOp } from './pdfcore.js';
import { springFrames, reducedMotion } from './fx.js';

let ctx = {};
export function initWorkflows(c) { ctx = c; }

// ---------- Bausteine ----------
const seg = (k, label, choices) => ({ k, label, choices });
export const STEPS = {
  blank: {
    label: 'Leere Seiten entfernen', icon: 'pageBlank', c: 'c-violet', o: { level: 'normal' },
    ui: [seg('level', 'Erkennung', [['strict', 'Streng'], ['normal', 'Normal'], ['loose', 'Großzügig']])],
    async run(b, o, say) {
      const { analyzeAll, isBlank } = await import('./pageorder.js');
      const pdf = await loadPdf(b.slice());
      let an;
      try { an = await analyzeAll(pdf, (i, n) => say(`Seite ${i} von ${n} wird geprüft …`, i / n)); } finally { closePdf(pdf); }
      const keep = an.map((a, i) => isBlank(a, o.level) ? -1 : i).filter(i => i >= 0);
      if (keep.length === an.length) return { bytes: b, note: 'keine leeren Seiten' };
      if (!keep.length) return { bytes: b, note: 'alle Seiten leer – übersprungen' };
      const d = an.length - keep.length;
      return { bytes: await pagesOp(b, { order: keep.map(i => ({ i, rot: 0 })) }), note: `${d} ${d === 1 ? 'Seite' : 'Seiten'} entfernt` };
    },
  },
  a4: {
    label: 'Auf DIN A4 vereinheitlichen', icon: 'fit', c: 'c-blue', o: {},
    async run(b) { const { normalizeA4 } = await import('./pagetools.js'); return { bytes: await normalizeA4(b) }; },
  },
  ocr: {
    label: 'Text erkennen (OCR)', icon: 'scan', c: 'c-teal', o: {},
    async run(b, o, say) {
      const { ocrPdf } = await import('./ocr.js');
      const r = await ocrPdf(b, { onProgress: (t, x) => say(t, x) });
      return r.pages ? { bytes: r.bytes, note: `${r.pages} ${r.pages === 1 ? 'Seite' : 'Seiten'} gelesen` } : { bytes: b, note: 'enthält schon Text' };
    },
  },
  pagenum: {
    label: 'Seitenzahlen einfügen', icon: 'text', c: 'c-orange', o: { fmt: 'Seite n von N', pos: 'fC' },
    ui: [seg('fmt', 'Format', [['n/N', '1 / 10'], ['Seite n von N', 'Seite 1 von 10'], ['- n -', '- 1 -']]), seg('pos', 'Position', [['fL', 'Links'], ['fC', 'Mitte'], ['fR', 'Rechts']])],
    run: (b, o) => headerFooter(b, o.pos, { kind: o.fmt }),
  },
  date: {
    label: 'Datum oben einfügen', icon: 'calendar', c: 'c-amber', o: { pos: 'hR' },
    ui: [seg('pos', 'Position', [['hL', 'Links'], ['hC', 'Mitte'], ['hR', 'Rechts']])],
    run: (b, o) => headerFooter(b, o.pos, { kind: 'date' }),
  },
  compress: {
    label: 'Komprimieren', icon: 'compress', c: 'c-green', o: { level: 'standard' },
    ui: [seg('level', 'Stärke', [['leicht', 'Leicht'], ['standard', 'Standard'], ['stark', 'Stark']])],
    async run(b, o, say) {
      const { compressPdf } = await import('./tools.js');
      const r = await compressPdf(b, o.level, (i, n) => say(`Bild ${i} von ${n} wird verkleinert …`, i / n));
      const out = r.bytes;
      if (out.byteLength >= b.byteLength * 0.98) return { bytes: b, note: 'schon gut komprimiert' };
      return { bytes: out, note: `${fmtSize(b.byteLength)} → ${fmtSize(out.byteLength)}` };
    },
  },
  wm: {
    label: 'Wasserzeichen', icon: 'drop', c: 'c-violet', o: { text: 'KOPIE', color: 'grau' },
    ui: [seg('text', 'Text', [['KOPIE', 'KOPIE'], ['VERTRAULICH', 'VERTRAULICH'], ['ENTWURF', 'ENTWURF'], ['MUSTER', 'MUSTER']]), seg('color', 'Farbe', [['grau', 'Grau'], ['rot', 'Rot'], ['blau', 'Blau']])],
    async run(b, o) {
      const { addWatermark, WM_COLORS } = await import('./tools.js');
      return { bytes: await addWatermark(b, { text: o.text, color: WM_COLORS[o.color] || WM_COLORS.grau, opacity: 0.2, diagonal: true }) };
    },
  },
  fix: {
    label: 'Fixieren (schreibgeschützt)', icon: 'lock', c: 'c-red', o: {},
    async run(b, o, say) {
      const { fixatePdf } = await import('./fixate.js');
      const r = await fixatePdf(b, { onProgress: t => say(t) });
      return { bytes: r.bytes, note: r.fields || r.burned ? `${(r.fields || 0) + (r.burned || 0)} Elemente fest` : '' };
    },
  },
};
async function headerFooter(b, slot, def) {
  const { addHeaderFooter } = await import('./pagetools.js');
  const slots = { hL: { kind: 'none' }, hC: { kind: 'none' }, hR: { kind: 'none' }, fL: { kind: 'none' }, fC: { kind: 'none' }, fR: { kind: 'none' } };
  slots[slot] = def;
  return { bytes: await addHeaderFooter(b, { slots, size: 10, color: '#111318', bold: false, margin: 12, range: 'all', from: 1, to: 9999, countFromStart: false }) };
}

// ---------- Speicher ----------
const DEFAULTS = () => [
  { id: 'wf-scan', name: 'Scan aufräumen & komprimieren', steps: [{ id: 'blank', o: { level: 'normal' } }, { id: 'ocr', o: {} }, { id: 'compress', o: { level: 'standard' } }] },
  { id: 'wf-print', name: 'Druckfertig machen (A4 + Seitenzahlen)', steps: [{ id: 'blank', o: { level: 'strict' } }, { id: 'a4', o: {} }, { id: 'pagenum', o: { fmt: 'Seite n von N', pos: 'fC' } }] },
  { id: 'wf-contract', name: 'Vertrag versandfertig (Fixieren + Wasserzeichen)', steps: [{ id: 'fix', o: {} }, { id: 'date', o: { pos: 'hR' } }, { id: 'wm', o: { text: 'KOPIE', color: 'grau' } }, { id: 'compress', o: { level: 'leicht' } }] },
];
export function listWorkflows() {
  let l = settings.get('workflows');
  if (!Array.isArray(l)) { l = DEFAULTS(); settings.set('workflows', l); }
  return l.filter(w => w && Array.isArray(w.steps)).map(w => ({ ...w, steps: w.steps.filter(s => STEPS[s.id]) }));
}
const saveAll = l => settings.set('workflows', l);
export const pinned = () => { const ids = settings.get('wfPins') || []; return listWorkflows().filter(w => ids.includes(w.id)); };
const togglePin = id => {
  const ids = settings.get('wfPins') || [];
  const on = ids.includes(id);
  if (!on && ids.length >= 3) { toast('Höchstens 3 Workflows anpinnen'); return null; }
  settings.set('wfPins', on ? ids.filter(x => x !== id) : [...ids, id]);
  ctx.onPins?.();
  return !on;
};
const chain = w => w.steps.map(s => STEPS[s.id].label.replace(/ \(.*\)$/, '')).join(' → ');

// ---------- Übersicht ----------
export function workflowsSheet() {
  sheet({
    title: '1-Tap-Workflows',
    html: `<p class="wf-intro">Mehrere Werkzeuge nacheinander – mit einem Tipp. Reihenfolge und Einstellungen bestimmst du.</p>
      <div class="wf-list" data-list></div>
      <div class="btn-row"><button class="btn" data-new>${icon('plus')} Neuer Workflow</button></div>`,
    onMount(el, api) {
      const render = () => {
        const pins = settings.get('wfPins') || [];
        const l = listWorkflows();
        el.querySelector('[data-list]').innerHTML = l.length ? l.map((w, i) => `
          <div class="wf-card" data-id="${esc(w.id)}" style="animation-delay:${i * 40}ms">
            <div class="wf-steps">${w.steps.map(s => `<span class="wf-dot ${STEPS[s.id].c}">${icon(STEPS[s.id].icon)}</span>`).join('<i></i>')}</div>
            <div class="wf-main"><b>${esc(w.name)}</b><span>${esc(chain(w)) || 'Noch keine Schritte'}</span></div>
            <div class="wf-acts">
              <button class="wf-pin${pins.includes(w.id) ? ' on' : ''}" data-pin aria-label="Auf Startseite anpinnen">${icon('pin')}</button>
              <button data-edit aria-label="Bearbeiten">${icon('sliders')}</button>
              <button class="wf-play" data-run aria-label="Starten" ${w.steps.length ? '' : 'disabled'}>${icon('play')}</button>
            </div>
          </div>`).join('') : `<div class="empty" style="padding:22px">Noch keine Workflows</div>`;
        el.querySelectorAll('.wf-card').forEach(c => {
          const w = listWorkflows().find(x => x.id === c.dataset.id);
          c.querySelector('[data-run]').onclick = () => { haptic(); api.close(); runWorkflow(w); };
          c.querySelector('[data-edit]').onclick = () => { haptic(); editWorkflow(w, render); };
          c.querySelector('[data-pin]').onclick = e => { haptic(); const on = togglePin(w.id); if (on != null) { e.currentTarget.classList.toggle('on', on); toast(on ? 'Auf der Startseite angepinnt' : 'Von der Startseite entfernt'); } };
        });
      };
      el.querySelector('[data-new]').onclick = () => { haptic(); editWorkflow(null, render); };
      render();
    },
  });
}

// ---------- Bearbeiten ----------
function editWorkflow(w, onSaved) {
  const isNew = !w;
  const st = { id: w?.id || 'wf-' + uid(), name: w?.name || '', steps: (w?.steps || []).map(s => ({ id: s.id, o: { ...STEPS[s.id].o, ...s.o }, k: uid() })) };
  sheet({
    title: isNew ? 'Neuer Workflow' : 'Workflow bearbeiten',
    html: `<input class="field" data-name maxlength="60" placeholder="Name, z. B. „Rechnungen ablegen“" value="${esc(st.name)}">
      <div class="lbl">Schritte <span class="wf-hint">werden von oben nach unten ausgeführt</span></div>
      <div class="wf-edit" data-steps></div>
      <button class="wf-add" data-add>${icon('plus')} Schritt hinzufügen</button>
      <div class="btn-row">${isNew ? '' : `<button class="btn" data-more>${icon('more')}</button>`}<button class="btn primary" data-save>${icon('check')} Speichern</button></div>`,
    onMount(el, api) {
      const box = el.querySelector('[data-steps]');
      const render = (flash = null) => {
        box.innerHTML = st.steps.map((s, i) => {
          const d = STEPS[s.id];
          return `<div class="wf-row" data-k="${s.k}">
            <span class="wf-no">${i + 1}</span><span class="row-ic ${d.c}">${icon(d.icon)}</span>
            <div class="wf-rmain"><b>${d.label}</b>${(d.ui || []).map(u => `<div class="wf-opt"><span>${u.label}</span><div class="seg sm" data-opt="${u.k}">${u.choices.map(([v, t]) => `<button data-v="${esc(v)}" class="${s.o[u.k] === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>`).join('')}</div>
            <div class="wf-rbtn"><button data-up ${i ? '' : 'disabled'} aria-label="Nach oben">${icon('chevronUp')}</button><button data-dn ${i < st.steps.length - 1 ? '' : 'disabled'} aria-label="Nach unten">${icon('chevronDown')}</button><button data-del aria-label="Entfernen">${icon('trash')}</button></div>
          </div>`;
        }).join('') || `<div class="wf-empty">Noch keine Schritte – tippe auf „Schritt hinzufügen“.</div>`;
        box.querySelectorAll('.wf-row').forEach((r, i) => {
          const s = st.steps[i];
          r.querySelectorAll('[data-opt]').forEach(g => g.querySelectorAll('button').forEach(b => b.onclick = () => { s.o[g.dataset.opt] = b.dataset.v; haptic(); g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); }));
          r.querySelector('[data-up]').onclick = () => move(i, -1);
          r.querySelector('[data-dn]').onclick = () => move(i, 1);
          r.querySelector('[data-del]').onclick = () => { haptic(); st.steps.splice(i, 1); render(); };
        });
        if (flash && !reducedMotion()) {
          const r = box.querySelector(`[data-k="${flash}"]`);
          if (r?.animate) { const sp = springFrames({ stiffness: 520, damping: 22 }, v => ({ transform: `scale(${(0.94 + 0.06 * v).toFixed(4)})`, opacity: Math.min(1, v * 2) })); r.animate(sp.frames, { duration: sp.ms }); }
        }
      };
      const move = (i, d) => {
        const j = i + d; if (j < 0 || j >= st.steps.length) return;
        haptic();
        const rows = [...box.children], before = new Map(rows.map(r => [r.dataset.k, r.getBoundingClientRect().top]));
        [st.steps[i], st.steps[j]] = [st.steps[j], st.steps[i]];
        render();
        if (!reducedMotion()) box.querySelectorAll('.wf-row').forEach(r => { const t0 = before.get(r.dataset.k); if (t0 == null || !r.animate) return; const dy = t0 - r.getBoundingClientRect().top; if (Math.abs(dy) > 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.3,1.3,.5,1)' }); });
      };
      el.querySelector('[data-add]').onclick = () => {
        haptic();
        sheet({
          title: 'Schritt hinzufügen',
          html: `<div class="menu">${Object.entries(STEPS).map(([k, d]) => `<button class="row" data-s="${k}"><span class="row-ic ${d.c}">${icon(d.icon)}</span><span class="row-main"><span class="row-title">${d.label}</span></span>${icon('plus')}</button>`).join('')}</div>`,
          onMount(e2, a2) {
            e2.querySelectorAll('[data-s]').forEach(b => b.onclick = () => {
              const s = { id: b.dataset.s, o: { ...STEPS[b.dataset.s].o }, k: uid() };
              st.steps.push(s); a2.close(); render(s.k);
            });
          },
        });
      };
      el.querySelector('[data-more]')?.addEventListener('click', () => {
        sheet({
          title: st.name || 'Workflow',
          html: `<div class="menu"><button class="row" data-dup><span class="row-ic c-teal">${icon('copy')}</span><span class="row-main"><span class="row-title">Duplizieren</span></span></button>
            <button class="row" data-del><span class="row-ic c-red">${icon('trash')}</span><span class="row-main"><span class="row-title" style="color:var(--danger)">Löschen</span></span></button></div>`,
          onMount(e2, a2) {
            e2.querySelector('[data-dup]').onclick = async () => {
              a2.close();
              const n = await promptDlg('Kopie benennen', (el.querySelector('[data-name]').value.trim() || st.name) + ' (Kopie)');
              if (!n) return;
              const l = listWorkflows(); l.push({ id: 'wf-' + uid(), name: n, steps: st.steps.map(s => ({ id: s.id, o: s.o })) }); saveAll(l);
              api.close(); onSaved?.(); toast('Dupliziert');
            };
            e2.querySelector('[data-del]').onclick = async () => {
              a2.close();
              if (!(await confirmDlg('Workflow löschen?', `„${st.name}“ wird entfernt. Deine PDFs bleiben unverändert.`))) return;
              saveAll(listWorkflows().filter(x => x.id !== st.id));
              settings.set('wfPins', (settings.get('wfPins') || []).filter(x => x !== st.id)); ctx.onPins?.();
              api.close(); onSaved?.(); toast('Gelöscht');
            };
          },
        });
      });
      el.querySelector('[data-save]').onclick = () => {
        const name = el.querySelector('[data-name]').value.trim();
        if (!name) { el.querySelector('[data-name]').focus(); return toast('Bitte einen Namen eingeben'); }
        if (!st.steps.length) return toast('Füge mindestens einen Schritt hinzu');
        const l = listWorkflows(), w2 = { id: st.id, name, steps: st.steps.map(s => ({ id: s.id, o: s.o })) };
        const i = l.findIndex(x => x.id === st.id);
        if (i >= 0) l[i] = w2; else l.push(w2);
        saveAll(l); haptic(); api.close(); onSaved?.(); ctx.onPins?.();
        toast(isNew ? 'Workflow gespeichert' : 'Gespeichert');
      };
      render();
      if (isNew) setTimeout(() => el.querySelector('[data-name]').focus(), 350);
    },
  });
}

// ---------- Ausführen ----------
export function runWorkflow(w) {
  if (!w?.steps?.length) return toast('Dieser Workflow hat keine Schritte');
  ctx.docPicker(w.name, chain(w), d => runOn(w, d));
}

function runOn(w, d) {
  let copy = settings.get('wfCopy') ?? true, running = false, doneId = null;
  sheet({
    title: w.name,
    html: `<div class="wf-doc"><span class="doc-thumb" style="width:38px;height:50px;background-image:url('${d.thumb || ''}')"></span><div><b>${esc(d.name)}</b><span>${d.pages ? d.pages + ' Seiten · ' : ''}${fmtSize(d.size || 0)}</span></div></div>
      <div class="wf-prog"><div class="wf-bar"><i data-bar></i></div><span data-pct>0 %</span></div>
      <div class="wf-run" data-steps>${w.steps.map((s, i) => `<div class="wf-st" data-i="${i}"><span class="wf-state"></span><span class="row-ic ${STEPS[s.id].c}">${icon(STEPS[s.id].icon)}</span><div><b>${STEPS[s.id].label}</b><small data-msg>Wartet</small></div></div>`).join('')}</div>
      <div class="row wf-copy" style="padding:12px 2px 2px;border:0"><span class="row-main"><span class="row-title">Als Kopie speichern</span><span class="row-sub" style="display:block">Aus: Original wird ersetzt</span></span>
        <div class="seg" data-copy><button data-v="1" class="${copy ? 'on' : ''}">An</button><button data-v="0" class="${copy ? '' : 'on'}">Aus</button></div></div>
      <div class="btn-row"><button class="btn primary" data-go>${icon('play')} Starten</button></div>`,
    onMount(el, api) {
      const bar = el.querySelector('[data-bar]'), pct = el.querySelector('[data-pct]');
      el.querySelectorAll('[data-copy] button').forEach(b => b.onclick = () => { copy = b.dataset.v === '1'; settings.set('wfCopy', copy); el.querySelectorAll('[data-copy] button').forEach(x => x.classList.toggle('on', x === b)); });
      const go = el.querySelector('[data-go]');
      let shown = 0, target = 0, raf = 0;
      // Balken gleitet weich zum Zielwert (60 FPS, nur transform)
      const tickBar = () => {
        raf = 0; shown += (target - shown) * (reducedMotion() ? 1 : 0.18);
        if (Math.abs(target - shown) < 0.001) shown = target;
        bar.style.transform = `scaleX(${shown.toFixed(4)})`; pct.textContent = Math.round(shown * 100) + ' %';
        if (shown !== target) raf = requestAnimationFrame(tickBar);
      };
      const setP = p => { target = Math.max(target, Math.min(1, p)); if (!raf) raf = requestAnimationFrame(tickBar); };
      go.onclick = async () => {
        if (doneId) { api.close(); ctx.openDoc(doneId); return; }
        if (running) return;
        running = true; haptic(); go.disabled = true; go.innerHTML = `<span class="wf-spin"></span> Läuft …`;
        el.querySelector('.wf-copy').classList.add('off');
        el.classList.add('wf-running');
        const N = w.steps.length;
        let bytes;
        try {
          bytes = new Uint8Array(await ctx.docBytes(d));
          for (let i = 0; i < N; i++) {
            const s = w.steps[i], def = STEPS[s.id], row = el.querySelector(`.wf-st[data-i="${i}"]`), msg = row.querySelector('[data-msg]');
            row.classList.add('run'); msg.textContent = 'Läuft …';
            row.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
            const say = (t, f) => { if (t) msg.textContent = String(t).replace(/\s*…?$/, ' …'); if (typeof f === 'number' && isFinite(f)) setP((i + Math.max(0, Math.min(1, f))) / N); };
            setP(i / N + 0.02 / N);
            const r = await def.run(bytes, { ...def.o, ...s.o }, say);
            bytes = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
            row.classList.remove('run'); row.classList.add('ok'); msg.textContent = r.note || 'Fertig';
            setP((i + 1) / N);
            await new Promise(res => setTimeout(res, 60));
          }
          const id = await ctx.storeResult(d, bytes, w.name.replace(/\s*\(.*\)\s*$/, ''), copy);
          await ctx.renderRecents();
          doneId = id; haptic();
          go.disabled = false; go.innerHTML = `${icon('eye')} Öffnen`;
          el.classList.add('wf-done');
          toast(`Fertig · ${fmtSize(bytes.byteLength)}`);
        } catch (e) {
          console.error(e);
          const row = el.querySelector('.wf-st.run'); if (row) { row.classList.remove('run'); row.classList.add('err'); row.querySelector('[data-msg]').textContent = 'Fehlgeschlagen – PDF bleibt unverändert'; }
          go.disabled = false; go.innerHTML = `${icon('x')} Schließen`; go.onclick = () => api.close();
          toast('Workflow abgebrochen', true);
        } finally { running = false; }
      };
    },
  });
}
