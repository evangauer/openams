import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteAmsRepository } from "../dist/sqlite-repository.js";
import {
  SqliteMailboxStore,
  FirestoreMailboxStore,
} from "../dist/mailbox-store.js";
import { MailboxVault } from "../dist/mailbox-credentials.js";
import { backend, firebaseServices } from "./support/backend.mjs";

const at = "2026-11-12T04:00:00Z";
const connection = (id = "connection1") => ({
  id,
  revision: 1,
  provider: "gmail",
  address: "agency@example.test",
  remoteId: "agency@example.test",
  createdAt: at,
  createdBy: "owner",
  state: "choose_folder",
  credentials: null,
  folder: null,
  cursor: null,
  hasMore: false,
  pending: null,
  lease: null,
  lastAttemptAt: null,
  lastSyncedAt: null,
  nextAttemptAt: null,
  error: null,
});
const message = (id = "message1", connectionId = "connection1") => ({
  id,
  revision: 1,
  connectionId,
  providerMessageId: `opaque+${id}/=`,
  queuedAt: at,
  receivedAt: at,
  status: "review",
  subject: "Fictional carrier update",
  from: "updates@example.test",
  to: "agency@example.test",
  body: "Review before filing.",
  bodyTruncated: false,
  attachmentCount: 0,
  direction: "inbound",
  original: null,
  filing: null,
  correspondenceId: null,
  reviewedBy: null,
  reviewedAt: null,
  reviewReason: "",
  error: null,
});
const change = (kind, value, expectedRevision = null) => ({
  kind,
  value,
  expectedRevision,
});
const conflict = (promise) =>
  assert.rejects(promise, (error) => error.code === "mailbox_changed");
