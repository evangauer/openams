"use client";

/*
 * Relay design take: shell pieces (sidebar agents, top bar, quick search and the
 * "Available with Relay" explainer). Every component renders nothing unless the
 * Relay take is active, so the other takes stay untouched. Nothing here calls the
 * API or contacts Relay; when the workspace is not connected, Relay entry points
 * explain what would connect instead of pretending to work.
 */
import Link from "next/link";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Building2,
  Calculator,
  CalendarRange,
  CheckCheck,
  ClipboardList,
  CornerDownLeft,
  FileCheck2,
  FolderOpen,
  History,
  Home,
  Landmark,
  Layers3,
  Lock,
  Menu,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { matchingAccountIds } from "../account-model";
import { recordTitle, type AgencySession, type AmsRecord, type Book } from "../model";
import { useAgencyTheme } from "../theme";

type Icon = ComponentType<{ size?: number; className?: string }>;

export type RelayAgentId = "assistant" | "quote" | "documents";
export const RELAY_AGENTS: {
  id: RelayAgentId;
  label: string;
  tone: string;
  icon: Icon;
  detail: string;
}[] = [
  {
    id: "assistant",
    label: "Agency Assistant",
    tone: "accent",
    icon: Sparkles,
    detail:
      "Ask about an account, plan your day and draft client follow-ups from these records.",
  },
  {
    id: "quote",
    label: "Quote with Relay",
    tone: "sky",
    icon: Calculator,
    detail:
      "Start a quote from an account’s policies and exposures, then compare carrier results.",
  },
  {
    id: "documents",
    label: "Document Studio",
    tone: "rose",
    icon: Presentation,
    detail:
      "Build proposals, renewal summaries and cover pages from account records.",
  },
];

const PAGES: { view: string; label: string; icon: Icon }[] = [
  { view: "home", label: "My day", icon: Home },
  { view: "accounts", label: "Accounts", icon: UsersRound },
  { view: "renewals", label: "Renewals", icon: RefreshCw },
  { view: "tasks", label: "Tasks", icon: CheckCheck },
  { view: "services", label: "Service requests", icon: ClipboardList },
  { view: "policies", label: "Policy terms", icon: Layers3 },
  { view: "certificates", label: "Certificates", icon: FileCheck2 },
  { view: "claims", label: "Claims", icon: ShieldCheck },
  { view: "documents", label: "Documents", icon: FolderOpen },
  { view: "financials", label: "Financials", icon: Landmark },
  { view: "reports", label: "Reports", icon: SlidersHorizontal },
  { view: "audit", label: "Audit history", icon: History },
];

export function RelayChip({ tone, icon: Glyph }: { tone: string; icon: Icon }) {
  return (
    <span className={`relay-chip relay-tone-${tone}`} aria-hidden="true">
      <Glyph size={14} />
    </span>
  );
}

