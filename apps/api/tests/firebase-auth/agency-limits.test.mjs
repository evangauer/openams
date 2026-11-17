// Per-agency quotas against the Firestore emulator: the transactional counters behind the
// daily write quota and the storage quota. Run with
// `npm run test:firebase-auth --workspace @openams/api`. All agencies here are fictional.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  AgencyStorageQuota,
  AgencyWriteQuota,
  firestoreCounters,
} from "../../dist/firebase/agency-limits.js";

if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("Run these tests through `npm run test:firebase-auth` (Firebase emulators).");

let app;
before(() => {
  app = initializeApp({ projectId: "demo-openams-auth" }, `agency-limits-${randomUUID()}`);
});
after(() => deleteApp(app));
const tenant = () => `agency_${randomUUID().replaceAll("-", "")}`;

test("concurrent instances never lease more writes than the daily limit", async () => {
  const db = getFirestore(app);
  const store = firestoreCounters(db);
  const id = tenant();
  const now = () => Date.parse("2026-03-04T12:00:00Z");
  const instances = Array.from(
    { length: 4 },
    () => new AgencyWriteQuota({ store, limit: 30, lease: 5, now }),
  );
  const results = await Promise.all(
    instances.flatMap((instance) => Array.from({ length: 12 }, () => instance.take(id))),
  );
  // A lease an instance has no requests left for still counts (the documented trade-off).
  const granted = results.filter(Boolean).length;
  assert.ok(granted <= 30 && granted > 30 - 4 * 5, `granted ${granted}`);
  const doc = await db.collection("identity_limits").doc(`agency_writes_${id}_2026-03-04`).get();
  assert.equal(doc.get("count"), 30);
});

test("storage reservations are atomic per agency", async () => {
  const db = getFirestore(app);
  const quota = new AgencyStorageQuota({ store: firestoreCounters(db), limitBytes: 100 });
  const id = tenant();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, () => quota.reserve(id, 20)),
  );
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 5);
  for (const refused of outcomes.filter((o) => o.status === "rejected"))
    assert.equal(refused.reason.code, "storage_quota_exceeded");
  await quota.release(id, 40);
  const doc = await db.collection("identity_limits").doc(`agency_storage_${id}`).get();
  assert.equal(doc.get("count"), 60);
});
