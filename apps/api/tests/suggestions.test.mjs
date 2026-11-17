import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmsService } from "../dist/service.js";
import { openRepository } from "./support/backend.mjs";
import { amsCanWrite } from "@openams/contracts";

const roles = ["admin", "manager", "member", "accountant", "viewer"];
const as = (role) => ({
  tenantId: "local_agency",
  userId: `local_${role}`,
  name: `Local ${role}`,
  role,
});
const reject = (promise, code) =>
  assert.rejects(promise, (error) => error.code === code);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ams-suggestions-"));
  const repository = openRepository(join(dir, "records.sqlite"));
  const members = roles.map((role) => ({
    id: `local_${role}`,
    name: `Local ${role}`,
    email: `${role}@example.test`,
    role,
    active: true,
  }));
  const service = new AmsService({
    repository,
    members: async () => members,
    now: () => new Date("2026-11-08T15:00:00Z"),
    timeZone: async () => "America/Chicago",
  });
  const run = (role, action, kind, data, record) =>
    service.execute(as(role), {
      id: randomUUID(),
      action,
      kind,
      data,
      reason: "",
      ...(record
        ? { recordId: record.id, expectedVersion: record.version }
        : {}),
    });
  t.after(async () => {
    repository.close?.();
    await rm(dir, { recursive: true, force: true });
  });
  return { run };
}

test("every role, viewers included, may write suggestions", () => {
  for (const role of roles) assert.equal(amsCanWrite(role, "suggestions"), true);
  // The exception is scoped: viewers still cannot write anything else.
  assert.equal(amsCanWrite("viewer", "tasks"), false);
});

test("suggestions start new, take support from teammates and keep managed fields", async (t) => {
  const f = await fixture(t);
  await reject(
    f.run("viewer", "create", "suggestions", {
      title: "Bulk renewal letters",
      status: "planned",
    }),
    "lifecycle_required",
  );
  await reject(
    f.run("viewer", "create", "suggestions", {
      title: "Bulk renewal letters",
      votes: ["local_admin"],
    }),
    "lifecycle_required",
  );
  let [idea] = (
    await f.run("viewer", "create", "suggestions", {
      title: "Bulk renewal letters",
      detail: "Send one reminder letter to every account renewing next month.",
      area: "renewals",
    })
  ).records;
  assert.equal(idea.data.status, "new");
  assert.deepEqual(idea.data.votes, []);

  [idea] = (await f.run("member", "suggestion.vote", "suggestions", { support: true }, idea)).records;
  [idea] = (await f.run("accountant", "suggestion.vote", "suggestions", { support: true }, idea)).records;
  assert.deepEqual(idea.data.votes, ["local_member", "local_accountant"]);
  await reject(
    f.run("member", "suggestion.vote", "suggestions", { support: true }, idea),
    "vote_unchanged",
  );
  [idea] = (await f.run("member", "suggestion.vote", "suggestions", { support: false }, idea)).records;
  assert.deepEqual(idea.data.votes, ["local_accountant"]);

  // Only the author edits the wording, and never the managed fields.
  await reject(
    f.run("member", "update", "suggestions", { title: "Something else" }, idea),
    "author_required",
  );
  await reject(
    f.run("viewer", "update", "suggestions", { votes: [] }, idea),
    "immutable_field",
  );
  await reject(
    f.run("viewer", "update", "suggestions", { status: "done" }, idea),
    "immutable_field",
  );
  [idea] = (
    await f.run("viewer", "update", "suggestions", { title: "Bulk renewal reminder letters" }, idea)
  ).records;
  assert.equal(idea.data.title, "Bulk renewal reminder letters");
  assert.deepEqual(idea.data.votes, ["local_accountant"]);

  // Status and replies belong to administrators and managers.
  await reject(
    f.run("member", "suggestion.respond", "suggestions", { status: "planned", response: "" }, idea),
    "manager_required",
  );
  await reject(
    f.run("manager", "suggestion.respond", "suggestions", { status: "shipped", response: "" }, idea),
    "invalid_request",
  );
  [idea] = (
    await f.run("manager", "suggestion.respond", "suggestions", {
      status: "planned",
      response: "We will try this with the March renewals.",
    }, idea)
  ).records;
  assert.equal(idea.data.status, "planned");
  assert.equal(idea.data.response, "We will try this with the March renewals.");
  assert.deepEqual(idea.data.votes, ["local_accountant"]);
});
