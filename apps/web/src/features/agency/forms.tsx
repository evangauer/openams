"use client";
// Forms: the agency's hosted forms and what clients send through them. A submission
// waits here, apart from the book, until someone files it to an account or dismisses it.
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ClipboardPen,
  Download,
  ExternalLink,
  FileText,
  Inbox,
  Link2,
  Mail,
  Paperclip,
  Phone,
  Plus,
  Search,
  UserRoundPlus,
  X,
} from "lucide-react";
import { amsFormValueText } from "@openams/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAccountCommand } from "./account-command";
import { workspaceRecord } from "./agency-profile";
import { FormBuilder, type BuilderStep } from "./form-builder";
import {
  exposureSummary,
  formUrl,
  matchingAccounts,
  newFormDraft,
  timeAgo,
  type FormRecord,
  type SubmissionRecord,
} from "./forms-model";
import { dateLabel, findAccount, type AgencySession, type AmsRecord, type Book } from "./model";
import { PageHeader } from "./page-header";
import "./forms.css";

const STARTERS = [
  { label: "Personal lines quote", detail: "Auto, home, renters and umbrella in one form", lines: ["auto", "home", "renters", "umbrella"] },
  { label: "Auto quote", detail: "Drivers, vehicles and current coverage", lines: ["auto"] },
  { label: "Homeowners quote", detail: "The home, its features and coverage", lines: ["home"] },
  { label: "Small business quote", detail: "General liability, BOP and workers' comp", lines: ["general_liability", "bop", "workers_comp"] },
  { label: "Commercial auto quote", detail: "Vehicles, drivers and how they are used", lines: ["commercial_auto"] },
  { label: "Start from a blank form", detail: "Contact details and your own questions", lines: [] },
];
const FILTERS = {
  new: "New",
  filed: "Filed",
  dismissed: "Dismissed",
  all: "All",
} as const;
type Filter = keyof typeof FILTERS;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const who = (submission: SubmissionRecord) =>
  submission.data.contact.businessName || submission.data.contact.name;

