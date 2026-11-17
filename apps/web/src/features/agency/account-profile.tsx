"use client";

import { useState, type FormEvent } from "react";
import {
  Archive,
  ArrowRight,
  Building2,
  Copy,
  Link2,
  Pencil,
  Plus,
  Undo2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AmsData } from "@openams/contracts";
import type { EditIntent } from "./editor";
import { useAccountCommand } from "./account-command";
import {
  accountDuplicateCandidates,
  accountIdentities,
  canonicalAccountId,
  sameAccount,
} from "./account-identity-model";
import {
  human,
  recordAccount,
  type AgencySession,
  type AmsRecord,
  type Book,
} from "./model";

type Account = AmsRecord<"accounts">;
type Entity = AmsData<"accounts">["insuredEntities"][number];
type CustomField = AmsData<"accounts">["customFields"][number];
type Relationship = AmsData<"accounts">["relationships"][number];
type Edit = { account: Account } & (
  | { kind: "entity"; value?: Entity }
  | { kind: "field"; value?: CustomField }
  | { kind: "relationship"; value?: Relationship }
);
type Props = {
  account: Account;
  book: Book;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  edit: (intent: EditIntent) => void;
};
const relationLabel: Record<Relationship["type"], string> = {
  parent: "Parent company",
  subsidiary: "Subsidiary",
  common_ownership: "Common ownership",
  related: "Related business",
};

