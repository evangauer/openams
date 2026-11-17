import type { AmsKind } from "./model";
export interface FieldSpec {
  key: string;
  label: string;
  type?:
    | "text"
    | "email"
    | "date"
    | "money"
    | "signedMoney"
    | "percent"
    | "long"
    | "select"
    | "member"
    | "account"
    | "policy"
    | "policies"
    | "document"
    | "documents"
    | "exposures"
    | "check"
    | "address"
    | "coverages"
    | "lines"
    | "facts"
    | "tags";
  required?: boolean;
  options?: string[];
  /** Display names for options, when the stored value doesn't read well alone. */
  labels?: Record<string, string>;
  default?: unknown;
  hint?: string;
  /** On a new record, tucked under "More details" so the form starts short. */
  more?: boolean;
  /** Takes the full width of the form. */
  span?: boolean;
}
const f = (
  key: string,
  label: string,
  type: FieldSpec["type"] = "text",
  required = false,
  options?: string[],
): FieldSpec => ({ key, label, type, required, options });
/** The same field, folded under "More details" on new records. */
const more = (spec: FieldSpec): FieldSpec => ({ ...spec, more: true });
const span = (spec: FieldSpec): FieldSpec => ({ ...spec, span: true });
const account = f("accountId", "Account", "account", true),
  policy = f("policyId", "Policy term", "policy", true),
  owner = f("ownerId", "Assigned to", "member"),
  notes = f("notes", "Internal notes", "long"),
  moreNotes = more(notes);
