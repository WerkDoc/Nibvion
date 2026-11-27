# Nibvion
PDF Tools, Stamp & Edit

Eigene PDF-App für RepairMobile – ohne Werbung, ohne Abo, alles lokal auf dem Gerät.

## Funktionen (v1.5)
- **Ansehen** – Zoom (Pinch, Doppeltipp, +/-), mehrere Seiten, Stoff-Lesezeichen (ziehen oder antippen) mit Fortschrittsring und „Weiter bei Seite …“, bis zu 4 Dokumente als Tabs
- **Teilen** – Teilen-Dialog mit schwebender 3D-Kippkarte der ersten Seite (Finger oder Neigung), auch in der Dokument-Info
- **Bearbeiten** – vorhandenen Text antippen und ändern (Hintergrund & Farbe werden übernommen), neuen Text, Bilder einfügen, Bereiche abdecken
- **Kommentieren** – Markieren, Unterstreichen, Durchstreichen, Notizen
- **Zeichnen** – Stift, Marker, Radierer
- **Füllen & unterschreiben** – Unterschrift (gespeichert), Text, Datum, Haken/Kreuz, Stempel (Vorlagen, eigene Text-Stempel, Firmenstempel-Bild)
- **Formular ausfüllen** – echte PDF-Formularfelder (Text, Kästchen, Optionsfelder, Auswahllisten) antippen und ausfüllen; bleibt ausfüllbar oder wird fixiert
- **Seiten verwalten** – drehen, sortieren, löschen, leere Seite
- **Aufteilen** – jede Seite einzeln, alle X Seiten, eigene Bereiche („1-3, 4-6“) oder ausgewählte Seiten herausziehen
- **Erstellen** – Scannen mit Kamera, Bilder → PDF, PDFs zusammenfügen, leeres PDF mit **Papiervorlagen** (Blanko, Liniert, Kariert 5 mm, Punktraster, Millimeter, Notenlinien, Cornell · Papier Weiß/Creme/Anthrazit · Linien Grau/Hellblau/Koralle · A4/A5 · 1–50 Seiten, echte Vektorlinien) – auch als neue Seiten in „Seiten verwalten“
- **Messen & Maßstab** – Strecke, Polygonzug (Teil- & Gesamtlängen) und Fläche (m²/cm²/mm² + Umfang) direkt im Plan; Maßstab 1:1 bis 1:500 exakt aus der Seitengröße (72 pt = 25,4 mm) oder per Referenzstrecke kalibriert, je Dokument oder Seite; Präzisions-Lupe mit Fadenkreuz, Einrasten auf 0°/45°/90°, Punkte nachträglich verschieben; Maße als Vektorgrafik ins PDF einbrennen (rückgängig möglich)
- **Ordner sperren** – PIN (4/6 Ziffern, PBKDF2-SHA-256) und optional Face ID / Touch ID (WebAuthn, PIN als Ersatz); gesperrte Dateien sind in Alle, Zuletzt, Suche und Auswahllisten verborgen; wieder sperren beim Verlassen oder nach dem App-Schließen (Sichtschutz, keine Verschlüsselung)
- **Stapel-Aktionen** – Mehrfachauswahl unter Dateien mit schwebender Leiste: Zusammenführen (Auswahl-Reihenfolge), Verschieben, Farb-Tag, Komprimieren, als ZIP teilen/sichern, Löschen
- **1-Tap-Workflows** – eigene Abläufe aus Werkzeugen (Leere Seiten entfernen, A4, OCR, Seitenzahlen, Datum, Komprimieren, Wasserzeichen, Fixieren) in beliebiger Reihenfolge speichern und mit Live-Fortschritt ausführen; 3 Vorlagen, auf der Startseite anpinnbar
- **Konvertieren** – PDF → Bilder, **Word → PDF** (.docx), **Excel → PDF** (.xlsx, .xlsm, .xls, .ods, .csv – Blätter wählbar, Ausrichtung, Gitternetz), **PowerPoint → PDF** (.pptx – Folien mit Layout/Master, Theme-Farben, Formen, Bildern, Tabellen, SmartArt und Diagrammen; durchsuchbarer Text), **PDF → Word** (bearbeitbare .docx: Absätze, Schriften, Einzüge, Spalten per Tabstopp, Bilder, Kopf-/Fußzeilen mit Seitenzahl; Scans als Bild)
  - Umwandlung komplett auf dem Gerät; Seiten werden als Bild gesetzt, mit unsichtbarer Textebene (Text bleibt durchsuch- und markierbar)
- Export: Teilen / In „Dateien“ sichern, Fertigstellen (Änderungen einbrennen)
- **Texterkennung (OCR)** – gescannte Seiten werden auf dem Gerät gelesen (Tesseract, Deutsch); unsichtbare Textebene macht sie durchsuchbar, markier- und kopierbar; beim Scannen automatisch (abschaltbar)
- **Favoriten** – Herz im ⋯-Menü, Filter „nur Favoriten“ in der Liste
- **Wasserzeichen** – Text (VERTRAULICH, KOPIE …), Farbe, Deckkraft, Größe, diagonal/waagerecht, mit Vorschau
- **Komprimieren** – Fotos/Scans in der PDF verkleinern (Standard/Stark/Leicht), Text bleibt scharf
- **Schwärzen** – Bereiche aufziehen oder per Suche (Begriff, E-Mails, Telefon, IBAN, Datum) markieren; betroffene Seiten werden neu als Bild aufgebaut, der Inhalt darunter ist endgültig entfernt
- **Passwortschutz** – AES-256 beim Teilen/Sichern; geschützte PDFs lassen sich mit Passwort importieren (entsperrt)

## Installation (iPhone)
1. In Safari öffnen: https://werkdoc.github.io/Nibvion/
2. Teilen → „Zum Home-Bildschirm“

## Technik
Reines HTML/CSS/JS, PWA mit Service Worker (offline). Alle Bibliotheken liegen in `lib/` (Lizenzen daneben):
pdf.js (Apache 2.0), pdf-lib (MIT), docx-preview 0.4.1 (Apache 2.0), JSZip 3.10 (MIT), html2canvas 1.4.1 (MIT), ExcelJS 4.4 (MIT), SheetJS CE 0.18.5 (Apache 2.0), @cantoo/pdf-lib 2.11 (MIT, nur für Verschlüsselung), Tesseract.js 7 + deutsches Sprachmodell (Apache 2.0, `lib/tesseract/`, nur für OCR).
Die Office-Bibliotheken werden erst beim ersten Umwandeln geladen (`js/convert.js`, `js/pdf2word.js`).
