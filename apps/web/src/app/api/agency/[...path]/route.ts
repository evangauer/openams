import { NextResponse } from "next/server";
import { clientAddressHeaders } from "@/lib/server/client-address";
import { amsContext, amsPublicDemo, localAmsEnabled } from "@/lib/server/ams-context";
import { mutationOriginAllowed } from "@/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const id = "[A-Za-z0-9_-]{1,128}";
const chatThread = `chat/(team|direct/${id})`;
const readPath = new RegExp(
  `^(certificate-templates/${id}/content|certificates/${id}/email-draft|session|audit|export|records/${id}(/${id}(/revisions/[1-9][0-9]*)?)?|documents/${id}/content|${chatThread}/messages|mailboxes|mailboxes/messages|mailboxes/messages/${id}(/original)?|mailboxes/${id}/events|form-submissions/${id}/files/[a-z][a-z0-9_]{0,39}|forms/address)$`,
);
const writePath = new RegExp(
  `^(certificate-templates|certificates/${id}/prepare|commands|import/(validate|apply)|accounts/${id}/(documents|emails)|correspondence/file|reminders/process|demo/start|chat/pulse|${chatThread}/(messages|read)|mailboxes/connect|mailboxes/authorize/(gmail|microsoft365)|mailboxes/${id}/(folders|select-folder|sync|disconnect|reset)|mailboxes/messages/${id}/(file|dismiss|retry)|forms/${id}/publish|forms/address)$`,
);
async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const path = (await context.params).path.join("/");
  if (path === "demo/start" && (!localAmsEnabled() || amsPublicDemo()))
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  if (!(request.method === "GET" ? readPath : writePath).test(path))
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  if (request.method === "POST" && !mutationOriginAllowed(request))
    return NextResponse.json(
      { message: "This request did not originate from this workspace." },
      { status: 403 },
    );
  const ctx = await amsContext(request);
  if (!ctx.ok) return ctx.response;
  const headers = new Headers({
    Authorization: `Bearer ${ctx.token}`,
    Accept: "application/json",
    ...clientAddressHeaders(request),
  });
  let body: Uint8Array | undefined;
  if (request.method === "POST") {
    const binary = path.startsWith("accounts/") || path === "certificate-templates";
    // The public demo keeps no visitor files: its disk is shared scratch space.
    if (binary && amsPublicDemo())
      return NextResponse.json(
        {
          error: "demo_uploads_off",
          message: "File uploads are turned off in the public demo. Nothing was saved.",
        },
        { status: 403 },
      );
    const mediaType = request.headers.get("content-type")?.split(";")[0];
    if (
      mediaType !== (binary ? "application/octet-stream" : "application/json")
    )
      return NextResponse.json(
        { message: "Unsupported request format." },
        { status: 415 },
      );
    const limit = binary ? 20 * 1024 * 1024 : 300 * 1024;
    if (Number(request.headers.get("content-length") || 0) > limit)
      return NextResponse.json(
        { message: "This upload is too large." },
        { status: 413 },
      );
    // Uploads can be 20 MB: confirm the session, and that the agency may make changes,
    // with the API before reading any of the body, so neither a request without a valid
    // session nor one from a read-only or paused agency can make this server buffer it.
    if (binary) {
      const check = await fetch(`${ctx.url}/ams/upload-check`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          Accept: "application/json",
          ...clientAddressHeaders(request),
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      // A restricted agency (402) is not signed out: pass the API's explanation through,
      // so the workspace shows why the change was refused.
      if (check?.status === 402)
        return new Response(check.body, {
          status: 402,
          headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
        });
      // A rate-limited agency is not signed out: pass the API's explanation through.
      if (check?.status === 429)
        return new Response(check.body, {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, no-store",
            "Retry-After": check.headers.get("retry-after") || "10",
          },
        });
      // A refused membership (403) keeps the API's reason, so the workspace can tell
      // an ended membership from a role that can't upload.
      if (check?.status === 403)
        return new Response(check.body, {
          status: 403,
          headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
        });
      // Only a refused session signs the person out. The API being unreachable or
      // failing is not their session ending: nothing was read, so retrying is safe.
      if (check?.status === 401)
        return NextResponse.json(
          { error: "unauthorized", message: "Sign in again to continue." },
          { status: 401 },
        );
      if (!check || !check.ok)
        return NextResponse.json(
          {
            error: "unavailable",
            message: "The agency service is unavailable. Nothing was uploaded; try again.",
          },
          { status: 503 },
        );
    }
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > limit) {
          await reader.cancel();
          return NextResponse.json(
            { message: "This upload is too large." },
            { status: 413 },
          );
        }
        chunks.push(chunk.value);
      }
    }
    body = Buffer.concat(chunks);
    headers.set("Content-Type", mediaType);
    if (binary)
      headers.set("x-file-name", request.headers.get("x-file-name") || "");
  }
  try {
    const upstream = await fetch(
      `${ctx.url}/ams/${path}${new URL(request.url).search}`,
      {
        method: request.method,
        headers,
        body: body as BodyInit | undefined,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      },
    );
    const output = new Headers({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    for (const key of ["content-type", "content-disposition", "etag", "retry-after"]) {
      const value = upstream.headers.get(key);
      if (value) output.set(key, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: output,
    });
  } catch {
    return NextResponse.json(
      {
        message:
          "The agency service is unavailable. Your save may still be processing; retry the same action to safely check its result.",
      },
      { status: 503 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
