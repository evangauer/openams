/**
 * Design takes under evaluation. The theme lives on <html data-theme> so portaled
 * dialogs pick it up too; theme stylesheets scope every rule to html[data-theme=…].
 */
export const AGENCY_THEMES = [
  { id: "openams", label: "Current" },
  { id: "portal", label: "Broker portal" },
  { id: "relay", label: "Relay" },
  // Broker portal layout in the OpenAMS brand palette (themes/brand.css).
  { id: "brand", label: "OpenAMS" },
] as const;
export type AgencyTheme = (typeof AGENCY_THEMES)[number]["id"];
/** The OpenAMS take is the design. The other takes stay in code but no longer load. */
export const DEFAULT_THEME: AgencyTheme = "brand";

export const THEME_STORAGE_KEY = "openams.theme";

/**
 * Color schemes for the OpenAMS take (themes/brand.css), on <html data-scheme>.
 * `palette` lists the scheme's colors, darkest first, for the Appearance picker.
 */
export const AGENCY_SCHEMES = [
  {
    id: "saffron",
    label: "Saffron",
    detail: "Graphite, bone and yellow",
    palette: ["#16181d", "#2e5a88", "#1f8a55", "#f7cc2e", "#fdf4d2", "#f3f1ec"],
  },
  {
    id: "dusk",
    label: "Desert dusk",
    detail: "Dusk purple, sunset orange, cactus teal",
    palette: ["#2b1838", "#6a3e9e", "#2a8a76", "#f0843a", "#fdc66b", "#f6efe8"],
  },
  {
    id: "twilight",
    label: "Twilight",
    detail: "The sun going down: purple into deep purple",
    palette: ["#24123d", "#432673", "#6b3fa0", "#8e44c4", "#f6c56b", "#f4f0f9"],
  },
  {
    id: "prairie",
    label: "Prairie",
    detail: "Field green, linen and barn red",
    palette: ["#1f2b23", "#2f6a4a", "#b4442e", "#e8b86a", "#f6e1da", "#f2f0e6"],
  },
  {
    id: "lakeshore",
    label: "Lakeshore",
    detail: "Deep navy, sand and lake blue",
    palette: ["#12263a", "#1d5288", "#2a6fb0", "#2f8a6a", "#8fc1ee", "#f3f2ee"],
  },
] as const;
export type AgencyScheme = (typeof AGENCY_SCHEMES)[number]["id"];
export const SCHEME_STORAGE_KEY = "openams.scheme";
