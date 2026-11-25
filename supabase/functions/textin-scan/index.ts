// Supabase Edge Function „textin-scan“ für Nibvion (Online-Scan über TextIn / CamScanner-Technik).
// Leitet ein Foto an die TextIn-API „crop_enhance_image“ (Scan) bzw. mit ?op=ocr an „pdf_to_markdown“ (Text + Positionen) weiter. Die TextIn-Zugangsdaten liegen nur
// hier als Secrets (TEXTIN_APP_ID, TEXTIN_SECRET) – nie in der App. NIBVION_KEY schützt vor Fremdnutzung.
// Mit ?op=translate (JSON { text: [...], target_lang, source_lang? }) wird über DeepL übersetzt (Secret DEEPL_KEY).
// Einstellung in Supabase: „Verify JWT“ für diese Funktion AUS (Schutz läuft über x-nibvion-key).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-nibvion-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ALLOWED = ['enhance_mode', 'crop_image', 'dewarp_image', 'deblur_image', 'correct_direction', 'size_and_positon', 'jpeg_quality'];
// op=ocr: Texterkennung mit Positionen (TextIn Dokument-Erkennung, nur Textzeilen) – für „Text bearbeiten“
const OCR_QUERY = 'parse_mode=scan&get_image=none&markdown_details=0&page_details=1&apply_document_tree=0';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ code: 405, message: 'Nur POST' }, 405);
  if (!Deno.env.get('NIBVION_KEY') || req.headers.get('x-nibvion-key') !== Deno.env.get('NIBVION_KEY')) {
    return json({ code: 401, message: 'Zugangsschlüssel falsch' }, 401);
  }
  const url0 = new URL(req.url);
  // ---- Übersetzen über DeepL (Kostenlos-Schlüssel endet auf „:fx“) ----
  if (url0.searchParams.get('op') === 'translate') {
    const key = Deno.env.get('DEEPL_KEY');
    if (!key) return json({ code: 40104, message: 'DEEPL_KEY fehlt in den Secrets' });
    let inp: { text?: string[]; target_lang?: string; source_lang?: string };
    try { inp = await req.json(); } catch { return json({ code: 400, message: 'Ungültige Anfrage' }); }
    const text = (inp.text || []).filter((t) => typeof t === 'string').slice(0, 200);
    if (!text.length) return json({ code: 200, result: { translations: [] } });
    const body: Record<string, unknown> = { text, target_lang: inp.target_lang || 'DE', preserve_formatting: true };
    if (inp.source_lang) body.source_lang = inp.source_lang;
    const host = key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const r = await fetch(`${host}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${key.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 403) return json({ code: 40105, message: 'DeepL-Schlüssel falsch' });
    if (r.status === 456) return json({ code: 40106, message: 'DeepL-Kontingent für diesen Monat aufgebraucht' });
    if (r.status === 429) return json({ code: 40306, message: 'Zu viele Anfragen – kurz warten' });
    if (!r.ok) return json({ code: r.status, message: `DeepL-Fehler ${r.status}` });
    return json({ code: 200, result: await r.json() });
  }

  const appId = Deno.env.get('TEXTIN_APP_ID'), secret = Deno.env.get('TEXTIN_SECRET');
  if (!appId || !secret) return json({ code: 500, message: 'TEXTIN_APP_ID / TEXTIN_SECRET fehlen in den Secrets' }, 500);

  const url = new URL(req.url), q = new URLSearchParams();
  for (const k of ALLOWED) { const v = url.searchParams.get(k); if (v !== null) q.set(k, v); }
  const body = await req.arrayBuffer();
  if (body.byteLength > 20 * 1024 * 1024) return json({ code: 413, message: 'Bild zu groß' }, 413);

  // Internationales Konto (textin.ai) → api.textin.ai, chinesisches (textin.com) → per Secret TEXTIN_HOST umstellen
  const host = Deno.env.get('TEXTIN_HOST') || 'https://api.textin.ai';
  const path = url.searchParams.get('op') === 'ocr' ? `/ai/service/v1/pdf_to_markdown?${OCR_QUERY}` : `/ai/service/v1/crop_enhance_image?${q}`;
  const r = await fetch(`${host}${path}`, {
    method: 'POST',
    headers: { 'x-ti-app-id': appId, 'x-ti-secret-code': secret, 'Content-Type': 'application/octet-stream' },
    body,
  });
  return new Response(await r.text(), { status: r.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
});
