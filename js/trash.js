// ================= Papierkorb =================
// Gelöschte PDFs bekommen deletedAt und bleiben 30 Tage wiederherstellbar.
// Danach werden sie beim App-Start endgültig entfernt.
import { db } from './db.js';
import { icon } from './icons.js';
import { sheet, toast, confirmDlg, esc, fmtSize, haptic } from './ui.js';

export const TRASH_DAYS = 30;
const DAY = 86400000;
export const isDeleted = d => !!d?.deletedAt;
export const daysLeft = d => Math.max(0, Math.ceil((d.deletedAt + TRASH_DAYS * DAY - Date.now()) / DAY));

export async function moveToTrash(ids) {
  for (const id of [].concat(ids)) {
    const d = await db.get('docs', id);
    if (d && !d.deletedAt) { d.deletedAt = Date.now(); await db.put('docs', d); }
  }
}
export async function restoreFromTrash(ids) {
  for (const id of [].concat(ids)) {
    const d = await db.get('docs', id);
    if (d && d.deletedAt) { delete d.deletedAt; await db.put('docs', d); }
  }
}
export async function purge(ids) {
  for (const id of [].concat(ids)) {
    const d = await db.get('docs', id);
    for (let i = 0; i < (d?.idSides?.length || 0); i++) { await db.del('files', `${id}#s${i}`); await db.del('files', `${id}#o${i}`); }   // Ausweis-Fotos
    await db.del('docs', id); await db.del('files', id);
  }
}
export async function trashDocs() {
  return (await db.all('docs')).filter(isDeleted).sort((a, b) => b.deletedAt - a.deletedAt);
}
export async function purgeExpired() {
  const old = (await trashDocs()).filter(d => Date.now() - d.deletedAt > TRASH_DAYS * DAY);
  if (old.length) await purge(old.map(d => d.id));
  return old.length;
}

export function trashSheet(onChange) {
  sheet({
    title: 'Papierkorb',
    html: `<p class="trash-info">Gelöschte PDFs bleiben ${TRASH_DAYS} Tage hier und werden danach automatisch endgültig gelöscht.</p>
      <div data-list></div>
      <div class="btn-row" data-acts>
        <button class="btn" data-all>${icon('restore')} Alle wiederherstellen</button>
        <button class="btn danger" data-empty>${icon('trash')} Leeren</button>
      </div>`,
    async onMount(el) {
      const list = el.querySelector('[data-list]'), acts = el.querySelector('[data-acts]');
      const render = async () => {
        const docs = await trashDocs();
        acts.hidden = !docs.length;
        list.innerHTML = docs.length ? `<div class="menu">${docs.map(d => {
          const left = daysLeft(d);
          return `<div class="row trash-row" data-id="${d.id}">
            <span class="doc-thumb" style="width:36px;height:46px;background-image:url('${d.thumb || ''}')"></span>
            <span class="row-main"><span class="row-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span>
              <span class="row-sub">${fmtSize(d.size || 0)} · <b class="${left <= 3 ? 'trash-soon' : ''}">${left === 0 ? 'wird heute gelöscht' : left === 1 ? 'noch 1 Tag' : `noch ${left} Tage`}</b></span></span>
            <button class="trash-btn" data-r="${d.id}" aria-label="Wiederherstellen">${icon('restore')}</button>
            <button class="trash-btn del" data-x="${d.id}" aria-label="Endgültig löschen">${icon('trash')}</button>
          </div>`; }).join('')}</div>`
          : `<div class="empty">${icon('trash')}<b>Papierkorb ist leer</b>Gelöschte PDFs landen zuerst hier.</div>`;
        list.querySelectorAll('[data-r]').forEach(b => b.onclick = async () => {
          await restoreFromTrash(b.dataset.r); haptic(); toast('Wiederhergestellt'); await render(); onChange && onChange();
        });
        list.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => {
          const d = docs.find(x => x.id === b.dataset.x);
          if (!(await confirmDlg('Endgültig löschen?', `„${d.name}“ wird sofort und unwiderruflich gelöscht.`, 'Endgültig löschen'))) return;
          await purge(d.id); toast('Endgültig gelöscht'); await render(); onChange && onChange();
        });
      };
      el.querySelector('[data-all]').onclick = async () => {
        const docs = await trashDocs(); if (!docs.length) return;
        await restoreFromTrash(docs.map(d => d.id)); haptic(); toast(`${docs.length} PDF(s) wiederhergestellt`); await render(); onChange && onChange();
      };
      el.querySelector('[data-empty]').onclick = async () => {
        const docs = await trashDocs(); if (!docs.length) return;
        if (!(await confirmDlg('Papierkorb leeren?', `${docs.length} PDF(s) werden sofort und unwiderruflich gelöscht.`, 'Leeren'))) return;
        await purge(docs.map(d => d.id)); toast('Papierkorb geleert'); await render(); onChange && onChange();
      };
      render();
    },
  });
}
