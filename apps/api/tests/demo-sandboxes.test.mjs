import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAmsRepository } from "../dist/sqlite-repository.js";
import { SqliteAmsChat } from "../dist/chat.js";
import { LocalAmsFiles } from "../dist/files.js";
import { LocalAmsDemo } from "../dist/local-demo.js";
import { DemoSandboxes, sandboxTenantId } from "../dist/demo-sandboxes.js";

const token = () => `sbx_${randomBytes(32).toString("hex")}`;
const members = ["admin", "manager", "member", "accountant", "viewer"].map((role) => ({
  id: `local_${role}`,
  role,
  name: `Demo ${role}`,
  email: `${role}@harbor.example.test`,
  active: true,
}));

/** A registry over fakes: what it seeds and removes, and a clock the test moves. */
function registry(overrides = {}) {
  const clock = { now: Date.UTC(2026, 0, 15, 12) };
  const seeded = [];
  const removed = [];
  const sandboxes = new DemoSandboxes({
    seed: async ({ tenantId }) => {
      seeded.push(tenantId);
      return { tenantId, startedAt: new Date(clock.now).toISOString(), accountId: "a", policyId: "p", renewalId: "r", taskId: "t", emailId: "e", serviceId: "s" };
    },
    remove: async (tenantId) => void removed.push(tenantId),
    ttlMs: 24 * 60 * 60 * 1000,
    max: 3,
    perMinute: 100,
    now: () => clock.now,
    ...overrides,
  });
  return { sandboxes, clock, seeded, removed };
}

test("each visitor's token opens only their own sandbox", async () => {
  const { sandboxes } = registry();
  const [mine, theirs] = [token(), token()];
  const a = await sandboxes.create(mine);
  const b = await sandboxes.create(theirs);
  assert.notEqual(a.tenantId, b.tenantId);
  assert.equal(sandboxes.find(mine).tenantId, a.tenantId);
  assert.equal(sandboxes.find(theirs).tenantId, b.tenantId);
  assert.equal(a.tenantId, sandboxTenantId(mine));
  // Anything that isn't a live token opens nothing.
  for (const bad of ["", "sbx_", token().slice(0, -1), token().toUpperCase(), a.tenantId, `Bearer ${mine}`])
    assert.equal(sandboxes.find(bad), null);
  assert.equal(sandboxes.info(a.tenantId).tenantId, a.tenantId);
  assert.equal(sandboxes.info("local_agency"), null);
  await assert.rejects(sandboxes.create("not-a-token"), { code: "invalid_request" });
});

test("creating twice with one token gives one sandbox, even at the same moment", async () => {
  const { sandboxes, seeded } = registry();
  const mine = token();
  const [a, b] = await Promise.all([sandboxes.create(mine), sandboxes.create(mine)]);
  assert.equal(a, b);
  assert.equal((await sandboxes.create(mine)).tenantId, a.tenantId);
  assert.equal(seeded.length, 1);
});

test("a sandbox ends after its time and its records are deleted", async () => {
  const { sandboxes, clock, removed } = registry();
  const mine = token();
  const { tenantId } = await sandboxes.create(mine);
  clock.now += 24 * 60 * 60 * 1000 - 1;
  assert.ok(sandboxes.find(mine));
  clock.now += 1;
  assert.equal(sandboxes.find(mine), null, "expired before the sweep runs");
  assert.equal(sandboxes.info(tenantId), null);
  assert.equal(await sandboxes.sweep(), 1);
  assert.deepEqual(removed, [tenantId]);
  assert.equal(sandboxes.size, 0);
});

test("starting over deletes the visitor's previous sandbox", async () => {
  const { sandboxes, removed } = registry();
  const [first, second] = [token(), token()];
  const old = await sandboxes.create(first);
  const fresh = await sandboxes.create(second, first);
  assert.deepEqual(removed, [old.tenantId]);
  assert.equal(sandboxes.find(first), null);
  assert.equal(sandboxes.find(second).tenantId, fresh.tenantId);
});

test("at the cap, only an idle sandbox makes room", async () => {
  const { sandboxes, clock, removed } = registry();
  const tokens = [token(), token(), token()];
  const made = [];
  for (const t of tokens) {
    made.push(await sandboxes.create(t));
    clock.now += 1000;
  }
  await assert.rejects(sandboxes.create(token()), { status: 429, code: "demo_busy" });
  assert.deepEqual(removed, []);
  // Twenty minutes on, the first two are still in use; the third has gone quiet.
  clock.now += 20 * 60 * 1000;
  sandboxes.find(tokens[0]);
  sandboxes.find(tokens[1]);
  await sandboxes.create(token());
  assert.deepEqual(removed, [made[2].tenantId]);
  assert.equal(sandboxes.size, 3);
});

