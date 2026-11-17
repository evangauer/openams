"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  ArrowDownToLine,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  Circle,
  Coins,
  FileText,
  History,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Search,
  ShieldCheck,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AmsAudit, AmsPage } from "@openams/contracts";
import type { EditIntent } from "./editor";
import { actionLabels } from "./fields";
import {
  accountAttention,
  accountBook,
  accountRecordKinds,
  accountStatus,
  accountSummary,
  accountWebsiteHref,
  searchAccount,
  type AccountAttention,
} from "./account-model";
import { AccountWorkflowLauncher } from "./account-workflows";
import { AccountProfile } from "./account-profile";
import { AccountCorrespondence } from "./account-correspondence";
import { ReminderQueue } from "./task-follow-up";
import { AccountRelay } from "./account-relay";
import { useAccountCommand } from "./account-command";
import { useAccountDraft } from "./account-drafts";
import {
  RelayAccountMark,
  RelayAskButton,
  RelayContactChips,
  RelayPolicies,
} from "./themes/relay-account";
import {
  dateLabel,
  human,
  money,
  recordTitle,
  recordAccount,
  request,
  singular,
  titles,
  today,
  type AgencySession,
  type AmsKind,
  type AmsRecord,
  type Book,
} from "./model";

type Props = {
  account: AmsRecord<"accounts">;
  book: Book;
  session: AgencySession;
  edit: (intent: EditIntent) => void;
  open: (record: AmsRecord) => void;
  saved: (records: AmsRecord[]) => void;
  archive: (kind: AmsKind) => void;
};
const dataOf = (record: AmsRecord) => record.data as Record<string, unknown>;
/** The account's Add menu, most-used first. */
const addGroups: { label: string; kinds: AmsKind[] }[] = [
  { label: "Work", kinds: ["tasks", "services", "notes"] },
  {
    label: "Coverage",
    kinds: ["policies", "renewals", "exposures", "claims", "certificates"],
  },
  { label: "People and files", kinds: ["contacts", "documents"] },
  { label: "Billing", kinds: ["invoices", "commissions"] },
];
type AccountTab = "overview" | "policies" | "activity" | "files" | "details";
const closedStatuses = [
  "done",
  "completed",
  "closed",
  "issued",
  "void",
  "renewed",
  "lost",
  "applied",
  "withdrawn",
];
const openRecords = (records: AmsRecord[], date: string) =>
  records.filter(
    (record) => !closedStatuses.includes(accountStatus(record, date)),
  );
const memberName = (session: AgencySession, id: string | null) =>
  session.members.find((member) => member.id === id)?.name || "Unassigned";
const addressLabel = (address: AmsRecord<"accounts">["data"]["address"]) =>
  [
    address.line1,
    address.line2,
    [address.city, address.state].filter(Boolean).join(", "),
    address.postalCode,
  ]
    .filter(Boolean)
    .join(" · ");

