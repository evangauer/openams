import assert from "node:assert/strict";
import {
  AMS_DATA_SCHEMAS,
  type AmsKind,
  type AmsRecord,
} from "@openams/contracts";
import {
  accountAttention,
  accountBook,
  accountSummary,
  accountWebsiteHref,
  groupAccountBook,
  matchingAccountIds,
  searchAccount,
} from "../src/features/agency/account-model";
import type { Book } from "../src/features/agency/model";

function record<K extends AmsKind>(
  kind: K,
  id: string,
  data: Record<string, unknown>,
): AmsRecord<K> {
  return {
    kind,
    id,
    data: AMS_DATA_SCHEMAS[kind].parse(data),
    version: "a".repeat(64),
    revision: 1,
    createdAt: "2026-11-01T12:00:00Z",
    updatedAt: "2026-11-01T12:00:00Z",
    createdBy: "admin",
    updatedBy: "admin",
    archivedAt: null,
  } as AmsRecord<K>;
}
const policy = (id: string, overrides: Record<string, unknown> = {}) =>
  record("policies", id, {
    accountId: "northstar",
    number: id,
    line: "General liability",
    carrier: "Example Mutual",
    effectiveDate: "2026-01-01",
    expirationDate: "2026-12-15",
    status: "active",
    premiumCents: 1250000,
    ...overrides,
  });
const book: Book = {
  accounts: [
    record("accounts", "northstar", { name: "Northstar Fabrication" }),
    record("accounts", "unrelated", { name: "Other account" }),
  ],
  policies: [
    policy("current"),
    policy("draft", { status: "draft", premiumCents: 9999999 }),
    policy("future", {
      effectiveDate: "2027-01-01",
      expirationDate: "2028-01-01",
    }),
    policy("expired", { expirationDate: "2026-11-06" }),
    policy("cancelled", { cancellationDate: "2026-11-05" }),
    policy("other", { accountId: "unrelated" }),
  ],
  contacts: [
    record("contacts", "person", {
      accountId: "northstar",
      name: "Jordan Ellis",
      email: "jordan@example.test",
    }),
    {
      ...record("contacts", "archived-person", {
        accountId: "northstar",
        name: "Archived Person",
      }),
      archivedAt: "2026-11-05T12:00:00Z",
    },
  ],
  tasks: [
    record("tasks", "open", {
      accountId: "northstar",
      title: "Payroll follow-up",
      dueDate: "2026-11-06",
    }),
    record("tasks", "done", {
      accountId: "northstar",
      title: "Finished follow-up",
      dueDate: "2026-11-01",
      status: "done",
    }),
    record("tasks", "agency", {
      title: "Agency-only work",
      dueDate: "2026-11-01",
    }),
    record("tasks", "other-task", {
      accountId: "unrelated",
      title: "Other account work",
      dueDate: "2026-11-01",
    }),
  ],
  notes: [
    record("notes", "note", {
      accountId: "northstar",
      body: "Payroll confirmed by Jordan",
      category: "call",
      occurredAt: "2026-11-05T12:00:00Z",
    }),
  ],
  invoices: [
    record("invoices", "finance", {
      accountId: "northstar",
      number: "FINANCE-PRIVATE",
      policyId: "current",
      issueDate: "2026-11-01",
      dueDate: "2026-12-01",
      lines: [{ type: "premium", description: "Fixture", amountCents: 100 }],
    }),
  ],
};
const readable: AmsKind[] = [
  "accounts",
  "contacts",
  "policies",
  "tasks",
  "notes",
  "renewals",
  "services",
  "claims",
  "certificates",
  "policychanges",
];
assert.equal(
  accountWebsiteHref("https://example.test/contact"),
  "https://example.test/contact",
);
assert.equal(accountWebsiteHref("javascript:alert(1)"), null);
assert.equal(accountWebsiteHref("data:text/html,example"), null);
assert.equal(accountWebsiteHref("not a URL"), null);
const scoped = accountBook(book, "northstar", readable);
assert.equal(scoped.policies?.length, 5);
assert.deepEqual(
  scoped.contacts?.map((row) => row.id),
  ["person"],
);
assert.equal(
  scoped.invoices,
  undefined,
  "Never project unreadable financial data even if supplied in the book",
);
assert.equal(
  scoped.tasks?.length,
  2,
  "Exclude agency-level and other-account tasks",
);
assert.deepEqual(accountSummary(scoped, "2026-11-06"), {
  activeCount: 1,
  premiumCents: 1250000,
  nextExpiration: "2026-12-15",
});
assert.equal(
  accountSummary(scoped, "2026-12-15").activeCount,
  0,
  "A term expires on its expiration calendar date",
);
assert.equal(
  accountSummary(scoped, "2027-01-01").activeCount,
  1,
  "Future terms activate on their effective calendar date",
);
assert.deepEqual(
  accountAttention(scoped, "2026-11-06").map((item) => item.record.id),
  ["open", "current"],
);

