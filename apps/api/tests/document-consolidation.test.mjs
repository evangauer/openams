import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { createAmsRouter } from "../dist/routes.js";
import { openRepository, openFiles } from "./support/backend.mjs";

test("document uploads use reviewed consolidated account scope without changing original records", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ams-consolidated-files-"));
  const repository = openRepository(join(dir, "agency.sqlite"));
  const actor = {
    tenantId: "fictional-agency",
    userId: "admin",
    name: "Fictional admin",
    role: "admin",
  };
  const app = express();
  app.use(express.json());
  app.use(
    createAmsRouter({
      authenticate: (_req, _res, next) => next(),
      actor: () => actor,
      enabled: async () => true,
      repository: () => repository,
      files: openFiles(join(dir, "files")),
      members: async () => [],
      workspaceName: async () => "Fictional agency",
      timeZone: async () => "America/Chicago",
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function command(kind, action, data, record) {
    const response = await fetch(`${url}/ams/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: randomUUID(),
        kind,
        action,
        data,
        reason: "Fictional reviewed identity test",
        ...(record
          ? { recordId: record.id, expectedVersion: record.version }
          : {}),
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.records;
  }
  const primary = (
    await command("accounts", "create", { name: "Fictional primary" })
  )[0];
  const retained = (
    await command("accounts", "create", { name: "Fictional duplicate" })
  )[0];
  const unrelated = (
    await command("accounts", "create", { name: "Fictional separate customer" })
  )[0];
  const policy = (
    await command("policies", "create", {
      accountId: retained.id,
      number: "FICTIONAL-POL-1",
      line: "General liability",
      carrier: "Fictional carrier",
      premiumCents: 100000,
      effectiveDate: "2026-01-01",
      expirationDate: "2027-01-01",
    })
  )[0];
  const upload = (account, extra = {}, id = randomUUID()) =>
    fetch(
      `${url}/ams/accounts/${account.id}/documents?${new URLSearchParams({ commandId: id, ...extra })}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": "fictional-policy.txt",
        },
        body: "Fictional immutable document",
      },
    );
  const originalResponse = await upload(retained, { policyId: policy.id });
  assert.equal(originalResponse.status, 201);
  const original = (await originalResponse.json()).records[0];
  assert.equal(
    (await upload(primary, { policyId: policy.id })).status,
    422,
    "separate accounts cannot share a policy before review",
  );
  await command(
    "accounts",
    "account.consolidate",
    { targetId: primary.id, targetVersion: primary.version },
    retained,
  );
  const id = randomUUID();
  const response = await upload(
    primary,
    { policyId: policy.id, supersedesId: original.id },
    id,
  );
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  const replacement = result.records[0];
  assert.equal(replacement.data.accountId, primary.id);
  assert.equal(replacement.data.policyId, policy.id);
  assert.equal(replacement.data.supersedesId, original.id);
  assert.equal(
    (
      await upload(
        primary,
        { policyId: policy.id, supersedesId: original.id },
        id,
      )
    ).status,
    200,
    "retry is idempotent",
  );
  assert.deepEqual(
    await repository.get(actor.tenantId, "policies", policy.id),
    policy,
  );
  assert.deepEqual(
    await repository.get(actor.tenantId, "documents", original.id),
    original,
  );
  assert.equal(
    (await upload(retained, { supersedesId: replacement.id })).status,
    201,
    "retained identity resolves the same reviewed scope",
  );
  const rejected = await upload(unrelated, {
    policyId: policy.id,
    supersedesId: original.id,
  });
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).error, "account_mismatch");
  for (const document of [original, replacement]) {
    const downloaded = await fetch(
      `${url}/ams/documents/${document.id}/content`,
    );
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), "Fictional immutable document");
  }
});
