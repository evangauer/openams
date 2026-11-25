import { z } from "zod";
import { AmsFormSchema, AmsFormSubmissionSchema } from "./forms.js";
export * from "./forms.js";
export * from "./form-catalog.js";
export type { AmsMailboxProvider, AmsMailboxMessageStatus, AmsMailboxError, AmsMailbox, AmsIncomingMessage, AmsMailboxList, AmsMailboxFolderPage } from "./mailbox.js";

export const AMS_SCHEMA_VERSION = 1;
export const AmsTimeZone = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((timeZone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid agency calendar time zone.");
export function amsCalendarDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export const AmsId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const AmsText = z.string().trim().min(1).max(500);
export const AmsDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Use a valid calendar date.");
export const AmsCents = z.number().int().safe().min(0).max(1_000_000_000_00);
export const AmsSignedCents = z
  .number()
  .int()
  .safe()
  .min(-1_000_000_000_00)
  .max(1_000_000_000_00);
const optionalText = z.string().trim().max(500).default("");
const note = z.string().trim().max(10_000).default("");
const reference = AmsId.nullable().default(null);
/** Source attribution is separate from the authenticated local audit history. */
export const AmsImportOriginSchema = z
  .object({
    source: z.string().trim().min(1).max(80),
    externalId: AmsText,
    sourceCreatedAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .default(null),
    sourceAuthor: optionalText,
  })
  .strict();
const importOrigin = AmsImportOriginSchema.nullable().default(null);
export const AmsAddressSchema = z
  .object({
    line1: optionalText,
    line2: optionalText,
    city: optionalText,
    state: z.string().max(2).default(""),
    postalCode: z.string().max(20).default(""),
    country: z.string().max(2).default("US"),
  })
  .strict();
export const AmsRoleSchema = z.enum([
  "admin",
  "manager",
  "member",
  "accountant",
  "viewer",
]);
export type AmsRole = z.infer<typeof AmsRoleSchema>;
export const AmsMemberSchema = z.object({
  id: AmsId,
  name: AmsText,
  email: z.string().email(),
  role: AmsRoleSchema,
  active: z.boolean(),
});
export type AmsMember = z.infer<typeof AmsMemberSchema>;
/** Account-owned entity identities stay stable across renames and consolidation. */
export const AmsInsuredEntitySchema = z
  .object({
    id: AmsId,
    name: AmsText,
    dba: optionalText,
    type: z
      .enum([
        "corporation",
        "llc",
        "partnership",
        "sole_proprietor",
        "individual",
        "trust",
        "other",
      ])
      .default("other"),
    address: AmsAddressSchema.prefault({}),
    inactive: z.boolean().default(false),
    notes: note,
  })
  .strict();
export const AmsAccountRelationshipSchema = z
  .object({
    accountId: AmsId,
    type: z.enum(["parent", "subsidiary", "common_ownership", "related"]),
    notes: z.string().trim().max(1000).default(""),
  })
  .strict();
export const AmsCustomFieldSchema = z
  .object({
    id: AmsId,
    label: z.string().trim().min(1).max(80),
    type: z.enum(["text", "number", "date", "boolean"]),
    value: z.union([
      z.string().trim().max(2000),
      z.number().finite(),
      z.boolean(),
    ]),
  })
  .strict()
  .superRefine((field, ctx) => {
    const valid =
      field.type === "number"
        ? typeof field.value === "number"
        : field.type === "boolean"
          ? typeof field.value === "boolean"
          : typeof field.value === "string" &&
            (field.type !== "date" || AmsDate.safeParse(field.value).success);
    if (!valid)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "Use a value that matches the field type.",
      });
  });
