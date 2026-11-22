// Supabase Edge Function „textin-scan“ für Nibvion (Online-Scan über TextIn / CamScanner-Technik).
// Leitet ein Foto an die TextIn-API „crop_enhance_image“ weiter. Die TextIn-Zugangsdaten liegen nur
// hier als Secrets (TEXTIN_APP_ID, TEXTIN_SECRET) – nie in der App. NIBVION_KEY schützt vor Fremdnutzung.
// Einstellung in Supabase: „Verify JWT“ für diese Funktion AUS (Schutz läuft über x-nibvion-key).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-nibvion-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ALLOWED = ['enhance_mode', 'crop_image', 'dewarp_image', 'deblur_image', 'correct_direction', 'size_and_positon', 'jpeg_quality'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ code: 405, message: 'Nur POST' }, 405);
  if (!Deno.env.get('NIBVION_KEY') || req.headers.get('x-nibvion-key') !== Deno.env.get('NIBVION_KEY')) {
    return json({ code: 401, message: 'Zugangsschlüssel falsch' }, 401);
  }
  const appId = Deno.env.get('TEXTIN_APP_ID'), secret = Deno.env.get('TEXTIN_SECRET');
  if (!appId || !secret) return json({ code: 500, message: 'TEXTIN_APP_ID / TEXTIN_SECRET fehlen in den Secrets' }, 500);

  const url = new URL(req.url), q = new URLSearchParams();
  for (const k of ALLOWED) { const v = url.searchParams.get(k); if (v !== null) q.set(k, v); }
  const body = await req.arrayBuffer();
  if (body.byteLength > 20 * 1024 * 1024) return json({ code: 413, message: 'Bild zu groß' }, 413);

  // Internationales Konto (textin.ai) → api.textin.ai, chinesisches (textin.com) → per Secret TEXTIN_HOST umstellen
  const host = Deno.env.get('TEXTIN_HOST') || 'https://api.textin.ai';
  const r = await fetch(`${host}/ai/service/v1/crop_enhance_image?${q}`, {
    method: 'POST',
    headers: { 'x-ti-app-id': appId, 'x-ti-secret-code': secret, 'Content-Type': 'application/octet-stream' },
    body,
  });
  return new Response(await r.text(), { status: r.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
});
