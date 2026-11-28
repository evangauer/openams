import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAmsRepository } from "../dist/sqlite-repository.js";
import { SqliteAmsChat } from "../dist/chat.js";
import { FirestoreAmsChat } from "../dist/firebase/firestore-chat.js";
import { backend, firebaseServices } from "./support/backend.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ams-chat-store-"));
  const root = `chatstore_${randomUUID().replaceAll("-", "")}`;
  let repository;
  const open = async () => {
    if (backend === "firebase")
      return new FirestoreAmsChat((await firebaseServices()).firestore, root);
    repository?.close();
    repository = new SqliteAmsRepository(join(directory, "agency.sqlite"));
    return new SqliteAmsChat(repository);
  };
  t.after(async () => {
    repository?.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store: await open(), open };
}
const at = "2026-11-12T01:00:00.000Z";
const message = (authorId, body, id = randomUUID()) => ({
  id,
  authorId,
  body,
  createdAt: at,
});

test(`${backend}: chat retries and concurrent posts retain one ordered original per id`, async (t) => {
  const { store, open } = await fixture(t);
  const original = message("alice", "Fictional review – café ✓");
  const retries = await Promise.all(
    Array.from({ length: 6 }, () => store.post("agency", "team", original)),
  );
  assert.ok(
    retries.every((m) => JSON.stringify(m) === JSON.stringify(retries[0])),
  );
  const [bob, alice] = await Promise.all([
    store.post("agency", "team", message("bob", "Fictional reply")),
    store.post("agency", "team", message("alice", "Fictional follow-up")),
  ]);
  assert.notEqual(bob.sequence, alice.sequence);
  const stored = await store.messages("agency", "team", { limit: 100 });
  assert.equal(stored.length, 3);
  assert.deepEqual(
    stored.map((m) => m.sequence),
    [...stored.map((m) => m.sequence)].sort((a, b) => a - b),
  );
  const replay = await store.post("agency", "team", {
    ...original,
    createdAt: "2026-11-13T01:00:00.000Z",
  });
  assert.equal(replay.createdAt, at);
  for (const [thread, changed] of [
    ["direct:alice:bob", original],
    ["team", { ...original, body: "Changed" }],
    ["team", { ...original, authorId: "bob" }],
  ]) {
    await assert.rejects(
      store.post("agency", thread, changed),
      (error) => error.code === "chat_id_reused",
    );
  }
  await store.post("other-agency", "team", {
    ...original,
    body: "Other fictional agency",
  });
  assert.equal(
    (await store.messages("agency", "direct:alice:bob", { limit: 100 })).length,
    0,
  );
  assert.equal(
    (await store.messages("other-agency", "team", { limit: 100 })).length,
    1,
  );
  const reopened = await open();
  assert.deepEqual(
    await reopened.messages("agency", "team", { limit: 100 }),
    stored,
  );
  assert.deepEqual(await reopened.last("agency", "team"), stored.at(-1));
});

test(`${backend}: chat pagination, unread markers and presence survive replay without hiding future messages`, async (t) => {
  const { store } = await fixture(t);
  const rows = [];
  for (const [author, body] of [
    ["alice", "First"],
    ["bob", "Second"],
    ["alice", "Third"],
    ["bob", "Fourth"],
  ])
    rows.push(
      await store.post("agency", "team", message(author, `Fictional ${body}`)),
    );
  const latest = await store.messages("agency", "team", { limit: 2 });
  assert.deepEqual(latest, rows.slice(2));
  assert.deepEqual(
    await store.messages("agency", "team", {
      before: latest[0].sequence,
      limit: 2,
    }),
    rows.slice(0, 2),
  );
  assert.deepEqual(
    await store.messages("agency", "team", {
      after: rows[1].sequence,
      limit: 2,
    }),
    rows.slice(2),
  );
  assert.deepEqual(
    await store.messages("agency", "team", { before: 0, limit: 2 }),
    [],
  );
  assert.equal(await store.unread("agency", "team", "alice"), 2);
  assert.equal(await store.unread("agency", "team", "bob"), 2);
  await store.markRead("agency", "team", "alice", rows[1].sequence);
  await store.markRead("agency", "team", "alice", 0);
  assert.equal(
    await store.readMarker("agency", "team", "alice"),
    rows[1].sequence,
  );
  assert.equal(await store.unread("agency", "team", "alice"), 1);
  await store.markRead("agency", "team", "bob", 1000000);
  assert.equal(
    await store.readMarker("agency", "team", "bob"),
    rows[3].sequence,
  );
  const next = await store.post(
    "agency",
    "team",
    message("alice", "Fictional new message"),
  );
  assert.equal(await store.unread("agency", "team", "bob"), 1);
  // Direct conversations do not borrow team read positions or unread counts.
  await store.post(
    "agency",
    "direct:alice:bob",
    message("bob", "Fictional private note"),
  );
  assert.equal(await store.unread("agency", "direct:alice:bob", "alice"), 1);
  assert.equal(
    await store.readMarker("agency", "direct:alice:bob", "alice"),
    0,
  );
  assert.equal(await store.readMarker("other-agency", "team", "bob"), 0);
  assert.equal((await store.last("agency", "team")).sequence, next.sequence);
  await store.markRead("agency", "empty", "alice", 999);
  assert.equal(await store.readMarker("agency", "empty", "alice"), 0);
  await store.touch("agency", "alice", "2026-11-12T01:10:00.000Z");
  await store.touch("agency", "alice", at);
  assert.equal((await store.seen("agency")).alice, "2026-11-12T01:10:00.000Z");
  assert.deepEqual(await store.seen("other-agency"), {});
  await store.touch("agency", "bob", at);
  assert.deepEqual(await store.seen("agency"), { alice: "2026-11-12T01:10:00.000Z", bob: at });
});

test(`${backend}: chat summaries match last and unread, and the version moves only when they could change`, async (t) => {
  const { store } = await fixture(t);
  assert.equal(await store.version("agency"), 0);
  assert.deepEqual(await store.summary("agency", "team", "alice"), { last: null, unread: 0 });
  const versions = [0];
  const moved = async (expected, why) => {
    const next = await store.version("agency");
    assert.equal(next > versions.at(-1), expected, why);
    versions.push(next);
  };
  const first = message("alice", "Fictional first");
  const one = await store.post("agency", "team", first);
  await moved(true, "a new message");
  await store.post("agency", "team", first);
  await moved(false, "a retried message");
  const two = await store.post("agency", "direct:alice:bob", message("alice", "Fictional note"));
  await moved(true, "a message in another conversation");
  for (const [conversation, reader] of [["team", "alice"], ["team", "bob"], ["direct:alice:bob", "bob"], ["empty", "bob"]])
    assert.deepEqual(await store.summary("agency", conversation, reader), {
      last: await store.last("agency", conversation),
      unread: await store.unread("agency", conversation, reader),
    });
  assert.deepEqual(await store.summary("agency", "team", "bob"), { last: one, unread: 1 });
  assert.deepEqual(await store.summary("agency", "direct:alice:bob", "alice"), { last: two, unread: 0 });
  await store.markRead("agency", "team", "bob", one.sequence);
  await moved(true, "a read marker moving");
  assert.equal((await store.summary("agency", "team", "bob")).unread, 0);
  await store.markRead("agency", "team", "bob", one.sequence);
  await store.markRead("agency", "team", "bob", 0);
  await moved(false, "a read marker that didn't move");
  await store.touch("agency", "bob", at);
  await moved(false, "presence");
  assert.equal(await store.version("other-agency"), 0);
});
