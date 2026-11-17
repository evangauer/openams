// Where the door leads. The footer's desert door opens onto these: a western town at
// sundown, the sea floor and the moon. Each is the same size as the footer strip with the
// door in the same place, so stepping through only changes what's around it. Same rules
// as scenes.mjs: drawn from a seed, ordered dithering, one hex color per pixel.
import { SUNDOWN, drawDoor, drawScene, drawTrail, makeRng, ramp, th } from "./scenes.mjs";

function canvas(W, H, fill) {
  const buf = new Array(W * H).fill(fill);
  const set = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = c; };
  const get = (x, y) => buf[Math.round(y) * W + Math.round(x)];
  return { buf, set, get };
}
// Draws a sprite from rows of characters; each character maps to a color, "." is empty.
function sprite(set, x0, y0, rows, colors, flip = false) {
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (colors[ch]) set(flip ? x0 + row.length - 1 - x : x0 + x, y0 + y, colors[ch]); }));
}
const keepStars = (buf, W, stars, bright) => stars.filter(([x, y, c]) => buf[y * W + x] === c).map(([x, y, c]) => [x, y, c === bright ? 1 : 0]);

// ---------------------------------------------------------------- the western town

export const TOWN = {
  wood: "#7A3F2C", woodLit: "#9A5236", woodDark: "#55291F", woodDeep: "#3A1E1C",
  trim: "#C9743C", rim: "#F2A052", sign: "#B87A45", signEdge: "#5E3024",
  glass: "#2E2146", lamp: "#F7CC2E", lampHi: "#F9D07A",
  awning: "#5E3024", stripe: "#A7553C", barn: "#8E3A2C", barnLit: "#A7553C",
  rider: "#2A1830",
};

// A rider on horseback, facing right, to stand against the setting sun.
const RIDER = [
  "......XX........",
  ".....XXXX.......",
  "......XX........",
  "......XXX.....X.",
  ".....XXX.X...XX.",
  ".....XXX..XXXXXX",
  "..XXXXXXXXXXX.XX",
  ".XXXXXXXXXXXX...",
  "X.XXXXXXXXXXX...",
  "X.X.X.....X.X...",
  "..X.X.....X.X...",
  "..X..X....X..X..",
];

