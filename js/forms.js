// ================= Formular ausfüllen (echte PDF-Formularfelder / AcroForm) =================
// Felder werden mit pdf.js erkannt (Lage, Typ, Optionen) und auf der Seite angezeigt.
// Gespeichert wird mit pdf-lib in die echten Felder – die PDF bleibt ein ausfüllbares Formular
// (oder wird auf Wunsch fixiert, dann sind die Eingaben fest im Dokument).
import { icon } from './icons.js';
import { toast, busy, sheet, esc, haptic } from './ui.js';
import { loadPdf, closePdf, pdfjsLib } from './pdfcore.js';

const L = () => window.PDFLib;

// Alle Felder aller Seiten: { name, type: text|check|radio|choice|sig, page, rect (normiert), … }
export async function readFields(pdf) {
  const fields = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    let anns = [];
    try { anns = await p.getAnnotations({ intent: 'display' }); } catch {}
    for (const a of anns) {
      if (a.subtype !== 'Widget' || !a.fieldName || a.hidden) continue;
      const t = vp.transform, tp = (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
      const [ax, ay] = tp(a.rect[0], a.rect[1]), [bx, by] = tp(a.rect[2], a.rect[3]);
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      const f = {
        name: a.fieldName, page: i - 1, readOnly: !!a.readOnly,
        rect: { x: x0 / vp.width, y: y0 / vp.height, w: (x1 - x0) / vp.width, h: (y1 - y0) / vp.height },
        ptH: y1 - y0, label: (a.alternativeText || a.fieldName.split('.').pop() || '').trim(),
      };
      if (a.fieldType === 'Tx') { f.type = 'text'; f.multi = !!a.multiLine; f.maxLen = a.maxLen || 0; f.value = typeof a.fieldValue === 'string' ? a.fieldValue : ''; f.comb = !!a.comb; }
      else if (a.fieldType === 'Btn' && a.checkBox) { f.type = 'check'; f.on = a.exportValue || 'Yes'; f.value = !!a.fieldValue && a.fieldValue !== 'Off'; }
      else if (a.fieldType === 'Btn' && a.radioButton) { f.type = 'radio'; f.on = a.buttonValue; f.value = a.fieldValue && a.fieldValue !== 'Off' ? a.fieldValue : null; }
      else if (a.fieldType === 'Ch') {
        f.type = 'choice'; f.options = (a.options || []).map(o => ({ v: o.exportValue, t: o.displayValue ?? o.exportValue }));
        const fv = Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue; f.value = fv || '';
      }
      else if (a.fieldType === 'Sig') f.type = 'sig';
      else continue;
      fields.push(f);
    }
    p.cleanup();
  }
  // Lesereihenfolge: Seite, dann von oben nach unten, links nach rechts
  fields.sort((a, b) => a.page - b.page || (Math.abs(a.rect.y - b.rect.y) > 0.008 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x));
  return fields;
}

// Werte (nach Feldname) in die PDF schreiben
export async function writeFields(bytes, values, { flatten = false } = {}) {
  const { PDFDocument, StandardFonts, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = L();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const clean = s => { let o = ''; for (const ch of String(s ?? '').replace(/\r\n?/g, '\n')) { if (ch === '\n') { o += ch; continue; } try { font.encodeText(ch); o += ch; } catch { o += ch === '\t' ? ' ' : ''; } } return o; };
  let set = 0, failed = 0;
  for (const [name, v] of Object.entries(values)) {
    let f; try { f = form.getField(name); } catch { failed++; continue; }
    try {
      if (f instanceof PDFTextField) {
        let t = clean(v);
        const ml = f.getMaxLength(); if (ml && t.length > ml) t = t.slice(0, ml);
        // „Automatische“ Schriftgröße (0) macht bei mehrzeiligen Feldern riesige Schrift → feste Größe setzen
        const da = f.acroField.getDefaultAppearance?.() || '';
        const m = da.match(/([\d.]+)\s+Tf/);
        let hgt = 20; try { hgt = f.acroField.getWidgets()[0].getRectangle().height; } catch {}
        const multi = f.isMultiline(), sz = m ? +m[1] : 0;
        if (t && (!sz || sz > (multi ? 14 : hgt * 0.85))) {
          try { f.setFontSize(multi ? Math.min(10, Math.max(6, hgt * 0.6)) : Math.max(6, Math.min(12, hgt * 0.65))); } catch {}
        }
        f.setText(t || undefined);
      } else if (f instanceof PDFCheckBox) v ? f.check() : f.uncheck();
      else if (f instanceof PDFRadioGroup) { if (v) f.select(v); else f.clear(); }
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        if (!v) f.clear();
        else { try { f.select(v); } catch { f.select(clean(v)); } }
      } else continue;
      set++;
    } catch (e) { console.warn('Feld', name, e); failed++; }
  }
  try { form.updateFieldAppearances(font); } catch (e) { console.warn(e); }
  if (flatten) { try { form.flatten({ updateFieldAppearances: false }); } catch (e) { console.warn('Fixieren', e); } }
  return { bytes: await doc.save(), set, failed };
}

