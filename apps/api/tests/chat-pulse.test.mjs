// What an idle chat costs: a pulse reuses a reader's summaries until the agency's chat
// actually changes, and the member list is read once for a burst of chat requests,
// without ever turning away someone who just joined.
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
import { LocalAmsFiles } from "../dist/files.js";
import { backend, firebaseServices } from "./support/backend.mjs";

const member = (id, active = true) => ({ id, name: id, email: `${id}@harbor-test.example`, role: "member", active });

test(`${backend}: an idle pulse reads no threads, and the member list is read once per burst`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ams-chat-pulse-"));
  const repository = new SqliteAmsRepository(join(dir, "agency.sqlite"));
  const store =
    backend === "firebase"
      ? new FirestoreAmsChat((await firebaseServices()).firestore, `chatpulse_${randomUUID().replaceAll("-", "")}`)
      : new SqliteAmsChat(repository);
  const calls = {};
  const chat = new Proxy(store, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== "function") return value;
      return (...args) => {
        calls[name] = (calls[name] ?? 0) + 1;
        return value.apply(target, args);
      };
    },
  });
  const members = [member("ana"), member("ben"), member("cy")];
  let memberReads = 0;
  const app = express();
  app.use(express.json());
  app.use(
    createAmsRouter({
      authenticate: (_req, _res, next) => next(),
      actor: (req) => ({ tenantId: "agency-1", userId: req.header("authorization").replace("Bearer ", ""), name: "x", role: "member" }),
      enabled: async () => true,
      repository: () => repository,
      files: new LocalAmsFiles(join(dir, "files")),
      members: async () => {
        memberReads += 1;
        return members.map((m) => ({ ...m }));
      },
      workspaceName: async () => "Fixture agency",
      timeZone: async () => "America/Chicago",
      chat,
    }),
  );
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || "internal" }));
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
      headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const pulse = async (who) => (await call(who, "/ams/chat/pulse", { active: true })).body;
  const unread = (body, thread) => body.threads.find((row) => row.thread === thread)?.unread;
  const threadReads = () => (calls.summary ?? 0) + (calls.last ?? 0) + (calls.unread ?? 0);

  // First pulse reads each of the reader's threads once (team + two teammates).
  const first = await pulse("ben");
  assert.equal(first.threads.length, 3);
  assert.equal(threadReads(), 3);
  // Idle: ten more pulses read no threads at all, and the answer is the same.
  for (let i = 0; i < 10; i++) assert.deepEqual((await pulse("ben")).threads, first.threads);
  assert.equal(threadReads(), 3);
  // Every pulse still records presence and returns it fresh.
  assert.equal(calls.touch, 11);
  assert.ok((await pulse("ana")).seen.ben);
  // The member list was read once for all of that, by two different people.
  assert.equal(memberReads, 1);

  // A message changes the version: the next pulse sees it, for every reader.
  let before = threadReads();
  const sent = await call("ana", "/ams/chat/team/messages", { id: randomUUID(), body: "Fictional hello" });
  assert.equal(sent.status, 200);
  assert.equal(unread(await pulse("ben"), "team"), 1);
  assert.equal(unread(await pulse("ana"), "team"), 0);
  assert.equal(unread(await pulse("cy"), "team"), 1);
  assert.equal(threadReads(), before + 9);
  // Reading it changes the version too, so the count clears on the next pulse.
  assert.equal((await call("ben", "/ams/chat/team/read", { sequence: sent.body.sequence })).status, 200);
  assert.equal(unread(await pulse("ben"), "team"), 0);
  // …and then it is idle again.
  before = threadReads();
  await pulse("ben");
  await pulse("ben");
  assert.equal(threadReads(), before);

  // Someone who just joined is not turned away by the remembered list, and can be
  // written to straight away; neither needs the list to expire first.
  members.push(member("dev"));
  let reads = memberReads;
  const joined = await pulse("dev");
  assert.equal(joined.threads.length, 4);
  assert.equal(memberReads, reads + 1);
  members.push(member("eli"));
  assert.equal((await call("ana", "/ams/chat/direct/eli/messages", { id: randomUUID(), body: "Fictional welcome" })).status, 200);
  // A reader whose team changed gets the new thread on their next pulse.
  assert.equal((await pulse("ben")).threads.length, 5);
  // Someone deactivated can't be written to, even while the old list is remembered.
  members.find((m) => m.id === "cy").active = false;
  assert.equal((await call("ana", "/ams/chat/direct/cy/messages", { id: randomUUID(), body: "Fictional" })).status, 404);
  // A stranger is refused, after one fresh look and no more per request than that.
  reads = memberReads;
  assert.equal((await call("zed", "/ams/chat/pulse", {})).status, 403);
  assert.equal(memberReads, reads + 1);
});
