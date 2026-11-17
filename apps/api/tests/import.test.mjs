import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { openRepository } from "./support/backend.mjs";
import { AmsService } from "../dist/service.js";
import { planImport, applyImport } from "../dist/import.js";
import { AmsListSchema } from "@openams/contracts";
const actor = {
  tenantId: "fixture-agency",
  userId: "admin",
  role: "admin",
  name: "Fixture admin",
};
test("migration review is read-only, rejects invalid batches and retries without overwriting existing records", async (t) => {
  const repository = openRepository(":memory:");
  t.after(() => repository.close());
  const service = new AmsService({ repository, members: async () => [] });
  const input = {
    source: "Legacy fixture",
    kind: "accounts",
    rows: [
      { externalId: "ACC-1", name: "First fixture" },
      { externalId: "ACC-2", name: "Second fixture" },
    ],
  };
  const plan = await planImport(actor, input, repository);
  assert.equal(plan.ready, 2);
  assert.equal((await repository.history(actor.tenantId)).items.length, 0);
  const invalid = {
    ...input,
    rows: [...input.rows, { externalId: "ACC-2", name: "Duplicate" }],
  };
  const invalidPlan = await planImport(actor, invalid, repository);
  assert.equal(invalidPlan.errors, 1);
  await assert.rejects(
    applyImport(actor, invalid, repository, service, invalidPlan.fingerprint),
    (e) => e.code === "import_invalid",
  );
  assert.equal((await repository.history(actor.tenantId)).items.length, 0);
  await assert.rejects(
    applyImport(actor, input, repository, service, "wrong"),
    (e) => e.code === "import_changed",
  );
  const applied = await applyImport(
    actor,
    input,
    repository,
    service,
    plan.fingerprint,
  );
  assert.equal(applied.created, 2);
  assert.equal(applied.complete, true);
  const again = await applyImport(
    actor,
    input,
    repository,
    service,
    plan.fingerprint,
  );
  assert.equal(again.created, 0);
  assert.equal(again.existing, 2);
  const changed = {
    ...input,
    rows: [{ ...input.rows[0], name: "Should not overwrite" }],
  };
  const changedPlan = await planImport(actor, changed, repository);
  assert.equal(changedPlan.existing, 1);
  await applyImport(
    actor,
    changed,
    repository,
    service,
    changedPlan.fingerprint,
  );
  assert.equal(
    (
      await repository.get(
        actor.tenantId,
        "accounts",
        applied.outcomes[0].recordId,
      )
    ).data.name,
    "First fixture",
  );
  const policyInput = {
    source: "Legacy fixture",
    kind: "policies",
    rows: [
      {
        accountExternalId: "ACC-1",
        number: "GL-001",
        line: "General liability",
        carrier: "Example Carrier",
        effectiveDate: "2026-01-01",
        expirationDate: "2027-01-01",
        premiumCents: 123456,
      },
    ],
  };
  const policyPlan = await planImport(actor, policyInput, repository);
  assert.equal(policyPlan.premiumCents, 123456);
  assert.equal(policyPlan.ready, 1);
  const imported = await applyImport(
    actor,
    policyInput,
    repository,
    service,
    policyPlan.fingerprint,
  );
  assert.equal(imported.created, 1);
  const policy = await repository.get(
    actor.tenantId,
    "policies",
    imported.outcomes[0].recordId,
  );
  assert.equal(policy.data.status, "draft");
  assert.equal(policy.data.accountId, applied.outcomes[0].recordId);
  await assert.rejects(
    planImport({ ...actor, role: "member" }, input, repository),
    (e) => e.code === "manager_required",
  );
  const crossTenant = await planImport(
    { ...actor, tenantId: "other" },
    policyInput,
    repository,
  );
  assert.equal(crossTenant.errors, 1);
});

