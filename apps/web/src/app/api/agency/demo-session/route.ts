import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  AMS_LOCAL_COOKIE,
  AMS_SANDBOX_TOKEN,
  amsPublicDemo,
  localAmsEnabled,
} from "@/lib/server/ams-context";
import { mutationOriginAllowed } from "@/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The public demo (AMS_PREVIEW=public): opens a private sandbox for this browser and
 * keeps its token in an HttpOnly cookie. Calling it again starts over with a fresh copy
 * and deletes the previous one. Everywhere else this route doesn't exist.
 */
export async function POST(request: Request) {
  if (!amsPublicDemo() || !localAmsEnabled())
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  if (
    !mutationOriginAllowed(request) ||
    request.headers.get("content-type")?.split(";")[0] !== "application/json"
  )
    return NextResponse.json({ message: "Request refused." }, { status: 403 });
  let launcher = "";
  try {
    launcher = String(JSON.parse(process.env.AMS_LOCAL_TOKENS || "{}").admin || "");
  } catch {
    // Reported below.
  }
  if (launcher.length < 40)
    return NextResponse.json({ message: "The demo isn't configured." }, { status: 503 });
  const jar = await cookies();
  const previous = jar.get(AMS_LOCAL_COOKIE)?.value;
  const token = `sbx_${randomBytes(32).toString("hex")}`;
  const upstream = await fetch(`${process.env.AMS_LOCAL_API_URL}/demo/sandboxes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${launcher}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      ...(previous && AMS_SANDBOX_TOKEN.test(previous) ? { replaces: previous } : {}),
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!upstream)
    return NextResponse.json(
      { message: "The demo couldn't be prepared. Try again." },
      { status: 503 },
    );
  const result = (await upstream.json().catch(() => ({}))) as {
    expiresAt?: string;
    error?: string;
    message?: string;
  };
  const expires = Date.parse(result.expiresAt ?? "");
  if (upstream.status !== 201 || !Number.isFinite(expires))
    return NextResponse.json(
      {
        error: result.error ?? "request_failed",
        message: result.message ?? "The demo couldn't be prepared. Try again.",
      },
      { status: upstream.status === 429 ? 429 : 503, headers: { "Cache-Control": "no-store" } },
    );
  const response = NextResponse.json(
    { expiresAt: result.expiresAt },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(AMS_LOCAL_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    // Browsers accept Secure cookies on http://localhost, so this holds when trying
    // the image on your own machine too.
    secure: true,
    path: "/api/agency",
    maxAge: Math.max(60, Math.floor((expires - Date.now()) / 1000)),
  });
  return response;
}
