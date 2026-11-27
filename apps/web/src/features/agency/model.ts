import { amsCalendarDate } from "@openams/contracts";
import type {
  AmsActor,
  AmsKind,
  AmsMember,
  AmsRecord,
  AmsCommand,
  AmsCommandResult,
  AmsPage,
} from "@openams/contracts";
export type { AmsKind, AmsRecord, AmsCommand, AmsMember };
export interface AgencySession {
  actor: AmsActor;
  workspaceName: string;
  timeZone?: string;
  certificateTemplateHashes?: string[];
  relayWorkspaceEnabled?: boolean;
  originalEmailFilingEnabled?: boolean;
  mailboxReviewEnabled?: boolean;
  /** Hosted forms are available; publishing may still be off (the public demo). */
  formsEnabled?: boolean;
  formPublishingEnabled?: boolean;
  /** Team chat and presence are available in this environment. */
  chatEnabled?: boolean;
  calendarConfigured?: boolean;
  defaultOwnerId?: string | null;
  demoAvailable?: boolean;
  demo?: {
    tenantId: string;
    startedAt: string;
    accountId: string;
    policyId: string;
    renewalId: string;
    taskId: string;
    emailId: string;
    serviceId: string;
  } | null;
  members: AmsMember[];
  readableKinds: AmsKind[];
  writableKinds: AmsKind[];
}
export type Book = Partial<Record<AmsKind, AmsRecord[]>> & {
  /** Reference context only; archived accounts stay out of active lists and pickers. */
  archivedAccounts?: AmsRecord<"accounts">[];
};
export function findAccount(book: Book, id: string | null | undefined) {
  return (book.accounts?.find((record) => record.id === id) ||
    book.archivedAccounts?.find((record) => record.id === id)) as
    | AmsRecord<"accounts">
    | undefined;
}
export const titles: Record<AmsKind, string> = {
  workspace: "Agency setup",
  accounts: "Accounts",
  contacts: "Contacts",
  exposures: "Exposures",
  policies: "Policy terms",
  policychanges: "Scheduled endorsements",
  renewals: "Renewals",
  tasks: "Tasks",
  notes: "Activity notes",
  reminders: "Reminders",
  correspondence: "Correspondence",
  services: "Service requests",
  claims: "Claims",
  documents: "Documents",
  certificates: "Certificates",
  certificateholders: "Certificate holders",
  certificatetemplates: "Certificate templates",
  invoices: "Invoices",
  payments: "Receipts & payments",
  commissions: "Direct-bill commissions",
  journals: "General ledger",
  statements: "Carrier statements",
  suggestions: "Suggestions",
  forms: "Forms",
  formsubmissions: "Form submissions",
};
export const singular: Record<AmsKind, string> = {
  workspace: "agency setup",
  accounts: "account",
  contacts: "contact",
  exposures: "exposure",
  policies: "policy term",
  policychanges: "scheduled endorsement",
  renewals: "renewal",
  tasks: "task",
  notes: "activity note",
  reminders: "reminder",
  correspondence: "filed email",
  services: "service request",
  claims: "claim",
  documents: "document",
  certificates: "certificate request",
  certificateholders: "certificate holder",
  certificatetemplates: "certificate template",
  invoices: "invoice",
  payments: "payment",
  commissions: "commission",
  journals: "journal",
  statements: "carrier statement",
  suggestions: "suggestion",
  forms: "form",
  formsubmissions: "form submission",
};
export const human = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (char) => char.toUpperCase());
export const today = (timeZone = "UTC") =>
  amsCalendarDate(new Date(), timeZone);
export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(cents / 100);
export const dateLabel = (value: unknown) =>
  typeof value === "string" && value
    ? new Date(
        value.length > 10 ? value : `${value}T12:00:00`,
      ).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
export function recordTitle(record: AmsRecord) {
  const d = record.data as Record<string, unknown>;
  return String(
    d.name ||
      d.title ||
      d.subject ||
      d.holderName ||
      d.number ||
      d.claimNumber ||
      d.reference ||
      (record.kind === "notes" ? d.body : d.description) ||
      (record.kind === "commissions"
        ? `${d.carrier} · ${human(String(d.transaction))}`
        : singular[record.kind]),
  );
}
export function recordAccount(record: AmsRecord) {
  return record.kind === "accounts"
    ? record.id
    : "accountId" in record.data
      ? record.data.accountId
      : null;
}
/** Raised on window when the API refuses a request because of the agency's access state. */
export const ACCESS_REFUSED_EVENT = "openams:access-refused";
export class AgencyRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
/**
 * Raised on window when a workspace request shows the person can't continue in this tab:
 * their session ended (401), or their membership of the agency did (403). The workspace
 * pauses background work and explains, instead of each feature retrying on its own.
 */
