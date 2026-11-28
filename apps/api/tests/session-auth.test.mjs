// The /ams authenticator: a refused session signs the person out (401) and says why in
// the logs; Auth or Firestore failing does not (503), so the browser simply retries.
// Auth and Firestore are stand-ins here; the emulator suites cover the real ones.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SessionCache,
  sessionCacheSecondsFromEnv,
  SessionRefused,
  createFirebaseAuthenticate,
  logSessionRefused,
} from "../dist/firebase/identity.js";

const cookie = "c".repeat(40);
const decoded = { exp: Math.floor(Date.now() / 1000) + 3600, uid: "uid_casey", email: "casey@harbor-test.example", email_verified: true, firebase: { sign_in_provider: "password" } };

function authError(code) {
  return Object.assign(new Error("fixture"), { code });
}
function fakeAuth(verify) {
  return { verifySessionCookie: async () => verify(), getUser: async () => ({}) };
}
function fakeDb({ fail = false, member = { name: "Casey Lane", email: "casey@harbor-test.example", role: "admin", active: true } } = {}) {
  const doc = (path) => ({
    collection: (name) => collection(`${path}/${name}`),
    get: async () => {
      if (fail) throw new Error("firestore unavailable");
      if (path === "identity_users/uid_casey") return { exists: true, get: (field) => (field === "tenantId" ? "tenant_harbor" : undefined) };
      if (path.endsWith("/members/uid_casey")) return { exists: Boolean(member), data: () => member, get: (field) => member?.[field] };
      return { exists: false, get: () => undefined };
    },
  });
  const collection = (path) => ({ doc: (id) => doc(`${path}/${id}`), limit: () => collection(path) });
  return { collection };
}
async function call(authenticate, headers = { authorization: `Bearer ${cookie}` }) {
  const request = { header: (name) => headers[name.toLowerCase()] };
  let status = 200;
  let body = null;
  let passed = false;
  const response = {
    locals: {},
    status(code) {
      status = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };
  await authenticate(request, response, () => (passed = true));
  return { status, body, passed, actor: response.locals.amsActor, expiresAt: response.locals.amsSessionExpiresAt };
}
function captureLogs(t) {
  const lines = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (line) => lines.push(["warn", line]);
  console.error = (line) => lines.push(["error", line]);
  t.after(() => {
    console.warn = warn;
    console.error = error;
  });
  return lines;
}

test("a valid session with an active membership passes, with the stored tenant", async () => {
  const result = await call(createFirebaseAuthenticate({ auth: fakeAuth(() => decoded), db: fakeDb(), requireMfa: false, allowSms: false }));
  assert.equal(result.passed, true);
  assert.deepEqual(result.actor, { userId: "uid_casey", tenantId: "tenant_harbor", name: "Casey Lane", role: "admin" });
});

test("refused sessions are 401 and the reason is logged without identifiers", async (t) => {
  const lines = captureLogs(t);
  for (const code of ["auth/session-cookie-expired", "auth/session-cookie-revoked", "auth/argument-error", "auth/user-disabled"]) {
    const result = await call(createFirebaseAuthenticate({ auth: fakeAuth(() => { throw authError(code); }), db: fakeDb(), requireMfa: false, allowSms: false }));
    assert.equal(result.status, 401, code);
    assert.deepEqual(result.body, { error: "unauthorized", message: "Sign in again to continue." });
    assert.equal(result.passed, false);
  }
  const unverified = await call(createFirebaseAuthenticate({ auth: fakeAuth(() => ({ ...decoded, email_verified: false })), db: fakeDb(), requireMfa: false, allowSms: false }));
  assert.equal(unverified.status, 401);
  const noFactor = await call(createFirebaseAuthenticate({ auth: fakeAuth(() => decoded), db: fakeDb(), requireMfa: true }));
  assert.equal(noFactor.status, 401);
  const missing = await call(createFirebaseAuthenticate({ auth: fakeAuth(() => decoded), db: fakeDb(), requireMfa: false, allowSms: false }), {});
  assert.equal(missing.status, 401);
  const logged = lines.map(([, line]) => line).join("\n");
  for (const reason of ["auth/session-cookie-expired", "auth/session-cookie-revoked", "auth/argument-error", "auth/user-disabled", "email_unverified", "second_factor_missing", "missing_session"])
    assert.match(logged, new RegExp(`session refused: ${reason.replace("/", "\\/")}`));
  assert.doesNotMatch(logged, /uid_casey|casey@|c{40}/);
});

test("Auth being unreachable is 503, not a sign-out", async (t) => {
  captureLogs(t);
  for (const thrown of [authError("auth/internal-error"), new TypeError("fetch failed"), authError("Not A Code")]) {
    const result = await call(createFirebaseAuthenticate({ auth: fakeAuth(() => { throw thrown; }), db: fakeDb(), requireMfa: false, allowSms: false }));
    assert.equal(result.status, 503, String(thrown.code ?? thrown.message));
    assert.equal(result.body.error, "auth_unavailable");
    assert.equal(result.passed, false);
  }
});

test("a failed membership read is 503, not a sign-out; a missing or inactive one is still 403", async (t) => {
  const lines = captureLogs(t);
  const failed = await call(createFirebaseAuthenticate({ auth: fakeAuth(() => decoded), db: fakeDb({ fail: true }), requireMfa: false, allowSms: false }));
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, "unavailable");
  assert.equal(failed.passed, false);
  assert.deepEqual(lines, [["error", "OpenAMS membership lookup failed."]]);
  const inactive = await call(createFirebaseAuthenticate({ auth: fakeAuth(() => decoded), db: fakeDb({ member: { name: "Casey Lane", email: "casey@harbor-test.example", role: "admin", active: false } }), requireMfa: false, allowSms: false }));
  assert.equal(inactive.status, 403);
  assert.equal(inactive.body.error, "membership_inactive");
  const none = await call(createFirebaseAuthenticate({ auth: fakeAuth(() => decoded), db: fakeDb({ member: null }), requireMfa: false, allowSms: false }));
  assert.equal(none.status, 403);
  assert.equal(none.body.error, "agency_required");
});

