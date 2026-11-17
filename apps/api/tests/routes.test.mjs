import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { createAmsRouter } from "../dist/routes.js";
import { openRepository, openFiles } from "./support/backend.mjs";
test("authenticated HTTP flow uploads immutable bytes, issues reviewed certificates, and fences roles and tenants", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ams-http-"));
  const repository = openRepository(join(dir, "agency.sqlite"));
  const app = express();
  let enabled = true;
  app.use(express.json());
  app.use(
    createAmsRouter({
      authenticate: (req, res, next) => {
        if (!req.header("authorization"))
          return res.status(401).json({ error: "unauthorized" });
        next();
      },
      actor: (req) => ({
        tenantId:
          req.header("authorization") === "Bearer other"
            ? "other-agency"
            : "agency-1",
        userId: "user-1",
        name: "Fixture",
        role:
          req.header("authorization") === "Bearer viewer"
            ? "viewer"
            : req.header("authorization") === "Bearer member"
              ? "member"
              : "admin",
      }),
      enabled: async () => enabled,
      repository: () => repository,
      files: openFiles(join(dir, "files")),
      members: async () => [],
      workspaceName: async () => "Fixture agency",
      timeZone: async () => "America/Chicago",
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
  const get = (path, token = "admin") =>
    fetch(url + path, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  // The cheap session check the web proxy runs before reading a large upload body.
  assert.deepEqual(await (await get("/ams/whoami")).json(), { role: "admin" });
  assert.equal((await get("/ams/whoami", "viewer")).status, 200);
  assert.equal((await get("/ams/whoami", null)).status, 401);
  const cmd = async (kind, action, data = {}, record) => {
    const response = await fetch(url + "/ams/commands", {
      method: "POST",
      headers: {
        authorization: "Bearer admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: randomUUID(),
        kind,
        action,
        data,
        reason: "Fixture review",
        ...(record
          ? { recordId: record.id, expectedVersion: record.version }
          : {}),
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await get("/ams/session", null)).status, 401);
  enabled = false;
  assert.equal((await get("/ams/session")).status, 404);
  enabled = true;
  assert.equal(
    (await (await get("/ams/session")).json()).timeZone,
    "America/Chicago",
  );
  const account = (await cmd("accounts", "create", { name: "Fixture Roofing" }))
    .records[0];
  let policy = (
    await cmd("policies", "create", {
      accountId: account.id,
      number: "GL-1",
      line: "General liability",
      carrier: "Example Carrier",
      premiumCents: 100000,
      effectiveDate: "2020-01-01",
      expirationDate: "2099-01-01",
    })
  ).records[0];
  policy = (
    await cmd(
      "policies",
      "policy.issue",
      { sourceReference: "Carrier fixture" },
      policy,
    )
  ).records[0];
  const bytes = Buffer.from("%PDF-1.4\nFixture certificate bytes · café\n%%EOF");
  const commandId = randomUUID();
  // Array/object request bodies must never use a forged length as an upload size.
  for (const body of [[1, 2, 3], { length: 1, bytes: "pretend file" }]) {
    const response = await fetch(`${url}/ams/accounts/${account.id}/documents?commandId=${randomUUID()}`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "Content-Type": "application/json", "x-file-name": "fixture.pdf" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error, "binary_required");
  }
  const upload = () =>
    fetch(
      `${url}/ams/accounts/${account.id}/documents?commandId=${commandId}&category=certificate`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin",
          "Content-Type": "application/octet-stream",
          "x-file-name": "certificate.pdf",
        },
        body: bytes,
      },
    );
  const first = await upload();
  assert.equal(first.status, 201);
  const document = (await first.json()).records[0];
  assert.equal(document.data.bytes, Buffer.byteLength(bytes));
  assert.equal((await upload()).status, 200);
  const downloaded = await get(`/ams/documents/${document.id}/content`);
  assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal(
    (await get(`/ams/documents/${document.id}/content`, "other")).status,
    404,
  );
  // Documents are not financial records, so every role passes the read check.
  assert.equal(
    (await get(`/ams/documents/${document.id}/content`, "viewer")).status,
    200,
  );
  let certificate = (
    await cmd("certificates", "create", {
      accountId: account.id,
      holderName: "Example GC",
      policyIds: [policy.id],
      requestedDate: "2026-11-05",
    })
  ).records[0];
  certificate = (
    await cmd(
      "certificates",
      "certificate.issue",
      { documentId: document.id, reviewed: true },
      certificate,
    )
  ).records[0];
  assert.equal(certificate.data.policySnapshots[0].version, policy.version);
  assert.equal((await get("/ams/records/journals", "member")).status, 403);
  assert.equal((await get("/ams/export", "viewer")).status, 403);
  const noWrite = await fetch(url + "/ams/commands", {
    method: "POST",
    headers: {
      authorization: "Bearer viewer",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: randomUUID(),
      kind: "accounts",
      action: "create",
      data: { name: "No" },
    }),
  });
  assert.equal(noWrite.status, 403);
  const exported = await (await get("/ams/export")).json();
  assert.equal(exported.records.length, 4);
  assert.match(exported.consistency, /not a point-in-time/);
});
