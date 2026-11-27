// Gespeicherte Unterschriften & Stempel
import { db, uid } from './db.js';
import { sheet, toast, confirmDlg, esc, pickFiles, haptic } from './ui.js';
import { icon } from './icons.js';
import { signaturePad, STAMP_PRESETS, STAMP_COLORS, makeStamp } from './sign.js';
import { normalizeImage } from './pdfcore.js';
import { settings } from './settings.js';
import { qrMatrix, qrCanvas, wifiPayload, urlPayload } from './qr.js';

async function list(kind) {
  return (await db.all('assets')).filter(a => a.kind === kind).sort((a, b) => b.created - a.created);
}

// ---------- Unterschriften ----------
export function signatureSheet(onPick) {
  const s = sheet({
    title: onPick ? 'Unterschrift einfügen' : 'Meine Unterschriften',
    html: `<div class="asset-grid" data-grid></div>
      <p style="color:var(--text3);font-size:12.5px;margin:14px 2px 0">Unterschriften werden nur auf diesem Gerät gespeichert.</p>`,
    async onMount(el, api) {
      const grid = el.querySelector('[data-grid]');
      const render = async () => {
        const items = await list('sig');
        grid.innerHTML = `<button class="asset add" data-new>${icon('plus')}Neue Unterschrift</button>` +
          items.map(a => `<button class="asset" data-id="${a.id}"><img src="${a.src}" alt=""><span class="del" data-del="${a.id}">${icon('x')}</span></button>`).join('');
        grid.querySelector('[data-new]').onclick = async () => {
          const r = await signaturePad();
          if (!r) return;
          const a = { id: uid(), kind: 'sig', ...r, created: Date.now() };
          await db.put('assets', a);
          haptic();
          if (onPick) { api.close(); onPick(a); } else render();
        };
        grid.querySelectorAll('[data-id]').forEach(b => b.onclick = async e => {
          const del = e.target.closest('[data-del]');
          if (del) {
            e.stopPropagation();
            if (await confirmDlg('Unterschrift löschen?', 'Die gespeicherte Unterschrift wird von diesem Gerät entfernt.')) { await db.del('assets', del.dataset.del); render(); }
            return;
          }
          if (onPick) { const a = items.find(x => x.id === b.dataset.id); api.close(); onPick(a); }
        });
      };
      render();
    },
  });
  return s;
}

// ---------- Stempel ----------
export function stampSheet(onPick) {
  sheet({
    title: onPick ? 'Stempel einfügen' : 'Meine Stempel',
    html: `
      <div class="lbl" style="margin-top:0">Eigene Stempel</div>
      <div class="asset-grid" data-mine></div>
      <div class="lbl">Vorlagen</div>
      <div class="asset-grid" data-presets></div>`,
    async onMount(el, api) {
      const mine = el.querySelector('[data-mine]');
      const presets = el.querySelector('[data-presets]');
      const name = settings.get('stampName');
      const pick = a => { if (onPick) { api.close(); onPick(a); } };
      presets.innerHTML = STAMP_PRESETS.map((p, i) => {
        const st = makeStamp({ text: p.text, color: p.color, date: settings.get('stampDate'), sub: name });
        return `<button class="asset" data-p="${i}"><img src="${st.src}" alt="${esc(p.text)}"></button>`;
      }).join('');
      presets.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
        const p = STAMP_PRESETS[b.dataset.p];
        pick(makeStamp({ text: p.text, color: p.color, date: settings.get('stampDate'), sub: name }));
      });
      const render = async () => {
        const items = await list('stamp');
        mine.innerHTML = `<button class="asset add" data-new>${icon('plus')}Text-Stempel</button>
          <button class="asset add" data-img>${icon('upload')}Stempelbild</button>
          <button class="asset add" data-qr>${icon('qr')}QR-Code</button>` +
          items.map(a => `<button class="asset" data-id="${a.id}"><img src="${a.src}" alt=""><span class="del" data-del="${a.id}">${icon('x')}</span></button>`).join('');
        mine.querySelector('[data-new]').onclick = () => customStamp(async st => {
          const a = { id: uid(), kind: 'stamp', ...st, created: Date.now() };
          await db.put('assets', a); render(); toast('Stempel gespeichert');
        });
        mine.querySelector('[data-img]').onclick = async () => {
          const [f] = await pickFiles('file-img'); if (!f) return;
          const im = await normalizeImage(f, 1200);
          const a = { id: uid(), kind: 'stamp', src: im.url, w: im.w, h: im.h, created: Date.now(), image: true };
          await db.put('assets', a); render(); toast('Stempelbild gespeichert');
        };
        mine.querySelector('[data-qr]').onclick = () => qrSheet({
          onInsert: onPick ? st => { api.close(); onPick(st); } : null,
          onSave: async st => { await db.put('assets', { id: uid(), kind: 'stamp', ...st, created: Date.now() }); render(); toast('QR-Code gespeichert'); },
        });
        mine.querySelectorAll('[data-id]').forEach(b => b.onclick = async e => {
          const del = e.target.closest('[data-del]');
          if (del) {
            e.stopPropagation();
            if (await confirmDlg('Stempel löschen?', 'Der Stempel wird von diesem Gerät entfernt.')) { await db.del('assets', del.dataset.del); render(); }
            return;
          }
          pick(items.find(x => x.id === b.dataset.id));
        });
      };
      render();
    },
  });
}

