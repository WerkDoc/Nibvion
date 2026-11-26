// ================= Element-Details & Ebenen-Filter (Viewer) =================
// Schalter im ⋯-Menü des Editors. Unten erscheint ein kleines Panel mit Ebenen-Filtern
// (Kommentare/Markierungen, Formularfelder, Stempel/Signaturen, Links) – nur für die Ansicht,
// Export und Speichern bleiben unverändert. Antippen eines Elements zeigt ein schwebendes
// Detail-Badge: Schrift & Größe eines Textabsatzes, Bildauflösung in Pixeln & DPI, Link-Ziel.
//
// PDF-Annotationen: pdf.js-Annotation-Speicher `noView` (nur dieses geladene Dokument, wird nie
// gespeichert – Nibvion speichert mit pdf-lib). Eigene Nibvion-Objekte: CSS-Klassen am Editor.

import { icon } from './icons.js';
import { toast, haptic, esc } from './ui.js';
import { pdfjsLib } from './pdfcore.js';
import { reducedMotion, springKeys } from './fx.js';

const NS = 'http://www.w3.org/2000/svg';
export const LAYERS = [
  { id: 'comment', label: 'Kommentare & Markierungen', short: 'Kommentare', icon: 'comment', c: 'c-amber' },
  { id: 'form', label: 'Formularfelder', short: 'Formulare', icon: 'form', c: 'c-blue' },
  { id: 'stamp', label: 'Stempel & Signaturen', short: 'Stempel', icon: 'stamp', c: 'c-green' },
  { id: 'link', label: 'Klickbare Links', short: 'Links', icon: 'link', c: 'c-teal' },
];
const COMMENT_TYPES = new Set(['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Caret', 'Popup', 'FileAttachment', 'Sound', 'Redact']);
const TYPE_DE = { Text: 'Notiz', FreeText: 'Textkommentar', Highlight: 'Markierung', Underline: 'Unterstreichung', StrikeOut: 'Durchstreichung', Squiggly: 'Wellenlinie', Ink: 'Freihand-Zeichnung', Square: 'Rechteck', Circle: 'Kreis/Ellipse', Line: 'Linie', Polygon: 'Polygon', PolyLine: 'Linienzug', Caret: 'Einfügezeichen', FileAttachment: 'Dateianhang', Sound: 'Audio', Redact: 'Schwärzung', Stamp: 'Stempel', Link: 'Link', Widget: 'Formularfeld' };
const FIELD_DE = { Tx: 'Textfeld', Btn: 'Schaltfläche/Kästchen', Ch: 'Auswahlliste', Sig: 'Signaturfeld' };
export function layerOf(a) {
  if (a.subtype === 'Link') return 'link';
  if (a.subtype === 'Widget') return a.fieldType === 'Sig' ? 'stamp' : 'form';
  if (a.subtype === 'Stamp') return 'stamp';
  if (COMMENT_TYPES.has(a.subtype)) return 'comment';
  return null;
}
// eigene Objekte → Ebene
export function objLayer(o) {
  if (o.type === 'image') return 'stamp';
  if (['highlight', 'underline', 'strike', 'ink'].includes(o.type) || (o.type === 'text' && o.bg)) return 'comment';
  return null;
}

const cleanFont = n => String(n || '').replace(/^[A-Z]{6}\+/, '').replace(/[_,]/g, ' ').trim();
const fmt = (v, d = 0) => Number(v).toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d });
const mm = pt => fmt(pt / 72 * 25.4, 1) + ' mm';

/**
 * api: { el, pdf(), page(i) → {el, svg}, count(), scale(), loadText(i) → items, objects(), bbox(o),
 *        rerender(i), renderLayer(i), jump(i), svgToScreen(i, x, y) }
 */
