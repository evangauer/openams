// Repository conformance: the same behaviors run against SQLite (reference) and
// Firestore (emulator). Run with `npm run test:firebase --workspace @openams/api`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AmsListSchema } from "@openams/contracts";
import { AmsService } from "../../dist/service.js";
import { SqliteAmsRepository } from "../../dist/sqlite-repository.js";
import { versioned } from "../../dist/repository.js";
import { firebaseServices } from "../support/backend.mjs";

const firebase = await firebaseServices();
const backends = {
  sqlite: () => {
    const repository = new SqliteAmsRepository(":memory:");
    return { repository, close: () => repository.close() };
  },
  firestore: () => ({
    repository: new firebase.FirestoreAmsRepository(firebase.firestore, {
      root: `conformance_${randomUUID().replaceAll("-", "")}`,
    }),
    close: () => {},
  }),
};
const tenant = "agency-a";
const otherTenant = "agency-b";
const actor = {
  userId: "admin-1",
  tenantId: tenant,
  role: "admin",
  name: "Fixture Admin",
};
const members = async () => [
  {
    id: "admin-1",
    name: "Fixture Admin",
    email: "admin@example.test",
    role: "admin",
    active: true,
  },
];
const rejectsCode = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.stack);
    return true;
  });
const record = (kind, id, data, revision = 1) =>
  versioned({
    id,
    kind,
    revision,
    createdAt: "2026-11-05T15:00:00.000Z",
    updatedAt: "2026-11-05T15:00:00.000Z",
    createdBy: "admin-1",
    updatedBy: "admin-1",
    archivedAt: null,
    data,
  });
const audit = (sequence, accountId = null, accountIds) => ({
  id: randomUUID(),
  sequence,
  commandId: randomUUID(),
  action: "create",
  actorId: "admin-1",
  actorName: "Fixture Admin",
  at: "2026-11-05T15:00:00.000Z",
  accountId,
  ...(accountIds ? { accountIds } : {}),
  records: [],
  reason: "",
  details: {},
});
const service = (repository) =>
  new AmsService({
    repository,
    members,
    now: () => new Date("2026-11-05T15:00:00Z"),
  });
const command = (kind, action, data, target) => ({
  id: randomUUID(),
  kind,
  action,
  data,
  reason: "Fixture reason",
  ...(target ? { recordId: target.id, expectedVersion: target.version } : {}),
});

