// Primary text sign-in for an existing verified-email identity. Emulator-only;
// all people, addresses, agencies and numbers are fictional.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createIdentityRouter, createFirebaseAuthenticate, smsSigninFromEnv } from "../../dist/firebase/identity.js";
import { requestLimitOptions } from "../../dist/firebase/rate-limit.js";

const PROJECT = "demo-openams-auth";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const DB_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !DB_HOST) throw new Error("Run SMS sign-in tests with the Auth and Firestore emulators.");
let app, server, origin;
before(async () => {
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  await fetch(`http://${DB_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  app = initializeApp({ projectId: PROJECT }, `sms-${randomUUID()}`);
  const auth = getAuth(app), db = getFirestore(app);
  const web = express();
  web.use(express.json());
  web.use(createIdentityRouter({ auth, db, signup: "open", allowSms: true }));
  web.use("/off", createIdentityRouter({ auth, db, signup: "open", allowSms: false }));
  web.use("/mfa", createIdentityRouter({ auth, db, allowSms: true, requireMfa: true }));
  web.get("/ams/whoami", rateLimit(requestLimitOptions(200)), createFirebaseAuthenticate({ auth, db, allowSms: true }), (_req, res) => res.json(res.locals.amsActor));
  server = web.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); await deleteApp(app); });
async function authRest(method, body, expected = 200) {
  const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/${method}?key=fixture-key`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, expected, `Auth ${method}: ${response.status}`);
  return response.json();
}
async function call(path, body, cookie, expected = 200) {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(cookie ? { authorization: `Bearer ${cookie}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected, `${path}: ${response.status}`);
  return response.json();
}
async function emailSignIn(email) {
  await authRest("accounts:sendOobCode", { requestType: "EMAIL_SIGNIN", email, continueUrl: "http://localhost/sign-in/finish", canHandleCodeInApp: true });
  const { oobCodes } = await (await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  return authRest("accounts:signInWithEmailLink", { email, oobCode: oobCodes.filter((x) => x.email === email).at(-1).oobCode });
}
async function textSignIn(phoneNumber, idToken) {
  const { sessionInfo } = await authRest("accounts:sendVerificationCode", { phoneNumber, recaptchaToken: "emulator" });
  const { verificationCodes } = await (await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/verificationCodes`)).json();
  const { code } = verificationCodes.find((x) => x.sessionInfo === sessionInfo);
  return authRest("accounts:signInWithPhoneNumber", { sessionInfo, code, ...(idToken ? { idToken } : {}) });
}
const cookieFor = async (idToken) => (await call("/identity/session", { idToken })).sessionCookie;

let owner, ownerCookie, agency, member;
test("email proof and linked text sign-in preserve the account and invitation membership", async () => {
  owner = await emailSignIn("avery@harbor-test.example");
  ownerCookie = await cookieFor(owner.idToken);
  agency = await call("/identity/agencies", { name: "Harbor Test Agency", timeZone: "America/New_York" }, ownerCookie, 201);
  const invite = await call("/identity/invitations", { email: "rowan@harbor-test.example", role: "member" }, ownerCookie, 201);
  member = await emailSignIn("rowan@harbor-test.example");
  const linked = await textSignIn("+12025550123", member.idToken);
  assert.equal(linked.localId, member.localId);
  const sms = await textSignIn("+12025550123");
  assert.equal(sms.localId, member.localId);
  const cookie = await cookieFor(sms.idToken);
  const me = await call("/identity/me", undefined, cookie);
  assert.equal(me.email, "rowan@harbor-test.example");
  assert.equal(me.pendingInvitations.length, 1);
  await call("/identity/invitations/accept", { invitationId: invite.invitation.id, token: invite.token }, cookie);
  const actor = await call("/ams/whoami", undefined, cookie);
  assert.equal(actor.userId, member.localId);
  const ownerActor = await call("/ams/whoami", undefined, ownerCookie);
  assert.equal(actor.tenantId, ownerActor.tenantId);
  assert.equal(actor.role, "member");
});

test("a verified phone alone cannot create a session or obtain agency access", async () => {
  const phoneOnly = await textSignIn("+12025550124");
  await call("/identity/session", { idToken: phoneOnly.idToken }, undefined, 401);
  await call("/ams/whoami", undefined, phoneOnly.idToken, 401);
});

test("SMS is opt-in and cannot bypass a required second factor", async () => {
  assert.equal(smsSigninFromEnv({}), false);
  assert.equal(smsSigninFromEnv({ AMS_SMS_SIGNIN: "1" }), true);
  assert.equal(smsSigninFromEnv({ AMS_SMS_SIGNIN: "1", AMS_AUTH_TENANT_ID: "demo-tenant" }), false);
  assert.equal(smsSigninFromEnv({ AMS_SMS_SIGNIN: "1", AMS_AUTH_TENANT_ID: "  " }), true);
  assert.equal(smsSigninFromEnv({ AMS_SMS_SIGNIN: "1", AMS_REQUIRE_MFA: "1" }), false);
  const sms = await textSignIn("+12025550123");
  await call("/off/identity/session", { idToken: sms.idToken }, undefined, 401);
  await call("/mfa/identity/session", { idToken: sms.idToken }, undefined, 401);
  const cookie = await cookieFor(sms.idToken);
  await call("/off/identity/me", undefined, cookie, 401);
  // The email route remains available when SMS is disabled.
  await call("/off/identity/session", { idToken: owner.idToken });
});

test("linking refuses a number owned by another account and never transfers membership", async () => {
  const other = await emailSignIn("sage@other-test.example");
  const { sessionInfo } = await authRest("accounts:sendVerificationCode", { phoneNumber: "+12025550123", recaptchaToken: "emulator" });
  const { verificationCodes } = await (await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/verificationCodes`)).json();
  const { code } = verificationCodes.find((x) => x.sessionInfo === sessionInfo);
  // Identity Toolkit represents this conflict as a temporary proof, not an ID
  // token. The SDK turns that response into credential-already-in-use.
  const refused = await authRest("accounts:signInWithPhoneNumber", { sessionInfo, code, idToken: other.idToken });
  assert.equal(refused.idToken, undefined);
  assert.equal(typeof refused.temporaryProof, "string");
  assert.equal((await getAuth(app).getUser(member.localId)).phoneNumber, "+12025550123");
  assert.equal((await getAuth(app).getUser(other.localId)).phoneNumber, undefined);
  const cookie = await cookieFor(other.idToken);
  await call("/identity/agencies", { name: "Other Test Agency", timeZone: "America/New_York" }, cookie, 201);
  const [otherActor, ownerActor] = await Promise.all([call("/ams/whoami", undefined, cookie), call("/ams/whoami", undefined, ownerCookie)]);
  assert.notEqual(otherActor.tenantId, ownerActor.tenantId);
});

test("unlinking immediately refuses an existing SMS session while email still works", async () => {
  const sms = await textSignIn("+12025550123");
  const cookie = await cookieFor(sms.idToken);
  await getAuth(app).updateUser(member.localId, { phoneNumber: null });
  await call("/identity/me", undefined, cookie, 401);
  await call("/ams/whoami", undefined, cookie, 401);
  await call("/identity/session", { idToken: sms.idToken }, undefined, 401);
  const email = await emailSignIn("rowan@harbor-test.example");
  assert.equal(email.localId, member.localId);
  const emailCookie = await cookieFor(email.idToken);
  await call("/ams/whoami", undefined, emailCookie);
});
