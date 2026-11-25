// Required multi-factor sign-in (AMS_REQUIRE_MFA) against the Firebase Auth and Firestore
// emulators. The emulator supports phone second factors (codes are read from its REST
// API); OpenAMS accepts any second factor, and production uses an authenticator app
// (TOTP), which the browser handles the same way. All people here are fictional.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createFirebaseAuthenticate, createIdentityRouter } from "../../dist/firebase/identity.js";
import { requestLimitOptions } from "../../dist/firebase/rate-limit.js";

const PROJECT = "demo-openams-auth";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FIRESTORE_HOST)
  throw new Error("Run these tests through `npm run test:firebase-auth` (Firebase emulators).");
const ADMIN_EMAIL = "riley.admin@mfa-test.example";
const tick = () => new Promise((resolve) => setTimeout(resolve, 1100));

let app;
let server;
let url;
before(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  app = initializeApp({ projectId: PROJECT }, `mfa-test-${randomUUID()}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const web = express();
  web.use(express.json({ limit: "300kb" }));
  web.use(createIdentityRouter({ auth, db, adminEmails: [ADMIN_EMAIL], requireMfa: true }));
  // Stands in for the agency API: the same authenticate as every /ams route.
  web.get("/ams/whoami", rateLimit(requestLimitOptions(200)), createFirebaseAuthenticate({ auth, db, requireMfa: true }), (_request, response) =>
    response.json({ actor: response.locals.amsActor }),
  );
  server = web.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await deleteApp(app);
});

async function rest(path, body, version = "v1") {
  const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/${version}/${path}?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
const smsCode = async (sessionInfo) => {
  const { verificationCodes } = await (await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/verificationCodes`)).json();
  return verificationCodes.find((entry) => entry.sessionInfo === sessionInfo).code;
};
/** Completes an email link; returns the emulator's raw response (idToken, or mfaPendingCredential). */
async function emailLink(email) {
  await rest("accounts:sendOobCode", { requestType: "EMAIL_SIGNIN", email, continueUrl: "http://localhost/sign-in/finish", canHandleCodeInApp: true });
  const { oobCodes } = await (await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  const code = oobCodes.filter((c) => c.email === email && c.requestType === "EMAIL_SIGNIN").at(-1);
  return rest("accounts:signInWithEmailLink", { email, oobCode: code.oobCode });
}
async function enroll(idToken, phoneNumber) {
  const started = await rest("accounts/mfaEnrollment:start", { idToken, phoneEnrollmentInfo: { phoneNumber } }, "v2");
  const sessionInfo = started.phoneSessionInfo.sessionInfo;
  return rest("accounts/mfaEnrollment:finalize", { idToken, phoneVerificationInfo: { sessionInfo, code: await smsCode(sessionInfo) } }, "v2");
}
/** Email link, then the second factor: a token signed in with both. */
async function signInWithBoth(email) {
  const first = await emailLink(email);
  assert.ok(first.mfaPendingCredential, "an enrolled person's email link needs the second factor");
  const hint = first.mfaInfo[0];
  const started = await rest("accounts/mfaSignIn:start", { mfaPendingCredential: first.mfaPendingCredential, mfaEnrollmentId: hint.mfaEnrollmentId, phoneSignInInfo: { phoneNumber: hint.phoneInfo } }, "v2");
  const sessionInfo = started.phoneResponseInfo.sessionInfo;
  const done = await rest("accounts/mfaSignIn:finalize", { mfaPendingCredential: first.mfaPendingCredential, phoneVerificationInfo: { sessionInfo, code: await smsCode(sessionInfo) } }, "v2");
  return done.idToken;
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
const session = async (idToken, status = 200) => json(await call("/identity/session", { body: { idToken } }), status);

/** Signs someone in for the first time: refused until they enroll, then signs in with both factors. */
async function enrolledPerson(email, phoneNumber) {
  const first = await emailLink(email);
  assert.equal((await session(first.idToken, 403)).error, "mfa_enrollment_required");
  await enroll(first.idToken, phoneNumber);
  const idToken = await signInWithBoth(email);
  return { uid: first.localId, cookie: (await session(idToken)).sessionCookie };
}

test("a session needs a sign-in with a second factor; the first sign-in leads to setting one up", async () => {
  const riley = await enrolledPerson(ADMIN_EMAIL, "+15555550101");
  const me = await json(await call("/identity/me", { cookie: riley.cookie }), 200);
  assert.equal(me.mfaRequired, true);
  await json(await call("/identity/agencies", { cookie: riley.cookie, body: { name: "MFA Test Agency", timeZone: "America/Chicago" } }), 201);
  assert.equal((await json(await call("/ams/whoami", { cookie: riley.cookie }), 200)).actor.role, "admin");
  // A session cookie minted from a sign-in without a second factor (for example, one
  // created before MFA was required) is refused everywhere.
  const plain = await emailLink("casey.plain@mfa-test.example");
  const cookie = await getAuth(app).createSessionCookie(plain.idToken, { expiresIn: 3_600_000 });
  assert.equal((await call("/identity/me", { cookie })).status, 401);
  assert.equal((await call("/ams/whoami", { cookie })).status, 401);
});

test("an administrator can reset a member's second factor, but not their own; the member's sessions end", async () => {
  const riley = { cookie: (await session(await signInWithBoth(ADMIN_EMAIL))).sessionCookie };
  const invited = await json(await call("/identity/invitations", { cookie: riley.cookie, body: { email: "jordan.member@mfa-test.example", role: "member" } }), 201);
  const jordan = await enrolledPerson("jordan.member@mfa-test.example", "+15555550102");
  await json(await call("/identity/invitations/accept", { cookie: jordan.cookie, body: { invitationId: invited.invitation.id, token: invited.token } }), 200);

  // Managers see who has a second factor set up.
  const { members } = await json(await call("/identity/members", { cookie: riley.cookie }), 200);
  assert.deepEqual(members.map((m) => m.secondFactor), [true, true]);

  assert.equal((await json(await call(`/identity/members/${jordan.uid}/reset-mfa`, { cookie: jordan.cookie, body: {} }), 403)).error, "manager_required");
  const self = members.find((m) => m.id !== jordan.uid).id;
  assert.equal((await json(await call(`/identity/members/${self}/reset-mfa`, { cookie: riley.cookie, body: {} }), 409)).error, "cannot_change_self");
  assert.equal((await call(`/identity/members/someone_elsewhere/reset-mfa`, { cookie: riley.cookie, body: {} })).status, 404);

  await tick();
  const reset = await json(await call(`/identity/members/${jordan.uid}/reset-mfa`, { cookie: riley.cookie, body: {} }), 200);
  assert.equal(reset.sessionsRevoked, true);
  assert.equal(((await getAuth(app).getUser(jordan.uid)).multiFactor?.enrolledFactors ?? []).length, 0);
  assert.equal((await call("/ams/whoami", { cookie: jordan.cookie })).status, 401);
  // Their next sign-in sets up a new factor.
  const again = await emailLink("jordan.member@mfa-test.example");
  assert.equal((await session(again.idToken, 403)).error, "mfa_enrollment_required");
  const audit = await getFirestore(app).collectionGroup("identity_audit").where("action", "==", "member.mfa_reset").get();
  assert.equal(audit.size, 1);
});
