import { DatabaseSync } from "node:sqlite";
import {
  AmsAccountSchema,
  AmsCertificateSchema,
  AmsPolicySchema,
  AmsTaskSchema,
  type AmsAudit,
  type AmsKind,
  type AmsPage,
  type AmsRecord,
} from "@openams/contracts";
import {
  AmsError,
  auditMatchesAccount,
  type AmsQuery,
  decodeCursor,
  encodeCursor,
  listFingerprint,
  matches,
  revisionKey,
  type AmsReceipt,
  type AmsRepository,
  type AmsTransaction,
} from "./repository.js";

function hydrate<K extends AmsKind>(value: string): AmsRecord<K> {
  const record = JSON.parse(value) as AmsRecord<K>;
  if (record.kind === "certificates")
    record.data = AmsCertificateSchema.parse(
      record.data,
    ) as AmsRecord<K>["data"];
  if (record.kind === "accounts")
    record.data = AmsAccountSchema.parse(record.data) as AmsRecord<K>["data"];
  if (record.kind === "policies")
    record.data = AmsPolicySchema.parse(record.data) as AmsRecord<K>["data"];
  if (record.kind === "tasks")
    record.data = AmsTaskSchema.parse(record.data) as AmsRecord<K>["data"];
  return record;
}
/** Durable isolated-development adapter. Never selected by production's repository factory. */
export class SqliteAmsRepository implements AmsRepository {
  private db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS ams_records(tenant TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(tenant,kind,id));
      CREATE TABLE IF NOT EXISTS ams_receipts(tenant TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS ams_audit(tenant TEXT NOT NULL,sequence INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(tenant,sequence));
      CREATE TABLE IF NOT EXISTS ams_revisions(tenant TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(tenant,id));`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS ams_reminders_due ON ams_records(tenant, json_extract(value,'$.data.queueKey')) WHERE kind='reminders'",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS ams_account_epochs(tenant TEXT NOT NULL,id TEXT NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(tenant,id))",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS ams_keys(tenant TEXT NOT NULL,key TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(tenant,key))",
    );
  }
  async dueReminders(tenant: string, date: string, limit = 100) {
    return this.serial(() =>
      this.db
        .prepare(
          "SELECT value FROM ams_records WHERE tenant=? AND kind='reminders' AND json_extract(value,'$.data.queueKey') >= '0000' AND json_extract(value,'$.data.queueKey') <= ? ORDER BY json_extract(value,'$.data.queueKey') LIMIT ?",
        )
        .all(tenant, `${date}:~`, limit)
        .map((row) => hydrate<"reminders">(String(row.value))),
    );
  }
  private serial<T>(run: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private read<K extends AmsKind>(
    tenant: string,
    kind: K,
    id: string,
  ): AmsRecord<K> | null {
    const row = this.db
      .prepare(
        "SELECT value FROM ams_records WHERE tenant=? AND kind=? AND id=?",
      )
      .get(tenant, kind, id);
    return row ? hydrate<K>(String(row.value)) : null;
  }
  get<K extends AmsKind>(tenant: string, kind: K, id: string) {
    return this.serial(() => this.read(tenant, kind, id));
  }
  list<K extends AmsKind>(
    tenant: string,
    kind: K,
    options: AmsQuery,
  ): Promise<AmsPage<AmsRecord<K>>> {
    return this.serial(() => {
      const fingerprint = listFingerprint(tenant, kind, options);
      const after = decodeCursor(options.cursor, fingerprint) ?? "";
      const rows = this.db
        .prepare(
          "SELECT id,value FROM ams_records WHERE tenant=? AND kind=? AND id>? ORDER BY id LIMIT 1001",
        )
        .all(tenant, kind, after);
      const items: AmsRecord<K>[] = [];
      let last: string | null = null;
      for (const row of rows.slice(0, 1000)) {
        last = String(row.id);
        const record = hydrate<K>(String(row.value));
        if (matches(record, options)) items.push(record);
        if (items.length === options.limit)
          return { items, nextCursor: encodeCursor(last, fingerprint) };
      }
      return {
        items,
        nextCursor:
          rows.length > 1000 && last ? encodeCursor(last, fingerprint) : null,
      };
    });
  }
  history(
    tenant: string,
    accountId?: string | string[],
    before = Number.MAX_SAFE_INTEGER,
    limit = 50,
  ): Promise<AmsPage<AmsAudit>> {
    return this.serial(() => {
      const rows = this.db
        .prepare(
          "SELECT sequence,value FROM ams_audit WHERE tenant=? AND sequence<? ORDER BY sequence DESC LIMIT 501",
        )
        .all(tenant, before);
      const items: AmsAudit[] = [];
      let last: number | null = null;
      for (const row of rows.slice(0, 500)) {
        const audit = JSON.parse(String(row.value)) as AmsAudit;
        last = audit.sequence;
        if (auditMatchesAccount(audit, accountId)) items.push(audit);
        if (items.length === limit) break;
      }
      return {
        items,
        nextCursor:
          last && (rows.length > 500 || items.length === limit)
            ? String(last)
            : null,
      };
    });
  }
  revision(tenant: string, kind: AmsKind, id: string, revision: number) {
    return this.serial(() => {
      const row = this.db
        .prepare("SELECT value FROM ams_revisions WHERE tenant=? AND id=?")
        .get(tenant, revisionKey({ kind, id, revision }));
      return row ? hydrate(String(row.value)) : null;
    });
  }
  transact<T>(
    tenant: string,
    action: (transaction: AmsTransaction) => Promise<T>,
  ): Promise<T> {
    return this.serial(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const epoch = (id: string) =>
          Number(
            this.db
              .prepare(
                "SELECT epoch FROM ams_account_epochs WHERE tenant=? AND id=?",
              )
              .get(tenant, id)?.epoch ?? 0,
          );
        const result = await action({
          accountEpoch: async (id) => epoch(id),
          advanceAccountEpoch: async (id) => {
            const next = epoch(id) + 1;
            this.db
              .prepare(
                "INSERT INTO ams_account_epochs VALUES(?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET epoch=excluded.epoch",
              )
              .run(tenant, id, next);
            return next;
          },
          get: async <K extends AmsKind>(kind: K, id: string) =>
            this.read(tenant, kind, id),
          revision: async (kind, id, revision) => {
            const row = this.db
              .prepare(
                "SELECT value FROM ams_revisions WHERE tenant=? AND id=?",
              )
              .get(tenant, revisionKey({ kind, id, revision }));
            return row ? hydrate(String(row.value)) : null;
          },
          put: (record) => {
            const encoded = JSON.stringify(record);
            this.db
              .prepare(
                "INSERT INTO ams_records VALUES(?,?,?,?) ON CONFLICT(tenant,kind,id) DO UPDATE SET value=excluded.value",
              )
              .run(tenant, record.kind, record.id, encoded);
            this.db
              .prepare("INSERT INTO ams_revisions VALUES(?,?,?)")
              .run(tenant, revisionKey(record), encoded);
          },
          receipt: async (id) => {
            const row = this.db
              .prepare("SELECT value FROM ams_receipts WHERE tenant=? AND id=?")
              .get(tenant, id);
            return row ? (JSON.parse(String(row.value)) as AmsReceipt) : null;
          },
          saveReceipt: (id, value) => {
            this.db
              .prepare("INSERT INTO ams_receipts VALUES(?,?,?)")
              .run(tenant, id, JSON.stringify(value));
          },
          nextSequence: async () =>
            Number(
              this.db
                .prepare(
                  "SELECT COALESCE(MAX(sequence),0)+1 AS next FROM ams_audit WHERE tenant=?",
                )
                .get(tenant)!.next,
            ),
          unique: async (key, recordId) => {
            const row = this.db
              .prepare(
                "SELECT record_id FROM ams_keys WHERE tenant=? AND key=?",
              )
              .get(tenant, key);
            if (row && row.record_id !== recordId)
              throw new AmsError(
                409,
                "duplicate_record",
                "A record with this policy term, invoice number, or external identity already exists.",
              );
            this.db
              .prepare(
                "INSERT INTO ams_keys VALUES(?,?,?) ON CONFLICT(tenant,key) DO NOTHING",
              )
              .run(tenant, key, recordId);
          },
          audit: (audit) => {
            this.db
              .prepare("INSERT INTO ams_audit VALUES(?,?,?)")
              .run(tenant, audit.sequence, JSON.stringify(audit));
          },
        });
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  /**
   * Deletes everything one tenant stored in this file, in every table that has a
   * `tenant` column (records, history, chat, mailbox review). Only for demo sandboxes.
   */
  deleteTenant(tenant: string) {
    if (!/^local_demo_[a-f0-9]{24}$/.test(tenant))
      throw new Error("Only a demo tenant can be deleted.");
    return this.exclusive((db) => {
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => /^ams_[a-z_]+$/.test(name))
        .filter((name) =>
          (
            db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]
          ).some((column) => column.name === "tenant"),
        );
      db.exec("BEGIN");
      try {
        for (const name of tables)
          db.prepare(`DELETE FROM ${name} WHERE tenant=?`).run(tenant);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  /** Runs work on this connection between transactions; the chat store shares it. */
  exclusive<T>(run: (db: DatabaseSync) => T): Promise<T> {
    return this.serial(() => run(this.db));
  }
  close() {
    this.db.close();
  }
}
