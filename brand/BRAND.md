# OpenAMS brand guide

How to write about, draw and color OpenAMS. The assets live next to this file;
[`index.html`](index.html) shows them all on one page.

## Positioning

**OpenAMS is the open-source agency management system that independent P&C agencies
own: their book, their data, and software their team likes using.**

Short form, for headlines and social cards: **Agency management you own.**

The idea behind the brand is an open door with the lights on. Agencies can walk in for
free, and they can leave whenever they want with every record. That answers the
complaint we hear most about agency systems: they are expensive to leave.

### Taglines

| Line | Use |
| --- | --- |
| Agency management you own. | Primary. Site hero, social cards, the repo's About line |
| The door's open. Your data's yours. | Openness and data portability, export pages |
| Your book. Your data. Software your team actually likes using. | README and longer intros |
| Every renewal, on time. | Product pages about renewals and servicing |

## Voice and tone

Calm, plainspoken and specific. People trust us with their clients' insurance records,
so we sound like a careful colleague, not a launch event.

| Rule | Do | Don't |
| --- | --- | --- |
| Say what it does | "Every renewal has an owner and a due date." | "Supercharge your renewal workflows." |
| Claim only what we can show | "Self-hosting has no license fee." | "Trusted by thousands of agencies." |
| Stay calm about risk | "Import runs a dry run first. Nothing saves until you confirm." | "Never lose data again!" |
| Use agency words | "account, policy, renewal, producer, CSR, book" | "entities, objects, data pipeline" |
| Respect people on other systems | "Switching from another AMS? Start with a CSV import." | "Your AMS is a dinosaur." |
| Be honest about gaps | "Agency-bill accounting isn't supported yet." | "Full accounting coming soon!" |
| Keep it short | "Export your book any time." | "We believe agencies deserve the freedom to export their data whenever they choose." |

- Write short sentences in the active voice. No exclamation marks.
- "You" is the agency. "We" is the OpenAMS team.
- Never say a carrier was contacted, coverage was bound, a message was sent or money
  moved unless it actually happened.
- Use fictional names in every example, screenshot and demo. See `AGENTS.md`.

## Writing the name

Write **OpenAMS**: capital "O" and "AMS", one word. Use this casing everywhere the
product name appears, including at the start of a sentence.

| Correct | Incorrect |
| --- | --- |
| OpenAMS | openAMS, Open AMS, OpenAms, OPENAMS, open-AMS, oAMS |
| OpenAMS Cloud | OpenAMS cloud, the OpenAMS Cloud |
| `openams` (URLs, packages, repos, code) | `OpenAMS` in a URL or package name |

On first mention, in page titles and in social bios, pair the name with what it is:
"OpenAMS: open-source agency management". Never use the name alone where a reader
could mistake it for another project.

## Logo

The mark is a doorway: a lit opening with the door swung toward you, in a rounded
square. The wordmark is "OpenAMS" in Instrument Sans SemiBold, converted to outlines.
Always use the files. Don't retype the wordmark in a live font.

### Which file

| Background | Mark | Lockup |
| --- | --- | --- |
| Light (white, bone, paper) | `logo/openams-mark.svg` (dark square) | `logo/openams-lockup-horizontal.svg` |
| Dark (graphite, black, photos) | `logo/openams-mark-inverse.svg` (bone square) | `logo/openams-lockup-horizontal-inverse.svg` |
| One ink only (stamps, embroidery, fax) | `logo/openams-mark-mono-black.svg` / `-mono-white.svg` | `logo/openams-lockup-horizontal-mono-black.svg` / `-mono-white.svg` |
| Square or centered layouts | | `logo/openams-lockup-stacked*.svg` |

`logo/openams-glyph.svg` and `logo/openams-glyph-inverse.svg` are the doorway without
its square, for inline use where the square would feel heavy. Prefer the square.

### Clear space and minimum size

- Keep clear space on every side equal to **one quarter of the mark's height**. In a
  lockup, measure from the mark.
- The mark works down to **16 px** (favicon). In print, keep it at least **6 mm**.
- The horizontal lockup needs a mark at least **20 px** tall on screen, **8 mm** in
  print. Below that, use the mark alone.
- The stacked lockup needs at least **64 px** of total height on screen.

### Don't

- Recolor the door or the light, or swap their colors.
- Put the dark square on a dark background, or the bone square on a light one.
- Add shadows, outlines, gradients or the floor glow to the mark. The glow belongs to
  illustrations.
