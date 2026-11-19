// Open sign-up (AMS_SIGNUP=open) against the Firebase Auth and Firestore emulators:
// anyone with a verified email can create an agency, one per person and per mailbox,
// with per-domain and deployment-wide daily caps, and agencies stay isolated.
// Run with `npm run test:firebase-auth --workspace @openams/api`. All people and agencies
// here are fictional.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
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
import { createAmsRouter } from "../../dist/routes.js";
import { SqliteAmsRepository } from "../../dist/sqlite-repository.js";
import { LocalAmsFiles } from "../../dist/files.js";

const PROJECT = "demo-openams-auth";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FIRESTORE_HOST)
  throw new Error("Run these tests through `npm run test:firebase-auth` (Firebase emulators).");

const limits = { agenciesPerDay: 1000, agenciesPerDomainPerDay: 3, invitationsPerAgencyPerDay: 8, openSignupInvitationEmailsPerAgencyPerDay: 2 };
const mailed = [];
let app, server, url, dir, repository;

before(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  app = initializeApp({ projectId: PROJECT }, `open-signup-test-${randomUUID()}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  dir = await mkdtemp(join(tmpdir(), "ams-open-signup-"));
  repository = new SqliteAmsRepository(join(dir, "agency.sqlite"));
  const web = express();
  web.use(express.json({ limit: "300kb" }));
  // adminEmails is set to prove it is ignored in open mode.
  web.use(createIdentityRouter({ auth, db, limits, signup: "open", adminEmails: ["nobody@example.com"], invitationMail: async (mail) => void mailed.push(mail.to) }));
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
const call = (path, { cookie, body } = {}) =>
  fetch(url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { authorization: `Bearer ${cookie}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function json(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
const create = (person, name, status = 201) =>
  call("/identity/agencies", { cookie: person.cookie, body: { name, timeZone: "America/Chicago" } }).then((r) => json(r, status));

const people = {};

test("anyone with a verified email can create one agency", async () => {
  people.avery = await signIn("avery.admin@harbor-test.example");
  const me = await json(await call("/identity/me", { cookie: people.avery.cookie }), 200);
  assert.equal(me.signup, "open");
  assert.equal(me.setupAvailable, true);
  assert.ok(!me.agencyLimitReached);
  const { membership } = await create(people.avery, "Harbor Test Agency");
  assert.match(membership.tenantId, /^agency_[A-Za-z0-9_-]{24}$/);
  assert.equal(membership.role, "admin");
  people.avery.tenantId = membership.tenantId;
  assert.equal((await create(people.avery, "Second Agency", 409)).error, "already_member");
  const after = await json(await call("/identity/me", { cookie: people.avery.cookie }), 200);
  assert.equal(after.setupAvailable, false);

  // A second, unrelated person creates their own agency: no "one per deployment" limit.
  people.blake = await signIn("blake.owner@lakeside-test.example");
  people.blake.tenantId = (await create(people.blake, "Lakeside Test Insurance")).membership.tenantId;
  assert.notEqual(people.blake.tenantId, people.avery.tenantId);
});

test("self-created agencies are isolated from each other", async () => {
  const created = await json(
    await call("/ams/commands", {
      cookie: people.avery.cookie,
      body: { id: randomUUID(), kind: "accounts", action: "create", data: { name: "Fixture Bakery LLC" }, reason: "Fixture" },
    }),
    200,
  );
  const recordId = created.records[0].id;
  const theirs = await json(await call("/ams/records/accounts", { cookie: people.blake.cookie }), 200);
  assert.equal(theirs.items.length, 0);
  assert.equal((await call(`/ams/records/accounts/${recordId}`, { cookie: people.blake.cookie })).status, 404);
  const session = await json(await call("/ams/session", { cookie: people.blake.cookie }), 200);
  assert.deepEqual(session.members.map((m) => m.email), ["blake.owner@lakeside-test.example"]);
  assert.equal(session.workspaceName, "Lakeside Test Insurance");
});

test("one agency per person and per mailbox, ever", async () => {
  const quinn = await signIn("quinn.founder@harbor-test.example");
  await create(quinn, "Quinn Test Brokerage");
  // Even with the membership link cleared, the same person can't create another.
  await db().collection("identity_users").doc(quinn.uid).update({ tenantId: null });
  assert.equal((await create(quinn, "Another", 429)).error, "agency_limit_reached");
  const me = (person) => call("/identity/me", { cookie: person.cookie }).then((r) => json(r, 200));
  const quinnMe = await me(quinn);
  assert.equal(quinnMe.setupAvailable, false);
  assert.equal(quinnMe.agencyLimitReached, true);
  // Aliases of one mailbox count as one sign-up. The alias is told before it sees a form,
  // and learns nothing about the other address or its agency.
  const alias = await signIn("quinn.founder+second@harbor-test.example");
  const aliasMe = await me(alias);
  assert.equal(aliasMe.setupAvailable, false);
  assert.equal(aliasMe.agencyLimitReached, true);
  assert.equal(aliasMe.membership, null);
  assert.deepEqual(aliasMe.pendingInvitations, []);
  assert.doesNotMatch(JSON.stringify(aliasMe), /quinn\.founder@|Quinn Test Brokerage|agency_[A-Za-z0-9_-]{24}/);
  const refused = await create(alias, "Alias Agency", 429);
  assert.equal(refused.error, "agency_limit_reached");
  assert.equal(
    refused.message,
    "An agency was already created from this inbox. Sign in with the address that created it, or ask the agency's administrator to invite this one.",
  );
  // An unrelated address can still create an agency.
  const stranger = await me(await signIn("sam.newcomer@orchard-test.example"));
  assert.equal(stranger.setupAvailable, true);
  assert.ok(!stranger.agencyLimitReached);
});

test("per-domain and deployment-wide daily caps", async () => {
  // avery and quinn used two of three harbor-test.example sign-ups today.
  await create(await signIn("third.founder@harbor-test.example"), "Third Test Agency");
  const fourth = await signIn("fourth.founder@harbor-test.example");
  assert.equal((await create(fourth, "Fourth Agency", 429)).error, "agency_domain_limit");

  const day = new Date().toISOString().slice(0, 10);
  const counter = db().collection("identity_limits").doc(`agencies_${day}`);
  const before = (await counter.get()).get("count");
  assert.equal(before, 4);
  await counter.set({ count: limits.agenciesPerDay });
  const capped = await signIn("riley.capped@capped-test.example");
  assert.equal((await create(capped, "Capped Agency", 429)).error, "agency_daily_limit");
  await counter.set({ count: before });
});

test("without access control, an agency's invitations are emailed only up to the daily cap", async () => {
  const invite = (email) =>
    call("/identity/invitations", { cookie: people.blake.cookie, body: { email, role: "member" } }).then((r) => json(r, 201));
  const results = [];
  for (const name of ["one", "two", "three"]) results.push(await invite(`${name}.invitee@stranger-test.example`));
  assert.deepEqual(results.map((r) => r.emailed), [true, true, false]);
  assert.deepEqual(mailed, ["one.invitee@stranger-test.example", "two.invitee@stranger-test.example"]);
  // The invitation beyond the cap is still recorded, so the inviter can send the steps themselves.
  assert.equal(results[2].invitation.email, "three.invitee@stranger-test.example");
});
