// Pixel-art sundown scenes: a desert at dusk with mesas, saguaros and the open door.
// drawScene() returns one hex color per pixel plus metadata (where the stars, sun and door
// are) so animations can be layered exactly on top. build-scenes.mjs writes both.
// Every scene is drawn from a seed, so the same options always give the same picture.
export const SUNDOWN = {
  sky: ["#211832", "#2E2146", "#432A5A", "#5E3266", "#813C6C", "#A8496C", "#CB5B62", "#E47554", "#F19448", "#F5AE45"],
  stars: ["#F6E7D0", "#9C7AA8"],
  sunCore: "#FFF0C8", sun: "#FBDC8C", sunRim: "#F7C35A",
  cloudHi: ["#4A2D5E", "#7A3A6A"], cloudLo: ["#D9645C", "#F39A5A"],
  haze: ["#B5677A", "#94566F", "#7A4868"],
  mesaRim: "#F2A052", mesaLit: "#DE8540", mesa: "#B5603E", mesaMid: "#A7553C", mesaShade: "#7A3A2C", mesaDeep: "#55271F", strata: "#8E4632",
  sand: ["#F4BE72", "#EBA45A", "#DD8C48", "#C9743C", "#AC5D34", "#87452B", "#5E3024", "#3A1E1C"],
  trail: "#F7CF8E",
  cactus: "#2E5C4E", cactusHi: "#4F8A6A", cactusLo: "#1D3B33",
  brush: "#3F5E3E", brushHi: "#6A8A55",
  rock: "#6B2E2A", rockHi: "#9A4234", rockLo: "#401B1D",
  saffron: "#F7CC2E", wheat: "#F9D07A", terracotta: "#D47A2C", clay: "#A7553C", graphite: "#16181D", frame: "#3A2620",
};
const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// Ordered (Bayer) dithering threshold for a pixel, in (0, 1).
export const th = (x, y) => (B4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
export function makeRng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// A color from a palette at position t, dithered between neighbouring entries.
export const ramp = (pal, t, x, y) => { const v = Math.max(0, Math.min(1, t)) * (pal.length - 1); const b = Math.min(pal.length - 1, Math.floor(v)); return v - b > th(x, y) && b + 1 < pal.length ? pal[b + 1] : pal[b]; };

export function drawScene(W, H, o) {
  const R = makeRng(o.seed ?? 7);
  const buf = new Array(W * H).fill(SUNDOWN.graphite);
  const set = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = c; };
  const hz = Math.round(H * o.horizon);
  const meta = { width: W, height: H, horizon: hz, stars: [], sun: null, door: null };

  // Sky: dithered bands from night violet down to saffron at the horizon.
  for (let y = 0; y < hz + 4; y++) for (let x = 0; x < W; x++) set(x, y, ramp(SUNDOWN.sky, y / hz, x, y));
  for (let i = 0; i < W * (o.calm ? 0.02 : 0.05); i++) {
    const x = Math.round(R() * W), y = Math.round(R() * hz * 0.25), c = R() < 0.35 ? SUNDOWN.stars[0] : SUNDOWN.stars[1];
    set(x, y, c);
    if (x < W && y < H) meta.stars.push([x, y, c]);
  }

  // Sun, sitting low.
  if (o.sun) {
    const { x: sx0, r } = o.sun; const sx = Math.round(W * sx0), sy = hz - Math.round(r * 0.3);
    meta.sun = { x: sx, y: sy, r };
    for (let y = sy - r; y <= sy + r; y++) for (let x = sx - r; x <= sx + r; x++) {
      const d = Math.hypot(x - sx + 0.5, y - sy + 0.5);
      if (d <= r) set(x, y, d < r * 0.6 ? SUNDOWN.sunCore : d < r * 0.88 ? SUNDOWN.sun : SUNDOWN.sunRim);
    }
  }
  // Long sunset clouds.
  for (let i = 0; i < (o.clouds ?? 7); i++) {
    const y = Math.round(hz * (0.1 + R() * 0.72)); const len = Math.round(W * (0.08 + R() * 0.2)); const x0 = Math.round(R() * (W + len) - len / 2);
    const pal = y / hz < 0.45 ? SUNDOWN.cloudHi : SUNDOWN.cloudLo;
    for (let x = x0 + Math.round(len * 0.2); x < x0 + len * 0.75; x++) set(x, y, pal[0]);
    for (let x = x0; x < x0 + len; x++) set(x, y + 1, pal[1]);
    if (R() < 0.5) for (let x = x0 + Math.round(len * 0.45); x < x0 + len * 0.95; x++) set(x, y + 2, pal[1]);
  }

  for (const b of o.birds ?? []) { const bx = Math.round(W * b[0]), by = Math.round(hz * b[1]); set(bx - 1, by, SUNDOWN.cloudHi[0]); set(bx, by + 1, SUNDOWN.cloudHi[0]); set(bx + 1, by, SUNDOWN.cloudHi[0]); }
  // Far mesas in haze.
  for (const m of o.far ?? []) {
    const x0 = W * m.x0, x1 = W * m.x1, top = hz - m.h;
    for (let x = Math.floor(x0 - m.h * 1.6); x < x1 + m.h * 1.6; x++) {
      const edge = x < x0 ? (x0 - x) / 1.6 : x > x1 ? (x - x1) / 1.6 : 0; const t = Math.round(top + edge);
      for (let y = t; y < hz + 2; y++) set(x, y, y === t ? SUNDOWN.haze[0] : ramp(SUNDOWN.haze, (y - t) / Math.max(1, hz - t), x, y));
    }
  }

  // Ground: lit sand near the horizon, darkening toward the viewer.
  for (let y = hz; y < H; y++) for (let x = 0; x < W; x++) {
    let c = ramp(SUNDOWN.sand, (y - hz) / (H - hz) * (o.groundDepth ?? 0.85), x, y);
    if (R() < (o.calm ? 0.012 : 0.035)) c = SUNDOWN.sand[Math.min(SUNDOWN.sand.length - 1, SUNDOWN.sand.indexOf(c) + 1)];
    set(x, y, c);
  }
  for (let i = 0; i < W * (o.calm ? 0.04 : 0.12); i++) { const y = hz + 2 + R() * (H - hz) * 0.7; const x = R() * W; const l = 3 + R() * 8; const c = R() < 0.5 ? SUNDOWN.sand[0] : SUNDOWN.sand[3]; for (let k = 0; k < l; k++) set(x + k, y, c); }

  // Near mesas: lit left faces, strata, shadowed right faces, talus skirts.
  for (const m of o.mesas ?? []) {
    const x0 = Math.round(W * m.x0), x1 = Math.round(W * m.x1), top = hz - m.h, base = hz + (m.base ?? 3), skirt = Math.round(m.h * 0.9);
    let step = 0; const tops = [];
    for (let x = x0; x <= x1; x++) { if (R() < 0.18) step = Math.max(-1, Math.min(1, step + (R() < 0.5 ? -1 : 1))); tops.push(top + step); }
    const crevices = new Map(Array.from({ length: Math.round((x1 - x0) / 9) }, () => [x0 + Math.round(R() * (x1 - x0)), 0.35 + R() * 0.6]));
    for (let x = x0 - skirt; x <= x1 + skirt; x++) {
      const inBody = x >= x0 && x <= x1; const cliffBase = Math.round(hz - m.h * 0.38);
      const t = inBody ? tops[x - x0] : x < x0 ? Math.round(cliffBase + (x0 - x) * (base - cliffBase) / skirt) : Math.round(cliffBase + (x - x1) * (base - cliffBase) / skirt);
      for (let y = t; y <= base; y++) {
        const u = (x - x0) / (x1 - x0);
        let c;
        if (inBody && y < cliffBase) {
          c = u < 0.14 ? SUNDOWN.mesaLit : u > 0.8 ? SUNDOWN.mesaShade : u > 0.62 ? SUNDOWN.mesaMid : SUNDOWN.mesa;
          if (y === t) c = u > 0.8 ? SUNDOWN.mesaMid : SUNDOWN.mesaRim;
          else if ((y - top) % 5 === 0 && R() < 0.75) c = u > 0.8 ? SUNDOWN.mesaDeep : SUNDOWN.strata;
          if (crevices.has(x) && y > t + 1 && y < t + (cliffBase - t) * crevices.get(x)) c = u > 0.62 ? SUNDOWN.mesaDeep : SUNDOWN.mesaShade;
          if (u < 0.03 && y > t) c = SUNDOWN.mesaRim;
        } else {
          const side = x < x0 + (x1 - x0) * 0.5 ? 0 : 1;
          c = ramp([side ? SUNDOWN.mesaShade : SUNDOWN.mesa, SUNDOWN.mesaShade, SUNDOWN.mesaDeep], (y - t) / Math.max(1, base - t + 2), x, y);
          if (R() < 0.018) c = R() < 0.5 ? SUNDOWN.brush : SUNDOWN.brushHi;
        }
        set(x, y, c);
      }
    }
  }

  // A trail running toward the door, then the door itself.
  if (o.door && o.trail !== false) drawTrail(set, W, H, hz, o.door, [SUNDOWN.trail, SUNDOWN.sand[1], SUNDOWN.sand[3]]);
  if (o.door) meta.door = drawDoor(set, W, hz, o.door);

  // Saguaros.
  for (const s of o.cacti ?? []) {
    const x = Math.round(W * s.x), base = hz + s.y, h = s.h, w = s.w ?? Math.max(3, Math.round(h / 9));
    const col = (cx, y0, y1, ww) => { for (let y = y0; y <= y1; y++) for (let k = 0; k < ww; k++) { if (y === y0 && (k === 0 || k === ww - 1) && ww > 2) continue; set(cx + k, y, k === 0 ? SUNDOWN.cactusHi : k === ww - 1 ? SUNDOWN.cactusLo : SUNDOWN.cactus); } };
    col(x, base - h, base, w);
    for (const [side, at, up] of s.arms ?? [[-1, 0.5, 0.32], [1, 0.62, 0.26]]) {
      const ay = Math.round(base - h * at); const aw = Math.max(2, w - 1); const reach = Math.round(w * 0.9) + 1;
      const ax = side < 0 ? x - reach - aw + 1 : x + w + reach - 1;
      for (let k = 0; k < reach + aw; k++) for (let t = 0; t < aw; t++) set(side < 0 ? x - 1 - k : x + w + k, ay - t, t === 0 ? SUNDOWN.cactusLo : SUNDOWN.cactus);
      col(ax, Math.round(ay - h * up), ay, aw);
    }
  }
  // Scrub.
  for (let i = 0; i < (o.brush ?? 30); i++) {
    const y = hz + 3 + Math.pow(R(), 0.7) * (H - hz - 4), x = R() * W, s = 1 + (y - hz) / (H - hz) * 4;
    if (o.door && y > hz + o.door.y - 4 && Math.abs(x - W * o.door.x - o.door.h * 0.3) < o.door.h * (0.6 + (y - hz - o.door.y) / (H - hz) * 2.2)) continue;
    for (let k = 0; k < s * 3; k++) { const ox = (R() - 0.5) * s * 2.2, oy = -R() * s; set(x + ox, y + oy, oy < -s * 0.5 ? SUNDOWN.brushHi : SUNDOWN.brush); }
  }
  // Foreground rocks in the corners.
  for (const r of o.rocks ?? []) {
    const x0 = Math.round(W * r.x0), x1 = Math.round(W * r.x1); let hgt = r.h;
    for (let x = x0; x <= x1; x++) {
      const u = (x - x0) / (x1 - x0); hgt += (R() - 0.5) * 2; const top = H - Math.round(Math.sin(Math.PI * u) * hgt);
      for (let y = top; y < H; y++) set(x, y, y === top ? SUNDOWN.rockHi : (y - top) % 4 === 0 && R() < 0.5 ? SUNDOWN.rockLo : SUNDOWN.rock);
    }
  }
  // Dither the bottom into graphite so text can sit on it.
  if (o.fade) for (let y = H - o.fade; y < H; y++) for (let x = 0; x < W; x++) if ((y - (H - o.fade)) / o.fade > th(x, y)) set(x, y, SUNDOWN.graphite);
  // Keep only stars nothing was drawn over.
  meta.stars = meta.stars.filter(([x, y, c]) => buf[y * W + x] === c).map(([x, y, c]) => [x, y, c === SUNDOWN.stars[0] ? 1 : 0]);
  return { pixels: buf, meta };
}

