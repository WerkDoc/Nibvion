const KEY = 'nibvion.settings';
const DEFAULTS = {
  theme: 'dark',          // dark | light | system
  stampName: '',
  stampDate: true,
  textSize: 11,
  textColor: '#111318',
  penColor: '#1d3fae',
  penWidth: 2,
  markerColor: '#ffd60a',
  markerWidth: 12,
  hlColor: '#ffd60a',
  lineColor: '#d32f2f',
  sort: 'new',
  scanOcr: true,
  favOnly: false,
  smartShapes: true,     // Stift: grobe Formen einrasten lassen
  recentView: 'list',    // Startseite „Zuletzt“: list | flow
};
let cache;
function load() { if (!cache) { try { cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { cache = { ...DEFAULTS }; } } return cache; }
export const settings = {
  get: k => load()[k],
  set(k, v) { load()[k] = v; localStorage.setItem(KEY, JSON.stringify(cache)); },
};

export function applyTheme() {
  const t = settings.get('theme');
  const light = t === 'light' || (t === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  // Statusleiste (iOS liest theme-color): genau die App-Hintergrundfarbe.
  // Meta-Tag neu einsetzen, damit Safari den Wechsel sicher übernimmt.
  const color = light ? '#f3f4f7' : '#121417';
  const old = document.querySelector('meta[name=theme-color]');
  if (old && old.content !== color) {
    const m = document.createElement('meta'); m.name = 'theme-color'; m.content = color;
    old.replaceWith(m);
  }
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme);
