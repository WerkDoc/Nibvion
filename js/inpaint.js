// ================= Retusche: Schrift aus dem Bild entfernen =================
// Wie CamScanner beim Übersetzen: nicht ein Rechteck übermalen, sondern nur die Schrift-Pixel
// (plus schmalen Rand) von außen nach innen mit der Umgebung auffüllen, glätten und die Körnung
// des Hintergrunds wieder darüberlegen. Struktur, Licht und Schatten bleiben erhalten.

/**
 * px: RGBA-Daten des ganzen Bildes (wird verändert), W/H: Bildgröße,
 * box: [x0,y0,x1,y1] (inklusive), mask: Uint8Array der Größe (x1-x0+1)*(y1-y0+1) – 1 = entfernen.
 */
export function inpaintRegion(px, W, H, mask, box) {
  const mw = box[2] - box[0] + 1, mh = box[3] - box[1] + 1;
  const hole = (gx, gy) => { const lx = gx - box[0], ly = gy - box[1]; return lx >= 0 && ly >= 0 && lx < mw && ly < mh ? mask[ly * mw + lx] : 0; };
  const PAD = 10;
  const x0 = Math.max(0, box[0] - PAD), y0 = Math.max(0, box[1] - PAD), x1 = Math.min(W - 1, box[2] + PAD), y1 = Math.min(H - 1, box[3] + PAD);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, N = bw * bh;
  if (bw < 3 || bh < 3) return;
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), fill = new Uint8Array(N), known = new Uint8Array(N);
  let left = 0;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = y * bw + x, o = ((y + y0) * W + x + x0) * 4, hv = hole(x + x0, y + y0);
    R[i] = px[o]; G[i] = px[o + 1]; B[i] = px[o + 2];
    fill[i] = hv; known[i] = hv ? 0 : 1; left += hv;
  }
  if (!left || left === N) return;
  // Körnung der Umgebung (Pixel minus 5×5-Mittel) als Vorrat
  const res = new Float32Array(N * 3), srcs = [];
  for (let y = 2; y < bh - 2; y += 1) for (let x = 2; x < bw - 2; x += 1) {
    if ((x & 1) || (y & 1)) continue;
    const i = y * bw + x; let ok = true, mr = 0, mg = 0, mb = 0;
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) { const j = i + dy * bw + dx; if (!known[j]) { ok = false; break; } mr += R[j]; mg += G[j]; mb += B[j]; }
    if (!ok) continue;
    res[i * 3] = R[i] - mr / 25; res[i * 3 + 1] = G[i] - mg / 25; res[i * 3 + 2] = B[i] - mb / 25;
    srcs.push(i);
  }
  // Zwiebelschalen: Ring für Ring von außen nach innen
  const RAD = 3;
  let ring = [];
  for (let i = 0; i < N; i++) if (!known[i]) {
    const x = i % bw;
    if ((x > 0 && known[i - 1]) || (x < bw - 1 && known[i + 1]) || (i >= bw && known[i - bw]) || (i < N - bw && known[i + bw])) ring.push(i);
  }
  const inRing = new Uint8Array(N);
  for (let guard = 0; ring.length && guard < 400; guard++) {
    const vals = new Float32Array(ring.length * 3);
    ring.forEach((i, n) => {
      const x = i % bw, y = (i / bw) | 0; let r = 0, g = 0, b = 0, ws = 0;
      for (let dy = -RAD; dy <= RAD; dy++) { const yy = y + dy; if (yy < 0 || yy >= bh) continue;
        for (let dx = -RAD; dx <= RAD; dx++) { const xx = x + dx; if (xx < 0 || xx >= bw) continue;
          const j = yy * bw + xx; if (!known[j]) continue;
          const wt = 1 / (dx * dx + dy * dy); r += R[j] * wt; g += G[j] * wt; b += B[j] * wt; ws += wt; } }
      vals[n * 3] = r / ws; vals[n * 3 + 1] = g / ws; vals[n * 3 + 2] = b / ws;
    });
    const next = [];
    ring.forEach((i, n) => { R[i] = vals[n * 3]; G[i] = vals[n * 3 + 1]; B[i] = vals[n * 3 + 2]; known[i] = 1; left--; });
    for (const i of ring) {
      const x = i % bw;
      for (const j of [x > 0 ? i - 1 : -1, x < bw - 1 ? i + 1 : -1, i - bw, i + bw]) if (j >= 0 && j < N && !known[j] && !inRing[j]) { inRing[j] = 1; next.push(j); }
    }
    next.forEach(j => { inRing[j] = 0; });
    ring = next;
  }
  // Glätten (Laplace) nur in den gefüllten Pixeln – gegen Streifen
  const idx = []; for (let i = 0; i < N; i++) if (fill[i]) idx.push(i);
  const iters = Math.min(120, 30 + Math.round(Math.sqrt(idx.length) / 3));
  for (let it = 0; it < iters; it++) for (const i of idx) {
    const x = i % bw;
    const l = x > 0 ? i - 1 : i, r = x < bw - 1 ? i + 1 : i, u = i >= bw ? i - bw : i, d = i < N - bw ? i + bw : i;
    R[i] = (R[l] + R[r] + R[u] + R[d]) / 4; G[i] = (G[l] + G[r] + G[u] + G[d]) / 4; B[i] = (B[l] + B[r] + B[u] + B[d]) / 4;
  }
  // Körnung blockweise aus der Umgebung kopieren und zurückschreiben
  const blk = new Map();
  const srcFor = (x, y) => { const k = (y >> 3) * 8192 + (x >> 3); if (!blk.has(k)) blk.set(k, srcs.length ? srcs[(Math.random() * srcs.length) | 0] : -1); return blk.get(k); };
  for (const i of idx) {
    const x = i % bw, y = (i / bw) | 0, c = srcFor(x, y);
    let nr = 0, ng = 0, nb = 0;
    if (c >= 0) {
      const cx = (c % bw) + (x & 7) - 4, cy = ((c / bw) | 0) + (y & 7) - 4, j = cy * bw + cx;
      if (cx >= 0 && cy >= 0 && cx < bw && cy < bh && !fill[j]) { nr = res[j * 3]; ng = res[j * 3 + 1]; nb = res[j * 3 + 2]; }
      else { nr = res[c * 3]; ng = res[c * 3 + 1]; nb = res[c * 3 + 2]; }
    }
    const o = ((y + y0) * W + x + x0) * 4;
    px[o] = Math.max(0, Math.min(255, R[i] + nr)); px[o + 1] = Math.max(0, Math.min(255, G[i] + ng)); px[o + 2] = Math.max(0, Math.min(255, B[i] + nb));
  }
}

/** Lokale Maske (w×h) um r Pixel erweitern. */
export function dilate(m, w, h, r) {
  for (let k = 0; k < r; k++) {
    const m2 = m.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (m[i]) continue;
      if ((x > 0 && m[i - 1]) || (x < w - 1 && m[i + 1]) || (y > 0 && m[i - w]) || (y < h - 1 && m[i + w])) m2[i] = 1;
    }
    m = m2;
  }
  return m;
}
