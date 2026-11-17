import { randomBytes } from "node:crypto";
import { mailboxCallbackPolicy } from "@/lib/mailbox-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * First land on our origin, then redeem through the authenticated, origin-checked
 * BFF. This preserves the local session's SameSite=Strict cookie: an external
 * provider redirect does not carry it, but this same-origin fetch does.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  if (provider !== "gmail" && provider !== "microsoft365")
    return new Response("Not found", { status: 404 });
  // The proxy replaces this header with its own nonce and sets the same policy.
  const suppliedNonce = request.headers.get("x-nonce");
  const nonce =
    suppliedNonce && /^[A-Za-z0-9+/=]{16,128}$/.test(suppliedNonce)
      ? suppliedNonce
      : randomBytes(24).toString("base64");
  // The only interpolated values are a generated nonce and a whitelisted provider.
  // Authorization codes stay out of HTML, DOM content, subsequent URLs and referers.
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect mailbox · OpenAMS</title>
<style nonce="${nonce}">body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f5f8;color:#192b3b;font:16px system-ui,sans-serif}main{background:white;border:1px solid #dae1e7;border-radius:16px;padding:32px;max-width:440px;margin:24px}h1{font-size:24px}p{line-height:1.6}a{color:#176991}</style>
<main><h1>Connect your mailbox</h1><p id="status" role="status">Finishing authorization…</p><a href="/#inbox">Return to Incoming mail</a></main>
<script nonce="${nonce}">
const query = location.search.slice(1);
history.replaceState(null, "", location.pathname);
(async () => {
  const status = document.getElementById("status");
  try {
    if (!query || query.length > 20000) throw new Error("This authorization link is incomplete. Return to Incoming mail and connect again.");
    const response = await fetch("/api/agency/mailboxes/authorize/${provider}", {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body:JSON.stringify({query}), cache:"no-store"});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? "Sign in to this agency, then start connecting your mailbox again." : result.message || "Authorization could not finish. Return to Incoming mail and connect again.");
    location.replace("/#inbox?connected=1");
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Authorization could not finish. Return to Incoming mail and try again.";
  }
})();
</script></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": mailboxCallbackPolicy(nonce),
    },
  });
}