export const AmsAccountSchema = z
  .object({
    name: AmsText,
    legalName: optionalText,
    dba: optionalText,
    type: z.enum(["business", "person"]).default("business"),
    status: z
      .enum(["prospect", "active", "inactive", "archived"])
      .default("prospect"),
    // Historical clients accepted free-form email text. Preserve it on reads;
    // the command service requires a valid address on new saves.
    industry: optionalText,
    naics: z.string().max(10).default(""),
    email: z.string().max(254).default(""),
    phone: z.string().max(40).default(""),
    website: z.union([z.string().url().max(500), z.literal("")]).default(""),
    address: AmsAddressSchema.prefault({}),
    producerId: reference,
    serviceOwnerId: reference,
    source: optionalText,
    externalId: optionalText,
    leadIds: z.array(AmsId).max(1000).default([]),
    insuredEntities: z.array(AmsInsuredEntitySchema).max(100).default([]),
    relationships: z.array(AmsAccountRelationshipSchema).max(50).default([]),
    customFields: z.array(AmsCustomFieldSchema).max(50).default([]),
    // Managed only by account.consolidate / account.undoConsolidation.
    consolidatedAccountIds: z.array(AmsId).max(20).default([]),
    consolidation: z
      .object({
        targetId: AmsId,
        at: z.string().datetime(),
        by: AmsId,
        targetEpoch: z.number().int().safe().positive(),
        targetVersion: z.string().regex(/^[a-f0-9]{64}$/),
        sourceProfileDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable()
      .default(null),
    tags: z.array(z.string().trim().min(1).max(50)).max(25).default([]),
    notes: note,
  })
  .strict();
export const AmsContactSchema = z
  .object({
    importOrigin,
    accountId: AmsId,
    name: AmsText,
    title: optionalText,
    email: z.union([z.string().email().max(254), z.literal("")]).default(""),
    phone: z.string().max(40).default(""),
    mobile: z.string().max(40).default(""),
    primary: z.boolean().default(false),
    address: AmsAddressSchema.prefault({}),
    notes: note,
  })
  .strict();
export const AmsExposureSchema = z
  .object({
    importOrigin,
    accountId: AmsId,
    kind: z.enum([
      "location",
      "building",
      "vehicle",
      "driver",
      "payroll",
      "equipment",
      "operations",
    ]),
    name: AmsText,
    address: AmsAddressSchema.prefault({}),
    description: note,
    values: z
      .record(
        z.string().max(100),
        z.union([z.string().max(1000), z.number().finite(), z.boolean()]),
      )
      .default({}),
  })
  .strict()
  .refine(
    (value) => Object.keys(value.values).length <= 50,
    "At most 50 exposure facts.",
  );
export const AmsCoverageSchema = z
  .object({
    name: AmsText,
    limit: optionalText,
    deductible: optionalText,
    notes: z.string().max(2000).default(""),
  })
  .strict();
/** Carrier-confirmed reinstatement; retains the preceding cancellation evidence. */
export const AmsReinstatementSchema = z
  .object({
    cancellationDate: AmsDate,
    cancellationReason: AmsText,
    cancellationReference: AmsText,
    effectiveDate: AmsDate,
    sourceReference: AmsText,
    sourceDocumentId: reference,
    reason: AmsText,
    recordedAt: z.string().datetime(),
    recordedBy: AmsId,
  })
  .strict();
export const AmsPolicySchema = z
  .object({
    accountId: AmsId,
    number: AmsText,
    line: AmsText,
    carrier: AmsText,
    carrierId: reference,
    carrierNaic: z.string().max(10).default(""),
    mga: optionalText,
    effectiveDate: AmsDate,
    expirationDate: AmsDate,
    status: z
      .enum(["draft", "active", "cancelled", "nonrenewed", "expired"])
      .default("draft"),
    billing: z.enum(["direct", "agency"]).default("direct"),
    premiumCents: AmsCents,
    taxCents: AmsCents.default(0),
    feeCents: AmsCents.default(0),
    commissionBps: z.number().int().min(0).max(10000).default(0),
    producerId: reference,
    previousPolicyId: reference,
    sourceDocumentId: reference,
    sourceReference: optionalText,
    coverages: z.array(AmsCoverageSchema).max(100).default([]),
    exposureIds: z.array(AmsId).max(200).default([]),
    cancellationDate: AmsDate.nullable().default(null),
    cancellationReason: optionalText,
    reinstatements: z.array(AmsReinstatementSchema).max(100).default([]),
    nonrenewal: z
      .object({
        noticeDate: AmsDate,
        reason: AmsText,
        sourceReference: AmsText,
      })
      .strict()
      .nullable()
      .default(null),
    notes: note,
  })
  .strict()
  .refine(
    (value) => value.expirationDate > value.effectiveDate,
    "Expiration must follow the effective date.",
  )
  .refine(
    (value) =>
      value.reinstatements.every(
        (event, index, events) =>
          event.cancellationDate >= value.effectiveDate &&
          event.effectiveDate >= event.cancellationDate &&
          event.effectiveDate < value.expirationDate &&
          (!index ||
            event.cancellationDate >= events[index - 1].effectiveDate) &&
          (!value.cancellationDate ||
            value.cancellationDate >= event.effectiveDate),
      ),
    "Reinstatements must follow their cancellations, remain within the term, and retain their order.",
  );
/** Recorded status as of a calendar date; does not determine carrier coverage. */
export function amsPolicyStatusAt(
  policy: z.infer<typeof AmsPolicySchema>,
  date: string,
) {
  if (policy.status === "draft") return "draft";
  if (policy.cancellationDate && policy.cancellationDate <= date)
    return "cancelled";
  if (
    policy.reinstatements?.some(
      (event) => date >= event.cancellationDate && date < event.effectiveDate,
    )
  )
    return "cancelled";
  if (date >= policy.expirationDate)
    return policy.nonrenewal || policy.status === "nonrenewed"
      ? "nonrenewed"
      : "expired";
  if (date < policy.effectiveDate) return "scheduled";
  if (policy.status === "cancelled" && !policy.cancellationDate)
    return "cancelled";
  return "active";
}
export const AmsEndorsementChangeSchema = z
  .object({
    effectiveDate: AmsDate,
    premiumDeltaCents: AmsSignedCents,
    coverages: z.array(AmsCoverageSchema).max(100).optional(),
    sourceReference: AmsText,
    sourceDocumentId: AmsId.nullable().optional(),
    notes: z.string().max(10000).optional(),
  })
  .strict();
export const AmsPolicyChangeSchema = z
  .object({
    accountId: AmsId,
    policyId: AmsId,
    name: AmsText,
    baseVersion: z.string().regex(/^[a-f0-9]{64}$/),
    change: AmsEndorsementChangeSchema,
    status: z.enum(["scheduled", "applied", "withdrawn"]).default("scheduled"),
    appliedAt: z.string().datetime().nullable().default(null),
    appliedBy: reference,
  })
  .strict();
export const AmsRenewalSchema = z
  .object({
    accountId: AmsId,
    title: AmsText,
    policyIds: z.array(AmsId).min(1).max(100),
    expirationDate: AmsDate,
    ownerId: reference,
    stage: z
      .enum([
        "review",
        "collecting",
        "marketing",
        "proposal",
        "waiting",
        "renewed",
        "lost",
      ])
      .default("review"),
    nextAction: optionalText,
    followUpDate: AmsDate.nullable().default(null),
    waitingOn: optionalText,
    outcomeReason: optionalText,
    replacementPolicyIds: z.array(AmsId).max(100).default([]),
    quoteLeadIds: z.array(AmsId).max(100).default([]),
    notes: note,
  })
  .strict();
export const AmsTaskFollowUpSchema = z
  .object({
    reminderDaysBefore: z
      .number()
      .int()
      .min(0)
      .max(365)
      .nullable()
      .default(null),
    escalationAfterDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .nullable()
      .default(null),
    escalationOwnerId: reference,
    repeatEveryDays: z.number().int().min(1).max(366).nullable().default(null),
    repeatUntil: AmsDate.nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.escalationAfterDays !== null) !==
      (value.escalationOwnerId !== null)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose both an escalation delay and an escalation owner.",
      });
    if (value.repeatUntil && !value.repeatEveryDays)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose a repeat interval before an end date.",
      });
  });
