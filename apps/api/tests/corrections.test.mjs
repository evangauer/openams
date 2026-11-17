import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AmsService } from "../dist/service.js";
import { openRepository } from "./support/backend.mjs";
import {
  amsPolicyStatusAt,
  amsCalendarDate,
  AmsTimeZone,
} from "@openams/contracts";

test("agency calendar boundaries keep tomorrow's endorsements and receipts in the future after UTC midnight", async (t) => {
  assert.equal(
    amsCalendarDate(new Date("2026-11-07T01:00:00Z"), "America/Chicago"),
    "2026-11-06",
  );
  assert.equal(
    amsCalendarDate(new Date("2026-03-08T05:59:59Z"), "America/Chicago"),
    "2026-03-07",
  );
  assert.equal(
    amsCalendarDate(new Date("2026-03-08T06:00:00Z"), "America/Chicago"),
    "2026-03-08",
  );
  assert.equal(
    amsCalendarDate(new Date("2026-11-01T05:00:00Z"), "America/Chicago"),
    "2026-11-01",
  );
  assert.equal(AmsTimeZone.safeParse("Unknown/Agency").success, false);
  const repository = openRepository(":memory:");
  t.after(() => repository.close());
  const actor = {
    tenantId: "calendar-fixture",
    userId: "admin",
    role: "admin",
    name: "Admin",
  };
  let now = "2026-11-07T01:00:00Z";
  const service = new AmsService({
    repository,
    members: async () => [],
    now: () => new Date(now),
    timeZone: async () => "America/Chicago",
  });
  const cmd = (kind, action, data, record) =>
    service.execute(actor, {
      id: randomUUID(),
      kind,
      action,
      data,
      reason: "Calendar fixture",
      ...(record
        ? { recordId: record.id, expectedVersion: record.version }
        : {}),
    });
  const account = (
    await cmd("accounts", "create", { name: "Calendar fixture" })
  ).records[0];
  const draft = (
    await cmd("policies", "create", {
      accountId: account.id,
      number: "DATE",
      line: "GL",
      carrier: "Fixture",
      effectiveDate: "2026-01-01",
      expirationDate: "2027-01-01",
      premiumCents: 100000,
      commissionBps: 1000,
    })
  ).records[0];
  const issued = await cmd(
    "policies",
    "policy.issue",
    { sourceReference: "Fixture issue" },
    draft,
  );
  const policy = issued.records.find((r) => r.kind === "policies"),
    commission = issued.records.find((r) => r.kind === "commissions");
  const queued = (
    await cmd(
      "policies",
      "policy.endorse",
      {
        effectiveDate: "2026-11-07",
        premiumDeltaCents: 10000,
        sourceReference: "Tomorrow",
      },
      policy,
    )
  ).records[0];
  assert.equal(queued.kind, "policychanges");
  assert.equal(queued.createdAt, "2026-11-07T01:00:00.000Z");
  await assert.rejects(
    cmd("policychanges", "policyChange.apply", {}, queued),
    (e) => e.code === "change_not_due",
  );
  await assert.rejects(
    cmd(
      "commissions",
      "commission.receive",
      {
        date: "2026-11-07",
        amountCents: 10000,
        statementReference: "Tomorrow",
      },
      commission,
    ),
    (e) => e.code === "future_transaction",
  );
  await assert.rejects(
    cmd(
      "policies",
      "policy.nonrenew",
      { noticeDate: "2026-11-07", sourceReference: "Tomorrow" },
      policy,
    ),
    (e) => e.code === "future_notice",
  );
  assert.equal(
    amsPolicyStatusAt(
      { ...policy.data, status: "cancelled", cancellationDate: "2026-11-07" },
      amsCalendarDate(new Date(now), "America/Chicago"),
    ),
    "active",
  );
  now = "2026-11-07T06:00:00Z";
  const applied = await cmd("policychanges", "policyChange.apply", {}, queued);
  assert.equal(
    applied.records.find((r) => r.kind === "policies").data.premiumCents,
    110000,
  );
});
for (const adapter of ["sqlite"])
  test(`${adapter}: linked commission corrections and unique reversals preserve financial history`, async (t) => {
    const repository =
      openRepository(":memory:");
    if (adapter === "sqlite") t.after(() => repository.close());
    const actor = {
      tenantId: "agency",
      userId: "admin",
      name: "Admin",
      role: "admin",
    };
    let clock = "2026-11-06T12:00:00Z";
    const service = new AmsService({
      repository,
      members: async () => [],
      now: () => new Date(clock),
    });
    const command = (kind, action, data = {}, record, extra = {}) => ({
      id: randomUUID(),
      kind,
      action,
      data,
      reason: "Fixture correction evidence",
      ...(record
        ? { recordId: record.id, expectedVersion: record.version }
        : {}),
      ...extra,
    });
    const cmd = (...args) => service.execute(actor, command(...args));
    const account = (await cmd("accounts", "create", { name: "Fixture" }))
      .records[0];
    let policy = (
      await cmd("policies", "create", {
        accountId: account.id,
        number: "TEST-1",
        line: "GL",
        carrier: "Fixture Carrier",
        effectiveDate: "2026-01-01",
        expirationDate: "2027-01-01",
        premiumCents: 100000,
        commissionBps: 1500,
      })
    ).records[0];
    const issued = await cmd(
      "policies",
      "policy.issue",
      { sourceReference: "Carrier fixture" },
      policy,
    );
    policy = issued.records.find((r) => r.kind === "policies");
    let commission = issued.records.find((r) => r.kind === "commissions");
    const receipt = await cmd(
      "commissions",
      "commission.receive",
      { amountCents: 15000, date: "2026-11-01", statementReference: "ST-1" },
      commission,
    );
    commission = receipt.records.find((r) => r.kind === "commissions");
    const posting = receipt.records.find((r) => r.kind === "journals");
    await assert.rejects(
      cmd(
        "journals",
        "journal.reverseCommission",
        { date: "2026-10-31", sourceReference: "Correction" },
        posting,
      ),
      (e) => e.code === "invalid_reversal_date",
    );
    const reverse = command(
      "journals",
      "journal.reverseCommission",
      { date: "2026-11-06", sourceReference: "Correct wrong receipt" },
      posting,
    );
    const result = await service.execute(actor, reverse);
    assert.equal((await service.execute(actor, reverse)).replayed, true);
    await assert.rejects(
      service.execute(actor, { ...reverse, id: randomUUID() }),
      (e) => e.code === "duplicate_record",
    );
    const journal = result.records.find((r) => r.kind === "journals");
    assert.equal(journal.data.reversalOf, posting.id);
    assert.equal(
      journal.data.entries.reduce(
        (v, e) => v + e.debitCents - e.creditCents,
        0,
      ),
      0,
    );
    assert.deepEqual(
      (await repository.get("agency", "journals", posting.id)).data,
      posting.data,
    );
    commission = result.records.find((r) => r.kind === "commissions");
    assert.equal(commission.data.receivedCents, 0);
    await assert.rejects(
      cmd("commissions", "update", { expectedCents: 13000 }, commission),
      (e) => e.code === "commission_posted",
    );
    const adjustment = (
      await cmd(
        "commissions",
        "commission.adjust",
        {
          date: "2026-11-06",
          premiumDeltaCents: -10000,
          commissionDeltaCents: -1500,
          sourceReference: "Carrier return commission",
        },
        commission,
      )
    ).records[0];
    assert.equal(adjustment.data.adjustsCommissionId, commission.id);
    assert.equal(adjustment.data.transaction, "adjustment");
    const negative = await cmd(
      "commissions",
      "commission.receive",
      { amountCents: -1500, date: "2026-11-06", statementReference: "ST-2" },
      adjustment,
    );
    const negJournal = negative.records.find((r) => r.kind === "journals");
    const undo = await cmd(
      "journals",
      "journal.reverseCommission",
      { date: "2026-11-06", sourceReference: "Incorrect return posting" },
      negJournal,
    );
    assert.equal(
      undo.records.find((r) => r.kind === "commissions").data.receivedCents,
      0,
    );
    await assert.rejects(
      service.execute({ ...actor, role: "member" }, reverse),
      (e) => e.code === "permission_denied",
    );
    await assert.rejects(
      service.execute({ ...actor, tenantId: "other" }, reverse),
      (e) => e.code === "not_found",
    );
    // Future cancellation and nonrenewal record notices, not an immediate loss of coverage.
    policy = (
      await cmd(
        "policies",
        "policy.nonrenew",
        { noticeDate: "2026-11-06", sourceReference: "Carrier notice" },
        policy,
      )
    ).records[0];
    assert.equal(amsPolicyStatusAt(policy.data, "2026-11-06"), "active");
    assert.equal(amsPolicyStatusAt(policy.data, "2027-01-01"), "nonrenewed");
    const noticed = policy;
    policy = (
      await cmd(
        "policies",
        "policy.withdrawNonrenewal",
        { sourceReference: "Carrier withdrawn" },
        policy,
      )
    ).records[0];
    assert.equal(policy.data.nonrenewal, null);
    assert.ok(
      (
        await repository.revision(
          "agency",
          "policies",
          noticed.id,
          noticed.revision,
        )
      ).data.nonrenewal,
    );
    policy = (
      await cmd(
        "policies",
        "policy.cancel",
        {
          effectiveDate: "2026-12-01",
          sourceReference: "Carrier cancellation",
        },
        policy,
      )
    ).records[0];
    assert.equal(amsPolicyStatusAt(policy.data, "2026-11-30"), "active");
    assert.equal(amsPolicyStatusAt(policy.data, "2026-12-01"), "cancelled");
    assert.equal(
      amsPolicyStatusAt(
        {
          ...policy.data,
          status: "active",
          cancellationDate: null,
          effectiveDate: "2026-12-01",
        },
        "2026-11-06",
      ),
      "scheduled",
    );
    policy = (
      await cmd(
        "policies",
        "policy.reinstate",
        {
          effectiveDate: "2026-12-01",
          sourceReference: "Carrier reinstatement",
        },
        policy,
      )
    ).records[0];
    let change = (
      await cmd(
        "policies",
        "policy.endorse",
        {
          effectiveDate: "2026-12-01",
          premiumDeltaCents: 20000,
          sourceReference: "Future endorsement",
        },
        policy,
      )
    ).records[0];
    assert.equal(change.kind, "policychanges");
    assert.equal(
      (await repository.get("agency", "policies", policy.id)).data.premiumCents,
      100000,
    );
    await assert.rejects(
      cmd("policychanges", "policyChange.apply", {}, change),
      (e) => e.code === "change_not_due",
    );
    clock = "2026-12-01T12:00:00Z";
    policy = (
      await cmd(
        "policies",
        "policy.endorse",
        {
          effectiveDate: "2026-11-15",
          premiumDeltaCents: 5000,
          sourceReference: "Intervening endorsement",
        },
        policy,
      )
    ).records[0];
    await assert.rejects(
      cmd("policychanges", "policyChange.apply", {}, change),
      (e) => e.code === "stale_policy_change",
    );
    await assert.rejects(
      cmd(
        "policychanges",
        "policyChange.review",
        { policyVersion: "stale", reviewed: true },
        change,
      ),
      (e) => e.code === "stale_policy_change",
    );
    change = (
      await cmd(
        "policychanges",
        "policyChange.review",
        { policyVersion: policy.version, reviewed: true },
        change,
      )
    ).records[0];
    const apply = command("policychanges", "policyChange.apply", {}, change);
    const applied = await service.execute(actor, apply);
    assert.equal(
      applied.records.find((r) => r.kind === "policies").data.premiumCents,
      125000,
    );
    assert.equal(
      applied.records.find((r) => r.kind === "commissions").data.expectedCents,
      3000,
    );
    assert.equal(
      applied.records.find((r) => r.kind === "policychanges").data.status,
      "applied",
    );
    assert.equal((await service.execute(actor, apply)).replayed, true);
    await assert.rejects(
      cmd(
        "policychanges",
        "update",
        { status: "scheduled" },
        applied.records.find((r) => r.kind === "policychanges"),
      ),
      (e) => e.code === "immutable_record",
    );
  });
