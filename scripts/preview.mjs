// Hosted preview launcher (Dockerfile). Runs the evaluation build in production mode:
// the API on loopback with fictional data in a scratch directory, and the web app on
// $PORT. Two ways to run it:
// - Private preview (the default): every web request must carry a valid Google IAP
//   assertion for the configured audience (apps/web/src/lib/server/iap.ts), so it only
//   runs behind IAP. docs/hosted-preview.md.
// - Public demo (AMS_PREVIEW=public): open to anyone; each browser gets a private
//   sandbox of the fictional agency that is deleted after a day. docs/public-demo.md.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const publicDemo = process.env.AMS_PREVIEW === "public";
const audience = process.env.AMS_PREVIEW_IAP_AUDIENCE;
if (!publicDemo && (!audience || !/^\/projects\/\d+\/(locations|global)\//.test(audience)))
  throw new Error(
    "Set AMS_PREVIEW_IAP_AUDIENCE to the service's IAP audience, or AMS_PREVIEW=public for the public demo.",
  );
const root = fileURLToPath(new URL("..", import.meta.url));
// The public demo always starts empty: sandboxes live in memory, so records left by an
// earlier run would belong to nobody.
const directory = publicDemo
  ? await mkdtemp(join(tmpdir(), "openams-demo-"))
  : process.env.AMS_LOCAL_DIRECTORY || "/tmp/openams-preview";
await mkdir(directory, { recursive: true, mode: 0o700 });
const tokens = Object.fromEntries(
  ["admin", "manager", "member", "accountant", "viewer"].map((role) => [
    role,
    randomBytes(32).toString("hex"),
  ]),
);
await writeFile(join(directory, "development-sessions.json"), JSON.stringify(tokens), {
  mode: 0o600,
});
const apiPort = process.env.AMS_LOCAL_PORT || "4510";
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "LANG"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
Object.assign(env, {
  NODE_ENV: "production",
  ...(publicDemo
    ? {
        AMS_PREVIEW: "public",
        ...Object.fromEntries(
          [
            "AMS_DEMO_HOURS",
            "AMS_DEMO_MAX_SANDBOXES",
            "AMS_DEMO_STARTS_PER_MINUTE",
            "AMS_DEMO_LINK_URL",
            "AMS_DEMO_LINK_LABEL",
          ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
        ),
      }
    : { AMS_PREVIEW: "iap", AMS_PREVIEW_IAP_AUDIENCE: audience }),
  AMS_LOCAL_ENABLED: "1",
  AMS_LOCAL_DIRECTORY: directory,
  AMS_LOCAL_TOKENS: JSON.stringify(tokens),
  AMS_LOCAL_PORT: apiPort,
  AMS_LOCAL_API_URL: `http://127.0.0.1:${apiPort}`,
  AMS_LOCAL_TIME_ZONE: process.env.AMS_LOCAL_TIME_ZONE || "America/New_York",
  NEXT_TELEMETRY_DISABLED: "1",
});
const children = [
  spawn(process.execPath, ["dist/local-server.js"], {
    cwd: join(root, "apps/api"),
    env,
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    [
      join(root, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "0.0.0.0",
      "--port",
      process.env.PORT || "8080",
    ],
    { cwd: join(root, "apps/web"), env, stdio: "inherit" },
  ),
];
const stop = () => children.forEach((child) => child.kill("SIGTERM"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
for (const child of children)
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
    stop();
  });
