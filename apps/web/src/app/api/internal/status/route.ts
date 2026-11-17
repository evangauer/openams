import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only instance status (Firebase deployment only), for uptime monitoring. The API verifies the Google-signed ID token, its audience and the
 * status service account, and answers 404 when none is configured. This route forwards
 * only the bearer token.
 */
export async function GET(request: Request) {
  const apiUrl = process.env.AMS_API_URL;
  if (process.env.AMS_AUTH_MODE !== "firebase" || !apiUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl))
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  const authorization = request.headers.get("authorization");
  const headers = new Headers({ Accept: "application/json" });
  if (authorization && authorization.length <= 4096 && /^Bearer [^\s]+$/.test(authorization))
    headers.set("Authorization", authorization);
  try {
    const upstream = await fetch(`${apiUrl}/internal/status/v1`, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ message: "Status unavailable." }, { status: 503 });
  }
}
