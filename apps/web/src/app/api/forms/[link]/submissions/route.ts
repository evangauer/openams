import { NextResponse } from "next/server";
import { mutationOriginAllowed } from "@/lib/request-origin";
import { noStore, readLimitedBody, refuse } from "@/lib/server/hosted-request";
import { FORM_LINK, publicFormHeaders, publicFormsApi } from "@/lib/server/public-forms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const LIMIT = 300 * 1024;

/** A client's answers, from the public form page to the API. No session is read or sent. */
export async function POST(
  request: Request,
  context: { params: Promise<{ link: string }> },
) {
  const { link } = await context.params;
  if (!FORM_LINK.test(link)) return refuse(404, "This form link isn't active.");
  // The page posts to its own origin, also when it is embedded in another site's frame.
  if (!mutationOriginAllowed(request))
    return refuse(403, "Open the form from its link and try again.");
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
    return refuse(415, "Unsupported request format.");
  const api = await publicFormsApi(request);
  if (!api) return refuse(404, "This form link isn't active.");
  const body = await readLimitedBody(request, LIMIT);
  if (!body)
    return refuse(
      413,
      "Your answers are longer than this form can save. Shorten the longest ones, or send the details as a file.",
      "answers_too_long",
    );
  try {
    const upstream = await fetch(`${api}/public/forms/${link}/submissions`, {
      method: "POST",
      headers: { ...publicFormHeaders(request), "Content-Type": "application/json" },
      body: body as BodyInit,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    const headers = new Headers(noStore);
    headers.set("Content-Type", "application/json");
    const retry = upstream.headers.get("retry-after");
    if (retry) headers.set("Retry-After", retry);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return NextResponse.json(
      {
        error: "form_unavailable",
        message:
          "We couldn't confirm your response was saved. Press Send again: sending twice never saves it twice.",
      },
      { status: 503, headers: noStore },
    );
  }
}