function building(set, R, b, s, sunX, lamps) {
  const { x0, x1, h } = s, top = b - h, mid = (x0 + x1) / 2, litRight = mid < sunX;
  const body = s.color ?? TOWN.wood, lit = s.colorLit ?? TOWN.woodLit;
  // A false front: the middle stands a couple of pixels proud of the shoulders.
  const front = (x) => (s.gable ? top + Math.round(Math.abs(x - mid) * (s.gable / ((x1 - x0) / 2))) : x > x0 + (x1 - x0) * 0.2 && x < x1 - (x1 - x0) * 0.2 ? top - 2 : top);
  for (let x = x0; x <= x1; x++) {
    const t = front(x);
    for (let y = t; y <= b; y++) {
      let c = (y - top) % 3 === 2 && R() < 0.8 ? TOWN.woodDark : (litRight ? x > x1 - 2 : x < x0 + 2) ? lit : body;
      if (y === t) c = TOWN.trim;
      else if (y === t + 1) c = TOWN.woodDeep;
      if (x === x0 || x === x1) c = TOWN.woodDeep;
      // The edge facing the sun catches the light.
      if ((litRight && x === x1) || (!litRight && x === x0)) c = TOWN.rim;
      set(x, y, c);
    }
  }
  const win = (x, y, w, hh, on) => {
    for (let yy = y - 1; yy <= y + hh; yy++) for (let xx = x - 1; xx <= x + w; xx++) set(xx, yy, TOWN.woodDeep);
    for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, on ? (yy === y ? TOWN.lampHi : TOWN.lamp) : TOWN.glass);
    if (w >= 3) for (let yy = y; yy < y + hh; yy++) set(x + Math.floor(w / 2), yy, TOWN.woodDeep);
    if (on) lamps.push([x, y, w, hh]);
  };
  for (const [wx, wy, ww, wh, on] of s.windows ?? []) win(x0 + wx, b - wy, ww, wh, on);
  if (s.door) {
    const [dx, w, hh, kind] = s.door, x = x0 + dx;
    for (let y = b - hh; y <= b; y++) for (let xx = x - 1; xx <= x + w; xx++) set(xx, y, TOWN.woodDeep);
    if (kind === "saloon") {
      // Lamplight behind batwing doors.
      for (let y = b - hh + 1; y <= b; y++) for (let xx = x; xx < x + w; xx++) set(xx, y, y < b - hh + 3 || y > b - 2 ? TOWN.lamp : TOWN.woodLit);
      lamps.push([x, b - hh + 1, w, 2]);
    } else if (kind === "barn") {
      for (let y = b - hh + 1; y <= b; y++) for (let xx = x; xx < x + w; xx++) set(xx, y, TOWN.barn);
      for (let k = 0; k < hh; k++) { set(x + Math.round((k * (w - 1)) / (hh - 1)), b - hh + 1 + k, TOWN.woodDeep); set(x + w - 1 - Math.round((k * (w - 1)) / (hh - 1)), b - hh + 1 + k, TOWN.woodDeep); }
    }
  }
  if (s.awning) {
    const y = b - s.awning;
    for (let x = x0 - 1; x <= x1 + 1; x++) { set(x, y, (x - x0) % 4 < 2 ? TOWN.stripe : TOWN.awning); set(x, y + 1, TOWN.woodDeep); }
    for (let x = x0; x <= x1; x += Math.max(6, Math.round((x1 - x0) / 4))) for (let yy = y + 2; yy <= b; yy++) set(x, yy, TOWN.woodDeep);
    for (let yy = y + 2; yy <= b; yy++) set(x1, yy, TOWN.woodDeep);
  }
  if (s.balcony) {
    const y = b - s.balcony;
    for (let x = x0 - 1; x <= x1 + 1; x++) { set(x, y, TOWN.woodDeep); if ((x - x0) % 2 === 0) set(x, y - 1, TOWN.woodDark); set(x, y - 2, TOWN.trim); }
  }
  if (s.sign) {
    const [sx, sy, sw, sh] = s.sign;
    for (let y = b - sy; y < b - sy + sh; y++) for (let x = x0 + sx; x < x0 + sx + sw; x++) {
      const edge = y === b - sy || y === b - sy + sh - 1 || x === x0 + sx || x === x0 + sx + sw - 1;
      set(x, y, edge ? TOWN.signEdge : TOWN.sign);
    }
    // A sheriff's star instead of lettering: scenes never carry text.
    if (s.star) sprite(set, x0 + sx + Math.floor(sw / 2) - 2, b - sy + Math.floor(sh / 2) - 2, ["..X..", "XXXXX", ".XXX.", "X...X"], { X: SUNDOWN.saffron });
  }
  // Boardwalk.
  for (let x = x0 - 2; x <= x1 + 2; x++) set(x, b + 1, (x & 1) ? TOWN.woodDark : TOWN.woodDeep);
}

function waterTower(set, b, x0, legs, tankH, w) {
  const top = b - legs - tankH;
  for (let y = b - legs; y <= b; y++) { set(x0 + 1, y, TOWN.woodDeep); set(x0 + w - 2, y, TOWN.woodDeep); }
  for (let k = 0; k < w - 3; k++) { set(x0 + 2 + k, b - legs + 2 + k, TOWN.woodDark); set(x0 + w - 3 - k, b - legs + 2 + k, TOWN.woodDark); }
  for (let y = top; y < b - legs; y++) for (let x = x0; x < x0 + w; x++) {
    const band = (y - top) % 4 === 1;
    set(x, y, x === x0 + w - 1 ? TOWN.rim : band ? TOWN.woodDeep : x < x0 + 2 ? TOWN.woodDark : TOWN.wood);
  }
  for (let k = 0; k <= Math.ceil(w / 2); k++) for (let x = x0 - 1 + k; x <= x0 + w - k; x++) set(x, top - 1 - k, k === 0 ? TOWN.trim : TOWN.awning);
}

