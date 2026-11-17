// Runs inside `firebase emulators:exec` (see `npm run test:firebase`):
// 1. the SQLite/Firestore conformance suite and the Cloud Storage tests;
// 2. the full API suite again with Firestore and Cloud Storage as the backend.
import { spawnSync } from "node:child_process";

if (
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !process.env.FIREBASE_STORAGE_EMULATOR_HOST
) {
  console.error("Run through `npm run test:firebase` so the emulators are up.");
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  ["--test", "tests/firebase/*.test.mjs", "tests/*.test.mjs"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENAMS_TEST_BACKEND: "firebase",
      GCLOUD_PROJECT: "demo-openams",
    },
  },
);
process.exit(result.status ?? 1);
