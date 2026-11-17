import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AmsService } from "../dist/service.js";
import { openRepository } from "./support/backend.mjs";
import { AmsListSchema } from "@openams/contracts";

test("claim dates describe a loss already reported on the agency calendar", async (t) => {
  const repository = openRepository(":memory:");
  t.after(() => repository.close());
  const actor = { tenantId: "claim-dates", userId: "admin", role: "admin", name: "Fictional admin" };
  const service = new AmsService({
    repository, members: async () => [],
    now: () => new Date("2026-11-13T01:00:00Z"),
    timeZone: async () => "America/New_York",
  });
  const run = (kind, action, data, record) => service.execute(actor, {
    id: randomUUID(), kind, action, data, reason: "Fictional claim date verification",
    ...(record ? { recordId: record.id, expectedVersion: record.version } : {}),
  });
  const account = (await run("accounts", "create", { name: "Fictional Claim Workshop" })).records[0];
  const policy = (await run("policies", "create", {
    accountId: account.id, number: "FICTIONAL-CLAIM-DATES", line: "General liability", carrier: "Fictional Mutual",
    effectiveDate: "2026-01-01", expirationDate: "2027-01-01", premiumCents: 100000,
  })).records[0];
  const data = { accountId: account.id, policyId: policy.id, dateOfLoss: "2026-11-12", reportedDate: "2026-11-12", description: "Fictional loss notice" };
  for (const [dates, code] of [
    [{ dateOfLoss: "2026-11-13", reportedDate: "2026-11-13" }, "future_claim_date"],
    [{ reportedDate: "2026-11-13" }, "future_claim_date"],
    [{ reportedDate: "2026-11-11" }, "invalid_claim_dates"],
  ]) {
    await assert.rejects(run("claims", "create", { ...data, ...dates }), error => error.code === code);
    assert.equal((await repository.list(actor.tenantId, "claims", AmsListSchema.parse({}))).items.length, 0);
  }
  const claim = (await run("claims", "create", data)).records[0];
  for (const [patch, code] of [
    [{ dateOfLoss: "2026-11-13" }, "future_claim_date"],
    [{ reportedDate: "2026-11-11" }, "invalid_claim_dates"],
  ]) {
    await assert.rejects(run("claims", "update", patch, claim), error => error.code === code);
    assert.equal((await repository.get(actor.tenantId, "claims", claim.id)).version, claim.version);
  }
  const changed = (await run("claims", "update", { dateOfLoss: "2026-11-11", reportedDate: "2026-11-12" }, claim)).records[0];
  assert.equal(changed.data.reportedDate, "2026-11-12");
  assert.equal(changed.revision, claim.revision + 1);
});
