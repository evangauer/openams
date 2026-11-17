import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * External access control entry point (Firebase deployment, AMS_ACCESS_CONTROL=external).
 * The API verifies the Google-signed ID token, its audience and the access service
 * account, and answers 404 when access control is off. This route forwards only the
 * bearer token, the agency id and a small JSON body.
 */
const path = /^v1\/agencies\/[A-Za-z0-9_-]{1,128}$/;
const BODY_LIMIT = 4 * 1024;

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const apiUrl = process.env.AMS_API_URL;
  if (process.env.AMS_AUTH_MODE !== "firebase" || !apiUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl))
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  const target = (await context.params).path.join("/");
  if (!path.test(target)) return NextResponse.json({ message: "Not found." }, { status: 404 });
  const authorization = request.headers.get("authorization");
  const headers = new Headers({ Accept: "application/json" });
  if (authorization && authorization.length <= 4096 && /^Bearer [^\s]+$/.test(authorization))
    headers.set("Authorization", authorization);
  let body: string | undefined;
  if (request.method === "PUT") {
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      return NextResponse.json({ message: "Unsupported request format." }, { status: 415 });
    body = await request.text();
    if (body.length > BODY_LIMIT) return NextResponse.json({ message: "This request is too large." }, { status: 413 });
    headers.set("Content-Type", "application/json");
  }
  try {
    const upstream = await fetch(`${apiUrl}/internal/access/${target}`, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ message: "Access control unavailable." }, { status: 503 });
  }
}
export const GET = forward;
export const PUT = forward;
