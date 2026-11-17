// Firebase App Hosting build (apphosting.yaml buildCommand).
// The Node.js buildpack rewrites package.json to add its own build script and drops the
// "workspaces" field, so a plain `npm run build` fails with "No workspaces found" and its
// install skips the workspace packages. Restore the workspace list from package-lock.json, install every
// workspace (with dev dependencies, which the build needs), then build.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// The lockfile is untouched by the buildpack and records the repository's workspaces.
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const WORKSPACES = lock.packages?.[""]?.workspaces;
if (!Array.isArray(WORKSPACES) || WORKSPACES.length === 0)
  throw new Error("package-lock.json lists no workspaces; regenerate it with npm install.");
if (JSON.stringify(manifest.workspaces) !== JSON.stringify(WORKSPACES)) {
  console.log("Restoring the npm workspaces field removed by the buildpack.");
  manifest.workspaces = WORKSPACES;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(args) {
  console.log(`> npm ${args.join(" ")}`);
  const result = spawnSync("npm", args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(["ci", "--include=dev", "--no-audit", "--no-fund"]);
run(["run", "build"]);
