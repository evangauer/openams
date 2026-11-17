import { NextResponse } from "next/server";
import { clientAddressHeaders } from "@/lib/server/client-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cloud Scheduler entry point for due reminders (Firebase deployment only). The API
 * verifies the Google-signed OIDC token, its audience and the scheduler service account;
 * this route forwards that bearer token and the client address for admission limits.
 */
export async function POST(request: Request) {
  const apiUrl = process.env.AMS_API_URL;
  if (process.env.AMS_AUTH_MODE !== "firebase" || !apiUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl))
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 4096 || !/^Bearer [^\s]+$/.test(authorization))
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  try {
    const upstream = await fetch(`${apiUrl}/internal/reminders/run`, {
      method: "POST",
      headers: { Authorization: authorization, Accept: "application/json", ...clientAddressHeaders(request) },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(280_000),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ message: "Reminder run unavailable." }, { status: 503 });
  }
}
