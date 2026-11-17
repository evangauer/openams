import { z } from "zod";
import { accountIdentities, sameAccount } from "./account-identity-model";
import type { AmsRecord, Book } from "./model";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const leadSchema = z.object({
  id,
  accountId: id.nullable().optional(),
  business: z
    .object({ name: z.string().optional(), dba: z.string().optional() })
    .optional(),
  applicant: z
    .object({
      fullName: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
    })
    .optional(),
  intake: z.object({ subject: z.string().optional() }).optional(),
  stage: z.string(),
  quotePackage: z
    .object({ status: z.string(), carrierNames: z.array(z.string()) })
    .optional(),
});
const messageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  subject: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  bodyPreview: z.string().nullable(),
  body: z.string().nullable(),
  messageAt: z.string().nullable(),
  sendStatus: z.string().nullable(),
  attachmentCount: z.number().int().min(0),
});
export type AccountRelayMessage = z.infer<typeof messageSchema>;
export type AccountRelayWork = z.infer<typeof leadSchema>;
export type RelayWorkResult = {
  id: string;
  work: AccountRelayWork | null;
  state: "ready" | "restricted" | "unavailable" | "moved";
};

export function accountRelayReferences(book: Book, accountId: string) {
  const identities = accountIdentities(book, accountId);
  return {
    accountIds: identities.map((row) => row.id),
    leadIds: [
      ...new Set([
        ...identities.flatMap((row) => row.data.leadIds),
        ...((book.renewals ?? []) as AmsRecord<"renewals">[])
          .filter(
            (row) =>
              !row.archivedAt &&
              sameAccount(book, accountId, row.data.accountId),
          )
          .flatMap((row) => row.data.quoteLeadIds),
      ]),
    ]
      .filter((value) => id.safeParse(value).success)
      .sort(),
  };
}

/** Existing lead routes remain authoritative for entitlement and private-mailbox access. */
export async function loadAccountRelayWork(
  leadId: string,
  accountIds: string[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<RelayWorkResult> {
  const response = await fetcher(
    `/api/leads/${encodeURIComponent(leadId)}?board=true`,
    { signal, cache: "no-store" },
  );
  if (!response.ok)
    return {
      id: leadId,
      work: null,
      state: [401, 403, 404].includes(response.status)
        ? "restricted"
        : "unavailable",
    };
  const parsed = leadSchema.safeParse((await response.json()).lead);
  if (!parsed.success) return { id: leadId, work: null, state: "unavailable" };
  if (
    parsed.data.id !== leadId ||
    !parsed.data.accountId ||
    !accountIds.includes(parsed.data.accountId)
  )
    return { id: leadId, work: null, state: "moved" };
  return { id: leadId, work: parsed.data, state: "ready" };
}

export async function loadAccountRelayConversation(
  leadId: string,
  accountIds: string[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  // Recheck the current account association and permissions when opening a thread.
  const current = await loadAccountRelayWork(
    leadId,
    accountIds,
    signal,
    fetcher,
  );
  if (!current.work)
    throw new Error(
      "This work is no longer available on this account. Refresh the linked work list.",
    );
  const response = await fetcher(
    `/api/leads/${encodeURIComponent(leadId)}/communications?bodies=10`,
    { signal, cache: "no-store" },
  );
  if (!response.ok)
    throw new Error(
      [401, 403, 404].includes(response.status)
        ? "This conversation is unavailable with your current Relay access."
        : "The conversation could not be loaded. Try again.",
    );
  const parsed = z
    .object({
      thread: z
        .object({
          messages: z.array(messageSchema),
          awaitingReply: z.boolean(),
        })
        .nullable(),
    })
    .safeParse(await response.json());
  if (!parsed.success || !parsed.data.thread)
    throw new Error(
      "Captured conversation history is unavailable for this work.",
    );
  const messages = [
    ...new Map(
      parsed.data.thread.messages.map((message) => [message.id, message]),
    ).values(),
  ].sort((a, b) => (b.messageAt ?? "").localeCompare(a.messageAt ?? ""));
  return {
    messages: messages.slice(0, 50),
    awaitingReply: parsed.data.thread.awaitingReply,
    more: messages.length > 50,
  };
}