export function AccountProfile({ account, book, session, saved, edit }: Props) {
  const [editing, setEditing] = useState<Edit | null>(null);
  const [review, setReview] = useState(false);
  const [undo, setUndo] = useState<Account | null>(null);
  const identities = accountIdentities(book, account.id);
  const entities = identities.flatMap((origin) =>
    (origin.data.insuredEntities || []).map((value) => ({ origin, value })),
  );
  const fields = identities.flatMap((origin) =>
    (origin.data.customFields || []).map((value) => ({ origin, value })),
  );
  const relationships = identities.flatMap((origin) =>
    (origin.data.relationships || []).map((value) => ({ origin, value })),
  );
  const incoming = ((book.accounts || []) as Account[]).flatMap((origin) =>
    (origin.data.relationships || [])
      .filter(
        (value) =>
          sameAccount(book, value.accountId, account.id) &&
          !sameAccount(book, origin.id, account.id),
      )
      .map((value) => ({ origin, value })),
  );
  const candidates = accountDuplicateCandidates(account, book);
  const writable = session.writableKinds.includes("accounts");
  const manager = ["admin", "manager"].includes(session.actor.role);
  return (
    <section
      className="account-section account-profile"
      aria-labelledby="account-profile-title"
    >
      <header className="account-section-heading">
        <div>
          <h2 id="account-profile-title">Business details</h2>
          <p>
            Legal entities, related businesses, and details that matter to your
            agency.
          </p>
        </div>
        {manager && (
          <button
            className="account-text-button"
            onClick={() => setReview(true)}
          >
            <Copy size={14} />
            {candidates.length
              ? `Review ${candidates.length} possible duplicate${candidates.length === 1 ? "" : "s"}`
              : "Review duplicates"}
          </button>
        )}
      </header>
      <div className="account-profile-grid">
        <div>
          <div className="account-profile-heading">
            <h3>
              <Building2 size={15} />
              Insured entities
            </h3>
            {writable && (
              <button
                className="account-text-button"
                onClick={() => setEditing({ kind: "entity", account })}
              >
                <Plus size={14} />
                Add entity
              </button>
            )}
          </div>
          <p className="account-profile-help">
            Record legal entities here. Policy documents establish which
            entities are insured on each term.
          </p>
          {entities.length ? (
            <ul>
              {entities.map(({ origin, value }) => (
                <li key={`${origin.id}:${value.id}`}>
                  <div>
                    <strong>
                      {value.name}
                      {value.inactive && <small> · Inactive</small>}
                    </strong>
                    <small>
                      {[
                        human(value.type),
                        value.dba && `DBA ${value.dba}`,
                        origin.id !== account.id && origin.data.name,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    {value.address.line1 && (
                      <small>
                        {[
                          value.address.line1,
                          value.address.city,
                          value.address.state,
                          value.address.postalCode,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </small>
                    )}
                  </div>
                  {writable && (
                    <button
                      className="agency-icon-button"
                      aria-label={`Edit entity ${value.name}`}
                      onClick={() =>
                        setEditing({ kind: "entity", account: origin, value })
                      }
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="account-profile-empty">
              Add LLCs, corporations, individuals, or other entities represented
              by this account.
            </p>
          )}
        </div>
        <div>
          <div className="account-profile-heading">
            <h3>Agency fields</h3>
            {writable && (
              <button
                className="account-text-button"
                onClick={() => setEditing({ kind: "field", account })}
              >
                <Plus size={14} />
                Add field
              </button>
            )}
          </div>
          {fields.length ? (
            <ul>
              {fields.map(({ origin, value }) => (
                <li key={`${origin.id}:${value.id}`}>
                  <div>
                    <small>
                      {value.label}
                      {origin.id !== account.id ? ` · ${origin.data.name}` : ""}
                    </small>
                    <strong>
                      {typeof value.value === "boolean"
                        ? value.value
                          ? "Yes"
                          : "No"
                        : String(value.value)}
                    </strong>
                  </div>
                  {writable && (
                    <button
                      className="agency-icon-button"
                      aria-label={`Edit field ${value.label}`}
                      onClick={() =>
                        setEditing({ kind: "field", account: origin, value })
                      }
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="account-profile-empty">
              Keep agency-specific details in searchable, typed fields.
            </p>
          )}
        </div>
        <div>
          <div className="account-profile-heading">
            <h3>
              <Link2 size={15} />
              Related accounts
            </h3>
            {writable && (
              <button
                className="account-text-button"
                onClick={() => setEditing({ kind: "relationship", account })}
              >
                <Plus size={14} />
                Link account
              </button>
            )}
          </div>
          {relationships.length + incoming.length ? (
            <ul>
              {relationships.map(({ origin, value }) => {
                const related = book.accounts?.find(
                  (row) => row.id === canonicalAccountId(book, value.accountId),
                ) as Account | undefined;
                return (
                  <li key={`${origin.id}:${value.accountId}`}>
                    <div>
                      <small>{relationLabel[value.type]}</small>
                      <a href={`#accounts/${value.accountId}`}>
                        {related?.data.name || "Archived related account"}
                        <ArrowRight size={13} />
                      </a>
                      {value.notes && <small>{value.notes}</small>}
                    </div>
                    {writable && (
                      <button
                        className="agency-icon-button"
                        aria-label={`Edit relationship ${related?.data.name || value.accountId}`}
                        onClick={() =>
                          setEditing({
                            kind: "relationship",
                            account: origin,
                            value,
                          })
                        }
                      >
                        <Pencil size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
              {incoming.map(({ origin, value }) => (
                <li key={`incoming:${origin.id}:${value.accountId}`}>
                  <div>
                    <small>
                      {value.type === "parent"
                        ? "Subsidiary"
                        : value.type === "subsidiary"
                          ? "Parent company"
                          : relationLabel[value.type]}{" "}
                      · linked from their account
                    </small>
                    <a href={`#accounts/${origin.id}`}>
                      {origin.data.name}
                      <ArrowRight size={13} />
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="account-profile-empty">
              Connect parent companies, subsidiaries, and businesses with common
              ownership.
            </p>
          )}
        </div>
      </div>
      {identities.length > 1 && (
        <details className="account-retained">
          <summary>
            {identities.length - 1} retained account identit
            {identities.length === 2 ? "y" : "ies"}
          </summary>
          <p>
            Agency records appear together in this account. Original identities
            and existing quote links are preserved.
          </p>
          <ul>
            {identities
              .filter((item) => item.id !== account.id)
              .map((origin) => (
                <li key={origin.id}>
                  <div>
                    <strong>{origin.data.name}</strong>
                    <small>
                      {origin.data.source || "Original account"}
                      {origin.data.externalId && ` · ${origin.data.externalId}`}
                    </small>
                  </div>
                  <div className="account-profile-actions">
                    {writable && (
                      <button
                        className="account-text-button"
                        onClick={() =>
                          edit({ kind: "accounts", record: origin })
                        }
                      >
                        Edit original details
                      </button>
                    )}
                    {manager && (
                      <button
                        className="account-text-button"
                        onClick={() => setUndo(origin)}
                      >
                        <Undo2 size={14} />
                        Undo consolidation
                      </button>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        </details>
      )}
      {manager && writable && !account.data.consolidation && (
        <div className="account-profile-archive">
          <h3>Archive account</h3>
          <p className="account-profile-help">
            Remove this account from the active directory. Its records and
            history are retained, and you can restore it from Archived accounts.
            Archiving does not cancel its policies.
          </p>
          <button
            className="account-text-button"
            onClick={() =>
              edit({ kind: "accounts", record: account, action: "archive" })
            }
          >
            <Archive size={14} />
            Archive account
          </button>
        </div>
      )}
      {editing && (
        <ProfileEditor
          key={`${editing.kind}:${editing.account.id}:${editing.value ? "edit" : "new"}`}
          intent={editing}
          book={book}
          saved={saved}
          close={() => setEditing(null)}
        />
      )}
      {review && (
        <ConsolidationReview
          account={account}
          book={book}
          saved={saved}
          close={() => setReview(false)}
        />
      )}
      {undo && (
        <UndoConsolidation
          account={undo}
          saved={saved}
          close={() => setUndo(null)}
        />
      )}
    </section>
  );
}

function ProfileEditor({
  intent,
  book,
  saved,
  close,
}: {
  intent: Edit;
  book: Book;
  saved: Props["saved"];
  close: () => void;
}) {
  const initial = intent.value;
  const [name, setName] = useState(
    initial && "name" in initial
      ? initial.name
      : initial && "label" in initial
        ? initial.label
        : "",
  );
  const [type, setType] = useState<string>(
    initial?.type ||
      (intent.kind === "entity"
        ? "llc"
        : intent.kind === "field"
          ? "text"
          : "related"),
  );
  const [value, setValue] = useState(
    initial && "value" in initial ? String(initial.value) : "",
  );
  const [dba, setDba] = useState(
    initial && "dba" in initial ? initial.dba : "",
  );
  const [inactive, setInactive] = useState(
    initial && "inactive" in initial ? initial.inactive : false,
  );
  const [address, setAddress] = useState(
    initial && "address" in initial
      ? initial.address
      : {
          line1: "",
          line2: "",
          city: "",
          state: "",
          postalCode: "",
          country: "US",
        },
  );
  const [relatedId, setRelatedId] = useState(
    initial && "accountId" in initial ? initial.accountId : "",
  );
  const [notes, setNotes] = useState(
    initial && "notes" in initial ? initial.notes : "",
  );
  const mutation = useAccountCommand(saved);
  const title = `${initial ? "Edit" : "Add"} ${intent.kind === "entity" ? "insured entity" : intent.kind === "field" ? "agency field" : "account relationship"}`;
  async function submit(event: FormEvent, remove = false) {
    event.preventDefault();
    const id = initial && "id" in initial ? initial.id : crypto.randomUUID();
    let data: Record<string, unknown>;
    if (intent.kind === "entity") {
      const entity = { id, name, type, dba, address, inactive, notes };
      data = {
        insuredEntities: [
          ...intent.account.data.insuredEntities.filter(
            (item) => item.id !== id,
          ),
          entity,
        ],
      };
    } else if (intent.kind === "field") {
      const field = {
        id,
        label: name,
        type,
        value:
          type === "boolean"
            ? value === "true"
            : type === "number"
              ? Number(value)
              : value,
      };
      data = {
        customFields: [
          ...intent.account.data.customFields.filter((item) => item.id !== id),
          ...(remove ? [] : [field]),
        ],
      };
    } else {
      const previousId = intent.value?.accountId;
      data = {
        relationships: [
          ...intent.account.data.relationships.filter(
            (item) => item.accountId !== previousId,
          ),
          ...(remove ? [] : [{ accountId: relatedId, type, notes }]),
        ],
      };
    }
    if (
      await mutation.run(() => ({
        id: crypto.randomUUID(),
        kind: "accounts",
        action: "update",
        recordId: intent.account.id,
        expectedVersion: intent.account.version,
        data,
        reason: "",
      }))
    )
      close();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.busy && !mutation.uncertain) close();
      }}
    >
      <DialogContent
        data-brand="relay"
        className="agency-dialog account-profile-dialog"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {intent.account.data.name}. Changes are recorded in the account
            history.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <fieldset
            disabled={mutation.busy || mutation.uncertain}
            className="account-profile-form"
          >
            {intent.kind !== "relationship" && (
              <label>
                {intent.kind === "entity" ? "Legal name" : "Field label"}
                <input
                  required
                  maxLength={intent.kind === "entity" ? 500 : 80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            <label>
              {intent.kind === "entity"
                ? "Entity type"
                : intent.kind === "field"
                  ? "Value type"
                  : "Relationship to this account"}
              <select
                aria-label={
                  intent.kind === "entity"
                    ? "Entity type"
                    : intent.kind === "field"
                      ? "Value type"
                      : "Relationship to this account"
                }
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  if (intent.kind === "field")
                    setValue(e.target.value === "boolean" ? "false" : "");
                }}
              >
                {(intent.kind === "entity"
                  ? [
                      "llc",
                      "corporation",
                      "partnership",
                      "sole_proprietor",
                      "individual",
                      "trust",
                      "other",
                    ]
                  : intent.kind === "field"
                    ? ["text", "number", "date", "boolean"]
                    : Object.keys(relationLabel)
                ).map((option) => (
                  <option key={option} value={option}>
                    {intent.kind === "relationship"
                      ? relationLabel[option as Relationship["type"]]
                      : human(option)}
                  </option>
                ))}
              </select>
            </label>
            {intent.kind === "entity" && (
              <>
                <label>
                  DBA
                  <input
                    value={dba}
                    maxLength={500}
                    onChange={(e) => setDba(e.target.value)}
                  />
                </label>
                <label>
                  Street address
                  <input
                    value={address.line1}
                    maxLength={500}
                    onChange={(e) =>
                      setAddress({ ...address, line1: e.target.value })
                    }
                  />
                </label>
                <label>
                  Suite / unit
                  <input
                    value={address.line2}
                    maxLength={500}
                    onChange={(e) =>
                      setAddress({ ...address, line2: e.target.value })
                    }
                  />
                </label>
                <div className="account-profile-address">
                  <label>
                    City
                    <input
                      value={address.city}
                      maxLength={500}
                      onChange={(e) =>
                        setAddress({ ...address, city: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    State
                    <input
                      value={address.state}
                      maxLength={2}
                      onChange={(e) =>
                        setAddress({
                          ...address,
                          state: e.target.value.toUpperCase(),
                        })
                      }
                    />
                  </label>
                  <label>
                    ZIP
                    <input
                      value={address.postalCode}
                      maxLength={20}
                      onChange={(e) =>
                        setAddress({ ...address, postalCode: e.target.value })
                      }
                    />
                  </label>
                </div>
                <label className="account-profile-check">
                  <input
                    type="checkbox"
                    checked={inactive}
                    onChange={(e) => setInactive(e.target.checked)}
                  />
                  Inactive entity
                </label>
              </>
            )}
            {intent.kind === "field" && (
              <label>
                Value
                {type === "boolean" ? (
                  <select
                    aria-label="Value"
                    value={value || "false"}
                    onChange={(e) => setValue(e.target.value)}
                  >
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : (
                  <input
                    required
                    type={
                      type === "number"
                        ? "number"
                        : type === "date"
                          ? "date"
                          : "text"
                    }
                    step={type === "number" ? "any" : undefined}
                    maxLength={2000}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                )}
              </label>
            )}
            {intent.kind === "relationship" && (
              <label>
                Related account
                <select
                  aria-label="Related account"
                  required
                  value={relatedId}
                  onChange={(e) => setRelatedId(e.target.value)}
                >
                  <option value="">Choose account</option>
                  {((book.accounts || []) as Account[])
                    .filter(
                      (row) =>
                        !row.data.consolidation &&
                        !row.archivedAt &&
                        !sameAccount(book, row.id, intent.account.id),
                    )
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.data.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {intent.kind !== "field" && (
              <label>
                Notes
                <textarea
                  rows={3}
                  maxLength={intent.kind === "entity" ? 10000 : 1000}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
            )}
          </fieldset>
          {mutation.error && (
            <p className="agency-error" role="alert">
              {mutation.error}
            </p>
          )}
          <div className="account-profile-footer">
            {initial && intent.kind !== "entity" && !mutation.uncertain && (
              <button
                type="button"
                className="account-text-button"
                disabled={mutation.busy}
                onClick={(event) => void submit(event, true)}
              >
                Remove {intent.kind === "field" ? "field" : "relationship"}
              </button>
            )}
            <button
              type="button"
              className="agency-button"
              disabled={mutation.busy || mutation.uncertain}
              onClick={close}
            >
              Cancel
            </button>
            <button className="agency-button primary" disabled={mutation.busy}>
              {mutation.busy
                ? "Saving…"
                : mutation.uncertain
                  ? "Retry same save"
                  : "Save changes"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConsolidationReview({
  account,
  book,
  saved,
  close,
}: {
  account: Account;
  book: Book;
  saved: Props["saved"];
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const mutation = useAccountCommand(saved);
  const candidates = accountDuplicateCandidates(account, book);
  const options = ((book.accounts || []) as Account[]).filter(
    (row) =>
      !row.archivedAt &&
      !row.data.consolidation &&
      !row.data.consolidatedAccountIds?.length &&
      row.id !== account.id &&
      (query
        ? JSON.stringify(row.data).toLowerCase().includes(query.toLowerCase())
        : candidates.some((item) => item.account.id === row.id)),
  );
  const source = book.accounts?.find((row) => row.id === sourceId) as
    | Account
    | undefined;
  const count = (id: string) =>
    Object.values(book)
      .flat()
      .filter((row) => row.kind !== "accounts" && recordAccount(row) === id)
      .length;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.busy && !mutation.uncertain) close();
      }}
    >
      <DialogContent
        data-brand="relay"
        className="agency-dialog account-profile-dialog"
      >
        <DialogHeader>
          <DialogTitle>Review duplicate accounts</DialogTitle>
          <DialogDescription>
            Keep {account.data.name} as the primary account. Matching details
            are hints; confirm these are the same customer before consolidating.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!source) return;
            if (
              await mutation.run(() => ({
                id: crypto.randomUUID(),
                kind: "accounts",
                action: "account.consolidate",
                recordId: source.id,
                expectedVersion: source.version,
                data: { targetId: account.id, targetVersion: account.version },
                reason,
              }))
            )
              close();
          }}
        >
          <fieldset
            disabled={mutation.busy || mutation.uncertain}
            className="account-profile-form"
          >
            <label>
              Find another account
              <input
                placeholder="Search by name, email, or phone"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label>
              Duplicate to consolidate
              <select
                aria-label="Duplicate to consolidate"
                required
                value={sourceId}
                onChange={(e) => {
                  setSourceId(e.target.value);
                  setReviewed(false);
                }}
              >
                <option value="">Choose a reviewed duplicate</option>
                {options.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.data.name}
                    {candidates.find((item) => item.account.id === row.id)
                      ?.reasons.length
                      ? ` · ${candidates.find((item) => item.account.id === row.id)!.reasons.join(", ")}`
                      : ""}
                  </option>
                ))}
                {source && !options.some((row) => row.id === source.id) && (
                  <option value={source.id}>{source.data.name}</option>
                )}
              </select>
            </label>
            {source && (
              <>
                <div className="account-consolidation-comparison">
                  {[account, source].map((row, i) => (
                    <div key={row.id}>
                      <small>
                        {i ? "Retain as original identity" : "Primary account"}
                      </small>
                      <strong>{row.data.name}</strong>
                      <span>{row.data.email || "No email"}</span>
                      <span>{row.data.phone || "No phone"}</span>
                      <span>{count(row.id)} associated records</span>
                      <span>
                        {row.data.leadIds.length} existing quote links
                      </span>
                    </div>
                  ))}
                </div>
                <p className="account-profile-help">
                  Both sets of records and details remain intact. This combines
                  the account view; it does not deduplicate policy terms or
                  change the primary profile. Undo is available only before
                  further account work is recorded.
                </p>
                <label className="account-profile-check">
                  <input
                    required
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  I reviewed both identities and confirmed they represent the
                  same customer.
                </label>
                <label>
                  Reason
                  <textarea
                    required
                    maxLength={2000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
              </>
            )}
          </fieldset>
          {mutation.error && (
            <p className="agency-error" role="alert">
              {mutation.error}
            </p>
          )}
          <div className="account-profile-footer">
            <button
              type="button"
              className="agency-button"
              onClick={close}
              disabled={mutation.busy || mutation.uncertain}
            >
              Cancel
            </button>
            <button
              className="agency-button primary"
              disabled={mutation.busy || !source || !reviewed}
            >
              {mutation.busy
                ? "Consolidating…"
                : mutation.uncertain
                  ? "Retry same consolidation"
                  : "Consolidate accounts"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UndoConsolidation({
  account,
  saved,
  close,
}: {
  account: Account;
  saved: Props["saved"];
  close: () => void;
}) {
  const mutation = useAccountCommand(saved);
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.busy && !mutation.uncertain) close();
      }}
    >
      <DialogContent
        data-brand="relay"
        className="agency-dialog account-profile-dialog"
      >
        <DialogHeader>
          <DialogTitle>Undo account consolidation</DialogTitle>
          <DialogDescription>
            {account.data.name} will return to the account directory with its
            original records. If work has been recorded since consolidation, the
            server will require a reviewed separation.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              await mutation.run(() => ({
                id: crypto.randomUUID(),
                kind: "accounts",
                action: "account.undoConsolidation",
                recordId: account.id,
                expectedVersion: account.version,
                data: {},
                reason,
              }))
            )
              close();
          }}
        >
          <fieldset
            disabled={mutation.busy || mutation.uncertain}
            className="account-profile-form"
          >
            <label>
              Reason
              <textarea
                required
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </fieldset>
          {mutation.error && (
            <p className="agency-error" role="alert">
              {mutation.error}
            </p>
          )}
          <div className="account-profile-footer">
            <button
              type="button"
              className="agency-button"
              onClick={close}
              disabled={mutation.busy || mutation.uncertain}
            >
              Cancel
            </button>
            <button className="agency-button primary" disabled={mutation.busy}>
              {mutation.busy
                ? "Checking…"
                : mutation.uncertain
                  ? "Retry same undo"
                  : "Undo consolidation"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
