import { randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";
import { z } from "zod";
import {
  AmsId,
  amsCanWrite,
  type AmsActor,
  type AmsMember,
  type AmsMailbox,
  type AmsIncomingMessage,
} from "@openams/contracts";
import { AmsError, digest, type AmsRepository } from "./repository.js";
import { fileHash, type AmsFiles } from "./files.js";
import type { AmsService } from "./service.js";
import { EmailFilingInput, fileOriginalEmail } from "./correspondence.js";
import { emailPreview } from "./email-preview.js";
import {
  createMailboxClient,
  MailboxProviderError,
  type MailboxClient,
  type MailboxProvider,
} from "./mailbox-providers.js";
import { MailboxVault } from "./mailbox-credentials.js";
import type { MailboxOAuth } from "./mailbox-oauth.js";
import type {
  MailboxConnection,
  MailboxEvent,
  MailboxMessage,
  MailboxPage,
  MailboxStore,
} from "./mailbox-store.js";

type Dependencies = {
  store: MailboxStore;
  files: AmsFiles;
  repository: AmsRepository;
  service: () => AmsService;
  members: (tenantId: string) => Promise<AmsMember[]>;
  vault?: MailboxVault;
  oauth?: Pick<MailboxOAuth, "configured" | "begin" | "exchange" | "refresh">;
  client?: typeof createMailboxClient;
  now?: () => Date;
};
type Driver = {
  connection: MailboxConnection;
  client: MailboxClient;
  save: (
    patch: Partial<MailboxConnection>,
    message?: MailboxMessage,
  ) => Promise<void>;
};
const changed = () =>
  new AmsError(
    409,
    "mailbox_changed",
    "This mailbox item changed. Refresh before trying again.",
  );
const unavailable = () =>
  new AmsError(
    409,
    "mailbox_disconnected",
    "Connect this mailbox before syncing or choosing a folder.",
  );
const invalidCallback = () =>
  new AmsError(
    400,
    "mailbox_authorization_invalid",
    "This mailbox authorization expired or belongs to another session. Start connecting again.",
  );
const safeError = (error: unknown) =>
  error instanceof AmsError
    ? { code: error.code, message: error.message.slice(0, 500) }
    : {
        code: "mailbox_sync_failed",
        message:
          "The mailbox operation was interrupted. Retry from its saved position.",
      };
const event = (
  actor: AmsActor,
  connectionId: string,
  at: string,
  action: MailboxEvent["action"],
  detail: string,
  messageId: string | null = null,
): MailboxEvent => ({
  id: randomUUID(),
  revision: 1,
  connectionId,
  messageId,
  at,
  actorId: actor.userId,
  action,
  detail,
});

/** Public projections are explicit: never serialize credentials, sync cursors or storage keys. */
export function publicMailbox(
  connection: MailboxConnection,
  now = new Date(),
): AmsMailbox {
  return {
    id: connection.id,
    revision: connection.revision,
    provider: connection.provider,
    address: connection.address,
    state: connection.state,
    folder: connection.folder,
    hasMore: connection.hasMore || Boolean(connection.pending),
    syncing: Boolean(
      connection.lease && Date.parse(connection.lease.until) > now.getTime(),
    ),
    lastAttemptAt: connection.lastAttemptAt,
    lastSyncedAt: connection.lastSyncedAt,
    nextAttemptAt: connection.nextAttemptAt,
    error: connection.error,
  };
}
export function publicMailboxMessage(
  message: MailboxMessage,
): AmsIncomingMessage {
  return {
    id: message.id,
    revision: message.revision,
    connectionId: message.connectionId,
    queuedAt: message.queuedAt,
    receivedAt: message.receivedAt,
    status: message.status,
    subject: message.subject,
    from: message.from,
    to: message.to,
    body: message.body,
    bodyTruncated: message.bodyTruncated,
    attachmentCount: message.attachmentCount,
    direction: message.direction,
    originalAvailable: Boolean(message.original),
    bytes: message.original?.bytes ?? null,
    accountId: message.filing?.accountId ?? null,
    policyId: message.filing?.policyId ?? null,
    correspondenceId: message.correspondenceId,
    reviewedBy: message.reviewedBy,
    reviewedAt: message.reviewedAt,
    reviewReason: message.reviewReason,
    error: message.error,
  };
}

export class Mailboxes {
  constructor(private deps: Dependencies) {}
  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private async authorize(actor: AmsActor, manage = false) {
    if (
      !amsCanWrite(actor.role, "correspondence") ||
      (manage && !["admin", "manager"].includes(actor.role))
    )
      throw new AmsError(
        403,
        "permission_denied",
        manage
          ? "Only agency administrators and managers can connect or configure mailboxes."
          : "Your role cannot review incoming mailbox messages.",
      );
    const members = await this.deps.members(actor.tenantId);
    if (
      !members.some(
        (m) => m.id === actor.userId && m.active && m.role === actor.role,
      )
    )
      throw new AmsError(
        403,
        "permission_denied",
        "Active agency membership is required.",
      );
  }
  private async connection(actor: AmsActor, id: string) {
    const connection = await this.deps.store.get(
      actor.tenantId,
      "connections",
      AmsId.parse(id),
    );
    if (!connection)
      throw new AmsError(404, "not_found", "Mailbox connection not found.");
    return connection;
  }
  private async message(actor: AmsActor, id: string) {
    const message = await this.deps.store.get(
      actor.tenantId,
      "messages",
      AmsId.parse(id),
    );
    if (!message)
      throw new AmsError(404, "not_found", "Incoming message not found.");
    return message;
  }
  async list(actor: AmsActor, cursor?: string) {
    await this.authorize(actor);
    const page = await this.deps.store.list(actor.tenantId, "connections", {
      ...(cursor ? { cursor } : {}),
    });
    return {
      ...page,
      items: page.items.map((c) => publicMailbox(c, this.now())),
      providers: ["gmail", "microsoft365"].map((provider) => ({
        provider,
        configured: Boolean(
          this.deps.vault &&
          this.deps.oauth?.configured(provider as MailboxProvider),
        ),
      })),
      syncMode: "manual" as const,
    };
  }
  async messages(actor: AmsActor, page: MailboxPage) {
    await this.authorize(actor);
    const result = await this.deps.store.list(actor.tenantId, "messages", page);
    return { ...result, items: result.items.map(publicMailboxMessage) };
  }
  async getMessage(actor: AmsActor, id: string) {
    await this.authorize(actor);
    return publicMailboxMessage(await this.message(actor, id));
  }
  async events(actor: AmsActor, connectionId: string, cursor?: string) {
    await this.authorize(actor, true);
    await this.connection(actor, connectionId);
    return this.deps.store.list(actor.tenantId, "events", {
      connectionId,
      ...(cursor ? { cursor } : {}),
    });
  }
  async begin(actor: AmsActor, provider: MailboxProvider) {
    await this.authorize(actor, true);
    if (!this.deps.oauth?.configured(provider) || !this.deps.vault)
      throw new AmsError(
        503,
        "mailbox_not_configured",
        "This mailbox provider has not been configured for this deployment.",
      );
    const start = await this.deps.oauth.begin(provider);
    const id = digest({ state: start.state });
    const verifier = this.deps.vault.seal(
      { tenantId: actor.tenantId, id, provider, purpose: "authorization" },
      start.verifier,
    );
    await this.deps.store.commit(actor.tenantId, [
      {
        kind: "authorizations",
        expectedRevision: null,
        value: {
          id,
          revision: 1,
          provider,
          actorId: actor.userId,
          createdAt: this.now().toISOString(),
          expiresAt: new Date(this.now().getTime() + 10 * 60_000).toISOString(),
          verifier,
          consumed: false,
        },
      },
    ]);
    return { authorizationUrl: start.url };
  }
  async complete(actor: AmsActor, provider: MailboxProvider, query: string) {
    await this.authorize(actor, true);
    if (
      !this.deps.oauth?.configured(provider) ||
      !this.deps.vault ||
      query.length > 20_000
    )
      throw invalidCallback();
    const parameters = new URLSearchParams(query),
      state = parameters.get("state");
    if (
      !state ||
      !/^[A-Za-z0-9_-]{32,200}$/.test(state) ||
      parameters.getAll("state").length !== 1 ||
      parameters.getAll("code").length > 1 ||
      parameters.getAll("error").length > 1
    )
      throw invalidCallback();
    const authorization = await this.deps.store.get(
      actor.tenantId,
      "authorizations",
      digest({ state }),
    );
    if (
      !authorization ||
      authorization.actorId !== actor.userId ||
      authorization.provider !== provider ||
      authorization.consumed ||
      Date.parse(authorization.expiresAt) <= this.now().getTime()
    )
      throw invalidCallback();
    const verifier = this.deps.vault.open(
      {
        tenantId: actor.tenantId,
        id: authorization.id,
        provider,
        purpose: "authorization",
      },
      authorization.verifier,
    );
    // Consume before contacting the provider. A lost authorization response requires a new consent flow.
    await this.deps.store.commit(actor.tenantId, [
      {
        kind: "authorizations",
        expectedRevision: authorization.revision,
        value: {
          ...authorization,
          revision: authorization.revision + 1,
          consumed: true,
        },
      },
    ]);
    const credentials = await this.deps.oauth.exchange(
      provider,
      parameters,
      state,
      verifier,
    );
    const identity = await (this.deps.client ?? createMailboxClient)(
      provider,
      credentials.accessToken,
    ).identity();
    const id = `mailbox_${digest({ provider, remoteId: identity.remoteId }).slice(0, 48)}`;
    const previous = await this.deps.store.get(
      actor.tenantId,
      "connections",
      id,
    );
    const connection: MailboxConnection = {
      id,
      revision: (previous?.revision ?? 0) + 1,
      provider,
      address: identity.address,
      remoteId: identity.remoteId,
      createdAt: previous?.createdAt ?? this.now().toISOString(),
      createdBy: previous?.createdBy ?? actor.userId,
      state: previous?.folder ? "connected" : "choose_folder",
      credentials: this.deps.vault.seal(
        { tenantId: actor.tenantId, id, provider, purpose: "credentials" },
        JSON.stringify(credentials),
      ),
      folder: previous?.folder ?? null,
      cursor: previous?.cursor ?? null,
      pending: previous?.pending ?? null,
      hasMore: previous?.hasMore ?? false,
      lease: null,
      lastAttemptAt: previous?.lastAttemptAt ?? null,
      lastSyncedAt: previous?.lastSyncedAt ?? null,
      nextAttemptAt: null,
      error: null,
    };
    await this.deps.store.commit(actor.tenantId, [
      {
        kind: "connections",
        expectedRevision: previous?.revision ?? null,
        value: connection,
      },
      {
        kind: "events",
        expectedRevision: null,
        value: event(
          actor,
          id,
          this.now().toISOString(),
          "connected",
          previous
            ? "Reauthorized read access to the same mailbox; retained queue and cursor."
            : "Authorized read access. No messages sync until an agency folder is selected.",
        ),
      },
    ]);
    return publicMailbox(connection, this.now());
  }
  async disconnect(actor: AmsActor, id: string, revision: number) {
    await this.authorize(actor, true);
    const current = await this.connection(actor, id);
    if (current.revision !== revision) throw changed();
    const value = {
      ...current,
      revision: revision + 1,
      state: "disconnected" as const,
      credentials: null,
      lease: null,
      nextAttemptAt: null,
      error: null,
    };
    await this.deps.store.commit(actor.tenantId, [
      { kind: "connections", expectedRevision: revision, value },
      {
        kind: "events",
        expectedRevision: null,
        value: event(
          actor,
          id,
          this.now().toISOString(),
          "disconnected",
          "Stopped importing and removed stored access/refresh credentials. Retained incoming and filed messages. Provider consent can also be revoked in the mailbox account.",
        ),
      },
    ]);
    return publicMailbox(value, this.now());
  }
  private async withClient<T>(
    actor: AmsActor,
    id: string,
    action: (driver: Driver) => Promise<T>,
  ) {
    let current = await this.connection(actor, id);
    if (current.state === "disconnected" || !current.credentials)
      throw unavailable();
    if (!this.deps.vault)
      throw new AmsError(
        503,
        "mailbox_not_configured",
        "Restore this deployment's mailbox encryption key before syncing.",
      );
    if (current.lease && Date.parse(current.lease.until) > this.now().getTime())
      throw new AmsError(
        409,
        "mailbox_busy",
        "This mailbox is already syncing. Wait for the current batch to finish.",
      );
    if (
      current.nextAttemptAt &&
      Date.parse(current.nextAttemptAt) > this.now().getTime()
    )
      throw new AmsError(
        429,
        "mailbox_throttled",
        "Wait until this mailbox's retry time before syncing again.",
      );
    const lease = {
      id: randomUUID(),
      until: new Date(this.now().getTime() + 120_000).toISOString(),
    };
    const update = async (
      patch: Partial<MailboxConnection>,
      message?: MailboxMessage,
    ) => {
      const value = {
        ...current,
        ...patch,
        id: current.id,
        revision: current.revision + 1,
      };
      await this.deps.store.commit(actor.tenantId, [
        { kind: "connections", expectedRevision: current.revision, value },
        ...(message
          ? [
              {
                kind: "messages" as const,
                expectedRevision: null,
                value: message,
              },
            ]
          : []),
      ]);
      current = value;
      if (driver) driver.connection = current;
    };
    let driver: Driver | undefined;
    await update({ lease });
    try {
      let credentials = this.deps.vault.credentials(
        { tenantId: actor.tenantId, id, provider: current.provider },
        current.credentials!,
      );
      if (Date.parse(credentials.expiresAt) <= this.now().getTime() + 60_000) {
        if (!this.deps.oauth?.configured(current.provider))
          throw new AmsError(
            503,
            "mailbox_not_configured",
            "Configure this mailbox provider before refreshing its read access.",
          );
        credentials = await this.deps.oauth.refresh(
          current.provider,
          credentials,
        );
        await update({
          credentials: this.deps.vault.seal(
            {
              tenantId: actor.tenantId,
              id,
              provider: current.provider,
              purpose: "credentials",
            },
            JSON.stringify(credentials),
          ),
        });
      }
      driver = {
        connection: current,
        client: (this.deps.client ?? createMailboxClient)(
          current.provider,
          credentials.accessToken,
          { signal: AbortSignal.timeout(40_000) },
        ),
        save: update,
      };
      return await action(driver);
    } catch (error) {
      const saved = await this.connection(actor, id);
      if (saved.lease?.id === lease.id) {
        current = saved;
        const failure = safeError(error);
        const nextAttemptAt =
          error instanceof MailboxProviderError && error.retryAfterSeconds
            ? new Date(
                this.now().getTime() + error.retryAfterSeconds * 1000,
              ).toISOString()
            : null;
        await update({ error: failure, nextAttemptAt });
      }
      if (error instanceof AmsError) throw error;
      throw new AmsError(
        502,
        "mailbox_sync_failed",
        "The mailbox operation was interrupted. Retry from its saved position.",
      );
    } finally {
      const saved = await this.connection(actor, id);
      if (saved.lease?.id === lease.id) {
        // Review actions may run concurrently; refresh the revision before releasing this lease.
        try {
          await this.deps.store.commit(actor.tenantId, [
            {
              kind: "connections",
              expectedRevision: saved.revision,
              value: { ...saved, revision: saved.revision + 1, lease: null },
            },
          ]);
        } catch (error) {
          if (!(error instanceof AmsError && error.code === "mailbox_changed"))
            throw error;
        }
      }
    }
  }
  async folders(
    actor: AmsActor,
    id: string,
    input: { parentId?: string; next?: string },
  ) {
    await this.authorize(actor, true);
    return this.withClient(actor, id, ({ client }) => client.folders(input));
  }
  async selectFolder(
    actor: AmsActor,
    id: string,
    input: {
      folderId: string;
      since: string;
      shareWithAgency: true;
      replaceSelection?: boolean;
    },
  ) {
    await this.authorize(actor, true);
    const selected = z
      .object({
        folderId: z.string().min(1).max(2048),
        since: z.string().datetime({ offset: true }),
        shareWithAgency: z.literal(true),
        replaceSelection: z.boolean().default(false),
      })
      .strict()
      .parse(input);
    if (Date.parse(selected.since) > this.now().getTime())
      throw new AmsError(
        422,
        "invalid_mailbox_start",
        "Choose a sync start date that is not in the future.",
      );
    await this.withClient(actor, id, async (driver) => {
      if (driver.connection.folder && !selected.replaceSelection)
        throw new AmsError(
          409,
          "mailbox_folder_fixed",
          "Confirm changing this mailbox's folder or start date. Previously imported messages will be retained.",
        );
      const folder = await driver.client.folder(selected.folderId);
      const at = this.now().toISOString();
      const value: MailboxConnection = {
        ...driver.connection,
        revision: driver.connection.revision + 1,
        state: "connected",
        folder: {
          id: folder.id,
          name: folder.name,
          since: selected.since,
          consentBy: actor.userId,
          consentAt: at,
        },
        cursor: null,
        pending: null,
        hasMore: true,
        lastSyncedAt: null,
        error: null,
      };
      await this.deps.store.commit(actor.tenantId, [
        {
          kind: "connections",
          expectedRevision: driver.connection.revision,
          value,
        },
        {
          kind: "events",
          expectedRevision: null,
          value: event(
            actor,
            id,
            at,
            "folder_selected",
            `Authorized agency review from ${selected.since} in folder: ${folder.name}`.slice(
              0,
              1000,
            ),
          ),
        },
      ]);
      driver.connection = value;
    });
    return publicMailbox(await this.connection(actor, id), this.now());
  }
  private async retainedMessage(
    actor: AmsActor,
    connection: MailboxConnection,
    providerMessageId: string,
    client: MailboxClient,
  ): Promise<MailboxMessage | null> {
    const id = `incoming_${digest({ connectionId: connection.id, providerMessageId }).slice(0, 48)}`;
    const blank: MailboxMessage = {
      id,
      revision: 1,
      connectionId: connection.id,
      providerMessageId,
      queuedAt: this.now().toISOString(),
      receivedAt: null,
      status: "error",
      subject: "Message needs import review",
      from: "",
      to: "",
      body: "",
      bodyTruncated: false,
      attachmentCount: 0,
      direction: "unknown",
      original: null,
      filing: null,
      correspondenceId: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewReason: "",
      error: null,
    };
    try {
      const original = await client.original(providerMessageId, {
        folderId: connection.folder!.id,
        since: connection.folder!.since,
      });
      if (!original) return null;
      const header = original.bytes
        .subarray(0, 64 * 1024)
        .toString("utf8")
        .split(/\r?\n\r?\n/, 1)[0]!;
      if (!/^(from|to|subject|message-id):/im.test(header))
        throw new AmsError(
          422,
          "invalid_email",
          "This provider item does not contain usable email headers. Review it in the mailbox.",
        );
      const mail = await simpleParser(original.bytes, {
        skipHtmlToText: false,
        skipTextToHtml: true,
        skipImageLinks: true,
        maxHtmlLengthToParse: 2_000_000,
      });
      const sha256 = fileHash(original.bytes);
      const storageKey = `ams-documents/${actor.tenantId}/${connection.id}/${sha256}`;
      await this.deps.files.put(storageKey, original.bytes, "message/rfc822");
      const to = Array.isArray(mail.to)
        ? mail.to.map((a) => a.text).join(", ")
        : mail.to?.text || "";
      return {
        ...blank,
        status: "review",
        receivedAt: original.receivedAt,
        subject: (mail.subject || "(No subject)").slice(0, 500),
        from: (mail.from?.text || "").slice(0, 2000),
        to: to.slice(0, 4000),
        ...emailPreview(mail),
        attachmentCount: mail.attachments.length,
        direction: original.direction,
        original: { storageKey, sha256, bytes: original.bytes.length },
      };
    } catch (error) {
      if (
        error instanceof AmsError &&
        ["mailbox_message_too_large", "invalid_email"].includes(error.code)
      )
        return { ...blank, error: safeError(error) };
      throw error;
    }
  }
  async sync(actor: AmsActor, id: string) {
    await this.authorize(actor);
    let imported = 0,
      checked = 0;
    await this.withClient(actor, id, async (driver) => {
      if (!driver.connection.folder || driver.connection.state !== "connected")
        throw new AmsError(
          409,
          "mailbox_folder_required",
          "Choose an agency folder and authorize sharing before syncing.",
        );
      await driver.save({
        lastAttemptAt: this.now().toISOString(),
        error: null,
      });
      if (!driver.connection.pending) {
        const page = await driver.client.page(
          {
            folderId: driver.connection.folder!.id,
            since: driver.connection.folder!.since,
          },
          driver.connection.cursor,
        );
        await driver.save({
          pending: {
            ids: page.messageIds,
            cursor: page.cursor,
            more: page.more,
          },
          hasMore: true,
        });
      }
      // Bounded batches survive request deadlines. A page cursor is promoted only after every ID is durable or skipped.
      while (driver.connection.pending!.ids.length && checked < 3) {
        const pending = driver.connection.pending!,
          providerId = pending.ids[0]!;
        const messageId = `incoming_${digest({ connectionId: id, providerMessageId: providerId }).slice(0, 48)}`;
        const existing = await this.deps.store.get(
          actor.tenantId,
          "messages",
          messageId,
        );
        const message = existing
          ? null
          : await this.retainedMessage(
              actor,
              driver.connection,
              providerId,
              driver.client,
            );
        await driver.save(
          { pending: { ...pending, ids: pending.ids.slice(1) } },
          message ?? undefined,
        );
        if (message) imported++;
        checked++;
      }
      if (!driver.connection.pending!.ids.length) {
        const pending = driver.connection.pending!;
        await driver.save({
          cursor: pending.cursor,
          pending: null,
          hasMore: pending.more,
          ...(!pending.more ? { lastSyncedAt: this.now().toISOString() } : {}),
        });
      }
    });
    return {
      connection: publicMailbox(await this.connection(actor, id), this.now()),
      imported,
      checked,
    };
  }
  async reset(actor: AmsActor, id: string, revision: number) {
    await this.authorize(actor, true);
    const current = await this.connection(actor, id);
    if (current.revision !== revision) throw changed();
    if (current.state !== "connected" || !current.folder) throw unavailable();
    const value = {
      ...current,
      revision: revision + 1,
      cursor: null,
      pending: null,
      hasMore: true,
      error: null,
      lease: null,
    };
    await this.deps.store.commit(actor.tenantId, [
      { kind: "connections", expectedRevision: revision, value },
      {
        kind: "events",
        expectedRevision: null,
        value: event(
          actor,
          id,
          this.now().toISOString(),
          "sync_reset",
          "Restarted the selected folder from its original start date. Retained messages and filing decisions remain unchanged.",
        ),
      },
    ]);
    return publicMailbox(value, this.now());
  }
  async original(actor: AmsActor, id: string) {
    await this.authorize(actor);
    const message = await this.message(actor, id);
    if (!message.original)
      throw new AmsError(
        404,
        "not_found",
        "This message has no retained original. Review it in the mailbox.",
      );
    const bytes = await this.deps.files.get(message.original.storageKey);
    if (fileHash(bytes) !== message.original.sha256)
      throw new AmsError(
        409,
        "mailbox_original_changed",
        "The retained original failed its integrity check. Ask an administrator to review storage.",
      );
    return bytes;
  }
  async dismiss(actor: AmsActor, id: string, revision: number, reason: string) {
    await this.authorize(actor);
    const current = await this.message(actor, id);
    if (current.revision !== revision) throw changed();
    if (!["review", "error", "unavailable"].includes(current.status))
      throw new AmsError(
        409,
        "mailbox_review_completed",
        "This message already has a review decision or filing in progress.",
      );
    const detail = z.string().trim().min(1).max(1000).parse(reason);
    const at = this.now().toISOString();
    const value: MailboxMessage = {
      ...current,
      revision: revision + 1,
      status: "dismissed",
      reviewedAt: at,
      reviewedBy: actor.userId,
      reviewReason: detail,
      error: null,
    };
    await this.deps.store.commit(actor.tenantId, [
      { kind: "messages", expectedRevision: revision, value },
      {
        kind: "events",
        expectedRevision: null,
        value: event(
          actor,
          current.connectionId,
          at,
          "message_dismissed",
          detail,
          id,
        ),
      },
    ]);
    return publicMailboxMessage(value);
  }
  async retry(actor: AmsActor, id: string, revision: number) {
    await this.authorize(actor);
    const current = await this.message(actor, id);
    if (current.revision !== revision) throw changed();
    if (!["dismissed", "error", "unavailable"].includes(current.status))
      throw new AmsError(
        409,
        "mailbox_review_completed",
        "This message is already awaiting review or has been filed.",
      );
    const save = async (
      message: MailboxMessage,
      connectionRevision?: number,
    ) => {
      const value: MailboxMessage = {
        ...message,
        revision: current.revision + 1,
        queuedAt: current.queuedAt,
        reviewedAt: null,
        reviewedBy: null,
        reviewReason: "",
      };
      await this.deps.store.commit(
        actor.tenantId,
        [
          { kind: "messages", expectedRevision: current.revision, value },
          {
            kind: "events",
            expectedRevision: null,
            value: event(
              actor,
              current.connectionId,
              this.now().toISOString(),
              "message_retried",
              "Returned the message to import/review without changing the provider mailbox or an account.",
              id,
            ),
          },
        ],
        connectionRevision === undefined
          ? undefined
          : {
              connectionId: current.connectionId,
              revision: connectionRevision,
            },
      );
    };
    if (current.original)
      await save({ ...current, status: "review", error: null });
    else
      await this.withClient(actor, current.connectionId, async (driver) => {
        if (!driver.connection.folder) throw unavailable();
        const retained = await this.retainedMessage(
          actor,
          driver.connection,
          current.providerMessageId,
          driver.client,
        );
        await save(
          retained ?? {
            ...current,
            status: "unavailable",
            error: {
              code: "mailbox_message_unavailable",
              message:
                "The message is no longer in the selected folder or is outside its date range. Check the original mailbox.",
            },
          },
          driver.connection.revision,
        );
      });
    return publicMailboxMessage(await this.message(actor, id));
  }
  async file(
    actor: AmsActor,
    id: string,
    input: {
      expectedRevision: number;
      accountId: string;
      expectedVersion: string;
      policyId: string | null;
      direction: "inbound" | "outbound" | "unknown";
      shareWithAgency: true;
    },
  ) {
    await this.authorize(actor);
    const filingInput = EmailFilingInput.omit({ commandId: true })
      .extend({ expectedRevision: z.number().int().min(1), accountId: AmsId })
      .strict()
      .parse(input);
    let current = await this.message(actor, id);
    if (
      !current.original ||
      !["review", "filing", "filed"].includes(current.status)
    )
      throw new AmsError(
        409,
        "mailbox_original_required",
        "A retained original awaiting review is required before filing.",
      );
    if (
      current.status === "review" &&
      current.revision !== filingInput.expectedRevision
    )
      throw changed();
    if (
      current.filing &&
      (current.filing.accountId !== filingInput.accountId ||
        current.filing.policyId !== filingInput.policyId ||
        current.filing.direction !== filingInput.direction)
    )
      throw new AmsError(
        409,
        "mailbox_filing_in_progress",
        "This message already has a filing decision. Finish that filing before making another change.",
      );
    if (current.status === "filed") return publicMailboxMessage(current);
    const correspondenceId = `correspondence_${digest({ sha256: current.original.sha256 }).slice(0, 48)}`;
    const finish = async () => {
      const filed = await this.deps.repository.get(
        actor.tenantId,
        "correspondence",
        correspondenceId,
      );
      if (!filed) return null;
      if (
        filed.data.accountId !== filingInput.accountId ||
        filed.data.policyId !== filingInput.policyId
      )
        throw new AmsError(
          409,
          "email_already_filed",
          "This original email is already filed with a different account or policy. Review its existing Correspondence record instead of filing a second copy.",
        );
      const at = this.now().toISOString();
      const value: MailboxMessage = {
        ...current,
        revision: current.revision + 1,
        status: "filed",
        correspondenceId,
        filing: current.filing ?? {
          commandId: randomUUID(),
          accountId: filingInput.accountId,
          policyId: filingInput.policyId,
          expectedVersion: filingInput.expectedVersion,
          direction: filed.data.direction,
          actorId: actor.userId,
        },
        direction: filed.data.direction,
        reviewedBy: actor.userId,
        reviewedAt: at,
        reviewReason:
          "Reviewed and linked the retained original to account correspondence.",
        error: null,
      };
      await this.deps.store.commit(actor.tenantId, [
        { kind: "messages", expectedRevision: current.revision, value },
        {
          kind: "events",
          expectedRevision: null,
          value: event(
            actor,
            current.connectionId,
            at,
            "message_filed",
            "Linked the retained original to account correspondence. No policy changes or external messages were made.",
            id,
          ),
        },
      ]);
      return publicMailboxMessage(value);
    };
    const recovered = await finish();
    if (recovered) return recovered;
    if (current.filing && current.filing.actorId !== actor.userId)
      throw new AmsError(
        409,
        "mailbox_filing_in_progress",
        "Another agency member started this filing. They can retry the same action to finish it.",
      );
    if (!current.filing) {
      const value: MailboxMessage = {
        ...current,
        revision: current.revision + 1,
        status: "filing",
        error: null,
        filing: {
          commandId: randomUUID(),
          accountId: filingInput.accountId,
          policyId: filingInput.policyId,
          expectedVersion: filingInput.expectedVersion,
          direction: filingInput.direction,
          actorId: actor.userId,
        },
      };
      await this.deps.store.commit(actor.tenantId, [
        { kind: "messages", expectedRevision: current.revision, value },
      ]);
      current = value;
    }
    try {
      const connection = await this.connection(actor, current.connectionId);
      const bytes = await this.original(actor, id);
      const filing = current.filing!;
      await fileOriginalEmail({
        actor,
        accountId: filing.accountId,
        filing: {
          commandId: filing.commandId,
          expectedVersion: filing.expectedVersion,
          policyId: filing.policyId,
          direction: filing.direction,
          shareWithAgency: true,
        },
        bytes,
        filename: "mailbox-message.eml",
        repository: this.deps.repository,
        files: this.deps.files,
        service: this.deps.service(),
        source: {
          provider: connection.provider,
          connectionId: connection.id,
          messageId: current.providerMessageId,
          direction: filing.direction,
        },
      });
      return (await finish())!;
    } catch (error) {
      // A commit may have succeeded before its response was lost. Recover by immutable
      // content identity before allowing any new filing decision or command identifier.
      let failure = error;
      try {
        const recovered = await finish();
        if (recovered) return recovered;
      } catch (recoveryError) {
        // Another mailbox may have filed the identical original to a different
        // destination. Keep the losing review editable, rather than stuck filing.
        if (
          recoveryError instanceof AmsError &&
          recoveryError.code === "email_already_filed"
        )
          failure = recoveryError;
        else throw recoveryError;
      }
      if (failure instanceof AmsError && failure.status < 500) {
        try {
          await this.deps.store.commit(actor.tenantId, [
            {
              kind: "messages",
              expectedRevision: current.revision,
              value: {
                ...current,
                revision: current.revision + 1,
                status: "review",
                filing: null,
                error: safeError(failure),
              },
            },
          ]);
        } catch (conflict) {
          if (!(
            conflict instanceof AmsError && conflict.code === "mailbox_changed"
          ))
            throw conflict;
        }
      }
      if (failure instanceof AmsError) throw failure;
      throw new AmsError(
        503,
        "mailbox_filing_interrupted",
        "The filing may still be completing. Retry the same account and policy to safely recover its result.",
      );
    }
  }
}
