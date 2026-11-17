import type { DatabaseSync } from "node:sqlite";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { AmsId } from "@openams/contracts";
import type { SqliteExclusive } from "./chat.js";
import { AmsError, digest } from "./repository.js";
import { MailboxCursorSchema } from "./mailbox-providers.js";

const at = z.string().datetime({ offset: true });
const remoteId = z.string().min(1).max(2048);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const error = z
  .object({ code: z.string().max(80), message: z.string().max(500) })
  .strict()
  .nullable();
const base = { id: AmsId, revision };
export const MailboxConnectionSchema = z
  .object({
    ...base,
    provider: z.enum(["gmail", "microsoft365"]),
    address: z.string().email().max(320),
    remoteId,
    createdAt: at,
    createdBy: AmsId,
    state: z.enum(["choose_folder", "connected", "disconnected"]),
    /** Encrypted with a deployment key and authenticated agency/connection context. */
    credentials: z.string().max(64_000).nullable(),
    folder: z
      .object({
        id: remoteId,
        name: z.string().min(1).max(1000),
        since: at,
        consentBy: AmsId,
        consentAt: at,
      })
      .strict()
      .nullable(),
    cursor: MailboxCursorSchema.nullable(),
    hasMore: z.boolean().default(false),
    pending: z
      .object({
        ids: z.array(remoteId).max(2000),
        cursor: MailboxCursorSchema,
        more: z.boolean(),
      })
      .strict()
      .nullable(),
    lease: z.object({ id: z.string().uuid(), until: at }).strict().nullable(),
    lastAttemptAt: at.nullable(),
    lastSyncedAt: at.nullable(),
    nextAttemptAt: at.nullable(),
    error,
  })
  .strict();
export type MailboxConnection = z.infer<typeof MailboxConnectionSchema>;

