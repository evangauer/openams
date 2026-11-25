// Hosted identity against the Firebase Auth and Firestore emulators.
// Run with `npm run test:firebase-auth --workspace @openams/api`; it refuses to run
// anywhere but the emulators. All people and agencies here are fictional.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  createFirebaseAuthenticate,
  createIdentityRouter,
  firestoreMembers,
  firestoreTimeZone,
  firestoreWorkspaceName,
} from "../../dist/firebase/identity.js";
import { createAmsRouter } from "../../dist/routes.js";
import { SqliteAmsRepository } from "../../dist/sqlite-repository.js";
import { LocalAmsFiles } from "../../dist/files.js";

const PROJECT = "demo-openams-auth";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FIRESTORE_HOST)
  throw new Error(
    "Run these tests through `npm run test:firebase-auth` (Firebase emulators).",
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Revocation compares whole seconds; leave a gap so ordering is unambiguous.
const tick = () => sleep(1100);

let app;
let server;
let url;
let dir;
let repository;
let clockOffset = 0;
const limits = { invitationsPerAgencyPerDay: 8 };
// The administrator named at install (AMS_ADMIN_EMAIL): the only person who can set up
// this instance's agency.
const ADMIN_EMAIL = "avery.admin@harbor-test.example";

before(async () => {
  await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, {
    method: "DELETE",
  });
  app = initializeApp({ projectId: PROJECT }, `identity-test-${randomUUID()}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  dir = await mkdtemp(join(tmpdir(), "ams-identity-"));
  repository = new SqliteAmsRepository(join(dir, "agency.sqlite"));
  const web = express();
  web.use(express.json({ limit: "300kb" }));
  web.use(
    createIdentityRouter({
      auth,
      db,
      now: () => new Date(Date.now() + clockOffset),
      limits,
      adminEmails: [ADMIN_EMAIL],
    }),
  );
  web.use(
    createAmsRouter({
      authenticate: createFirebaseAuthenticate({ auth, db }),
      actor: (request) => request.res.locals.amsActor,
      enabled: async () => true,
      repository: () => repository,
      files: new LocalAmsFiles(join(dir, "files")),
      members: firestoreMembers(db),
      workspaceName: firestoreWorkspaceName(db),
      timeZone: firestoreTimeZone(db),
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
const auth = () => getAuth(app);
async function authRest(method, body) {
  const response = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/${method}?key=fake-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
/** A real email-link sign-in through the Auth emulator's out-of-band codes. */
async function emailLinkIdToken(email) {
  await authRest("accounts:sendOobCode", {
    requestType: "EMAIL_SIGNIN",
    email,
    continueUrl: "http://localhost/sign-in/finish",
    canHandleCodeInApp: true,
  });
  const { oobCodes } = await (
    await fetch(
      `http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/oobCodes`,
    )
  ).json();
  const code = oobCodes
    .filter((c) => c.email === email && c.requestType === "EMAIL_SIGNIN")
    .at(-1);
  const signedIn = await authRest("accounts:signInWithEmailLink", {
    email,
    oobCode: code.oobCode,
  });
  return { idToken: signedIn.idToken, uid: signedIn.localId };
}
const call = (path, { cookie, body, method, headers = {} } = {}) =>
  fetch(url + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { authorization: `Bearer ${cookie}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function json(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
async function signIn(email) {
  const { idToken, uid } = await emailLinkIdToken(email);
  const session = await json(
    await call("/identity/session", { body: { idToken } }),
    200,
  );
  return { uid, cookie: session.sessionCookie, expiresAt: session.expiresAt };
}
async function createAgency(person, name) {
  return (
    await json(
      await call("/identity/agencies", {
        cookie: person.cookie,
        body: { name, timeZone: "America/Chicago" },
      }),
      201,
    )
  ).membership;
}
// The link secret of each invitation created here (no mail is configured, so the API
// returns it to the inviter), keyed by invitation id.
const linkTokens = new Map();
async function invite(person, email, role, status = 201) {
  const result = await json(
    await call("/identity/invitations", {
      cookie: person.cookie,
      body: { email, role },
    }),
    status,
  );
  if (result.token) linkTokens.set(result.invitation.id, result.token);
  return result;
}
/** Accepts from the invitation link (its id and secret), as the join page does. */
const accept = (person, invitationId, token = linkTokens.get(invitationId)) =>
  call("/identity/invitations/accept", {
    cookie: person.cookie,
    body: { invitationId, ...(token ? { token } : {}) },
  });
/**
 * Writes a second agency straight into Firestore. The API never creates one (one agency
 * per instance), but the data layer must still keep agencies apart if one exists.
 */
async function seedAgency(person, email, tenantId, name) {
  const at = Timestamp.now();
  await db().collection("identity_agencies").doc(tenantId).set({
    name, timeZone: "America/Chicago", createdBy: person.uid, createdAt: at,
  });
  await db().collection("identity_agencies").doc(tenantId).collection("members").doc(person.uid).set({
    role: "admin", name: email.split("@")[0], email, active: true, createdAt: at, updatedAt: at,
  });
  await db().collection("identity_users").doc(person.uid).set({ email, tenantId, updatedAt: at });
  return tenantId;
}
const setRole = (person, uid, role) =>
  call(`/identity/members/${uid}/role`, { cookie: person.cookie, body: { role } });

const people = {};

test("session minting requires a fresh, verified email-link sign-in", async () => {
  const fresh = await signIn("avery.admin@harbor-test.example");
  assert.match(fresh.cookie, /^[\w-]+\.[\w-]*\.[\w-]*$/);
  const lifetime = Date.parse(fresh.expiresAt) - Date.now();
  assert.ok(lifetime > 7.9 * 3600_000 && lifetime <= 8 * 3600_000);
  people.avery = fresh;
  assert.equal(ADMIN_EMAIL, "avery.admin@harbor-test.example");

  // Stale sign-in: auth_time older than five minutes.
  const { idToken } = await emailLinkIdToken("stale.signin@harbor-test.example");
  clockOffset = 6 * 60_000;
  const stale = await json(
    await call("/identity/session", { body: { idToken } }),
    401,
  );
  clockOffset = 0;
  assert.equal(stale.error, "recent_sign_in_required");

  // Unverified email (password account) cannot mint a session.
  await auth().createUser({
    email: "unverified.person@harbor-test.example",
    password: "fixture-password-123",
    emailVerified: false,
  });
  const unverified = await authRest("accounts:signInWithPassword", {
    email: "unverified.person@harbor-test.example",
    password: "fixture-password-123",
    returnSecureToken: true,
  });
  const refused = await json(
    await call("/identity/session", { body: { idToken: unverified.idToken } }),
    401,
  );
  assert.deepEqual(refused, {
    error: "unauthorized",
    message: "Sign in again to continue.",
  });

  // Garbage, extra fields and non-JSON are refused without detail.
  assert.equal(
    (await call("/identity/session", { body: { idToken: "x".repeat(40) } }))
      .status,
    401,
  );
  assert.equal(
    (await call("/identity/session", { body: { idToken, tenantId: "x" } }))
      .status,
    400,
  );
  const form = await fetch(url + "/identity/session", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `idToken=${idToken}`,
  });
  assert.equal(form.status, 415);
  // An ID token is not a session cookie.
  assert.equal((await call("/identity/me", { cookie: idToken })).status, 401);
});

test("a signed-in person without an agency can see only their own state", async () => {
  const me = await json(await call("/identity/me", { cookie: people.avery.cookie }), 200);
  assert.equal(me.email, "avery.admin@harbor-test.example");
  assert.equal(me.membership, null);
  assert.equal(me.setupAvailable, true);
  assert.deepEqual(me.pendingInvitations, []);
  const ams = await json(await call("/ams/session", { cookie: people.avery.cookie }), 403);
  assert.equal(ams.error, "agency_required");
  assert.equal((await call("/ams/session")).status, 401);
  assert.equal((await call("/identity/me")).status, 401);
});

test("only the install-time administrator can set up the agency, and only once", async () => {
  // Anyone else signed in is told to ask for an invitation, with no setup offered.
  people.stranger = await signIn("quinn.stranger@harbor-test.example");
  const strangerMe = await json(await call("/identity/me", { cookie: people.stranger.cookie }), 200);
  assert.equal(strangerMe.setupAvailable, false);
  const refused = await json(
    await call("/identity/agencies", {
      cookie: people.stranger.cookie,
      body: { name: "Quinn Test Brokerage", timeZone: "UTC" },
    }),
    403,
  );
  assert.equal(refused.error, "setup_not_allowed");
  // An alias of the administrator's mailbox is a different address.
  const alias = await signIn("avery.admin+second@harbor-test.example");
  assert.equal(
    (await json(
      await call("/identity/agencies", { cookie: alias.cookie, body: { name: "Alias", timeZone: "UTC" } }),
      403,
    )).error,
    "setup_not_allowed",
  );

  // A client-chosen tenant id is rejected by the strict schema.
  assert.equal(
    (
      await call("/identity/agencies", {
        cookie: people.avery.cookie,
        body: { name: "Harbor Test", timeZone: "America/Chicago", tenantId: "mine" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/identity/agencies", {
        cookie: people.avery.cookie,
        body: { name: "Harbor Test", timeZone: "Not/AZone" },
      })
    ).status,
    400,
  );
  const membership = await createAgency(people.avery, "Harbor Test Agency");
  assert.match(membership.tenantId, /^agency_[A-Za-z0-9_-]{24}$/);
  assert.equal(membership.role, "admin");
  people.avery.tenantId = membership.tenantId;
  const again = await json(
    await call("/identity/agencies", {
      cookie: people.avery.cookie,
      body: { name: "Second Agency", timeZone: "UTC" },
    }),
    409,
  );
  assert.equal(again.error, "already_member");
  const session = await json(await call("/ams/session", { cookie: people.avery.cookie }), 200);
  assert.equal(session.actor.tenantId, membership.tenantId);
  assert.equal(session.actor.role, "admin");
  assert.equal(session.workspaceName, "Harbor Test Agency");
  assert.equal(session.timeZone, "America/Chicago");
  assert.equal(session.demoAvailable, false);

  // Once set up, the instance never creates a second agency, even for the administrator
  // with the membership link cleared.
  await db().collection("identity_users").doc(people.avery.uid).update({ tenantId: null });
  const me = await json(await call("/identity/me", { cookie: people.avery.cookie }), 200);
  assert.equal(me.setupAvailable, false);
  const exists = await json(
    await call("/identity/agencies", {
      cookie: people.avery.cookie,
      body: { name: "Another", timeZone: "UTC" },
    }),
    409,
  );
  assert.equal(exists.error, "agency_exists");
  await db().collection("identity_users").doc(people.avery.uid).update({ tenantId: membership.tenantId });
});

test("with no administrator email configured, nobody can set up an agency", async (t) => {
  const bare = express();
  bare.use(createIdentityRouter({ auth: auth(), db: db(), adminEmails: [] }));
  const bareServer = bare.listen(0, "127.0.0.1");
  await new Promise((resolve) => bareServer.once("listening", resolve));
  t.after(() => new Promise((resolve) => bareServer.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${bareServer.address().port}/identity/agencies`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${people.stranger.cookie}` },
    body: JSON.stringify({ name: "Nobody", timeZone: "UTC" }),
  });
  assert.equal((await json(response, 403)).error, "setup_not_configured");
});

test("agencies are isolated from each other", async () => {
  people.blake = await signIn("blake.owner@lakeside-test.example");
  people.blake.tenantId = await seedAgency(
    people.blake,
    "blake.owner@lakeside-test.example",
    "agency_lakesideTestSeed00000000",
    "Lakeside Test Insurance",
  );
  const created = await json(
    await call("/ams/commands", {
      cookie: people.avery.cookie,
      body: {
        id: randomUUID(),
        kind: "accounts",
        action: "create",
        data: { name: "Fixture Bakery LLC" },
        reason: "Fixture",
      },
    }),
    200,
  );
  const recordId = created.records[0].id;
  const mine = await json(await call("/ams/records/accounts", { cookie: people.avery.cookie }), 200);
  assert.ok(mine.items.some((record) => record.id === recordId));
  const theirs = await json(await call("/ams/records/accounts", { cookie: people.blake.cookie }), 200);
  assert.equal(theirs.items.length, 0);
  assert.equal(
    (await call(`/ams/records/accounts/${recordId}`, { cookie: people.blake.cookie })).status,
    404,
  );
  const blakeSession = await json(await call("/ams/session", { cookie: people.blake.cookie }), 200);
  assert.deepEqual(blakeSession.members.map((m) => m.email), ["blake.owner@lakeside-test.example"]);

  // Identity endpoints are fenced by the caller's own membership.
  const { invitation } = await invite(people.avery, "casey.viewer@harbor-test.example", "viewer");
  people.caseyInvitation = invitation.id;
  assert.equal(
    (await call(`/identity/invitations/${invitation.id}/revoke`, { cookie: people.blake.cookie, body: {} })).status,
    404,
  );
  assert.equal((await setRole(people.blake, people.avery.uid, "viewer")).status, 404);
  assert.equal(
    (await call(`/identity/members/${people.avery.uid}/deactivate`, { cookie: people.blake.cookie, body: {} })).status,
    404,
  );
  const blakeInvites = await json(await call("/identity/invitations", { cookie: people.blake.cookie }), 200);
  assert.equal(blakeInvites.invitations.length, 0);
});

test("invitations are bound to the verified email, single use, expiring and revocable", async () => {
  // Only the hash of the link secret is stored, never the secret.
  const stored = (await db().collection("identity_invitations").doc(people.caseyInvitation).get()).data();
  assert.deepEqual(Object.keys(stored).sort(), [
    "createdAt", "email", "expiresAt", "invitedBy", "invitedByEmail", "role", "status", "tenantId", "tokenHash",
  ]);
  const caseyToken = linkTokens.get(people.caseyInvitation);
  assert.match(caseyToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(stored.tokenHash, createHash("sha256").update(caseyToken).digest("hex"));
  assert.ok(!JSON.stringify(stored).includes(caseyToken));
  assert.equal(stored.expiresAt.toMillis() - stored.createdAt.toMillis(), 7 * 86400_000);

  const { invitation: managerInvite } = await invite(people.avery, "  Morgan.Manager@Harbor-Test.example ", "manager");
  assert.equal(managerInvite.email, "morgan.manager@harbor-test.example");
  await invite(people.avery, "morgan.manager@harbor-test.example", "member", 409);

  // Someone else with only the id gets the same answer as for a missing invitation.
  const intruder = await signIn("intruder.person@elsewhere-test.example");
  const missing = await json(await accept(intruder, "x".repeat(24), "y".repeat(43)), 404);
  const wrong = await json(await accept(intruder, managerInvite.id, null), 404);
  assert.deepEqual(wrong, missing);
  assert.deepEqual(await json(await accept(intruder, managerInvite.id, "y".repeat(43)), 404), missing);
  // Even with the whole link, a different address can't use it, and isn't told which.
  const withLink = await json(await accept(intruder, managerInvite.id), 403);
  assert.equal(withLink.error, "invitation_wrong_email");
  assert.ok(!JSON.stringify(withLink).includes("morgan"));
  // A member of another agency cannot accept either.
  const blakeTry = await accept(people.blake, managerInvite.id);
  assert.equal(blakeTry.status, 403);

  people.morgan = await signIn("morgan.manager@harbor-test.example");
  const me = await json(await call("/identity/me", { cookie: people.morgan.cookie }), 200);
  assert.deepEqual(
    me.pendingInvitations.map((i) => [i.id, i.role, i.agencyName, i.invitedByEmail, i.linkRequired]),
    [[managerInvite.id, "manager", "Harbor Test Agency", "avery.admin@harbor-test.example", true]],
  );
  // Signed in as the invited address, the id alone still isn't enough: it takes the link.
  assert.deepEqual(await json(await accept(people.morgan, managerInvite.id, null), 404), missing);
  assert.ok(Date.parse(me.pendingInvitations[0].agencyCreatedAt) <= Date.now());
  const accepted = await json(await accept(people.morgan, managerInvite.id), 200);
  assert.equal(accepted.membership.tenantId, people.avery.tenantId);
  assert.equal(accepted.membership.role, "manager");
  // Single use.
  const reused = await json(await accept(people.morgan, managerInvite.id), 409);
  assert.equal(reused.error, "invitation_not_pending");
  const user = (await db().collection("identity_users").doc(people.morgan.uid).get()).data();
  assert.equal(user.tenantId, people.avery.tenantId);
  const morganSession = await json(await call("/ams/session", { cookie: people.morgan.cookie }), 200);
  assert.equal(morganSession.actor.role, "manager");
  assert.equal(morganSession.actor.tenantId, people.avery.tenantId);

  // Expired.
  const { invitation: late } = await invite(people.avery, "late.person@harbor-test.example", "member");
  const latePerson = await signIn("late.person@harbor-test.example");
  clockOffset = 8 * 86400_000;
  const expired = await json(await accept(latePerson, late.id), 410);
  clockOffset = 0;
  assert.equal(expired.error, "invitation_expired");

  // Revoked.
  const { invitation: revoked } = await invite(people.avery, "revoked.person@harbor-test.example", "member");
  const revokedResult = await json(
    await call(`/identity/invitations/${revoked.id}/revoke`, { cookie: people.avery.cookie, body: {} }),
    200,
  );
  assert.equal(revokedResult.invitation.status, "revoked");
  const revokedPerson = await signIn("revoked.person@harbor-test.example");
  assert.equal((await json(await accept(revokedPerson, revoked.id), 409)).error, "invitation_not_pending");
  assert.equal(
    (await call(`/identity/invitations/${revoked.id}/revoke`, { cookie: people.avery.cookie, body: {} })).status,
    409,
  );
});

test("nobody can grant a role above their own", async () => {
  // Manager cannot invite an admin, but can invite lower roles.
  assert.equal((await invite(people.morgan, "new.admin@harbor-test.example", "admin", 403)).error, "role_not_allowed");
  const { invitation } = await invite(people.morgan, "jamie.member@harbor-test.example", "member");
  people.jamie = await signIn("jamie.member@harbor-test.example");
  await json(await accept(people.jamie, invitation.id), 200);
  // Members cannot invite or manage at all.
  assert.equal((await invite(people.jamie, "x.person@harbor-test.example", "viewer", 403)).error, "manager_required");
  assert.equal((await setRole(people.jamie, people.jamie.uid, "admin")).status, 403);
  // Manager cannot promote anyone (or themselves) to admin, nor touch an admin.
  assert.equal((await json(await setRole(people.morgan, people.jamie.uid, "admin"), 403)).error, "role_not_allowed");
  assert.equal((await setRole(people.morgan, people.morgan.uid, "admin")).status, 403);
  assert.equal((await setRole(people.morgan, people.avery.uid, "viewer")).status, 403);
  assert.equal(
    (await call(`/identity/members/${people.avery.uid}/deactivate`, { cookie: people.morgan.cookie, body: {} })).status,
    403,
  );
  // Manager cannot revoke an admin's admin invitation.
  const { invitation: adminInvite } = await invite(people.avery, "second.admin@harbor-test.example", "admin");
  assert.equal(
    (await call(`/identity/invitations/${adminInvite.id}/revoke`, { cookie: people.morgan.cookie, body: {} })).status,
    403,
  );
  // Manager can adjust non-admin roles.
  const changed = await json(await setRole(people.morgan, people.jamie.uid, "accountant"), 200);
  assert.equal(changed.member.role, "accountant");
  const jamieSession = await json(await call("/ams/session", { cookie: people.jamie.cookie }), 200);
  assert.equal(jamieSession.actor.role, "accountant");
});

test("the last active administrator cannot be removed or demoted", async () => {
  assert.equal((await json(await setRole(people.avery, people.avery.uid, "manager"), 409)).error, "last_admin");
  assert.equal(
    (await json(await call(`/identity/members/${people.avery.uid}/deactivate`, { cookie: people.avery.cookie, body: {} }), 409)).error,
    "cannot_change_self",
  );
  // With a second admin, demotion works and is audited with before/after roles.
  await json(await setRole(people.avery, people.morgan.uid, "admin"), 200);
  await json(await setRole(people.avery, people.avery.uid, "manager"), 200);
  // Now Morgan is the only admin.
  assert.equal((await json(await setRole(people.morgan, people.morgan.uid, "viewer"), 409)).error, "last_admin");
  const entries = (
    await db().collection("tenants").doc(people.avery.tenantId).collection("identity_audit").get()
  ).docs.map((doc) => doc.data());
  const demotion = entries.find(
    (e) => e.action === "member.role_changed" && e.targetUid === people.avery.uid,
  );
  assert.equal(demotion.actorUid, people.avery.uid);
  assert.equal(demotion.beforeRole, "admin");
  assert.equal(demotion.afterRole, "manager");
  assert.ok(entries.some((e) => e.action === "agency.created"));
  assert.ok(entries.some((e) => e.action === "invitation.accepted"));
  assert.ok(entries.some((e) => e.action === "invitation.revoked"));
});

test("deactivated members are refused and their sessions revoked", async () => {
  await tick();
  const result = await json(
    await call(`/identity/members/${people.jamie.uid}/deactivate`, { cookie: people.morgan.cookie, body: {} }),
    200,
  );
  assert.equal(result.member.active, false);
  assert.equal(result.sessionsRevoked, true);
  assert.equal((await call("/ams/session", { cookie: people.jamie.cookie })).status, 401);
  await tick();
  // Even a fresh session cannot reach agency records while inactive.
  const fresh = await signIn("jamie.member@harbor-test.example");
  const refused = await json(await call("/ams/session", { cookie: fresh.cookie }), 403);
  assert.equal(refused.error, "membership_inactive");
  // An inactive member keeps their one membership and cannot set up an agency.
  assert.equal(
    (await call("/identity/agencies", { cookie: fresh.cookie, body: { name: "Hop", timeZone: "UTC" } })).status,
    403,
  );
  await json(
    await call(`/identity/members/${people.jamie.uid}/reactivate`, { cookie: people.morgan.cookie, body: {} }),
    200,
  );
  assert.equal((await call("/ams/session", { cookie: fresh.cookie })).status, 200);
});

test("a deactivated inviter's pending invitations stop working", async () => {
  await tick();
  // Avery is a manager by now (demoted in an earlier test); Morgan is the admin.
  const { invitation } = await invite(people.avery, "withdrawn.invitee@harbor-test.example", "member");
  await json(await call(`/identity/members/${people.avery.uid}/deactivate`, { cookie: people.morgan.cookie, body: {} }), 200);
  const invitee = await signIn("withdrawn.invitee@harbor-test.example");
  assert.equal((await json(await accept(invitee, invitation.id), 410)).error, "invitation_withdrawn");
  await json(await call(`/identity/members/${people.avery.uid}/reactivate`, { cookie: people.morgan.cookie, body: {} }), 200);
  // With the inviter active again, the same invitation works.
  assert.equal((await json(await accept(invitee, invitation.id), 200)).membership.role, "member");
});

test("signing out revokes the session cookie", async () => {
  await tick();
  assert.equal((await call("/identity/me", { cookie: people.blake.cookie })).status, 200);
  await json(await call("/identity/sign-out", { cookie: people.blake.cookie, body: {} }), 200);
  assert.equal((await call("/identity/me", { cookie: people.blake.cookie })).status, 401);
  assert.equal((await call("/ams/session", { cookie: people.blake.cookie })).status, 401);
  // Revoked directly (for example from the Firebase console) also takes effect immediately.
  await tick();
  const fresh = await signIn("blake.owner@lakeside-test.example");
  assert.equal((await call("/ams/session", { cookie: fresh.cookie })).status, 200);
  await tick();
  await auth().revokeRefreshTokens(fresh.uid);
  assert.equal((await call("/ams/session", { cookie: fresh.cookie })).status, 401);
});

test("per-agency invitation cap", async () => {
  await tick();
  const owner = await signIn("blake.owner@lakeside-test.example");
  for (let i = 0; i < limits.invitationsPerAgencyPerDay; i++)
    await invite(owner, `cap.person${i}@lakeside-test.example`, "viewer");
  const capped = await invite(owner, "cap.overflow@lakeside-test.example", "viewer", 429);
  assert.equal(capped.error, "invitation_daily_limit");
});

test("App Check, when configured, is required to mint a session", async (t) => {
  const checked = express();
  checked.use(
    createIdentityRouter({
      auth: auth(),
      db: db(),
      // Stub verifier: the real one needs a live App Check project.
      appCheck: {
        verifyToken: async (token) => {
          if (token !== "fixture-app-check-token") throw new Error("invalid");
          return { appId: "fixture", token: {} };
        },
      },
    }),
  );
  const checkedServer = checked.listen(0, "127.0.0.1");
  await new Promise((resolve) => checkedServer.once("listening", resolve));
  t.after(() => new Promise((resolve) => checkedServer.close(resolve)));
  const base = `http://127.0.0.1:${checkedServer.address().port}`;
  const mint = async (headers) => {
    const { idToken } = await emailLinkIdToken("app.check@harbor-test.example");
    return fetch(base + "/identity/session", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ idToken }),
    });
  };
  assert.equal((await json(await mint({}), 401)).error, "app_check_failed");
  assert.equal(
    (await json(await mint({ "x-firebase-appcheck": "forged" }), 401)).error,
    "app_check_failed",
  );
  await json(await mint({ "x-firebase-appcheck": "fixture-app-check-token" }), 200);
});
