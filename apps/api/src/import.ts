import { z } from "zod";
import {
  AmsAccountSchema,
  AmsPolicySchema,
  AMS_DATA_SCHEMAS,
  AmsImportOriginSchema,
  AmsListSchema,
  type AmsActor,
  type AmsRecord,
  type AmsPage,
} from "@openams/contracts";
import { AmsError, digest, type AmsRepository } from "./repository.js";
import { AmsService, parseAms } from "./service.js";

export const AmsImportSchema = z
  .object({
    source: z.string().trim().min(1).max(80),
    kind: z.enum([
      "accounts",
      "policies",
      "contacts",
      "exposures",
      "notes",
      "tasks",
    ]),
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(250),
  })
  .strict();
export type AmsImport = z.infer<typeof AmsImportSchema>;
export interface AmsImportRow {
  line: number;
  identity: string;
  status: "ready" | "existing" | "error";
  message: string;
  recordId?: string;
  data?: Record<string, unknown>;
}
export interface AmsImportPlan {
  kind: AmsImport["kind"];
  source: string;
  fingerprint: string;
  rows: AmsImportRow[];
  ready: number;
  existing: number;
  errors: number;
  premiumCents: number;
}
async function all(
  repository: AmsRepository,
  tenant: string,
  kind: AmsImport["kind"],
) {
  const records: AmsRecord[] = [];
  let cursor: string | null = null;
  do {
    const page: AmsPage<AmsRecord> = await repository.list(
      tenant,
      kind,
      AmsListSchema.parse({
        limit: 100,
        includeArchived: "true",
        ...(cursor ? { cursor } : {}),
      }),
    );
    records.push(...page.items);
    cursor = page.nextCursor;
    if (records.length > 50_000)
      throw new AmsError(
        413,
        "migration_too_large",
        "Use the managed migration process for books larger than 50,000 records.",
      );
  } while (cursor);
  return records;
}
export async function planImport(
  actor: AmsActor,
  input: unknown,
  repository: AmsRepository,
): Promise<AmsImportPlan> {
  if (!["admin", "manager"].includes(actor.role))
    throw new AmsError(
      403,
      "manager_required",
      "An agency administrator or manager must review imports.",
    );
  const request = parseAms(AmsImportSchema, input);
  const accounts = await all(repository, actor.tenantId, "accounts");
  const policies = ["policies", "notes", "tasks"].includes(request.kind)
    ? await all(repository, actor.tenantId, "policies")
    : [];
  const related = !["accounts", "policies"].includes(request.kind)
    ? await all(repository, actor.tenantId, request.kind)
    : [];
  const seen = new Set<string>();
  const rows: AmsImportRow[] = request.rows.map((raw, index) => {
    const line = index + 2;
    try {
      if (request.kind === "accounts") {
        const data = parseAms(AmsAccountSchema, {
          ...raw,
          source: request.source,
        });
        if (!data.externalId)
          throw new Error(
            "Each account needs its stable external ID from the source system.",
          );
        if (data.leadIds.length)
          throw new Error("Quote links cannot be supplied by an import.");
        if (data.producerId || data.serviceOwnerId)
          throw new Error(
            "Assign agency team members after this import; external user IDs are not agency identities.",
          );
        if (data.email && !z.string().email().safeParse(data.email).success)
          throw new Error("Correct the email address.");
        if (data.status === "archived")
          throw new Error(
            "Import active, inactive or prospect relationships; archival requires a separate reviewed action.",
          );
        const identity = data.externalId;
        if (seen.has(identity))
          throw new Error("Duplicate external ID inside this file.");
        seen.add(identity);
        const found = accounts.find((record) => {
          const account = record.data as AmsRecord<"accounts">["data"];
          return (
            account.source.toLowerCase() === request.source.toLowerCase() &&
            account.externalId === identity
          );
        });
        return {
          line,
          identity,
          status: found ? "existing" : "ready",
          message: found
            ? "Already imported; the current record will be preserved."
            : "New account",
          ...(found ? { recordId: found.id } : {}),
          data,
        };
      }
      const { accountExternalId, ...values } = raw;
      if (typeof accountExternalId !== "string" || !accountExternalId)
        throw new Error(
          "Supply accountExternalId to match an imported account.",
        );
      const account = accounts.find((record) => {
        const data = record.data as AmsRecord<"accounts">["data"];
        return (
          data.source.toLowerCase() === request.source.toLowerCase() &&
          data.externalId === accountExternalId
        );
      });
      if (!account || account.archivedAt)
        throw new Error(
          "Import the active account from this source before its related records.",
        );
      if (request.kind !== "policies") {
        const {
          externalId,
          sourceCreatedAt,
          sourceAuthor,
          policyNumber,
          policyCarrier,
          policyEffectiveDate,
          ...fields
        } = values;
        if (
          ["accountId", "policyId", "renewalId", "importOrigin"].some(
            (key) => key in fields,
          )
        )
          throw new Error(
            "Use external account and policy identities; internal links and source attribution are resolved by the import.",
          );
        const origin = parseAms(AmsImportOriginSchema, {
          source: request.source,
          externalId,
          sourceCreatedAt: sourceCreatedAt || null,
          sourceAuthor: sourceAuthor || "",
        });
        if (seen.has(origin.externalId))
          throw new Error("Duplicate external ID inside this file.");
        seen.add(origin.externalId);
        let policyId: string | null = null;
        if (policyNumber || policyCarrier || policyEffectiveDate) {
          if (!["notes", "tasks"].includes(request.kind))
            throw new Error("Policy links are supported on notes and tasks.");
          if (
            ![policyNumber, policyCarrier, policyEffectiveDate].every(
              (value) => typeof value === "string" && value.trim(),
            )
          )
            throw new Error(
              "Supply policyNumber, policyCarrier and policyEffectiveDate together to link a policy term.",
            );
          const policy = policies.find((record) => {
            const data = record.data as AmsRecord<"policies">["data"];
            return (
              !record.archivedAt &&
              data.accountId === account.id &&
              data.number.toLowerCase() ===
                String(policyNumber).toLowerCase() &&
              data.carrier.toLowerCase() ===
                String(policyCarrier).toLowerCase() &&
              data.effectiveDate === policyEffectiveDate
            );
          });
          if (!policy)
            throw new Error(
              "Import the matching policy term before linking this activity.",
            );
          policyId = policy.id;
        }
        const data = parseAms(
          AMS_DATA_SCHEMAS[request.kind] as z.ZodType<Record<string, unknown>>,
          {
            ...fields,
            accountId: account.id,
            importOrigin: origin,
            ...(["notes", "tasks"].includes(request.kind) ? { policyId } : {}),
          },
        );
        if (
          request.kind === "tasks" &&
          (data.ownerId ||
            data.status !== "open" ||
            data.completedAt ||
            data.completedBy)
        )
          throw new Error(
            "Import open tasks without external user IDs. Assign an active agency owner after review; preserve completed activity as source-attributed notes.",
          );
        const found = related.find((record) => {
          const prior = (record.data as Record<string, unknown>)
            .importOrigin as z.infer<typeof AmsImportOriginSchema> | null;
          return (
            prior?.source.toLowerCase() === request.source.toLowerCase() &&
            prior.externalId === origin.externalId
          );
        });
        if (
          found &&
          (found.data as Record<string, unknown>).accountId !== account.id
        )
          throw new Error(
            "This source identity already belongs to another account. Resolve the source mapping before importing.",
          );
        return {
          line,
          identity: origin.externalId,
          status: found ? "existing" : "ready",
          message: found
            ? "Already imported; the current record and original attribution will be preserved."
            : `New ${request.kind === "notes" ? "source-attributed activity" : request.kind.slice(0, -1)}`,
          ...(found ? { recordId: found.id } : {}),
          data,
        };
      }
      const data = parseAms(AmsPolicySchema, {
        ...values,
        accountId: account.id,
      });
      if (
        data.status !== "draft" ||
        data.cancellationDate ||
        data.nonrenewal ||
        data.previousPolicyId ||
        data.sourceDocumentId
      )
        throw new Error(
          "Imported terms begin as drafts. Review source evidence and record issuance separately.",
        );
      if (data.producerId || data.carrierId || data.exposureIds.length)
        throw new Error(
          "Link agency team members, carrier connections and exposures after import.",
        );
      const identity = `${accountExternalId}:${data.carrier.toLowerCase()}:${data.number.toLowerCase()}:${data.effectiveDate}`;
      if (seen.has(identity))
        throw new Error("Duplicate policy term inside this file.");
      seen.add(identity);
      const found = policies.find((record) => {
        const p = record.data as AmsRecord<"policies">["data"];
        return (
          p.accountId === account.id &&
          p.number.toLowerCase() === data.number.toLowerCase() &&
          p.carrier.toLowerCase() === data.carrier.toLowerCase() &&
          p.effectiveDate === data.effectiveDate
        );
      });
      return {
        line,
        identity,
        status: found ? "existing" : "ready",
        message: found
          ? "Matching policy term already exists; it will be preserved."
          : "New draft term — issuance review required",
        ...(found ? { recordId: found.id } : {}),
        data: {
          ...data,
          sourceReference:
            data.sourceReference ||
            `Imported from ${request.source}; account ${accountExternalId}`,
        },
      };
    } catch (error) {
      return {
        line,
        identity: String(raw.externalId || raw.number || ""),
        status: "error",
        message: error instanceof Error ? error.message : "Invalid row",
      };
    }
  });
  return {
    kind: request.kind,
    source: request.source,
    fingerprint: digest(request),
    rows,
    ready: rows.filter((r) => r.status === "ready").length,
    existing: rows.filter((r) => r.status === "existing").length,
    errors: rows.filter((r) => r.status === "error").length,
    premiumCents: rows
      .filter((r) => r.status === "ready")
      .reduce((sum, r) => sum + Number(r.data?.premiumCents || 0), 0),
  };
}
function rowCommandId(fingerprint: string, index: number) {
  const hex = digest({ fingerprint, index });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function applyImport(
  actor: AmsActor,
  input: unknown,
  repository: AmsRepository,
  service: AmsService,
  expectedFingerprint: unknown,
) {
  const plan = await planImport(actor, input, repository);
  if (plan.fingerprint !== expectedFingerprint)
    throw new AmsError(
      409,
      "import_changed",
      "The import changed after review. Validate the file again.",
    );
  if (plan.errors)
    throw new AmsError(
      422,
      "import_invalid",
      "Correct every invalid row before applying this import. No rows were imported.",
    );
  const outcomes: {
    line: number;
    status: "created" | "existing" | "error";
    recordId?: string;
    message: string;
  }[] = [];
  for (const row of plan.rows) {
    if (row.status === "existing") {
      outcomes.push({
        line: row.line,
        status: "existing",
        recordId: row.recordId,
        message: row.message,
      });
      continue;
    }
    try {
      const command = {
        id: rowCommandId(plan.fingerprint, row.line),
        kind: plan.kind,
        action: "create" as const,
        data: row.data!,
        reason: `Reviewed ${plan.source} import; CSV row ${row.line}; batch ${plan.fingerprint.slice(0, 12)}`,
      };
      const result = ["accounts", "policies"].includes(plan.kind)
        ? await service.execute(actor, command)
        : await service.createImportedRecord(actor, command);
      outcomes.push({
        line: row.line,
        status: "created",
        recordId: result.records[0].id,
        message: result.replayed
          ? "Recovered prior successful import."
          : "Imported.",
      });
    } catch (error) {
      outcomes.push({
        line: row.line,
        status: "error",
        message:
          error instanceof AmsError
            ? error.message
            : "The result is unconfirmed. Retry this exact file to reconcile it safely.",
      });
      break;
    }
  }
  return {
    fingerprint: plan.fingerprint,
    outcomes,
    totalRows: plan.rows.length,
    processedRows: outcomes.length,
    created: outcomes.filter((r) => r.status === "created").length,
    existing: outcomes.filter((r) => r.status === "existing").length,
    errors: outcomes.filter((r) => r.status === "error").length,
    complete:
      outcomes.length === plan.rows.length &&
      !outcomes.some((r) => r.status === "error"),
  };
}