/** Explains a Relay connection point. It never claims anything was sent. */
export function RelayConnectDialog({
  focus,
  subject,
  close,
}: {
  focus?: RelayAgentId;
  subject?: string;
  close: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="agency-dialog relay-connect-dialog" data-brand="relay">
        <DialogHeader>
          <span className="relay-connect-mark" aria-hidden="true">
            <Sparkles size={18} />
          </span>
          <DialogTitle>Available with Relay</DialogTitle>
          <DialogDescription>
            Relay adds AI quoting and an assistant on top of OpenAMS records.
            {subject
              ? ` Once connected, you could ask about ${subject} right here.`
              : " Once connected, these agents open from this sidebar."}
          </DialogDescription>
        </DialogHeader>
        <ul className="relay-connect-agents">
          {RELAY_AGENTS.map((agent) => (
            <li key={agent.id} data-focus={agent.id === focus || undefined}>
              <RelayChip tone={agent.tone} icon={agent.icon} />
              <span>
                <strong>{agent.label}</strong>
                <small>{agent.detail}</small>
              </span>
            </li>
          ))}
        </ul>
        <p className="relay-connect-note">
          <Lock size={14} aria-hidden="true" />
          <span>
            This workspace is not connected to Relay. Nothing has been sent and
            no assistant has read these records. An agency administrator sets
            up the connection from a live Relay workspace.
          </span>
        </p>
        <div className="relay-connect-footer">
          <button className="agency-button" onClick={close}>
            Got it
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** AGENTS and CHATS sections for the sidebar, plus the mobile menu toggle. */
export function RelayAgents({ session }: { session: AgencySession }) {
  const theme = useAgencyTheme();
  const [explain, setExplain] = useState<RelayAgentId | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The mobile menu opens the existing sidebar in place; navigation closes it.
    const sidebar = toggle.current?.closest(".agency-sidebar") as HTMLElement | null;
    if (!sidebar) return;
    if (menuOpen) sidebar.dataset.relayMenu = "open";
    else delete sidebar.dataset.relayMenu;
  }, [menuOpen]);
  useEffect(() => {
    const close = () => setMenuOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);
  if (theme !== "relay") return null;
  const connected = Boolean(session.relayWorkspaceEnabled);
  return (
    <>
      <button
        ref={toggle}
        className="relay-menu-toggle"
        aria-expanded={menuOpen}
        aria-label={menuOpen ? "Close navigation" : "Open navigation"}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {menuOpen ? <X size={18} /> : <Menu size={18} />}
      </button>
      <div className="relay-rail">
        <div className="relay-rail-label">
          <span>Agents</span>
          {!connected && <span className="relay-tag">Connect Relay</span>}
        </div>
        <ul className="relay-agent-list">
          {RELAY_AGENTS.map((agent) => (
            <li key={agent.id}>
              {connected ? (
                <Link className="relay-agent" href="/" prefetch={false}>
                  <RelayChip tone={agent.tone} icon={agent.icon} />
                  <span>{agent.label}</span>
                  <ArrowUpRight size={14} className="relay-agent-end" />
                </Link>
              ) : (
                <button
                  className="relay-agent"
                  data-locked="true"
                  onClick={() => setExplain(agent.id)}
                  aria-label={`${agent.label}, available with Relay`}
                >
                  <RelayChip tone={agent.tone} icon={agent.icon} />
                  <span>{agent.label}</span>
                  <Lock size={13} className="relay-agent-end" />
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="relay-rail-label relay-rail-chats">
          <span>Chats</span>
        </div>
        <p className="relay-rail-note">
          {connected
            ? "Your Agency Assistant chats open in Relay."
            : "Assistant chats show up here once Relay is connected."}
        </p>
      </div>
      {explain && (
        <RelayConnectDialog focus={explain} close={() => setExplain(null)} />
      )}
    </>
  );
}

/** Slim Relay top bar: title, Accounts | Renewals, quick search and the primary action. */
export function RelayTopbar({
  view,
  title,
  inAccount,
  session,
  book,
  loading,
  navigate,
  refresh,
  addAccount,
}: {
  view: string;
  title: string;
  inAccount: boolean;
  session: AgencySession;
  book: Book;
  loading: boolean;
  navigate: (path: string) => void;
  refresh: () => void;
  addAccount?: () => void;
}) {
  const theme = useAgencyTheme();
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (theme !== "relay") return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [theme]);
  if (theme !== "relay") return null;
  const segmented = view === "accounts" || view === "renewals";
  return (
    <>
      <div className="relay-top-cell relay-top-left">
        {inAccount && (
          <button
            className="relay-icon-button"
            aria-label="Back to accounts"
            onClick={() => navigate("accounts")}
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <span className="relay-top-title">{title}</span>
        {segmented && (
          <nav className="relay-segmented" aria-label="Accounts and renewals">
            {[
              { id: "accounts", label: "Accounts", icon: UsersRound },
              { id: "renewals", label: "Renewals", icon: CalendarRange },
            ].map(({ id, label, icon: Glyph }) => (
              <button
                key={id}
                aria-current={view === id ? "page" : undefined}
                onClick={() => navigate(id)}
              >
                <Glyph size={14} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
      <div className="relay-top-cell relay-top-center">
        <button
          className="relay-search-pill"
          onClick={() => setSearching(true)}
          aria-label="Search accounts and pages (Command K)"
        >
          <Search size={16} aria-hidden="true" />
          <span>Search accounts, people, policies…</span>
          <span className="relay-kbd" aria-hidden="true">
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </span>
        </button>
      </div>
      <div className="relay-top-cell relay-top-right">
        <button
          className="relay-icon-button relay-search-icon"
          aria-label="Search"
          onClick={() => setSearching(true)}
        >
          <Search size={16} />
        </button>
        <button
          className="relay-icon-button"
          aria-label={loading ? "Refreshing agency records" : "Refresh agency records"}
          title={loading ? "Refreshing" : "Records up to date"}
          disabled={loading}
          onClick={refresh}
        >
          <RefreshCw size={16} className={loading ? "agency-spin" : undefined} />
        </button>
        {addAccount && (
          <button className="relay-primary" onClick={addAccount}>
            <Plus size={16} aria-hidden="true" />
            <span>Add account</span>
          </button>
        )}
      </div>
      {searching && (
        <RelaySearch
          book={book}
          session={session}
          navigate={navigate}
          close={() => setSearching(false)}
        />
      )}
    </>
  );
}

/** Quick jump to an account or page. Client-side only, over records already loaded. */
function RelaySearch({
  book,
  session,
  navigate,
  close,
}: {
  book: Book;
  session: AgencySession;
  navigate: (path: string) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const results = useMemo(() => {
    const accounts = (book.accounts || []).filter(
      (record) =>
        !record.archivedAt &&
        !(record as AmsRecord<"accounts">).data.consolidation,
    ) as AmsRecord<"accounts">[];
    const ids = query.trim()
      ? matchingAccountIds(book, query, session.readableKinds)
      : null;
    const accountRows = accounts
      .filter((record) => !ids || ids.has(record.id))
      .sort((a, b) => recordTitle(a).localeCompare(recordTitle(b)))
      .slice(0, 6)
      .map((record) => ({
        key: `account:${record.id}`,
        group: "Accounts",
        label: recordTitle(record),
        detail:
          [
            record.data.industry,
            [record.data.address.city, record.data.address.state]
              .filter(Boolean)
              .join(", "),
          ]
            .filter(Boolean)
            .join(" · ") || "Account",
        icon: Building2 as Icon,
        path: `accounts/${record.id}`,
      }));
    const term = query.trim().toLowerCase();
    const pageRows = PAGES.filter(
      (page) =>
        (page.view !== "financials" ||
          session.readableKinds.includes("invoices")) &&
        (!term || page.label.toLowerCase().includes(term)),
    )
      .slice(0, term ? 6 : 4)
      .map((page) => ({
        key: `page:${page.view}`,
        group: "Go to",
        label: page.label,
        detail: "Page",
        icon: page.icon,
        path: page.view,
      }));
    return [...accountRows, ...pageRows];
  }, [book, query, session.readableKinds]);
  const choose = (index: number) => {
    const row = results[index];
    if (!row) return;
    close();
    navigate(row.path);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="agency-dialog relay-search-dialog"
        data-brand="relay"
        showClose={false}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Search the agency</DialogTitle>
        <div className="relay-search-input">
          <Search size={17} aria-hidden="true" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              results[active] ? `${listId}-${active}` : undefined
            }
            aria-label="Search accounts and pages"
            placeholder="Search accounts, people, policies…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(results.length - 1, index + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(0, index - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(active);
              }
            }}
          />
          <span className="relay-kbd" aria-hidden="true">
            <kbd>esc</kbd>
          </span>
        </div>
        <ul className="relay-search-results" id={listId} role="listbox" aria-label="Results">
          {results.map((row, index) => (
            <li
              key={row.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-group={
                index === 0 || results[index - 1].group !== row.group
                  ? row.group
                  : undefined
              }
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <span className="relay-search-tile" aria-hidden="true">
                <row.icon size={15} />
              </span>
              <span>
                <strong>{row.label}</strong>
                <small>{row.detail}</small>
              </span>
              {index === active && (
                <CornerDownLeft size={14} aria-hidden="true" className="relay-search-enter" />
              )}
            </li>
          ))}
          {!results.length && (
            <li className="relay-search-empty" role="presentation">
              No accounts or pages match “{query}”.
            </li>
          )}
        </ul>
        <p className="relay-search-foot">
          Searches records already open in this workspace.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Relay connection point for My day. Prompts are shown as what Relay would do; they
 * are not buttons until the workspace is connected.
 */
export function RelayAssistantCard({ session }: { session: AgencySession }) {
  const theme = useAgencyTheme();
  const [explain, setExplain] = useState(false);
  if (theme !== "relay") return null;
  const connected = Boolean(session.relayWorkspaceEnabled);
  const prompts = ["Plan my workday", "Prioritize today’s renewals", "Draft a follow-up email"];
  return (
    <section className="relay-assist-card relay-assist-home" aria-label="Agency Assistant">
      <span className="relay-assist-mark" aria-hidden="true">
        <Sparkles size={18} />
      </span>
      <div className="relay-assist-copy">
        <span className="relay-eyebrow">
          {connected ? "Relay connected" : "Available with Relay"}
        </span>
        <h2>Plan your day with the Agency Assistant</h2>
        <p>
          Relay reads these accounts, renewals and tasks to suggest what to do first and draft follow-ups for your review.
        </p>
        <ul className="relay-assist-prompts" aria-label="What Relay could do">
          {prompts.map((prompt) => (
            <li key={prompt}>
              {connected ? <Sparkles size={13} aria-hidden="true" /> : <Lock size={12} aria-hidden="true" />}
              {prompt}
            </li>
          ))}
        </ul>
      </div>
      {connected ? (
        <Link className="agency-button" href="/" prefetch={false}>
          Open Relay <ArrowUpRight size={14} />
        </Link>
      ) : (
        <button className="agency-button" onClick={() => setExplain(true)}>
          How it connects <ArrowRight size={14} />
        </button>
      )}
      {explain && (
        <RelayConnectDialog focus="assistant" close={() => setExplain(false)} />
      )}
    </section>
  );
}
