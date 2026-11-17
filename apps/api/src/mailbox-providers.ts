import { z } from "zod";
import { AmsError } from "./repository.js";

export type MailboxProvider = "gmail" | "microsoft365";
export const MAILBOX_MESSAGE_LIMIT = 20 * 1024 * 1024;
const PAGE_SIZE = 25;
const opaqueId = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\s\x00-\x1f\x7f]+$/);
const pageToken = z.string().min(1).max(16_384);
const historyId = z.string().regex(/^\d{1,40}$/);
const timestamp = z.string().datetime({ offset: true });
export const MailboxCursorSchema = z.discriminatedUnion("phase", [
  z
    .object({
      provider: z.literal("gmail"),
      phase: z.literal("listing"),
      anchor: historyId,
      page: pageToken.optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("gmail"),
      phase: z.literal("history"),
      anchor: historyId,
      page: pageToken.optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("microsoft365"),
      phase: z.literal("delta"),
      url: pageToken,
    })
    .strict(),
]);
export type MailboxCursor = z.infer<typeof MailboxCursorSchema>;
export type MailboxSelection = { folderId: string; since: string };
export type MailboxRemotePage = {
  messageIds: string[];
  cursor: MailboxCursor;
  /** False means the initial listing/change round has been completely consumed. */
  more: boolean;
};
export type MailboxFolder = { id: string; name: string; hasChildren: boolean };
export type MailboxFolderPage = {
  folders: MailboxFolder[];
  next: string | null;
};
export type MailboxOriginal = {
  bytes: Buffer;
  receivedAt: string;
  direction: "inbound" | "outbound" | "unknown";
};
export interface MailboxClient {
  identity(): Promise<{ address: string; remoteId: string }>;
  folders(input?: {
    parentId?: string;
    next?: string;
  }): Promise<MailboxFolderPage>;
  folder(id: string): Promise<MailboxFolder>;
  page(
    selection: MailboxSelection,
    cursor?: MailboxCursor | null,
  ): Promise<MailboxRemotePage>;
  /** Null: removed, draft, outside the selected folder, or older than the chosen start. */
  original(
    id: string,
    selection: MailboxSelection,
  ): Promise<MailboxOriginal | null>;
}

export class MailboxProviderError extends AmsError {
  constructor(
    code: string,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(code === "mailbox_throttled" ? 429 : 502, code, message);
  }
}
const invalidResponse = () =>
  new MailboxProviderError(
    "mailbox_response_invalid",
    "The mailbox provider returned an unexpected response. Retry syncing or reconnect the mailbox.",
  );
const resetRequired = () =>
  new MailboxProviderError(
    "mailbox_sync_reset",
    "The mailbox change history has expired. Restart sync to check the selected folder again; retained messages will not be erased.",
  );
