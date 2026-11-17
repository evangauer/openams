"use client";
import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { AmsCommandResult, AmsRecord } from "@openams/contracts";
import {
  AgencyRequestError,
  request,
  today,
  dateLabel,
  type Book,
  type AgencySession,
} from "./model";
import { certificateDefaults } from "./certificate-model";
import { useAccountCommand } from "./account-command";

type Certificate = AmsRecord<"certificates">;
type Template = AmsRecord<"certificatetemplates">;
export function CertificatePreparation({
  record,
  book,
  agency,
  timeZone,
  close,
  saved,
}: {
  record: Certificate;
  book: Book;
  agency: string;
  timeZone?: string;
  close: () => void;
  saved: (records: AmsRecord[]) => void;
}) {
  const templates = (book.certificatetemplates || []) as Template[];
  const usable = templates.filter((t) => !t.archivedAt && !t.data.revokedAt);
  const [templateId, setTemplateId] = useState(
    record.data.preparation?.templateId || usable[0]?.id || "",
  );
  const template = usable.find((t) => t.id === templateId);
  const account = book.accounts?.find((r) => r.id === record.data.accountId) as
    | AmsRecord<"accounts">
    | undefined;
  const policies = (book.policies || []).filter((r) =>
    record.data.policyIds.includes(r.id),
  ) as AmsRecord<"policies">[];
  const defaults: Record<string, string | boolean> = {
    ...(account
      ? certificateDefaults(record, account, policies, agency, timeZone)
      : {}),
    insured: account?.data.legalName || account?.data.name || "",
    agency,
    holder: record.data.holderName,
    holder_email: record.data.holderEmail,
    description: record.data.description,
    date: today(timeZone),
    policies: policies
      .map(
        (p) =>
          `${p.data.number} | ${p.data.carrier} | ${p.data.effectiveDate} to ${p.data.expirationDate}`,
      )
      .join("\n"),
  };
  const [values, setValues] = useState<Record<string, string | boolean>>(
    record.data.preparation?.fields || defaults,
  );
  const [draft, setDraft] = useState<Certificate | null>(
    record.data.preparation && record.data.documentId ? record : null,
  );
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<string | null>(null);
  const inFlight = useRef(false);
  const mutation = useAccountCommand(saved);
  async function prepare() {
    if (inFlight.current || !template || !account) return;
    pending.current ||= JSON.stringify({
      commandId: crypto.randomUUID(),
      expectedVersion: record.version,
      templateId,
      accountVersion: account.version,
      policyVersions: policies.map((p) => ({ id: p.id, version: p.version })),
      fields: Object.fromEntries(
        template.data.fields.map((f) => [
          f.pdfKey,
          values[f.pdfKey] ?? (f.type === "checkbox" ? false : ""),
        ]),
      ),
    });
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request<AmsCommandResult>(
        `certificates/${record.id}/prepare`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: pending.current,
        },
      );
      const next = result.records.find(
        (r) => r.kind === "certificates",
      ) as Certificate;
      saved(result.records);
      setDraft(next);
      setReviewed(false);
      pending.current = null;
      setUncertain(false);
    } catch (failure) {
      const unknown =
        !(failure instanceof AgencyRequestError) ||
        failure.status >= 500 ||
        failure.status === 408;
      setUncertain(unknown);
      if (!unknown) pending.current = null;
      setError(
        unknown
          ? "The result could not be confirmed. Retry the same preparation safely."
          : failure.message,
      );
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  async function issue() {
    if (!draft || !reviewed) return;
    if (
      await mutation.run(() => ({
        id: crypto.randomUUID(),
        action: "certificate.issue",
        kind: "certificates",
        recordId: draft.id,
        expectedVersion: draft.version,
        data: { documentId: draft.data.documentId, reviewed: true },
        reason: "Reviewed final PDF and issued policy evidence",
      }))
    )
      close();
  }
  const locked = busy || uncertain || mutation.busy || mutation.uncertain;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) close();
      }}
    >
      <DialogContent
        className="agency-dialog agency-certificate-dialog"
        showClose={!locked}
      >
        <DialogHeader>
          <DialogTitle>
            {draft ? "Review certificate" : "Prepare certificate"}
          </DialogTitle>
          <DialogDescription>
            {record.data.holderName} · Preparation, issuance and delivery are
            separate steps.
          </DialogDescription>
        </DialogHeader>
        {(error || mutation.error) && (
          <p className="agency-form-error" role="alert">
            {error || mutation.error}
          </p>
        )}
        <div className="agency-editor-scroll">
          <p className="agency-form-note">
            Check the complete PDF against the issued policy documents. Coverage
            limits, additional-insured wording, cancellation promises and
            signatures require your review; they are not inferred.
          </p>
          <ul>
            {policies.map((p) => (
              <li key={p.id}>
                {p.data.number} · {p.data.line} · {p.data.effectiveDate}–
                {p.data.expirationDate}
              </li>
            ))}
          </ul>
          {draft ? (
            <>
              <a
                className="agency-button"
                href={`/api/agency/documents/${draft.data.documentId}/content`}
                target="_blank"
                rel="noreferrer"
              >
                Download PDF for review
              </a>
              <p>
                Template:{" "}
                {templates.find(
                  (t) => t.id === draft.data.preparation?.templateId,
                )?.data.name || draft.data.preparation?.formId}
                . The saved document is a draft until you record issuance.
              </p>
              <label className="agency-checkbox">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={locked}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I opened and reviewed this PDF, confirmed the policy evidence
                and form edition, and have authority to issue it.
              </label>
            </>
          ) : (
            <fieldset disabled={locked} className="agency-certificate-fields">
              <label className="agency-field">
                <span>Authorized form edition</span>
                <select
                  value={templateId}
                  onChange={(e) => {
                    setTemplateId(e.target.value);
                    setValues(defaults);
                  }}
                >
                  <option value="">Choose a template</option>
                  {usable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.data.name} · {t.data.edition}
                    </option>
                  ))}
                </select>
              </label>
              {!usable.length && (
                <p>
                  An administrator or manager must add an authorized fillable
                  PDF from Certificates → Templates. No licensed forms are
                  included.
                </p>
              )}
              {template && (
                <p className="agency-form-note">
                  Authorization reference: {template.data.authorization}. Empty
                  fields are cleared when preparing the PDF. Review every field.
                </p>
              )}
              <div className="agency-form-grid">
                {template?.data.fields.map((f) => (
                  <label className="agency-field" key={f.pdfKey}>
                    <span>{f.label}</span>
                    {f.type === "checkbox" ? (
                      <input
                        type="checkbox"
                        checked={values[f.pdfKey] === true}
                        onChange={(e) =>
                          setValues({ ...values, [f.pdfKey]: e.target.checked })
                        }
                      />
                    ) : (
                      <textarea
                        rows={f.multiline ? 3 : 1}
                        maxLength={f.maxLength}
                        value={String(values[f.pdfKey] ?? "")}
                        onChange={(e) =>
                          setValues({ ...values, [f.pdfKey]: e.target.value })
                        }
                      />
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>
        <div className="agency-form-footer">
          {draft ? (
            <>
              <button
                className="agency-button"
                disabled={locked}
                onClick={() => {
                  setDraft(null);
                  setReviewed(false);
                }}
              >
                Revise draft
              </button>
              <button
                className="agency-button primary"
                disabled={busy || mutation.busy || !reviewed}
                onClick={issue}
              >
                {mutation.uncertain
                  ? "Retry issuance"
                  : "Record issued certificate"}
              </button>
            </>
          ) : (
            <button
              className="agency-button primary"
              disabled={
                busy ||
                !template ||
                !account ||
                policies.length !== record.data.policyIds.length
              }
              onClick={prepare}
            >
              {busy
                ? "Preparing…"
                : uncertain
                  ? "Retry same preparation"
                  : "Prepare PDF for review"}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CertificateTemplates({
  book,
  session,
  saved,
}: {
  book: Book;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
}) {
  const canManage = session.writableKinds.includes("certificatetemplates");
  const [name, setName] = useState("");
  const [edition, setEdition] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const pending = useRef<{ query: string; file: File } | null>(null);
  const inFlight = useRef(false);
  const mutation = useAccountCommand(saved);
  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !file || !authorized) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("Choose a PDF under 5 MB.");
      return;
    }
    pending.current ||= {
      query: new URLSearchParams({
        commandId: crypto.randomUUID(),
        name,
        edition,
        authorization,
        authorized: "true",
      }).toString(),
      file,
    };
    setBusy(true);
    inFlight.current = true;
    setError("");
    try {
      const result = await request<AmsCommandResult>(
        `certificate-templates?${pending.current.query}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: pending.current.file,
        },
      );
      saved(result.records);
      pending.current = null;
      setUncertain(false);
      setName("");
      setEdition("");
      setAuthorization("");
      setAuthorized(false);
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (failure) {
      const unknown =
        !(failure instanceof AgencyRequestError) ||
        failure.status >= 500 ||
        failure.status === 408;
      setUncertain(unknown);
      if (!unknown) pending.current = null;
      setError(
        unknown
          ? "The upload could not be confirmed. Retry the same upload."
          : failure.message,
      );
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  return (
    <section className="agency-panel agency-certificate-templates">
      <h2>Authorized certificate templates</h2>
      <p>
        Supply a blank fillable PDF your agency is authorized to use. OpenAMS
        includes no ACORD or other licensed forms. Each upload is a separate,
        immutable edition.
      </p>
      {(error || mutation.error) && (
        <p className="agency-form-error" role="alert">
          {error || mutation.error}
        </p>
      )}
      {canManage && (
        <form onSubmit={upload}>
          <fieldset disabled={busy || uncertain} className="agency-form-grid">
            <label className="agency-field">
              <span>Form name</span>
              <input
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="agency-field">
              <span>Edition</span>
              <input
                required
                maxLength={200}
                value={edition}
                onChange={(e) => setEdition(e.target.value)}
              />
            </label>
            <label className="agency-field">
              <span>Authorization reference</span>
              <input
                required
                maxLength={200}
                value={authorization}
                onChange={(e) => setAuthorization(e.target.value)}
                placeholder="License or agency authorization reference"
              />
            </label>
            <label className="agency-field">
              <span>Blank fillable PDF (up to 5 MB)</span>
              <input
                type="file"
                ref={fileInput}
                accept="application/pdf"
                required
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
            <label className="agency-checkbox agency-span">
              <input
                type="checkbox"
                checked={authorized}
                onChange={(e) => setAuthorized(e.target.checked)}
                required
              />
              I confirm this edition is blank and our agency has permission to
              use and reproduce it.
            </label>
          </fieldset>
          <button
            className="agency-button primary"
            disabled={busy || !file || !authorized}
          >
            {busy
              ? "Checking PDF…"
              : uncertain
                ? "Retry same upload"
                : "Authorize template"}
          </button>
        </form>
      )}
      {canManage && (
        <label className="agency-field">
          <span>Reason when revoking an edition</span>
          <input
            value={revokeReason}
            maxLength={2000}
            disabled={mutation.busy || mutation.uncertain}
            onChange={(e) => setRevokeReason(e.target.value)}
          />
        </label>
      )}
      <ul>
        {((book.certificatetemplates as Template[]) || []).map((t) => (
          <li key={t.id}>
            <strong>
              {t.data.name} · {t.data.edition}
            </strong>{" "}
            —{" "}
            {t.data.revokedAt
              ? `Revoked: ${t.data.revocationReason}`
              : "Authorized"}
            {!t.data.revokedAt && (
              <>
                {" "}
                <a href={`/api/agency/certificate-templates/${t.id}/content`}>
                  Download original
                </a>
                {canManage && (
                  <button
                    className="agency-button"
                    disabled={
                      !revokeReason.trim() ||
                      mutation.busy ||
                      mutation.uncertain
                    }
                    onClick={() =>
                      void mutation.run(() => ({
                        id: crypto.randomUUID(),
                        kind: "certificatetemplates",
                        action: "template.revoke",
                        recordId: t.id,
                        expectedVersion: t.version,
                        reason: revokeReason,
                        data: {},
                      }))
                    }
                  >
                    Revoke edition
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {mutation.uncertain && (
        <button
          className="agency-button"
          disabled={mutation.busy}
          onClick={() => void mutation.retry()}
        >
          Retry revocation
        </button>
      )}
    </section>
  );
}

export function CertificateServicing({
  record,
  book,
  session,
  saved,
  edit,
  open,
}: {
  record: Certificate;
  book: Book;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  edit: (intent: import("./editor").EditIntent) => void;
  open: (record: AmsRecord) => void;
}) {
  const canWrite = session.writableKinds.includes("certificates");
  const [recipient, setRecipient] = useState(
    record.data.holderEmail || record.data.holderName,
  );
  const [method, setMethod] = useState("email");
  const [evidence, setEvidence] = useState("");
  const [deliveredAt, setDeliveredAt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const mutation = useAccountCommand(saved);
  async function delivery(event: React.FormEvent) {
    event.preventDefault();
    if (!deliveredAt) return;
    if (
      await mutation.run(() => ({
        id: crypto.randomUUID(),
        action: "certificate.deliver",
        kind: "certificates",
        recordId: record.id,
        expectedVersion: record.version,
        reason: "Staff recorded external delivery",
        data: {
          recipient,
          method,
          evidence,
          deliveredAt: new Date(deliveredAt).toISOString(),
          confirmed,
          completeService,
          serviceVersion: service?.version,
        },
      }))
    ) {
      setEvidence("");
      setConfirmed(false);
      setCompleteService(false);
    }
  }
  const service = book.services?.find((s) => s.id === record.data.serviceId) as
    | AmsRecord<"services">
    | undefined;
  const [completeService, setCompleteService] = useState(false);
  const related = (book.certificates || []) as Certificate[];
  const previous = related.find(
    (c) => c.id === record.data.previousCertificateId,
  );
  return (
    <section className="agency-certificate-service">
      {service && (
        <p>
          Service request:{" "}
          <button className="agency-button quiet" onClick={() => open(service)}>
            {service.data.title} · {service.data.status}
          </button>
        </p>
      )}
      {record.data.previousCertificateId && (
        <p>
          Reissue reason: {record.data.reissueReason}. The previous certificate
          is retained.
          {previous && (
            <button
              className="agency-button quiet"
              onClick={() => open(previous)}
            >
              View previous certificate
            </button>
          )}
        </p>
      )}
      {related
        .filter((c) => c.data.previousCertificateId === record.id)
        .map((c) => (
          <button
            key={c.id}
            className="agency-button quiet"
            onClick={() => open(c)}
          >
            Open reissue request · {c.data.status}
          </button>
        ))}
      {canWrite && ["issued", "void"].includes(record.data.status) && (
        <button
          className="agency-button"
          onClick={() =>
            edit({
              kind: "certificates",
              record,
              action: "certificate.reissue",
              accountId: record.data.accountId,
              initial: {
                policyIds: [],
                requestedDate: today(session.timeZone),
              },
            })
          }
        >
          Create renewal / reissue request
        </button>
      )}
      {record.data.status === "issued" && (
        <>
          <h3>Delivery</h3>
          <p>
            Download the issued PDF and send it using your agency’s approved
            channel. An email draft does not send a message or confirm delivery.
          </p>
          {record.data.holderEmail && (
            <a
              className="agency-button"
              href={`/api/agency/certificates/${record.id}/email-draft`}
            >
              Download email draft with PDF
            </a>
          )}
          {canWrite && (
            <form onSubmit={delivery}>
              <fieldset
                disabled={mutation.busy || mutation.uncertain}
                className="agency-form-grid"
              >
                <label className="agency-field">
                  <span>Recipient</span>
                  <input
                    required
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    maxLength={200}
                  />
                </label>
                <label className="agency-field">
                  <span>Delivery channel</span>
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    <option value="email">Email</option>
                    <option value="portal">Recipient portal</option>
                    <option value="mail">Mail</option>
                    <option value="in_person">In person</option>
                  </select>
                </label>
                <label className="agency-field">
                  <span>Delivered at (your local time)</span>
                  <input
                    type="datetime-local"
                    step="1"
                    required
                    value={deliveredAt}
                    onChange={(e) => setDeliveredAt(e.target.value)}
                  />
                </label>
                <label className="agency-field">
                  <span>Delivery evidence / reference</span>
                  <textarea
                    required
                    maxLength={1000}
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    placeholder="Sent-message ID, portal receipt, or handover reference"
                  />
                </label>
                {service && service.data.status !== "completed" && (
                  <label className="agency-checkbox agency-span">
                    <input
                      type="checkbox"
                      checked={completeService}
                      onChange={(e) => setCompleteService(e.target.checked)}
                    />
                    Also complete “{service.data.title}” and attach this issued
                    PDF to its resolution.
                  </label>
                )}
                <label className="agency-checkbox agency-span">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    required
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I confirm delivery occurred outside OpenAMS and have recorded
                  the supporting reference.
                </label>
              </fieldset>
              <button
                className="agency-button"
                disabled={mutation.busy || !confirmed}
              >
                {mutation.uncertain
                  ? "Retry same delivery record"
                  : "Record external delivery"}
              </button>
            </form>
          )}
        </>
      )}
      {mutation.error && (
        <p role="alert" className="agency-form-error">
          {mutation.error}
        </p>
      )}
      {record.data.deliveries.length > 0 && (
        <>
          <h3>Delivery history</h3>
          <ul>
            {record.data.deliveries.map((d) => (
              <li key={d.id}>
                {d.recipient} · {d.method} · {dateLabel(d.deliveredAt)}
                <br />
                {d.evidence}
                <br />
                <small>
                  Recorded by{" "}
                  {session.members.find((m) => m.id === d.recordedBy)?.name ||
                    d.recordedBy}
                  ; staff-attested external delivery.
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
