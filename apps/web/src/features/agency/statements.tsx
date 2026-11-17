"use client";
import { useRef, useState } from "react";
import { Check, FileSpreadsheet, Upload } from "lucide-react";
import { AmsStatementSchema } from "@openams/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  dateLabel,
  human,
  money,
  today,
  type AmsRecord,
  type Book,
} from "./model";
import {
  parseStatementCsv,
  statementTemplate,
  inspectStatementCsv,
  statementColumns,
  columnLabels,
  type StatementMapping,
  type StatementDateFormat,
} from "./statement-csv";
import { useAccountCommand } from "./account-command";
type Statement = AmsRecord<"statements">;
export function StatementImport({
  close,
  saved,
  timeZone,
}: {
  close: () => void;
  saved: (records: AmsRecord[]) => void;
  timeZone?: string;
}) {
  const [carrier, setCarrier] = useState("");
  const [reference, setReference] = useState("");
  const [date, setDate] = useState(today(timeZone));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Statement["data"] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mutation = useAccountCommand(saved);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<StatementMapping | null>(null);
  const [dateFormat, setDateFormat] = useState<StatementDateFormat>("iso");
  const fileRead = useRef(0);
  async function selectFile(selected: File | null) {
    const version = ++fileRead.current;
    setFile(selected);
    setHeaders([]);
    setMapping(null);
    setError("");
    if (!selected) return;
    setBusy(true);
    try {
      if (selected.size > 200_000)
        throw new Error("Choose a CSV under 200 KB.");
      const info = inspectStatementCsv(await selected.text());
      if (version === fileRead.current) {
        setHeaders(info.headers);
        setMapping(info.mapping);
      }
    } catch (failure) {
      if (version === fileRead.current)
        setError(
          failure instanceof Error ? failure.message : "Cannot read file.",
        );
    } finally {
      if (version === fileRead.current) setBusy(false);
    }
  }
  async function review() {
    setError("");
    setBusy(true);
    try {
      if (!file || !mapping || file.size > 200_000)
        throw new Error("Choose a CSV under 200 KB.");
      const bytes = await file.arrayBuffer();
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const parsed = AmsStatementSchema.safeParse({
        carrier,
        reference,
        statementDate: date,
        sourceName: file.name,
        sourceSha256: hash,
        rows: parseStatementCsv(new TextDecoder().decode(bytes), {
          mapping,
          dateFormat,
        }),
        notes: `CSV date format: ${dateFormat}. Reviewed column mapping: ${statementColumns.map((key) => `${columnLabels[key]} = ${mapping[key] || "not supplied"}`).join("; ")}.`,
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .map((issue) => `${issue.path.join(" ")}: ${issue.message}`)
            .slice(0, 3)
            .join(" · "),
        );
      setPreview(parsed.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot read statement.");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!preview) return;
    if (
      await mutation.run(() => ({
        id: crypto.randomUUID(),
        kind: "statements",
        action: "create",
        data: preview,
        reason:
          "Imported carrier statement for review; source fingerprint and column mapping preserved.",
      }))
    )
      close();
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([statementTemplate], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "direct-bill-statement-template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && !mutation.busy && !mutation.uncertain) close();
      }}
    >
      <DialogContent data-brand="relay" className="agency-dialog">
        <DialogHeader>
          <DialogTitle>Review a carrier statement</DialogTitle>
          <DialogDescription>
            Import the carrier’s actual transactions, then match and post them
            against expected direct-bill commissions.
          </DialogDescription>
        </DialogHeader>
        <fieldset
          disabled={busy || mutation.busy || mutation.uncertain || !!preview}
          className="agency-form-grid"
        >
          <label className="agency-field">
            <span>Writing carrier</span>
            <input
              aria-label="Statement carrier"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
            />
          </label>
          <label className="agency-field">
            <span>Unique statement / batch reference</span>
            <input
              aria-label="Statement reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <label className="agency-field">
            <span>Statement date</span>
            <input
              type="date"
              aria-label="Statement date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="agency-field">
            <span>Statement CSV</span>
            <input
              type="file"
              accept=".csv"
              aria-label="Statement CSV"
              onChange={(e) => void selectFile(e.target.files?.[0] || null)}
            />
          </label>
          {mapping && (
            <>
              <label className="agency-field">
                <span>Dates in this file</span>
                <select
                  aria-label="Statement date format"
                  value={dateFormat}
                  onChange={(e) =>
                    setDateFormat(e.target.value as StatementDateFormat)
                  }
                >
                  <option value="iso">YYYY-MM-DD</option>
                  <option value="us">MM/DD/YYYY</option>
                  <option value="day_first">DD/MM/YYYY</option>
                </select>
              </label>
              <div className="agency-field agency-span">
                <strong>Review column mapping</strong>
                <p>
                  Policy number, term effective date, and paid commission are
                  required. Missing transaction details need explicit review
                  when matching. Rows without a paid date use the statement
                  date.
                </p>
              </div>
              {statementColumns.map((key) => (
                <label className="agency-field" key={key}>
                  <span>
                    {columnLabels[key]}
                    {["policy_number", "effective_date", "commission"].includes(
                      key,
                    )
                      ? " *"
                      : ""}
                  </span>
                  <select
                    aria-label={`Map ${columnLabels[key].toLowerCase()}`}
                    value={mapping[key]}
                    onChange={(e) =>
                      setMapping(
                        (previous) =>
                          previous && { ...previous, [key]: e.target.value },
                      )
                    }
                  >
                    <option value="">Not supplied</option>
                    {headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </>
          )}
          <button type="button" className="agency-button" onClick={download}>
            Download statement template
          </button>
          <button
            type="button"
            className="agency-button primary"
            onClick={() => void review()}
            disabled={!mapping}
          >
            Review rows
          </button>
        </fieldset>
        {preview && (
          <div className="agency-import-review">
            <div className="agency-import-totals">
              <strong>{preview.rows.length} transactions</strong>
              <span>
                {money(
                  preview.rows.reduce(
                    (sum, row) => sum + row.commissionCents,
                    0,
                  ),
                )}{" "}
                statement commission
              </span>
            </div>
            <div className="agency-import-rows">
              {preview.rows.map((row) => (
                <div key={row.id}>
                  <strong>{row.policyNumber}</strong>
                  <span>
                    {row.transaction
                      ? human(row.transaction)
                      : "Transaction type not supplied"}{" "}
                    ·{" "}
                    {row.premiumCents == null
                      ? "Premium not supplied"
                      : `${money(row.premiumCents)} premium`}
                    · {money(row.commissionCents)} commission · Paid{" "}
                    {dateLabel(row.paidDate || preview.statementDate)}
                  </span>
                </div>
              ))}
            </div>
            <p>
              No commission is posted during import. Every row starts unmatched.
            </p>
          </div>
        )}
        {(error || mutation.error) && (
          <div className="agency-form-error" role="alert">
            {error || mutation.error}
          </div>
        )}
        <footer className="agency-form-footer">
          <button
            className="agency-button"
            onClick={() => (preview ? setPreview(null) : close())}
            disabled={busy || mutation.busy || mutation.uncertain}
          >
            {preview ? "Back to file" : "Cancel"}
          </button>
          {preview && (
            <button
              className="agency-button primary"
              onClick={() => void save()}
              disabled={busy || mutation.busy}
            >
              <Upload size={15} />
              {mutation.busy
                ? "Saving…"
                : mutation.uncertain
                  ? "Retry same import"
                  : "Save statement for matching"}
            </button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
export function StatementReview({
  record,
  book,
  canWrite,
  saved,
  post,
}: {
  record: Statement;
  book: Book;
  canWrite: boolean;
  saved: (records: AmsRecord[]) => void;
  post: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const mutation = useAccountCommand(saved);
  const { error, busy, uncertain } = mutation;
  async function match(
    row: Statement["data"]["rows"][number],
    commissionId: string | null,
  ) {
    await mutation.run(() => ({
      id: crypto.randomUUID(),
      kind: "statements",
      action: "statement.match",
      recordId: record.id,
      expectedVersion: record.version,
      data: {
        rowId: row.id,
        commissionId,
        reviewedMissingFields: Boolean(reviewed[row.id]),
        ...(commissionId
          ? {
              expectedCommissionVersion: book.commissions?.find(
                (item) => item.id === commissionId,
              )?.version,
            }
          : {}),
      },
      reason: reasons[row.id] || "",
    }));
  }
  const matched = record.data.rows.filter((row) => row.status === "matched");
  const posted = record.data.rows.filter((row) => row.status === "posted");
  return (
    <section className="agency-statement-review">
      <div className="agency-import-totals">
        <strong>{posted.length} posted</strong>
        <span>{matched.length} matched</span>
        <span>
          {record.data.rows.length - posted.length - matched.length} need review
        </span>
        <span>
          {money(
            record.data.rows.reduce((sum, row) => sum + row.commissionCents, 0),
          )}{" "}
          total
        </span>
      </div>
      <p>
        Match the carrier and policy term, then review the expected transaction.
        Supplied transaction details must agree. Partial receipts leave the
        remaining commission open; missing source fields require a recorded
        review.
      </p>
      {error && (
        <div className="agency-form-error" role="alert">
          {error}
          {uncertain && (
            <button
              className="agency-button"
              disabled={busy}
              onClick={() => void mutation.retry()}
            >
              Retry same match
            </button>
          )}
        </div>
      )}
      {record.data.rows.map((row) => {
        const candidates = (book.commissions || []).filter((item) => {
          const commission = item.data as AmsRecord<"commissions">["data"];
          const policy = book.policies?.find(
            (policy) => policy.id === commission.policyId,
          )?.data as AmsRecord<"policies">["data"] | undefined;
          return (
            policy &&
            policy.number.toLowerCase() === row.policyNumber.toLowerCase() &&
            policy.carrier.toLowerCase() ===
              record.data.carrier.toLowerCase() &&
            policy.effectiveDate === row.effectiveDate
          );
        });
        const selected = choices[row.id] ?? row.commissionId ?? "";
        const incomplete =
          row.transaction == null ||
          row.transactionDate == null ||
          row.premiumCents == null;
        const selectedCommission = candidates.find(
          (item) => item.id === selected,
        ) as AmsRecord<"commissions"> | undefined;
        const partial =
          selectedCommission &&
          Math.abs(row.commissionCents) <
            Math.abs(
              selectedCommission.data.expectedCents -
                selectedCommission.data.receivedCents,
            );
        return (
          <article key={row.id}>
            <div className="agency-inline">
              <FileSpreadsheet size={18} />
              <strong>{row.policyNumber}</strong>
              <span className="agency-badge">{human(row.status)}</span>
            </div>
            <p>
              {row.transaction
                ? human(row.transaction)
                : "Transaction type not supplied"}{" "}
              ·{" "}
              {row.transactionDate
                ? dateLabel(row.transactionDate)
                : "Transaction date not supplied"}{" "}
              · Term begins {dateLabel(row.effectiveDate)} · Paid{" "}
              {dateLabel(row.paidDate || record.data.statementDate)}
            </p>
            <div className="agency-import-totals">
              <span>
                {row.premiumCents == null
                  ? "Premium not supplied"
                  : `${money(row.premiumCents)} premium`}
              </span>
              <strong>{money(row.commissionCents)} commission</strong>
            </div>
            {row.status === "posted" ? (
              <small>
                <Check size={13} /> Posted {dateLabel(row.postedAt)}
              </small>
            ) : canWrite ? (
              <div className="agency-match-controls">
                <select
                  aria-label={`Expected commission for ${row.policyNumber}`}
                  value={selected}
                  onChange={(e) => {
                    setChoices((previous) => ({
                      ...previous,
                      [row.id]: e.target.value,
                    }));
                    setReviewed((previous) => ({
                      ...previous,
                      [row.id]: false,
                    }));
                    setReasons((previous) => ({ ...previous, [row.id]: "" }));
                  }}
                  disabled={busy || uncertain}
                >
                  <option value="">Choose expected transaction</option>
                  {candidates.map((item) => {
                    const c = item.data as AmsRecord<"commissions">["data"];
                    return (
                      <option key={item.id} value={item.id}>
                        {human(c.transaction)} · {dateLabel(c.transactionDate)}{" "}
                        · {money(c.expectedCents - c.receivedCents)} remaining
                      </option>
                    );
                  })}
                </select>
                {partial && (
                  <p>
                    This is a partial receipt. The unpaid balance will remain
                    open.
                  </p>
                )}
                {incomplete && (
                  <div className="agency-field agency-span">
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Review missing fields for ${row.policyNumber}`}
                        checked={Boolean(reviewed[row.id])}
                        disabled={busy || uncertain}
                        onChange={(e) =>
                          setReviewed((values) => ({
                            ...values,
                            [row.id]: e.target.checked,
                          }))
                        }
                      />{" "}
                      I reviewed missing source fields against this expected
                      transaction.
                    </label>
                    <label>
                      Basis for matching
                      <textarea
                        aria-label={`Match review for ${row.policyNumber}`}
                        value={reasons[row.id] || ""}
                        disabled={busy || uncertain}
                        maxLength={2000}
                        onChange={(e) =>
                          setReasons((values) => ({
                            ...values,
                            [row.id]: e.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                )}
                <button
                  className="agency-button"
                  onClick={() => void match(row, selected)}
                  disabled={
                    busy ||
                    uncertain ||
                    !selected ||
                    (incomplete &&
                      (!reviewed[row.id] || !reasons[row.id]?.trim()))
                  }
                >
                  Match row
                </button>
                {row.status === "matched" && (
                  <button
                    className="agency-button quiet"
                    onClick={() => void match(row, null)}
                    disabled={busy || uncertain}
                  >
                    Unmatch
                  </button>
                )}
                {!candidates.length && (
                  <p>
                    No matching policy transaction is recorded. Add or correct
                    the expected commission, then return to this statement.
                  </p>
                )}
              </div>
            ) : null}
          </article>
        );
      })}
      {canWrite && matched.length > 0 && (
        <button
          className="agency-button primary"
          onClick={post}
          disabled={busy || uncertain}
        >
          Post {matched.length} matched rows
        </button>
      )}
    </section>
  );
}