function checked<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const value = schema.safeParse(input);
  if (!value.success) throw invalidResponse();
  return value.data;
}
function idPath(id: string) {
  if (id === "." || id === "..") throw invalidResponse();
  return encodeURIComponent(checked(opaqueId, id)).replaceAll("'", "%27");
}
function selection(input: MailboxSelection) {
  return checked(
    z.object({ folderId: opaqueId, since: timestamp }).strict(),
    input,
  );
}
async function readBounded(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) {
    await response.body?.cancel();
    throw new MailboxProviderError(
      "mailbox_message_too_large",
      "The mailbox response exceeds the supported size. Review large messages in the mailbox.",
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new MailboxProviderError(
          "mailbox_message_too_large",
          "The mailbox response exceeds the supported size. Review large messages in the mailbox.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** Only fixed provider origins receive bearer credentials. Redirects are never followed. */
class ProviderHttp {
  constructor(
    private provider: MailboxProvider,
    private token: string,
    private fetcher: typeof fetch,
    private signal?: AbortSignal,
  ) {}
  async get(url: string, maximum = 4 * 1024 * 1024): Promise<Buffer> {
    const parsed = new URL(url);
    const origin =
      this.provider === "gmail"
        ? "https://gmail.googleapis.com"
        : "https://graph.microsoft.com";
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      throw invalidResponse();
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(this.provider === "microsoft365"
            ? { Prefer: `IdType="ImmutableId", odata.maxpagesize=${PAGE_SIZE}` }
            : {}),
        },
        redirect: "error",
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        // Never expose provider bodies, URLs, tokens, or message content in errors/logs.
        let code = "";
        let reasons: string[] = [];
        try {
          const error = JSON.parse(
            (await readBounded(response, 64 * 1024)).toString("utf8"),
          )?.error;
          code = typeof error?.code === "string" ? error.code : "";
          reasons = Array.isArray(error?.errors)
            ? error.errors
                .map((e: { reason?: string }) => e.reason)
                .filter((r: unknown): r is string => typeof r === "string")
            : [];
        } catch {
          /* Status alone is enough for safe classification. */
        }
        if (
          response.status === 429 ||
          reasons.some((r) =>
            [
              "rateLimitExceeded",
              "userRateLimitExceeded",
              "dailyLimitExceeded",
            ].includes(r),
          )
        ) {
          const retry = response.headers.get("retry-after");
          const seconds =
            retry && /^\d+$/.test(retry)
              ? Number(retry)
              : retry
                ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
                : 60;
          throw new MailboxProviderError(
            "mailbox_throttled",
            "The mailbox provider is limiting requests. Sync can resume after the retry delay.",
            Number.isFinite(seconds)
              ? Math.min(86_400, Math.max(1, seconds))
              : 60,
          );
        }
        if (response.status === 401 || response.status === 403)
          throw new MailboxProviderError(
            "mailbox_reconnect_required",
            "Mailbox access was denied. Reconnect with read permission for this mailbox.",
          );
        if (response.status === 404)
          throw new MailboxProviderError(
            "mailbox_not_found",
            "The mailbox item is no longer available.",
          );
        if (
          response.status === 410 ||
          [
            "syncStateNotFound",
            "SyncStateNotFound",
            "InvalidDeltaToken",
            "ErrorInvalidSyncStateData",
          ].includes(code)
        )
          throw resetRequired();
        throw new MailboxProviderError(
          "mailbox_unavailable",
          "The mailbox provider could not complete the request. Retry syncing later.",
        );
      }
      return await readBounded(response, maximum);
    } catch (error) {
      if (error instanceof MailboxProviderError) throw error;
      throw new MailboxProviderError(
        "mailbox_unavailable",
        "The mailbox request was interrupted. Sync can retry from its saved position.",
      );
    }
  }
  async json<S extends z.ZodType>(
    url: string,
    schema: S,
    maximum?: number,
  ): Promise<z.infer<S>> {
    const bytes = await this.get(url, maximum);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw invalidResponse();
    }
    return checked(schema, value);
  }
}

