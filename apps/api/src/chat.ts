import type { DatabaseSync } from "node:sqlite";
import type { Request, RequestHandler, Response, Router } from "express";
import {
  AMS_CHAT_TEAM,
  AmsChatHistorySchema,
  AmsChatPostSchema,
  AmsChatPulseSchema,
  AmsChatReadSchema,
  AmsId,
  amsChatDirectThread,
  type AmsActor,
  type AmsChatHistory,
  type AmsChatMessage,
  type AmsChatPulse,
  type AmsMember,
} from "@openams/contracts";
import { AmsError } from "./repository.js";
import { parseAms } from "./service.js";

/**
 * Where team chat lives. Conversations are stored under a stable key: "team", or
 * "direct:<a>:<b>" with the two member ids sorted, so both people share one thread.
 */
export interface AmsChatStore {
  /** Record that a member has OpenAMS open in front of them. */
  touch(tenantId: string, userId: string, at: string): Promise<void>;
  /** Member id to the last time they were seen. */
  seen(tenantId: string): Promise<Record<string, string>>;
  /** Saves a message once; a retry with the same id returns the saved message. */
  post(
    tenantId: string,
    conversation: string,
    message: Omit<AmsChatMessage, "sequence">,
  ): Promise<AmsChatMessage>;
  messages(
    tenantId: string,
    conversation: string,
    page: { after?: number; before?: number; limit: number },
  ): Promise<AmsChatMessage[]>;
  last(tenantId: string, conversation: string): Promise<AmsChatMessage | null>;
  /** Messages from other people after the reader's marker. */
  unread(
    tenantId: string,
    conversation: string,
    userId: string,
  ): Promise<number>;
  readMarker(
    tenantId: string,
    conversation: string,
    userId: string,
  ): Promise<number>;
  /** Moves the marker forward only. */
  markRead(
    tenantId: string,
    conversation: string,
    userId: string,
    sequence: number,
  ): Promise<void>;
  /** A conversation's latest message and the reader's unread count, read together. */
  summary(
    tenantId: string,
    conversation: string,
    userId: string,
  ): Promise<{ last: AmsChatMessage | null; unread: number }>;
  /**
   * A number that grows whenever anything a summary could show changes for this agency:
   * a new message, or a read marker moving. Equal versions mean nothing changed, so a
   * reader's summaries can be reused without reading every conversation again.
   */
  version(tenantId: string): Promise<number>;
}

/** How long chat routes reuse an agency's member list before reading it again. */
const ROSTER_MS = 30_000;
export const directConversation = (a: string, b: string) =>
  `direct:${[a, b].sort().join(":")}`;

type Row = Record<string, unknown>;
const message = (row: Row): AmsChatMessage => ({
  id: String(row.id),
  authorId: String(row.author),
  body: String(row.body),
  createdAt: String(row.created_at),
  sequence: Number(row.seq),
});

/** Runs work on a shared SQLite connection, between (never inside) its transactions. */
export interface SqliteExclusive {
  exclusive<T>(run: (db: DatabaseSync) => T): Promise<T>;
}

/**
 * Durable local adapter. It shares the agency database's connection and write queue:
 * a record save holds the write lock while it works, and a second connection would
 * stall the server waiting on it. Sharing the file also keeps chat in backups.
 */
