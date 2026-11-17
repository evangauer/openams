import { createHash } from "node:crypto";
import {
  AMS_KINDS,
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
  FieldPath,
  type CollectionReference,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {
  AmsError,
  auditMatchesAccount,
  decodeCursor,
  encodeCursor,
  listFingerprint,
  matches,
  revisionKey,
  type AmsQuery,
  type AmsReceipt,
  type AmsRepository,
  type AmsTransaction,
} from "../repository.js";

/*
 * Firestore layout (all documents live under one tenant document):
 *
 *   {root}/{tenantId}/kinds/{kind}/records/i_{id}   { id, kind, queueKey, value }
 *   {root}/{tenantId}/revisions/{kind}_{id}_{rev}   { value }            (create-only)
 *   {root}/{tenantId}/receipts/{i_<id> | h_<sha>}   { id, value }        (create-only)
 *   {root}/{tenantId}/audit/{sequence:016}          { sequence, value }  (create-only)
 *   {root}/{tenantId}/keys/{sha256(key)}            { key, recordId }    (create-only)
 *   {root}/{tenantId}/epochs/{i_<id> | h_<sha>}     { id, epoch }
 *   {root}/{tenantId}/meta/counters                 { auditSequence }
 *
 * `value` is the exact JSON the SQLite adapter stores, so records round-trip
 * byte-for-byte (no Timestamp/undefined/integer coercion by Firestore).
 * Record documents use one collection per kind so list() is a single-field
 * document-id range scan and dueReminders() a single-field queueKey range scan;
 * neither needs a composite index.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESERVED_ID = /^__.*__$/;
const KINDS = new Set<string>(AMS_KINDS);
const MAX_SEQUENCE_DIGITS = 16; // Number.MAX_SAFE_INTEGER has 16 digits.

function hydrate<K extends AmsKind>(value: string): AmsRecord<K> {
  const record = JSON.parse(value) as AmsRecord<K>;
  if (record.kind === "certificates")
    record.data = AmsCertificateSchema.parse(record.data) as AmsRecord<K>["data"];
  if (record.kind === "accounts")
    record.data = AmsAccountSchema.parse(record.data) as AmsRecord<K>["data"];
  if (record.kind === "policies")
    record.data = AmsPolicySchema.parse(record.data) as AmsRecord<K>["data"];
  if (record.kind === "tasks")
    record.data = AmsTaskSchema.parse(record.data) as AmsRecord<K>["data"];
  return record;
}
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function assertTenant(tenantId: string) {
  if (
    typeof tenantId !== "string" ||
    !SAFE_ID.test(tenantId) ||
    RESERVED_ID.test(tenantId)
  )
    throw new AmsError(400, "invalid_tenant", "Invalid agency identifier.");
}
function assertKind(kind: string): asserts kind is AmsKind {
  if (!KINDS.has(kind))
    throw new AmsError(400, "invalid_kind", "Unknown record kind.");
}
/** Record document ids keep id ordering (common prefix) and avoid `__x__` reserved ids. */
const recordDocId = (id: string) => `i_${id}`;
/** Opaque ids: safe ones stay readable; anything else is hashed (distinct prefix, so no collisions). */
const opaqueDocId = (id: string) =>
  typeof id === "string" && SAFE_ID.test(id) ? `i_${id}` : `h_${sha256(String(id))}`;
const sequenceDocId = (sequence: number) => {
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new AmsError(500, "invalid_sequence", "Invalid audit sequence.");
  return String(sequence).padStart(MAX_SEQUENCE_DIGITS, "0");
};
function revisionDocId(record: Pick<AmsRecord, "kind" | "id" | "revision">) {
  assertKind(record.kind);
  if (!SAFE_ID.test(record.id) || !Number.isSafeInteger(record.revision))
    throw new AmsError(400, "invalid_record", "Invalid record identity.");
  return revisionKey(record);
}
const duplicate = () =>
  new AmsError(
    409,
    "duplicate_record",
    "A record with this policy term, invoice number, or external identity already exists.",
  );

/** Documents read per Firestore query while paging. */
const LIST_BATCH_SIZE = 200;
/** Most documents one list request may scan before returning a cursor. */
const LIST_SCAN_LIMIT = 1000;
/** Most stored JSON one list request may read before returning a cursor. */
const LIST_BYTE_BUDGET = 4 * 1024 * 1024;
/** Most audit entries one history request may scan before returning a cursor. */
const HISTORY_SCAN_LIMIT = 500;

/** Production adapter for Cloud Firestore. The Firestore instance is injected; this module never initializes firebase-admin. */
export class FirestoreAmsRepository implements AmsRepository {
  private root: string;
  constructor(
    private db: Firestore,
    options: { root?: string } = {},
  ) {
    const root = options.root ?? "tenants";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(root) || RESERVED_ID.test(root))
      throw new Error("Invalid Firestore root collection name.");
    this.root = root;
  }
  private tenant(tenantId: string): DocumentReference {
    assertTenant(tenantId);
    return this.db.collection(this.root).doc(tenantId);
  }
  private records(tenantId: string, kind: AmsKind): CollectionReference {
    assertKind(kind);
    return this.tenant(tenantId)
      .collection("kinds")
      .doc(kind)
      .collection("records");
  }
  private recordRef(tenantId: string, kind: AmsKind, id: string) {
    return this.records(tenantId, kind).doc(recordDocId(id));
  }
  private refs(tenantId: string) {
    const tenant = this.tenant(tenantId);
    return {
      revision: (key: string) => tenant.collection("revisions").doc(key),
      receipt: (id: string) =>
        tenant.collection("receipts").doc(opaqueDocId(id)),
      audit: (sequence: number) =>
        tenant.collection("audit").doc(sequenceDocId(sequence)),
      key: (key: string) => tenant.collection("keys").doc(sha256(key)),
      epoch: (id: string) => tenant.collection("epochs").doc(opaqueDocId(id)),
      counters: tenant.collection("meta").doc("counters"),
    };
  }
  async dueReminders(tenantId: string, date: string, limit = 100) {
    const snapshot = await this.records(tenantId, "reminders")
      .where("queueKey", ">=", "0000")
      .where("queueKey", "<=", `${date}:~`)
      .orderBy("queueKey")
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) =>
      hydrate<"reminders">(String(doc.get("value"))),
    );
  }
  async get<K extends AmsKind>(tenantId: string, kind: K, id: string) {
    const ref = this.records(tenantId, kind);
    if (typeof id !== "string" || !SAFE_ID.test(id)) return null;
    const doc = await ref.doc(recordDocId(id)).get();
    return doc.exists ? hydrate<K>(String(doc.get("value"))) : null;
  }
  async list<K extends AmsKind>(
    tenantId: string,
    kind: K,
    options: AmsQuery,
  ): Promise<AmsPage<AmsRecord<K>>> {
    const collection = this.records(tenantId, kind);
    const fingerprint = listFingerprint(tenantId, kind, options);
    const after = decodeCursor(options.cursor, fingerprint);
    const base = collection.orderBy(FieldPath.documentId());
    const items: AmsRecord<K>[] = [];
    let last: string | null = after;
    let lastDocId: string | null = after === null ? null : recordDocId(after);
    let scanned = 0;
    let bytes = 0;
    // Read in small batches and stop as soon as the page is full, so a page of
    // 25 never reads 1,000 documents. Scans that filter heavily are bounded by
    // a document count and a byte budget per request.
    while (scanned < LIST_SCAN_LIMIT && bytes < LIST_BYTE_BUDGET) {
      const want = Math.min(
        LIST_BATCH_SIZE,
        Math.max(options.limit - items.length + 1, 10),
        LIST_SCAN_LIMIT - scanned,
      );
      const query =
        lastDocId === null
          ? base
          : base.where(FieldPath.documentId(), ">", lastDocId);
      const { docs } = await query.limit(want).get();
      for (const doc of docs) {
        scanned += 1;
        lastDocId = doc.id;
        last = String(doc.get("id"));
        const value = String(doc.get("value"));
        bytes += value.length;
        const record = hydrate<K>(value);
        if (matches(record, options)) items.push(record);
        if (items.length === options.limit)
          return { items, nextCursor: encodeCursor(last, fingerprint) };
      }
      if (docs.length < want) return { items, nextCursor: null };
    }
    return {
      items,
      nextCursor: last === null ? null : encodeCursor(last, fingerprint),
    };
  }
  async history(
    tenantId: string,
    accountId?: string | string[],
    before = Number.MAX_SAFE_INTEGER,
    limit = 50,
  ): Promise<AmsPage<AmsAudit>> {
    const audit = this.tenant(tenantId)
      .collection("audit")
      .orderBy("sequence", "desc");
    const items: AmsAudit[] = [];
    let last: number | null = null;
    let cursor = before;
    let scanned = 0;
    while (scanned < HISTORY_SCAN_LIMIT) {
      const want = Math.min(
        LIST_BATCH_SIZE,
        Math.max(limit - items.length + 1, 10),
        HISTORY_SCAN_LIMIT - scanned,
      );
      const { docs } = await audit
        .where("sequence", "<", cursor)
        .limit(want)
        .get();
      for (const doc of docs) {
        scanned += 1;
        const entry = JSON.parse(String(doc.get("value"))) as AmsAudit;
        last = entry.sequence;
        cursor = entry.sequence;
        if (auditMatchesAccount(entry, accountId)) items.push(entry);
        if (items.length === limit) return { items, nextCursor: String(last) };
      }
      if (docs.length < want) return { items, nextCursor: null };
    }
    return { items, nextCursor: last === null ? null : String(last) };
  }
  async revision(
    tenantId: string,
    kind: AmsKind,
    id: string,
    revision: number,
  ) {
    const refs = this.refs(tenantId);
    assertKind(kind);
    if (
      typeof id !== "string" ||
      !SAFE_ID.test(id) ||
      !Number.isSafeInteger(revision)
    )
      return null;
    const doc = await refs.revision(revisionKey({ kind, id, revision })).get();
    return doc.exists ? hydrate(String(doc.get("value"))) : null;
  }
  async transact<T>(
    tenantId: string,
    action: (transaction: AmsTransaction) => Promise<T>,
  ): Promise<T> {
    const refs = this.refs(tenantId);
    // The SDK may run this callback more than once (contention retries), so every
    // buffer is created per attempt. Nothing reaches Firestore until the action
    // resolves; a thrown error discards the attempt with no writes.
    return this.db.runTransaction(async (tx) => {
      const attempt = new BufferedAttempt(tx, refs, (kind, id) =>
        this.recordRef(tenantId, kind, id),
      );
      const result = await action(attempt.api());
      await attempt.flush();
      return result;
    }).catch((error: unknown) => {
      // A create-only document (revision, receipt, audit, unique key) already
      // existed at commit time: another writer got there first. Nothing was written.
      if ((error as { code?: unknown })?.code === 6)
        throw new AmsError(
          409,
          "write_conflict",
          "Another change was saved at the same time. Reload and try again.",
        );
      throw error;
    });
  }
}

