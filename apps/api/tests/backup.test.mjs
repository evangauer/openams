import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { SqliteAmsRepository } from "../dist/sqlite-repository.js";
import { versioned } from "../dist/repository.js";
import { AmsService } from "../dist/service.js";
import { LocalAmsFiles, fileHash } from "../dist/files.js";
import { SqliteMailboxStore } from "../dist/mailbox-store.js";
import { MailboxVault } from "../dist/mailbox-credentials.js";
import {
  createLocalBackup,
  restoreLocalBackup,
  verifyLocalBackup,
} from "../../../scripts/backup.mjs";
test("local recovery retains authorized and revoked certificate template originals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ams-template-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const repository = new SqliteAmsRepository(join(source, "agency.sqlite"));
  t.after(() => repository.close());
  const files = new LocalAmsFiles(join(source, "files"));
  const originals = [];
  // Exercise the storage format directly so recovery also handles template
  // records from a newer application release without needing its command API.
  for (const revoked of [false, true]) {
    const id = randomUUID();
    const bytes = Buffer.from(`Fictional template storage fixture ${id}`);
    const storageKey = `ams-documents/agency/templates/${id}/${fileHash(bytes)}`;
    await files.put(storageKey, bytes);
    const at = "2026-11-12T00:00:00.000Z";
    const record = versioned({
      id, kind: "certificatetemplates", revision: 1,
      createdAt: at, updatedAt: at, createdBy: "admin", updatedBy: "admin", archivedAt: null,
      data: {
        name: "Fictional form", edition: id, authorization: "Original fictional fixture",
        authorizedBy: "admin", authorizedAt: at, requestFingerprint: fileHash(bytes),
        storageKey, sha256: fileHash(bytes), bytes: bytes.length,
        fields: [{ pdfKey: "insured", type: "text", label: "Insured", section: "Fixture", maxLength: 100, multiline: false }],
        revokedAt: revoked ? at : null, revocationReason: revoked ? "Fictional retired edition" : "",
      },
    });
    await repository.transact("agency", async (tx) => tx.put(record));
    originals.push({ storageKey, bytes });
  }
  const backup = join(root, "backup"), target = join(root, "restored");
  const manifest = await createLocalBackup(source, backup);
  await restoreLocalBackup(backup, target);
  for (const original of originals)
    assert.deepEqual(await new LocalAmsFiles(join(target, "files")).get(original.storageKey), original.bytes);
  assert.equal(manifest.templateOriginalCount, 2);
  assert.equal(manifest.documentCount, 0);
  await writeFile(join(backup, "files", originals[0].storageKey), "Tampered template");
  await assert.rejects(verifyLocalBackup(backup), /Document integrity/);
});
test("local recovery retains unfiled mailbox originals, deduplicates shared bytes and keeps grants encrypted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ams-mail-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const repository = new SqliteAmsRepository(join(source, "agency.sqlite"));
  t.after(() => repository.close());
  const store = new SqliteMailboxStore(repository);
  const at = "2026-11-12T04:00:00Z";
  const vault = new MailboxVault(randomBytes(32).toString("base64"));
  const context = {
    tenantId: "agency",
    id: "connection1",
    provider: "gmail",
    purpose: "credentials",
  };
  const credentials = vault.seal(
    context,
    JSON.stringify({
      accessToken: "fictional-access",
      refreshToken: "fictional-refresh",
      expiresAt: at,
    }),
  );
  const connection = {
    id: "connection1",
    revision: 1,
    provider: "gmail",
    address: "agency@example.test",
    remoteId: "agency@example.test",
    createdAt: at,
    createdBy: "owner",
    state: "choose_folder",
    credentials,
    folder: null,
    cursor: null,
    hasMore: false,
    pending: null,
    lease: null,
    lastAttemptAt: null,
    lastSyncedAt: null,
    nextAttemptAt: null,
    error: null,
  };
  const bytes = Buffer.from(
    "From: updates@example.test\r\nSubject: Fictional pending renewal\r\n\r\nReview before filing.\r\n",
  );
  const key = `ams-documents/agency/connection1/${fileHash(bytes)}`;
  await new LocalAmsFiles(join(source, "files")).put(key, bytes);
  const message = {
    id: "incoming1",
    revision: 1,
    connectionId: "connection1",
    providerMessageId: "source1",
    queuedAt: at,
    receivedAt: at,
    status: "review",
    subject: "Fictional pending renewal",
    from: "updates@example.test",
    to: "agency@example.test",
    body: "Review before filing.",
    bodyTruncated: false,
    attachmentCount: 0,
    direction: "inbound",
    original: { storageKey: key, sha256: fileHash(bytes), bytes: bytes.length },
    filing: null,
    correspondenceId: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewReason: "",
    error: null,
  };
  await store.commit("agency", [
    { kind: "connections", expectedRevision: null, value: connection },
    { kind: "messages", expectedRevision: null, value: message },
    {
      kind: "messages",
      expectedRevision: null,
      value: {
        ...message,
        id: "incoming2",
        providerMessageId: "source2",
        status: "dismissed",
      },
    },
  ]);
  const backup = join(root, "backup");
  const manifest = await createLocalBackup(source, backup);
  assert.equal(manifest.documentCount, 0);
  assert.equal(manifest.mailboxOriginalCount, 2);
  assert.equal(manifest.counts.ams_mailbox, 3);
  assert.equal((await verifyLocalBackup(backup)).files.length, 1);
  assert.equal(
    (await readFile(join(backup, "agency.sqlite"))).includes(
      Buffer.from("fictional-refresh"),
    ),
    false,
  );
  const restoredPath = join(root, "restored");
  await restoreLocalBackup(backup, restoredPath);
  const restoredRepository = new SqliteAmsRepository(
    join(restoredPath, "agency.sqlite"),
  );
  t.after(() => restoredRepository.close());
  const restored = new SqliteMailboxStore(restoredRepository);
  const restoredMessage = await restored.get("agency", "messages", "incoming1");
  assert.deepEqual(
    await new LocalAmsFiles(join(restoredPath, "files")).get(
      restoredMessage.original.storageKey,
    ),
    bytes,
  );
  assert.equal(
    vault.credentials(
      context,
      (await restored.get("agency", "connections", "connection1")).credentials,
    ).refreshToken,
    "fictional-refresh",
  );
  await writeFile(join(backup, "files", key), "Tampered original");
  await assert.rejects(verifyLocalBackup(backup), /Document integrity/);
});
test("local snapshot restores records, revisions, audit, retry receipts and exact files without session tokens", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ams-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await (await import("node:fs/promises")).mkdir(source);
  const repository = new SqliteAmsRepository(join(source, "agency.sqlite"));
  t.after(() => repository.close());
  const actor = {
    tenantId: "fixture-agency",
    userId: "admin",
    role: "admin",
    name: "Fixture",
  };
  const service = new AmsService({ repository, members: async () => [] });
  const command = {
    id: randomUUID(),
    kind: "accounts",
    action: "create",
    data: { name: "Recovery fixture" },
    reason: "",
  };
  const account = (await service.execute(actor, command)).records[0];
  const bytes = Buffer.from("Fictional recovery document");
  const key = `ams-documents/${actor.tenantId}/fixture/${fileHash(bytes)}`;
  await new LocalAmsFiles(join(source, "files")).put(key, bytes);
  const document = (
    await service.createDocument(actor, {
      id: randomUUID(),
      kind: "documents",
      action: "create",
      reason: "Fixture",
      data: {
        accountId: account.id,
        name: "fixture.txt",
        bytes: bytes.length,
        mediaType: "text/plain",
        sha256: fileHash(bytes),
        storageKey: key,
      },
    })
  ).records[0];
  await writeFile(
    join(source, "development-sessions.json"),
    "DO-NOT-COPY-FIXTURE",
  );
  const backup = join(root, "backup");
  const manifest = await createLocalBackup(source, backup);
  assert.equal(manifest.counts.ams_records, 2);
  assert.equal(manifest.counts.ams_receipts, 2);
  await assert.rejects(stat(join(backup, "development-sessions.json")), {
    code: "ENOENT",
  });
  // Source remains writable; writes after snapshot must not appear in restoration.
  await service.execute(actor, {
    id: randomUUID(),
    kind: "accounts",
    action: "create",
    data: { name: "After snapshot" },
    reason: "",
  });
  const target = join(root, "restored");
  await restoreLocalBackup(backup, target);
  await assert.rejects(restoreLocalBackup(backup, target), { code: "EEXIST" });
  const restored = new SqliteAmsRepository(join(target, "agency.sqlite"));
  t.after(() => restored.close());
  assert.deepEqual(
    await restored.get(actor.tenantId, "accounts", account.id),
    account,
  );
  assert.deepEqual(
    await restored.revision(actor.tenantId, "accounts", account.id, 1),
    account,
  );
  assert.equal((await restored.history(actor.tenantId)).items.length, 2);
  const replay = await new AmsService({
    repository: restored,
    members: async () => [],
  }).execute(actor, command);
  assert.equal(replay.replayed, true);
  assert.deepEqual(
    await new LocalAmsFiles(join(target, "files")).get(key),
    bytes,
  );
  assert.equal(
    (await restored.list(actor.tenantId, "accounts", { limit: 100 })).items
      .length,
    1,
  );
  await writeFile(join(backup, "files", key), "Corrupted bytes");
  await assert.rejects(verifyLocalBackup(backup), /Document integrity/);
  await assert.rejects(
    restoreLocalBackup(backup, join(root, "bad-restore")),
    /Document integrity/,
  );
  await assert.rejects(stat(join(root, "bad-restore")), { code: "ENOENT" });
  assert.equal(document.data.sha256, fileHash(bytes));
});

