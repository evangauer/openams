import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { amsPolicyStatusAt } from "@openams/contracts";
import { AmsService } from "../dist/service.js";
import { openRepository } from "./support/backend.mjs";

for (const adapter of ["sqlite"]) {
  test(`${adapter}: reinstatement keeps cancellation intervals, evidence and historical boundaries`, async (t) => {
    const repository =
      openRepository(":memory:");
    if (adapter === "sqlite") t.after(() => repository.close());
    const actor = {
      tenantId: "history",
      userId: "admin",
      role: "admin",
      name: "Fixture admin",
    };
    const service = new AmsService({
      repository,
      members: async () => [],
      now: () => new Date("2026-11-06T12:00:00Z"),
    });
    const cmd = (kind, action, data, record, extra = {}) =>
      service.execute(actor, {
        id: randomUUID(),
        kind,
        action,
        data,
        reason: "Reviewed carrier evidence",
        ...(record
          ? { recordId: record.id, expectedVersion: record.version }
          : {}),
        ...extra,
      });
    const reject = (promise, code) =>
      assert.rejects(promise, (e) => e.code === code);
    const account = (
      await cmd("accounts", "create", { name: "Reinstatement fixture" })
    ).records[0];
    const draft = (
      await cmd("policies", "create", {
        accountId: account.id,
        number: "HISTORY-1",
        line: "GL",
        carrier: "Fixture",
        effectiveDate: "2026-01-01",
        expirationDate: "2027-01-01",
        premiumCents: 100000,
      })
    ).records[0];
    let policy = (
      await cmd(
        "policies",
        "policy.issue",
        { sourceReference: "Original issued policy" },
        draft,
      )
    ).records[0];
    const cancelled = (
      await cmd(
        "policies",
        "policy.cancel",
        {
          effectiveDate: "2026-11-01",
          sourceReference: "Carrier cancellation #1",
        },
        policy,
      )
    ).records[0];
    await reject(
      cmd(
        "policies",
        "policy.reinstate",
        { sourceReference: "Missing effective date" },
        cancelled,
      ),
      "invalid_request",
    );
    await reject(
      cmd(
        "policies",
        "policy.reinstate",
        { effectiveDate: "2026-10-31", sourceReference: "Before cancellation" },
        cancelled,
      ),
      "date_outside_term",
    );
    await reject(
      cmd(
        "policies",
        "policy.reinstate",
        { effectiveDate: "2027-01-01", sourceReference: "Outside term" },
        cancelled,
      ),
      "date_outside_term",
    );
    const input = { id: randomUUID() };
    const reinstatement = {
      effectiveDate: "2026-11-06",
      sourceReference: "Carrier reinstatement #1",
    };
    const result = await cmd(
      "policies",
      "policy.reinstate",
      reinstatement,
      cancelled,
      input,
    );
    assert.equal(
      (
        await cmd(
          "policies",
          "policy.reinstate",
          reinstatement,
          cancelled,
          input,
        )
      ).replayed,
      true,
    );
    policy = result.records[0];
    assert.equal(policy.data.reinstatements.length, 1);
    assert.equal(
      policy.data.reinstatements[0].cancellationReference,
      "Carrier cancellation #1",
    );
    assert.equal(policy.data.reinstatements[0].recordedBy, "admin");
    assert.equal(policy.data.cancellationDate, null);
    for (const [date, status] of [
      ["2025-12-31", "scheduled"],
      ["2026-10-31", "active"],
      ["2026-11-01", "cancelled"],
      ["2026-11-05", "cancelled"],
      ["2026-11-06", "active"],
      ["2027-01-01", "expired"],
    ])
      assert.equal(amsPolicyStatusAt(policy.data, date), status, date);
    assert.equal(
      (
        await repository.revision(
          "history",
          "policies",
          policy.id,
          cancelled.revision,
        )
      ).data.cancellationDate,
      "2026-11-01",
    );
    await reject(
      cmd("policies", "update", { reinstatements: [] }, policy),
      "immutable_field",
    );
    await reject(
      cmd(
        "policies",
        "update",
        { reinstatements: policy.data.reinstatements },
        draft,
      ),
      "stale_record",
    );
    await reject(
      cmd(
        "policies",
        "policy.endorse",
        {
          effectiveDate: "2026-11-03",
          premiumDeltaCents: 1000,
          sourceReference: "Within cancellation",
        },
        policy,
      ),
      "change_during_cancellation",
    );
    const claim = {
      accountId: account.id,
      policyId: policy.id,
      claimNumber: "FNOL-1",
      dateOfLoss: "2026-11-03",
      reportedDate: "2026-11-06",
      description: "Fictional loss requiring policy review",
    };
    await reject(cmd("claims", "create", claim), "loss_outside_term");
    assert.equal(
      (await cmd("claims", "create", { ...claim, dateOfLoss: "2026-11-06" }))
        .records[0].data.dateOfLoss,
      "2026-11-06",
    );
    await reject(
      cmd(
        "policies",
        "policy.cancel",
        {
          effectiveDate: "2026-11-04",
          sourceReference: "Overlaps recorded reinstatement",
        },
        policy,
      ),
      "invalid_request",
    );
    policy = (
      await cmd(
        "policies",
        "policy.cancel",
        { effectiveDate: "2026-12-01", sourceReference: "Second cancellation" },
        policy,
      )
    ).records[0];
    policy = (
      await cmd(
        "policies",
        "policy.reinstate",
        {
          effectiveDate: "2026-12-03",
          sourceReference: "Second reinstatement",
        },
        policy,
      )
    ).records[0];
    assert.equal(amsPolicyStatusAt(policy.data, "2026-12-02"), "cancelled");
    assert.equal(amsPolicyStatusAt(policy.data, "2026-12-03"), "active");
    assert.equal(policy.data.reinstatements.length, 2);
    // A carrier-confirmed no-lapse reinstatement preserves the event without inventing a gap.
    policy = (
      await cmd(
        "policies",
        "policy.cancel",
        { effectiveDate: "2026-12-10", sourceReference: "Third cancellation" },
        policy,
      )
    ).records[0];
    policy = (
      await cmd(
        "policies",
        "policy.reinstate",
        {
          effectiveDate: "2026-12-10",
          sourceReference: "No-lapse confirmation",
        },
        policy,
      )
    ).records[0];
    assert.equal(amsPolicyStatusAt(policy.data, "2026-12-10"), "active");
    assert.equal(policy.data.reinstatements.length, 3);
    const next = (
      await cmd(
        "policies",
        "policy.renew",
        {
          number: "HISTORY-2",
          effectiveDate: "2027-01-01",
          expirationDate: "2028-01-01",
          premiumCents: 120000,
        },
        policy,
      )
    ).records[0];
    assert.deepEqual(next.data.reinstatements, []);
    assert.equal(next.data.previousPolicyId, policy.id);
    await reject(
      cmd(
        "policies",
        "update",
        { reinstatements: policy.data.reinstatements },
        next,
      ),
      "immutable_field",
    );
    await reject(
      cmd("policies", "create", {
        ...next.data,
        number: "FORGED",
        reinstatements: policy.data.reinstatements,
      }),
      "lifecycle_required",
    );
  });
}
