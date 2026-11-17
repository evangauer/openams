"use client";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Loader2,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { AMS_DATA_SCHEMAS } from "@openams/contracts";
import { fields, actionFields, actionLabels, type FieldSpec } from "./fields";
import {
  AgencyRequestError,
  command,
  dateLabel,
  human,
  request,
  recordTitle,
  singular,
  today,
  type AgencySession,
  type AmsRecord,
  type AmsKind,
  type AmsCommand,
  type Book,
} from "./model";

import { ExposureFacts } from "./exposure-facts";
import {
  accountDuplicateCandidates,
  sameAccount,
} from "./account-identity-model";
import { Choice, Picker, initialsOf, type PickerOption } from "./picker";

export interface EditIntent {
  kind: AmsKind;
  record?: AmsRecord;
  action?: AmsCommand["action"];
  accountId?: string;
  initial?: Record<string, unknown>;
}
type Values = Record<string, unknown>;

/** Same month and day next year; Feb 29 becomes Feb 28. */
const plusYear = (date: string) =>
  `${Number(date.slice(0, 4)) + 1}${date.slice(4) === "-02-29" ? "-02-28" : date.slice(4)}`;
const plusDays = (date: string, days: number) => {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};
/** Fields cleared when the account changes: they point at that account's records. */
const accountLinked = [
  "policyId",
  "policyIds",
  "documentId",
  "documentIds",
  "exposureIds",
  "supersedesId",
  "serviceId",
];
/** Company-only fields, hidden while an account is a person. */
const businessOnly = ["legalName", "dba", "industry", "naics"];

function starting(intent: EditIntent): Values {
  if (intent.action && intent.action !== "update") {
    const d = intent.record?.data as Values | undefined;
    if (intent.action === "certificate.issue" && d?.documentId)
      return { documentId: d.documentId };
    if (intent.action === "policy.endorse" && d)
      return { coverages: d.coverages || [] };
    return intent.action === "policy.renew" && d
      ? {
          number: d.number,
          effectiveDate: d.expirationDate,
          expirationDate: plusYear(String(d.expirationDate)),
          premiumCents: d.premiumCents,
        }
      : intent.initial || {};
  }
  return {
    ...(intent.kind === "notes"
      ? { occurredAt: new Date().toISOString() }
      : {}),
    ...(intent.record?.data || {}),
    ...(intent.accountId ? { accountId: intent.accountId } : {}),
    ...intent.initial,
  };
}
function defaults(specs: FieldSpec[], initial: Values, timeZone?: string) {
  const result = { ...initial };
  for (const spec of specs)
    if (result[spec.key] === undefined) {
      if (spec.default !== undefined) {
        result[spec.key] = spec.default;
        continue;
      }
      // Money starts blank: a required amount must be typed, an optional one falls
      // back to the schema's zero.
      result[spec.key] = ["money", "signedMoney", "percent"].includes(
        spec.type || "",
      )
        ? undefined
        : spec.type === "date"
          ? spec.required
            ? today(timeZone)
            : null
          : spec.type === "select"
            ? spec.options?.[0] || ""
            : spec.type === "check"
              ? false
              : ["member", "account", "policy", "document"].includes(
                    spec.type || "",
                  )
                ? null
                : [
                      "policies",
                      "documents",
                      "exposures",
                      "coverages",
                      "lines",
                      "tags",
                    ].includes(spec.type || "")
                  ? []
                  : ["address", "facts"].includes(spec.type || "")
                    ? {}
                    : "";
    }
  return result;
}

