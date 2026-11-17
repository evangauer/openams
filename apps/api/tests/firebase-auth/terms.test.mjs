// Accepting the deployment's terms when creating an agency (AMS_TERMS_URL /
// AMS_TERMS_VERSION), against the Firebase emulators. Fictional people only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createIdentityRouter, termsFromEnv } from "../../dist/firebase/identity.js";

const PROJECT = "demo-openams-auth";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FIRESTORE_HOST) throw new Error("Run these tests through `npm run test:firebase-auth` (Firebase emulators).");
const TERMS = { url: "https://terms.example/terms", version: "terms@2.0" };

let app;
let server;
let url;
before(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  app = initializeApp({ projectId: PROJECT }, `terms-test-${randomUUID()}`);
  const web = express();
  web.use(express.json({ limit: "300kb" }));
  web.use(createIdentityRouter({ auth: getAuth(app), db: getFirestore(app), signup: "open", terms: TERMS }));
  server = web.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await deleteApp(app);
});

async function rest(path, body) {
  const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/${path}?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}
async function signIn(email) {
  await rest("accounts:sendOobCode", { requestType: "EMAIL_SIGNIN", email, continueUrl: "http://localhost/sign-in/finish", canHandleCodeInApp: true });
  const { oobCodes } = await (await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  const code = oobCodes.filter((c) => c.email === email).at(-1);
  const { idToken } = await rest("accounts:signInWithEmailLink", { email, oobCode: code.oobCode });
  const response = await fetch(`${url}/identity/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }) });
  return (await response.json()).sessionCookie;
}
const post = (cookie, body) =>
  fetch(`${url}/identity/agencies`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cookie}` }, body: JSON.stringify(body) });

test("creating an agency requires accepting the current terms, and records it", async () => {
  const cookie = await signIn("morgan.founder@terms-test.example");
  const me = await (await fetch(`${url}/identity/me`, { headers: { authorization: `Bearer ${cookie}` } })).json();
  assert.deepEqual(me.terms, TERMS);
  const agency = { name: "Terms Test Agency", timeZone: "America/Chicago" };
  let response = await post(cookie, agency);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "terms_required");
  response = await post(cookie, { ...agency, acceptTerms: "terms@1.0" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /changed/);
  response = await post(cookie, { ...agency, acceptTerms: TERMS.version });
  assert.equal(response.status, 201);
  const { membership } = await response.json();
  const stored = (await getFirestore(app).collection("identity_agencies").doc(membership.tenantId).get()).get("termsAccepted");
  assert.equal(stored.version, TERMS.version);
  assert.equal(stored.email, "morgan.founder@terms-test.example");
});

test("terms settings: both or neither, https only", () => {
  assert.equal(termsFromEnv({}), null);
  assert.equal(termsFromEnv({ AMS_TERMS_URL: "https://x.example/terms" }), null);
  assert.deepEqual(termsFromEnv({ AMS_TERMS_URL: "https://x.example/terms", AMS_TERMS_VERSION: "terms@1;dpa@1" }), { url: "https://x.example/terms", version: "terms@1;dpa@1" });
  assert.throws(() => termsFromEnv({ AMS_TERMS_URL: "http://x.example/terms", AMS_TERMS_VERSION: "1" }));
  assert.throws(() => termsFromEnv({ AMS_TERMS_URL: "https://x.example/terms", AMS_TERMS_VERSION: "<script>" }));
});
