// Firebase-mode launcher: App Hosting (apphosting.yaml runCommand) and the container
// image in deploy/firebase.Dockerfile (docs/cloud-run.md). Starts the records API on
// loopback and the Next.js app on $PORT. Only the web app is reachable from outside the
// container; it forwards an allowlist of paths to the API.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.AMS_AUTH_MODE !== "firebase")
  throw new Error("Set AMS_AUTH_MODE=firebase (see apphosting.yaml).");
const emulated = process.env.AMS_FIREBASE_EMULATORS === "1";
if (emulated && process.env.NODE_ENV === "production")
  throw new Error("Refusing to run production against the Firebase emulators.");
// The public origin: AMS_APP_URL (read at runtime, so one image can serve many
// deployments) wins over NEXT_PUBLIC_APP_URL (App Hosting sets it for build and runtime).
const appUrl = process.env.AMS_APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
// Every non-emulator run is treated as production, whatever NODE_ENV says.
if (!emulated) {
  if (!appUrl) throw new Error("AMS_APP_URL (or NEXT_PUBLIC_APP_URL) is required outside the emulators.");
  for (const name of ["NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY", "AMS_SCHEDULER_SERVICE_ACCOUNT"])
    if (!process.env[name]) throw new Error(`${name} is required outside the emulators.`);
  let protocol;
  try {
    protocol = new URL(appUrl).protocol;
  } catch {
    throw new Error("AMS_APP_URL (or NEXT_PUBLIC_APP_URL) must be a valid URL.");
  }
  if (protocol !== "https:")
    throw new Error("AMS_APP_URL (or NEXT_PUBLIC_APP_URL) must be https outside the emulators.");
  // App Hosting supplies FIREBASE_CONFIG with the default bucket; elsewhere (Cloud Run)
  // there is no default, so the bucket must be named.
  if (!process.env.AMS_STORAGE_BUCKET && !process.env.FIREBASE_CONFIG)
    throw new Error("AMS_STORAGE_BUCKET is required outside Firebase App Hosting.");
}
const root = fileURLToPath(new URL("..", import.meta.url));
const apiPort = process.env.AMS_API_PORT || "4510";
const env = {
  ...process.env,
  AMS_API_PORT: apiPort,
  AMS_API_URL: `http://127.0.0.1:${apiPort}`,
  NEXT_TELEMETRY_DISABLED: "1",
};
const children = new Set();
let stopping = false;
function stop() {
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
function supervise(child) {
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!stopping) process.exitCode = code || 1;
    stop();
  });
  return child;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
const api = supervise(spawn(process.execPath, ["dist/firebase-server.js"], {
  cwd: join(root, "apps/api"),
  env,
  stdio: ["inherit", "inherit", "inherit", "ipc"],
}));
// The public port is the platform's readiness signal. Open it only once the
// API can accept the very first proxied request.
api.once("message", (message) => {
  if (stopping || message !== "listening") return;
  supervise(spawn(
    process.execPath,
    [
      join(root, "node_modules/next/dist/bin/next"),
      emulated ? "dev" : "start",
      "--hostname",
      emulated ? "127.0.0.1" : "0.0.0.0",
      "--port",
      process.env.PORT || "8080",
    ],
    { cwd: join(root, "apps/web"), env, stdio: "inherit" },
  ));
});
