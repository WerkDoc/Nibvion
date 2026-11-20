# Nibvion
PDF Tools, Stamp & Edit

Eigene PDF-App für RepairMobile – ohne Werbung, ohne Abo, alles lokal auf dem Gerät.

## Funktionen (v1.0)
- **Ansehen** – Zoom (Pinch, Doppeltipp, +/-), mehrere Seiten
- **Bearbeiten** – vorhandenen Text antippen und ändern (Hintergrund & Farbe werden übernommen), neuen Text, Bilder einfügen, Bereiche abdecken
- **Kommentieren** – Markieren, Unterstreichen, Durchstreichen, Notizen
- **Zeichnen** – Stift, Marker, Radierer
- **Füllen & unterschreiben** – Unterschrift (gespeichert), Text, Datum, Haken/Kreuz, Stempel (Vorlagen, eigene Text-Stempel, Firmenstempel-Bild)
- **Seiten verwalten** – drehen, sortieren, löschen, leere Seite
- **Erstellen** – Scannen mit Kamera, Bilder → PDF, PDFs zusammenfügen, leeres PDF
- **Konvertieren** – PDF → Bilder (Word/Excel/PowerPoint folgen)
- Export: Teilen / In „Dateien“ sichern, Fertigstellen (Änderungen einbrennen)

## Installation (iPhone)
1. In Safari öffnen: https://werkdoc.github.io/Nibvion/
2. Teilen → „Zum Home-Bildschirm“

## Technik
Reines HTML/CSS/JS, PWA mit Service Worker (offline). pdf.js (Apache 2.0) und pdf-lib (MIT) liegen in `lib/`.