// A path from the bottom of the scene to the door, widening toward the viewer.
export function drawTrail(set, W, H, hz, door, pal) {
  const dx = W * door.x, dy = hz + door.y;
  for (let y = Math.round(dy + 2); y < H; y++) {
    const t = (y - dy) / (H - dy); const cx = dx + (door.trailTo - door.x) * W * t * t; const hw = 1 + t * W * 0.05;
    for (let x = Math.round(cx - hw); x <= cx + hw; x++) if (Math.abs(x - cx) < hw - 1 || th(x, y) < 0.5) set(x, y, ramp(pal, t, x, y));
  }
}

// The open door: a lit doorway standing in the scene, light spilling toward the viewer.
// `spill` colors the light on the ground, nearest first; `halo` is the glow around the frame
// (null for none, where the warm dither would read as a box against the background).
// Returns where the doorway and its light are, for the lamplight animations.
export function drawDoor(set, W, hz, door, { halo = SUNDOWN.terracotta, spill = [SUNDOWN.saffron, SUNDOWN.terracotta, SUNDOWN.clay] } = {}) {
  const h = door.h, w = Math.round(h * 0.5), dx = Math.round(W * door.x), dy = hz + door.y;
  const len = door.spill ?? Math.round(h * 2.1);
  const far = { cx: dx + w / 2 + 5, half: w / 2 + 1 + w * 1.9 };
  if (halo) for (let y = dy - h - 3; y <= dy + 1; y++) for (let x = dx - 3; x <= dx + w + 3; x++) if (th(x, y) < 0.22) set(x, y, halo);
  for (let j = 1; j <= len; j++) {
    const t = j / len; const half = w / 2 + 1 + t * w * 1.9; const cx = dx + w / 2 + t * 5;
    for (let x = Math.round(cx - half); x <= cx + half; x++) {
      const edge = Math.abs(x - cx) / half; const dens = (1 - t * 0.85) * (1 - edge * edge * 0.7);
      if (dens > th(x, dy + j) * 0.9) set(x, dy + j, t < 0.22 ? spill[0] : t < 0.5 ? spill[1] : spill[2]);
    }
  }
  for (let y = dy - h; y <= dy; y++) { set(dx + w, y, SUNDOWN.frame); }
  for (let x = dx - 1; x <= dx + w; x++) set(x, dy - h - 1, SUNDOWN.frame);
  for (let y = dy - h; y <= dy; y++) for (let x = dx; x < dx + w; x++) set(x, y, y < dy - h + 2 ? SUNDOWN.wheat : SUNDOWN.saffron);
  const pw = Math.max(2, Math.round(w * 0.6));
  for (let i = 0; i < pw; i++) { const rise = Math.round((i + 1) * 0.5); for (let y = dy - h - rise; y <= dy + rise; y++) set(dx - 1 - i, y, SUNDOWN.graphite); }
  return { x: dx, y: dy - h, w, h, spill: [[dx - 1, dy + 1], [dx + w + 1, dy + 1], [Math.round(far.cx + far.half), dy + len], [Math.round(far.cx - far.half), dy + len]] };
}

