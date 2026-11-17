import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { simpleParser } from "mailparser";
import { createAmsRouter } from "../dist/routes.js";
import { processCertificatePdf } from "../dist/certificate-renderer.js";
import { fileHash } from "../dist/files.js";
import { versioned } from "../dist/repository.js";
import { openRepository, openFiles } from "./support/backend.mjs";

// Original fictional form: no ACORD layout, wording, branding or licensed assets.
async function fixturePdf() {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const page = pdf.addPage([612, 792]);
  page.drawText("FICTIONAL CERTIFICATE WORKFLOW TEST", {
    x: 36,
    y: 745,
    size: 16,
  });
  page.drawText("NOT EVIDENCE OF INSURANCE - TEST DATA ONLY", {
    x: 36,
    y: 720,
    size: 11,
  });
  const form = pdf.getForm();
  for (const [key, y] of [
    ["insured", 640],
    ["holder", 570],
    ["description", 480],
  ]) {
    page.drawText(key.toUpperCase(), {
      x: 36,
      y: y + (key === "description" ? 75 : 45),
      size: 10,
    });
    const field = form.createTextField(key);
    if (key === "description") field.enableMultiline();
    field.setMaxLength(180);
    field.addToPage(page, {
      x: 36,
      y,
      width: 530,
      height: key === "description" ? 60 : 30,
    });
  }
  const second = pdf.addPage([612, 792]);
  second.drawText("FICTIONAL TEST - REVIEW CHECKBOX", {
    x: 36,
    y: 740,
    size: 14,
  });
  form
    .createCheckBox("review_example")
    .addToPage(second, { x: 36, y: 680, width: 15, height: 15 });
  return Buffer.from(await pdf.save());
}

