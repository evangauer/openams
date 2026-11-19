// Country choice and as-you-type formatting for the text sign-in number field. Pure and
// dependency-free; `internationalPhone()` in auth-methods.ts stays the final validator.

/**
 * ISO 3166-1 alpha-2 region and its ITU-T E.164 calling code. Where several regions share
 * a code (+1, +7), the one listed first is chosen when a typed `+` number is recognized.
 */
export const PHONE_COUNTRIES: ReadonlyArray<readonly [iso: string, dial: string]> = [
  // North America and the Caribbean (+1 is shared)
  ["US", "1"], ["CA", "1"], ["PR", "1"], ["DO", "1"], ["JM", "1"], ["TT", "1"], ["BS", "1"],
  ["MX", "52"],
  // Central and South America
  ["GT", "502"], ["SV", "503"], ["HN", "504"], ["NI", "505"], ["CR", "506"], ["PA", "507"],
  ["AR", "54"], ["BO", "591"], ["BR", "55"], ["CL", "56"], ["CO", "57"], ["EC", "593"],
  ["PY", "595"], ["PE", "51"], ["UY", "598"], ["VE", "58"],
  // Europe
  ["GB", "44"], ["IE", "353"], ["FR", "33"], ["DE", "49"], ["ES", "34"], ["IT", "39"],
  ["PT", "351"], ["NL", "31"], ["BE", "32"], ["LU", "352"], ["CH", "41"], ["AT", "43"],
  ["SE", "46"], ["NO", "47"], ["DK", "45"], ["FI", "358"], ["IS", "354"], ["PL", "48"],
  ["CZ", "420"], ["SK", "421"], ["HU", "36"], ["RO", "40"], ["BG", "359"], ["GR", "30"],
  ["HR", "385"], ["SI", "386"], ["RS", "381"], ["EE", "372"], ["LV", "371"], ["LT", "370"],
  ["MT", "356"], ["CY", "357"], ["UA", "380"], ["TR", "90"], ["RU", "7"], ["KZ", "7"],
  // Asia and the Pacific
  ["AU", "61"], ["NZ", "64"], ["IN", "91"], ["PH", "63"], ["CN", "86"], ["JP", "81"],
  ["KR", "82"], ["HK", "852"], ["TW", "886"], ["SG", "65"], ["MY", "60"], ["TH", "66"],
  ["VN", "84"], ["ID", "62"], ["PK", "92"], ["BD", "880"], ["LK", "94"], ["NP", "977"],
  // Middle East and Africa
  ["IL", "972"], ["AE", "971"], ["SA", "966"], ["QA", "974"], ["KW", "965"], ["JO", "962"],
  ["LB", "961"], ["EG", "20"], ["MA", "212"], ["ZA", "27"], ["NG", "234"], ["GH", "233"],
  ["KE", "254"], ["ET", "251"], ["TZ", "255"], ["UG", "256"],
];

export const FALLBACK_COUNTRY = "US";
/** E.164 allows 15 digits in all; nothing longer is kept while typing. */
const MAX_DIGITS = 15;
const DIAL = new Map(PHONE_COUNTRIES.map(([iso, dial]) => [iso, dial]));

export interface PhoneCountry { iso: string; dial: string; name: string }
export interface TypedPhone { iso: string; national: string }

export function dialCode(iso: string): string {
  return DIAL.get(iso) ?? DIAL.get(FALLBACK_COUNTRY)!;
}

/** The list for a picker: named in `locale`, the United States first, the rest by name. */
export function phoneCountries(locale = "en"): PhoneCountry[] {
  let names: Intl.DisplayNames | undefined;
  try { names = new Intl.DisplayNames([locale], { type: "region" }); } catch { /* codes are shown instead */ }
  const all = PHONE_COUNTRIES.map(([iso, dial]) => ({ iso, dial, name: names?.of(iso) ?? iso }));
  const rest = all.filter(({ iso }) => iso !== FALLBACK_COUNTRY).sort((a, b) => a.name.localeCompare(b.name, locale));
  return [...all.filter(({ iso }) => iso === FALLBACK_COUNTRY), ...rest];
}

