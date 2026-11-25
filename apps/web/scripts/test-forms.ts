// Hosted forms: the builder's draft rules, the share snippet, who a submission probably
// belongs to, and the one place another site may frame this app.
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { AMS_FORM_CATALOG, AmsFormSchema, amsFormFromCatalog } from "@openams/contracts";
import { contentSecurityPolicy, isHostedFormPath, proxy } from "../src/proxy";
import {
  draftProblems,
  embedSnippet,
  exposureSummary,
  fitsOneForm,
  formNameFor,
  formUrl,
  isLoopback,
  matchingAccounts,
  newFormDraft,
  newKey,
  previewForm,
  sameDraft,
  tidyDraft,
  timeAgo,
  type FormDraft,
  type SubmissionRecord,
} from "../src/features/agency/forms-model";
import type { AmsRecord, Book } from "../src/features/agency/model";
import { inkOn } from "../src/features/forms/form-color";

const agency = { name: "Harbor Fixture Agency", phone: "555-0100", email: "hello@harbor.example.test" };

// A new draft from any starter saves as it is.
for (const lines of [[], ["auto"], ["auto", "home", "renters"], ["general_liability", "bop", "workers_comp"]]) {
  const draft = newFormDraft(agency, lines);
  assert.deepEqual(draftProblems(draft), [], lines.join(","));
  assert.ok(AmsFormSchema.safeParse({ ...tidyDraft(draft), status: "draft" }).success);
  assert.equal(draft.branding.agencyName, "Harbor Fixture Agency");
}
assert.equal(newFormDraft(agency, ["auto"]).name, "Auto quote");
assert.equal(newFormDraft(agency, ["auto", "home"]).name, "Auto & homeowners quote");
assert.equal(newFormDraft(agency, ["auto"], "Spring campaign").name, "Spring campaign");
assert.equal(formNameFor({ lines: [] }), "New form");
assert.equal(newFormDraft({ name: "" }).branding.agencyName, "Our agency");

// The same draft, however its properties are ordered, is not an unsaved change.
const draft = newFormDraft(agency, ["auto"]);
const reversed = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reversed)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)]))
      : value;
assert.notEqual(JSON.stringify(reversed(draft)), JSON.stringify(draft));
assert.ok(sameDraft(draft, reversed(draft) as FormDraft));
assert.ok(!sameDraft(draft, { ...draft, title: "Another headline" }));

// Problems are said in the builder's words, and the first one that matters comes first.
const blank = structuredClone(draft);
blank.sections[1].fields[0].label = " ";
assert.match(draftProblems(blank)[0], /has no wording/);
const choice = structuredClone(draft);
choice.sections[1].fields.push({ id: "question_1", label: "Pick one", help: "", type: "select", required: false, options: ["", " "], showIf: null });
assert.match(draftProblems(choice)[0], /needs at least one choice/);
assert.match(draftProblems({ ...draft, name: "" })[0], /Give the form a name/);

