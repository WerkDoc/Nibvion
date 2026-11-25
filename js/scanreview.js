// ================= Scan-Ansicht (Vollbild) =================
// Große Seitenvorschau zum Durchwischen, Filter mit Vorschau, Regler, Werkzeugleiste.
// Schließen/Herunterwischen fragt „Verwerfen / Weiter bearbeiten“.
import { icon } from './icons.js';
import { sheet, toast, busy, haptic, pickFiles, spinRotate, imgLoaded } from './ui.js';
import { render as renderScan, enhance, FILTERS, cropEditor, detectCorners, loadFileImage, FULL } from './scanner.js';
import { liveScanner, cameraSupported } from './camera.js';
import { ensureAI, edgeCut, aiPref, setAiPref, aiLoaded } from './ai.js';
import { ensureEnhance, enhReady, enhLoaded } from './aienhance.js';
import { ensureOnline, onlineDone, onlineReady } from './online.js';

const BIG = 1400;                       // Kantenlänge der großen Vorschau
const tick = () => new Promise(r => setTimeout(r, 16));

function discardDlg() {
  return new Promise(res => {
    let v = false;
    sheet({
      title: 'Scan verwerfen?',
      html: `<p style="color:var(--text2);margin:0 2px 6px;line-height:1.45">Die gescannten Seiten wurden noch nicht als PDF gespeichert.</p>
        <div class="btn-row"><button class="btn" data-k>Weiter bearbeiten</button><button class="btn danger" data-d>Verwerfen</button></div>`,
      onMount(el, api) {
        el.querySelector('[data-k]').onclick = () => api.close();
        el.querySelector('[data-d]').onclick = () => { v = true; api.close(); };
      },
      onClose: () => res(v),
    });
  });
}

/**
 * opts: { kind: 'scan'|'images', items, filter, ocrOn, onSave(items, filter, adj, ocrOn), onText(items, filter, adj), onFilter(f), onOcr(v) }
 */
