"use client";

/*
 * Broker portal take: small presentational additions that only render when
 * <html data-theme="portal">. Each one reads records the workspace already loaded
 * and reuses the workspace's own handlers, so data flow and behavior are unchanged
 * and every other take renders exactly as before.
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bell,
  Check,
  Mail,
  Menu,
  MessageCircle,
  Phone,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { amsChatDirectThread, amsPolicyStatusAt } from "@openams/contracts";
import { useAgencyTheme } from "../theme";
import { useTeamChat } from "../team-chat";
import { sameAccount } from "../account-identity-model";
import type { EditIntent } from "../editor";
import {
  dateLabel,
  human,
  recordAccount,
  recordTitle,
  titles,
  today,
  type AgencySession,
  type AmsKind,
  type AmsRecord,
  type Book,
} from "../model";

// The brand theme reuses the portal layout with the OpenAMS palette.
const usePortal = () => {
  const theme = useAgencyTheme();
  return theme === "portal" || theme === "brand";
};
const dataOf = (record: AmsRecord) => record.data as Record<string, unknown>;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
const wholeDollars = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) /
      86_400_000,
  );
/** "Due today", "In 3 days", "2 days late", or the date, plus whether it is pressing. */
function dueLabel(due: string, date: string) {
  if (!due) return { text: "No date", soon: false };
  const days = daysBetween(date, due);
  if (days < 0)
    return { text: `${-days} day${days === -1 ? "" : "s"} late`, soon: true };
  if (days === 0) return { text: "Due today", soon: true };
  if (days <= 7)
    return { text: `In ${days} day${days === 1 ? "" : "s"}`, soon: days <= 3 };
  return { text: dateLabel(due), soon: false };
}

/* ----------------------------------------------------------------- shell */

/** Mobile menu toggle. The sidebar becomes a drawer below 780px. */
export function PortalMenuButton() {
  const portal = usePortal();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    if (open) root.dataset.portalNav = "open";
    else delete root.dataset.portalNav;
    return () => {
      delete root.dataset.portalNav;
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      button.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      const drawer = button.current?.closest("aside");
      if (drawer && !drawer.contains(event.target as Node)) close();
    };
    window.addEventListener("hashchange", close);
    window.addEventListener("openams:close-menu", close);
    window.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("hashchange", close);
      window.removeEventListener("openams:close-menu", close);
      window.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  if (!portal) return null;
  return (
    <button
      ref={button}
      type="button"
      className="portal-menu-button"
      aria-expanded={open}
      aria-label={open ? "Close menu" : "Open menu"}
      onClick={() => setOpen((value) => !value)}
    >
      {open ? <X size={20} /> : <Menu size={20} />}
    </button>
  );
}