export class SqliteAmsChat implements AmsChatStore {
  private ready: Promise<void>;
  constructor(private database: SqliteExclusive) {
    this.ready = database.exclusive((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS ams_chat_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant TEXT NOT NULL,id TEXT NOT NULL,conversation TEXT NOT NULL,author TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tenant,id));
        CREATE INDEX IF NOT EXISTS ams_chat_thread ON ams_chat_messages(tenant,conversation,seq);
        CREATE TABLE IF NOT EXISTS ams_chat_reads(tenant TEXT NOT NULL,user_id TEXT NOT NULL,conversation TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(tenant,user_id,conversation));
        CREATE TABLE IF NOT EXISTS ams_chat_presence(tenant TEXT NOT NULL,user_id TEXT NOT NULL,seen_at TEXT NOT NULL,PRIMARY KEY(tenant,user_id));`);
    });
  }
  private run<T>(work: (db: DatabaseSync) => T) {
    return this.ready.then(() => this.database.exclusive(work));
  }
  touch(tenant: string, userId: string, at: string) {
    return this.run((db) => {
      db.prepare(
        "INSERT INTO ams_chat_presence(tenant,user_id,seen_at) VALUES(?,?,?) ON CONFLICT(tenant,user_id) DO UPDATE SET seen_at=excluded.seen_at WHERE excluded.seen_at > seen_at",
      ).run(tenant, userId, at);
    });
  }
  seen(tenant: string) {
    return this.run((db) =>
      Object.fromEntries(
        db
          .prepare(
            "SELECT user_id, seen_at FROM ams_chat_presence WHERE tenant=?",
          )
          .all(tenant)
          .map((row) => [String(row.user_id), String(row.seen_at)]),
      ),
    );
  }
  post(
    tenant: string,
    conversation: string,
    input: Omit<AmsChatMessage, "sequence">,
  ) {
    return this.run((db) => {
      const existing = db
        .prepare("SELECT * FROM ams_chat_messages WHERE tenant=? AND id=?")
        .get(tenant, input.id);
      if (existing) {
        if (
          existing.conversation !== conversation ||
          existing.author !== input.authorId ||
          existing.body !== input.body
        )
          throw new AmsError(
            409,
            "chat_id_reused",
            "That message id was already used for a different message.",
          );
        return message(existing);
      }
      const row = db
        .prepare(
          "INSERT INTO ams_chat_messages(tenant,id,conversation,author,body,created_at) VALUES(?,?,?,?,?,?) RETURNING *",
        )
        .get(
          tenant,
          input.id,
          conversation,
          input.authorId,
          input.body,
          input.createdAt,
        );
      return message(row!);
    });
  }
  messages(
    tenant: string,
    conversation: string,
    page: { after?: number; before?: number; limit: number },
  ) {
    return this.run((db) =>
      page.after !== undefined
        ? db
            .prepare(
              "SELECT * FROM ams_chat_messages WHERE tenant=? AND conversation=? AND seq>? ORDER BY seq LIMIT ?",
            )
            .all(tenant, conversation, page.after, page.limit)
            .map(message)
        : db
            .prepare(
              "SELECT * FROM ams_chat_messages WHERE tenant=? AND conversation=? AND seq<? ORDER BY seq DESC LIMIT ?",
            )
            .all(
              tenant,
              conversation,
              page.before ?? Number.MAX_SAFE_INTEGER,
              page.limit,
            )
            .map(message)
            .reverse(),
    );
  }
  last(tenant: string, conversation: string) {
    return this.run((db) => {
      const row = db
        .prepare(
          "SELECT * FROM ams_chat_messages WHERE tenant=? AND conversation=? ORDER BY seq DESC LIMIT 1",
        )
        .get(tenant, conversation);
      return row ? message(row) : null;
    });
  }
  readMarker(tenant: string, conversation: string, userId: string) {
    return this.run((db) => marker(db, tenant, conversation, userId));
  }
  unread(tenant: string, conversation: string, userId: string) {
    return this.run((db) => {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n FROM ams_chat_messages WHERE tenant=? AND conversation=? AND author<>? AND seq>?",
        )
        .get(
          tenant,
          conversation,
          userId,
          marker(db, tenant, conversation, userId),
        );
      return Number(row?.n ?? 0);
    });
  }
  async summary(tenant: string, conversation: string, userId: string) {
    return {
      last: await this.last(tenant, conversation),
      unread: await this.unread(tenant, conversation, userId),
    };
  }
  version(tenant: string) {
    // Message sequences and read markers only ever grow, so their sum does too.
    return this.run((db) =>
      Number(
        db
          .prepare(
            "SELECT (SELECT COALESCE(MAX(seq),0) FROM ams_chat_messages WHERE tenant=?) + (SELECT COALESCE(SUM(seq),0) FROM ams_chat_reads WHERE tenant=?) AS v",
          )
          .get(tenant, tenant)?.v ?? 0,
      ),
    );
  }
  markRead(
    tenant: string,
    conversation: string,
    userId: string,
    sequence: number,
  ) {
    return this.run((db) => {
      const latest = Number(
        db
          .prepare(
            "SELECT MAX(seq) AS seq FROM ams_chat_messages WHERE tenant=? AND conversation=?",
          )
          .get(tenant, conversation)?.seq ?? 0,
      );
      db.prepare(
        "INSERT INTO ams_chat_reads(tenant,user_id,conversation,seq) VALUES(?,?,?,?) ON CONFLICT(tenant,user_id,conversation) DO UPDATE SET seq=excluded.seq WHERE excluded.seq > seq",
      ).run(tenant, userId, conversation, Math.min(sequence, latest));
    });
  }
}
function marker(
  db: DatabaseSync,
  tenant: string,
  conversation: string,
  userId: string,
) {
  const row = db
    .prepare(
      "SELECT seq FROM ams_chat_reads WHERE tenant=? AND user_id=? AND conversation=?",
    )
    .get(tenant, userId, conversation);
  return row ? Number(row.seq) : 0;
}

/**
 * Chat routes. Every active member can talk to the team and to each other active
 * member; a one-to-one thread is readable only by its two people.
 */
export function mountChatRoutes(
  router: Router,
  {
    chat,
    members,
    handle,
  }: {
    chat: AmsChatStore;
    members: (tenantId: string) => Promise<AmsMember[]>;
    handle: (
      action: (
        request: Request,
        response: Response,
        actor: AmsActor,
      ) => Promise<void>,
    ) => RequestHandler;
  },
) {
  // An open chat asks who is on the team every few seconds. Remember the answer briefly;
  // when it would refuse someone or hide a teammate, ask again first, so a person who
  // just joined is never turned away by a remembered list.
  const rosters = new Map<string, { at: number; value: Promise<AmsMember[]> }>();
  function roster(tenantId: string, fresh = false) {
    const hit = rosters.get(tenantId);
    if (!fresh && hit && Date.now() - hit.at < ROSTER_MS) return hit.value;
    const value = members(tenantId);
    if (rosters.size >= 5000) rosters.clear();
    rosters.set(tenantId, { at: Date.now(), value });
    value.catch(() => {
      if (rosters.get(tenantId)?.value === value) rosters.delete(tenantId);
    });
    return value;
  }
  const isActive = (all: AmsMember[], actor: AmsActor) =>
    all.some((member) => member.id === actor.userId && member.active);
  // What each reader's last pulse showed, reused while the agency's chat version (and
  // the team) is unchanged: an idle chat then costs a version read, not every thread.
  const summaries = new Map<string, { version: number; team: string; threads: AmsChatPulse["threads"] }>();
  async function team(actor: AmsActor) {
    let all = await roster(actor.tenantId);
    if (!isActive(all, actor)) all = await roster(actor.tenantId, true);
    if (!isActive(all, actor))
      throw new AmsError(
        403,
        "chat_members_only",
        "Team chat is for active members of this agency.",
      );
    return all;
  }
  /** The stored conversation behind a route, after checking the reader may see it. */
  async function conversation(
    request: Request,
    actor: AmsActor,
    writing: boolean,
  ) {
    let all = await team(actor);
    const memberId = request.params.memberId;
    if (memberId === undefined) return AMS_CHAT_TEAM;
    parseAms(AmsId, memberId);
    let other = all.find((member) => member.id === memberId);
    // Before refusing, or before writing to someone, make sure the list is current.
    if (memberId !== actor.userId && (!other || writing)) {
      all = await roster(actor.tenantId, true);
      other = all.find((member) => member.id === memberId);
    }
    if (!other || other.id === actor.userId || (writing && !other.active))
      throw new AmsError(404, "not_found", "Teammate not found.");
    return directConversation(actor.userId, other.id);
  }

  router.post(
    "/ams/chat/pulse",
    handle(async (request, response, actor) => {
      const { active } = parseAms(AmsChatPulseSchema, request.body ?? {});
      const all = await team(actor);
      const now = new Date().toISOString();
      if (active) await chat.touch(actor.tenantId, actor.userId, now);
      const others = all.filter(
        (member) => member.active && member.id !== actor.userId,
      );
      // Read the version before the threads: if something lands in between, the stored
      // version is older than the threads and the next pulse simply reads them again.
      const [version, seen] = await Promise.all([
        chat.version(actor.tenantId),
        chat.seen(actor.tenantId),
      ]);
      const reader = `${actor.tenantId}\n${actor.userId}`;
      const teamKey = others.map((member) => member.id).join("\n");
      const kept = summaries.get(reader);
      let threads = kept?.version === version && kept.team === teamKey ? kept.threads : null;
      if (!threads) {
        threads = await Promise.all(
          [
            { thread: AMS_CHAT_TEAM, key: AMS_CHAT_TEAM },
            ...others.map((member) => ({
              thread: amsChatDirectThread(member.id),
              key: directConversation(actor.userId, member.id),
            })),
          ].map(async ({ thread, key }) => ({
            thread,
            ...(await chat.summary(actor.tenantId, key, actor.userId)),
          })),
        );
        if (summaries.size >= 20_000) summaries.clear();
        summaries.set(reader, { version, team: teamKey, threads });
      }
      const ids = new Set(all.filter((m) => m.active).map((m) => m.id));
      response.json({
        now,
        seen: Object.fromEntries(
          Object.entries(seen).filter(([id]) => ids.has(id)),
        ),
        threads,
      } satisfies AmsChatPulse);
    }),
  );
  for (const path of ["/ams/chat/team", "/ams/chat/direct/:memberId"]) {
    router.get(
      `${path}/messages`,
      handle(async (request, response, actor) => {
        const key = await conversation(request, actor, false);
        const page = parseAms(AmsChatHistorySchema, request.query);
        response.json({
          messages: await chat.messages(actor.tenantId, key, page),
          read: await chat.readMarker(actor.tenantId, key, actor.userId),
        } satisfies AmsChatHistory);
      }),
    );
    router.post(
      `${path}/messages`,
      handle(async (request, response, actor) => {
        const key = await conversation(request, actor, true);
        const input = parseAms(AmsChatPostSchema, request.body);
        const saved = await chat.post(actor.tenantId, key, {
          id: input.id,
          authorId: actor.userId,
          body: input.body,
          createdAt: new Date().toISOString(),
        });
        // Your own message is read by definition.
        await chat.markRead(actor.tenantId, key, actor.userId, saved.sequence);
        response.json(saved);
      }),
    );
    router.post(
      `${path}/read`,
      handle(async (request, response, actor) => {
        const key = await conversation(request, actor, false);
        const { sequence } = parseAms(AmsChatReadSchema, request.body);
        await chat.markRead(actor.tenantId, key, actor.userId, sequence);
        response.json({ ok: true });
      }),
    );
  }
}
