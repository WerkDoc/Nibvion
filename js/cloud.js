// ================= Nibvion-Cloud: Abgleich über Supabase, Ende-zu-Ende verschlüsselt =================
// • Anmeldung mit E-Mail + Passwort. Das echte Passwort verlässt das Gerät nie:
//   Supabase bekommt nur einen daraus abgeleiteten Wert (PBKDF2 „auth“).
// • Ein zufälliger Datenschlüssel (AES-256-GCM) verschlüsselt alles. Er liegt in der Cloud nur
//   verpackt mit einem zweiten, ebenfalls aus dem Passwort abgeleiteten Schlüssel (PBKDF2 „enc“).
// • Jede Änderung an docs/files/assets wird als verschlüsselte Datei in Storage abgelegt,
//   die Tabelle nib_items listet nur Schlüssel + Zeitstempel (letzte Änderung gewinnt).
import { db, onDbChange } from './db.js';
import { settings } from './settings.js';

const BUCKET = 'nibvion', STORES = ['docs', 'files', 'assets'];
const LS = { auth: 'nibvion.cloud.auth', dirty: 'nibvion.cloud.dirty', known: 'nibvion.cloud.known', last: 'nibvion.cloud.last' };
const te = new TextEncoder(), td = new TextDecoder();
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));

// ---------- Hilfen ----------
const b64 = u8 => { let s = ''; const a = new Uint8Array(u8); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = s => b64(te.encode(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// Eingebautes Nibvion-Projekt: dann muss nur noch E-Mail + Passwort eingegeben werden.
// Der Publishable key ist öffentlich gedacht (Zugriff regeln die RLS-Regeln aus cloud.sql).
export const NIB_URL = 'https://mkumrhjtldwbeenxocxf.supabase.co';
export const NIB_KEY = '';
const base = () => (settings.get('cloudUrl') || NIB_URL).replace(/\/+$/, '');
const anon = () => settings.get('cloudAnon') || (base() === NIB_URL ? NIB_KEY : '');
export const cloudProject = () => ({ url: base(), key: anon() });

async function derive(pw, email, purpose) {
  const k = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(`nibvion-${purpose}|${email.toLowerCase()}`), iterations: 300000 }, k, 256));
}
const aesKey = (raw, extractable = false) => crypto.subtle.importKey('raw', raw, 'AES-GCM', extractable, ['encrypt', 'decrypt']);
async function seal(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}
const open_ = async (key, buf) => { const a = new Uint8Array(buf); return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: a.subarray(0, 12) }, key, a.subarray(12))); };

