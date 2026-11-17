#!/usr/bin/env node
// Verifies a deployed OpenAMS (Firebase) instance from the outside, without signing in or
// sending email. Used by docs/self-hosting.md so a person or an AI agent can prove a
// deployment is locked down instead of assuming it.
//
//   npm run verify:deployment -- https://app.example.org \
//     [--project <id> --api-key <browser key>] [--database <id>] [--bucket <name>]
//     [--expect-app-check]
//
// Exits non-zero if any check fails.

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const base = args.find((a) => /^https?:\/\//.test(a));
const project = flag("--project");
const apiKey = flag("--api-key");
const database = flag("--database") ?? "(default)";
const bucket = flag("--bucket") ?? `${project}.firebasestorage.app`;
const expectAppCheck = args.includes("--expect-app-check");
if (!base) {
  console.error(
    "Usage: npm run verify:deployment -- <https://app-url> [--project <id> --api-key <key>] [--database <id>] [--bucket <name>] [--expect-app-check]",
  );
  process.exit(2);
}
const origin = new URL(base).origin;
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};
const status = async (url, init) => (await fetch(url, { redirect: "manual", ...init })).status;

await check("Home page loads over HTTPS", async () => {
  expect(new URL(origin).protocol === "https:", "the URL must be https");
  const response = await fetch(origin + "/", { redirect: "manual" });
  expect(response.status === 200, `status ${response.status}`);
  globalThis.home = response;
  return "200";
});
await check("Security headers", async () => {
  const h = globalThis.home?.headers ?? (await fetch(origin + "/")).headers;
  const csp = h.get("content-security-policy") ?? "";
  expect(/script-src[^;]*'nonce-/.test(csp), "CSP has no script nonce");
  expect(/frame-ancestors 'none'/.test(csp), "CSP lacks frame-ancestors 'none'");
  expect((h.get("strict-transport-security") ?? "").includes("max-age="), "no HSTS");
  expect(h.get("x-content-type-options") === "nosniff", "no nosniff");
  expect(h.get("x-frame-options") === "DENY", "no X-Frame-Options DENY");
  return "CSP nonce, frame-ancestors, HSTS, nosniff, X-Frame-Options";
});
await check("Records API refuses requests without a session", async () => {
  const s = await status(origin + "/api/agency/session");
  expect(s === 401, `expected 401, got ${s}`);
  return "401";
});
await check("Identity API refuses requests without a session", async () => {
  const s = await status(origin + "/api/identity/me");
  expect(s === 401, `expected 401, got ${s}`);
  return "401";
});
await check("Cross-site writes are refused", async () => {
  const s = await status(origin + "/api/agency/commands", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: "{}",
  });
  expect(s === 403, `expected 403, got ${s}`);
  return "403";
});
await check("Scheduler endpoint is hidden from unsigned and forged tokens", async () => {
  const none = await status(origin + "/api/internal/reminders", { method: "POST" });
  const forged = await status(origin + "/api/internal/reminders", {
    method: "POST",
    headers: { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.e30.invalid" },
  });
  // Both the web route and scheduler authorization hide refusals as not found.
  // This checks anonymous access only; verify an authorized scheduled run separately.
  expect(none === 404, `expected 404 without a token, got ${none}`);
  expect(forged === 404, `expected 404 for a forged token, got ${forged}`);
  return `${none} / ${forged}`;
});
await check("Status endpoint refuses unsigned and forged tokens", async () => {
  const none = await status(origin + "/api/internal/status");
  const forged = await status(origin + "/api/internal/status", {
    headers: { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.e30.invalid" },
  });
  // Disabled endpoints and authorization refusals both answer 404.
  expect(none === 404, `expected 404 without a token, got ${none}`);
  expect(forged === 404, `expected 404 for a forged token, got ${forged}`);
  return `${none} / ${forged}`;
});
await check("Paths outside the allowlist are not proxied", async () => {
  const s = await status(origin + "/api/agency/../../internal/reminders/run");
  expect(s === 404 || s === 400 || s === 308 || s === 307, `got ${s}`);
  return String(s);
});

if (project && apiKey) {
  const referer = { referer: origin + "/" };
  await check("Browsers cannot read Firestore directly", async () => {
    const s = await status(
      `https://firestore.googleapis.com/v1/projects/${project}/databases/${encodeURIComponent(database)}/documents/tenants?key=${apiKey}`,
      { headers: referer },
    );
    expect(s === 403 || s === 401, `expected 403, got ${s}`);
    return String(s);
  });
  await check("Browsers cannot list Cloud Storage directly", async () => {
    const s = await status(
      `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o?prefix=ams-documents%2F&key=${apiKey}`,
      { headers: referer },
    );
    expect(s === 403 || s === 401, `expected 403, got ${s}`);
    return String(s);
  });
  await check("The API key is refused from other websites", async () => {
    const s = await status(
      `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", referer: "https://attacker.example/" },
        body: JSON.stringify({ identifier: "nobody@example.com", continueUri: origin }),
      },
    );
    expect(s === 403, `expected 403 (restrict the key to your domains), got ${s}`);
    return "403";
  });
  if (expectAppCheck)
    await check("Sign-in requires App Check", async () => {
      // No App Check token: an enforced project refuses this before any email is sent.
      const s = await status(
        `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${apiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...referer },
          body: JSON.stringify({ identifier: "nobody@example.com", continueUri: origin }),
        },
      );
      expect(s === 401 || s === 403, `expected 401, got ${s}`);
      return String(s);
    });
} else {
  results.push({
    name: "Firestore, Storage and API key checks",
    ok: true,
    skipped: true,
    detail: "pass --project and --api-key to run these checks",
  });
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
}
const skipped = results.filter((r) => r.skipped).length;
const passed = results.filter((r) => r.ok && !r.skipped).length;
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped groups.`);
process.exit(failed ? 1 : 0);
