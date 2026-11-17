import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AmsService } from "../dist/service.js";
import { versioned } from "../dist/repository.js";
import { openRepository } from "./support/backend.mjs";

const actor = { userId: "fixture-admin", tenantId: "fixture-agency", role: "admin", name: "Fictional Admin" };
async function fixture(t) {
  const repository = openRepository(":memory:");
  t.after(() => repository.close());
  const service = new AmsService({ repository, now: () => new Date("2026-11-12T12:00:00Z"), members: async () => [{ id: actor.userId, name: actor.name, email: "admin@example.test", role: "admin", active: true }] });
  async function run(kind, action, data = {}, record, extra = {}) {
    return service.execute(actor, { id: randomUUID(), kind, action, data, reason: "Fictional lifecycle review", ...(record ? {recordId: record.id, expectedVersion: record.version} : {}), ...extra });
  }
  const account = (await run("accounts", "create", { name: "Fictional Audit Business", status: "prospect" })).records[0];
  return { repository, service, run, account };
}

for (const status of ["prospect", "active", "inactive"]) {
  test(`archiving and restoring an account preserves its ${status} relationship`, async t => {
    const f = await fixture(t);
    const account = (await f.run("accounts", "update", { status }, f.account)).records[0];
    const archived = (await f.run("accounts", "archive", {}, account)).records[0];
    assert.equal(archived.data.status, status);
    assert.ok(archived.archivedAt);
    const input = { id: randomUUID(), kind: "accounts", action: "restore", recordId: archived.id, expectedVersion: archived.version, data: {}, reason: "Fictional archive review" };
    const restored = (await f.service.execute(actor, input)).records[0];
    assert.equal(restored.data.status, status);
    assert.equal(restored.archivedAt, null);
    assert.equal((await f.service.execute(actor, input)).replayed, true);
    await assert.rejects(f.run("accounts", "restore", {}, restored), e => e.code === "not_archived");
  });

  test(`legacy archived accounts recover the ${status} relationship from their immutable history`, async t => {
    const f = await fixture(t);
    const account = (await f.run("accounts", "update", { status }, f.account)).records[0];
    const archived = versioned({ ...account, data: { ...account.data, status: "archived" }, archivedAt: "2026-11-12T12:00:00Z", revision: account.revision + 1 });
    await f.repository.transact(actor.tenantId, async tx => tx.put(archived));
    const restored = (await f.run("accounts", "restore", {}, archived)).records[0];
    assert.equal(restored.data.status, status);
    assert.equal(restored.archivedAt, null);
  });
}

test("archive permissions, stale versions and missing legacy history cannot silently change relationships", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run("accounts", "create", { name: "Fictional hidden account", status: "archived" }), e => e.code === "lifecycle_required");
  await assert.rejects(f.run("accounts", "update", { status: "archived" }, f.account), e => e.code === "lifecycle_required");
  const archived = (await f.run("accounts", "archive", {}, f.account)).records[0];
  await assert.rejects(f.service.execute({ ...actor, role: "member" }, { id: randomUUID(), kind: "accounts", action: "restore", recordId: archived.id, expectedVersion: archived.version, data: {}, reason: "Fictional restore" }), e => e.status === 403);
  await assert.rejects(f.run("accounts", "restore", {}, f.account), e => e.code === "stale_record");
  const legacy = versioned({ ...archived, id: "missing-legacy-history", revision: 1, data: { ...archived.data, status: "archived" } });
  await f.repository.transact(actor.tenantId, async tx => tx.put(legacy));
  await assert.rejects(f.run("accounts", "restore", {}, legacy), e => e.code === "archive_history_required");
  assert.equal((await f.repository.get(actor.tenantId, "accounts", legacy.id)).version, legacy.version);
});

test("service completion cannot be forged when creating a request", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run("services", "create", { accountId: f.account.id, type: "general", title: "Fictional service", dueDate: "2026-11-13", status: "completed", resolution: "" }), e => e.code === "lifecycle_required");
});

test("a completed service resolution cannot be overwritten by a second completion", async t => {
  const f = await fixture(t);
  const request = (await f.run("services", "create", { accountId: f.account.id, type: "general", title: "Fictional service", dueDate: "2026-11-13" })).records[0];
  await assert.rejects(f.run("services", "service.complete", { resolution: "" }, request));
  const completed = (await f.run("services", "service.complete", { resolution: "Reviewed fictional documentation" }, request)).records[0];
  await assert.rejects(f.run("services", "service.complete", { resolution: "Unreviewed replacement" }, completed), e => e.code === "service_completed");
  await assert.rejects(f.run("services", "update", { resolution: "Unreviewed replacement" }, completed), e => e.code === "service_completed");
  await assert.rejects(f.run("services", "update", { status: "open" }, completed), e => e.code === "service_completed");
  assert.equal((await f.repository.get(actor.tenantId, "services", request.id)).data.resolution, "Reviewed fictional documentation");
});

test("withdrawn scheduled endorsements cannot change policy premium or be applied later", async t => {
  const f = await fixture(t);
  let policy = (await f.run("policies", "create", { accountId: f.account.id, number: "FICTIONAL-GL-1", carrier: "Fictional Mutual", line: "General liability", effectiveDate: "2026-01-01", expirationDate: "2027-01-01", premiumCents: 100000 })).records[0];
  policy = (await f.run("policies", "policy.issue", { sourceReference: "Fictional issued policy evidence" }, policy)).records[0];
  const scheduled = (await f.run("policies", "policy.endorse", { effectiveDate: "2026-12-01", premiumDeltaCents: 5000, sourceReference: "Fictional future change" }, policy)).records.find(r => r.kind === "policychanges");
  const input = { id: randomUUID(), kind: "policychanges", action: "policyChange.withdraw", recordId: scheduled.id, expectedVersion: scheduled.version, data: {}, reason: "Fictional carrier withdrew pending endorsement" };
  const withdrawn = (await f.service.execute(actor, input)).records[0];
  assert.equal(withdrawn.data.status, "withdrawn");
  assert.equal((await f.service.execute(actor, input)).replayed, true);
  await assert.rejects(f.run("policychanges", "policyChange.apply", {}, withdrawn), e => e.code === "policy_change_closed");
  assert.equal((await f.repository.get(actor.tenantId, "policies", policy.id)).data.premiumCents, 100000);
});
