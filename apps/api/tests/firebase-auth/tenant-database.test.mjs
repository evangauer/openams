// Several deployments in one Google Cloud project (docs/cloud-run.md): each with its own
// Identity Platform tenant and its own named Firestore database, against the Firebase
// Auth and Firestore emulators. Run with `npm run test:firebase-auth --workspace
// @openams/api`. All people and agencies here are fictional.
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
  throw new Error(
    "Run these tests through `npm run test:firebase-auth` (Firebase emulators).",
  );
// The same person administers both agencies, to show the tenants keep them apart.
const ADMIN_EMAIL = "morgan.owner@lakeside-test.example";

let app;
const deployments = {};

async function startDeployment(name, databaseId) {
  const tenant = await getAuth(app).tenantManager().createTenant({
    displayName: name,
    emailSignInConfig: { enabled: true, passwordRequired: false },
  });
  const auth = getAuth(app).tenantManager().authForTenant(tenant.tenantId);
  const db = getFirestore(app, databaseId);
  const web = express();
  web.use(express.json({ limit: "300kb" }));
  web.use(createIdentityRouter({ auth, db, adminEmails: [ADMIN_EMAIL] }));
  const server = web.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    tenantId: tenant.tenantId,
    databaseId,
    db,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

before(async () => {
  for (const database of ["(default)", "agency-a", "agency-b"])
    await fetch(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/${database}/documents`,
      { method: "DELETE" },
    );
  app = initializeApp({ projectId: PROJECT }, `tenant-test-${randomUUID()}`);
  deployments.a = await startDeployment("AgencyA", "agency-a");
  deployments.b = await startDeployment("AgencyB", "agency-b");
});
after(async () => {
  for (const deployment of Object.values(deployments)) {
    await new Promise((resolve) => deployment.server.close(resolve));
    await getAuth(app).tenantManager().deleteTenant(deployment.tenantId).catch(() => {});
  }
  await deleteApp(app);
});

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
/** An email-link sign-in, through a tenant when one is given (as the browser does). */
async function emailLinkIdToken(email, tenantId) {
  const tenant = tenantId ? { tenantId } : {};
  await authRest("accounts:sendOobCode", {
    requestType: "EMAIL_SIGNIN",
    email,
    continueUrl: "http://localhost/sign-in/finish",
    canHandleCodeInApp: true,
    ...tenant,
  });
  // The emulator keeps each tenant's sign-in links apart, as Identity Platform does.
  const scope = tenantId ? `projects/${PROJECT}/tenants/${tenantId}` : `projects/${PROJECT}`;
  const { oobCodes } = await (
    await fetch(`http://${AUTH_HOST}/emulator/v1/${scope}/oobCodes`)
  ).json();
  const code = oobCodes
    .filter((c) => c.email === email && c.requestType === "EMAIL_SIGNIN")
    .at(-1);
  assert.ok(code, "the emulator recorded a sign-in link");
  const signedIn = await authRest("accounts:signInWithEmailLink", {
    email,
    oobCode: code.oobCode,
    ...tenant,
  });
  return { idToken: signedIn.idToken, uid: signedIn.localId };
}
const call = (deployment, path, { cookie, body } = {}) =>
  fetch(deployment.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { authorization: `Bearer ${cookie}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function json(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
async function signIn(deployment) {
  const { idToken, uid } = await emailLinkIdToken(ADMIN_EMAIL, deployment.tenantId);
  const session = await json(
    await call(deployment, "/identity/session", { body: { idToken } }),
    200,
  );
  return { uid, idToken, cookie: session.sessionCookie };
}

const people = {};

test("each deployment signs people in through its own tenant", async () => {
  people.a = await signIn(deployments.a);
  people.b = await signIn(deployments.b);
  // One email, two tenants: two separate accounts.
  assert.notEqual(people.a.uid, people.b.uid);
  assert.equal((await json(await call(deployments.a, "/identity/me", { cookie: people.a.cookie }), 200)).email, ADMIN_EMAIL);
  assert.equal((await json(await call(deployments.b, "/identity/me", { cookie: people.b.cookie }), 200)).email, ADMIN_EMAIL);
});

test("a session or ID token from another tenant, or from project-level Auth, is refused", async () => {
  assert.equal((await call(deployments.b, "/identity/me", { cookie: people.a.cookie })).status, 401);
  assert.equal((await call(deployments.a, "/identity/me", { cookie: people.b.cookie })).status, 401);
  const fresh = await emailLinkIdToken(ADMIN_EMAIL, deployments.a.tenantId);
  assert.equal(
    (await call(deployments.b, "/identity/session", { body: { idToken: fresh.idToken } })).status,
    401,
  );
  const projectLevel = await emailLinkIdToken(ADMIN_EMAIL);
  assert.equal(
    (await call(deployments.a, "/identity/session", { body: { idToken: projectLevel.idToken } })).status,
    401,
  );
});

test("each deployment keeps its agency in its own named database", async () => {
  const created = await json(
    await call(deployments.a, "/identity/agencies", {
      cookie: people.a.cookie,
      body: { name: "Lakeside Test Agency", timeZone: "America/Chicago" },
    }),
    201,
  );
  const agencyId = created.membership.tenantId;
  assert.ok((await deployments.a.db.collection("identity_agencies").doc(agencyId).get()).exists);
  assert.equal((await deployments.b.db.collection("identity_agencies").get()).size, 0);
  assert.equal((await getFirestore(app).collection("identity_agencies").get()).size, 0);
  // Deployment B is still a fresh install: its administrator can set up its own agency.
  const me = await json(await call(deployments.b, "/identity/me", { cookie: people.b.cookie }), 200);
  assert.equal(me.membership, null);
  assert.equal(me.setupAvailable, true);
  await json(
    await call(deployments.b, "/identity/agencies", {
      cookie: people.b.cookie,
      body: { name: "Hillcrest Test Agency", timeZone: "America/Denver" },
    }),
    201,
  );
  assert.equal((await deployments.a.db.collection("identity_agencies").get()).size, 1);
  assert.equal((await deployments.b.db.collection("identity_agencies").get()).size, 1);
});

test("signing out revokes the session in its own tenant only", async () => {
  // Revocation compares whole seconds; leave a gap so ordering is unambiguous.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await json(await call(deployments.a, "/identity/sign-out", { cookie: people.a.cookie, body: {} }), 200);
  assert.equal((await call(deployments.a, "/identity/me", { cookie: people.a.cookie })).status, 401);
  assert.equal((await call(deployments.b, "/identity/me", { cookie: people.b.cookie })).status, 200);
});
