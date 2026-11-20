# Nibvion – Regeln für Claude

- Projekt: PWA „Nibvion“ (PDF bearbeiten, kommentieren, zeichnen, unterschreiben, stempeln) für Oleg / RepairMobile.
- Läuft über GitHub Pages: https://werkdoc.github.io/Nibvion/ – als App auf dem iPhone-Home-Bildschirm.
- Ablauf: Claude arbeitet immer auf einem eigenen Branch und öffnet einen Pull Request. Oleg merged in der GitHub-App. Nie direkt auf `main` pushen.
- Reines HTML/CSS/JS (ES-Module), kein Build-Schritt. Bibliotheken liegen lokal in `lib/` (pdf.js legacy 6.x, pdf-lib 1.17.1) – keine CDNs.
- Alle Daten bleiben lokal (IndexedDB `nibvion`: docs, files, assets). Keine Cloud, keine Werbung, kein Tracking.
- UI-Sprache Deutsch. Design: Anthrazit + Koralle/Orange-Verlauf (wie App-Icon), iOS-Look, sanfte Animationen.
- Bei jeder Änderung an App-Dateien die `VERSION` in `sw.js` (Cache-Name) und `js/app.js` erhöhen, damit das Update auf dem iPhone ankommt.
