# Nibvion – Regeln für Claude

- Projekt: PWA „Nibvion“ (PDF bearbeiten, kommentieren, zeichnen, unterschreiben, stempeln) für Oleg / RepairMobile.
- Läuft über GitHub Pages: https://werkdoc.github.io/Nibvion/ – als App auf dem iPhone-Home-Bildschirm.
- Ablauf: Claude arbeitet immer auf einem eigenen Branch und öffnet einen Pull Request. Oleg merged in der GitHub-App. Nie direkt auf `main` pushen.
- Reines HTML/CSS/JS (ES-Module), kein Build-Schritt. Bibliotheken liegen lokal in `lib/` (pdf.js legacy 6.x, pdf-lib 1.17.1, docx-preview, JSZip, html2canvas, ExcelJS, SheetJS, @cantoo/pdf-lib als `pdf-lib-crypt.esm.min.js` nur für Passwortschutz, Tesseract.js in `lib/tesseract/` nur für OCR) – keine CDNs. Office-Bibliotheken lädt `js/convert.js` erst bei Bedarf.
- Daten liegen lokal (IndexedDB `nibvion`: docs, files, assets). Optionale Nibvion-Cloud (`js/cloud.js`, Supabase „Nivion“): nur Ende-zu-Ende verschlüsselt (AES-GCM, Schlüssel aus dem Passwort abgeleitet), Änderungen laufen über `db.put/del` (Hook) – Daten aus der Cloud nur mit `db.rawPut/rawDel` schreiben. Setup: `supabase/cloud.sql`. Keine Werbung, kein Tracking.
- UI-Sprache Deutsch. Design: Anthrazit + Koralle/Orange-Verlauf (wie App-Icon), iOS-Look, sanfte Animationen.
- Bei jeder Änderung an App-Dateien die `VERSION` in `sw.js` (Cache-Name) und `js/app.js` erhöhen, damit das Update auf dem iPhone ankommt.