export function scanReview(opts) {
  const { kind } = opts;
  const items = opts.items;
  let filter = opts.filter ?? null;
  let ocrOn = !!opts.ocrOn;
  const adj = { brightness: 0, contrast: 0, sharp: 0 };
  let cur = 0, panel = 'filter', liveFailed = !!opts.liveFailed, closed = false;

  const wrap = document.createElement('div');
  wrap.className = 'rv-wrap';
  wrap.innerHTML = `
    <div class="rv-top">
      <div class="rv-grab"></div>
      <button class="rv-round" data-x aria-label="Schließen">${icon('x')}</button>
      <div class="rv-count" data-count></div>
      <button class="rv-save" data-save>${icon('check')} PDF</button>
    </div>
    <div class="rv-stage no-swipe" data-stage></div>
    <div class="rv-panel">
      <div class="rv-tabs">
        <div class="seg" data-tabs><button data-p="filter" class="on">Filter</button><button data-p="adj">Anpassen</button></div>
        <div class="rv-chips">
          <button class="rv-chip" data-ai aria-label="KI-Glätten">${icon('sparkles')}<span>KI</span></button>
          ${kind === 'scan' ? `<button class="rv-chip" data-ocr>${icon('textScan')}<span>Text erkennen</span></button>` : ''}
        </div>
      </div>
      <div class="flt-row no-swipe" data-flt></div>
      <div class="rv-adj" data-adj hidden>
        ${[['brightness', 'Helligkeit', -50, 50], ['contrast', 'Kontrast', -50, 50], ['sharp', 'Schärfe', 0, 100]].map(([k, l, mn, mx]) =>
          `<div class="adj-row"><span>${l}</span><input type="range" class="range" min="${mn}" max="${mx}" step="1" value="0" data-a="${k}"><span data-av="${k}">0</span></div>`).join('')}
        <button class="link-btn" data-reset style="padding:2px">Zurücksetzen</button>
      </div>
    </div>
    <div class="rv-tools">
      <button data-t="cam">${icon('scan')}<span>Weitere</span></button>
      <button data-t="lib">${icon('images')}<span>Fotos</span></button>
      <button data-t="rot">${icon('rotate')}<span>Drehen</span></button>
      <button data-t="crop">${icon('fit')}<span>Zuschneiden</span></button>
      <button data-t="text">${icon('share')}<span>Export</span></button>
      <button data-t="del">${icon('trash')}<span>Löschen</span></button>
    </div>`;
  document.body.appendChild(wrap);
  const stage = wrap.querySelector('[data-stage]'), flt = wrap.querySelector('[data-flt]');

  // ---------- Vorschau ----------
  const aiReady = it => !!(it.ai && it._ai && it._ai.key === JSON.stringify(it.corners));
  const key = it => JSON.stringify([filter, adj, it.rot, it.corners, aiReady(it), filter === 'ai' && enhReady(it), filter === 'online' && onlineDone(it)]);
  // Filterliste: „☁️ Online“ nur, wenn in den Einstellungen eingerichtet
  const FL = onlineReady() ? [FILTERS[0], FILTERS[1], ['online', '☁️ Online'], ...FILTERS.slice(2)] : FILTERS;
  const preview = it => {
    const k = key(it);
    if (it._bigKey !== k) { it._big = renderScan(it, filter, BIG, adj).toDataURL('image/jpeg', 0.85); it._bigKey = k; }
    return it._big;
  };
  const thumb = it => { const k = key(it); if (it._thKey !== k) { it._th = renderScan(it, filter, 320, adj).toDataURL('image/jpeg', 0.8); it._thKey = k; } return it._th; };

  const buildStage = () => {
    stage.innerHTML = items.map((_, i) => `<div class="rv-page" data-i="${i}"><img alt=""><div class="rv-spin"></div></div>`).join('')
      || `<div class="rv-empty">${icon('scan')}<b>Keine Seiten</b>Tippe unten auf „Weitere“ oder „Fotos“.</div>`;
    stage.querySelectorAll('.rv-page').forEach(p => p.onclick = () => openCrop(+p.dataset.i));
  };
  let drawT;
  const drawVisible = () => {
    clearTimeout(drawT);
    drawT = setTimeout(async () => {
      for (const i of [cur, cur + 1, cur - 1]) {
        const it = items[i], el = stage.querySelector(`.rv-page[data-i="${i}"]`);
        if (!it || !el) continue;
        const img = el.querySelector('img');
        if (it.ai && !aiReady(it)) {
          el.classList.add('busy');
          const first = !aiLoaded();
          if (first) busy(true, 'KI wird geladen … (einmalig ca. 23 MB)');
          try { await ensureAI(it); } catch (e) { console.warn(e); it.ai = false; aiFail(); }
          if (first) busy(false);
          if (it._ai && !it._ai.canvas && !flatShown) { flatShown = true; toast('Seite ist eben – ohne KI wird sie genauer'); }
          if (closed) return;
          if (i === cur) renderFilters();
        }
        if (filter === 'ai' && !enhReady(it)) {
          el.classList.add('busy');
          let pct = el.querySelector('.rv-pct');
          if (!pct) { pct = document.createElement('div'); pct.className = 'rv-pct'; el.appendChild(pct); }
          pct.textContent = '✨ KI-Scan …';
          const first = !enhLoaded();
          if (first) busy(true, 'KI wird geladen … (einmalig ca. 21 MB)');
          try {
            await ensureEnhance(it, (msg, f) => { if (f != null) { if (first) busy(false); pct.textContent = `✨ KI-Scan … ${Math.round(f * 100)} %`; } });
          } catch (e) { console.warn(e); toast('KI-Scan hat nicht geklappt – „Verbessern“ wird verwendet', true); }
          if (first) busy(false);
          pct.remove();
          if (closed) return;
          if (i === cur) renderFilters();
        }
        if (filter === 'online' && !onlineDone(it)) {
          el.classList.add('busy', 'nibopt');
          let pct = el.querySelector('.rv-pct');
          if (!pct) { pct = document.createElement('div'); pct.className = 'rv-pct'; el.appendChild(pct); }
          pct.classList.add('nib'); pct.textContent = 'Wird mit Nibvion optimiert …';
          try { await ensureOnline(it); }
          catch (e) { console.warn(e); toast(`Online-Scan: ${e.message || 'fehlgeschlagen'} – KI-Scan wird verwendet`, true); }
          pct.remove(); el.classList.remove('nibopt');
          if (closed) return;
          if (i === cur) renderFilters();
        }
        if (img.dataset.k === key(it)) { el.classList.remove('busy'); continue; }
        el.classList.add('busy'); await tick();
        img.src = preview(it); img.dataset.k = key(it);
        el.classList.remove('busy');
        if (closed) return;
      }
    }, 40);
  };
  const updCount = () => {
    wrap.querySelector('[data-count]').textContent = items.length ? `${cur + 1} / ${items.length}` : '0 Seiten';
    wrap.querySelector('[data-save]').disabled = !items.length;
  };
  stage.addEventListener('scroll', () => {
    const i = Math.round(stage.scrollLeft / Math.max(1, stage.clientWidth));
    if (i !== cur && i >= 0 && i < items.length) { cur = i; updCount(); drawVisible(); renderFilters(); }
  }, { passive: true });
  const goTo = i => { cur = Math.max(0, Math.min(items.length - 1, i)); stage.scrollTo({ left: cur * stage.clientWidth, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' }); stage.scrollLeft = cur * stage.clientWidth; updCount(); drawVisible(); renderFilters(); };

  // ---------- Filter ----------
  let fltFor = null, fltPrev = {};
  const renderFilters = () => {
    const it = items[cur];
    const fk = it && JSON.stringify([it._id, it.rot, it.corners, aiReady(it), enhReady(it), onlineDone(it)]);
    if (it && fltFor !== fk) {
      fltFor = fk; fltPrev = {};
      const base = renderScan(it, '', 240);
      for (const [k] of FL) {
        const c = document.createElement('canvas'); c.width = base.width; c.height = base.height;
        c.getContext('2d').drawImage(base, 0, 0);
        fltPrev[k] = enhance(c, k).toDataURL('image/jpeg', 0.75);
      }
      if (enhReady(it)) fltPrev.ai = renderScan(it, 'ai', 240).toDataURL('image/jpeg', 0.75);
      if (onlineDone(it)) fltPrev.online = renderScan(it, 'online', 240).toDataURL('image/jpeg', 0.75);
    }
    flt.innerHTML = FL.map(([k, l]) => `<button class="flt ${k === (filter || '') ? 'on' : ''}" data-fk="${k}"><span class="flt-img" style="background-image:url(${fltPrev[k] || ''})"></span>${l}</button>`).join('');
    flt.querySelectorAll('[data-fk]').forEach(b => b.onclick = () => {
      filter = b.dataset.fk || null; opts.onFilter && opts.onFilter(filter || ''); haptic();
      renderFilters(); drawVisible();
    });
  };
  let idc = 0;
  let aiOn = aiPref();
  const aiFor = it => { it.ai = aiOn && !edgeCut(it.corners); };
  const tag = list => list.forEach(it => { it._id ??= ++idc; aiFor(it); });
  tag(items);

  // ---------- Panel ----------
  wrap.querySelectorAll('[data-tabs] button').forEach(b => b.onclick = () => {
    panel = b.dataset.p;
    wrap.querySelectorAll('[data-tabs] button').forEach(x => x.classList.toggle('on', x === b));
    flt.hidden = panel !== 'filter'; wrap.querySelector('[data-adj]').hidden = panel !== 'adj';
  });
  wrap.querySelectorAll('[data-a]').forEach(r => r.oninput = () => {
    adj[r.dataset.a] = +r.value; wrap.querySelector(`[data-av="${r.dataset.a}"]`).textContent = r.value; drawVisible();
  });
  wrap.querySelector('[data-reset]').onclick = () => {
    for (const k in adj) adj[k] = 0;
    wrap.querySelectorAll('[data-a]').forEach(r => { r.value = 0; wrap.querySelector(`[data-av="${r.dataset.a}"]`).textContent = '0'; });
    drawVisible();
  };
  const ocrBtn = wrap.querySelector('[data-ocr]');
  const updOcr = () => ocrBtn && ocrBtn.classList.toggle('on', ocrOn);
  if (ocrBtn) ocrBtn.onclick = () => { ocrOn = !ocrOn; opts.onOcr && opts.onOcr(ocrOn); updOcr(); haptic(); toast(ocrOn ? 'Text wird beim Speichern erkannt' : 'Ohne Texterkennung'); };
  updOcr();
  const aiBtn = wrap.querySelector('[data-ai]');
  const updAi = () => aiBtn.classList.toggle('on', aiOn);
  let failShown = false, flatShown = false;
  function aiFail() { if (!failShown) { failShown = true; toast('KI-Glätten hat nicht geklappt – klassische Ansicht', true); } }
  aiBtn.onclick = () => {
    aiOn = !aiOn; setAiPref(aiOn); haptic(); updAi();
    items.forEach(aiFor);
    const cut = aiOn && items.some(it => edgeCut(it.corners));
    toast(!aiOn ? 'KI-Glätten aus' : cut ? 'KI-Glätten an – angeschnittene Seiten bleiben klassisch' : 'KI-Glätten an: gewölbte Seiten werden geglättet');
    drawVisible(); renderFilters();
  };
  updAi();
  // Vor Speichern/Export alle Seiten mit KI fertig berechnen
  const prepAll = async () => {
    const todo = items.filter(it => it.ai && !aiReady(it));
    for (let n = 0; n < todo.length; n++) {
      busy(true, `KI glättet Seite ${n + 1} von ${todo.length} …`);
      try { await ensureAI(todo[n]); } catch (e) { console.warn(e); todo[n].ai = false; aiFail(); }
    }
    if (filter === 'online') {
      const list = items.filter(it => !onlineDone(it));
      for (let n = 0; n < list.length; n++) {
        busy(true, `☁️ Online-Scan Seite ${n + 1} von ${list.length} …`);
        try { await ensureOnline(list[n]); }
        catch (e) { console.warn(e); toast(`Online-Scan: ${e.message || 'fehlgeschlagen'}`, true); break; }
      }
    }
    if (filter === 'ai' || (filter === 'online' && items.some(it => !onlineDone(it)))) {
      const list = items.filter(it => !enhReady(it));
      for (let n = 0; n < list.length; n++) {
        busy(true, `✨ KI-Scan Seite ${n + 1} von ${list.length} …`);
        try { await ensureEnhance(list[n], (m, f) => { if (f != null) busy(true, `✨ KI-Scan Seite ${n + 1} von ${list.length} … ${Math.round(f * 100)} %`); }); }
        catch (e) { console.warn(e); toast('KI-Scan hat nicht geklappt – „Verbessern“ wird verwendet', true); break; }
      }
    }
    busy(false);
  };

  // ---------- Werkzeuge ----------
  const refreshAll = (goLast) => { buildStage(); updCount(); if (goLast) requestAnimationFrame(() => goTo(items.length - 1)); else { drawVisible(); renderFilters(); } };
  const addShots = list => { tag(list); items.push(...list); refreshAll(true); };
  const openCrop = async i => {
    const it = items[i]; if (!it) return;
    const r = await cropEditor(it); if (!r) return;
    it.corners = r.corners; it.rot = r.rot; aiFor(it); drawVisible(); renderFilters();
  };
  const addFiles = async (files, auto) => {
    if (!files.length) return;
    busy(true, auto ? 'Ränder werden erkannt …' : 'Bilder werden geladen …');
    const out = [];
    for (const f of files) {
      try { const { img, url } = await loadFileImage(f); out.push({ img, url, corners: auto ? detectCorners(img) : FULL.map(p => [...p]), rot: 0 }); }
      catch { toast('Bild konnte nicht geladen werden', true); }
    }
    busy(false); if (out.length) addShots(out);
  };
  wrap.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
    const t = b.dataset.t, it = items[cur];
    if (t === 'cam') {
      if (cameraSupported() && !liveFailed) {
        const shots = await liveScanner({ startCount: items.length });
        if (shots === null) { liveFailed = true; addFiles(await pickFiles('file-cam'), true); }
        else if (shots.length) addShots(shots);
      } else addFiles(await pickFiles('file-cam'), true);
    }
    if (t === 'lib') addFiles(await pickFiles('file-img'), true);
    if (!it) return;
    if (t === 'rot') {
      if (it._spin) return; it._spin = true; haptic();
      const pg = stage.querySelector(`.rv-page[data-i="${cur}"]`), img = pg && pg.querySelector('img[src]');
      const apply = () => { it.rot = ((it.rot || 0) + 90) % 360; drawVisible(); renderFilters(); return img && imgLoaded(img); };
      if (img) { const cs = getComputedStyle(pg); await spinRotate(img, pg.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), pg.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom), apply); }
      else apply();
      it._spin = false;
    }
    if (t === 'crop') openCrop(cur);
    if (t === 'del') {
      const [gone] = items.splice(cur, 1); if (gone?.url) setTimeout(() => URL.revokeObjectURL(gone.url), 1000);
      cur = Math.min(cur, items.length - 1); if (cur < 0) cur = 0;
      haptic(); refreshAll(false); requestAnimationFrame(() => goTo(cur));
    }
    if (t === 'text') { await prepAll(); opts.onText(items, filter, adj); }
  });

  // ---------- Schließen ----------
  const close = () => {
    if (closed) return; closed = true;
    wrap.classList.add('out'); setTimeout(() => wrap.remove(), 280);
  };
  const askClose = async () => {
    if (!items.length || await discardDlg()) {
      items.forEach(it => it.url && setTimeout(() => URL.revokeObjectURL(it.url), 1000));
      close();
    }
  };
  wrap.querySelector('[data-x]').onclick = askClose;
  wrap.querySelector('[data-save]').onclick = async () => {
    if (!items.length) return;
    await prepAll();
    const ok = await opts.onSave(items, filter, adj, ocrOn);
    if (ok !== false) close();
  };
  // Von oben herunterwischen
  const top = wrap.querySelector('.rv-top');
  let sy = null, dy = 0;
  top.addEventListener('touchstart', e => { sy = e.touches[0].clientY; dy = 0; }, { passive: true });
  top.addEventListener('touchmove', e => { if (sy == null) return; dy = Math.max(0, e.touches[0].clientY - sy); wrap.style.transform = `translateY(${dy * 0.5}px)`; wrap.style.transition = 'none'; }, { passive: true });
  top.addEventListener('touchend', () => { if (sy == null) return; wrap.style.transition = ''; wrap.style.transform = ''; if (dy > 90) askClose(); sy = null; });

  buildStage(); updCount(); renderFilters(); drawVisible();
  return { close };
}
