import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { AmsService } from "../dist/service.js";
import { fileOriginalEmail } from "../dist/correspondence.js";
import { SqliteAmsRepository } from "../dist/sqlite-repository.js";
import { backend, openRepository, openFiles } from "./support/backend.mjs";
import { LocalAmsFiles, fileHash } from "../dist/files.js";
import { createAmsRouter } from "../dist/routes.js";
import { AmsListSchema } from "@openams/contracts";
const actor = {
  tenantId: "agency",
  userId: "owner",
  name: "Email owner",
  role: "member",
};
const bytes = Buffer.from(
  [
    "From: Customer <customer@example.test>",
    "To: Agency <agency@example.test>",
    "Subject: Renewal information",
    "Date: Fri, 6 Nov 2026 14:00:00 -0600",
    "Message-ID: <renewal-fixture@example.test>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="fixture-boundary"',
    "",
    "--fixture-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Here are the updated exposures. <script>window.bad = true</script>",
    "--fixture-boundary",
    "Content-Type: text/plain",
    'Content-Disposition: attachment; filename="exposures.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Fictional payroll: 120000").toString("base64"),
    "--fixture-boundary",
    "Content-Type: application/octet-stream",
    'Content-Disposition: attachment; filename="unsupported.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Retained only inside original").toString("base64"),
    "--fixture-boundary--",
    "",
  ].join("\r\n"),
);
const reject = (p, code) => assert.rejects(p, (e) => e.code === code);
async function fixture(t, adapter) {
  const dir = await mkdtemp(join(tmpdir(), "ams-email-"));
  const repository =
    openRepository(join(dir, "agency.sqlite"));
  const files = openFiles(join(dir, "files"));
  const service = new AmsService({
    repository,
    members: async () => [],
    now: () => new Date("2026-11-07T12:00:00Z"),
  });
  const run = (kind, data) =>
    service.execute(actor, {
      id: randomUUID(),
      kind,
      action: "create",
      data,
      reason: "",
    });
  const account = (await run("accounts", { name: "Fictional client" }))
    .records[0];
  const filing = {
    commandId: randomUUID(),
    expectedVersion: account.version,
    policyId: null,
    direction: "inbound",
    shareWithAgency: true,
  };
  const file = (patch = {}) =>
    fileOriginalEmail({
      actor,
      accountId: account.id,
      filing,
      bytes,
      filename: "renewal.eml",
      repository,
      files,
      service,
      ...patch,
    });
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
  return { dir, repository, files, service, account, filing, file, run, list };
}
for (const adapter of ["sqlite"]) {
  test(`${adapter}: HTML-only multipart carrier emails retain a readable, inert preview`, async (t) => {
    const f = await fixture(t, adapter);
    const original = Buffer.from(bytes.toString()
      .replace("Content-Type: text/plain; charset=utf-8", "Content-Type: text/html; charset=utf-8")
      .replace("Here are the updated exposures. <script>window.bad = true</script>",
        '<p>Fictional renewal review: proposed premium $1,350.</p><img src="https://tracking.example.test/pixel"><script>window.bad = true</script>'));
    const result = await f.file({ bytes: original });
    const mail = result.records.find((r) => r.kind === "correspondence");
    assert.match(mail.data.body, /Fictional renewal review: proposed premium \$1,350/);
    assert.doesNotMatch(mail.data.body, /window.bad|<script>|tracking.example.test/i);
    assert.equal(mail.data.bodyTruncated, false);
    const document = await f.repository.get(actor.tenantId, "documents", mail.data.originalDocumentId);
    assert.deepEqual(await f.files.get(document.data.storageKey), original);
    assert.equal(mail.data.attachmentCount, 2);
  });
  test(`${adapter}: filing retains exact original and supported attachments atomically, with safe replay`, async (t) => {
    const f = await fixture(t, adapter);
    const result = await f.file();
    const mail = result.records.find((r) => r.kind === "correspondence");
    assert.equal(mail.data.attachmentCount, 2);
    assert.deepEqual(mail.data.unextractedAttachments, ["unsupported.bin"]);
    assert.equal(mail.data.source, "eml_upload");
    assert.equal(mail.data.messageAt, "2026-11-06T20:00:00.000Z");
    assert.equal(mail.data.filedBy, actor.userId);
    assert.match(mail.data.body, /<script>/i);
    assert.equal(mail.data.documentIds.length, 2);
    assert.equal(result.audit.records.length, 3);
    const original = await f.repository.get(
      actor.tenantId,
      "documents",
      mail.data.originalDocumentId,
    );
    assert.deepEqual(await f.files.get(original.data.storageKey), bytes);
    assert.equal(original.data.sha256, fileHash(bytes));
    const attachment = (await f.list("documents")).find(
      (d) => d.id !== original.id,
    );
    assert.equal(
      (await f.files.get(attachment.data.storageKey)).toString(),
      "Fictional payroll: 120000",
    );
    assert.equal((await f.file()).replayed, true);
    assert.equal((await f.list("correspondence")).length, 1);
    await reject(
      f.file({ filing: { ...f.filing, commandId: randomUUID() } }),
      "email_already_filed",
    );
    await reject(
      f.service.execute(actor, {
        id: randomUUID(),
        action: "update",
        kind: "correspondence",
        recordId: mail.id,
        expectedVersion: mail.version,
        data: { body: "Forged" },
        reason: "",
      }),
      "immutable_record",
    );
    await reject(
      f.service.execute(actor, {
        id: randomUUID(),
        action: "correspondence.file",
        kind: "accounts",
        recordId: f.account.id,
        expectedVersion: f.account.version,
        data: {},
        reason: "",
      }),
      "verified_email_required",
    );
  });
  test(`${adapter}: failed filing cannot leave partial records and cannot cross accounts or tenants`, async (t) => {
    const f = await fixture(t, adapter);
    const other = (await f.run("accounts", { name: "Other client" }))
      .records[0];
    const policy = (
      await f.run("policies", {
        accountId: other.id,
        number: "OTHER-1",
        premiumCents: 10000,
        line: "GL",
        carrier: "Example",
        effectiveDate: "2026-01-01",
        expirationDate: "2027-01-01",
      })
    ).records[0];
    await reject(
      f.file({ filing: { ...f.filing, policyId: policy.id } }),
      "account_mismatch",
    );
    await reject(
      f.file({ filing: { ...f.filing, expectedVersion: "a".repeat(64) } }),
      "stale_record",
    );
    assert.equal((await f.list("documents")).length, 0);
    assert.equal((await f.list("correspondence")).length, 0);
    await reject(
      f.file({ actor: { ...actor, role: "viewer" } }),
      "permission_denied",
    );
    await reject(
      f.file({ actor: { ...actor, tenantId: "other-agency" } }),
      "account_unavailable",
    );
    await reject(
      f.file({ bytes: Buffer.from("Not an email") }),
      "invalid_email",
    );
  });
}
test("HTTP email import requires explicit sharing, fences viewer/tenant access, and downloads original bytes", async (t) => {
  const f = await fixture(t, "sqlite");
  const app = express();
  app.use(express.json());
  app.use(
    createAmsRouter({
      authenticate: (_q, _s, next) => next(),
      actor: (req) => ({
        ...actor,
        role: req.header("x-role") || "member",
        tenantId: req.header("x-tenant") || "agency",
      }),
      enabled: async () => true,
      repository: () => f.repository,
      files: f.files,
      members: async () => [],
      workspaceName: async () => "Fixture",
    }),
  );
  app.use((e, _q, s, _n) => s.status(e.status || 500).json({ error: e.code }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (consent = true, headers = {}) =>
    fetch(
      `${base}/ams/accounts/${f.account.id}/emails?commandId=${f.filing.commandId}&expectedVersion=${f.account.version}&direction=inbound&shareWithAgency=${consent}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": "renewal.eml",
          ...headers,
        },
        body: bytes,
      },
    );
  assert.equal((await send(false)).status, 400);
  assert.equal((await send(true, { "x-role": "viewer" })).status, 403);
  const response = await send();
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal((await send()).status, 200);
  const original = result.records.find(
    (r) => r.kind === "documents" && r.data.mediaType === "message/rfc822",
  );
  const download = await fetch(`${base}/ams/documents/${original.id}/content`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.equal(
    (
      await fetch(`${base}/ams/documents/${original.id}/content`, {
        headers: { "x-tenant": "other" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${base}/ams/reminders/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
});
test("backup restores filed email, exact attachments and pending reminders before worker replay", { skip: backend !== "sqlite" && "local SQLite backup only" }, async (t) => {
  const f = await fixture(t, "sqlite");
  const { createLocalBackup, restoreLocalBackup } = await import(
    "../../../scripts/backup.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "ams-email-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filed = await f.file();
  const members = async () => [
    {
      id: "owner",
      name: "Owner",
      email: "owner@example.test",
      role: "member",
      active: true,
    },
  ];
  const service = new AmsService({
    repository: f.repository,
    members,
    now: () => new Date("2026-11-06T12:00:00Z"),
  });
  const task = (
    await service.execute(actor, {
      id: randomUUID(),
      action: "create",
      kind: "tasks",
      data: {
        accountId: f.account.id,
        title: "Reply to client",
        dueDate: "2026-11-07",
        ownerId: "owner",
      },
      reason: "",
    })
  ).records[0];
  await service.execute(actor, {
    id: randomUUID(),
    action: "task.followUp",
    kind: "tasks",
    recordId: task.id,
    expectedVersion: task.version,
    data: { reminderDaysBefore: 0 },
    reason: "",
  });
  await createLocalBackup(f.dir, join(root, "backup"));
  await restoreLocalBackup(join(root, "backup"), join(root, "restored"));
  const repository = new SqliteAmsRepository(
    join(root, "restored", "agency.sqlite"),
  );
  t.after(() => repository.close());
  const files = new LocalAmsFiles(join(root, "restored", "files"));
  for (const doc of filed.records.filter((r) => r.kind === "documents")) {
    const restored = await repository.get(actor.tenantId, "documents", doc.id);
    assert.equal(
      fileHash(await files.get(restored.data.storageKey)),
      doc.data.sha256,
    );
  }
  const worker = new AmsService({
    repository,
    members,
    now: () => new Date("2026-11-07T12:00:00Z"),
  });
  const results = await Promise.all([
    worker.processDueReminders(actor.tenantId),
    worker.processDueReminders(actor.tenantId),
  ]);
  assert.equal(
    results.reduce((sum, r) => sum + r.processed, 0),
    1,
  );
  const restoredMail = await repository.get(
    actor.tenantId,
    "correspondence",
    filed.records.find((r) => r.kind === "correspondence").id,
  );
  assert.equal(restoredMail.data.sha256, fileHash(bytes));
});
