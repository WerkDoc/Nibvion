# Online-Scan (TextIn) – Einrichtung

Optional. Ohne Einrichtung bleibt Nibvion komplett lokal.

1. **TextIn-Konto** anlegen (textin.com) → Konto/Entwickler-Info: `x-ti-app-id` und `x-ti-secret-code` notieren.
   Den Dienst „文档图像切边增强矫正“ (crop_enhance_image) aktivieren.
2. **Supabase** (beliebiges eigenes Projekt) → *Edge Functions* → *Deploy a new function* → *Via Editor*
   - Name: `textin-scan`
   - Inhalt: `supabase/functions/textin-scan/index.ts` einfügen → *Deploy*
   - In den Einstellungen der Funktion **„Verify JWT“ ausschalten** (Schutz läuft über den eigenen Schlüssel).
3. **Secrets** (*Edge Functions → Secrets*):
   - `TEXTIN_APP_ID` = App-ID von TextIn
   - `TEXTIN_SECRET` = Secret Code von TextIn
   - `NIBVION_KEY` = selbst ausgedachtes Passwort (lang, zufällig)
4. **In Nibvion**: Einstellungen → Online-Scan → Einrichten
   - Adresse: `https://<projekt-ref>.supabase.co/functions/v1/textin-scan`
   - Zugangsschlüssel: derselbe Wert wie `NIBVION_KEY` → *Testen* → *Speichern*

Danach gibt es in der Scan-Ansicht den Filter **„☁️ Online“**. Nur dann wird das Foto an TextIn gesendet.
