import "server-only";
import { NextResponse } from "next/server";
import { mutationOriginAllowed } from "@/lib/request-origin";

/** JSON bodies on hosted identity routes are tiny; anything larger is refused. */
export const IDENTITY_BODY_LIMIT = 16 * 1024;
export const noStore = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
export const refuse = (status: number, message: string, error?: string) =>
  NextResponse.json(
    { ...(error ? { error } : {}), message },
    { status, headers: noStore },
  );

/**
 * CSRF barrier for cookie-authenticated mutations: same-origin (Origin / Sec-Fetch-Site)
 * plus a JSON content type, which an HTML form cannot send cross-site.
 */
export function hostedMutationRefusal(request: Request): NextResponse | null {
  if (!mutationOriginAllowed(request))
    return refuse(403, "This request did not originate from this workspace.");
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
    return refuse(415, "Unsupported request format.");
  return null;
}

/** Reads at most `limit` bytes; returns null when the body is larger. */
export async function readLimitedBody(
  request: Request,
  limit = IDENTITY_BODY_LIMIT,
): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") || 0) > limit) return null;
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  return Buffer.concat(chunks);
}
