"use client";
import { createContext, useContext, useRef, useState } from "react";
import { Download, Mail, Paperclip, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AmsCommandResult } from "@openams/contracts";
import { sameAccount } from "./account-identity-model";
import {
  AgencyRequestError,
  dateLabel,
  human,
  request,
  type AgencySession,
  type AmsRecord,
  type Book,
} from "./model";

type FilingContext = {
  account: AmsRecord<"accounts">;
  book: Book;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
};
export const EmailFilingContext = createContext<FilingContext | null>(null);
export function NativeEmailFilingButton({
  leadId,
  messageId,
}: {
  leadId: string;
  messageId: string;
}) {
  const context = useContext(EmailFilingContext);
  const [open, setOpen] = useState(false);
  if (
    !context?.session.originalEmailFilingEnabled ||
    !context.session.writableKinds.includes("correspondence")
  )
    return null;
  const already = context.book.correspondence?.some(
    (r) =>
      (r as AmsRecord<"correspondence">).data.sourceMessageId === messageId,
  );
  return (
    <>
      <button
        className="agency-button"
        disabled={already}
        onClick={() => setOpen(true)}
      >
        <Mail size={14} />
        {already ? "Filed in agency account" : "File email in account"}
      </button>
      {open && (
        <EmailFilingDialog
          {...context}
          source={{ leadId, messageId }}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function AccountCorrespondence({
  account,
  book,
  session,
  saved,
  open,
}: FilingContext & { open: (record: AmsRecord) => void }) {
  const [filing, setFiling] = useState(false);
  const rows = (book.correspondence || [])
    .filter((r) =>
      sameAccount(
        book,
        (r as AmsRecord<"correspondence">).data.accountId,
        account.id,
      ),
    )
    .sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ) as AmsRecord<"correspondence">[];
  return (
    <section className="account-section" aria-label="Account correspondence">
      <div className="account-section-heading">
        <h2>
          Correspondence <span className="account-count">{rows.length}</span>
        </h2>
        {session.writableKinds.includes("correspondence") && (
          <button
            className="account-text-button"
            onClick={() => setFiling(true)}
          >
            <Upload size={14} />
            File email
          </button>
        )}
      </div>
      {!rows.length ? (
        <p className="account-relay-note">
          File an original email to keep its message and attachments with this
          account. Everyone with account access can read filed correspondence.
        </p>
      ) : (
        <div className="account-relay-list">
          {rows.slice(0, 8).map((row) => (
            <article key={row.id}>
              <div>
                <button
                  className="account-text-button"
                  onClick={() => open(row)}
                >
                  <Mail size={15} />
                  <strong>{row.data.subject}</strong>
                </button>
                <p>
                  {row.data.from || "Sender not recorded"} ·{" "}
                  {dateLabel(row.data.messageAt || row.data.filedAt)}
                </p>
                <p>
                  {human(row.data.direction)}
                  {row.data.attachmentCount
                    ? ` · ${row.data.attachmentCount} attachments`
                    : ""}
                </p>
              </div>
              <a
                className="account-text-button"
                href={`/api/agency/documents/${row.data.originalDocumentId}/content`}
              >
                <Download size={14} />
                Original email
              </a>
            </article>
          ))}
        </div>
      )}
      {rows.length > 8 && (
        <p className="account-relay-note">
          Recent 8 of {rows.length} filed emails. Search this account or use All
          records to see the full correspondence history.
        </p>
      )}
      {filing && (
        <EmailFilingDialog
          account={account}
          book={book}
          session={session}
          saved={saved}
          close={() => setFiling(false)}
        />
      )}
    </section>
  );
}
export function EmailFilingDialog({
  account,
  book,
  saved,
  close,
  source,
}: FilingContext & {
  close: () => void;
  source?: { leadId: string; messageId: string };
}) {
  const [file, setFile] = useState<File | null>(null);
  const [policyId, setPolicyId] = useState("");
  const [direction, setDirection] = useState("unknown");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const flight = useRef(false);
  const pending = useRef<{ path: string; init: RequestInit } | null>(null);
  async function submit() {
    if (flight.current) return;
    if (!pending.current) {
      if (!consent || (!source && !file)) {
        setError(
          "Choose an original email and confirm sharing it with your agency.",
        );
        return;
      }
      const filing = {
        commandId: crypto.randomUUID(),
        expectedVersion: account.version,
        policyId: policyId || null,
        direction,
        shareWithAgency: true,
      };
      if (source)
        pending.current = {
          path: "correspondence/file",
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...filing,
              ...source,
              accountId: account.id,
            }),
          },
        };
      else {
        const query = new URLSearchParams({
          commandId: filing.commandId,
          expectedVersion: filing.expectedVersion,
          direction,
          shareWithAgency: "true",
          ...(policyId ? { policyId } : {}),
        });
        pending.current = {
          path: `accounts/${account.id}/emails?${query}`,
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-file-name": encodeURIComponent(file!.name),
            },
            body: file!,
          },
        };
      }
    }
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request<AmsCommandResult>(
        pending.current.path,
        pending.current.init,
      );
      pending.current = null;
      setUncertain(false);
      saved(result.records);
      close();
    } catch (e) {
      const unknown =
        !(e instanceof AgencyRequestError) ||
        e.status >= 500 ||
        e.status === 408;
      setUncertain(unknown);
      if (!unknown) pending.current = null;
      setError(
        unknown
          ? "The filing could not be confirmed. Retry the same upload to check safely."
          : e instanceof Error
            ? e.message
            : "The email could not be filed.",
      );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy && !uncertain) close();
      }}
    >
      <DialogContent
        className="agency-dialog account-profile-dialog agency-email-filing"
        data-brand="relay"
      >
        <DialogHeader>
          <DialogTitle>File email in {account.data.name}</DialogTitle>
          <DialogDescription>
            Keep the original message and its attachments in the shared account
            history.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset
            className="account-profile-form"
            disabled={busy || uncertain}
          >
            {!source && (
              <label>
                Original email (.eml)
                <input
                  aria-label="Original email (.eml)"
                  type="file"
                  accept=".eml,message/rfc822"
                  required
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
                <span className="account-profile-help">
                  Export the original message from your mailbox. Maximum 20 MB,
                  with up to 30 attachments.
                </span>
              </label>
            )}
            <label>
              Policy term
              <select
                aria-label="Email policy term"
                value={policyId}
                onChange={(e) => setPolicyId(e.target.value)}
              >
                <option value="">Account correspondence</option>
                {book.policies
                  ?.filter((p) =>
                    sameAccount(
                      book,
                      (p as AmsRecord<"policies">).data.accountId,
                      account.id,
                    ),
                  )
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {(p as AmsRecord<"policies">).data.number} ·{" "}
                      {(p as AmsRecord<"policies">).data.carrier}
                    </option>
                  ))}
              </select>
            </label>
            {!source && (
              <label>
                Direction
                <select
                  aria-label="Email direction"
                  value={direction}
                  onChange={(e) => setDirection(e.target.value)}
                >
                  <option value="unknown">Not specified</option>
                  <option value="inbound">Received</option>
                  <option value="outbound">Sent</option>
                </select>
              </label>
            )}
            <label className="agency-email-consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              I have reviewed this email and its attachments and want to share
              them with everyone who can access this agency account.
            </label>
            <p className="account-profile-help">
              The filed copy remains in agency history if the original mailbox
              connection is removed. Filing records evidence; it does not send
              an email or verify the sender.
            </p>
            <button
              className="agency-button primary"
              type="submit"
              disabled={!consent || (!source && !file)}
            >
              <Mail size={15} />
              {busy ? "Filing email…" : "File original email"}
            </button>
          </fieldset>
          {error && (
            <p role="alert" className="agency-form-error">
              {error}
            </p>
          )}
          {uncertain && (
            <button
              type="button"
              className="agency-button"
              disabled={busy}
              onClick={() => void submit()}
            >
              Retry same filing
            </button>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function CorrespondenceDetail({
  record,
  book,
}: {
  record: AmsRecord<"correspondence">;
  book: Book;
}) {
  const d = record.data;
  return (
    <section className="agency-email-detail" aria-label="Filed email">
      <dl>
        <dt>Direction</dt>
        <dd>{human(d.direction)}</dd>
        <dt>From</dt>
        <dd>{d.from || "Not recorded"}</dd>
        <dt>To</dt>
        <dd>{d.to || "Not recorded"}</dd>
        {d.cc && (
          <>
            <dt>Cc</dt>
            <dd>{d.cc}</dd>
          </>
        )}
        <dt>Message date</dt>
        <dd>
          {d.messageAt ? dateLabel(d.messageAt) : "Not recorded in source"}
        </dd>
      </dl>
      <div className="account-relay-message-body">
        {d.body || "No readable text preview. Download the original email to review it."}
      </div>
      {d.bodyTruncated && (
        <p className="account-relay-note">
          This preview was shortened. Download the original email to review the
          complete message.
        </p>
      )}
      <div className="agency-email-attachments">
        {d.documentIds.map((id) => {
          const doc = book.documents?.find((r) => r.id === id) as
            | AmsRecord<"documents">
            | undefined;
          return (
            <a
              className="agency-button"
              key={id}
              href={`/api/agency/documents/${id}/content`}
            >
              <Paperclip size={14} />
              {doc?.data.name ||
                (id === d.originalDocumentId ? "Original email" : "Attachment")}
            </a>
          );
        })}
      </div>
      {!!d.unextractedAttachments.length && (
        <p className="account-relay-note">
          These attachments remain inside the original email because their
          format could not be extracted as a supported document:{" "}
          {d.unextractedAttachments.join(", ")}.
        </p>
      )}
      <p className="account-relay-note">
        Filed {dateLabel(d.filedAt)} ·{" "}
        {d.source === "relay_mailbox"
          ? "Original captured in Relay"
          : d.source === "gmail"
            ? "Original imported from Gmail"
          : d.source === "microsoft365"
            ? "Original imported from Microsoft 365"
          : "Original .eml uploaded"}
        . Shared agency record.
      </p>
    </section>
  );
}
