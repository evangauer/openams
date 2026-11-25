import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmsService } from "../dist/service.js";
import { AmsError } from "../dist/repository.js";
import { DEMO_BOOK } from "../dist/demo-book.js";
import { LocalAmsDemo, localDemoToken } from "../dist/local-demo.js";
import { openRepository, openFiles } from "./support/backend.mjs";
import { AmsListSchema } from "@openams/contracts";
import express from "express";
import { createAmsRouter } from "../dist/routes.js";

const actor = {
  tenantId: "local_agency",
  userId: "local_admin",
  name: "Admin",
  role: "admin",
};
const profile = {
  name: "Fictional pilot agency",
  timeZone: "America/Chicago",
  defaultOwnerId: "local_member",
  calendarAcknowledged: true,
};
const reject = (promise, code) =>
  assert.rejects(promise, (error) => error.code === code);
async function fixture(t, adapter = "sqlite") {
  const dir = await mkdtemp(join(tmpdir(), "ams-setup-"));
  const repository = openRepository(join(dir, "records.sqlite"));
  const files = openFiles(join(dir, "files"));
  const members = ["admin", "manager", "member", "accountant", "viewer"].map(
    (role) => ({
      id: `local_${role}`,
      name: `Local ${role}`,
      email: `${role}@example.test`,
      role,
      active: true,
    }),
  );
  const service = new AmsService({
    repository,
    members: async () => members,
    now: () => new Date("2026-11-08T01:00:00Z"),
    timeZone: async () => {
      throw new AmsError(503, "agency_time_zone_required", "Choose a calendar");
    },
  });
  const run = (action, kind, data, record, extra = {}, as = actor) =>
    service.execute(as, {
      id: randomUUID(),
      action,
      kind,
      data,
      reason: "Fictional setup review",
      ...(record
        ? { recordId: record.id, expectedVersion: record.version }
        : {}),
      ...extra,
    });
  const list = async (tenantId, kind) =>
    (await repository.list(tenantId, kind, AmsListSchema.parse({ limit: 100 })))
      .items;
  t.after(async () => {
    repository.close?.();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, repository, files, members, service, run, list };
}
for (const adapter of ["sqlite"]) {
  test(`${adapter}: first agency setup is singleton, role-checked, versioned and retry-safe`, async (t) => {
    const f = await fixture(t, adapter);
    await reject(
      f.run("create", "accounts", { name: "Before calendar" }),
      "agency_time_zone_required",
    );
    for (const role of ["member", "accountant", "viewer"])
      await reject(
        f.run(
          "workspace.configure",
          "workspace",
          profile,
          null,
          {},
          { ...actor, role },
        ),
        "permission_denied",
      );
    await reject(
      f.run("workspace.configure", "workspace", {
        ...profile,
        calendarAcknowledged: false,
      }),
      "invalid_request",
    );
    await reject(
      f.run("workspace.configure", "workspace", {
        ...profile,
        defaultOwnerId: "outside-agency",
      }),
      "invalid_owner",
    );
    const commandId = randomUUID();
    await reject(
      f.run("workspace.configure", "workspace", {
        ...profile,
        defaultOwnerId: "local_viewer",
      }),
      "invalid_owner",
    );
    const result = await f.run(
      "workspace.configure",
      "workspace",
      profile,
      null,
      { id: commandId },
    );
    const setup = result.records[0];
    assert.equal(setup.id, "agency");
    assert.equal(setup.data.timeZone, "America/Chicago");
    assert.equal(result.audit.actorId, actor.userId);
    assert.equal(
      (
        await f.run("workspace.configure", "workspace", profile, null, {
          id: commandId,
        })
      ).replayed,
      true,
    );
    await reject(
      f.run("workspace.configure", "workspace", profile),
      "version_required",
    );
    await reject(
      f.run("create", "workspace", profile),
      "specialized_action_required",
    );
    await reject(
      f.run("update", "workspace", { name: "Unreviewed" }, setup),
      "immutable_record",
    );
    await reject(
      f.run("archive", "workspace", {}, setup),
      "lifecycle_required",
    );
    const updated = (
      await f.run(
        "workspace.configure",
        "workspace",
        { ...profile, name: "Updated agency" },
        setup,
      )
    ).records[0];
    await reject(
      f.run("workspace.configure", "workspace", profile, setup),
      "stale_record",
    );
    assert.equal((await f.list(actor.tenantId, "workspace")).length, 1);
    assert.equal(updated.revision, 2);
    const task = (
      await f.run("create", "tasks", {
        title: "Agency calendar reminder",
        dueDate: "2026-11-08",
        ownerId: actor.userId,
      })
    ).records[0];
    await f.run("task.followUp", "tasks", { reminderDaysBefore: 0 }, task);
    assert.equal(
      (await f.service.processDueReminders(actor.tenantId)).processed,
      0,
      "Nov 7 in the selected agency calendar",
    );
  });
}

// The walkthrough account and its policy, plus the fictional book around it.
const demoAccounts = 1 + DEMO_BOOK.length;
const demoPolicies =
  1 +
  DEMO_BOOK.flatMap((a) => a.policies).reduce(
    (n, p) => n + (p.priorPremium ? 2 : 1),
    0,
  );

test("demo resumes after restart and reset creates an isolated copy while preserving the working book", async (t) => {
  const f = await fixture(t);
  await f.run("workspace.configure", "workspace", profile);
  const own = (
    await f.run("create", "accounts", { name: "Working agency record" })
  ).records[0];
  let demo = new LocalAmsDemo(f.dir, f.repository, f.files, f.members);
  await demo.load();
  const command = {
    commandId: randomUUID(),
    restart: false,
    expectedTenantId: null,
  };
  const first = await demo.start(command);
  assert.equal((await f.list(first.tenantId, "accounts")).length, demoAccounts);
  assert.equal((await f.list(actor.tenantId, "accounts")).length, 1);
  assert.equal(
    (await f.repository.get(actor.tenantId, "accounts", own.id)).version,
    own.version,
  );
  assert.equal(
    await f.repository.get(actor.tenantId, "accounts", first.accountId),
    null,
  );
  const email = await f.repository.get(
    first.tenantId,
    "correspondence",
    first.emailId,
  );
  const doc = await f.repository.get(
    first.tenantId,
    "documents",
    email.data.originalDocumentId,
  );
  assert.match(
    (await f.files.get(doc.data.storageKey)).toString(),
    /Morgan Chen/,
  );
  assert.equal(email.data.documentIds.length, 2);
  assert.equal(
    (await f.list(first.tenantId, "reminders")).find(
      (r) => r.data.type === "due",
    ).data.status,
    "ready",
  );
  demo = new LocalAmsDemo(f.dir, f.repository, f.files, f.members);
  await demo.load();
  assert.deepEqual(demo.info(), first);
  assert.deepEqual(
    await demo.start({ ...command, commandId: randomUUID() }),
    first,
  );
  const reset = {
    commandId: randomUUID(),
    restart: true,
    expectedTenantId: first.tenantId,
  };
  const second = await demo.start(reset);
  assert.notEqual(second.tenantId, first.tenantId);
  assert.deepEqual(
    await demo.start(reset),
    second,
    "lost reset response safely replays",
  );
  await reject(
    demo.start({ ...reset, commandId: randomUUID() }),
    "demo_changed",
  );
  assert.equal(
    (await f.list(first.tenantId, "accounts")).length,
    demoAccounts,
    "prior demo is retained",
  );
  assert.equal((await f.list(actor.tenantId, "accounts")).length, 1);
  assert.notEqual(localDemoToken("fixture"), "fixture");
  assert.equal(localDemoToken("fixture"), localDemoToken("fixture"));
});

test("interrupted demo preparation resumes committed steps without duplicate accounts or policy postings", async (t) => {
  const f = await fixture(t);
  let fail = true;
  const files = {
    get: (...args) => f.files.get(...args),
    put: (...args) => {
      if (fail) {
        fail = false;
        throw new Error("Isolated interrupted file write");
      }
      return f.files.put(...args);
    },
  };
  let demo = new LocalAmsDemo(f.dir, f.repository, files, f.members);
  await demo.load();
  await assert.rejects(
    demo.start({
      commandId: randomUUID(),
      restart: false,
      expectedTenantId: null,
    }),
    /interrupted/,
  );
  assert.equal(demo.info(), null);
  demo = new LocalAmsDemo(f.dir, f.repository, files, f.members);
  await demo.load();
  const result = await demo.start({
    commandId: randomUUID(),
    restart: false,
    expectedTenantId: null,
  });
  assert.equal(
    (await f.list(result.tenantId, "accounts")).length,
    demoAccounts,
  );
  assert.equal(
    (await f.list(result.tenantId, "commissions")).length,
    demoPolicies,
  );
  assert.equal((await f.list(result.tenantId, "correspondence")).length, 1);
  assert.equal((await f.list(result.tenantId, "workspace")).length, 1);
});

test("HTTP setup opens before calendar configuration, but operational writes and demo activation retain their boundaries", async (t) => {
  const f = await fixture(t);
  const app = express();
  app.use(express.json());
  app.use(
    createAmsRouter({
      authenticate: (req, res, next) =>
        req.header("authorization")
          ? next()
          : res.status(401).json({ error: "unauthorized" }),
      actor: (req) => ({
        ...actor,
        role:
          req.header("authorization") === "Bearer viewer" ? "viewer" : "admin",
      }),
      enabled: async () => true,
      repository: () => f.repository,
      files: f.files,
      members: async () => f.members,
      workspaceName: async () => "Unconfigured agency",
      timeZone: async () => {
        throw new AmsError(
          503,
          "agency_time_zone_required",
          "Choose a calendar",
        );
      },
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.code || "internal" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, data, role = "admin") =>
    fetch(base + path, {
      method: data ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${role}`,
        "Content-Type": "application/json",
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  let session = await (await request("/ams/session")).json();
  assert.equal(session.calendarConfigured, false);
  assert.equal(session.demoAvailable, false);
  assert.equal(session.demo, null);
  assert.equal(
    (await request("/ams/demo/start", { commandId: randomUUID() })).status,
    404,
  );
  assert.equal(
    (
      await request("/ams/commands", {
        id: randomUUID(),
        action: "create",
        kind: "accounts",
        data: { name: "Too early" },
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await request(
        "/ams/commands",
        {
          id: randomUUID(),
          action: "workspace.configure",
          kind: "workspace",
          data: profile,
        },
        "viewer",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/ams/commands", {
        id: randomUUID(),
        action: "workspace.configure",
        kind: "workspace",
        data: profile,
      })
    ).status,
    200,
  );
  session = await (await request("/ams/session")).json();
  assert.equal(session.calendarConfigured, true);
  assert.equal(session.timeZone, profile.timeZone);
  assert.equal(session.workspaceName, profile.name);
  assert.equal(session.defaultOwnerId, profile.defaultOwnerId);
  assert.equal(
    (
      await request("/ams/commands", {
        id: randomUUID(),
        action: "create",
        kind: "accounts",
        data: { name: "Ready for first account" },
      })
    ).status,
    200,
  );
});