const gmailRoot = "https://gmail.googleapis.com/gmail/v1/users/me";
const googleProfile = z.object({
  emailAddress: z.string().email().max(320),
  historyId,
});
const remoteMessage = z.object({ id: opaqueId });
const googleHistory = z.object({
  historyId,
  nextPageToken: pageToken.optional(),
  history: z
    .array(
      z.object({
        messagesAdded: z
          .array(z.object({ message: remoteMessage }))
          .max(1000)
          .optional(),
        labelsAdded: z
          .array(
            z.object({
              message: remoteMessage,
              labelIds: z.array(opaqueId).max(1000),
            }),
          )
          .max(1000)
          .optional(),
      }),
    )
    .max(500)
    .optional(),
});
class GmailMailbox implements MailboxClient {
  constructor(private http: ProviderHttp) {}
  async identity() {
    const profile = await this.http.json(`${gmailRoot}/profile`, googleProfile);
    return {
      address: profile.emailAddress,
      remoteId: profile.emailAddress.toLowerCase(),
    };
  }
  async folders(input: { parentId?: string; next?: string } = {}) {
    if (input.parentId || input.next) throw invalidResponse();
    const result = await this.http.json(
      `${gmailRoot}/labels`,
      z.object({
        labels: z
          .array(z.object({ id: opaqueId, name: z.string().max(1000) }))
          .max(10_000),
      }),
    );
    return {
      folders: result.labels
        .filter(
          (l) =>
            ![
              "DRAFT",
              "TRASH",
              "SPAM",
              "SENT",
              "UNREAD",
              "STARRED",
              "IMPORTANT",
              "CHAT",
            ].includes(l.id),
        )
        .map((l) => ({ ...l, hasChildren: false })),
      next: null,
    };
  }
  async folder(id: string) {
    if (
      [
        "DRAFT",
        "TRASH",
        "SPAM",
        "SENT",
        "UNREAD",
        "STARRED",
        "IMPORTANT",
        "CHAT",
      ].includes(id)
    )
      throw new AmsError(
        422,
        "mailbox_folder_unavailable",
        "Choose an inbox or an agency label for carrier updates.",
      );
    const folder = await this.http.json(
      `${gmailRoot}/labels/${idPath(id)}`,
      z.object({ id: opaqueId, name: z.string().min(1).max(1000) }),
    );
    if (folder.id !== id) throw invalidResponse();
    return { ...folder, hasChildren: false };
  }
  async page(
    input: MailboxSelection,
    current?: MailboxCursor | null,
  ): Promise<MailboxRemotePage> {
    const selected = selection(input);
    let cursor = current ? checked(MailboxCursorSchema, current) : null;
    if (cursor && cursor.provider !== "gmail") throw invalidResponse();
    // Anchor BEFORE the initial listing so arrivals during pagination are recovered by history.
    if (!cursor)
      cursor = {
        provider: "gmail",
        phase: "listing",
        anchor: (await this.http.json(`${gmailRoot}/profile`, googleProfile))
          .historyId,
      };
    const query = new URLSearchParams({ maxResults: String(PAGE_SIZE) });
    if (cursor.page) query.set("pageToken", cursor.page);
    if (cursor.phase === "listing") {
      query.set("labelIds", selected.folderId);
      // Gmail's after boundary is exclusive. Fetch one overlapping second and
      // apply the exact inclusive cutoff to internalDate before retaining MIME.
      query.set(
        "q",
        `after:${Math.floor(Date.parse(selected.since) / 1000) - 1}`,
      );
      query.set("includeSpamTrash", "false");
      const result = await this.http.json(
        `${gmailRoot}/messages?${query}`,
        z.object({
          messages: z.array(remoteMessage).max(500).optional(),
          nextPageToken: pageToken.optional(),
        }),
      );
      if (result.nextPageToken && result.nextPageToken === cursor.page)
        throw invalidResponse();
      return {
        messageIds: [...new Set((result.messages ?? []).map((m) => m.id))],
        cursor: result.nextPageToken
          ? { ...cursor, page: result.nextPageToken }
          : { provider: "gmail", phase: "history", anchor: cursor.anchor },
        // Always drain changes since the pre-listing anchor, even when the folder was empty.
        more: true,
      };
    }
    query.set("startHistoryId", cursor.anchor);
    query.set("labelId", selected.folderId);
    query.append("historyTypes", "messageAdded");
    query.append("historyTypes", "labelAdded");
    let result: z.infer<typeof googleHistory>;
    try {
      result = await this.http.json(
        `${gmailRoot}/history?${query}`,
        googleHistory,
      );
    } catch (error) {
      if (
        error instanceof MailboxProviderError &&
        error.code === "mailbox_not_found"
      )
        throw resetRequired();
      throw error;
    }
    const messageIds = new Set<string>();
    if (result.nextPageToken && result.nextPageToken === cursor.page)
      throw invalidResponse();
    for (const change of result.history ?? []) {
      for (const added of change.messagesAdded ?? [])
        messageIds.add(added.message.id);
      for (const added of change.labelsAdded ?? [])
        if (added.labelIds.includes(selected.folderId))
          messageIds.add(added.message.id);
    }
    if (messageIds.size > 2000) throw invalidResponse();
    return {
      messageIds: [...messageIds],
      cursor: result.nextPageToken
        ? { ...cursor, page: result.nextPageToken }
        : { provider: "gmail", phase: "history", anchor: result.historyId },
      more: Boolean(result.nextPageToken),
    };
  }
  async original(
    id: string,
    input: MailboxSelection,
  ): Promise<MailboxOriginal | null> {
    const selected = selection(input);
    let mail;
    try {
      mail = await this.http.json(
        `${gmailRoot}/messages/${idPath(id)}?format=raw`,
        z.object({
          id: opaqueId,
          labelIds: z.array(opaqueId).max(10_000),
          internalDate: z.string().regex(/^\d{1,16}$/),
          raw: z
            .string()
            .max(Math.ceil(MAILBOX_MESSAGE_LIMIT * 1.4))
            .regex(/^[A-Za-z0-9_-]+={0,2}$/),
        }),
        Math.ceil(MAILBOX_MESSAGE_LIMIT * 1.4),
      );
    } catch (error) {
      if (
        error instanceof MailboxProviderError &&
        error.code === "mailbox_not_found"
      )
        return null;
      throw error;
    }
    if (mail.id !== id) throw invalidResponse();
    if (
      !mail.labelIds.includes(selected.folderId) ||
      mail.labelIds.some((l) => ["DRAFT", "TRASH", "SPAM"].includes(l))
    )
      return null;
    const received = new Date(Number(mail.internalDate));
    if (!Number.isFinite(received.getTime())) throw invalidResponse();
    if (received.getTime() < Date.parse(selected.since)) return null;
    const bytes = Buffer.from(mail.raw, "base64url");
    if (bytes.toString("base64url") !== mail.raw.replace(/=+$/, ""))
      throw invalidResponse();
    if (!bytes.length || bytes.length > MAILBOX_MESSAGE_LIMIT)
      throw new MailboxProviderError(
        "mailbox_message_too_large",
        "This message exceeds the supported 20 MB size. Review it in the mailbox.",
      );
    return {
      bytes,
      receivedAt: received.toISOString(),
      direction: mail.labelIds.includes("SENT") ? "outbound" : "inbound",
    };
  }
}