export function drawTown(W, H, o) {
  const R = makeRng(o.seed ?? 41);
  // The desert does the sky, the sun, the far ridge, the street and the door.
  const base = drawScene(W, H, { ...o, mesas: [], cacti: [] });
  const buf = base.pixels, meta = { ...base.meta, lamps: [] };
  const set = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = c; };
  const hz = meta.horizon, b = hz + 3, sunX = meta.sun?.x ?? W / 2;

  // The rider, on the far ridge, against the sun.
  const r = o.rider;
  sprite(set, Math.round(W * r.x) - 8, hz - r.ridge - RIDER.length, RIDER, { X: TOWN.rider });

  for (const s of o.buildings) building(set, R, b, s, sunX, meta.lamps);
  for (const t of o.towers ?? []) waterTower(set, b, t.x, t.legs, t.tank, t.w);
  // Hitching rails and barrels on the boardwalks.
  for (const [x, len] of o.rails ?? []) { for (let k = 0; k <= len; k++) set(x + k, b - 3, TOWN.woodDark); set(x, b - 2, TOWN.woodDeep); set(x, b - 1, TOWN.woodDeep); set(x + len, b - 2, TOWN.woodDeep); set(x + len, b - 1, TOWN.woodDeep); }
  for (const x of o.barrels ?? []) sprite(set, x, b - 3, [".AA.", "BCCB", "BAAB", ".BB."], { A: TOWN.woodDeep, B: TOWN.woodDark, C: TOWN.trim });

  // Keep only stars the town didn't cover.
  meta.stars = meta.stars.filter(([x, y, bright]) => buf[y * W + x] === SUNDOWN.stars[bright ? 0 : 1]);
  return { pixels: buf, meta };
}

// ---------------------------------------------------------------- the sea floor

export const SEA = {
  water: ["#8AD8D2", "#62C2C8", "#43A9B8", "#3290A6", "#28778F", "#226279", "#1E5068", "#1B425A"],
  surface: "#CDF2EA", surfaceLo: "#A6E4DC", glow: ["#FFF6DA", "#E8F7E6", "#BDEBE1"],
  haze: ["#2B6A82", "#255C73", "#204E65"], whale: "#2D7088", whaleLo: "#286580",
  floor: ["#E2CC94", "#CDB27E", "#B49868", "#977F57", "#7A6849", "#5C503D", "#3E3832", "#252428"],
  kelp: "#2E7A57", kelpHi: "#5BAA70", kelpLo: "#1C4F3E",
  coral: "#E8735A", coralHi: "#F6A07E", coralLo: "#B5503E",
  fan: "#A8496C", fanHi: "#CB5B62", fanLo: "#6E2E55",
  rock: "#3E5566", rockHi: "#5E7A88", rockLo: "#2A3A48", iron: "#4A4F58", ironHi: "#6C727C",
  fishLo: "#E0A21E", school: "#B9EEE8", bubble: "#E6FAF6",
};