test("refusal logs are summarized per reason, once a minute", (t) => {
  const lines = captureLogs(t);
  const refused = new SessionRefused("fixture-reason-a");
  logSessionRefused(refused, 1_000);
  for (let i = 0; i < 5; i++) logSessionRefused(refused, 2_000 + i);
  logSessionRefused(new SessionRefused("fixture-reason-b", true), 3_000);
  logSessionRefused(refused, 62_000);
  assert.deepEqual(lines, [
    ["warn", "OpenAMS session refused: fixture-reason-a."],
    ["error", "OpenAMS session check unavailable: fixture-reason-b."],
    ["warn", "OpenAMS session refused: fixture-reason-a (5 more since the last report)."],
  ]);
});

test("the session cache is off unless configured, and bounded", () => {
  assert.equal(sessionCacheSecondsFromEnv({}), 0);
  for (const bad of ["", "abc", "-5", "1.5", "1e3"]) assert.equal(sessionCacheSecondsFromEnv({ AMS_SESSION_CACHE_SECONDS: bad }), 0, bad);
  assert.equal(sessionCacheSecondsFromEnv({ AMS_SESSION_CACHE_SECONDS: " 60 " }), 60);
  assert.equal(sessionCacheSecondsFromEnv({ AMS_SESSION_CACHE_SECONDS: "999" }), 300);
  const off = new SessionCache(0);
  off.set(cookie, { userId: "u" }, 9e9);
  assert.equal(off.get(cookie), null);
});

test("by default every request is verified and the membership read", async () => {
  let verified = 0;
  const authenticate = createFirebaseAuthenticate({ auth: fakeAuth(() => (verified++, decoded)), db: fakeDb(), requireMfa: false, allowSms: false, sessions: new SessionCache(0) });
  for (let i = 0; i < 3; i++) assert.equal((await call(authenticate)).passed, true);
  assert.equal(verified, 3);
});

test("a remembered session skips verification until it lapses, is forgotten, or the cookie expires", async () => {
  let clock = 1_000_000_000_000;
  const sessions = new SessionCache(60, () => clock);
  let verified = 0;
  let revoked = false;
  const exp = clock / 1000 + 90;
  const auth = fakeAuth(() => {
    verified++;
    if (revoked) throw authError("auth/session-cookie-revoked");
    return { ...decoded, exp };
  });
  const authenticate = createFirebaseAuthenticate({ auth, db: fakeDb(), requireMfa: false, allowSms: false, sessions });
  const first = await call(authenticate);
  assert.equal(first.passed, true);
  assert.equal(first.expiresAt, exp);
  for (let i = 0; i < 5; i++) {
    const again = await call(authenticate);
    assert.deepEqual(again.actor, first.actor);
    assert.equal(again.expiresAt, exp);
  }
  assert.equal(verified, 1);
  // A different cookie is not the remembered one.
  await call(authenticate, { authorization: `Bearer ${"d".repeat(40)}` });
  assert.equal(verified, 2);
  // Revoked elsewhere: still trusted here until the time is up, then refused.
  revoked = true;
  clock += 59_000;
  assert.equal((await call(authenticate)).passed, true);
  clock += 2_000;
  assert.equal((await call(authenticate)).status, 401);
  // Forgetting the person applies at once on this instance.
  revoked = false;
  assert.equal((await call(authenticate)).passed, true);
  const before = verified;
  sessions.forgetUser("uid_casey");
  await call(authenticate);
  assert.equal(verified, before + 1);
  // Never trusted past the cookie's own expiry, however long the setting.
  const long = new SessionCache(300, () => clock);
  long.set(cookie, first.actor, clock / 1000 + 10);
  assert.ok(long.get(cookie));
  clock += 11_000;
  assert.equal(long.get(cookie), null);
  // A refused or member-less session is never remembered.
  const refusing = new SessionCache(60);
  await call(createFirebaseAuthenticate({ auth: fakeAuth(() => decoded), db: fakeDb({ member: null }), requireMfa: false, allowSms: false, sessions: refusing }));
  assert.equal(refusing.get(cookie), null);
});