export const AmsReminderSchema = z
  .object({
    accountId: reference,
    taskId: AmsId,
    generation: z.number().int().safe().positive(),
    type: z.enum(["due", "escalation"]),
    ownerId: AmsId,
    dueDate: AmsDate,
    title: AmsText,
    status: z.enum(["scheduled", "ready", "dismissed", "cancelled", "blocked"]),
    queueKey: z.string().max(160).nullable().default(null),
    deliveredAt: z.string().datetime().nullable().default(null),
    dismissedAt: z.string().datetime().nullable().default(null),
    dismissedBy: reference,
    detail: optionalText,
  })
  .strict();
export const AmsCorrespondenceSchema = z
  .object({
    accountId: AmsId,
    policyId: reference,
    subject: AmsText,
    from: z.string().max(2000),
    to: z.string().max(4000),
    cc: z.string().max(4000).default(""),
    direction: z.enum(["inbound", "outbound", "unknown"]),
    messageAt: z.string().datetime().nullable().default(null),
    messageId: z.string().max(1000).default(""),
    body: z.string().max(20_000),
    bodyTruncated: z.boolean(),
    source: z.enum(["eml_upload", "relay_mailbox", "gmail", "microsoft365"]),
    sourceLeadId: reference,
    sourceMessageId: z.string().min(1).max(2048).nullable().default(null),
    sourceConnectionId: reference,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    originalDocumentId: AmsId,
    documentIds: z.array(AmsId).min(1).max(31),
    attachmentCount: z.number().int().min(0).max(30),
    unextractedAttachments: z.array(z.string().max(200)).max(30).default([]),
    filedBy: AmsId,
    filedAt: z.string().datetime(),
  })
  .strict();
