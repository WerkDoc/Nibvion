// ================= Echtes Seiten-Rollen (WebGL) – wie Apple Bücher =================
// Die Seite wird als feines Dreiecksnetz gezeichnet und im Vertex-Shader um einen gedachten
// Zylinder (Radius R) gerollt. Die Zylinderachse steht senkrecht zur Zugrichtung des Fingers –
// zieht man waagerecht, rollt die Seite gerade von der Seite ein; greift man oben/unten,
// rollt sie schräg über die Ecke. Rückseite: weißes Papier, Text schimmert gespiegelt durch.
// Schatten unter der Rolle, Licht auf der Wölbung – alles pro Pixel, ohne Streifen-Kanten.
//
// createCurl({ book, surface, paper() → [r,g,b] 0..1, spine (px, Bundsteg-Schatten), image(i) → {img, fit:[x,y,w,h] (0..1)} | Promise, setBase(i),
//              count(), index(), commit(i), onTap(x, y), onEdge() }) → { go(dir), busy(), destroy() } | null
import { reducedMotion } from './fx.js';

const VS_PAGE = `
attribute vec2 aPos;
uniform vec2 uSize, uC, uN;
uniform float uR;
varying vec2 vUv;
varying float vTh;
void main() {
  vec2 m = -uN;
  float d = dot(aPos - uC, m);
  vec2 p = aPos; float z = 0.0; float th = 0.0;
  if (d > 0.0) {
    float h = 3.14159265 * uR;
    if (d < h) { th = d / uR; p = aPos - m * (d - uR * sin(th)); z = uR * (1.0 - cos(th)); }
    else { th = 3.14159265; p = aPos - m * (2.0 * d - h); z = 2.0 * uR; }
  }
  vUv = aPos / uSize; vTh = th;
  gl_Position = vec4(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0, -0.9 * z / (2.0 * uR + 1.0), 1.0);
}`;
const FS_PAGE = `
precision mediump float;
uniform sampler2D uTex;
uniform vec4 uFit;
uniform float uHas, uSpine;
uniform vec3 uPaper;
varying vec2 vUv;
varying float vTh;
void main() {
  vec2 t = (vUv - uFit.xy) / uFit.zw;
  vec3 c = uPaper;
  if (uHas > 0.5 && t.x >= 0.0 && t.y >= 0.0 && t.x <= 1.0 && t.y <= 1.0) c = texture2D(uTex, t).rgb;
  vec3 col;
  if (vTh < 1.5707963) {
    // Vorderseite: wird zur Wölbung hin etwas dunkler, links leichter Bundsteg-Schatten
    float sh = 1.0 - 0.30 * (1.0 - cos(vTh));
    if (uSpine > 0.0) sh *= 1.0 - 0.16 * (1.0 - smoothstep(0.0, uSpine, vUv.x));
    col = c * sh;
  } else {
    // Rückseite: Papier, Schrift scheint gespiegelt und blass durch
    vec3 p = mix(uPaper, c, 0.2);
    float k = clamp(-cos(vTh), 0.0, 1.0);
    float sh = 0.76 + 0.24 * sqrt(k);
    sh += 0.07 * exp(-pow((vTh - 1.9) / 0.22, 2.0));
    col = p * min(sh, 1.0);
  }
  gl_FragColor = vec4(col, 1.0);
}`;
const VS_SHADOW = `
attribute vec2 aPos;
uniform vec2 uSize;
varying vec2 vP;
void main() { vP = aPos; gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0); }`;
const FS_SHADOW = `
precision mediump float;
uniform vec2 uC, uN;
uniform float uR, uA;
varying vec2 vP;
void main() {
  float s = dot(vP - uC, -uN);
  float a = s <= 0.0 ? 0.0 : (s < uR ? 1.0 : exp(-(s - uR) / (uR * 1.5)));
  a *= uA * 0.28;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

function program(gl, vs, fs) {
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; for (const n of ['uSize', 'uC', 'uN', 'uR', 'uTex', 'uFit', 'uHas', 'uSpine', 'uA', 'uPaper']) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}

export function createCurl(o) {
  if (typeof WebGLRenderingContext === 'undefined') return null;
  const { book, surface = book, spine = 22 } = o;
  let paper = [1, 1, 1];
  const cv = document.createElement('canvas'); cv.className = 'pc-canvas';
  let gl = null, P, Sh, meshBuf, idxBuf, quadBuf, tex, nIdx = 0, meshKey = '';
  try {
    gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true });
    if (!gl) return null;
    P = program(gl, VS_PAGE, FS_PAGE); Sh = program(gl, VS_SHADOW, FS_SHADOW);
    meshBuf = gl.createBuffer(); idxBuf = gl.createBuffer(); quadBuf = gl.createBuffer(); tex = gl.createTexture();
  } catch (e) { console.warn('WebGL-Umblättern nicht verfügbar', e); return null; }
  book.appendChild(cv);
  let lost = false;
  cv.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;

  let W = 0, H = 0, R = 40, Lfull = 1;
  let S = { x: 0, y: 0 }, F = { x: 0, y: 0 }, Vel = { x: 0, y: 0 };
  let C = { x: 0, y: 0 }, N = { x: -1, y: 0 }, L = 0;
  let dir = 0, raf = 0, drag = null, ready = false, token = 0, fit = [0, 0, 1, 1], hasTex = 0, hideT = 0;

  // ---------- Größe, Netz ----------
  function size() {
    W = book.clientWidth; H = book.clientHeight;
    const dpr = Math.min(3, devicePixelRatio || 1);
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    R = Math.max(16, Math.min(W, H) * 0.1);
    Lfull = 2 * (W + R) - Math.PI * R + H * 0.24 + 12;   // ab hier ist die Seite ganz umgeschlagen
    const key = W + 'x' + H;
    if (key === meshKey) return;
    meshKey = key;
    const nx = Math.max(16, Math.min(72, Math.round(W / 6))), ny = Math.max(16, Math.min(110, Math.round(H / 6)));
    const v = new Float32Array((nx + 1) * (ny + 1) * 2);
    let q = 0;
    for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) { v[q++] = W * x / nx; v[q++] = H * y / ny; }
    const id = new Uint16Array(nx * ny * 6); q = 0;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const a = y * (nx + 1) + x, b = a + 1, c = a + nx + 1, d = c + 1;
      id[q++] = a; id[q++] = c; id[q++] = b; id[q++] = b; id[q++] = c; id[q++] = d;
    }
    nIdx = id.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, id, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, W, 0, 0, H, W, H]), gl.STATIC_DRAW);
  }

  function upload(r) {
    hasTex = 0;
    if (!r || !r.img) return;
    let src = r.img;
    const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
    if (iw > maxTex || ih > maxTex) {
      const k = maxTex / Math.max(iw, ih), c = document.createElement('canvas');
      c.width = Math.floor(iw * k); c.height = Math.floor(ih * k);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); src = c;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (src !== r.img) src.width = src.height = 0;
    fit = r.fit || [0, 0, 1, 1]; hasTex = 1;
  }

  // ---------- Finger → Rollachse ----------
  // Der Punkt S am rechten Rand wird zum (virtuellen) Finger F gezogen. Aus dem Weg L ergibt sich,
  // wie weit die Achse vom Rand entfernt sein muss, damit S genau unter dem Finger liegt.
  function solveD(len) {
    const h = Math.PI * R;
    if (len >= h) return (len + h) / 2;
    let lo = 0, hi = h;
    for (let k = 0; k < 28; k++) { const m = (lo + hi) / 2; if (m - R * Math.sin(m / R) < len) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  function geom() {
    const vx = Math.min(0, F.x - S.x), lim = Math.abs(vx) * 0.7;
    const vy = Math.max(-lim, Math.min(lim, F.y - S.y));
    L = Math.hypot(vx, vy);
    if (L < 0.05) { N = { x: -1, y: 0 }; C = { x: S.x + 2, y: S.y }; L = 0; return; }
    N = { x: vx / L, y: vy / L };
    const d = solveD(L);
    C = { x: S.x + N.x * d, y: S.y + N.y * d };
  }

  function draw() {
    if (!ready || lost) return;
    geom();
    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enableVertexAttribArray(0);
    // Schatten der Rolle auf der darunterliegenden Seite
    const fadeIn = Math.min(1, L / (R * 1.2)), fadeOut = Math.max(0, Math.min(1, (Lfull - L) / (W * 0.45)));
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(Sh.p);
    gl.uniform2f(Sh.u.uSize, W, H); gl.uniform2f(Sh.u.uC, C.x, C.y); gl.uniform2f(Sh.u.uN, N.x, N.y);
    gl.uniform1f(Sh.u.uR, R); gl.uniform1f(Sh.u.uA, fadeIn * fadeOut);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Die gerollte Seite
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    gl.useProgram(P.p);
    gl.uniform2f(P.u.uSize, W, H); gl.uniform2f(P.u.uC, C.x, C.y); gl.uniform2f(P.u.uN, N.x, N.y);
    gl.uniform1f(P.u.uR, R); gl.uniform4f(P.u.uFit, fit[0], fit[1], fit[2], fit[3]);
    gl.uniform1f(P.u.uHas, hasTex); gl.uniform1f(P.u.uSpine, spine / W);
    gl.uniform3f(P.u.uPaper, paper[0], paper[1], paper[2]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(P.u.uTex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.drawElements(gl.TRIANGLES, nIdx, gl.UNSIGNED_SHORT, 0);
  }

  // ---------- Start / Ende ----------
  const can = d => { const i = o.index(); return d > 0 ? i < o.count() - 1 : i > 0; };
  const turned = y => ({ x: S.x - Lfull, y });
  function begin(d, y0) {
    clearTimeout(hideT);
    dir = d; size();
    S = { x: W, y: Math.max(0, Math.min(H, y0)) };
    F = d > 0 ? { x: S.x, y: S.y } : turned(S.y);
    Vel = { x: 0, y: 0 };
    ready = false;
    const tok = ++token, i = o.index(), pi = d > 0 ? i : i - 1;
    const show = r => {
      if (tok !== token || lost) return;
      upload(r); ready = true;
      try { paper = (o.paper && o.paper()) || [1, 1, 1]; } catch {}
      if (d > 0) o.setBase(i + 1);
      draw(); cv.classList.add('on');
    };
    let r = null;
    try { r = o.image(pi); } catch {}
    if (r && typeof r.then === 'function') r.then(show, () => show(null)); else show(r);
  }
  function end() {
    // Leinwand erst ausblenden, wenn die neue Grundseite sicher gezeichnet ist
    const tok = token;
    hideT = setTimeout(() => { if (tok === token && !dir) { cv.classList.remove('on'); ready = false; } }, 90);
  }

  // ---------- Federanimation (2D) ----------
  function animateTo(T, done) {
    cancelAnimationFrame(raf);
    let last = performance.now();
    const k = 140, c = 2 * Math.sqrt(k);
    const step = now => {
      const dt = Math.min(0.032, (now - last) / 1000); last = now;
      for (const a of ['x', 'y']) { const acc = k * (T[a] - F[a]) - c * Vel[a]; Vel[a] += acc * dt; F[a] += Vel[a] * dt; }
      if (F.x > S.x) { F.x = S.x; Vel.x = 0; }
      draw();
      if (Math.hypot(T.x - F.x, T.y - F.y) < 2 && Math.hypot(Vel.x, Vel.y) < 40) { F = { ...T }; draw(); raf = 0; done(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function finish(commit) {
    const i = o.index(), d = dir;
    const T = d > 0 ? (commit ? turned(S.y - H * 0.06) : { ...S }) : (commit ? { ...S } : turned(F.y));
    animateTo(T, () => {
      if (d > 0) { if (commit) o.commit(i + 1); else o.setBase(i); }
      else if (commit) { o.setBase(i - 1); o.commit(i - 1); }
      dir = 0; end();
    });
  }
  function instant(d) {
    const i = o.index() + d;
    book.animate?.([{ opacity: .4 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    o.setBase(i); o.commit(i);
  }
  function go(d) {
    if (raf || drag || !can(d)) return false;
    if (reducedMotion() || lost) { instant(d); return true; }
    size();
    begin(d, H * 0.58);
    if (d > 0) Vel = { x: -380, y: -40 }; else { F = turned(S.y - H * 0.06); Vel = { x: 380, y: 20 }; }
    finish(true);
    return true;
  }

  // ---------- Gesten ----------
  const down = e => {
    if (e.button > 0 || drag || raf) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), lt: performance.now(), d: 0, moved: false, fx: 0, fy: 0 };
  };
  const move = e => {
    const g = drag; if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.d) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.1) { if (Math.hypot(dx, dy) > 10) g.moved = true; return; }
      g.moved = true;
      const d = dx < 0 ? 1 : -1;
      if (!can(d)) { g.d = 'blocked'; return; }
      g.d = d;
      if (reducedMotion() || lost) return;
      try { surface.setPointerCapture(e.pointerId); } catch {}
      const r = book.getBoundingClientRect();
      begin(d, g.y - r.top);
      g.F0 = { ...F };
    }
    if (g.d === 'blocked' || reducedMotion() || lost || !g.F0) return;
    // vorwärts folgt die Kante dem Finger; wer oben/unten greift, rollt die Ecke schräg voran.
    // rückwärts kommt die Seite zügiger von links zurück.
    const k = g.d > 0 ? 1.1 : Lfull / (W * 0.9);
    const ex = dx * k, lean = g.d > 0 ? (S.y - H / 2) / (H / 2) : 0;
    const nF = { x: Math.min(S.x, g.F0.x + ex), y: g.F0.y + dy * 0.6 - lean * Math.min(Math.abs(ex), W * 0.6) * 0.3 };
    const now = performance.now(), dt = Math.max(1, now - g.lt) / 1000; g.lt = now;
    Vel = { x: Vel.x * 0.5 + ((nF.x - F.x) / dt) * 0.5, y: Vel.y * 0.5 + ((nF.y - F.y) / dt) * 0.5 };
    F = nF; draw();
  };
  const up = e => {
    const g = drag; if (!g || e.pointerId !== g.id) return;
    drag = null;
    if (!g.d) {
      if (!g.moved && performance.now() - g.t < 350) {
        const r = surface.getBoundingClientRect();
        o.onTap && o.onTap((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      }
      return;
    }
    if (g.d === 'blocked') { o.onEdge && o.onEdge(); return; }
    if (reducedMotion() || lost) { instant(g.d); return; }
    if (!g.F0) return;
    const fling = Math.abs(Vel.x) > 380, moved = S.x - F.x;
    const commit = g.d > 0 ? (fling ? Vel.x < 0 : moved > W * 0.5) : (fling ? Vel.x > 0 : moved < Lfull - W * 0.5);
    finish(e.type === 'pointercancel' ? false : commit);
  };
  surface.addEventListener('pointerdown', down);
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', up);
  surface.addEventListener('pointercancel', up);

  return {
    go,
    busy: () => !!(raf || drag),
    destroy() {
      cancelAnimationFrame(raf); clearTimeout(hideT); token++;
      surface.removeEventListener('pointerdown', down); surface.removeEventListener('pointermove', move);
      surface.removeEventListener('pointerup', up); surface.removeEventListener('pointercancel', up);
      try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
      cv.remove();
    },
  };
}
