import { createHash } from "node:crypto";
import { FieldValue, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import { AmsId, type AmsChatMessage } from "@openams/contracts";
import type { AmsChatStore } from "../chat.js";
import { AmsError } from "../repository.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sequenceKey = (sequence: number) => {
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new AmsError(400, "invalid_sequence", "Invalid chat position.");
  return String(sequence).padStart(16, "0");
};
const id = (value: string) => {
  const parsed = AmsId.safeParse(value);
  if (!parsed.success)
    throw new AmsError(400, "invalid_identifier", "Invalid chat identity.");
  return `i_${parsed.data}`;
};
const readMessage = (value: unknown): AmsChatMessage =>
  JSON.parse(String(value));

/**
 * One agency's hosted chat. Message IDs are unique across its conversations;
 * sequence numbers are contiguous within a conversation. A transaction writes
 * the immutable message, retry receipt and latest position together.
 *
 * Presence for the whole agency is one document, and one counter document records
 * that something changed, so an idle agency costs a reader two document reads per
 * check instead of several per teammate.
 *
 * Threads are opaque document keys. Messages page by a unique sequence field and unread
 * counts use a single-field author/sequence range, so no composite index or
 * unbounded history scan is required. Client access is denied by storage rules;
 * membership and direct-message participants are checked by the shared routes.
 */
