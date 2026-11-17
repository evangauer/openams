// Builds every OpenAMS logo, icon and social image from code, so a color or layout change
// is one edit and a rebuild. Text is converted to outlines, so the SVGs render the same
// everywhere without the fonts installed.
//
//   npm --prefix brand/scripts ci
//   npm --prefix brand/scripts run build
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const brandDir = join(here, "..");

const loadFont = (pkg, file) =>
  opentype.loadSync(join(here, "node_modules/@fontsource", pkg, "files", file));
const sans600 = loadFont("instrument-sans", "instrument-sans-latin-600-normal.woff");
const sans400 = loadFont("instrument-sans", "instrument-sans-latin-400-normal.woff");
const mono500 = loadFont("jetbrains-mono", "jetbrains-mono-latin-500-normal.woff");

// Keep in sync with brand/tokens.css.
const c = {
  graphite: "#16181D",
  graphite700: "#2A2D34",
  graphite600: "#2C3038",
  bone: "#F6F5F1",
  white: "#FFFFFF",
  saffron: "#F7CC2E",
  clay: "#A7553C",
  clayLight: "#E0937C",
  slate: "#5B6170",
  slateDark: "#4E535E",
  ash: "#9BA0AA",
  mist: "#B9BBC1",
  stone: "#E6E3DC",
};

const WORDMARK_TRACKING = -0.035; // em
const CAP_HEIGHT = sans600.tables.os2.sCapHeight / sans600.unitsPerEm;
const num = (v) => +v.toFixed(2);

// Lays out a string as one outlined path. Returns the path data, pen advance and ink box.
function outline(font, str, size, { x = 0, y = 0, tracking = 0, fill } = {}) {
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(str);
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  let pen = x;
  let d = "";
  glyphs.forEach((glyph, i) => {
    const path = glyph.getPath(pen, y, size);
    d += path.toPathData(2);
    const b = path.getBoundingBox();
    if (Number.isFinite(b.x1) && b.x2 > b.x1) {
      box.x1 = Math.min(box.x1, b.x1);
      box.y1 = Math.min(box.y1, b.y1);
      box.x2 = Math.max(box.x2, b.x2);
      box.y2 = Math.max(box.y2, b.y2);
    }
    pen += glyph.advanceWidth * scale;
    if (i < glyphs.length - 1) {
      pen += font.getKerningValue(glyph, glyphs[i + 1]) * scale + tracking * size;
    }
  });
  return { d, advance: pen - x, box, svg: `<path fill="${fill}" d="${d}"/>` };
}

// Places text so its ink starts exactly at `left`.
function textAt(font, str, size, left, baseline, fill, tracking = 0) {
  const probe = outline(font, str, size, { tracking });
  const t = outline(font, str, size, { x: left - probe.box.x1, y: baseline, tracking, fill });
  return { ...t, width: t.box.x2 - t.box.x1 };
}

const wordmarkAt = (size, left, baseline, fill) =>
  textAt(sans600, "OpenAMS", size, left, baseline, fill, WORDMARK_TRACKING);

// The mark is drawn on a 64-unit grid: a rounded square, a lit doorway and the door
// swung open toward the viewer.
const DOOR = "M28.5 16 19.5 12.8V51.2L28.5 48Z";
const doorway = ({ door, light }) =>
  `<rect x="28.5" y="16" width="17" height="32" rx="1.5" fill="${light}"/>` +
  `<path d="${DOOR}" fill="${door}" stroke="${door}" stroke-width="1.5" stroke-linejoin="round"/>`;
// One color: the doorway becomes a frame and the light is the background showing through.
const doorwayMono = (ink) =>
  `<path fill="${ink}" fill-rule="evenodd" d="M28.5 16H44a1.5 1.5 0 0 1 1.5 1.5v29A1.5 1.5 0 0 1 44 48H28.5ZM31 18.5v27h12v-27Z"/>` +
  `<path d="${DOOR}" fill="${ink}" stroke="${ink}" stroke-width="1.5" stroke-linejoin="round"/>`;

const MARKS = {
  mark: { tile: c.graphite, door: c.bone, light: c.saffron },
  "mark-inverse": { tile: c.bone, door: c.graphite, light: c.saffron },
  glyph: { door: c.graphite, light: c.saffron },
  "glyph-inverse": { door: c.bone, light: c.saffron },
  "mark-mono-black": { mono: c.graphite },
  "mark-mono-white": { mono: c.white },
};
const markBody = (v) =>
  (v.tile ? `<rect width="64" height="64" rx="15" fill="${v.tile}"/>` : "") +
  (v.mono ? doorwayMono(v.mono) : doorway(v));