// Datenschlüssel lokal (eigene kleine IndexedDB, wird nicht synchronisiert)
const keyDb = () => new Promise((res, rej) => { const r = indexedDB.open('nibvion-cloud', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const keyOp = async (mode, fn) => { const d = await keyDb(); return new Promise((res, rej) => { const t = d.transaction('k', mode), q = fn(t.objectStore('k')); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); };
let DEK = null;
const loadDek = async () => DEK ||= await keyOp('readonly', s => s.get('dek')) || null;

// ---------- Supabase (ohne Bibliothek, nur fetch) ----------
const auth = () => lsGet(LS.auth, null);
async function gotrue(path, body) {
  const r = await fetch(`${base()}/auth/v1/${path}`, { method: 'POST', headers: { apikey: anon(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.msg || j.error_description || j.message || `Fehler ${r.status}`);
  return j;
}
const keepSession = j => lsSet(LS.auth, { ...auth(), access: j.access_token, refresh: j.refresh_token, exp: j.expires_at || (Date.now() / 1000 + (j.expires_in || 3600)), uid: j.user?.id || auth()?.uid, email: j.user?.email || auth()?.email });
async function token() {
  const a = auth(); if (!a?.refresh) throw new Error('Nicht angemeldet');
  if (a.exp - Date.now() / 1000 > 90) return a.access;
  keepSession(await gotrue('token?grant_type=refresh_token', { refresh_token: a.refresh }));
  return auth().access;
}
async function api(path, opt = {}) {
  const r = await fetch(`${base()}${path}`, { ...opt, headers: { apikey: anon(), Authorization: `Bearer ${await token()}`, ...(opt.headers || {}) } });
  if (!r.ok) {
    const t = await r.text().catch(() => ''); let j = {}; try { j = JSON.parse(t); } catch {}
    const code = j.code || '', msg = j.message || j.error || t.slice(0, 160);
    const e = new Error(
      code === '42501' || /permission denied/i.test(msg) ? 'Supabase verweigert den Zugriff – die GRANT-Zeilen aus cloud.sql ausführen'
      : code === 'PGRST205' || code === '42P01' ? 'Cloud-Tabellen fehlen – supabase/cloud.sql ausführen'
      : /bucket not found/i.test(msg) ? 'Speicher-Bucket „nibvion“ fehlt – supabase/cloud.sql ausführen'
      : `Supabase ${r.status}: ${msg}`);
    e.status = r.status; e.code = code; throw e;
  }
  return r;
}

// ---------- Konto ----------
export const cloudOn = () => !!(auth()?.refresh && base() && anon());
export const cloudEmail = () => auth()?.email || '';

export async function cloudLogin(email, pw, create = false) {
  email = email.trim().toLowerCase();
  const authPw = b64(await derive(pw, email, 'auth'));
  let j;
  if (create) {
    j = await gotrue('signup', { email, password: authPw });
    if (!j.access_token) throw Object.assign(new Error('Bitte bestätige zuerst die E-Mail von Supabase und melde dich dann an.'), { confirm: true });
  } else {
    try { j = await gotrue('token?grant_type=password', { email, password: authPw }); }
    catch (e) { throw new Error(/invalid/i.test(e.message) ? 'E-Mail oder Passwort falsch' : /confirm/i.test(e.message) ? 'E-Mail noch nicht bestätigt – Link in der Mail antippen' : e.message); }
  }
  lsSet(LS.auth, null); keepSession(j);
  try { await setupKey(pw, email); }
  catch (e) { lsSet(LS.auth, null); throw e; }          // halb angemeldet bleibt nichts hängen
  // Alles Lokale vormerken; beim Abgleich gewinnt jeweils der neuere Stand
  lsSet(LS.known, {}); lsSet(LS.last, '1970-01-01T00:00:00Z');
  if (!await db.get('assets', PREFS_ID)) await writePrefs(true);   // eigene Einstellungen erst anlegen, wenn welche da sind
  await markAll();
}

async function setupKey(pw, email) {
  // Datenschlüssel holen oder (erstes Gerät) anlegen
  const kek = await aesKey(await derive(pw, email, 'enc'));
  const rows = await (await api('/rest/v1/nib_keys?select=wrapped')).json();
  let raw;
  if (rows.length) {
    try { raw = await open_(kek, unb64(rows[0].wrapped)); } catch { lsSet(LS.auth, null); throw new Error('Passwort passt nicht zum Cloud-Schlüssel'); }
  } else {
    raw = crypto.getRandomValues(new Uint8Array(32));
    await api('/rest/v1/nib_keys', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: auth().uid, wrapped: b64(await seal(kek, raw)), iv: '' }) });
  }
  DEK = await aesKey(raw);
  await keyOp('readwrite', s => s.put(DEK, 'dek'));
}

export async function cloudLogout() {
  lsSet(LS.auth, null); lsSet(LS.dirty, {}); lsSet(LS.known, {}); localStorage.removeItem(LS.last);
  DEK = null; await keyOp('readwrite', s => s.delete('dek'));
  status({ state: 'off' });
}

// ---------- Einstellungen, die mitwandern (Online-Scan / TextIn) ----------
// Liegen als verschlüsselter Eintrag in „assets“ (kind: 'prefs'), damit sie nach dem Anmelden
// auf jedem Gerät automatisch wieder da sind.
const PREFS_ID = 'nib-prefs', PREF_KEYS = ['onlineUrl', 'onlineKey', 'onlineMode'];
async function writePrefs(onlyIfSet = false) {
  const vals = Object.fromEntries(PREF_KEYS.map(k => [k, settings.get(k) || '']));
  if (onlyIfSet && !vals.onlineKey) return;
  const now = Date.now();
  await db.rawPut('assets', { id: PREFS_ID, kind: 'prefs', ...vals, created: now, updated: now });
}
/** Nach Änderungen an den Online-Scan-Einstellungen aufrufen. */
export async function savePrefs() { await writePrefs(); if (cloudOn()) markDirty('assets', PREFS_ID); }
function applyPrefs(rec) { for (const k of PREF_KEYS) if (k in rec) settings.set(k, rec[k] || ''); }

// ---------- Änderungen merken ----------
const KEY = (s, id) => `${s}:${id}`;
const dirty = () => lsGet(LS.dirty, {});
function markDirty(s, id, del) {
  if (!cloudOn() || !STORES.includes(s)) return;
  const d = dirty(); d[KEY(s, id)] = { t: Date.now(), del: !!del }; lsSet(LS.dirty, d);
  schedule(4000);
}
onDbChange(markDirty);

async function markAll() {
  const d = dirty(), docs = await db.all('docs'), dt = Object.fromEntries(docs.map(x => [x.id, x.updated || x.created || 1]));
  for (const x of docs) d[KEY('docs', x.id)] ||= { t: dt[x.id] };
  for (const id of await db.keys('files')) d[KEY('files', id)] ||= { t: dt[String(id).split('#')[0]] || 1 };
  for (const a of await db.all('assets')) d[KEY('assets', a.id)] ||= { t: a.updated || a.created || 1 };
  lsSet(LS.dirty, d);
}

// ---------- Packen / Entpacken ----------
const replacer = (k, v) => v instanceof ArrayBuffer ? { __ab: b64(new Uint8Array(v)) } : ArrayBuffer.isView(v) ? { __u8: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) } : v;
const reviver = (k, v) => v && typeof v === 'object' ? (v.__ab ? unb64(v.__ab).buffer : v.__u8 ? unb64(v.__u8) : v) : v;
function pack(s, rec) {
  let bin = null, meta = rec;
  if (s === 'files' && rec.data) {
    const { data, ...rest } = rec; meta = rest;
    bin = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  const js = te.encode(JSON.stringify(meta, replacer));
  const out = new Uint8Array(4 + js.length + (bin ? bin.length : 0));
  new DataView(out.buffer).setUint32(0, js.length); out.set(js, 4); if (bin) out.set(bin, 4 + js.length);
  return out;
}
function unpack(s, u8) {
  const n = new DataView(u8.buffer, u8.byteOffset).getUint32(0);
  const rec = JSON.parse(td.decode(u8.subarray(4, 4 + n)), reviver);
  if (s === 'files') rec.data = u8.slice(4 + n).buffer;
  return rec;
}
const objPath = k => `${auth().uid}/${b64url(k)}`;

// ---------- Abgleich ----------
let running = null, timer = null, listeners = [], last = { state: 'off' };
export const onCloudStatus = fn => { listeners.push(fn); fn(last); };
function status(s) { last = { ...last, ...s }; for (const f of listeners) try { f(last); } catch {} }
export const cloudStatus = () => last;

export function schedule(ms = 0) {
  if (!cloudOn()) return;
  clearTimeout(timer); timer = setTimeout(() => cloudSync().catch(() => {}), ms);
}

export function cloudSync({ onProgress } = {}) {
  if (!cloudOn()) return Promise.resolve(null);
  if (running) return running;
  running = (async () => {
    status({ state: 'sync' });
    try {
      if (!await loadDek()) { await cloudLogout(); status({ state: 'off', error: null }); return null; }
      const got = await pull(onProgress), sent = await push(onProgress);
      settings.set('cloudLast', Date.now());
      status({ state: 'ok', at: Date.now(), error: null });
      if (got) dispatchEvent(new CustomEvent('nib-cloud-pulled', { detail: got }));
      return { got, sent };
    } catch (e) {
      console.warn('Cloud', e);
      status({ state: 'error', error: e.status === 401 ? 'Anmeldung abgelaufen' : navigator.onLine === false ? 'Offline' : e.message });
      throw e;
    } finally { running = null; }
  })();
  return running;
}

async function pull(onProgress) {
  let after = lsGet(LS.last, '1970-01-01T00:00:00Z'), got = 0;
  const known = lsGet(LS.known, {});
  for (;;) {
    const rows = await (await api(`/rest/v1/nib_items?select=k,updated,deleted,server_ts&server_ts=gt.${encodeURIComponent(after)}&order=server_ts.asc&limit=300`)).json();
    if (!rows.length) break;
    let i = 0;
    for (const r of rows) {
      i++; onProgress?.(`Lade aus der Cloud … ${got + 1}`);
      const d = dirty()[r.k];
      if (d && d.t >= r.updated) { if (d.t === r.updated) { const x = dirty(); delete x[r.k]; lsSet(LS.dirty, x); } known[r.k] = r.updated; continue; }
      if ((known[r.k] || 0) >= r.updated) continue;
      const [s, ...rest] = r.k.split(':'), id = rest.join(':');
      if (!STORES.includes(s)) continue;
      if (r.deleted) await db.rawDel(s, id);
      else {
        const res = await api(`/storage/v1/object/authenticated/${BUCKET}/${objPath(r.k)}`);
        const rec = unpack(s, await open_(DEK, await res.arrayBuffer()));
        await db.rawPut(s, rec);
        if (s === 'assets' && rec.kind === 'prefs') applyPrefs(rec);
      }
      known[r.k] = r.updated; got++;
      const x = dirty(); if (x[r.k] && x[r.k].t <= r.updated) { delete x[r.k]; lsSet(LS.dirty, x); }
      if (got % 10 === 0) lsSet(LS.known, known);
    }
    after = rows[rows.length - 1].server_ts;
    lsSet(LS.known, known); lsSet(LS.last, after);
    if (rows.length < 300) break;
  }
  return got;
}

async function push(onProgress) {
  const todo = Object.entries(dirty());
  if (!todo.length) return 0;
  const known = lsGet(LS.known, {}), uid = auth().uid;
  let sent = 0;
  const one = async ([k, d]) => {
    const [s, ...rest] = k.split(':'), id = rest.join(':');
    let del = d.del, size = 0;
    if (!del) {
      const rec = await db.get(s, id);
      if (!rec) del = true;
      else {
        const body = await seal(DEK, pack(s, rec)); size = body.length;
        await api(`/storage/v1/object/${BUCKET}/${objPath(k)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }, body });
      }
    }
    if (del) await api(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [objPath(k)] }) }).catch(() => {});
    await api('/rest/v1/nib_items?on_conflict=user_id,k', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ user_id: uid, k, updated: d.t, deleted: !!del, size }]) });
    known[k] = d.t; sent++;
    onProgress?.(`Sichere in der Cloud … ${sent}/${todo.length}`);
    const x = dirty(); if (x[k] && x[k].t === d.t) { delete x[k]; lsSet(LS.dirty, x); }   // inzwischen erneut geändert → bleibt vorgemerkt
  };
  // 3 gleichzeitig
  const q = todo.slice();
  await Promise.all([0, 1, 2].map(async () => { while (q.length) await one(q.shift()); }));
  lsSet(LS.known, known);
  return sent;
}

export const pendingCount = () => Object.keys(dirty()).length;

// Start: gleich abgleichen, beim Zurückkehren in die App und jede Minute
export function initCloud() {
  if (cloudOn()) { status({ state: 'idle', at: settings.get('cloudLast') }); schedule(800); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
  addEventListener('online', () => schedule(300));
  setInterval(() => { if (document.visibilityState === 'visible') schedule(0); }, 60000);
}
