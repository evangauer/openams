import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AmsService } from "../dist/service.js";
import { openRepository } from "./support/backend.mjs";
import { amsBasisPoints, AmsListSchema } from "@openams/contracts";
for (const adapter of ["sqlite"])
  test(`${adapter}: direct-bill statement matching and posting are versioned, atomic and restart-safe`, async (t) => {
    const repository =
      openRepository(":memory:");
    if (adapter === "sqlite") t.after(() => repository.close());
    const actor = {
      tenantId: "agency-1",
      userId: "admin",
      name: "Fixture admin",
      role: "admin",
    };
    const service = new AmsService({
      repository,
      members: async () => [
        {
          id: "producer",
          name: "Producer",
          email: "p@example.test",
          role: "member",
          active: true,
        },
      ],
      now: () => new Date("2026-11-06T12:00:00Z"),
    });
    const cmd = (kind, action, data, record, extra = {}) =>
      service.execute(actor, {
        id: randomUUID(),
        kind,
        action,
        data,
        reason: "Reviewed fixture",
        ...(record
          ? { recordId: record.id, expectedVersion: record.version }
          : {}),
        ...extra,
      });
    const account = (
      await cmd("accounts", "create", { name: "Fixture Account" })
    ).records[0];
    let policy = (
      await cmd("policies", "create", {
        accountId: account.id,
        number: "GL-1",
        line: "General liability",
        carrier: "Example Carrier",
        effectiveDate: "2026-01-01",
        expirationDate: "2027-01-01",
        premiumCents: 100000,
        commissionBps: 1500,
      })
    ).records[0];
    const issued = await cmd(
      "policies",
      "policy.issue",
      { sourceReference: "Carrier confirmation" },
      policy,
    );
    policy = issued.records.find((r) => r.kind === "policies");
    let commission = issued.records.find((r) => r.kind === "commissions");
    assert.equal(commission.data.expectedCents, 15000);
    const endorsed = await cmd(
      "policies",
      "policy.endorse",
      {
        effectiveDate: "2026-10-01",
        premiumDeltaCents: -10000,
        sourceReference: "Carrier return-premium endorsement",
      },
      policy,
    );
    const negative = endorsed.records.find((r) => r.kind === "commissions");
    assert.equal(negative.data.expectedCents, -1500);
    const rows = [
      {
        id: "row-1",
        policyNumber: "GL-1",
        effectiveDate: "2026-01-01",
        transactionDate: "2026-01-01",
        transaction: "new_business",
        premiumCents: 100000,
        commissionCents: 15000,
      },
      {
        id: "row-2",
        policyNumber: "GL-1",
        effectiveDate: "2026-01-01",
        transactionDate: "2026-10-01",
        transaction: "endorsement",
        premiumCents: -10000,
        commissionCents: -1500,
      },
      {
        id: "row-3",
        policyNumber: "UNMATCHED",
        effectiveDate: "2026-01-01",
        transactionDate: "2026-01-01",
        transaction: "new_business",
        premiumCents: 90000,
        commissionCents: 9999,
      },
    ];
    const input = {
      carrier: "Example Carrier",
      reference: "NOV-STATEMENT",
      statementDate: "2026-11-05",
      sourceSha256: "a".repeat(64),
      rows,
    };
    let statement = (await cmd("statements", "create", input)).records[0];
    await assert.rejects(
      cmd("statements", "create", input),
      (e) => e.code === "duplicate_record",
    );
    await assert.rejects(
      cmd("statements", "update", { rows: [] }, statement),
      (e) => e.code === "immutable_record",
    );
    await assert.rejects(
      cmd(
        "statements",
        "statement.match",
        { rowId: "row-3", commissionId: commission.id },
        statement,
      ),
      (e) => e.code === "statement_match_mismatch",
    );
    statement = (
      await cmd(
        "statements",
        "statement.match",
        { rowId: "row-1", commissionId: commission.id },
        statement,
      )
    ).records[0];
    statement = (
      await cmd(
        "statements",
        "statement.match",
        { rowId: "row-2", commissionId: negative.id },
        statement,
      )
    ).records[0];
    // A changed expected transaction invalidates its reviewed match, and the
    // complete multi-row posting rolls back, including the first row's journal.
    const adjusted = (
      await cmd(
        "commissions",
        "commission.allocate",
        { producerId: "producer", producerShareBps: 4000 },
        negative,
      )
    ).records[0];
    await assert.rejects(
      cmd("statements", "statement.post", {}, statement),
      (e) => e.code === "stale_statement_match",
    );
    assert.equal(
      (await repository.get(actor.tenantId, "commissions", commission.id)).data
        .receivedCents,
      0,
    );
    assert.equal(
      (
        await repository.list(
          actor.tenantId,
          "journals",
          AmsListSchema.parse({}),
        )
      ).items.length,
      0,
    );
    statement = (
      await cmd(
        "statements",
        "statement.match",
        { rowId: "row-2", commissionId: adjusted.id },
        statement,
      )
    ).records[0];
    const id = randomUUID();
    const posted = await cmd("statements", "statement.post", {}, statement, {
      id,
    });
    const replay = await cmd("statements", "statement.post", {}, statement, {
      id,
    });
    assert.equal(replay.replayed, true);
    const final = posted.records.find((r) => r.kind === "statements");
    assert.equal(final.data.status, "partial");
    assert.deepEqual(
      final.data.rows.map((r) => r.status),
      ["posted", "posted", "unmatched"],
    );
    assert.equal(
      (await repository.get(actor.tenantId, "commissions", commission.id)).data
        .receivedCents,
      15000,
    );
    assert.equal(
      (await repository.get(actor.tenantId, "commissions", negative.id)).data
        .receivedCents,
      -1500,
    );
    const journals = (
      await repository.list(
        actor.tenantId,
        "journals",
        AmsListSchema.parse({ limit: 100 }),
      )
    ).items;
    assert.equal(journals.length, 2);
    assert.ok(
      journals.every(
        (r) =>
          r.data.entries.reduce(
            (s, e) => s + e.debitCents - e.creditCents,
            0,
          ) === 0,
      ),
    );
    assert.equal(amsBasisPoints(-101, 5000), -51);
    assert.equal(amsBasisPoints(101, 5000), 51);
  });

