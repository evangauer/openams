"use client";
import { useState } from "react";
import { ArrowDownToLine, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { importKindFromValue, importTemplates, parseImportCsv, type ImportKind } from "./import-csv";
import { request, money } from "./model";
interface Plan {
  fingerprint: string;
  ready: number;
  existing: number;
  errors: number;
  premiumCents: number;
  rows: { line: number; identity: string; status: string; message: string }[];
}
interface Result {
  complete: boolean;
  created: number;
  existing: number;
  errors: number;
  processedRows: number;
  totalRows: number;
  outcomes: { line: number; status: string; message: string }[];
}
export function ImportDialog({
  close,
  done,
}: {
  close: () => void;
  done: () => void;
}) {
  const [kind, setKind] = useState<ImportKind>("accounts");
  const [source, setSource] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [input, setInput] = useState<{
    kind: ImportKind;
    source: string;
    rows: Record<string, unknown>[];
  } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function template() {
    const url = URL.createObjectURL(
      new Blob([importTemplates[kind]], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `agency-${kind}-template.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function validate() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!source.trim() || !file)
        throw new Error("Name the source system and choose a CSV file.");
      if (file.size > 200_000) throw new Error("Use a file under 200 KB.");
      const value = {
        kind,
        source: source.trim(),
        rows: parseImportCsv(await file.text(), kind),
      };
      setInput(value);
      setPlan(
        await request("import/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Validation failed.");
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!plan || !input) return;
    setBusy(true);
    setError("");
    try {
      const next = await request<Result>("import/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, fingerprint: plan.fingerprint }),
      });
      setResult(next);
      done();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Import result is unconfirmed. Retry the same file.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent className="agency-dialog">
        <DialogHeader>
          <DialogTitle>Bring your book with you.</DialogTitle>
          <DialogDescription>
            Start with accounts and policy terms, then bring over contacts,
            exposures and activity. Source identities and historical attribution
            are preserved; imports never overwrite agency records.
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy} className="agency-form-grid">
          <label className="agency-field">
            <span>Import type</span>
            <select
              aria-label="Import type"
              value={kind}
              onChange={(e) => {
                const selected = importKindFromValue(e.target.value);
                if (!selected) return;
                setKind(selected);
                setPlan(null);
                setResult(null);
              }}
            >
              <option value="accounts">Accounts</option>
              <option value="policies">Policy terms</option>
              <option value="contacts">Contacts</option>
              <option value="exposures">Exposure schedules</option>
              <option value="notes">Notes and activity</option>
              <option value="tasks">Open tasks</option>
            </select>
          </label>
          <label className="agency-field">
            <span>Source system / migration name</span>
            <input
              value={source}
              maxLength={80}
              placeholder="e.g. Legacy AMS export"
              onChange={(e) => {
                setSource(e.target.value);
                setPlan(null);
                setResult(null);
              }}
            />
          </label>
          <label className="agency-field agency-span">
            <span>CSV file · up to 250 rows</span>
            <input
              aria-label="Import CSV file"
              type="file"
              accept=".csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                setPlan(null);
                setResult(null);
              }}
            />
          </label>
          <button type="button" className="agency-button" onClick={template}>
            <ArrowDownToLine size={15} />
            Download {kind} template
          </button>
          {/* Fictional sample book (public/samples) so the import can be tried without real data. */}
          <a
            className="agency-button"
            href={`/samples/${kind}.csv`}
            download={`sample-book-${kind}.csv`}
          >
            <ArrowDownToLine size={15} />
            Fictional sample
          </a>
          <button
            type="button"
            className="agency-button primary"
            onClick={() => void validate()}
          >
            {busy ? "Working…" : "Validate without importing"}
          </button>
        </fieldset>
        {plan && (
          <div className="agency-import-review">
            <div className="agency-import-totals">
              <strong>{plan.ready} ready</strong>
              <span>{plan.existing} already present</span>
              <span>{plan.errors} errors</span>
              {kind === "policies" && (
                <span>{money(plan.premiumCents)} premium to import</span>
              )}
            </div>
            <p>
              {kind === "policies"
                ? "Policy terms arrive as drafts. Review each term and record carrier-confirmed issuance before treating it as active."
                : kind === "tasks"
                  ? "Tasks arrive open and unassigned. Review due dates and assign an active agency owner before relying on the work queue."
                  : "External IDs match records from this source and make interrupted imports safe to retry."}
            </p>
            <div className="agency-import-rows">
              {(result?.outcomes || plan.rows).map((row) => (
                <div key={row.line}>
                  <strong>
                    Row {row.line} · {row.status}
                  </strong>
                  <span>{row.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {error && (
          <div className="agency-form-error" role="alert">
            {error}
          </div>
        )}
        {result && (
          <div className="agency-form-note" role="status">
            {result.complete
              ? "Import complete."
              : "Import stopped; review the result and retry the same file to continue safely."}{" "}
            {result.created} created, {result.existing} preserved,{" "}
            {result.processedRows} of {result.totalRows} processed.
          </div>
        )}
        <footer className="agency-form-footer">
          <button className="agency-button" onClick={close} disabled={busy}>
            Close
          </button>
          {plan && (
            <button
              className="agency-button"
              disabled={busy}
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      JSON.stringify(
                        {
                          source,
                          kind,
                          exportedAt: new Date().toISOString(),
                          plan,
                          result,
                        },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  ),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = `agency-import-${kind}-${plan.fingerprint.slice(0, 12)}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download reconciliation
            </button>
          )}
          {plan && plan.ready > 0 && !plan.errors && !result?.complete && (
            <button
              className="agency-button primary"
              onClick={() => void apply()}
              disabled={busy}
            >
              <Upload size={15} />
              {busy
                ? "Importing…"
                : result
                  ? "Retry reviewed import"
                  : `Import ${plan.ready} reviewed records`}
            </button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