async function fixture(t) {
  if (backend === "firebase") {
    const { firestore } = await firebaseServices();
    const store = new FirestoreMailboxStore(
      firestore,
      `mailtest_${randomUUID().replaceAll("-", "")}`,
    );
    return { store, reopen: () => store };
  }
  const directory = await mkdtemp(join(tmpdir(), "ams-mailbox-"));
  let repository = new SqliteAmsRepository(join(directory, "agency.sqlite"));
  const store = new SqliteMailboxStore(repository);
  t.after(async () => {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    reopen: () => {
      repository.close();
      repository = new SqliteAmsRepository(join(directory, "agency.sqlite"));
      return new SqliteMailboxStore(repository);
    },
  };
}

test(`${backend}: mailbox state survives reopening and agency boundaries include pagination cursors`, async (t) => {
  const f = await fixture(t);
  await f.store.commit("agency", [
    change("connections", connection()),
    change("messages", message("one")),
    change("messages", message("two")),
  ]);
  const store = f.reopen();
  assert.deepEqual(
    await store.get("agency", "connections", "connection1"),
    connection(),
  );
  assert.equal(await store.get("other", "connections", "connection1"), null);
  const page = await store.list("agency", "messages", { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  await assert.rejects(
    store.list("other", "messages", { cursor: page.nextCursor }),
    (error) => error.code === "invalid_cursor",
  );
  await assert.rejects(
    store.list("agency", "messages", {
      status: "filed",
      cursor: page.nextCursor,
    }),
    (error) => error.code === "invalid_cursor",
  );
  const next = await store.list("agency", "messages", {
    cursor: page.nextCursor,
    limit: 1,
  });
  assert.notEqual(next.items[0].id, page.items[0].id);
  assert.equal(next.nextCursor, null);
});

test(`${backend}: mailbox compare-and-swap commits roll back every write and prevent concurrent lost updates`, async (t) => {
  const { store } = await fixture(t);
  await store.commit("agency", [
    change("connections", connection()),
    change("messages", message()),
  ]);
  await conflict(
    store.commit("agency", [
      change("connections", { ...connection(), revision: 2 }, 1),
      change("messages", message()),
    ]),
  );
  assert.equal(
    (await store.get("agency", "connections", "connection1")).revision,
    1,
  );
  const updates = await Promise.allSettled(
    ["disconnected", "connected"].map((state) =>
      store.commit("agency", [
        change("connections", { ...connection(), revision: 2, state }, 1),
      ]),
    ),
  );
  assert.equal(updates.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    updates.find((r) => r.status === "rejected").reason.code,
    "mailbox_changed",
  );
  await conflict(
    store.commit("agency", [change("messages", message("late"))], {
      connectionId: "connection1",
      revision: 1,
    }),
  );
  assert.equal(
    await store.get("agency", "messages", "late"),
    null,
    "A disconnected/changed connection cannot accept an in-flight sync result",
  );
});

test(`${backend}: review status/connection queues paginate without scans and keep events immutable`, async (t) => {
  const { store } = await fixture(t);
  await store.commit("agency", [
    change("connections", connection()),
    change("messages", message("one")),
    change("messages", message("two", "other")),
    change("messages", { ...message("three"), status: "filed" }),
  ]);
  assert.deepEqual(
    (
      await store.list("agency", "messages", { connectionId: "connection1" })
    ).items.map((m) => m.id),
    ["one"],
  );
  assert.deepEqual(
    (await store.list("agency", "messages", { status: "filed" })).items.map(
      (m) => m.id,
    ),
    ["three"],
  );
  await store.commit("agency", [
    change(
      "messages",
      { ...message("one"), revision: 2, status: "dismissed" },
      1,
    ),
  ]);
  assert.equal(
    (await store.list("agency", "messages", { connectionId: "connection1" }))
      .items.length,
    0,
  );
  assert.equal(
    (
      await store.list("agency", "messages", {
        connectionId: "connection1",
        status: "dismissed",
      })
    ).items.length,
    1,
  );
  const event = {
    id: "event1",
    revision: 1,
    connectionId: "connection1",
    messageId: "one",
    at,
    actorId: "owner",
    action: "message_dismissed",
    detail: "Fictional unrelated update.",
  };
  await store.commit("agency", [change("events", event)]);
  await conflict(
    store.commit("agency", [change("events", { ...event, revision: 2 }, 1)]),
  );
  assert.equal(
    (await store.list("agency", "events", { connectionId: "connection1" }))
      .items[0].detail,
    event.detail,
  );
});

test("Mailbox vault authenticates the deployment key, agency, connection, provider and purpose", () => {
  const vault = new MailboxVault(randomBytes(32).toString("base64"));
  const context = {
    tenantId: "agency",
    id: "connection1",
    provider: "gmail",
    purpose: "credentials",
  };
  const plaintext = JSON.stringify({
    accessToken: "fictional-access",
    refreshToken: "fictional-refresh",
    expiresAt: at,
  });
  const encrypted = vault.seal(context, plaintext);
  assert.doesNotMatch(encrypted, /fictional-access|fictional-refresh/);
  assert.notEqual(
    encrypted,
    vault.seal(context, plaintext),
    "Each encryption uses a fresh nonce",
  );
  assert.equal(vault.open(context, encrypted), plaintext);
  assert.equal(
    vault.credentials(context, encrypted).refreshToken,
    "fictional-refresh",
  );
  for (const patch of [
    { tenantId: "other" },
    { id: "connection2" },
    { provider: "microsoft365" },
    { purpose: "authorization" },
  ])
    assert.throws(
      () => vault.open({ ...context, ...patch }, encrypted),
      (e) => e.code === "mailbox_credentials_unavailable",
    );
  assert.throws(
    () =>
      new MailboxVault(randomBytes(32).toString("base64")).open(
        context,
        encrypted,
      ),
    (e) => e.code === "mailbox_credentials_unavailable",
  );
  const parts = encrypted.split(".");
  parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
  assert.throws(
    () => vault.open(context, parts.join(".")),
    (e) => e.code === "mailbox_credentials_unavailable",
  );
  assert.throws(() => new MailboxVault("not-a-key"), /32-byte/);
});