/** Bell and account chip on the right of the top bar. */
export function PortalTopActions({
  session,
  openTasks,
  showTasks,
  showSettings,
}: {
  session: AgencySession;
  openTasks: number;
  showTasks: () => void;
  showSettings: () => void;
}) {
  const portal = usePortal();
  // Lets the sidebar's task count go quiet at zero; CSS cannot read the number.
  useEffect(() => {
    const root = document.documentElement;
    if (portal) root.dataset.portalTasks = openTasks ? "some" : "none";
    return () => {
      delete root.dataset.portalTasks;
    };
  }, [portal, openTasks]);
  if (!portal) return null;
  const { name, role } = session.actor;
  return (
    <div className="portal-top-actions">
      <button
        type="button"
        className="portal-bell"
        onClick={showTasks}
        aria-label={
          openTasks
            ? `Tasks: ${openTasks} open`
            : "Tasks: nothing open"
        }
      >
        <Bell size={19} aria-hidden="true" />
        {openTasks > 0 && <i aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="portal-user-chip"
        onClick={showSettings}
      >
        <span className="portal-avatar" data-tone="navy" aria-hidden="true">
          {initials(name)}
        </span>
        <span className="portal-user-text">
          <strong>{name}</strong>
          <span>
            {human(role)} · {session.workspaceName}
          </span>
        </span>
        <Settings2 size={16} aria-hidden="true" />
        <span className="portal-sr">Settings</span>
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- My day */

type WorkItem = {
  record: AmsRecord;
  type: string;
  due: string;
  ownerId: string | null;
  status: string;
};
type WorkTab = "all" | "mine" | "tasks" | "renewals" | "services";

/** Portal-style home: a greeting, stat tiles beside the team, then every open item. */
export function PortalHome({
  book,
  session,
  open,
  navigate,
  create,
}: {
  book: Book;
  session: AgencySession;
  open: (record: AmsRecord) => void;
  navigate: (view: string) => void;
  create: (intent: EditIntent) => void;
}) {
  const portal = usePortal();
  const [tab, setTab] = useState<WorkTab>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(8);
  const chat = useTeamChat();
  if (!portal) return null;
  const date = today(session.timeZone);
  const me = session.actor.userId;
  const accountName = (record: AmsRecord) => {
    const id = recordAccount(record);
    const account = book.accounts?.find((row) => row.id === id);
    return account ? recordTitle(account) : "Agency";
  };
  const items: WorkItem[] = [
    ...(book.tasks || [])
      .filter((record) => dataOf(record).status !== "done")
      .map((record) => ({
        record,
        type: "Task",
        due: String(dataOf(record).dueDate || ""),
        ownerId: (dataOf(record).ownerId as string | null) ?? null,
        status: String(dataOf(record).status || "open"),
      })),
    ...(book.renewals || [])
      .filter(
        (record) => !["renewed", "lost"].includes(String(dataOf(record).stage)),
      )
      .map((record) => ({
        record,
        type: "Renewal",
        due: String(
          dataOf(record).followUpDate || dataOf(record).expirationDate || "",
        ),
        ownerId: (dataOf(record).ownerId as string | null) ?? null,
        status: String(dataOf(record).stage || "review"),
      })),
    ...(book.services || [])
      .filter((record) => dataOf(record).status !== "completed")
      .map((record) => ({
        record,
        type: "Service",
        due: String(dataOf(record).dueDate || ""),
        ownerId: (dataOf(record).ownerId as string | null) ?? null,
        status: String(dataOf(record).status || "open"),
      })),
  ].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const inTab = (item: WorkItem, value: WorkTab) =>
    value === "all" ||
    (value === "mine" && item.ownerId === me) ||
    (value === "tasks" && item.type === "Task") ||
    (value === "renewals" && item.type === "Renewal") ||
    (value === "services" && item.type === "Service");
  const needle = query.trim().toLowerCase();
  const shown = items.filter(
    (item) =>
      inTab(item, tab) &&
      (!needle ||
        `${recordTitle(item.record)} ${accountName(item.record)}`
          .toLowerCase()
          .includes(needle)),
  );
  const mine = items.filter((item) => item.type === "Task" && item.ownerId === me);
  const mineLate = mine.filter((item) => item.due && item.due < date).length;
  const renewals = items.filter((item) => item.type === "Renewal");
  const nextRenewal = (book.renewals || [])
    .filter((record) => !["renewed", "lost"].includes(String(dataOf(record).stage)))
    .map((record) => String(dataOf(record).expirationDate || ""))
    .filter(Boolean)
    .sort()[0];
  const active = ((book.policies || []) as AmsRecord<"policies">[]).filter(
    (record) => amsPolicyStatusAt(record.data, date) === "active",
  );
  const premium = active.reduce(
    (total, record) => total + record.data.premiumCents,
    0,
  );
  // Teammates you can reach, the ones around first; a solo agency shows just you.
  const others =
    chat?.teammates ??
    session.members.filter((member) => member.active && member.id !== me);
  // Each person keeps one avatar color across the workspace.
  const toneOf = (id: string) =>
    Math.max(
      0,
      session.members.findIndex((member) => member.id === id),
    ) % 3;
  const team = (
    others.length
      ? others
      : session.members.filter((member) => member.id === me)
  ).slice(0, 2);
  const tabs: { id: WorkTab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "mine", label: "Assigned to you" },
    { id: "tasks", label: "Tasks" },
    { id: "renewals", label: "Renewals" },
    { id: "services", label: "Service" },
  ];
  const memberName = (id: string | null) =>
    session.members.find((member) => member.id === id)?.name || "Unassigned";
  return (
    <>
      <header className="portal-greeting">
        <div>
          <h1>Hi {session.actor.name.split(/\s+/)[0]}</h1>
          <p>
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}{" "}
            · {session.workspaceName}
          </p>
        </div>
        {session.writableKinds.includes("tasks") && (
          <button
            className="agency-button primary"
            onClick={() => create({ kind: "tasks", initial: { ownerId: me } })}
          >
            <Plus size={17} />
            New task
          </button>
        )}
      </header>
      <div className="portal-stats">
        <button
          className="portal-stat"
          data-tone={mine.length ? "you" : undefined}
          onClick={() => navigate("tasks")}
        >
          <strong>{mine.length}</strong>
          <span>Need you</span>
          <small>
            {mineLate ? `${mineLate} past due` : "Tasks assigned to you"}
          </small>
        </button>
        <button className="portal-stat" onClick={() => navigate("renewals")}>
          <strong>{renewals.length}</strong>
          <span>Renewals in motion</span>
          <small>
            {nextRenewal
              ? `Next expires ${dateLabel(nextRenewal)}`
              : "None open"}
          </small>
        </button>
        <button className="portal-stat" onClick={() => navigate("policies")}>
          <strong>{wholeDollars(premium)}</strong>
          <span>Active-term premium</span>
          <small>
            {active.length} active {active.length === 1 ? "policy" : "policies"}
          </small>
        </button>
        <section className="portal-team" aria-labelledby="portal-team-title">
          <h2 id="portal-team-title">Your team</h2>
          <ul>
            {team.map((member) => {
              const presence = chat?.presence(member.id);
              const thread = amsChatDirectThread(member.id);
              const unread = chat?.unread(thread) ?? 0;
              return (
                <li key={member.id}>
                  <span
                    className="portal-avatar"
                    data-tone={toneOf(member.id)}
                    data-online={
                      (member.id !== me && presence?.online) || undefined
                    }
                    aria-hidden="true"
                  >
                    {initials(member.name)}
                  </span>
                  <span className="portal-team-who">
                    <strong>
                      {member.name}
                      {member.id === me ? " (you)" : ""}
                    </strong>
                    {presence && member.id !== me ? (
                      <span
                        className="portal-team-presence"
                        data-online={presence.online || undefined}
                      >
                        {presence.label}
                      </span>
                    ) : (
                      human(member.role)
                    )}
                  </span>
                  {member.id !== me &&
                    (chat ? (
                      <button
                        type="button"
                        className="portal-team-chat"
                        aria-label={
                          unread
                            ? `Message ${member.name}, ${unread} unread`
                            : `Message ${member.name}`
                        }
                        onClick={() => chat.open(thread)}
                      >
                        <MessageCircle size={16} />
                        {unread > 0 && <em aria-hidden="true">{unread}</em>}
                      </button>
                    ) : (
                      <a
                        href={`mailto:${member.email}`}
                        aria-label={`Email ${member.name}`}
                      >
                        <Mail size={16} />
                      </a>
                    ))}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
      <section className="portal-work" aria-labelledby="portal-work-title">
        <h2 id="portal-work-title" className="portal-sr">
          Your work
        </h2>
        <div className="portal-toolbar">
          <div className="portal-tabs" role="group" aria-label="Show work">
            {tabs.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={tab === option.id}
                onClick={() => {
                  setTab(option.id);
                  setLimit(8);
                }}
              >
                {option.label}
                <span>{items.filter((item) => inTab(item, option.id)).length}</span>
              </button>
            ))}
          </div>
          <label className="portal-search">
            <Search size={18} aria-hidden="true" />
            <input
              aria-label="Search your work"
              placeholder="Search work or accounts"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        {shown.length ? (
          <div className="portal-rows-scroll">
            <table className="portal-rows">
              <thead>
                <tr>
                  <th>Work</th>
                  <th>Type</th>
                  <th>Due</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, limit).map((item) => {
                  const due = dueLabel(item.due, date);
                  const yours = item.ownerId === me;
                  const tone =
                    item.status === "waiting"
                      ? "off"
                      : due.soon
                        ? "you"
                        : undefined;
                  return (
                    <tr key={`${item.record.kind}:${item.record.id}`}>
                      <td>
                        <button
                          className="portal-row-title"
                          onClick={() => open(item.record)}
                        >
                          {recordTitle(item.record)}
                        </button>
                        <small>{accountName(item.record)}</small>
                      </td>
                      <td className="portal-row-code">{item.type}</td>
                      <td>
                        <span className="portal-due" data-soon={due.soon || undefined}>
                          {due.text}
                        </span>
                      </td>
                      <td>{yours ? "You" : memberName(item.ownerId)}</td>
                      <td>
                        <span className="portal-status" data-tone={tone}>
                          {due.soon && item.status !== "waiting"
                            ? due.text.includes("late")
                              ? "Past due"
                              : "Needs you"
                            : human(item.status)}
                        </span>
                      </td>
                      <td>
                        <button
                          className="portal-pill"
                          data-primary={yours || due.soon || undefined}
                          onClick={() => open(item.record)}
                          aria-label={`${yours || due.soon ? "Review" : "View"} ${recordTitle(item.record)}`}
                        >
                          {yours || due.soon ? "Review" : "View"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="portal-rows-empty">
            <Check size={20} aria-hidden="true" />
            <div>
              <strong>{needle ? "No matching work" : "Nothing open here"}</strong>
              <span>
                {needle
                  ? "Try another name or clear the search."
                  : "New tasks, renewals and service requests land in this list."}
              </span>
            </div>
          </div>
        )}
        {shown.length > limit && (
          <div className="portal-more">
            <button type="button" onClick={() => setLimit((n) => n + 8)}>
              Show more · {shown.length - limit} left
            </button>
          </div>
        )}
      </section>
    </>
  );
}

/* ----------------------------------------------------------------- lists */

/** Status tabs with counts. They drive the same status filter as the select they sit beside. */
export function PortalStatusTabs({
  kind,
  book,
  accountId,
  statusOf,
  value,
  onChange,
}: {
  kind: AmsKind;
  book: Book;
  accountId?: string;
  statusOf: (record: AmsRecord) => string;
  value: string;
  onChange: (value: string) => void;
}) {
  const portal = usePortal();
  if (!portal) return null;
  const rows = (book[kind] || []).filter(
    (record) =>
      (!accountId || sameAccount(book, recordAccount(record), accountId)) &&
      !(
        record.kind === "accounts" &&
        (record as AmsRecord<"accounts">).data.consolidation
      ),
  );
  const counts = new Map<string, number>();
  for (const record of rows) {
    const status = statusOf(record);
    if (status) counts.set(status, (counts.get(status) || 0) + 1);
  }
  const options = [
    { id: "all", label: "All", count: rows.length as number | null },
    ...[...counts.keys()]
      .sort()
      .map((id) => ({ id, label: human(id), count: counts.get(id) ?? 0 })),
    { id: "archived", label: "Archived", count: null },
  ];
  return (
    <div
      className="portal-tabs portal-status-tabs"
      role="group"
      aria-label={`Filter ${titles[kind].toLowerCase()} by status`}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          {option.count !== null && <span>{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- detail */

const renewalSteps = [
  ["review", "Review"],
  ["collecting", "Collecting info"],
  ["marketing", "Marketing"],
  ["proposal", "Proposal"],
  ["renewed", "Renewed"],
] as const;

/** Horizontal progress through the renewal stages, after the portal's risk tracker. */
export function PortalRenewalStepper({
  record,
  compact = false,
}: {
  record: AmsRecord;
  compact?: boolean;
}) {
  const portal = usePortal();
  if (!portal || record.kind !== "renewals") return null;
  const stage = String(dataOf(record).stage || "review");
  const index =
    stage === "waiting"
      ? 3
      : stage === "lost"
        ? 4
        : renewalSteps.findIndex(([id]) => id === stage);
  return (
    <ol
      className="portal-stepper"
      data-compact={compact || undefined}
      aria-label="Renewal progress"
    >
      {renewalSteps.map(([id, label], position) => {
        const state =
          stage === "renewed" || position < index
            ? stage === "lost"
              ? "skipped"
              : "done"
            : position === index
              ? stage === "lost"
                ? "lost"
                : "current"
              : "todo";
        const shownLabel =
          position === 4 && stage === "lost"
            ? "Lost"
            : position === 3 && stage === "waiting"
              ? "Waiting on client"
              : label;
        return (
          <li
            key={id}
            data-state={state}
            data-attention={(position === 3 && stage === "waiting") || undefined}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="portal-step-dot" aria-hidden="true">
              {state === "done" && <Check size={12} strokeWidth={3} />}
              {state === "lost" && <X size={12} strokeWidth={3} />}
            </span>
            <span className="portal-step-label">{shownLabel}</span>
            <span className="portal-sr">
              {state === "done"
                ? ", complete"
                : state === "current"
                  ? ", current stage"
                  : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The account's open renewal, tracked across the top of the account like a portal risk.
 * Not shown for now: the account page reads cleaner without it, and the renewal is still
 * in Next up. If it returns, give it a dismiss button.
 */
export function PortalAccountTrack({
  book,
  session,
  open,
}: {
  book: Book;
  session: AgencySession;
  open: (record: AmsRecord) => void;
}) {
  const portal = usePortal();
  if (!portal) return null;
  const renewal = (book.renewals || [])
    .filter((record) => !["renewed", "lost"].includes(String(dataOf(record).stage)))
    .sort((a, b) =>
      String(dataOf(a).expirationDate).localeCompare(
        String(dataOf(b).expirationDate),
      ),
    )[0];
  if (!renewal) return null;
  const d = dataOf(renewal);
  const owner = session.members.find((member) => member.id === d.ownerId);
  return (
    <section className="portal-track" aria-label="Open renewal">
      <div className="portal-track-head">
        <div>
          <strong>{recordTitle(renewal)}</strong>
          <span>
            Expires {dateLabel(d.expirationDate)}
            {owner ? ` · ${owner.name}` : ""}
            {d.nextAction ? ` · Next: ${String(d.nextAction)}` : ""}
          </span>
        </div>
        <button
          className="portal-pill"
          data-primary
          onClick={() => open(renewal)}
          aria-label={`Open renewal ${recordTitle(renewal)}`}
        >
          Open renewal <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
      <PortalRenewalStepper record={renewal} />
    </section>
  );
}

/**
 * The account's primary contact with call and email, after the portal's underwriter card.
 * Not shown for now: the People card on the account already lists the same person.
 */
export function PortalContactCard({ contacts }: { contacts?: AmsRecord[] }) {
  const portal = usePortal();
  if (!portal) return null;
  const people = (contacts || []) as AmsRecord<"contacts">[];
  const contact = people.find((row) => row.data.primary) || people[0];
  if (!contact) return null;
  const { name, title, phone, mobile, email } = contact.data;
  const call = phone || mobile;
  return (
    <div className="portal-person">
      <span className="portal-avatar" data-tone="mint" aria-hidden="true">
        {initials(name)}
      </span>
      <span className="portal-person-text">
        <strong>{name}</strong>
        <span>
          {[title, contact.data.primary ? "Primary contact" : "Contact"]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      {call && (
        <a
          className="portal-person-icon"
          href={`tel:${call}`}
          aria-label={`Call ${name}`}
        >
          <Phone size={16} />
        </a>
      )}
      {email && (
        <a className="portal-person-message" href={`mailto:${email}`}>
          <Mail size={15} aria-hidden="true" />
          Email
          <span className="portal-sr"> {name}</span>
        </a>
      )}
    </div>
  );
}
