import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import {
  AMS_FORM_CATALOG,
  AMS_FORM_RESERVED_HANDLES,
  AmsFormHandle,
  AmsFormSchema,
  amsFormAddLine,
  amsFormFromCatalog,
  amsFormHandleError,
  amsFormIssues,
  amsFormPath,
  amsFormRemoveLine,
  amsFormSections,
  amsFormSnapshot,
  amsFormStored,
  amsFormTyped,
  amsFormValueText,
} from "@openams/contracts";
import { createAmsRouter } from "../dist/routes.js";
import { MemoryFormLinks, SqliteFormLinks, formPendingKey, formSubmissionId, newFormLinkId } from "../dist/form-links.js";
import { SqliteAmsRepository } from "../dist/sqlite-repository.js";
import { backend, firebaseServices, openRepository, openFiles, openPendingFiles } from "./support/backend.mjs";

const PDF = Buffer.from("%PDF-1.4\n% fixture declarations page\n");
const team = () => [
  { id: "user-admin", name: "Avery Admin", email: "avery@agency.example.test", role: "admin", active: true },
  { id: "user-member", name: "Morgan Member", email: "morgan@agency.example.test", role: "member", active: true },
];

async function harness(t, forms = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ams-forms-"));
  const repository = openRepository(join(dir, "agency.sqlite"));
  const links = new MemoryFormLinks();
  const pending = openPendingFiles(join(dir, "files"));
  const state = { accepting: true, members: team() };
  const files = openFiles(join(dir, "files"));
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
      files,
      members: async () => state.members,
      workspaceName: async () => "Fixture agency",
      timeZone: async () => "America/Chicago",
      forms: { links, pending, accepting: async () => state.accepting, ...forms },
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
    url,
    state,
    links,
    files,
    pending,
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
    removeUpload: (link, submission, sha256) =>
      api.post(`/public/forms/${link}/files/remove?submission=${submission}`, { sha256 }, null),
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

test("changing lines updates catalog contact defaults and retains agency wording", () => {
  const commercial = amsFormFromCatalog(["general_liability"]);
  const mixed = amsFormAddLine(commercial, "auto");
  assert.deepEqual(mixed.sections[0], amsFormFromCatalog(["general_liability", "auto"]).sections[0]);
  assert.deepEqual(amsFormRemoveLine(mixed, "general_liability").sections[0], amsFormFromCatalog(["auto"]).sections[0]);
  commercial.sections[0].fields.find((field) => field.label === "Business name").label = "Registered entity";
  assert.ok(amsFormAddLine(commercial, "auto").sections[0].fields.some((field) => field.label === "Registered entity"));
});

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
  // A choice is one of the choices exactly: a padded answer must not slip past the
  // condition of the question that depends on it.
  const padded = autoAnswers();
  padded.auto_current[0].insured = true;
  padded.auto_drivers[0].marital_status = "Married ";
  assert.ok(amsFormIssues(form, { lines: [], answers: padded, files: [] }).some((issue) => issue.field === "marital_status"));
  // A file sits on a file question, for an item the client answered; ten files in all.
  const file = (item, field = "declarations", section = "auto_current") => ({ section, item, field });
  const filed = (files) => amsFormIssues(form, { lines: [], answers: autoAnswers(), files });
  assert.deepEqual(filed([file(0)]), []);
  assert.equal(filed([file(3)]).length, 1, "an item nobody answered");
  assert.equal(filed([file(0, "carrier")]).length, 1, "not a file question");
  assert.equal(filed([file(0, "license", "auto_drivers")]).length, 1, "no such question");
  assert.ok(filed([...Array(5).fill(file(0)), ...Array(6).fill(file(0, "documents", "wrap_up"))]).length >= 1, "more than ten files");
  // A form must open with a contact section that asks for a name and an email.
  const noContact = autoForm();
  noContact.sections = noContact.sections.slice(1);
  assert.equal(AmsFormSchema.safeParse(noContact).success, false);
  const dangling = autoForm();
  dangling.sections[1].fields[0].showIf = { field: "incidents", equals: true };
  assert.equal(AmsFormSchema.safeParse(dangling).success, false, "a question can depend only on an earlier one");
});

