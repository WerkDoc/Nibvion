// ================= Live-Scanner: Kamera mit Rahmenerkennung =================
// Die Kamera läuft direkt in der App. Alle ~120 ms wird ein verkleinertes Bild auf ein
// Dokument untersucht, der Rahmen wird live eingeblendet. „Auto“ löst aus, sobald das
// Blatt ruhig erkannt ist. Ergebnis: Liste von { img: Canvas, corners, rot } mit
// list.mode (gewählter Modus, per Wischen umschaltbar) und list.idType (Art des Ausweises).
import { icon } from './icons.js';
import { haptic, toast, pickFiles, busy as showBusy, confirmDlg } from './ui.js';
import { detectQuad, detectCorners, cardInGuide, cardCorners, loadFileImage, FULL, render, warp } from './scanner.js';

export const cameraSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

const AUTO_KEY = 'nibvion.camAuto';

// CSS-matrix3d, die ein Rechteck (W×H, Ursprung oben links) projektiv auf das Viereck Q legt
function quadMatrix(W, H, Q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = Q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let a, b, c = x0, d, e, f = y0, g = 0, h = 0;
  if (Math.abs(sx) < 1e-6 && Math.abs(sy) < 1e-6) { a = x1 - x0; b = x3 - x0; d = y1 - y0; e = y3 - y0; }
  else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; d = y1 - y0 + g * y1; e = y3 - y0 + h * y3;
  }
  return `matrix3d(${a / W},${d / W},0,${g / W},${b / H},${e / H},0,${h / H},0,0,1,0,${c},${f},0,1)`;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));


// Modi zum Durchwischen (wie CamScanner)
export const CAM_MODES = [
  { id: 'scan', label: 'Scannen' },
  { id: 'id', label: 'Ausweise' },
  { id: 'text', label: 'Text extrahieren' },
  { id: 'word', label: 'Zu Word' },
  { id: 'excel', label: 'Zu Excel' },
  { id: 'sign', label: 'Unterschreiben' },
  { id: 'stamp', label: 'Zeitstempel' },
  { id: 'qr', label: 'QR-Code' },
];
const ID_TYPES = [
  { id: 'idcard', label: 'ID-Karte', sides: 2, r: 85.6 / 54 },
  { id: 'driver', label: 'Führerschein', sides: 2, r: 85.6 / 54 },
  { id: 'passport', label: 'Reisepass', sides: 1, r: 125 / 88 },
  { id: 'bank', label: 'Bankkarte', sides: 2, r: 85.6 / 54 },
  { id: 'cert', label: 'Zertifikat', sides: 0 },
  { id: 'other', label: 'Andere', sides: 2, r: 85.6 / 54 },
];
const HINTS = {
  scan: 'Dokument ins Bild halten', text: 'Text ins Bild halten', word: 'Dokument ins Bild halten',
  excel: 'Tabelle ins Bild halten', sign: 'Dokument zum Unterschreiben', stamp: 'Foto mit Datum und Uhrzeit', qr: 'QR-Code in den Rahmen halten',
};
let jsqrP = null;
const loadJsQR = () => jsqrP ??= new Promise((res, rej) => {
  if (window.jsQR) return res(window.jsQR);
  const s = document.createElement('script'); s.src = new URL('../lib/jsQR.js', import.meta.url).href;
  s.onload = () => res(window.jsQR); s.onerror = () => { jsqrP = null; rej(new Error('QR-Leser nicht geladen')); };
  document.head.appendChild(s);
});
const two = n => String(n).padStart(2, '0');
const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const stampText = (d = new Date()) => ({ time: `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`, date: `${WD[d.getDay()]} | ${two(d.getDate())}.${two(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}` });

export { cardCorners };

