// Read-only instance status against the Firestore emulator: off by default, only the
// configured service account gets through, and the answer holds health and counts only.
// Run with `npm run test:firebase-auth --workspace @openams/api`. All agencies and people
// here are fictional.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createStatusApi } from "../../dist/firebase/status.js";
import { createSchedulerAuthorization } from "../../dist/firebase/scheduler.js";

const PROJECT = "demo-openams-auth";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!FIRESTORE_HOST)
  throw new Error("Run these tests through `npm run test:firebase-auth` (Firebase emulators).");

const STATUS_ACCOUNT = "status-reader@fixture-project.iam.gserviceaccount.com";
const AUDIENCE = "https://ams.fixture.example/api/internal/status";
// Stands in for Google's token verification: one token per caller identity.
const tokens = {
  reader: { email: STATUS_ACCOUNT, email_verified: true, iss: "https://accounts.google.com" },
  stranger: { email: "someone-else@fixture-project.iam.gserviceaccount.com", email_verified: true, iss: "https://accounts.google.com" },
};
const verifier = {
  async verifyIdToken({ idToken, audience }) {
    if (audience !== AUDIENCE || !tokens[idToken]) throw new Error("invalid token");
    return { getPayload: () => tokens[idToken] };
  },
};
let app;
const servers = [];

async function serve(enabled) {
  const web = express();
  web.use(
    createStatusApi({
      db: getFirestore(app),
      enabled,
      authorize: createSchedulerAuthorization({
        serviceAccount: STATUS_ACCOUNT,
        audience: AUDIENCE,
        client: verifier,
        errorCode: "status_denied",
      }),
    }),
  );
  const server = web.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return (token) =>
    fetch(`http://127.0.0.1:${server.address().port}/internal/status/v1`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
}

before(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  app = initializeApp({ projectId: PROJECT }, `status-test-${randomUUID()}`);
});
after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await deleteApp(app);
});

test("the status endpoint is off unless configured", async () => {
  const get = await serve(false);
  assert.equal((await get()).status, 404);
  assert.equal((await get("reader")).status, 404);
});

test("only the status service account can read it", async () => {
  const get = await serve(true);
  assert.equal((await get()).status, 404);
  assert.deepEqual(await (await get("stranger")).json(), { error: "not_found" });
  assert.equal((await get("forged")).status, 404);
});

test("it reports health and counts, never people or records", async () => {
  const get = await serve(true);
  const before = await (await get("reader")).json();
  assert.equal(before.status, "ok");
  assert.deepEqual(before.agency, { configured: false });
  assert.deepEqual(before.members, { active: 0, total: 0 });

  const db = getFirestore(app);
  const agency = db.collection("identity_agencies").doc("agency_statusFixture000000000");
  const at = Timestamp.fromDate(new Date("2026-01-05T15:00:00Z"));
  await agency.set({ name: "Harbor Test Agency", timeZone: "America/Chicago", createdBy: "u1", createdAt: at });
  await agency.collection("members").doc("u1").set({ role: "admin", name: "Avery", email: "avery.admin@harbor-test.example", active: true });
  await agency.collection("members").doc("u2").set({ role: "viewer", name: "Casey", email: "casey.viewer@harbor-test.example", active: false });

  const response = await get("reader");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.agency, {
    configured: true,
    name: "Harbor Test Agency",
    timeZone: "America/Chicago",
    createdAt: "2026-01-05T15:00:00.000Z",
  });
  assert.deepEqual(body.members, { active: 1, total: 2 });
  assert.equal(typeof body.version, "string");
  assert.ok(!JSON.stringify(body).includes("@"), "no email addresses in the status answer");
});

test("with open sign-up it reports totals, never one agency's details", async (t) => {
  const web = express();
  web.use(
    createStatusApi({
      db: getFirestore(app),
      enabled: true,
      signup: "open",
      authorize: createSchedulerAuthorization({ serviceAccount: STATUS_ACCOUNT, audience: AUDIENCE, client: verifier, errorCode: "status_denied" }),
    }),
  );
  const server = web.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const db = getFirestore(app);
  await db.collection("identity_agencies").doc("agency_statusSecond0000000000").set({ name: "Lakeside Test Insurance", timeZone: "UTC" });
  await db.collection("identity_users").doc("u1").set({ email: "avery.admin@harbor-test.example", tenantId: "agency_statusFixture000000000" });
  await db.collection("identity_users").doc("u9").set({ email: "no.agency@harbor-test.example", tenantId: null });
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/internal/status/v1`, { headers: { authorization: "Bearer reader" } })).json();
  assert.equal(body.status, "ok");
  assert.equal(body.signup, "open");
  assert.deepEqual(body.agencies, { total: 2 });
  assert.deepEqual(body.people, { total: 1 });
  assert.equal(body.agency, undefined);
  const text = JSON.stringify(body);
  assert.ok(!text.includes("Harbor") && !text.includes("Lakeside") && !text.includes("@"), text);
});