export const fields: Record<AmsKind, FieldSpec[]> = {
  workspace: [],
  accounts: [
    span(f("name", "Account name", "text", true)),
    f("type", "Account type", "select", true, ["business", "person"]),
    f("status", "Relationship", "select", true, [
      "prospect",
      "active",
      "inactive",
    ]),
    f("email", "Email", "email"),
    f("phone", "Phone"),
    f("serviceOwnerId", "Account manager", "member"),
    f("producerId", "Producer", "member"),
    more(f("legalName", "Legal entity name")),
    more(f("dba", "DBA")),
    more(f("industry", "Industry")),
    more(f("naics", "NAICS code")),
    more(f("website", "Website")),
    more(f("address", "Mailing address", "address")),
    more(f("tags", "Tags", "tags")),
    more(f("source", "Source")),
    more(f("externalId", "External record ID")),
    moreNotes,
  ],
  contacts: [
    account,
    f("name", "Full name", "text", true),
    f("title", "Title / role"),
    f("email", "Email", "email"),
    f("phone", "Phone"),
    f("primary", "Primary contact", "check"),
    more(f("mobile", "Mobile")),
    more(f("address", "Mailing address", "address")),
    moreNotes,
  ],
  exposures: [
    account,
    f("kind", "Exposure type", "select", true, [
      "location",
      "building",
      "vehicle",
      "driver",
      "payroll",
      "equipment",
      "operations",
    ]),
    f("name", "Description / identifier", "text", true),
    f("address", "Address", "address"),
    f("description", "Details", "long"),
    f("values", "Exposure facts", "facts"),
  ],
  policies: [
    account,
    f("number", "Policy number", "text", true),
    f("line", "Line of business", "text", true),
    f("carrier", "Writing carrier", "text", true),
    f("premiumCents", "Term premium", "money", true),
    f("effectiveDate", "Effective date", "date", true),
    f("expirationDate", "Expiration date", "date", true),
    {
      ...f("billing", "Billing", "select", true, ["direct", "agency"]),
      labels: { direct: "Direct bill", agency: "Agency bill" },
    },
    more(f("carrierNaic", "Carrier NAIC")),
    more(f("mga", "MGA / wholesaler")),
    more(f("taxCents", "Taxes", "money")),
    more(f("feeCents", "Fees", "money")),
    more(f("commissionBps", "Commission rate", "percent")),
    more(f("producerId", "Producer", "member")),
    more(f("coverages", "Coverages", "coverages")),
    more(f("exposureIds", "Covered exposures", "exposures")),
    moreNotes,
  ],
  renewals: [
    account,
    f("title", "Renewal name", "text", true),
    f("policyIds", "Expiring terms", "policies", true),
    f("expirationDate", "Expiration date", "date", true),
    owner,
    f("stage", "Stage", "select", true, [
      "review",
      "collecting",
      "marketing",
      "proposal",
      "waiting",
    ]),
    f("nextAction", "Next action"),
    f("followUpDate", "Follow-up date", "date"),
    more(f("waitingOn", "Waiting on")),
    moreNotes,
  ],
  tasks: [
    span(f("title", "What needs to happen?", "text", true)),
    { ...account, required: false },
    { ...policy, required: false },
    owner,
    f("dueDate", "Due date", "date", true),
    {
      ...f("priority", "Priority", "select", true, [
        "low",
        "normal",
        "high",
        "urgent",
      ]),
      default: "normal",
    },
    f("status", "Status", "select", true, ["open", "waiting"]),
    f("description", "Details", "long"),
  ],
  notes: [
    account,
    { ...policy, required: false },
    f("category", "Activity type", "select", true, [
      "note",
      "call",
      "meeting",
      "email",
      "review",
    ]),
    f("body", "What happened?", "long", true),
  ],
  services: [
    account,
    f("type", "Request type", "select", true, [
      "endorsement",
      "cancellation",
      "reinstatement",
      "certificate",
      "billing",
      "document",
      "general",
    ]),
    { ...policy, required: false },
    span(f("title", "Request summary", "text", true)),
    owner,
    f("dueDate", "Due date", "date", true),
    f("status", "Status", "select", true, ["open", "in_progress", "waiting"]),
    f("description", "Requested change", "long"),
    more(f("documentIds", "Supporting documents", "documents")),
  ],
  claims: [
    account,
    span(policy),
    f("dateOfLoss", "Date of loss", "date", true),
    f("reportedDate", "Date reported to agency", "date", true),
    f("description", "Loss details", "long", true),
    f("status", "Claim status", "select", true, [
      "notice",
      "reported",
      "open",
      "closed",
      "reopened",
    ]),
    owner,
    f("followUpDate", "Follow-up date", "date"),
    more(f("claimNumber", "Carrier claim number")),
    more(f("adjuster", "Adjuster")),
    more(f("adjusterEmail", "Adjuster email", "email")),
    more(f("adjusterPhone", "Adjuster phone")),
    more(f("reserveCents", "Recorded reserve", "money")),
    more(f("paidCents", "Recorded claim payments", "money")),
    more(f("documentIds", "Claim documents", "documents")),
    moreNotes,
  ],
  policychanges: [],
  reminders: [],
  correspondence: [],
  documents: [],
  certificatetemplates: [],
  certificateholders: [
    f("name", "Holder name", "text", true),
    f("address", "Address", "address"),
    f("email", "Email", "email"),
    notes,
  ],
  certificates: [
    account,
    f("holderName", "Certificate holder", "text", true),
    f("holderAddress", "Holder address", "address"),
    f("holderEmail", "Holder email", "email"),
    f("policyIds", "Policies to evidence", "policies", true),
    f("requestedDate", "Requested date", "date", true),
    owner,
    f("description", "Certificate requirements", "long"),
  ],
  invoices: [
    account,
    policy,
    f("number", "Invoice number", "text", true),
    f("issueDate", "Invoice date", "date", true),
    f("dueDate", "Due date", "date", true),
    f("lines", "Invoice items", "lines", true),
    f("commissionCents", "Agency commission", "money"),
    notes,
  ],
  payments: [],
  commissions: [
    account,
    policy,
    f("carrier", "Carrier", "text", true),
    f("transaction", "Transaction", "select", true, [
      "new_business",
      "renewal",
      "endorsement",
      "cancellation",
      "adjustment",
    ]),
    f("transactionDate", "Transaction date", "date", true),
    f("premiumCents", "Transaction premium", "signedMoney", true),
    f("expectedCents", "Expected commission", "signedMoney", true),
    f("producerId", "Producer", "member"),
    f("producerShareBps", "Producer share", "percent"),
    notes,
  ],
  journals: [],
  statements: [],
  // Suggestions have their own screen (suggestions.tsx), not the generic editor.
  suggestions: [],
};
export const actionFields: Record<string, FieldSpec[]> = {
  "policyChange.review": [
    f(
      "reviewed",
      "I reviewed the endorsement against the current policy",
      "check",
      true,
    ),
  ],
  "policy.nonrenew": [
    f("noticeDate", "Notice received date", "date", true),
    f("sourceReference", "Carrier notice reference", "text", true),
  ],
  "policy.withdrawNonrenewal": [
    f("sourceReference", "Carrier withdrawal confirmation", "text", true),
  ],
  "commission.adjust": [
    f("date", "Adjustment date", "date", true),
    f("premiumDeltaCents", "Premium adjustment", "signedMoney", true),
    f("commissionDeltaCents", "Commission adjustment", "signedMoney", true),
    f("sourceReference", "Carrier adjustment reference", "text", true),
  ],
  "journal.reverseCommission": [
    f("date", "Reversal date", "date", true),
    f("sourceReference", "Correction reference", "text", true),
  ],
  "commission.allocate": [
    f("producerId", "Producer", "member", true),
    f("producerShareBps", "Producer share", "percent", true),
  ],
  "policy.issue": [
    f(
      "sourceReference",
      "Carrier confirmation / source reference",
      "text",
      true,
    ),
    f("sourceDocumentId", "Issued policy document", "document"),
  ],
  "policy.endorse": [
    f("effectiveDate", "Endorsement effective date", "date", true),
    f("premiumDeltaCents", "Additional / return premium", "signedMoney", true),
    f("sourceReference", "Carrier endorsement reference", "text", true),
    f("sourceDocumentId", "Endorsement document", "document"),
    f("coverages", "Complete updated coverages", "coverages"),
  ],
  "policy.cancel": [
    f("effectiveDate", "Cancellation effective date", "date", true),
    f("sourceReference", "Carrier cancellation reference", "text", true),
  ],
  "policy.reinstate": [
    {
      ...f(
        "effectiveDate",
        "Carrier-confirmed reinstatement date",
        "date",
        true,
      ),
      hint: "Use the date on the carrier confirmation. The cancellation interval stays in history; equal cancellation and reinstatement dates record no lapse.",
    },
    f("sourceReference", "Carrier reinstatement reference", "text", true),
    f("sourceDocumentId", "Reinstatement document", "document"),
  ],
  "policy.renew": [
    f("number", "Renewal policy number", "text", true),
    f("effectiveDate", "New term effective date", "date", true),
    f("expirationDate", "New term expiration date", "date", true),
    f("premiumCents", "New term premium", "money", true),
  ],
  "renewal.close": [
    f("stage", "Outcome", "select", true, ["renewed", "lost"]),
    f("replacementPolicyIds", "Issued replacement terms", "policies"),
  ],
  "service.complete": [f("resolution", "How was this resolved?", "long", true)],
  "certificate.reissue": [
    f(
      "policyIds",
      "Replacement policy terms (choose explicitly)",
      "policies",
      true,
    ),
    f("requestedDate", "Requested date", "date", true),
  ],
  "certificate.issue": [
    f("documentId", "Reviewed certificate PDF", "document", true),
    {
      ...f(
        "reviewed",
        "I reviewed the final certificate and policy terms",
        "check",
        true,
      ),
      hint: "Records issuance of the reviewed PDF. Delivery to the holder is a separate workflow.",
    },
  ],
  "payment.record": [
    f("kind", "Transaction", "select", true, ["receipt", "carrier_payment"]),
    f("amountCents", "Amount", "money", true),
    {
      ...f("date", "Transaction date", "date", true),
      hint: "Use the actual date of a completed receipt or carrier payment, no later than today. This records money movement; it does not send money.",
    },
    f("method", "Method", "select", true, [
      "check",
      "ach",
      "card",
      "wire",
      "other",
    ]),
    f("reference", "Payment / bank reference", "text", true),
  ],
  "payment.reverse": [
    {
      ...f("date", "Reversal date", "date", true),
      hint: "Use a date on or after the original payment and no later than today.",
    },
  ],
  "commission.receive": [
    f("amountCents", "Commission received / returned", "signedMoney", true),
    f("date", "Statement date", "date", true),
    f("statementReference", "Carrier statement reference", "text", true),
  ],
};
export const actionLabels: Record<string, string> = {
  "account.startWorkflow": "Start workflow",
  "account.bulkAssign": "Assign account team",
  "account.consolidate": "Consolidate accounts",
  "account.undoConsolidation": "Undo account consolidation",
  "policyChange.apply": "Apply due endorsement",
  "policyChange.review": "Review against current policy",
  "policyChange.withdraw": "Withdraw scheduled endorsement",
  "policy.nonrenew": "Record nonrenewal notice",
  "policy.withdrawNonrenewal": "Withdraw nonrenewal notice",
  "commission.adjust": "Create linked adjustment",
  "journal.reverseCommission": "Reverse commission receipt",
  "policy.issue": "Record issued policy",
  "policy.endorse": "Record endorsement",
  "policy.cancel": "Record cancellation",
  "policy.reinstate": "Record reinstatement",
  "policy.renew": "Create next term",
  "renewal.close": "Close renewal",
  "task.complete": "Complete task",
  "task.reopen": "Reopen task",
  "service.complete": "Complete request",
  "certificate.issue": "Record issued certificate",
  "certificate.void": "Void certificate",
  "certificate.reissue": "Create reissue request",
  "invoice.post": "Post invoice",
  "invoice.void": "Void invoice",
  "payment.record": "Record payment",
  "payment.reverse": "Reverse payment",
  "commission.receive": "Reconcile commission",
  "commission.allocate": "Set producer share",
  "statement.post": "Post matched rows",
  "statement.match": "Match statement row",
  archive: "Archive record",
  restore: "Restore record",
};