// Tidying keeps a draft valid after edits: a question whose condition lost what it
// depended on is asked always, and choices are trimmed and listed once.
const edited = structuredClone(draft);
const drivers = edited.sections.find((section) => section.id === "auto_drivers")!;
const detail = drivers.fields.find((field) => field.id === "incidents_detail")!;
assert.deepEqual(detail.showIf, { field: "incidents", equals: true });
drivers.fields = drivers.fields.filter((field) => field.id !== "incidents");
drivers.fields[0].options = ["ignored on a text question"];
drivers.fields.push({ id: "question_9", label: " Garage? ", help: "", type: "select", required: false, options: [" Yes ", "Yes", "", "No"], showIf: null });
const tidy = tidyDraft(edited);
const tidyDrivers = tidy.sections.find((section) => section.id === "auto_drivers")!;
assert.equal(tidyDrivers.fields.find((field) => field.id === "incidents_detail")!.showIf, null);
assert.deepEqual(tidyDrivers.fields[0].options, []);
assert.deepEqual(tidyDrivers.fields.at(-1)!.options, ["Yes", "No"]);
assert.equal(tidyDrivers.fields.at(-1)!.label, "Garage?");
assert.deepEqual(draftProblems(edited), []);
// A repeating section is named only by questions it still has.
const vehicles = edited.sections.find((section) => section.id === "auto_vehicles")!;
vehicles.fields = vehicles.fields.filter((field) => field.id !== "make");
assert.deepEqual(tidyDraft(edited).sections.find((section) => section.id === "auto_vehicles")!.repeat!.title, ["year", "model"]);
// The preview is what a client would get: no owner, no internal name.
const preview = previewForm(draft);
assert.deepEqual(Object.keys(preview).sort(), ["branding", "confirmation", "consent", "intro", "lines", "linkId", "revision", "sections", "title"]);
// New ids are random: the id of a removed question is never handed to a new one.
const keys = new Set(Array.from({ length: 200 }, () => newKey("question", [])));
assert.ok(keys.size > 190);
for (const key of keys) assert.match(key, /^question_[a-z0-9]{1,6}$/);
// A form past what one form holds says so in plain words.
const everything = newFormDraft(agency, AMS_FORM_CATALOG.map((line) => line.id));
assert.ok(!fitsOneForm(everything));
assert.match(draftProblems(everything)[0], /holds up to 40 sections/);
assert.ok(fitsOneForm(newFormDraft(agency, ["auto", "home", "renters", "umbrella"])));

// Sharing: the link, and an embed that only listens to the form's own origin.
assert.equal(formUrl("https://ams.example.test", "auto-quote-abcdefghjk"), "https://ams.example.test/f/auto-quote-abcdefghjk");
const snippet = embedSnippet("https://ams.example.test", "auto-quote-abcdefghjk", `Harbor "Fixture" <Agency>`);
assert.ok(snippet.includes(`src="https://ams.example.test/f/auto-quote-abcdefghjk?embed=1"`));
assert.ok(snippet.includes(`if (event.origin !== "https://ams.example.test") return;`));
// Only its own frame is heard, so two forms on a page don't size or scroll each other.
assert.ok(snippet.includes(`event.source !== frame.contentWindow`));
// The two things a form asks of the page: its height, and to be shown.
assert.ok(snippet.includes(`"openams:form-height"`) && snippet.includes(`"openams:form-show"`));
// What is pasted runs as written: the script parses, and the frame's id is the one it looks up.
new Function(snippet.slice(snippet.indexOf("<script>") + 8, snippet.indexOf("</script>")));
assert.equal(snippet.match(/id="([^"]+)"/)![1], snippet.match(/getElementById\("([^"]+)"\)/)![1]);
assert.ok(!snippet.includes(`"Fixture"`) && !snippet.includes("<Agency>"), "the title is escaped");
assert.ok(isLoopback("127.0.0.1") && isLoopback("localhost") && !isLoopback("ams.example.test"));

// Only a hosted form page may be framed by another site; everything else still refuses.
assert.ok(isHostedFormPath("/f/auto-quote-abcdefghjk"));
// The same form at its readable address under the agency's own.
assert.ok(isHostedFormPath("/f/harbor-fixture/auto-quote"));
for (const path of ["/", "/f", "/f/", "/f/a/b/c", "/f/a/b/", "/forms", "/api/forms/auto-quote-abcdefghjk/submissions", "/sign-in/finish"])
  assert.ok(!isHostedFormPath(path), path);
assert.ok(contentSecurityPolicy("n", "production").includes("frame-ancestors 'none'"));
assert.ok(contentSecurityPolicy("n", "production", true).includes("frame-ancestors *"));
const framed = (path: string) =>
  proxy(new NextRequest(`https://ams.example.test${path}`)).headers.get("Content-Security-Policy")!;
