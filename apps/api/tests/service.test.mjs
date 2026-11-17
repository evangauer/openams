import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmsService } from "../dist/service.js";
import { openRepository } from "./support/backend.mjs";
import { AmsListSchema } from "@openams/contracts";

const actor = {
  userId: "member-1",
  tenantId: "agency-1",
  role: "admin",
  name: "Fixture Admin",
};
const members = async () => [
  {
    id: "member-1",
    name: "Fixture Admin",
    email: "admin@example.test",
    role: "admin",
    active: true,
  },
  {
    id: "member-2",
    name: "Fixture Member",
    email: "member@example.test",
    role: "member",
    active: true,
  },
];
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ams-domain-"));
  const filename = join(dir, "records.sqlite");
  let repository = openRepository(filename);
  t.after(async () => {
    repository.close();
    await rm(dir, { recursive: true, force: true });
  });
  const service = () =>
    new AmsService({
      repository,
      members,
      now: () => new Date("2026-11-05T15:00:00Z"),
      certificateTemplates: async () => ["b".repeat(64)],
    });
  const execute = (kind, action, data = {}, record, as = actor, extra = {}) =>
    (action === "certificate.prepare"
      ? service().prepareCertificate.bind(service())
      : service().execute.bind(service()))(as, {
      id: randomUUID(),
      kind,
      action,
      data,
      reason: "Fixture reason",
      ...(record
        ? { recordId: record.id, expectedVersion: record.version }
        : {}),
      ...extra,
    });
  const create = async (kind, data, as = actor) =>
    (await execute(kind, "create", data, undefined, as)).records[0];
  const account = await create("accounts", {
    name: "Example Plumbing",
    status: "active",
  });
  const policy = async (overrides = {}) =>
    create("policies", {
      accountId: account.id,
      number: randomUUID(),
      line: "General liability",
      carrier: "Example Carrier",
      effectiveDate: "2026-01-01",
      expirationDate: "2027-01-01",
      premiumCents: 100000,
      ...overrides,
    });
  return {
    get repository() {
      return repository;
    },
    service,
    execute,
    create,
    account,
    policy,
    restart() {
      repository.close();
      repository = openRepository(filename);
    },
  };
}
const rejectsCode = (promise, code) =>
  assert.rejects(promise, (error) => error.code === code);

