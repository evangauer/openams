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
  tenantId: "agency",
  userId: "manager",
  name: "Manager",
  role: "manager",
};
const reject = (p, code) => assert.rejects(p, (e) => e.code === code);
async function fixture(t, adapter) {
  const dir = await mkdtemp(join(tmpdir(), "ams-reminders-"));
  let repository =
    openRepository(join(dir, "db.sqlite"));
  let at = "2026-11-07T05:30:00Z";
  const members = [
    { id: "manager", role: "manager", active: true },
    { id: "csr", role: "member", active: true },
  ].map((m) => ({ ...m, name: m.id, email: `${m.id}@example.test` }));
  const service = () =>
    new AmsService({
      repository,
      members: async () => members,
      now: () => new Date(at),
      timeZone: async () => "America/Chicago",
    });
  const run = (action, kind, data = {}, record, extra = {}, as = actor) =>
    service().execute(as, {
      id: randomUUID(),
      action,
      kind,
      data,
      reason: "Reviewed fixture",
      ...(record
        ? { recordId: record.id, expectedVersion: record.version }
        : {}),
      ...extra,
    });
  const get = (kind, id) => repository.get(actor.tenantId, kind, id);
  const list = async (kind) =>
    (
      await repository.list(
        actor.tenantId,
        kind,
        AmsListSchema.parse({ limit: 100 }),
      )
    ).items;
  t.after(async () => {
    repository.close?.();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    service,
    run,
    get,
    list,
    members,
    setTime: (v) => {
      at = v;
    },
    get repository() {
      return repository;
    },
    restart() {
      if (adapter === "sqlite") {
        repository.close();
        repository = openRepository(join(dir, "db.sqlite"));
      }
    },
  };
}
for (const adapter of ["sqlite"]) {
  test(`${adapter}: reminders persist, respect the agency date, and deliver once`, async (t) => {
    const f = await fixture(t, adapter);
    let task = (
      await f.run("create", "tasks", {
        title: "Collect renewal information",
        ownerId: "csr",
        dueDate: "2026-11-07",
      })
    ).records[0];
    const id = randomUUID();
    const original = task;
    const result = await f.run(
      "task.followUp",
      "tasks",
      {
        reminderDaysBefore: 0,
        escalationAfterDays: 2,
        escalationOwnerId: "manager",
      },
      task,
      { id },
    );
    task = result.records.find((r) => r.kind === "tasks");
    assert.equal((await f.list("reminders")).length, 2);
    assert.equal(
      (
        await f.run(
          "task.followUp",
          "tasks",
          {
            reminderDaysBefore: 0,
            escalationAfterDays: 2,
            escalationOwnerId: "manager",
          },
          original,
          { id },
        )
      ).replayed,
      true,
    );
    assert.equal(
      (await f.service().processDueReminders("agency")).processed,
      0,
    ); // Still Nov 6 in Chicago.
    assert.equal(
      (await f.service().processDueReminders("other-agency")).processed,
      0,
    );
    f.restart();
    f.setTime("2026-11-07T06:00:00Z");
    assert.equal(
      (await f.service().processDueReminders("agency")).processed,
      1,
    );
    assert.equal(
      (await f.service().processDueReminders("agency")).processed,
      0,
    );
    const ready = (await f.list("reminders")).find(
      (r) => r.data.status === "ready",
    );
    assert.equal(ready.data.ownerId, "csr");
    await reject(
      f.run("reminder.deliver", "reminders", {}, ready),
      "worker_required",
    );
    await reject(
      f.run(
        "reminder.dismiss",
        "reminders",
        {},
        ready,
        {},
        { ...actor, userId: "other", role: "member" },
      ),
      "recipient_required",
    );
    await reject(
      f.run("reminder.snooze", "reminders", { dueDate: "2026-11-07" }, ready),
      "invalid_snooze",
    );
    await f.run(
      "reminder.snooze",
      "reminders",
      { dueDate: "2026-11-10" },
      ready,
    );
    assert.equal((await f.get("tasks", task.id)).data.dueDate, "2026-11-07");
    f.setTime("2026-11-09T12:00:00Z");
    assert.equal(
      (await f.service().processDueReminders("agency")).processed,
      1,
    );
    assert.equal(
      (await f.list("reminders")).find((r) => r.data.type === "escalation").data
        .status,
      "ready",
    );
    await f.run("task.complete", "tasks", {}, task);
    assert.ok(
      (await f.list("reminders")).every((r) => r.data.status === "cancelled"),
    );
    f.setTime("2026-11-10T12:00:00Z");
    assert.equal(
      (await f.service().processDueReminders("agency")).processed,
      0,
    );
  });
  test(`${adapter}: reassignment cancels stale reminders; inactive recipients are visible and retryable`, async (t) => {
    const f = await fixture(t, adapter);
    f.setTime("2026-11-07T12:00:00Z");
    let task = (
      await f.run("create", "tasks", {
        title: "Follow up",
        ownerId: "csr",
        dueDate: "2026-11-07",
      })
    ).records[0];
    task = (
      await f.run("task.followUp", "tasks", { reminderDaysBefore: 0 }, task)
    ).records.find((r) => r.kind === "tasks");
    f.members[1].active = false;
    await f.service().processDueReminders("agency");
    let reminder = (await f.list("reminders"))[0];
    assert.equal(reminder.data.status, "blocked");
    f.members[1].active = true;
    reminder = (await f.run("reminder.retry", "reminders", {}, reminder))
      .records[0];
    await f.service().processDueReminders("agency");
    assert.equal((await f.get("reminders", reminder.id)).data.status, "ready");
    task = (
      await f.run(
        "update",
        "tasks",
        { ownerId: "manager", dueDate: "2026-11-08" },
        task,
      )
    ).records.find((r) => r.kind === "tasks");
    assert.equal(
      (await f.get("reminders", reminder.id)).data.status,
      "cancelled",
    );
    assert.equal(
      (await f.list("reminders")).find((r) => r.data.status === "scheduled")
        .data.ownerId,
      "manager",
    );
    await reject(
      f.run("update", "tasks", { reminderGeneration: 99 }, task),
      "immutable_field",
    );
    await reject(
      f.run("create", "reminders", {}),
      "specialized_action_required",
    );
  });
  test(`${adapter}: recurrence is atomic, skips missed dates, and cannot be duplicated by replay or reopening`, async (t) => {
    const f = await fixture(t, adapter);
    f.setTime("2026-11-18T12:00:00Z");
    let task = (
      await f.run("create", "tasks", {
        title: "Weekly client follow-up",
        ownerId: "csr",
        dueDate: "2026-11-01",
      })
    ).records[0];
    task = (
      await f.run(
        "task.followUp",
        "tasks",
        {
          repeatEveryDays: 7,
          repeatUntil: "2026-11-25",
          reminderDaysBefore: 0,
        },
        task,
      )
    ).records.find((r) => r.kind === "tasks");
    const id = randomUUID();
    const completed = await f.run("task.complete", "tasks", {}, task, { id });
    assert.equal(
      (await f.run("task.complete", "tasks", {}, task, { id })).replayed,
      true,
    );
    const tasks = await f.list("tasks");
    assert.equal(tasks.length, 2);
    const original = tasks.find((r) => r.id === task.id),
      next = tasks.find((r) => r.id !== task.id);
    assert.equal(next.data.dueDate, "2026-11-22");
    assert.equal(next.data.previousTaskId, task.id);
    assert.equal(original.data.nextTaskId, next.id);
    await reject(
      f.run("task.reopen", "tasks", {}, original),
      "recurring_successor_exists",
    );
    await reject(
      f.run("task.complete", "tasks", {}, original),
      "task_completed",
    );
    await f.run("task.complete", "tasks", {}, next);
    assert.equal((await f.list("tasks")).length, 2);
    assert.ok(completed.audit.records.some((r) => r.id === next.id));
  });
  test(`${adapter}: cancelled account work does not notify; escalation requires a manager`, async (t) => {
    const f = await fixture(t, adapter);
    const account = (
      await f.run("create", "accounts", { name: "Test account" })
    ).records[0];
    let task = (
      await f.run("create", "tasks", {
        accountId: account.id,
        title: "Review",
        ownerId: "csr",
        dueDate: "2026-11-07",
      })
    ).records[0];
    await reject(
      f.run(
        "task.followUp",
        "tasks",
        { escalationAfterDays: 1, escalationOwnerId: "csr" },
        task,
      ),
      "invalid_escalation_owner",
    );
    task = (
      await f.run("task.followUp", "tasks", { reminderDaysBefore: 0 }, task)
    ).records.find((r) => r.kind === "tasks");
    await f.run("archive", "accounts", {}, account);
    f.setTime("2026-11-07T12:00:00Z");
    await f.service().processDueReminders("agency");
    assert.equal((await f.list("reminders"))[0].data.status, "cancelled");
  });
}
