import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  amsBasisPoints,
  amsPolicyStatusAt,
  amsCalendarDate,
  AmsTimeZone,
  AmsSuggestionSchema,
  AmsTaskFollowUpSchema,
  AmsWorkspaceProfileSchema,
  AMS_DATA_SCHEMAS,
  AmsCommandSchema,
  AmsDate,
  AmsSignedCents,
  AmsId,
  AmsEndorsementChangeSchema,
  AmsCertificatePreparationSchema,
  AmsCertificateDeliverySchema,
  AmsFormFilingSchema,
  AmsFormLinkId,
  AmsFormSubmissionSchema,
  amsFormValueText,
  amsCanRead,
  amsCanWrite,
  type AmsActor,
  type AmsAudit,
  type AmsCommand,
  type AmsCommandResult,
  type AmsData,
  type AmsKind,
  type AmsMember,
  type AmsRecord,
} from "@openams/contracts";
import {
  AmsError,
  accountOf,
  digest,
  versioned,
  type AmsRepository,
  type AmsTransaction,
} from "./repository.js";

import {
  calendarDays,
  nextTaskDate,
  reminderId,
  taskReminders,
  taskScheduleKey,
} from "./task-follow-up.js";

type Schemas = typeof AMS_DATA_SCHEMAS;
const immutableKinds: AmsKind[] = [
  "workspace",
  "certificatetemplates",
  "documents",
  "payments",
  "journals",
  "reminders",
  "correspondence",
  "formsubmissions",
];
/** What the public form endpoint hands over once a submission has been checked. */
const FormReceipt = AmsFormSubmissionSchema.pick({
  lines: true,
  contact: true,
  sections: true,
  files: true,
  digest: true,
})
  .extend({ submissionId: z.string().uuid() })
  .strict();
export type AmsFormReceipt = z.input<typeof FormReceipt>;
/** A submission as plain text, for the note left on the account it is filed to. */
function submissionText(submission: AmsData<"formsubmissions">) {
  const lines = [`Form submission: ${submission.formName}`];
  if (submission.lines.length)
    lines.push(
      `Coverage requested: ${submission.lines.map((line) => line.label).join(", ")}`,
    );
  for (const section of submission.sections)
    section.items.forEach((item, index) => {
      lines.push(
        "",
        section.noun
          ? `${section.title}: ${item.title || `${section.noun} ${index + 1}`}`
          : section.title,
      );
      for (const answer of item.answers)
        lines.push(`${answer.label}: ${amsFormValueText(answer.value, answer.type)}`);
    });
  if (submission.files.length)
    lines.push("", `Files: ${submission.files.map((file) => file.name).join(", ")}`);
  const text = lines.join("\n");
  return text.length > 20_000 ? `${text.slice(0, 19_990)}\n[…]` : text;
}
type SubmissionItem =
  AmsData<"formsubmissions">["sections"][number]["items"][number];
