"use client";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  ClipboardPen,
  CirclePlay,
  Compass,
  FileCheck2,
  FolderOpen,
  History,
  Home,
  Inbox,
  Landmark,
  Layers3,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Lightbulb,
  Users,
  UsersRound,
  X,
  RotateCcw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  amsBasisPoints,
  amsPolicyStatusAt,
  type AmsAudit,
  type AmsPage,
} from "@openams/contracts";
import {
  CertificatePreparation,
  CertificateServicing,
  CertificateTemplates,
} from "./certificates";
import { PolicyHistory } from "./policy-history";
import { StatementImport, StatementReview } from "./statements";
import { ImportDialog } from "./import-dialog";
import { TaskFollowUp, ReminderQueue } from "./task-follow-up";
import { CorrespondenceDetail } from "./account-correspondence";
import { MailboxInbox } from "./mailbox-inbox";
import { AccountWorkspace } from "./account-workspace";
import { AccountDirectory } from "./account-directory";
import { canonicalAccountId, sameAccount } from "./account-identity-model";
import { matchingAccountIds } from "./account-model";
import { AccountDraftProvider } from "./account-drafts";
import { AgencyProfileForm, workspaceRecord } from "./agency-profile";
import { AgencyEditor, type EditIntent } from "./editor";
import { TeamChatProvider } from "./team-chat";
import { TeamPage } from "./team";
import { PageHeader } from "./page-header";
import { SuggestionBox } from "./suggestions";
import { FormsView } from "./forms";
import { useAgencyTheme } from "./theme";
import {
  PortalHome,
  PortalMenuButton,
  PortalRenewalStepper,
  PortalStatusTabs,
  PortalTopActions,
} from "./themes/portal-parts";
import {
  RelayAgents,
  RelayAssistantCard,
  RelayTopbar,
} from "./themes/relay-shell";
import { BrandNav, BrandSchemePicker } from "./themes/brand-parts";
import { actionLabels } from "./fields";
import {
  AgencyRequestError,
  dateLabel,
  findAccount,
  human,
  money,
  readBook,
  readArchived,
  recordAccount,
  recordTitle,
  request,
  singular,
  titles,
  today,
  type AgencySession,
  type AmsCommand,
  type AmsKind,
  type AmsRecord,
  type Book,
} from "./model";
import "./workspace.css";
import "./account-workspace.css";
// Design takes load last so they override the base styles they are scoped over.
import "./themes/portal.css";
import "./themes/relay.css";
import "./themes/brand.css";
import "./picker.css";
import "./team-chat.css";

/** Per-person state: account drafts and team chat start over when the person changes. */
function WorkspaceProviders({
  session,
  children,
}: {
  session: AgencySession;
  children: ReactNode;
}) {
  return (
    <AccountDraftProvider>
      <TeamChatProvider session={session}>{children}</TeamChatProvider>
    </AccountDraftProvider>
  );
}
import "./hosted-identity.css";

type View =
  | AmsKind
  | "home"
  | "financials"
  | "reports"
  | "audit"
  | "team"
  | "inbox"
  | "settings";