// A tumbleweed, drawn at `angle` so a strip of frames reads as rolling. Transparent
// pixels are null.
export function drawTumbleweed(size, angle, seed = 5) {
  const R = makeRng(seed);
  const px = new Array(size * size).fill(null);
  const c = (size - 1) / 2, r = size / 2 - 0.6;
  const colors = ["#3E2718", "#5A3A22", "#7A5230", "#A57A45"];
  const strands = [{ ox: 0, oy: 0, rad: r, a0: 0, len: Math.PI * 2, tone: 0, step: 0.5 }];
  for (let i = 0; i < 14; i++) strands.push({ ox: (R() - 0.5) * r * 0.9, oy: (R() - 0.5) * r * 0.9, rad: r * (0.25 + R() * 0.6), a0: R() * Math.PI * 2, len: 1.2 + R() * 2.4, tone: 1 + (i % 3), step: 0.15 });
  for (const st of strands) {
    for (let a = st.a0; a < st.a0 + st.len; a += st.step) {
      if (st.tone === 0 && Math.sin(a * 3 + seed) > 0.75) continue; // gaps in the outline
      const x0 = st.ox + Math.cos(a) * st.rad, y0 = st.oy + Math.sin(a) * st.rad;
      const x = Math.round(c + x0 * Math.cos(angle) - y0 * Math.sin(angle)), y = Math.round(c + x0 * Math.sin(angle) + y0 * Math.cos(angle));
      if (x >= 0 && y >= 0 && x < size && y < size) px[y * size + x] = colors[st.tone];
    }
  }
  return px;
}