export function liveScanner({ startCount = 0, mode: startMode = 'scan', idType: startId = 'idcard', lockMode = false, maxShots = 0 } = {}) {
  return new Promise(async resolve => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
    } catch (e) {
      console.warn(e);
      return resolve(null);           // Aufrufer weicht auf die normale Kamera-Auswahl aus
    }
    const track = stream.getVideoTracks()[0];
    let auto = localStorage.getItem(AUTO_KEY) !== '0';
    let torch = false;
    let mode = startMode, idType = startId;
    const items = [];

    const wrap = document.createElement('div');
    wrap.className = 'cam-wrap';
    wrap.innerHTML = `
      <div class="cam-top">
        <button class="cam-round" data-x aria-label="Schließen">${icon('x')}</button>
        <div class="cam-top-r">
          <button class="cam-round" data-torch aria-label="Licht" hidden>${icon('flash')}</button>
          <button class="cam-pill ${auto ? 'on' : ''}" data-auto>Auto</button>
        </div>
      </div>
      <div class="cam-stage">
        <video playsinline muted autoplay></video>
        <svg class="cam-svg"><polygon class="cam-quad"/></svg>
        <div class="cam-guide"><i></i><i></i><i></i><i></i><span class="cam-guide-lbl"></span></div>
        <div class="cam-qrbox"><i></i><i></i><i></i><i></i><b></b></div>
        <div class="cam-stamp"><div class="cs-time"></div><div class="cs-date"></div></div>
        <div class="cam-flash"></div>
        <div class="cam-idtypes">${ID_TYPES.map(t => `<button data-idt="${t.id}">${t.label}</button>`).join('')}</div>
        <div class="cam-hint">Dokument ins Bild halten</div>
        <div class="cam-qrres" hidden><div class="cqr-txt"></div><div class="cqr-btns"><button data-qcopy>${icon('copy')} Kopieren</button><button data-qopen>${icon('share')} Öffnen</button><button data-qagain>Weiter scannen</button></div></div>
      </div>
      <div class="cam-modes"><div class="cam-mode-track">${CAM_MODES.map(m => `<button data-m="${m.id}">${m.label}</button>`).join('')}</div></div>
      <div class="cam-bottom">
        <div class="cam-left">
          <button class="cam-thumb" data-done aria-label="Fertig"><span class="cam-badge"></span></button>
          <button class="cam-gallery" data-gal aria-label="Aus Fotos">${icon('image')}<span>Fotos</span></button>
        </div>
        <button class="cam-shutter" data-shot aria-label="Aufnehmen"><span></span></button>
        <button class="cam-done" data-done>Fertig</button>
      </div>`;
    document.body.appendChild(wrap);
    document.body.classList.add('cam-open');
    const video = wrap.querySelector('video'), svg = wrap.querySelector('.cam-svg'), poly = wrap.querySelector('.cam-quad');
    const hint = wrap.querySelector('.cam-hint'), stage = wrap.querySelector('.cam-stage');
    const thumbBtn = wrap.querySelector('.cam-thumb'), badge = wrap.querySelector('.cam-badge');
    const guide = wrap.querySelector('.cam-guide'), track_ = wrap.querySelector('.cam-mode-track');
    const qrRes = wrap.querySelector('.cam-qrres'), stampEl = wrap.querySelector('.cam-stamp');
    const doneBtn = wrap.querySelector('.cam-done');
    video.srcObject = stream;
    try { await video.play(); } catch {}

    // Licht (nur wenn die Kamera es anbietet)
    try {
      if (track.getCapabilities && track.getCapabilities().torch) {
        const tb = wrap.querySelector('[data-torch]'); tb.hidden = false;
        tb.onclick = async () => {
          torch = !torch;
          try { await track.applyConstraints({ advanced: [{ torch }] }); tb.classList.toggle('on', torch); } catch { torch = false; }
        };
      }
    } catch {}

    const idt = () => ID_TYPES.find(t => t.id === idType) || ID_TYPES[0];
    const cardMode = () => mode === 'id' && idt().sides > 0;     // Ausweis mit Rahmen-Schablone
    const usesQuad = () => !['stamp', 'qr'].includes(mode) && !cardMode();
    const autoOK = () => auto && ['scan', 'word', 'excel', 'sign', 'text'].includes(mode) || (auto && mode === 'id' && !cardMode());

    const updThumb = () => {
      const n = startCount + items.length;
      badge.textContent = n || '';
      thumbBtn.classList.toggle('has', n > 0);
      doneBtn.classList.toggle('show', n > 0);
      if (items.length) {
        const last = items[items.length - 1];
        thumbBtn.style.backgroundImage = `url(${(last.stamp ? last.img : render(last, last.card ? 'card' : 'color', 160)).toDataURL('image/jpeg', 0.7)})`;
      }
    };

    // ---------- Modus-Leiste ----------
    const setHint = () => {
      if (mode === 'id') {
        const t = idt();
        hint.textContent = !t.sides ? 'Dokument ins Bild halten'
          : items.length === 0 ? `${t.label}: Vorderseite in den Rahmen` : 'Jetzt die Rückseite';
        doneBtn.textContent = t.sides === 2 && items.length === 1 ? 'Ohne Rückseite' : 'Fertig';
      } else { hint.textContent = HINTS[mode]; doneBtn.textContent = 'Fertig'; }
    };
    const layoutGuide = () => {
      if (!cardMode()) return;
      const sw = stage.clientWidth, sh = stage.clientHeight, r = idt().r;
      let w = sw * 0.84, h = w / r;
      if (h > sh * 0.6) { h = sh * 0.6; w = h * r; }
      Object.assign(guide.style, { width: w + 'px', height: h + 'px', left: (sw - w) / 2 + 'px', top: (sh - h) / 2 - sh * 0.04 + 'px' });
      guide.querySelector('.cam-guide-lbl').textContent = items.length ? 'Rückseite' : 'Vorderseite';
    };
    const applyMode = (anim = true) => {
      wrap.dataset.mode = mode;
      wrap.classList.toggle('card', cardMode());
      track_.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === mode));
      const on = track_.querySelector('.on');
      if (on) {
        const x = on.offsetLeft + on.offsetWidth / 2;
        track_.style.transition = anim ? '' : 'none';
        track_.style.transform = `translateX(${track_.parentElement.clientWidth / 2 - x}px)`;
      }
      wrap.querySelectorAll('[data-idt]').forEach(b => b.classList.toggle('on', b.dataset.idt === idType));
      wrap.querySelector('[data-auto]').hidden = !['scan', 'word', 'excel', 'sign', 'text'].includes(mode) && !(mode === 'id' && !cardMode());
      quad = null; stable = 0;
      qrRes.hidden = true; qrPaused = false;
      layoutGuide(); setHint();
      if (mode === 'qr') loadJsQR().catch(e => toast(e.message, true));
    };
    const DOC = ['scan', 'text', 'word', 'excel', 'sign'];
    const switchMode = async m => {
      if (m === mode || lockMode) return;
      // Seiten bleiben erhalten, solange beide Modi „Dokument“-Modi sind; sonst nachfragen
      if (items.length && !(DOC.includes(m) && DOC.includes(mode))) {
        const lbl = CAM_MODES.find(x => x.id === m).label;
        if (!await confirmDlg('Aufnahmen verwerfen?', `${items.length} ${items.length === 1 ? 'Aufnahme geht' : 'Aufnahmen gehen'} verloren, wenn du zu „${lbl}“ wechselst.`, 'Verwerfen')) return;
        items.length = 0; thumbBtn.style.backgroundImage = ''; updThumb();
      }
      mode = m; haptic(); applyMode();
    };
    track_.querySelectorAll('[data-m]').forEach(b => b.onclick = () => switchMode(b.dataset.m));
    wrap.querySelectorAll('[data-idt]').forEach(b => b.onclick = () => {
      if (items.length) return toast('Erst „Fertig“ oder „Ohne Rückseite“ tippen');
      idType = b.dataset.idt; haptic(); applyMode();
    });
    // Wischen über das Kamerabild wechselt den Modus
    let sx = null, sy = 0;
    stage.addEventListener('touchstart', e => { if (e.target.closest('.cam-idtypes, .cam-qrres, button')) { sx = null; return; } if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive: true });
    stage.addEventListener('touchend', e => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const i = CAM_MODES.findIndex(m => m.id === mode) + (dx < 0 ? 1 : -1);
      if (i >= 0 && i < CAM_MODES.length) switchMode(CAM_MODES[i].id);
    }, { passive: true });

    // Videokoordinaten (normiert) ↔ Bildschirm (object-fit: cover)
    const fitInfo = () => {
      const sw = stage.clientWidth, sh = stage.clientHeight, vw = video.videoWidth || 1, vh = video.videoHeight || 1;
      const s = Math.max(sw / vw, sh / vh); return { s, vw, vh, ox: (sw - vw * s) / 2, oy: (sh - vh * s) / 2 };
    };
    const toScreen = ([nx, ny]) => { const f = fitInfo(); return [nx * f.vw * f.s + f.ox, ny * f.vh * f.s + f.oy]; };
    const toVideo = ([x, y]) => { const f = fitInfo(); return [Math.min(1, Math.max(0, (x - f.ox) / f.s / f.vw)), Math.min(1, Math.max(0, (y - f.oy) / f.s / f.vh))]; };

    let quad = null, shown = null, stable = 0, armed = true, running = true, last = 0, busy = false, qrPaused = false, lastQr = 0;
    const small = document.createElement('canvas');
    const moved = (a, b) => !a || !b ? 1 : Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

    const loop = t => {
      if (!running) return;
      requestAnimationFrame(loop);
      if (mode === 'stamp') {
        const st = stampText(); stampEl.firstChild.textContent = st.time; stampEl.lastChild.textContent = st.date;
      }
      if (mode === 'qr' && !qrPaused && video.readyState >= 2 && t - lastQr > 220 && window.jsQR) { lastQr = t; scanQr(); }
      if (usesQuad() && video.readyState >= 2 && t - last > 120 && !busy) {
        last = t;
        const vw = video.videoWidth, vh = video.videoHeight, k = 320 / Math.max(vw, vh);
        small.width = Math.round(vw * k); small.height = Math.round(vh * k);
        small.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, small.width, small.height);
        const q = detectQuad(small, 320);
        const mv = moved(q, quad);
        if (q && mv < 0.025) stable++; else stable = 0;
        if (!q || mv > 0.08) armed = true;
        quad = q;
        if (!q) setHint();
        else if (autoOK() && armed) hint.textContent = stable >= 3 ? 'Ruhig halten …' : 'Dokument erkannt';
        else hint.textContent = 'Dokument erkannt – auslösen';
        hint.classList.toggle('ok', !!q);
        if (autoOK() && armed && q && stable >= 7) { armed = false; stable = 0; shoot(); }
      } else if (!usesQuad()) { quad = null; hint.classList.remove('ok'); }
      // Rahmen weich nachführen
      const sw = stage.clientWidth, sh = stage.clientHeight;
      svg.setAttribute('viewBox', `0 0 ${sw} ${sh}`);
      if (quad && usesQuad()) {
        const target = quad.map(toScreen);
        shown = shown ? shown.map((p, i) => [p[0] + (target[i][0] - p[0]) * 0.35, p[1] + (target[i][1] - p[1]) * 0.35]) : target;
        poly.setAttribute('points', shown.map(p => p.join(',')).join(' '));
        poly.classList.add('show');
        poly.classList.toggle('steady', autoOK() && stable >= 3);
      } else { poly.classList.remove('show'); shown = null; }
    };

    // ---------- QR-Code ----------
    const qrCanvas = document.createElement('canvas');
    const showQr = text => {
      qrPaused = true; haptic();
      const url = /^(https?:\/\/|www\.)/i.test(text.trim());
      qrRes.querySelector('.cqr-txt').textContent = text;
      qrRes.querySelector('[data-qopen]').hidden = !url;
      qrRes.hidden = false;
      wrap.querySelector('.cam-qrbox').classList.add('hit');
    };
    const decode = (src, w, h) => {
      const k = Math.min(1, 720 / Math.max(w, h));
      qrCanvas.width = Math.round(w * k); qrCanvas.height = Math.round(h * k);
      const x = qrCanvas.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, qrCanvas.width, qrCanvas.height);
      const d = x.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
      return window.jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
    };
    const scanQr = () => { try { const r = decode(video, video.videoWidth, video.videoHeight); if (r && r.data) showQr(r.data); } catch (e) { console.warn(e); } };
    qrRes.querySelector('[data-qcopy]').onclick = async () => { try { await navigator.clipboard.writeText(qrRes.querySelector('.cqr-txt').textContent); toast('Kopiert'); } catch { toast('Kopieren nicht möglich', true); } };
    qrRes.querySelector('[data-qopen]').onclick = () => { let u = qrRes.querySelector('.cqr-txt').textContent.trim(); if (!/^https?:/i.test(u)) u = 'https://' + u; window.open(u, '_blank', 'noopener'); };
    qrRes.querySelector('[data-qagain]').onclick = () => { qrRes.hidden = true; wrap.querySelector('.cam-qrbox').classList.remove('hit'); setTimeout(() => { qrPaused = false; }, 600); };

    applyMode(false);
    updThumb();
    requestAnimationFrame(loop);

    // ---------- Auslösen ----------
    const grab = () => {
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      return c;
    };
    const stampPhoto = c => {
      const x = c.getContext('2d'), st = stampText(), u = Math.max(c.width, c.height) / 60;
      x.save(); x.shadowColor = 'rgba(0,0,0,.55)'; x.shadowBlur = u * 0.6; x.fillStyle = '#fff';
      x.font = `700 ${u * 3.2}px -apple-system, Helvetica, Arial, sans-serif`;
      x.fillText(st.time, u * 1.6, c.height - u * 3.6);
      x.font = `500 ${u * 1.35}px -apple-system, Helvetica, Arial, sans-serif`;
      x.fillText(st.date, u * 1.7, c.height - u * 1.6);
      x.restore();
      return c;
    };
    const flash = () => { const fl = wrap.querySelector('.cam-flash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go'); };
    const finishAfter = () => {
      // Modi mit genau einer Aufnahme schließen danach von selbst
      if (mode === 'text' || mode === 'stamp') return close(items);
      if (maxShots && items.length >= maxShots) return close(items);     // z. B. „Erneut aufnehmen“: genau ein Foto
      if (mode === 'id' && idt().sides > 0 && items.length >= idt().sides) return close(items);
    };

    const shoot = () => {
      if (video.readyState < 2 || busy || mode === 'qr') return;
      busy = true;
      const c = grab();
      haptic(); flash();
      if (mode === 'stamp') {
        items.push({ img: stampPhoto(c), corners: FULL.map(p => [...p]), rot: 0, stamp: true });
        updThumb(); busy = false;
        return setTimeout(finishAfter, 350);
      }
      let corners = detectQuad(c, 480);
      if (cardMode()) {
        // Karte: erkannte Kanten nur nehmen, wenn sie zur Schablone passen, sonst den Schablonen-Rahmen
        const g = guide.getBoundingClientRect(), st = stage.getBoundingClientRect();
        const gq = [[g.left, g.top], [g.right, g.top], [g.right, g.bottom], [g.left, g.bottom]].map(([x, y]) => toVideo([x - st.left, y - st.top]));
        // 1. Kartenkanten (farbunabhängig), 2. Papier-Erkennung, wenn nah an der Schablone, 3. Schablone
        const cq = cardInGuide(c, gq, idt().r);
        if (cq) corners = cq;
        else if (!corners || moved(corners, gq) > 0.12) corners = gq;
      }
      corners ||= quad || FULL.map(p => [...p]);
      const item = { img: c, corners, rot: 0 };
      if (cardMode()) { item.card = true; item.straighten = false; }
      items.push(item);
      const done = () => {
        thumbBtn.classList.remove('pop'); void thumbBtn.offsetWidth; thumbBtn.classList.add('pop');
        updThumb(); setHint(); layoutGuide();
        busy = false;
        finishAfter();
      };
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
      unfold(item).catch(e => console.warn(e)).finally(done);
    };
    // Aufklapp-Animation: das erkannte Blatt löst sich aus dem Foto, klappt gerade auf,
    // eine Scan-Linie läuft von unten nach oben und zeigt die verbesserte Seite, dann fliegt es zur Vorschau.
    const unfold = async item => {
      const sw = stage.clientWidth, sh = stage.clientHeight;
      const raw = warp(item.img, item.corners, 1000);
      const r = raw.width / raw.height, m = 26;
      let W = sw - 2 * m, H = W / r;
      if (H > sh - 2 * m) { H = sh - 2 * m; W = H * r; }
      const L = (sw - W) / 2, T = (sh - H) / 2;
      const pop = document.createElement('div'); pop.className = 'cam-pop';
      pop.innerHTML = '<div class="cam-pop-bg"></div><div class="cam-page"><div class="cam-sweep"></div></div>';
      const page = pop.querySelector('.cam-page'), sweep = pop.querySelector('.cam-sweep');
      Object.assign(page.style, { left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px' });
      raw.className = 'raw'; page.prepend(raw);
      const Q = item.corners.map(toScreen).map(([x, y]) => [x - L, y - T]);
      page.style.transform = quadMatrix(W, H, Q);
      stage.appendChild(pop);
      await nextFrame();
      pop.classList.add('open');                      // Hintergrund abdunkeln, Blatt klappt auf
      page.style.transform = 'none';
      // verbesserte Seite währenddessen berechnen
      await sleep(80);
      const enh = render(item, item.card ? 'card' : 'color', 1000); enh.className = 'enh';
      page.insertBefore(enh, sweep);
      await sleep(Math.max(0, 520 - 80));
      pop.classList.add('scan');                      // Scan-Linie läuft hoch, darunter die fertige Seite
      await sleep(1050);
      // zur Vorschau unten links fliegen
      const tb = thumbBtn.getBoundingClientRect(), pb = page.getBoundingClientRect();
      const k = Math.min(tb.width / pb.width, tb.height / pb.height);
      page.style.transition = 'transform .45s cubic-bezier(.5,0,.3,1), opacity .45s ease-in';
      page.style.transformOrigin = '0 0';
      page.style.transform = `translate(${tb.left - pb.left + (tb.width - pb.width * k) / 2}px, ${tb.top - pb.top + (tb.height - pb.height * k) / 2}px) scale(${k})`;
      page.style.opacity = '.4';
      pop.classList.remove('open');
      await sleep(460);
      pop.remove();
    };

    const close = v => {
      running = false;
      document.body.classList.remove('cam-open');
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), 250);
      if (v) { v.mode = mode; v.idType = idType; }
      resolve(v);
    };
    wrap.querySelector('[data-shot]').onclick = shoot;
    wrap.querySelectorAll('[data-done]').forEach(b => b.onclick = () => close(items));
    // Fotos aus der Mediathek: Ränder automatisch erkennen, dann direkt weiter zur Scan-Ansicht
    wrap.querySelector('[data-gal]').onclick = async () => {
      const files = await pickFiles('file-img');
      if (!files.length) return;
      if (mode === 'qr') {
        try {
          await loadJsQR();
          const { img } = await loadFileImage(files[0]);
          const r = decode(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
          r?.data ? showQr(r.data) : toast('Kein QR-Code im Bild gefunden', true);
        } catch { toast('Bild konnte nicht gelesen werden', true); }
        return;
      }
      showBusy(true, 'Ränder werden erkannt …');
      for (const f of files) {
        try {
          const { img, url } = await loadFileImage(f);
          if (cardMode()) items.push({ img, url, corners: cardCorners(img, idt().r), rot: 0, card: true, straighten: false });
          else items.push({ img, url, corners: detectCorners(img), rot: 0 });
        }
        catch { toast('Bild konnte nicht geladen werden', true); }
      }
      showBusy(false);
      if (items.length) close(items);
    };
    wrap.querySelector('[data-x]').onclick = () => close(items.length ? items : []);
    wrap.querySelector('[data-auto]').onclick = e => {
      auto = !auto; localStorage.setItem(AUTO_KEY, auto ? '1' : '0');
      e.currentTarget.classList.toggle('on', auto); haptic();
      toast(auto ? 'Automatisch auslösen: an' : 'Automatisch auslösen: aus');
    };
    // App im Hintergrund → Kamera freigeben
    const vis = () => { if (document.hidden) close(items); };
    document.addEventListener('visibilitychange', vis, { once: true });
  });
}
