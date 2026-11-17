"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, Mail, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  accountRelayReferences,
  loadAccountRelayConversation,
  loadAccountRelayWork,
  type AccountRelayWork,
  type RelayWorkResult,
} from "./account-relay-model";
import {
  EmailFilingContext,
  NativeEmailFilingButton,
} from "./account-correspondence";
import {
  dateLabel,
  human,
  type AmsRecord,
  type AgencySession,
  type Book,
} from "./model";

const title = (work: AccountRelayWork) =>
  work.intake?.subject ||
  work.business?.dba ||
  work.business?.name ||
  work.applicant?.fullName ||
  [work.applicant?.firstName, work.applicant?.lastName]
    .filter(Boolean)
    .join(" ") ||
  "Linked Relay work";

export function AccountRelay({
  accountId,
  account,
  saved,
  book,
  session,
}: {
  account: AmsRecord<"accounts">;
  saved: (records: AmsRecord[]) => void;
  accountId: string;
  book: Book;
  session: AgencySession;
}) {
  const refs = accountRelayReferences(book, accountId);
  return (
    <EmailFilingContext.Provider value={{ account, book, session, saved }}>
      <section className="account-section" aria-label="Linked Relay work">
        <div className="account-section-heading">
          <h2>Linked Relay work</h2>
        </div>
        {!session.relayWorkspaceEnabled ? (
          <p className="account-relay-note">
            Linked Relay inbox and quoting are not available in this workspace.
          </p>
        ) : !refs.leadIds.length ? (
          <p className="account-relay-note">
            No linked conversations or quoting work yet.{" "}
            <Link
              prefetch={false}
              href={`/accounts?accountId=${encodeURIComponent(accountId)}`}
            >
              Open this account in Relay <ArrowUpRight size={13} />
            </Link>
          </p>
        ) : (
          <RelayWorkList
            key={`${accountId}:${session.actor.userId}:${session.actor.role}:${refs.accountIds.join(",")}:${refs.leadIds.join(",")}`}
            {...refs}
          />
        )}
      </section>
    </EmailFilingContext.Provider>
  );
}

function RelayWorkList({
  leadIds,
  accountIds,
}: {
  leadIds: string[];
  accountIds: string[];
}) {
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  return (
    <>
      <div className="account-relay-controls">
        <span>
          Linked items {page * 10 + 1}–
          {Math.min(page * 10 + 10, leadIds.length)} of {leadIds.length}
        </span>
        <button
          className="account-text-button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={13} />
          Refresh linked work
        </button>
      </div>
      <RelayWorkPage
        key={`${page}:${refresh}`}
        leadIds={leadIds.slice(page * 10, page * 10 + 10)}
        accountIds={accountIds}
      />
      {leadIds.length > 10 && (
        <div className="account-relay-controls">
          <button
            className="agency-button"
            disabled={page === 0}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous linked work
          </button>
          <button
            className="agency-button"
            disabled={(page + 1) * 10 >= leadIds.length}
            onClick={() => setPage((value) => value + 1)}
          >
            More linked work
          </button>
        </div>
      )}
    </>
  );
}

function RelayWorkPage({
  leadIds,
  accountIds,
}: {
  leadIds: string[];
  accountIds: string[];
}) {
  const [results, setResults] = useState<RelayWorkResult[] | null>(null);
  const [selected, setSelected] = useState<AccountRelayWork | null>(null);
  // Props are fixed by the page/scope key. Abort navigation and discard stale results.
  const [scope] = useState({ leadIds, accountIds });
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(
      scope.leadIds.map(async (id) => {
        try {
          return await loadAccountRelayWork(
            id,
            scope.accountIds,
            controller.signal,
          );
        } catch {
          return { id, work: null, state: "unavailable" } as RelayWorkResult;
        }
      }),
    ).then((rows) => {
      if (!controller.signal.aborted) setResults(rows);
    });
    return () => controller.abort();
  }, [scope]);
  if (!results)
    return (
      <p role="status" className="account-relay-note">
        <Loader2 size={15} className="agency-spin" /> Loading work with your
        Relay access…
      </p>
    );
  const available = results.filter((row) => row.work);
  const restricted = results.filter((row) => row.state === "restricted").length;
  const unavailable = results.filter(
    (row) => row.state === "unavailable",
  ).length;
  const moved = results.filter((row) => row.state === "moved").length;
  return (
    <>
      <div className="account-relay-list">
        {available.map(
          ({ id, work }) =>
            work && (
              <article key={id}>
                <div>
                  <strong>{title(work)}</strong>
                  <p>
                    {human(work.stage)}
                    {work.quotePackage &&
                      ` · Quote package ${human(work.quotePackage.status).toLowerCase()}`}
                  </p>
                  {!!work.quotePackage?.carrierNames.length && (
                    <p>{work.quotePackage.carrierNames.join(" · ")}</p>
                  )}
                </div>
                <div className="account-relay-actions">
                  <button
                    className="account-text-button"
                    onClick={() => setSelected(work)}
                    aria-label={`Read conversation for ${title(work)}`}
                  >
                    <Mail size={14} />
                    Conversation
                  </button>
                  <Link
                    prefetch={false}
                    href={`/pipeline/${encodeURIComponent(id)}`}
                    className="account-text-button"
                  >
                    Open work <ArrowUpRight size={13} />
                  </Link>
                </div>
              </article>
            ),
        )}
      </div>
      {restricted > 0 && (
        <p className="account-relay-note">
          {restricted} linked {restricted === 1 ? "item is" : "items are"}{" "}
          unavailable with your current Relay access.
        </p>
      )}
      {unavailable > 0 && (
        <p role="alert" className="account-relay-note">
          Some linked work could not be loaded. Refresh to try again.
        </p>
      )}
      {moved > 0 && (
        <p className="account-relay-note">
          A linked item no longer belongs to this account. Review its account
          link in Relay.
        </p>
      )}
      {selected && (
        <Conversation
          key={selected.id}
          work={selected}
          accountIds={scope.accountIds}
          close={() => setSelected(null)}
        />
      )}
    </>
  );
}

