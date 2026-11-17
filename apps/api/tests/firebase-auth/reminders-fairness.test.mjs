// The reminder run is fair across agencies: each gets a bounded share per pass, and a run
// that runs out of time resumes after the last agency it served. Firestore emulator only;
// the reminder work itself is a stand-in. All agencies here are fictional.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { runRemindersForAllAgencies } from "../../dist/firebase/scheduler.js";

const PROJECT = "demo-openams-auth";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!FIRESTORE_HOST) throw new Error("Run these tests through `npm run test:firebase-auth` (Firebase emulators).");
let app;
before(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  app = initializeApp({ projectId: PROJECT }, `reminders-test-${randomUUID()}`);
  const db = getFirestore(app);
  for (const id of ["agency_a", "agency_b", "agency_c", "agency_d"]) await db.collection("identity_agencies").doc(id).set({ name: id });
});
after(() => deleteApp(app));

/** A stand-in service: agency_a always has more due work; the others have one batch each. */
function fakeService(calls) {
  return () => ({
    async processDueReminders(tenantId) {
      calls.push(tenantId);
      return { processed: 1, conflicts: 0, more: tenantId === "agency_a" };
    },
  });
}

test("a busy agency can't take the whole run", async () => {
  const calls = [];
  const result = await runRemindersForAllAgencies({ db: getFirestore(app), service: fakeService(calls), roundsPerAgency: 3 });
  assert.equal(result.incomplete, false);
  assert.deepEqual(calls, ["agency_a", "agency_a", "agency_a", "agency_b", "agency_c", "agency_d"]);
});

test("a run that runs out of time resumes after the last agency it served", async () => {
  const db = getFirestore(app);
  // Simulate an earlier run that stopped after agency_b.
  await db.collection("identity_limits").doc("reminders_cursor").set({ after: "agency_b" });
  const calls = [];
  await runRemindersForAllAgencies({ db, service: fakeService(calls), roundsPerAgency: 1 });
  assert.deepEqual(calls, ["agency_c", "agency_d", "agency_a", "agency_b"]);
  assert.equal((await db.collection("identity_limits").doc("reminders_cursor").get()).get("after"), null);

  // Out of time immediately: nothing served, and the saved position doesn't move forward.
  await db.collection("identity_limits").doc("reminders_cursor").set({ after: "agency_c" });
  const none = [];
  const stopped = await runRemindersForAllAgencies({ db, service: fakeService(none), budgetMs: -1 });
  assert.equal(stopped.incomplete, true);
  assert.deepEqual(none, []);
  assert.equal((await db.collection("identity_limits").doc("reminders_cursor").get()).get("after"), "agency_c");
});
