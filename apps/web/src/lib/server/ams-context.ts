import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { IAP_HEADER, verifyIapAssertion } from "./iap";

export const AMS_LOCAL_COOKIE = "openams_local";
/**
 * Hosted sign-in session (AMS_AUTH_MODE=firebase). `__Host-` pins it to this host,
 * Path=/ and Secure; its value is a Firebase session cookie the API verifies.
 */
export const AMS_SESSION_COOKIE = "__Host-openams_session";
/** Opt-in hosted sign-in with Firebase Auth email links. Unset keeps local evaluation. */
export function firebaseAuthMode() {
  return process.env.AMS_AUTH_MODE === "firebase";
}
/** The API is reachable only on loopback: http://127.0.0.1:<port>, nothing else. */
function loopbackApiUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value || "");
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
/** AMS_API_URL in firebase mode, validated like the local evaluation URL. */
export function firebaseApiUrl(): string | null {
  if (!firebaseAuthMode()) return null;
  const url = loopbackApiUrl(process.env.AMS_API_URL);
  return url && new URL(url).port ? url : null;
}
/**
 * The hosted preview (scripts/preview.mjs) runs the same evaluation build in production
 * mode behind Google IAP. It is on only when explicitly configured with the IAP audience.
 */
export function amsPreviewAudience() {
  return process.env.AMS_PREVIEW === "iap"
    ? process.env.AMS_PREVIEW_IAP_AUDIENCE || null
    : null;
}
/**
 * The public demo (scripts/preview.mjs with AMS_PREVIEW=public): the evaluation build
 * open to anyone, where each browser gets a private sandbox of fictional records
 * (docs/public-demo.md). It never offers the local test roles.
 */
export function amsPublicDemo() {
  return process.env.AMS_PREVIEW === "public" && !firebaseAuthMode();
}
/** A visitor's sandbox token, as stored in their cookie. */
export const AMS_SANDBOX_TOKEN = /^sbx_[a-f0-9]{64}$/;
export function localAmsEnabled() {
  // Hosted sign-in disables the local test roles and demo entirely.
  if (firebaseAuthMode()) return false;
  if (
    (process.env.NODE_ENV !== "development" && !amsPreviewAudience() && !amsPublicDemo()) ||
    process.env.AMS_LOCAL_ENABLED !== "1"
  )
    return false;
  return loopbackApiUrl(process.env.AMS_LOCAL_API_URL) !== null;
}
/** Locally: loopback only. In the hosted preview: a valid IAP assertion only. */
export async function localAmsRequestAllowed(request: Request) {
  if (!localAmsEnabled()) return false;
  // Anyone may reach the public demo; what they can open is decided by their sandbox token.
  if (amsPublicDemo()) return true;
  const audience = amsPreviewAudience();
  if (audience) {
    const result = await verifyIapAssertion(request.headers.get(IAP_HEADER), {
      audience,
    }).catch((error: unknown) => ({
      ok: false as const,
      reason: error instanceof Error ? error.message : "verification failed",
    }));
    if (!result.ok) console.warn(`Preview request refused: ${result.reason}.`);
    return result.ok;
  }
  const host = request.headers.get("host") || new URL(request.url).host;
  return (
    /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) &&
    (!request.headers.has("x-forwarded-host") ||
      request.headers.get("x-forwarded-host") === host)
  );
}
export function localAmsTokens(): Record<string, string> {
  // No local test roles in the public demo.
  if (!localAmsEnabled() || amsPublicDemo()) return {};
  try {
    const tokens = JSON.parse(process.env.AMS_LOCAL_TOKENS || "{}") as Record<
      string,
      string
    >;
    return {
      ...tokens,
      ...Object.fromEntries(
        Object.entries(tokens).map(([role, token]) => [
          `demo_${role}`,
          createHash("sha256")
            .update(`openams-demo-v1:${token}`)
            .digest("hex"),
        ]),
      ),
    };
  } catch {
    return {};
  }
}
// Local evaluation uses per-role test tokens. Hosted mode (AMS_AUTH_MODE=firebase)
// forwards the session cookie as the bearer; the API verifies it on every request.
export async function amsContext(
  request: Request,
): Promise<
  | { ok: true; url: string; token: string }
  | { ok: false; response: NextResponse }
> {
  if (firebaseAuthMode()) {
    const url = firebaseApiUrl();
    if (!url)
      return {
        ok: false,
        response: NextResponse.json(
          { message: "OpenAMS sign-in is not configured for this deployment." },
          { status: 503 },
        ),
      };
    const token = (await cookies()).get(AMS_SESSION_COOKIE)?.value;
    if (!token || !/^[A-Za-z0-9._-]{20,8192}$/.test(token))
      return {
        ok: false,
        response: NextResponse.json(
          { error: "unauthorized", message: "Sign in to continue." },
          { status: 401 },
        ),
      };
    return { ok: true, url, token };
  }
  if (!localAmsEnabled())
    return {
      ok: false,
      response: NextResponse.json(
        { message: "OpenAMS sign-in is not configured for this deployment." },
        { status: 503 },
      ),
    };
  if (!(await localAmsRequestAllowed(request)))
    return {
      ok: false,
      response: NextResponse.json(
        {
          message: amsPreviewAudience()
            ? "Sign in through the preview link."
            : "Local access requires a loopback host.",
        },
        { status: 403 },
      ),
    };
  const token = (await cookies()).get(AMS_LOCAL_COOKIE)?.value;
  if (amsPublicDemo()) {
    // The API decides whether the sandbox exists and is still alive.
    if (!token || !AMS_SANDBOX_TOKEN.test(token))
      return {
        ok: false,
        response: NextResponse.json(
          { error: "unauthorized", message: "Start the demo to continue." },
          { status: 401 },
        ),
      };
    return { ok: true, url: process.env.AMS_LOCAL_API_URL!, token };
  }
  if (!token || !Object.values(localAmsTokens()).includes(token))
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Choose a local test session." },
        { status: 401 },
      ),
    };
  return { ok: true, url: process.env.AMS_LOCAL_API_URL!, token };
}