const nav: { view: View; label: string; icon: typeof Home }[] = [
  { view: "home", label: "My day", icon: Home },
  { view: "accounts", label: "Accounts", icon: UsersRound },
  { view: "inbox", label: "Incoming mail", icon: Inbox },
  { view: "forms", label: "Forms", icon: ClipboardPen },
  { view: "renewals", label: "Renewals", icon: RefreshCw },
  { view: "tasks", label: "Tasks", icon: CheckCheck },
  { view: "services", label: "Service requests", icon: ClipboardList },
  { view: "policies", label: "Policy terms", icon: Layers3 },
  { view: "policychanges", label: "Scheduled changes", icon: ClipboardList },
  { view: "certificates", label: "Certificates", icon: FileCheck2 },
  { view: "claims", label: "Claims", icon: ShieldCheck },
  { view: "documents", label: "Documents", icon: FolderOpen },
  { view: "financials", label: "Financials", icon: Landmark },
  { view: "reports", label: "Reports", icon: SlidersHorizontal },
  { view: "audit", label: "Audit history", icon: History },
  { view: "team", label: "Team", icon: Users },
  { view: "suggestions", label: "Suggestion box", icon: Lightbulb },
];
const financeKinds: AmsKind[] = [
  "commissions",
  "statements",
  "invoices",
  "payments",
  "journals",
];
const accountKinds: AmsKind[] = [
  "policies",
  "policychanges",
  "renewals",
  "contacts",
  "exposures",
  "tasks",
  "notes",
  "correspondence",
  "reminders",
  "documents",
  "services",
  "claims",
  "certificates",
  "invoices",
  "commissions",
  "payments",
  "journals",
];
const subscribeHash = (callback: () => void) => {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
};
const getHash = () => window.location.hash;
const go = (view: string) => {
  // Use Next's integrated native-history path. Direct hash assignment can leave
  // its canonical URL behind and restore an older view on refresh.
  window.history.pushState(null, "", `#${view}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
};
const dataOf = (record: AmsRecord) => record.data as Record<string, unknown>;
const accountName = (book: Book, id: string | null) => {
  const account = findAccount(book, id);
  return account ? recordTitle(account) : "";
};
const statusOf = (record: AmsRecord, timeZone = "UTC") =>
  record.archivedAt
    ? "archived"
    : record.kind === "policies"
      ? amsPolicyStatusAt(
          record.data as AmsRecord<"policies">["data"],
          today(timeZone),
        )
      : String(dataOf(record).status || dataOf(record).stage || "");
const sum = (records: AmsRecord[], key: string) =>
  records.reduce(
    (total, record) => total + Number(dataOf(record)[key] || 0),
    0,
  );

export function AgencyWorkspace({
  local,
  hosted,
  publicDemo,
}: {
  local: boolean;
  /**
   * The public demo (AMS_PREVIEW=public): no roles to choose; each browser gets a private
   * sandbox of the fictional agency. `link` is the way onward shown in the banner.
   */
  publicDemo?: { link: { url: string; label: string } | null };
  /** Hosted sign-in (AMS_AUTH_MODE=firebase): adds sign-out and team management. */
  hosted?: {
    signOut: () => Promise<void>;
    manageAccount?: () => Promise<void>;
    /** Called once the workspace has loaded, so notices can wait for it. */
    onReady?: () => void;
  };
}) {
  const hash = useSyncExternalStore(subscribeHash, getHash, () => "#home");
  const [routePath] = hash.replace(/^#\/?/, "").split("?");
  const [path, accountId, accountTab] = routePath.split("/");
  const view: View = [
    ...nav.map((item) => item.view),
    "certificateholders",
    "certificatetemplates",
    "formsubmissions",
    "settings",
    ...financeKinds,
  ].includes(path as View)
    ? (path as View)
    : "home";
  const [session, setSession] = useState<AgencySession | null>(null);
  const onReady = hosted?.onReady;
  useEffect(() => {
    if (session) onReady?.();
  }, [session, onReady]);
  const [book, setBook] = useState<Book>({});
  const [archived, setArchived] = useState<AmsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [login, setLogin] = useState(false);
  const [statementImport, setStatementImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  // The Relay design take reuses the built-in Relay skin; every other take is OpenAMS.
  const theme = useAgencyTheme();
  const brand: "openams" | "relay" = theme === "relay" ? "relay" : "openams";
  const [intent, setIntent] = useState<EditIntent | null>(null);
  const [selected, setSelected] = useState<AmsRecord | null>(null);
  const [message, setMessage] = useState("");
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState("");
  const [resetDemo, setResetDemo] = useState(false);
  const demoPending = useRef<{
    commandId: string;
    restart: boolean;
    expectedTenantId: string | null;
  } | null>(null);
  const demoFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    return request<AgencySession>("session", { signal: abort.signal })
      .then(async (nextSession) => ({
        nextSession,
        nextBook: await readBook(nextSession, abort.signal),
      }))
      .then(({ nextSession, nextBook }) => {
        if (abort.signal.aborted) return;
        setSession(nextSession);
        setBook(nextBook);
        setLogin(false);
        setError("");
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "Unable to open the agency.",
        );
        setLogin(
          failure instanceof AgencyRequestError && failure.status === 401,
        );
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
  }, []);
  useEffect(() => {
    void refresh();
    return () => controller.current?.abort();
  }, [refresh]);
  const account = book.accounts?.find(
    (record) => record.id === canonicalAccountId(book, accountId),
  );
  const activeKind: AmsKind | null =
    view === "accounts" && accountId
      ? accountKinds.includes(accountTab as AmsKind)
        ? (accountTab as AmsKind)
        : "policies"
      : view === "financials"
        ? "commissions"
        : view in titles
          ? (view as AmsKind)
          : null;
  const writable =
    activeKind &&
    session?.writableKinds.includes(activeKind) &&
    ![
      "payments",
      "journals",
      "policychanges",
      "reminders",
      "correspondence",
      "workspace",
    ].includes(activeKind);
  useEffect(() => {
    if (status !== "archived" || !activeKind) return;
    const abort = new AbortController();
    readArchived(activeKind, abort.signal)
      .then((rows) => setArchived(rows))
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [activeKind, status]);
  const matchingAccounts =
    activeKind === "accounts" && query.trim()
      ? matchingAccountIds(book, query, session?.readableKinds || [])
      : null;
  const records = (
    activeKind
      ? status === "archived"
        ? archived.filter((row) => row.kind === activeKind)
        : book[activeKind] || []
      : []
  ).filter(
    (record) =>
      (!accountId || sameAccount(book, recordAccount(record), accountId)) &&
      !(
        record.kind === "accounts" &&
        (record as AmsRecord<"accounts">).data.consolidation
      ) &&
      (status === "all" || statusOf(record, session?.timeZone) === status) &&
      (!query ||
        (activeKind === "accounts" && matchingAccounts?.has(record.id)) ||
        JSON.stringify(record.data)
          .toLowerCase()
          .includes(query.toLowerCase()) ||
        (
          findAccount(book, recordAccount(record))?.data as
            | { name?: string }
            | undefined
        )?.name
          ?.toLowerCase()
          .includes(query.toLowerCase())),
  );
  function navigate(next: string) {
    setQuery("");
    setStatus("all");
    setSelected(null);
    go(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function saved(records: AmsRecord[]) {
    const setup = records.find((r) => r.kind === "workspace") as
      | AmsRecord<"workspace">
      | undefined;
    if (setup)
      setSession((previous) =>
        previous
          ? {
              ...previous,
              workspaceName: setup.data.name,
              timeZone: setup.data.timeZone,
              calendarConfigured: true,
              defaultOwnerId: setup.data.defaultOwnerId,
            }
          : previous,
      );
    setArchived((previous) =>
      previous.filter(
        (row) =>
          !records.some(
            (record) => record.kind === row.kind && record.id === row.id,
          ),
      ),
    );
    setBook((previous) => {
      const next = { ...previous };
      for (const record of records) {
        const rows = [...(next[record.kind] || [])];
        const index = rows.findIndex((row) => row.id === record.id);
        if (index === -1) rows.push(record);
        else rows[index] = record;
        next[record.kind] = rows.filter((row) => !row.archivedAt);
        if (record.kind === "accounts")
          next.archivedAccounts = [
            ...(next.archivedAccounts || []).filter((row) => row.id !== record.id),
            ...(record.archivedAt ? [record as AmsRecord<"accounts">] : []),
          ];
      }
      return next;
    });
    setSelected(
      (previous) =>
        records.find(
          (record) =>
            record.id === previous?.id && record.kind === previous.kind,
        ) || previous,
    );
    setMessage("Saved to your agency. Change history updated.");
    if (
      account &&
      records.some(
        (record) =>
          record.kind === "accounts" &&
          record.id === account.id &&
          record.archivedAt,
      )
    ) {
      navigate("accounts");
      setStatus("archived");
      setMessage("Account archived. Its records and history are retained.");
    }
  }
  function openRecord(record: AmsRecord) {
    if (record.kind === "accounts" && !record.archivedAt)
      navigate(`accounts/${record.id}`);
    else setSelected(record);
  }
  async function localSignIn(
    role: string,
    mode = session?.demo ? "demo" : "agency",
  ) {
    setError("");
    try {
      await request("local-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, mode }),
      });
      setSession(null);
      setBook({});
      setSelected(null);
      setIntent(null);
      setLoading(true);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sign-in failed.");
    }
  }
  /** Public demo: opens a private sandbox for this browser, or a fresh one in its place. */
  const sandboxFlight = useRef(false);
  async function openSandbox() {
    if (sandboxFlight.current) return;
    sandboxFlight.current = true;
    setDemoBusy(true);
    setDemoError("");
    try {
      await request("demo-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      setSession(null);
      setBook({});
      setSelected(null);
      setIntent(null);
      setResetDemo(false);
      setLoading(true);
      go("home");
      await refresh();
    } catch (failure) {
      setDemoError(
        failure instanceof Error ? failure.message : "The demo couldn't be prepared. Try again.",
      );
    } finally {
      sandboxFlight.current = false;
      setDemoBusy(false);
    }
  }
  // A visitor with no sandbox yet (or one that has ended) gets one without asking.
  const sandboxOpened = useRef(false);
  useEffect(() => {
    if (!publicDemo || !login || session || sandboxOpened.current) return;
    sandboxOpened.current = true;
    void openSandbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicDemo, login, session]);
  async function startDemo(restart = false) {
    if (demoFlight.current) return;
    demoFlight.current = true;
    setDemoBusy(true);
    setDemoError("");
    demoPending.current ||= {
      commandId: crypto.randomUUID(),
      restart,
      expectedTenantId: session?.demo?.tenantId ?? null,
    };
    try {
      await request("local-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "admin",
          // Keep a failed reset inside the fictional tenant. Switching back to
          // the agency here would leave demo UI paired with an agency cookie.
          mode: session?.demo ? "demo" : "agency",
        }),
      });
      await request("demo/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(demoPending.current),
      });
      await localSignIn("admin", "demo");
      demoPending.current = null;
      setResetDemo(false);
      go("home");
    } catch (failure) {
      const uncertain =
        !(failure instanceof AgencyRequestError) ||
        failure.status >= 500 ||
        failure.status === 408;
      if (!uncertain) demoPending.current = null;
      setDemoError(
        uncertain
          ? "Demo preparation could not be confirmed. Retry safely to resume the same copy."
          : failure.message,
      );
    } finally {
      demoFlight.current = false;
      setDemoBusy(false);
    }
  }
  if (!session && publicDemo && login && !loading)
    return (
      <div className="agency-bootstrap">
        <div className="agency-mark">
          <Layers3 size={25} />
        </div>
        <span className="agency-overline">OpenAMS</span>
        <h1>{demoError ? "The demo couldn't open" : "Preparing your demo agency…"}</h1>
        {demoError ? (
          <>
            <p role="alert">{demoError}</p>
            <button className="agency-button primary" disabled={demoBusy} onClick={() => void openSandbox()}>
              Try again
            </button>
          </>
        ) : (
          <Loader2 className="agency-spin" />
        )}
        <small>A private copy with fictional records · Nothing here contacts anyone</small>
      </div>
    );
  if (!session)
    return (
      <div className="agency-bootstrap">
        <div className="agency-mark">
          <Layers3 size={25} />
        </div>
        <span className="agency-overline">OpenAMS</span>
        <h1>
          {loading
            ? "Opening your agency…"
            : local && login
              ? "Your working agency workspace"
              : "Agency management"}
        </h1>
        {loading ? (
          <Loader2 className="agency-spin" />
        ) : (
          <>
            <p>
              {local && login
                ? "Choose a local test role. Records and uploaded files stay on this computer between sessions."
                : error}
            </p>
            {local && login ? (
              <div className="agency-login-roles">
                {["admin", "member", "accountant", "viewer"].map((role) => (
                  <button
                    key={role}
                    onClick={() => void localSignIn(role)}
                    className={`agency-button ${role === "admin" ? "primary" : ""}`}
                  >
                    Continue as {role}
                    <ArrowRight size={15} />
                  </button>
                ))}
              </div>
            ) : (
              <button className="agency-button" onClick={() => void refresh()}>
                Try again
              </button>
            )}
            {local && login && error !== "Choose a local test session." && (
              <p role="alert">{error}</p>
            )}
            {local && login && (
              <div className="agency-bootstrap-demo">
                <button
                  className="agency-button"
                  disabled={demoBusy}
                  onClick={() => void startDemo()}
                >
                  <Compass size={16} />
                  {demoBusy ? "Preparing demo…" : "Explore demo agency"}
                </button>
                {demoError && <p role="alert">{demoError}</p>}
              </div>
            )}
            {!local && login && (
              <a className="agency-button primary" href="/">
                Sign in again
              </a>
            )}
            <small>
              {local
                ? "Isolated development · No carrier actions or live payments"
                : "Access is verified against your agency membership."}
            </small>
          </>
        )}
      </div>
    );
  const demoActions = {
    restart: () => setResetDemo(true),
    ...(publicDemo
      ? { link: publicDemo.link }
      : {
          exit: () => {
            void localSignIn("admin", "agency");
            go("home");
          },
        }),
  };
  return (
    <WorkspaceProviders
      key={`${session.actor.tenantId}:${session.actor.userId}:${session.actor.role}`}
      session={session}
    >
      <div className="agency-app" data-brand={brand}>
        <a href="#agency-main" className="agency-skip">
          Skip to workspace
        </a>
        <aside className="agency-sidebar">
          <button className="agency-brand" onClick={() => navigate("home")}>
            <span className="agency-mark">
              <Layers3 size={21} />
            </span>
            <span>
              OpenAMS
              <small>
                {brand === "openams"
                  ? "Agency management"
                  : session.relayWorkspaceEnabled
                    ? "in Relay"
                    : "Agency workspace"}
              </small>
            </span>
          </button>
          <PortalMenuButton />
          <div className="agency-org">
            <Building2 size={17} />
            <span>
              {session.workspaceName}
              <small>
                {publicDemo ? "Demo" : local ? "Local development" : human(session.actor.role)}
              </small>
            </span>
          </div>
          {theme === "brand" ? (
            <BrandNav
              items={nav.filter(
                (item) =>
                  (item.view !== "financials" || session.readableKinds.includes("invoices")) &&
                  (item.view !== "inbox" || Boolean(session.mailboxReviewEnabled && session.writableKinds.includes("correspondence"))) &&
                  (item.view !== "forms" || Boolean(session.formsEnabled)),
              )}
              isCurrent={(target) =>
                view === target ||
                (target === "financials" &&
                  financeKinds.includes(view as AmsKind))
              }
              navigate={navigate}
              taskCount={
                (book.tasks || []).filter(
                  (r) => statusOf(r, session?.timeZone) !== "done",
                ).length
              }
              demo={session.demo ? { busy: demoBusy, ...demoActions } : null}
            />
          ) : (
            <nav aria-label="Agency navigation">
              {nav
                .filter(
                  (item) =>
                    (item.view !== "financials" || session.readableKinds.includes("invoices")) &&
                    (item.view !== "inbox" || Boolean(session.mailboxReviewEnabled && session.writableKinds.includes("correspondence"))) &&
                    (item.view !== "forms" || Boolean(session.formsEnabled)),
                )
                .map(({ view: target, label, icon: Icon }) => (
                  <button
                    key={target}
                    aria-current={
                      view === target ||
                      (target === "financials" &&
                        financeKinds.includes(view as AmsKind))
                        ? "page"
                        : undefined
                    }
                    onClick={() => navigate(target)}
                  >
                    <Icon size={17} />
                    <span>{label}</span>
                    {target === "tasks" && (
                      <em>
                        {
                          (book.tasks || []).filter(
                            (r) => statusOf(r, session?.timeZone) !== "done",
                          ).length
                        }
                      </em>
                    )}
                  </button>
                ))}
            </nav>
          )}
          {brand === "relay" && <RelayAgents session={session} />}
          <div className="agency-sidebar-bottom">
            {brand === "relay" && (
              <div className="agency-connection">
                <Sparkles size={16} />
                <span>
                  Relay quoting
                  <small>
                    {local
                      ? "Connect in your live workspace"
                      : "Your existing quoting workspace"}
                  </small>
                </span>
                {session.relayWorkspaceEnabled && (
                  <Link href="/" aria-label="Open Relay quoting">
                    <ArrowRight size={16} />
                  </Link>
                )}
              </div>
            )}
            <button
              className="agency-person"
              onClick={() => navigate("settings")}
            >
              <span className="agency-avatar" aria-hidden="true">
                {theme === "brand"
                  ? session.actor.name
                      .split(/\s+/)
                      .map((word) => word[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase()
                  : session.actor.name.slice(0, 1)}
              </span>
              <span>
                {session.actor.name}
                <small>{human(session.actor.role)}</small>
              </span>
              <Settings2 size={16} />
            </button>
            {hosted?.manageAccount && (
              <button
                className="agency-signout"
                onClick={() => void hosted.manageAccount?.()}
              >
                <Settings2 size={15} />
                Manage account
              </button>
            )}
            {hosted && (
              <button
                className="agency-signout"
                onClick={() => void hosted.signOut()}
              >
                <LogOut size={15} />
                Sign out
              </button>
            )}
          </div>
        </aside>
        <div className="agency-body">
          {session.demo && <DemoBanner busy={demoBusy} publicDemo={Boolean(publicDemo)} {...demoActions} />}
          {/* The OpenAMS take has no top bar: pages open on their own heading and the
              person sits at the foot of the sidebar. */}
          {theme !== "brand" && (
            <header className="agency-topbar">
              {brand === "relay" && (
                <RelayTopbar
                  view={view}
                  title={
                    nav.find((item) => item.view === view)?.label ||
                    (view === "settings" ? "Settings" : titles[view as AmsKind])
                  }
                  inAccount={Boolean(account)}
                  session={session}
                  book={book}
                  loading={loading}
                  navigate={navigate}
                  refresh={() => void refresh()}
                  addAccount={
                    session.writableKinds.includes("accounts")
                      ? () => setIntent({ kind: "accounts" })
                      : undefined
                  }
                />
              )}
              <div>
                {account ? (
                  <button
                    className="account-breadcrumb"
                    onClick={() => navigate("accounts")}
                  >
                    Accounts
                  </button>
                ) : (
                  <span>Workspace</span>
                )}
                <ChevronRight size={14} />
                <strong>
                  {account
                    ? recordTitle(account)
                    : nav.find((item) => item.view === view)?.label ||
                      (view === "settings"
                        ? "Settings"
                        : titles[view as AmsKind])}
                </strong>
              </div>
              <div>
                <span className={`agency-live ${loading ? "syncing" : ""}`}>
                  <i />
                  {loading ? "Refreshing" : "Connected"}
                </span>
                <button
                  className="agency-icon-button"
                  aria-label="Refresh agency records"
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={16} />
                </button>
                <span className="agency-top-role">
                  {publicDemo ? "Demo · fictional data" : local ? "Local · persistent data" : "Agency workspace"}
                </span>
                <PortalTopActions
                  session={session}
                  openTasks={
                    (book.tasks || []).filter(
                      (r) => statusOf(r, session.timeZone) !== "done",
                    ).length
                  }
                  showTasks={() => navigate("tasks")}
                  showSettings={() => navigate("settings")}
                />
              </div>
            </header>
          )}
          <main id="agency-main" className="agency-main">
            {error && (
              <div className="agency-alert" role="alert">
                {error}
                <button onClick={() => void refresh()}>Retry</button>
              </div>
            )}
            {message && (
              <div className="agency-save-message" role="status">
                <Check size={15} />
                {message}
                <button
                  aria-label="Dismiss saved notification"
                  onClick={() => setMessage("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {demoError && (
              <div className="agency-alert" role="alert">
                {demoError}
                <button disabled={demoBusy} onClick={() => void startDemo()}>
                  Retry demo preparation
                </button>
              </div>
            )}
            {view === "home" ? (
              <HomeView
                book={book}
                session={session}
                open={openRecord}
                navigate={navigate}
                create={setIntent}
                saved={saved}
              />
            ) : view === "inbox" ? (
              <MailboxInbox session={session} book={book} refreshBook={() => void refresh()} openAccount={(id) => navigate(`accounts/${id}`)} />
            ) : view === "reports" ? (
              <Reports book={book} session={session} navigate={navigate} />
            ) : view === "audit" ? (
              <AuditView book={book} />
            ) : view === "suggestions" ? (
              <SuggestionBox book={book} session={session} saved={saved} />
            ) : view === "forms" || view === "formsubmissions" ? (
              <FormsView
                book={book}
                session={session}
                saved={saved}
                route={
                  view === "formsubmissions"
                    ? ["submissions"]
                    : [accountId, accountTab].filter(Boolean)
                }
                navigate={navigate}
              />
            ) : view === "team" ? (
              <TeamPage
                session={session}
                local={local}
                hosted={Boolean(hosted)}
                refresh={() => void refresh()}
                signIn={localSignIn}
              />
            ) : view === "settings" ? (
              <Settings
                session={session}
                setup={workspaceRecord(book)}
                saved={saved}
                navigate={navigate}
                openImport={() => setImporting(true)}
              />
            ) : view === "accounts" &&
              account &&
              (!accountTab || accountTab === "overview") ? (
              <AccountWorkspace
                archive={(kind) => {
                  navigate(`accounts/${account.id}/${kind}`);
                  setStatus("archived");
                }}
                key={`${account.id}:${session.actor.userId}:${session.actor.role}`}
                account={account as AmsRecord<"accounts">}
                book={book}
                session={session}
                edit={setIntent}
                open={openRecord}
                saved={saved}
              />
            ) : (
              <>
                {accountId ? (
                  <>
                    {account ? (
                      <AccountHeader
                        account={account}
                        book={book}
                        session={session}
                        local={local}
                        edit={() =>
                          setIntent({ kind: "accounts", record: account })
                        }
                        back={() => navigate("accounts")}
                      />
                    ) : (
                      <p role="alert">
                        This account is not available in your agency.
                      </p>
                    )}
                    <div
                      className="account-legacy-navigation"
                      aria-label="Account records"
                    >
                      <button
                        className="account-text-button"
                        onClick={() => navigate(`accounts/${accountId}`)}
                      >
                        <ArrowLeft size={15} />
                        Account overview
                      </button>
                      <select
                        aria-label="Account record type"
                        value={activeKind || "policies"}
                        onChange={(event) =>
                          navigate(
                            `accounts/${accountId}/${event.target.value}`,
                          )
                        }
                      >
                        {accountKinds
                          .filter((kind) =>
                            session.readableKinds.includes(kind),
                          )
                          .map((kind) => (
                            <option key={kind} value={kind}>
                              {titles[kind]} ·{" "}
                              {
                                (book[kind] || []).filter((record) =>
                                  sameAccount(
                                    book,
                                    recordAccount(record),
                                    accountId,
                                  ),
                                ).length
                              }
                            </option>
                          ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <PageHeader
                    eyebrow={
                      financeKinds.includes(activeKind!)
                        ? "AGENCY FINANCIALS"
                        : "AGENCY WORKSPACE"
                    }
                    title={
                      view === "financials"
                        ? "Financials"
                        : activeKind
                          ? titles[activeKind]
                          : ""
                    }
                    description={
                      activeKind === "renewals"
                        ? "A clear next step for every expiring relationship."
                        : activeKind === "accounts"
                          ? "The whole client relationship, in one place."
                          : activeKind === "policies"
                            ? "Distinct policy terms, carrier evidence, and a durable transaction history."
                            : activeKind === "invoices"
                              ? "Agency-bill invoicing and a traceable record of receipts and remittances."
                              : `Manage your agency’s ${activeKind ? titles[activeKind].toLowerCase() : ""}.`
                    }
                  />
                )}
                {financeKinds.includes(activeKind!) && !accountId && (
                  <div className="agency-tabs" aria-label="Financial sections">
                    {financeKinds.map((kind) => (
                      <button
                        key={kind}
                        aria-current={activeKind === kind ? "page" : undefined}
                        onClick={() => navigate(kind)}
                      >
                        {titles[kind]}
                      </button>
                    ))}
                  </div>
                )}
                {[
                  "certificates",
                  "certificateholders",
                  "certificatetemplates",
                ].includes(activeKind || "") && (
                  <nav
                    className="agency-tabs"
                    aria-label="Certificate workflow"
                  >
                    {(
                      [
                        "certificates",
                        "certificateholders",
                        "certificatetemplates",
                      ] as const
                    ).map((kind) => (
                      <button
                        key={kind}
                        aria-current={activeKind === kind ? "page" : undefined}
                        onClick={() => navigate(kind)}
                      >
                        {titles[kind]}
                      </button>
                    ))}
                  </nav>
                )}
                {activeKind === "certificatetemplates" && (
                  <CertificateTemplates
                    book={book}
                    session={session}
                    saved={saved}
                  />
                )}
                {activeKind && activeKind !== "certificatetemplates" && (
                  <>
                    <div className="agency-table-toolbar">
                      <PortalStatusTabs
                        kind={activeKind}
                        book={book}
                        accountId={accountId}
                        statusOf={(r) => statusOf(r, session.timeZone)}
                        value={status}
                        onChange={setStatus}
                      />
                      <label className="agency-search">
                        <Search size={17} />
                        <input
                          aria-label={`Search ${titles[activeKind].toLowerCase()}`}
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder={`Search ${titles[activeKind].toLowerCase()}…`}
                        />
                      </label>
                      <select
                        aria-label="Filter by status"
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                      >
                        <option value="all">All active records</option>
                        <option value="archived">Archived records</option>
                        {[
                          ...new Set(
                            (book[activeKind] || [])
                              .map((record) =>
                                statusOf(record, session.timeZone),
                              )
                              .filter(Boolean),
                          ),
                        ]
                          .sort()
                          .map((value) => (
                            <option key={value} value={value}>
                              {human(value)}
                            </option>
                          ))}
                      </select>
                      <div className="agency-toolbar-spacer" />
                      <button
                        className="agency-button quiet"
                        onClick={() => downloadCsv(records, book)}
                      >
                        <ArrowDownToLine size={15} />
                        Export view
                      </button>
                      {writable && (
                        <button
                          className="agency-button primary"
                          onClick={() =>
                            activeKind === "statements"
                              ? setStatementImport(true)
                              : setIntent({ kind: activeKind, accountId })
                          }
                        >
                          <Plus size={16} />
                          {activeKind === "statements"
                            ? "Import statement"
                            : activeKind === "documents"
                              ? "Upload document"
                              : `New ${singular[activeKind]}`}
                        </button>
                      )}
                    </div>
                    {activeKind === "accounts" && !accountId ? (
                      <AccountDirectory
                        saved={saved}
                        records={records}
                        book={book}
                        session={session}
                        open={openRecord}
                      />
                    ) : (
                      <RecordsTable
                        kind={activeKind}
                        records={records}
                        book={book}
                        session={session}
                        open={openRecord}
                      />
                    )}
                  </>
                )}
              </>
            )}
          </main>
          <footer className="agency-workspace-footer">
            <span>
              {brand === "openams" ? "OpenAMS" : "Relay"} · Agency workspace
            </span>
            <span>Every save has a history.</span>
          </footer>
        </div>
        {selected && (
          <RecordDetail
            key={`${selected.kind}:${selected.id}`}
            brand={brand}
            drawer={view === "accounts" && Boolean(account)}
            record={selected}
            book={book}
            session={session}
            close={() => setSelected(null)}
            edit={setIntent}
            saved={saved}
            open={openRecord}
          />
        )}
        {statementImport && (
          <StatementImport
            timeZone={session.timeZone}
            close={() => setStatementImport(false)}
            saved={saved}
          />
        )}
        {importing && (
          <ImportDialog
            close={() => setImporting(false)}
            done={() => void refresh()}
          />
        )}
        {intent && (
          <AgencyEditor
            brand={brand}
            key={`${intent.kind}:${intent.record?.id || "new"}:${intent.action || "edit"}`}
            intent={intent}
            book={book}
            session={session}
            close={() => setIntent(null)}
            saved={saved}
            openAccount={(id) => navigate(`accounts/${id}`)}
          />
        )}
      </div>
      {resetDemo && (
        <Dialog
          open
          onOpenChange={(value) => {
            if (!value && !demoBusy) setResetDemo(false);
          }}
        >
          <DialogContent className="agency-dialog">
            <DialogHeader>
              <DialogTitle>Start a fresh demo?</DialogTitle>
              <DialogDescription>
                {publicDemo
                  ? "Everything you changed in this demo will be deleted, and you'll get a fresh copy of the fictional agency."
                  : "A new fictional agency will replace the current demo view for local demo sessions. Your working agency stays untouched. Earlier demo records remain on this computer."}
              </DialogDescription>
            </DialogHeader>
            <div className="agency-demo-actions">
              <button
                className="agency-button primary"
                disabled={demoBusy}
                onClick={() => void (publicDemo ? openSandbox() : startDemo(true))}
              >
                {demoBusy ? "Preparing…" : "Start fresh demo"}
              </button>
              <button
                className="agency-button"
                disabled={demoBusy}
                onClick={() => setResetDemo(false)}
              >
                Keep current demo
              </button>
            </div>
            {demoError && <p role="alert">{demoError}</p>}
          </DialogContent>
        </Dialog>
      )}
    </WorkspaceProviders>
  );
}
/** Shown while the fictional local demo agency is open. */
function DemoBanner({
  exit,
  restart,
  busy,
  link,
  publicDemo,
}: {
  exit?: () => void;
  restart: () => void;
  busy: boolean;
  link?: { url: string; label: string } | null;
  publicDemo?: boolean;
}) {
  return (
    <div className={`agency-demo-banner${publicDemo ? " public" : ""}`} role={publicDemo ? "status" : undefined}>
      <span>
        <CirclePlay size={15} />
        <span>
          <strong>Demo agency</strong> · Fictional records
          {publicDemo && <> · A private copy for you; please don&apos;t enter real client information</>}
        </span>
      </span>
      <div>
        <button onClick={restart} disabled={busy}>
          <RotateCcw size={13} /> Fresh demo
        </button>
        {exit && (
          <button onClick={exit} disabled={busy}>
            Leave demo <ArrowRight size={13} />
          </button>
        )}
        {link && (
          <a className="agency-demo-link" href={link.url}>
            {link.label} <ArrowRight size={13} />
          </a>
        )}
      </div>
    </div>
  );
}
function Badge({ value }: { value: string }) {
  return (
    <span
      className={`agency-badge ${["active", "done", "completed", "issued", "reconciled", "renewed"].includes(value) ? "green" : ["waiting", "review", "notice", "overdue", "exception", "cancelled", "lost"].includes(value) ? "amber" : ""}`}
    >
      {human(value || "Recorded")}
    </span>
  );
}
function AccountHeader({
  account,
  book,
  session,
  local,
  edit,
  back,
}: {
  account: AmsRecord;
  book: Book;
  session: AgencySession;
  local: boolean;
  edit: () => void;
  back: () => void;
}) {
  const data = account.data as AmsRecord<"accounts">["data"];
  const policies = (book.policies || []).filter((record) =>
    sameAccount(book, recordAccount(record), account.id),
  );
  const manager = session.members.find(
    (member) => member.id === data.serviceOwnerId,
  );
  return (
    <>
      <button className="agency-back" onClick={back}>
        <ArrowLeft size={15} />
        All accounts
      </button>
      <div className="agency-account-hero">
        <span className="agency-account-symbol">
          <Building2 size={28} />
        </span>
        <div>
          <div className="agency-inline">
            <h1>{data.name}</h1>
            <Badge value={data.status} />
          </div>
          <p>
            {data.industry || data.legalName || "Commercial account"}
            {data.address.city
              ? ` · ${data.address.city}, ${data.address.state}`
              : ""}
          </p>
          <div className="agency-account-meta">
            {data.email && <a href={`mailto:${data.email}`}>{data.email}</a>}
            {data.phone && <span>{data.phone}</span>}
            <span>{manager?.name || "Account manager unassigned"}</span>
          </div>
        </div>
        <div className="agency-toolbar-spacer" />
        {session.relayWorkspaceEnabled && (
          <Link
            className="agency-button"
            href={`/accounts?accountId=${encodeURIComponent(account.id)}`}
          >
            Open Relay account
            <ArrowRight size={14} />
          </Link>
        )}
        {session.writableKinds.includes("accounts") && (
          <button className="agency-button" onClick={edit}>
            Edit account
          </button>
        )}
      </div>
      <div className="agency-account-facts">
        <span>
          <strong>{policies.length}</strong>Policy terms
        </span>
        <span>
          <strong>
            {money(
              sum(
                policies.filter(
                  (r) => statusOf(r, session?.timeZone) === "active",
                ),
                "premiumCents",
              ),
            )}
          </strong>
          Recorded active-term premium
        </span>
        <span>
          <strong>{data.source || "Agency created"}</strong>Source
        </span>
        <span>
          <strong>{dateLabel(account.createdAt)}</strong>Account created
        </span>
      </div>
    </>
  );
}
function HomeView({
  book,
  session,
  open,
  navigate,
  create,
  saved,
}: {
  book: Book;
  session: AgencySession;
  open: (r: AmsRecord) => void;
  navigate: (v: string) => void;
  create: (i: EditIntent) => void;
  saved: (records: AmsRecord[]) => void;
}) {
  const date = today(session.timeZone);
  const dueChanges = (book.policychanges || []).filter((r) => {
    const change = r.data as AmsRecord<"policychanges">["data"];
    return change.status === "scheduled" && change.change.effectiveDate <= date;
  });
  const tasks = (book.tasks || []).filter(
    (r) => statusOf(r, session?.timeZone) !== "done",
  );
  const renewals = (book.renewals || []).filter(
    (r) => !["renewed", "lost"].includes(statusOf(r, session?.timeZone)),
  );
  const overdue = tasks.filter((r) => String(dataOf(r).dueDate) < date);
  const owned = tasks.filter((r) => dataOf(r).ownerId === session.actor.userId);
  const service = (book.services || []).filter(
    (r) => statusOf(r, session?.timeZone) !== "completed",
  );
  return (
    <>
      <PortalHome
        book={book}
        session={session}
        open={open}
        navigate={navigate}
        create={create}
      />
      <PageHeader
        eyebrow={new Date()
          .toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })
          .toUpperCase()}
        title="A little clarity for your day."
        description="Your relationships, your renewals, and the work that moves them forward."
      >
        {session.writableKinds.includes("tasks") && (
          <button
            className="agency-button primary"
            onClick={() =>
              create({
                kind: "tasks",
                initial: { ownerId: session.actor.userId },
              })
            }
          >
            <Plus size={16} />
            New task
          </button>
        )}
      </PageHeader>
      {!session.demo && !workspaceRecord(book) && (
        <div className="agency-setup-prompt">
          <Building2 size={20} />
          <div>
            <strong>Save your agency details.</strong>
            <p>
              {session.writableKinds.includes("workspace")
                ? "Set your agency name and calendar in Settings. Due dates and reminders follow that calendar."
                : "An agency administrator or manager sets the agency name and calendar in Settings."}
            </p>
          </div>
          <button className="agency-button" onClick={() => navigate("settings")}>
            Open settings <ArrowRight size={14} />
          </button>
        </div>
      )}
      <RelayAssistantCard session={session} />
      <ReminderQueue book={book} session={session} saved={saved} open={open} />
      {dueChanges.length > 0 && (
        <div className="agency-alert" role="status">
          {dueChanges.length} scheduled endorsement
          {dueChanges.length === 1 ? " is" : "s are"} due for review and
          application.
          <button onClick={() => navigate("policychanges")}>
            Review scheduled changes
          </button>
        </div>
      )}
      <div className="agency-metrics">
        {[
          {
            name: "Open renewals",
            count: renewals.length,
            detail: "Relationships to move forward",
            view: "renewals",
          },
          {
            name: "Tasks assigned to you",
            count: owned.length,
            detail: `${overdue.filter((r) => dataOf(r).ownerId === session.actor.userId).length} past due`,
            view: "tasks",
          },
          {
            name: "Service requests",
            count: service.length,
            detail: "Open across your agency",
            view: "services",
          },
          {
            name: "Accounts",
            count:
              book.accounts?.filter(
                (record) =>
                  !(record as AmsRecord<"accounts">).data.consolidation,
              ).length || 0,
            detail: "One connected book of business",
            view: "accounts",
          },
        ].map((metric) => (
          <button key={metric.name} onClick={() => navigate(metric.view)}>
            <span>
              {metric.name}
              <ArrowRight size={15} />
            </span>
            <strong>{metric.count}</strong>
            <small>{metric.detail}</small>
          </button>
        ))}
      </div>
      <div className="agency-home-columns">
        <section className="agency-panel">
          <div className="agency-section-heading">
            <h2>
              Needs your attention <span>{overdue.length}</span>
            </h2>
            <button onClick={() => navigate("tasks")}>
              All tasks
              <ArrowRight size={14} />
            </button>
          </div>
          {tasks.length ? (
            <div className="agency-work-list">
              {[...tasks]
                .sort((a, b) =>
                  String(dataOf(a).dueDate).localeCompare(
                    String(dataOf(b).dueDate),
                  ),
                )
                .slice(0, 8)
                .map((record) => (
                  <button key={record.id} onClick={() => open(record)}>
                    <span className="agency-task-circle" />
                    <div>
                      <strong>{recordTitle(record)}</strong>
                      <small>
                        {accountName(book, recordAccount(record)) ||
                          "Agency task"}
                      </small>
                    </div>
                    <span
                      className={
                        String(dataOf(record).dueDate) < date
                          ? "agency-overdue"
                          : ""
                      }
                    >
                      {dateLabel(dataOf(record).dueDate)}
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))}
            </div>
          ) : (
            <Empty
              title="A clear starting point"
              detail="Add your first task, assign an owner, and give it a due date."
            />
          )}
        </section>
        <section className="agency-panel">
          <div className="agency-section-heading">
            <h2>Renewals in motion</h2>
            <button onClick={() => navigate("renewals")}>
              View all
              <ArrowRight size={14} />
            </button>
          </div>
          {renewals.length ? (
            <div className="agency-work-list">
              {[...renewals]
                .sort((a, b) =>
                  String(dataOf(a).expirationDate).localeCompare(
                    String(dataOf(b).expirationDate),
                  ),
                )
                .slice(0, 6)
                .map((record) => (
                  <button key={record.id} onClick={() => open(record)}>
                    <span className="agency-mini-icon">
                      <RefreshCw size={17} />
                    </span>
                    <div>
                      <strong>{recordTitle(record)}</strong>
                      <small>
                        {String(
                          dataOf(record).nextAction || "Add a next action",
                        )}
                      </small>
                    </div>
                    <Badge value={statusOf(record, session?.timeZone)} />
                  </button>
                ))}
            </div>
          ) : (
            <Empty
              title="Make room for proactive renewals"
              detail="Create policy terms, then open a renewal case with an owner and a next step."
            />
          )}
        </section>
      </div>
      <div className="agency-get-started">
        <span className="agency-mini-icon">
          <UsersRound size={22} />
        </span>
        <div>
          <h2>Your client relationship starts here.</h2>
          <p>
            Bring together contacts, exposures, policy terms, service work, and
            documents.
          </p>
        </div>
        <button
          className="agency-button"
          onClick={() =>
            session.writableKinds.includes("accounts")
              ? create({ kind: "accounts" })
              : navigate("accounts")
          }
        >
          {session.writableKinds.includes("accounts")
            ? "Add an account"
            : "View accounts"}
          <ArrowRight size={15} />
        </button>
      </div>
    </>
  );
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="agency-empty">
      <FolderOpen size={27} />
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
function RecordsTable({
  kind,
  records,
  book,
  session,
  open,
}: {
  kind: AmsKind;
  records: AmsRecord[];
  book: Book;
  session: AgencySession;
  open: (record: AmsRecord) => void;
}) {
  const finance = financeKinds.includes(kind);
  return (
    <section className="agency-records">
      <div className="agency-table-count">
        {records.length}{" "}
        {records.length === 1 ? singular[kind] : titles[kind].toLowerCase()}
      </div>
      {records.length ? (
        <div className="agency-table-scroll">
          <table>
            <thead>
              <tr>
                <th>
                  {kind === "accounts"
                    ? "Account"
                    : kind === "policies"
                      ? "Policy / line"
                      : titles[kind]}
                </th>
                {kind !== "accounts" && <th>Account</th>}
                <th>
                  {kind === "accounts"
                    ? "Account manager"
                    : finance
                      ? "Amount"
                      : kind === "policies"
                        ? "Carrier"
                        : "Owner / detail"}
                </th>
                <th>
                  {kind === "policies"
                    ? "Term"
                    : kind === "renewals"
                      ? "Expiration"
                      : "Date"}
                </th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => {
                const d = dataOf(record);
                const account = findAccount(book, recordAccount(record));
                const owner = session.members.find(
                  (member) =>
                    member.id ===
                    (d.ownerId || d.serviceOwnerId || d.producerId),
                );
                const amount =
                  kind === "invoices"
                    ? (d.lines as { amountCents: number }[]).reduce(
                        (s, l) => s + l.amountCents,
                        0,
                      )
                    : kind === "statements"
                      ? (d.rows as { commissionCents: number }[]).reduce(
                          (total, row) => total + row.commissionCents,
                          0,
                        )
                      : kind === "commissions"
                        ? Number(d.expectedCents)
                        : kind === "payments"
                          ? Number(d.amountCents)
                          : kind === "journals"
                            ? (d.entries as { debitCents: number }[]).reduce(
                                (s, e) => s + e.debitCents,
                                0,
                              )
                            : 0;
                return (
                  <tr key={record.id}>
                    <td>
                      <button
                        className="agency-record-link"
                        onClick={() => open(record)}
                      >
                        {kind === "accounts" && (
                          <span className="agency-avatar">
                            {recordTitle(record).slice(0, 2).toUpperCase()}
                          </span>
                        )}
                        <span>
                          <strong>{recordTitle(record)}</strong>
                          <small>
                            {String(
                              d.line ||
                                d.industry ||
                                d.nextAction ||
                                d.type ||
                                d.category ||
                                (kind === "notes" ? d.category : "") ||
                                "",
                            )}
                          </small>
                        </span>
                      </button>
                    </td>
                    {kind !== "accounts" && (
                      <td>
                        {account ? (
                          <button
                            className="agency-text-link"
                            onClick={() => open(account)}
                          >
                            {recordTitle(account)}
                            {account.archivedAt && <small>Archived account</small>}
                          </button>
                        ) : (
                          "Agency"
                        )}
                      </td>
                    )}
                    <td>
                      {finance
                        ? money(amount)
                        : kind === "policies"
                          ? String(d.carrier)
                          : owner?.name ||
                            (kind === "documents"
                              ? `${(Number(d.bytes) / 1024).toFixed(0)} KB`
                              : d.email
                                ? String(d.email)
                                : "Unassigned")}
                    </td>
                    <td>
                      {kind === "policies" ? (
                        <>
                          <span>{dateLabel(d.effectiveDate)}</span>
                          <small>to {dateLabel(d.expirationDate)}</small>
                        </>
                      ) : (
                        dateLabel(
                          d.dueDate ||
                            d.expirationDate ||
                            d.dateOfLoss ||
                            d.requestedDate ||
                            d.transactionDate ||
                            d.statementDate ||
                            d.date ||
                            record.updatedAt,
                        )
                      )}
                    </td>
                    <td>
                      <Badge value={statusOf(record, session?.timeZone)} />
                    </td>
                    <td>
                      <button
                        className="agency-icon-button"
                        onClick={() => open(record)}
                        aria-label={`Open ${recordTitle(record)}`}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={`No ${titles[kind].toLowerCase()} here yet`}
          detail="Create a record or adjust your search to get started."
        />
      )}
    </section>
  );
}
function recordActions(
  record: AmsRecord,
  session: AgencySession,
): AmsCommand["action"][] {
  if (record.archivedAt) return ["restore"];
  const status = statusOf(record, session?.timeZone);
  switch (record.kind) {
    case "policies": {
      const policy = record as AmsRecord<"policies">;
      if (policy.data.status === "draft") return ["policy.issue"];
      if (policy.data.status === "cancelled") return ["policy.reinstate"];
      const notice: AmsCommand["action"] = policy.data.nonrenewal
        ? "policy.withdrawNonrenewal"
        : "policy.nonrenew";
      return status === "active" || status === "scheduled"
        ? ["policy.endorse", "policy.renew", "policy.cancel", notice]
        : ["policy.renew", notice];
    }
    case "policychanges":
      return status === "scheduled"
        ? ["policyChange.apply", "policyChange.review", "policyChange.withdraw"]
        : [];
    case "renewals":
      return ["renewed", "lost"].includes(status) ? [] : ["renewal.close"];
    case "tasks":
      return status === "done" && dataOf(record).nextTaskId
        ? []
        : [status === "done" ? "task.reopen" : "task.complete"];
    case "services":
      return status === "completed" ? [] : ["service.complete"];
    case "certificates":
      return status === "issued"
        ? ["certificate.void"]
        : status === "void"
          ? []
          : ["certificate.issue"];
    case "invoices":
      return status === "draft"
        ? ["invoice.post"]
        : status === "posted"
          ? ["payment.record", "invoice.void"]
          : [];
    case "payments":
      return status === "posted" && !dataOf(record).reversedPaymentId
        ? ["payment.reverse"]
        : [];
    case "commissions":
      return status === "reconciled"
        ? ["commission.allocate", "commission.adjust"]
        : ["commission.receive", "commission.allocate", "commission.adjust"];
    case "journals":
      return dataOf(record).sourceKind === "commissions" &&
        !dataOf(record).reversalOf
        ? ["journal.reverseCommission"]
        : [];
    default:
      return [];
  }
}
function editable(record: AmsRecord, session: AgencySession) {
  if (record.archivedAt) return false;
  const status = statusOf(record, session?.timeZone);
  return (
    ![
      "workspace",
      "notes",
      "documents",
      "payments",
      "journals",
      "statements",
      "policychanges",
      "reminders",
      "correspondence",
    ].includes(record.kind) &&
    !(record.kind === "policies" && status !== "draft") &&
    !(record.kind === "invoices" && status !== "draft") &&
    !(record.kind === "certificates" && ["issued", "void"].includes(status)) &&
    !(record.kind === "renewals" && ["renewed", "lost"].includes(status)) &&
    !(record.kind === "tasks" && status === "done") &&
    !(record.kind === "services" && status === "completed") &&
    !(
      record.kind === "commissions" &&
      (Number(dataOf(record).receivedCents) !== 0 ||
        dataOf(record).hasReceipts === true)
    )
  );
}
function RecordDetail({
  drawer = false,
  brand,
  record,
  book,
  session,
  close,
  edit,
  saved,
  open,
}: {
  drawer?: boolean;
  brand: "relay" | "openams";
  record: AmsRecord;
  book: Book;
  session: AgencySession;
  close: () => void;
  edit: (intent: EditIntent) => void;
  saved: (records: AmsRecord[]) => void;
  open: (record: AmsRecord) => void;
}) {
  const [preparing, setPreparing] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement),
  );
  const relatedAccount = findAccount(
    book,
    canonicalAccountId(book, recordAccount(record)),
  );
  const archivedAccount =
    record.kind !== "accounts" && relatedAccount?.archivedAt;
  const writable =
    session.writableKinds.includes(record.kind) && !archivedAccount;
  const d = dataOf(record);
  const actions = writable
    ? recordActions(record, session).filter(
        (action) =>
          (action !== "restore" ||
            ["admin", "manager"].includes(session.actor.role)) &&
          (action !== "journal.reverseCommission" ||
            !(book.journals || []).some(
              (j) => dataOf(j).reversalOf === record.id,
            )),
      )
    : [];
  const shown = Object.entries(d).filter(
    ([key, value]) =>
      record.kind !== "correspondence" &&
      ![
        "rows",
        "storageKey",
        "sha256",
        "policySnapshots",
        "reinstatements",
        "preparation",
        "baseVersion",
        "hasReceipts",
        "leadIds",
        "quoteLeadIds",
        "completedBy",
        "followUp",
        "reminderGeneration",
        "previousTaskId",
        "nextTaskId",
        "queueKey",
        "issuedBy",
        "deliveries",
        "serviceId",
        "previousCertificateId",
        "reissueReason",
      ].includes(key) &&
      value !== null &&
      value !== "" &&
      (!Array.isArray(value) || value.length),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        data-brand={brand}
        className={`agency-dialog agency-detail${drawer ? " account-record-drawer" : ""}`}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{recordTitle(record)}</DialogTitle>
          <DialogDescription>
            {titles[record.kind]} · Revision {record.revision} · Updated{" "}
            {dateLabel(record.updatedAt)}
          </DialogDescription>
        </DialogHeader>
        {archivedAccount && (
          <p className="agency-form-note">
            This account is archived. Restore it from Accounts before changing
            its records. Saved history and documents remain available.
          </p>
        )}
        <PortalRenewalStepper record={record} />
        {preparing && record.kind === "certificates" && (
          <CertificatePreparation
            timeZone={session.timeZone}
            record={record as AmsRecord<"certificates">}
            book={book}
            agency={session.workspaceName}
            close={() => setPreparing(false)}
            saved={saved}
          />
        )}
        {record.kind === "policies" && (
          <p className="agency-form-note">
            Current term status: {human(statusOf(record, session?.timeZone))}.{" "}
            {d.cancellationDate
              ? `Cancellation recorded for ${dateLabel(d.cancellationDate)}. `
              : ""}
            {d.nonrenewal
              ? "A nonrenewal notice is on file; current term dates still apply."
              : ""}
          </p>
        )}
        {record.kind === "policies" && (
          <PolicyHistory policy={record as AmsRecord<"policies">} />
        )}
        {record.kind === "tasks" && (
          <TaskFollowUp
            key={record.id}
            task={record as AmsRecord<"tasks">}
            session={session}
            readOnly={Boolean(archivedAccount)}
            saved={saved}
          />
        )}
        {record.kind === "correspondence" && (
          <CorrespondenceDetail
            record={record as AmsRecord<"correspondence">}
            book={book}
          />
        )}

        <div className="agency-detail-actions">
          {writable &&
            record.kind === "services" &&
            d.type === "certificate" &&
            d.status !== "completed" && (
              <button
                className="agency-button"
                onClick={() =>
                  edit({
                    kind: "certificates",
                    accountId: String(d.accountId),
                    initial: {
                      serviceId: record.id,
                      description: d.description,
                      policyIds: d.policyId ? [String(d.policyId)] : [],
                      requestedDate: today(session.timeZone),
                    },
                  })
                }
              >
                Start certificate request
              </button>
            )}

          {writable &&
            record.kind === "certificates" &&
            !record.archivedAt &&
            ["requested", "review"].includes(String(d.status)) && (
              <button
                className="agency-button"
                onClick={() => setPreparing(true)}
              >
                Prepare certificate
              </button>
            )}
          {record.kind === "certificates" &&
            typeof d.documentId === "string" && (
              <a
                className="agency-button"
                href={`/api/agency/documents/${d.documentId}/content`}
                download
              >
                Download certificate
              </a>
            )}
          {writable && editable(record, session) && (
            <button
              className="agency-button"
              onClick={() => edit({ kind: record.kind, record })}
            >
              Edit record
            </button>
          )}
          {actions.map((action) => (
            <button
              key={action}
              className={`agency-button ${["policy.issue", "task.complete", "invoice.post", "certificate.issue"].includes(action) ? "primary" : ""}`}
              onClick={() =>
                edit({
                  kind: record.kind,
                  record,
                  action,
                  accountId:
                    canonicalAccountId(book, recordAccount(record)) ||
                    undefined,
                  ...(action === "policyChange.review"
                    ? {
                        initial: {
                          policyVersion: book.policies?.find(
                            (p) => p.id === d.policyId,
                          )?.version,
                        },
                      }
                    : {}),
                })
              }
            >
              {actionLabels[action]}
            </button>
          ))}
          {record.kind === "documents" && (
            <a
              className="agency-button primary"
              href={`/api/agency/documents/${record.id}/content`}
              download
            >
              <ArrowDownToLine size={16} />
              Download original
            </a>
          )}
          {writable &&
            [
            "accounts",
            "contacts",
            "exposures",
            "tasks",
            "services",
            "claims",
          ].includes(record.kind) &&
            ["admin", "manager"].includes(session.actor.role) &&
            !record.archivedAt && (
              <button
                className="agency-button quiet"
                onClick={() =>
                  edit({ kind: record.kind, record, action: "archive" })
                }
              >
                Archive
              </button>
            )}
        </div>
        <div className="agency-detail-body">
          {record.kind === "certificates" && (
            <CertificateServicing
              key={record.id}
              record={record as AmsRecord<"certificates">}
              book={book}
              session={session}
              saved={saved}
              edit={edit}
              open={open}
            />
          )}
          {record.kind === "statements" && (
            <StatementReview
              record={record as AmsRecord<"statements">}
              book={book}
              canWrite={writable}
              saved={saved}
              post={() =>
                edit({ kind: "statements", record, action: "statement.post" })
              }
            />
          )}
          <dl>
            {shown.map(([key, value]) => (
              <div key={key}>
                <dt>
                  {human(
                    key
                      .replace(/Cents$/, "")
                      .replace(/Bps$/, " rate")
                      .replace(/Ids?$/, ""),
                  )}
                </dt>
                <dd>
                  <DetailValue
                    field={key}
                    value={value}
                    book={book}
                    session={session}
                  />
                </dd>
              </div>
            ))}
          </dl>
          <RecordRevisions record={record} book={book} session={session} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
function DetailValue({
  field,
  value,
  book,
  session,
}: {
  field: string;
  value: unknown;
  book: Book;
  session: AgencySession;
}): ReactNode {
  if (field.endsWith("Cents")) return money(Number(value));
  if (field.endsWith("Bps")) return `${Number(value) / 100}%`;
  if (field.endsWith("Date") || field.endsWith("At")) return dateLabel(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && field.endsWith("Id")) {
    const member = session.members.find((m) => m.id === value);
    const related = Object.values(book)
      .flat()
      .find((r) => r.id === value);
    return member?.name || (related ? recordTitle(related) : value);
  }
  if (Array.isArray(value))
    return (
      <ul className="agency-value-list">
        {value.map((item, index) => (
          <li key={index}>
            <DetailValue
              field={field.endsWith("Ids") ? field.slice(0, -1) : field}
              value={item}
              book={book}
              session={session}
            />
          </li>
        ))}
      </ul>
    );
  if (value && typeof value === "object")
    return (
      <span className="agency-nested-values">
        {Object.entries(value)
          .filter(([, v]) => v !== "" && v !== null)
          .map(([key, v]) => (
            <span key={key}>
              <small>{human(key.replace(/Cents$/, ""))}</small>
              <DetailValue
                field={key}
                value={v}
                book={book}
                session={session}
              />
            </span>
          ))}
      </span>
    );
  return typeof value === "string"
    ? ["status", "stage", "billing", "priority", "kind", "method"].includes(
        field,
      )
      ? human(value)
      : value
    : String(value ?? "—");
}
function RecordRevisions({
  record,
  book,
  session,
}: {
  record: AmsRecord;
  book: Book;
  session: AgencySession;
}) {
  const [revision, setRevision] = useState<AmsRecord | null>(null);
  const [error, setError] = useState("");
  async function load(value: string) {
    if (!value) {
      setRevision(null);
      return;
    }
    try {
      const result = await request<{ record: AmsRecord }>(
        `records/${record.kind}/${record.id}/revisions/${value}`,
      );
      setRevision(result.record);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load revision.");
    }
  }
  return (
    <section className="agency-revisions">
      <h3>Saved history</h3>
      <p>
        Revisions preserve the record as it was saved. Audit history adds the
        actor, action, and reason.
      </p>
      <select
        aria-label="View saved revision"
        value={revision?.revision || ""}
        onChange={(e) => void load(e.target.value)}
      >
        <option value="">Choose a revision</option>
        {Array.from(
          { length: Math.min(record.revision, 200) },
          (_, i) => record.revision - i,
        ).map((number) => (
          <option key={number} value={number}>
            Revision {number}
          </option>
        ))}
      </select>
      {error && <p role="alert">{error}</p>}
      {revision && (
        <>
          <p>
            Saved {dateLabel(revision.updatedAt)} by{" "}
            {session.members.find((m) => m.id === revision.updatedBy)?.name ||
              revision.updatedBy}
          </p>
          <DetailValue
            field="revision"
            value={revision.data}
            book={book}
            session={session}
          />
        </>
      )}
    </section>
  );
}
function AuditView({ book }: { book: Book }) {
  const [items, setItems] = useState<AmsAudit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    request<AmsPage<AmsAudit>>(
      `audit?limit=50${account ? `&accountId=${account}` : ""}`,
      { signal: abort.signal },
    )
      .then((page) => {
        setItems(page.items);
        setCursor(page.nextCursor);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [account]);
  async function more() {
    setBusy(true);
    try {
      const page = await request<AmsPage<AmsAudit>>(
        `audit?limit=50&before=${cursor}${account ? `&accountId=${account}` : ""}`,
      );
      setItems((previous) => [...previous, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load history.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="ACCOUNTABILITY"
        title="A history you can follow."
        description="Who changed what, when, and why. Financial events follow your role’s access."
      />
      <label className="agency-audit-filter">
        Account
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">All agency activity</option>
          {book.accounts?.map((r) => (
            <option key={r.id} value={r.id}>
              {recordTitle(r)}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="agency-audit-list">
        {items.map((event) => (
          <article key={event.id}>
            <span className="agency-audit-dot">
              <History size={16} />
            </span>
            <div>
              <strong>
                {actionLabels[event.action] || human(event.action)}{" "}
                <span>by {event.actorName}</span>
              </strong>
              <p>
                {event.records
                  .map((r) => `${singular[r.kind]} · revision ${r.revision}`)
                  .join(" · ")}
              </p>
              {event.reason && <blockquote>{event.reason}</blockquote>}
              <small>
                {new Date(event.at).toLocaleString()} · Event {event.sequence}
              </small>
            </div>
          </article>
        ))}
      </div>
      {cursor && (
        <button
          className="agency-button"
          onClick={() => void more()}
          disabled={busy}
        >
          {busy ? "Loading…" : "Load earlier activity"}
        </button>
      )}
      {!items.length && !error && (
        <Empty
          title="Your history starts with your first save"
          detail="Changes are recorded automatically."
        />
      )}
    </>
  );
}
function Reports({
  book,
  session,
  navigate,
}: {
  book: Book;
  session: AgencySession;
  navigate: (value: string) => void;
}) {
  const policies = (book.policies || []).filter(
    (r) => statusOf(r, session?.timeZone) === "active",
  );
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const record of book.journals || [])
    for (const entry of (record.data as AmsRecord<"journals">["data"])
      .entries) {
      const value = totals.get(entry.ledgerAccount) || { debit: 0, credit: 0 };
      value.debit += entry.debitCents;
      value.credit += entry.creditCents;
      totals.set(entry.ledgerAccount, value);
    }
  const ar = (book.invoices || []).filter(
    (r) => statusOf(r, session?.timeZone) === "posted",
  );
  const outstanding = ar.reduce(
    (total, r) =>
      total +
      (r.data as AmsRecord<"invoices">["data"]).lines.reduce(
        (s, l) => s + l.amountCents,
        0,
      ) -
      Number(dataOf(r).paidCents),
    0,
  );
  const renewed = (book.renewals || []).filter(
    (r) => statusOf(r, session?.timeZone) === "renewed",
  ).length;
  const lost = (book.renewals || []).filter(
    (r) => statusOf(r, session?.timeZone) === "lost",
  ).length;
  return (
    <>
      <PageHeader
        eyebrow="YOUR BOOK, IN FOCUS"
        title="Agency reports"
        description="Calculated from saved agency records. Active status reflects recorded carrier activity; review effective dates when assessing coverage."
      />
      <div className="agency-metrics">
        <button onClick={() => navigate("policies")}>
          <span>Active-term premium</span>
          <strong className="agency-money-metric">
            {money(sum(policies, "premiumCents"))}
          </strong>
          <small>{policies.length} recorded active terms</small>
        </button>
        <button onClick={() => navigate("renewals")}>
          <span>Completed-case retention</span>
          <strong>
            {renewed + lost
              ? `${Math.round((100 * renewed) / (renewed + lost))}%`
              : "—"}
          </strong>
          <small>
            {renewed} renewed · {lost} lost
          </small>
        </button>
        {book.invoices && (
          <button onClick={() => navigate("invoices")}>
            <span>Accounts receivable</span>
            <strong className="agency-money-metric">
              {money(outstanding)}
            </strong>
            <small>Posted invoices less recorded receipts</small>
          </button>
        )}
        {book.commissions && (
          <button onClick={() => navigate("commissions")}>
            <span>Unreconciled direct-bill commission</span>
            <strong className="agency-money-metric">
              {money(
                sum(book.commissions, "expectedCents") -
                  sum(book.commissions, "receivedCents"),
              )}
            </strong>
            <small>Expected less recorded commission</small>
          </button>
        )}
      </div>
      {book.journals && (
        <section className="agency-panel">
          <div className="agency-section-heading">
            <h2>Ledger totals</h2>
            <button onClick={() => downloadCsv(book.journals || [], book)}>
              Export journal
              <ArrowDownToLine size={14} />
            </button>
          </div>
          <div className="agency-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Debits</th>
                  <th>Credits</th>
                  <th>Net debit / (credit)</th>
                </tr>
              </thead>
              <tbody>
                {[...totals].map(([key, value]) => (
                  <tr key={key}>
                    <td>{human(key)}</td>
                    <td>{money(value.debit)}</td>
                    <td>{money(value.credit)}</td>
                    <td>{money(value.debit - value.credit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th>
                    {money(
                      [...totals.values()].reduce((s, v) => s + v.debit, 0),
                    )}
                  </th>
                  <th>
                    {money(
                      [...totals.values()].reduce((s, v) => s + v.credit, 0),
                    )}
                  </th>
                  <th>
                    {money(
                      [...totals.values()].reduce(
                        (s, v) => s + v.debit - v.credit,
                        0,
                      ),
                    )}
                  </th>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="agency-form-note">
            This ledger covers transactions recorded here. Bank reconciliation,
            opening balances, producer settlements, and period close remain
            prerequisites for replacing agency accounting.
          </p>
        </section>
      )}
      {book.commissions && (
        <ProducerReport records={book.commissions} session={session} />
      )}
      <section className="agency-panel agency-report-quality">
        <h2>Book quality</h2>
        <p>
          {
            (book.accounts || []).filter((r) => !dataOf(r).serviceOwnerId)
              .length
          }{" "}
          accounts without an account manager
        </p>
        <p>
          {
            (book.renewals || []).filter(
              (r) =>
                !["renewed", "lost"].includes(statusOf(r, session?.timeZone)) &&
                !dataOf(r).nextAction,
            ).length
          }{" "}
          open renewals without a next action
        </p>
        <p>
          {
            (book.policies || []).filter(
              (r) =>
                statusOf(r, session?.timeZone) === "active" &&
                String(dataOf(r).expirationDate) < today(session.timeZone),
            ).length
          }{" "}
          recorded active policies past their expiration date
        </p>
      </section>
    </>
  );
}
function Settings({
  session,
  setup,
  saved,
  navigate,
  openImport,
}: {
  session: AgencySession;
  setup?: AmsRecord<"workspace">;
  saved: (records: AmsRecord[]) => void;
  navigate: (path: string) => void;
  openImport: () => void;
}) {
  const active = session.members.filter((member) => member.active).length;
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE SETTINGS"
        title="Make it your agency."
        description="Your agency calendar, team and existing book."
      />
      <BrandSchemePicker />
      <section className="agency-panel agency-settings">
        <h2>Agency details and calendar</h2>
        <p>
          Policy status, due dates and financial dates follow{" "}
          {session.timeZone || "UTC"}.
        </p>
        <AgencyProfileForm
          key={setup?.version || "new"}
          setup={setup}
          session={session}
          saved={saved}
        />
        <h2>Agency team</h2>
        <p>
          {active} active {active === 1 ? "member" : "members"}.{" "}
          {["admin", "manager"].includes(session.actor.role)
            ? "Invite teammates, change roles and remove access on the Team page."
            : "See who works here and what each role can do on the Team page."}
        </p>
        <button className="agency-button" onClick={() => navigate("team")}>
          <Users size={16} />
          Open team
        </button>
        <h2>Bring your existing book</h2>
        <p>
          Bring over accounts, policy terms, contacts, exposure schedules,
          historical notes and open tasks. Review the mapped rows and totals,
          import, then download the reconciliation. Stable source IDs make
          interrupted batches safe to retry.
        </p>
        {["admin", "manager"].includes(session.actor.role) && (
          <button className="agency-button" onClick={openImport}>
            <Plus size={16} />
            Import agency records
          </button>
        )}
        <h2>Your records belong to you</h2>
        <p>
          Download versioned records as JSON. Original document files can be
          downloaded from their account. This export is not a point-in-time
          backup.
        </p>
        {["admin", "manager"].includes(session.actor.role) && (
          <a className="agency-button" href="/api/agency/export" download>
            <ArrowDownToLine size={16} />
            Export agency records
          </a>
        )}
        <h2>Replacement readiness</h2>
        <p>
          Core records and the workflows shown here are implemented. Carrier
          downloads, native licensed certificate forms, mailbox synchronization,
          migration reconciliation, full agency accounting, and recovery
          operations need completion and an agency pilot before cutover.
        </p>
      </section>
    </>
  );
}
function downloadCsv(records: AmsRecord[], book: Book) {
  const escape = (value: unknown) => {
    let text =
      typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const keys = [
    ...new Set(records.flatMap((record) => Object.keys(record.data))),
  ].filter((key) => !["storageKey", "policySnapshots"].includes(key));
  const rows = [
    ["ID", "Revision", "Account", ...keys.map(human)],
    ...records.map((record) => [
      record.id,
      record.revision,
      accountName(book, recordAccount(record)),
      ...keys.map((key) => dataOf(record)[key]),
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob(
      ["\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n")],
      { type: "text/csv;charset=utf-8" },
    ),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `agency-${records[0]?.kind || "records"}-${today()}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ProducerReport({
  records,
  session,
}: {
  records: AmsRecord[];
  session: AgencySession;
}) {
  const totals = new Map<
    string,
    { expected: number; received: number; share: number }
  >();
  for (const record of records) {
    const data = record.data as AmsRecord<"commissions">["data"];
    const id = data.producerId || "unassigned";
    const row = totals.get(id) || { expected: 0, received: 0, share: 0 };
    row.expected += data.expectedCents;
    row.received += data.receivedCents;
    row.share += amsBasisPoints(data.receivedCents, data.producerShareBps);
    totals.set(id, row);
  }
  return (
    <section className="agency-panel agency-producer-report">
      <div className="agency-section-heading">
        <h2>Producer commission allocation</h2>
        <small>All recorded transactions</small>
      </div>
      <div className="agency-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Producer</th>
              <th>Expected agency commission</th>
              <th>Received agency commission</th>
              <th>Calculated producer share</th>
            </tr>
          </thead>
          <tbody>
            {[...totals].map(([id, row]) => (
              <tr key={id}>
                <td>
                  {session.members.find((member) => member.id === id)?.name ||
                    "Unassigned"}
                </td>
                <td>{money(row.expected)}</td>
                <td>{money(row.received)}</td>
                <td>{money(row.share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="agency-form-note">
        Calculated from recorded receipts and each transaction’s saved producer
        share. Returns reduce the allocation. This report does not record a
        producer payout.
      </p>
    </section>
  );
}