function Conversation({
  work,
  accountIds,
  close,
}: {
  work: AccountRelayWork;
  accountIds: string[];
  close: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        data-brand="relay"
        className="agency-dialog account-record-drawer"
      >
        <DialogHeader>
          <DialogTitle>{title(work)}</DialogTitle>
          <DialogDescription>
            Captured Relay conversation · access follows the original mailbox
            and work record.
          </DialogDescription>
        </DialogHeader>
        <ConversationBody
          key={attempt}
          leadId={work.id}
          accountIds={accountIds}
          retry={() => setAttempt((value) => value + 1)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConversationBody({
  leadId,
  accountIds,
  retry,
}: {
  leadId: string;
  accountIds: string[];
  retry: () => void;
}) {
  const [state, setState] = useState<{
    data?: Awaited<ReturnType<typeof loadAccountRelayConversation>>;
    error?: string;
  }>({});
  const [scope] = useState({ leadId, accountIds });
  useEffect(() => {
    const controller = new AbortController();
    void loadAccountRelayConversation(
      scope.leadId,
      scope.accountIds,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setState({ data });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({
            error:
              error instanceof Error
                ? error.message
                : "Could not load this conversation.",
          });
      });
    return () => controller.abort();
  }, [scope]);
  return (
    <div className="account-relay-conversation">
      {!state.data && !state.error && (
        <p role="status">Loading conversation…</p>
      )}
      {state.error && (
        <>
          <p role="alert">{state.error}</p>
          <button className="agency-button" onClick={retry}>
            Retry conversation
          </button>
        </>
      )}
      {state.data && (
        <>
          <div className="account-relay-controls">
            <span>
              {state.data.awaitingReply
                ? "Latest captured message is inbound"
                : "Captured conversation"}
            </span>
            <Link
              prefetch={false}
              className="agency-button"
              href={`/inbox/${encodeURIComponent(leadId)}`}
            >
              Reply and attachments in Inbox <ArrowUpRight size={14} />
            </Link>
          </div>
          {!state.data.messages.length && (
            <p>No captured messages for this linked work.</p>
          )}
          <p className="account-relay-note">
            {state.data.more ? "Showing the latest 50 captured messages. " : ""}
            The archive may not include every provider message. Full text is
            requested for the 10 most recent messages.
          </p>
          {state.data.messages.map((message) => (
            <details key={message.id} className="account-relay-message">
              <summary>
                <strong>{message.subject || "No subject"}</strong>
                <span>
                  {message.from || "Sender unavailable"} ·{" "}
                  {dateLabel(message.messageAt)}
                </span>
                <span>
                  {human(message.direction)}
                  {message.sendStatus && ` · ${human(message.sendStatus)}`}
                  {message.attachmentCount > 0 &&
                    ` · ${message.attachmentCount} attachments`}
                </span>
              </summary>
              <NativeEmailFilingButton leadId={leadId} messageId={message.id} />
              <p>To: {message.to || "Recipient unavailable"}</p>
              <div className="account-relay-message-body">
                {message.body ||
                  message.bodyPreview ||
                  "No captured message text."}
              </div>
              {!message.body && message.bodyPreview && (
                <p className="account-relay-note">
                  Preview only. Open Inbox to review the source message.
                </p>
              )}
            </details>
          ))}
        </>
      )}
    </div>
  );
}