function submissionAddress(item: SubmissionItem | undefined) {
  const value = item?.answers.find((answer) => answer.type === "address")?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    line1: value.line1,
    line2: value.line2,
    city: value.city,
    state: value.state.toUpperCase(),
    postalCode: value.postalCode,
    country: "US",
  };
}
const nonterminalRenewals = new Set([
  "review",
  "collecting",
  "marketing",
  "proposal",
  "waiting",
]);
const text = z.string().trim().min(1).max(2000);
export interface AmsServiceDependencies {
  repository: AmsRepository;
  members: (tenantId: string) => Promise<AmsMember[]>;
  now?: () => Date;
  createId?: () => string;
  certificateTemplates?: (tenantId: string) => Promise<string[]>;
  timeZone?: (tenantId: string) => Promise<string>;
}
export function parseAms<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new AmsError(
    400,
    "invalid_request",
    `${issue?.path.join(".") || "Request"}: ${issue?.message || "invalid value"}`,
  );
}
export class AmsService {
  constructor(private deps: AmsServiceDependencies) {}
  async execute(actor: AmsActor, input: unknown): Promise<AmsCommandResult> {
    return this.run(actor, input, false);
  }
  /** Only the authenticated upload service supplies verified immutable file metadata. */
  async createDocument(
    actor: AmsActor,
    input: AmsCommand,
  ): Promise<AmsCommandResult> {
    if (input.action !== "create" || input.kind !== "documents")
      throw new AmsError(400, "invalid_upload", "Invalid document operation.");
    return this.run(actor, input, true);
  }
  /** Only the PDF ingestion/rendering routes may attest to template bytes or a generated draft. */
  async registerCertificateTemplate(actor: AmsActor, input: AmsCommand) {
    if (input.action !== "create" || input.kind !== "certificatetemplates")
      throw new AmsError(
        400,
        "invalid_template",
        "Invalid template operation.",
      );
    return this.run(actor, input, false, false, false, false, true);
  }
  async prepareCertificate(actor: AmsActor, input: AmsCommand) {
    if (input.action !== "certificate.prepare" || input.kind !== "certificates")
      throw new AmsError(
        400,
        "invalid_preparation",
        "Invalid certificate operation.",
      );
    return this.run(actor, input, false, false, false, false, true);
  }
  /** Reviewed imports may retain source attribution, never impersonate an audit actor. */
  async createImportedRecord(
    actor: AmsActor,
    input: AmsCommand,
  ): Promise<AmsCommandResult> {
    if (!["admin", "manager"].includes(actor.role))
      throw new AmsError(
        403,
        "manager_required",
        "An agency administrator or manager must review imports.",
      );
    if (
      input.action !== "create" ||
      !["contacts", "exposures", "notes", "tasks"].includes(input.kind) ||
      !input.data.importOrigin
    )
      throw new AmsError(
        400,
        "invalid_import",
        "Invalid attributed import operation.",
      );
    return this.run(actor, input, false, true);
  }
  /** Internal in-app work only. No carrier actions, email sends or other external effects. */
  async processDueReminders(tenantId: string, limit = 100) {
    const actor: AmsActor = {
      tenantId,
      userId: "ams_scheduler",
      name: "Agency reminders",
      role: "admin",
    };
    const now = this.deps.now?.() ?? new Date();
    const zone = parseAms(
      AmsTimeZone,
      (await this.deps.repository.get(tenantId, "workspace", "agency"))?.data
        .timeZone ??
        (await this.deps.timeZone?.(tenantId)) ??
        "UTC",
    );
    const jobs = await this.deps.repository.dueReminders(
      tenantId,
      amsCalendarDate(now, zone),
      Math.max(1, Math.min(limit, 100)),
    );
    const results: AmsCommandResult[] = [];
    let conflicts = 0;
    for (const job of jobs) {
      try {
        results.push(
          await this.run(
            actor,
            {
              id: randomUUID(),
              action: "reminder.deliver",
              kind: "reminders",
              recordId: job.id,
              expectedVersion: job.version,
              data: {},
              reason: "Process due in-app reminder",
            },
            false,
            false,
            true,
          ),
        );
      } catch (error) {
        if (error instanceof AmsError && error.code === "stale_record")
          conflicts++;
        else throw error;
      }
    }
    return {
      processed: results.length,
      conflicts,
      more: jobs.length === limit,
      records: results.flatMap((result) => result.records),
    };
  }
  /** Only the publish route, which holds the public link index, may assign a link. */
  async publishForm(actor: AmsActor, command: AmsCommand) {
    if (command.action !== "form.publish" || command.kind !== "forms")
      throw new AmsError(400, "invalid_publish", "Invalid form operation.");
    return this.run(actor, command, false, false, false, false, false, true);
  }
  /**
   * Saves a checked submission from the public form endpoint and opens its follow-up
   * task. Nothing else is created until a person files the submission to an account.
   */
  async receiveFormSubmission(
    tenantId: string,
    form: Pick<AmsRecord<"forms">, "id" | "version">,
    input: AmsFormReceipt,
  ) {
    const actor: AmsActor = {
      tenantId,
      userId: "ams_forms",
      name: "Hosted form",
      role: "admin",
    };
    return this.run(
      actor,
      {
        id: input.submissionId,
        action: "formSubmission.receive",
        kind: "forms",
        recordId: form.id,
        expectedVersion: form.version,
        data: input,
        reason: "",
      },
      false,
      false,
      false,
      false,
      false,
      true,
    );
  }
  async fileCorrespondence(actor: AmsActor, command: AmsCommand) {
    if (command.action !== "correspondence.file" || command.kind !== "accounts")
      throw new AmsError(
        400,
        "invalid_filing",
        "Invalid email filing operation.",
      );
    return this.run(actor, command, false, false, false, true);
  }
  private async run(
    actor: AmsActor,
    input: unknown,
    verifiedDocument: boolean,
    verifiedImport = false,
    verifiedWorker = false,
    verifiedCorrespondence = false,
    verifiedCertificate = false,
    verifiedForm = false,
  ): Promise<AmsCommandResult> {
    const command = parseAms(AmsCommandSchema, input);
    if (
      !amsCanWrite(
        actor.role,
        verifiedCorrespondence ? "correspondence" : command.kind,
      )
    )
      throw new AmsError(
        403,
        "permission_denied",
        "Your role cannot change these records.",
      );
    if (command.action === "reminder.deliver" && !verifiedWorker)
      throw new AmsError(
        403,
        "worker_required",
        "Only the reminder processor can deliver reminders.",
      );
    if (command.action === "correspondence.file" && !verifiedCorrespondence)
      throw new AmsError(
        403,
        "verified_email_required",
        "File the original email through the email import or mailbox workflow.",
      );
    if (command.action === "certificate.prepare" && !verifiedCertificate)
      throw new AmsError(
        403,
        "renderer_required",
        "Prepare the PDF through the certificate workflow.",
      );
    if (
      (command.action === "form.publish" ||
        command.action === "formSubmission.receive") &&
      !verifiedForm
    )
      throw new AmsError(
        403,
        "form_workflow_required",
        "Publish forms and receive submissions through the form workflow.",
      );
    const approvedTemplates = command.action.startsWith("certificate.")
      ? ((await this.deps.certificateTemplates?.(actor.tenantId)) ?? [])
      : [];
    const members = await this.deps.members(actor.tenantId);
    const memberIds = new Set(
      members.filter((member) => member.active).map((member) => member.id),
    );
    const now = (this.deps.now?.() ?? new Date()).toISOString();
    const configuredWorkspace = await this.deps.repository.get(
      actor.tenantId,
      "workspace",
      "agency",
    );
    const timeZone = parseAms(
      AmsTimeZone,
      configuredWorkspace?.data.timeZone ??
        (command.action === "workspace.configure"
          ? command.data.timeZone
          : ((await this.deps.timeZone?.(actor.tenantId)) ?? "UTC")),
    );
    const createId = this.deps.createId ?? randomUUID;
    const fingerprint = digest(command);
    return this.deps.repository.transact(actor.tenantId, async (tx) => {
      const receipt = await tx.receipt(command.id);
      if (receipt) {
        if (receipt.actorId !== actor.userId || receipt.hash !== fingerprint)
          throw new AmsError(
            409,
            "idempotency_conflict",
            "This request identifier was already used for another change.",
          );
        return { ...receipt.result, replayed: true };
      }
      const records: AmsRecord[] = [];
      const workspace = await tx.get("workspace", "agency");
      const businessDate = amsCalendarDate(
        new Date(now),
        workspace?.data.timeZone ?? timeZone,
      );
      const previousVersions = new Map<string, string | null>();
      const requireRecord = async <K extends AmsKind>(
        kind: K,
        id: string,
        includeArchived = false,
      ): Promise<AmsRecord<K>> => {
        const record = await tx.get(kind, id);
        if (!record || (!includeArchived && record.archivedAt))
          throw new AmsError(
            404,
            "not_found",
            "This record does not exist in your agency or has been archived.",
          );
        return record;
      };
      const approvePreparation = async (
        preparation: z.infer<typeof AmsCertificatePreparationSchema>,
      ) => {
        if (preparation.templateId) {
          const template = await requireRecord(
            "certificatetemplates",
            preparation.templateId,
          );
          if (
            !template.data.revokedAt &&
            template.data.sha256 === preparation.templateSha256
          )
            return;
        } else if (approvedTemplates.includes(preparation.templateSha256))
          return;
        throw new AmsError(
          409,
          "certificate_template_not_approved",
          "This form edition is no longer approved. Prepare a new draft with an authorized template.",
        );
      };
      const canonicalAccount = async (id: string) => {
        const account = await requireRecord("accounts", id);
        if (!account.data.consolidation) return account;
        const target = await requireRecord(
          "accounts",
          account.data.consolidation.targetId,
        );
        if (
          target.data.consolidation ||
          !target.data.consolidatedAccountIds.includes(id)
        )
          throw new AmsError(
            409,
            "invalid_consolidation",
            "The account consolidation requires administrator review.",
          );
        return target;
      };
      const sameAccount = async (left: string, right: string) =>
        left === right ||
        (await canonicalAccount(left)).id ===
          (await canonicalAccount(right)).id;
      const validate = async <K extends AmsKind>(
        kind: K,
        data: AmsData<K>,
        id: string,
      ) => {
        const values = data as Record<string, unknown>;
        const accountId =
          typeof values.accountId === "string"
            ? values.accountId
            : kind === "accounts"
              ? id
              : null;
        if (kind !== "accounts" && kind !== "reminders" && accountId)
          await canonicalAccount(accountId);
        if (
          kind === "accounts" &&
          values.email &&
          !z.string().email().safeParse(values.email).success
        )
          throw new AmsError(
            422,
            "invalid_email",
            "Correct the account email address before saving. The original imported value remains unchanged.",
          );
        for (const field of ["ownerId", "producerId", "serviceOwnerId"])
          if (
            kind !== "reminders" &&
            values[field] &&
            !memberIds.has(String(values[field]))
          )
            throw new AmsError(
              422,
              "invalid_owner",
              "Choose an active member of this agency.",
            );
        const checkReference = async (
          relatedKind: AmsKind,
          relatedId: unknown,
        ) => {
          if (typeof relatedId !== "string" || !relatedId) return;
          const related = await requireRecord(relatedKind, relatedId);
          if (
            accountId &&
            accountOf(related) !== accountId &&
            (!accountOf(related) ||
              (await canonicalAccount(accountOf(related)!)).id !==
                (await canonicalAccount(accountId)).id)
          )
            throw new AmsError(
              422,
              "account_mismatch",
              "Related policies, documents, and work must belong to the same account.",
            );
        };
        await checkReference("policies", values.policyId);
        await checkReference("policies", values.previousPolicyId);
        await checkReference("renewals", values.renewalId);
        await checkReference("documents", values.sourceDocumentId);
        await checkReference("documents", values.documentId);
        await checkReference("documents", values.supersedesId);
        if (kind === "certificates" && values.serviceId) {
          await checkReference("services", values.serviceId);
          const request = await requireRecord(
            "services",
            String(values.serviceId),
          );
          if (request.data.type !== "certificate")
            throw new AmsError(
              422,
              "certificate_service_required",
              "Choose a certificate service request for this account.",
            );
        }
        await checkReference("invoices", values.invoiceId);
        await checkReference("commissions", values.adjustsCommissionId);
        for (const [field, relatedKind] of [
          ["policyIds", "policies"],
          ["replacementPolicyIds", "policies"],
          ["documentIds", "documents"],
          ["exposureIds", "exposures"],
        ] as const) {
          const ids = values[field];
          if (Array.isArray(ids)) {
            if (new Set(ids).size !== ids.length)
              throw new AmsError(
                422,
                "duplicate_reference",
                "Select each related record once.",
              );
            for (const relatedId of ids)
              await checkReference(relatedKind, relatedId);
          }
        }
        if (kind === "accounts") {
          const account = data as AmsData<"accounts">;
          for (const collection of [
            account.insuredEntities,
            account.customFields,
          ]) {
            if (
              new Set(collection.map((item) => item.id)).size !==
              collection.length
            )
              throw new AmsError(
                422,
                "duplicate_identity",
                "Give each entity and custom field its own identity.",
              );
          }
          if (
            new Set(
              account.customFields.map((field) => field.label.toLowerCase()),
            ).size !== account.customFields.length
          )
            throw new AmsError(
              422,
              "duplicate_field",
              "Use a distinct label for each custom field.",
            );
          if (
            new Set(account.relationships.map((item) => item.accountId))
              .size !== account.relationships.length
          )
            throw new AmsError(
              422,
              "duplicate_relationship",
              "Record each related account once.",
            );
          const ownRoot = account.consolidation?.targetId || id;
          for (const relationship of account.relationships) {
            const other = await canonicalAccount(relationship.accountId);
            if (other.id === ownRoot || relationship.accountId === id)
              throw new AmsError(
                422,
                "self_relationship",
                "Choose a different account for this relationship.",
              );
          }
          const previous = await tx.get("accounts", id);
          if (
            previous?.data.insuredEntities.some(
              (entity) =>
                !account.insuredEntities.some((item) => item.id === entity.id),
            )
          )
            throw new AmsError(
              422,
              "entity_history_required",
              "Mark an insured entity inactive instead of deleting its identity.",
            );
        }
        if (kind === "policies") {
          const policy = data as AmsData<"policies">;
          await tx.unique(
            `policy:${policy.accountId}:${policy.carrier.toLowerCase()}:${policy.number.toLowerCase()}:${policy.effectiveDate}`,
            id,
          );
        }
        if (kind === "statements") {
          const statement = data as AmsData<"statements">;
          await tx.unique(
            `statement:${statement.carrier.toLowerCase()}:${statement.reference.toLowerCase()}`,
            id,
          );
        }
        if (kind === "invoices")
          await tx.unique(`invoice:${String(values.number).toLowerCase()}`, id);
        if (kind === "accounts" && values.externalId)
          await tx.unique(
            `account:${String(values.source).toLowerCase()}:${values.externalId}`,
            id,
          );
        if (values.importOrigin) {
          const origin = values.importOrigin as {
            source: string;
            externalId: string;
          };
          await tx.unique(
            `import:${kind}:${digest([origin.source.toLowerCase(), origin.externalId])}`,
            id,
          );
        }
        if (kind === "claims") {
          const date = String(values.dateOfLoss);
          const reported = String(values.reportedDate);
          if (date > businessDate || reported > businessDate)
            throw new AmsError(
              422,
              "future_claim_date",
              "Record a loss already reported to the agency. Loss and reported dates cannot be later than today.",
            );
          if (reported < date)
            throw new AmsError(
              422,
              "invalid_claim_dates",
              "The date reported to the agency must be on or after the loss date.",
            );
          const policy = await requireRecord(
            "policies",
            String(values.policyId),
          );
          if (
            date < policy.data.effectiveDate ||
            date >= policy.data.expirationDate ||
            amsPolicyStatusAt(policy.data, date) === "cancelled"
          )
            throw new AmsError(
              422,
              "loss_outside_term",
              "The loss date is outside this recorded policy term. Select the applicable term; coverage is not being determined here.",
            );
        }
      };
      const save = async <K extends AmsKind>(
        kind: K,
        value: unknown,
        previous?: AmsRecord<K>,
        options: { id?: string; archivedAt?: string | null } = {},
      ): Promise<AmsRecord<K>> => {
        let data = parseAms(
          AMS_DATA_SCHEMAS[kind] as unknown as z.ZodType<AmsData<K>>,
          value,
        );
        if (Buffer.byteLength(JSON.stringify(data)) > 128_000)
          throw new AmsError(
            413,
            "record_too_large",
            "Keep each record under 128 KB; attach supporting files as documents.",
          );
        const id = previous?.id ?? options.id ?? createId();
        const previousTask =
          kind === "tasks"
            ? (previous as AmsRecord<"tasks"> | undefined)
            : undefined;
        let scheduleChanged = false;
        if (kind === "tasks") {
          const candidate = {
            ...previous,
            id,
            data,
            archivedAt:
              options.archivedAt === undefined
                ? (previous?.archivedAt ?? null)
                : options.archivedAt,
          } as AmsRecord<"tasks">;
          const d = data as AmsData<"tasks">;
          const hasReminders =
            d.followUp.reminderDaysBefore !== null ||
            d.followUp.escalationAfterDays !== null;
          scheduleChanged = previousTask
            ? taskScheduleKey(candidate) !== taskScheduleKey(previousTask) &&
              (previousTask.data.reminderGeneration > 0 || hasReminders)
            : hasReminders;
          data = {
            ...d,
            reminderGeneration:
              (previousTask?.data.reminderGeneration ?? 0) +
              (scheduleChanged ? 1 : 0),
          } as AmsData<K>;
          if (
            (d.followUp.reminderDaysBefore !== null ||
              d.followUp.escalationAfterDays !== null ||
              d.followUp.repeatEveryDays !== null) &&
            !d.ownerId
          )
            throw new AmsError(
              422,
              "owner_required",
              "Assign a task owner before enabling follow-ups.",
            );
          if (
            d.followUp.escalationOwnerId &&
            !members.some(
              (m) =>
                m.id === d.followUp.escalationOwnerId &&
                m.active &&
                ["admin", "manager"].includes(m.role),
            )
          )
            throw new AmsError(
              422,
              "invalid_escalation_owner",
              "Choose an active agency manager for escalation.",
            );
        }
        await validate(kind, data, id);
        const record = versioned({
          id,
          kind,
          revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          createdBy: previous?.createdBy ?? actor.userId,
          updatedBy: actor.userId,
          archivedAt:
            options.archivedAt === undefined
              ? (previous?.archivedAt ?? null)
              : options.archivedAt,
          data,
        });
        previousVersions.set(`${kind}:${id}`, previous?.version ?? null);
        tx.put(record);
        records.push(record);
        if (kind === "tasks" && scheduleChanged) {
          if (previousTask)
            for (const type of ["due", "escalation"] as const) {
              const old = await tx.get(
                "reminders",
                reminderId(id, previousTask.data.reminderGeneration, type),
              );
              if (old && !["dismissed", "cancelled"].includes(old.data.status))
                await save(
                  "reminders",
                  {
                    ...old.data,
                    status: "cancelled",
                    queueKey: null,
                    detail: "The task or its follow-up schedule changed.",
                  },
                  old,
                );
            }
          for (const reminder of taskReminders(record as AmsRecord<"tasks">))
            await save("reminders", reminder.data, undefined, {
              id: reminder.id,
            });
        }
        return record;
      };
      const journal = async (
        date: string,
        description: string,
        source: AmsRecord,
        entries: AmsData<"journals">["entries"],
        reversalOf: string | null = null,
      ) => {
        const filtered = entries.filter(
          (entry) => entry.debitCents || entry.creditCents,
        );
        if (!filtered.length) return;
        return save("journals", {
          date,
          description,
          sourceKind: source.kind,
          sourceId: source.id,
          accountId: accountOf(source),
          policyId: "policyId" in source.data ? source.data.policyId : null,
          reversalOf,
          entries: filtered,
        });
      };
      const receiveCommission = async (
        commission: AmsRecord<"commissions">,
        input: {
          amountCents: number;
          date: string;
          statementReference: string;
        },
      ) => {
        const policy = await requireRecord(
          "policies",
          commission.data.policyId,
        );
        if (policy.data.billing !== "direct")
          throw new AmsError(
            422,
            "direct_bill_required",
            "Agency-bill commission is recorded through invoice posting.",
          );
        if (input.date > businessDate)
          throw new AmsError(
            422,
            "future_transaction",
            "Record completed receipts using their actual transaction date.",
          );
        const remaining =
          commission.data.expectedCents - commission.data.receivedCents;
        if (
          Math.sign(remaining) !== Math.sign(input.amountCents) ||
          Math.abs(input.amountCents) > Math.abs(remaining)
        )
          throw new AmsError(
            422,
            "commission_mismatch",
            "The receipt must match the sign and remaining expected commission. Resolve the difference before posting.",
          );
        const total = commission.data.receivedCents + input.amountCents;
        const posted = await save(
          "commissions",
          {
            ...commission.data,
            receivedCents: total,
            hasReceipts: true,
            statementReference: input.statementReference,
            status:
              total === commission.data.expectedCents
                ? "reconciled"
                : "partial",
          },
          commission,
        );
        const amount = Math.abs(input.amountCents);
        await journal(
          input.date,
          `Direct-bill commission · ${input.statementReference}`,
          posted,
          input.amountCents > 0
            ? [
                debit("operating_cash", amount),
                credit("commission_income", amount),
              ]
            : [
                debit("commission_income", amount),
                credit("operating_cash", amount),
              ],
        );
      };
      const expectedCommission = async (
        policy: AmsRecord<"policies">,
        premiumCents: number,
        transactionDate: string,
        transaction: AmsData<"commissions">["transaction"],
      ) => {
        const expectedCents = amsBasisPoints(
          premiumCents,
          policy.data.commissionBps,
        );
        if (policy.data.billing !== "direct" || !expectedCents) return;
        await save("commissions", {
          accountId: policy.data.accountId,
          policyId: policy.id,
          carrier: policy.data.carrier,
          transaction,
          transactionDate,
          premiumCents,
          expectedCents,
          producerId: policy.data.producerId,
          notes: `Expected from recorded ${transaction.replaceAll("_", " ")} at ${policy.data.commissionBps / 100}% commission. Review against the carrier statement.`,
        });
      };
      const original =
        command.action === "workspace.configure"
          ? workspace
          : command.action === "create"
            ? null
            : command.recordId
              ? await requireRecord(
                  command.kind,
                  command.recordId,
                  command.action === "restore",
                )
              : null;
      if (
        command.action !== "create" &&
        !(command.action === "workspace.configure" && !original)
      ) {
        if (!original)
          throw new AmsError(
            400,
            "record_required",
            "Select the record to change.",
          );
        if (!command.expectedVersion)
          throw new AmsError(
            428,
            "version_required",
            "A current record version is required.",
          );
        if (original.version !== command.expectedVersion)
          throw new AmsError(
            409,
            "stale_record",
            "Someone changed this record. Refresh it and review your changes before saving again.",
          );
      }
      const reason = () => {
        if (!command.reason.trim())
          throw new AmsError(
            422,
            "reason_required",
            "Record the reason for this change.",
          );
        return command.reason;
      };

      if (
        command.action === "workspace.configure" &&
        command.kind === "workspace"
      ) {
        if (
          (command.recordId && command.recordId !== "agency") ||
          (!workspace && command.expectedVersion)
        )
          throw new AmsError(
            409,
            "stale_record",
            "Refresh agency setup before saving.",
          );
        const { calendarAcknowledged: _ack, ...profile } = parseAms(
          AmsWorkspaceProfileSchema.extend({
            calendarAcknowledged: z.literal(true),
          }).strict(),
          command.data,
        );
        if (
          profile.defaultOwnerId &&
          !members.some(
            (member) =>
              member.id === profile.defaultOwnerId &&
              member.active &&
              amsCanWrite(member.role, "tasks"),
          )
        )
          throw new AmsError(
            422,
            "invalid_owner",
            "Choose an active teammate with task access as the default owner.",
          );
        await save("workspace", profile, workspace ?? undefined, {
          id: "agency",
        });
      } else if (
        command.action === "correspondence.file" &&
        original?.kind === "accounts"
      ) {
        const payload = parseAms(
          z
            .object({
              message: AMS_DATA_SCHEMAS.correspondence.omit({
                filedBy: true,
                filedAt: true,
              }),
              documents: z
                .array(
                  z
                    .object({ id: AmsId, data: AMS_DATA_SCHEMAS.documents })
                    .strict(),
                )
                .min(1)
                .max(31),
              shareWithAgency: z.literal(true),
            })
            .strict(),
          command.data,
        );
        if (
          payload.message.accountId !== original.id ||
          payload.documents.some((d) => d.data.accountId !== original.id)
        )
          throw new AmsError(
            422,
            "account_mismatch",
            "The filed email must belong to this account.",
          );
        const id = `correspondence_${digest({ sha256: payload.message.sha256 }).slice(0, 48)}`;
        const existing = await tx.get("correspondence", id);
        if (existing)
          throw new AmsError(
            409,
            "email_already_filed",
            "This original email is already filed in this agency. Find it in Correspondence before filing another copy.",
          );
        await tx.unique(`correspondence:${payload.message.sha256}`, id);
        for (const document of payload.documents)
          await save("documents", document.data, undefined, {
            id: document.id,
          });
        await save(
          "correspondence",
          { ...payload.message, filedBy: actor.userId, filedAt: now },
          undefined,
          { id },
        );
      } else if (
        command.action === "account.startWorkflow" &&
        original?.kind === "accounts"
      ) {
        const account = original as AmsRecord<"accounts">;
        if (account.data.consolidation)
          throw new AmsError(
            409,
            "consolidated_account",
            "Start the workflow from the primary account.",
          );
        const input = parseAms(
          z
            .object({
              title: text,
              policyId: AmsId.nullable().default(null),
              renewalId: AmsId.nullable().default(null),
              steps: z
                .array(
                  z
                    .object({
                      title: text,
                      description: z.string().trim().max(10000).default(""),
                      ownerId: AmsId.nullable().default(null),
                      dueDate: AmsDate,
                      priority: z
                        .enum(["low", "normal", "high", "urgent"])
                        .default("normal"),
                    })
                    .strict(),
                )
                .min(1)
                .max(30),
            })
            .strict(),
          command.data,
        );
        for (const [index, step] of input.steps.entries())
          await save("tasks", {
            ...step,
            accountId: account.id,
            policyId: input.policyId,
            renewalId: input.renewalId,
            workflow: {
              id: command.id,
              title: input.title,
              step: index + 1,
              total: input.steps.length,
            },
          });
      } else if (
        command.action === "account.bulkAssign" &&
        original?.kind === "accounts"
      ) {
        if (!["admin", "manager"].includes(actor.role))
          throw new AmsError(
            403,
            "manager_required",
            "An agency administrator or manager must review team assignment.",
          );
        reason();
        const input = parseAms(
          z
            .object({
              accounts: z
                .array(
                  z
                    .object({
                      id: AmsId,
                      version: z.string().regex(/^[a-f0-9]{64}$/),
                    })
                    .strict(),
                )
                .min(1)
                .max(50),
              producerId: AmsId.nullable().optional(),
              serviceOwnerId: AmsId.nullable().optional(),
            })
            .strict(),
          command.data,
        );
        if (
          input.producerId === undefined &&
          input.serviceOwnerId === undefined
        )
          throw new AmsError(
            422,
            "no_changes",
            "Select an account team change.",
          );
        if (
          new Set(input.accounts.map((item) => item.id)).size !==
            input.accounts.length ||
          !input.accounts.some((item) => item.id === original.id)
        )
          throw new AmsError(
            422,
            "invalid_selection",
            "Review a distinct set of selected accounts.",
          );
        for (const selected of input.accounts) {
          const account = await requireRecord("accounts", selected.id);
          if (account.version !== selected.version)
            throw new AmsError(
              409,
              "stale_record",
              "An account changed. Refresh and review the selected accounts before assigning the team.",
            );
          if (account.data.consolidation)
            throw new AmsError(
              409,
              "consolidated_account",
              "Assign the team on primary accounts.",
            );
          await save(
            "accounts",
            {
              ...account.data,
              ...(input.producerId !== undefined
                ? { producerId: input.producerId }
                : {}),
              ...(input.serviceOwnerId !== undefined
                ? { serviceOwnerId: input.serviceOwnerId }
                : {}),
            },
            account,
          );
        }
      } else if (
        command.action === "account.consolidate" &&
        original?.kind === "accounts"
      ) {
        if (!["admin", "manager"].includes(actor.role))
          throw new AmsError(
            403,
            "manager_required",
            "An agency administrator or manager must review account consolidation.",
          );
        reason();
        const input = parseAms(
          z
            .object({
              targetId: AmsId,
              targetVersion: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
          command.data,
        );
        const source = original as AmsRecord<"accounts">;
        const target = await requireRecord("accounts", input.targetId);
        if (target.version !== input.targetVersion)
          throw new AmsError(
            409,
            "stale_record",
            "The destination account changed. Refresh and review both accounts.",
          );
        if (
          source.id === target.id ||
          source.data.consolidation ||
          target.data.consolidation ||
          source.data.consolidatedAccountIds.length
        )
          throw new AmsError(
            409,
            "invalid_consolidation",
            "Choose a standalone duplicate and a primary account. Consolidated groups cannot be nested.",
          );
        if (target.data.consolidatedAccountIds.length >= 20)
          throw new AmsError(
            422,
            "consolidation_limit",
            "This account has reached its 20 retained identities. Administrator review is required.",
          );
        const group = [
          target,
          ...(await Promise.all(
            target.data.consolidatedAccountIds.map((id) =>
              requireRecord("accounts", id),
            ),
          )),
        ];
        const allIds = new Set([source.id, ...group.map((item) => item.id)]);
        if (
          [source, ...group].some((item) =>
            item.data.relationships.some((link) => allIds.has(link.accountId)),
          )
        )
          throw new AmsError(
            422,
            "related_account_conflict",
            "These accounts have a business relationship. Review and remove that relationship before treating them as duplicates.",
          );
        const entityIds = group.flatMap((item) =>
          item.data.insuredEntities.map((entity) => entity.id),
        );
        if (
          source.data.insuredEntities.some((entity) =>
            entityIds.includes(entity.id),
          )
        )
          throw new AmsError(
            422,
            "entity_identity_conflict",
            "The accounts share an insured entity identity. Review the source records before consolidation.",
          );
        const epoch = await tx.accountEpoch(target.id);
        const primary = await save(
          "accounts",
          {
            ...target.data,
            consolidatedAccountIds: [
              ...target.data.consolidatedAccountIds,
              source.id,
            ],
          },
          target,
        );
        await save(
          "accounts",
          {
            ...source.data,
            consolidation: {
              targetId: target.id,
              at: now,
              by: actor.userId,
              targetEpoch: epoch + 1,
              targetVersion: primary.version,
              sourceProfileDigest: digest(source.data),
            },
          },
          source,
        );
      } else if (
        command.action === "account.undoConsolidation" &&
        original?.kind === "accounts"
      ) {
        if (!["admin", "manager"].includes(actor.role))
          throw new AmsError(
            403,
            "manager_required",
            "An agency administrator or manager must review account consolidation.",
          );
        reason();
        parseAms(z.object({}).strict(), command.data);
        const source = original as AmsRecord<"accounts">;
        const merge = source.data.consolidation;
        if (!merge)
          throw new AmsError(
            409,
            "not_consolidated",
            "This account is not consolidated.",
          );
        const target = await canonicalAccount(source.id);
        if (
          (await tx.accountEpoch(target.id)) !== merge.targetEpoch ||
          target.version !== merge.targetVersion ||
          digest({ ...source.data, consolidation: null }) !==
            merge.sourceProfileDigest
        )
          throw new AmsError(
            409,
            "consolidation_in_use",
            "Work has been recorded on this account since consolidation. Automatic undo is unavailable; a reviewed separation is required.",
          );
        await save("accounts", { ...source.data, consolidation: null }, source);
        await save(
          "accounts",
          {
            ...target.data,
            consolidatedAccountIds: target.data.consolidatedAccountIds.filter(
              (id) => id !== source.id,
            ),
          },
          target,
        );
      } else if (command.action === "create") {
        if (command.data.importOrigin && !verifiedImport)
          throw new AmsError(
            422,
            "reviewed_import_required",
            "Retain source attribution through the reviewed import workflow.",
          );
        if (command.kind === "policychanges")
          throw new AmsError(
            422,
            "lifecycle_required",
            "Schedule changes from the issued policy term.",
          );
        if (
          immutableKinds.includes(command.kind) &&
          !(command.kind === "documents" && verifiedDocument) &&
          !(command.kind === "certificatetemplates" && verifiedCertificate)
        )
          throw new AmsError(
            400,
            "specialized_action_required",
            "Use the document upload or financial posting workflow.",
          );
        this.requireInitialState(command.kind, command.data);
        if (
          command.kind === "accounts" &&
          Array.isArray(command.data.leadIds) &&
          command.data.leadIds.length
        )
          throw new AmsError(
            422,
            "server_owned_field",
            "Link quote work through the existing account/quote workflow.",
          );
        let creation = command.data;
        if (command.kind === "certificates" && creation.holderId) {
          const holder = await requireRecord(
            "certificateholders",
            String(creation.holderId),
          );
          creation = {
            ...creation,
            holderName: holder.data.name,
            holderAddress: holder.data.address,
            holderEmail: holder.data.email,
          };
        }
        await save(command.kind, creation);
      } else if (command.action === "update" && original) {
        if (
          immutableKinds.includes(command.kind) ||
          command.kind === "notes" ||
          command.kind === "statements" ||
          command.kind === "policychanges"
        )
          throw new AmsError(
            409,
            "immutable_record",
            "Keep the original record; add a new note, document revision, or reversing transaction.",
          );
        if (
          original.kind === "suggestions" &&
          original.createdBy !== actor.userId
        )
          throw new AmsError(
            403,
            "author_required",
            "Only the person who made a suggestion can edit it. Add your support instead.",
          );
        this.validateGenericUpdate(original, command.data);
        let merged = {
          ...original.data,
          ...command.data,
          ...(original.kind === "certificates"
            ? { preparation: null, documentId: null, status: "requested" }
            : {}),
        };
        if (
          original.kind === "certificates" &&
          command.data.holderId &&
          command.data.holderId !==
            (original as AmsRecord<"certificates">).data.holderId
        ) {
          const holder = await requireRecord(
            "certificateholders",
            String(command.data.holderId),
          );
          merged = {
            ...merged,
            holderName: holder.data.name,
            holderAddress: holder.data.address,
            holderEmail: holder.data.email,
          };
        }
        await save(command.kind, merged, original);
      } else if (
        (command.action === "archive" || command.action === "restore") &&
        original
      ) {
        if (
          immutableKinds.includes(command.kind) ||
          [
            "invoices",
            "commissions",
            "certificates",
            "policies",
            "statements",
            "policychanges",
          ].includes(command.kind)
        )
          throw new AmsError(
            409,
            "lifecycle_required",
            "Use this record’s lifecycle controls so its history remains complete.",
          );
        if (!["admin", "manager"].includes(actor.role))
          throw new AmsError(
            403,
            "manager_required",
            "An agency administrator or manager must archive or restore records.",
          );
        if (
          original.kind === "accounts" &&
          (original as AmsRecord<"accounts">).data.consolidation
        )
          throw new AmsError(
            409,
            "consolidated_account",
            "Archive the primary account, or review separation before archiving a retained identity.",
          );
        reason();
        if (command.action === "restore" && !original.archivedAt)
          throw new AmsError(409, "not_archived", "This record is not archived.");
        let data = original.data;
        // Archival is record metadata, not an account relationship. Older
        // releases replaced the relationship with "archived"; recover it from
        // the immutable pre-archive revision rather than guessing "active".
        if (
          original.kind === "accounts" &&
          (original as AmsRecord<"accounts">).data.status === "archived"
        ) {
          const previous = await tx.revision(
            "accounts",
            original.id,
            original.revision - 1,
          );
          if (
            !previous ||
            previous.kind !== "accounts" ||
            previous.archivedAt ||
            (previous as AmsRecord<"accounts">).data.status === "archived"
          )
            throw new AmsError(
              409,
              "archive_history_required",
              "The original account relationship is missing from history. Review the archive history before restoring this account.",
            );
          data = {
            ...(original as AmsRecord<"accounts">).data,
            status: (previous as AmsRecord<"accounts">).data.status,
          };
        }
        await save(original.kind, data, original, {
          archivedAt: command.action === "archive" ? now : null,
        });
      } else if (
        command.action.startsWith("policy.") &&
        original?.kind === "policies"
      ) {
        const policy = original as AmsRecord<"policies">;
        if (command.action === "policy.issue") {
          if (policy.data.status !== "draft")
            throw new AmsError(
              409,
              "invalid_policy_state",
              "Only a draft can be recorded as issued.",
            );
          const evidence = parseAms(
            z
              .object({
                sourceReference: text,
                sourceDocumentId: AmsId.nullable().optional(),
              })
              .strict(),
            command.data,
          );
          await save(
            "policies",
            { ...policy.data, ...evidence, status: "active" },
            policy,
          );
          await expectedCommission(
            policy,
            policy.data.premiumCents,
            policy.data.effectiveDate,
            policy.data.previousPolicyId ? "renewal" : "new_business",
          );
        } else if (command.action === "policy.endorse") {
          if (policy.data.status !== "active")
            throw new AmsError(
              409,
              "invalid_policy_state",
              "Only an active policy can be endorsed.",
            );
          const change = parseAms(AmsEndorsementChangeSchema, command.data);
          if (
            change.effectiveDate < policy.data.effectiveDate ||
            change.effectiveDate >= policy.data.expirationDate
          )
            throw new AmsError(
              422,
              "date_outside_term",
              "The endorsement date must be within the policy term.",
            );
          if (policy.data.premiumCents + change.premiumDeltaCents < 0)
            throw new AmsError(
              422,
              "invalid_premium",
              "An endorsement cannot reduce the term premium below zero.",
            );
          if (
            amsPolicyStatusAt(policy.data, change.effectiveDate) === "cancelled"
          )
            throw new AmsError(
              422,
              "change_during_cancellation",
              "The endorsement date falls within a recorded cancellation. Review the carrier evidence first.",
            );
          if (change.effectiveDate > businessDate) {
            reason();
            if (change.sourceDocumentId) {
              const document = await requireRecord(
                "documents",
                change.sourceDocumentId,
              );
              if (
                !(await sameAccount(
                  document.data.accountId,
                  policy.data.accountId,
                ))
              )
                throw new AmsError(
                  422,
                  "account_mismatch",
                  "The endorsement evidence must belong to this account.",
                );
            }
            await save("policychanges", {
              accountId: policy.data.accountId,
              policyId: policy.id,
              name: `${policy.data.number} · endorsement ${change.effectiveDate}`,
              baseVersion: policy.version,
              change,
            });
          } else {
            reason();
            await save(
              "policies",
              {
                ...policy.data,
                premiumCents:
                  policy.data.premiumCents + change.premiumDeltaCents,
                coverages: change.coverages ?? policy.data.coverages,
                sourceReference: change.sourceReference,
                sourceDocumentId:
                  change.sourceDocumentId ?? policy.data.sourceDocumentId,
                notes: change.notes ?? policy.data.notes,
              },
              policy,
            );
            await expectedCommission(
              policy,
              change.premiumDeltaCents,
              change.effectiveDate,
              "endorsement",
            );
          }
        } else if (command.action === "policy.cancel") {
          if (policy.data.status !== "active")
            throw new AmsError(
              409,
              "invalid_policy_state",
              "Only an active policy can be cancelled.",
            );
          const change = parseAms(
            z
              .object({ effectiveDate: AmsDate, sourceReference: text })
              .strict(),
            command.data,
          );
          if (
            change.effectiveDate < policy.data.effectiveDate ||
            change.effectiveDate > policy.data.expirationDate
          )
            throw new AmsError(
              422,
              "date_outside_term",
              "The cancellation date must fall within this term.",
            );
          await save(
            "policies",
            {
              ...policy.data,
              status: "cancelled",
              cancellationDate: change.effectiveDate,
              cancellationReason: reason(),
              sourceReference: change.sourceReference,
            },
            policy,
          );
        } else if (command.action === "policy.reinstate") {
          if (policy.data.status !== "cancelled")
            throw new AmsError(
              409,
              "invalid_policy_state",
              "Only a cancelled policy can be reinstated.",
            );
          const change = parseAms(
            z
              .object({
                effectiveDate: AmsDate,
                sourceReference: text,
                sourceDocumentId: AmsId.nullable().optional(),
              })
              .strict(),
            command.data,
          );
          if (
            !policy.data.cancellationDate ||
            !policy.data.cancellationReason ||
            !policy.data.sourceReference
          )
            throw new AmsError(
              409,
              "cancellation_evidence_required",
              "The recorded cancellation is missing its date or evidence. Review the policy history before reinstating it.",
            );
          if (
            change.effectiveDate < policy.data.cancellationDate ||
            change.effectiveDate >= policy.data.expirationDate
          )
            throw new AmsError(
              422,
              "date_outside_term",
              "The reinstatement must be on or after cancellation and before this term expires.",
            );
          if (change.sourceDocumentId) {
            const document = await requireRecord(
              "documents",
              change.sourceDocumentId,
            );
            if (
              !(await sameAccount(
                document.data.accountId,
                policy.data.accountId,
              ))
            )
              throw new AmsError(
                422,
                "account_mismatch",
                "The reinstatement evidence must belong to this account.",
              );
          }
          await save(
            "policies",
            {
              ...policy.data,
              status: "active",
              cancellationDate: null,
              cancellationReason: "",
              reinstatements: [
                ...(policy.data.reinstatements ?? []),
                {
                  cancellationDate: policy.data.cancellationDate,
                  cancellationReason: policy.data.cancellationReason,
                  cancellationReference: policy.data.sourceReference,
                  effectiveDate: change.effectiveDate,
                  sourceReference: change.sourceReference,
                  sourceDocumentId: change.sourceDocumentId ?? null,
                  reason: reason(),
                  recordedAt: now,
                  recordedBy: actor.userId,
                },
              ],
              sourceReference: change.sourceReference,
            },
            policy,
          );
        } else if (
          command.action === "policy.nonrenew" ||
          command.action === "policy.withdrawNonrenewal"
        ) {
          if (policy.data.status !== "active")
            throw new AmsError(
              409,
              "invalid_policy_state",
              "Record nonrenewal notices against an issued, uncancelled term.",
            );
          if (command.action === "policy.nonrenew") {
            const notice = parseAms(
              z.object({ noticeDate: AmsDate, sourceReference: text }).strict(),
              command.data,
            );
            if (notice.noticeDate > businessDate)
              throw new AmsError(
                422,
                "future_notice",
                "Record a notice that has actually been received.",
              );
            if (policy.data.nonrenewal)
              throw new AmsError(
                409,
                "notice_exists",
                "Withdraw the existing notice before recording a replacement.",
              );
            await save(
              "policies",
              { ...policy.data, nonrenewal: { ...notice, reason: reason() } },
              policy,
            );
          } else {
            parseAms(
              z.object({ sourceReference: text }).strict(),
              command.data,
            );
            if (!policy.data.nonrenewal)
              throw new AmsError(
                409,
                "notice_missing",
                "This term has no recorded nonrenewal notice.",
              );
            reason();
            await save(
              "policies",
              { ...policy.data, nonrenewal: null },
              policy,
            );
          }
        } else if (command.action === "policy.renew") {
          if (!["active", "expired"].includes(policy.data.status))
            throw new AmsError(
              409,
              "invalid_policy_state",
              "Select the active or expired term being renewed.",
            );
          const next = parseAms(AMS_DATA_SCHEMAS.policies, {
            ...policy.data,
            ...command.data,
            accountId: policy.data.accountId,
            previousPolicyId: policy.id,
            nonrenewal: null,
            status: "draft",
            cancellationDate: null,
            cancellationReason: "",
            reinstatements: [],
            sourceDocumentId: null,
            sourceReference: "",
          });
          if (next.effectiveDate < policy.data.expirationDate)
            throw new AmsError(
              422,
              "overlapping_terms",
              "The next term cannot start before the current term expires.",
            );
          await save("policies", next);
        }
      } else if (
        command.action.startsWith("policyChange.") &&
        original?.kind === "policychanges"
      ) {
        const scheduled = original as AmsRecord<"policychanges">;
        if (scheduled.data.status !== "scheduled")
          throw new AmsError(
            409,
            "policy_change_closed",
            "This scheduled change has already been resolved.",
          );
        const policy = await requireRecord("policies", scheduled.data.policyId);
        if (command.action === "policyChange.withdraw") {
          parseAms(z.object({}).strict(), command.data);
          reason();
          await save(
            "policychanges",
            { ...scheduled.data, status: "withdrawn" },
            scheduled,
          );
        } else {
          if (policy.data.status !== "active")
            throw new AmsError(
              409,
              "invalid_policy_state",
              "Review the issued policy before applying this endorsement.",
            );
          if (command.action === "policyChange.review") {
            const input = parseAms(
              z
                .object({
                  policyVersion: z.string(),
                  reviewed: z.literal(true),
                })
                .strict(),
              command.data,
            );
            if (input.policyVersion !== policy.version)
              throw new AmsError(
                409,
                "stale_policy_change",
                "The policy changed since you reviewed it. Refresh and review again.",
              );
            reason();
            await save(
              "policychanges",
              { ...scheduled.data, baseVersion: policy.version },
              scheduled,
            );
          } else if (command.action === "policyChange.apply") {
            parseAms(z.object({}).strict(), command.data);
            const change = scheduled.data.change;
            if (change.effectiveDate > businessDate)
              throw new AmsError(
                422,
                "change_not_due",
                "This endorsement is not effective yet.",
              );
            if (scheduled.data.baseVersion !== policy.version)
              throw new AmsError(
                409,
                "stale_policy_change",
                "The policy changed after scheduling. Review it against the current policy before applying.",
              );
            if (
              change.effectiveDate < policy.data.effectiveDate ||
              change.effectiveDate >= policy.data.expirationDate
            )
              throw new AmsError(
                422,
                "date_outside_term",
                "The endorsement date must fall within the term.",
              );
            if (
              amsPolicyStatusAt(policy.data, change.effectiveDate) ===
              "cancelled"
            )
              throw new AmsError(
                422,
                "change_during_cancellation",
                "The endorsement date falls within a recorded cancellation. Review the carrier evidence first.",
              );
            reason();
            await save(
              "policies",
              {
                ...policy.data,
                premiumCents:
                  policy.data.premiumCents + change.premiumDeltaCents,
                coverages: change.coverages ?? policy.data.coverages,
                sourceReference: change.sourceReference,
                sourceDocumentId:
                  change.sourceDocumentId ?? policy.data.sourceDocumentId,
                notes: change.notes ?? policy.data.notes,
              },
              policy,
            );
            await expectedCommission(
              policy,
              change.premiumDeltaCents,
              change.effectiveDate,
              "endorsement",
            );
            await save(
              "policychanges",
              {
                ...scheduled.data,
                status: "applied",
                appliedAt: now,
                appliedBy: actor.userId,
              },
              scheduled,
            );
          }
        }
      } else if (
        command.action === "renewal.close" &&
        original?.kind === "renewals"
      ) {
        const renewal = original as AmsRecord<"renewals">;
        if (!nonterminalRenewals.has(renewal.data.stage))
          throw new AmsError(
            409,
            "renewal_closed",
            "This renewal already has an outcome.",
          );
        const outcome = parseAms(
          z
            .object({
              stage: z.enum(["renewed", "lost"]),
              replacementPolicyIds: z.array(AmsId).max(100).default([]),
            })
            .strict(),
          command.data,
        );
        reason();
        if (outcome.stage === "renewed") {
          if (!outcome.replacementPolicyIds.length)
            throw new AmsError(
              422,
              "replacement_required",
              "Select the issued replacement policy terms.",
            );
          const replacements = await Promise.all(
            outcome.replacementPolicyIds.map((id) =>
              requireRecord("policies", id),
            ),
          );
          for (const policy of replacements)
            if (
              !(await sameAccount(
                policy.data.accountId,
                renewal.data.accountId,
              ))
            )
              throw new AmsError(
                422,
                "account_mismatch",
                "Replacement terms must belong to this account.",
              );
          for (const id of renewal.data.policyIds)
            if (
              !replacements.some(
                (policy) =>
                  policy.data.previousPolicyId === id &&
                  policy.data.status === "active",
              )
            )
              throw new AmsError(
                422,
                "replacement_required",
                "Each expiring policy needs an active replacement term linked to it.",
              );
        }
        await save(
          "renewals",
          { ...renewal.data, ...outcome, outcomeReason: command.reason },
          renewal,
        );
      } else if (
        command.action === "task.followUp" &&
        original?.kind === "tasks"
      ) {
        const task = original as AmsRecord<"tasks">;
        if (task.data.status === "done")
          throw new AmsError(
            409,
            "task_completed",
            "Change follow-ups on an open task.",
          );
        const followUp = parseAms(AmsTaskFollowUpSchema, command.data);
        if (followUp.repeatUntil && followUp.repeatUntil < task.data.dueDate)
          throw new AmsError(
            422,
            "invalid_repeat_end",
            "The repeat end date must be on or after the task due date.",
          );
        await save("tasks", { ...task.data, followUp }, task);
      } else if (
        command.action.startsWith("reminder.") &&
        original?.kind === "reminders"
      ) {
        const reminder = original as AmsRecord<"reminders">;
        const task = await tx.get("tasks", reminder.data.taskId);
        const account = task?.data.accountId
          ? await tx.get("accounts", task.data.accountId)
          : null;
        const root = account?.data.consolidation
          ? await tx.get("accounts", account.data.consolidation.targetId)
          : account;
        const current =
          task &&
          !task.archivedAt &&
          task.data.status !== "done" &&
          task.data.reminderGeneration === reminder.data.generation &&
          (!task.data.accountId || (root && !root.archivedAt));
        if (command.action === "reminder.deliver") {
          if (
            reminder.data.status !== "scheduled" ||
            reminder.data.dueDate > businessDate
          )
            throw new AmsError(
              409,
              "not_due",
              "This reminder is not due for processing.",
            );
          const member = members.find(
            (m) => m.id === reminder.data.ownerId && m.active,
          );
          const allowed =
            member &&
            (reminder.data.type !== "escalation" ||
              ["admin", "manager"].includes(member.role));
          await save(
            "reminders",
            {
              ...reminder.data,
              queueKey: null,
              status: !current ? "cancelled" : allowed ? "ready" : "blocked",
              deliveredAt: current && allowed ? now : null,
              detail: !current
                ? "The task is no longer active on this schedule."
                : !allowed
                  ? "The recipient is inactive or no longer holds the required role. Review task ownership."
                  : "Available in the agency work queue.",
            },
            reminder,
          );
        } else {
          if (
            actor.userId !== reminder.data.ownerId &&
            !["admin", "manager"].includes(actor.role)
          )
            throw new AmsError(
              403,
              "recipient_required",
              "Only the recipient or an agency manager can change this reminder.",
            );
          if (!current)
            throw new AmsError(
              409,
              "task_changed",
              "This task changed or is complete. Refresh the work queue.",
            );
          if (
            command.action === "reminder.dismiss" &&
            reminder.data.status === "ready"
          )
            await save(
              "reminders",
              {
                ...reminder.data,
                status: "dismissed",
                dismissedAt: now,
                dismissedBy: actor.userId,
                queueKey: null,
              },
              reminder,
            );
          else if (
            command.action === "reminder.snooze" &&
            reminder.data.status === "ready"
          ) {
            const { dueDate } = parseAms(
              z.object({ dueDate: AmsDate }).strict(),
              command.data,
            );
            if (
              dueDate <= businessDate ||
              dueDate > calendarDays(businessDate, 365)
            )
              throw new AmsError(
                422,
                "invalid_snooze",
                "Choose a future date within one year. The task due date stays unchanged.",
              );
            await save(
              "reminders",
              {
                ...reminder.data,
                status: "scheduled",
                dueDate,
                queueKey: `${dueDate}:${reminder.id}`,
                detail: `Snoozed by ${actor.name}.`,
              },
              reminder,
            );
          } else if (
            command.action === "reminder.retry" &&
            reminder.data.status === "blocked" &&
            ["admin", "manager"].includes(actor.role)
          )
            await save(
              "reminders",
              {
                ...reminder.data,
                status: "scheduled",
                dueDate: businessDate,
                queueKey: `${businessDate}:${reminder.id}`,
                detail: "Manager requested another recipient check.",
              },
              reminder,
            );
          else
            throw new AmsError(
              409,
              "invalid_reminder_state",
              "Refresh the reminder before changing it.",
            );
        }
      } else if (
        (command.action === "task.complete" ||
          command.action === "task.reopen") &&
        original?.kind === "tasks"
      ) {
        const task = original as AmsRecord<"tasks">;
        if (command.action === "task.reopen") {
          reason();
          if (task.data.nextTaskId)
            throw new AmsError(
              409,
              "recurring_successor_exists",
              "A follow-up task already exists. Work from that task; reopening would duplicate the series.",
            );
        } else if (task.data.status === "done")
          throw new AmsError(
            409,
            "task_completed",
            "This task is already complete.",
          );
        let nextTaskId = task.data.nextTaskId;
        if (
          command.action === "task.complete" &&
          task.data.followUp.repeatEveryDays
        ) {
          const dueDate = nextTaskDate(
            task.data.dueDate,
            businessDate,
            task.data.followUp.repeatEveryDays,
          );
          if (
            !task.data.followUp.repeatUntil ||
            dueDate <= task.data.followUp.repeatUntil
          ) {
            const next = await save("tasks", {
              ...task.data,
              dueDate,
              status: "open",
              completedAt: null,
              completedBy: null,
              previousTaskId: task.id,
              nextTaskId: null,
              workflow: null,
              importOrigin: null,
              reminderGeneration: 0,
            });
            nextTaskId = next.id;
          }
        }
        await save(
          "tasks",
          {
            ...task.data,
            nextTaskId,
            status: command.action === "task.complete" ? "done" : "open",
            completedAt: command.action === "task.complete" ? now : null,
            completedBy:
              command.action === "task.complete" ? actor.userId : null,
          },
          task,
        );
      } else if (
        command.action === "service.complete" &&
        original?.kind === "services"
      ) {
        const service = original as AmsRecord<"services">;
        if (service.data.status === "completed")
          throw new AmsError(
            409,
            "service_completed",
            "This request is already completed. Create a follow-up request to preserve its resolution.",
          );
        const resolution = parseAms(
          z.object({ resolution: text }).strict(),
          command.data,
        );
        await save(
          "services",
          { ...service.data, ...resolution, status: "completed" },
          service,
        );
      } else if (
        command.action === "template.revoke" &&
        original?.kind === "certificatetemplates"
      ) {
        const template = original as AmsRecord<"certificatetemplates">;
        if (template.data.revokedAt)
          throw new AmsError(
            409,
            "template_revoked",
            "This template has already been revoked.",
          );
        await save(
          "certificatetemplates",
          { ...template.data, revokedAt: now, revocationReason: reason() },
          template,
        );
      } else if (
        command.action === "certificate.deliver" &&
        original?.kind === "certificates"
      ) {
        const certificate = original as AmsRecord<"certificates">;
        if (
          certificate.data.status !== "issued" ||
          !certificate.data.documentId
        )
          throw new AmsError(
            409,
            "certificate_not_issued",
            "Issue and review this certificate before recording delivery.",
          );
        const input = parseAms(
          AmsCertificateDeliverySchema.pick({
            recipient: true,
            method: true,
            deliveredAt: true,
            evidence: true,
          })
            .extend({
              confirmed: z.literal(true),
              completeService: z.boolean().default(false),
              serviceVersion: z.string().optional(),
            })
            .strict(),
          command.data,
        );
        if (
          Date.parse(input.deliveredAt) > Date.parse(now) ||
          // The staff input records seconds, while issuance records milliseconds.
          Date.parse(input.deliveredAt) <
            Math.floor(Date.parse(certificate.data.issuedAt!) / 1000) * 1000
        )
          throw new AmsError(
            422,
            "invalid_delivery_date",
            "Delivery must be between issuance and now.",
          );
        if (
          input.method === "email" &&
          !z.string().email().safeParse(input.recipient).success
        )
          throw new AmsError(
            422,
            "invalid_recipient",
            "Enter the recipient's email address.",
          );
        const document = await requireRecord(
          "documents",
          certificate.data.documentId,
        );
        const {
          confirmed: _confirmed,
          completeService,
          serviceVersion,
          ...delivery
        } = input;
        await save(
          "certificates",
          {
            ...certificate.data,
            deliveries: [
              ...certificate.data.deliveries,
              {
                ...delivery,
                id: command.id,
                documentId: document.id,
                documentSha256: document.data.sha256,
                recordedAt: now,
                recordedBy: actor.userId,
              },
            ],
          },
          certificate,
        );
        if (completeService) {
          if (!certificate.data.serviceId)
            throw new AmsError(
              422,
              "service_required",
              "This certificate is not linked to a service request.",
            );
          const request = await requireRecord(
            "services",
            certificate.data.serviceId,
          );
          if (
            !serviceVersion ||
            request.version !== serviceVersion ||
            request.data.status === "completed"
          )
            throw new AmsError(
              409,
              "stale_service",
              "The service request changed or is already complete. Refresh before closing it.",
            );
          await save(
            "services",
            {
              ...request.data,
              status: "completed",
              resolution: `Certificate ${certificate.id}: external ${delivery.method} delivery to ${delivery.recipient}. Evidence: ${delivery.evidence}`,
              documentIds: [
                ...new Set([...request.data.documentIds, document.id]),
              ],
            },
            request,
          );
        }
      } else if (
        command.action === "certificate.reissue" &&
        original?.kind === "certificates"
      ) {
        const certificate = original as AmsRecord<"certificates">;
        if (!["issued", "void"].includes(certificate.data.status))
          throw new AmsError(
            409,
            "certificate_not_final",
            "Finish the existing request before creating a reissue.",
          );
        const input = parseAms(
          z
            .object({
              policyIds: z.array(AmsId).min(1).max(25),
              requestedDate: AmsDate,
            })
            .strict(),
          command.data,
        );
        await save("certificates", {
          accountId: certificate.data.accountId,
          holderId: certificate.data.holderId,
          holderName: certificate.data.holderName,
          holderAddress: certificate.data.holderAddress,
          holderEmail: certificate.data.holderEmail,
          description: certificate.data.description,
          ownerId: certificate.data.ownerId,
          ...input,
          previousCertificateId: certificate.id,
          reissueReason: reason(),
        });
      } else if (
        command.action === "certificate.prepare" &&
        original?.kind === "certificates"
      ) {
        const certificate = original as AmsRecord<"certificates">;
        if (!["requested", "review"].includes(certificate.data.status))
          throw new AmsError(
            409,
            "certificate_finalized",
            "This certificate is already finalized.",
          );
        const input = parseAms(
          z
            .object({
              documentId: AmsId,
              preparation: AmsCertificatePreparationSchema,
            })
            .strict(),
          command.data,
        );
        await approvePreparation(input.preparation);
        const document = await requireRecord("documents", input.documentId);
        if (
          !(await sameAccount(
            document.data.accountId,
            certificate.data.accountId,
          )) ||
          document.data.category !== "certificate" ||
          document.data.mediaType !== "application/pdf"
        )
          throw new AmsError(
            422,
            "certificate_document_required",
            "Choose a certificate PDF belonging to this account.",
          );
        const account = await requireRecord(
          "accounts",
          certificate.data.accountId,
        );
        const policies = await Promise.all(
          certificate.data.policyIds.map((id) => requireRecord("policies", id)),
        );
        if (
          account.version !== input.preparation.accountVersion ||
          input.preparation.policyVersions.length !== policies.length ||
          new Set(input.preparation.policyVersions.map((p) => p.id)).size !==
            policies.length ||
          policies.some(
            (policy) =>
              !input.preparation.policyVersions.some(
                (p) => p.id === policy.id && p.version === policy.version,
              ),
          )
        )
          throw new AmsError(
            409,
            "certificate_sources_changed",
            "Account or policy details changed. Refresh and prepare a new certificate before saving.",
          );
        await save(
          "certificates",
          { ...certificate.data, ...input, status: "review" },
          certificate,
        );
      } else if (
        command.action === "certificate.issue" &&
        original?.kind === "certificates"
      ) {
        const certificate = original as AmsRecord<"certificates">;
        if (!["requested", "review"].includes(certificate.data.status))
          throw new AmsError(
            409,
            "certificate_finalized",
            "This certificate request is already finalized.",
          );
        const input = parseAms(
          z.object({ documentId: AmsId, reviewed: z.literal(true) }).strict(),
          command.data,
        );
        const document = await requireRecord("documents", input.documentId);
        if (
          !(await sameAccount(
            document.data.accountId,
            certificate.data.accountId,
          )) ||
          document.data.mediaType !== "application/pdf" ||
          document.data.category !== "certificate"
        )
          throw new AmsError(
            422,
            "certificate_document_required",
            "Attach the reviewed certificate PDF from your authorized form workflow.",
          );
        const policies = await Promise.all(
          certificate.data.policyIds.map((id) => requireRecord("policies", id)),
        );
        const preparation = certificate.data.preparation;
        if (preparation) {
          await approvePreparation(preparation);
          const account = await requireRecord(
            "accounts",
            certificate.data.accountId,
          );
          if (
            input.documentId !== certificate.data.documentId ||
            account.version !== preparation.accountVersion ||
            policies.some(
              (policy) =>
                !preparation.policyVersions.some(
                  (p) => p.id === policy.id && p.version === policy.version,
                ),
            )
          )
            throw new AmsError(
              409,
              "certificate_sources_changed",
              "The prepared PDF no longer matches the account or policy versions. Prepare and review a new certificate.",
            );
        }
        for (const policy of policies)
          if (
            !(await sameAccount(
              policy.data.accountId,
              certificate.data.accountId,
            )) ||
            amsPolicyStatusAt(policy.data, businessDate) !== "active"
          )
            throw new AmsError(
              422,
              "policy_not_active",
              "Review the policy terms before recording this certificate as issued.",
            );
        await save(
          "certificates",
          {
            ...certificate.data,
            documentId: input.documentId,
            status: "issued",
            issuedAt: now,
            issuedBy: actor.userId,
            policySnapshots: policies.map((policy) => ({
              id: policy.id,
              version: policy.version,
              data: policy.data,
            })),
          },
          certificate,
        );
      } else if (
        command.action === "certificate.void" &&
        original?.kind === "certificates"
      ) {
        const certificate = original as AmsRecord<"certificates">;
        if (certificate.data.status !== "issued")
          throw new AmsError(
            409,
            "certificate_not_issued",
            "Only an issued certificate can be voided.",
          );
        await save(
          "certificates",
          { ...certificate.data, status: "void", voidReason: reason() },
          certificate,
        );
      } else if (
        (command.action === "invoice.post" ||
          command.action === "invoice.void") &&
        original?.kind === "invoices"
      ) {
        const invoice = original as AmsRecord<"invoices">;
        const policy = await requireRecord("policies", invoice.data.policyId);
        if (policy.data.billing !== "agency")
          throw new AmsError(
            422,
            "agency_bill_required",
            "Agency invoices require an agency-billed policy.",
          );
        const totals = invoiceTotals(invoice.data);
        if (totals.total <= 0)
          throw new AmsError(
            422,
            "empty_invoice",
            "A posted invoice must have a positive balance.",
          );
        if (totals.premium < invoice.data.commissionCents)
          throw new AmsError(
            422,
            "invalid_commission",
            "Commission cannot exceed the premium portion.",
          );
        if (
          command.action === "invoice.post" &&
          invoice.data.status !== "draft"
        )
          throw new AmsError(
            409,
            "already_posted",
            "Only a draft invoice can be posted.",
          );
        if (
          command.action === "invoice.void" &&
          (invoice.data.status !== "posted" ||
            invoice.data.paidCents ||
            invoice.data.carrierPaidCents)
        )
          throw new AmsError(
            409,
            "reverse_payments_first",
            "Reverse receipts and carrier payments before voiding the posted invoice.",
          );
        if (command.action === "invoice.void") reason();
        const posted = await save(
          "invoices",
          {
            ...invoice.data,
            status: command.action === "invoice.post" ? "posted" : "void",
            postedAt: invoice.data.postedAt ?? now,
          },
          invoice,
        );
        const entries: AmsData<"journals">["entries"] = [
          debit("accounts_receivable", totals.total),
          credit(
            "carrier_payable",
            totals.premium - invoice.data.commissionCents,
          ),
          credit("tax_payable", totals.tax),
          credit("fee_income", totals.fee),
          credit("commission_income", invoice.data.commissionCents),
        ];
        await journal(
          businessDate,
          `${command.action === "invoice.post" ? "Posted" : "Voided"} invoice ${invoice.data.number}`,
          posted,
          command.action === "invoice.void" ? reverse(entries) : entries,
          command.action === "invoice.void" ? invoice.id : null,
        );
      } else if (
        command.action === "payment.record" &&
        original?.kind === "invoices"
      ) {
        const invoice = original as AmsRecord<"invoices">;
        if (invoice.data.status !== "posted")
          throw new AmsError(
            409,
            "invoice_not_posted",
            "Post the invoice before recording money received or paid.",
          );
        const payment = parseAms(AMS_DATA_SCHEMAS.payments, {
          ...command.data,
          accountId: invoice.data.accountId,
          invoiceId: invoice.id,
          status: "posted",
          reversedPaymentId: null,
        });
        if (payment.kind === "refund")
          throw new AmsError(
            422,
            "use_reversal",
            "Use the receipt reversal workflow to retain its source link.",
          );
        if (payment.date > businessDate)
          throw new AmsError(
            422,
            "future_transaction",
            "Record completed receipts and carrier payments using their actual transaction date, no later than today.",
          );
        const receipt = payment.kind === "receipt";
        const remaining = receipt
          ? invoiceTotals(invoice.data).total - invoice.data.paidCents
          : invoiceTotals(invoice.data).premium -
            invoice.data.commissionCents -
            invoice.data.carrierPaidCents;
        if (payment.amountCents > remaining)
          throw new AmsError(
            422,
            "overpayment",
            "This amount exceeds the remaining balance.",
          );
        const entry = await save("payments", payment);
        await save(
          "invoices",
          {
            ...invoice.data,
            paidCents:
              invoice.data.paidCents + (receipt ? payment.amountCents : 0),
            carrierPaidCents:
              invoice.data.carrierPaidCents +
              (receipt ? 0 : payment.amountCents),
          },
          invoice,
        );
        await journal(
          payment.date,
          `${receipt ? "Receipt" : "Carrier payment"} · ${payment.reference}`,
          entry,
          receipt
            ? [
                debit("trust_cash", payment.amountCents),
                credit("accounts_receivable", payment.amountCents),
              ]
            : [
                debit("carrier_payable", payment.amountCents),
                credit("trust_cash", payment.amountCents),
              ],
        );
      } else if (
        command.action === "payment.reverse" &&
        original?.kind === "payments"
      ) {
        const payment = original as AmsRecord<"payments">;
        if (payment.data.status !== "posted" || payment.data.reversedPaymentId)
          throw new AmsError(
            409,
            "already_reversed",
            "This entry cannot be reversed again.",
          );
        const invoice = await requireRecord("invoices", payment.data.invoiceId);
        const receipt = payment.data.kind === "receipt";
        reason();
        const date = parseAms(AmsDate, command.data.date);
        if (date < payment.data.date || date > businessDate)
          throw new AmsError(
            422,
            "invalid_reversal_date",
            "The reversal must be on or after the original payment and no later than today.",
          );
        const reversing = await save("payments", {
          ...payment.data,
          date,
          reference: command.reason,
          reversedPaymentId: payment.id,
        });
        await save(
          "payments",
          { ...payment.data, status: "reversed" },
          payment,
        );
        await save(
          "invoices",
          {
            ...invoice.data,
            paidCents:
              invoice.data.paidCents - (receipt ? payment.data.amountCents : 0),
            carrierPaidCents:
              invoice.data.carrierPaidCents -
              (receipt ? 0 : payment.data.amountCents),
          },
          invoice,
        );
        await journal(
          date,
          `Reversal · ${payment.data.reference}`,
          reversing,
          receipt
            ? [
                debit("accounts_receivable", payment.data.amountCents),
                credit("trust_cash", payment.data.amountCents),
              ]
            : [
                debit("trust_cash", payment.data.amountCents),
                credit("carrier_payable", payment.data.amountCents),
              ],
          payment.id,
        );
      } else if (
        command.action === "commission.adjust" &&
        original?.kind === "commissions"
      ) {
        const commission = original as AmsRecord<"commissions">;
        const input = parseAms(
          z
            .object({
              date: AmsDate,
              premiumDeltaCents: AmsSignedCents,
              commissionDeltaCents: AmsSignedCents.refine(
                (value) => value !== 0,
              ),
              sourceReference: text,
            })
            .strict(),
          command.data,
        );
        if (input.date > businessDate)
          throw new AmsError(
            422,
            "future_transaction",
            "Record an adjustment confirmed by the carrier.",
          );
        const policy = await requireRecord(
          "policies",
          commission.data.policyId,
        );
        if (policy.data.billing !== "direct")
          throw new AmsError(
            422,
            "direct_bill_required",
            "Use agency-bill invoice corrections for this policy.",
          );
        await save("commissions", {
          accountId: commission.data.accountId,
          policyId: commission.data.policyId,
          carrier: commission.data.carrier,
          transaction: "adjustment",
          transactionDate: input.date,
          premiumCents: input.premiumDeltaCents,
          expectedCents: input.commissionDeltaCents,
          adjustsCommissionId: commission.id,
          sourceReference: input.sourceReference,
          producerId: commission.data.producerId,
          producerShareBps: commission.data.producerShareBps,
          notes: reason(),
        });
      } else if (
        command.action === "journal.reverseCommission" &&
        original?.kind === "journals"
      ) {
        const posting = original as AmsRecord<"journals">;
        const input = parseAms(
          z.object({ date: AmsDate, sourceReference: text }).strict(),
          command.data,
        );
        if (
          posting.data.sourceKind !== "commissions" ||
          posting.data.reversalOf ||
          posting.data.entries.length !== 2 ||
          posting.data.entries.some(
            (e) =>
              !["operating_cash", "commission_income"].includes(
                e.ledgerAccount,
              ),
          )
        )
          throw new AmsError(
            422,
            "not_commission_receipt",
            "Only an original direct-bill receipt posting can be reversed here.",
          );
        if (input.date < posting.data.date || input.date > businessDate)
          throw new AmsError(
            422,
            "invalid_reversal_date",
            "The reversal must be on or after the receipt and no later than today.",
          );
        await tx.unique(`commission-reversal:${posting.id}`, command.id);
        const commission = await requireRecord(
          "commissions",
          posting.data.sourceId,
        );
        const cash = posting.data.entries.find(
          (e) => e.ledgerAccount === "operating_cash",
        );
        if (!cash)
          throw new AmsError(
            422,
            "not_commission_receipt",
            "This is not an operating-cash receipt.",
          );
        const amount = cash.debitCents - cash.creditCents;
        const received = commission.data.receivedCents - amount;
        if (
          received &&
          (Math.sign(received) !== Math.sign(commission.data.expectedCents) ||
            Math.abs(received) > Math.abs(commission.data.expectedCents))
        )
          throw new AmsError(
            409,
            "commission_balance_conflict",
            "Review the receipt history before reversing this transaction.",
          );
        const corrected = await save(
          "commissions",
          {
            ...commission.data,
            receivedCents: received,
            hasReceipts: true,
            status:
              received === commission.data.expectedCents
                ? "reconciled"
                : received
                  ? "partial"
                  : "expected",
          },
          commission,
        );
        await journal(
          input.date,
          `Reversed direct-bill receipt · ${input.sourceReference} · ${reason()}`.slice(
            0,
            500,
          ),
          corrected,
          reverse(posting.data.entries),
          posting.id,
        );
      } else if (
        command.action === "commission.allocate" &&
        original?.kind === "commissions"
      ) {
        const commission = original as AmsRecord<"commissions">;
        const allocation = parseAms(
          z
            .object({
              producerId: AmsId.nullable(),
              producerShareBps: z.number().int().min(0).max(10000),
            })
            .strict(),
          command.data,
        );
        reason();
        await save(
          "commissions",
          { ...commission.data, ...allocation },
          commission,
        );
      } else if (
        (command.action === "statement.match" ||
          command.action === "statement.post") &&
        original?.kind === "statements"
      ) {
        const statement = original as AmsRecord<"statements">;
        if (statement.data.status === "posted")
          throw new AmsError(
            409,
            "statement_posted",
            "This statement is fully posted. Preserve it and use adjustment transactions for corrections.",
          );
        if (command.action === "statement.match") {
          const input = parseAms(
            z
              .object({
                rowId: AmsId,
                commissionId: AmsId.nullable(),
                reviewedMissingFields: z.boolean().default(false),
                expectedCommissionVersion: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
              })
              .strict(),
            command.data,
          );
          const row = statement.data.rows.find((row) => row.id === input.rowId);
          if (!row || row.status === "posted")
            throw new AmsError(
              409,
              "statement_row_closed",
              "Choose an unposted statement row.",
            );
          let version: string | null = null;
          if (input.commissionId) {
            if (
              statement.data.rows.some(
                (other) =>
                  other.id !== row.id &&
                  other.commissionId === input.commissionId,
              )
            )
              throw new AmsError(
                422,
                "duplicate_match",
                "Each expected transaction can match only one row in this statement.",
              );
            const commission = await requireRecord(
              "commissions",
              input.commissionId,
            );
            const policy = await requireRecord(
              "policies",
              commission.data.policyId,
            );
            if (
              policy.data.billing !== "direct" ||
              policy.data.number.toLowerCase() !==
                row.policyNumber.toLowerCase() ||
              policy.data.carrier.toLowerCase() !==
                statement.data.carrier.toLowerCase() ||
              policy.data.effectiveDate !== row.effectiveDate ||
              (row.transaction != null &&
                commission.data.transaction !== row.transaction) ||
              (row.transactionDate != null &&
                commission.data.transactionDate !== row.transactionDate)
            )
              throw new AmsError(
                422,
                "statement_match_mismatch",
                "Match the carrier, policy term and expected transaction. Resolve differences in the expected transaction first.",
              );
            if (
              (row.transaction == null ||
                row.transactionDate == null ||
                row.premiumCents == null) &&
              (!input.reviewedMissingFields || !command.reason.trim())
            )
              throw new AmsError(
                422,
                "statement_review_required",
                "Review the missing statement fields against the selected expected transaction and record the basis for this match.",
              );
            if (
              row.premiumCents != null &&
              commission.data.premiumCents !== row.premiumCents
            )
              throw new AmsError(
                422,
                "premium_mismatch",
                "The statement premium differs from the expected transaction premium. Review the difference before matching.",
              );
            const remaining =
              commission.data.expectedCents - commission.data.receivedCents;
            if (
              Math.sign(remaining) !== Math.sign(row.commissionCents) ||
              Math.abs(row.commissionCents) > Math.abs(remaining)
            )
              throw new AmsError(
                422,
                "commission_mismatch",
                "The statement commission exceeds or conflicts with the remaining expected commission. Review or record the appropriate adjustment before matching.",
              );
            if (
              input.expectedCommissionVersion &&
              input.expectedCommissionVersion !== commission.version
            )
              throw new AmsError(
                409,
                "stale_record",
                "The expected commission changed. Refresh it and review this match again.",
              );
            if (
              (row.transaction == null ||
                row.transactionDate == null ||
                row.premiumCents == null ||
                Math.abs(row.commissionCents) < Math.abs(remaining)) &&
              !input.expectedCommissionVersion
            )
              throw new AmsError(
                428,
                "version_required",
                "Review the current expected transaction before matching missing fields or a partial receipt.",
              );
            version = commission.version;
          }
          await save(
            "statements",
            {
              ...statement.data,
              rows: statement.data.rows.map((item) =>
                item.id === row.id
                  ? {
                      ...item,
                      commissionId: input.commissionId,
                      commissionVersion: version,
                      status: input.commissionId ? "matched" : "unmatched",
                    }
                  : item,
              ),
            },
            statement,
          );
        } else {
          parseAms(z.object({}).strict(), command.data);
          const matched = statement.data.rows.filter(
            (row) => row.status === "matched",
          );
          if (!matched.length)
            throw new AmsError(
              422,
              "no_matched_rows",
              "Match and review at least one row before posting. Unmatched rows remain open.",
            );
          for (const row of matched) {
            const commission = await requireRecord(
              "commissions",
              row.commissionId!,
            );
            if (commission.version !== row.commissionVersion)
              throw new AmsError(
                409,
                "stale_statement_match",
                "An expected commission changed after matching. Review and match that row again before posting.",
              );
            await receiveCommission(commission, {
              amountCents: row.commissionCents,
              date: row.paidDate || statement.data.statementDate,
              statementReference: statement.data.reference,
            });
          }
          const rows = statement.data.rows.map((row) =>
            row.status === "matched"
              ? { ...row, status: "posted" as const, postedAt: now }
              : row,
          );
          await save(
            "statements",
            {
              ...statement.data,
              rows,
              status: rows.every((row) => row.status === "posted")
                ? "posted"
                : "partial",
            },
            statement,
          );
        }
      } else if (
        command.action === "commission.receive" &&
        original?.kind === "commissions"
      ) {
        const commission = original as AmsRecord<"commissions">;
        const input = parseAms(
          z
            .object({
              amountCents: AmsSignedCents.refine((value) => value !== 0),
              date: AmsDate,
              statementReference: text,
            })
            .strict(),
          command.data,
        );
        await receiveCommission(commission, input);
      } else if (
        command.action === "suggestion.vote" &&
        original?.kind === "suggestions"
      ) {
        const suggestion = original as AmsRecord<"suggestions">;
        const { support } = parseAms(
          z.object({ support: z.boolean() }).strict(),
          command.data,
        );
        if (suggestion.data.votes.includes(actor.userId) === support)
          throw new AmsError(
            409,
            "vote_unchanged",
            support
              ? "You already support this suggestion."
              : "You have not supported this suggestion.",
          );
        const others = suggestion.data.votes.filter(
          (id) => id !== actor.userId,
        );
        await save(
          "suggestions",
          {
            ...suggestion.data,
            votes: support ? [...others, actor.userId] : others,
          },
          suggestion,
        );
      } else if (
        command.action === "suggestion.respond" &&
        original?.kind === "suggestions"
      ) {
        if (!["admin", "manager"].includes(actor.role))
          throw new AmsError(
            403,
            "manager_required",
            "An agency administrator or manager updates suggestion status.",
          );
        const suggestion = original as AmsRecord<"suggestions">;
        const input = parseAms(
          AmsSuggestionSchema.pick({ status: true, response: true })
            .required()
            .strict(),
          command.data,
        );
        await save("suggestions", { ...suggestion.data, ...input }, suggestion);
      } else if (
        (command.action === "form.publish" || command.action === "form.pause") &&
        original?.kind === "forms"
      ) {
        const form = original as AmsRecord<"forms">;
        // A form outlives the person it was assigned to; never block on that here.
        const ownerId =
          form.data.ownerId && memberIds.has(form.data.ownerId)
            ? form.data.ownerId
            : null;
        if (command.action === "form.pause") {
          if (form.data.status !== "published")
            throw new AmsError(409, "form_not_published", "This form is not published.");
          await save("forms", { ...form.data, ownerId, status: "paused" }, form);
        } else {
          const { linkId } = parseAms(
            z.object({ linkId: AmsFormLinkId }).strict(),
            command.data,
          );
          if (form.data.status === "published")
            throw new AmsError(409, "form_published", "This form is already published.");
          if (form.data.linkId && form.data.linkId !== linkId)
            throw new AmsError(
              409,
              "link_assigned",
              "This form already has a link. Refresh and publish again.",
            );
          await save(
            "forms",
            {
              ...form.data,
              ownerId,
              status: "published",
              linkId,
              publishedAt: form.data.publishedAt ?? now,
            },
            form,
          );
        }
      } else if (
        command.action === "formSubmission.receive" &&
        original?.kind === "forms"
      ) {
        const form = original as AmsRecord<"forms">;
        if (form.data.status !== "published")
          throw new AmsError(
            409,
            "form_closed",
            "This form is not taking submissions.",
          );
        const { submissionId, ...received } = parseAms(FormReceipt, command.data);
        const canOwn = (id: string | null | undefined) =>
          Boolean(id) &&
          members.some(
            (member) =>
              member.id === id && member.active && amsCanWrite(member.role, "tasks"),
          );
        const ownerId =
          [form.data.ownerId, workspace?.data.defaultOwnerId].find(canOwn) ?? null;
        const { contact } = received;
        const task = await save("tasks", {
          accountId: null,
          title: `Review form submission: ${contact.businessName || contact.name}`.slice(0, 500),
          description: [
            `${contact.name} sent the form "${form.data.name}".`,
            received.lines.length
              ? `Coverage requested: ${received.lines.map((line) => line.label).join(", ")}.`
              : "",
            [contact.email, contact.phone].filter(Boolean).join(" · "),
            "Open Forms to read the answers and file them to an account.",
          ]
            .filter(Boolean)
            .join("\n"),
          ownerId,
          dueDate: calendarDays(businessDate, form.data.followUpDays),
        });
        await save(
          "formsubmissions",
          {
            ...received,
            formId: form.id,
            formName: form.data.name,
            formRevision: form.revision,
            taskId: task.id,
            submittedAt: now,
          },
          undefined,
          { id: submissionId },
        );
      } else if (
        command.action === "formSubmission.file" &&
        original?.kind === "formsubmissions"
      ) {
        const submission = original as AmsRecord<"formsubmissions">;
        if (submission.data.status !== "new")
          throw new AmsError(
            409,
            "submission_closed",
            "This submission was already filed or dismissed.",
          );
        if (
          !amsCanWrite(actor.role, "accounts") ||
          !amsCanWrite(actor.role, "documents")
        )
          throw new AmsError(
            403,
            "permission_denied",
            "Your role cannot file submissions to accounts.",
          );
        const filing = parseAms(AmsFormFilingSchema, command.data);
        const { contact, sections, files, formName } = submission.data;
        const mailing = submissionAddress(
          sections.find((section) => section.id === "contact")?.items[0],
        );
        // The account is saved first so the change history opens on it.
        const account = filing.accountId
          ? await canonicalAccount(filing.accountId)
          : await save("accounts", {
              name: filing.account!.name,
              type: filing.account!.type,
              status: "prospect",
              email: contact.email,
              phone: contact.phone,
              address: mailing,
              source: "Hosted form",
            });
        const accountId = account.id;
        if (filing.createContact)
          await save("contacts", {
            accountId,
            name: contact.name,
            email: contact.email,
            phone: contact.phone,
            primary: !filing.accountId,
            address: mailing,
          });
        if (filing.createExposures)
          for (const section of sections) {
            if (!section.exposure) continue;
            for (const [index, item] of section.items.entries()) {
              const address = submissionAddress(item);
              await save("exposures", {
                accountId,
                kind: section.exposure,
                name: (
                  item.title ||
                  address.line1 ||
                  `${section.title}${section.items.length > 1 ? ` ${index + 1}` : ""}`
                ).slice(0, 500),
                address,
                description: `From the form "${formName}".`,
                values: Object.fromEntries(
                  item.answers
                    .filter((answer) => answer.type !== "address")
                    .slice(0, 50)
                    .map((answer) => [
                      answer.label.slice(0, 100),
                      typeof answer.value === "boolean"
                        ? answer.value
                        : amsFormValueText(answer.value, answer.type).slice(0, 1000),
                    ]),
                ),
              });
            }
          }
        const filed: AmsData<"formsubmissions">["files"] = [];
        for (const file of files) {
          // The public endpoint verified these bytes and their fingerprint on receipt.
          const document = await save("documents", {
            accountId,
            policyId: null,
            name: file.name,
            mediaType: file.mediaType,
            bytes: file.bytes,
            sha256: file.sha256,
            storageKey: file.storageKey,
            category: "application",
            supersedesId: null,
            description: `${file.label}. From the form "${formName}".`,
          });
          filed.push({ ...file, documentId: document.id });
        }
        await save("notes", {
          accountId,
          policyId: null,
          body: submissionText(submission.data),
          category: "note",
          occurredAt: submission.data.submittedAt,
        });
        const task = submission.data.taskId
          ? await tx.get("tasks", submission.data.taskId)
          : null;
        // A follow-up outlives the person it was given to: whoever files it takes it on.
        if (task && !task.archivedAt && !task.data.accountId)
          await save(
            "tasks",
            {
              ...task.data,
              accountId,
              ownerId:
                task.data.ownerId && !memberIds.has(task.data.ownerId)
                  ? actor.userId
                  : task.data.ownerId,
            },
            task,
          );
        await save(
          "formsubmissions",
          {
            ...submission.data,
            files: filed,
            status: "filed",
            accountId,
            filedAt: now,
            filedBy: actor.userId,
          },
          submission,
        );
      } else if (
        (command.action === "formSubmission.dismiss" ||
          command.action === "formSubmission.reopen") &&
        original?.kind === "formsubmissions"
      ) {
        const submission = original as AmsRecord<"formsubmissions">;
        const dismissing = command.action === "formSubmission.dismiss";
        if (submission.data.status !== (dismissing ? "new" : "dismissed"))
          throw new AmsError(
            409,
            "submission_closed",
            dismissing
              ? "This submission was already filed or dismissed."
              : "Only a dismissed submission can be reopened.",
          );
        await save(
          "formsubmissions",
          {
            ...submission.data,
            status: dismissing ? "dismissed" : "new",
            dismissReason: dismissing ? reason() : "",
          },
          submission,
        );
        const task =
          dismissing && submission.data.taskId
            ? await tx.get("tasks", submission.data.taskId)
            : null;
        // Nothing is left to follow up on a dismissed submission.
        if (
          task &&
          !task.archivedAt &&
          task.data.status !== "done" &&
          !task.data.followUp.repeatEveryDays
        )
          await save(
            "tasks",
            {
              ...task.data,
              ownerId:
                task.data.ownerId && !memberIds.has(task.data.ownerId)
                  ? actor.userId
                  : task.data.ownerId,
              status: "done",
              completedAt: now,
              completedBy: actor.userId,
            },
            task,
          );
      } else
        throw new AmsError(
          400,
          "invalid_action",
          "This action does not apply to the selected record.",
        );

      if (!records.length)
        throw new AmsError(400, "no_changes", "No changes were made.");
      const accountIds = new Set(
        records.map(accountOf).filter((id): id is string => Boolean(id)),
      );
      const roots = new Set<string>();
      for (const id of accountIds) {
        // Archived accounts may still be recorded by the archive/restore command.
        const account = await tx.get("accounts", id);
        roots.add(account?.data.consolidation?.targetId || id);
      }
      for (const id of roots) {
        accountIds.add(id);
        await tx.advanceAccountEpoch(id);
      }
      const sequence = await tx.nextSequence();
      const audit: AmsAudit = {
        id: command.id,
        sequence,
        commandId: command.id,
        action: command.action,
        actorId: actor.userId,
        actorName: actor.name,
        at: now,
        accountId: accountOf(records[0]),
        accountIds: [...accountIds],
        reason: command.reason,
        details: command.data,
        records: records.map((record) => ({
          kind: record.kind,
          id: record.id,
          beforeVersion:
            previousVersions.get(`${record.kind}:${record.id}`) ?? null,
          afterVersion: record.version,
          revision: record.revision,
        })),
      };
      tx.audit(audit);
      const result = { records, audit };
      tx.saveReceipt(command.id, {
        actorId: actor.userId,
        hash: fingerprint,
        result,
      });
      return result;
    });
  }
  private requireInitialState(kind: AmsKind, data: Record<string, unknown>) {
    if (kind === "accounts" && data.status === "archived")
      throw new AmsError(
        422,
        "lifecycle_required",
        "Create the account with its relationship, then use the archive action.",
      );
    if (kind === "statements") {
      const parsed = parseAms(AMS_DATA_SCHEMAS.statements, data);
      if (
        parsed.rows.some(
          (row) =>
            row.status !== "unmatched" ||
            row.commissionId ||
            row.commissionVersion ||
            row.postedAt,
        )
      )
        throw new AmsError(
          422,
          "lifecycle_required",
          "Import statement rows before matching and posting them.",
        );
    }
    const initial: Partial<Record<AmsKind, Record<string, unknown>>> = {
      accounts: { consolidation: null, consolidatedAccountIds: [] },
      policies: {
        status: "draft",
        cancellationDate: null,
        nonrenewal: null,
        reinstatements: [],
      },
      renewals: { stage: "review", replacementPolicyIds: [] },
      tasks: {
        status: "open",
        completedAt: null,
        completedBy: null,
        workflow: null,
        followUp: AmsTaskFollowUpSchema.parse({}),
        reminderGeneration: 0,
        previousTaskId: null,
        nextTaskId: null,
      },
      services: { status: "open" },
      certificates: {
        status: "requested",
        preparation: null,
        issuedAt: null,
        issuedBy: null,
        documentId: null,
        policySnapshots: [],
        previousCertificateId: null,
        reissueReason: "",
        deliveries: [],
      },
      invoices: {
        status: "draft",
        paidCents: 0,
        carrierPaidCents: 0,
        postedAt: null,
      },
      commissions: {
        status: "expected",
        receivedCents: 0,
        hasReceipts: false,
        adjustsCommissionId: null,
      },
      statements: { status: "review" },
      suggestions: { status: "new", votes: [], response: "" },
      forms: { status: "draft", linkId: null, publishedAt: null },
    };
    for (const [field, expected] of Object.entries(initial[kind] ?? {}))
      if (field in data && digest(data[field]) !== digest(expected))
        throw new AmsError(
          422,
          "lifecycle_required",
          `Use the dedicated workflow to change ${field}.`,
        );
  }
  private validateGenericUpdate(
    record: AmsRecord,
    patch: Record<string, unknown>,
  ) {
    const current = record.data as Record<string, unknown>;
    for (const field of [
      "accountId",
      "importOrigin",
      "leadIds",
      "consolidation",
      "consolidatedAccountIds",
      "previousPolicyId",
      "completedAt",
      "completedBy",
      ...(record.kind === "tasks"
        ? [
            "workflow",
            "followUp",
            "reminderGeneration",
            "previousTaskId",
            "nextTaskId",
          ]
        : []),
      ...(record.kind === "invoices"
        ? ["paidCents", "carrierPaidCents", "postedAt"]
        : []),
      "receivedCents",
      "adjustsCommissionId",
      "hasReceipts",
      ...(record.kind === "policies" ? ["nonrenewal", "reinstatements"] : []),
      "issuedAt",
      "issuedBy",
      "policySnapshots",
      ...(record.kind === "certificates"
        ? [
            "preparation",
            "documentId",
            "deliveries",
            "previousCertificateId",
            "reissueReason",
          ]
        : []),
      ...(record.kind === "suggestions" ? ["status", "votes", "response"] : []),
      ...(record.kind === "forms" ? ["status", "linkId", "publishedAt"] : []),
      "replacementPolicyIds",
    ])
      if (field in patch && digest(patch[field]) !== digest(current[field]))
        throw new AmsError(
          422,
          "immutable_field",
          `${field} is managed by the related workflow.`,
        );
    if (record.kind === "policies" && current.status !== "draft")
      throw new AmsError(
        409,
        "policy_revision_required",
        "Use an endorsement, cancellation, reinstatement, or new term to preserve the issued policy history.",
      );
    if (record.kind === "services" && current.status === "completed")
      throw new AmsError(
        409,
        "service_completed",
        "This request is already completed. Create a follow-up request to preserve its resolution.",
      );
    if (record.kind === "accounts" && patch.status === "archived")
      throw new AmsError(
        422,
        "lifecycle_required",
        "Use the archive action to retain the account relationship and record who archived it.",
      );
    if (record.kind === "invoices" && current.status !== "draft")
      throw new AmsError(
        409,
        "invoice_posted",
        "Posted invoices are immutable; reverse transactions and void before correcting them.",
      );
    if (
      record.kind === "commissions" &&
      (current.receivedCents !== 0 || current.hasReceipts)
    )
      throw new AmsError(
        409,
        "commission_posted",
        "Preserve reconciled amounts; create a separate adjustment transaction.",
      );
    if (
      record.kind === "certificates" &&
      ["issued", "void"].includes(String(current.status))
    )
      throw new AmsError(
        409,
        "certificate_finalized",
        "Issued certificate records are immutable. Void and create a new request.",
      );
    if (
      record.kind === "renewals" &&
      !nonterminalRenewals.has(String(current.stage))
    )
      throw new AmsError(
        409,
        "renewal_closed",
        "Preserve the outcome; create a new renewal case for further work.",
      );
    if (
      record.kind === "renewals" &&
      patch.stage &&
      !nonterminalRenewals.has(String(patch.stage))
    )
      throw new AmsError(
        422,
        "lifecycle_required",
        "Close the renewal with its replacement terms or a reason for loss.",
      );
    if (
      record.kind === "policies" &&
      patch.status &&
      patch.status !== current.status
    )
      throw new AmsError(
        422,
        "lifecycle_required",
        "Record policy issuance through the policy action.",
      );
    if (
      record.kind === "tasks" &&
      patch.status &&
      (patch.status === "done" || current.status === "done")
    )
      throw new AmsError(
        422,
        "lifecycle_required",
        "Use task completion or reopening to retain who finished it and when.",
      );
    if (
      record.kind === "commissions" &&
      patch.status &&
      !["expected", "exception"].includes(String(patch.status))
    )
      throw new AmsError(
        422,
        "lifecycle_required",
        "Use commission reconciliation to record actual receipts.",
      );
    if (record.kind === "services" && patch.status === "completed")
      throw new AmsError(
        422,
        "lifecycle_required",
        "Complete the request with a resolution.",
      );
    if (
      record.kind === "certificates" &&
      patch.status &&
      !["requested", "review"].includes(String(patch.status))
    )
      throw new AmsError(
        422,
        "lifecycle_required",
        "Use certificate issuance or void.",
      );
    if (
      record.kind === "invoices" &&
      patch.status &&
      patch.status !== current.status
    )
      throw new AmsError(
        422,
        "lifecycle_required",
        "Use invoice posting or void.",
      );
  }
}
export function invoiceTotals(invoice: AmsData<"invoices">) {
  const total = (type?: string) =>
    invoice.lines
      .filter((line) => !type || line.type === type)
      .reduce((sum, line) => sum + line.amountCents, 0);
  return {
    total: total(),
    premium: total("premium"),
    tax: total("tax"),
    fee: total("fee"),
  };
}
function debit(
  ledgerAccount: AmsData<"journals">["entries"][number]["ledgerAccount"],
  amount: number,
) {
  return { ledgerAccount, debitCents: amount, creditCents: 0 };
}
function credit(
  ledgerAccount: AmsData<"journals">["entries"][number]["ledgerAccount"],
  amount: number,
) {
  return { ledgerAccount, debitCents: 0, creditCents: amount };
}
function reverse(entries: AmsData<"journals">["entries"]) {
  return entries.map((entry) => ({
    ...entry,
    debitCents: entry.creditCents,
    creditCents: entry.debitCents,
  }));
}