export function drawSea(W, H, o) {
  const R = makeRng(o.seed ?? 51);
  const { buf, set, get } = canvas(W, H, SEA.water.at(-1));
  const hz = Math.round(H * o.horizon);
  const meta = { width: W, height: H, horizon: hz, stars: [], sun: null, door: null, bubbles: [] };
  const sx = Math.round(W * o.sun.x);
  const waterAt = (x, y, lift = 0) => ramp(SEA.water, y / hz - lift, x, y);

  // Water, lighter toward the surface, with shafts of light slanting down from the sun.
  for (let y = 0; y < hz + 4; y++) for (let x = 0; x < W; x++) set(x, y, waterAt(x, y));
  for (let i = 0; i < (o.rays ?? 6); i++) {
    const x0 = sx - 20 + R() * 60, slope = 0.9 + R() * 0.5, w = 2 + Math.round(R() * 4), reach = hz * (0.6 + R() * 0.45);
    for (let y = 0; y < reach; y++) for (let k = 0; k < w; k++) {
      const x = Math.round(x0 - y * slope + k);
      if (th(x, y) < 0.55 * (1 - y / reach)) set(x, y, waterAt(x, y, 0.22));
    }
  }
  // The surface, rippling, and the sun shimmering through it.
  for (let x = 0; x < W; x++) {
    if (Math.sin(x * 0.37) + Math.sin(x * 0.11 + 1) > -0.6) set(x, 0, SEA.surface);
    if (Math.sin(x * 0.29 + 2) > 0.2 && th(x, 1) < 0.5) set(x, 1, SEA.surfaceLo);
  }
  for (let y = 0; y <= o.sun.r; y++) for (let x = sx - o.sun.r * 2; x <= sx + o.sun.r * 2; x++) {
    const d = Math.hypot((x - sx) / 2, y) / o.sun.r;
    if (d < 1 && th(x, y) < 1.15 - d) set(x, y, SEA.glow[d < 0.4 ? 0 : d < 0.7 ? 1 : 2]);
  }
  meta.sun = { x: sx, y: 0, r: o.sun.r };

  // A whale, far off in the blue.
  if (o.whale) {
    const { x: wx0, y: wy, len } = o.whale, wx = Math.round(W * wx0), half = 3;
    for (let x = 0; x < len; x++) {
      const u = x / len, thick = Math.round(half * Math.sin(Math.PI * Math.min(1, u * 1.25)) + (u > 0.75 ? 1 : 0));
      for (let y = -thick; y <= thick; y++) set(wx + x, wy + y, y > 0 && u > 0.3 ? SEA.whaleLo : SEA.whale);
    }
    sprite(set, wx - 5, wy - 4, ["X....", "XX...", ".XXXX", "XX...", "X...."], { X: SEA.whale });
    sprite(set, wx + Math.round(len * 0.55), wy + half, ["XX", ".XX", "..X"], { X: SEA.whaleLo });
  }
  // Far reefs in the haze.
  for (const m of o.reefs ?? []) {
    const x0 = Math.round(W * m.x0), x1 = Math.round(W * m.x1);
    for (let x = x0; x <= x1; x++) {
      const u = (x - x0) / (x1 - x0), top = Math.round(hz - m.h * Math.sin(Math.PI * u) * (0.75 + 0.25 * Math.sin(x * 0.9)));
      for (let y = top; y < hz + 2; y++) set(x, y, ramp(SEA.haze, (y - top) / Math.max(1, hz - top), x, y));
    }
  }

  // The sea floor, with ripples in the sand.
  for (let y = hz; y < H; y++) for (let x = 0; x < W; x++) set(x, y, ramp(SEA.floor, ((y - hz) / (H - hz)) * (o.groundDepth ?? 0.8), x, y));
  for (let i = 0; i < W * 0.06; i++) {
    const y = Math.round(hz + 2 + R() * (H - hz) * 0.75), x = Math.round(R() * W), l = 3 + Math.round(R() * 6);
    for (let k = 0; k < l; k++) set(x + k, y - (k > 0 && k < l - 1 ? 1 : 0), SEA.floor[0]);
  }
  if (o.door) drawTrail(set, W, H, hz, o.door, [SEA.floor[0], SEA.floor[1], SEA.floor[3]]);

  for (const r of o.rocks ?? []) {
    const x0 = Math.round(W * r.x), base = hz + r.y;
    for (let x = 0; x < r.w; x++) {
      const top = base - Math.round(r.h * Math.sin(Math.PI * (x + 0.5) / r.w));
      for (let y = top; y <= base; y++) set(x0 + x, y, y === top ? SEA.rockHi : x > r.w * 0.6 ? SEA.rockLo : SEA.rock);
    }
  }
  if (o.anchor) {
    const ax = Math.round(W * o.anchor.x), ab = hz + o.anchor.y;
    sprite(set, ax - 3, ab - 9, ["..XXX..", "..X.X..", "..XXX..", "XXXXXXX", "...X...", "...X...", "...X...", "X..X..X", ".XXXXX.", "..YYY.."], { X: SEA.iron, Y: SEA.ironHi });
  }
  // Kelp swaying up from the floor, with bubbles rising off the tallest.
  for (const k of o.kelp ?? []) {
    const x0 = Math.round(W * k.x), base = hz + k.y;
    for (let y = base; y >= base - k.h; y--) {
      const u = base - y, cx = x0 + Math.round(Math.sin(u * 0.22 + k.phase) * 1.6);
      set(cx, y, SEA.kelpHi); set(cx + 1, y, SEA.kelp);
      if (u > 3 && u % 5 === 0) { const side = (u / 5) % 2 ? 1 : -1; set(cx + (side > 0 ? 2 : -1), y - 1, SEA.kelp); set(cx + (side > 0 ? 3 : -2), y - 2, SEA.kelpLo); }
    }
    if (k.h > 20) meta.bubbles.push([x0 + Math.round(Math.sin(k.h * 0.22 + k.phase) * 1.6), base - k.h - 1]);
  }
  for (const c of o.coral ?? []) {
    const x0 = Math.round(W * c.x), base = hz + c.y;
    if (c.fan) {
      for (let y = 0; y <= c.h; y++) for (let x = -c.h; x <= c.h; x++) {
        const d = Math.hypot(x, y * 1.2) / c.h;
        if (d <= 1 && th(x0 + x, base - y) < 1.25 - d * 0.5) set(x0 + x, base - 1 - y, d > 0.84 ? SEA.fanHi : (x + y) % 3 === 0 ? SEA.fanLo : SEA.fan);
      }
      continue;
    }
    const branch = (x, y, len, lean) => {
      for (let i = 0; i < len; i++) { x += lean * (i % 2 ? 1 : 0); y -= 1; set(x, y, i === len - 1 ? SEA.coralHi : lean < 0 ? SEA.coralLo : SEA.coral); if (i < len - 2) set(x + 1, y, SEA.coralLo); }
      return [x, y];
    };
    const [mx, my] = branch(x0, base, c.h, 0);
    branch(x0, base - Math.round(c.h * 0.35), Math.round(c.h * 0.6), -1);
    branch(x0, base - Math.round(c.h * 0.55), Math.round(c.h * 0.5), 1);
    branch(mx, my, 2, -1);
  }

  if (o.door) {
    meta.door = drawDoor(set, W, hz, o.door, { halo: null, spill: [SUNDOWN.saffron, "#E8C27A", "#C9AE7A"] });
    meta.bubbles.push([meta.door.x + meta.door.w - 2, meta.door.y - 2]);
  }

  // Fish: a few saffron ones close by, a small school farther off.
  for (const [fx, fy, left] of o.fish ?? []) sprite(set, Math.round(W * fx), fy, [".XXX.", "TXXXE", ".XXX."], { X: SUNDOWN.saffron, T: SEA.fishLo, E: SUNDOWN.graphite }, !left);
  for (const s of o.school ?? []) for (let i = 0; i < s.n; i++) {
    const x = Math.round(W * s.x + (R() - 0.5) * s.spread * 2), y = Math.round(s.y + (R() - 0.5) * s.spread * 0.6);
    set(x, y, SEA.school); set(x + 1, y, SEA.school);
  }
  // A few bubbles caught mid-rise.
  for (const [bx, by] of meta.bubbles) for (let k = 1; k <= 3; k++) if (get(bx, by - k * 3)) set(bx + (k % 2), by - k * 3, SEA.bubble);
  return { pixels: buf, meta };
}

