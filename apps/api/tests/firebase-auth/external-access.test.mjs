// External access control (AMS_ACCESS_CONTROL=external) against the Firebase Auth and
// Firestore emulators: per-agency states enforced on /ams, set only by the configured
// service account, audited in the agency's own trail, and a signed link for agency
// administrators. Run with `npm run test:firebase-auth --workspace @openams/api`. All
// people and agencies here are fictional.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import {
  createFirebaseAuthenticate,
  createIdentityRouter,
  firestoreMembers,
  firestoreTimeZone,
  firestoreWorkspaceName,
} from "../../dist/firebase/identity.js";
import { createAccessApi, createAccessControl, externalAccessFromEnv } from "../../dist/firebase/external-access.js";
import { createSchedulerAuthorization } from "../../dist/firebase/scheduler.js";
import { createAmsRouter } from "../../dist/routes.js";
import { FirestoreMailboxStore } from "../../dist/mailbox-store.js";
import { SqliteAmsRepository } from "../../dist/sqlite-repository.js";
import { LocalAmsFiles } from "../../dist/files.js";

const PROJECT = "demo-openams-auth";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FIRESTORE_HOST)
  throw new Error("Run these tests through `npm run test:firebase-auth` (Firebase emulators).");

const ACCESS_ACCOUNT = "access-controller@fixture-project.iam.gserviceaccount.com";
const APP_ORIGIN = "https://ams.fixture.example";
const AUDIENCE = `${APP_ORIGIN}/api/internal/access`;
const ACCESS_URL = "https://accounts.fixture.example/start";
const SECRET = "fixture-link-secret-".padEnd(48, "x");
const tokens = {
  controller: { email: ACCESS_ACCOUNT, email_verified: true, iss: "https://accounts.google.com" },
  stranger: { email: "someone-else@fixture-project.iam.gserviceaccount.com", email_verified: true, iss: "https://accounts.google.com" },
};
const verifier = {
  async verifyIdToken({ idToken, audience }) {
    if (audience !== AUDIENCE || !tokens[idToken]) throw new Error("invalid token");
    return { getPayload: () => tokens[idToken] };
  },
};
let app, server, url, dir, repository;
// A stand-in for the SMTP sender: records what would have been sent.
const sentMail = [];
let mailFails = false;