assert.ok(framed("/f/auto-quote-abcdefghjk").includes("frame-ancestors *"));
assert.ok(framed("/").includes("frame-ancestors 'none'"));
assert.ok(framed("/api/agency/session").includes("frame-ancestors 'none'"));
// The X-Frame-Options rule in next.config.ts skips exactly the same pages.
const { default: nextConfig } = await import("../next.config");
const headerRules = await nextConfig.headers!();
const frameRule = headerRules.find((rule) => rule.headers.some((header) => header.key === "X-Frame-Options"))!;
assert.equal(frameRule.source, "/((?!f/).*)");
assert.ok(!headerRules.some((rule) => rule.source === "/:path*" && rule.headers.some((header) => header.key === "X-Frame-Options")));
const denied = new RegExp(`^${frameRule.source}$`);
assert.ok(denied.test("/") && denied.test("/forms") && denied.test("/api/agency/session"));
assert.ok(!denied.test("/f/auto-quote-abcdefghjk"));

// Text on the agency's color stays readable.
assert.equal(inkOn("#1f6f5c"), "#ffffff");
assert.equal(inkOn("#f0b429"), "#14171c");
assert.equal(inkOn("#ffffff"), "#14171c");
assert.equal(inkOn("#000000"), "#ffffff");

// Filing suggestions: the same email, phone or name, best first; never a merged-away identity.
const account = (id: string, data: Record<string, unknown>) =>
  ({ id, kind: "accounts", archivedAt: null, data: { name: "", legalName: "", email: "", phone: "", consolidation: null, ...data } }) as unknown as AmsRecord<"accounts">;
const submission = (contact: Record<string, string>, sections: unknown[] = []) =>
  ({ id: "s1", kind: "formsubmissions", data: { contact: { name: "", email: "", phone: "", businessName: "", ...contact }, sections } }) as unknown as SubmissionRecord;
const book: Book = {
  accounts: [
    account("a-name", { name: "Dana Fixture" }),
    account("a-phone", { name: "Fixture Household", phone: "555.010.0199" }),
    account("a-email", { name: "D. Fixture", email: "DANA@client.example.test" }),
    account("a-merged", { name: "Dana Fixture", email: "dana@client.example.test", consolidation: { targetId: "a-email" } }),
    account("a-other", { name: "Someone Else", email: "else@client.example.test" }),
    account("a-contact", { name: "Fixture Family Trust" }),
  ],
  contacts: [
    { id: "c1", kind: "contacts", data: { accountId: "a-contact", name: "Dana F.", email: "dana@client.example.test", phone: "", mobile: "" } } as unknown as AmsRecord<"contacts">,
  ],
};
const matches = matchingAccounts(book, submission({ name: "Dana Fixture", email: "dana@client.example.test", phone: "(555) 010-0199" }));
assert.deepEqual(matches.map((match) => match.account.id), ["a-email", "a-contact", "a-phone", "a-name"]);
assert.equal(matches[0].reason, "Same email");
// A name alone is offered but never chosen for the person filing.
assert.deepEqual(matches.map((match) => match.strong), [true, true, true, false]);
assert.match(matches[1].reason, /Contact Dana F\. has this email/);
assert.deepEqual(matchingAccounts(book, submission({ name: "Nobody Known", email: "nobody@client.example.test" })), []);
assert.equal(
  exposureSummary(submission({}, [
    { exposure: "driver", items: [{}, {}] },
    { exposure: "vehicle", items: [{}] },
    { exposure: null, items: [{}] },
  ])),
  "2 drivers, 1 vehicle",
);
const now = Date.parse("2026-11-24T18:00:00.000Z");
assert.equal(timeAgo("2026-11-24T17:59:40.000Z", now), "just now");
assert.equal(timeAgo("2026-11-24T17:15:00.000Z", now), "45 min ago");
assert.equal(timeAgo("2026-11-23T17:00:00.000Z", now), "yesterday");
assert.ok(amsFormFromCatalog(["auto"]).sections.length > 2);
console.log("hosted forms: drafts, sharing, framing and filing suggestions passed");