for (const adapter of ["sqlite"])
  test(`${adapter}: attributed history migration resolves links, resumes partial batches and protects source identities`, async (t) => {
    const repository =
      openRepository(":memory:");
    if (adapter === "sqlite") t.after(() => repository.close());
    const service = new AmsService({
      repository,
      members: async () => [],
      now: () => new Date("2026-11-06T12:00:00Z"),
    });
    const source = "NowCerts fictional extract";
    const apply = async (kind, rows, target = service) => {
      const input = { source, kind, rows };
      const plan = await planImport(actor, input, repository);
      assert.equal(plan.errors, 0, JSON.stringify(plan.rows));
      return applyImport(actor, input, repository, target, plan.fingerprint);
    };
    const accounts = await apply("accounts", [
      { externalId: "A", name: "Account A" },
      { externalId: "B", name: "Account B" },
    ]);
    const accountId = accounts.outcomes[0].recordId;
    const terms = await apply("policies", [
      {
        accountExternalId: "A",
        number: "P",
        line: "GL",
        carrier: "Fixture",
        effectiveDate: "2026-01-01",
        expirationDate: "2027-01-01",
        premiumCents: 100000,
      },
    ]);
    const policyId = terms.outcomes[0].recordId;
    const origin = {
      externalId: "external-1",
      accountExternalId: "A",
      sourceCreatedAt: "2024-01-10T10:00:00-06:00",
      sourceAuthor: "Historical author",
    };
    const policy = {
      policyNumber: "P",
      policyCarrier: "Fixture",
      policyEffectiveDate: "2026-01-01",
    };
    const fixtures = {
      contacts: { name: "Jordan", email: "jordan@example.test", primary: true },
      exposures: {
        name: "Workshop",
        kind: "location",
        values: { squareFeet: 5000, sprinklered: true },
      },
      notes: {
        body: "Original call, including historical facts.",
        occurredAt: "2024-01-10T16:00:00Z",
        category: "call",
        ...policy,
      },
      tasks: {
        title: "Collect updated payroll",
        dueDate: "2026-12-01",
        ...policy,
      },
    };
    for (const [kind, fields] of Object.entries(fixtures)) {
      const rows = [
        { ...origin, ...fields },
        { ...origin, ...fields, externalId: "external-2" },
      ];
      let calls = 0;
      const interrupted = {
        createImportedRecord: async (...args) => {
          if (++calls === 2) throw new Error("Simulated process interruption");
          return service.createImportedRecord(...args);
        },
      };
      const first = await apply(kind, rows, interrupted);
      assert.equal(first.complete, false);
      assert.equal(first.created, 1);
      assert.equal(first.errors, 1);
      const resumed = await apply(kind, rows);
      assert.equal(resumed.complete, true);
      assert.equal(resumed.existing, 1);
      assert.equal(resumed.created, 1);
      const record = await repository.get(
        actor.tenantId,
        kind,
        first.outcomes[0].recordId,
      );
      assert.equal(record.data.importOrigin.externalId, origin.externalId);
      assert.equal(
        record.data.importOrigin.sourceCreatedAt,
        origin.sourceCreatedAt,
      );
      assert.equal(record.data.importOrigin.sourceAuthor, origin.sourceAuthor);
      assert.equal(record.createdBy, actor.userId);
      assert.equal(record.createdAt, "2026-11-06T12:00:00.000Z");
      assert.equal(record.data.accountId, accountId);
      if (["notes", "tasks"].includes(kind))
        assert.equal(record.data.policyId, policyId);
      const changed = rows
        .map((row) => ({ ...row, sourceAuthor: "Changed source" }))
        .reverse();
      const repeated = await apply(kind, changed);
      assert.equal(repeated.created, 0);
      assert.equal(repeated.existing, 2);
      assert.equal(
        (await repository.get(actor.tenantId, kind, record.id)).version,
        record.version,
      );
      const badMapping = await planImport(
        actor,
        {
          source,
          kind,
          rows: [
            {
              ...rows[0],
              ...(["notes", "tasks"].includes(kind)
                ? {
                    policyNumber: "",
                    policyCarrier: "",
                    policyEffectiveDate: "",
                  }
                : {}),
              accountExternalId: "B",
            },
          ],
        },
        repository,
      );
      assert.equal(badMapping.errors, 1);
      assert.match(badMapping.rows[0].message, /another account/);
      const injected = {
        id: randomUUID(),
        kind,
        action: "create",
        data: record.data,
        reason: "Bypass review",
      };
      await assert.rejects(
        service.execute(actor, injected),
        (e) => e.code === "reviewed_import_required",
      );
      await assert.rejects(
        service.createImportedRecord({ ...actor, role: "member" }, injected),
        (e) => e.code === "manager_required",
      );
      await assert.rejects(
        service.createImportedRecord(actor, injected),
        (e) => e.code === "duplicate_record",
      );
      if (kind === "contacts") {
        await assert.rejects(
          service.execute(actor, {
            ...injected,
            id: randomUUID(),
            action: "update",
            recordId: record.id,
            expectedVersion: record.version,
            data: { importOrigin: null },
          }),
          (e) => e.code === "immutable_field",
        );
        const updated = await service.execute(actor, {
          ...injected,
          id: randomUUID(),
          action: "update",
          recordId: record.id,
          expectedVersion: record.version,
          data: { phone: "555-0101" },
        });
        assert.deepEqual(
          updated.records[0].data.importOrigin,
          record.data.importOrigin,
        );
      }
      assert.equal(
        (await repository.list(actor.tenantId, kind, AmsListSchema.parse({})))
          .items.length,
        2,
      );
    }
    const invalid = await planImport(
      actor,
      {
        source,
        kind: "notes",
        rows: [{ ...origin, ...fixtures.notes, policyCarrier: "Wrong" }],
      },
      repository,
    );
    assert.equal(invalid.errors, 1);
    assert.match(invalid.rows[0].message, /matching policy/);
    const closed = await planImport(
      actor,
      {
        source,
        kind: "tasks",
        rows: [{ ...origin, ...fixtures.tasks, status: "done" }],
      },
      repository,
    );
    assert.equal(closed.errors, 1);
    const crossTenant = await planImport(
      { ...actor, tenantId: "another" },
      { source, kind: "contacts", rows: [{ ...origin, ...fixtures.contacts }] },
      repository,
    );
    assert.equal(crossTenant.errors, 1);
    const history = (await repository.history(actor.tenantId, accountId)).items;
    assert.ok(history.length > 0);
    assert.ok(
      history.every(
        (event) =>
          event.actorId === actor.userId ||
          event.actor?.userId === actor.userId,
      ),
    );
  });
