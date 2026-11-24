import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import {
  AMS_FORM_CATALOG,
  AmsFormSchema,
  amsFormAddLine,
  amsFormFromCatalog,
  amsFormIssues,
  amsFormRemoveLine,
  amsFormSections,
} from "@openams/contracts";
import { createAmsRouter } from "../dist/routes.js";
import { MemoryFormLinks, formSubmissionId, newFormLinkId } from "../dist/form-links.js";
import { openRepository, openFiles } from "./support/backend.mjs";

const PDF = Buffer.from("%PDF-1.4\n% fixture declarations page\n");
const members = [
  { id: "user-admin", name: "Avery Admin", email: "avery@agency.example.test", role: "admin", active: true },
  { id: "user-member", name: "Morgan Member", email: "morgan@agency.example.test", role: "member", active: true },
];

async function harness(t, forms = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ams-forms-"));
  const repository = openRepository(join(dir, "agency.sqlite"));
  const links = new MemoryFormLinks();
  const state = { accepting: true };
  const app = express();
  app.use(express.json({ limit: "300kb" }));
  app.use(
    createAmsRouter({
      authenticate: (req, res, next) =>
        req.header("authorization") ? next() : res.status(401).json({ error: "unauthorized" }),
      actor: (req) => {
        const token = (req.header("authorization") || "").replace("Bearer ", "");
        const [role, tenantId = "agency-1"] = token.split("@");
        return { tenantId, userId: `user-${role}`, name: `Fixture ${role}`, role };
      },
      enabled: async () => true,
      repository: () => repository,
      files: openFiles(join(dir, "files")),
      members: async () => members,
      workspaceName: async () => "Fixture agency",
      timeZone: async () => "America/Chicago",
      forms: { links, accepting: async () => state.accepting, ...forms },
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
  const json = async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) });
  const api = {
    state,
    links,
    get: (path, token = "admin") =>
      fetch(url + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }),
    post: (path, body, token = "admin") =>
      fetch(url + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }).then(json),
    command: (kind, action, data = {}, record, token = "admin", reason = "") =>
      api.post(
        "/ams/commands",
        {
          id: randomUUID(),
          kind,
          action,
          data,
          reason,
          ...(record ? { recordId: record.id, expectedVersion: record.version } : {}),
        },
        token,
      ),
    list: async (kind, token = "admin") =>
      (await (await api.get(`/ams/records/${kind}?limit=100`, token)).json()).items,
    upload: (link, submission, name, bytes) =>
      fetch(`${url}/public/forms/${link}/files?submission=${submission}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
        body: bytes,
      }).then(json),
    publicGet: (link) => fetch(`${url}/public/forms/${link}`).then(json),
    submit: (link, body) => api.post(`/public/forms/${link}/submissions`, body, null),
  };
  return api;
}
const autoForm = (extra = {}) => ({
  name: "Auto quote",
  title: "Let's get your auto quote started",
  intro: "A few questions about you, your drivers and your vehicles.",
  branding: { agencyName: "Harbor Fixture Insurance", phone: "555-0100" },
  ownerId: "user-member",
  ...amsFormFromCatalog(["auto"]),
  ...extra,
});
const autoAnswers = () => ({
  contact: [
    {
      name: "Dana Fixture",
      email: "dana@client.example.test",
      phone: "(555) 010-0199",
      address: { line1: "12 Sample Lane", line2: "", city: "Springfield", state: "IL", postalCode: "62701" },
    },
  ],
  auto_drivers: [
    { name: "Dana Fixture", birth_date: "1988-04-12", incidents: false },
    { name: "Robin Fixture", birth_date: "1990-09-30", incidents: true, incidents_detail: "One speeding ticket in 2024." },
  ],
  auto_vehicles: [{ year: "2021", make: "Toyota", model: "Camry", vin: "4T1FIXTURE0000001" }],
  auto_current: [{ insured: true, carrier: "Example Mutual", premium: "1480" }],
  wrap_up: [{ notes: "Call after 3pm." }],
});
async function published(api, form = autoForm()) {
  const created = await api.command("forms", "create", form);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const record = created.body.records[0];
  const result = await api.post(`/ams/forms/${record.id}/publish`, {
    commandId: randomUUID(),
    expectedVersion: record.version,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.records[0];
}

test("the catalog builds a valid form for every line, alone and together", () => {
  const sectionIds = new Set();
  for (const line of AMS_FORM_CATALOG)
    for (const section of line.sections) {
      assert.ok(section.id.startsWith(`${line.id}_`), section.id);
      assert.ok(!sectionIds.has(section.id), `duplicate section ${section.id}`);
      sectionIds.add(section.id);
    }
  const check = (ids) => {
    const draft = amsFormFromCatalog(ids);
    const form = AmsFormSchema.parse({ name: "Fixture", title: "Fixture", branding: { agencyName: "Fixture Agency" }, ...draft });
    assert.equal(form.sections[0].id, "contact");
    assert.equal(form.sections.at(-1).id, "wrap_up");
    return form;
  };
  for (const line of AMS_FORM_CATALOG) check([line.id]);
  for (const family of ["personal", "commercial"])
    check(AMS_FORM_CATALOG.filter((line) => line.family === family).map((line) => line.id));
  // A commercial line brings the shared business section and the business name.
  const mixed = check(["auto", "general_liability"].filter((id) => AMS_FORM_CATALOG.some((line) => line.id === id)));
  if (mixed.lines.length === 2) {
    assert.deepEqual(mixed.sections.find((section) => section.id === "business").lines, ["general_liability"]);
    assert.ok(mixed.sections[0].fields.some((field) => field.id === "business_name"));
    // A client who only wants auto is never asked the business questions.
    assert.ok(!amsFormSections(mixed, ["auto"]).some((section) => section.id === "business"));
    const added = amsFormAddLine(amsFormFromCatalog(["auto"]), "general_liability");
    assert.deepEqual(added.sections.map((section) => section.id), mixed.sections.map((section) => section.id));
    const removed = amsFormRemoveLine(added, "general_liability");
    assert.ok(!removed.sections.some((section) => section.id === "business" || section.lines.includes("general_liability")));
  }
});

test("answers are checked the same way for the page and the server", () => {
  const form = AmsFormSchema.parse(autoForm());
  assert.deepEqual(amsFormIssues(form, { lines: [], answers: autoAnswers(), files: [] }), []);
  const bad = autoAnswers();
  bad.contact[0].email = "not-an-email";
  bad.auto_drivers[1].incidents_detail = "";
  bad.auto_vehicles[0].year = "twenty";
  bad.auto_vehicles.push({});
  const issues = amsFormIssues(form, { lines: [], answers: bad, files: [] });
  const at = (section, item, field) => issues.some((issue) => issue.section === section && issue.item === item && issue.field === field);
  assert.ok(at("contact", 0, "email"));
  assert.ok(at("auto_drivers", 1, "incidents_detail"), "a shown follow-up question is required");
  assert.ok(!at("auto_drivers", 0, "incidents_detail"), "a hidden follow-up question is not");
  assert.ok(at("auto_vehicles", 0, "year"));
  assert.ok(at("auto_vehicles", 1, "make"), "an added item is checked like the first");
  // A form must open with a contact section that asks for a name and an email.
  const noContact = autoForm();
  noContact.sections = noContact.sections.slice(1);
  assert.equal(AmsFormSchema.safeParse(noContact).success, false);
  const dangling = autoForm();
  dangling.sections[1].fields[0].showIf = { field: "incidents", equals: true };
  assert.equal(AmsFormSchema.safeParse(dangling).success, false, "a question can depend only on an earlier one");
});

test("a published form takes a submission with files, and staff file it to a new account", async (t) => {
  const api = await harness(t);
  // Only administrators and managers build forms; a link can't be set by hand.
  assert.equal((await api.command("forms", "create", autoForm(), undefined, "member")).status, 403);
  assert.equal((await api.command("forms", "create", autoForm({ status: "published" }))).status, 422);
  assert.equal((await api.command("forms", "create", autoForm({ linkId: "auto-quote-aaaaaaaaaa" }))).status, 422);
  const draft = (await api.command("forms", "create", autoForm())).body.records[0];
  assert.equal(draft.data.status, "draft");
  assert.equal((await api.command("forms", "form.publish", { linkId: "auto-quote-aaaaaaaaaa" }, draft)).status, 403);
  assert.equal((await api.command("forms", "update", { linkId: "auto-quote-aaaaaaaaaa" }, draft)).status, 422);
  assert.equal(
    (await api.post(`/ams/forms/${draft.id}/publish`, { commandId: randomUUID(), expectedVersion: draft.version }, "member")).status,
    403,
  );
  const commandId = randomUUID();
  const publish = await api.post(`/ams/forms/${draft.id}/publish`, { commandId, expectedVersion: draft.version });
  assert.equal(publish.status, 200);
  const form = publish.body.records[0];
  assert.equal(form.data.status, "published");
  assert.match(form.data.linkId, /^auto-quote-[a-z0-9]{10}$/);
  // A retried publish is the same publish.
  const again = await api.post(`/ams/forms/${draft.id}/publish`, { commandId, expectedVersion: draft.version });
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.records[0].data.linkId, form.data.linkId);
  const link = form.data.linkId;

  // The public version carries the questions and the look, and nothing internal.
  const open = await api.publicGet(link);
  assert.equal(open.status, 200);
  assert.equal(open.body.status, "open");
  assert.deepEqual(Object.keys(open.body.form).sort(), [
    "branding", "confirmation", "consent", "intro", "lines", "linkId", "revision", "sections", "title",
  ]);
  assert.ok(!JSON.stringify(open.body).includes("user-member"));
  assert.equal((await api.publicGet("auto-quote-zzzzzzzzzz")).status, 404);
  assert.equal((await api.publicGet("../ams/session")).status, 404);

  // Uploads: checked by content, kept under this submission only.
  const page = randomUUID();
  assert.equal((await api.upload(link, page, "notes.exe", PDF)).status, 415);
  assert.equal((await api.upload(link, page, "fake.pdf", Buffer.from("not a pdf"))).status, 415);
  assert.equal((await api.upload(link, "not-a-uuid", "dec.pdf", PDF)).status, 400);
  const uploaded = await api.upload(link, page, "Dec page 2026.pdf", PDF);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.mediaType, "application/pdf");
  const file = { section: "auto_current", item: 0, field: "declarations", name: uploaded.body.name, sha256: uploaded.body.sha256, bytes: uploaded.body.bytes };

  const body = { id: page, revision: form.revision, lines: [], answers: autoAnswers(), files: [file], elapsedMs: 45_000 };
  // Scripts are refused honestly: a filled hidden field, or an instant submit.
  assert.equal((await api.submit(link, { ...body, confirm: "https://spam.example.test" })).status, 422);
  assert.equal((await api.submit(link, { ...body, elapsedMs: 300 })).status, 422);
  // Problems come back by question, never as a saved record.
  const invalid = structuredClone(body);
  invalid.answers.contact[0].email = "nope";
  const refused = await api.submit(link, invalid);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, "invalid_answers");
  assert.deepEqual(refused.body.issues.map((issue) => `${issue.section}.${issue.field}`), ["contact.email"]);
  // A file must sit on a file question the client was asked, and must really be stored.
  assert.equal((await api.submit(link, { ...body, files: [{ ...file, field: "carrier" }] })).status, 422);
  const missing = await api.submit(link, { ...body, files: [{ ...file, sha256: "a".repeat(64) }] });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error, "upload_missing");
  assert.equal((await api.list("formsubmissions")).length, 0);

  const sent = await api.submit(link, body);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.deepEqual(sent.body, { ok: true });
  // The same page submitting again is the same submission, even with other answers.
  assert.equal((await api.submit(link, body)).status, 200);
  const changed = structuredClone(body);
  changed.answers.wrap_up[0].notes = "Different";
  assert.equal((await api.submit(link, changed)).status, 200);
  const submissions = await api.list("formsubmissions");
  assert.equal(submissions.length, 1);
  let submission = submissions[0];
  assert.equal(submission.id, formSubmissionId(form.id, page));
  assert.equal(submission.createdBy, "ams_forms");
  assert.equal(submission.data.status, "new");
  assert.deepEqual(submission.data.contact, { name: "Dana Fixture", email: "dana@client.example.test", phone: "(555) 010-0199", businessName: "" });
  assert.deepEqual(submission.data.lines, [{ id: "auto", label: "Auto" }]);
  const drivers = submission.data.sections.find((section) => section.id === "auto_drivers");
  assert.deepEqual(drivers.items.map((item) => item.title), ["Dana Fixture", "Robin Fixture"]);
  assert.ok(!drivers.items[0].answers.some((answer) => answer.id === "incidents_detail"));
  assert.equal(submission.data.sections.find((section) => section.id === "auto_vehicles").items[0].title, "2021 Toyota Camry");
  assert.equal(submission.data.files.length, 1);
  assert.equal(submission.data.files[0].label, "Current declarations page");
  // The follow-up task goes to the form's owner, due the next day.
  const task = (await api.list("tasks")).find((item) => item.id === submission.data.taskId);
  assert.equal(task.data.ownerId, "user-member");
  assert.equal(task.data.accountId, null);
  assert.match(task.data.title, /Dana Fixture/);

  // Staff read the upload; another agency can't see the submission or the file.
  const download = await api.get(`/ams/form-submissions/${submission.id}/files/f1`, "member");
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), PDF);
  assert.equal((await api.get(`/ams/form-submissions/${submission.id}/files/f1`, "admin@agency-2")).status, 404);
  assert.equal((await api.list("formsubmissions", "admin@agency-2")).length, 0);
  // Answers are a record of what the client sent: no edits, no hand-made submissions.
  assert.equal((await api.command("formsubmissions", "update", { status: "filed" }, submission)).status, 409);
  assert.equal((await api.command("formsubmissions", "create", submission.data)).status, 400);
  assert.equal((await api.command("forms", "formSubmission.receive", {}, form)).status, 403);

  // Filing: a viewer can't; a member files to a new prospect account.
  assert.equal(
    (await api.command("formsubmissions", "formSubmission.file", { account: { name: "Dana Fixture", type: "person" } }, submission, "viewer")).status,
    403,
  );
  assert.equal((await api.command("formsubmissions", "formSubmission.file", {}, submission, "member")).status, 400);
  const filed = await api.command("formsubmissions", "formSubmission.file", { account: { name: "Dana Fixture", type: "person" } }, submission, "member");
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  const byKind = (kind) => filed.body.records.filter((record) => record.kind === kind);
  const [account] = byKind("accounts");
  assert.equal(account.data.status, "prospect");
  assert.equal(account.data.email, "dana@client.example.test");
  assert.equal(account.data.address.city, "Springfield");
  assert.equal(byKind("contacts")[0].data.primary, true);
  assert.deepEqual(
    byKind("exposures").map((record) => `${record.data.kind}:${record.data.name}`).sort(),
    ["driver:Dana Fixture", "driver:Robin Fixture", "vehicle:2021 Toyota Camry"],
  );
  assert.equal(byKind("exposures").find((record) => record.data.kind === "vehicle").data.values.VIN, "4T1FIXTURE0000001");
  const [document] = byKind("documents");
  assert.equal(document.data.category, "application");
  assert.equal(document.data.sha256, uploaded.body.sha256);
  assert.match(byKind("notes")[0].data.body, /Drivers: Robin Fixture\nFull name: Robin Fixture/);
  assert.equal(byKind("tasks")[0].data.accountId, account.id);
  submission = byKind("formsubmissions")[0];
  assert.equal(submission.data.status, "filed");
  assert.equal(submission.data.accountId, account.id);
  assert.equal(submission.data.filedBy, "user-member");
  assert.equal(submission.data.files[0].documentId, document.id);
  assert.equal(filed.body.audit.accountId, account.id);
  // The file is now an ordinary account document too.
  const content = await api.get(`/ams/documents/${document.id}/content`);
  assert.equal(content.status, 200);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), PDF);
  assert.equal((await api.command("formsubmissions", "formSubmission.file", { accountId: account.id }, submission)).status, 409);
});

test("pausing, access and editing decide whether a link is open", async (t) => {
  const api = await harness(t);
  let form = await published(api);
  const link = form.data.linkId;
  const body = () => ({ id: randomUUID(), revision: form.revision, lines: [], answers: autoAnswers(), files: [], elapsedMs: 60_000 });
  // An agency that may not take submissions right now: the link says so, with its name.
  api.state.accepting = false;
  const closed = await api.publicGet(link);
  assert.equal(closed.body.status, "closed");
  assert.equal(closed.body.branding.agencyName, "Harbor Fixture Insurance");
  assert.equal(closed.body.form, undefined);
  assert.equal((await api.submit(link, body())).status, 409);
  api.state.accepting = true;

  // Editing a published form is live at once; a client mid-form gets the new questions.
  const stale = body();
  const sections = structuredClone(form.data.sections);
  sections.at(-1).fields.unshift({ id: "referral", label: "Who referred you?", type: "text", required: true });
  const edited = await api.command("forms", "update", { sections }, form);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  form = edited.body.records[0];
  assert.equal(form.data.status, "published");
  const outdated = await api.submit(link, stale);
  assert.equal(outdated.status, 422);
  assert.equal(outdated.body.form.revision, form.revision);
  assert.deepEqual(outdated.body.issues.map((issue) => issue.field), ["referral"]);
  const current = body();
  current.answers.wrap_up[0].referral = "A neighbor";
  assert.equal((await api.submit(link, current)).status, 201);

  // Paused: closed to the public, and the same link reopens on publish.
  assert.equal((await api.command("forms", "form.pause", {}, form, "member")).status, 403);
  form = (await api.command("forms", "form.pause", {}, form)).body.records[0];
  assert.equal(form.data.status, "paused");
  assert.equal((await api.publicGet(link)).body.status, "closed");
  assert.equal((await api.submit(link, body())).status, 409);
  assert.equal((await api.upload(link, randomUUID(), "dec.pdf", PDF)).status, 409);
  form = (await api.post(`/ams/forms/${form.id}/publish`, { commandId: randomUUID(), expectedVersion: form.version })).body.records[0];
  assert.equal(form.data.linkId, link);
  assert.equal((await api.publicGet(link)).body.status, "open");
  // Archived: the link leads nowhere.
  const archived = await api.command("forms", "archive", {}, form, "admin", "Retired");
  assert.equal(archived.status, 200);
  assert.equal((await api.publicGet(link)).status, 404);
});

test("a submission can be filed to an existing account or dismissed with a reason", async (t) => {
  const api = await harness(t);
  const form = await published(api, autoForm({ ownerId: null }));
  const link = form.data.linkId;
  const send = async () => {
    const result = await api.submit(link, { id: randomUUID(), revision: form.revision, lines: [], answers: autoAnswers(), files: [], elapsedMs: 60_000 });
    assert.equal(result.status, 201);
  };
  await send();
  await send();
  const [first, second] = await api.list("formsubmissions");
  const account = (await api.command("accounts", "create", { name: "Fixture Household", type: "person" })).body.records[0];
  const filed = await api.command("formsubmissions", "formSubmission.file", { accountId: account.id, createContact: false, createExposures: false }, first);
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  assert.deepEqual(filed.body.records.map((record) => record.kind).sort(), ["formsubmissions", "notes", "tasks"]);
  assert.equal(filed.body.records.find((record) => record.kind === "formsubmissions").data.accountId, account.id);
  assert.equal((await api.command("formsubmissions", "formSubmission.file", { accountId: "missing-account" }, second)).status, 404);

  assert.equal((await api.command("formsubmissions", "formSubmission.dismiss", {}, second)).status, 422);
  const dismissed = await api.command("formsubmissions", "formSubmission.dismiss", {}, second, "member", "Duplicate of an earlier request");
  assert.equal(dismissed.status, 200);
  const submission = dismissed.body.records.find((record) => record.kind === "formsubmissions");
  assert.equal(submission.data.status, "dismissed");
  assert.equal(submission.data.dismissReason, "Duplicate of an earlier request");
  assert.equal(dismissed.body.records.find((record) => record.kind === "tasks").data.status, "done");
  const reopened = await api.command("formsubmissions", "formSubmission.reopen", {}, submission);
  assert.equal(reopened.body.records[0].data.status, "new");
});

test("where publishing is off, forms are built but no link opens", async (t) => {
  const api = await harness(t, { publishing: false });
  const session = await (await api.get("/ams/session")).json();
  assert.equal(session.formsEnabled, true);
  assert.equal(session.formPublishingEnabled, false);
  const draft = (await api.command("forms", "create", autoForm())).body.records[0];
  const refused = await api.post(`/ams/forms/${draft.id}/publish`, { commandId: randomUUID(), expectedVersion: draft.version });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "publishing_off");
});

test("a form takes only so many uploaded bytes a day", async (t) => {
  const api = await harness(t, { uploadBytesPerDay: PDF.length + 10 });
  const form = await published(api);
  const check = () => api.post(`/public/forms/${form.data.linkId}/upload-check`, {}, null);
  assert.equal((await check()).status, 200);
  assert.equal((await api.upload(form.data.linkId, randomUUID(), "one.pdf", PDF)).status, 201);
  // The next file would pass the day's allowance: refused, and nothing is stored.
  const refused = await api.upload(form.data.linkId, randomUUID(), "two.pdf", PDF);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "form_busy");
  assert.equal((await check()).status, 200, "a smaller file could still fit");
  // A form with no file question takes no files at all.
  const sections = structuredClone(form.data.sections).map((section) => ({
    ...section,
    fields: section.fields.filter((field) => field.type !== "file" && field.showIf?.field !== "insured"),
  }));
  const edited = await api.command("forms", "update", { sections }, form);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await check()).status, 422);
  assert.equal((await api.upload(form.data.linkId, randomUUID(), "three.pdf", PDF)).status, 422);
});

test("a link belongs to one form for good", async () => {
  const links = new MemoryFormLinks();
  const linkId = newFormLinkId("Auto & Home — Quote!");
  assert.match(linkId, /^auto-home-quote-[a-z0-9]{10}$/);
  await links.claim(linkId, { tenantId: "agency-1", formId: "form-1" });
  await links.claim(linkId, { tenantId: "agency-1", formId: "form-1" });
  await assert.rejects(links.claim(linkId, { tenantId: "agency-2", formId: "form-1" }), { code: "link_taken" });
  assert.deepEqual(await links.resolve(linkId), { tenantId: "agency-1", formId: "form-1" });
  assert.equal(await links.resolve("unknown-link-aaaa"), null);
  assert.notEqual(formSubmissionId("form-1", randomUUID()), formSubmissionId("form-2", randomUUID()));
});

test("the demo agency has a sample form with submissions waiting, and no open link where publishing is off", async (t) => {
  const { LocalAmsDemo } = await import("../dist/local-demo.js");
  const demoMembers = ["admin", "manager", "member", "accountant", "viewer"].map((role) => ({
    id: `local_${role}`, name: `Fixture ${role}`, email: `${role}@harbor.example.test`, role, active: true,
  }));
  for (const publishing of [true, false]) {
    const dir = await mkdtemp(join(tmpdir(), "ams-forms-demo-"));
    const repository = openRepository(join(dir, "agency.sqlite"));
    t.after(async () => {
      repository.close();
      await rm(dir, { recursive: true, force: true });
    });
    const links = new MemoryFormLinks();
    const demo = new LocalAmsDemo(dir, repository, openFiles(join(dir, "files")), demoMembers, { links, publishing });
    const input = { tenantId: `local_demo_${"ab".repeat(12)}`, commandId: randomUUID(), startedAt: new Date().toISOString() };
    await demo.seed(input);
    // Seeding again changes nothing.
    await demo.seed(input);
    const options = { limit: 100, includeArchived: "false" };
    const forms = (await repository.list(input.tenantId, "forms", options)).items;
    const submissions = (await repository.list(input.tenantId, "formsubmissions", options)).items;
    assert.equal(forms.length, 1);
    assert.equal(forms[0].data.status, publishing ? "published" : "paused");
    assert.deepEqual(submissions.map((item) => item.data.contact.name).sort(), ["Jamie Rivera", "Taylor Nguyen"]);
    assert.ok(submissions.every((item) => item.data.status === "new" && item.data.taskId));
    const target = await links.resolve(forms[0].data.linkId);
    assert.deepEqual(target, publishing ? { tenantId: input.tenantId, formId: forms[0].id } : null);
  }
});
