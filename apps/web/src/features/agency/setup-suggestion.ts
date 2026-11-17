/**
 * Suggested values for signing in and creating an agency, carried on a link into the app:
 * `/?agency=Harbor%20Agency&email=sam%40example.com` (and `&scheme=`, see theme.ts). A site
 * that introduces OpenAMS can use them so a visitor doesn't type the same thing twice.
 * They only prefill the forms; the person still reviews and submits them.
 *
 * Sign-in finishes from an emailed link, often in another tab, so the values are kept in
 * this browser's storage for a day and cleared once an agency exists.
 */
export interface SetupSuggestion {
  agencyName?: string;
  email?: string;
}

export const SETUP_SUGGESTION_KEY = "openams.setupSuggestion";
/** After creating an agency, continue to the access page once (see AccessGate). */
export const CONTINUE_ACCESS_KEY = "openams.continueAccess";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** Printable text only, trimmed and collapsed; null when nothing usable is left. */
function clean(value: string | null, max: number) {
  const text = (value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text && text.length <= max ? text : null;
}

/** Reads the suggestion from a URL's query string. Anything malformed is ignored. */
export function parseSetupSuggestion(search: string): SetupSuggestion | null {
  const params = new URLSearchParams(search);
  const agencyName = clean(params.get("agency"), 120);
  const address = clean(params.get("email"), 254)?.toLowerCase();
  const email = address && EMAIL.test(address) ? address : null;
  if (!agencyName && !email) return null;
  return { ...(agencyName ? { agencyName } : {}), ...(email ? { email } : {}) };
}

/** What to store, and what was stored: a suggestion older than a day is dropped. */
export function encodeSetupSuggestion(suggestion: SetupSuggestion, now: number) {
  return JSON.stringify({ ...suggestion, savedAt: now });
}
export function decodeSetupSuggestion(stored: string | null, now: number): SetupSuggestion | null {
  if (!stored) return null;
  try {
    const value = JSON.parse(stored) as Record<string, unknown>;
    if (typeof value.savedAt !== "number" || now - value.savedAt > MAX_AGE_MS || value.savedAt > now + 60_000)
      return null;
    const params = new URLSearchParams();
    if (typeof value.agencyName === "string") params.set("agency", value.agencyName);
    if (typeof value.email === "string") params.set("email", value.email);
    return parseSetupSuggestion(params.toString());
  } catch {
    return null;
  }
}

/** The same URL without the suggestion, so it isn't bookmarked, shared or sent as a referrer. */
export function withoutSetupSuggestion(href: string) {
  const url = new URL(href);
  url.searchParams.delete("agency");
  url.searchParams.delete("email");
  return url.toString();
}

/**
 * Browser only. Takes a suggestion from the address bar (removing it from there), keeps it
 * for the sign-in round trip, and returns the current one, if any.
 */
export function takeSetupSuggestion(): SetupSuggestion | null {
  if (typeof window === "undefined") return null;
  try {
    const fromLink = parseSetupSuggestion(window.location.search);
    if (fromLink) {
      window.localStorage.setItem(SETUP_SUGGESTION_KEY, encodeSetupSuggestion(fromLink, Date.now()));
      window.history.replaceState(window.history.state, "", withoutSetupSuggestion(window.location.href));
      return fromLink;
    }
    return decodeSetupSuggestion(window.localStorage.getItem(SETUP_SUGGESTION_KEY), Date.now());
  } catch {
    return null;
  }
}

export function clearSetupSuggestion() {
  try {
    window.localStorage.removeItem(SETUP_SUGGESTION_KEY);
  } catch {
    // Nothing was kept.
  }
}