test("restoration preserves consolidation undo boundaries and account activity epochs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ams-identity-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const repository = new SqliteAmsRepository(join(source, "agency.sqlite"));
  t.after(() => repository.close());
  const actor = {
    tenantId: "agency",
    userId: "admin",
    role: "admin",
    name: "Fixture",
  };
  const service = new AmsService({ repository, members: async () => [] });
  const cmd = (action, kind, data, record) => ({
    id: randomUUID(),
    action,
    kind,
    data,
    reason: "Reviewed recovery fixture",
    ...(record ? { recordId: record.id, expectedVersion: record.version } : {}),
  });
  const groups = [];
  for (const inUse of [false, true]) {
    const target = (
      await service.execute(
        actor,
        cmd("create", "accounts", { name: `Primary ${inUse}` }),
      )
    ).records[0];
    const alias = (
      await service.execute(
        actor,
        cmd("create", "accounts", { name: `Original ${inUse}` }),
      )
    ).records[0];
    const merged = await service.execute(
      actor,
      cmd(
        "account.consolidate",
        "accounts",
        { targetId: target.id, targetVersion: target.version },
        alias,
      ),
    );
    if (inUse)
      await service.execute(
        actor,
        cmd("create", "notes", {
          accountId: alias.id,
          body: "Later retained-identity work",
          occurredAt: new Date().toISOString(),
        }),
      );
    groups.push({
      targetId: target.id,
      alias: merged.records.find((row) => row.id === alias.id),
      inUse,
      epoch: await repository.transact(actor.tenantId, (tx) =>
        tx.accountEpoch(target.id),
      ),
    });
  }
  const backup = join(root, "backup");
  const manifest = await createLocalBackup(source, backup);
  assert.equal(manifest.counts.ams_account_epochs, 4);
  const target = join(root, "restored");
  await restoreLocalBackup(backup, target);
  const restored = new SqliteAmsRepository(join(target, "agency.sqlite"));
  t.after(() => restored.close());
  const restoredService = new AmsService({
    repository: restored,
    members: async () => [],
  });
  for (const group of groups) {
    assert.equal(
      await restored.transact(actor.tenantId, (tx) =>
        tx.accountEpoch(group.targetId),
      ),
      group.epoch,
    );
    const undo = restoredService.execute(
      actor,
      cmd("account.undoConsolidation", "accounts", {}, group.alias),
    );
    if (group.inUse)
      await assert.rejects(
        undo,
        (error) => error.code === "consolidation_in_use",
      );
    else {
      await undo;
      assert.equal(
        (await restored.get(actor.tenantId, "accounts", group.alias.id)).data
          .consolidation,
        null,
      );
    }
  }
});
