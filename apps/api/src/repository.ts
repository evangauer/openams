import { createHash } from "node:crypto";
import type {
  AmsAudit,
  AmsCommandResult,
  AmsData,
  AmsKind,
  AmsList,
  AmsPage,
  AmsRecord,
} from "@openams/contracts";

export class AmsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface AmsReceipt {
  actorId: string;
  hash: string;
  result: AmsCommandResult;
}
export type AmsQuery = AmsList & { accountIds?: string[] };
export interface AmsTransaction {
  accountEpoch(id: string): Promise<number>;
  advanceAccountEpoch(id: string): Promise<number>;
  get<K extends AmsKind>(kind: K, id: string): Promise<AmsRecord<K> | null>;
  revision(kind: AmsKind, id: string, revision: number): Promise<AmsRecord | null>;
  put(record: AmsRecord): void;
  receipt(id: string): Promise<AmsReceipt | null>;
  saveReceipt(id: string, value: AmsReceipt): void;
  nextSequence(): Promise<number>;
  unique(key: string, recordId: string): Promise<void>;
  audit(value: AmsAudit): void;
}
export interface AmsRepository {
  dueReminders(
    tenantId: string,
    date: string,
    limit?: number,
  ): Promise<AmsRecord<"reminders">[]>;
  get<K extends AmsKind>(
    tenantId: string,
    kind: K,
    id: string,
  ): Promise<AmsRecord<K> | null>;
  list<K extends AmsKind>(
    tenantId: string,
    kind: K,
    options: AmsQuery,
  ): Promise<AmsPage<AmsRecord<K>>>;
  history(
    tenantId: string,
    accountId?: string | string[],
    before?: number,
    limit?: number,
  ): Promise<AmsPage<AmsAudit>>;
  revision(
    tenantId: string,
    kind: AmsKind,
    id: string,
    revision: number,
  ): Promise<AmsRecord | null>;
  transact<T>(
    tenantId: string,
    action: (transaction: AmsTransaction) => Promise<T>,
  ): Promise<T>;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
export function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export function versioned<K extends AmsKind>(
  record: Omit<AmsRecord<K>, "version">,
): AmsRecord<K> {
  return { ...record, version: digest(record) };
}
export function accountOf(record: AmsRecord): string | null {
  return record.kind === "accounts"
    ? record.id
    : "accountId" in record.data
      ? record.data.accountId
      : null;
}
export function listFingerprint(
  tenantId: string,
  kind: AmsKind,
  options: AmsQuery,
) {
  const { cursor: _cursor, ...filters } = options;
  return digest({ tenantId, kind, filters });
}
export function decodeCursor(
  cursor: string | undefined,
  fingerprint: string,
): string | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      value.fingerprint !== fingerprint ||
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)
    )
      throw new Error();
    return value.id;
  } catch {
    throw new AmsError(
      400,
      "invalid_cursor",
      "Restart this search; the page cursor no longer matches the filters.",
    );
  }
}
export function encodeCursor(id: string, fingerprint: string) {
  return Buffer.from(JSON.stringify({ id, fingerprint })).toString("base64url");
}
export function matches(record: AmsRecord, options: AmsQuery): boolean {
  if (record.archivedAt && options.includeArchived !== "true") return false;
  const data = record.data as AmsData & Record<string, unknown>;
  if (options.accountIds) {
    if (!options.accountIds.includes(accountOf(record) || "")) return false;
  } else if (options.accountId && accountOf(record) !== options.accountId)
    return false;
  if (options.status && (data.status ?? data.stage) !== options.status)
    return false;
  if (
    options.ownerId &&
    (data.ownerId ?? data.serviceOwnerId ?? data.producerId) !== options.ownerId
  )
    return false;
  if (
    options.query &&
    !JSON.stringify(data)
      .toLocaleLowerCase("en-US")
      .includes(options.query.toLocaleLowerCase("en-US"))
  )
    return false;
  return true;
}
export const revisionKey = (
  record: Pick<AmsRecord, "kind" | "id" | "revision">,
) => `${record.kind}_${record.id}_${record.revision}`;

/** Resolve one-level retained identities without erasing original foreign keys. */
export async function accountScope(
  repository: AmsRepository,
  tenantId: string,
  id: string,
) {
  let account = await repository.get(tenantId, "accounts", id);
  if (!account) throw new AmsError(404, "not_found", "Account not found.");
  if (account.data.consolidation) {
    account = await repository.get(
      tenantId,
      "accounts",
      account.data.consolidation.targetId,
    );
    if (
      !account ||
      account.data.consolidation ||
      !account.data.consolidatedAccountIds.includes(id)
    )
      throw new AmsError(
        409,
        "invalid_consolidation",
        "The account consolidation requires administrator review.",
      );
  }
  return [account.id, ...(account.data.consolidatedAccountIds || [])];
}
export function auditMatchesAccount(
  audit: AmsAudit,
  scope?: string | string[],
) {
  return (
    !scope ||
    (Array.isArray(scope) ? scope : [scope]).some(
      (id) => audit.accountId === id || audit.accountIds?.includes(id),
    )
  );
}