export class FirestoreAmsChat implements AmsChatStore {
  constructor(
    private db: Firestore,
    private root = "tenants",
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(root) || /^__.*__$/.test(root))
      throw new Error("Invalid Firestore chat root.");
  }
  private agency(tenantId: string): DocumentReference {
    // Keep the agency document identical to the records/identity adapters.
    id(tenantId);
    if (/^__.*__$/.test(tenantId))
      throw new AmsError(400, "invalid_identifier", "Invalid agency identity.");
    return this.db.collection(this.root).doc(tenantId);
  }
  private thread(tenantId: string, conversation: string) {
    if (!conversation || conversation.length > 300)
      throw new AmsError(
        400,
        "invalid_conversation",
        "Invalid chat conversation.",
      );
    return this.agency(tenantId)
      .collection("chat_threads")
      .doc(`h_${hash(conversation)}`);
  }
  /** Agency-wide chat state: "presence" (member id to last seen) and "version". */
  private state(tenantId: string, name: "presence" | "version") {
    return this.agency(tenantId).collection("chat_state").doc(name);
  }
  async touch(tenantId: string, userId: string, at: string) {
    const ref = this.state(tenantId, "presence");
    const key = id(userId);
    // Not a transaction: everyone in the agency writes this document every few seconds,
    // and the worst a race can do is keep a timestamp a moment older than the newest.
    const previous = (await ref.get()).get("seen") as Record<string, string> | undefined;
    if (!previous?.[key] || previous[key] < at)
      await ref.set({ seen: { [key]: at } }, { merge: true });
  }
  async seen(tenantId: string) {
    const seen = ((await this.state(tenantId, "presence").get()).get("seen") ?? {}) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(seen).map(([key, at]) => [key.slice(2), String(at)]),
    );
  }
  async version(tenantId: string) {
    return Number((await this.state(tenantId, "version").get()).get("n") ?? 0);
  }
  async summary(tenantId: string, conversation: string, userId: string) {
    const thread = this.thread(tenantId, conversation);
    const [position, read] = await this.db.getAll(
      thread,
      thread.collection("chat_reads").doc(id(userId)),
    );
    return {
      last: position!.exists ? readMessage(position!.get("last")) : null,
      unread: await this.unreadFrom(
        thread,
        userId,
        Number(position!.get("sequence") ?? 0),
        Number(read!.get("sequence") ?? 0),
      ),
    };
  }
  async post(
    tenantId: string,
    conversation: string,
    input: Omit<AmsChatMessage, "sequence">,
  ) {
    const thread = this.thread(tenantId, conversation);
    const receipt = this.agency(tenantId)
      .collection("chat_receipts")
      .doc(id(input.id));
    id(input.authorId);
    return this.db.runTransaction(async (tx) => {
      const [previous, position] = await tx.getAll(receipt, thread);
      if (previous!.exists) {
        const saved = readMessage(previous!.get("value"));
        if (
          previous!.get("conversation") !== conversation ||
          saved.authorId !== input.authorId ||
          saved.body !== input.body
        )
          throw new AmsError(
            409,
            "chat_id_reused",
            "That message id was already used for a different message.",
          );
        return saved;
      }
      const sequence = Number(position!.get("sequence") ?? 0) + 1;
      const key = sequenceKey(sequence);
      const saved = { ...input, sequence };
      const value = JSON.stringify(saved);
      tx.create(thread.collection("chat_messages").doc(key), {
        value,
        sequence,
        authorSequenceKey: `${hash(input.authorId)}:${key}`,
      });
      tx.create(receipt, { conversation, value });
      tx.set(thread, { sequence, last: value });
      tx.set(this.state(tenantId, "version"), { n: FieldValue.increment(1) }, { merge: true });
      return saved;
    });
  }
  async messages(
    tenantId: string,
    conversation: string,
    page: { after?: number; before?: number; limit: number },
  ) {
    const messages = this.thread(tenantId, conversation).collection(
      "chat_messages",
    );
    const forward = page.after !== undefined;
    sequenceKey(page.after ?? page.before ?? 0);
    const query = forward
      ? messages.where("sequence", ">", page.after!).orderBy("sequence", "asc")
      : messages
          .where("sequence", "<", page.before ?? Number.MAX_SAFE_INTEGER)
          .orderBy("sequence", "desc");
    const snapshot = await query.limit(page.limit).get();
    const rows = snapshot.docs.map((doc) => readMessage(doc.get("value")));
    return forward ? rows : rows.reverse();
  }
  async last(tenantId: string, conversation: string) {
    const snapshot = await this.thread(tenantId, conversation).get();
    return snapshot.exists ? readMessage(snapshot.get("last")) : null;
  }
  async readMarker(tenantId: string, conversation: string, userId: string) {
    const snapshot = await this.thread(tenantId, conversation)
      .collection("chat_reads")
      .doc(id(userId))
      .get();
    return Number(snapshot.get("sequence") ?? 0);
  }
  async unread(tenantId: string, conversation: string, userId: string) {
    const thread = this.thread(tenantId, conversation);
    const [position, read] = await this.db.getAll(
      thread,
      thread.collection("chat_reads").doc(id(userId)),
    );
    return this.unreadFrom(
      thread,
      userId,
      Number(position!.get("sequence") ?? 0),
      Number(read!.get("sequence") ?? 0),
    );
  }
  /** Other people's messages after the marker; counts only when there could be any. */
  private async unreadFrom(thread: DocumentReference, userId: string, latest: number, read: number) {
    const marker = Math.min(latest, read);
    if (latest <= marker) return 0;
    const author = hash(userId);
    const own = await thread
      .collection("chat_messages")
      .where("authorSequenceKey", ">", `${author}:${sequenceKey(marker)}`)
      .where("authorSequenceKey", "<=", `${author}:${sequenceKey(latest)}`)
      .count()
      .get();
    return Math.max(0, latest - marker - own.data().count);
  }
  async markRead(
    tenantId: string,
    conversation: string,
    userId: string,
    sequence: number,
  ) {
    sequenceKey(sequence);
    const thread = this.thread(tenantId, conversation);
    const ref = thread.collection("chat_reads").doc(id(userId));
    await this.db.runTransaction(async (tx) => {
      const [position, read] = await tx.getAll(thread, ref);
      const next = Math.min(sequence, Number(position!.get("sequence") ?? 0));
      if (next > Number(read!.get("sequence") ?? 0)) {
        tx.set(ref, { sequence: next });
        tx.set(this.state(tenantId, "version"), { n: FieldValue.increment(1) }, { merge: true });
      }
    });
  }
}
