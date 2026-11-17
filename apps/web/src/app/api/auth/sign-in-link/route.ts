import { NextResponse } from "next/server";
import { z } from "zod";
import { clientAddressHeaders } from "@/lib/server/client-address";
import { firebaseApiUrl, firebaseAuthMode } from "@/lib/server/ams-context";
import {
  hostedMutationRefusal,
  noStore,
  readLimitedBody,
  refuse,
} from "@/lib/server/hosted-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z
  .object({
    email: z.string().min(3).max(254),
    phoneSetup: z.boolean().optional(),
  })
  .strict();
const Upstream = z.object({ sent: z.boolean() });

/**
 * Asks the API to email a sign-in link in the OpenAMS look (docs/hosted-identity.md).
 * `{ sent: false }` means this deployment doesn't send its own sign-in email right now,
 * and the browser asks Firebase to send its built-in one instead.
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
    return refuse(400, "Enter a valid email address.", "invalid_request");
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
    upstream = await fetch(`${url}/identity/sign-in-link`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
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
        : "The sign-in link couldn't be requested. Try again.",
      typeof failure?.error === "string" ? failure.error : "sign_in_link_failed",
    );
  }
  const result = Upstream.safeParse(value);
  if (!result.success)
    return refuse(502, "The sign-in service returned an unexpected answer.");
  return NextResponse.json({ sent: result.data.sent }, { headers: noStore });
}