export function createInspector(api) {
  const S = { on: false, hidden: new Set(), annots: {}, imgs: {}, badge: null, panel: null, hi: null };

  // ---------- Daten je Seite ----------
  function annots(i) {
    if (S.annots[i]) return S.annots[i];
    S.annots[i] = (async () => {
      const page = await api.pdf().getPage(i + 1), vp = page.getViewport({ scale: 1 });
      const list = (await page.getAnnotations({ intent: 'display' })).map(a => {
        const m = vp.transform, T = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
        const [x0, y0] = T(a.rect[0], a.rect[1]), [x1, y1] = T(a.rect[2], a.rect[3]);
        return { ...a, layer: layerOf(a), box: { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) } };
      });
      S.annots[i] = list; applyView(i);
      if (S.hidden.size && list.some(a => S.hidden.has(a.layer) && a.layer !== 'link')) api.rerender(i);
      return list;
    })().catch(e => { console.warn(e); return (S.annots[i] = []); });
    return S.annots[i];
  }
  const annotsNow = i => Array.isArray(S.annots[i]) ? S.annots[i] : null;

  // Bilder einer Seite aus der Operator-Liste (Transformationen mitverfolgen)
  function images(i) {
    if (S.imgs[i]) return S.imgs[i];
    S.imgs[i] = (async () => {
      const page = await api.pdf().getPage(i + 1), vp = page.getViewport({ scale: 1 });
      const ol = await page.getOperatorList(), O = pdfjsLib.OPS, T = pdfjsLib.Util.transform;
      const out = [], st = []; let ctm = [1, 0, 0, 1, 0, 0];
      for (let k = 0; k < ol.fnArray.length; k++) {
        const fn = ol.fnArray[k], a = ol.argsArray[k];
        if (fn === O.save) st.push(ctm);
        else if (fn === O.restore) ctm = st.pop() || ctm;
        else if (fn === O.transform) ctm = T(ctm, a);
        else if (fn === O.paintFormXObjectBegin) { st.push(ctm); if (Array.isArray(a?.[0]) && a[0].length === 6) ctm = T(ctm, a[0]); }
        else if (fn === O.paintFormXObjectEnd) ctm = st.pop() || ctm;
        else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageXObjectRepeat || fn === O.paintImageMaskXObject) {
          const m = T(vp.transform, ctm);
          const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
          const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
          let pw = a?.[1], ph = a?.[2];
          if (typeof pw !== 'number') { const d = a?.[0]; pw = d?.width; ph = d?.height; }
          if (box.w > 1 && box.h > 1) out.push({ box, pw, ph, mask: fn === O.paintImageMaskXObject, rot: Math.abs(m[1]) > Math.abs(m[0]) });
        }
      }
      S.imgs[i] = out; return out;
    })().catch(e => { console.warn(e); return (S.imgs[i] = []); });
    return S.imgs[i];
  }

  // ---------- Filter ----------
  // Sichtbarkeit der PDF-Annotationen einer Seite im pdf.js-Speicher setzen
  function applyView(i) {
    const list = annotsNow(i), store = api.pdf()?.annotationStorage; if (!list || !store) return;
    for (const a of list) if (a.layer && a.layer !== 'link') {
      const hide = S.hidden.has(a.layer), cur = store.getRawValue?.(a.id)?.noView;
      if (hide ? cur !== true : cur === true) store.setValue(a.id, { noView: hide ? true : undefined });
    }
  }
  function setHidden(layer, hide) {
    hide ? S.hidden.add(layer) : S.hidden.delete(layer);
    api.el.classList.toggle('hide-' + layer, hide);
    for (let i = 0; i < api.count(); i++) {
      const list = annotsNow(i);
      if (!list) { if (hide) annots(i); }
      else if (layer !== 'link' && list.some(a => a.layer === layer)) { applyView(i); api.rerender(i); }
      api.renderLayer(i);
    }
    closeBadge();
  }

  // ---------- Overlay im SVG (Links sichtbar machen, Hervorhebung) ----------
  function drawLayer(svg, i) {
    if (!S.on) return;
    const list = annotsNow(i);
    if (!list) { annots(i).then(() => S.on && api.renderLayer(i)); return; }
    if (!S.hidden.has('link')) list.filter(a => a.layer === 'link').forEach(a => {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('class', 'insp-link');
      for (const [k, v] of Object.entries({ x: a.box.x, y: a.box.y, width: a.box.w, height: a.box.h, rx: 1.5 })) r.setAttribute(k, v);
      svg.appendChild(r);
    });
    if (S.hi && S.hi.page === i) {
      const b = S.hi.box, r = document.createElementNS(NS, 'rect'), pad = 2 / api.scale();
      r.setAttribute('class', 'insp-hi');
      for (const [k, v] of Object.entries({ x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, rx: 2 })) r.setAttribute(k, v);
      svg.appendChild(r);
    }
  }

  // ---------- Panel ----------
  function panel() {
    if (S.panel) return S.panel;
    const p = document.createElement('div');
    p.className = 'insp-panel'; p.setAttribute('role', 'region'); p.setAttribute('aria-label', 'Element-Details & Filter');
    api.el.appendChild(p);
    p.addEventListener('pointerdown', e => e.stopPropagation());
    p.addEventListener('click', e => {
      if (e.target.closest('[data-insp-close]')) { haptic(); return setOn(false); }
      const b = e.target.closest('[data-layer-t]'); if (!b) return;
      const id = b.dataset.layerT, hide = !S.hidden.has(id);
      b.classList.toggle('off', hide); b.setAttribute('aria-pressed', String(!hide));
      haptic(); setHidden(id, hide);
    });
    return (S.panel = p);
  }
  async function counts() {
    const n = Math.min(api.count(), 150), c = { comment: 0, form: 0, stamp: 0, link: 0 };
    for (let i = 0; i < n; i++) (await annots(i)).forEach(a => { if (a.layer) c[a.layer]++; });
    api.objects().forEach(o => { const l = objLayer(o); if (l) c[l]++; });
    return c;
  }
  function renderPanel() {
    const p = panel();
    p.innerHTML = `<div class="insp-head"><span class="insp-title">${icon('info')}Element-Details & Filter</span><button class="insp-x" data-insp-close aria-label="Schließen">${icon('x')}</button></div>
      <div class="insp-toggles">${LAYERS.map(l => `<button class="insp-t ${S.hidden.has(l.id) ? 'off' : ''}" data-layer-t="${l.id}" aria-pressed="${!S.hidden.has(l.id)}"><span class="qt-ic ${l.c}">${icon(l.icon)}</span><span class="insp-tl">${l.short}</span><span class="insp-n" data-n="${l.id}">·</span></button>`).join('')}</div>
      <div class="insp-sub">Tippe auf Text, Bilder oder Links für Details · Filter gelten nur für die Ansicht</div>`;
    counts().then(c => { if (!S.on) return; for (const k in c) { const e = p.querySelector(`[data-n="${k}"]`); if (e) e.textContent = c[k]; } });
  }

  function setOn(on) {
    if (on === S.on) return;
    S.on = on;
    api.el.classList.toggle('inspect', on);
    if (on) {
      renderPanel();
      requestAnimationFrame(() => S.panel.classList.add('show'));
    } else {
      S.panel?.classList.remove('show');
      closeBadge();
      // Filter wieder aufheben, damit nichts unbemerkt versteckt bleibt
      [...S.hidden].forEach(l => setHidden(l, false));
    }
    for (let i = 0; i < api.count(); i++) api.renderLayer(i);
  }

  // ---------- Antippen → Details ----------
  const inBox = (b, x, y, pad = 0) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;

  async function tapAt(i, x, y, cx, cy) {
    const pad = 4 / api.scale();
    // 1) eigene Objekte (oben liegend)
    const objs = api.objects().filter(o => o.page === i && !S.hidden.has(objLayer(o))).reverse();
    const o = objs.find(o => inBox(api.bbox(o), x, y, pad));
    if (o) return show(i, api.bbox(o), await objInfo(o), cx, cy);
    // 2) Links und Annotationen
    const list = await annots(i);
    const link = !S.hidden.has('link') && list.find(a => a.layer === 'link' && inBox(a.box, x, y, pad));
    if (link) return show(i, link.box, await linkInfo(link), cx, cy);
    const an = list.find(a => a.layer && a.layer !== 'link' && !S.hidden.has(a.layer) && inBox(a.box, x, y, pad));
    if (an) return show(i, an.box, annotInfo(an), cx, cy);
    // 3) Text vor Bild (Text liegt meist über Bildern)
    const items = await api.loadText(i);
    const t = items.find(t => inBox({ x: t.x, y: t.top, w: t.w, h: t.h }, x, y, pad * 0.5));
    if (t) { const p = paragraph(items, t); return show(i, p.box, textInfo(p), cx, cy); }
    const imgs = await images(i);
    const im = imgs.filter(m => inBox(m.box, x, y)).sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
    if (im) return show(i, im.box, imgInfo(im), cx, cy);
    closeBadge();
    toast('Hier ist kein Element – tippe auf Text, ein Bild oder einen Link');
  }

  function paragraph(items, t0) {
    const size = t0.size, inPara = new Set([t0]);
    let box = { x: t0.x, y: t0.top, w: t0.w, h: t0.h }, grew = true, guard = 0;
    while (grew && guard++ < 60) {
      grew = false;
      for (const t of items) {
        if (inPara.has(t) || Math.abs(t.size - size) > size * 0.22) continue;
        const gapY = t.top > box.y + box.h ? t.top - (box.y + box.h) : box.y > t.top + t.h ? box.y - (t.top + t.h) : 0;
        const overX = Math.min(box.x + box.w, t.x + t.w) - Math.max(box.x, t.x);
        const sameLine = Math.abs((t.top + t.h / 2) - (box.y + box.h / 2)) < size * 0.6 && box.h < size * 1.8;
        if ((gapY < size * 0.75 && overX > -size * 0.5) || (sameLine && Math.abs(t.x - (box.x + box.w)) < size * 1.5)) {
          inPara.add(t);
          const x0 = Math.min(box.x, t.x), y0 = Math.min(box.y, t.top), x1 = Math.max(box.x + box.w, t.x + t.w), y1 = Math.max(box.y + box.h, t.top + t.h);
          box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; grew = true;
        }
      }
    }
    const list = [...inPara].sort((a, b) => a.top - b.top || a.x - b.x);
    const lines = []; list.forEach(t => { const l = lines.find(l => Math.abs(l.y - t.top) < size * 0.5); l ? l.items.push(t) : lines.push({ y: t.top, items: [t] }); });
    const text = lines.map(l => l.items.sort((a, b) => a.x - b.x).map(t => t.str).join(' ').replace(/\s+/g, ' ').trim()).join('\n');
    return { box, t0, lines: lines.length, text };
  }

  // ---------- Inhalte der Badges ----------
  function textInfo(p) {
    const t = p.t0, real = cleanFont(t.fname);
    const fam = { serif: 'Serifenschrift', mono: 'Festbreite', sans: 'Serifenlos' }[t.font] || '';
    const words = (p.text.match(/\S+/g) || []).length;
    return {
      icon: 'text', title: 'Textabsatz',
      rows: [['Schriftart', real ? `${esc(real)}<small>${fam}</small>` : fam], ['Schriftgröße', `${fmt(t.size, t.size < 10 ? 1 : 0)} pt`], ['Stil', [t.bold && 'Fett', t.italic && 'Kursiv'].filter(Boolean).join(', ') || 'Normal'], ['Umfang', `${p.lines} ${p.lines === 1 ? 'Zeile' : 'Zeilen'} · ${words} ${words === 1 ? 'Wort' : 'Wörter'}`]],
      copy: p.text, copyLabel: 'Text kopieren',
    };
  }
  function imgInfo(m) {
    const wpt = m.rot ? m.box.h : m.box.w, hpt = m.rot ? m.box.w : m.box.h;
    const rows = [];
    if (m.pw && m.ph) {
      const dx = m.pw / (wpt / 72), dy = m.ph / (hpt / 72), dpi = Math.round(Math.min(dx, dy));
      const q = dpi >= 250 ? ['gut', 'ok'] : dpi >= 150 ? ['ausreichend', 'mid'] : ['niedrig für Druck', 'low'];
      rows.push(['Auflösung', `${fmt(m.pw)} × ${fmt(m.ph)} px`], ['Effektiv', `<span class="insp-dpi ${q[1]}">${dpi} DPI</span><small>${q[0]}</small>`]);
    }
    rows.push(['Größe auf Seite', `${mm(m.box.w)} × ${mm(m.box.h)}`]);
    if (m.mask) rows.push(['Art', 'Bildmaske (einfarbig)']);
    return { icon: 'image', title: 'Bild', rows };
  }
  async function linkInfo(a) {
    const url = a.url || a.unsafeUrl;
    if (url) return { icon: 'link', title: 'Link', rows: [['Ziel', `<span class="insp-url">${esc(url)}</span>`]], copy: url, copyLabel: 'Adresse kopieren', open: url };
    let page = null;
    try {
      let d = a.dest; if (typeof d === 'string') d = await api.pdf().getDestination(d);
      if (Array.isArray(d)) page = typeof d[0] === 'object' ? await api.pdf().getPageIndex(d[0]) : d[0];
    } catch {}
    if (page != null) return { icon: 'link', title: 'Interner Link', rows: [['Ziel', `Seite ${page + 1}`]], jump: page };
    return { icon: 'link', title: 'Link', rows: [['Ziel', a.action ? `Aktion: ${esc(a.action)}` : 'Unbekannt']] };
  }
  function annotInfo(a) {
    const rows = [['Typ', a.subtype === 'Widget' ? (FIELD_DE[a.fieldType] || 'Formularfeld') : (TYPE_DE[a.subtype] || esc(a.subtype))]];
    if (a.fieldName) rows.push(['Feldname', esc(a.fieldName)]);
    if (a.subtype === 'Widget' && a.fieldValue != null && a.fieldValue !== '') rows.push(['Wert', esc(Array.isArray(a.fieldValue) ? a.fieldValue.join(', ') : String(a.fieldValue))]);
    const author = a.titleObj?.str, text = a.contentsObj?.str;
    if (author) rows.push(['Von', esc(author)]);
    if (text) rows.push(['Inhalt', esc(text.slice(0, 200))]);
    if (a.modificationDate) { const m = /^D:(\d{4})(\d{2})(\d{2})/.exec(a.modificationDate); if (m) rows.push(['Datum', `${m[3]}.${m[2]}.${m[1]}`]); }
    rows.push(['Größe', `${mm(a.box.w)} × ${mm(a.box.h)}`]);
    const L = LAYERS.find(l => l.id === a.layer);
    return { icon: L?.icon || 'info', title: a.layer === 'form' ? 'Formularfeld' : a.layer === 'stamp' ? (a.fieldType === 'Sig' ? 'Signatur' : 'Stempel') : 'Kommentar', rows, copy: text || undefined, copyLabel: 'Inhalt kopieren' };
  }
  async function objInfo(o) {
    const b = api.bbox(o);
    if (o.type === 'image') {
      let pw = 0, ph = 0;
      try { const im = new Image(); im.src = o.src; await im.decode(); pw = im.naturalWidth; ph = im.naturalHeight; } catch {}
      const rows = [];
      if (pw) { const dpi = Math.round(Math.min(pw / (o.w / 72), ph / (o.h / 72))); rows.push(['Auflösung', `${fmt(pw)} × ${fmt(ph)} px`], ['Effektiv', `<span class="insp-dpi ${dpi >= 250 ? 'ok' : dpi >= 150 ? 'mid' : 'low'}">${dpi} DPI</span>`]); }
      rows.push(['Größe auf Seite', `${mm(o.w)} × ${mm(o.h)}`]);
      if (o.rot) rows.push(['Drehung', `${fmt(o.rot, 1)}°`]);
      return { icon: 'stamp', title: 'Bild / Stempel (Nibvion)', rows };
    }
    if (o.type === 'text') {
      const F = { sans: 'Helvetica', serif: 'Times', mono: 'Courier' }[o.font || 'sans'];
      return { icon: 'text', title: o.bg ? 'Notiz (Nibvion)' : 'Text (Nibvion)', rows: [['Schriftart', F], ['Schriftgröße', `${fmt(o.size, 1)} pt`], ['Stil', [o.bold && 'Fett', o.italic && 'Kursiv'].filter(Boolean).join(', ') || 'Normal'], ['Farbe', `<span class="insp-sw" style="background:${esc(o.color)}"></span>${esc(o.color)}`]], copy: o.text, copyLabel: 'Text kopieren' };
    }
    if (o.type === 'ink') {
      const SH = { line: 'Linie', arrow: 'Pfeil', rect: 'Rechteck', square: 'Quadrat', tri: 'Dreieck', circle: 'Kreis', ellipse: 'Oval' };
      return { icon: 'draw', title: o.shape ? `Form: ${SH[o.shape] || o.shape}` : 'Zeichnung (Nibvion)', rows: [['Strichstärke', `${fmt(o.width, 1)} pt`], ['Farbe', `<span class="insp-sw" style="background:${esc(o.color)}"></span>${esc(o.color)}`], ['Größe', `${mm(b.w)} × ${mm(b.h)}`]] };
    }
    const T = { highlight: 'Markierung', underline: 'Unterstreichung', strike: 'Durchstreichung', whiteout: 'Abdeckung' };
    return { icon: 'highlight', title: `${T[o.type] || 'Element'} (Nibvion)`, rows: [['Farbe', `<span class="insp-sw" style="background:${esc(o.color)}"></span>${esc(o.color)}`], ['Größe', `${mm(b.w)} × ${mm(b.h)}`]] };
  }

  // ---------- Badge ----------
  function show(i, box, info, cx, cy) {
    S.hi = { page: i, box }; api.renderLayer(i);
    let b = S.badge;
    if (!b) {
      b = S.badge = document.createElement('div'); b.className = 'insp-badge'; b.setAttribute('role', 'dialog');
      api.el.appendChild(b);
      b.addEventListener('pointerdown', e => e.stopPropagation());
    }
    b.innerHTML = `<div class="ib-head">${icon(info.icon)}<b>${info.title}</b><button class="ib-x" data-x aria-label="Schließen">${icon('x')}</button></div>
      <dl>${info.rows.filter(r => r[1]).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${info.copy || info.open || info.jump != null ? `<div class="ib-acts">
        ${info.copy ? `<button data-copy>${icon('copy')}${info.copyLabel || 'Kopieren'}</button>` : ''}
        ${info.open ? `<button data-open>${icon('globe')}Öffnen</button>` : ''}
        ${info.jump != null ? `<button data-jump>${icon('chevronRight')}Zu Seite ${info.jump + 1}</button>` : ''}</div>` : ''}`;
    b.querySelector('[data-x]').onclick = () => { haptic(); closeBadge(); };
    b.querySelector('[data-copy]')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(info.copy); haptic(); toast('Kopiert'); } catch { toast('Kopieren nicht möglich', true); } });
    b.querySelector('[data-open]')?.addEventListener('click', () => { if (/^(https?:|mailto:|tel:)/i.test(info.open)) window.open(info.open, '_blank', 'noopener'); else toast('Diese Adresse wird aus Sicherheitsgründen nicht geöffnet', true); });
    b.querySelector('[data-jump]')?.addEventListener('click', () => { closeBadge(); api.jump(info.jump); });
    b.dataset.page = i; S.badgeAt = { i, box };
    place(true);
    haptic();
  }
  function place(pop) {
    const b = S.badge; if (!b || !S.badgeAt) return;
    const { i, box } = S.badgeAt, er = api.el.getBoundingClientRect();
    const top = api.svgToScreen(i, box.x + box.w / 2, box.y), bot = api.svgToScreen(i, box.x + box.w / 2, box.y + box.h);
    b.classList.add('show');
    const bw = b.offsetWidth, bh = b.offsetHeight;
    const roomAbove = top.y - er.top - 150;                  // Platz unter Kopf + Werkzeugleiste
    const below = roomAbove < bh + 14;
    const y = below ? Math.min(bot.y + 12, er.bottom - bh - 150) : top.y - 12;
    const x = Math.min(er.width - bw / 2 - 10, Math.max(bw / 2 + 10, top.x - er.left));
    b.style.left = x + 'px'; b.style.top = (y - er.top) + 'px';
    const base = below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';
    b.style.transform = base; b.style.transformOrigin = below ? '50% 0' : '50% 100%';
    b.classList.toggle('below', below);
    b.style.setProperty('--ax', `${Math.max(16, Math.min(bw - 16, top.x - er.left - x + bw / 2))}px`);
    if (pop) {
      b.getAnimations?.().forEach(a => a.cancel());
      if (reducedMotion() || !b.animate) b.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      else b.animate(springKeys(0.6, base), { duration: 500, easing: 'linear' });
    }
  }
  function closeBadge() {
    S.badge?.classList.remove('show');
    const hi = S.hi; S.hi = null; S.badgeAt = null;
    if (hi) api.renderLayer(hi.page);
  }

  return {
    get on() { return S.on; },
    setOn, tapAt, drawLayer, closeBadge,
    reposition: () => S.badgeAt && place(false),
    reset() { S.annots = {}; S.imgs = {}; closeBadge(); if (S.on) { S.on = false; api.el.classList.remove('inspect'); S.panel?.classList.remove('show'); } S.hidden.forEach(l => api.el.classList.remove('hide-' + l)); S.hidden.clear(); },
  };
}