test("PDF renderer preserves canonical text and checkbox values on multiple pages and rejects unsafe or overflowing forms", async () => {
  const bytes = await fixturePdf();
  const fields = {
    insured: "Example Roofing",
    holder: "Example Property",
    description:
      "Fictional review example.\nNo insurance coverage is provided.",
    review_example: true,
  };
  const inspected = await processCertificatePdf(bytes);
  assert.equal(inspected.fields.length, 4);
  const rendered = await processCertificatePdf(bytes, fields);
  const reopened = await PDFDocument.load(rendered.bytes);
  assert.equal(reopened.getPageCount(), 2);
  assert.equal(
    reopened.getForm().getTextField("insured").getText(),
    fields.insured,
  );
  assert.equal(
    reopened.getForm().getTextField("description").getText(),
    fields.description,
  );
  assert.equal(
    reopened.getForm().getCheckBox("review_example").isChecked(),
    true,
  );
  for (const field of reopened.getForm().getFields()) {
    assert.equal(field.isReadOnly(), true);
    for (const widget of field.acroField.getWidgets())
      assert.ok(widget.getAppearances()?.normal);
  }
  const unchecked = await processCertificatePdf(bytes, {
    review_example: false,
  });
  assert.equal(
    (await PDFDocument.load(unchecked.bytes))
      .getForm()
      .getCheckBox("review_example")
      .isChecked(),
    false,
  );
  assert.equal(
    fileHash(Buffer.from(rendered.bytes)),
    fileHash(Buffer.from((await processCertificatePdf(bytes, fields)).bytes)),
    "retry rendering is deterministic",
  );
  for (const values of [
    { missing: "bad" },
    { insured: true },
    { review_example: "yes" },
    { insured: "x".repeat(180) },
    { insured: "line one\nline two" },
  ])
    await assert.rejects(
      processCertificatePdf(bytes, values),
      (error) => error.code === "invalid_template",
    );
  await assert.rejects(processCertificatePdf(Buffer.from("not a PDF")));
  const scripted = await PDFDocument.load(bytes);
  scripted.catalog.set(
    PDFName.of("OpenAction"),
    scripted.context.obj({
      S: "JavaScript",
      JS: PDFString.of("alert('fixture')"),
    }),
  );
  await assert.rejects(
    processCertificatePdf(Buffer.from(await scripted.save())),
    /scripts/,
  );
  const attached = await PDFDocument.load(bytes);
  await attached.attach(Buffer.from("fictional attachment"), "example.txt");
  await assert.rejects(
    processCertificatePdf(Buffer.from(await attached.save())),
    /attachments/,
  );
  const unsigned = await PDFDocument.create();
  unsigned.addPage();
  unsigned
    .getForm()
    .createDropdown("unsupported")
    .addToPage(unsigned.getPage(0));
  await assert.rejects(
    processCertificatePdf(Buffer.from(await unsigned.save())),
    /Only text/,
  );
  if (process.env.OPENAMS_CERT_EVIDENCE_DIR) {
    await writeFile(
      join(process.env.OPENAMS_CERT_EVIDENCE_DIR, "fictional-template.pdf"),
      bytes,
    );
    await writeFile(
      join(process.env.OPENAMS_CERT_EVIDENCE_DIR, "fictional-rendered.pdf"),
      rendered.bytes,
    );
  }
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ams-cert-"));
  const repository = openRepository(join(dir, "agency.sqlite"));
  const files = openFiles(join(dir, "files"));
  const app = express();
  app.use(express.json());
  app.use(
    createAmsRouter({
      authenticate: (req, res, next) =>
        req.header("authorization") ? next() : res.sendStatus(401),
      actor: (req) => ({
        tenantId:
          req.header("authorization") === "other" ? "other-agency" : "agency-1",
        userId: "user-1",
        name: "Fixture User",
        role: ["viewer", "member", "accountant"].includes(
          req.header("authorization"),
        )
          ? req.header("authorization")
          : "admin",
      }),
      enabled: async () => true,
      repository: () => repository,
      files,
      members: async () => [],
      workspaceName: async () => "Fixture Agency",
    }),
  );
  app.use((error, _req, res, _next) =>
    res
      .status(error.status || 500)
      .json({ error: error.code || "internal", message: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (path, body, token = "admin") =>
    fetch(url + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const command = (kind, action, data = {}, record, extra = {}) => ({
    id: randomUUID(),
    kind,
    action,
    data,
    reason: "Fixture review",
    ...(record ? { recordId: record.id, expectedVersion: record.version } : {}),
    ...extra,
  });
  async function execute(kind, action, data = {}, record, extra = {}) {
    const response = await send(
      "/ams/commands",
      command(kind, action, data, record, extra),
    );
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.records[0];
  }
  const bytes = await fixturePdf();
  const templateId = randomUUID();
  const query = new URLSearchParams({
    commandId: templateId,
    name: "Fictional certificate",
    edition: "Test 1",
    authorization: "Original fictional test form",
    authorized: "true",
  });
  const upload = (token = "admin", data = bytes) =>
    fetch(`${url}/ams/certificate-templates?${query}`, {
      method: "POST",
      headers: {
        authorization: token,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
  const account = await execute("accounts", "create", {
    name: "Example Roofing",
  });
  let policy = await execute("policies", "create", {
    accountId: account.id,
    number: "DEMO-GL-1",
    line: "General liability",
    carrier: "Fictional Mutual",
    premiumCents: 10000,
    effectiveDate: "2020-01-01",
    expirationDate: "2099-01-01",
  });
  policy = await execute(
    "policies",
    "policy.issue",
    { sourceReference: "Fictional issued policy" },
    policy,
  );
  return { repository, files, send, command, execute, upload, account, policy };
}

test("authorized template through issuance, external delivery, holder reuse and renewal is isolated, immutable and retry-safe", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.upload("member")).status, 403);
  assert.equal((await f.upload("viewer")).status, 403);
  const response = await f.upload();
  assert.equal(response.status, 201);
  const template = (await response.json()).records[0];
  assert.equal((await f.upload()).status, 200);
  assert.equal((await f.upload("admin", Buffer.from("changed"))).status, 409);
  assert.equal(
    (
      await f.send(
        `/ams/certificate-templates/${template.id}/content`,
        undefined,
        "other",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.send(
        "/ams/commands",
        f.command("certificatetemplates", "create", template.data),
      )
    ).status,
    400,
  );
  const holder = await f.execute("certificateholders", "create", {
    name: "Example Property",
    email: "holder@example.test",
  });
  const service = await f.execute("services", "create", {
    accountId: f.account.id,
    type: "certificate",
    title: "Fictional certificate request",
    dueDate: "2026-11-12",
  });
  let certificate = await f.execute("certificates", "create", {
    serviceId: service.id,
    accountId: f.account.id,
    holderName: "Ignored",
    holderId: holder.id,
    requestedDate: "2026-11-11",
    policyIds: [f.policy.id],
  });
  assert.equal(certificate.data.holderName, holder.data.name);
  const prepare = {
    commandId: randomUUID(),
    templateId: template.id,
    expectedVersion: certificate.version,
    accountVersion: f.account.version,
    policyVersions: [{ id: f.policy.id, version: f.policy.version }],
    fields: {
      insured: f.account.data.name,
      holder: holder.data.name,
      description: "Fictional data only",
    },
  };
  const path = `/ams/certificates/${certificate.id}/prepare`;
  assert.equal((await f.send(path, prepare, "viewer")).status, 403);
  assert.equal((await f.send(path, prepare, "other")).status, 404);
  assert.equal(
    (await f.send(path, { ...prepare, accountVersion: "stale" })).status,
    409,
  );
  const prepared = await f.send(path, prepare);
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const result = await prepared.json();
  certificate = result.records.find((r) => r.kind === "certificates");
  const document = result.records.find((r) => r.kind === "documents");
  assert.equal(certificate.data.status, "review");
  assert.equal((await f.send(path, prepare)).status, 200);
  assert.equal(
    (await f.send(path, { ...prepare, fields: { holder: "changed" } })).status,
    409,
  );
  assert.equal(
    (
      await f.send(
        "/ams/commands",
        f.command(
          "certificates",
          "certificate.prepare",
          {
            documentId: document.id,
            preparation: certificate.data.preparation,
          },
          certificate,
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.send(`/ams/certificates/${certificate.id}/email-draft`)).status,
    409,
  );
  certificate = await f.execute(
    "certificates",
    "certificate.issue",
    { documentId: document.id, reviewed: true },
    certificate,
  );
  assert.equal(certificate.data.status, "issued");
  const issuedSnapshot = structuredClone(certificate.data);
  const mail = await f.send(`/ams/certificates/${certificate.id}/email-draft`);
  assert.equal(mail.status, 200);
  const parsed = await simpleParser(await mail.text());
  assert.equal(parsed.headers.get("x-unsent"), "1");
  assert.equal(parsed.to.value[0].address, holder.data.email);
  assert.equal(fileHash(parsed.attachments[0].content), document.data.sha256);
  assert.equal(
    (await f.repository.get("agency-1", "certificates", certificate.id)).data
      .deliveries.length,
    0,
    "downloading a draft is not delivery",
  );
  assert.equal(
    (
      await f.send(
        `/ams/certificates/${certificate.id}/email-draft`,
        undefined,
        "other",
      )
    ).status,
    404,
  );
  const delivery = f.command(
    "certificates",
    "certificate.deliver",
    {
      method: "email",
      recipient: holder.data.email,
      deliveredAt: certificate.data.issuedAt.slice(0, 19) + "Z",
      evidence: "Fictional mailbox receipt DEMO-1",
      confirmed: true,
      completeService: true,
      serviceVersion: service.version,
    },
    certificate,
  );
  assert.equal(
    (
      await f.send("/ams/commands", {
        ...delivery,
        data: { ...delivery.data, confirmed: false },
      })
    ).status,
    400,
  );
  const staleDelivery = {
    ...delivery,
    id: randomUUID(),
    data: { ...delivery.data, serviceVersion: "stale" },
  };
  assert.equal((await f.send("/ams/commands", staleDelivery)).status, 409);
  assert.equal(
    (await f.repository.get("agency-1", "certificates", certificate.id)).data
      .deliveries.length,
    0,
    "failed service completion rolls back delivery too",
  );
  for (const deliveredAt of [
    new Date(Date.parse(certificate.data.issuedAt) - 1000).toISOString(),
    new Date(Date.now() + 60000).toISOString(),
  ]) {
    assert.equal(
      (
        await f.send("/ams/commands", {
          ...delivery,
          id: randomUUID(),
          data: { ...delivery.data, deliveredAt },
        })
      ).status,
      422,
    );
  }
  const delivered = await f.send("/ams/commands", delivery);
  assert.equal(delivered.status, 200);
  certificate = (await delivered.json()).records[0];
  assert.equal((await f.send("/ams/commands", delivery)).status, 200);
  assert.equal(certificate.data.deliveries.length, 1);
  const completedService = await f.repository.get(
    "agency-1",
    "services",
    service.id,
  );
  assert.equal(completedService.data.status, "completed");
  assert.deepEqual(completedService.data.documentIds, [document.id]);
  assert.equal(
    certificate.data.deliveries[0].documentSha256,
    document.data.sha256,
  );
  assert.equal(
    (
      await f.send(
        "/ams/commands",
        f.command("certificates", "update", { deliveries: [] }, certificate),
      )
    ).status,
    422,
  );
  await f.execute(
    "certificateholders",
    "update",
    { name: "New holder name" },
    holder,
  );
  assert.equal(
    (await f.repository.get("agency-1", "certificates", certificate.id)).data
      .holderName,
    "Example Property",
  );
  const reissue = f.command(
    "certificates",
    "certificate.reissue",
    { policyIds: [f.policy.id], requestedDate: "2026-11-12" },
    certificate,
  );
  const nextResponse = await f.send("/ams/commands", reissue);
  assert.equal(nextResponse.status, 200);
  const next = (await nextResponse.json()).records[0];
  assert.equal((await f.send("/ams/commands", reissue)).status, 200);
  assert.equal(next.data.previousCertificateId, certificate.id);
  assert.equal(next.data.status, "requested");
  assert.equal(next.data.preparation, null);
  assert.equal(next.data.documentId, null);
  assert.deepEqual(next.data.deliveries, []);
  assert.deepEqual(
    (await f.repository.get("agency-1", "certificates", certificate.id)).data
      .policySnapshots,
    issuedSnapshot.policySnapshots,
  );
  const otherAccount = await f.execute("accounts", "create", {
    name: "Other fictional insured",
  });
  const otherPolicy = await f.execute("policies", "create", {
    ...f.policy.data,
    accountId: otherAccount.id,
    status: "draft",
    sourceReference: "",
  });
  assert.equal(
    (
      await f.send(
        "/ams/commands",
        f.command(
          "certificates",
          "certificate.reissue",
          { policyIds: [otherPolicy.id], requestedDate: "2026-11-12" },
          certificate,
        ),
      )
    ).status,
    422,
  );
  const second = await f.send(`/ams/certificates/${next.id}/prepare`, {
    ...prepare,
    commandId: randomUUID(),
    expectedVersion: next.version,
  });
  assert.equal(second.status, 200);
  const secondDraft = (await second.json()).records.find(
    (r) => r.kind === "certificates",
  );
  await f.execute("certificatetemplates", "template.revoke", {}, template);
  assert.equal(
    (
      await f.send(
        "/ams/commands",
        f.command(
          "certificates",
          "certificate.issue",
          { documentId: secondDraft.data.documentId, reviewed: true },
          secondDraft,
        ),
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.send(`/ams/documents/${document.id}/content`)).status,
    200,
    "revocation preserves issued PDF history",
  );
  const voided = await f.execute(
    "certificates",
    "certificate.void",
    {},
    certificate,
  );
  assert.equal(
    (await f.send(`/ams/certificates/${voided.id}/email-draft`)).status,
    409,
  );
  assert.equal(
    (
      await f.send(
        "/ams/commands",
        f.command("certificates", "certificate.deliver", delivery.data, voided),
      )
    ).status,
    409,
  );
});

test("legacy certificate records receive defaults without changing their optimistic-lock version", async (t) => {
  const f = await fixture(t);
  const record = await f.execute("certificates", "create", {
    accountId: f.account.id,
    holderName: "Fictional holder",
    requestedDate: "2026-11-11",
    policyIds: [f.policy.id],
  });
  const data = { ...record.data };
  for (const key of [
    "holderId",
    "serviceId",
    "deliveries",
    "previousCertificateId",
    "reissueReason",
  ])
    delete data[key];
  const legacy = versioned({ ...record, revision: record.revision + 1, data });
  await f.repository.transact("agency-1", async (tx) => {
    tx.put(legacy);
  });
  const restored = await f.repository.get(
    "agency-1",
    "certificates",
    record.id,
  );
  assert.deepEqual(restored.data.deliveries, []);
  assert.equal(restored.data.serviceId, null);
  assert.equal(restored.data.previousCertificateId, null);
  assert.equal(restored.version, legacy.version);
  const updated = await f.execute(
    "certificates",
    "update",
    { description: "Legacy request can still be edited" },
    restored,
  );
  assert.equal(updated.data.description, "Legacy request can still be edited");
});
