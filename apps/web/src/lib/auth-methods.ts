// Non-secret runtime policy, shared by the layout and the sign-in UI.
export const SMS_SIGNIN_META = "openams-sms-signin";
export function runtimeSmsSignin(env: Record<string, string | undefined> = process.env): boolean {
  const yes = ["1", "true", "yes"];
  return yes.includes(env.AMS_SMS_SIGNIN?.trim().toLowerCase() ?? "") &&
    !env.AMS_AUTH_TENANT_ID?.trim() &&
    ![...yes, "required"].includes(env.AMS_REQUIRE_MFA?.trim().toLowerCase() ?? "");
}
export function documentSmsSignin(doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined" ? undefined : document): boolean {
  return doc?.querySelector(`meta[name="${SMS_SIGNIN_META}"]`)?.getAttribute("content") === "1";
}
export function internationalPhone(value: string): string {
  const phone = value.replace(/[ ()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Enter your mobile number with its country code, such as +1 202 555 0123.");
  return phone;
}

/** Firebase may retain the requested destination inside continueUrl. Accept only this origin's finish path. */
export function phoneSetupRequested(href: string): boolean {
  const url = new URL(href);
  if (url.searchParams.get("phone") === "add") return true;
  const nested = url.searchParams.get("continueUrl");
  if (!nested) return false;
  try {
    const destination = new URL(nested);
    return destination.origin === url.origin && destination.pathname === "/sign-in/finish" && destination.searchParams.get("phone") === "add";
  } catch { return false; }
}

/**
 * Whether this browser's last successful sign-in was by an account with a linked mobile
 * number. A yes/no flag only (never the number), used to decide whether the sign-in page
 * offers the text-message button. It is a display hint: the server alone decides whether
 * a text sign-in is accepted.
 */
export const TEXT_SIGNIN_KEY = "openams.textSignIn";
type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function browserStorage(): FlagStorage | null {
  // Reading window.localStorage can itself throw when storage is blocked.
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
export function rememberTextSignIn(linked: boolean, storage: FlagStorage | null = browserStorage()): void {
  try {
    if (linked) storage?.setItem(TEXT_SIGNIN_KEY, "1");
    else storage?.removeItem(TEXT_SIGNIN_KEY);
  } catch {
    // Storage can be unavailable; the sign-in page then offers the email link only.
  }
}
export function rememberedTextSignIn(storage: FlagStorage | null = browserStorage()): boolean {
  try { return storage?.getItem(TEXT_SIGNIN_KEY) === "1"; } catch { return false; }
}