// ---------- Oberfläche ----------
// ctx: { docBytes, storeResult, renderRecents, openDoc }
export async function formSheet(d, ctx) {
  if (!d) return;
  busy(true, 'Formularfelder werden gesucht …');
  let bytes, pdf, fields;
  try { bytes = await ctx.docBytes(d); pdf = await loadPdf(bytes); fields = await readFields(pdf); }
  catch (e) { console.error(e); busy(false); closePdf(pdf); return toast('PDF konnte nicht gelesen werden', true); }
  busy(false);
  const editable = fields.filter(f => !f.readOnly && f.type !== 'sig');
  if (!editable.length) {
    closePdf(pdf);
    return sheet({
      title: 'Formular ausfüllen',
      html: `<div class="prot-ic">${icon('form')}</div>
        <p style="color:var(--text2);margin:0 6px 6px;line-height:1.45;text-align:center;font-size:14px">„${esc(d.name)}“ hat keine ausfüllbaren Formularfelder. Mit <b style="color:var(--text)">Füllen &amp; unterschreiben</b> kannst du trotzdem Text, Häkchen und Datum frei auf die Seite setzen.</p>
        <div class="btn-row"><button class="btn primary" data-ok>${icon('sign')} Füllen &amp; unterschreiben</button></div>`,
      onMount(el, api) { el.querySelector('[data-ok]').onclick = () => { api.close(); ctx.openDoc(d.id, 'sign'); }; },
    });
  }

  // Werte je Feldname (Felder mit gleichem Namen teilen den Wert)
  const values = {};
  for (const f of fields) {
    if (f.type === 'radio') { if (f.value != null || !(f.name in values)) values[f.name] = f.value ?? values[f.name] ?? null; }
    else if (!(f.name in values)) values[f.name] = f.value;
  }
  const start = JSON.stringify(values);
  const N = pdf.numPages;
  let cur = editable[0].page, active = null, copy = true, fix = false;
  const cache = new Map();

  sheet({
    title: 'Formular ausfüllen',
    html: `<p style="color:var(--text2);margin:0 2px 10px;font-size:14px;line-height:1.4"><b style="color:var(--text)">${editable.length}</b> ${editable.length === 1 ? 'Feld' : 'Felder'} gefunden. Tippe ein Feld an – Kästchen werden direkt angehakt.</p>
      <div class="rd-stage"><div class="fm-wrap"><canvas data-cv class="rd-canvas fm-canvas"></canvas></div></div>
      <div class="rd-nav">
        <button class="rd-nb" data-prev>${icon('chevronLeft')}</button>
        <span data-info></span>
        <button class="rd-nb" data-next>${icon('chevronRight')}</button>
      </div>
      <div class="fm-panel" data-panel hidden></div>
      <div class="row" style="padding:12px 2px 2px;border:0"><span class="row-main"><span class="row-title">Als Kopie speichern</span><span class="row-sub" style="display:block">Das leere Formular bleibt erhalten</span></span>
        <div class="seg" data-copy><button data-v="1" class="on">An</button><button data-v="0">Aus</button></div></div>
      <div class="row" style="padding:12px 2px 2px;border:0"><span class="row-main"><span class="row-title">Formular fixieren</span><span class="row-sub" style="display:block">Eingaben fest einbrennen, nicht mehr änderbar</span></span>
        <div class="seg" data-fix><button data-v="0" class="on">Aus</button><button data-v="1">An</button></div></div>
      <div class="btn-row"><button class="btn primary" data-ok>${icon('check')} Formular speichern</button></div>`,
    onClose: () => closePdf(pdf),
    onMount(el, api) {
      const cv = el.querySelector('[data-cv]'), g = cv.getContext('2d');
      const info = el.querySelector('[data-info]'), panel = el.querySelector('[data-panel]');
      let base = null, renderId = 0;

      const pageImg = async i => {
        if (cache.has(i)) return cache.get(i);
        const p = await pdf.getPage(i + 1);
        const v = p.getViewport({ scale: 1 });
        const s = Math.min(1400 / v.width, 1800 / v.height);
        const vp = p.getViewport({ scale: s });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        // Felder selbst zeichnen wir – deshalb ohne Formular-Darstellung rendern
        await p.render({ canvasContext: x, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
        cache.set(i, { c, s });
        return cache.get(i);
      };

      const fitText = (t, w, size) => { g.font = `${size}px Helvetica, Arial, sans-serif`; while (size > 6 && g.measureText(t).width > w) { size -= 0.5; g.font = `${size}px Helvetica, Arial, sans-serif`; } return size; };
      const draw = () => {
        if (!base) return;
        g.drawImage(base.c, 0, 0);
        const W = cv.width, H = cv.height, sc = base.s;
        for (const f of fields) {
          if (f.page !== cur) continue;
          const x = f.rect.x * W, y = f.rect.y * H, w = f.rect.w * W, h = f.rect.h * H;
          const on = active === f, ro = f.readOnly || f.type === 'sig';
          g.fillStyle = ro ? 'rgba(130,130,140,.10)' : on ? 'rgba(255,106,91,.20)' : 'rgba(80,140,255,.13)';
          g.fillRect(x, y, w, h);
          g.lineWidth = on ? Math.max(3, W / 300) : Math.max(1.5, W / 700);
          g.strokeStyle = on ? '#ff6a5b' : ro ? 'rgba(130,130,140,.5)' : 'rgba(80,140,255,.55)';
          g.strokeRect(x, y, w, h);
          const v = values[f.name];
          g.fillStyle = '#10142a'; g.textBaseline = 'middle';
          if (f.type === 'text' && v) {
            const lines = f.multi ? String(v).split('\n') : [String(v).replace(/\n/g, ' ')];
            let size = Math.min(12 * sc, (f.multi ? Math.min(h, 14 * sc * 1.25) : h) * 0.72);
            if (f.comb && f.maxLen) {
              size = fitText('M', w / f.maxLen, size); const cw = w / f.maxLen;
              [...String(v)].slice(0, f.maxLen).forEach((ch, k) => { g.textAlign = 'center'; g.fillText(ch, x + cw * (k + 0.5), y + h / 2); });
              g.textAlign = 'left';
            } else if (f.multi) {
              g.font = `${size}px Helvetica, Arial, sans-serif`;
              let yy = y + size * 0.75;
              for (const ln of lines) { if (yy > y + h) break; g.fillText(ln, x + 2 * sc, yy, w - 4 * sc); yy += size * 1.2; }
            } else { size = fitText(lines[0], w - 4 * sc, size); g.fillText(lines[0], x + 2 * sc, y + h / 2); }
          } else if (f.type === 'check' && v) {
            g.strokeStyle = '#10142a'; g.lineWidth = Math.max(2, Math.min(w, h) * 0.13);
            g.beginPath(); g.moveTo(x + w * 0.2, y + h * 0.52); g.lineTo(x + w * 0.42, y + h * 0.76); g.lineTo(x + w * 0.8, y + h * 0.24); g.stroke();
          } else if (f.type === 'radio' && v != null && v === f.on) {
            g.beginPath(); g.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.27, 0, Math.PI * 2); g.fill();
          } else if (f.type === 'choice' && v) {
            const t = f.options.find(o => o.v === v)?.t ?? v;
            const size = fitText(t, w - 4 * sc, Math.min(12 * sc, h * 0.72)); void size; g.fillText(t, x + 2 * sc, y + h / 2);
          }
        }
        const here = editable.filter(f => f.page === cur).length;
        const filled = new Set(editable.filter(f => { const v = values[f.name]; return f.type === 'check' ? v : v != null && v !== ''; }).map(f => f.name)).size;
        const total = new Set(editable.map(f => f.name)).size;
        info.innerHTML = `Seite ${cur + 1} / ${N}<small>${here} ${here === 1 ? 'Feld' : 'Felder'} hier · ${filled} von ${total} ausgefüllt</small>`;
        el.querySelector('[data-prev]').disabled = cur === 0;
        el.querySelector('[data-next]').disabled = cur === N - 1;
      };
      const show = async i => {
        cur = i; const id = ++renderId;
        info.innerHTML = `Seite ${cur + 1} / ${N}<small>wird geladen …</small>`;
        const b = await pageImg(i);
        if (id !== renderId) return;
        base = b; cv.width = b.c.width; cv.height = b.c.height;
        cv.classList.remove('pop'); void cv.offsetWidth; cv.classList.add('pop');
        draw();
      };

      // Bearbeitungsfeld unter der Seite
      const openPanel = f => {
        active = f; draw();
        if (f.type === 'check' || f.type === 'radio') { panel.hidden = true; return; }
        const idx = editable.indexOf(f);
        const nav = `<div class="fm-btns"><button class="btn" data-back ${idx <= 0 ? 'disabled' : ''}>${icon('chevronLeft')} Zurück</button><button class="btn primary" data-fwd>${idx >= editable.length - 1 ? 'Fertig' : `Weiter ${icon('chevronRight')}`}</button></div>`;
        if (f.type === 'text') {
          panel.innerHTML = `<div class="fm-lbl">${esc(f.label || 'Textfeld')}</div>
            ${f.multi ? `<textarea class="field" data-v rows="3"></textarea>` : `<input class="field" data-v ${f.maxLen ? `maxlength="${f.maxLen}"` : ''} autocomplete="off">`}${nav}`;
          const inp = panel.querySelector('[data-v]');
          inp.value = values[f.name] || '';
          inp.oninput = () => { values[f.name] = inp.value; draw(); };
          inp.onkeydown = e => { if (e.key === 'Enter' && !f.multi) { e.preventDefault(); step(1); } };
          setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch { inp.focus(); } }, 60);
        } else if (f.type === 'choice') {
          panel.innerHTML = `<div class="fm-lbl">${esc(f.label || 'Auswahl')}</div>
            <div class="chips no-swipe fm-opts">${[{ v: '', t: '–' }, ...f.options].map(o => `<button class="chip ${values[f.name] === o.v ? 'on' : ''}" data-o="${esc(o.v)}">${esc(o.t || '–')}</button>`).join('')}</div>${nav}`;
          panel.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { values[f.name] = b.dataset.o; haptic(); panel.querySelectorAll('[data-o]').forEach(x => x.classList.toggle('on', x === b)); draw(); });
        } else if (f.type === 'sig') {
          panel.innerHTML = `<div class="fm-lbl">Unterschriftsfeld</div><p class="fm-hint">Unterschreiben kannst du nach dem Speichern mit „Füllen &amp; unterschreiben“.</p>${nav}`;
        }
        panel.hidden = false;
        panel.querySelector('[data-back]').onclick = () => step(-1);
        panel.querySelector('[data-fwd]').onclick = () => step(1);
        requestAnimationFrame(() => panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      };
      const step = async dir => {
        const i = editable.indexOf(active) + dir;
        if (i < 0) return;
        if (i >= editable.length) { active = null; panel.hidden = true; draw(); return toast('Alle Felder durchgegangen'); }
        const f = editable[i];
        if (f.page !== cur) await show(f.page);
        openPanel(f);
      };

      const hit = e => {
        const r = cv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        const tol = 6 / r.width;
        let best = null, bd = 1e9;
        for (const f of fields) {
          if (f.page !== cur) continue;
          const q = f.rect;
          if (x < q.x - tol || x > q.x + q.w + tol || y < q.y - tol || y > q.y + q.h + tol) continue;
          const dd = Math.hypot(x - (q.x + q.w / 2), y - (q.y + q.h / 2));
          if (dd < bd) { bd = dd; best = f; }
        }
        return best;
      };
      cv.addEventListener('click', e => {
        const f = hit(e);
        if (!f) { active = null; panel.hidden = true; draw(); return; }
        if (f.readOnly) return toast('Dieses Feld ist schreibgeschützt', true);
        haptic();
        if (f.type === 'check') { values[f.name] = !values[f.name]; active = f; panel.hidden = true; draw(); return; }
        if (f.type === 'radio') { values[f.name] = values[f.name] === f.on ? null : f.on; active = f; panel.hidden = true; draw(); return; }
        openPanel(f);
      });

      el.querySelector('[data-prev]').onclick = () => { if (cur > 0) { active = null; panel.hidden = true; show(cur - 1); } };
      el.querySelector('[data-next]').onclick = () => { if (cur < N - 1) { active = null; panel.hidden = true; show(cur + 1); } };
      const seg = (sel, setv) => el.querySelectorAll(`${sel} button`).forEach(b => b.onclick = () => { setv(b.dataset.v === '1'); el.querySelectorAll(`${sel} button`).forEach(x => x.classList.toggle('on', x === b)); });
      seg('[data-copy]', v => { copy = v; });
      seg('[data-fix]', v => { fix = v; });

      el.querySelector('[data-ok]').onclick = async () => {
        if (JSON.stringify(values) === start && !fix) return toast('Noch nichts ausgefüllt', true);
        api.close(); busy(true, 'Formular wird gespeichert …');
        try {
          const res = await writeFields(bytes, values, { flatten: fix });
          const id = await ctx.storeResult(d, res.bytes, 'ausgefüllt', copy);
          busy(false); await ctx.renderRecents();
          toast(res.failed ? `Gespeichert – ${res.failed} ${res.failed === 1 ? 'Feld' : 'Felder'} nicht übernommen` : 'Formular gespeichert', !!res.failed);
          ctx.openDoc(id);
        } catch (e) { console.error(e); busy(false); toast('Speichern fehlgeschlagen', true); }
      };
      show(cur);
    },
  });
}
