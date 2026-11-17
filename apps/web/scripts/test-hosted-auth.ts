// Hosted sign-in mode switch and the cookie-setting auth routes, against a stub
// loopback API. Firebase itself is exercised by the API's emulator tests.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// `server-only` throws outside the React server build; resolve it to its no-op variant.
const serverOnlyEmpty = pathToFileURL(
  join(
    dirname(createRequire(import.meta.url).resolve("server-only")),
    "empty.js",
  ),
).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "server-only"
      ? { url: serverOnlyEmpty, shortCircuit: true }
      : next(specifier, context);
  },
});

const seen: { path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
const api = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    seen.push({ path: request.url || "", headers: request.headers, body });
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.body));
  });
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const port = (api.address() as { port: number }).port;

const env = process.env as Record<string, string | undefined>;
const context = await import("../src/lib/server/ams-context");
const session = await import("../src/app/api/auth/session/route");
const signInLink = await import("../src/app/api/auth/sign-in-link/route");
const identity = await import("../src/app/api/identity/[...path]/route");
const agency = await import("../src/app/api/agency/[...path]/route");
const localSession = await import("../src/app/api/agency/local-session/route");

const origin = "http://localhost:4600";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(origin + path, {
    method: "POST",
    headers: {
      host: "localhost:4600",
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (path: string) => ({
  params: Promise.resolve({ path: path.split("/") }),
});

// Local evaluation stays exactly as before when AMS_AUTH_MODE is unset.
Object.assign(env, {
  NODE_ENV: "development",
  AMS_LOCAL_ENABLED: "1",
  AMS_LOCAL_API_URL: "http://127.0.0.1:4510",
  AMS_LOCAL_TOKENS: JSON.stringify({ admin: "a".repeat(64) }),
});
delete env.AMS_AUTH_MODE;
assert.equal(context.localAmsEnabled(), true);
assert.equal(context.firebaseAuthMode(), false);
assert.equal(context.firebaseApiUrl(), null);
assert.equal((await session.POST(post("/api/auth/session", { idToken: "x".repeat(40) }))).status, 404);
assert.equal((await signInLink.POST(post("/api/auth/sign-in-link", { email: "casey@harbor-test.example" }))).status, 404);
assert.equal((await identity.GET(new Request(origin + "/api/identity/me"), params("me"))).status, 404);

// Firebase mode disables local test roles and the demo.
env.AMS_AUTH_MODE = "firebase";
env.AMS_API_URL = `http://127.0.0.1:${port}`;
assert.equal(context.localAmsEnabled(), false);
assert.equal(context.firebaseApiUrl(), `http://127.0.0.1:${port}`);
assert.equal((await localSession.POST(post("/api/agency/local-session", { role: "admin" }))).status, 404);
assert.equal((await agency.POST(post("/api/agency/demo/start", {}), params("demo/start"))).status, 404);
for (const bad of [
  "http://localhost:4510",
  "https://127.0.0.1:4510",
  "http://127.0.0.1",
  "http://user:pw@127.0.0.1:4510",
  "http://127.0.0.1:4510/api",
  "http://10.0.0.5:4510",
]) {
  env.AMS_API_URL = bad;
  assert.equal(context.firebaseApiUrl(), null, bad);
}
env.AMS_API_URL = `http://127.0.0.1:${port}`;

// Identity proxy: allowlist, origin and content type are checked before anything else.
assert.equal((await identity.GET(new Request(origin + "/api/identity/session"), params("session"))).status, 404);
assert.equal((await identity.POST(post("/api/identity/session", {}), params("session"))).status, 404);
assert.equal((await identity.POST(post("/api/identity/members/x/delete", {}), params("members/x/delete"))).status, 404);
assert.equal(
  (await identity.POST(post("/api/identity/agencies", {}, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }), params("agencies"))).status,
  403,
);
assert.equal(
  (await identity.POST(post("/api/identity/agencies", "name=x", { "content-type": "application/x-www-form-urlencoded" }), params("agencies"))).status,
  415,
);

// Session route: CSRF barriers and strict body.
assert.equal(
  (await session.POST(post("/api/auth/session", { idToken: "x".repeat(40) }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status,
  403,
);
assert.equal(
  (await session.POST(post("/api/auth/session", "idToken=x", { "content-type": "text/plain" }))).status,
  415,
);
assert.equal(
  (await session.POST(post("/api/auth/session", { idToken: "x".repeat(40), tenantId: "t" }))).status,
  400,
);
assert.equal(
  (await session.POST(post("/api/auth/session", { idToken: "x".repeat(20_000) }))).status,
  413,
);
assert.equal(seen.length, 0);

// A refused sign-in sets no cookie and passes the generic API message through.
reply = { status: 401, body: { error: "recent_sign_in_required", message: "Your sign-in link has expired. Request a new one." } };
const refused = await session.POST(post("/api/auth/session", { idToken: "i".repeat(40) }));
assert.equal(refused.status, 401);
assert.equal(refused.headers.get("set-cookie"), null);
assert.equal((await refused.json()).error, "recent_sign_in_required");

// Success: the cookie is HttpOnly, Secure, SameSite=Lax, Path=/, about 8 hours.
const sessionCookie = "header.payload.signature-fixture-value";
reply = {
  status: 200,
  body: { sessionCookie, expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() },
};
const minted = await session.POST(
  post("/api/auth/session", { idToken: "i".repeat(40) }, { "x-firebase-appcheck": "app-check-fixture" }),
);
assert.equal(minted.status, 200);
const cookie = minted.headers.get("set-cookie") || "";
assert.match(cookie, new RegExp(`^__Host-openams_session=${sessionCookie.replaceAll(".", "\\.")};`));
assert.match(cookie, /Path=\//);
assert.match(cookie, /HttpOnly/i);
assert.match(cookie, /Secure/i);
assert.match(cookie, /SameSite=lax/i);
const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
assert.ok(maxAge > 28_700 && maxAge <= 28_800, String(maxAge));
assert.equal(minted.headers.get("cache-control"), "private, no-store");
const body = await minted.json();
assert.equal(JSON.stringify(body).includes(sessionCookie), false, "cookie value never returned in the body");
const forwarded = seen.at(-1)!;
assert.equal(forwarded.path, "/identity/session");
assert.equal(forwarded.headers["x-firebase-appcheck"], "app-check-fixture");
assert.deepEqual(JSON.parse(forwarded.body), { idToken: "i".repeat(40) });

// Sign-in link route: same barriers, strict body; it forwards the request and App Check
// token, and passes back only whether the deployment sent the email itself.
assert.equal(
  (await signInLink.POST(post("/api/auth/sign-in-link", { email: "casey@harbor-test.example" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status,
  403,
);
assert.equal(
  (await signInLink.POST(post("/api/auth/sign-in-link", "email=x", { "content-type": "text/plain" }))).status,
  415,
);
assert.equal(
  (await signInLink.POST(post("/api/auth/sign-in-link", { email: "casey@harbor-test.example", continueUrl: "https://evil.example" }))).status,
  400,
);
const before = seen.length;
reply = { status: 200, body: { sent: true, extra: "dropped" } };
const linked = await signInLink.POST(
  post("/api/auth/sign-in-link", { email: "casey@harbor-test.example", phoneSetup: true }, { "x-firebase-appcheck": "app-check-fixture" }),
);
assert.equal(linked.status, 200);
assert.deepEqual(await linked.json(), { sent: true });
assert.equal(linked.headers.get("cache-control"), "private, no-store");
assert.equal(seen.length, before + 1);
assert.equal(seen.at(-1)!.path, "/identity/sign-in-link");
assert.equal(seen.at(-1)!.headers["x-firebase-appcheck"], "app-check-fixture");
assert.deepEqual(JSON.parse(seen.at(-1)!.body), { email: "casey@harbor-test.example", phoneSetup: true });
reply = { status: 200, body: { sent: false } };
assert.deepEqual(await (await signInLink.POST(post("/api/auth/sign-in-link", { email: "casey@harbor-test.example" }))).json(), { sent: false });
reply = { status: 401, body: { error: "app_check_failed", message: "This app could not be verified. Reload the page and try again." } };
const unverified = await signInLink.POST(post("/api/auth/sign-in-link", { email: "casey@harbor-test.example" }));
assert.equal(unverified.status, 401);
assert.equal((await unverified.json()).error, "app_check_failed");
reply = { status: 200, body: { sent: "yes" } };
assert.equal((await signInLink.POST(post("/api/auth/sign-in-link", { email: "casey@harbor-test.example" }))).status, 502);

api.close();
console.log("Hosted sign-in routes: mode switch, CSRF barriers, session cookie and sign-in link verified.");
