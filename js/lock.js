// ================= Ordner-Sperre: PIN & Face ID / Touch ID =================
// Ein Ordner bekommt f.lock = { v, len, salt, hash, iter, bio, relock }.
// • PIN (4 oder 6 Ziffern) → PBKDF2-SHA-256 mit Zufalls-Salt über die Web Crypto API; gespeichert
//   wird nur der Hash. • Face ID / Touch ID über WebAuthn (Plattform-Authenticator, Gerät behält den
//   Schlüssel) – schlägt sie fehl oder fehlt sie, gilt der PIN.
// • Solange ein Ordner gesperrt ist, sind seine Dateien überall verborgen (Alle, Zuletzt, Suche, Filter,
//   Auswahllisten). Entsperrt bleibt er bis zum Verlassen des Ordners bzw. bis die App länger im
//   Hintergrund war – je nach Einstellung.
// Hinweis: Das ist ein Sichtschutz in der App, keine Verschlüsselung der Dateien auf dem Gerät.
import { db, onDbChange } from './db.js';
import { icon } from './icons.js';
import { sheet, toast, haptic, esc } from './ui.js';
import { springFrames, reducedMotion } from './fx.js';

const ITER = 150000;
const locked = new Set();          // Ordner-IDs mit Sperre
const unlocked = new Set();        // gerade entsperrt
const relockMode = new Map();      // id → 'leave' | 'app'
const fails = new Map();           // id → { n, until }
const listeners = new Set();
export const onLockChange = fn => listeners.add(fn);
const notify = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.warn(e); } });

// ---------- Zustand ----------
export async function refreshLocks() {
  const fs = (await db.all('assets')).filter(a => a.kind === 'folder');
  locked.clear(); relockMode.clear();
  for (const f of fs) if (f.lock?.hash) { locked.add(f.id); relockMode.set(f.id, f.lock.relock || 'leave'); }
  for (const id of [...unlocked]) if (!locked.has(id)) unlocked.delete(id);
}
let rT;
onDbChange(s => { if (s === 'assets') { clearTimeout(rT); rT = setTimeout(() => refreshLocks().then(notify), 120); } });

export const isLockedFolder = id => locked.has(id);
export const isOpenFolder = id => !locked.has(id) || unlocked.has(id);
/** Dokument verbergen? (liegt in einem gesperrten, nicht entsperrten Ordner) */
export const isHidden = d => !!d?.folder && locked.has(d.folder) && !unlocked.has(d.folder);
export const visibleDocs = docs => docs.filter(d => !isHidden(d));

/** Ordner verlassen → je nach Einstellung wieder sperren */
export function leftFolder(id) {
  if (id && unlocked.has(id) && relockMode.get(id) !== 'app') { unlocked.delete(id); notify(); }
}
export function relockAll() { if (!unlocked.size) return; unlocked.clear(); notify(); }

// App länger als 20 s im Hintergrund → alles wieder sperren (kurze Unterbrechungen wie
// Teilen-Menü oder Dateiauswahl sperren nicht)
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 20000) relockAll();
});
addEventListener('pagehide', () => { unlocked.clear(); });