test("durable records, immutable revisions and idempotency receipts survive restart", async (t) => {
  const f = await fixture(t);
  const input = {
    id: randomUUID(),
    kind: "tasks",
    action: "create",
    data: {
      accountId: f.account.id,
      title: "Review renewal",
      dueDate: "2026-11-10",
    },
    reason: "",
  };
  const result = await f.service().execute(actor, input);
  f.restart();
  assert.equal(
    (await f.repository.get(actor.tenantId, "tasks", result.records[0].id)).data
      .title,
    "Review renewal",
  );
  assert.deepEqual(
    (await f.service().execute(actor, input)).records,
    result.records,
  );
  assert.equal((await f.service().execute(actor, input)).replayed, true);
  assert.equal((await f.repository.history(actor.tenantId)).items.length, 2);
  await rejectsCode(
    f
      .service()
      .execute(actor, { ...input, data: { ...input.data, title: "Changed" } }),
    "idempotency_conflict",
  );
  assert.equal(
    (
      await f.repository.revision(
        actor.tenantId,
        "tasks",
        result.records[0].id,
        1,
      )
    ).version,
    result.records[0].version,
  );
});
test("concurrent edits reject a stale writer without losing either revision or audit atomicity", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled(
    ["First", "Second"].map((name) =>
      f.execute("accounts", "update", { name }, f.account),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "stale_record",
  );
  assert.equal((await f.repository.history(actor.tenantId)).items.length, 2);
  assert.equal(
    (await f.repository.get(actor.tenantId, "accounts", f.account.id)).revision,
    2,
  );
});
test("tenant, role, account-reference and active owner boundaries are enforced", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.repository.get("other-agency", "accounts", f.account.id),
    null,
  );
  await rejectsCode(
    f.create(
      "tasks",
      { accountId: f.account.id, title: "Foreign", dueDate: "2026-11-10" },
      { ...actor, tenantId: "other-agency" },
    ),
    "not_found",
  );
  await rejectsCode(
    f.create(
      "tasks",
      { title: "Denied", dueDate: "2026-11-10" },
      { ...actor, role: "viewer" },
    ),
    "permission_denied",
  );
  await rejectsCode(
    f.create("invoices", {}, { ...actor, role: "member" }),
    "permission_denied",
  );
  await rejectsCode(
    f.create("tasks", {
      title: "Unknown owner",
      dueDate: "2026-11-10",
      ownerId: "other-member",
    }),
    "invalid_owner",
  );
  const other = await f.create("accounts", { name: "Other Account" });
  const policy = await f.policy();
  await rejectsCode(
    f.create("tasks", {
      accountId: other.id,
      policyId: policy.id,
      title: "Wrong account",
      dueDate: "2026-11-10",
    }),
    "account_mismatch",
  );
});
test("policy lifecycle retains terms, source evidence, endorsement history and renewal outcome", async (t) => {
  const f = await fixture(t);
  let policy = await f.policy();
  await rejectsCode(
    f.execute("policies", "update", { status: "active" }, policy),
    "lifecycle_required",
  );
  policy = (
    await f.execute(
      "policies",
      "policy.issue",
      { sourceReference: "Carrier issue 123" },
      policy,
    )
  ).records[0];
  await rejectsCode(
    f.execute("policies", "update", { premiumCents: 99 }, policy),
    "policy_revision_required",
  );
  const endorsement = await f.execute(
    "policies",
    "policy.endorse",
    {
      effectiveDate: "2026-10-01",
      premiumDeltaCents: 5000,
      sourceReference: "Endorsement 01",
    },
    policy,
  );
  policy = endorsement.records[0];
  assert.equal(policy.data.premiumCents, 105000);
  assert.equal(endorsement.audit.details.effectiveDate, "2026-10-01");
  const scheduled = await f.execute(
    "policies",
    "policy.endorse",
    {
      effectiveDate: "2026-12-01",
      premiumDeltaCents: 1000,
      sourceReference: "Future",
    },
    policy,
  );
  assert.equal(scheduled.records[0].kind, "policychanges");
  assert.equal(scheduled.records[0].data.status, "scheduled");
  let next = (
    await f.execute(
      "policies",
      "policy.renew",
      { effectiveDate: "2027-01-01", expirationDate: "2028-01-01" },
      policy,
    )
  ).records[0];
  assert.equal(next.data.previousPolicyId, policy.id);
  assert.equal(next.data.status, "draft");
  let renewal = await f.create("renewals", {
    accountId: f.account.id,
    title: "2027 renewal",
    policyIds: [policy.id],
    expirationDate: "2027-01-01",
  });
  await rejectsCode(
    f.execute(
      "renewals",
      "renewal.close",
      { stage: "renewed", replacementPolicyIds: [next.id] },
      renewal,
    ),
    "replacement_required",
  );
  next = (
    await f.execute(
      "policies",
      "policy.issue",
      { sourceReference: "Renewal issue 2027" },
      next,
    )
  ).records[0];
  renewal = (
    await f.execute(
      "renewals",
      "renewal.close",
      { stage: "renewed", replacementPolicyIds: [next.id] },
      renewal,
    )
  ).records[0];
  assert.equal(renewal.data.stage, "renewed");
  assert.equal(
    (await f.repository.get(actor.tenantId, "policies", policy.id)).data
      .expirationDate,
    "2027-01-01",
  );
  policy = (
    await f.execute(
      "policies",
      "policy.cancel",
      { effectiveDate: "2026-11-01", sourceReference: "Cancel 01" },
      policy,
    )
  ).records[0];
  assert.equal(policy.data.status, "cancelled");
  policy = (
    await f.execute(
      "policies",
      "policy.reinstate",
      { effectiveDate: "2026-11-01", sourceReference: "Reinstate 01" },
      policy,
    )
  ).records[0];
  assert.equal(policy.data.status, "active");
});
test("task completion, service resolution, notes and claims retain their domain rules", async (t) => {
  const f = await fixture(t);
  let task = await f.create("tasks", {
    title: "Call insured",
    dueDate: "2026-11-06",
    accountId: f.account.id,
  });
  task = (await f.execute("tasks", "task.complete", {}, task)).records[0];
  assert.equal(task.data.completedBy, actor.userId);
  task = (await f.execute("tasks", "task.reopen", {}, task)).records[0];
  assert.equal(task.data.completedAt, null);
  const note = await f.create("notes", {
    accountId: f.account.id,
    body: "Called insured",
    occurredAt: "2026-11-05T12:00:00Z",
  });
  await rejectsCode(
    f.execute("notes", "update", { body: "Overwritten" }, note),
    "immutable_record",
  );
  const policy = await f.policy();
  await rejectsCode(
    f.create("claims", {
      accountId: f.account.id,
      policyId: policy.id,
      dateOfLoss: "2025-01-01",
      reportedDate: "2026-11-05",
      description: "Reported loss",
    }),
    "loss_outside_term",
  );
  let claim = await f.create("claims", {
    accountId: f.account.id,
    policyId: policy.id,
    dateOfLoss: "2026-10-01",
    reportedDate: "2026-11-05",
    description: "Reported loss",
  });
  claim = (await f.execute("claims", "update", { paidCents: 2000 }, claim))
    .records[0];
  assert.equal(claim.data.paidCents, 2000);
});
test("agency-bill invoice posting, partial receipt, remittance and reversals balance without duplicates", async (t) => {
  const f = await fixture(t);
  const policy = await f.policy({ billing: "agency" });
  let invoice = await f.create("invoices", {
    accountId: f.account.id,
    policyId: policy.id,
    number: "INV-001",
    issueDate: "2026-11-01",
    dueDate: "2026-12-01",
    commissionCents: 15000,
    lines: [
      { description: "Premium", type: "premium", amountCents: 100000 },
      { description: "Tax", type: "tax", amountCents: 5000 },
      { description: "Fee", type: "fee", amountCents: 1000 },
    ],
  });
  const posted = await f.execute("invoices", "invoice.post", {}, invoice);
  invoice = posted.records.find((r) => r.kind === "invoices");
  assert.equal(posted.records.filter((r) => r.kind === "journals").length, 1);
  await rejectsCode(
    f.execute("invoices", "update", { number: "Rewrite" }, invoice),
    "invoice_posted",
  );
  const input = {
    id: randomUUID(),
    kind: "invoices",
    action: "payment.record",
    recordId: invoice.id,
    expectedVersion: invoice.version,
    data: {
      kind: "receipt",
      amountCents: 106000,
      date: "2026-11-05",
      method: "ach",
      reference: "Bank deposit 1",
    },
    reason: "",
  };
  const receipt = await f.service().execute(actor, input);
  assert.equal((await f.service().execute(actor, input)).replayed, true);
  invoice = receipt.records.find((r) => r.kind === "invoices");
  await rejectsCode(
    f.execute(
      "invoices",
      "payment.record",
      { ...input.data, amountCents: 1 },
      invoice,
    ),
    "overpayment",
  );
  const payment = receipt.records.find((r) => r.kind === "payments");
  const reversed = await f.execute(
    "payments",
    "payment.reverse",
    { date: "2026-11-05" },
    payment,
  );
  invoice = reversed.records.find((r) => r.kind === "invoices");
  assert.equal(invoice.data.paidCents, 0);
  await rejectsCode(
    f.execute(
      "payments",
      "payment.reverse",
      { date: "2026-11-05" },
      reversed.records.find((r) => r.id === payment.id),
    ),
    "already_reversed",
  );
  const voided = await f.execute("invoices", "invoice.void", {}, invoice);
  assert.equal(voided.records[0].data.status, "void");
  const journals = (
    await f.repository.list(
      actor.tenantId,
      "journals",
      AmsListSchema.parse({ limit: 100 }),
    )
  ).items;
  const byAccount = {};
  for (const journal of journals) {
    assert.equal(
      journal.data.entries.reduce(
        (sum, e) => sum + e.debitCents - e.creditCents,
        0,
      ),
      0,
    );
    for (const e of journal.data.entries)
      byAccount[e.ledgerAccount] =
        (byAccount[e.ledgerAccount] || 0) + e.debitCents - e.creditCents;
  }
  assert.ok(Object.values(byAccount).every((value) => value === 0));
});
test("invalid posting rolls back record, uniqueness key, audit and receipt together", async (t) => {
  const f = await fixture(t);
  const before = (await f.repository.history(actor.tenantId)).items.length;
  await assert.rejects(
    f.repository.transact(actor.tenantId, async (tx) => {
      const record = { ...f.account, id: "rollback-account", revision: 1 };
      tx.put(record);
      await tx.unique("rollback-key", record.id);
      throw new Error("forced failure");
    }),
    /forced failure/,
  );
  assert.equal(
    await f.repository.get(actor.tenantId, "accounts", "rollback-account"),
    null,
  );
  assert.equal(
    (await f.repository.history(actor.tenantId)).items.length,
    before,
  );
  await f.repository.transact(actor.tenantId, (tx) =>
    tx.unique("rollback-key", "replacement"),
  );
});
test("direct-bill reconciliation supports partial receipt and rejects duplicate income via agency bill", async (t) => {
  const f = await fixture(t);
  const policy = await f.policy();
  let commission = await f.create("commissions", {
    accountId: f.account.id,
    policyId: policy.id,
    carrier: "Example Carrier",
    transaction: "new_business",
    transactionDate: "2026-11-01",
    premiumCents: 100000,
    expectedCents: 15000,
  });
  commission = (
    await f.execute(
      "commissions",
      "commission.receive",
      { amountCents: 10000, date: "2026-11-05", statementReference: "NOV-1" },
      commission,
    )
  ).records[0];
  assert.equal(commission.data.status, "partial");
  commission = (
    await f.execute(
      "commissions",
      "commission.receive",
      { amountCents: 5000, date: "2026-11-05", statementReference: "NOV-2" },
      commission,
    )
  ).records[0];
  assert.equal(commission.data.status, "reconciled");
  await rejectsCode(
    f.execute(
      "commissions",
      "commission.receive",
      { amountCents: 1, date: "2026-11-05", statementReference: "NOV-3" },
      commission,
    ),
    "commission_mismatch",
  );
});
test("pagination stays tenant-bound and duplicate identities are rejected", async (t) => {
  const f = await fixture(t);
  await f.create("accounts", { name: "Second" });
  const first = await f.repository.list(
    actor.tenantId,
    "accounts",
    AmsListSchema.parse({ limit: 1 }),
  );
  assert.ok(first.nextCursor);
  await rejectsCode(
    f.repository.list(
      "other-agency",
      "accounts",
      AmsListSchema.parse({ limit: 1, cursor: first.nextCursor }),
    ),
    "invalid_cursor",
  );
  const second = await f.repository.list(
    actor.tenantId,
    "accounts",
    AmsListSchema.parse({ limit: 1, cursor: first.nextCursor }),
  );
  assert.notEqual(first.items[0].id, second.items[0].id);
  const policy = await f.policy({ number: "UNIQUE-TERM" });
  await rejectsCode(
    f.policy({ number: policy.data.number }),
    "duplicate_record",
  );
});