- Stretch, rotate or crop the mark, or round its square differently.
- Change the wordmark's case, weight or spacing.

## Color

Graphite and bone carry most of every surface. Saffron is the light in the doorway, so
use it like light: on buttons, highlights and the one thing you want noticed. Clay is the
glow on the floor and the color that connects us to Relay. Denim is for links and
information.

| Name | Hex | Role |
| --- | --- | --- |
| Graphite | `#16181D` | Text, dark surfaces, the mark's square |
| Graphite 700 | `#2A2D34` | The door in dark illustrations, dark borders |
| Slate | `#5B6170` | Captions and secondary text |
| Stone | `#E6E3DC` | Borders and rules |
| Bone | `#F6F5F1` | Page background, the inverse mark's square |
| Saffron | `#F7CC2E` | Brand accent: the light, primary buttons, highlights. A true yellow |
| Amber ink | `#6B5000` | Saffron-family text on light backgrounds |
| Clay | `#A7553C` | The floor glow, "Works with Relay", warm accents |
| Denim | `#2E5A88` | Links, information, focus rings |

Clay is Relay's red (`#B05A45`) with a little terracotta mixed in, a shade darker. It
sits next to Relay's palette without copying it.

### Rules

- **Saffron fills carry graphite text, never white.** Saffron text on a light
  background fails contrast. Use amber ink or graphite instead.
- **Saffron isn't a status.** Show warnings with the warning tokens plus an icon or a
  word.
- **Status never relies on color alone.** Pair success, warning and error colors with
  an icon or a label.
- Clay can be text on white or bone (5.2:1 and 4.8:1). Keep it for small accents.
- A rough balance: 60% bone and white, 30% graphite, 10% saffron. Clay and denim are
  seasoning.

### Contrast

Every text pair in `tokens.css` meets WCAG 2.2 AA in light and dark. The table below is
generated by `node brand/scripts/check-contrast.mjs --markdown`; the script exits with an
error if a pair drops below its minimum.

| Use | Pair | Minimum | Light | Dark |
| --- | --- | --- | --- | --- |
| Body text on the page | `--color-ink` on `--color-bg` | 4.5:1 | 16.28 | 16.28 |
| Body text on cards | `--color-ink` on `--color-surface` | 4.5:1 | 17.76 | 14.78 |
| Secondary text on subtle panels | `--color-ink-muted` on `--color-surface-subtle` | 4.5:1 | 8.47 | 9.33 |
| Captions and meta on the page | `--color-ink-subtle` on `--color-bg` | 4.5:1 | 5.68 | 6.77 |
| Captions and meta on cards | `--color-ink-subtle` on `--color-surface` | 4.5:1 | 6.20 | 6.15 |
| Captions on subtle panels | `--color-ink-subtle` on `--color-surface-subtle` | 4.5:1 | 5.29 | 5.77 |
| Text on inverse bars and toasts | `--color-ink-inverse` on `--color-surface-inverse` | 4.5:1 | 17.76 | 16.28 |
| Label on a saffron button | `--color-on-accent` on `--color-accent` | 4.5:1 | 11.53 | 11.53 |
| Label on a hovered saffron button | `--color-on-accent` on `--color-accent-hover` | 4.5:1 | 10.00 | 12.48 |
| Accent text on cards | `--color-accent-ink` on `--color-surface` | 4.5:1 | 7.57 | 10.84 |
| Accent text on a saffron tint | `--color-accent-ink` on `--color-accent-soft` | 4.5:1 | 6.87 | 8.83 |
| Links on the page | `--color-link` on `--color-bg` | 4.5:1 | 6.56 | 7.19 |
| Links on cards | `--color-link` on `--color-surface` | 4.5:1 | 7.16 | 6.53 |
| Info message | `--color-info` on `--color-info-soft` | 4.5:1 | 6.00 | 5.90 |
| Clay text (Works with Relay) | `--color-clay` on `--color-bg` | 4.5:1 | 4.80 | 7.30 |
| Clay text on a clay tint | `--color-clay` on `--color-clay-soft` | 4.5:1 | 4.69 | 5.84 |
| Success message | `--color-success` on `--color-success-soft` | 4.5:1 | 5.38 | 6.33 |
| Warning message | `--color-warning` on `--color-warning-soft` | 4.5:1 | 5.27 | 7.35 |
| Error message | `--color-danger` on `--color-danger-soft` | 4.5:1 | 5.61 | 6.26 |
| Error text on cards | `--color-danger` on `--color-surface` | 4.5:1 | 6.57 | 6.64 |
| Text on night sections | `--color-on-night` on `--color-night` | 4.5:1 | 15.51 | 15.51 |
| Secondary text on night sections | `--color-on-night-muted` on `--color-night` | 4.5:1 | 11.24 | 11.24 |
| Accent text on night sections | `--color-on-night-accent` on `--color-night` | 4.5:1 | 11.54 | 11.54 |
| Focus ring (non-text, 3:1) | `--color-link` on `--color-surface` | 3:1 | 7.16 | 6.53 |