// ---------- Krypto ----------
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
async function pinHash(pin, salt, iter = ITER) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('nibvion-ordner:' + pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
// Vergleich ohne frühen Abbruch
const same = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
async function checkPin(f, pin) { return same(await pinHash(pin, unb64(f.lock.salt), f.lock.iter || ITER), f.lock.hash); }

// ---------- Face ID / Touch ID (WebAuthn) ----------
let bioP = null;
export function bioAvailable() {
  bioP ??= (async () => {
    try { return !!(window.PublicKeyCredential && isSecureContext && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
  })();
  return bioP;
}
const bioName = () => /iPhone|iPad|Mac/.test(navigator.userAgent) ? (/iPhone|iPad/.test(navigator.userAgent) && screen.height >= 812 ? 'Face ID' : 'Touch ID') : 'Biometrie';
// Muss direkt aus einem Tipp heraus aufgerufen werden (iOS)
function bioRegister(name) {
  const ch = crypto.getRandomValues(new Uint8Array(32)), uidb = crypto.getRandomValues(new Uint8Array(16));
  return navigator.credentials.create({
    publicKey: {
      challenge: ch, rp: { name: 'Nibvion' }, user: { id: uidb, name: 'Ordner „' + name + '“', displayName: 'Nibvion-Ordner' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000, attestation: 'none',
    },
  }).then(c => c ? b64url(c.rawId) : null);
}
function bioVerify(credId) {
  return navigator.credentials.get({
    publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [{ type: 'public-key', id: unb64url(credId), transports: ['internal'] }], userVerification: 'required', timeout: 60000 },
  }).then(c => !!c);
}

// ---------- PIN-Tastatur ----------
/**
 * pinPad({ title, sub, len, check(code) → Promise<true|string>, bio: { label, run() → Promise<bool> } })
 * check gibt true (ok) oder eine Fehlermeldung zurück. → Promise<boolean>
 */
function pinPad({ title, sub = '', len = 4, check, bio = null, autoBio = null }) {
  return new Promise(res => {
    let code = '', busyNow = false, ok = false, kb = null;
    sheet({
      title: '', noHead: true,
      html: `<div class="pin">
        <div class="pin-lock">${icon('lock')}</div>
        <h3 class="pin-t">${esc(title)}</h3><p class="pin-s" data-sub>${esc(sub)}</p>
        <div class="pin-dots" data-dots>${'<i></i>'.repeat(len)}</div>
        <div class="pin-pad no-swipe">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-n="${n}">${n}</button>`).join('')}
          ${bio ? `<button class="pin-fn" data-bio aria-label="${esc(bio.label)}">${icon('faceId')}<small>${esc(bio.label)}</small></button>` : '<span></span>'}
          <button data-n="0">0</button>
          <button class="pin-fn" data-del aria-label="Löschen">${icon('chevronLeft')}</button></div>
        <button class="pin-cancel" data-cancel>Abbrechen</button></div>`,
      onMount(el, api) {
        const dots = el.querySelector('[data-dots]'), subEl = el.querySelector('[data-sub]');
        const paint = () => dots.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i < code.length));
        const shake = msg => {
          haptic(); try { navigator.vibrate?.([30, 40, 30]); } catch {}
          subEl.textContent = msg; subEl.classList.add('err');
          if (!reducedMotion() && dots.animate) {
            const sp = springFrames({ stiffness: 700, damping: 9, velocity: 40 }, v => ({ transform: `translateX(${((1 - v) * 18).toFixed(2)}px)` }), 40);
            dots.animate(sp.frames, { duration: sp.ms });
          }
          code = ''; setTimeout(paint, 120);
        };
        const done = () => { ok = true; dots.classList.add('ok'); haptic(); setTimeout(() => api.close(), reducedMotion() ? 0 : 260); };
        const press = async n => {
          if (busyNow || code.length >= len) return;
          code += n; haptic(); paint(); subEl.classList.remove('err');
          if (code.length < len) return;
          busyNow = true;
          try { const r = await check(code, { shake, done }); if (r === true) done(); else if (typeof r === 'string') shake(r); }
          finally { busyNow = false; }
        };
        el.querySelectorAll('[data-n]').forEach(b => b.onclick = () => press(b.dataset.n));
        el.querySelector('[data-del]').onclick = () => { if (code) { code = code.slice(0, -1); haptic(); paint(); } };
        el.querySelector('[data-cancel]').onclick = () => api.close();
        const runBio = p => (p || bio.run()).then(r => { if (r) done(); }).catch(() => { subEl.textContent = 'Bitte PIN eingeben'; });
        el.querySelector('[data-bio]')?.addEventListener('click', () => runBio());
        if (autoBio) runBio(autoBio);
        // Hardware-Tastatur (Mac/iPad)
        kb = e => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') el.querySelector('[data-del]').click(); };
        document.addEventListener('keydown', kb);
      },
      onClose() { if (kb) document.removeEventListener('keydown', kb); res(ok); },
    });
  });
}

// ---------- Entsperren ----------
/** Muss direkt aus einem Tipp aufgerufen werden (Face ID startet sofort). → Promise<boolean> */
export function unlockFolder(f) {
  if (!f?.lock?.hash || unlocked.has(f.id)) return Promise.resolve(true);
  // Face ID sofort anstoßen (noch innerhalb des Tipps), parallel die PIN-Tastatur zeigen
  const auto = f.lock.bio && window.PublicKeyCredential ? bioVerify(f.lock.bio) : null;
  return pinPad({
    title: `„${f.name}“ ist gesperrt`, sub: `${f.lock.len}-stelligen PIN eingeben`, len: f.lock.len,
    bio: f.lock.bio ? { label: bioName(), run: () => bioVerify(f.lock.bio) } : null, autoBio: auto,
    async check(code) {
      const fl = fails.get(f.id) || { n: 0, until: 0 };
      if (Date.now() < fl.until) return `Zu viele Versuche – noch ${Math.ceil((fl.until - Date.now()) / 1000)} s warten`;
      if (await checkPin(f, code)) { fails.delete(f.id); return true; }
      fl.n++; if (fl.n >= 5) fl.until = Date.now() + (fl.n >= 10 ? 300 : 30) * 1000;
      fails.set(f.id, fl);
      return fl.until > Date.now() ? 'Zu viele Versuche – kurz warten' : `Falscher PIN${fl.n >= 3 ? ` (${fl.n}. Versuch)` : ''}`;
    },
  }).then(ok => { if (ok) { unlocked.add(f.id); notify(); } return ok; });
}

// ---------- Einrichten / Verwalten ----------
async function choosePin(len, wantBio, f) {
  let first = null, cred = null;
  const a = await pinPad({ title: 'Neuen PIN festlegen', sub: `${len} Ziffern für „${f.name}“`, len, check: async c => { first = c; return true; } });
  if (!a) return null;
  const b = await pinPad({
    title: 'PIN bestätigen', sub: 'Bitte noch einmal eingeben', len,
    async check(c) {
      if (c !== first) return 'Stimmt nicht überein – nochmal';
      // Face ID direkt aus diesem Tipp heraus einrichten (iOS verlangt eine Nutzeraktion)
      if (wantBio) { try { cred = await bioRegister(f.name); } catch (e) { console.warn(e); cred = null; toast(`${bioName()} wurde nicht eingerichtet – PIN gilt`, true); } }
      return true;
    },
  });
  if (!b) return null;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { pin: first, salt: b64(salt), hash: await pinHash(first, salt), cred };
}

/** Ordner sperren / Sperre verwalten (⋯-Menü des Ordners) */
export async function lockSheet(f, onDone) {
  const has = !!f.lock?.hash;
  if (has && !(await unlockFolder(f))) return;
  const bio = await bioAvailable();
  const st = { len: f.lock?.len || 4, relock: f.lock?.relock || 'leave', bio: has ? !!f.lock.bio : bio };
  sheet({
    title: has ? 'Sperre verwalten' : 'Ordner sperren',
    html: `<div class="lk-hero"><span class="lk-ic">${icon(has ? 'lock' : 'unlock')}</span><div><b>${esc(f.name)}</b><span>${has ? `Gesperrt mit ${f.lock.len}-stelligem PIN${f.lock.bio ? ' & ' + bioName() : ''}` : 'Dateien bleiben verborgen, bis du den Ordner entsperrst.'}</span></div></div>
      ${has ? '' : `<div class="lk-row"><span>PIN-Länge</span><div class="seg" data-len><button data-v="4">4 Ziffern</button><button data-v="6">6 Ziffern</button></div></div>`}
      ${bio ? `<div class="lk-row"><span>${bioName()}<small>PIN bleibt als Ersatz</small></span><div class="seg" data-bio><button data-v="1">An</button><button data-v="0">Aus</button></div></div>` : `<p class="lk-note">${icon('info')} Face ID / Touch ID ist hier nicht verfügbar – der Ordner wird mit PIN gesperrt.</p>`}
      <div class="lk-row col"><span>Wieder sperren<small>Immer auch, wenn die App länger im Hintergrund war</small></span><div class="seg" data-relock><button data-v="leave">Beim Verlassen</button><button data-v="app">Beim App-Schließen</button></div></div>
      <p class="lk-note">${icon('shield')} Sichtschutz in Nibvion: Gesperrte Dateien erscheinen nicht unter „Alle“, „Zuletzt“, in der Suche und in Auswahllisten. Die Dateien selbst werden nicht verschlüsselt.</p>
      <div class="btn-row">${has ? `<button class="btn danger" data-off>${icon('unlock')} Sperre entfernen</button><button class="btn" data-pin>PIN ändern</button>` : ''}<button class="btn primary" data-ok>${icon('lock')} ${has ? 'Speichern' : 'PIN festlegen'}</button></div>`,
    onMount(el, api) {
      const paint = () => {
        el.querySelectorAll('[data-len] button').forEach(b => b.classList.toggle('on', +b.dataset.v === st.len));
        el.querySelectorAll('[data-relock] button').forEach(b => b.classList.toggle('on', b.dataset.v === st.relock));
        el.querySelectorAll('[data-bio] button').forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === st.bio));
      };
      el.querySelectorAll('[data-len] button').forEach(b => b.onclick = () => { st.len = +b.dataset.v; haptic(); paint(); });
      el.querySelectorAll('[data-relock] button').forEach(b => b.onclick = () => { st.relock = b.dataset.v; haptic(); paint(); });
      el.querySelectorAll('[data-bio] button').forEach(b => b.onclick = () => { st.bio = b.dataset.v === '1'; haptic(); paint(); });
      const save = async lock => {
        if (lock) f.lock = lock; else delete f.lock;
        await db.put('assets', f);
        await refreshLocks(); if (lock) unlocked.add(f.id); else unlocked.delete(f.id);
        notify(); onDone?.();
      };
      el.querySelector('[data-ok]').onclick = async () => {
        if (!has) {
          api.close();
          const r = await choosePin(st.len, bio && st.bio, f);
          if (!r) return;
          await save({ v: 1, len: st.len, salt: r.salt, hash: r.hash, iter: ITER, bio: r.cred || null, relock: st.relock });
          unlocked.delete(f.id); notify();
          toast(`„${f.name}“ ist jetzt gesperrt`); return;
        }
        // Verwalten: Face ID an/aus (Einrichten direkt aus diesem Tipp), Wieder-sperren
        let cred = f.lock.bio;
        if (st.bio && !cred && bio) { try { cred = await bioRegister(f.name); } catch { toast(`${bioName()} wurde nicht eingerichtet`, true); } }
        if (!st.bio) cred = null;
        api.close();
        await save({ ...f.lock, bio: cred || null, relock: st.relock });
        toast('Gespeichert');
      };
      el.querySelector('[data-pin]')?.addEventListener('click', async () => {
        api.close();
        const r = await choosePin(f.lock.len, false, f);
        if (!r) return;
        await save({ ...f.lock, salt: r.salt, hash: r.hash, iter: ITER });
        toast('PIN geändert');
      });
      el.querySelector('[data-off]')?.addEventListener('click', async () => {
        api.close(); await save(null); toast('Sperre entfernt');
      });
      paint();
    },
  });
}
