import { amsContext, firebaseAuthMode } from "@/lib/server/ams-context";
import { clientAddressHeaders } from "@/lib/server/client-address";
import {
  hostedMutationRefusal,
  noStore,
  readLimitedBody,
  refuse,
} from "@/lib/server/hosted-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hosted identity proxy (AMS_AUTH_MODE=firebase only). Session minting and sign-out
// have their own routes under /api/auth because they set and clear the cookie.
const id = "[A-Za-z0-9_-]{1,128}";
const readPath = /^(me|members|invitations)$/;
const writePath = new RegExp(
  `^(agencies|access-link|invitations|invitations/accept|invitations/${id}/revoke|members/${id}/(role|deactivate|reactivate|reset-mfa))$`,
);
async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  if (!firebaseAuthMode()) return refuse(404, "Not found.");
  const path = (await context.params).path.join("/");
  if (!(request.method === "GET" ? readPath : writePath).test(path))
    return refuse(404, "Not found.");
  if (request.method === "POST") {
    const refusal = hostedMutationRefusal(request);
    if (refusal) return refusal;
  }
  const ctx = await amsContext(request);
  if (!ctx.ok) return ctx.response;
  const headers = new Headers({
    Authorization: `Bearer ${ctx.token}`,
    Accept: "application/json",
    ...clientAddressHeaders(request),
  });
  let body: Uint8Array | undefined;
  if (request.method === "POST") {
    const read = await readLimitedBody(request);
    if (!read) return refuse(413, "This request is too large.");
    body = read;
    headers.set("Content-Type", "application/json");
  }
  try {
    const upstream = await fetch(`${ctx.url}/identity/${path}`, {
      method: request.method,
      headers,
      body: body as BodyInit | undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const output = new Headers(noStore);
    const type = upstream.headers.get("content-type");
    if (type) output.set("content-type", type);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: output,
    });
  } catch {
    return refuse(
      503,
      "The sign-in service is unavailable. Retry to check whether your change was saved.",
    );
  }
}
export const GET = proxy;
export const POST = proxy;
