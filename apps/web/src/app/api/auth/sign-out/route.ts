import { cookies } from "next/headers";
import { clientAddressHeaders } from "@/lib/server/client-address";
import { NextResponse } from "next/server";
import {
  AMS_SESSION_COOKIE,
  firebaseApiUrl,
  firebaseAuthMode,
} from "@/lib/server/ams-context";
import { hostedMutationRefusal, noStore, refuse } from "@/lib/server/hosted-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revokes the person's Firebase sessions (every device) through the API, then clears
 * the cookie. The cookie is cleared even when revocation cannot be confirmed, and the
 * answer says so.
 */
export async function POST(request: Request) {
  if (!firebaseAuthMode()) return refuse(404, "Not found.");
  const refusal = hostedMutationRefusal(request);
  if (refusal) return refusal;
  const token = (await cookies()).get(AMS_SESSION_COOKIE)?.value;
  const url = firebaseApiUrl();
  let revoked = false;
  if (token && url && /^[A-Za-z0-9._-]{20,8192}$/.test(token)) {
    try {
      const upstream = await fetch(`${url}/identity/sign-out`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...clientAddressHeaders(request),
        },
        body: "{}",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      // 401 means the session was already invalid: nothing left to revoke.
      revoked = upstream.ok || upstream.status === 401;
    } catch {
      revoked = false;
    }
  } else revoked = true;
  const response = NextResponse.json({ ok: true, revoked }, { headers: noStore });
  response.cookies.set(AMS_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