for (const [name, open] of Object.entries(backends)) {
  const fixture = (t) => {
    const backend = open();
    t.after(backend.close);
    return backend.repository;
  };

  test(`${name}: records round-trip exactly and immutable revisions are retrievable`, async (t) => {
    const repository = fixture(t);
    const data = {
      title: "Kitchen remodel – “quoted” ✓",
      nested: { list: [1, 2.5, -0, null, "", { deep: true }], empty: {} },
      big: Number.MAX_SAFE_INTEGER,
      date: "2026-11-05T15:00:00Z",
      nothing: null,
    };
    const first = record("notes", "note-1", data);
    const second = record("notes", "note-1", { ...data, title: "Edited" }, 2);
    await repository.transact(tenant, async (tx) => tx.put(first));
    await repository.transact(tenant, async (tx) => tx.put(second));
    const loaded = await repository.get(tenant, "notes", "note-1");
    assert.deepEqual(loaded, JSON.parse(JSON.stringify(second)));
    assert.deepEqual(
      await repository.revision(tenant, "notes", "note-1", 1),
      JSON.parse(JSON.stringify(first)),
    );
    assert.equal(
      (await repository.revision(tenant, "notes", "note-1", 2)).version,
      second.version,
    );
    assert.equal(await repository.revision(tenant, "notes", "note-1", 3), null);
    assert.equal(await repository.get(tenant, "notes", "missing"), null);
    assert.equal(await repository.get(tenant, "tasks", "note-1"), null);
  });

  test(`${name}: transactions read their own writes before commit`, async (t) => {
    const repository = fixture(t);
    await repository.transact(tenant, async (tx) => {
      assert.equal(await tx.get("notes", "n1"), null);
      tx.put(record("notes", "n1", { text: "draft" }));
      assert.equal((await tx.get("notes", "n1")).data.text, "draft");
      assert.equal(await tx.accountEpoch("acct-1"), 0);
      assert.equal(await tx.advanceAccountEpoch("acct-1"), 1);
      assert.equal(await tx.advanceAccountEpoch("acct-1"), 2);
      assert.equal(await tx.accountEpoch("acct-1"), 2);
      assert.equal(await tx.nextSequence(), 1);
      tx.audit(audit(1));
      assert.equal(await tx.nextSequence(), 2);
      await tx.unique("invoice:inv-1", "n1");
      await tx.unique("invoice:inv-1", "n1");
      await rejectsCode(tx.unique("invoice:inv-1", "n2"), "duplicate_record");
      assert.equal(await tx.receipt("cmd-1"), null);
      tx.saveReceipt("cmd-1", { actorId: "a", hash: "h", result: {} });
      assert.deepEqual(await tx.receipt("cmd-1"), {
        actorId: "a",
        hash: "h",
        result: {},
      });
    });
    await repository.transact(tenant, async (tx) => {
      assert.equal(await tx.accountEpoch("acct-1"), 2);
      assert.equal(await tx.nextSequence(), 2);
      assert.equal((await tx.receipt("cmd-1")).hash, "h");
      await rejectsCode(tx.unique("invoice:inv-1", "n2"), "duplicate_record");
      await tx.unique("invoice:inv-1", "n1");
    });
  });

  test(`${name}: a thrown error leaves no records, revisions, keys, audit, receipts or epochs`, async (t) => {
    const repository = fixture(t);
    await assert.rejects(
      repository.transact(tenant, async (tx) => {
        tx.put(record("notes", "rolled-back", { text: "never" }));
        await tx.unique("invoice:rolled-back", "rolled-back");
        await tx.advanceAccountEpoch("acct-1");
        tx.audit(audit(await tx.nextSequence()));
        tx.saveReceipt("cmd-rollback", { actorId: "a", hash: "h", result: {} });
        throw new Error("fixture failure after every write kind");
      }),
      /fixture failure/,
    );
    assert.equal(await repository.get(tenant, "notes", "rolled-back"), null);
    assert.equal(
      await repository.revision(tenant, "notes", "rolled-back", 1),
      null,
    );
    assert.deepEqual((await repository.history(tenant)).items, []);
    assert.deepEqual(
      (await repository.list(tenant, "notes", AmsListSchema.parse({}))).items,
      [],
    );
    await repository.transact(tenant, async (tx) => {
      assert.equal(await tx.receipt("cmd-rollback"), null);
      assert.equal(await tx.accountEpoch("acct-1"), 0);
      assert.equal(await tx.nextSequence(), 1);
      await tx.unique("invoice:rolled-back", "someone-else");
    });
  });

  test(`${name}: service rollback on a failed posting keeps record, unique key, audit and receipt out`, async (t) => {
    const repository = fixture(t);
    const ams = service(repository);
    const account = (
      await ams.execute(actor, command("accounts", "create", { name: "Example Bakery", status: "active" }))
    ).records[0];
    const before = (await repository.history(tenant)).items.length;
    // An invoice with a missing account reference fails validation after the
    // unique key for its number was claimed inside the same transaction.
    const failing = command("invoices", "create", {
      accountId: "missing-account",
      number: "INV-ROLLBACK",
      dueDate: "2026-12-01",
      lines: [{ description: "Fee", amountCents: 1000 }],
    });
    await assert.rejects(ams.execute(actor, failing));
    assert.equal((await repository.history(tenant)).items.length, before);
    assert.equal(await repository.transact(tenant, (tx) => tx.receipt(failing.id)), null);
    await repository.transact(tenant, (tx) =>
      tx.unique("invoice:inv-rollback", "anyone"),
    );
    assert.equal(account.kind, "accounts");
  });

  test(`${name}: receipts replay idempotently and reject a reused id`, async (t) => {
    const repository = fixture(t);
    const ams = service(repository);
    const input = command("accounts", "create", { name: "Example Florist", status: "active" });
    const first = await ams.execute(actor, input);
    const replay = await ams.execute(actor, input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.records, first.records);
    assert.equal((await repository.history(tenant)).items.length, 1);
    await rejectsCode(
      ams.execute(actor, { ...input, data: { ...input.data, name: "Other" } }),
      "idempotency_conflict",
    );
    // Concurrent duplicates of one command commit once.
    const again = command("accounts", "create", { name: "Example Tailor", status: "active" });
    const results = await Promise.all([
      ams.execute(actor, again),
      ams.execute(actor, again),
      ams.execute(actor, again),
    ]);
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    assert.equal(new Set(results.map((r) => r.records[0].id)).size, 1);
    assert.equal((await repository.history(tenant)).items.length, 2);
  });

  test(`${name}: concurrent edits reject the stale writer and keep revisions and audit consistent`, async (t) => {
    const repository = fixture(t);
    const ams = service(repository);
    const account = (
      await ams.execute(actor, command("accounts", "create", { name: "Example Garage", status: "active" }))
    ).records[0];
    const results = await Promise.allSettled(
      ["First", "Second", "Third"].map((name) =>
        ams.execute(actor, command("accounts", "update", { name }, account)),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results.filter((r) => r.status === "rejected"))
      assert.equal(r.reason.code, "stale_record");
    const stored = await repository.get(tenant, "accounts", account.id);
    assert.equal(stored.revision, 2);
    assert.equal((await repository.history(tenant)).items.length, 2);
    assert.equal(
      (await repository.revision(tenant, "accounts", account.id, 2)).version,
      stored.version,
    );
  });

  test(`${name}: concurrent read-modify-write transactions serialize without lost updates`, async (t) => {
    const repository = fixture(t);
    await repository.transact(tenant, async (tx) =>
      tx.put(record("notes", "counter", { count: 0 })),
    );
    await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.transact(tenant, async (tx) => {
          const current = await tx.get("notes", "counter");
          const sequence = await tx.nextSequence();
          tx.put(
            record(
              "notes",
              "counter",
              { count: current.data.count + 1 },
              current.revision + 1,
            ),
          );
          tx.audit(audit(sequence));
        }),
      ),
    );
    const counter = await repository.get(tenant, "notes", "counter");
    assert.equal(counter.data.count, 8);
    assert.equal(counter.revision, 9);
    const history = await repository.history(tenant);
    assert.deepEqual(
      history.items.map((a) => a.sequence),
      [8, 7, 6, 5, 4, 3, 2, 1],
    );
  });

  test(`${name}: a conflicting immutable write fails the whole transaction`, async (t) => {
    const repository = fixture(t);
    await repository.transact(tenant, async (tx) =>
      tx.put(record("notes", "n1", { text: "one" })),
    );
    await assert.rejects(
      repository.transact(tenant, async (tx) => {
        tx.put(record("notes", "n2", { text: "bystander" }));
        // Same revision number again without reading: revisions are immutable.
        tx.put(record("notes", "n1", { text: "overwrite" }));
      }),
    );
    assert.equal(await repository.get(tenant, "notes", "n2"), null);
    assert.equal((await repository.get(tenant, "notes", "n1")).data.text, "one");
  });

  test(`${name}: pagination is ordered, complete, filtered and rejects tampered cursors`, async (t) => {
    const repository = fixture(t);
    const ids = ["t-07", "t-01", "t-05", "t-03", "t-02", "t-06", "t-04"];
    await repository.transact(tenant, async (tx) => {
      for (const id of ids)
        tx.put(
          record("notes", id, {
            accountId: id <= "t-04" ? "acct-1" : "acct-2",
            text: `note ${id}`,
          }),
        );
      tx.put({
        ...record("notes", "t-08", { accountId: "acct-1", text: "archived" }),
        archivedAt: "2026-11-05T16:00:00.000Z",
      });
    });
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const page = await repository.list(
        tenant,
        "notes",
        AmsListSchema.parse({ limit: 3, ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    assert.deepEqual(seen, [...ids].sort());
    assert.equal(pages, 3);
    const filtered = await repository.list(
      tenant,
      "notes",
      AmsListSchema.parse({ accountId: "acct-1", limit: 10 }),
    );
    assert.deepEqual(
      filtered.items.map((r) => r.id),
      ["t-01", "t-02", "t-03", "t-04"],
    );
    const withArchived = await repository.list(
      tenant,
      "notes",
      AmsListSchema.parse({ accountId: "acct-1", includeArchived: "true", limit: 10 }),
    );
    assert.equal(withArchived.items.at(-1).id, "t-08");
    const scoped = await repository.list(tenant, "notes", {
      ...AmsListSchema.parse({ limit: 10, query: "NOTE T-0" }),
      accountIds: ["acct-2"],
    });
    assert.deepEqual(
      scoped.items.map((r) => r.id),
      ["t-05", "t-06", "t-07"],
    );
    const first = await repository.list(
      tenant,
      "notes",
      AmsListSchema.parse({ limit: 2 }),
    );
    assert.ok(first.nextCursor);
    // Same cursor, different filters.
    await rejectsCode(
      repository.list(
        tenant,
        "notes",
        AmsListSchema.parse({ limit: 2, accountId: "acct-1", cursor: first.nextCursor }),
      ),
      "invalid_cursor",
    );
    // Another kind.
    await rejectsCode(
      repository.list(tenant, "tasks", AmsListSchema.parse({ limit: 2, cursor: first.nextCursor })),
      "invalid_cursor",
    );
    // Hand-edited cursor body.
    const decoded = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString());
    for (const id of ["../../other", "t-01.x", "t-99/x", 7]) {
      const forged = Buffer.from(JSON.stringify({ ...decoded, id })).toString("base64url");
      await rejectsCode(
        repository.list(tenant, "notes", AmsListSchema.parse({ limit: 2, cursor: forged })),
        "invalid_cursor",
      );
    }
    await rejectsCode(
      repository.list(tenant, "notes", AmsListSchema.parse({ limit: 2, cursor: "not-a-cursor" })),
      "invalid_cursor",
    );
  });

  test(`${name}: a page scans at most 1000 records and resumes after the last scanned id`, async (t) => {
    const repository = fixture(t);
    // 1003 records; only the last three match the filter.
    await repository.transact(tenant, async (tx) => {
      for (let i = 0; i < 1003; i += 1) {
        const id = `r-${String(i).padStart(4, "0")}`;
        tx.put(record("notes", id, { accountId: i >= 1000 ? "acct-hit" : "acct-miss" }));
      }
    });
    const options = AmsListSchema.parse({ accountId: "acct-hit", limit: 50 });
    const first = await repository.list(tenant, "notes", options);
    assert.deepEqual(first.items, []);
    assert.ok(first.nextCursor);
    const second = await repository.list(tenant, "notes", {
      ...options,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map((r) => r.id),
      ["r-1000", "r-1001", "r-1002"],
    );
    assert.equal(second.nextCursor, null);
  });

  test(`${name}: history pages newest first and filters by account scope`, async (t) => {
    const repository = fixture(t);
    await repository.transact(tenant, async (tx) => {
      for (let i = 1; i <= 6; i += 1)
        tx.audit(
          audit(i, i % 2 ? "acct-odd" : "acct-even", i === 6 ? ["acct-even", "acct-odd"] : undefined),
        );
    });
    const page = await repository.history(tenant, undefined, undefined, 4);
    assert.deepEqual(page.items.map((a) => a.sequence), [6, 5, 4, 3]);
    assert.equal(page.nextCursor, "3");
    const rest = await repository.history(tenant, undefined, Number(page.nextCursor), 4);
    assert.deepEqual(rest.items.map((a) => a.sequence), [2, 1]);
    assert.equal(rest.nextCursor, null);
    const odd = await repository.history(tenant, "acct-odd");
    assert.deepEqual(odd.items.map((a) => a.sequence), [6, 5, 3, 1]);
    const scoped = await repository.history(tenant, ["acct-even"], 6);
    assert.deepEqual(scoped.items.map((a) => a.sequence), [4, 2]);
  });

  test(`${name}: due reminders are ordered by queue key, bounded by date and limited`, async (t) => {
    const repository = fixture(t);
    const reminder = (id, queueKey) => record("reminders", id, { queueKey, status: "pending" });
    await repository.transact(tenant, async (tx) => {
      tx.put(reminder("rem-c", "2026-11-05:rem-c"));
      tx.put(reminder("rem-a", "2026-11-03:rem-a"));
      tx.put(reminder("rem-b", "2026-11-05:rem-b"));
      tx.put(reminder("rem-future", "2026-11-06:rem-future"));
      tx.put(reminder("rem-done", null));
      tx.put(record("notes", "not-a-reminder", { queueKey: "2026-11-01:x" }));
    });
    const due = await repository.dueReminders(tenant, "2026-11-05");
    assert.deepEqual(due.map((r) => r.id), ["rem-a", "rem-b", "rem-c"]);
    const limited = await repository.dueReminders(tenant, "2026-11-05", 2);
    assert.deepEqual(limited.map((r) => r.id), ["rem-a", "rem-b"]);
    // Delivering clears the queue key; the reminder leaves the queue.
    await repository.transact(tenant, async (tx) => {
      const current = await tx.get("reminders", "rem-a");
      tx.put(record("reminders", "rem-a", { ...current.data, queueKey: null }, 2));
    });
    assert.deepEqual(
      (await repository.dueReminders(tenant, "2026-11-05")).map((r) => r.id),
      ["rem-b", "rem-c"],
    );
    assert.deepEqual(await repository.dueReminders(otherTenant, "2026-11-05"), []);
  });

  test(`${name}: tenants never see each other's records, revisions, history, receipts or keys`, async (t) => {
    const repository = fixture(t);
    const ams = service(repository);
    const created = await ams.execute(
      actor,
      command("accounts", "create", { name: "Example Roofing", status: "active" }),
    );
    const account = created.records[0];
    await repository.transact(tenant, (tx) => tx.unique("invoice:shared-number", "rec-a"));
    assert.equal(await repository.get(otherTenant, "accounts", account.id), null);
    assert.equal(await repository.revision(otherTenant, "accounts", account.id, 1), null);
    assert.deepEqual(
      (await repository.list(otherTenant, "accounts", AmsListSchema.parse({}))).items,
      [],
    );
    assert.deepEqual((await repository.history(otherTenant)).items, []);
    assert.deepEqual((await repository.history(otherTenant, account.id)).items, []);
    await repository.transact(otherTenant, async (tx) => {
      assert.equal(await tx.get("accounts", account.id), null);
      assert.equal(await tx.receipt(created.audit.commandId), null);
      assert.equal(await tx.nextSequence(), 1);
      assert.equal(await tx.accountEpoch(account.id), 1 - 1);
      await tx.unique("invoice:shared-number", "rec-b");
    });
    // The other tenant's first command does not collide with tenant A's audit or ids.
    const otherActor = { ...actor, tenantId: otherTenant };
    await ams.execute(
      otherActor,
      command("accounts", "create", { name: "Example Roofing", status: "active" }),
    );
    assert.equal((await repository.history(tenant)).items.length, 1);
    assert.equal((await repository.history(otherTenant)).items.length, 1);
    const page = await repository.list(tenant, "accounts", AmsListSchema.parse({ limit: 1 }));
    assert.equal(page.items.length, 1);
    // Cursors are tenant-bound.
    await ams.execute(actor, command("accounts", "create", { name: "Example Paving", status: "active" }));
    const bound = await repository.list(tenant, "accounts", AmsListSchema.parse({ limit: 1 }));
    await rejectsCode(
      repository.list(otherTenant, "accounts", AmsListSchema.parse({ limit: 1, cursor: bound.nextCursor })),
      "invalid_cursor",
    );
  });

  test(`${name}: duplicate unique identities are rejected through the service`, async (t) => {
    const repository = fixture(t);
    const ams = service(repository);
    const account = (
      await ams.execute(actor, command("accounts", "create", { name: "Example Clinic", status: "active" }))
    ).records[0];
    const policy = {
      accountId: account.id,
      number: "GL-0001",
      line: "General liability",
      carrier: "Example Carrier",
      effectiveDate: "2026-01-01",
      expirationDate: "2027-01-01",
      premiumCents: 100000,
    };
    await ams.execute(actor, command("policies", "create", policy));
    const historyBefore = (await repository.history(tenant)).items.length;
    await rejectsCode(
      ams.execute(actor, command("policies", "create", { ...policy, number: "gl-0001" })),
      "duplicate_record",
    );
    assert.equal((await repository.history(tenant)).items.length, historyBefore);
    assert.equal(
      (await repository.list(tenant, "policies", AmsListSchema.parse({}))).items.length,
      1,
    );
  });
}

test("firestore: tenant, kind and id inputs are validated before any path is built", async () => {
  const repository = new firebase.FirestoreAmsRepository(firebase.firestore, {
    root: `conformance_${randomUUID().replaceAll("-", "")}`,
  });
  for (const bad of ["", "../agency-a", "agency-a/kinds", "__agency__", "a.b", "x".repeat(129), 7])
    await rejectsCode(repository.get(bad, "accounts", "a"), "invalid_tenant");
  await rejectsCode(repository.transact("a/b", async () => "never"), "invalid_tenant");
  await rejectsCode(repository.history("..", undefined), "invalid_tenant");
  await rejectsCode(repository.get("agency-a", "../../x", "a"), "invalid_kind");
  await rejectsCode(repository.list("agency-a", "users", AmsListSchema.parse({})), "invalid_kind");
  for (const id of ["a/b", "..", ".", "", "x".repeat(129)]) {
    assert.equal(await repository.get("agency-a", "accounts", id), null);
    assert.equal(await repository.revision("agency-a", "accounts", id, 1), null);
  }
  await rejectsCode(
    repository.transact("agency-a", async (tx) => tx.put(record("notes", "a/b", {}))),
    "invalid_record",
  );
  // Reserved-looking ids are stored safely (prefixed document ids).
  await repository.transact("agency-a", async (tx) => {
    tx.put(record("notes", "__name__", { text: "reserved-looking" }));
    await tx.unique("account:import/../weird key:√", "__name__");
    tx.saveReceipt("not/a uuid", { actorId: "a", hash: "h", result: {} });
  });
  assert.equal((await repository.get("agency-a", "notes", "__name__")).data.text, "reserved-looking");
  await repository.transact("agency-a", async (tx) => {
    assert.equal((await tx.receipt("not/a uuid")).hash, "h");
    await rejectsCode(tx.unique("account:import/../weird key:√", "other"), "duplicate_record");
  });
  assert.throws(
    () => new firebase.FirestoreAmsRepository(firebase.firestore, { root: "a/b" }),
  );
});

test("firestore: transaction attempts are isolated when the SDK retries", async () => {
  const repository = new firebase.FirestoreAmsRepository(firebase.firestore, {
    root: `conformance_${randomUUID().replaceAll("-", "")}`,
  });
  let attempts = 0;
  const result = await repository.transact(tenant, async (tx) => {
    attempts += 1;
    tx.put(record("notes", `attempt-${attempts}`, { attempts }));
    await tx.unique("invoice:retry", `attempt-${attempts}`);
    if (attempts === 1) {
      // Simulate contention: a retryable ABORTED error from inside the attempt.
      const error = new Error("simulated contention");
      error.code = 10;
      throw error;
    }
    return attempts;
  });
  assert.equal(result, 2);
  assert.equal(await repository.get(tenant, "notes", "attempt-1"), null);
  assert.equal((await repository.get(tenant, "notes", "attempt-2")).data.attempts, 2);
  await repository.transact(tenant, async (tx) => {
    await tx.unique("invoice:retry", "attempt-2");
  });
});
