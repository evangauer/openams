import { NextResponse } from "next/server";
import { clientAddressHeaders } from "@/lib/server/client-address";
import { z } from "zod";
import {
  AMS_SESSION_COOKIE,
  firebaseApiUrl,
  firebaseAuthMode,
} from "@/lib/server/ams-context";
import {
  hostedMutationRefusal,
  noStore,
  readLimitedBody,
  refuse,
} from "@/lib/server/hosted-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const SESSION_SECONDS = 8 * 60 * 60;
const Body = z.object({ idToken: z.string().min(20).max(8192) }).strict();
const Upstream = z.object({
  sessionCookie: z.string().regex(/^[A-Za-z0-9._-]{20,8192}$/),
  expiresAt: z.string().datetime(),
});

/**
 * Exchanges a fresh Firebase ID token (from an email-link sign-in) for a server
 * session cookie. The API verifies the token and mints the cookie; this route only
 * stores it as HttpOnly, Secure, SameSite=Lax `__Host-openams_session`.
 */
export async function POST(request: Request) {
  if (!firebaseAuthMode()) return refuse(404, "Not found.");
  const refusal = hostedMutationRefusal(request);
  if (refusal) return refusal;
  const url = firebaseApiUrl();
  if (!url)
    return refuse(503, "OpenAMS sign-in is not configured for this deployment.");
  const raw = await readLimitedBody(request);
  if (!raw) return refuse(413, "This request is too large.");
  let input: z.infer<typeof Body>;
  try {
    input = Body.parse(JSON.parse(Buffer.from(raw).toString("utf8")));
  } catch {
    return refuse(400, "Sign in again to continue.", "invalid_request");
  }
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
    ...clientAddressHeaders(request),
  });
  const appCheck = request.headers.get("x-firebase-appcheck");
  if (appCheck && appCheck.length <= 4096)
    headers.set("X-Firebase-AppCheck", appCheck);
  let upstream: Response;
  try {
    upstream = await fetch(`${url}/identity/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idToken: input.idToken }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return refuse(503, "The sign-in service is unavailable. Try again.");
  }
  const value: unknown = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const failure = value as { error?: unknown; message?: unknown } | null;
    return refuse(
      upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
      typeof failure?.message === "string"
        ? failure.message
        : "Sign in again to continue.",
      typeof failure?.error === "string" ? failure.error : "unauthorized",
    );
  }
  const session = Upstream.safeParse(value);
  if (!session.success)
    return refuse(502, "The sign-in service returned an unexpected answer.");
  const maxAge = Math.min(
    SESSION_SECONDS,
    Math.floor((Date.parse(session.data.expiresAt) - Date.now()) / 1000),
  );
  if (maxAge <= 0) return refuse(401, "Sign in again to continue.", "unauthorized");
  const response = NextResponse.json(
    { ok: true, expiresAt: session.data.expiresAt },
    { headers: noStore },
  );
  response.cookies.set(AMS_SESSION_COOKIE, session.data.sessionCookie, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  return response;
}