export const MailboxMessageSchema = z
  .object({
    ...base,
    connectionId: AmsId,
    providerMessageId: remoteId,
    queuedAt: at,
    receivedAt: at.nullable(),
    status: z.enum([
      "review",
      "filing",
      "filed",
      "dismissed",
      "error",
      "unavailable",
    ]),
    subject: z.string().max(500),
    from: z.string().max(2000),
    to: z.string().max(4000),
    body: z.string().max(20_000),
    bodyTruncated: z.boolean(),
    attachmentCount: z.number().int().min(0),
    direction: z.enum(["inbound", "outbound", "unknown"]),
    original: z
      .object({
        storageKey: z.string().max(1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z
          .number()
          .int()
          .min(1)
          .max(20 * 1024 * 1024),
      })
      .strict()
      .nullable(),
    filing: z
      .object({
        commandId: z.string().uuid(),
        accountId: AmsId,
        expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
        policyId: AmsId.nullable(),
        direction: z.enum(["inbound", "outbound", "unknown"]),
        actorId: AmsId,
      })
      .strict()
      .nullable(),
    correspondenceId: AmsId.nullable(),
    reviewedBy: AmsId.nullable(),
    reviewedAt: at.nullable(),
    reviewReason: z.string().max(1000),
    error,
  })
  .strict();
export type MailboxMessage = z.infer<typeof MailboxMessageSchema>;
export const MailboxEventSchema = z
  .object({
    ...base,
    connectionId: AmsId,
    messageId: AmsId.nullable(),
    at,
    actorId: AmsId,
    action: z.enum([
      "connected",
      "folder_selected",
      "disconnected",
      "sync_reset",
      "message_filed",
      "message_dismissed",
      "message_retried",
    ]),
    detail: z.string().max(1000),
  })
  .strict();
export type MailboxEvent = z.infer<typeof MailboxEventSchema>;
export const MailboxAuthorizationSchema = z
  .object({
    ...base,
    provider: z.enum(["gmail", "microsoft365"]),
    actorId: AmsId,
    createdAt: at,
    expiresAt: at,
    verifier: z.string().max(2000),
    consumed: z.boolean(),
  })
  .strict();
export type MailboxAuthorization = z.infer<typeof MailboxAuthorizationSchema>;
export type MailboxEntities = {
  connections: MailboxConnection;
  messages: MailboxMessage;
  events: MailboxEvent;
  authorizations: MailboxAuthorization;
};
type Kind = keyof MailboxEntities;
type Entity = MailboxEntities[Kind];
type Change = {
  [K in Kind]: {
    kind: K;
    expectedRevision: number | null;
    value: MailboxEntities[K];
  };
}[Kind];
export type MailboxPage = {
  connectionId?: string;
  status?: MailboxMessage["status"];
  cursor?: string;
  limit?: number;
};
export interface MailboxStore {
  get<K extends Kind>(
    tenantId: string,
    kind: K,
    id: string,
  ): Promise<MailboxEntities[K] | null>;
  list<K extends Kind>(
    tenantId: string,
    kind: K,
    page?: MailboxPage,
  ): Promise<{ items: MailboxEntities[K][]; nextCursor: string | null }>;
  /** Compare-and-swap all changes atomically. Conditions protect in-flight sync from disconnects. */
  commit(
    tenantId: string,
    changes: Change[],
    condition?: { connectionId: string; revision: number },
  ): Promise<void>;
}
const schemas = {
  connections: MailboxConnectionSchema,
  messages: MailboxMessageSchema,
  events: MailboxEventSchema,
  authorizations: MailboxAuthorizationSchema,
};
const conflict = () =>
  new AmsError(
    409,
    "mailbox_changed",
    "This mailbox item changed. Refresh before trying again.",
  );
function identity(tenant: string, kind: Kind, id?: string) {
  if (
    !AmsId.safeParse(tenant).success ||
    /^__.*__$/.test(tenant) ||
    !Object.hasOwn(schemas, kind) ||
    (id !== undefined && !AmsId.safeParse(id).success)
  )
    throw new AmsError(
      400,
      "invalid_mailbox_id",
      "Invalid mailbox identifier.",
    );
}
function prepared(tenant: string, changes: Change[]) {
  if (!changes.length || changes.length > 10)
    throw new Error("Mailbox commits require 1–10 changes.");
  const keys = new Set<string>();
  return changes.map((change) => {
    identity(tenant, change.kind, change.value.id);
    const value = schemas[change.kind].parse(change.value) as Entity;
    if (
      value.revision !== (change.expectedRevision ?? 0) + 1 ||
      (change.kind === "events" && change.expectedRevision !== null)
    )
      throw conflict();
    const key = `${change.kind}:${value.id}`;
    if (keys.has(key)) throw conflict();
    keys.add(key);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 800 * 1024)
      throw new AmsError(
        413,
        "mailbox_state_too_large",
        "This mailbox page exceeds the supported size. Restart sync or use a narrower folder.",
      );
    const prefix =
      change.kind === "messages"
        ? `${(value as MailboxMessage).status}:`
        : "all:";
    const sort =
      change.kind === "messages"
        ? `${(value as MailboxMessage).queuedAt}:${value.id}`
        : change.kind === "events"
          ? `${(value as MailboxEvent).at}:${value.id}`
          : value.id;
    const queueKey = `${prefix}${sort}`;
    const connectionQueueKey =
      change.kind === "connections" || change.kind === "authorizations"
        ? queueKey
        : `${(value as MailboxMessage | MailboxEvent).connectionId}:${queueKey}`;
    return { ...change, value, json, queueKey, connectionQueueKey };
  });
}
function paging(tenant: string, kind: Kind, input: MailboxPage = {}) {
  identity(tenant, kind);
  const page = z
    .object({
      connectionId: AmsId.optional(),
      status: MailboxMessageSchema.shape.status.optional(),
      cursor: z.string().max(4096).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict()
    .parse(input);
  if (
    ((kind === "connections" || kind === "authorizations") &&
      (page.connectionId || page.status)) ||
    (kind === "events" && page.status)
  )
    throw new AmsError(
      400,
      "invalid_mailbox_filter",
      "Invalid mailbox filter.",
    );
  const prefix = `${page.connectionId ? `${page.connectionId}:` : ""}${kind === "messages" ? `${page.status ?? "review"}:` : "all:"}`;
  const fingerprint = digest({ tenant, kind, prefix });
  let after: string | null = null;
  if (page.cursor) {
    try {
      const parsed = JSON.parse(
        Buffer.from(page.cursor, "base64url").toString("utf8"),
      );
      if (
        parsed.fingerprint !== fingerprint ||
        typeof parsed.key !== "string" ||
        !parsed.key.startsWith(prefix) ||
        parsed.key.length > 1024
      )
        throw new Error();
      after = parsed.key;
    } catch {
      throw new AmsError(
        400,
        "invalid_cursor",
        "Restart the mailbox search; its cursor no longer matches these filters.",
      );
    }
  }
  return {
    ...page,
    prefix,
    fingerprint,
    after,
    field: page.connectionId ? "connectionQueueKey" : "queueKey",
  } as const;
}
function result<K extends Kind>(
  rows: Array<{ value: string; key: string }>,
  page: ReturnType<typeof paging>,
) {
  const more = rows.length > page.limit;
  const kept = rows.slice(0, page.limit);
  return {
    items: kept.map((r) => JSON.parse(r.value) as MailboxEntities[K]),
    nextCursor: more
      ? Buffer.from(
          JSON.stringify({
            fingerprint: page.fingerprint,
            key: kept.at(-1)!.key,
          }),
        ).toString("base64url")
      : null,
  };
}

/** Shares the agency SQLite queue/file, so ordinary local backups retain mailbox state. */
export class SqliteMailboxStore implements MailboxStore {
  private ready: Promise<void>;
  constructor(private database: SqliteExclusive) {
    this.ready = database.exclusive((db) => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS ams_mailbox(tenant TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,queue_key TEXT NOT NULL,connection_queue_key TEXT NOT NULL,PRIMARY KEY(tenant,kind,id));
      CREATE INDEX IF NOT EXISTS ams_mailbox_queue ON ams_mailbox(tenant,kind,queue_key);
      CREATE INDEX IF NOT EXISTS ams_mailbox_connection_queue ON ams_mailbox(tenant,kind,connection_queue_key);
    `);
    });
  }
  private run<T>(work: (db: DatabaseSync) => T) {
    return this.ready.then(() => this.database.exclusive(work));
  }
  async get<K extends Kind>(
    tenant: string,
    kind: K,
    id: string,
  ): Promise<MailboxEntities[K] | null> {
    identity(tenant, kind, id);
    return this.run((db) => {
      const row = db
        .prepare(
          "SELECT value FROM ams_mailbox WHERE tenant=? AND kind=? AND id=?",
        )
        .get(tenant, kind, id);
      return row ? (JSON.parse(String(row.value)) as MailboxEntities[K]) : null;
    });
  }
  async list<K extends Kind>(tenant: string, kind: K, input?: MailboxPage) {
    const page = paging(tenant, kind, input);
    return this.run((db) => {
      const column =
        page.field === "queueKey" ? "queue_key" : "connection_queue_key";
      const rows = db
        .prepare(
          `SELECT value,${column} AS key FROM ams_mailbox WHERE tenant=? AND kind=? AND ${column}>=? AND ${column}<? AND ${column}>? ORDER BY ${column} LIMIT ?`,
        )
        .all(
          tenant,
          kind,
          page.prefix,
          `${page.prefix}~`,
          page.after ?? "",
          page.limit + 1,
        );
      return result<K>(
        rows.map((r) => ({ value: String(r.value), key: String(r.key) })),
        page,
      );
    });
  }
  async commit(
    tenant: string,
    changes: Change[],
    condition?: { connectionId: string; revision: number },
  ) {
    const batch = prepared(tenant, changes);
    if (condition) identity(tenant, "connections", condition.connectionId);
    return this.run((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const readRevision = (kind: Kind, id: string) => {
          const row = db
            .prepare(
              "SELECT value FROM ams_mailbox WHERE tenant=? AND kind=? AND id=?",
            )
            .get(tenant, kind, id);
          return row
            ? (JSON.parse(String(row.value)).revision as number)
            : null;
        };
        if (
          condition &&
          readRevision("connections", condition.connectionId) !==
            condition.revision
        )
          throw conflict();
        for (const change of batch)
          if (
            readRevision(change.kind, change.value.id) !==
            change.expectedRevision
          )
            throw conflict();
        for (const change of batch)
          db.prepare(
            "INSERT INTO ams_mailbox(tenant,kind,id,value,queue_key,connection_queue_key) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant,kind,id) DO UPDATE SET value=excluded.value,queue_key=excluded.queue_key,connection_queue_key=excluded.connection_queue_key",
          ).run(
            tenant,
            change.kind,
            change.value.id,
            change.json,
            change.queueKey,
            change.connectionQueueKey,
          );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
}

/** Separate collections keep credentials out of ordinary records, exports and client queries. */
export class FirestoreMailboxStore implements MailboxStore {
  constructor(
    private db: Firestore,
    private root = "tenants",
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(root) || /^__.*__$/.test(root))
      throw new Error("Invalid Firestore root.");
  }
  private collection(tenant: string, kind: Kind) {
    identity(tenant, kind);
    return this.db
      .collection(this.root)
      .doc(tenant)
      .collection(`mailbox_${kind}`);
  }
  async get<K extends Kind>(
    tenant: string,
    kind: K,
    id: string,
  ): Promise<MailboxEntities[K] | null> {
    identity(tenant, kind, id);
    const doc = await this.collection(tenant, kind).doc(`i_${id}`).get();
    return doc.exists
      ? (JSON.parse(doc.get("value")) as MailboxEntities[K])
      : null;
  }
  async list<K extends Kind>(tenant: string, kind: K, input?: MailboxPage) {
    const page = paging(tenant, kind, input);
    // One indexed field, no scans or deployment-specific composite index required.
    let query = this.collection(tenant, kind)
      .orderBy(page.field)
      .where(page.field, ">=", page.prefix)
      .where(page.field, "<", `${page.prefix}~`);
    if (page.after) query = query.startAfter(page.after);
    const docs = await query
      .limit(page.limit + 1)
      .select("value", page.field)
      .get();
    return result<K>(
      docs.docs.map((d) => ({ value: d.get("value"), key: d.get(page.field) })),
      page,
    );
  }
  async commit(
    tenant: string,
    changes: Change[],
    condition?: { connectionId: string; revision: number },
  ) {
    const batch = prepared(tenant, changes);
    if (condition) identity(tenant, "connections", condition.connectionId);
    await this.db.runTransaction(async (tx) => {
      const refs = batch.map((c) =>
        this.collection(tenant, c.kind).doc(`i_${c.value.id}`),
      );
      const conditionRef = condition
        ? this.collection(tenant, "connections").doc(
            `i_${condition.connectionId}`,
          )
        : null;
      // Every read precedes every write; Firebase may rerun this pure transaction.
      const docs = await tx.getAll(
        ...refs,
        ...(conditionRef ? [conditionRef] : []),
      );
      const storedRevision = (i: number) =>
        docs[i]!.exists
          ? (JSON.parse(docs[i]!.get("value")).revision as number)
          : null;
      if (condition && storedRevision(batch.length) !== condition.revision)
        throw conflict();
      for (const [i, change] of batch.entries())
        if (storedRevision(i) !== change.expectedRevision) throw conflict();
      for (const [i, change] of batch.entries())
        tx.set(refs[i]!, {
          value: change.json,
          queueKey: change.queueKey,
          connectionQueueKey: change.connectionQueueKey,
        });
    });
  }
}