export function FormsView({
  book,
  session,
  saved,
  route,
  navigate,
}: {
  book: Book;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  /** The address after "forms": [], ["new"], [formId], ["submissions"], ["submissions", id]. */
  route: string[];
  navigate: (view: string) => void;
}) {
  const forms = useMemo(
    () => [...((book.forms || []) as FormRecord[])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [book.forms],
  );
  const submissions = useMemo(
    () =>
      [...((book.formsubmissions || []) as SubmissionRecord[])].sort((a, b) =>
        b.data.submittedAt.localeCompare(a.data.submittedAt),
      ),
    [book.formsubmissions],
  );
  const canBuild = session.writableKinds.includes("forms");
  const agency = workspaceRecord(book)?.data;
  const [starter, setStarter] = useState<{ lines: string[]; name: string }>({ lines: [], name: "" });
  const initial = useMemo(
    () =>
      newFormDraft(
        { name: agency?.name ?? session.workspaceName, phone: agency?.phone, email: agency?.email },
        starter.lines,
        starter.name,
      ),
    // A new draft is made once per visit to the builder, from the starter chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [starter],
  );
  const newCount = submissions.filter((item) => item.data.status === "new").length;
  const [builderStep, setBuilderStep] = useState<BuilderStep | null>(null);

  if (route[0] && route[0] !== "submissions") {
    const record = route[0] === "new" ? null : (forms.find((form) => form.id === route[0]) ?? null);
    if (route[0] !== "new" && !record)
      return (
        <div className="fm-missing">
          <p role="alert">This form is not in your agency, or it was archived.</p>
          <button type="button" className="agency-button" onClick={() => navigate("forms")}>
            Back to forms
          </button>
        </div>
      );
    return (
      // One builder per form: moving between forms never carries one form's edits into
      // another. The step is kept here so a new form's first save doesn't reset it.
      <FormBuilder
        key={record?.id ?? "new"}
        record={record}
        initial={initial}
        session={session}
        saved={saved}
        step={builderStep}
        setStep={setBuilderStep}
        back={() => {
          setBuilderStep(null);
          navigate("forms");
        }}
        opened={(id) => {
          // The address follows the new form without leaving the builder.
          window.history.replaceState(null, "", `#forms/${id}`);
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        }}
      />
    );
  }
  const showSubmissions = route[0] === "submissions";
  const start = (lines: string[], name = "") => {
    setStarter({ lines, name });
    setBuilderStep(null);
    navigate("forms/new");
  };
  return (
    <div className="fm">
      <PageHeader
        eyebrow="HOSTED FORMS"
        title="Forms"
        description="Send clients a link instead of a PDF. They answer on any device and attach what they have; you file it to an account in one step."
      >
        {canBuild && forms.length > 0 && (
          <button type="button" className="agency-button primary" onClick={() => start([])}>
            <Plus size={16} />
            New form
          </button>
        )}
      </PageHeader>
      <nav className="agency-tabs fm-tabs" aria-label="Forms sections">
        <button type="button" aria-current={!showSubmissions ? "page" : undefined} onClick={() => navigate("forms")}>
          Your forms <span>{forms.length}</span>
        </button>
        <button
          type="button"
          aria-current={showSubmissions ? "page" : undefined}
          onClick={() => navigate("forms/submissions")}
        >
          Submissions <span data-new={newCount > 0 || undefined}>{newCount ? `${newCount} new` : submissions.length}</span>
        </button>
      </nav>
      {showSubmissions ? (
        <Submissions
          submissions={submissions}
          selectedId={route[1]}
          book={book}
          session={session}
          saved={saved}
          navigate={navigate}
        />
      ) : forms.length ? (
        <div className="fm-forms">
          {forms.map((form) => (
            <FormCard
              key={form.id}
              form={form}
              submissions={submissions.filter((item) => item.data.formId === form.id)}
              open={() => {
                setBuilderStep(null);
                navigate(`forms/${form.id}`);
              }}
              openSubmissions={() => navigate("forms/submissions")}
            />
          ))}
        </div>
      ) : (
        <section className="fm-start">
          <span className="fm-start-icon" aria-hidden="true">
            <ClipboardPen size={22} />
          </span>
          <h2>Build your first form</h2>
          <p>
            Pick a starting point. Every question can be reworded, removed or added to, and
            you see the client&apos;s side as you go.
          </p>
          {canBuild ? (
            <div className="fm-starters">
              {STARTERS.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => start(item.lines, item.lines.length ? item.label : "")}
                >
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : (
            <p className="fm-quiet">An administrator or manager builds and publishes forms.</p>
          )}
        </section>
      )}
    </div>
  );
}

function FormCard({
  form,
  submissions,
  open,
  openSubmissions,
}: {
  form: FormRecord;
  submissions: SubmissionRecord[];
  open: () => void;
  openSubmissions: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { status, linkId } = form.data;
  const fresh = submissions.filter((item) => item.data.status === "new").length;
  const link = linkId && status === "published" ? formUrl(window.location.origin, linkId) : "";
  return (
    <article className="fm-form">
      <button type="button" className="fm-form-main" onClick={open}>
        <span className="fm-form-head">
          <h3>{form.data.name}</h3>
          <span className="fm-form-status" data-status={status}>
            <i />
            {status === "published" ? "Live" : status === "paused" ? "Paused" : "Draft"}
          </span>
        </span>
        <p>
          {form.data.lines.length
            ? form.data.lines.map((line) => line.label).join(" · ")
            : "Your own questions"}
        </p>
        <small>
          {form.data.sections.reduce((total, section) => total + section.fields.length, 0)} questions · edited{" "}
          {timeAgo(form.updatedAt)}
        </small>
      </button>
      <footer>
        <button type="button" className="fm-form-count" onClick={openSubmissions}>
          <Inbox size={15} />
          <span>
            {submissions.length} {submissions.length === 1 ? "submission" : "submissions"}
          </span>
          {fresh > 0 && <em>{fresh} new</em>}
        </button>
        {link && (
          <span>
            <button
              type="button"
              className="agency-button quiet"
              onClick={() =>
                void navigator.clipboard.writeText(link).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1600);
                })
              }
            >
              {copied ? <Check size={14} /> : <Link2 size={14} />}
              {copied ? "Copied" : "Copy link"}
            </button>
            <a className="agency-button quiet" href={link} target="_blank" rel="noreferrer" aria-label={`Open ${form.data.name}`}>
              <ExternalLink size={14} />
            </a>
          </span>
        )}
      </footer>
    </article>
  );
}