const withRenewal: Book = {
  ...scoped,
  renewals: [
    record("renewals", "renewal", {
      accountId: "northstar",
      title: "Renewal review",
      policyIds: ["current"],
      expirationDate: "2026-12-15",
      followUpDate: "2026-11-05",
    }),
  ],
};
assert.deepEqual(
  accountAttention(withRenewal, "2026-11-06").map((item) => item.record.id),
  ["renewal", "open"],
  "A tracked renewal replaces the synthetic expiration reminder",
);
const notices: Book = {
  policies: [
    policy("notice", {
      nonrenewal: {
        noticeDate: "2026-11-01",
        reason: "Fixture reason",
        sourceReference: "Fixture notice",
      },
    }),
    policy("scheduled-cancel", { cancellationDate: "2026-11-10" }),
  ],
  renewals: withRenewal.renewals,
};
assert.deepEqual(
  accountAttention(notices, "2026-11-06").map((item) => item.detail),
  ["Review · Renewal", "Cancellation scheduled", "Nonrenewal notice on file"],
);
assert.equal(accountAttention(notices, "2026-11-06")[1].urgent, true);
const certificate = record("certificates", "cert", {
  accountId: "northstar",
  holderName: "Warehouse owner",
  policyIds: ["current"],
  requestedDate: "2026-11-01",
  ownerId: "admin",
});
const certificates = accountAttention(
  { certificates: [certificate] },
  "2026-11-06",
);
assert.equal(certificates[0].date, null, "A requested date is not a due date");
assert.equal(certificates[0].ownerId, "admin");
assert.deepEqual(
  searchAccount(scoped, "JORDAN")
    .map((row) => row.id)
    .sort(),
  ["note", "person"],
);
assert.deepEqual(
  searchAccount(scoped, "Jordan", "contacts").map((row) => row.id),
  ["person"],
);
assert.equal(
  searchAccount(scoped, "General Mutual").length,
  5,
  "Search across policy fields with multiple terms",
);
assert.equal(searchAccount(scoped, "other account").length, 0);
assert.deepEqual(
  [...matchingAccountIds(book, "jordan@example.test", readable)],
  ["northstar"],
);
assert.equal(matchingAccountIds(book, "FINANCE-PRIVATE", readable).size, 0);
assert.equal(matchingAccountIds(book, "Agency-only", readable).size, 0);
assert.equal(matchingAccountIds(book, "Archived Person", readable).size, 0);
const grouped = groupAccountBook(book, readable);
assert.deepEqual(
  Object.values(grouped.get("northstar") || {})
    .flat()
    .map((row) => row.id)
    .sort(),
  Object.values(scoped)
    .flat()
    .map((row) => row.id)
    .sort(),
);
assert.equal(grouped.get("unrelated")?.tasks?.length, 1);
assert.equal(grouped.has("agency"), false);
console.log(
  "PASS account scope, role filtering, calendar-aware coverage, attention queue, renewal deduplication, notices, directory lookup and account search",
);
