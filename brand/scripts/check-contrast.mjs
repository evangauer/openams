// Checks WCAG 2.2 contrast for the text and focus pairs in brand/tokens.css, in light and
// dark. Exits 1 if any pair is below its minimum. Has no dependencies:
//
//   node brand/scripts/check-contrast.mjs            table for the terminal
//   node brand/scripts/check-contrast.mjs --markdown table for brand/BRAND.md
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../tokens.css"), "utf8");
const root = css.match(/:root\s*{([\s\S]*?)\n}/)[1].replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = Object.fromEntries(
  [...root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
);

function resolve(value, theme) {
  const pair = value.match(/^light-dark\((.+)\)$/);
  if (pair) {
    const [light, dark] = splitArgs(pair[1]);
    return resolve(theme === "light" ? light : dark, theme);
  }
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) return resolve(tokens[ref[1]], theme);
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  throw new Error(`Can't resolve ${value}`);
}
function splitArgs(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "(") depth++;
    if (args[i] === ")") depth--;
    if (args[i] === "," && depth === 0) return [args.slice(0, i).trim(), args.slice(i + 1).trim()];
  }
  throw new Error(`Expected two arguments: ${args}`);
}

const luminance = (hex) =>
  hex
    .slice(1)
    .match(/../g)
    .map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground, background, minimum, use]
const TEXT = 4.5;
const UI = 3;
const pairs = [
  ["--color-ink", "--color-bg", TEXT, "Body text on the page"],
  ["--color-ink", "--color-surface", TEXT, "Body text on cards"],
  ["--color-ink-muted", "--color-surface-subtle", TEXT, "Secondary text on subtle panels"],
  ["--color-ink-subtle", "--color-bg", TEXT, "Captions and meta on the page"],
  ["--color-ink-subtle", "--color-surface", TEXT, "Captions and meta on cards"],
  ["--color-ink-subtle", "--color-surface-subtle", TEXT, "Captions on subtle panels"],
  ["--color-ink-inverse", "--color-surface-inverse", TEXT, "Text on inverse bars and toasts"],
  ["--color-on-accent", "--color-accent", TEXT, "Label on a saffron button"],
  ["--color-on-accent", "--color-accent-hover", TEXT, "Label on a hovered saffron button"],
  ["--color-accent-ink", "--color-surface", TEXT, "Accent text on cards"],
  ["--color-accent-ink", "--color-accent-soft", TEXT, "Accent text on a saffron tint"],
  ["--color-link", "--color-bg", TEXT, "Links on the page"],
  ["--color-link", "--color-surface", TEXT, "Links on cards"],
  ["--color-info", "--color-info-soft", TEXT, "Info message"],
  ["--color-clay", "--color-bg", TEXT, "Clay text (Works with Relay)"],
  ["--color-clay", "--color-clay-soft", TEXT, "Clay text on a clay tint"],
  ["--color-success", "--color-success-soft", TEXT, "Success message"],
  ["--color-warning", "--color-warning-soft", TEXT, "Warning message"],
  ["--color-danger", "--color-danger-soft", TEXT, "Error message"],
  ["--color-danger", "--color-surface", TEXT, "Error text on cards"],
  ["--color-on-night", "--color-night", TEXT, "Text on night sections"],
  ["--color-on-night-muted", "--color-night", TEXT, "Secondary text on night sections"],
  ["--color-on-night-accent", "--color-night", TEXT, "Accent text on night sections"],
  ["--color-link", "--color-surface", UI, "Focus ring (non-text, 3:1)"],
];

const markdown = process.argv.includes("--markdown");
const rows = [];
let failures = 0;
for (const [fg, bg, min, use] of pairs) {
  const cells = ["light", "dark"].map((theme) => {
    const r = ratio(resolve(tokens[fg], theme), resolve(tokens[bg], theme));
    if (r < min) failures++;
    return `${r.toFixed(2)}${r < min ? " FAIL" : ""}`;
  });
  rows.push([use, `\`${fg}\` on \`${bg}\``, `${min}:1`, ...cells]);
}

if (markdown) {
  console.log("| Use | Pair | Minimum | Light | Dark |\n| --- | --- | --- | --- | --- |");
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
} else {
  for (const r of rows) console.log(`${r[3].padEnd(11)}${r[4].padEnd(11)}min ${r[2].padEnd(6)}${r[0]}`);
  console.log(failures ? `\n${failures} pair(s) below minimum.` : "\nAll pairs meet WCAG AA.");
}
process.exit(failures ? 1 : 0);
