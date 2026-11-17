"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Check,
  Download,
  Inbox,
  Mail,
  RefreshCw,
} from "lucide-react";
import type {
  AmsIncomingMessage,
  AmsMailbox,
  AmsMailboxFolderPage,
  AmsMailboxList,
  AmsMailboxMessageStatus,
  AmsMailboxProvider,
  AmsPage,
  AmsRecord,
} from "@openams/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "./page-header";
import { Picker } from "./picker";
import { sameAccount } from "./account-identity-model";
import {
  dateLabel,
  findAccount,
  human,
  recordTitle,
  request,
  type AgencySession,
  type Book,
} from "./model";
import "./mailbox-inbox.css";

const providerName = (provider: AmsMailboxProvider) =>
  provider === "gmail" ? "Gmail" : "Microsoft 365";
const post = <T,>(path: string, body: unknown = {}) =>
  request<T>(`mailboxes/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The mailbox request failed. Try again.";
const statuses: { value: AmsMailboxMessageStatus; label: string }[] = [
  { value: "review", label: "Needs review" },
  { value: "filing", label: "Filing in progress" },
  { value: "error", label: "Import issues" },
  { value: "unavailable", label: "Unavailable" },
  { value: "filed", label: "Filed" },
  { value: "dismissed", label: "Dismissed" },
];

export function MailboxInbox({
  session,
  book,
  refreshBook,
  openAccount,
}: {
  session: AgencySession;
  book: Book;
  refreshBook: () => void;
  openAccount: (id: string) => void;
}) {
  const [connections, setConnections] = useState<AmsMailboxList | null>(null);
  const [messages, setMessages] = useState<AmsPage<AmsIncomingMessage>>({
    items: [],
    nextCursor: null,
  });
  const [status, setStatus] = useState<AmsMailboxMessageStatus>("review");
  const [connectionId, setConnectionId] = useState("");
  const [selected, setSelected] = useState<AmsIncomingMessage | null>(null);
  const [folder, setFolder] = useState<AmsMailbox | null>(null);
  const [history, setHistory] = useState<AmsMailbox | null>(null);
  const [disconnect, setDisconnect] = useState<AmsMailbox | null>(null);
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const stopSync = useRef(false);
  const manager = ["admin", "manager"].includes(session.actor.role);
  const canReview =
    session.writableKinds.includes("correspondence") &&
    session.mailboxReviewEnabled;
  const reload = () => setGeneration((n) => n + 1);
  const query = new URLSearchParams({
    status,
    ...(connectionId ? { connectionId } : {}),
  }).toString();
  useEffect(() => {
    if (!canReview) return;
    const abort = new AbortController();
    request<AmsMailboxList>("mailboxes", { signal: abort.signal })
      .then(setConnections)
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorText(e));
      });
    return () => abort.abort();
  }, [canReview, generation]);
  useEffect(() => {
    if (!canReview) return;
    const abort = new AbortController();
    setLoading(true);
    request<AmsPage<AmsIncomingMessage>>(`mailboxes/messages?${query}`, {
      signal: abort.signal,
    })
      .then((value) => {
        if (!abort.signal.aborted) setMessages(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [canReview, query, generation]);
  useEffect(
    () => () => {
      stopSync.current = true;
    },
    [],
  );

  async function run(key: string, action: () => Promise<void>, refresh = true) {
    if (busy) return;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
      if (refresh) reload();
    }
  }
  async function connect(provider: AmsMailboxProvider) {
    await run(`connect:${provider}`, async () => {
      const result = await post<{ authorizationUrl: string }>("connect", {
        provider,
      });
      const url = new URL(result.authorizationUrl);
      if (
        url.protocol !== "https:" ||
        !["accounts.google.com", "login.microsoftonline.com"].includes(
          url.hostname,
        )
      )
        throw new Error("The provider authorization address was invalid.");
      window.location.assign(url.toString());
    });
  }
  async function sync(connection: AmsMailbox) {
    stopSync.current = false;
    await run(`sync:${connection.id}`, async () => {
      let imported = 0,
        more = true;
      // A bounded series keeps the page responsive; the server retains every unfinished page.
      for (let batch = 0; batch < 10 && more && !stopSync.current; batch++) {
        const result = await post<{ connection: AmsMailbox; imported: number }>(
          `${connection.id}/sync`,
        );
        imported += result.imported;
        more = result.connection.hasMore;
        setConnections((current) =>
          current
            ? {
                ...current,
                items: current.items.map((c) =>
                  c.id === result.connection.id ? result.connection : c,
                ),
              }
            : current,
        );
        setNotice(
          `${imported} messages added to the review queue${more ? "; checking the next batch…" : "."}`,
        );
      }
      setNotice(
        `${imported} messages added to the review queue. ${more ? "More messages remain; choose Continue sync when ready." : "The selected folder is up to date as of this sync."}`,
      );
    });
  }
  if (!canReview)
    return (
      <div className="agency-alert" role="alert">
        Incoming mail is available to agency members who can file
        correspondence.
      </div>
    );
  return (
    <div className="mailbox-page">
      <PageHeader
        eyebrow="Agency servicing"
        title="Incoming mail"
        description="Review carrier updates, keep the original evidence, and file each message to the right account."
      >
        <button
          className="agency-button"
          disabled={Boolean(busy)}
          onClick={() => {
            setError("");
            reload();
          }}
        >
          <RefreshCw size={15} /> Refresh queue
        </button>
      </PageHeader>
      {error && (
        <div className="agency-alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="agency-save-message" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      <section
        className="agency-panel mailbox-connections"
        aria-labelledby="mailbox-connections-title"
      >
        <div className="mailbox-section-title">
          <div>
            <h2 id="mailbox-connections-title">Agency mailboxes</h2>
            <p>
              Read-only access. Sync runs when you request it; your mailbox is
              never marked read, moved, or sent from here.
            </p>
          </div>
          {manager && (
            <div className="mailbox-actions">
              {connections?.providers.map(({ provider, configured }) => (
                <button
                  key={provider}
                  className="agency-button"
                  disabled={Boolean(busy) || !configured}
                  title={
                    configured
                      ? `Authorize ${providerName(provider)} read access`
                      : `${providerName(provider)} requires deployment setup`
                  }
                  onClick={() => void connect(provider)}
                >
                  <Mail size={15} />
                  Connect {providerName(provider)}
                </button>
              ))}
            </div>
          )}
        </div>
        {manager && connections?.providers.some((p) => !p.configured) && (
          <p className="mailbox-muted">
            {connections.providers
              .filter((p) => !p.configured)
              .map((p) => providerName(p.provider))
              .join(" and ")}{" "}
            connection setup is not configured. Your deployment administrator
            must register the mailbox applications before these buttons are
            available.
          </p>
        )}
        {!connections ? (
          <p role="status">Loading mailbox connections…</p>
        ) : !connections.items.length ? (
          <div className="mailbox-connect-empty">
            <Inbox size={26} />
            <div>
              <strong>No mailboxes connected</strong>
              <p>
                Choose an agency folder after authorization. Only messages you
                explicitly file become account correspondence.
              </p>
              <p>
                You can also upload an original .eml file from an account’s
                Activity tab.
              </p>
            </div>
          </div>
        ) : (
          <div className="mailbox-connection-grid">
            {connections.items.map((connection) => (
              <article key={connection.id} className="mailbox-connection">
                <div className="mailbox-connection-heading">
                  <Mail size={18} />
                  <div>
                    <strong>{connection.address}</strong>
                    <small>
                      {providerName(connection.provider)} ·{" "}
                      {connection.state === "connected"
                        ? "Read access authorized"
                        : connection.state === "choose_folder"
                          ? "Choose a folder to start"
                          : "Disconnected"}
                    </small>
                  </div>
                </div>
                {connection.folder && (
                  <p>
                    <strong>{connection.folder.name}</strong> · From{" "}
                    {dateLabel(connection.folder.since)} (UTC)
                  </p>
                )}
                <p className="mailbox-muted">
                  {connection.lastSyncedAt
                    ? `Last complete sync: ${new Date(connection.lastSyncedAt).toLocaleString()}`
                    : "No complete sync yet."}
                </p>
                {connection.error && (
                  <p className="mailbox-issue">{connection.error.message}</p>
                )}
                {connection.nextAttemptAt && (
                  <p className="mailbox-muted">
                    Retry after{" "}
                    {new Date(connection.nextAttemptAt).toLocaleString()}.
                  </p>
                )}
                <div className="mailbox-actions">
                  {connection.state === "connected" && (
                    <button
                      className="agency-button primary"
                      disabled={Boolean(busy) || connection.syncing}
                      onClick={() => void sync(connection)}
                    >
                      <RefreshCw size={14} />
                      {busy === `sync:${connection.id}`
                        ? "Syncing…"
                        : connection.hasMore
                          ? "Continue sync"
                          : "Sync now"}
                    </button>
                  )}
                  {busy === `sync:${connection.id}` && (
                    <button
                      className="agency-button"
                      onClick={() => {
                        stopSync.current = true;
                        setNotice(
                          "Stopping after the current batch. Its position will be saved.",
                        );
                      }}
                    >
                      Stop after this batch
                    </button>
                  )}
                  {manager && connection.state !== "disconnected" && (
                    <button
                      className="agency-button"
                      disabled={Boolean(busy) || connection.syncing}
                      onClick={() => setFolder(connection)}
                    >
                      {connection.folder ? "Change folder" : "Choose folder"}
                    </button>
                  )}
                  {manager &&
                    connection.error?.code === "mailbox_sync_reset" && (
                      <button
                        className="agency-button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run("reset", async () => {
                            await post(`${connection.id}/reset`, {
                              expectedRevision: connection.revision,
                            });
                            setNotice(
                              "Sync reset. Retained messages and review decisions are unchanged; choose Continue sync.",
                            );
                          })
                        }
                      >
                        Restart sync
                      </button>
                    )}
                  {manager && connection.state !== "disconnected" && (
                    <button
                      className="agency-button"
                      disabled={Boolean(busy)}
                      onClick={() => setDisconnect(connection)}
                    >
                      Disconnect
                    </button>
                  )}
                  {manager && (
                    <button
                      className="agency-button"
                      disabled={Boolean(busy)}
                      onClick={() => setHistory(connection)}
                    >
                      History
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        {connections?.nextCursor && (
          <button
            className="agency-button"
            disabled={Boolean(busy)}
            onClick={() =>
              void run(
                "connections",
                async () => {
                  const next = await request<AmsMailboxList>(
                    `mailboxes?cursor=${encodeURIComponent(connections.nextCursor!)}`,
                  );
                  setConnections({
                    ...next,
                    items: [...connections.items, ...next.items],
                  });
                },
                false,
              )
            }
          >
            More mailboxes
          </button>
        )}
      </section>
      <section
        className="agency-panel mailbox-queue"
        aria-labelledby="mailbox-queue-title"
      >
        <div className="mailbox-section-title">
          <h2 id="mailbox-queue-title">Review queue</h2>
          <div className="mailbox-filters">
            <label>
              Show
              <select
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value as AmsMailboxMessageStatus)
                }
              >
                {statuses.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mailbox
              <select
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
              >
                <option value="">All mailboxes</option>
                {connections?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.address} · {providerName(c.provider)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {loading ? (
          <p className="mailbox-empty" role="status">
            Loading messages…
          </p>
        ) : !messages.items.length ? (
          <div className="mailbox-empty">
            <Inbox size={28} />
            <h3>
              {status === "review"
                ? "No messages waiting for review"
                : `No ${statuses.find((s) => s.value === status)?.label.toLowerCase()} messages`}
            </h3>
            <p>
              {status === "review"
                ? "Sync a connected folder to bring in new carrier updates."
                : "Choose another queue to review incoming correspondence."}
            </p>
          </div>
        ) : (
          <div className="mailbox-message-list">
            {messages.items.map((message) => (
              <button
                key={message.id}
                className="mailbox-message-row"
                onClick={() => setSelected(message)}
              >
                <Mail size={18} />
                <div>
                  <strong>{message.subject}</strong>
                  <span>{message.from || "Sender unavailable"}</span>
                  <small>
                    {message.attachmentCount
                      ? `${message.attachmentCount} attachment${message.attachmentCount === 1 ? "" : "s"} · `
                      : ""}
                    {statuses.find((s) => s.value === message.status)?.label}
                  </small>
                </div>
                <time dateTime={message.receivedAt ?? message.queuedAt}>
                  {dateLabel(message.receivedAt ?? message.queuedAt)}
                </time>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        )}
        {!loading && messages.nextCursor && (
          <button
            className="agency-button mailbox-more"
            disabled={Boolean(busy)}
            onClick={() =>
              void run(
                "more",
                async () => {
                  const next = await request<AmsPage<AmsIncomingMessage>>(
                    `mailboxes/messages?${query}&cursor=${encodeURIComponent(messages.nextCursor!)}`,
                  );
                  setMessages({
                    ...next,
                    items: [...messages.items, ...next.items],
                  });
                },
                false,
              )
            }
          >
            More messages
          </button>
        )}
      </section>
      {selected && (
        <MessageReview
          key={selected.id}
          message={selected}
          mailbox={connections?.items.find(
            (c) => c.id === selected.connectionId,
          )}
          book={book}
          close={() => setSelected(null)}
          openAccount={openAccount}
          changed={(value) => {
            setSelected(value);
            reload();
            if (value.status === "filed") refreshBook();
          }}
        />
      )}
      {folder && (
        <FolderSelection
          mailbox={folder}
          close={() => setFolder(null)}
          saved={() => {
            setFolder(null);
            reload();
            setNotice(
              "Folder selected. Choose Sync now to import messages for agency review.",
            );
          }}
        />
      )}
      {history && (
        <MailboxHistory mailbox={history} close={() => setHistory(null)} />
      )}
      {disconnect && (
        <Dialog open onOpenChange={() => setDisconnect(null)}>
          <DialogContent className="agency-dialog mailbox-dialog">
            <DialogHeader>
              <DialogTitle>Disconnect {disconnect.address}?</DialogTitle>
              <DialogDescription>
                This stops importing and removes stored credentials. Incoming
                and filed messages remain available. You can separately revoke
                the application’s consent in your mailbox account.
              </DialogDescription>
            </DialogHeader>
            <div className="mailbox-actions">
              <button
                className="agency-button"
                onClick={() => setDisconnect(null)}
              >
                Keep connected
              </button>
              <button
                className="agency-button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("disconnect", async () => {
                    await post(`${disconnect.id}/disconnect`, {
                      expectedRevision: disconnect.revision,
                    });
                    setDisconnect(null);
                    setNotice(
                      "Mailbox disconnected. Retained messages remain available.",
                    );
                  })
                }
              >
                Disconnect mailbox
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function FolderSelection({
  mailbox,
  close,
  saved,
}: {
  mailbox: AmsMailbox;
  close: () => void;
  saved: () => void;
}) {
  const [page, setPage] = useState<AmsMailboxFolderPage>({
    folders: [],
    next: null,
  });
  const [parents, setParents] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [since, setSince] = useState(
    mailbox.folder?.since.slice(0, 10) ??
      new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
  );
  const [share, setShare] = useState(false),
    [replace, setReplace] = useState(false);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const parentId = parents.at(-1)?.id;
  const folderRequest = useRef<{
    key: string;
    result: Promise<AmsMailboxFolderPage>;
  } | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const key = `${mailbox.id}:${parentId ?? "root"}`;
    // Strict Mode may mount effects twice. Share this component's one in-flight
    // read so it does not race the server's credential-refresh/sync lease.
    if (folderRequest.current?.key !== key)
      folderRequest.current = {
        key,
        result: post<AmsMailboxFolderPage>(
          `${mailbox.id}/folders`,
          parentId ? { parentId } : {},
        ),
      };
    folderRequest.current.result
      .then((value) => {
        if (active) setPage(value);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mailbox.id, parentId]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected || !share || saving) return;
    setSaving(true);
    setError("");
    try {
      await post(`${mailbox.id}/select-folder`, {
        folderId: selected.id,
        since: `${since}T00:00:00.000Z`,
        shareWithAgency: true,
        ...(mailbox.folder ? { replaceSelection: replace } : {}),
      });
      saved();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="agency-dialog mailbox-dialog">
        <DialogHeader>
          <DialogTitle>Choose an agency folder</DialogTitle>
          <DialogDescription>
            Messages from this folder become visible to agency staff for review.
            Choose a folder or label used for agency work.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="mailbox-form">
          {error && (
            <div className="agency-alert" role="alert">
              {error}
            </div>
          )}
          {parents.length > 0 && (
            <button
              type="button"
              className="agency-button"
              disabled={loading || saving}
              onClick={() => setParents((p) => p.slice(0, -1))}
            >
              Back from {parents.at(-1)!.name}
            </button>
          )}
          {loading ? (
            <p role="status">Loading folders…</p>
          ) : (
            <fieldset className="mailbox-folders">
              <legend>
                {parentId
                  ? parents.at(-1)!.name
                  : providerName(mailbox.provider) === "Gmail"
                    ? "Labels"
                    : "Folders"}
              </legend>
              {page.folders.length ? (
                page.folders.map((f) => (
                  <div key={f.id}>
                    <label>
                      <input
                        type="radio"
                        name="mailbox-folder"
                        checked={selected?.id === f.id}
                        onChange={() => {
                          setSelected(f);
                          setShare(false);
                        }}
                        disabled={saving}
                      />
                      {f.name}
                    </label>
                    {f.hasChildren && (
                      <button
                        type="button"
                        className="agency-button"
                        disabled={saving}
                        aria-label={`Open subfolders of ${f.name}`}
                        onClick={() => setParents((p) => [...p, f])}
                      >
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <p>No folders found here.</p>
              )}
            </fieldset>
          )}
          {page.next && !loading && (
            <button
              type="button"
              className="agency-button"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  const next = await post<AmsMailboxFolderPage>(
                    `${mailbox.id}/folders`,
                    { ...(parentId ? { parentId } : {}), next: page.next },
                  );
                  setPage({
                    ...next,
                    folders: [...page.folders, ...next.folders],
                  });
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setSaving(false);
                }
              }}
            >
              More folders
            </button>
          )}
          {selected && (
            <p>
              Selected: <strong>{selected.name}</strong>
            </p>
          )}
          <label className="mailbox-field">
            Messages received on or after (UTC)
            <input
              type="date"
              value={since}
              max={new Date().toISOString().slice(0, 10)}
              required
              disabled={saving}
              onChange={(e) => {
                setSince(e.target.value);
                setShare(false);
              }}
            />
          </label>
          <label className="mailbox-checkbox">
            <input
              type="checkbox"
              checked={share}
              onChange={(e) => setShare(e.target.checked)}
              disabled={saving}
            />
            Share messages and attachments from this folder with agency staff
            for review.
          </label>
          {mailbox.folder && (
            <label className="mailbox-checkbox">
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
                disabled={saving}
              />
              Replace the current folder or start date and retain messages
              already imported.
            </label>
          )}
          <div className="mailbox-actions">
            <button type="button" className="agency-button" onClick={close}>
              Cancel
            </button>
            <button
              className="agency-button primary"
              disabled={
                loading ||
                saving ||
                !selected ||
                !share ||
                Boolean(mailbox.folder && !replace)
              }
            >
              {saving ? "Saving…" : "Use this folder"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MessageReview({
  message,
  mailbox,
  book,
  close,
  changed,
  openAccount,
}: {
  message: AmsIncomingMessage;
  mailbox?: AmsMailbox;
  book: Book;
  close: () => void;
  changed: (message: AmsIncomingMessage) => void;
  openAccount: (id: string) => void;
}) {
  const [accountId, setAccountId] = useState<string | null>(message.accountId);
  const [policyId, setPolicyId] = useState<string | null>(message.policyId);
  const [direction, setDirection] = useState(message.direction);
  const [share, setShare] = useState(false),
    [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const accounts = (book.accounts ?? []).filter(
    (a) => !a.archivedAt && !(a as AmsRecord<"accounts">).data.consolidation,
  );
  const account =
    message.status === "filing"
      ? findAccount(book, accountId)
      : accounts.find((a) => a.id === accountId);
  const policies = (book.policies ?? []).filter(
    (p) =>
      !p.archivedAt &&
      sameAccount(book, (p as AmsRecord<"policies">).data.accountId, accountId),
  );
  const pending = message.status === "filing",
    review = message.status === "review" || pending;
  async function action(path: string, body: unknown) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      changed(
        await post<AmsIncomingMessage>(`messages/${message.id}/${path}`, body),
      );
      setDismissing(false);
    } catch (e) {
      setError(errorText(e));
      // Validation can return a pending filing to review with a new revision.
      // Refresh the open item so the reviewer can correct it without reopening.
      try {
        changed(
          await request<AmsIncomingMessage>(`mailboxes/messages/${message.id}`),
        );
      } catch {
        /* Keep the original action error. */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="agency-dialog mailbox-dialog mailbox-review">
        <DialogHeader>
          <DialogTitle>{message.subject}</DialogTitle>
          <DialogDescription>
            {mailbox
              ? `${providerName(mailbox.provider)} · ${mailbox.address}`
              : "Incoming agency message"}{" "}
            · {statuses.find((s) => s.value === message.status)?.label}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="agency-alert" role="alert">
            {error}
          </div>
        )}
        {message.error && (
          <div className="agency-alert" role="alert">
            {message.error.message}
          </div>
        )}
        <dl className="mailbox-envelope">
          <div>
            <dt>From</dt>
            <dd>{message.from || "Unavailable"}</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>{message.to || "Unavailable"}</dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd>
              {message.receivedAt
                ? new Date(message.receivedAt).toLocaleString()
                : "Unavailable"}
            </dd>
          </div>
        </dl>
        <pre className="mailbox-preview">
          {message.body ||
            "No readable text preview. Download the retained original to review the message."}
        </pre>
        {message.bodyTruncated && (
          <p className="mailbox-muted">
            Preview shortened. The original contains the complete message.
          </p>
        )}
        {message.originalAvailable && (
          <div className="mailbox-original">
            <a
              className="agency-button"
              href={`/api/agency/mailboxes/messages/${message.id}/original`}
            >
              <Download size={14} />
              Download original email
            </a>
            <span>
              {message.attachmentCount} attachment
              {message.attachmentCount === 1 ? "" : "s"} in the original
            </span>
          </div>
        )}
        <p className="mailbox-muted">
          Filing preserves the original and supported attachments. It does not
          confirm coverage, apply policy changes, or send a message.
        </p>
        {review && (
          <form
            className="mailbox-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (account && share)
                void action("file", {
                  expectedRevision: message.revision,
                  accountId: account.id,
                  expectedVersion: account.version,
                  policyId,
                  direction,
                  shareWithAgency: true,
                });
            }}
          >
            {pending && (
              <p className="mailbox-issue">
                A filing is pending. Retry the same account and policy to
                recover its result.
              </p>
            )}
            <div className="mailbox-form-grid">
              <div>
                <label htmlFor="incoming-account">Account *</label>
                <Picker
                  id="incoming-account"
                  label="Account"
                  value={accountId}
                  options={accounts.map((a) => ({
                    id: a.id,
                    label: recordTitle(a),
                  }))}
                  placeholder="Choose an account"
                  required
                  disabled={busy || pending}
                  onChange={(id) => {
                    setAccountId(id);
                    setPolicyId(null);
                    setShare(false);
                  }}
                />
              </div>
              <div>
                <label htmlFor="incoming-policy">Policy (optional)</label>
                <Picker
                  id="incoming-policy"
                  label="Policy"
                  value={policyId}
                  options={policies.map((p) => ({
                    id: p.id,
                    label: recordTitle(p),
                    detail: (p as AmsRecord<"policies">).data.carrier,
                  }))}
                  placeholder="Account correspondence"
                  none="Account correspondence"
                  disabled={busy || pending || !accountId}
                  onChange={(id) => {
                    setPolicyId(id);
                    setShare(false);
                  }}
                />
              </div>
            </div>
            <label className="mailbox-field">
              Direction
              <select
                value={direction}
                disabled={busy || pending}
                onChange={(e) =>
                  setDirection(e.target.value as typeof direction)
                }
              >
                <option value="inbound">Incoming</option>
                <option value="outbound">Outgoing</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label className="mailbox-checkbox">
              <input
                type="checkbox"
                checked={share}
                disabled={busy}
                onChange={(e) => setShare(e.target.checked)}
              />
              I reviewed this message and want to file its original and
              attachments to this shared agency account.
            </label>
            <div className="mailbox-actions">
              <button
                className="agency-button primary"
                disabled={busy || !account || !share}
              >
                {busy
                  ? "Saving…"
                  : pending
                    ? "Resume filing"
                    : "File to account"}
              </button>
              {!pending && (
                <button
                  type="button"
                  className="agency-button"
                  disabled={busy}
                  onClick={() => setDismissing((v) => !v)}
                >
                  Dismiss message
                </button>
              )}
            </div>
          </form>
        )}
        {["error", "unavailable", "dismissed"].includes(message.status) && (
          <div className="mailbox-actions">
            <button
              className="agency-button"
              disabled={busy}
              onClick={() =>
                void action("retry", { expectedRevision: message.revision })
              }
            >
              {message.originalAvailable ? "Return to review" : "Retry import"}
            </button>
            {message.status !== "dismissed" && (
              <button
                className="agency-button"
                disabled={busy}
                onClick={() => setDismissing((v) => !v)}
              >
                Dismiss message
              </button>
            )}
          </div>
        )}
        {dismissing && (
          <form
            className="mailbox-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action("dismiss", {
                expectedRevision: message.revision,
                reason,
              });
            }}
          >
            <label className="mailbox-field">
              Reason for dismissing
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                maxLength={1000}
                rows={2}
                disabled={busy}
              />
            </label>
            <button className="agency-button" disabled={busy || !reason.trim()}>
              Confirm dismissal
            </button>
          </form>
        )}
        {message.status === "filed" && (
          <div className="mailbox-filed">
            <Check size={18} />
            <span>Filed as shared account correspondence.</span>
            {message.accountId && (
              <button
                className="agency-button"
                onClick={() => {
                  close();
                  openAccount(message.accountId!);
                }}
              >
                Open account <ArrowRight size={14} />
              </button>
            )}
          </div>
        )}
        {message.reviewReason && (
          <p className="mailbox-muted">{message.reviewReason}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MailboxHistory({
  mailbox,
  close,
}: {
  mailbox: AmsMailbox;
  close: () => void;
}) {
  type Event = { id: string; at: string; action: string; detail: string };
  const [page, setPage] = useState<AmsPage<Event> | null>(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    request<AmsPage<Event>>(`mailboxes/${mailbox.id}/events`, {
      signal: abort.signal,
    })
      .then(setPage)
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorText(e));
      });
    return () => abort.abort();
  }, [mailbox.id]);
  return (
    <Dialog open onOpenChange={close}>
      <DialogContent className="agency-dialog mailbox-dialog">
        <DialogHeader>
          <DialogTitle>Mailbox history</DialogTitle>
          <DialogDescription>
            {mailbox.address} · Connection and review decisions
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert">{error}</p>}
        {!page ? (
          <p role="status">Loading history…</p>
        ) : (
          <ol className="mailbox-history">
            {page.items.map((e) => (
              <li key={e.id}>
                <strong>{human(e.action)}</strong>
                <time>{new Date(e.at).toLocaleString()}</time>
                <p>{e.detail}</p>
              </li>
            ))}
          </ol>
        )}
        {page?.nextCursor && (
          <button
            className="agency-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const next = await request<AmsPage<Event>>(
                  `mailboxes/${mailbox.id}/events?cursor=${encodeURIComponent(page.nextCursor!)}`,
                );
                setPage({ ...next, items: [...page.items, ...next.items] });
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            More history
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}
