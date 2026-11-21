// Nibvion Service Worker – offline-fähig
const VERSION = 'nibvion-v1.6.0';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/editor.js', 'js/pdfcore.js', 'js/ui.js', 'js/db.js', 'js/icons.js', 'js/sign.js', 'js/assets.js', 'js/settings.js', 'js/convert.js', 'js/pdf2word.js', 'js/tools.js', 'js/scanner.js', 'js/search.js', 'js/backup.js', 'js/ocr.js', 'js/camera.js', 'js/textview.js',
  'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/pdf-lib.min.js',
  'lib/jszip.min.js', 'lib/docx-preview.min.js', 'lib/html2canvas.min.js', 'lib/exceljs.min.js', 'lib/xlsx.core.min.js', 'lib/pdf-lib-crypt.esm.min.js',
  'icons/logo.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// App-Dateien: erst Netz (damit Updates sofort ankommen), sonst Cache. Bibliotheken: Cache zuerst.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/lib/') || url.pathname.includes('/icons/')) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const c = res.clone(); caches.open(VERSION).then(ca => ca.put(e.request, c)); return res; })));
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => { if (res.ok) { const c = res.clone(); caches.open(VERSION).then(ca => ca.put(e.request, c)); } return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
