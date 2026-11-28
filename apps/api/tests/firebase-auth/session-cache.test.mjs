// AMS_SESSION_CACHE_SECONDS against the Firebase Auth and Firestore emulators: what a
// remembered session saves, and exactly what it trades away. Two authenticators stand in
// for two server instances; the identity router shares the first one's cache, as the
// instance that handles a deactivation does. All people here are fictional.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createFirebaseAuthenticate, createIdentityRouter, SessionCache } from "../../dist/firebase/identity.js";

const PROJECT = "demo-openams-auth";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FIRESTORE_HOST)
  throw new Error("Run these tests through `npm run test:firebase-auth` (Firebase emulators).");
const tick = () => new Promise((resolve) => setTimeout(resolve, 1100));
const run = randomUUID().slice(0, 8);
const tenantId = `agency_cache${run}`;

let app;
let server;
let url;
let verifications = 0;
const people = {};
before(async () => {
  app = initializeApp({ projectId: PROJECT }, `session-cache-test-${randomUUID()}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  // Count real session verifications, to show what the cache saves.
  const counting = new Proxy(auth, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== "function") return value;
      if (name === "verifySessionCookie")
        return (...args) => {
          verifications += 1;
          return value.apply(target, args);
        };
      return value.bind(target);
    },
  });
  await db.collection("identity_agencies").doc(tenantId).set({ name: "Harbor Test Agency", timeZone: "America/Chicago" });
  for (const [key, role] of [["avery", "admin"], ["jamie", "member"]]) {
    const email = `${key}.${run}@harbor-test.example`;
    const password = randomUUID();
    const user = await auth.createUser({ email, password, emailVerified: true });
    await db.collection("identity_users").doc(user.uid).set({ email, tenantId });
    await db.collection("identity_agencies").doc(tenantId).collection("members").doc(user.uid).set({ role, name: key, email, active: true });
    const signedIn = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const { idToken } = await signedIn.json();
    people[key] = { uid: user.uid, cookie: await auth.createSessionCookie(idToken, { expiresIn: 60 * 60 * 1000 }) };
  }
  const first = new SessionCache(60);
  const second = new SessionCache(60);
  const web = express();
  web.use(express.json());
  web.use(createIdentityRouter({ auth, db, sessions: first }));
  const whoami = (_request, response) => response.json({ actor: response.locals.amsActor, expiresAt: response.locals.amsSessionExpiresAt });
  web.get("/first/whoami", createFirebaseAuthenticate({ auth: counting, db, sessions: first }), whoami);
  web.get("/second/whoami", createFirebaseAuthenticate({ auth: counting, db, sessions: second }), whoami);
  web.get("/always/whoami", createFirebaseAuthenticate({ auth: counting, db }), whoami);
  server = web.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await deleteApp(app);
});
const call = (path, who, body) =>
  fetch(url + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${people[who].cookie}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

test("a remembered session is verified once, and carries the real expiry", async () => {
  await tick();
  verifications = 0;
  for (let i = 0; i < 5; i++) {
    const response = await call("/first/whoami", "jamie");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.actor.userId, people.jamie.uid);
    assert.equal(body.actor.tenantId, tenantId);
    const left = body.expiresAt - Date.now() / 1000;
    assert.ok(left > 3500 && left <= 3600, String(left));
  }
  assert.equal(verifications, 1);
  for (let i = 0; i < 3; i++) assert.equal((await call("/always/whoami", "jamie")).status, 200);
  assert.equal(verifications, 4, "without the cache every request is verified");
});

test("deactivation applies at once where it is handled and without the cache; elsewhere it waits out the cache", async () => {
  assert.equal((await call("/second/whoami", "jamie")).status, 200);
  const result = await call(`/identity/members/${people.jamie.uid}/deactivate`, "avery", {});
  assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
  await tick();
  // The instance that handled it forgot Jamie: refused immediately.
  assert.notEqual((await call("/first/whoami", "jamie")).status, 200);
  // No cache: refused immediately.
  assert.notEqual((await call("/always/whoami", "jamie")).status, 200);
  // The documented trade: another instance still trusts what it verified, for up to the
  // configured time (60 seconds here).
  assert.equal((await call("/second/whoami", "jamie")).status, 200);
  // The administrator's own session is untouched.
  assert.equal((await call("/first/whoami", "avery")).status, 200);
});

test("signing out is forgotten at once on the instance that handles it", async () => {
  assert.equal((await call("/first/whoami", "avery")).status, 200);
  assert.equal((await call("/identity/sign-out", "avery", {})).status, 200);
  await tick();
  assert.equal((await call("/first/whoami", "avery")).status, 401);
  assert.equal((await call("/always/whoami", "avery")).status, 401);
});