type Refs = ReturnType<FirestoreAmsRepository["refs"]>;
class BufferedAttempt {
  private records = new Map<string, { record: AmsRecord; value: string }>();
  private revisions = new Map<string, string>();
  private receipts = new Map<string, string>();
  private audits = new Map<number, string>();
  private keys = new Map<string, string>();
  private epochs = new Map<string, number>();
  private storedEpochs = new Map<string, number>();
  private storedKeys = new Map<string, string | null>();
  private storedSequence: number | null = null;
  constructor(
    private tx: Transaction,
    private refs: Refs,
    private recordRef: (kind: AmsKind, id: string) => DocumentReference,
  ) {}
  private async read(ref: DocumentReference): Promise<DocumentSnapshot> {
    return this.tx.get(ref);
  }
  private async epoch(id: string) {
    const buffered = this.epochs.get(id);
    if (buffered !== undefined) return buffered;
    let stored = this.storedEpochs.get(id);
    if (stored === undefined) {
      const doc = await this.read(this.refs.epoch(id));
      stored = Number(doc.exists ? doc.get("epoch") : 0);
      this.storedEpochs.set(id, stored);
    }
    return stored;
  }
  api(): AmsTransaction {
    return {
      revision: async (kind, id, revision) => {
        assertKind(kind);
        if (!SAFE_ID.test(id) || !Number.isSafeInteger(revision) || revision < 1)
          return null;
        const key = revisionKey({ kind, id, revision });
        const buffered = this.revisions.get(key);
        if (buffered) return hydrate(buffered);
        const doc = await this.read(this.refs.revision(key));
        return doc.exists ? hydrate(doc.get("value")) : null;
      },
      accountEpoch: (id) => this.epoch(id),
      advanceAccountEpoch: async (id) => {
        const next = (await this.epoch(id)) + 1;
        this.epochs.set(id, next);
        return next;
      },
      get: async <K extends AmsKind>(kind: K, id: string) => {
        assertKind(kind);
        if (typeof id !== "string" || !SAFE_ID.test(id)) return null;
        const ref = this.recordRef(kind, id);
        const buffered = this.records.get(`${kind}/${id}`);
        if (buffered) return hydrate<K>(buffered.value);
        const doc = await this.read(ref);
        return doc.exists ? hydrate<K>(String(doc.get("value"))) : null;
      },
      put: (record) => {
        assertKind(record.kind);
        if (!SAFE_ID.test(record.id))
          throw new AmsError(400, "invalid_record", "Invalid record identity.");
        const key = revisionDocId(record);
        // Mirrors SQLite's revision primary key within the transaction; a clash with
        // an already-committed revision fails the commit (create precondition).
        if (this.revisions.has(key))
          throw new AmsError(
            409,
            "revision_conflict",
            "This record revision was already written.",
          );
        const value = JSON.stringify(record);
        this.records.set(`${record.kind}/${record.id}`, { record, value });
        this.revisions.set(key, value);
      },
      receipt: async (id) => {
        const buffered = this.receipts.get(id);
        if (buffered !== undefined) return JSON.parse(buffered) as AmsReceipt;
        const doc = await this.read(this.refs.receipt(id));
        return doc.exists
          ? (JSON.parse(String(doc.get("value"))) as AmsReceipt)
          : null;
      },
      saveReceipt: (id, value) => {
        if (this.receipts.has(id))
          throw new AmsError(
            409,
            "idempotency_conflict",
            "This request identifier was already used for another change.",
          );
        this.receipts.set(id, JSON.stringify(value));
      },
      nextSequence: async () => {
        if (this.storedSequence === null) {
          const doc = await this.read(this.refs.counters);
          this.storedSequence = Number(
            doc.exists ? (doc.get("auditSequence") ?? 0) : 0,
          );
        }
        return Math.max(this.storedSequence, ...this.audits.keys()) + 1;
      },
      unique: async (key, recordId) => {
        let existing = this.keys.get(key) ?? this.storedKeys.get(key);
        if (existing === undefined) {
          const doc = await this.read(this.refs.key(key));
          existing = doc.exists ? String(doc.get("recordId")) : null;
          this.storedKeys.set(key, existing);
        }
        if (existing !== null && existing !== recordId) throw duplicate();
        if (existing === null) this.keys.set(key, recordId);
      },
      audit: (audit) => {
        sequenceDocId(audit.sequence);
        if (this.audits.has(audit.sequence))
          throw new AmsError(
            409,
            "audit_conflict",
            "This audit sequence was already written.",
          );
        this.audits.set(audit.sequence, JSON.stringify(audit));
      },
    };
  }
  /**
   * Applies every buffered write to the Firestore transaction. Any read still
   * needed (the audit counter) happens first, so reads precede all writes.
   */
  async flush() {
    const { tx, refs } = this;
    if (this.audits.size && this.storedSequence === null) {
      const doc = await this.read(refs.counters);
      this.storedSequence = Number(
        doc.exists ? (doc.get("auditSequence") ?? 0) : 0,
      );
    }
    for (const { record, value } of this.records.values())
      tx.set(this.recordRef(record.kind, record.id), {
        id: record.id,
        kind: record.kind,
        queueKey:
          record.kind === "reminders"
            ? ((record.data as { queueKey?: string | null }).queueKey ?? null)
            : null,
        value,
      });
    for (const [key, value] of this.revisions)
      tx.create(refs.revision(key), { value });
    for (const [id, value] of this.receipts)
      tx.create(refs.receipt(id), { id, value });
    for (const [key, recordId] of this.keys)
      tx.create(refs.key(key), { key, recordId });
    for (const [id, epoch] of this.epochs)
      tx.set(refs.epoch(id), { id, epoch });
    if (this.audits.size) {
      for (const [sequence, value] of this.audits)
        tx.create(refs.audit(sequence), { sequence, value });
      const highest = Math.max(...this.audits.keys());
      if (highest > (this.storedSequence ?? 0))
        tx.set(refs.counters, { auditSequence: highest });
    }
  }
}
