import { canonicalAccountId, sameAccount } from "./account-identity-model";
import { amsPolicyStatusAt } from "@openams/contracts";
import {
  human,
  recordAccount,
  recordTitle,
  type AmsKind,
  type AmsRecord,
  type Book,
} from "./model";

export const accountRecordKinds: AmsKind[] = [
  "policies",
  "renewals",
  "tasks",
  "services",
  "contacts",
  "documents",
  "notes",
  "correspondence",
  "reminders",
  "exposures",
  "claims",
  "certificates",
  "policychanges",
  "invoices",
  "commissions",
  "payments",
  "journals",
];

export function accountWebsiteHref(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function accountBook(
  book: Book,
  accountId: string,
  readable: AmsKind[],
): Book {
  return Object.fromEntries(
    accountRecordKinds
      .filter((kind) => readable.includes(kind))
      .map((kind) => [
        kind,
        (book[kind] || []).filter(
          (record) =>
            !record.archivedAt &&
            sameAccount(book, recordAccount(record), accountId),
        ),
      ]),
  );
}

/** One pass over the book for the account directory, instead of one scan per row. */
export function groupAccountBook(book: Book, readable: AmsKind[]) {
  const grouped = new Map<string, Book>();
  for (const kind of accountRecordKinds) {
    if (!readable.includes(kind)) continue;
    for (const record of book[kind] || []) {
      const id = canonicalAccountId(book, recordAccount(record));
      if (!id || record.archivedAt) continue;
      const scoped = grouped.get(id) || {};
      (scoped[kind] ||= []).push(record);
      grouped.set(id, scoped);
    }
  }
  return grouped;
}

export const accountStatus = (record: AmsRecord, date: string) =>
  record.kind === "policies"
    ? amsPolicyStatusAt((record as AmsRecord<"policies">).data, date)
    : String(
        (record.data as Record<string, unknown>).status ||
          (record.data as Record<string, unknown>).stage ||
          "recorded",
      );

export interface AccountAttention {
  record: AmsRecord;
  title: string;
  detail: string;
  date: string | null;
  ownerId: string | null;
  urgent: boolean;
}

export function accountAttention(book: Book, date: string): AccountAttention[] {
  const items: AccountAttention[] = [];
  const renewalPolicyIds = new Set<string>();
  for (const record of (book.renewals || []) as AmsRecord<"renewals">[]) {
    const d = record.data;
    if (["renewed", "lost"].includes(d.stage)) continue;
    d.policyIds.forEach((id) => renewalPolicyIds.add(id));
    items.push({
      record,
      title: d.title,
      detail: d.nextAction || `${human(d.stage)} · Renewal`,
      date: d.followUpDate || d.expirationDate,
      ownerId: d.ownerId,
      urgent: false,
    });
  }
  for (const record of (book.tasks || []) as AmsRecord<"tasks">[]) {
    const d = record.data;
    if (d.status === "done") continue;
    items.push({
      record,
      title: d.title,
      detail: d.status === "waiting" ? "Waiting · Task" : "Task",
      date: d.dueDate,
      ownerId: d.ownerId,
      urgent: d.priority === "urgent" || d.priority === "high",
    });
  }
  for (const record of (book.services || []) as AmsRecord<"services">[]) {
    const d = record.data;
    if (d.status === "completed") continue;
    items.push({
      record,
      title: d.title,
      detail: `${human(d.type)} · Service request`,
      date: d.dueDate,
      ownerId: d.ownerId,
      urgent: false,
    });
  }
  for (const record of (book.claims || []) as AmsRecord<"claims">[]) {
    const d = record.data;
    if (d.status === "closed") continue;
    items.push({
      record,
      title: d.claimNumber || "Claim follow-up",
      detail: "Claim",
      date: d.followUpDate,
      ownerId: d.ownerId,
      urgent: false,
    });
  }
  for (const record of (book.certificates ||
    []) as AmsRecord<"certificates">[]) {
    const d = record.data;
    if (["issued", "void"].includes(d.status)) continue;
    items.push({
      record,
      title: d.holderName,
      detail: "Certificate request",
      date: null,
      ownerId: d.ownerId,
      urgent: false,
    });
  }
  for (const record of (book.policychanges ||
    []) as AmsRecord<"policychanges">[]) {
    if (record.data.status !== "scheduled") continue;
    items.push({
      record,
      title: record.data.name,
      detail: "Scheduled endorsement",
      date: record.data.change.effectiveDate,
      ownerId: null,
      urgent: false,
    });
  }
  for (const record of (book.policies || []) as AmsRecord<"policies">[]) {
    const d = record.data;
    if (!["active", "scheduled"].includes(amsPolicyStatusAt(d, date))) continue;
    const cancellation = d.cancellationDate && d.cancellationDate > date;
    const days = Math.round(
      (Date.parse(`${d.expirationDate}T00:00:00Z`) -
        Date.parse(`${date}T00:00:00Z`)) /
        86_400_000,
    );
    if (
      !cancellation &&
      !d.nonrenewal &&
      (days > 90 || renewalPolicyIds.has(record.id))
    )
      continue;
    items.push({
      record,
      title: `${d.line} · ${d.number}`,
      detail: cancellation
        ? "Cancellation scheduled"
        : d.nonrenewal
          ? "Nonrenewal notice on file"
          : "Expiration within 90 days · Plan renewal",
      date: cancellation ? d.cancellationDate : d.expirationDate,
      ownerId: d.producerId,
      urgent: Boolean(cancellation || d.nonrenewal),
    });
  }
  return items.sort(
    (a, b) =>
      (a.date || "9999").localeCompare(b.date || "9999") ||
      Number(b.urgent) - Number(a.urgent) ||
      a.title.localeCompare(b.title) ||
      a.record.id.localeCompare(b.record.id),
  );
}

export function accountSummary(book: Book, date: string) {
  const policies = (book.policies || []) as AmsRecord<"policies">[];
  const active = policies.filter(
    (record) => amsPolicyStatusAt(record.data, date) === "active",
  );
  const upcoming = policies.filter((record) =>
    ["active", "scheduled"].includes(amsPolicyStatusAt(record.data, date)),
  );
  return {
    activeCount: active.length,
    premiumCents: active.reduce(
      (total, record) => total + record.data.premiumCents,
      0,
    ),
    nextExpiration:
      upcoming.map((record) => record.data.expirationDate).sort()[0] || null,
  };
}

export function searchAccount(
  book: Book,
  query: string,
  kind: AmsKind | "all" = "all",
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return accountRecordKinds
    .filter((k) => kind === "all" || kind === k)
    .flatMap((k) => book[k] || [])
    .filter(
      (record) =>
        !record.archivedAt &&
        terms.every((term) =>
          `${human(record.kind)} ${JSON.stringify(record.data)}`
            .toLocaleLowerCase()
            .includes(term),
        ),
    )
    .sort(
      (a, b) =>
        Number(
          recordTitle(b)
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        ) -
          Number(
            recordTitle(a)
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
          ) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
}

/** Directory lookup includes contacts and policy identifiers, using only the
 * kinds this role can read. It never brings agency-level records into results. */
export function matchingAccountIds(
  book: Book,
  query: string,
  readable: AmsKind[],
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const ids = new Set<string>();
  for (const kind of ["accounts", ...accountRecordKinds] as AmsKind[]) {
    if (!readable.includes(kind)) continue;
    for (const record of book[kind] || []) {
      const id = canonicalAccountId(book, recordAccount(record));
      if (!id || record.archivedAt) continue;
      const haystack = JSON.stringify(record.data).toLocaleLowerCase();
      if (terms.every((term) => haystack.includes(term))) ids.add(id);
    }
  }
  return ids;
}
