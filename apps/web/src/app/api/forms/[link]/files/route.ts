import { NextResponse } from "next/server";
import { AMS_FORM_UPLOAD_MAX_BYTES } from "@openams/contracts";
import { mutationOriginAllowed } from "@/lib/request-origin";
import { amsPublicDemo } from "@/lib/server/ams-context";
import { noStore, readLimitedBody, refuse } from "@/lib/server/hosted-request";
import { FORM_LINK, publicFormHeaders, publicFormsApi } from "@/lib/server/public-forms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const TOO_LARGE = "This file is larger than 10 MB. Attach a smaller copy.";

/** One file a client attaches on the public form page. No session is read or sent. */
export async function POST(
  request: Request,
  context: { params: Promise<{ link: string }> },
) {
  const { link } = await context.params;
  const submission = new URL(request.url).searchParams.get("submission") || "";
  if (!FORM_LINK.test(link) || !/^[0-9a-f-]{36}$/i.test(submission))
    return refuse(404, "This form link isn't active.");
  if (!mutationOriginAllowed(request))
    return refuse(403, "Open the form from its link and try again.");
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/octet-stream"
  )
    return refuse(415, "Unsupported request format.");
  // The public demo keeps no visitor files, and publishes no forms.
  if (amsPublicDemo()) return refuse(403, "File uploads are turned off in the demo.");
  if (Number(request.headers.get("content-length") || 0) > AMS_FORM_UPLOAD_MAX_BYTES)
    return refuse(413, TOO_LARGE, "invalid_file");
  const api = await publicFormsApi(request);
  if (!api) return refuse(404, "This form link isn't active.");
  const headers = publicFormHeaders(request);
  try {
    // Ask before reading up to 10 MB: is this form open, does it take files, and is
    // this client within its limits? A refusal costs this server nothing.
    const check = await fetch(`${api}/public/forms/${link}/upload-check`, {
      method: "POST",
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!check.ok) {
      const output = new Headers(noStore);
      output.set("Content-Type", "application/json");
      const retry = check.headers.get("retry-after");
      if (retry) output.set("Retry-After", retry);
      return new Response(check.body, { status: check.status, headers: output });
    }
    const body = await readLimitedBody(request, AMS_FORM_UPLOAD_MAX_BYTES);
    if (!body) return refuse(413, TOO_LARGE, "invalid_file");
    const upstream = await fetch(
      `${api}/public/forms/${link}/files?submission=${encodeURIComponent(submission)}`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/octet-stream",
          "x-file-name": request.headers.get("x-file-name") || "",
        },
        body: body as BodyInit,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      },
    );
    const output = new Headers(noStore);
    output.set("Content-Type", "application/json");
    return new Response(upstream.body, { status: upstream.status, headers: output });
  } catch {
    return NextResponse.json(
      {
        error: "form_unavailable",
        message: "This file didn't upload. Check your connection and attach it again.",
      },
      { status: 503, headers: noStore },
    );
  }
}
