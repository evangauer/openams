import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCodeqlResults } from "./check-codeql-results.mjs";

const report = () => ({ version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL" } }, results: [], invocations: [{ executionSuccessful: true }] }] });
test("accepts a completed clean analysis", () => {
  assert.match(checkCodeqlResults(report()), /no findings/);
});
test("rejects findings even if suppressed or informational", () => {
  for (const result of [{ ruleId: "example" }, { level: "note", suppressions: [{ kind: "inSource" }] }]) {
    const value = report();
    value.runs[0].results.push(result);
    assert.throws(() => checkCodeqlResults(value), /finding/);
  }
});
test("rejects absent, incomplete and failed scans", () => {
  for (const value of [null, {}, { version: "2.1.0", runs: [] }])
    assert.throws(() => checkCodeqlResults(value));
  for (const change of [
    (run) => { delete run.results; },
    (run) => { run.tool.driver.name = "Other"; },
    (run) => { delete run.invocations; },
    (run) => { run.invocations = []; },
    (run) => { run.invocations[0].executionSuccessful = false; },
    (run) => { run.invocations[0].toolExecutionNotifications = [{ level: "error" }]; },
  ]) {
    const value = report();
    change(value.runs[0]);
    assert.throws(() => checkCodeqlResults(value));
  }
});
