import { NextResponse } from "next/server";
import {
  AMS_LOCAL_COOKIE,
  amsPreviewAudience,
  amsPublicDemo,
  localAmsRequestAllowed,
  localAmsTokens,
} from "@/lib/server/ams-context";
import { mutationOriginAllowed } from "@/lib/request-origin";

export async function POST(request: Request) {
  // The public demo has no test roles to choose: visitors get a sandbox instead.
  if (amsPublicDemo() || !(await localAmsRequestAllowed(request)))
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  if (
    !mutationOriginAllowed(request) ||
    request.headers.get("content-type") !== "application/json"
  )
    return NextResponse.json({ message: "Request refused." }, { status: 403 });
  const body = await request.json().catch(() => null);
  const tokens = localAmsTokens();
  if (
    !body ||
    typeof body.role !== "string" ||
    !["admin", "manager", "member", "accountant", "viewer"].includes(
      body.role,
    ) ||
    (body.mode !== undefined && !["agency", "demo"].includes(body.mode))
  )
    return NextResponse.json(
      { message: "Choose a local role." },
      { status: 400 },
    );
  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    AMS_LOCAL_COOKIE,
    tokens[`${body.mode === "demo" ? "demo_" : ""}${body.role}`],
    {
      httpOnly: true,
      sameSite: "strict",
      // The hosted preview is served over HTTPS; local evaluation is plain HTTP.
      secure: Boolean(amsPreviewAudience()),
      path: "/api/agency",
      maxAge: 8 * 60 * 60,
    },
  );
  return response;
}
