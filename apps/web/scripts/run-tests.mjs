// Runs each regression program in scripts/test-*.ts and fails on the first error.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const programs = readdirSync(new URL(".", import.meta.url))
  .filter((name) => /^test-.*\.ts$/.test(name))
  .sort();
for (const program of programs) {
  const result = spawnSync("npx", ["tsx", `scripts/${program}`], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${program} failed.`);
    process.exit(result.status ?? 1);
  }
}
console.log(`${programs.length} web regression programs passed.`);
