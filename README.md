# Nibvion
PDF Tools, Stamp & Edit

Eigene PDF-App für RepairMobile – ohne Werbung, ohne Abo, alles lokal auf dem Gerät.

## Funktionen (v1.2)
- **Ansehen** – Zoom (Pinch, Doppeltipp, +/-), mehrere Seiten
- **Bearbeiten** – vorhandenen Text antippen und ändern (Hintergrund & Farbe werden übernommen), neuen Text, Bilder einfügen, Bereiche abdecken
- **Kommentieren** – Markieren, Unterstreichen, Durchstreichen, Notizen
- **Zeichnen** – Stift, Marker, Radierer
- **Füllen & unterschreiben** – Unterschrift (gespeichert), Text, Datum, Haken/Kreuz, Stempel (Vorlagen, eigene Text-Stempel, Firmenstempel-Bild)
- **Seiten verwalten** – drehen, sortieren, löschen, leere Seite
- **Erstellen** – Scannen mit Kamera, Bilder → PDF, PDFs zusammenfügen, leeres PDF
- **Konvertieren** – PDF → Bilder, **Word → PDF** (.docx), **Excel → PDF** (.xlsx, .xlsm, .xls, .ods, .csv – Blätter wählbar, Ausrichtung, Gitternetz), **PDF → Word** (bearbeitbare .docx: Absätze, Schriften, Einzüge, Spalten per Tabstopp, Bilder, Kopf-/Fußzeilen mit Seitenzahl; Scans als Bild)
  - Umwandlung komplett auf dem Gerät; Seiten werden als Bild gesetzt, mit unsichtbarer Textebene (Text bleibt durchsuch- und markierbar)
- Export: Teilen / In „Dateien“ sichern, Fertigstellen (Änderungen einbrennen)

## Installation (iPhone)
1. In Safari öffnen: https://werkdoc.github.io/Nibvion/
2. Teilen → „Zum Home-Bildschirm“

## Technik
Reines HTML/CSS/JS, PWA mit Service Worker (offline). Alle Bibliotheken liegen in `lib/` (Lizenzen daneben):
pdf.js (Apache 2.0), pdf-lib (MIT), docx-preview 0.4.1 (Apache 2.0), JSZip 3.10 (MIT), html2canvas 1.4.1 (MIT), ExcelJS 4.4 (MIT), SheetJS CE 0.18.5 (Apache 2.0).
Die Office-Bibliotheken werden erst beim ersten Umwandeln geladen (`js/convert.js`, `js/pdf2word.js`).