for (const adapter of ["sqlite"])
  test(`${adapter}: partial carrier receipts and omitted fields require a versioned review and preserve source dates`, async (t) => {
    const repository =
      openRepository(":memory:");
    if (adapter === "sqlite") t.after(() => repository.close());
    const actor = {
      tenantId: "agency",
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
        reason:
          "Compared source statement with expected new-business transaction",
        ...(record
          ? { recordId: record.id, expectedVersion: record.version }
          : {}),
        ...extra,
      });
    const account = (
      await cmd("accounts", "create", { name: "Partial receipt fixture" })
    ).records[0];
    let policy = (
      await cmd("policies", "create", {
        accountId: account.id,
        number: "PARTIAL-1",
        line: "GL",
        carrier: "Fixture Mutual",
        effectiveDate: "2026-01-01",
        expirationDate: "2027-01-01",
        premiumCents: 100000,
        commissionBps: 1000,
      })
    ).records[0];
    const issued = await cmd(
      "policies",
      "policy.issue",
      { sourceReference: "Fixture carrier confirmation" },
      policy,
    );
    const commission = issued.records.find((row) => row.kind === "commissions");
    const make = async (reference, amount, paidDate = "2026-11-01") =>
      (
        await cmd("statements", "create", {
          carrier: "Fixture Mutual",
          reference,
          statementDate: "2026-11-05",
          sourceSha256: "a".repeat(64),
          rows: [
            {
              id: "row",
              policyNumber: "PARTIAL-1",
              effectiveDate: "2026-01-01",
              paidDate,
              commissionCents: amount,
            },
          ],
        })
      ).records[0];
    let statement = await make("PARTIAL", 4000);
    assert.equal(statement.data.rows[0].transaction, null);
    assert.equal(statement.data.rows[0].premiumCents, null);
    await assert.rejects(
      cmd(
        "statements",
        "statement.match",
        { rowId: "row", commissionId: commission.id },
        statement,
      ),
      (error) => error.code === "statement_review_required",
    );
    const match = {
      rowId: "row",
      commissionId: commission.id,
      reviewedMissingFields: true,
      expectedCommissionVersion: commission.version,
    };
    await assert.rejects(
      cmd("statements", "statement.match", match, statement, { reason: "" }),
      (error) => error.code === "statement_review_required",
    );
    await assert.rejects(
      cmd(
        "statements",
        "statement.match",
        { ...match, expectedCommissionVersion: "f".repeat(64) },
        statement,
      ),
      (error) => error.code === "stale_record",
    );
    statement = (await cmd("statements", "statement.match", match, statement))
      .records[0];
    const postId = randomUUID();
    const posted = await cmd("statements", "statement.post", {}, statement, {
      id: postId,
    });
    assert.equal(
      (await cmd("statements", "statement.post", {}, statement, { id: postId }))
        .replayed,
      true,
    );
    let current = await repository.get(
      actor.tenantId,
      "commissions",
      commission.id,
    );
    assert.equal(current.data.status, "partial");
    assert.equal(current.data.receivedCents, 4000);
    assert.equal(
      posted.records.find((row) => row.kind === "journals").data.date,
      "2026-11-01",
    );
    assert.equal(
      posted.records.find((row) => row.kind === "statements").data.rows[0]
        .premiumCents,
      null,
    );
    const excessive = await make("OVERPAYMENT", 7000);
    await assert.rejects(
      cmd(
        "statements",
        "statement.match",
        { ...match, expectedCommissionVersion: current.version },
        excessive,
      ),
      (error) => error.code === "commission_mismatch",
    );
    const wrongSign = await make("WRONG-SIGN", -6000);
    await assert.rejects(
      cmd(
        "statements",
        "statement.match",
        { ...match, expectedCommissionVersion: current.version },
        wrongSign,
      ),
      (error) => error.code === "commission_mismatch",
    );
    let future = await make("FUTURE", 6000, "2027-01-01");
    future = (
      await cmd(
        "statements",
        "statement.match",
        { ...match, expectedCommissionVersion: current.version },
        future,
      )
    ).records[0];
    await assert.rejects(
      cmd("statements", "statement.post", {}, future),
      (error) => error.code === "future_transaction",
    );
    assert.equal(
      (await repository.get(actor.tenantId, "commissions", commission.id))
        .version,
      current.version,
    );
    let final = await make("REMAINDER", 6000, "2026-11-04");
    final = (
      await cmd(
        "statements",
        "statement.match",
        { ...match, expectedCommissionVersion: current.version },
        final,
      )
    ).records[0];
    await cmd("statements", "statement.post", {}, final);
    current = await repository.get(
      actor.tenantId,
      "commissions",
      commission.id,
    );
    assert.equal(current.data.status, "reconciled");
    assert.equal(current.data.receivedCents, 10000);
  });