function customStamp(onSave) {
  let color = STAMP_COLORS[0], date = true;
  sheet({
    title: 'Eigener Stempel',
    html: `
      <div class="asset" style="height:110px;margin-bottom:6px" data-prev></div>
      <div class="lbl">Text</div>
      <input class="field" data-t value="BEZAHLT" maxlength="24" style="text-transform:uppercase">
      <div class="lbl">Zusatzzeile (optional)</div>
      <input class="field" data-s value="${esc(settings.get('stampName'))}" placeholder="z. B. Firmenname" maxlength="40">
      <div class="lbl">Farbe</div>
      <div class="colors" data-cols>${STAMP_COLORS.map((c, i) => `<button class="color ${i ? '' : 'on'}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      <div class="row" style="padding:14px 2px 0;border:0"><div class="row-main"><div class="row-title">Datum anfügen</div></div><div class="seg" data-date><button class="on" data-v="1">Ja</button><button data-v="0">Nein</button></div></div>
      <div class="btn-row"><button class="btn primary" data-save>${icon('check')} Speichern</button></div>`,
    onMount(el, api) {
      const t = el.querySelector('[data-t]'), s = el.querySelector('[data-s]'), prev = el.querySelector('[data-prev]');
      const upd = () => {
        const st = makeStamp({ text: (t.value || ' ').toUpperCase(), color, date, sub: s.value.trim() });
        // Bild nur austauschen statt neu einsetzen – kein kurzes Leerwerden/Springen beim Tippen
        const im = prev.querySelector('img'); if (im) im.src = st.src; else prev.innerHTML = `<img src="${st.src}" alt="">`;
        return st;
      };
      t.oninput = s.oninput = upd;
      el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { el.querySelectorAll('[data-c]').forEach(x => x.classList.remove('on')); b.classList.add('on'); color = b.dataset.c; upd(); });
      el.querySelectorAll('[data-date] button').forEach(b => b.onclick = () => { el.querySelectorAll('[data-date] button').forEach(x => x.classList.remove('on')); b.classList.add('on'); date = b.dataset.v === '1'; upd(); });
      el.querySelector('[data-save]').onclick = () => { if (!t.value.trim()) return; const st = upd(); api.close(); onSave({ ...st, text: t.value.toUpperCase(), color, date, sub: s.value.trim() }); };
      upd();
    },
  });
}

// Gespeicherter Text-Stempel mit Datum: beim Einfügen mit heutigem Datum neu erzeugen
export function freshStamp(a) {
  if (a.text && a.date) return makeStamp({ text: a.text, color: a.color, date: true, sub: a.sub });
  return a;
}

// ---------- QR-Code-Stempel ----------
// Link, WLAN (WIFI:T:…;S:…;P:…;;) oder Freitext → QR-Code lokal erzeugt (js/qr.js),
// als scharfes PNG (ganzzahlige Modulgröße) mit weißem oder transparentem Hintergrund.
const QR_COLORS = ['#111318', '#1d5fd1', '#d32f2f', '#1f9d57', '#6a3fd1'];

export function makeQrStamp({ payload, color = '#111318', bg = true, caption = '', ecl = 'M' }) {
  const qr = qrMatrix(payload, ecl);
  const margin = bg ? 2 : 0, n = qr.size + margin * 2;
  const scale = Math.max(8, Math.ceil(1100 / n));
  const code = qrCanvas(qr, { scale, margin, color, bg: bg ? '#fff' : null });
  if (!caption) return { src: code.toDataURL('image/png'), w: code.width, h: code.height, version: qr.version };
  // Beschriftung unter dem Code
  const W = code.width, fs = Math.round(W * 0.075), pad = Math.round(fs * 0.5);
  const c = document.createElement('canvas'); c.width = W;
  const g0 = c.getContext('2d'); g0.font = `600 ${fs}px Helvetica, Arial, sans-serif`;
  let t = caption; while (t.length > 1 && g0.measureText(t).width > W - pad * 2) t = t.slice(0, -2) + '…';
  c.height = code.height + fs + pad * (bg ? 1.6 : 0.8);
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(code, 0, 0);
  g.font = `600 ${fs}px Helvetica, Arial, sans-serif`; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'top';
  g.fillText(t, W / 2, code.height + (bg ? 0 : pad * 0.6));
  return { src: c.toDataURL('image/png'), w: c.width, h: c.height, version: qr.version };
}

export function qrSheet({ onInsert, onSave }) {
  const st = { type: 'url', color: QR_COLORS[0], bg: true, sec: 'WPA' };
  const seg = (k, opts, cur) => `<div class="seg" data-seg="${k}" style="width:100%">${opts.map(([v, l]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}" style="flex:1">${l}</button>`).join('')}</div>`;
  sheet({
    title: 'QR-Code',
    html: `
      ${seg('type', [['url', 'Link'], ['wifi', 'WLAN'], ['text', 'Text']], 'url')}
      <div class="qr-prev" data-prev></div>
      <div data-f="url"><div class="lbl">Adresse</div><input class="field" data-url type="url" inputmode="url" autocapitalize="off" autocorrect="off" placeholder="z. B. repair-mobile.de, E-Mail oder Telefonnummer"></div>
      <div data-f="wifi" hidden>
        <div class="lbl">WLAN-Name (SSID)</div><input class="field" data-ssid autocapitalize="off" autocorrect="off" placeholder="z. B. RepairMobile Gast">
        <div class="lbl">Verschlüsselung</div>${seg('sec', [['WPA', 'WPA/WPA2/3'], ['WEP', 'WEP'], ['nopass', 'Offen']], 'WPA')}
        <div data-passwrap><div class="lbl">Passwort</div><input class="field" data-pass autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="WLAN-Passwort"></div>
        <label class="qr-chk"><input type="checkbox" data-hidden> Verstecktes Netzwerk</label>
      </div>
      <div data-f="text" hidden><div class="lbl">Text</div><textarea class="field" data-text rows="3" placeholder="Beliebiger Text, z. B. Kontakt- oder Geräte-Infos"></textarea></div>
      <div class="lbl">Beschriftung (optional)</div><input class="field" data-cap maxlength="40" placeholder="z. B. Gäste-WLAN · Scannen zum Verbinden">
      <div class="lbl">Farbe</div>
      <div class="colors" data-cols>${QR_COLORS.map((c, i) => `<button class="color ${i ? '' : 'on'}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      <div class="row" style="padding:14px 2px 0;border:0"><div class="row-main"><div class="row-title">Hintergrund</div></div>${seg('bg', [['1', 'Weiß'], ['0', 'Transparent']], '1').replace('width:100%', '')}</div>
      <div class="btn-row">${onSave ? `<button class="btn" data-save>${icon('download')} Speichern</button>` : ''}${onInsert ? `<button class="btn primary" data-ins>${icon('check')} Einfügen</button>` : ''}</div>`,
    onMount(el, api) {
      const $ = s => el.querySelector(s), prev = $('[data-prev]');
      const payload = () => {
        if (st.type === 'url') return urlPayload($('[data-url]').value);
        if (st.type === 'wifi') { const ssid = $('[data-ssid]').value; return ssid.trim() ? wifiPayload({ ssid, pass: $('[data-pass]').value, sec: st.sec, hidden: $('[data-hidden]').checked }) : ''; }
        return $('[data-text]').value.trim();
      };
      let last = null;
      const upd = () => {
        const p = payload();
        el.querySelectorAll('[data-save],[data-ins]').forEach(b => b.disabled = !p);
        if (!p) { last = null; prev.innerHTML = `<span class="qr-ph">${icon('qr')}<small>${st.type === 'wifi' ? 'WLAN-Name eingeben' : st.type === 'url' ? 'Adresse eingeben' : 'Text eingeben'}</small></span>`; return; }
        try {
          last = { ...makeQrStamp({ payload: p, color: st.color, bg: st.bg, caption: $('[data-cap]').value.trim() }), qr: true, qrData: p };
          // Vorschau nur aktualisieren (nicht neu aufbauen): die Höhe bleibt gleich, das Fenster springt beim Tippen nicht
          const txt = p.length > 70 ? p.slice(0, 68) + '…' : p;
          let im = prev.querySelector('img');
          if (!im) { prev.innerHTML = `<img alt="QR-Code"><small></small>`; im = prev.querySelector('img'); }
          im.src = last.src; im.classList.toggle('tr', !st.bg); prev.querySelector('small').textContent = txt;
        } catch (e) { last = null; prev.innerHTML = `<span class="qr-ph err">${esc(e.message)}</span>`; el.querySelectorAll('[data-save],[data-ins]').forEach(b => b.disabled = true); }
      };
      el.querySelectorAll('[data-seg]').forEach(g => g.querySelectorAll('button').forEach(b => b.onclick = () => {
        g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); haptic();
        const k = g.dataset.seg, v = b.dataset.v;
        if (k === 'type') { st.type = v; el.querySelectorAll('[data-f]').forEach(f => f.hidden = f.dataset.f !== v); }
        if (k === 'sec') { st.sec = v; $('[data-passwrap]').hidden = v === 'nopass'; }
        if (k === 'bg') st.bg = v === '1';
        upd();
      }));
      el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { el.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', x === b)); st.color = b.dataset.c; haptic(); upd(); });
      el.querySelectorAll('input,textarea').forEach(i => i.addEventListener('input', upd));
      $('[data-hidden]').onchange = upd;
      $('[data-ins]')?.addEventListener('click', () => { if (!last) return; api.close(); onInsert(last); });
      $('[data-save]')?.addEventListener('click', () => { if (!last) return; onSave(last); if (!onInsert) api.close(); else { $('[data-save]').disabled = true; } });
      upd();
    },
  });
}
