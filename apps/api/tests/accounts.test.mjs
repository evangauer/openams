import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmsService } from "../dist/service.js";
import { openRepository } from "./support/backend.mjs";
import { accountScope } from "../dist/repository.js";
import { AmsAccountSchema, AmsListSchema } from "@openams/contracts";
const actor = {
  tenantId: "agency",
  userId: "admin",
  role: "admin",
  name: "Fixture admin",
};
const reject = (promise, code) =>
  assert.rejects(promise, (error) => error.code === code);
async function fixture(t, adapter) {
  const dir =
    adapter === "sqlite"
      ? await mkdtemp(join(tmpdir(), "ams-identities-"))
      : null;
  let repository = openRepository(join(dir, "agency.sqlite"));
  if (dir)
    t.after(async () => {
      repository.close();
      await rm(dir, { recursive: true, force: true });
    });
  const service = () =>
    new AmsService({
      repository,
      members: async () => [
        {
          id: "admin",
          name: "Admin",
          email: "admin@example.test",
          role: "admin",
          active: true,
        },
        {
          id: "csr",
          name: "CSR",
          email: "csr@example.test",
          role: "member",
          active: true,
        },
      ],
      now: () => new Date("2026-11-06T12:00:00Z"),
      certificateTemplates: async () => ["b".repeat(64)],
    });
  const run = (action, kind, data = {}, record, as = actor, extra = {}) =>
    (action === "certificate.prepare"
      ? service().prepareCertificate.bind(service())
      : service().execute.bind(service()))(as, {
      id: randomUUID(),
      action,
      kind,
      data,
      reason: "Fixture reviewed change",
      ...(record
        ? { recordId: record.id, expectedVersion: record.version }
        : {}),
      ...extra,
    });
  const create = async (kind, data, as) =>
    (
      await run(
        "create",
        kind,
        {
          ...(kind === "tasks"
            ? { dueDate: "2026-11-10" }
            : kind === "notes"
              ? { occurredAt: "2026-11-06T12:00:00Z" }
              : {}),
          ...data,
        },
        undefined,
        as,
      )
    ).records[0];
  const get = (kind, id) => repository.get(actor.tenantId, kind, id);
  const merge = (source, target, extra) =>
    run(
      "account.consolidate",
      "accounts",
      { targetId: target.id, targetVersion: target.version },
      source,
      actor,
      extra,
    );
  return {
    get repository() {
      return repository;
    },
    service,
    run,
    create,
    get,
    merge,
    restart() {
      if (!dir) return;
      repository.close();
      repository = openRepository(join(dir, "agency.sqlite"));
    },
  };
}
for (const adapter of ["sqlite"]) {
  test(`${adapter}: reviewed workflows create all tasks atomically and replay exactly once`, async (t) => {
    const f = await fixture(t, adapter);
    const account = await f.create("accounts", { name: "Workflow customer" });
    const data = {
      title: "Renewal review",
      steps: [
        {
          title: "Collect updated information",
          dueDate: "2026-11-07",
          ownerId: "csr",
        },
        { title: "Prepare marketing", dueDate: "2026-11-10", ownerId: "admin" },
      ],
    };
    const id = randomUUID();
    const result = await f.run(
      "account.startWorkflow",
      "accounts",
      data,
      account,
      actor,
      { id },
    );
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].data.workflow.id, id);
    assert.equal(result.records[1].data.workflow.step, 2);
    assert.equal(result.records[0].data.ownerId, "csr");
    assert.equal(
      (
        await f.run("account.startWorkflow", "accounts", data, account, actor, {
          id,
        })
      ).replayed,
      true,
    );
    const before = (
      await f.repository.list(actor.tenantId, "tasks", AmsListSchema.parse({}))
    ).items.length;
    await reject(
      f.run(
        "account.startWorkflow",
        "accounts",
        {
          ...data,
          steps: [data.steps[0], { ...data.steps[1], ownerId: "foreign" }],
        },
        account,
      ),
      "invalid_owner",
    );
    assert.equal(
      (
        await f.repository.list(
          actor.tenantId,
          "tasks",
          AmsListSchema.parse({}),
        )
      ).items.length,
      before,
    );
    await reject(
      f.create("tasks", {
        accountId: account.id,
        title: "Forged workflow",
        workflow: { id, title: "Forged", step: 1, total: 1 },
      }),
      "lifecycle_required",
    );
    await reject(
      f.run("update", "tasks", { workflow: null }, result.records[0]),
      "immutable_field",
    );
  });
  test(`${adapter}: bulk assignment rejects a stale selection without partially changing accounts`, async (t) => {
    const f = await fixture(t, adapter);
    const first = await f.create("accounts", { name: "First customer" });
    const second = await f.create("accounts", { name: "Second customer" });
    const freshSecond = (
      await f.run("update", "accounts", { name: "Updated second" }, second)
    ).records[0];
    const data = {
      accounts: [first, second].map((row) => ({
        id: row.id,
        version: row.version,
      })),
      serviceOwnerId: "csr",
    };
    await reject(
      f.run("account.bulkAssign", "accounts", data, first),
      "stale_record",
    );
    assert.equal((await f.get("accounts", first.id)).data.serviceOwnerId, null);
    const corrected = {
      ...data,
      accounts: [first, freshSecond].map((row) => ({
        id: row.id,
        version: row.version,
      })),
    };
    await reject(
      f.run("account.bulkAssign", "accounts", corrected, first, {
        ...actor,
        role: "member",
      }),
      "manager_required",
    );
    const result = await f.run(
      "account.bulkAssign",
      "accounts",
      corrected,
      first,
    );
    assert.equal(result.records.length, 2);
    assert.ok(result.records.every((row) => row.data.serviceOwnerId === "csr"));
    assert.deepEqual(
      new Set(result.audit.accountIds),
      new Set([first.id, second.id]),
    );
  });
  test(`${adapter}: typed account profiles, stable entity identities and tenant-safe relationships`, async (t) => {
    const f = await fixture(t, adapter);
    const parent = await f.create("accounts", { name: "Fixture parent" });
    const data = {
      name: "Fixture business",
      insuredEntities: [{ id: "entity-1", name: "Fixture LLC", type: "llc" }],
      customFields: [
        { id: "field-1", label: "Employees", type: "number", value: 7 },
      ],
      relationships: [{ accountId: parent.id, type: "parent" }],
    };
    let account = await f.create("accounts", data);
    assert.equal(account.data.insuredEntities[0].inactive, false);
    await reject(
      f.run("update", "accounts", { insuredEntities: [] }, account),
      "entity_history_required",
    );
    await reject(
      f.run(
        "update",
        "accounts",
        {
          customFields: [
            { id: "bad", label: "Employees", type: "number", value: "seven" },
          ],
        },
        account,
      ),
      "invalid_request",
    );
    await reject(
      f.run(
        "update",
        "accounts",
        { relationships: [{ accountId: account.id, type: "parent" }] },
        account,
      ),
      "self_relationship",
    );
    await reject(
      f.run(
        "update",
        "accounts",
        { relationships: [{ accountId: "foreign", type: "related" }] },
        account,
      ),
      "not_found",
    );
    await reject(
      f.run(
        "update",
        "accounts",
        {
          customFields: [
            { id: "a", label: "Region", type: "text", value: "West" },
            { id: "b", label: "region", type: "text", value: "East" },
          ],
        },
        account,
      ),
      "duplicate_field",
    );
    account = (
      await f.run(
        "update",
        "accounts",
        {
          insuredEntities: [
            {
              ...account.data.insuredEntities[0],
              inactive: true,
              name: "Renamed Fixture LLC",
            },
          ],
        },
        account,
      )
    ).records[0];
    assert.equal(account.data.insuredEntities[0].id, "entity-1");
    assert.equal(
      (await f.repository.revision(actor.tenantId, "accounts", account.id, 1))
        .data.insuredEntities[0].name,
      "Fixture LLC",
    );
  });
  test(`${adapter}: retained policy identities support certificates, scheduled evidence and renewal outcomes`, async (t) => {
    const f = await fixture(t, adapter);
    const primary = await f.create("accounts", { name: "Primary insured" });
    const retained = await f.create("accounts", { name: "Original insured" });
    const foreign = await f.create("accounts", { name: "Other insured" });
    let policy = await f.create("policies", {
      accountId: retained.id,
      number: "LINKED-1",
      carrier: "Fixture",
      line: "GL",
      effectiveDate: "2026-01-01",
      expirationDate: "2027-01-01",
      premiumCents: 10000,
    });
    policy = (
      await f.run(
        "policy.issue",
        "policies",
        { sourceReference: "Issued evidence" },
        policy,
      )
    ).records[0];
    await f.merge(retained, primary);
    const document = async (accountId) =>
      (
        await f.service().createDocument(actor, {
          id: randomUUID(),
          kind: "documents",
          action: "create",
          reason: "Fixture uploaded bytes",
          data: {
            accountId,
            name: "certificate.pdf",
            mediaType: "application/pdf",
            bytes: 100,
            sha256: "a".repeat(64),
            storageKey: "fixture",
            category: "certificate",
          },
        })
      ).records[0];
    const pdf = await document(primary.id);
    const otherPdf = await document(foreign.id);
    let certificate = await f.create("certificates", {
      accountId: retained.id,
      policyIds: [policy.id],
      holderName: "Holder",
      requestedDate: "2026-11-06",
    });
    const preparation = {
      formId: "acord25",
      templateSha256: "b".repeat(64),
      accountVersion: (await f.get("accounts", retained.id)).version,
      policyVersions: [{ id: policy.id, version: policy.version }],
      fields: { INSURED: "Reviewed legal name" },
    };
    await reject(
      f.run(
        "certificate.prepare",
        "certificates",
        { documentId: otherPdf.id, preparation },
        certificate,
      ),
      "certificate_document_required",
    );
    certificate = (
      await f.run(
        "certificate.prepare",
        "certificates",
        { documentId: pdf.id, preparation },
        certificate,
      )
    ).records[0];
    certificate = (
      await f.run(
        "certificate.issue",
        "certificates",
        { documentId: pdf.id, reviewed: true },
        certificate,
      )
    ).records[0];
    assert.equal(certificate.data.status, "issued");
    assert.equal(
      certificate.data.policySnapshots[0].data.accountId,
      retained.id,
    );
    const groupCertificate = await f.create("certificates", {
      accountId: primary.id,
      policyIds: [policy.id],
      holderName: "Second holder",
      requestedDate: "2026-11-06",
    });
    await reject(
      f.run(
        "certificate.issue",
        "certificates",
        { documentId: otherPdf.id, reviewed: true },
        groupCertificate,
      ),
      "certificate_document_required",
    );
    assert.equal(
      (
        await f.run(
          "certificate.issue",
          "certificates",
          { documentId: pdf.id, reviewed: true },
          groupCertificate,
        )
      ).records[0].data.status,
      "issued",
    );
    const endorsement = {
      effectiveDate: "2026-12-01",
      premiumDeltaCents: 1000,
      sourceReference: "Reviewed change",
    };
    await reject(
      f.run(
        "policy.endorse",
        "policies",
        { ...endorsement, sourceDocumentId: otherPdf.id },
        policy,
      ),
      "account_mismatch",
    );
    const scheduled = (
      await f.run(
        "policy.endorse",
        "policies",
        { ...endorsement, sourceDocumentId: pdf.id },
        policy,
      )
    ).records[0];
    assert.equal(scheduled.kind, "policychanges");
    const renewal = await f.create("renewals", {
      accountId: primary.id,
      title: "Annual review",
      policyIds: [policy.id],
      expirationDate: "2027-01-01",
    });
    let replacement = (
      await f.run(
        "policy.renew",
        "policies",
        {
          number: "LINKED-2",
          effectiveDate: "2027-01-01",
          expirationDate: "2028-01-01",
          premiumCents: 20000,
        },
        policy,
      )
    ).records[0];
    replacement = (
      await f.run(
        "policy.issue",
        "policies",
        { sourceReference: "Replacement evidence" },
        replacement,
      )
    ).records[0];
    const closed = (
      await f.run(
        "renewal.close",
        "renewals",
        { stage: "renewed", replacementPolicyIds: [replacement.id] },
        renewal,
      )
    ).records[0];
    assert.equal(closed.data.stage, "renewed");
    assert.equal(replacement.data.accountId, retained.id);
  });
  test(`${adapter}: consolidation preserves issued records and combines scope, history and new references`, async (t) => {
    const f = await fixture(t, adapter);
    const target = await f.create("accounts", {
      name: "Primary",
      status: "active",
    });
    const source = await f.create("accounts", {
      name: "Duplicate",
      status: "active",
      source: "nowcerts",
      externalId: "NC-001",
    });
    let policy = await f.create("policies", {
      accountId: source.id,
      number: "POL-1",
      carrier: "Fixture carrier",
      line: "GL",
      effectiveDate: "2026-01-01",
      expirationDate: "2027-01-01",
      premiumCents: 100000,
      commissionBps: 1000,
    });
    policy = (
      await f.run(
        "policy.issue",
        "policies",
        { sourceReference: "Reviewed carrier evidence" },
        policy,
      )
    ).records.find((row) => row.kind === "policies");
    const commission = (
      await f.repository.list(
        actor.tenantId,
        "commissions",
        AmsListSchema.parse({}),
      )
    ).items[0];
    const task = await f.create("tasks", {
      accountId: source.id,
      title: "Original task",
    });
    const note = await f.create("notes", {
      accountId: source.id,
      body: "Original note",
    });
    const input = { id: randomUUID() };
    const result = await f.merge(source, target, input);
    assert.equal((await f.merge(source, target, input)).replayed, true);
    assert.deepEqual(await f.get("policies", policy.id), policy);
    assert.deepEqual(await f.get("commissions", commission.id), commission);
    assert.deepEqual(await f.get("notes", note.id), note);
    assert.equal(
      (await f.get("accounts", source.id)).data.externalId,
      "NC-001",
    );
    const scope = await accountScope(f.repository, actor.tenantId, source.id);
    assert.deepEqual(scope, [target.id, source.id]);
    assert.equal(
      (
        await f.repository.list(actor.tenantId, "policies", {
          ...AmsListSchema.parse({ accountId: target.id }),
          accountIds: scope,
        })
      ).items[0].id,
      policy.id,
    );
    assert.ok(
      (await f.repository.history(actor.tenantId, scope)).items.some((event) =>
        event.records.some((ref) => ref.id === note.id),
      ),
    );
    const task2 = await f.create("tasks", {
      accountId: target.id,
      policyId: policy.id,
      title: "Policy from retained identity",
    });
    assert.equal(task2.data.policyId, policy.id);
    await reject(
      f.run(
        "account.undoConsolidation",
        "accounts",
        {},
        result.records.find((row) => row.id === source.id),
      ),
      "consolidation_in_use",
    );
    const current = await f.get("tasks", task.id);
    await f.run("task.complete", "tasks", {}, current);
    assert.equal(
      (await f.repository.history(actor.tenantId, target.id)).items[0]
        .records[0].id,
      task.id,
    );
    const unrelated = await f.create("accounts", {
      name: "Different customer",
    });
    await reject(
      f.create("tasks", {
        accountId: unrelated.id,
        policyId: policy.id,
        title: "Wrong customer",
      }),
      "account_mismatch",
    );
  });
  test(`${adapter}: undo survives restart, ignores unrelated work and rejects later group work`, async (t) => {
    const f = await fixture(t, adapter);
    const target = await f.create("accounts", { name: "Primary" });
    const source = await f.create("accounts", { name: "Duplicate" });
    const result = await f.merge(source, target);
    const retained = result.records.find((row) => row.id === source.id);
    f.restart();
    const unrelated = await f.create("accounts", { name: "Unrelated" });
    await f.create("tasks", {
      accountId: unrelated.id,
      title: "Unrelated work",
    });
    await f.run("account.undoConsolidation", "accounts", {}, retained);
    assert.equal((await f.get("accounts", source.id)).data.consolidation, null);
    assert.deepEqual(
      (await f.get("accounts", target.id)).data.consolidatedAccountIds,
      [],
    );
    const again = await f.merge(
      await f.get("accounts", source.id),
      await f.get("accounts", target.id),
    );
    await f.create("notes", {
      accountId: source.id,
      body: "Work on retained identity",
    });
    f.restart();
    await reject(
      f.run(
        "account.undoConsolidation",
        "accounts",
        {},
        again.records.find((row) => row.id === source.id),
      ),
      "consolidation_in_use",
    );
  });
  test(`${adapter}: authority, both account versions, cycles and server-owned metadata are enforced atomically`, async (t) => {
    const f = await fixture(t, adapter);
    const source = await f.create("accounts", { name: "Source" });
    let target = await f.create("accounts", { name: "Target" });
    await reject(
      f.run(
        "account.consolidate",
        "accounts",
        { targetId: target.id, targetVersion: target.version },
        source,
        { ...actor, role: "member" },
      ),
      "manager_required",
    );
    await reject(f.merge(source, source), "invalid_consolidation");
    await reject(f.merge(source, target, { reason: "" }), "reason_required");
    await reject(
      f.run(
        "update",
        "accounts",
        { consolidatedAccountIds: [source.id] },
        target,
      ),
      "immutable_field",
    );
    await reject(
      f.create("accounts", {
        name: "Forged",
        consolidatedAccountIds: [source.id],
      }),
      "lifecycle_required",
    );
    const fresh = (
      await f.run("update", "accounts", { name: "Updated" }, target)
    ).records[0];
    await reject(f.merge(source, target), "stale_record");
    assert.equal((await f.get("accounts", source.id)).data.consolidation, null);
    target = fresh;
    const foreign = await f.create(
      "accounts",
      { name: "Foreign" },
      { ...actor, tenantId: "another-agency" },
    );
    await reject(f.merge(source, foreign), "not_found");
    await f.merge(source, target);
    await reject(
      f.merge(
        await f.get("accounts", source.id),
        await f.get("accounts", target.id),
      ),
      "invalid_consolidation",
    );
    await reject(
      f.run("archive", "accounts", {}, await f.get("accounts", source.id)),
      "consolidated_account",
    );
  });
}
test("legacy account data defaults remain additive", () => {
  const old = AmsAccountSchema.parse({ name: "Legacy" });
  assert.deepEqual(old.customFields, []);
  assert.deepEqual(old.insuredEntities, []);
  assert.deepEqual(old.relationships, []);
  assert.equal(old.consolidation, null);
});