export const AmsTaskSchema = z
  .object({
    importOrigin,
    accountId: reference,
    policyId: reference,
    renewalId: reference,
    title: AmsText,
    description: note,
    ownerId: reference,
    dueDate: AmsDate,
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    status: z.enum(["open", "waiting", "done"]).default("open"),
    completedAt: z.string().datetime().nullable().default(null),
    completedBy: reference,
    followUp: AmsTaskFollowUpSchema.prefault({}),
    reminderGeneration: z.number().int().safe().nonnegative().default(0),
    previousTaskId: reference,
    nextTaskId: reference,
    workflow: z
      .object({
        id: AmsId,
        title: AmsText,
        step: z.number().int().min(1).max(30),
        total: z.number().int().min(1).max(30),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export const AmsNoteSchema = z
  .object({
    importOrigin,
    accountId: AmsId,
    policyId: reference,
    body: z.string().trim().min(1).max(20_000),
    category: z
      .enum(["note", "call", "meeting", "email", "review"])
      .default("note"),
    occurredAt: z.string().datetime(),
  })
  .strict();
export const AmsServiceSchema = z
  .object({
    accountId: AmsId,
    policyId: reference,
    type: z.enum([
      "endorsement",
      "cancellation",
      "reinstatement",
      "certificate",
      "billing",
      "document",
      "general",
    ]),
    title: AmsText,
    description: note,
    ownerId: reference,
    dueDate: AmsDate,
    status: z
      .enum(["open", "in_progress", "waiting", "completed"])
      .default("open"),
    resolution: note,
    documentIds: z.array(AmsId).max(50).default([]),
  })
  .strict();
export const AmsClaimSchema = z
  .object({
    accountId: AmsId,
    policyId: AmsId,
    dateOfLoss: AmsDate,
    reportedDate: AmsDate,
    description: z.string().trim().min(1).max(10_000),
    claimNumber: optionalText,
    status: z
      .enum(["notice", "reported", "open", "closed", "reopened"])
      .default("notice"),
    adjuster: optionalText,
    adjusterEmail: z.union([z.string().email(), z.literal("")]).default(""),
    adjusterPhone: z.string().max(40).default(""),
    ownerId: reference,
    followUpDate: AmsDate.nullable().default(null),
    reserveCents: AmsCents.default(0),
    paidCents: AmsCents.default(0),
    documentIds: z.array(AmsId).max(100).default([]),
    notes: note,
  })
  .strict();
export const AmsDocumentSchema = z
  .object({
    accountId: AmsId,
    policyId: reference,
    name: AmsText,
    mediaType: AmsText,
    bytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    storageKey: AmsText,
    category: z
      .enum([
        "policy",
        "endorsement",
        "application",
        "certificate",
        "claims",
        "billing",
        "correspondence",
        "other",
      ])
      .default("other"),
    supersedesId: reference,
    description: note,
  })
  .strict();
export const AmsCertificateHolderSchema = z
  .object({
    name: AmsText,
    address: AmsAddressSchema.prefault({}),
    email: z.union([z.string().email(), z.literal("")]).default(""),
    notes: note,
  })
  .strict();
export const AmsCertificateTemplateSchema = z
  .object({
    name: AmsText,
    edition: AmsText,
    authorization: AmsText,
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    authorizedBy: AmsId,
    authorizedAt: z.string().datetime(),
    storageKey: z.string().min(1).max(500),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024),
    fields: z
      .array(
        z
          .object({
            pdfKey: z.string().min(1).max(250),
            type: z.enum(["text", "checkbox"]),
            label: AmsText,
            section: AmsText,
            maxLength: z.number().int().positive().max(4000),
            multiline: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(150),
    revokedAt: z.string().datetime().nullable().default(null),
    revocationReason: optionalText,
  })
  .strict();
export const AmsCertificateDeliverySchema = z
  .object({
    id: z.string().uuid(),
    recipient: AmsText,
    method: z.enum(["email", "portal", "mail", "in_person"]),
    deliveredAt: z.string().datetime(),
    evidence: z.string().trim().min(1).max(1000),
    documentId: AmsId,
    documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: z.string().datetime(),
    recordedBy: AmsId,
  })
  .strict();
export const AmsCertificatePreparationSchema = z
  .object({
    formId: AmsText,
    templateId: reference,
    requestFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    templateSha256: z.string().regex(/^[a-f0-9]{64}$/),
    accountVersion: AmsText,
    policyVersions: z
      .array(z.object({ id: AmsId, version: AmsText }).strict())
      .min(1)
      .max(25),
    fields: z
      .record(z.string().max(250), z.union([z.string().max(4000), z.boolean()]))
      .refine((value) => Object.keys(value).length <= 150),
  })
  .strict();
export const AmsCertificateSchema = z
  .object({
    accountId: AmsId,
    holderName: AmsText,
    holderId: reference,
    serviceId: reference,
    previousCertificateId: reference,
    reissueReason: optionalText,
    deliveries: z.array(AmsCertificateDeliverySchema).max(100).default([]),
    preparation: AmsCertificatePreparationSchema.nullable().default(null),
    holderAddress: AmsAddressSchema.prefault({}),
    holderEmail: z.union([z.string().email(), z.literal("")]).default(""),
    description: note,
    policyIds: z.array(AmsId).min(1).max(25),
    status: z
      .enum(["requested", "review", "issued", "void"])
      .default("requested"),
    requestedDate: AmsDate,
    ownerId: reference,
    documentId: reference,
    issuedAt: z.string().datetime().nullable().default(null),
    issuedBy: reference,
    policySnapshots: z
      .array(z.object({ id: AmsId, version: AmsText, data: AmsPolicySchema }))
      .max(25)
      .default([]),
    voidReason: optionalText,
  })
  .strict();
export const AmsInvoiceLineSchema = z
  .object({
    description: AmsText,
    type: z.enum(["premium", "tax", "fee"]),
    amountCents: AmsCents,
  })
  .strict();
export const AmsInvoiceSchema = z
  .object({
    accountId: AmsId,
    policyId: AmsId,
    number: AmsText,
    issueDate: AmsDate,
    dueDate: AmsDate,
    lines: z.array(AmsInvoiceLineSchema).min(1).max(100),
    commissionCents: AmsCents.default(0),
    status: z.enum(["draft", "posted", "void"]).default("draft"),
    paidCents: AmsCents.default(0),
    carrierPaidCents: AmsCents.default(0),
    postedAt: z.string().datetime().nullable().default(null),
    notes: note,
  })
  .strict();
export const AmsPaymentSchema = z
  .object({
    accountId: AmsId,
    invoiceId: AmsId,
    amountCents: AmsCents.positive(),
    date: AmsDate,
    method: z.enum(["check", "ach", "card", "wire", "other"]),
    reference: AmsText,
    kind: z.enum(["receipt", "carrier_payment", "refund"]),
    reversedPaymentId: reference,
    status: z.enum(["posted", "reversed"]).default("posted"),
    notes: note,
  })
  .strict();
export const AmsCommissionSchema = z
  .object({
    accountId: AmsId,
    policyId: AmsId,
    carrier: AmsText,
    transaction: z.enum([
      "new_business",
      "renewal",
      "endorsement",
      "cancellation",
      "adjustment",
    ]),
    transactionDate: AmsDate,
    premiumCents: AmsSignedCents,
    expectedCents: AmsSignedCents,
    receivedCents: AmsSignedCents.default(0),
    hasReceipts: z.boolean().default(false),
    status: z
      .enum(["expected", "partial", "reconciled", "exception"])
      .default("expected"),
    adjustsCommissionId: reference,
    sourceReference: optionalText,
    statementReference: optionalText,
    producerId: reference,
    producerShareBps: z.number().int().min(0).max(10000).default(0),
    notes: note,
  })
  .strict();
export const AmsStatementRowSchema = z
  .object({
    id: AmsId,
    policyNumber: AmsText,
    effectiveDate: AmsDate,
    transactionDate: AmsDate.nullable().default(null),
    paidDate: AmsDate.nullable().default(null),
    transaction: AmsCommissionSchema.shape.transaction.nullable().default(null),
    premiumCents: AmsSignedCents.nullable().default(null),
    commissionCents: AmsSignedCents.refine(
      (value) => value !== 0,
      "A statement row must have a nonzero commission.",
    ),
    commissionId: reference,
    commissionVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    status: z.enum(["unmatched", "matched", "posted"]).default("unmatched"),
    postedAt: z.string().datetime().nullable().default(null),
  })
  .strict();
export const AmsStatementSchema = z
  .object({
    carrier: AmsText,
    reference: AmsText,
    statementDate: AmsDate,
    status: z.enum(["review", "partial", "posted"]).default("review"),
    sourceName: optionalText,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rows: z.array(AmsStatementRowSchema).min(1).max(50),
    notes: note,
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.rows.map((row) => row.id)).size === value.rows.length,
    "Statement row IDs must be unique.",
  );
export const AmsLedgerAccountSchema = z.enum([
  "accounts_receivable",
  "trust_cash",
  "carrier_payable",
  "tax_payable",
  "commission_receivable",
  "operating_cash",
  "commission_income",
  "fee_income",
]);
export const AmsJournalSchema = z
  .object({
    date: AmsDate,
    description: AmsText,
    accountId: reference,
    policyId: reference,
    sourceKind: AmsText,
    sourceId: AmsId,
    reversalOf: reference,
    entries: z
      .array(
        z
          .object({
            ledgerAccount: AmsLedgerAccountSchema,
            debitCents: AmsCents,
            creditCents: AmsCents,
          })
          .strict(),
      )
      .min(2)
      .max(20),
  })
  .strict()
  .refine(
    (value) =>
      value.entries.every(
        (entry) => entry.debitCents > 0 !== entry.creditCents > 0,
      ) &&
      value.entries.reduce(
        (sum, entry) => sum + entry.debitCents - entry.creditCents,
        0,
      ) === 0,
    "Every posting must balance and each entry must have one positive side.",
  );

/** Agency setup is operational configuration, not cutover approval. */
export const AmsWorkspaceProfileSchema = z
  .object({
    name: AmsText,
    timeZone: AmsTimeZone,
    email: z.union([z.literal(""), z.string().email().max(254)]).default(""),
    phone: optionalText,
    billingMode: z.enum(["direct", "mixed", "agency"]).default("direct"),
    adoptionMode: z.enum(["alongside", "primary"]).default("alongside"),
    sourceSystem: z.string().trim().max(100).default(""),
    emailPlan: z
      .enum(["undecided", "manual", "microsoft", "google"])
      .default("undecided"),
    accountingPlan: z
      .enum(["undecided", "external", "ams_direct_bill"])
      .default("undecided"),
    defaultOwnerId: reference,
  })
  .strict();
/** Saved agency setup: the profile itself. Older records may still carry retired setup-review fields; the next save drops them. */
export const AmsWorkspaceSchema = AmsWorkspaceProfileSchema;

/**
 * Feature suggestions from the agency's own team. They stay in the agency's records;
 * sharing one with the OpenAMS project is a separate, explicit step by a person.
 */
export const AMS_SUGGESTION_AREAS = [
  "setup",
  "accounts",
  "policies",
  "renewals",
  "tasks",
  "email",
  "certificates",
  "financials",
  "reports",
  "team",
  "other",
] as const;
export const AMS_SUGGESTION_STATUSES = [
  "new",
  "considering",
  "planned",
  "done",
  "declined",
] as const;
export const AmsSuggestionSchema = z
  .object({
    title: z.string().trim().min(3).max(140),
    detail: z.string().trim().max(4000).default(""),
    area: z.enum(AMS_SUGGESTION_AREAS).default("other"),
    status: z.enum(AMS_SUGGESTION_STATUSES).default("new"),
    /** Member ids who support the suggestion, changed only by suggestion.vote. */
    votes: z.array(AmsId).max(500).default([]),
    /** A manager's reply, changed only by suggestion.respond. */
    response: z.string().trim().max(2000).default(""),
  })
  .strict();

export const AMS_KINDS = [
  "workspace",
  "accounts",
  "contacts",
  "exposures",
  "policies",
  "policychanges",
  "renewals",
  "tasks",
  "notes",
  "reminders",
  "correspondence",
  "services",
  "claims",
  "documents",
  "certificates",
  "certificateholders",
  "certificatetemplates",
  "invoices",
  "payments",
  "commissions",
  "journals",
  "statements",
  "suggestions",
  "forms",
  "formsubmissions",
] as const;
export const AmsKindSchema = z.enum(AMS_KINDS);
export type AmsKind = z.infer<typeof AmsKindSchema>;
export const AMS_DATA_SCHEMAS = {
  workspace: AmsWorkspaceSchema,
  accounts: AmsAccountSchema,
  contacts: AmsContactSchema,
  exposures: AmsExposureSchema,
  policies: AmsPolicySchema,
  policychanges: AmsPolicyChangeSchema,
  renewals: AmsRenewalSchema,
  tasks: AmsTaskSchema,
  notes: AmsNoteSchema,
  reminders: AmsReminderSchema,
  correspondence: AmsCorrespondenceSchema,
  services: AmsServiceSchema,
  claims: AmsClaimSchema,
  documents: AmsDocumentSchema,
  certificates: AmsCertificateSchema,
  certificateholders: AmsCertificateHolderSchema,
  certificatetemplates: AmsCertificateTemplateSchema,
  invoices: AmsInvoiceSchema,
  payments: AmsPaymentSchema,
  commissions: AmsCommissionSchema,
  journals: AmsJournalSchema,
  statements: AmsStatementSchema,
  suggestions: AmsSuggestionSchema,
  forms: AmsFormSchema,
  formsubmissions: AmsFormSubmissionSchema,
} as const;
export type AmsData<K extends AmsKind = AmsKind> = z.infer<
  (typeof AMS_DATA_SCHEMAS)[K]
>;
export interface AmsRecord<K extends AmsKind = AmsKind> {
  id: string;
  kind: K;
  version: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  archivedAt: string | null;
  data: AmsData<K>;
}
export interface AmsAudit {
  id: string;
  sequence: number;
  commandId: string;
  action: string;
  actorId: string;
  actorName: string;
  at: string;
  accountId: string | null;
  accountIds?: string[];
  records: {
    kind: AmsKind;
    id: string;
    beforeVersion: string | null;
    afterVersion: string;
    revision: number;
  }[];
  reason: string;
  details: Record<string, unknown>;
}
export interface AmsActor {
  userId: string;
  tenantId: string;
  name: string;
  role: AmsRole;
}
export interface AmsPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface AmsCommandResult {
  records: AmsRecord[];
  audit: AmsAudit;
  replayed?: boolean;
}
export const AmsCommandSchema = z
  .object({
    id: z.string().uuid(),
    action: z.enum([
      "create",
      "update",
      "archive",
      "restore",
      "workspace.configure",
      "account.startWorkflow",
      "account.bulkAssign",
      "account.consolidate",
      "account.undoConsolidation",
      "policy.issue",
      "policy.endorse",
      "policy.cancel",
      "policy.reinstate",
      "policy.renew",
      "policy.nonrenew",
      "policyChange.apply",
      "policyChange.review",
      "policyChange.withdraw",
      "policy.withdrawNonrenewal",
      "renewal.close",
      "task.followUp",
      "reminder.deliver",
      "reminder.dismiss",
      "reminder.snooze",
      "reminder.retry",
      "correspondence.file",
      "task.complete",
      "task.reopen",
      "service.complete",
      "certificate.prepare",
      "certificate.issue",
      "certificate.void",
      "certificate.deliver",
      "certificate.reissue",
      "template.revoke",
      "invoice.post",
      "invoice.void",
      "payment.record",
      "payment.reverse",
      "commission.receive",
      "commission.allocate",
      "commission.adjust",
      "journal.reverseCommission",
      "statement.match",
      "statement.post",
      "suggestion.vote",
      "suggestion.respond",
      "form.publish",
      "form.pause",
      "formSubmission.receive",
      "formSubmission.file",
      "formSubmission.dismiss",
      "formSubmission.reopen",
    ]),
    kind: AmsKindSchema,
    recordId: AmsId.optional(),
    expectedVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    data: z.record(z.string(), z.unknown()).default({}),
    reason: z.string().trim().max(2000).default(""),
  })
  .strict();
export type AmsCommand = z.infer<typeof AmsCommandSchema>;
export const AmsListSchema = z
  .object({
    accountId: AmsId.optional(),
    status: z.string().max(40).optional(),
    ownerId: AmsId.optional(),
    query: z.string().trim().max(200).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    includeArchived: z.enum(["true", "false"]).default("false"),
  })
  .strict();
export type AmsList = z.infer<typeof AmsListSchema>;
export const AMS_FINANCIAL_KINDS: readonly AmsKind[] = [
  "invoices",
  "payments",
  "commissions",
  "journals",
  "statements",
];
export function amsCanWrite(role: AmsRole, kind: AmsKind) {
  // Agency setup, approved templates and what the agency publishes to the public.
  if (kind === "workspace" || kind === "certificatetemplates" || kind === "forms")
    return ["admin", "manager"].includes(role);
  // Everyone on the team, viewers included, can suggest and support ideas.
  if (kind === "suggestions") return true;
  return (
    role !== "viewer" &&
    (AMS_FINANCIAL_KINDS.includes(kind)
      ? ["admin", "manager", "accountant"].includes(role)
      : role !== "accountant" ||
        ["documents", "notes", "tasks", "reminders", "correspondence"].includes(
          kind,
        ))
  );
}
export function amsCanRead(role: AmsRole, kind: AmsKind) {
  return (
    !AMS_FINANCIAL_KINDS.includes(kind) ||
    ["admin", "manager", "accountant"].includes(role)
  );
}

/** Round a signed monetary amount times a basis-point rate symmetrically. */
export function amsBasisPoints(cents: number, bps: number): number {
  return Math.sign(cents) * Math.floor((Math.abs(cents) * bps + 5000) / 10000);
}

/*
 * Team chat: one room for the whole agency and one-to-one threads between active
 * members. A thread key is "team" or "direct:<the other member's id>", always from
 * the reader's side.
 */
export const AMS_CHAT_TEAM = "team";
export const AmsChatPostSchema = z
  .object({
    /** Chosen by the sender so a retried send never posts twice. */
    id: z.string().uuid(),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export const AmsChatReadSchema = z
  .object({ sequence: z.number().int().min(0).safe() })
  .strict();
export const AmsChatPulseSchema = z
  .object({
    /** False from a hidden tab: refresh the counts without marking the person here. */
    active: z.boolean().default(true),
  })
  .strict();
export const AmsChatHistorySchema = z
  .object({
    after: z.coerce.number().int().min(0).safe().optional(),
    before: z.coerce.number().int().min(1).safe().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export interface AmsChatMessage {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
  /** Increases with every message; use it to page and to mark a thread read. */
  sequence: number;
}
export interface AmsChatThread {
  thread: string;
  last: AmsChatMessage | null;
  unread: number;
}
export interface AmsChatPulse {
  /** Server time, so "last seen" is measured on one clock. */
  now: string;
  /** Member id to when that member last had OpenAMS open in front of them. */
  seen: Record<string, string>;
  threads: AmsChatThread[];
}
export interface AmsChatHistory {
  messages: AmsChatMessage[];
  /** The reader's own read marker for this thread. */
  read: number;
}
export const amsChatDirectThread = (memberId: string) => `direct:${memberId}`;
