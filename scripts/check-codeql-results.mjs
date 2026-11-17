import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Fail closed: a missing, incomplete or failed analysis is not a clean scan.
export function checkCodeqlResults(report) {
  if (report?.version !== "2.1.0" || !Array.isArray(report.runs) || !report.runs.length)
    throw new Error("Missing CodeQL SARIF runs.");
  let findings = 0;
  for (const run of report.runs) {
    if (run.tool?.driver?.name !== "CodeQL" || !Array.isArray(run.results))
      throw new Error("Invalid CodeQL results.");
    if (!Array.isArray(run.invocations) || !run.invocations.length ||
        run.invocations.some((invocation) => invocation.executionSuccessful !== true ||
          invocation.toolExecutionNotifications?.some((notice) => notice.level === "error")))
      throw new Error("CodeQL analysis did not complete successfully.");
    findings += run.results.length;
  }
  if (findings) throw new Error(`CodeQL reported ${findings} finding(s); review the retained SARIF report.`);
  return `CodeQL completed ${report.runs.length} run(s) with no findings.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(checkCodeqlResults(JSON.parse(readFileSync(process.argv[2], "utf8"))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
