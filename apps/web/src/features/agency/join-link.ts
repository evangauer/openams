/**
 * An invitation link: `/join#i=<invitation id>&t=<secret>`. The part after "#" is never
 * sent to a server, so the secret stays out of request logs and Referer headers.
 *
 * The join page reads the link, removes it from the address bar at once, and keeps it
 * here for the sign-in round trip. Sign-in finishes from an emailed link that usually
 * opens in a new tab, so the link is kept in this browser's storage, for an hour at
 * most, and cleared as soon as the invitation is accepted or declined, or the person
 * signs out. On its own the secret can't accept anything: the invited email address
 * must also be signed in.
 */
export interface JoinLink {
  invitationId: string;
  token: string;
}

export const JOIN_LINK_KEY = "openams.joinLink";
const MAX_AGE_MS = 60 * 60 * 1000;
const INVITATION_ID = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function valid(invitationId: unknown, token: unknown): JoinLink | null {
  return typeof invitationId === "string" &&
    typeof token === "string" &&
    INVITATION_ID.test(invitationId) &&
    TOKEN.test(token)
    ? { invitationId, token }
    : null;
}

/** Reads an invitation link from a URL's fragment ("#i=…&t=…"). Anything malformed is ignored. */
export function parseJoinLink(hash: string): JoinLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return valid(params.get("i"), params.get("t"));
}

export function encodeJoinLink(link: JoinLink, now: number) {
  return JSON.stringify({ ...link, savedAt: now });
}
export function decodeJoinLink(stored: string | null, now: number): JoinLink | null {
  if (!stored) return null;
  try {
    const value = JSON.parse(stored) as Record<string, unknown>;
    if (typeof value.savedAt !== "number" || now - value.savedAt > MAX_AGE_MS || value.savedAt > now + 60_000)
      return null;
    return valid(value.invitationId, value.token);
  } catch {
    return null;
  }
}

/** The same URL without its fragment, so the link isn't left in the address bar or history. */
export function withoutJoinLink(href: string) {
  const url = new URL(href);
  url.hash = "";
  return url.toString();
}

/**
 * Browser only. Takes an invitation link from the address bar (removing it from there),
 * keeps it for the sign-in round trip, and returns the current one, if any.
 */
export function takeJoinLink(): JoinLink | null {
  if (typeof window === "undefined") return null;
  try {
    const fromLink = parseJoinLink(window.location.hash);
    if (window.location.hash)
      window.history.replaceState(window.history.state, "", withoutJoinLink(window.location.href));
    if (fromLink) {
      window.localStorage.setItem(JOIN_LINK_KEY, encodeJoinLink(fromLink, Date.now()));
      return fromLink;
    }
    const kept = decodeJoinLink(window.localStorage.getItem(JOIN_LINK_KEY), Date.now());
    if (!kept) window.localStorage.removeItem(JOIN_LINK_KEY);
    return kept;
  } catch {
    return null;
  }
}

/** True when an invitation link is waiting for sign-in to finish (does not take it). */
export function hasJoinLink(): boolean {
  try {
    return decodeJoinLink(window.localStorage.getItem(JOIN_LINK_KEY), Date.now()) !== null;
  } catch {
    return false;
  }
}

export function clearJoinLink() {
  try {
    window.localStorage.removeItem(JOIN_LINK_KEY);
  } catch {
    // Nothing was kept.
  }
}