function Submissions({
  submissions,
  selectedId,
  book,
  session,
  saved,
  navigate,
}: {
  submissions: SubmissionRecord[];
  selectedId?: string;
  book: Book;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  navigate: (view: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>(
    submissions.some((item) => item.data.status === "new") ? "new" : "all",
  );
  const [query, setQuery] = useState("");
  const shown = submissions.filter(
    (item) =>
      (filter === "all" || item.data.status === filter) &&
      (!query.trim() ||
        JSON.stringify([item.data.contact, item.data.formName, item.data.lines])
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  const selected =
    submissions.find((item) => item.id === selectedId) ?? (selectedId ? undefined : shown[0]);
  // Once the last new submission is filed or dismissed, show where it went.
  const newLeft = submissions.some((item) => item.data.status === "new");
  useEffect(() => {
    if (!newLeft) setFilter((current) => (current === "new" ? "all" : current));
  }, [newLeft]);
  // With nothing chosen, a wide screen shows the first submission beside the list (a
  // narrow one shows the list alone). The address changes only when a person chooses.
  if (!submissions.length)
    return (
      <section className="fm-start">
        <span className="fm-start-icon" aria-hidden="true">
          <Inbox size={22} />
        </span>
        <h2>Submissions land here</h2>
        <p>
          When a client sends a form you get a task, and their answers and files wait here until
          you file them to an account.
        </p>
      </section>
    );
  return (
    <div className="fm-inbox" data-open={selectedId ? true : undefined}>
      <div className="fm-list">
        <div className="fm-filters">
          <div role="tablist" aria-label="Filter submissions">
            {(Object.keys(FILTERS) as Filter[]).map((key) => (
              <button key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}>
                {FILTERS[key]}
                <em>{submissions.filter((item) => key === "all" || item.data.status === key).length}</em>
              </button>
            ))}
          </div>
          <label className="fm-search">
            <Search size={14} />
            <input
              aria-label="Search submissions"
              placeholder="Search by name or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        {shown.length ? (
          <ul>
            {shown.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={selected?.id === item.id ? "true" : undefined}
                  onClick={() => navigate(`forms/submissions/${item.id}`)}
                >
                  <span className="fm-dot" data-status={item.data.status} aria-hidden="true" />
                  <span className="fm-row-main">
                    <strong>{who(item)}</strong>
                    <small>
                      {item.data.lines.map((line) => line.label).join(", ") || item.data.formName}
                    </small>
                  </span>
                  <span className="fm-row-side">
                    <time dateTime={item.data.submittedAt}>{timeAgo(item.data.submittedAt)}</time>
                    {item.data.files.length > 0 && (
                      <small>
                        <Paperclip size={11} />
                        {item.data.files.length}
                      </small>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fm-quiet">Nothing here. Try another filter.</p>
        )}
      </div>
      {selected ? (
        <SubmissionDetail
          key={selected.id}
          submission={selected}
          book={book}
          session={session}
          saved={saved}
          navigate={navigate}
        />
      ) : (
        <p className="fm-quiet fm-detail-empty">Choose a submission to read it.</p>
      )}
    </div>
  );
}

function SubmissionDetail({
  submission,
  book,
  session,
  saved,
  navigate,
}: {
  submission: SubmissionRecord;
  book: Book;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  navigate: (view: string) => void;
}) {
  const [filing, setFiling] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const reopen = useAccountCommand(saved);
  // Filing or dismissing takes a submission out of the New list. Keep it on screen so the
  // person sees where it went, instead of the next one sliding into its place.
  const savedHere = (records: AmsRecord[]) => {
    saved(records);
    navigate(`forms/submissions/${submission.id}`);
  };
  const { data } = submission;
  const canFile =
    session.writableKinds.includes("formsubmissions") && session.writableKinds.includes("accounts");
  const account = findAccount(book, data.accountId);
  const filedBy = session.members.find((member) => member.id === data.filedBy)?.name;
  return (
    <article className="fm-detail">
      <button type="button" className="fm-detail-back" onClick={() => navigate("forms/submissions")}>
        <X size={15} />
        Close
      </button>
      <header>
        <span className="fm-form-status" data-status={data.status === "new" ? "published" : data.status === "filed" ? "filed" : "paused"}>
          <i />
          {capital(data.status)}
        </span>
        <h2>{who(submission)}</h2>
        <p>
          {data.contact.businessName ? `${data.contact.name} · ` : ""}
          {data.formName} · sent {dateLabel(data.submittedAt)} at{" "}
          {new Date(data.submittedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
        </p>
        <div className="fm-reach">
          <a href={`mailto:${data.contact.email}`}>
            <Mail size={14} />
            {data.contact.email}
          </a>
          {data.contact.phone && (
            <a href={`tel:${data.contact.phone.replace(/[^0-9+]/g, "")}`}>
              <Phone size={14} />
              {data.contact.phone}
            </a>
          )}
        </div>
        {data.lines.length > 0 && (
          <div className="fm-chips">
            {data.lines.map((line) => (
              <span key={line.id}>{line.label}</span>
            ))}
          </div>
        )}
      </header>
      {data.status === "new" && canFile && (
        <div className="fm-actions">
          <button type="button" className="agency-button primary" onClick={() => setFiling(true)}>
            <UserRoundPlus size={15} />
            File to an account
          </button>
          <button type="button" className="agency-button quiet" onClick={() => setDismissing(true)}>
            Dismiss
          </button>
        </div>
      )}
      {data.status === "filed" && (
        <p className="fm-outcome">
          <Check size={15} />
          <span>
            Filed to <strong>{account ? account.data.name : "an account"}</strong>
            {filedBy ? ` by ${filedBy}` : ""} on {dateLabel(data.filedAt)}. The answers are a note on the
            account{data.files.length ? " and the files are in its documents" : ""}.
          </span>
          {account && !account.archivedAt && (
            <button type="button" className="agency-button" onClick={() => navigate(`accounts/${account.id}`)}>
              Open account
              <ArrowRight size={14} />
            </button>
          )}
        </p>
      )}
      {data.status === "dismissed" && (
        <p className="fm-outcome" data-tone="quiet">
          <span>
            Dismissed: {data.dismissReason}
          </span>
          {canFile && (
            <button
              type="button"
              className="agency-button"
              disabled={reopen.busy}
              onClick={() =>
                void reopen.run(() => ({
                  id: crypto.randomUUID(),
                  action: "formSubmission.reopen",
                  kind: "formsubmissions",
                  recordId: submission.id,
                  expectedVersion: submission.version,
                  data: {},
                  reason: "",
                }))
              }
            >
              Reopen
            </button>
          )}
        </p>
      )}
      {reopen.error && (
        <p className="agency-form-error" role="alert">
          {reopen.error}
        </p>
      )}
      {data.files.length > 0 && (
        <section className="fm-files">
          <h3>Files</h3>
          <ul>
            {data.files.map((file) => (
              <li key={file.id}>
                <FileText size={16} aria-hidden="true" />
                <span>
                  {file.name}
                  <small>
                    {file.label} · {Math.max(1, Math.round(file.bytes / 1024)).toLocaleString("en-US")} KB
                  </small>
                </span>
                <a
                  className="agency-button quiet"
                  href={`/api/agency/form-submissions/${submission.id}/files/${file.id}`}
                  aria-label={`Download ${file.name}`}
                >
                  <Download size={14} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.sections.map((section) => (
        <section key={section.id} className="fm-answers">
          <h3>{section.title}</h3>
          {section.items.map((item, index) => (
            <dl key={index}>
              {section.noun && (
                <div className="fm-item-title">
                  <dt>
                    {capital(section.noun)} {index + 1}
                  </dt>
                  <dd>{item.title}</dd>
                </div>
              )}
              {item.answers.map((answer) => (
                <div key={answer.id}>
                  <dt>{answer.label}</dt>
                  <dd>{amsFormValueText(answer.value, answer.type)}</dd>
                </div>
              ))}
            </dl>
          ))}
        </section>
      ))}
      {filing && (
        <FileDialog
          submission={submission}
          book={book}
          saved={savedHere}
          close={() => setFiling(false)}
        />
      )}
      {dismissing && (
        <DismissDialog
          submission={submission}
          saved={savedHere}
          close={() => setDismissing(false)}
        />
      )}
    </article>
  );
}

function FileDialog({
  submission,
  book,
  saved,
  close,
}: {
  submission: SubmissionRecord;
  book: Book;
  saved: (records: AmsRecord[]) => void;
  close: () => void;
}) {
  const { contact, sections, files } = submission.data;
  const matches = useMemo(() => matchingAccounts(book, submission), [book, submission]);
  const commercial = Boolean(contact.businessName);
  const [target, setTarget] = useState<string>(
    matches[0]?.strong ? matches[0].account.id : "new",
  );
  const [name, setName] = useState(contact.businessName || contact.name);
  const [type, setType] = useState<"business" | "person">(commercial ? "business" : "person");
  const [query, setQuery] = useState("");
  const knownContact = (accountId: string) =>
    ((book.contacts || []) as AmsRecord<"contacts">[]).some(
      (record) =>
        record.data.accountId === accountId &&
        record.data.email.toLowerCase() === contact.email.toLowerCase(),
    );
  const [contactChoice, setContactChoice] = useState<boolean | null>(null);
  const [exposures, setExposures] = useState(true);
  const mutation = useAccountCommand((records) => {
    saved(records);
    close();
  });
  const exposureText = exposureSummary(submission);
  const createContact = contactChoice ?? (target === "new" || !knownContact(target));
  const found = query.trim()
    ? ((book.accounts || []) as AmsRecord<"accounts">[])
        .filter(
          (account) =>
            !account.data.consolidation &&
            !matches.some((match) => match.account.id === account.id) &&
            account.data.name.toLowerCase().includes(query.trim().toLowerCase()),
        )
        .slice(0, 5)
    : [];
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.busy && close()}>
      <DialogContent className="agency-dialog fm-dialog">
        <DialogHeader>
          <DialogTitle>File {who(submission)} to an account</DialogTitle>
          <DialogDescription>
            Nothing is added to your book until you file. Choose where this belongs.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void mutation.run(() => ({
              id: crypto.randomUUID(),
              action: "formSubmission.file",
              kind: "formsubmissions",
              recordId: submission.id,
              expectedVersion: submission.version,
              data: {
                ...(target === "new"
                  ? { account: { name: name.trim(), type } }
                  : { accountId: target }),
                createContact,
                createExposures: exposures,
              },
              reason: "",
            }));
          }}
        >
          <fieldset disabled={mutation.busy || mutation.uncertain} className="fm-targets">
            {matches.map(({ account, reason }) => (
              <label key={account.id} data-on={target === account.id || undefined}>
                <input type="radio" name="target" checked={target === account.id} onChange={() => setTarget(account.id)} />
                <span>
                  <strong>{account.data.name}</strong>
                  <small>
                    Existing {account.data.status === "prospect" ? "prospect" : "account"} · {reason}
                  </small>
                </span>
              </label>
            ))}
            {found.map((account) => (
              <label key={account.id} data-on={target === account.id || undefined}>
                <input type="radio" name="target" checked={target === account.id} onChange={() => setTarget(account.id)} />
                <span>
                  <strong>{account.data.name}</strong>
                  <small>Existing {account.data.status === "prospect" ? "prospect" : "account"}</small>
                </span>
              </label>
            ))}
            <label data-on={target === "new" || undefined}>
              <input type="radio" name="target" checked={target === "new"} onChange={() => setTarget("new")} />
              <span>
                <strong>Create a new prospect</strong>
                <small>With the name, email, phone and address from the form</small>
              </span>
            </label>
            {target === "new" && (
              <div className="fm-new-account">
                <label className="agency-field">
                  <span>Account name</span>
                  <input required maxLength={500} value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <label className="agency-field">
                  <span>Type</span>
                  <select value={type} onChange={(event) => setType(event.target.value as "business" | "person")}>
                    <option value="person">Person or household</option>
                    <option value="business">Business</option>
                  </select>
                </label>
              </div>
            )}
            <label className="fm-search">
              <Search size={14} />
              <input
                aria-label="Find another account"
                placeholder="Find another account by name"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </fieldset>
          <div className="fm-adds">
            <h3>Filing adds</h3>
            <label>
              <input type="checkbox" checked={createContact} onChange={(event) => setContactChoice(event.target.checked)} />
              {contact.name} as a contact
              {target !== "new" && knownContact(target) && <small>Already a contact on this account</small>}
            </label>
            {exposureText && (
              <label>
                <input type="checkbox" checked={exposures} onChange={(event) => setExposures(event.target.checked)} />
                {capital(exposureText)} to the account&apos;s exposures
              </label>
            )}
            <p>
              <Check size={14} />
              The answers as a note on the account
            </p>
            {files.length > 0 && (
              <p>
                <Check size={14} />
                {files.length} {files.length === 1 ? "file" : "files"} to its documents
              </p>
            )}
            <p>
              <Check size={14} />
              The follow-up task moves onto the account
            </p>
          </div>
          {mutation.error && (
            <p className="agency-form-error" role="alert">
              {mutation.error}
            </p>
          )}
          <div className="fm-dialog-actions">
            {mutation.uncertain ? (
              <button type="button" className="agency-button primary" disabled={mutation.busy} onClick={() => void mutation.retry()}>
                Retry the same filing
              </button>
            ) : (
              <button type="submit" className="agency-button primary" disabled={mutation.busy || (target === "new" && !name.trim())}>
                {mutation.busy ? "Filing…" : target === "new" ? "Create prospect and file" : "File to this account"}
              </button>
            )}
            <button type="button" className="agency-button" disabled={mutation.busy} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DismissDialog({
  submission,
  saved,
  close,
}: {
  submission: SubmissionRecord;
  saved: (records: AmsRecord[]) => void;
  close: () => void;
}) {
  const [reason, setReason] = useState("");
  const mutation = useAccountCommand((records) => {
    saved(records);
    close();
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.busy && close()}>
      <DialogContent className="agency-dialog fm-dialog">
        <DialogHeader>
          <DialogTitle>Dismiss this submission?</DialogTitle>
          <DialogDescription>
            It stays here under Dismissed with your reason, and its follow-up task is closed. Nothing is added to your book.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void mutation.run(() => ({
              id: crypto.randomUUID(),
              action: "formSubmission.dismiss",
              kind: "formsubmissions",
              recordId: submission.id,
              expectedVersion: submission.version,
              data: {},
              reason: reason.trim(),
            }));
          }}
        >
          <div className="fm-reasons">
            {["Duplicate of another request", "Not something we write", "Spam or a test"].map((option) => (
              <button key={option} type="button" aria-pressed={reason === option} onClick={() => setReason(option)}>
                {option}
              </button>
            ))}
          </div>
          <label className="agency-field">
            <span>Reason</span>
            <input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          {mutation.error && (
            <p className="agency-form-error" role="alert">
              {mutation.error}
            </p>
          )}
          <div className="fm-dialog-actions">
            <button type="submit" className="agency-button primary" disabled={mutation.busy || !reason.trim()}>
              {mutation.busy ? "Dismissing…" : "Dismiss submission"}
            </button>
            <button type="button" className="agency-button" disabled={mutation.busy} onClick={close}>
              Keep it
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
