// Invitation links against the Firebase Auth and Firestore emulators: an invitation is
// accepted only from its link (id and secret) by the verified invited address; someone
// with an open invitation can't create an agency until they decline it; lifetimes come
// from the deployment or the agency and can only be shortened after sending.
// Run with `npm run test:firebase-auth --workspace @openams/api`. All people and agencies
// here are fictional.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createIdentityRouter, invitationTtlHoursFromEnv } from "../../dist/firebase/identity.js";

const PROJECT = "demo-openams-auth";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FIRESTORE_HOST)
  throw new Error("Run these tests through `npm run test:firebase-auth` (Firebase emulators).");

const HOUR = 3600_000;
let app, server, url;
let clockOffset = 0;
// An agency's own invitation lifetime, as external access control would set it.
const agencyTtl = new Map();

before(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  app = initializeApp({ projectId: PROJECT }, `invitation-links-test-${randomUUID()}`);
  const web = express();
  web.use(
    createIdentityRouter({
      auth: getAuth(app),
      db: getFirestore(app),
      signup: "open",
      now: () => new Date(Date.now() + clockOffset),
      limits: { invitationsPerAgencyPerDay: 12 },
      invitationTtlHours: 48,
      agencyInvitationTtlHours: async (tenantId) => agencyTtl.get(tenantId) ?? null,
    }),
  );
  server = web.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await deleteApp(app);
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
let clients = 0;
async function signIn(email) {
  await authRest("accounts:sendOobCode", { requestType: "EMAIL_SIGNIN", email, continueUrl: "http://localhost/sign-in/finish", canHandleCodeInApp: true });
  const { oobCodes } = await (await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  const code = oobCodes.filter((c) => c.email === email && c.requestType === "EMAIL_SIGNIN").at(-1);
  const { idToken, localId } = await authRest("accounts:signInWithEmailLink", { email, oobCode: code.oobCode });
  // Each person browses from their own address, as the web app reports it.
  const client = `192.0.2.${++clients}`;
  const response = await fetch(url + "/identity/session", { method: "POST", headers: { "content-type": "application/json", "x-openams-client": client }, body: JSON.stringify({ idToken }) });
  const session = await response.json();
  assert.equal(response.status, 200, JSON.stringify(session));
  return { uid: localId, email, cookie: session.sessionCookie, client };
}
const call = (path, person, body) =>
  fetch(url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(person ? { authorization: `Bearer ${person.cookie}`, "x-openams-client": person.client } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function json(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
const invite = async (person, email, role = "member") =>
  json(await call("/identity/invitations", person, { email, role }), 201);
const link = (created) => ({ invitationId: created.invitation.id, token: created.token });
const stored = async (id) => (await db().collection("identity_invitations").doc(id).get()).data();

const people = {};

test("an invitation's link secret is stored only as a hash and returned only when no email went out", async () => {
  people.avery = await signIn("avery.admin@harbor-test.example");
  people.avery.tenantId = (await json(await call("/identity/agencies", people.avery, { name: "Harbor Test Agency", timeZone: "UTC" }), 201)).membership.tenantId;
  const created = await invite(people.avery, "morgan.member@harbor-test.example");
  assert.equal(created.emailed, false);
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  const data = await stored(created.invitation.id);
  assert.equal(data.tokenHash, createHash("sha256").update(created.token).digest("hex"));
  assert.ok(!JSON.stringify(data).includes(created.token));
  // The list never carries a secret or its hash.
  const listed = await json(await call("/identity/invitations", people.avery), 200);
  assert.ok(!JSON.stringify(listed).includes(created.token));
  assert.ok(!JSON.stringify(listed).includes(data.tokenHash));
  people.morganInvite = created;
});

test("preview needs a session and the whole link, and says nothing to anyone else", async () => {
  const created = people.morganInvite;
  assert.equal((await call("/identity/invitations/preview", null, link(created))).status, 401);
  people.morgan = await signIn("morgan.member@harbor-test.example");
  const missing = await json(await call("/identity/invitations/preview", people.morgan, { invitationId: "z".repeat(24), token: "z".repeat(43) }), 404);
  const wrongSecret = await json(await call("/identity/invitations/preview", people.morgan, { invitationId: created.invitation.id, token: "z".repeat(43) }), 404);
  assert.deepEqual(wrongSecret, missing);
  // Malformed input is refused before anything is read.
  assert.equal((await call("/identity/invitations/preview", people.morgan, { invitationId: created.invitation.id })).status, 400);
  assert.equal((await call("/identity/invitations/preview", people.morgan, { ...link(created), extra: 1 })).status, 400);
  assert.equal((await call("/identity/invitations/preview", people.morgan, { invitationId: created.invitation.id, token: `${created.token}=` })).status, 400);

  const preview = await json(await call("/identity/invitations/preview", people.morgan, link(created)), 200);
  assert.deepEqual(Object.keys(preview).sort(), ["alreadyMember", "invitation"]);
  assert.deepEqual(Object.keys(preview.invitation).sort(), ["agencyName", "expiresAt", "invitedByEmail", "role"]);
  assert.equal(preview.invitation.agencyName, "Harbor Test Agency");
  assert.equal(preview.invitation.role, "member");
  assert.equal(preview.alreadyMember, false);
  // Previewing changes nothing.
  assert.equal((await stored(created.invitation.id)).status, "pending");

  // The right link with the wrong address: told so, never told which address.
  const stranger = await signIn("stranger.person@elsewhere-test.example");
  const wrongEmail = await json(await call("/identity/invitations/preview", stranger, link(created)), 403);
  assert.equal(wrongEmail.error, "invitation_wrong_email");
  assert.ok(!JSON.stringify(wrongEmail).includes("morgan"));
  assert.ok(!JSON.stringify(wrongEmail).includes("Harbor"));
});

test("someone with an open invitation can't create an agency until they decline it", async () => {
  const me = await json(await call("/identity/me", people.morgan), 200);
  assert.equal(me.setupAvailable, false);
  assert.equal(me.pendingInvitations.length, 1);
  assert.equal(me.pendingInvitations[0].linkRequired, true);
  const refused = await json(await call("/identity/agencies", people.morgan, { name: "Morgan's Own Agency", timeZone: "UTC" }), 409);
  assert.equal(refused.error, "invitation_pending");
  // Nobody else can decline it for them, with or without the id.
  const stranger = await signIn("other.stranger@elsewhere-test.example");
  assert.equal((await call("/identity/invitations/decline", stranger, { invitationId: people.morganInvite.invitation.id })).status, 404);
  assert.equal((await call("/identity/invitations/decline", stranger, link(people.morganInvite))).status, 403);
  // The invitee can, from the signed-in page, without the link.
  await json(await call("/identity/invitations/decline", people.morgan, { invitationId: people.morganInvite.invitation.id }), 200);
  assert.equal((await stored(people.morganInvite.invitation.id)).status, "declined");
  const audit = await db().collection("tenants").doc(people.avery.tenantId).collection("identity_audit").where("action", "==", "invitation.declined").get();
  assert.equal(audit.size, 1);
  // A declined invitation can't be accepted or declined again.
  assert.equal((await json(await call("/identity/invitations/accept", people.morgan, link(people.morganInvite)), 409)).error, "invitation_not_pending");
  assert.equal((await json(await call("/identity/invitations/decline", people.morgan, link(people.morganInvite)), 409)).error, "invitation_not_pending");
  const after = await json(await call("/identity/me", people.morgan), 200);
  assert.equal(after.setupAvailable, true);
  await json(await call("/identity/agencies", people.morgan, { name: "Morgan's Own Agency", timeZone: "UTC" }), 201);
});

test("an expired invitation doesn't block creating an agency", async () => {
  const created = await invite(people.avery, "late.person@harbor-test.example");
  const late = await signIn("late.person@harbor-test.example");
  clockOffset = 49 * HOUR;
  try {
    const me = await json(await call("/identity/me", late), 200);
    assert.equal(me.pendingInvitations.length, 0);
    assert.equal(me.setupAvailable, true);
    assert.equal((await json(await call("/identity/invitations/accept", late, link(created)), 410)).error, "invitation_expired");
  } finally {
    clockOffset = 0;
  }
});

test("the lifetime comes from the deployment or the agency, and is only ever shortened after sending", async () => {
  const created = await invite(people.avery, "casey.member@harbor-test.example");
  const data = await stored(created.invitation.id);
  assert.equal(data.expiresAt.toMillis() - data.createdAt.toMillis(), 48 * HOUR);
  const casey = await signIn("casey.member@harbor-test.example");

  // Shortened for the agency: the open invitation closes sooner, at once.
  agencyTtl.set(people.avery.tenantId, 24);
  const listed = (await json(await call("/identity/invitations", people.avery), 200)).invitations.find((i) => i.id === created.invitation.id);
  assert.equal(Date.parse(listed.expiresAt) - data.createdAt.toMillis(), 24 * HOUR);
  clockOffset = 25 * HOUR;
  try {
    assert.equal((await json(await call("/identity/invitations/accept", casey, link(created)), 410)).error, "invitation_expired");
    // Lengthened: never extends an invitation already sent past its stored expiry.
    agencyTtl.set(people.avery.tenantId, 100);
    assert.equal((await json(await call("/identity/invitations/preview", casey, link(created)), 200)).invitation.role, "member");
    clockOffset = 49 * HOUR;
    assert.equal((await json(await call("/identity/invitations/accept", casey, link(created)), 410)).error, "invitation_expired");
  } finally {
    clockOffset = 0;
    agencyTtl.delete(people.avery.tenantId);
  }
  // A new invitation takes the agency's lifetime when it has one.
  agencyTtl.set(people.avery.tenantId, 6);
  try {
    const short = await invite(people.avery, "dana.member@harbor-test.example");
    const shortData = await stored(short.invitation.id);
    assert.equal(shortData.expiresAt.toMillis() - shortData.createdAt.toMillis(), 6 * HOUR);
  } finally {
    agencyTtl.delete(people.avery.tenantId);
  }
  // Out-of-range agency values are ignored in favor of the deployment's.
  agencyTtl.set(people.avery.tenantId, 0);
  try {
    const fallback = await invite(people.avery, "emery.member@harbor-test.example");
    const fallbackData = await stored(fallback.invitation.id);
    assert.equal(fallbackData.expiresAt.toMillis() - fallbackData.createdAt.toMillis(), 48 * HOUR);
  } finally {
    agencyTtl.delete(people.avery.tenantId);
  }
});

test("AMS_INVITATION_TTL_HOURS accepts whole hours from 1 to 720", () => {
  assert.equal(invitationTtlHoursFromEnv({}), 168);
  assert.equal(invitationTtlHoursFromEnv({ AMS_INVITATION_TTL_HOURS: "72" }), 72);
  assert.equal(invitationTtlHoursFromEnv({ AMS_INVITATION_TTL_HOURS: "1" }), 1);
  assert.equal(invitationTtlHoursFromEnv({ AMS_INVITATION_TTL_HOURS: "720" }), 720);
  for (const bad of ["0", "721", "1.5", "-3", "abc", "1e2", "0x10", " "]) {
    const value = invitationTtlHoursFromEnv({ AMS_INVITATION_TTL_HOURS: bad });
    assert.equal(value, 168, bad);
  }
});

test("resending issues a new secret, and the old link stops working", async () => {
  const created = await invite(people.avery, "finley.member@harbor-test.example");
  const resent = await json(await call(`/identity/invitations/${created.invitation.id}/resend`, people.avery, {}), 200);
  assert.match(resent.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(resent.token, created.token);
  const finley = await signIn("finley.member@harbor-test.example");
  assert.equal((await call("/identity/invitations/preview", finley, link(created))).status, 404);
  assert.equal((await json(await call("/identity/invitations/accept", finley, link(resent)), 200)).membership.role, "member");
  // An accepted invitation can't be resent.
  assert.equal((await json(await call(`/identity/invitations/${created.invitation.id}/resend`, people.avery, {}), 409)).error, "invitation_not_pending");
  // Only the agency's own managers can resend.
  assert.equal((await call(`/identity/invitations/${created.invitation.id}/resend`, finley, {})).status, 403);
  const audit = await db().collection("tenants").doc(people.avery.tenantId).collection("identity_audit").where("action", "==", "invitation.resent").get();
  assert.equal(audit.size, 1);
});

test("an invitation sent before links existed is accepted by the invited address alone", async () => {
  const at = Timestamp.fromMillis(Date.now());
  const id = "LegacyInvitation00000001";
  await db().collection("identity_invitations").doc(id).set({
    tenantId: people.avery.tenantId,
    email: "gray.member@harbor-test.example",
    role: "viewer",
    status: "pending",
    invitedBy: people.avery.uid,
    invitedByEmail: people.avery.email,
    createdAt: at,
    expiresAt: Timestamp.fromMillis(at.toMillis() + 7 * 24 * HOUR),
  });
  const gray = await signIn("gray.member@harbor-test.example");
  const me = await json(await call("/identity/me", gray), 200);
  assert.deepEqual(me.pendingInvitations.map((i) => [i.id, i.linkRequired]), [[id, false]]);
  // There is no link to preview.
  assert.equal((await call("/identity/invitations/preview", gray, { invitationId: id, token: "q".repeat(43) })).status, 404);
  // Someone else can't take it.
  const stranger = await signIn("third.stranger@elsewhere-test.example");
  assert.equal((await call("/identity/invitations/accept", stranger, { invitationId: id })).status, 404);
  assert.equal((await json(await call("/identity/invitations/accept", gray, { invitationId: id }), 200)).membership.role, "viewer");
});

test("link endpoints are rate-limited per person", async () => {
  const created = await invite(people.avery, "harper.member@harbor-test.example");
  const harper = await signIn("harper.member@harbor-test.example");
  const statuses = [];
  for (let i = 0; i < 22; i++)
    statuses.push((await call("/identity/invitations/preview", harper, { invitationId: created.invitation.id, token: "w".repeat(43) })).status);
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(404));
  assert.equal(statuses.at(-1), 429);
  // Even the right link waits out the limit.
  assert.equal((await call("/identity/invitations/preview", harper, link(created))).status, 429);
});
