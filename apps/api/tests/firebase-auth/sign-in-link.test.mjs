// The deployment's own sign-in email against the Firebase Auth and Firestore emulators:
// the link it mails signs the person in through the app's finish page, and every reason
// not to send ends in `{ sent: false }` so the browser falls back to Firebase's email.
// Run with `npm run test:firebase-auth --workspace @openams/api`. Everyone is fictional.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createIdentityRouter } from "../../dist/firebase/identity.js";

const PROJECT = "demo-openams-auth";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FIRESTORE_HOST)
  throw new Error("Run these tests through `npm run test:firebase-auth` (Firebase emulators).");
const APP_ORIGIN = "http://localhost:4500";

let app;
const servers = [];
const mailed = [];
async function serve(deps) {
  const web = express();
  web.use(createIdentityRouter({ auth: getAuth(app), db: getFirestore(app), adminEmails: [], ...deps }));
  const server = web.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
let withMail;
let withoutMail;
let failing;

before(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  app = initializeApp({ projectId: PROJECT }, `sign-in-link-test-${randomUUID()}`);
  withMail = await serve({
    limits: { signInEmailsPerDay: 6 },
    signInMail: { appOrigin: APP_ORIGIN, send: async (message) => void mailed.push(message) },
  });
  withoutMail = await serve({});
  // Another day's counter, so its attempts don't use up the allowance above.
  failing = await serve({
    now: () => new Date("2030-01-02T12:00:00Z"),
    signInMail: {
      appOrigin: APP_ORIGIN,
      send: async () => {
        throw Object.assign(new Error("fixture SMTP outage"), { code: "ECONNECTION" });
      },
    },
  });
});
after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await deleteApp(app);
});

const ask = (base, body) =>
  fetch(`${base}/identity/sign-in-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
async function sent(base, body) {
  const response = await ask(base, body);
  assert.equal(response.status, 200);
  return (await response.json()).sent;
}
async function authRest(method, body) {
  const response = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/${method}?key=fake-api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("without mail settings the browser is told to use Firebase's email", async () => {
  assert.equal(await sent(withoutMail, { email: "casey@harbor-test.example" }), false);
  assert.equal(mailed.length, 0);
});

test("the mailed link opens the app's finish page and its code signs the person in, once", async () => {
  assert.equal(await sent(withMail, { email: " Casey@Harbor-Test.example " }), true);
  assert.equal(mailed.length, 1);
  const [{ to, link }] = mailed;
  assert.equal(to, "casey@harbor-test.example");
  const url = new URL(link);
  assert.equal(`${url.origin}${url.pathname}`, `${APP_ORIGIN}/sign-in/finish`);
  assert.equal(url.searchParams.get("mode"), "signIn");
  assert.equal(url.searchParams.has("continueUrl"), false);
  const oobCode = url.searchParams.get("oobCode");
  assert.ok(oobCode);
  const signedIn = await authRest("accounts:signInWithEmailLink", { email: to, oobCode });
  assert.equal(signedIn.status, 200);
  assert.ok(signedIn.body.idToken);
  // The same session exchange the browser makes next.
  const session = await fetch(`${withMail}/identity/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: signedIn.body.idToken }),
  });
  assert.equal(session.status, 200);
  assert.equal((await authRest("accounts:signInWithEmailLink", { email: to, oobCode })).status, 400);
});

test("text sign-in setup survives only where text sign-in is on", async () => {
  mailed.length = 0;
  assert.equal(await sent(withMail, { email: "drew@harbor-test.example", phoneSetup: true }), true);
  assert.equal(new URL(mailed[0].link).searchParams.has("phone"), false);
});

test("aliases of one inbox share a small allowance, then Firebase takes over", async () => {
  mailed.length = 0;
  for (const email of ["riley@harbor-test.example", "riley+one@harbor-test.example", "riley+two@harbor-test.example"])
    assert.equal(await sent(withMail, { email }), true, email);
  assert.equal(await sent(withMail, { email: "riley+three@harbor-test.example" }), false);
  assert.equal(mailed.length, 3);
});

test("past the deployment's daily allowance, Firebase sends the rest", async () => {
  // Six allowed today: Casey, Drew and three for Riley are five.
  assert.equal(await sent(withMail, { email: "jordan@harbor-test.example" }), true);
  assert.equal(await sent(withMail, { email: "quinn@harbor-test.example" }), false);
});

test("a failed send is reported as not sent, so the browser falls back", async () => {
  assert.equal(await sent(failing, { email: "sam@harbor-test.example" }), false);
});

test("the request body is strict", async () => {
  assert.equal((await ask(withMail, { email: "not-an-address" })).status, 400);
  assert.equal((await ask(withMail, { email: "casey@harbor-test.example", continueUrl: "https://bad.example" })).status, 400);
});