const placeMark = (variant, x, y, size) =>
  `<g transform="translate(${num(x)} ${num(y)}) scale(${num(size / 64)})">${markBody(MARKS[variant])}</g>`;

const GLOW =
  `<linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="${c.clay}" stop-opacity=".75"/>` +
  `<stop offset="1" stop-color="${c.clay}" stop-opacity=".12"/></linearGradient>`;

// The large doorway illustration: light spilling onto the floor as a clay glow.
function doorScene({ left, top, width, bottom, floor, door }) {
  const lean = width * 0.48;
  const rise = (bottom - top) * 0.075;
  const spread = width * 0.27;
  return (
    `<path d="M${left} ${bottom}H${left + width}L${num(left + width + spread)} ${floor}H${num(left - spread)}Z" fill="url(#glow)"/>` +
    `<rect x="${left}" y="${top}" width="${width}" height="${bottom - top}" rx="${num(width / 28)}" fill="${c.saffron}"/>` +
    `<path d="M${left} ${top} ${num(left - lean)} ${num(top - rise)}V${num(bottom + rise)}L${left} ${bottom}Z" fill="${door}"/>`
  );
}

const svgDoc = (w, h, body, { title = "OpenAMS", defs = "", viewBox } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="${viewBox ?? `0 0 ${num(w)} ${num(h)}`}" role="img" aria-label="${title}">` +
  `<title>${title}</title>${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>\n`;

const written = [];
function write(path, data) {
  const file = join(brandDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  written.push(relative(brandDir, file));
}

function render(svg, width, height = width) {
  const density = 72 * Math.max(width / parseFloat(svg.match(/width="([\d.]+)"/)[1]), 1);
  return sharp(Buffer.from(svg), { density })
    .resize(width, height)
    .png({ compressionLevel: 9, palette: true, quality: 95, effort: 10 })
    .toBuffer();
}
async function png(svg, path, width, height = width) {
  write(path, await render(svg, width, height));
}

// Logo ------------------------------------------------------------------------------------

for (const [name, variant] of Object.entries(MARKS)) {
  write(`logo/openams-${name}.svg`, svgDoc(64, 64, markBody(variant)));
}

const WM_SIZE = 100;
function wordmarkFile(fill) {
  const t = wordmarkAt(WM_SIZE, 0, WM_SIZE, fill);
  const top = t.box.y1;
  return svgDoc(t.width, t.box.y2 - top, `<g transform="translate(0 ${num(-top)})">${t.svg}</g>`);
}
write("logo/openams-wordmark.svg", wordmarkFile(c.graphite));
write("logo/openams-wordmark-inverse.svg", wordmarkFile(c.bone));

// Horizontal: the mark is 1.28x the type size and centered on the capitals.
function horizontal(markVariant, ink) {
  const m = 128;
  const baseline = m / 2 + (CAP_HEIGHT * WM_SIZE) / 2;
  const t = wordmarkAt(WM_SIZE, m + 36, baseline, ink);
  const height = Math.max(m, t.box.y2);
  return svgDoc(t.box.x2, height, placeMark(markVariant, 0, 0, m) + t.svg);
}
// Stacked: the mark sits centered above the wordmark.
function stacked(markVariant, ink) {
  const m = 160;
  const probe = wordmarkAt(WM_SIZE, 0, 0, ink);
  const width = Math.max(probe.width, m);
  const baseline = m + 36 + CAP_HEIGHT * WM_SIZE;
  const t = wordmarkAt(WM_SIZE, (width - probe.width) / 2, baseline, ink);
  return svgDoc(width, t.box.y2, placeMark(markVariant, (width - m) / 2, 0, m) + t.svg);
}
const LOCKUPS = {
  "": ["mark", c.graphite],
  "-inverse": ["mark-inverse", c.bone],
  "-mono-black": ["mark-mono-black", c.graphite],
  "-mono-white": ["mark-mono-white", c.white],
};
for (const [suffix, [mark, ink]] of Object.entries(LOCKUPS)) {
  write(`logo/openams-lockup-horizontal${suffix}.svg`, horizontal(mark, ink));
  write(`logo/openams-lockup-stacked${suffix}.svg`, stacked(mark, ink));
}

// Icons -----------------------------------------------------------------------------------

const markSvg = (size) => svgDoc(size, size, markBody(MARKS.mark), { viewBox: "0 0 64 64" });
// Full-bleed square for platforms that apply their own mask. `scale` shrinks the doorway
// inside the safe zone (maskable icons keep content within the center 80% circle).
const fullBleed = (size, scale) =>
  svgDoc(
    size,
    size,
    `<rect width="64" height="64" fill="${c.graphite}"/>` +
      `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${doorway(MARKS.mark)}</g>`,
    { viewBox: "0 0 64 64" },
  );

write("icons/favicon.svg", svgDoc(64, 64, markBody(MARKS.mark)));
const icoImages = [];
for (const size of [16, 32, 48]) icoImages.push({ size, data: await render(markSvg(size), size) });
write("icons/favicon.ico", ico(icoImages));
await png(fullBleed(180, 1), "icons/apple-touch-icon.png", 180);
await png(markSvg(192), "icons/icon-192.png", 192);
await png(markSvg(512), "icons/icon-512.png", 512);
await png(fullBleed(512, 0.8), "icons/icon-maskable-512.png", 512);
write(
  "icons/site.webmanifest",
  JSON.stringify(
    {
      name: "OpenAMS",
      short_name: "OpenAMS",
      icons: [
        { src: "icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
      theme_color: c.graphite,
      background_color: c.graphite,
      display: "standalone",
    },
    null,
    2,
  ) + "\n",
);

// A .ico file holding PNG images (supported by every current browser).
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size % 256, e);
    header.writeUInt8(size % 256, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

// README header ---------------------------------------------------------------------------

const TAGLINE = "Open-source agency management for independent agencies.";
function readmeHeader(theme) {
  const dark = theme === "dark";
  const frame = dark
    ? `<rect width="1280" height="360" rx="20" fill="${c.graphite}"/>`
    : `<rect x=".75" y=".75" width="1278.5" height="358.5" rx="19.25" fill="${c.bone}" stroke="${c.stone}" stroke-width="1.5"/>`;
  const ink = dark ? c.bone : c.graphite;
  return svgDoc(
    1280,
    360,
    frame +
      placeMark(dark ? "mark-inverse" : "mark", 96, 96, 104) +
      wordmarkAt(92, 224, 182, ink).svg +
      textAt(sans400, TAGLINE, 28, 98, 262, dark ? c.mist : c.slateDark).svg +
      doorScene({ left: 1034, top: 64, width: 112, bottom: 312, floor: 360, door: dark ? c.graphite700 : c.graphite }),
    { title: `OpenAMS. ${TAGLINE}`, defs: GLOW },
  );
}
write("readme/header-dark.svg", readmeHeader("dark"));
write("readme/header-light.svg", readmeHeader("light"));

// Social ----------------------------------------------------------------------------------

// Link-preview card: lockup, a two-line headline, a footer line and the doorway.
function card(W, H, footer, headline = ["Agency management", "you own."], live = false) {
  const pad = Math.round(W * 0.06875);
  const m = Math.round(W * 0.065);
  const wm = Math.round(m * 0.74);
  const h1 = Math.round(Math.min(H * 0.131, W * 0.0656));
  const lines = live
    ? headline
        .map(
          (line, i) =>
            `<text x="${pad}" y="${Math.round(H * (0.516 + i * 0.14))}" font-family="Instrument Sans, sans-serif" font-weight="600" font-size="${h1}" letter-spacing="${num(-0.043 * h1)}" fill="${i ? c.saffron : c.bone}">${line}</text>`,
        )
        .join("")
    : headline
        .map((line, i) => textAt(sans600, line, h1, pad, Math.round(H * (0.516 + i * 0.14)), i ? c.saffron : c.bone, -0.043).svg)
        .join("");
  const foot = live
    ? `<text x="${pad}" y="${Math.round(H * 0.875)}" font-family="JetBrains Mono, monospace" font-weight="500" font-size="${Math.round(H * 0.04)}" fill="${c.ash}">${footer}</text>`
    : textAt(mono500, footer, Math.round(H * 0.04), pad, Math.round(H * 0.875), c.ash).svg;
  const doorW = Math.round(W * 0.109);
  return svgDoc(
    W,
    H,
    `<rect width="${W}" height="${H}" fill="${c.graphite}"/>` +
      placeMark("mark-inverse", pad, pad, m) +
      wordmarkAt(wm, pad + m + Math.round(m * 0.24), pad + m / 2 + (CAP_HEIGHT * wm) / 2, c.bone).svg +
      lines +
      foot +
      doorScene({ left: W - Math.round(W * 0.211), top: Math.round(H * 0.234), width: doorW, bottom: Math.round(H * 0.875), floor: H, door: c.graphite700 }),
    { title: "OpenAMS: agency management you own", defs: GLOW },
  );
}
const preview = card(1280, 640, "github.com/evangauer/openams · AGPLv3");
write("social/github-social-preview.svg", preview);
await png(preview, "social/github-social-preview.png", 1280, 640);
const og = card(1200, 630, "Open-source agency management · AGPLv3");
write("social/og-image.svg", og);
await png(og, "social/og-image.png", 1200, 630);
write(
  "social/og-template.svg",
  card(1200, 630, "{{footer}}", ["{{title line 1}}", "{{title line 2}}"], true).replace(
    "<title>",
    "<!-- Page OG images: replace the {{…}} fields; the second title line is drawn in saffron. Needs Instrument Sans and JetBrains Mono at render time. --><title>",
  ),
);

const avatar = svgDoc(
  400,
  400,
  `<rect width="64" height="64" fill="${c.graphite}"/>` +
    `<g transform="translate(32 32) scale(.8) translate(-32 -32)">${doorway(MARKS.mark)}</g>`,
  { viewBox: "0 0 64 64" },
);
await png(avatar, "social/avatar.png", 400);

function banner(W, H, { m, wm, tag, left, door }) {
  const top = (H - m) / 2 - (tag ? tag * 1.4 : 0);
  return svgDoc(
    W,
    H,
    `<rect width="${W}" height="${H}" fill="${c.graphite}"/>` +
      placeMark("mark-inverse", left, top, m) +
      wordmarkAt(wm, left + m + Math.round(m * 0.28), top + m / 2 + (CAP_HEIGHT * wm) / 2, c.bone).svg +
      (tag ? textAt(sans400, TAGLINE, tag, left + 2, top + m + tag * 2.2, c.mist).svg : "") +
      doorScene({ ...door, door: c.graphite700 }),
    { defs: GLOW },
  );
}
await png(
  banner(1500, 500, { m: 104, wm: 92, tag: 30, left: 150, door: { left: 1180, top: 96, width: 120, bottom: 420, floor: 500 } }),
  "social/x-banner.png",
  1500,
  500,
);
await png(
  banner(1128, 191, { m: 56, wm: 50, tag: 0, left: 300, door: { left: 930, top: 36, width: 56, bottom: 160, floor: 191 } }),
  "social/linkedin-banner.png",
  1128,
  191,
);

// Works with Relay badge ------------------------------------------------------------------

function relayBadge(dark) {
  const h = 40;
  const size = 16;
  const baseline = h / 2 + (CAP_HEIGHT * size) / 2;
  const lead = textAt(sans400, "Works with", size, 46, baseline, dark ? c.ash : c.slate);
  const relay = textAt(sans600, "Relay", size, lead.box.x2 + 5, baseline, dark ? c.clayLight : c.clay);
  const w = Math.ceil(relay.box.x2 + 16);
  return svgDoc(
    w,
    h,
    `<rect x=".75" y=".75" width="${w - 1.5}" height="${h - 1.5}" rx="${(h - 1.5) / 2}" fill="${dark ? c.graphite : c.white}" stroke="${dark ? c.graphite600 : c.stone}" stroke-width="1.5"/>` +
      placeMark(dark ? "mark-inverse" : "mark", 7, 7, 26) +
      lead.svg +
      relay.svg,
    { title: "OpenAMS works with Relay" },
  );
}
write("badges/works-with-relay.svg", relayBadge(false));
write("badges/works-with-relay-inverse.svg", relayBadge(true));

// Email -----------------------------------------------------------------------------------

// Mail clients don't show SVG. Sign-in and invitation emails show this at 137×28.
await png(horizontal("mark", c.graphite), "email/openams-lockup.png", 273, 56);

console.log(written.sort().join("\n"));