export function AccountWorkspace({
  account,
  book,
  session,
  edit,
  open,
  saved,
  archive,
}: Props) {
  const scoped = useMemo(
    () => accountBook(book, account.id, session.readableKinds),
    [book, account.id, session.readableKinds],
  );
  const date = today(session.timeZone);
  const attention = accountAttention(scoped, date);
  const summary = accountSummary(scoped, date);
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [kind, setKind] = useState<AmsKind | "all">("all");
  const [completed, setCompleted] = useState<AmsRecord<"tasks"> | null>(null);
  const searching = Boolean(query.trim()) || browsing;
  const kinds = accountRecordKinds.filter((value) =>
    session.readableKinds.includes(value),
  );
  const createKinds = kinds.filter(
    (value) =>
      session.writableKinds.includes(value) &&
      ![
        "policychanges",
        "payments",
        "journals",
        "reminders",
        "correspondence",
      ].includes(value),
  );
  const create = (value: AmsKind) =>
    edit({ kind: value, accountId: account.id });
  const browse = (value: AmsKind | "all") => {
    setQuery("");
    setKind(value);
    setBrowsing(true);
  };
  const d = account.data;
  const website = accountWebsiteHref(d.website);
  const [tab, setTab] = useState<AccountTab>("overview");
  const showTab = (next: AccountTab) => {
    setQuery("");
    setBrowsing(false);
    setKind("all");
    setTab(next);
  };
  const accountTabs: { id: AccountTab; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    ...(session.readableKinds.includes("policies")
      ? [
          {
            id: "policies" as const,
            label: "Policies",
            count: scoped.policies?.length || 0,
          },
        ]
      : []),
    { id: "activity", label: "Activity" },
    ...(session.readableKinds.includes("documents")
      ? [
          {
            id: "files" as const,
            label: "Files",
            count: scoped.documents?.length || 0,
          },
        ]
      : []),
    { id: "details", label: "Details" },
  ];
  // Renewals, requests, claims, certificates and endorsements. The overview shows only
  // the ones with something open; the Policies tab shows them all, with a way to add.
  const workKinds = (
    [
      "renewals",
      "services",
      "claims",
      "certificates",
      "policychanges",
    ] as AmsKind[]
  ).filter((value) => session.readableKinds.includes(value));
  const openWork = workKinds.filter(
    (value) => openRecords(scoped[value] || [], date).length > 0,
  );
  const related = (value: AmsKind) => (
    <RelatedSummary
      key={value}
      kind={value}
      book={scoped}
      date={date}
      browse={() => browse(value)}
      create={createKinds.includes(value) ? () => create(value) : undefined}
    />
  );
  const people = (className: string) =>
    session.readableKinds.includes("contacts") && (
      <div className={className}>
        <People
          records={(scoped.contacts || []) as AmsRecord<"contacts">[]}
          open={open}
          add={
            session.writableKinds.includes("contacts")
              ? () => create("contacts")
              : undefined
          }
        />
      </div>
    );
  const coverage = session.readableKinds.includes("policies") && (
    <Coverage
      records={(scoped.policies || []) as AmsRecord<"policies">[]}
      date={date}
      open={open}
      add={
        session.writableKinds.includes("policies")
          ? () => create("policies")
          : undefined
      }
    />
  );
  const details = (
    <Section
      title="Account details"
      action={
        session.writableKinds.includes("accounts") && (
          <button
            className="account-text-button"
            onClick={() => edit({ kind: "accounts", record: account })}
          >
            <Pencil size={14} />
            Edit
          </button>
        )
      }
    >
      <dl className="account-facts-list">
        <div>
          <dt>Mailing address</dt>
          <dd>{addressLabel(d.address) || "Not recorded"}</dd>
        </div>
        <div>
          <dt>Producer</dt>
          <dd>{memberName(session, d.producerId)}</dd>
        </div>
        <div>
          <dt>Industry</dt>
          <dd>
            {d.industry || "Not recorded"}
            {d.naics && <small>NAICS {d.naics}</small>}
          </dd>
        </div>
        {d.dba && (
          <div>
            <dt>DBA</dt>
            <dd>{d.dba}</dd>
          </div>
        )}
        {d.email && (
          <div>
            <dt>Email</dt>
            <dd>
              <a href={`mailto:${d.email}`}>{d.email}</a>
            </dd>
          </div>
        )}
        {d.phone && (
          <div>
            <dt>Phone</dt>
            <dd>
              <a href={`tel:${d.phone}`}>{d.phone}</a>
            </dd>
          </div>
        )}
        {d.website && (
          <div>
            <dt>Website</dt>
            <dd>
              {website ? (
                <a href={website} target="_blank" rel="noreferrer">
                  {d.website.replace(/^https?:\/\//, "")}
                </a>
              ) : (
                d.website
              )}
            </dd>
          </div>
        )}
        {d.source && (
          <div>
            <dt>Source</dt>
            <dd>{d.source}</dd>
          </div>
        )}
      </dl>
      {d.tags.length > 0 && (
        <div className="account-tags">
          {d.tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      )}
      {d.notes && (
        <details className="account-background">
          <summary>Account background</summary>
          <p>{d.notes}</p>
        </details>
      )}
    </Section>
  );
  return (
    <div className="account-workspace">
      <header className="account-heading">
        <RelayAccountMark />
        <div className="account-identity">
          <div>
            <h1>{d.name}</h1>
            <AccountBadge value={d.status} />
          </div>
          <p>
            {[
              d.legalName && d.legalName !== d.name ? d.legalName : "",
              d.industry,
              [d.address.city, d.address.state].filter(Boolean).join(", "),
            ]
              .filter(Boolean)
              .join(" / ") || "Your client relationship, in one place."}
          </p>
          <RelayContactChips account={account} />
        </div>
        <div className="account-heading-actions">
          <RelayAskButton account={account} session={session} />
          {session.writableKinds.includes("accounts") && (
            <button
              className="agency-button quiet"
              onClick={() => edit({ kind: "accounts", record: account })}
            >
              <Pencil size={15} />
              Edit account
            </button>
          )}
          {createKinds.length > 0 && (
            <Menu.Root>
              <Menu.Trigger asChild>
                <button className="agency-button primary">
                  <Plus size={16} />
                  Add
                  <ChevronDown size={15} />
                </button>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content
                  className="account-add-menu"
                  align="end"
                  sideOffset={8}
                >
                  {addGroups
                    .map((group) => ({
                      ...group,
                      kinds: group.kinds.filter((value) =>
                        createKinds.includes(value),
                      ),
                    }))
                    .filter((group) => group.kinds.length)
                    .map((group, index) => (
                      <Menu.Group key={group.label}>
                        {index > 0 && <Menu.Separator />}
                        <Menu.Label>{group.label}</Menu.Label>
                        {group.kinds.map((value) => (
                          <Menu.Item key={value} onSelect={() => create(value)}>
                            {value === "documents"
                              ? "Upload document"
                              : human(singular[value])}
                          </Menu.Item>
                        ))}
                      </Menu.Group>
                    ))}
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          )}
        </div>
      </header>
      <div className="account-fact-band" aria-label="Account summary">
        <span>
          <ShieldCheck size={18} />
          <strong>{summary.activeCount}</strong> active{" "}
          {summary.activeCount === 1 ? "policy" : "policies"}
        </span>
        <span title="Premium for active policy terms; excludes taxes and fees. Not an annualized total.">
          <Coins size={18} />
          <strong>{money(summary.premiumCents)}</strong> term premium
        </span>
        <span>
          <CalendarDays size={18} />
          {summary.nextExpiration ? (
            <>
              Next expiration{" "}
              <strong>{dateLabel(summary.nextExpiration)}</strong>
            </>
          ) : (
            "No upcoming expiration"
          )}
        </span>
        <span>
          <UserRound size={18} />
          <span>
            <strong>{memberName(session, d.serviceOwnerId)}</strong>
            <small>Account manager</small>
          </span>
        </span>
      </div>
      <div className="account-tabbar">
        <div
          className="account-tabs"
          role="tablist"
          aria-label="Account sections"
          onKeyDown={(event) => {
            const ids = accountTabs.map((item) => item.id);
            const index = ids.indexOf(tab);
            const next =
              event.key === "ArrowRight"
                ? ids[(index + 1) % ids.length]
                : event.key === "ArrowLeft"
                  ? ids[(index - 1 + ids.length) % ids.length]
                  : event.key === "Home"
                    ? ids[0]
                    : event.key === "End"
                      ? ids[ids.length - 1]
                      : null;
            if (!next) return;
            event.preventDefault();
            showTab(next);
            document.getElementById(`account-tab-${next}`)?.focus();
          }}
        >
          {accountTabs.map((item) => (
            <button
              key={item.id}
              id={`account-tab-${item.id}`}
              role="tab"
              aria-selected={!searching && tab === item.id}
              aria-controls="account-tab-panel"
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => showTab(item.id)}
            >
              {item.label}
              {item.count !== undefined && item.count > 0 && (
                <span>{item.count}</span>
              )}
            </button>
          ))}
        </div>
        <div className="account-search-bar">
          <label className="agency-search">
            <Search size={18} />
            <input
              aria-label="Search this account"
              placeholder="Search this account…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setKind("all");
              }}
            />
            {query && (
              <button
                className="agency-icon-button"
                aria-label="Clear account search"
                onClick={() => setQuery("")}
              >
                <X size={15} />
              </button>
            )}
          </label>
          <button
            className="account-text-button"
            onClick={() =>
              searching
                ? (setQuery(""), setBrowsing(false), setKind("all"))
                : browse("all")
            }
          >
            {searching ? "Close search" : "All records"}
          </button>
        </div>
      </div>
      <div
        id="account-tab-panel"
        role="tabpanel"
        aria-labelledby={`account-tab-${tab}`}
        className="account-tab-panel"
      >
        {searching ? (
          <AccountSearch
            archive={archive}
            key={`${query}:${kind}`}
            book={scoped}
            query={query}
            kind={kind}
            setKind={setKind}
            kinds={kinds}
            open={open}
            date={date}
          />
        ) : tab === "overview" ? (
          <div className="account-layout">
            <div className="account-main-column">
              <Section
                title="Next up"
                count={attention.length}
                action={
                  session.writableKinds.includes("tasks") && (
                    <div className="account-profile-actions">
                      {session.writableKinds.includes("accounts") && (
                        <AccountWorkflowLauncher
                          account={account}
                          session={session}
                          saved={saved}
                        />
                      )}
                      <AddButton
                        label="Add task"
                        onClick={() => create("tasks")}
                      />
                    </div>
                  )
                }
              >
                {completed && (
                  <TaskUndo
                    task={completed}
                    saved={saved}
                    dismiss={() => setCompleted(null)}
                  />
                )}
                <AttentionList
                  items={attention}
                  session={session}
                  date={date}
                  open={open}
                  saved={(records) => {
                    saved(records);
                    const task = records.find(
                      (record) =>
                        record.kind === "tasks" &&
                        (record as AmsRecord<"tasks">).data.status === "done",
                    );
                    if (task) setCompleted(task as AmsRecord<"tasks">);
                  }}
                />
              </Section>
              {people("account-mobile-people")}
              {session.readableKinds.includes("policies") && (
                <RelayPolicies
                  records={(scoped.policies || []) as AmsRecord<"policies">[]}
                  renewals={scoped.renewals || []}
                  date={date}
                  open={open}
                  add={
                    session.writableKinds.includes("policies")
                      ? () => create("policies")
                      : undefined
                  }
                />
              )}
              {coverage}
              {openWork.length > 0 && (
                <div className="account-related-grid">
                  {openWork.map((value) => related(value))}
                </div>
              )}
              <AccountActivity
                account={account}
                book={scoped}
                session={session}
                saved={saved}
                open={open}
                compact
                showAll={() => showTab("activity")}
              />
            </div>
            <aside className="account-context-column" aria-label="Account context">
              {people("account-desktop-people")}
              {details}
            </aside>
          </div>
        ) : tab === "policies" ? (
          <div className="account-layout">
            <div className="account-main-column">
              {coverage}
              <div className="account-related-grid">
                {workKinds.map((value) => related(value))}
              </div>
              {session.readableKinds.includes("commissions") && (
                <Section
                  title="Financials"
                  action={
                    <button
                      className="account-text-button"
                      onClick={() => browse("commissions")}
                    >
                      View commissions
                      <ArrowRight size={14} />
                    </button>
                  }
                >
                  <div className="account-finance-summary">
                    {(
                      [
                        "commissions",
                        "invoices",
                        "payments",
                        "journals",
                      ] as AmsKind[]
                    )
                      .filter((value) => session.readableKinds.includes(value))
                      .map((value) => (
                        <button key={value} onClick={() => browse(value)}>
                          <strong>{scoped[value]?.length || 0}</strong>
                          {titles[value]}
                          <ArrowRight size={14} />
                        </button>
                      ))}
                  </div>
                </Section>
              )}
            </div>
            <aside className="account-context-column" aria-label="What is insured">
              {session.readableKinds.includes("exposures") && (
                <Exposures
                  records={(scoped.exposures || []) as AmsRecord<"exposures">[]}
                  open={open}
                  add={
                    session.writableKinds.includes("exposures")
                      ? () => create("exposures")
                      : undefined
                  }
                />
              )}
            </aside>
          </div>
        ) : tab === "activity" ? (
          <div className="account-single-column">
            <AccountActivity
              account={account}
              book={scoped}
              session={session}
              saved={saved}
              open={open}
            />
            <AccountCorrespondence
              account={account}
              book={book}
              session={session}
              saved={saved}
              open={open}
            />
            <ReminderQueue
              accountId={account.id}
              book={book}
              session={session}
              saved={saved}
              open={open}
            />
            {session.relayWorkspaceEnabled && (
              <AccountRelay
                account={account}
                saved={saved}
                accountId={account.id}
                book={book}
                session={session}
              />
            )}
          </div>
        ) : tab === "files" ? (
          <div className="account-single-column">
            {session.readableKinds.includes("documents") && (
              <Files
                records={(scoped.documents || []) as AmsRecord<"documents">[]}
                open={open}
                initial={20}
                add={
                  session.writableKinds.includes("documents")
                    ? () => create("documents")
                    : undefined
                }
              />
            )}
          </div>
        ) : (
          <div className="account-layout">
            <div className="account-main-column">
              <AccountProfile
                account={account}
                book={book}
                session={session}
                saved={saved}
                edit={edit}
              />
            </div>
            <aside className="account-context-column" aria-label="Account context">
              {details}
              {people("account-details-people")}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="account-section" aria-label={title}>
      <div className="account-section-heading">
        <h2>
          {title}
          {count !== undefined && (
            <span className="account-count">{count}</span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="account-text-button" onClick={onClick}>
      <Plus size={15} />
      {label}
    </button>
  );
}
export function AccountBadge({ value }: { value: string }) {
  return (
    <span
      className={`account-badge ${["active", "done", "completed", "issued", "renewed", "reconciled"].includes(value) ? "positive" : ["cancelled", "nonrenewed", "notice", "waiting", "lost"].includes(value) ? "attention" : ""}`}
    >
      {human(value)}
    </span>
  );
}
function More({
  total,
  visible,
  setVisible,
}: {
  total: number;
  visible: number;
  setVisible: (count: number) => void;
}) {
  return total > visible ? (
    <button
      className="account-show-more"
      onClick={() => setVisible(visible + 10)}
    >
      Show more · {total - visible} remaining
      <ChevronDown size={14} />
    </button>
  ) : null;
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="account-empty">{children}</p>;
}

function AttentionList({
  items,
  session,
  date,
  open,
  saved,
}: {
  items: AccountAttention[];
  session: AgencySession;
  date: string;
  open: Props["open"];
  saved: Props["saved"];
}) {
  const [visible, setVisible] = useState(5);
  return (
    <>
      {items.length ? (
        <ul className="account-attention-list">
          {items.slice(0, visible).map((item) => (
            <li key={`${item.record.kind}:${item.record.id}`}>
              {item.record.kind === "tasks" &&
              session.writableKinds.includes("tasks") ? (
                <TaskComplete
                  task={item.record as AmsRecord<"tasks">}
                  saved={saved}
                />
              ) : (
                <span className="account-row-symbol">
                  {item.urgent ? (
                    <ShieldCheck size={17} />
                  ) : (
                    <ArrowRight size={16} />
                  )}
                </span>
              )}
              <button
                className="account-attention-open"
                onClick={() => open(item.record)}
                aria-label={`Open ${item.title}`}
              >
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </span>
                <span
                  className={`account-due ${item.date && item.date <= date ? "due-now" : ""}`}
                >
                  {item.date
                    ? item.date < date
                      ? `Overdue · ${dateLabel(item.date)}`
                      : item.date === date
                        ? "Due today"
                        : dateLabel(item.date)
                    : "No follow-up date"}
                </span>
                <span className="account-row-owner">
                  {memberName(session, item.ownerId)}
                </span>
                <ArrowRight size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No open follow-ups or expirations needing attention.</Empty>
      )}
      <More total={items.length} visible={visible} setVisible={setVisible} />
    </>
  );
}

function SaveProblem({
  error,
  uncertain,
  busy,
  retry,
}: {
  error: string;
  uncertain: boolean;
  busy: boolean;
  retry: () => void;
}) {
  if (!error) return null;
  if (!uncertain)
    return (
      <p className="account-command-error" role="alert">
        {error}
      </p>
    );
  return (
    <Dialog open>
      <DialogContent
        className="agency-dialog"
        showClose={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Confirm the saved result</DialogTitle>
          <DialogDescription>
            The connection was interrupted. Check the original save before
            continuing so it cannot be submitted twice.
          </DialogDescription>
        </DialogHeader>
        <div className="account-save-recovery">
          <p role="alert">{error}</p>
          <button
            className="agency-button primary"
            disabled={busy}
            onClick={retry}
          >
            {busy && <Loader2 size={15} className="agency-spin" />}Retry
            original save
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
function TaskComplete({
  task,
  saved,
}: {
  task: AmsRecord<"tasks">;
  saved: Props["saved"];
}) {
  const mutation = useAccountCommand(saved);
  const complete = () =>
    void mutation.run(() => ({
      id: crypto.randomUUID(),
      action: "task.complete",
      kind: "tasks",
      recordId: task.id,
      expectedVersion: task.version,
      data: {},
      reason: "",
    }));
  return (
    <div className="account-task-complete">
      <button
        className="account-complete-button"
        aria-label={`Complete ${task.data.title}`}
        title="Complete task"
        disabled={mutation.busy}
        onClick={complete}
      >
        {mutation.busy ? (
          <Loader2 size={21} className="agency-spin" />
        ) : (
          <>
            <Circle size={21} />
            <Check size={13} />
          </>
        )}
      </button>
      <SaveProblem {...mutation} retry={complete} />
    </div>
  );
}
function TaskUndo({
  task,
  saved,
  dismiss,
}: {
  task: AmsRecord<"tasks">;
  saved: Props["saved"];
  dismiss: () => void;
}) {
  const mutation = useAccountCommand((records) => {
    saved(records);
    dismiss();
  });
  const undo = () =>
    void mutation.run(() => ({
      id: crypto.randomUUID(),
      action: "task.reopen",
      kind: "tasks",
      recordId: task.id,
      expectedVersion: task.version,
      data: {},
      reason: "Undid task completion from the account overview.",
    }));
  return (
    <div className="account-task-undo" role="status">
      <Check size={15} />
      <span>Completed {task.data.title}</span>
      {task.data.nextTaskId ? (
        <span>Next follow-up created.</span>
      ) : (
        <button disabled={mutation.busy} onClick={undo}>
          Undo
        </button>
      )}
      <button aria-label="Dismiss task completion" onClick={dismiss}>
        <X size={14} />
      </button>
      <SaveProblem {...mutation} retry={undo} />
    </div>
  );
}

function Coverage({
  records,
  date,
  open,
  add,
}: {
  records: AmsRecord<"policies">[];
  date: string;
  open: Props["open"];
  add?: () => void;
}) {
  const [filter, setFilter] = useState("current");
  const [visible, setVisible] = useState(5);
  const policies = records
    .filter(
      (record) =>
        filter === "all" ||
        ["active", "scheduled", "draft"].includes(accountStatus(record, date)),
    )
    .sort(
      (a, b) =>
        a.data.expirationDate.localeCompare(b.data.expirationDate) ||
        a.data.line.localeCompare(b.data.line),
    );
  return (
    <Section
      title="Coverage"
      action={
        <div className="account-section-actions">
          <select
            aria-label="Coverage terms"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setVisible(5);
            }}
          >
            <option value="current">Current & draft terms</option>
            <option value="all">All terms · {records.length}</option>
          </select>
          {add && (
            <button className="agency-button" onClick={add}>
              Add policy
            </button>
          )}
        </div>
      }
    >
      {policies.length ? (
        <div
          className="account-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Policy coverage table"
        >
          <table className="account-coverage-table">
            <thead>
              <tr>
                <th>Coverage / policy #</th>
                <th>Carrier</th>
                <th>Term</th>
                <th>Term premium</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {policies.slice(0, visible).map((record) => (
                <tr key={record.id}>
                  <td>
                    <button
                      onClick={() => open(record)}
                      aria-label={`Open ${record.data.number}`}
                    >
                      <strong>{record.data.line}</strong>
                      <small>{record.data.number}</small>
                    </button>
                  </td>
                  <td>
                    {record.data.carrier}
                    <small>
                      {record.data.billing === "direct"
                        ? "Direct bill"
                        : "Agency bill"}
                    </small>
                  </td>
                  <td>
                    {dateLabel(record.data.effectiveDate)}
                    <small>to {dateLabel(record.data.expirationDate)}</small>
                  </td>
                  <td className="account-money">
                    {money(record.data.premiumCents)}
                  </td>
                  <td>
                    <AccountBadge value={accountStatus(record, date)} />
                    {record.data.nonrenewal && (
                      <small className="account-policy-warning">
                        Nonrenewal notice
                      </small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>
          {records.length
            ? "No current or draft terms. Select All terms to see the policy history."
            : "No policy terms yet. Add the policy and its carrier evidence to start a coverage record."}
        </Empty>
      )}
      <More total={policies.length} visible={visible} setVisible={setVisible} />
    </Section>
  );
}

function People({
  records,
  open,
  add,
}: {
  records: AmsRecord<"contacts">[];
  open: Props["open"];
  add?: () => void;
}) {
  const [visible, setVisible] = useState(3);
  const contacts = [...records].sort(
    (a, b) =>
      Number(b.data.primary) - Number(a.data.primary) ||
      a.data.name.localeCompare(b.data.name),
  );
  return (
    <Section title="People" count={records.length}>
      {contacts.length ? (
        <ul className="account-people">
          {contacts.slice(0, visible).map((record) => (
            <li key={record.id}>
              <UserRound size={19} />
              <div>
                <button
                  className="account-person-name"
                  aria-label={`Open ${record.data.name}`}
                  onClick={() => open(record)}
                >
                  {record.data.name}
                </button>
                {record.data.primary && (
                  <span className="account-primary-label">Primary</span>
                )}
                <p>{record.data.title || "Contact"}</p>
                {record.data.email && (
                  <a href={`mailto:${record.data.email}`}>
                    <Mail size={13} />
                    {record.data.email}
                  </a>
                )}
                {record.data.phone && (
                  <a href={`tel:${record.data.phone}`}>
                    <Phone size={13} />
                    {record.data.phone}
                  </a>
                )}
                {record.data.mobile &&
                  record.data.mobile !== record.data.phone && (
                    <a href={`tel:${record.data.mobile}`}>
                      <Phone size={13} />
                      {record.data.mobile} · Mobile
                    </a>
                  )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Add the people you work with at this account.</Empty>
      )}
      <More total={contacts.length} visible={visible} setVisible={setVisible} />
      {add && (
        <div className="account-section-footer">
          <AddButton label="Add contact" onClick={add} />
        </div>
      )}
    </Section>
  );
}
function Files({
  records,
  open,
  add,
  initial = 3,
}: {
  records: AmsRecord<"documents">[];
  open: Props["open"];
  add?: () => void;
  initial?: number;
}) {
  const [visible, setVisible] = useState(initial);
  const files = [...records].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const superseded = new Set(
    records.flatMap((record) =>
      record.data.supersedesId ? [record.data.supersedesId] : [],
    ),
  );
  return (
    <Section
      title="Files"
      count={records.length}
      action={
        add && (
          <button className="account-text-button" onClick={add}>
            <Upload size={14} />
            Upload
          </button>
        )
      }
    >
      {files.length ? (
        <ul className="account-file-list">
          {files.slice(0, visible).map((record) => (
            <li key={record.id}>
              <FileText size={21} />
              <button
                onClick={() => open(record)}
                aria-label={`Open ${record.data.name}`}
              >
                <strong>{record.data.name}</strong>
                <small>
                  {Math.max(1, Math.round(record.data.bytes / 1024))} KB ·{" "}
                  {superseded.has(record.id)
                    ? "Superseded"
                    : human(record.data.category)}
                </small>
              </button>
              <a
                href={`/api/agency/documents/${record.id}/content`}
                download
                aria-label={`Download ${record.data.name}`}
                className="agency-icon-button"
              >
                <ArrowDownToLine size={17} />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          Keep policy documents, applications, and correspondence with this
          account.
        </Empty>
      )}
      <More total={files.length} visible={visible} setVisible={setVisible} />
    </Section>
  );
}
function Exposures({
  records,
  open,
  add,
}: {
  records: AmsRecord<"exposures">[];
  open: Props["open"];
  add?: () => void;
}) {
  const [visible, setVisible] = useState(3);
  return (
    <Section
      title="Locations & exposures"
      count={records.length}
      action={add && <AddButton label="Add exposure" onClick={add} />}
    >
      {records.length ? (
        <ul className="account-exposure-list">
          {records.slice(0, visible).map((record) => (
            <li key={record.id}>
              <MapPin size={18} />
              <button onClick={() => open(record)}>
                <strong>{record.data.name}</strong>
                <small>
                  {addressLabel(record.data.address) || human(record.data.kind)}
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          Locations, vehicles, payroll, and other insured exposures.
        </Empty>
      )}
      <More total={records.length} visible={visible} setVisible={setVisible} />
    </Section>
  );
}

function NoteComposer({
  accountId,
  saved,
}: {
  accountId: string;
  saved: Props["saved"];
}) {
  const { body, setBody, category, setCategory } = useAccountDraft(accountId);
  const input = useRef<HTMLTextAreaElement>(null);
  const mutation = useAccountCommand(saved);
  const submit = async () => {
    if (!body.trim()) return;
    if (
      await mutation.run(() => ({
        id: crypto.randomUUID(),
        action: "create",
        kind: "notes",
        data: {
          accountId,
          body: body.trim(),
          category,
          occurredAt: new Date().toISOString(),
        },
        reason: "",
      }))
    ) {
      setBody("");
      input.current?.focus();
    }
  };
  return (
    <form
      className="account-note-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={input}
        aria-label="Activity note"
        placeholder="Add a note or log a call…"
        maxLength={20000}
        rows={2}
        value={body}
        disabled={mutation.busy || mutation.uncertain}
        onChange={(event) => setBody(event.target.value)}
      />
      <div>
        <span>
          {body.length
            ? `${body.length.toLocaleString()} / 20,000`
            : "Saved with your name and time"}
        </span>
        <select
          aria-label="Activity type"
          value={category}
          disabled={mutation.busy || mutation.uncertain}
          onChange={(event) => setCategory(event.target.value)}
        >
          {["note", "call", "meeting", "email", "review"].map((value) => (
            <option key={value} value={value}>
              {human(value)}
            </option>
          ))}
        </select>
        <button
          className="agency-button primary"
          disabled={mutation.busy || !body.trim()}
        >
          {mutation.busy ? (
            <Loader2 size={15} className="agency-spin" />
          ) : (
            <Plus size={15} />
          )}
          {category === "call" ? "Log call" : "Add note"}
        </button>
      </div>
      <SaveProblem {...mutation} retry={() => void submit()} />
    </form>
  );
}
function AccountActivity({
  account,
  book,
  session,
  saved,
  open,
  compact = false,
  showAll,
}: {
  account: AmsRecord<"accounts">;
  book: Book;
  session: AgencySession;
  saved: Props["saved"];
  open: Props["open"];
  /** The overview's short form: the latest few entries and a link to the Activity tab. */
  compact?: boolean;
  showAll?: () => void;
}) {
  const pageSize = compact ? 3 : 10;
  const [events, setEvents] = useState<AmsAudit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState("");
  const activeLoad = useRef<AbortController | null>(null);
  const recordMap = useMemo(
    () =>
      new Map(
        [account, ...Object.values(book).flat()].map((record) => [
          `${record.kind}:${record.id}`,
          record,
        ]),
      ),
    [account, book],
  );
  useEffect(() => {
    const abort = new AbortController();
    activeLoad.current = abort;
    request<AmsPage<AmsAudit>>(
      `audit?accountId=${encodeURIComponent(account.id)}&limit=${pageSize}`,
      { signal: abort.signal },
    )
      .then((page) => {
        if (!abort.signal.aborted) {
          setEvents(page.items);
          setCursor(page.nextCursor);
          setError("");
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Unable to load activity.",
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [account.id, book, retry, pageSize]);
  async function more() {
    const abort = activeLoad.current;
    setBusy(true);
    try {
      const page = await request<AmsPage<AmsAudit>>(
        `audit?accountId=${encodeURIComponent(account.id)}&limit=${pageSize}&before=${encodeURIComponent(cursor!)}`,
        { signal: abort?.signal },
      );
      if (abort?.signal.aborted) return;
      setEvents((previous) => [
        ...new Map(
          [...previous, ...page.items].map((event) => [event.id, event]),
        ).values(),
      ]);
      setCursor(page.nextCursor);
      setError("");
    } catch (failure) {
      if (!abort?.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Unable to load more activity.",
        );
    } finally {
      if (!abort?.signal.aborted) setBusy(false);
    }
  }
  async function openHistorical(ref: AmsAudit["records"][number]) {
    const abort = activeLoad.current;
    setOpening(ref.id);
    setOpenError("");
    try {
      const result = await request<{ record: AmsRecord }>(
        `records/${ref.kind}/${encodeURIComponent(ref.id)}`,
        { signal: abort?.signal },
      );
      if (abort?.signal.aborted) return;
      if (
        ![account.id, ...(account.data.consolidatedAccountIds || [])].includes(
          recordAccount(result.record) || "",
        )
      )
        throw new Error("This record is not available in this account.");
      open(result.record);
    } catch (failure) {
      if (!abort?.signal.aborted)
        setOpenError(
          failure instanceof Error
            ? failure.message
            : "Unable to open the historical record.",
        );
    } finally {
      if (!abort?.signal.aborted) setOpening(null);
    }
  }
  return (
    <Section
      title={compact ? "Recent activity" : "Activity"}
      action={
        compact && showAll ? (
          <button className="account-text-button" onClick={showAll}>
            All activity
            <ArrowRight size={14} />
          </button>
        ) : (
          <span className="account-section-caption">Latest recorded first</span>
        )
      }
    >
      {!compact && session.writableKinds.includes("notes") && (
        <NoteComposer accountId={account.id} saved={saved} />
      )}
      {error && (
        <div className="account-activity-error" role="alert">
          {error}
          <button onClick={() => setRetry((value) => value + 1)}>
            Retry activity
          </button>
        </div>
      )}
      {openError && (
        <p className="account-activity-error" role="alert">
          {openError}
        </p>
      )}
      <ol className="account-timeline">
        {events.map((event) => {
          // Audit commands can affect several accounts. Only resolve titles and note
          // bodies from this account's already-authorized records.
          const records = event.records.flatMap((ref) => {
            const record = recordMap.get(`${ref.kind}:${ref.id}`);
            return record ? [record] : [];
          });
          const note =
            records.length === 1 && records[0].kind === "notes"
              ? (records[0] as AmsRecord<"notes">)
              : null;
          const primary =
            event.action === "correspondence.file"
              ? records.find((record) => record.kind === "correspondence") ||
                records[0]
              : event.action === "task.complete"
                ? records.find(
                    (record) =>
                      record.kind === "tasks" &&
                      (record as AmsRecord<"tasks">).data.status === "done",
                  ) || records[0]
                : records[0];
          const historical =
            !primary &&
            event.records.length === 1 &&
            session.readableKinds.includes(event.records[0].kind)
              ? event.records[0]
              : null;
          const eventLabel =
            (
              {
                create: "Record added",
                update: "Record updated",
                archive: "Record archived",
                restore: "Record restored",
                "policy.issue": "Policy issued",
                "policy.endorse": "Endorsement recorded",
                "task.complete": "Task completed",
                "task.reopen": "Task reopened",
                "task.followUp": "Follow-ups updated",
                "reminder.deliver": "Reminder processed",
                "reminder.snooze": "Reminder snoozed",
                "reminder.dismiss": "Reminder dismissed",
                "reminder.retry": "Reminder retried",
                "correspondence.file": "Email filed",
                "service.complete": "Service request completed",
              } as Record<string, string>
            )[event.action] ||
            actionLabels[event.action] ||
            human(event.action);
          const title = note
            ? note.data.body
            : `${historical ? eventLabel.replace(/^Record/, human(singular[historical.kind])) : eventLabel}${primary ? ` · ${recordTitle(primary)}` : ""}`;
          return (
            <li key={event.id}>
              <span className="account-timeline-icon">
                {note ? (
                  note.data.category === "call" ? (
                    <Phone size={15} />
                  ) : (
                    <FileText size={15} />
                  )
                ) : (
                  <History size={15} />
                )}
              </span>
              <div>
                {records[0] || historical ? (
                  <button
                    className="account-activity-title"
                    aria-disabled={Boolean(opening)}
                    aria-busy={opening === historical?.id}
                    onClick={() => {
                      if (!opening) {
                        if (records[0]) open(records[0]);
                        else void openHistorical(historical!);
                      }
                    }}
                  >
                    {title}
                  </button>
                ) : (
                  <p>{title}</p>
                )}
                <small>
                  {note ? `${human(note.data.category)} · ` : ""}
                  {event.actorName} ·{" "}
                  <time dateTime={event.at}>
                    {new Date(event.at).toLocaleString("en-US", {
                      timeZone: session.timeZone || "UTC",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                </small>
                {note?.data.importOrigin && (
                  <small>
                    Imported from {note.data.importOrigin.source}
                    {note.data.importOrigin.sourceAuthor
                      ? ` · Original author: ${note.data.importOrigin.sourceAuthor}`
                      : ""}{" "}
                    · Occurred {dateLabel(note.data.occurredAt)}
                  </small>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {!events.length && !busy && !error && (
        <Empty>No activity recorded yet.</Empty>
      )}
      {busy && (
        <p className="account-empty" role="status">
          Loading activity…
        </p>
      )}
      {cursor && !compact && (
        <button
          className="account-show-more"
          disabled={busy}
          onClick={() => void more()}
        >
          Show earlier activity
          <ChevronDown size={14} />
        </button>
      )}
    </Section>
  );
}

function RelatedSummary({
  kind,
  book,
  date,
  browse,
  create,
}: {
  kind: AmsKind;
  book: Book;
  date: string;
  browse: () => void;
  create?: () => void;
}) {
  const records = book[kind] || [];
  const openCount = openRecords(records, date).length;
  return (
    <div className="account-related-summary">
      <button onClick={browse}>
        <span>{titles[kind]}</span>
        <strong>
          {openCount} open <small>· {records.length} total</small>
        </strong>
        <ArrowRight size={15} />
      </button>
      {create && (
        <button
          className="agency-icon-button"
          aria-label={`New ${singular[kind]}`}
          onClick={create}
        >
          <Plus size={15} />
        </button>
      )}
    </div>
  );
}
function AccountSearch({
  archive,
  book,
  query,
  kind,
  setKind,
  kinds,
  open,
  date,
}: {
  archive: Props["archive"];
  book: Book;
  query: string;
  kind: AmsKind | "all";
  setKind: (kind: AmsKind | "all") => void;
  kinds: AmsKind[];
  open: Props["open"];
  date: string;
}) {
  const records = searchAccount(book, query, kind);
  const [visible, setVisible] = useState(20);
  return (
    <Section
      title={query ? "Search results" : "All account records"}
      count={records.length}
      action={
        <select
          aria-label="Account record type"
          value={kind}
          onChange={(event) => setKind(event.target.value as AmsKind | "all")}
        >
          <option value="all">All record types</option>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {titles[value]} · {book[value]?.length || 0}
            </option>
          ))}
        </select>
      }
    >
      {records.length ? (
        <ul className="account-search-results">
          {records.slice(0, visible).map((record) => (
            <li key={`${record.kind}:${record.id}`}>
              <button onClick={() => open(record)}>
                <span className="account-result-type">
                  {singular[record.kind]}
                </span>
                <span>
                  <strong>{recordTitle(record)}</strong>
                  <small>
                    {String(
                      dataOf(record).line ||
                        dataOf(record).email ||
                        dataOf(record).category ||
                        "",
                    )}
                  </small>
                </span>
                <AccountBadge value={accountStatus(record, date)} />
                <ArrowRight size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          {query
            ? "No matching records in this account. Try a name, policy number, carrier, or phrase."
            : "No records of this type yet."}
        </Empty>
      )}
      <More total={records.length} visible={visible} setVisible={setVisible} />
      {kind !== "all" && (
        <div className="account-section-footer">
          <button className="account-text-button" onClick={() => archive(kind)}>
            <History size={14} />
            View archived {titles[kind].toLowerCase()}
          </button>
        </div>
      )}
    </Section>
  );
}