before(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  app = initializeApp({ projectId: PROJECT }, `access-test-${randomUUID()}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  dir = await mkdtemp(join(tmpdir(), "ams-access-"));
  repository = new SqliteAmsRepository(join(dir, "agency.sqlite"));
  const control = createAccessControl({ db, enabled: true, actor: (response) => response.locals.amsActor });
  const web = express();
  web.use(express.json({ limit: "300kb" }));
  web.use(
    createIdentityRouter({
      auth,
      db,
      signup: "open",
      access: { view: control.access, link: { appOrigin: APP_ORIGIN, url: ACCESS_URL, secret: SECRET } },
      agencyInvitationTtlHours: control.invitationTtlHours,
      invitationMail: async (message) => {
        if (mailFails) throw new Error("smtp unavailable");
        sentMail.push(message);
      },
    }),
  );
  web.use(
    createAccessApi({
      db,
      enabled: true,
      authorize: createSchedulerAuthorization({ serviceAccount: ACCESS_ACCOUNT, audience: AUDIENCE, client: verifier, errorCode: "access_denied" }),
      onChange: control.forget,
    }),
  );
  const authenticate = createFirebaseAuthenticate({ auth, db });
  web.use(
    createAmsRouter({
      authenticate: (request, response, next) =>
        authenticate(request, response, (error) => (error ? next(error) : control.gate(request, response, next))),
      actor: (request) => request.res.locals.amsActor,
      enabled: async () => true,
      repository: () => repository,
      files: new LocalAmsFiles(join(dir, "files")),
      members: firestoreMembers(db),
      workspaceName: firestoreWorkspaceName(db),
      timeZone: firestoreTimeZone(db),
      mailboxes: { store: new FirestoreMailboxStore(db) },
    }),
  );
  server = web.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  repository.close();
  await deleteApp(app);
  await rm(dir, { recursive: true, force: true });
});

const db = () => getFirestore(app);
async function authRest(method, body) {
  const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/${method}?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
async function signIn(email) {
  await authRest("accounts:sendOobCode", { requestType: "EMAIL_SIGNIN", email, continueUrl: "http://localhost/sign-in/finish", canHandleCodeInApp: true });
  const { oobCodes } = await (await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  const code = oobCodes.filter((c) => c.email === email && c.requestType === "EMAIL_SIGNIN").at(-1);
  const { idToken, localId } = await authRest("accounts:signInWithEmailLink", { email, oobCode: code.oobCode });
  const response = await fetch(url + "/identity/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }) });
  const session = await response.json();
  assert.equal(response.status, 200, JSON.stringify(session));
  return { uid: localId, cookie: session.sessionCookie };
}
const call = (path, { cookie, body, method, bearer } = {}) =>
  fetch(url + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { authorization: `Bearer ${cookie}` } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function json(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
const setAccess = (tenantId, body, bearer = "controller") => call(`/internal/access/v1/agencies/${tenantId}`, { method: "PUT", body, bearer });
const newAccount = () => ({ id: randomUUID(), kind: "accounts", action: "create", data: { name: "Fixture Bakery LLC" }, reason: "Fixture" });

const people = {};

test("a new agency waits, pending, until it is activated", async () => {
  people.avery = await signIn("avery.admin@harbor-test.example");
  const { membership } = await json(
    await call("/identity/agencies", { cookie: people.avery.cookie, body: { name: "Harbor Test Agency", timeZone: "America/Chicago" } }),
    201,
  );
  people.avery.tenantId = membership.tenantId;
  const me = await json(await call("/identity/me", { cookie: people.avery.cookie }), 200);
  assert.deepEqual(me.access, { state: "pending", message: null });
  assert.equal((await json(await call("/ams/session", { cookie: people.avery.cookie }), 402)).error, "access_pending");
});

test("an agency that isn't active records invitations but sends no email", async () => {
  const result = await json(
    await call("/identity/invitations", { cookie: people.avery.cookie, body: { email: "pat.pending@harbor-test.example", role: "member" } }),
    201,
  );
  assert.equal(result.emailed, false);
  assert.equal(result.invitation.status, "pending");
  assert.equal(sentMail.length, 0);
});

test("only the configured service account can read or set access", async () => {
  const id = people.avery.tenantId;
  assert.equal((await setAccess(id, { state: "active" }, null)).status, 404);
  assert.equal((await setAccess(id, { state: "active" }, "stranger")).status, 404);
  assert.equal((await setAccess(id, { state: "free_forever" })).status, 400);
  assert.equal((await setAccess(id, { state: "active", tenantId: "other" })).status, 400);
  assert.equal((await setAccess("agency_doesNotExist0000000000", { state: "active" })).status, 404);
  assert.deepEqual(await json(await call(`/internal/access/v1/agencies/${id}`, { bearer: "controller" }), 200), { tenantId: id, state: "pending", message: null, invitationTtlHours: null });
});

test("active, read-only and suspended are enforced on every request", async () => {
  const id = people.avery.tenantId;
  await json(await setAccess(id, { state: "active", message: "Trial ends in 14 days." }), 200);
  assert.deepEqual((await json(await call("/identity/me", { cookie: people.avery.cookie }), 200)).access, { state: "active", message: "Trial ends in 14 days." });
  await json(await call("/ams/commands", { cookie: people.avery.cookie, body: newAccount() }), 200);
  // The upload pre-check (the web proxy calls it before reading a file) passes when active...
  await json(await call("/ams/upload-check", { cookie: people.avery.cookie, body: {} }), 200);

  await json(await setAccess(id, { state: "read_only", message: null }), 200);
  // ...and is refused like any change when read-only, before any upload is read.
  assert.equal((await json(await call("/ams/upload-check", { cookie: people.avery.cookie, body: {} }), 402)).error, "access_read_only");
  assert.equal((await call("/ams/session", { cookie: people.avery.cookie })).status, 200);
  assert.equal((await call("/ams/records/accounts", { cookie: people.avery.cookie })).status, 200);
  assert.equal((await json(await call("/ams/commands", { cookie: people.avery.cookie, body: newAccount() }), 402)).error, "access_read_only");

  await json(await setAccess(id, { state: "suspended" }), 200);
  assert.equal((await json(await call("/ams/records/accounts", { cookie: people.avery.cookie }), 402)).error, "access_suspended");

  await json(await setAccess(id, { state: "active" }), 200);
  assert.equal((await call("/ams/records/accounts", { cookie: people.avery.cookie })).status, 200);

  // Each change is in the agency's own audit trail.
  const entries = (await db().collection("tenants").doc(id).collection("identity_audit").where("action", "==", "access.changed").get()).docs.map((d) => d.data());
  assert.deepEqual(
    entries.map((e) => [e.beforeAccess, e.afterAccess]).sort(),
    [[null, "active"], ["active", "read_only"], ["read_only", "suspended"], ["suspended", "active"]].sort(),
  );
});

test("certificate and mailbox routes honor agency access before work starts", async () => {
  const id = people.avery.tenantId;
  const cookie = people.avery.cookie;
  assert.equal((await call("/ams/mailboxes", { cookie })).status, 200);
  // A mounted preparation route rejects an incomplete body, without rendering.
  assert.equal((await call("/ams/certificates/fixture/prepare", { cookie, body: {} })).status, 400);
  await json(await setAccess(id, { state: "read_only" }), 200);
  try {
    assert.equal((await call("/ams/mailboxes", { cookie })).status, 200);
    for (const path of [
      "/ams/mailboxes/connect",
      "/ams/mailboxes/authorize/gmail",
      "/ams/mailboxes/authorize/microsoft365",
      "/ams/mailboxes/fixture/sync",
      "/ams/mailboxes/messages/fixture/file",
      "/ams/certificate-templates",
      "/ams/certificates/fixture/prepare",
    ]) {
      assert.equal((await json(await call(path, { cookie, body: {} }), 402)).error, "access_read_only", path);
    }
    await json(await setAccess(id, { state: "suspended" }), 200);
    for (const path of [
      "/ams/mailboxes",
      "/ams/mailboxes/messages/fixture/original",
      "/ams/certificate-templates/fixture/content",
      "/ams/certificates/fixture/email-draft",
    ]) {
      assert.equal((await json(await call(path, { cookie }), 402)).error, "access_suspended", path);
    }
  } finally {
    await json(await setAccess(id, { state: "active" }), 200);
  }
});

test("an active agency's invitation is emailed, and a failed send is reported as not sent", async () => {
  const accessPath = `/internal/access/v1/agencies/${people.avery.tenantId}`;
  const before = await json(await call(accessPath, { bearer: "controller" }), 200);
  await json(await setAccess(people.avery.tenantId, { state: "active", message: null }), 200);
  const emailed = await json(
    await call("/identity/invitations", { cookie: people.avery.cookie, body: { email: "morgan.member@harbor-test.example", role: "member" } }),
    201,
  );
  assert.equal(emailed.emailed, true);
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0].to, "morgan.member@harbor-test.example");
  assert.equal(sentMail[0].agencyName, "Harbor Test Agency");
  assert.equal(sentMail[0].invitedByEmail, "avery.admin@harbor-test.example");
  assert.equal(sentMail[0].role, "member");
  // The email carries the link secret, so the response to the inviter doesn't.
  assert.match(sentMail[0].token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(sentMail[0].invitationId, emailed.invitation.id);
  assert.equal(emailed.token, undefined);
  mailFails = true;
  const failed = await json(
    await call("/identity/invitations", { cookie: people.avery.cookie, body: { email: "quinn.viewer@harbor-test.example", role: "viewer" } }),
    201,
  );
  mailFails = false;
  assert.equal(failed.emailed, false);
  assert.match(failed.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(failed.invitation.status, "pending");
  assert.equal(sentMail.length, 1);
  // Leave the agency as the next test expects to find it.
  await json(await setAccess(people.avery.tenantId, { state: before.state, message: before.message ?? null }), 200);
});

test("the outside system can set an agency's invitation lifetime, within bounds", async () => {
  const id = people.avery.tenantId;
  const before = await json(await call(`/internal/access/v1/agencies/${id}`, { bearer: "controller" }), 200);
  const setLifetime = (hours, bearer = "controller") => call(`/internal/access/v1/agencies/${id}/invitation-lifetime`, { method: "PUT", body: { hours }, bearer });
  for (const bad of [0, 721, 1.5, -1, "24", true])
    assert.equal((await setLifetime(bad)).status, 400, String(bad));
  // Only the configured service account can set it.
  assert.equal((await setLifetime(1, "stranger")).status, 404);
  try {
    const set = await json(await setLifetime(12), 200);
    assert.equal(set.invitationTtlHours, 12);
    // Leaving it out keeps it; null returns it to the deployment's setting.
    assert.equal((await json(await setAccess(id, { state: before.state, message: before.message }), 200)).invitationTtlHours, 12);
    const created = await json(
      await call("/identity/invitations", { cookie: people.avery.cookie, body: { email: "riley.viewer@harbor-test.example", role: "viewer" } }),
      201,
    );
    assert.equal(Date.parse(created.invitation.expiresAt) - Date.parse(created.invitation.createdAt), 12 * 3600_000);
    assert.equal((await json(await setLifetime(null), 200)).invitationTtlHours, null);
    const entries = (await db().collection("tenants").doc(id).collection("identity_audit").where("action", "==", "invitation_lifetime.changed").get()).docs.map((d) => d.data());
    assert.ok(entries.some((e) => e.beforeInvitationTtlHours === null && e.afterInvitationTtlHours === 12));
    assert.ok(entries.some((e) => e.beforeInvitationTtlHours === 12 && e.afterInvitationTtlHours === null));
  } finally {
    await json(await setLifetime(null), 200);
  }
});

test("one agency's access never affects another", async () => {
  const blake = await signIn("blake.owner@lakeside-test.example");
  await json(await call("/identity/agencies", { cookie: blake.cookie, body: { name: "Lakeside Test Insurance", timeZone: "UTC" } }), 201);
  assert.equal((await call("/ams/session", { cookie: blake.cookie })).status, 402);
  assert.equal((await call("/ams/session", { cookie: people.avery.cookie })).status, 200);
});

test("administrators get a signed, short-lived link; others don't", async () => {
  const { url: link } = await json(await call("/identity/access-link", { cookie: people.avery.cookie, body: {} }), 200);
  const parsed = new URL(link);
  assert.equal(`${parsed.origin}${parsed.pathname}`, ACCESS_URL);
  const [header, payload, signature] = parsed.searchParams.get("token").split(".");
  assert.equal(createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url"), signature);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.sub, people.avery.tenantId);
  assert.equal(claims.name, "Harbor Test Agency");
  assert.equal(claims.email, "avery.admin@harbor-test.example");
  assert.equal(claims.iss, APP_ORIGIN);
  assert.equal(claims.aud, "https://accounts.fixture.example");
  assert.equal(claims.exp - claims.iat, 600);

  // A member who isn't an administrator can't get one.
  const created = await json(await call("/identity/invitations", { cookie: people.avery.cookie, body: { email: "casey.member@harbor-test.example", role: "member" } }), 201);
  // The link secret: from the response when no email went out, otherwise from the email.
  const token = created.token ?? sentMail.at(-1).token;
  const casey = await signIn("casey.member@harbor-test.example");
  await json(await call("/identity/invitations/accept", { cookie: casey.cookie, body: { invitationId: created.invitation.id, token } }), 200);
  assert.equal((await call("/identity/access-link", { cookie: casey.cookie, body: {} })).status, 403);
});

test("an incomplete configuration is refused at startup", () => {
  assert.equal(externalAccessFromEnv({}).enabled, false);
  assert.throws(() => externalAccessFromEnv({ AMS_ACCESS_CONTROL: "external" }), /AMS_ACCESS_SERVICE_ACCOUNT, AMS_ACCESS_URL, AMS_ACCESS_LINK_SECRET/);
  assert.throws(
    () => externalAccessFromEnv({ AMS_ACCESS_CONTROL: "external", AMS_ACCESS_SERVICE_ACCOUNT: ACCESS_ACCOUNT, AMS_ACCESS_URL: "http://insecure.example", AMS_ACCESS_LINK_SECRET: SECRET }),
    /https/,
  );
  assert.equal(
    externalAccessFromEnv({ AMS_ACCESS_CONTROL: "external", AMS_ACCESS_SERVICE_ACCOUNT: ACCESS_ACCOUNT, AMS_ACCESS_URL: ACCESS_URL, AMS_ACCESS_LINK_SECRET: SECRET }).enabled,
    true,
  );
});
