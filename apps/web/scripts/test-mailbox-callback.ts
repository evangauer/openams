// Exercise the actual proxy and callback together: a different CSP nonce in
// either layer silently prevents the authorization page from finishing.
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";
import { GET } from "../src/app/api/mailbox/callback/[provider]/route";

for (const provider of ["gmail", "microsoft365"]) {
  const url = `https://ams.example.test/api/mailbox/callback/${provider}?code=fictional-private-code&state=fictional-state`;
  const response = proxy(
    new NextRequest(url, {
      headers: { "x-nonce": "attacker-controlled-nonce" },
    }),
  );
  const nonce = response.headers.get("x-middleware-request-x-nonce");
  assert.ok(nonce);
  assert.notEqual(nonce, "attacker-controlled-nonce");
  const callback = await GET(
    new Request(url, { headers: { "x-nonce": nonce } }),
    {
      params: Promise.resolve({ provider }),
    },
  );
  const html = await callback.text();
  assert.equal(callback.status, 200);
  assert.equal(
    callback.headers.get("Content-Security-Policy"),
    response.headers.get("Content-Security-Policy"),
  );
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.ok(html.includes(`<style nonce="${nonce}">`));
  assert.ok(!html.includes("fictional-private-code"));
  assert.ok(!html.includes("fictional-state"));
  assert.ok(!html.includes("attacker-controlled-nonce"));
  assert.ok(html.indexOf("history.replaceState") < html.indexOf("await fetch"));
  assert.ok(
    html.includes(`fetch("/api/agency/mailboxes/authorize/${provider}"`),
  );
  assert.equal(callback.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(callback.headers.get("Cache-Control"), "no-store");
  assert.ok(
    !callback.headers.get("Content-Security-Policy")?.includes("unsafe-inline"),
  );
  assert.ok(
    !callback.headers.get("Content-Security-Policy")?.includes("https:"),
  );
}

const invalid = await GET(
  new Request("https://ams.example.test/api/mailbox/callback/unknown"),
  {
    params: Promise.resolve({ provider: "<script>" }),
  },
);
assert.equal(invalid.status, 404);
assert.equal(await invalid.text(), "Not found");
console.log(
  "Mailbox callback: both providers share the proxy nonce, scrub authorization URLs and restrict resources.",
);