const graphRoot = "https://graph.microsoft.com/v1.0/me";
/** Follow opaque pagination tokens, but never an arbitrary host, user or resource path. */
function graphLink(raw: string, path: string) {
  checked(pageToken, raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidResponse();
  }
  if (
    url.origin !== "https://graph.microsoft.com" ||
    url.username ||
    url.password ||
    url.hash ||
    graphPath(url.pathname) !== graphPath(path)
  )
    throw invalidResponse();
  return url.toString();
}
function graphPath(path: string) {
  if (/^\/v1\.0\/me\/mailfolders$/i.test(path)) return "folders";
  // Graph documents both /mailFolders/id and /mailfolders('id') next links.
  // Folder IDs remain case-sensitive; only the fixed resource names are normalized.
  const match =
    /^\/v1\.0\/me\/mailfolders(?:\/([^/]+)|\('((?:[^']|'')+)'\))(\/(?:messages\/delta|childfolders))$/i.exec(
      path,
    );
  if (!match) throw invalidResponse();
  try {
    return JSON.stringify([
      decodeURIComponent(match[1] ?? match[2]!.replaceAll("''", "'")),
      match[3]!.toLowerCase(),
    ]);
  } catch {
    throw invalidResponse();
  }
}
class MicrosoftMailbox implements MailboxClient {
  constructor(private http: ProviderHttp) {}
  async identity() {
    const profile = await this.http.json(
      `${graphRoot}?$select=id,mail,userPrincipalName`,
      z.object({
        id: opaqueId,
        mail: z.string().email().nullable().optional(),
        userPrincipalName: z.string().email(),
      }),
    );
    return {
      address: profile.mail || profile.userPrincipalName,
      remoteId: profile.id,
    };
  }
  async folders(
    input: { parentId?: string; next?: string } = {},
  ): Promise<MailboxFolderPage> {
    const path = `/v1.0/me/mailFolders${input.parentId ? `/${idPath(input.parentId)}/childFolders` : ""}`;
    const url = input.next
      ? graphLink(input.next, path)
      : `https://graph.microsoft.com${path}?$select=id,displayName,childFolderCount&$top=100`;
    const result = await this.http.json(
      url,
      z.object({
        value: z
          .array(
            z.object({
              id: opaqueId,
              displayName: z.string().max(1000),
              childFolderCount: z.number().int().nonnegative(),
            }),
          )
          .max(1000),
        "@odata.nextLink": pageToken.optional(),
      }),
    );
    return {
      folders: result.value.map((f) => ({
        id: f.id,
        name: f.displayName,
        hasChildren: f.childFolderCount > 0,
      })),
      next: result["@odata.nextLink"]
        ? graphLink(result["@odata.nextLink"], path)
        : null,
    };
  }
  async folder(id: string) {
    const folder = await this.http.json(
      `${graphRoot}/mailFolders/${idPath(id)}?$select=id,displayName,childFolderCount`,
      z.object({
        id: opaqueId,
        displayName: z.string().min(1).max(1000),
        childFolderCount: z.number().int().nonnegative(),
      }),
    );
    if (folder.id !== id) throw invalidResponse();
    return {
      id: folder.id,
      name: folder.displayName,
      hasChildren: folder.childFolderCount > 0,
    };
  }
  async page(
    input: MailboxSelection,
    current?: MailboxCursor | null,
  ): Promise<MailboxRemotePage> {
    const selected = selection(input);
    const cursor = current ? checked(MailboxCursorSchema, current) : null;
    if (cursor && cursor.provider !== "microsoft365") throw invalidResponse();
    const path = `/v1.0/me/mailFolders/${idPath(selected.folderId)}/messages/delta`;
    // Enumerate metadata without a date filter; filter MIME downloads locally. This
    // avoids Graph's filtered-delta result limits silently truncating a large folder.
    const url = cursor
      ? graphLink(cursor.url, path)
      : `https://graph.microsoft.com${path}?$select=id,isDraft,receivedDateTime&$top=${PAGE_SIZE}`;
    const result = await this.http.json(
      url,
      z.object({
        value: z
          .array(
            z.object({
              id: opaqueId,
              isDraft: z.boolean().optional(),
              receivedDateTime: timestamp.optional(),
              "@removed": z.object({ reason: z.string() }).optional(),
            }),
          )
          .max(1000),
        "@odata.nextLink": pageToken.optional(),
        "@odata.deltaLink": pageToken.optional(),
      }),
    );
    const next = result["@odata.nextLink"],
      delta = result["@odata.deltaLink"];
    if ((!next && !delta) || (next && delta)) throw invalidResponse();
    if (next && cursor && graphLink(next, path) === graphLink(cursor.url, path))
      throw invalidResponse();
    return {
      messageIds: [
        ...new Set(
          result.value
            .filter(
              (m) =>
                !m["@removed"] &&
                !m.isDraft &&
                (!m.receivedDateTime ||
                  Date.parse(m.receivedDateTime) >= Date.parse(selected.since)),
            )
            .map((m) => m.id),
        ),
      ],
      cursor: {
        provider: "microsoft365",
        phase: "delta",
        url: graphLink((next || delta)!, path),
      },
      more: Boolean(next),
    };
  }
  async original(
    id: string,
    input: MailboxSelection,
  ): Promise<MailboxOriginal | null> {
    const selected = selection(input);
    try {
      const url = `${graphRoot}/messages/${idPath(id)}`;
      const meta = await this.http.json(
        `${url}?$select=id,parentFolderId,isDraft,receivedDateTime`,
        z.object({
          id: opaqueId,
          parentFolderId: opaqueId,
          isDraft: z.boolean(),
          receivedDateTime: timestamp,
        }),
      );
      if (meta.id !== id) throw invalidResponse();
      if (
        meta.isDraft ||
        meta.parentFolderId !== selected.folderId ||
        Date.parse(meta.receivedDateTime) < Date.parse(selected.since)
      )
        return null;
      const bytes = await this.http.get(`${url}/$value`, MAILBOX_MESSAGE_LIMIT);
      if (!bytes.length) throw invalidResponse();
      return {
        bytes,
        receivedAt: new Date(meta.receivedDateTime).toISOString(),
        direction: "unknown",
      };
    } catch (error) {
      if (
        error instanceof MailboxProviderError &&
        error.code === "mailbox_not_found"
      )
        return null;
      throw error;
    }
  }
}

/** Access tokens are supplied by the server credential store, never by record data. */
export function createMailboxClient(
  provider: MailboxProvider,
  accessToken: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): MailboxClient {
  if (provider !== "gmail" && provider !== "microsoft365")
    throw invalidResponse();
  if (!accessToken || accessToken.length > 32_000 || /[\r\n]/.test(accessToken))
    throw new MailboxProviderError(
      "mailbox_reconnect_required",
      "Reconnect the mailbox to restore read access.",
    );
  const http = new ProviderHttp(
    provider,
    accessToken,
    options.fetcher ?? fetch,
    options.signal,
  );
  return provider === "gmail"
    ? new GmailMailbox(http)
    : new MicrosoftMailbox(http);
}
