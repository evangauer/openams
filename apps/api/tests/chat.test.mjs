import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { createAmsRouter } from "../dist/routes.js";
import { SqliteAmsRepository } from "../dist/sqlite-repository.js";
import { SqliteAmsChat } from "../dist/chat.js";
import { FirestoreAmsChat } from "../dist/firebase/firestore-chat.js";
import {
  backend,
  openRepository,
  firebaseServices,
} from "./support/backend.mjs";
import { LocalAmsFiles } from "../dist/files.js";

const member = (id, role, active = true) => ({
  id,
  role,
  name: `Fixture ${id}`,
  email: `${id}@agency.example.test`,
  active,
});

test(`${backend}: team chat keeps one-to-one threads private, sends once, counts unread and tracks presence`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ams-chat-"));
  const repository = openRepository(join(dir, "agency.sqlite"));
  const chat =
    backend === "firebase"
      ? new FirestoreAmsChat(
          (await firebaseServices()).firestore,
          `chat_${randomUUID().replaceAll("-", "")}`,
        )
      : new SqliteAmsChat(repository);
  const members = [
    member("ana", "admin"),
    member("ben", "member"),
    member("cy", "viewer"),
    member("dee", "member", false),
  ];
  const app = express();
  app.use(express.json());
  app.use(
    createAmsRouter({
      authenticate: (req, res, next) => {
        if (!req.header("authorization"))
          return res.status(401).json({ error: "unauthorized" });
        next();
      },
      actor: (req) => {
        const userId = req.header("authorization").replace("Bearer ", "");
        return {
          tenantId: userId === "stranger" ? "other-agency" : "agency-1",
          userId,
          name: userId,
          role: members.find((m) => m.id === userId)?.role ?? "member",
        };
      },
      enabled: async () => true,
      repository: () => repository,
      files: new LocalAmsFiles(join(dir, "files")),
      members: async (tenantId) => (tenantId === "agency-1" ? members : []),
      workspaceName: async () => "Fixture agency",
      timeZone: async () => "America/Chicago",
      chat,
    }),
  );
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.code || "internal" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (who, path, body) => {
    const response = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${who}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const send = (who, path, text, id = randomUUID()) =>
    call(who, `/ams/chat/${path}/messages`, { id, body: text });

  assert.equal((await call("ana", "/ams/session")).body.chatEnabled, true);

  // Only active members of the agency can use chat.
  assert.equal((await call("stranger", "/ams/chat/pulse", {})).status, 403);
  assert.equal((await call("dee", "/ams/chat/pulse", {})).status, 403);

  // A retried send is saved once; reusing its id for other text is refused.
  const id = randomUUID();
  const first = await send("ana", "team", "  Morning, team.  ", id);
  assert.equal(first.status, 200);
  assert.equal(first.body.body, "Morning, team.");
  const retry = await send("ana", "team", "Morning, team.", id);
  assert.equal(retry.body.sequence, first.body.sequence);
  assert.equal((await send("ana", "team", "Something else", id)).status, 409);
  assert.equal((await send("ana", "team", "   ")).status, 400);
  assert.equal((await send("ana", "team", "x".repeat(4001))).status, 400);

  // One-to-one: both people share one thread; nobody else can reach it.
  assert.equal(
    (await send("ana", "direct/ben", "Payroll looks right?")).status,
    200,
  );
  const benSide = await call("ben", "/ams/chat/direct/ana/messages");
  assert.deepEqual(
    benSide.body.messages.map((m) => [m.authorId, m.body]),
    [["ana", "Payroll looks right?"]],
  );
  const cySide = await call("cy", "/ams/chat/direct/ana/messages");
  assert.deepEqual(cySide.body.messages, []);
  assert.equal((await send("ana", "direct/ana", "Note to self")).status, 404);
  assert.equal((await send("ana", "direct/dee", "Are you there?")).status, 404);
  assert.equal((await send("ana", "direct/nobody", "Hello")).status, 404);
  assert.equal(
    (await call("ana", "/ams/chat/direct/dee/messages")).status,
    200,
  );

  // Unread counts other people's messages after your marker, never your own.
  let pulse = (await call("ben", "/ams/chat/pulse", {})).body;
  const unread = (body, thread) =>
    body.threads.find((row) => row.thread === thread)?.unread;
  assert.equal(unread(pulse, "team"), 1);
  assert.equal(unread(pulse, "direct:ana"), 1);
  assert.equal(
    unread(pulse, "direct:dee"),
    undefined,
    "inactive members are hidden",
  );
  assert.equal(
    pulse.threads.find((row) => row.thread === "direct:ana").last.body,
    "Payroll looks right?",
  );
  assert.equal(
    unread((await call("ana", "/ams/chat/pulse", {})).body, "team"),
    0,
  );
  await call("ben", "/ams/chat/direct/ana/read", {
    sequence: benSide.body.messages[0].sequence,
  });
  pulse = (await call("ben", "/ams/chat/pulse", {})).body;
  assert.equal(unread(pulse, "direct:ana"), 0);
  // Markers only move forward.
  await call("ben", "/ams/chat/direct/ana/read", { sequence: 0 });
  pulse = (await call("ben", "/ams/chat/pulse", {})).body;
  assert.equal(unread(pulse, "direct:ana"), 0);

  // Presence: an active pulse marks you seen; a hidden tab's pulse does not.
  assert.ok(pulse.seen.ben && pulse.seen.ana);
  assert.equal(
    (await call("cy", "/ams/chat/pulse", { active: false })).body.seen.cy,
    undefined,
  );

  // History pages forward with `after` and backward with `before`.
  for (let n = 1; n <= 5; n += 1) await send("ben", "team", `Update ${n}`);
  const latest = (await call("ana", "/ams/chat/team/messages?limit=2")).body
    .messages;
  assert.deepEqual(
    latest.map((m) => m.body),
    ["Update 4", "Update 5"],
  );
  const earlier = (
    await call(
      "ana",
      `/ams/chat/team/messages?limit=2&before=${latest[0].sequence}`,
    )
  ).body.messages;
  assert.deepEqual(
    earlier.map((m) => m.body),
    ["Update 2", "Update 3"],
  );
  const newer = (
    await call("ana", `/ams/chat/team/messages?after=${earlier[1].sequence}`)
  ).body.messages;
  assert.deepEqual(
    newer.map((m) => m.body),
    ["Update 4", "Update 5"],
  );
});

test("a chat write waits for a record save instead of stalling on its lock", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ams-chat-lock-"));
  const repository = new SqliteAmsRepository(join(dir, "agency.sqlite"));
  const chat = new SqliteAmsChat(repository);
  t.after(async () => {
    repository.close();
    await rm(dir, { recursive: true, force: true });
  });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  // A save that holds the write lock while it waits on other work.
  const saving = repository.transact("agency-1", async () => {
    await held;
    return "saved";
  });
  const started = Date.now();
  const posting = chat.post("agency-1", "team", {
    id: randomUUID(),
    authorId: "ana",
    body: "Hello",
    createdAt: new Date().toISOString(),
  });
  setTimeout(release, 50);
  const [saved, message] = await Promise.all([saving, posting]);
  assert.equal(saved, "saved");
  assert.equal(message.body, "Hello");
  assert.ok(Date.now() - started < 2000, "no lock wait");
});
