// When a session ends while the workspace is open: which refusals announce it, that
// they announce it once per request, and that the upload pre-check only reports a
// signed-out session when the API actually refused the session.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// `server-only` throws outside the React server build; `next/headers` needs a request
// scope. Stand in for both: the cookie jar is whatever this program puts on globalThis.
const serverOnlyEmpty = pathToFileURL(
  join(dirname(createRequire(import.meta.url).resolve("server-only")), "empty.js"),
).href;
const headersStub =
  "data:text/javascript," +
  encodeURIComponent(
    "export async function cookies(){const jar=globalThis.__testCookies||{};return{get:(name)=>name in jar?{name,value:jar[name]}:undefined};}",
  );
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: serverOnlyEmpty, shortCircuit: true };
    if (specifier === "next/headers") return { url: headersStub, shortCircuit: true };
    return next(specifier, context);
  },
});

const { request, sessionEndReason, sameActor, SESSION_ENDED_EVENT, AgencyRequestError } =
  await import("../src/features/agency/model");
const { identityRequest } = await import("../src/features/agency/identity-model");

// --- Which refusals end the session in this tab.
assert.equal(sessionEndReason(401, "unauthorized"), "signed_out");
assert.equal(sessionEndReason(401, "request_failed"), "signed_out");
assert.equal(sessionEndReason(403, "membership_inactive"), "access_ended");
assert.equal(sessionEndReason(403, "agency_required"), "access_ended");
// A role that can't do something, an access-state refusal or an outage is not an ended session.
assert.equal(sessionEndReason(403, "forbidden"), null);
assert.equal(sessionEndReason(402, "access_read_only"), null);
assert.equal(sessionEndReason(429, "rate_limited"), null);
assert.equal(sessionEndReason(503, "unavailable"), null);

assert.equal(sameActor({ userId: "u1", tenantId: "t1" }, { userId: "u1", tenantId: "t1" }), true);
assert.equal(sameActor({ userId: "u1", tenantId: "t1" }, { userId: "u2", tenantId: "t1" }), false);
assert.equal(sameActor({ userId: "u1", tenantId: "t1" }, { userId: "u1", tenantId: "t2" }), false);
assert.equal(sameActor({ userId: "u1", tenantId: "t1" }, null), false);

// --- request() and identityRequest() announce on window, then still throw.
const events: string[] = [];
const target = new EventTarget();
target.addEventListener(SESSION_ENDED_EVENT, (event) =>
  events.push((event as CustomEvent<{ reason: string }>).detail.reason),
);
(globalThis as { window?: unknown }).window = target;
let answer: { status: number; body: unknown } = { status: 200, body: {} };
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error as InstanceType<typeof AgencyRequestError>;
  }
  assert.fail("expected the request to be refused");
}
const cases: [number, unknown, string[]][] = [
  [401, { error: "unauthorized", message: "Sign in to continue." }, ["signed_out"]],
  [401, { message: "Choose a local test session." }, ["signed_out"]],
  [403, { error: "membership_inactive", message: "Your agency membership is not active." }, ["access_ended"]],
  [403, { error: "forbidden", message: "Your role can't do that." }, []],
  [402, { error: "access_read_only", message: "Read-only." }, []],
  [503, { message: "The agency service is unavailable." }, []],
];
for (const [status, body, expected] of cases) {
  events.length = 0;
  answer = { status, body };
  const error = await refusal(() => request("chat/team/messages"));
  assert.equal(error.status, status);
  assert.deepEqual(events, expected, `request ${status} ${JSON.stringify(body)}`);
}
answer = { status: 200, body: { ok: true } };
events.length = 0;
assert.deepEqual(await request("session"), { ok: true });
assert.deepEqual(events, []);

// Identity: only a refused session counts; sign-in steps have their own 401 codes.
for (const [code, expected] of [
  ["unauthorized", ["signed_out"]],
  ["mfa_required", []],
  ["recent_sign_in_required", []],
] as const) {
  events.length = 0;
  answer = { status: 401, body: { error: code, message: "…" } };
  await refusal(() => identityRequest("invitations"));
  assert.deepEqual(events, expected, `identity 401 ${code}`);
}
globalThis.fetch = realFetch;
delete (globalThis as { window?: unknown }).window;

// --- Upload pre-check: only the API refusing the session is reported as signed out.
let check: { status: number; body: unknown } | "drop" = { status: 200, body: { ok: true } };
const paths: string[] = [];
const api = createServer((incoming, response) => {
  incoming.resume();
  incoming.on("end", () => {
    paths.push(incoming.url || "");
    if (incoming.url === "/ams/upload-check") {
      if (check === "drop") {
        incoming.socket.destroy();
        return;
      }
      response.writeHead(check.status, { "content-type": "application/json" });
      response.end(JSON.stringify(check.body));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ uploaded: true }));
  });
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const port = (api.address() as { port: number }).port;
Object.assign(process.env, { AMS_AUTH_MODE: "firebase", AMS_API_URL: `http://127.0.0.1:${port}` });
(globalThis as { __testCookies?: Record<string, string> }).__testCookies = {
  "__Host-openams_session": "s".repeat(40),
};
const agency = await import("../src/app/api/agency/[...path]/route");
const origin = "http://localhost:4600";
const upload = () =>
  agency.POST(
    new Request(`${origin}/api/agency/accounts/acc_1/documents`, {
      method: "POST",
      headers: {
        host: "localhost:4600",
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/octet-stream",
        "x-file-name": "loss-runs.pdf",
      },
      body: new Uint8Array([1, 2, 3]),
    }),
    { params: Promise.resolve({ path: ["accounts", "acc_1", "documents"] }) },
  );

check = { status: 401, body: { error: "unauthorized", message: "Sign in again to continue." } };
let response = await upload();
assert.equal(response.status, 401);
assert.equal((await response.json()).error, "unauthorized");

check = { status: 403, body: { error: "membership_inactive", message: "Your agency membership is not active." } };
response = await upload();
assert.equal(response.status, 403);
assert.equal((await response.json()).error, "membership_inactive", "the API's reason passes through");

for (const failure of [{ status: 500, body: { message: "boom" } }, { status: 503, body: {} }, "drop"] as const) {
  check = failure;
  response = await upload();
  assert.equal(response.status, 503, `pre-check ${JSON.stringify(failure)} is an outage, not a sign-out`);
  assert.equal((await response.json()).error, "unavailable");
}

paths.length = 0;
check = { status: 200, body: { ok: true } };
response = await upload();
assert.equal(response.status, 200);
assert.deepEqual(paths, ["/ams/upload-check", "/ams/accounts/acc_1/documents"]);

api.close();
console.log("Session ended: refusals announce once, identity sign-in steps don't, and upload checks only sign out on a refused session.");
