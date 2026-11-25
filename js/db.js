// IndexedDB: docs (Metadaten + Objekte), files (PDF-Bytes), assets (Unterschriften/Stempel)
const NAME = 'nibvion', VERSION = 1;
let _db;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['docs', 'files', 'assets']) {
        if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      }
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}

function run(store, mode, fn) {
  return open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

// Cloud-Sync hängt sich hier ein: jede Änderung an docs/files/assets wird gemeldet.
// db.raw* schreibt ohne Meldung (für Daten, die gerade aus der Cloud kommen).
const watchers = [];
export const onDbChange = fn => watchers.push(fn);
const tell = (s, id, del) => { for (const w of watchers) try { w(s, id, del); } catch (e) { console.warn(e); } };

export const db = {
  get: (s, id) => run(s, 'readonly', st => st.get(id)),
  all: (s) => run(s, 'readonly', st => st.getAll()),
  keys: (s) => run(s, 'readonly', st => st.getAllKeys()),
  put: (s, v) => run(s, 'readwrite', st => st.put(v)).then(r => { tell(s, v.id, false); return r; }),
  del: (s, id) => run(s, 'readwrite', st => st.delete(id)).then(r => { tell(s, id, true); return r; }),
  clear: async (s) => { const ks = await db.keys(s); await run(s, 'readwrite', st => st.clear()); for (const k of ks) tell(s, k, true); },
  rawPut: (s, v) => run(s, 'readwrite', st => st.put(v)),
  rawDel: (s, id) => run(s, 'readwrite', st => st.delete(id)),
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
