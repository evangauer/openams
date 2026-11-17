// Renders the sundown scenes to PNG at native pixel size, each with a JSON file saying where
// its stars, sun and door are. Display them scaled up with `image-rendering: pixelated`.
//
//   npm --prefix brand/scripts run scenes
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { drawScene, drawTumbleweed } from "./scenes.mjs";
import { drawSea, drawSpace, drawTown } from "./scenes-beyond.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "../scenes");
mkdirSync(out, { recursive: true });

// Text never sits on a scene: these are bands and vignettes placed between solid sections.
export const SCENES = {
  // Under the site hero. The middle stays quiet because a product screenshot covers it.
  "hero-band": { W: 400, H: 120, o: { seed: 14, calm: true, horizon: 0.56, sun: { x: 0.08, r: 19 }, clouds: 4,
    far: [{ x0: 0.3, x1: 0.4, h: 5 }, { x0: 0.6, x1: 0.7, h: 4 }],
    mesas: [{ x0: 0.9, x1: 1.04, h: 28, base: 4 }],
    door: { x: 0.905, y: 22, h: 20, trailTo: 0.96 }, birds: [[0.17, 0.42], [0.2, 0.36]],
    cacti: [{ x: 0.03, y: 46, h: 24, w: 4 }, { x: 0.97, y: 48, h: 18, w: 3, arms: [[-1, 0.55, 0.3]] }],
    brush: 16, groundDepth: 0.55 } },
  // A shorter band for the bottom of inner-page headers.
  "page-band": { W: 400, H: 56, o: { seed: 27, calm: true, horizon: 0.58, sun: { x: 0.14, r: 11 }, clouds: 3,
    far: [{ x0: 0.34, x1: 0.46, h: 4 }, { x0: 0.62, x1: 0.7, h: 3 }],
    mesas: [{ x0: 0.84, x1: 1.03, h: 16, base: 2 }],
    door: { x: 0.78, y: 9, h: 11, trailTo: 0.74 },
    cacti: [{ x: 0.05, y: 21, h: 13, w: 3, arms: [[1, 0.55, 0.3]] }], brush: 8, groundDepth: 0.7 } },
  // The top of sign-in and invitation emails: shown at 600×84 (2×), so it stays crisp in
  // mail clients that can't scale pixel art. email/scene-band.png is this at 4×.
  "email-band": { W: 300, H: 42, o: { seed: 27, calm: true, horizon: 0.58, sun: { x: 0.14, r: 9 }, clouds: 2,
    far: [{ x0: 0.34, x1: 0.46, h: 3 }],
    mesas: [{ x0: 0.84, x1: 1.03, h: 12, base: 2 }],
    door: { x: 0.74, y: 7, h: 9, trailTo: 0.7 },
    cacti: [{ x: 0.05, y: 16, h: 10, w: 3, arms: [[1, 0.55, 0.3]] }], brush: 6, groundDepth: 0.7 } },
  // The lone door, for a card beside "your data's yours".
  vignette: { W: 160, H: 120, o: { seed: 3, calm: true, horizon: 0.58, sun: { x: 0.3, r: 18 }, clouds: 3,
    far: [{ x0: 0.02, x1: 0.16, h: 6 }],
    mesas: [{ x0: 0.78, x1: 1.04, h: 22, base: 3 }],
    door: { x: 0.52, y: 20, h: 22, trailTo: 0.45 }, birds: [[0.6, 0.38], [0.64, 0.33]],
    cacti: [{ x: 0.12, y: 40, h: 24, w: 4 }], brush: 10, groundDepth: 0.75 } },
  // Above the footer links, with the door at center stage.
  "footer-strip": { W: 400, H: 64, o: { seed: 33, calm: true, horizon: 0.55, sun: { x: 0.8, r: 12 }, clouds: 3,
    far: [{ x0: 0.58, x1: 0.68, h: 4 }],
    mesas: [{ x0: 0.02, x1: 0.22, h: 20, base: 3 }],
    door: { x: 0.485, y: 12, h: 18, trailTo: 0.5 },
    cacti: [{ x: 0.31, y: 20, h: 14, w: 3, arms: [[1, 0.55, 0.3]] }, { x: 0.92, y: 18, h: 12, w: 3, arms: [[-1, 0.55, 0.3]] }],
    brush: 10, groundDepth: 0.9 } },
  // Through the footer's door: the same size, the door in the same place, somewhere else.
  "footer-town": { W: 400, H: 64, draw: drawTown, o: { seed: 33, calm: true, horizon: 0.55, sun: { x: 0.575, r: 10 }, clouds: 3,
    far: [{ x0: 0.52, x1: 0.64, h: 4 }], door: { x: 0.485, y: 12, h: 18, trailTo: 0.5 }, brush: 6, groundDepth: 0.9,
    rider: { x: 0.575, ridge: 4 },
    buildings: [
      { x0: 4, x1: 40, h: 19, sign: [4, 17, 29, 4], awning: 9, windows: [[4, 7, 5, 4, true], [27, 7, 5, 4, false]], door: [16, 5, 8] },
      { x0: 46, x1: 92, h: 25, sign: [10, 24, 27, 3], balcony: 13, windows: [[5, 21, 5, 4, true], [20, 21, 5, 4, false], [35, 21, 5, 4, true], [4, 8, 6, 5, true], [36, 8, 6, 5, true]], door: [20, 7, 9, "saloon"] },
      { x0: 98, x1: 120, h: 14, windows: [[4, 9, 4, 4, false]], door: [13, 5, 8] },
      { x0: 252, x1: 290, h: 22, awning: 10, windows: [[5, 17, 5, 4, true], [17, 17, 5, 4, false], [29, 17, 5, 4, true], [5, 8, 5, 5, false], [29, 8, 5, 5, true]], door: [17, 5, 9] },
      { x0: 296, x1: 324, h: 16, sign: [6, 15, 17, 5], star: true, windows: [[3, 8, 4, 4, false]], door: [18, 5, 8] },
      { x0: 330, x1: 378, h: 20, gable: 6, color: "#8E3A2C", colorLit: "#A7553C", windows: [[21, 15, 6, 3, false]], door: [17, 14, 12, "barn"] },
      { x0: 384, x1: 404, h: 17, windows: [[4, 9, 4, 4, true]] },
    ],
    towers: [{ x: 126, w: 12, legs: 9, tank: 9 }], rails: [[140, 6], [238, 6]], barrels: [94, 291] } },
  "footer-sea": { W: 400, H: 64, draw: drawSea, o: { seed: 51, horizon: 0.55, sun: { x: 0.8, r: 7 }, rays: 7,
    whale: { x: 0.14, y: 14, len: 30 }, reefs: [{ x0: 0.3, x1: 0.44, h: 6 }, { x0: 0.6, x1: 0.78, h: 5 }], groundDepth: 0.8,
    door: { x: 0.485, y: 12, h: 18, trailTo: 0.5 },
    rocks: [{ x: 0.02, y: 4, w: 14, h: 5 }, { x: 0.86, y: 6, w: 18, h: 6 }], anchor: { x: 0.64, y: 10 },
    kelp: [{ x: 0.05, y: 4, h: 30, phase: 0 }, { x: 0.075, y: 6, h: 22, phase: 1.3 }, { x: 0.27, y: 3, h: 18, phase: 2.1 }, { x: 0.74, y: 5, h: 26, phase: 0.7 }, { x: 0.93, y: 7, h: 34, phase: 2.6 }, { x: 0.955, y: 5, h: 20, phase: 1 }],
    coral: [{ x: 0.16, y: 8, h: 12 }, { x: 0.36, y: 6, h: 7, fan: true }, { x: 0.585, y: 6, h: 9 }, { x: 0.82, y: 10, h: 8, fan: true }, { x: 0.215, y: 14, h: 8 }],
    fish: [[0.33, 12, false], [0.4, 17, false], [0.68, 21, true]], school: [{ x: 0.62, y: 9, n: 9, spread: 10 }] } },
  "footer-space": { W: 400, H: 64, draw: drawSpace, o: { seed: 61, horizon: 0.55, bow: 3, nebula: { y0: 30, y1: 2, w: 7 }, starDensity: 0.12,
    earth: { x: 0.1, y: 10, r: 5 }, planet: { x: 0.82, y: 14, r: 9, ring: 18 }, groundDepth: 0.85,
    craters: [{ x: 0.12, y: 8, r: 9 }, { x: 0.3, y: 4, r: 5 }, { x: 0.7, y: 6, r: 7 }, { x: 0.88, y: 16, r: 12 }, { x: 0.2, y: 20, r: 7 }],
    boulders: [{ x: 0.06, y: 2, big: true }, { x: 0.38, y: 10 }, { x: 0.62, y: 14, big: true }, { x: 0.95, y: 5 }],
    door: { x: 0.485, y: 12, h: 18, trailTo: 0.5 }, flag: { x: 0.56, y: 10 } } },
  // The 404 page: nothing out here but cactus.
  lost: { W: 128, H: 80, o: { seed: 9, calm: true, horizon: 0.58, sun: { x: 0.5, r: 13 }, clouds: 4,
    far: [{ x0: 0.08, x1: 0.24, h: 5 }],
    cacti: [{ x: 0.2, y: 26, h: 22, w: 4 }], brush: 10, rocks: [{ x0: 0.7, x1: 1.05, h: 8 }], groundDepth: 0.7 } },
};

