// Local development of the Firebase deployment against the Firebase Emulator Suite.
// Start the emulators first in another terminal:
//   npm run emulators
// then run `npm run dev:firebase`. Sign-in links appear in the emulator log and UI
// (http://127.0.0.1:4000/auth). The demo-* project id never touches Google Cloud.
// Sign in as AMS_ADMIN_EMAIL (default admin@example.com) to set up the agency, then
// invite anyone else from the Team page.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = "demo-openams";
const env = {
  ...process.env,
  NODE_ENV: "development",
  AMS_AUTH_MODE: "firebase",
  AMS_FIREBASE_EMULATORS: "1",
  AMS_ADMIN_EMAIL: process.env.AMS_ADMIN_EMAIL || "admin@example.com",
  GCLOUD_PROJECT: project,
  GOOGLE_CLOUD_PROJECT: project,
  FIREBASE_CONFIG: JSON.stringify({
    projectId: project,
    storageBucket: `${project}.appspot.com`,
  }),
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199",
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${project}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: project,
  NEXT_PUBLIC_FIREBASE_APP_ID: "demo-app-id",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  NEXT_PUBLIC_APP_URL: `http://localhost:${process.env.PORT || "4500"}`,
  PORT: process.env.PORT || "4500",
};
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("firebase-start.mjs", import.meta.url))],
  { env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => (process.exitCode = code ?? 1));
