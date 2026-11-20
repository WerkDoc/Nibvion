// Gespeicherte Unterschriften & Stempel
import { db, uid } from './db.js';
import { sheet, toast, confirmDlg, esc, pickFiles, haptic } from './ui.js';
import { icon } from './icons.js';
import { signaturePad, STAMP_PRESETS, STAMP_COLORS, makeStamp } from './sign.js';
import { normalizeImage } from './pdfcore.js';
import { settings } from './settings.js';

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
          <button class="asset add" data-img>${icon('upload')}Stempelbild</button>` +
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
      <input class="field" data-s value="${esc(settings.get('stampName'))}" placeholder="z. B. RepairMobile" maxlength="40">
      <div class="lbl">Farbe</div>
      <div class="colors" data-cols>${STAMP_COLORS.map((c, i) => `<button class="color ${i ? '' : 'on'}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      <div class="row" style="padding:14px 2px 0;border:0"><div class="row-main"><div class="row-title">Datum anfügen</div></div><div class="seg" data-date><button class="on" data-v="1">Ja</button><button data-v="0">Nein</button></div></div>
      <div class="btn-row"><button class="btn primary" data-save>${icon('check')} Speichern</button></div>`,
    onMount(el, api) {
      const t = el.querySelector('[data-t]'), s = el.querySelector('[data-s]'), prev = el.querySelector('[data-prev]');
      const upd = () => { const st = makeStamp({ text: (t.value || ' ').toUpperCase(), color, date, sub: s.value.trim() }); prev.innerHTML = `<img src="${st.src}">`; return st; };
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