const rgba = (pixels, W, H) => {
  const raw = Buffer.alloc(W * H * 4);
  pixels.forEach((hex, i) => hex && raw.set([...[1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)), 255], i * 4));
  return sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png({ palette: true, compressionLevel: 9, effort: 10 });
};

for (const [name, { W, H, o, draw = drawScene }] of Object.entries(SCENES)) {
  const { pixels, meta } = draw(W, H, o);
  await rgba(pixels, W, H).toFile(join(out, `${name}.png`));
  writeFileSync(join(out, `${name}.json`), JSON.stringify(meta) + "\n");
  console.log(`scenes/${name}.png  ${W}×${H}  ${meta.stars.length} stars${meta.door ? ", door" : ""}${meta.lamps ? `, ${meta.lamps.length} lamps` : ""}${meta.bubbles ? `, ${meta.bubbles.length} bubbles` : ""}`);
}

// Mail clients scale images smoothly, so the email band ships pre-scaled with whole pixels.
mkdirSync(join(out, "../email"), { recursive: true });
await sharp(join(out, "email-band.png"))
  .resize(1200, 168, { kernel: "nearest" })
  .png({ palette: true, compressionLevel: 9, effort: 10 })
  .toFile(join(out, "../email/scene-band.png"));
console.log("email/scene-band.png  1200×168 (email-band at 4×)");

// Eight frames of a rolling tumbleweed, side by side, for a stepped sprite animation.
const T = 12, FRAMES = 8;
const strip = new Array(T * FRAMES * T).fill(null);
for (let f = 0; f < FRAMES; f++) {
  const frame = drawTumbleweed(T, (f / FRAMES) * Math.PI * 2);
  frame.forEach((c, i) => { strip[Math.floor(i / T) * T * FRAMES + f * T + (i % T)] = c; });
}
await rgba(strip, T * FRAMES, T).toFile(join(out, "tumbleweed.png"));
console.log(`scenes/tumbleweed.png  ${FRAMES} frames of ${T}×${T}`);