test("new sandboxes are rate limited across all visitors", async () => {
  const { sandboxes, clock } = registry({ max: 100, perMinute: 2 });
  await sandboxes.create(token());
  await sandboxes.create(token());
  await assert.rejects(sandboxes.create(token()), { status: 429, code: "demo_busy" });
  clock.now += 61_000;
  await sandboxes.create(token());
});

test("one sandbox can't flood the server", async () => {
  const { sandboxes, clock } = registry({ requestsPerMinute: 3, maxWrites: 2 });
  const sandbox = await sandboxes.create(token());
  for (let i = 0; i < 3; i++) sandboxes.admit(sandbox, false);
  assert.throws(() => sandboxes.admit(sandbox, false), { status: 429, code: "rate_limited" });
  clock.now += 60_000;
  sandboxes.admit(sandbox, true);
  sandboxes.admit(sandbox, true);
  assert.throws(() => sandboxes.admit(sandbox, true), { status: 429, code: "demo_limit" });
  // Reading still works once the change limit is reached.
  clock.now += 60_000;
  sandboxes.admit(sandbox, false);
});

test("a failed seed leaves nothing behind and can be retried", async () => {
  let fail = true;
  const { sandboxes, removed } = registry({
    seed: async ({ tenantId }) => {
      if (fail) throw new Error("seed failed");
      return { tenantId };
    },
  });
  const mine = token();
  await assert.rejects(sandboxes.create(mine), /seed failed/);
  assert.deepEqual(removed, [sandboxTenantId(mine)]);
  assert.equal(sandboxes.find(mine), null);
  fail = false;
  assert.equal((await sandboxes.create(mine)).tenantId, sandboxTenantId(mine));
});

test("with the real demo: two sandboxes are separate agencies, and removal deletes one completely", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ams-demo-sandboxes-"));
  const repository = new SqliteAmsRepository(join(directory, "agency.sqlite"));
  const files = new LocalAmsFiles(join(directory, "files"));
  const chat = new SqliteAmsChat(repository);
  const demo = new LocalAmsDemo(directory, repository, files, members);
  t.after(async () => {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sandboxes = new DemoSandboxes({
    seed: async (input) => {
      const info = await demo.seed(input);
      await chat.post(info.tenantId, "team", { id: randomUUID(), authorId: "local_admin", body: "Morning.", createdAt: input.startedAt });
      return info;
    },
    remove: async (tenantId) => {
      await repository.deleteTenant(tenantId);
      await files.removeAll(`ams-documents/${tenantId}`);
    },
    ttlMs: 60_000,
    max: 10,
    perMinute: 10,
  });
  const [mine, theirs] = [token(), token()];
  const a = await sandboxes.create(mine);
  const b = await sandboxes.create(theirs);

  const accounts = async (tenantId) => (await repository.list(tenantId, "accounts", {})).items;
  const mineBefore = await accounts(a.tenantId);
  assert.ok(mineBefore.length > 0, "the sandbox is seeded with the fictional agency");
  assert.equal((await accounts(b.tenantId)).length, mineBefore.length);
  // Same fictional agency, separate records: neither tenant can read the other's ids.
  assert.equal(await repository.get(b.tenantId, "accounts", a.info.accountId), null);
  assert.ok(await repository.get(a.tenantId, "accounts", a.info.accountId));
  assert.ok(await chat.last(a.tenantId, "team"));
  const stored = await readdir(join(directory, "files", "ams-documents")).catch(() => []);

  // The local demo's own state file is untouched by sandboxes.
  assert.equal(demo.info(), null);

  await sandboxes.create(token(), mine);
  assert.deepEqual(await accounts(a.tenantId), []);
  assert.deepEqual((await repository.history(a.tenantId)).items, []);
  assert.equal(await chat.last(a.tenantId, "team"), null);
  assert.equal((await accounts(b.tenantId)).length, mineBefore.length, "the other visitor keeps everything");
  if (stored.includes(a.tenantId))
    assert.ok(!(await readdir(join(directory, "files", "ams-documents"))).includes(a.tenantId));

  assert.throws(() => repository.deleteTenant("local_agency"), /Only a demo tenant/);
});