test("prepared certificates pin source versions, reject stale issuance, and invalidate on request edits", async (t) => {
  const f = await fixture(t);
  let policy = await f.policy();
  policy = (
    await f.execute(
      "policies",
      "policy.issue",
      { sourceReference: "Fixture policy" },
      policy,
    )
  ).records[0];
  const document = (
    await f.service().createDocument(actor, {
      id: randomUUID(),
      kind: "documents",
      action: "create",
      reason: "Fixture",
      data: {
        accountId: f.account.id,
        name: "certificate.pdf",
        mediaType: "application/pdf",
        bytes: 100,
        sha256: "a".repeat(64),
        storageKey: "fixture",
        category: "certificate",
      },
    })
  ).records[0];
  let certificate = await f.create("certificates", {
    accountId: f.account.id,
    holderName: "Fixture Holder",
    requestedDate: "2026-11-05",
    policyIds: [policy.id],
  });
  const preparation = {
    formId: "acord25",
    templateSha256: "b".repeat(64),
    accountVersion: f.account.version,
    policyVersions: [{ id: policy.id, version: policy.version }],
    fields: { INSURED: f.account.data.name },
  };
  await rejectsCode(
    f.execute(
      "certificates",
      "certificate.prepare",
      {
        documentId: document.id,
        preparation: { ...preparation, accountVersion: "stale" },
      },
      certificate,
    ),
    "certificate_sources_changed",
  );
  certificate = (
    await f.execute(
      "certificates",
      "certificate.prepare",
      { documentId: document.id, preparation },
      certificate,
    )
  ).records[0];
  assert.equal(certificate.data.status, "review");
  assert.equal(certificate.data.documentId, document.id);
  const unapproved = new AmsService({
    repository: f.repository,
    members,
    now: () => new Date("2026-11-05T15:00:00Z"),
  });
  await rejectsCode(
    unapproved.execute(actor, {
      id: randomUUID(),
      kind: "certificates",
      action: "certificate.issue",
      recordId: certificate.id,
      expectedVersion: certificate.version,
      reason: "Fixture",
      data: { documentId: document.id, reviewed: true },
    }),
    "certificate_template_not_approved",
  );
  const changed = (
    await f.execute(
      "accounts",
      "update",
      { name: "Updated legal name" },
      f.account,
    )
  ).records[0];
  await rejectsCode(
    f.execute(
      "certificates",
      "certificate.issue",
      { documentId: document.id, reviewed: true },
      certificate,
    ),
    "certificate_sources_changed",
  );
  certificate = (
    await f.execute(
      "certificates",
      "certificate.prepare",
      {
        documentId: document.id,
        preparation: { ...preparation, accountVersion: changed.version },
      },
      certificate,
    )
  ).records[0];
  certificate = (
    await f.execute(
      "certificates",
      "update",
      { description: "New holder instructions" },
      certificate,
    )
  ).records[0];
  assert.equal(certificate.data.preparation, null);
  assert.equal(certificate.data.documentId, null);
  assert.equal(certificate.data.status, "requested");
  await rejectsCode(
    f.execute("certificates", "update", { preparation }, certificate),
    "immutable_field",
  );
  certificate = (
    await f.execute(
      "certificates",
      "certificate.prepare",
      {
        documentId: document.id,
        preparation: { ...preparation, accountVersion: changed.version },
      },
      certificate,
    )
  ).records[0];
  certificate = (
    await f.execute(
      "certificates",
      "certificate.issue",
      { documentId: document.id, reviewed: true },
      certificate,
    )
  ).records[0];
  assert.equal(certificate.data.status, "issued");
  assert.equal(certificate.data.policySnapshots[0].version, policy.version);
  await rejectsCode(
    f.execute(
      "certificates",
      "certificate.prepare",
      { documentId: document.id, preparation },
      certificate,
    ),
    "certificate_finalized",
  );
});
