// Local evaluation launcher: the API and web app on loopback, with durable SQLite
// records and files in a private directory, and a fictional sample agency on demand.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("Use Node 24 for the durable local SQLite adapter.");
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = resolve(
  process.env.AMS_LOCAL_DIRECTORY || join(homedir(), ".openams", "local"),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const tokenFile = join(directory, "development-sessions.json");
let tokens;
try {
  tokens = JSON.parse(await readFile(tokenFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  tokens = Object.fromEntries(
    ["admin", "manager", "member", "accountant", "viewer"].map((role) => [
      role,
      randomBytes(32).toString("hex"),
    ]),
  );
  await writeFile(tokenFile, JSON.stringify(tokens), {
    mode: 0o600,
    flag: "wx",
  });
}
// Pass only what local development needs; never inherit cloud credentials.
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "LANG", "TERM"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
const webPort = process.env.AMS_WEB_PORT || "4500";
Object.assign(env, {
  NODE_ENV: "development",
  AMS_LOCAL_ENABLED: "1",
  AMS_LOCAL_DIRECTORY: directory,
  AMS_LOCAL_TOKENS: JSON.stringify(tokens),
  AMS_LOCAL_PORT: process.env.AMS_LOCAL_PORT || "4510",
  AMS_LOCAL_TIME_ZONE: process.env.AMS_LOCAL_TIME_ZONE || "America/Chicago",
  NEXT_TELEMETRY_DISABLED: "1",
});
env.AMS_LOCAL_API_URL = `http://127.0.0.1:${env.AMS_LOCAL_PORT}`;
const children = [
  spawn(process.execPath, ["dist/local-server.js"], {
    cwd: join(root, "apps/api"),
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  }),
  spawn(
    process.execPath,
    [
      join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      webPort,
    ],
    {
      cwd: join(root, "apps/web"),
      env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    },
  ),
];
console.log(`OpenAMS: http://127.0.0.1:${webPort}`);
console.log(`Local records and files: ${directory}`);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
for (const child of children)
  child.on("exit", (code) => {
    if (code && !stopping) process.exitCode = code;
    else process.exitCode ??= 0;
    stop();
  });
