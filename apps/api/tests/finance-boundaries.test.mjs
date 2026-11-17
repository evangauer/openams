import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AmsListSchema } from "@openams/contracts";
import { AmsService } from "../dist/service.js";
import { backend, openRepository } from "./support/backend.mjs";

async function fixture(t) {
  const repository = openRepository(":memory:");
  t.after(() => repository.close());
  const actor = {
    tenantId: "finance-boundaries",
    userId: "accountant",
    role: "accountant",
    name: "Fictional Accountant",
  };
  // It is already November 12 in UTC, but November 11 in the agency calendar.
  const service = new AmsService({
    repository,
    members: async () => [],
    now: () => new Date("2026-11-12T01:00:00Z"),
    timeZone: async () => "America/New_York",
  });
  const run = (kind, action, data, record, extra = {}) =>
    service.execute(actor, {
      id: randomUUID(),
      kind,
      action,
      data,
      reason: "Fictional accounting review",
      ...(record
        ? { recordId: record.id, expectedVersion: record.version }
        : {}),
      ...extra,
    });
  const createAsAdmin = async (kind, data) =>
    (
      await service.execute(
        { ...actor, role: "admin" },
        {
          id: randomUUID(),
          kind,
          action: "create",
          data,
          reason: "Fictional setup",
        },
      )
    ).records[0];
  const account = await createAsAdmin("accounts", {
    name: "Fictional Ledger Workshop",
  });
  const policy = await createAsAdmin("policies", {
    accountId: account.id,
    number: "FICTIONAL-AGENCY-BILL",
    carrier: "Fictional Mutual",
    line: "General liability",
    billing: "agency",
    effectiveDate: "2026-01-01",
    expirationDate: "2027-01-01",
    premiumCents: 100000,
  });
  let invoice = (
    await run("invoices", "create", {
      accountId: account.id,
      policyId: policy.id,
      number: "FICTIONAL-INVOICE",
      issueDate: "2026-11-01",
      dueDate: "2026-12-01",
      commissionCents: 10000,
      lines: [
        {
          description: "Fictional premium",
          type: "premium",
          amountCents: 100000,
        },
      ],
    })
  ).records[0];
  invoice = (await run("invoices", "invoice.post", {}, invoice)).records.find(
    (r) => r.kind === "invoices",
  );
  const list = async (kind) =>
    (
      await repository.list(
        actor.tenantId,
        kind,
        AmsListSchema.parse({ limit: 100 }),
      )
    ).items;
  return { repository, actor, run, invoice, list };
}
const payment = (kind, date) => ({
  kind,
  date,
  amountCents: 10000,
  method: "ach",
  reference: "FICTIONAL-BANK-REFERENCE",
});

for (const kind of ["receipt", "carrier_payment"]) {
  test(`${backend}: ${kind} cannot record tomorrow's money as posted in the agency calendar`, async (t) => {
    const f = await fixture(t);
    const history = await f.repository.history(f.actor.tenantId);
    const journals = await f.list("journals");
    await assert.rejects(
      f.run(
        "invoices",
        "payment.record",
        payment(kind, "2026-11-12"),
        f.invoice,
      ),
      (error) => error.code === "future_transaction",
    );
    assert.equal(
      (await f.repository.get(f.actor.tenantId, "invoices", f.invoice.id))
        .version,
      f.invoice.version,
    );
    assert.deepEqual(await f.list("payments"), []);
    assert.deepEqual(await f.list("journals"), journals);
    assert.deepEqual(await f.repository.history(f.actor.tenantId), history);
    const actual = await f.run(
      "invoices",
      "payment.record",
      payment(kind, "2026-11-11"),
      f.invoice,
    );
    assert.equal(
      actual.records.find((r) => r.kind === "payments").data.date,
      "2026-11-11",
    );
  });

  test(`${backend}: ${kind} reversal must follow the original date and cannot be future dated`, async (t) => {
    const f = await fixture(t);
    const posted = await f.run(
      "invoices",
      "payment.record",
      payment(kind, "2026-11-10"),
      f.invoice,
    );
    const original = posted.records.find((r) => r.kind === "payments");
    const invoice = posted.records.find((r) => r.kind === "invoices");
    const history = await f.repository.history(f.actor.tenantId);
    for (const date of ["2026-11-09", "2026-11-12"]) {
      await assert.rejects(
        f.run("payments", "payment.reverse", { date }, original),
        (error) => error.code === "invalid_reversal_date",
      );
      assert.equal(
        (await f.repository.get(f.actor.tenantId, "payments", original.id))
          .version,
        original.version,
      );
      assert.equal(
        (await f.repository.get(f.actor.tenantId, "invoices", invoice.id))
          .version,
        invoice.version,
      );
      assert.deepEqual(await f.repository.history(f.actor.tenantId), history);
    }
    const commandId = randomUUID();
    const reversed = await f.run(
      "payments",
      "payment.reverse",
      { date: "2026-11-10" },
      original,
      { id: commandId },
    );
    const replay = await f.run(
      "payments",
      "payment.reverse",
      { date: "2026-11-10" },
      original,
      { id: commandId },
    );
    assert.equal(replay.replayed, true);
    const finalInvoice = reversed.records.find((r) => r.kind === "invoices");
    assert.equal(finalInvoice.data.paidCents, 0);
    assert.equal(finalInvoice.data.carrierPaidCents, 0);
    assert.equal((await f.list("payments")).length, 2);
    for (const journal of await f.list("journals")) {
      assert.equal(
        journal.data.entries.reduce(
          (n, e) => n + e.debitCents - e.creditCents,
          0,
        ),
        0,
      );
    }
  });
}
