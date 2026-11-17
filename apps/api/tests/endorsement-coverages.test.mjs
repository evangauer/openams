import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AmsService } from "../dist/service.js";
import { openRepository } from "./support/backend.mjs";

async function fixture(t) {
  const repository = openRepository(":memory:");
  t.after(() => repository.close());
  const actor = { tenantId: "coverage-fixture", userId: "admin", role: "admin", name: "Fictional admin" };
  let clock = "2026-11-12T12:00:00Z";
  const service = new AmsService({ repository, members: async () => [], now: () => new Date(clock) });
  const execute = (kind, action, data, record) => service.execute(actor, {
    id: randomUUID(), kind, action, data, reason: "Fictional carrier endorsement reviewed",
    ...(record ? { recordId: record.id, expectedVersion: record.version } : {}),
  });
  const account = (await execute("accounts", "create", { name: "Fictional Coverage Workshop" })).records[0];
  const original = [{ name: "General liability", limit: "$1,000,000", deductible: "$500", notes: "" }];
  const draft = (await execute("policies", "create", {
    accountId: account.id, number: "FICTIONAL-COVERAGES", line: "General liability", carrier: "Fictional Mutual",
    effectiveDate: "2026-01-01", expirationDate: "2027-01-01", premiumCents: 100000, coverages: original,
  })).records[0];
  const policy = (await execute("policies", "policy.issue", { sourceReference: "FICTIONAL-ISSUE" }, draft)).records[0];
  return { repository, actor, execute, policy, original, advance: () => { clock = "2026-11-13T12:00:00Z"; } };
}

test("premium-only scheduled endorsements retain later reviewed coverage changes", async (t) => {
  const f = await fixture(t);
  let scheduled = (await f.execute("policies", "policy.endorse", {
    effectiveDate: "2026-11-13", premiumDeltaCents: 10000, sourceReference: "FICTIONAL-PREMIUM",
  }, f.policy)).records[0];
  assert.equal(Object.hasOwn(scheduled.data.change, "coverages"), false);
  const coverages = [{ ...f.original[0], limit: "$2,000,000" }];
  let policy = (await f.execute("policies", "policy.endorse", {
    effectiveDate: "2026-11-12", premiumDeltaCents: 0, coverages, sourceReference: "FICTIONAL-COVERAGE",
  }, f.policy)).records[0];
  assert.deepEqual(policy.data.coverages, coverages);
  assert.equal(policy.data.premiumCents, 100000);
  assert.deepEqual((await f.repository.revision(f.actor.tenantId, "policies", policy.id, f.policy.revision)).data.coverages, f.original);
  f.advance();
  await assert.rejects(f.execute("policychanges", "policyChange.apply", {}, scheduled), error => error.code === "stale_policy_change");
  scheduled = (await f.execute("policychanges", "policyChange.review", { policyVersion: policy.version, reviewed: true }, scheduled)).records[0];
  policy = (await f.execute("policychanges", "policyChange.apply", {}, scheduled)).records.find(record => record.kind === "policies");
  assert.deepEqual(policy.data.coverages, coverages);
  assert.equal(policy.data.premiumCents, 110000);
});

test("explicit future coverage replacement waits until due and can record an empty list", async (t) => {
  const f = await fixture(t);
  const scheduled = (await f.execute("policies", "policy.endorse", {
    effectiveDate: "2026-11-13", premiumDeltaCents: 0, coverages: [], sourceReference: "FICTIONAL-REMOVE-COVERAGES",
  }, f.policy)).records[0];
  assert.deepEqual(scheduled.data.change.coverages, []);
  await assert.rejects(f.execute("policychanges", "policyChange.apply", {}, scheduled), error => error.code === "change_not_due");
  assert.equal((await f.repository.get(f.actor.tenantId, "policies", f.policy.id)).version, f.policy.version);
  f.advance();
  const applied = await f.execute("policychanges", "policyChange.apply", {}, scheduled);
  assert.deepEqual(applied.records.find(record => record.kind === "policies").data.coverages, []);
  assert.equal(applied.records.find(record => record.kind === "policychanges").data.status, "applied");
});