/** The browser locale's region when it is listed (`en-CA` gives CA), otherwise the United States. */
export function defaultCountry(locale: string | undefined = typeof navigator === "undefined" ? undefined : navigator.language): string {
  if (!locale) return FALLBACK_COUNTRY;
  try {
    const region = new Intl.Locale(locale).region;
    return region && DIAL.has(region) ? region : FALLBACK_COUNTRY;
  } catch { return FALLBACK_COUNTRY; }
}

const digitsOf = (value: string) => value.replace(/\D/g, "");

/**
 * A number typed with a `+` whose calling code is not listed is kept as `+` and its
 * digits, so a country missing from the picker can still be entered in full.
 */
const typedInFull = (value: string) => value.trimStart().startsWith("+");

/**
 * The national number as it should read in the field. Punctuation is only ever placed
 * between digits, never after the last one, so deleting always removes a digit.
 */
export function formatNational(iso: string, input: string): string {
  const digits = digitsOf(input).slice(0, MAX_DIGITS);
  if (typedInFull(input)) return `+${digits}`;
  if (dialCode(iso) === "1") {
    if (digits.length <= 3) return digits && `(${digits}`;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // No per-country plan: threes, with a lone last digit joining the group before it.
  const groups = digits.match(/\d{1,3}/g) ?? [];
  if (groups.length > 1 && groups[groups.length - 1].length === 1) groups.splice(-2, 2, groups.slice(-2).join(""));
  return groups.join(" ");
}

/**
 * What the field holds after the person types, pastes or autofills `raw`. A value that
 * starts with `+` chooses its country by the longest listed calling code, keeping the
 * current country when it shares that code.
 */
export function parseTyped(currentIso: string, raw: string): TypedPhone {
  const digits = digitsOf(raw).slice(0, MAX_DIGITS);
  if (typedInFull(raw)) {
    for (let length = Math.min(3, digits.length); length > 0; length -= 1) {
      const dial = digits.slice(0, length);
      const match = dialCode(currentIso) === dial && DIAL.has(currentIso)
        ? currentIso
        : PHONE_COUNTRIES.find(([, listed]) => listed === dial)?.[0];
      if (match) return { iso: match, national: digits.slice(length) };
    }
    return { iso: currentIso, national: `+${digits}` };
  }
  if (dialCode(currentIso) === "1" && digits.length === 11 && digits.startsWith("1")) return { iso: currentIso, national: digits.slice(1) };
  return { iso: currentIso, national: digits };
}

/** `+`, the calling code and the national digits, without one leading trunk `0` (Italy keeps its zero). */
export function toE164(iso: string, national: string): string {
  const digits = digitsOf(national);
  if (typedInFull(national)) return `+${digits}`;
  return `+${dialCode(iso)}${iso !== "IT" && digits.startsWith("0") ? digits.slice(1) : digits}`;
}

/** The number spaced for reading back, such as `+1 (202) 555-0123`. */
export function formatInternational(iso: string, national: string): string {
  if (typedInFull(national)) return formatNational(iso, national);
  const e164 = toE164(iso, national);
  return `+${dialCode(iso)} ${formatNational(iso, e164.slice(dialCode(iso).length + 1))}`;
}

/** An example in the country's own grouping, for the empty field. */
export function examplePlaceholder(iso: string): string {
  return formatNational(iso, dialCode(iso) === "1" ? "2025550123" : "1234567890");
}

/** Where the caret belongs in `formatted` so it stays after the same number of digits. */
export function caretAfterDigits(formatted: string, digitsBefore: number): number {
  if (digitsBefore <= 0) return formatted.search(/\d/) < 0 ? formatted.length : formatted.search(/\d/);
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/\d/.test(formatted[index]) && (seen += 1) === digitsBefore) return index + 1;
  }
  return formatted.length;
}