/** How a linked record reads in a dropdown or checklist. */
function recordOption(record: AmsRecord): PickerOption {
  const d = record.data as Values;
  if (record.kind === "accounts") {
    const address = (d.address || {}) as Values;
    const place = [address.city, address.state].filter(Boolean).join(", ");
    return {
      id: record.id,
      label: String(d.name),
      detail: [
        human(String(d.type || "business")),
        place,
        d.status !== "active" ? human(String(d.status || "")) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      keywords: [d.legalName, d.dba, d.email, d.phone]
        .filter(Boolean)
        .join(" "),
    };
  }
  if (record.kind === "policies")
    return {
      id: record.id,
      label: [d.line, d.number].filter(Boolean).join(" · "),
      detail: [d.carrier, `Expires ${dateLabel(d.expirationDate)}`]
        .filter(Boolean)
        .join(" · "),
    };
  if (record.kind === "documents")
    return {
      id: record.id,
      label: recordTitle(record),
      detail: [human(String(d.category || "")), dateLabel(record.createdAt)]
        .filter(Boolean)
        .join(" · "),
    };
  return { id: record.id, label: recordTitle(record) };
}

export function AgencyEditor({
  intent,
  book,
  session,
  close,
  saved,
  openAccount,
  brand = "relay",
}: {
  intent: EditIntent;
  book: Book;
  session: AgencySession;
  close: () => void;
  saved: (records: AmsRecord[]) => void;
  /** Leaves the dialog for an account: a search match, or one just created. */
  openAccount?: (id: string) => void;
  brand?: "relay" | "openams";
}) {
  const action = intent.action || (intent.record ? "update" : "create");
  const scopedAccount = book.accounts?.find(
    (account) => account.id === intent.accountId,
  );
  const upload = intent.kind === "documents";
  const specs = upload
    ? ([
        { key: "accountId", label: "Account", type: "account", required: true },
        { key: "policyId", label: "Policy term", type: "policy" },
        {
          key: "category",
          label: "Document category",
          type: "select",
          required: true,
          options: [
            "policy",
            "endorsement",
            "application",
            "certificate",
            "claims",
            "billing",
            "correspondence",
            "other",
          ],
        },
        { key: "supersedesId", label: "Replaces document", type: "document" },
        { key: "description", label: "Description", type: "long" },
      ] as FieldSpec[])
    : action === "create" || action === "update"
      ? fields[intent.kind].filter(
          (field) =>
            !(
              action === "create" &&
              ["stage", "status"].includes(field.key) &&
              intent.kind !== "accounts" &&
              intent.kind !== "claims"
            ),
        )
      : actionFields[action] || [];
  const has = (key: string) => specs.some((spec) => spec.key === key);
  const [values, setValues] = useState(() => {
    const initial = defaults(
      specs,
      {
        ...(action === "create" &&
        session.defaultOwnerId &&
        session.members.some(
          (m) =>
            m.id === session.defaultOwnerId && m.active && m.role !== "viewer",
        )
          ? intent.kind === "accounts"
            ? { serviceOwnerId: session.defaultOwnerId }
            : specs.some((s) => s.key === "ownerId")
              ? { ownerId: session.defaultOwnerId }
              : {}
          : {}),
        ...starting(intent),
      },
      session.timeZone,
    );
    // A new policy term runs a year unless someone says otherwise.
    if (
      action === "create" &&
      intent.kind === "policies" &&
      typeof initial.effectiveDate === "string" &&
      !intent.initial?.expirationDate
    )
      initial.expirationDate = plusYear(initial.effectiveDate);
    return initial;
  });
  const touched = useRef(new Set<string>());
  const form = useRef<HTMLFormElement>(null);
  // A new account starts with a search of the book, so the same client isn't added twice.
  const [lookup, setLookup] = useState(
    action === "create" &&
      intent.kind === "accounts" &&
      !intent.initial?.name &&
      Boolean(book.accounts?.length),
  );
  // Leaving the search lands in the form on the first field still to fill.
  const searched = useRef(false);
  useEffect(() => {
    if (lookup) {
      searched.current = true;
      return;
    }
    if (!searched.current) return;
    const inputs = [
      ...(form.current?.querySelectorAll<HTMLInputElement>(
        "input[id^='agency-field-']:not([type=checkbox])",
      ) || []),
    ];
    (inputs.find((input) => !input.value) || inputs[0])?.focus();
  }, [lookup]);
  const [current, setCurrent] = useState(intent.record);
  const [reason, setReason] = useState("");
  const [replaceCoverages, setReplaceCoverages] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);
  const accountId =
    typeof values.accountId === "string"
      ? values.accountId
      : intent.accountId ||
        (current && "accountId" in current.data
          ? current.data.accountId
          : null);
  const lifecycle = action !== "create" && action !== "update";
  const title = upload
    ? "Upload document"
    : lifecycle
      ? actionLabels[action]
      : `${current ? "Edit" : "New"} ${singular[intent.kind]}`;

  // New records keep optional fields folded away; edits show everything.
  const folds = action === "create" && !upload;
  const visible = specs.filter(
    (spec) =>
      !(intent.accountId && spec.key === "accountId") &&
      !(
        intent.kind === "accounts" &&
        values.type === "person" &&
        businessOnly.includes(spec.key)
      ),
  );
  const essentials = folds ? visible.filter((spec) => !spec.more) : visible;
  const extras = folds ? visible.filter((spec) => spec.more) : [];
  const [showMore, setShowMore] = useState(() =>
    extras.some((spec) => intent.initial?.[spec.key] !== undefined),
  );

  const duplicates = useMemo(
    () =>
      intent.kind === "accounts" && action === "create" && !lookup
        ? accountDuplicateCandidates(
            {
              id: "draft",
              kind: "accounts",
              data: values,
            } as unknown as AmsRecord<"accounts">,
            book,
          ).slice(0, 2)
        : [],
    [intent.kind, action, lookup, values, book],
  );

  function setField(key: string, value: unknown) {
    touched.current.add(key);
    setValues((previous) => {
      const next: Values = { ...previous, [key]: value };
      if (key === "accountId")
        for (const linked of accountLinked)
          if (linked in previous)
            next[linked] = linked.endsWith("Ids") ? [] : null;
      // The expiration follows the effective date until someone sets it.
      if (
        intent.kind === "policies" &&
        key === "effectiveDate" &&
        typeof value === "string" &&
        value &&
        has("expirationDate") &&
        !touched.current.has("expirationDate")
      )
        next.expirationDate = plusYear(value);
      // A renewal is due when the first of its expiring terms ends.
      if (
        intent.kind === "renewals" &&
        key === "policyIds" &&
        Array.isArray(value) &&
        has("expirationDate") &&
        !touched.current.has("expirationDate")
      ) {
        const first = (book.policies || [])
          .filter((policy) => value.includes(policy.id))
          .map((policy) => String((policy.data as Values).expirationDate || ""))
          .filter(Boolean)
          .sort()[0];
        if (first) next.expirationDate = first;
      }
      return next;
    });
  }

  function startFrom(query: string) {
    const text = query.trim();
    const digits = text.replace(/\D/g, "");
    setValues((previous) => ({
      ...previous,
      ...(text.includes("@")
        ? { email: text }
        : digits.length >= 7 && /^[\d\s()+.-]+$/.test(text)
          ? { phone: text }
          : { name: text }),
    }));
    setLookup(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setStale(false);
    let data = { ...values };
    // Coverage changes are explicit. A premium-only endorsement must not carry
    // a snapshot that could replace coverage details when applied later.
    if (action === "policy.endorse" && !replaceCoverages)
      delete data.coverages;
    if (!lifecycle && !upload) {
      const parsed = AMS_DATA_SCHEMAS[intent.kind].safeParse(data);
      if (!parsed.success) {
        setError(
          parsed.error.issues
            .map((issue) => `${human(issue.path.join(" "))}: ${issue.message}`)
            .slice(0, 3)
            .join(" · "),
        );
        return;
      }
      data = parsed.data;
    }
    if (upload && !file) {
      setError("Choose a document to upload.");
      return;
    }
    const fingerprint = JSON.stringify({
      action,
      data,
      reason,
      file: file ? [file.name, file.size, file.lastModified] : null,
    });
    if (!pending.current || pending.current.fingerprint !== fingerprint)
      pending.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true);
    try {
      let records: AmsRecord[];
      if (upload) {
        const query = new URLSearchParams({
          commandId: pending.current.id,
          category: String(values.category),
          description: String(values.description || ""),
        });
        for (const key of ["policyId", "supersedesId"])
          if (values[key]) query.set(key, String(values[key]));
        const result = await request<{ records: AmsRecord[] }>(
          `accounts/${values.accountId}/documents?${query}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-file-name": encodeURIComponent(file!.name),
            },
            body: file,
          },
        );
        records = result.records;
      } else {
        const result = await command({
          id: pending.current.id,
          action,
          kind: intent.kind,
          ...(current
            ? { recordId: current.id, expectedVersion: current.version }
            : {}),
          data,
          reason,
        });
        records = result.records;
      }
      saved(records);
      close();
      // A new account opens straight away, ready for its people and policies.
      const created =
        action === "create" && intent.kind === "accounts"
          ? records.find((record) => record.kind === "accounts")
          : undefined;
      if (created) openAccount?.(created.id);
    } catch (failure) {
      const isUncertain =
        !(failure instanceof AgencyRequestError) || failure.status >= 500;
      setUncertain(isUncertain);
      setStale(
        failure instanceof AgencyRequestError &&
          failure.code === "stale_record",
      );
      setError(failure instanceof Error ? failure.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    if (!current) return;
    setBusy(true);
    try {
      const result = await request<{ record: AmsRecord }>(
        `records/${current.kind}/${current.id}`,
      );
      setCurrent(result.record);
      setValues(
        defaults(
          specs,
          starting({ ...intent, record: result.record }),
          session.timeZone,
        ),
      );
      pending.current = null;
      setReplaceCoverages(false);
      setStale(false);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Reload failed.");
    } finally {
      setBusy(false);
    }
  }
  const renderField = (spec: FieldSpec) => {
    if (intent.kind === "exposures" && spec.key === "values")
      return <ExposureFacts
        key={spec.key}
        kind={String(values.kind || "location")}
        value={values.values}
        set={(value) => setField("values", value)}
      />;
    const field = (
      <Field
        key={spec.key}
        spec={
          intent.kind === "accounts" &&
          spec.key === "name" &&
          values.type === "person"
            ? { ...spec, label: "Full name" }
            : spec
        }
        value={values[spec.key]}
        set={(value) => setField(spec.key, value)}
        book={book}
        session={session}
        accountId={accountId || undefined}
        quickDates={action === "create"}
      />
    );
    if (action === "policy.endorse" && spec.key === "coverages")
      return (
        <div key={spec.key} className="agency-field agency-span">
          <label>
            <input
              type="checkbox"
              checked={replaceCoverages}
              onChange={(event) => setReplaceCoverages(event.target.checked)}
            />{" "}
            Update recorded coverages
          </label>
          <small>
            {replaceCoverages
              ? "This replaces the recorded coverage list. Include every coverage that remains, using the carrier's endorsement. Removing all rows records an empty list."
              : "Leave this off for a premium-only endorsement. Existing coverage details stay unchanged."}
          </small>
          {replaceCoverages && field}
        </div>
      );
    return field;
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && !uncertain) close();
      }}
    >
      <DialogContent
        className="agency-dialog"
        data-brand={brand}
        showClose={!busy && !uncertain}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {lookup
              ? "Search your book first, so the same client isn't added twice."
              : current
                ? recordTitle(current)
                : intent.accountId
                  ? `For ${scopedAccount ? recordTitle(scopedAccount) : "this account"}`
                  : upload
                    ? "Keep original files with the account. Uploads are immutable and can be superseded."
                    : "Saved to your agency workspace, with ownership and change history."}
          </DialogDescription>
        </DialogHeader>
        {lookup ? (
          <AccountLookup
            book={book}
            initial={String(values.name || values.email || values.phone || "")}
            open={(id) => {
              close();
              openAccount?.(id);
            }}
            create={startFrom}
            cancel={close}
          />
        ) : (
          <form onSubmit={submit} ref={form}>
            <fieldset disabled={busy || uncertain} className="agency-form-grid">
              {intent.kind === "certificates" && !lifecycle && (
                <label className="agency-field agency-span">
                  <span>Related certificate service request</span>
                  <select
                    value={String(values.serviceId || "")}
                    onChange={(e) =>
                      setField("serviceId", e.target.value || null)
                    }
                  >
                    <option value="">No linked service request</option>
                    {(book.services || [])
                      .filter((r) => {
                        const d = r.data as AmsRecord<"services">["data"];
                        return (
                          d.accountId === values.accountId &&
                          d.type === "certificate" &&
                          d.status !== "completed" &&
                          !r.archivedAt
                        );
                      })
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {String((r.data as { title: string }).title)}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {intent.kind === "certificates" && !lifecycle && (
                <label className="agency-field agency-span">
                  <span>Saved certificate holder</span>
                  <select
                    aria-label="Saved certificate holder"
                    value={String(values.holderId || "")}
                    onChange={(e) => {
                      const holder = book.certificateholders?.find(
                        (r) => r.id === e.target.value,
                      ) as AmsRecord<"certificateholders"> | undefined;
                      setValues((previous) => ({
                        ...previous,
                        holderId: holder?.id || null,
                        ...(holder
                          ? {
                              holderName: holder.data.name,
                              holderAddress: holder.data.address,
                              holderEmail: holder.data.email,
                            }
                          : {}),
                      }));
                    }}
                  >
                    <option value="">
                      Enter holder details for this request
                    </option>
                    {(book.certificateholders || [])
                      .filter((r) => !r.archivedAt)
                      .map((h) => (
                        <option key={h.id} value={h.id}>
                          {String((h.data as { name: string }).name)}
                        </option>
                      ))}
                  </select>
                  <small>
                    Manage reusable holders from Certificates → Certificate
                    holders. Issued certificates retain their original holder
                    details.
                  </small>
                </label>
              )}
              {intent.kind === "accounts" &&
                action === "create" &&
                Boolean(book.accounts?.length) && (
                  <button
                    type="button"
                    className="agency-lookup-back agency-span"
                    onClick={() => setLookup(true)}
                  >
                    <ArrowLeft size={15} aria-hidden="true" />
                    Back to search
                  </button>
                )}
              {duplicates.length > 0 && (
                <div
                  className="agency-duplicate-hint agency-span"
                  role="status"
                >
                  <strong>Already in your book?</strong>
                  {duplicates.map(({ account, reasons }) => (
                    <span key={account.id}>
                      {account.data.name}
                      <small>{reasons.join(" · ")}</small>
                      {openAccount && (
                        <button
                          type="button"
                          onClick={() => {
                            close();
                            openAccount(account.id);
                          }}
                        >
                          Open
                          <ArrowRight size={14} aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {essentials.map(renderField)}
              {extras.length > 0 && (
                <button
                  type="button"
                  className="agency-more-toggle agency-span"
                  aria-expanded={showMore}
                  onClick={() => setShowMore((open) => !open)}
                >
                  <ChevronDown size={16} aria-hidden="true" />
                  {showMore ? "Fewer details" : "More details"}
                  {!showMore && (
                    <small>
                      {extras
                        .map((spec) => spec.label)
                        .slice(0, 3)
                        .join(", ")}
                      {extras.length > 3
                        ? ` and ${extras.length - 3} more`
                        : ""}
                    </small>
                  )}
                </button>
              )}
              {showMore && extras.map(renderField)}
              {upload && (
                <label className="agency-field agency-span">
                  <span>File · up to 20 MB</span>
                  <input
                    aria-label="Document file"
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.eml,.docx,.xlsx"
                    required
                    onChange={(event) =>
                      setFile(event.target.files?.[0] || null)
                    }
                  />
                </label>
              )}
              {lifecycle && (
                <label className="agency-field agency-span">
                  <span>Reason / working note</span>
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={2000}
                    rows={3}
                    required={[
                      "archive",
                      "restore",
                      "policy.endorse",
                      "policy.cancel",
                      "policy.reinstate",
                      "renewal.close",
                      "task.reopen",
                      "certificate.void",
                      "certificate.reissue",
                      "invoice.void",
                      "payment.reverse",
                      "commission.allocate",
                      "commission.adjust",
                      "journal.reverseCommission",
                      "policy.nonrenew",
                      "policyChange.apply",
                      "policyChange.review",
                      "policyChange.withdraw",
                      "policy.withdrawNonrenewal",
                    ].includes(action)}
                  />
                </label>
              )}
            </fieldset>
            {lifecycle && (
              <p className="agency-form-note">
                {action.startsWith("policy.")
                  ? "Records carrier-confirmed activity. This action does not bind coverage or instruct a carrier."
                  : action.startsWith("payment.") ||
                      action === "commission.receive"
                    ? "Records a completed financial transaction. No money is moved."
                    : "The original record and every saved revision remain in the audit history."}
              </p>
            )}
            {error && (
              <div className="agency-form-error" role="alert">
                {error}
                {stale && (
                  <button type="button" onClick={reload} disabled={busy}>
                    Reload current record and discard these unsaved edits
                  </button>
                )}
                {uncertain && (
                  <p>
                    The result is unconfirmed. Retry this exact request; its
                    identifier prevents duplicate processing.
                  </p>
                )}
              </div>
            )}
            <footer className="agency-form-footer">
              <button
                className="agency-button"
                type="button"
                onClick={close}
                disabled={busy || uncertain}
              >
                Cancel
              </button>
              <button
                className="agency-button primary"
                type="submit"
                disabled={busy || stale}
              >
                {busy ? (
                  <Loader2 className="agency-spin" size={16} />
                ) : upload ? (
                  <Upload size={16} />
                ) : null}
                {busy
                  ? "Saving…"
                  : uncertain
                    ? "Retry same request"
                    : lifecycle
                      ? title
                      : upload
                        ? "Upload document"
                        : current
                          ? "Save changes"
                          : `Add ${singular[intent.kind]}`}
              </button>
            </footer>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

const digitsOf = (value: unknown) => String(value || "").replace(/\D/g, "");
const squash = (value: unknown) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9@.]/g, "");

/**
 * Step one of a new account: search accounts and their people by name, email or
 * phone. A match opens that account; otherwise the typed text starts the new one.
 */
function AccountLookup({
  book,
  initial,
  open,
  create,
  cancel,
}: {
  book: Book;
  initial: string;
  open: (id: string) => void;
  create: (query: string) => void;
  cancel: () => void;
}) {
  const [query, setQuery] = useState(initial);
  const [active, setActive] = useState(-1);
  const text = query.trim();
  const results = useMemo(() => {
    const needle = squash(text);
    const digits = text.replace(/\D/g, "");
    if (needle.length < 2) return [];
    const hit = (value: unknown) => squash(value).includes(needle);
    const phoneHit = (value: unknown) =>
      digits.length >= 4 && digitsOf(value).includes(digits);
    const accounts = ((book.accounts || []) as AmsRecord<"accounts">[]).filter(
      (account) => !account.archivedAt && !account.data.consolidation,
    );
    const found = new Map<
      string,
      { account: AmsRecord<"accounts">; why: string }
    >();
    for (const account of accounts) {
      const d = account.data;
      // Say why it matched when the reason isn't the name itself.
      if ([d.name, d.legalName, d.dba].some(hit))
        found.set(account.id, { account, why: "" });
      else if (hit(d.email))
        found.set(account.id, { account, why: `Email: ${d.email}` });
      else if (phoneHit(d.phone))
        found.set(account.id, { account, why: `Phone: ${d.phone}` });
    }
    for (const contact of (book.contacts || []) as AmsRecord<"contacts">[]) {
      const d = contact.data;
      const account = accounts.find((row) => row.id === d.accountId);
      if (!account || found.has(account.id)) continue;
      if (
        [d.name, d.email].some(hit) ||
        phoneHit(d.phone) ||
        phoneHit(d.mobile)
      )
        found.set(account.id, {
          account,
          why: `Contact: ${d.name}${d.title ? `, ${d.title}` : ""}`,
        });
    }
    return [...found.values()].slice(0, 6);
  }, [book, text]);
  const optionId = (index: number) => `account-lookup-${index}`;
  // The create row sits after the matches, so arrow keys reach it too.
  const last = text ? results.length : results.length - 1;

  return (
    <div className="agency-lookup">
      <div className="agency-lookup-search">
        <Search size={18} aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-label="Search accounts"
          aria-expanded={Boolean(text)}
          aria-controls="account-lookup-results"
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          placeholder="Business or person, email or phone"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(last, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(-1, index - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (active >= 0 && active < results.length)
                open(results[active].account.id);
              else if (text) create(text);
            }
          }}
        />
      </div>
      {text ? (
        <ul id="account-lookup-results" role="listbox" aria-label="Accounts">
          {results.length > 0 && (
            <li className="agency-lookup-label" role="presentation">
              Already in your book
            </li>
          )}
          {results.map(({ account, why }, index) => {
            const option = recordOption(account);
            return (
              <li
                key={account.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                data-active={index === active || undefined}
                onPointerMove={() => setActive(index)}
                onClick={() => open(account.id)}
              >
                <span className="agency-picker-avatar" aria-hidden="true">
                  {initialsOf(account.data.name)}
                </span>
                <span className="agency-picker-value">
                  {account.data.name}
                  <small>{why || option.detail}</small>
                </span>
                <span className="agency-lookup-open">
                  Open <ArrowRight size={14} aria-hidden="true" />
                </span>
              </li>
            );
          })}
          <li
            id={optionId(results.length)}
            role="option"
            aria-selected={active === results.length}
            data-active={active === results.length || undefined}
            className="agency-lookup-create"
            onPointerMove={() => setActive(results.length)}
            onClick={() => create(text)}
          >
            <span className="agency-picker-avatar" aria-hidden="true">
              <Plus size={16} />
            </span>
            <span className="agency-picker-value">
              New account for “{text}”
              <small>
                {results.length
                  ? "None of these? Start a new account."
                  : "Nothing in your book matches. Start a new account."}
              </small>
            </span>
          </li>
        </ul>
      ) : (
        <p className="agency-lookup-hint">
          Type a few letters of a business or person, an email address or a
          phone number.
        </p>
      )}
      <footer className="agency-form-footer">
        <button className="agency-button" type="button" onClick={cancel}>
          Cancel
        </button>
        <button
          className="agency-button primary"
          type="button"
          disabled={!text}
          onClick={() => create(text)}
        >
          Continue
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </footer>
    </div>
  );
}

function Field({
  spec,
  value,
  set,
  book,
  session,
  accountId,
  quickDates,
}: {
  spec: FieldSpec;
  value: unknown;
  set: (value: unknown) => void;
  book: Book;
  session: AgencySession;
  accountId?: string;
  quickDates?: boolean;
}) {
  const id = `agency-field-${spec.key}`;
  const labelId = `${id}-label`;
  const type = spec.type || "text";
  const wide =
    spec.span ||
    [
      "account",
      "long",
      "address",
      "coverages",
      "lines",
      "facts",
      "policies",
      "documents",
      "exposures",
      "tags",
    ].includes(type);
  const linked = [
    "account",
    "policy",
    "document",
    "policies",
    "documents",
    "exposures",
  ].includes(type);
  const options: PickerOption[] =
    type === "member"
      ? session.members
          .filter((member) => member.active)
          .map((member) => ({
            id: member.id,
            label: member.name,
            detail:
              member.id === session.actor.userId
                ? `${human(member.role)} · You`
                : human(member.role),
            initials: initialsOf(member.name),
          }))
      : type === "select"
        ? (spec.options || []).map((option) => ({
            id: option,
            label: spec.labels?.[option] || human(option),
          }))
        : linked
          ? (
              book[
                type === "account"
                  ? "accounts"
                  : type.startsWith("polic")
                    ? "policies"
                    : type.startsWith("doc")
                      ? "documents"
                      : "exposures"
              ] || []
            )
              .filter((record) =>
                type === "account"
                  ? !(record as AmsRecord<"accounts">).data.consolidation ||
                    record.id === accountId
                  : "accountId" in record.data &&
                    sameAccount(book, record.data.accountId, accountId),
              )
              .map((record) => recordOption(record))
              .sort((a, b) =>
                type === "account" ? a.label.localeCompare(b.label) : 0,
              )
          : [];
  // Records that belong to an account wait for one to be chosen.
  const needsAccount = linked && type !== "account" && !accountId;
  const noun =
    type === "policy" || type === "policies"
      ? "policy terms"
      : type === "document" || type === "documents"
        ? "documents"
        : "exposures";
  const day = today(session.timeZone);
  const quick =
    quickDates &&
    type === "date" &&
    ["dueDate", "followUpDate"].includes(spec.key)
      ? [
          { label: "Today", date: day },
          { label: "Tomorrow", date: plusDays(day, 1) },
          { label: "Next week", date: plusDays(day, 7) },
        ]
      : [];
  const amount = ["money", "signedMoney", "percent"].includes(type);
  return (
    <div className={`agency-field ${wide ? "agency-span" : ""}`}>
      <label htmlFor={id} id={labelId}>
        {spec.label}
        {spec.required ? " *" : ""}
      </label>
      {type === "long" ? (
        <textarea
          id={id}
          rows={3}
          value={String(value || "")}
          required={spec.required}
          maxLength={10000}
          onChange={(e) => set(e.target.value)}
        />
      ) : type === "select" && spec.required && options.length <= 4 ? (
        <Choice
          labelledBy={labelId}
          value={String(value || "")}
          options={options}
          onChange={set}
        />
      ) : ["select", "member", "account", "policy", "document"].includes(
          type,
        ) ? (
        <Picker
          id={id}
          labelledBy={labelId}
          label={spec.label}
          value={value ? String(value) : null}
          options={options}
          onChange={set}
          required={spec.required}
          disabled={
            needsAccount || (linked && type !== "account" && !options.length)
          }
          searchable={type === "account" || options.length > 7}
          none={
            spec.required
              ? undefined
              : type === "member"
                ? "Unassigned"
                : type === "account"
                  ? "No account"
                  : type === "policy"
                    ? "No policy term"
                    : "None"
          }
          placeholder={
            needsAccount
              ? "Choose an account first"
              : linked && type !== "account" && !options.length
                ? `No ${noun} on this account`
                : type === "member"
                  ? "Choose a teammate"
                  : `Choose ${spec.label.toLowerCase()}`
          }
          empty={
            type === "account"
              ? "No accounts yet."
              : type === "member"
                ? "No active teammates."
                : "Nothing to choose yet."
          }
        />
      ) : ["policies", "documents", "exposures"].includes(type) ? (
        <div
          id={id}
          role="group"
          aria-labelledby={labelId}
          className="agency-checklist"
        >
          {options.length ? (
            options.map((option) => (
              <label key={option.id}>
                <input
                  type="checkbox"
                  checked={Array.isArray(value) && value.includes(option.id)}
                  onChange={(e) =>
                    set(
                      e.target.checked
                        ? [...(Array.isArray(value) ? value : []), option.id]
                        : (Array.isArray(value) ? value : []).filter(
                            (id) => id !== option.id,
                          ),
                    )
                  }
                />
                <span>
                  {option.label}
                  {option.detail && <small>{option.detail}</small>}
                </span>
              </label>
            ))
          ) : (
            <small>
              {needsAccount
                ? "Choose an account first."
                : `No ${noun} on this account yet.`}
            </small>
          )}
        </div>
      ) : type === "check" ? (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          required={spec.required}
          onChange={(e) => set(e.target.checked)}
        />
      ) : type === "address" ? (
        <div id={id} className="agency-address">
          {["line1", "line2", "city", "state", "postalCode"].map((key) => (
            <input
              key={key}
              aria-label={`${spec.label} ${human(key)}`}
              placeholder={
                { line1: "Street", line2: "Suite or unit", postalCode: "ZIP" }[
                  key
                ] || human(key)
              }
              maxLength={key === "state" ? 2 : 200}
              value={String((value as Values)?.[key] || "")}
              onChange={(e) =>
                set({
                  ...((value || {}) as Values),
                  [key]: e.target.value,
                  country: "US",
                })
              }
            />
          ))}
        </div>
      ) : ["coverages", "lines", "facts"].includes(type) ? (
        <Rows spec={spec} value={value} set={set} />
      ) : type === "tags" ? (
        <input
          id={id}
          value={Array.isArray(value) ? value.join(", ") : ""}
          placeholder="Separate tags with commas"
          onChange={(e) =>
            set(
              e.target.value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            )
          }
        />
      ) : amount ? (
        <div
          className="agency-amount"
          data-unit={type === "percent" ? "%" : "$"}
        >
          <input
            id={id}
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            step="0.01"
            min={type === "signedMoney" ? undefined : 0}
            max={type === "percent" ? 100 : undefined}
            required={spec.required}
            value={typeof value === "number" ? value / 100 : ""}
            onChange={(e) =>
              set(
                e.target.value === ""
                  ? undefined
                  : Math.round(Number(e.target.value) * 100),
              )
            }
          />
        </div>
      ) : (
        <input
          id={id}
          type={type}
          required={spec.required}
          value={String(value || "")}
          onChange={(e) =>
            set(type === "date" ? e.target.value || null : e.target.value)
          }
        />
      )}
      {quick.length > 0 && (
        <div
          className="agency-quick-dates"
          role="group"
          aria-label={`${spec.label} shortcuts`}
        >
          {quick.map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={value === option.date}
              onClick={() => set(option.date)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {spec.hint && <small>{spec.hint}</small>}
    </div>
  );
}
function Rows({
  spec,
  value,
  set,
}: {
  spec: FieldSpec;
  value: unknown;
  set: (value: unknown) => void;
}) {
  const facts = spec.type === "facts";
  const rows: Values[] = facts
    ? Object.entries((value || {}) as Values).map(([name, detail]) => ({
        name,
        detail,
      }))
    : Array.isArray(value)
      ? value
      : [];
  const keys = facts
    ? ["name", "detail"]
    : spec.type === "lines"
      ? ["description", "type", "amountCents"]
      : ["name", "limit", "deductible"];
  const save = (next: Values[]) =>
    set(
      facts
        ? Object.fromEntries(next.map((row) => [String(row.name), row.detail]))
        : next,
    );
  return (
    <div className={`agency-row-editor${spec.type === "coverages" ? " agency-coverage-editor" : ""}`}>
      {rows.map((row, index) => (
        <div className="agency-edit-row" key={index}>
          {keys.map((key) => {
            if (key === "type") return (
              <div className="agency-edit-row-picker" key={key}>
                <Picker
                  id={`${spec.key}-${index}-type`}
                  label={`Item ${index + 1} type`}
                  value={String(row[key] || "premium")}
                  options={["premium", "tax", "fee"].map((v) => ({
                    id: v,
                    label: human(v),
                  }))}
                  onChange={(next) =>
                    save(
                      rows.map((item, i) =>
                        i === index
                          ? { ...item, [key]: next || "premium" }
                          : item,
                      ),
                    )
                  }
                  placeholder="Type"
                />
              </div>
            );
            const input = (
              <input
                key={key}
                aria-label={`${human(key)} ${index + 1}`}
                placeholder={human(key === "amountCents" ? "amount" : key)}
                required={key === "name" || key === "description"}
                type={key === "amountCents" ? "number" : "text"}
                min={key === "amountCents" ? 0 : undefined}
                step={key === "amountCents" ? "0.01" : undefined}
                value={
                  key === "amountCents"
                    ? Number(row[key] || 0) / 100
                    : String(row[key] || "")
                }
                onChange={(e) =>
                  save(
                    rows.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            [key]:
                              key === "amountCents"
                                ? Math.round(Number(e.target.value) * 100)
                                : e.target.value,
                          }
                        : item,
                    ),
                  )
                }
              />
            );
            return spec.type === "coverages" ? (
              <label key={key} className="agency-coverage-field">
                <span>{human(key)}</span>
                {input}
              </label>
            ) : input;
          })}
          <button
            type="button"
            aria-label={`Remove item ${index + 1}`}
            onClick={() => save(rows.filter((_, i) => i !== index))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="agency-button quiet"
        onClick={() =>
          save([
            ...rows,
            spec.type === "lines"
              ? { description: "", type: "premium", amountCents: 0 }
              : facts
                ? { name: `Fact ${rows.length + 1}`, detail: "" }
                : { name: "", limit: "", deductible: "", notes: "" },
          ])
        }
      >
        <Plus size={14} />
        Add{" "}
        {spec.type === "coverages" ? "coverage" : facts ? "fact" : "line item"}
      </button>
    </div>
  );
}