## Type

| Face | Use | Weights | License |
| --- | --- | --- | --- |
| [Instrument Sans](https://github.com/Instrument/instrument-sans) | Interface, headings, display, the wordmark | 400, 500, 600 | SIL Open Font License 1.1. Copyright 2022 The Instrument Sans Project Authors |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | Policy numbers, amounts in tables, IDs, code | 400, 500 | SIL Open Font License 1.1. Copyright 2020 The JetBrains Mono Project Authors |

Both licenses allow use, embedding and redistribution, including in this AGPL project.
The font files aren't committed here. Load them from npm
(`@fontsource-variable/instrument-sans`, `@fontsource-variable/jetbrains-mono`) or
`next/font/google`, and self-host them in the app so an agency's browser makes no
third-party font requests.

- Display and large headings: SemiBold 600, tracking `-0.035em` (`--tracking-display`).
- Section headings: SemiBold 600, tracking `-0.02em` (`--tracking-heading`).
- Body: Regular 400 at 14–16 px in the app, 17–20 px on the site.
- Use mono for numbers people compare or copy: policy numbers, premiums in tables,
  dates in lists, API paths.

## The doorway scene

Large layouts (README header, social cards) use a bigger doorway as an illustration: a
saffron opening, the door in graphite (Graphite 700 on dark), and clay light spilling
onto the floor, fading from 75% to 12% opacity (`--gradient-glow`). Put it on the right
with the text on the left. Don't use it at icon sizes.

## Sundown scenes

The website's personality comes from pixel-art desert scenes at dusk: a sky banding down
from night violet to saffron, clay mesas, saguaros, and the open door standing in the
sand with its light spilling toward you. They're original art, drawn from code in
`scripts/scenes.mjs`, so a new scene is a few lines of options and a seed.

The footer's door is a small easter egg: clicking it steps through to the town, the sea
floor and the moon (`scripts/scenes-beyond.mjs`), then back to the desert. Those scenes
match the footer strip's size and put the door in exactly the same place, so only its
surroundings change. The palettes move with the setting but keep the door saffron.

| Scene | Size | Use |
| --- | --- | --- |
| `scenes/hero-band.png` | 400×120 | Under the site hero, with a product screenshot standing on the horizon |
| `scenes/page-band.png` | 400×56 | The bottom edge of inner-page headers |
| `scenes/vignette.png` | 160×120 | A card beside a statement, such as "Your data's yours" |
| `scenes/footer-strip.png` | 400×64 | Above the footer links |
| `scenes/footer-town.png` | 400×64 | Through the footer's door: a western town at sundown, a rider against the sun |
| `scenes/footer-sea.png` | 400×64 | Through the door again: the sea floor, with kelp, coral, fish and a whale far off |
| `scenes/footer-space.png` | 400×64 | And again: the moon, with Earth, a ringed planet and our flag |
| `scenes/lost.png` | 128×80 | The 404 page |
| `scenes/email-band.png` | 300×42 | The top of sign-in and invitation emails, shipped 4× as `email/scene-band.png` |
| `scenes/tumbleweed.png` | 8 × 12×12 | Sprite frames for the footer's tumbleweed |

- **Text never sits on a scene.** Scenes go between solid sections (night, bone,
  graphite, white) or in cards beside text.
- **Scale by whole numbers** (2×, 3×, 4×) with `image-rendering: pixelated`. Never
  smooth or blur them.
- **Personality on the edges, calm in the work.** Use scenes on the website, README,
  social posts, 404 and empty states, and the app's sign-in. Keep them out of the
  working screens of the app.
- Light copy can lean in ("Walk in free"). Keep product, security and pricing copy plain.

### Motion

Each scene has a JSON file beside it listing where its stars, sun and door are, so small
animations can sit exactly on its pixels: stars that brighten, an occasional shooting
star, lamplight flickering in the doorway and, in the footer, `scenes/tumbleweed.png`
(eight 12×12 frames) rolling across the sand. The town lists its lit windows (`lamps`)
so they can flicker, and the sea floor lists where bubbles rise from (`bubbles`).

- Keep it rare and small. A shooting star every few seconds, not a meteor shower.
- Animate only opacity and position, and step sprite frames rather than rotating them.
- Turn every animation off for `prefers-reduced-motion: reduce`.

| Sundown color | Hex | Where it shows up |
| --- | --- | --- |
| Night | `#211832` | The top of the sky; night sections (`--color-night`) |
| Dusk | `#432A5A` | Upper sky |
| Plum | `#813C6C` | Mid sky |
| Rose | `#CB5B62` | Low sky, cloud undersides |
| Ember | `#F19448` | Sky at the horizon |
| Mesa | `#DE8540` | Sunlit mesa faces |
| Canyon | `#55271F` | Mesa shadows |
| Sand | `#F4BE72` | Lit desert floor |
| Saguaro | `#2E5C4E` | Cactus and scrub |

## Works with Relay

OpenAMS is the system of record and works fully on its own. [Relay](https://relayins.com)
is an optional AI layer from the same team.

- Say "Works with Relay" or "Connects with Relay". Don't say "OpenAMS by Relay" or
  "Relay AMS".
- Use `badges/works-with-relay.svg` on light backgrounds and
  `badges/works-with-relay-inverse.svg` on dark. "Relay" is set in clay.
- The badge comes after the OpenAMS identity and is never larger than the OpenAMS logo.
- Refer to Relay by name. Don't put Relay's own mark inside OpenAMS assets.

## Files

| Path | What |
| --- | --- |
| `tokens.css` | CSS variables, light and dark. Names match what the web app reads |
| `tailwind-theme.css` | Tailwind CSS v4 theme that maps utilities to the tokens |
| `logo/` | Mark, glyph, wordmark and lockups: full color, inverse and one color |
| `icons/` | `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, 192/512 and maskable PNGs, `site.webmanifest` |
| `readme/` | README header (dark, used on both GitHub themes) and a light variant |
| `social/` | GitHub social preview, OG image and template, avatar, X and LinkedIn banners |
| `badges/` | "Works with Relay" badge |
| `scenes/` | Sundown pixel scenes for the website, 404 and empty states |
| `email/` | PNG lockup and sundown band for sign-in and invitation emails |
| `scripts/` | Asset build and contrast check |

`email/` holds PNGs for the emails a deployment sends (mail clients don't show SVG or
scale pixel art cleanly): the lockup at 2× and `scene-band.png`, the `email-band` scene
at 4×. The web app serves copies from `apps/web/public/brand/email/`; copy them again
after rebuilding.

### Using the tokens

```css
@import "<path>/brand/tokens.css";
html { color-scheme: light; }      /* or "light dark" to follow the system */
```

Set `data-theme="light"` or `data-theme="dark"` on any element to force a theme. For
Tailwind CSS v4, import `tailwind-theme.css` after the tokens; utilities follow the token
names (`bg-surface`, `text-ink-subtle`, `bg-accent text-on-accent`, `text-link`).

### README header

The README uses the dark header on both of GitHub's themes: the bone mark on graphite
is the strongest version of the brand. `readme/header-light.svg` is there for light
pages elsewhere.

```html
<img alt="OpenAMS: open-source agency management for independent agencies" src="brand/readme/header-dark.svg" width="100%">
```

### GitHub social preview

Upload `social/github-social-preview.png` in the repository's **Settings → General →
Social preview**. GitHub doesn't read it from the repository.

### Rebuilding the assets

Every logo, icon and social image is generated, so a color change is one edit:

```sh
npm --prefix brand/scripts ci
npm --prefix brand/scripts run build     # writes logo/, icons/, readme/, social/, badges/
npm --prefix brand/scripts run scenes    # writes scenes/
npm --prefix brand/scripts run contrast  # checks tokens.css
```

Keep the colors in `scripts/build-assets.mjs` in sync with `tokens.css`.

The app's sign-in serves copies of `scenes/vignette.png`, `scenes/lost.png`,
`scenes/page-band.png` and `logo/openams-lockup-horizontal-inverse.svg` from
`apps/web/public/brand/`. Copy them again after rebuilding.