test("typed answers are tidied as they are typed and kept in one spelling", () => {
  const typed = (type, steps) => steps.map((step) => amsFormTyped(type, step));
  // Each keystroke of a phone number, then the ways one arrives whole.
  assert.deepEqual(typed("phone", ["5", "518", "5185", "5185550", "5185550142"]), [
    "(5", "(518", "(518) 5", "(518) 555-0", "(518) 555-0142",
  ]);
  for (const whole of ["518.555.0142", "1 518 555 0142", "+15185550142", "(518) 555-0142"])
    assert.equal(amsFormStored("phone", whole), "(518) 555-0142");
  assert.equal(amsFormTyped("phone", "(518) 555-0142x12"), "(518) 555-0142 x12");
  assert.equal(amsFormStored("phone", "(518) 555-0142 x"), "(518) 555-0142", "an x with no extension is dropped");
  assert.equal(amsFormStored("phone", "+44  20 7946 0958"), "+44 20 7946 0958", "another country's number is left as its digits");
  // Dates are typed, with or without slashes, and kept as YYYY-MM-DD.
  assert.deepEqual(typed("date", ["3", "031", "0314", "03141986", "3/", "3/1/", "3/14/1986", "1986-03-14"]), [
    "03", "03/1", "03/14", "03/14/1986", "03/", "03/01/", "03/14/1986", "03/14/1986",
  ]);
  assert.equal(amsFormStored("date", "3/4/1986"), "1986-03-04");
  assert.equal(amsFormValueText("1986-03-04", "date"), "03/04/1986");
  // Money always groups thousands; a plain number waits for five digits, so a year
  // typed into one is not written 1,998.
  assert.deepEqual(typed("currency", ["1200", "$250,000", "1200.505", ".5"]), ["1,200", "250,000", "1,200.50", "0.5"]);
  assert.deepEqual(typed("number", ["1998", "12000", "0.95"]), ["1998", "12,000", "0.95"]);
  assert.equal(amsFormStored("currency", "250,000"), "250000");
  assert.equal(amsFormValueText("250000", "currency"), "$250,000");
  assert.equal(amsFormValueText("12000", "number"), "12,000");
  assert.equal(amsFormValueText("45", "percent"), "45%");
  assert.deepEqual(
    [amsFormTyped("zip", "123456789"), amsFormTyped("ein", "123456789"), amsFormTyped("year", "19985"), amsFormTyped("vin", "1hgcm82633a 004352")],
    ["12345-6789", "12-3456789", "1998", "1HGCM82633A004352"],
  );
  // Tidying what is already tidy changes nothing, so it is safe on every keystroke.
  for (const [type, value] of [["phone", "5185550142"], ["currency", "1234567.89"], ["number", "12000.5"], ["date", "03141986"], ["zip", "123456789"], ["ein", "123456789"]])
    assert.equal(amsFormTyped(type, amsFormTyped(type, value)), amsFormTyped(type, value));
  // The page and the server agree on what is acceptable, however it was typed.
  const form = AmsFormSchema.parse(autoForm());
  const loose = autoAnswers();
  loose.contact[0].phone = "1-555-010-0199";
  loose.auto_drivers[0].birth_date = "4/12/1988";
  assert.deepEqual(amsFormIssues(form, { lines: [], answers: loose, files: [] }), []);
  const kept = amsFormSnapshot(form, { lines: [], answers: loose, files: [] });
  const answer = (section, id) => kept.find((item) => item.id === section).items[0].answers.find((item) => item.id === id).value;
  assert.equal(answer("contact", "phone"), "(555) 010-0199");
  assert.equal(answer("auto_drivers", "birth_date"), "1988-04-12");
  const wrong = autoAnswers();
  wrong.contact[0].phone = "555-0199";
  wrong.auto_drivers[0].birth_date = "13/45/1988";
  wrong.auto_vehicles[0].year = "98";
  assert.deepEqual(
    amsFormIssues(form, { lines: [], answers: wrong, files: [] }).map((issue) => issue.message),
    ["Enter a 10-digit phone number, area code first.", "Enter a date as MM/DD/YYYY.", "Enter a 4-digit year."],
  );
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
  // The same page sending the same answers again is the same submission. With other
  // answers it is told the first ones were kept: never thanked for what wasn't saved.
  assert.equal((await api.submit(link, body)).status, 200);
  const changed = structuredClone(body);
  changed.answers.wrap_up[0].notes = "Different";
  const second = await api.submit(link, changed);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "already_received");
  // Until it was sent the file waited apart from the agency's documents; now it is with
  // them, and the waiting copy is gone.
  const savedId = formSubmissionId(form.id, page);
  await assert.rejects(api.pending.get(formPendingKey("agency-1", savedId, uploaded.body.sha256)));
  assert.deepEqual(await api.files.get((await api.list("formsubmissions"))[0].data.files[0].storageKey), PDF);
  // A file the client takes back before sending is deleted, not kept.
  const other = randomUUID();
  const kept = await api.upload(link, other, "second.pdf", Buffer.concat([PDF, Buffer.from("second")]));
  const waiting = formPendingKey("agency-1", formSubmissionId(form.id, other), kept.body.sha256);
  assert.equal((await api.pending.get(waiting)).length, kept.body.bytes);
  assert.equal((await api.removeUpload(link, other, kept.body.sha256)).status, 200);
  await assert.rejects(api.pending.get(waiting));
  assert.equal((await api.removeUpload(link, other, kept.body.sha256)).status, 200, "removing twice is fine");
  assert.equal((await api.removeUpload(link, "nope", kept.body.sha256)).status, 400);
  const submissions = await api.list("formsubmissions");
  assert.equal(submissions.length, 1);
  let submission = submissions[0];
  assert.equal(submission.id, formSubmissionId(form.id, page));
  assert.equal(submission.createdBy, "ams_forms");
  assert.equal(submission.data.status, "new");
  assert.match(submission.data.digest, /^[a-f0-9]{64}$/);
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
  assert.equal(outdated.status, 409);
  assert.equal(outdated.body.error, "form_updated");
  assert.equal(outdated.body.form.revision, form.revision);
  assert.deepEqual(outdated.body.issues.map((issue) => issue.field), ["referral"]);
  // Even when the old answers would pass, an answer is never filed under wording the
  // client did not read: they are shown the current form and send again.
  const reworded = structuredClone(form.data.sections);
  reworded.at(-1).fields[0].required = false;
  reworded[1].fields.find((field) => field.id === "incidents").label = "Confirm: no accidents or tickets in the last 5 years";
  const before = form.revision;
  form = (await api.command("forms", "update", { sections: reworded }, form)).body.records[0];
  const unread = await api.submit(link, { ...body(), revision: before });
  assert.equal(unread.status, 409);
  assert.equal(unread.body.error, "form_updated");
  assert.deepEqual(unread.body.issues, []);
  assert.equal((await api.list("formsubmissions")).length, 0);
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
  // A client whose answers were saved before the pause is still told so on a retry.
  assert.deepEqual(await api.submit(link, current), { status: 200, body: { ok: true } });
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

test("only what is saved spends a form's allowance, and one link's traffic stays its own", async (t) => {
  const api = await harness(t, { burst: { submissions: 2, uploads: 2 } });
  const form = await published(api);
  const link = form.data.linkId;
  const body = (extra = {}) => ({ id: randomUUID(), revision: form.revision, lines: [], answers: autoAnswers(), files: [], elapsedMs: 60_000, ...extra });
  const missing = { section: "auto_current", item: 0, field: "declarations", name: "dec.pdf", sha256: "b".repeat(64), bytes: 10 };
  // Requests that save nothing (a file that was never uploaded, a check before an
  // upload) take nothing from the form: a real client is not shut out by them.
  for (let count = 0; count < 5; count++) {
    assert.equal((await api.submit(link, body({ files: [missing] }))).body.error, "upload_missing");
    assert.equal((await api.post(`/public/forms/${link}/upload-check`, {}, null)).status, 200);
  }
  assert.equal((await api.submit(link, body())).status, 201);
  assert.equal((await api.submit(link, body())).status, 201);
  // The burst is spent by two saved submissions; the next waits.
  const waits = await api.submit(link, body());
  assert.equal(waits.status, 429);
  assert.equal(waits.body.error, "form_busy");
  assert.equal((await api.upload(link, randomUUID(), "one.pdf", PDF)).status, 201);
  assert.equal((await api.upload(link, randomUUID(), "two.pdf", PDF)).status, 201);
  assert.equal((await api.upload(link, randomUUID(), "three.pdf", PDF)).body.error, "form_busy");
  assert.equal((await api.list("formsubmissions")).length, 2);

  // Without a trusted client address the per-minute limits are kept per link, so a
  // flood at one link (here, one that leads nowhere) never closes another form.
  const other = await published(api, autoForm({ name: "Second form" }));
  let refused = 0;
  for (let count = 0; count < 24; count++)
    if ((await api.submit("no-such-form-aaaaaaaaaa", body())).status === 429) refused++;
  assert.ok(refused >= 3, "the flooded link is limited");
  assert.equal((await api.submit(other.data.linkId, { ...body(), revision: other.revision })).status, 201);
});

test("one client takes only its share of a form, and an unsaved submission leaves no files behind", async (t) => {
  const api = await harness(t, { burst: { submissions: 4, clientSubmissions: 2 } });
  const form = await published(api);
  const link = form.data.linkId;
  const body = (extra = {}) => ({ id: randomUUID(), revision: form.revision, lines: [], answers: autoAnswers(), files: [], elapsedMs: 60_000, ...extra });
  const from = (client, payload) =>
    fetch(`${api.url}/public/forms/${link}/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-openams-client": client },
      body: JSON.stringify(payload),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
  // One address sends as fast as it can: it gets its share and no more.
  assert.equal((await from("203.0.113.7", body())).status, 201);
  assert.equal((await from("203.0.113.7", body())).status, 201);
  const refused = await from("203.0.113.7", body());
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, "form_busy");
  // The form is still open to everyone else.
  assert.equal((await from("203.0.113.8", body())).status, 201);
  assert.equal((await api.list("formsubmissions")).length, 3);

  // A submission that can't be saved takes its copied files back out of the documents.
  // Here the store refuses the second of two files.
  const submission = randomUUID();
  const OTHER = Buffer.from("%PDF-1.4\n% a second fixture file\n");
  const one = await api.upload(link, submission, "dec.pdf", PDF);
  const two = await api.upload(link, submission, "extra.pdf", OTHER);
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.equal(two.status, 201, JSON.stringify(two.body));
  const put = api.files.put.bind(api.files);
  const remove = api.files.remove.bind(api.files);
  const stored = [];
  const removed = [];
  api.files.put = async (key, ...rest) => {
    if (stored.length === 1) throw new Error("the store refused this file");
    stored.push(key);
    return put(key, ...rest);
  };
  api.files.remove = async (key) => {
    removed.push(key);
    return remove(key);
  };
  const failed = await from(
    "203.0.113.9",
    body({
      id: submission,
      files: [
        { section: "auto_current", item: 0, field: "declarations", name: "dec.pdf", sha256: one.body.sha256, bytes: PDF.length },
        { section: "wrap_up", item: 0, field: "documents", name: "extra.pdf", sha256: two.body.sha256, bytes: OTHER.length },
      ],
    }),
  );
  assert.ok(failed.status >= 500, JSON.stringify(failed.body));
  assert.equal(stored.length, 1);
  assert.deepEqual(removed, stored, "the copy made for the unsaved submission is removed");
  assert.equal((await api.list("formsubmissions")).length, 3, "nothing was saved");
});

test("a revision change after copying a file leaves it pending for resubmission", async (t) => {
  const api = await harness(t);
  const form = await published(api);
  const page = randomUUID();
  const upload = await api.upload(form.data.linkId, page, "fixture.pdf", PDF);
  const put = api.files.put.bind(api.files);
  let copied;
  api.files.put = async (key, ...args) => {
    copied = key;
    await put(key, ...args);
    const edited = await api.command("forms", "update", { name: "Updated intake" }, form);
    assert.equal(edited.status, 200);
  };
  const payload = { id: page, revision: form.revision, lines: [], answers: autoAnswers(), elapsedMs: 60_000,
    files: [{ section: "auto_current", item: 0, field: "declarations", name: "fixture.pdf", sha256: upload.body.sha256, bytes: PDF.length }] };
  const stale = await api.submit(form.data.linkId, payload);
  assert.equal(stale.body.error, "form_updated");
  assert.ok(copied);
  await assert.rejects(api.files.get(copied));
  assert.equal((await api.list("formsubmissions")).length, 0);
  api.files.put = put;
  const retry = await api.submit(form.data.linkId, { ...payload, revision: stale.body.form.revision });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
});

test("Firebase submission consumes the upload journal and keeps the downloaded bytes", { skip: backend !== "firebase" }, async (t) => {
  const { firestore, storage } = await firebaseServices();
  const { formPromotions } = await import("../dist/firebase/form-promotions.js");
  const bucket = storage.bucket();
  const promotions = formPromotions(firestore, bucket, 500_000_000);
  let attempt;
  const begin = promotions.begin;
  promotions.begin = async (id, ...args) => {
    attempt = id;
    await begin(id, ...args);
  };
  const api = await harness(t, { promotions });
  const form = await published(api);
  const page = randomUUID();
  const upload = await api.upload(form.data.linkId, page, "fixture.pdf", PDF);
  const payload = { id: page, revision: form.revision, lines: [], answers: autoAnswers(), elapsedMs: 60_000,
    files: [{ section: "auto_current", item: 0, field: "declarations", name: "fixture.pdf", sha256: upload.body.sha256, bytes: PDF.length }] };
  const sent = await api.submit(form.data.linkId, payload);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal((await firestore.collection("form_promotions").doc(attempt).get()).exists, false);
  const [record] = await api.list("formsubmissions");
  assert.deepEqual((await bucket.file(record.data.files[0].storageKey).download())[0], PDF);
  assert.equal((await api.submit(form.data.linkId, payload)).status, 200);
});

test("a follow-up outlives the person it was given to", async (t) => {
  const api = await harness(t);
  let form = await published(api);
  const link = form.data.linkId;
  const send = async () =>
    assert.equal((await api.submit(link, { id: randomUUID(), revision: form.revision, lines: [], answers: autoAnswers(), files: [], elapsedMs: 60_000 })).status, 201);
  await send();
  await send();
  const [first, second] = await api.list("formsubmissions");
  assert.ok((await api.list("tasks")).every((task) => task.data.ownerId === "user-member"));
  // The form's owner leaves the agency.
  api.state.members = api.state.members.map((member) => (member.id === "user-member" ? { ...member, active: false } : member));
  const filed = await api.command("formsubmissions", "formSubmission.file", { account: { name: "Dana Fixture", type: "person" } }, first);
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  assert.equal(filed.body.records.find((record) => record.kind === "tasks").data.ownerId, "user-admin", "whoever files it takes it on");
  const dismissed = await api.command("formsubmissions", "formSubmission.dismiss", {}, second, "admin", "Duplicate");
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  // New submissions go to nobody rather than failing, and the form can still be paused.
  await send();
  const newest = (await api.list("tasks")).find((task) => task.data.status === "open" && !task.data.accountId);
  assert.equal(newest.data.ownerId, null);
  form = (await api.command("forms", "form.pause", {}, form)).body.records[0];
  assert.equal(form.data.ownerId, null);
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

/* ------------------------------------------------------- the forms address */

const INVALID_HANDLE = "Use 3 to 40 lowercase letters, numbers and dashes.";

test("a forms address is short, lowercase and not a reserved name", () => {
  for (const handle of ["harbor-agency", "abc", "a1b", "harbor2", "a".repeat(40)]) {
    assert.equal(amsFormHandleError(handle), null, handle);
    assert.equal(AmsFormHandle.safeParse(handle).success, true, handle);
  }
  for (const handle of ["", "ab", "Harbor", "harbor agency", "harbor_agency", "-harbor", "harbor-", "harbor--agency", "a".repeat(41), "harbor/agency", "../harbor"]) {
    assert.equal(amsFormHandleError(handle), INVALID_HANDLE, handle);
    assert.equal(AmsFormHandle.safeParse(handle).success, false, handle);
  }
  for (const handle of ["forms", "form", "f", "api", "app", "admin", "www", "openams", "support", "help", "billing", "login", "signin", "sign-in", "signup", "security", "status", "demo", "test", "new", "about", "pricing", "terms", "privacy"]) {
    assert.ok(AMS_FORM_RESERVED_HANDLES.includes(handle), handle);
    assert.ok(amsFormHandleError(handle), handle);
  }
  assert.equal(amsFormHandleError("forms"), "That address is reserved.");
  // A form's readable name is its link without the random ending.
  assert.equal(amsFormPath("auto-quote-abcdefghjk"), "auto-quote");
  assert.equal(amsFormPath(newFormLinkId("Auto & Home — Quote!")), "auto-home-quote");
  assert.equal(amsFormPath("auto-quote"), "auto-quote");
});

test("the link index gives an agency one address and keeps addresses and links apart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ams-form-handles-"));
  const database = new SqliteAmsRepository(join(dir, "agency.sqlite"));
  t.after(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const links of [new MemoryFormLinks(), new SqliteFormLinks(database)]) {
    assert.equal(await links.resolveHandle("harbor-agency"), null);
    assert.equal(await links.handleOf("agency-1"), null);
    await links.claimHandle("harbor-agency", "agency-1");
    // Asking again for the address it has changes nothing.
    await links.claimHandle("harbor-agency", "agency-1");
    assert.equal(await links.resolveHandle("harbor-agency"), "agency-1");
    assert.equal(await links.handleOf("agency-1"), "harbor-agency");
    await assert.rejects(links.claimHandle("harbor-agency", "agency-2"), { code: "handle_taken", status: 409 });
    await assert.rejects(links.claimHandle("harbor-west", "agency-1"), { code: "handle_set", status: 409 });
    assert.equal(await links.resolveHandle("harbor-west"), null, "a refused claim changes nothing");
    assert.equal(await links.handleOf("agency-2"), null);
    // An address and a link share /f/<name>: neither takes the other's.
    const linkId = newFormLinkId("Auto quote");
    await links.claim(linkId, { tenantId: "agency-1", formId: "form-1" });
    await assert.rejects(links.claimHandle(linkId, "agency-2"), { code: "handle_taken" });
    await assert.rejects(links.claim("harbor-agency", { tenantId: "agency-2", formId: "form-2" }), { code: "link_taken" });
    assert.equal(await links.resolve("harbor-agency"), null);
    assert.equal(await links.resolveHandle(linkId), null);
    await links.claimHandle("second-agency", "agency-2");
    assert.equal(await links.handleOf("agency-2"), "second-agency");
  }
});

test("an agency claims its forms address once, and no other agency can take it", async (t) => {
  const api = await harness(t);
  const address = async (token) => (await api.get("/ams/forms/address", token)).json();
  assert.equal((await api.get("/ams/forms/address", null)).status, 401);
  // Anyone on the team can see it; the suggestion comes from the agency's name.
  assert.deepEqual(await address("viewer"), { handle: null, suggestion: "fixture-agency", publishing: true });
  const claim = (handle, token = "admin") => api.post("/ams/forms/address", { handle }, token);

  // Only the roles that publish forms choose it.
  for (const role of ["member", "accountant", "viewer"]) {
    const refused = await claim("harbor-agency", role);
    assert.equal(refused.status, 403, role);
    assert.equal(refused.body.error, "manager_required");
  }
  for (const handle of ["ab", "Harbor-Agency", "harbor--agency", "-harbor", "harbor_agency", "a".repeat(41), "harbor agency"])
    assert.deepEqual(await claim(handle), { status: 422, body: { error: "handle_invalid", message: INVALID_HANDLE } }, handle);
  for (const handle of ["forms", "admin", "openams", "sign-in"])
    assert.deepEqual(await claim(handle), { status: 422, body: { error: "handle_invalid", message: "That address is reserved." } }, handle);
  for (const body of [{}, { handle: 7 }, { handle: "harbor-agency", tenantId: "agency-2" }])
    assert.equal((await api.post("/ams/forms/address", body)).body.error, "handle_invalid", JSON.stringify(body));
  assert.equal((await address("admin")).handle, null, "a refused address is not kept");

  assert.deepEqual(await claim("harbor-agency", "manager"), { status: 200, body: { handle: "harbor-agency" } });
  // Asking for the same address again is simply confirmed.
  assert.deepEqual(await claim("harbor-agency"), { status: 200, body: { handle: "harbor-agency" } });
  assert.equal((await address("member")).handle, "harbor-agency");
  // Set once: a different address is refused, and the answer says which one it has.
  const again = await claim("harbor-west");
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "handle_set");
  assert.equal(again.body.handle, "harbor-agency");
  assert.equal(await api.links.resolveHandle("harbor-west"), null);

  // Another agency cannot take it, and is told nothing about who has it.
  const other = "admin@agency-2";
  assert.equal((await address(other)).handle, null);
  const taken = await claim("harbor-agency", other);
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, "handle_taken");
  assert.deepEqual(Object.keys(taken.body).sort(), ["error", "message"]);
  assert.equal((await address(other)).handle, null);
  // Nor an address spelled like an existing form link.
  const form = await published(api);
  assert.equal((await claim(form.data.linkId, other)).body.error, "handle_taken");
  assert.deepEqual(await claim("second-agency", other), { status: 200, body: { handle: "second-agency" } });
  assert.equal((await address(other)).handle, "second-agency");
  assert.equal((await address("admin")).handle, "harbor-agency");
});

test("a forms address lists only live forms, and nothing internal", async (t) => {
  const api = await harness(t);
  const agency = (handle = "harbor-agency") =>
    api.get(`/public/agencies/${handle}`, null).then(async (response) => ({ status: response.status, body: await response.json() }));
  const missing = { status: 404, body: { error: "not_found" } };
  assert.deepEqual(await agency(), missing, "nobody has claimed it");
  assert.deepEqual((await api.post("/ams/forms/address", { handle: "harbor-agency" })).body, { handle: "harbor-agency" });
  assert.deepEqual(await agency(), missing, "no live form yet");
  await api.command("forms", "create", autoForm({ name: "Internal draft" }));
  assert.deepEqual(await agency(), missing, "a draft is not live");

  let auto = await published(api);
  const first = await agency();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, {
    handle: "harbor-agency",
    name: "Harbor Fixture Insurance",
    phone: "555-0100",
    email: "",
    accent: "#1f6f5c",
    logo: "",
    forms: [
      {
        linkId: auto.data.linkId,
        path: "auto-quote",
        title: "Let's get your auto quote started",
        intro: "A few questions about you, your drivers and your vehicles.",
        lines: auto.data.lines,
      },
    ],
  });
  // The form opens at its own link exactly as before.
  assert.equal((await api.publicGet(auto.data.linkId)).body.status, "open");

  // A newer form comes first, and its look is the agency's.
  let home = await published(
    api,
    autoForm({
      name: "Auto quote",
      title: "A second way in",
      branding: { agencyName: "Harbor Fixture Insurance West", phone: "555-0111", email: "west@agency.example.test", accent: "#224466" },
    }),
  );
  const both = await agency();
  assert.deepEqual(both.body.forms.map((form) => form.linkId), [home.data.linkId, auto.data.linkId]);
  // Two forms with the same name share a path; both are listed, each with its own link.
  assert.deepEqual(both.body.forms.map((form) => form.path), ["auto-quote", "auto-quote"]);
  assert.equal(both.body.name, "Harbor Fixture Insurance West");
  assert.equal(both.body.email, "west@agency.example.test");
  assert.equal(both.body.accent, "#224466");
  // Nothing internal: no record ids, owner, follow-up settings, questions or agency id.
  assert.deepEqual(Object.keys(both.body).sort(), ["accent", "email", "forms", "handle", "logo", "name", "phone"]);
  for (const form of both.body.forms)
    assert.deepEqual(Object.keys(form).sort(), ["intro", "lines", "linkId", "path", "title"]);
  const text = JSON.stringify(both.body);
  for (const internal of [auto.id, home.id, "user-member", "ownerId", "followUpDays", "agency-1", "sections", "Internal draft", "internal-draft", "publishedAt"])
    assert.equal(text.includes(internal), false, internal);

  // Paused: off the list. With nothing live, the address reads as if it were never claimed.
  home = (await api.command("forms", "form.pause", {}, home)).body.records[0];
  const one = await agency();
  assert.deepEqual(one.body.forms.map((form) => form.linkId), [auto.data.linkId]);
  assert.equal(one.body.name, "Harbor Fixture Insurance");
  auto = (await api.command("forms", "form.pause", {}, auto)).body.records[0];
  assert.deepEqual(await agency(), missing);
  auto = (await api.post(`/ams/forms/${auto.id}/publish`, { commandId: randomUUID(), expectedVersion: auto.version })).body.records[0];
  assert.equal((await agency()).status, 200);
  // An agency that may not take submissions right now.
  api.state.accepting = false;
  assert.deepEqual(await agency(), missing);
  api.state.accepting = true;
  assert.equal((await agency()).status, 200);
  assert.equal((await api.command("forms", "archive", {}, auto, "admin", "Retired")).status, 200);
  assert.deepEqual(await agency(), missing);
  // Unknown and malformed addresses read the same; a form link is not an address.
  for (const handle of ["nobody-here", "Harbor-Agency", "ab", "harbor--agency", home.data.linkId])
    assert.deepEqual(await agency(handle), missing, handle);
});

test("where publishing is off, no address is claimed or opened", async (t) => {
  const api = await harness(t, { publishing: false });
  assert.deepEqual(await (await api.get("/ams/forms/address")).json(), { handle: null, suggestion: "fixture-agency", publishing: false });
  const refused = await api.post("/ams/forms/address", { handle: "harbor-agency" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "publishing_off");
  assert.equal(await api.links.resolveHandle("harbor-agency"), null);
  await api.links.claimHandle("harbor-agency", "agency-1");
  assert.equal((await api.get("/public/agencies/harbor-agency", null)).status, 404);
});
