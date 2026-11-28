// Nibvion Service Worker – offline-fähig
const VERSION = 'nibvion-v1.53.0';
// Bei Änderungen an Dateien in BIG_PATHS den Namen hochzählen
const BIG = 'nibvion-big-1';
// Bibliotheken (lib/*.js) und Icons: eigener Cache, überlebt App-Updates.
// Nur hochzählen, wenn sich eine Datei in LIBS oder icons/ ändert.
const LIB = 'nibvion-lib-1';
const BIG_PATHS = ['/lib/models/', '/lib/ort/', '/lib/tesseract/'];
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/editor.js', 'js/pdfcore.js', 'js/ui.js', 'js/db.js', 'js/icons.js', 'js/sign.js', 'js/assets.js', 'js/settings.js', 'js/convert.js', 'js/pdf2word.js', 'js/tools.js', 'js/scanner.js', 'js/search.js', 'js/backup.js', 'js/ocr.js', 'js/camera.js', 'js/textview.js', 'js/scanreview.js', 'js/scan2office.js', 'js/trash.js', 'js/ai.js', 'js/aienhance.js', 'js/online.js', 'js/files.js', 'js/idview.js', 'js/idpages.js', 'js/merge.js', 'js/translate.js', 'js/aifx.js', 'js/inpaint.js', 'js/pagetools.js', 'js/cloud.js', 'js/redact.js', 'js/forms.js', 'js/split.js', 'js/compare.js', 'js/incoming.js', 'js/qr.js', 'js/pageorder.js', 'js/present.js', 'js/scrubber.js', 'js/fixate.js', 'js/reader.js', 'js/layout.js', 'js/links.js', 'js/preflight.js', 'js/titles.js', 'js/fx.js', 'js/pageflip.js', 'js/pagecurl.js', 'js/flipview.js', 'js/gif.js', 'js/gifexport.js', 'js/flipbook.js', 'js/shapes.js', 'js/coverflow.js', 'js/inspect.js', 'js/collage.js', 'js/tiltcard.js', 'js/bookmark.js', 'js/doctabs.js', 'js/pptx.js', 'js/paper.js', 'js/workflows.js', 'js/lock.js', 'js/measure.js', 'js/scanstore.js', 'js/desk.js',
];
const LIBS = [
  'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/pdf-lib.min.js',
  'lib/jszip.min.js', 'lib/docx-preview.min.js', 'lib/html2canvas.min.js', 'lib/exceljs.min.js', 'lib/xlsx.core.min.js', 'lib/pdf-lib-crypt.esm.min.js',
  'icons/logo.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];

// Install darf nie an einer einzelnen Datei scheitern – sonst bleibt der alte Service Worker
// für immer aktiv und die App „hängt“ auf einer alten Version (iOS: wenig Speicher, Funkloch).
// Alles mit cache:'reload' holen, damit nicht der HTTP-Cache (GitHub Pages: 10 min) alte Dateien liefert.
async function fill(name, list, onlyMissing) {
  const c = await caches.open(name);
  await Promise.all(list.map(async u => {
    try {
      if (onlyMissing && await c.match(u)) return;
      const res = await fetch(new Request(u, { cache: 'reload' }));
      if (res.ok) await c.put(u, res);
    } catch {}
  }));
}
self.addEventListener('install', e => {
  e.waitUntil(Promise.all([fill(VERSION, ASSETS, false), fill(LIB, LIBS, true)]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== BIG && k !== LIB && k !== SHARE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const SHARE = 'nibvion-share';
async function receiveShare(req) {
  const base = new URL('./', self.registration.scope).href;
  try {
    const fd = await req.formData();
    const files = fd.getAll('files').filter(f => f && typeof f === 'object' && f.size);
    const c = await caches.open(SHARE);
    for (const k of await c.keys()) await c.delete(k);
    const stamp = Date.now();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      await c.put(new Request(`${base}__share/${stamp}/${i}`), new Response(f, { headers: {
        'Content-Type': f.type || 'application/octet-stream',
        'X-Name': encodeURIComponent(f.name || `Datei ${i + 1}`),
      } }));
    }
    const meta = { title: fd.get('title') || '', text: fd.get('text') || '', url: fd.get('url') || '', count: files.length };
    await c.put(new Request(`${base}__share/meta`), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect(`${base}?shared=${stamp}`, 303);
  } catch (e) {
    return Response.redirect(`${base}?shared=error`, 303);
  }
}

// App-Dateien: erst Netz (damit Updates sofort ankommen), sonst Cache. Bibliotheken: Cache zuerst.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === location.origin && url.searchParams.has('share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/lib/') || url.pathname.includes('/icons/')) {
    // Große Dateien (KI-Modell, KI-Laufzeit, Texterkennung) überleben App-Updates im eigenen Cache
    const name = BIG_PATHS.some(p => url.pathname.includes(p)) ? BIG : LIB;
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { if (res.ok) { const c = res.clone(); caches.open(name).then(ca => ca.put(e.request, c)); } return res; })));
    return;
  }
  // App-Dateien immer frisch vom Server (cache:'no-cache' prüft per ETag, lädt nur Geändertes neu)
  const fresh = e.request.mode === 'navigate'
    ? fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(
    fresh.then(res => { if (res.ok) { const c = res.clone(); caches.open(VERSION).then(ca => ca.put(e.request, c)); } return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