// ---------------------------------------------------------------- the moon

export const SPACE = {
  sky: ["#06050D", "#0B0918", "#110E22", "#18132C", "#1F1735", "#28193F", "#331D49"],
  nebula: ["#2E1C44", "#4A2858", "#6B3366", "#8E3E6C"],
  stars: ["#FFF6E0", "#C7B8E0", "#9C7AA8"],
  ground: ["#CFCAD6", "#B5AFC0", "#9A93A8", "#7F7890", "#655E77", "#4C465E", "#353046", "#221E30"],
  rimHi: "#ECE8F0",
  planet: ["#F5AE45", "#F19448", "#E47554", "#CB5B62", "#A8496C"], planetShade: "#6E2E55", ring: "#F9D07A", ringLo: "#C9874A",
  earth: "#2E6FB0", earthHi: "#5C9BD6", land: "#4F8A6A", cloud: "#EAF2F8", earthShade: "#173B63",
  pole: "#D8D4DE",
};

export function drawSpace(W, H, o) {
  const R = makeRng(o.seed ?? 61);
  const { buf, set, get } = canvas(W, H, SPACE.sky[0]);
  const hz = Math.round(H * o.horizon);
  const meta = { width: W, height: H, horizon: hz, stars: [], sun: null, door: null };
  // The moon is small: its horizon bows down at the edges.
  const rim = (x) => hz + Math.round(((x / W - 0.5) * 2) ** 2 * (o.bow ?? 3));

  for (let y = 0; y < hz + 6; y++) for (let x = 0; x < W; x++) set(x, y, ramp(SPACE.sky, y / hz, x, y));
  // A faint nebula across the sky.
  const n = o.nebula;
  for (let y = 0; y < hz; y++) for (let x = 0; x < W; x++) {
    const along = y - (n.y0 + (n.y1 - n.y0) * (x / W)), d = along / n.w;
    const v = Math.exp(-d * d) * (0.55 + 0.25 * Math.sin(x * 0.13 + y * 0.31) + 0.2 * Math.sin(x * 0.047 - y * 0.19 + 1.3));
    if (v > th(x, y) * 0.9 + 0.12) set(x, y, SPACE.nebula[Math.min(3, Math.floor(v * 4.2))]);
  }
  for (let i = 0; i < W * (o.starDensity ?? 0.12); i++) {
    const x = Math.round(R() * W), y = Math.round(R() * (hz - 2)), r = R();
    const c = r < 0.18 ? SPACE.stars[0] : r < 0.55 ? SPACE.stars[1] : SPACE.stars[2];
    set(x, y, c); meta.stars.push([x, y, c]);
  }

  // Earth, small and far.
  const e = o.earth, ex = Math.round(W * e.x);
  for (let y = -e.r; y <= e.r; y++) for (let x = -e.r; x <= e.r; x++) {
    const d = Math.hypot(x + 0.5, y + 0.5); if (d > e.r) continue;
    let c = Math.sin(x * 1.3 + y * 0.7) + Math.sin(y * 1.9 - x * 0.4) > 0.9 ? SPACE.land : x + y < -e.r * 0.6 ? SPACE.earthHi : SPACE.earth;
    if (Math.sin(x * 2.1 - y * 1.1) > 0.92) c = SPACE.cloud;
    if (x - y < -e.r * 0.9 + th(ex + x, e.y + y) * 2) c = SPACE.earthShade;
    set(ex + x, e.y + y, c);
  }
  // A ringed planet, lit from the right, its ring passing behind and in front.
  const p = o.planet, px = Math.round(W * p.x), py = p.y;
  const ring = (front) => {
    for (let x = -p.ring; x <= p.ring; x++) for (let y = -8; y <= 8; y++) {
      const yy = y + x * 0.18, d = (x / p.ring) ** 2 + (yy / (p.ring * 0.22)) ** 2;
      if (d > 1 || d < 0.62 || (d > 0.78 && d < 0.84)) continue;
      if ((yy > 0) !== front) continue;
      set(px + x, py + y, d > 0.9 ? SPACE.ringLo : SPACE.ring);
    }
  };
  ring(false);
  for (let y = -p.r; y <= p.r; y++) for (let x = -p.r; x <= p.r; x++) {
    const d = Math.hypot(x + 0.5, y + 0.5); if (d > p.r) continue;
    const band = Math.floor((y + p.r + Math.sin(x * 0.5) * 0.6) / (p.r * 0.45)) % SPACE.planet.length;
    let c = SPACE.planet[band];
    if (x + y * 0.4 < -p.r * 0.35 - th(px + x, py + y) * p.r * 0.5) c = SPACE.planetShade;
    set(px + x, py + y, c);
  }
  ring(true);

  // The ground: pale regolith with a bright rim at the horizon.
  for (let x = 0; x < W; x++) for (let y = rim(x); y < H; y++) {
    let c = y === rim(x) ? SPACE.rimHi : ramp(SPACE.ground, ((y - rim(x)) / (H - hz)) * (o.groundDepth ?? 0.85), x, y);
    if (R() < 0.02) c = SPACE.ground[Math.min(7, SPACE.ground.indexOf(c) + 1)];
    set(x, y, c);
  }
  // Craters, flattened by perspective: a lit far wall, a shadowed near wall, a bright lip.
  for (const c of o.craters ?? []) {
    const cx = Math.round(W * c.x), cy = hz + c.y, rx = c.r, ry = Math.max(1, Math.round(c.r * 0.32));
    for (let y = -ry - 1; y <= ry + 1; y++) for (let x = -rx - 1; x <= rx + 1; x++) {
      const d = (x / rx) ** 2 + (y / ry) ** 2;
      const base = get(cx + x, cy + y); if (!base || !SPACE.ground.includes(base)) continue;
      const i = SPACE.ground.indexOf(base);
      if (d < 1) set(cx + x, cy + y, SPACE.ground[Math.min(7, i + (y < 0 ? 3 : 1))]);
      else if (d < 1.5 && y > 0) set(cx + x, cy + y, SPACE.ground[Math.max(0, i - 2)]);
    }
  }
  for (const b of o.boulders ?? []) sprite(set, Math.round(W * b.x), hz + b.y, b.big ? [".AAB.", "ACCCB", "CCCDD"] : [".AB", "CCD"], { A: SPACE.ground[0], B: SPACE.ground[1], C: SPACE.ground[3], D: SPACE.ground[5] });

  // The door, then footprints walking out of its light toward the viewer.
  if (o.door) {
    meta.door = drawDoor(set, W, hz, o.door, { halo: null, spill: [SUNDOWN.saffron, "#E8C25A", "#B5A27E"] });
    const dx = W * o.door.x + 3, dy = hz + o.door.y;
    for (let t = 0.08, k = 0; t < 1; t += 0.085, k++) {
      const y = Math.round(dy + 2 + t * (H - dy - 2)), x = Math.round(dx + (o.door.trailTo - o.door.x) * W * t * t + (k % 2 ? 2 : -2) * (0.6 + t));
      set(x, y, SPACE.ground[6]); if (t > 0.4) set(x + 1, y, SPACE.ground[6]);
    }
  }
  // Our flag.
  if (o.flag) {
    const fx = Math.round(W * o.flag.x), fb = hz + o.flag.y;
    for (let y = fb - 11; y <= fb; y++) set(fx, y, SPACE.pole);
    sprite(set, fx + 1, fb - 11, ["XXXXXX", "XXXXXY", "XXXXYY", "XXXXX."], { X: SUNDOWN.saffron, Y: "#E0A21E" });
  }
  meta.stars = keepStars(buf, W, meta.stars, SPACE.stars[0]);
  return { pixels: buf, meta };
}