export const SESSION_ENDED_EVENT = "openams:session-ended";
export type SessionEndReason = "signed_out" | "access_ended";
export interface SessionEndedDetail {
  reason: SessionEndReason;
}
/** Why a refusal ends the session in this tab, or null when it doesn't. */
export function sessionEndReason(status: number, code: string): SessionEndReason | null {
  if (status === 401) return "signed_out";
  if (status === 403 && (code === "membership_inactive" || code === "agency_required"))
    return "access_ended";
  return null;
}
/** Tells the workspace a request was refused because the session ended. */
export function announceSessionEnded(reason: SessionEndReason) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SessionEndedDetail>(SESSION_ENDED_EVENT, { detail: { reason } }),
  );
}
/** A signed-in person coming back is the same one only with the same agency. */
export function sameActor(
  a: Pick<AmsActor, "userId" | "tenantId">,
  b: Pick<AmsActor, "userId" | "tenantId"> | null | undefined,
) {
  return Boolean(b) && a.userId === b!.userId && a.tenantId === b!.tenantId;
}
/**
 * After a session ended: has this person come back? Asks the workspace session directly
 * (not through request(), which would announce the ended session again).
 * "resume": the same person and agency, so this tab can carry on as it is.
 * "other_person": someone else is signed in now; nothing in this tab is theirs.
 * "waiting": still signed out, or the check couldn't tell.
 */
export type SessionRecovery = "resume" | "other_person" | "waiting";
export async function checkSessionRecovery(
  actor: Pick<AmsActor, "userId" | "tenantId">,
): Promise<SessionRecovery> {
  const response = await fetch("/api/agency/session", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return "waiting";
  const next = (await response.json().catch(() => null)) as Partial<AgencySession> | null;
  if (!next?.actor || typeof next.actor.userId !== "string") return "waiting";
  return sameActor(actor, next.actor) ? "resume" : "other_person";
}
/** Used when a refusal carries no message of its own; the API's messages take precedence. */
const STATUS_MESSAGES: Record<number, string> = {
  413: "This is more than your agency can store or send at once. Nothing was saved.",
  429: "Your agency is making too many requests right now. Wait a moment and try again.",
};
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/agency/${path}`, {
    ...init,
    cache: "no-store",
  });
  const value = await response.json().catch(() => ({}));
  // A change refused because of the agency's access state (external access control):
  // tell the hosted shell so it can explain why and offer a way to restore access.
  if (response.status === 402 && typeof value.error === "string" && value.error.startsWith("access_") && typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent(ACCESS_REFUSED_EVENT, { detail: { code: value.error, message: value.message } }),
    );
  if (!response.ok) {
    const code = value.error || value.code || "request_failed";
    const ended = sessionEndReason(response.status, code);
    if (ended) announceSessionEnded(ended);
    throw new AgencyRequestError(
      response.status,
      code,
      value.message || STATUS_MESSAGES[response.status] || value.error || "The request failed.",
    );
  }
  return value as T;
}
export async function command(input: AmsCommand) {
  return request<AmsCommandResult>("commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
export async function readArchived(
  kind: AmsKind,
  signal: AbortSignal,
): Promise<AmsRecord[]> {
  const records: AmsRecord[] = [];
  let cursor: string | null = null;
  let scanned = 0;
  do {
    const page: AmsPage<AmsRecord> = await request(
      `records/${kind}?limit=100&includeArchived=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { signal },
    );
    scanned += page.items.length;
    records.push(...page.items.filter((record) => record.archivedAt));
    cursor = page.nextCursor;
    if (scanned > 10_000)
      throw new Error(
        "This archive exceeds the current interactive limit. Use managed export; partial results have not been displayed.",
      );
  } while (cursor);
  return records;
}
export async function readBook(
  session: AgencySession,
  signal: AbortSignal,
): Promise<Book> {
  // Load every cursor page, including sparse filtered pages. Never silently
  // turn a partial page into a book total or an incomplete relation picker.
  const pairs = [];
  for (let start = 0; start < session.readableKinds.length; start += 4) {
    const batch = session.readableKinds.slice(start, start + 4);
    pairs.push(...await Promise.all(batch.map(async (kind) => {
      const records: AmsRecord[] = [];
      let cursor: string | null = null;
      do {
        const path = `records/${kind}?limit=100${kind === "accounts" ? "&includeArchived=true" : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const read = () => request<AmsPage<AmsRecord>>(path, { signal });
        const page: AmsPage<AmsRecord> = await read().catch(async (error: unknown) => {
          if (!(error instanceof AgencyRequestError) || error.status !== 503) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
          signal.throwIfAborted();
          return read();
        });
        records.push(...page.items);
        cursor = page.nextCursor;
        if (records.length > 10_000)
          throw new Error(
            `${titles[kind]} exceeds the workspace's current 10,000-record interactive limit. Use managed export; totals have not been displayed from incomplete data.`,
          );
      } while (cursor);
      return [kind, records] as const;
    })));
  }
  const book: Book = Object.fromEntries(pairs);
  if (book.accounts) {
    book.archivedAccounts = book.accounts.filter(
      (record) => record.archivedAt,
    ) as AmsRecord<"accounts">[];
    book.accounts = book.accounts.filter((record) => !record.archivedAt);
  }
  return book;
}
