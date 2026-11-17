"use client";
// The suggestion box. Suggestions are agency records: teammates support them and an
// administrator or manager sets a status and replies. Nothing leaves the agency unless
// a person chooses "Share with the OpenAMS project", which opens a pre-filled public
// GitHub issue in their browser for them to review and submit.
import { useMemo, useState } from "react";
import {
  ExternalLink,
  Lightbulb,
  MessageSquareReply,
  Send,
  ThumbsUp,
} from "lucide-react";
import {
  AMS_SUGGESTION_AREAS,
  AMS_SUGGESTION_STATUSES,
} from "@openams/contracts";
import { useAccountCommand } from "./account-command";
import { dateLabel, type AgencySession, type AmsRecord, type Book } from "./model";
import { PageHeader } from "./page-header";
import {
  AREA_LABELS,
  STATUS_LABELS,
  shareUrl,
  type SuggestionArea as Area,
  type SuggestionStatus as Status,
} from "./team-suggestions-model";
import "./team-suggestions.css";

type Suggestion = AmsRecord<"suggestions">;

const FILTERS = {
  open: { label: "Open", statuses: ["new", "considering", "planned"] },
  done: { label: "Done", statuses: ["done"] },
  declined: { label: "Not now", statuses: ["declined"] },
  all: { label: "All", statuses: [...AMS_SUGGESTION_STATUSES] },
} satisfies Record<string, { label: string; statuses: readonly Status[] }>;

/** Starting points, so an empty box shows what a useful suggestion looks like. */
const STARTERS: { title: string; area: Area; detail: string }[] = [
  {
    title: "Send renewal reminder letters in bulk",
    area: "renewals",
    detail:
      "Each month we write to every client renewing in 60 days. Today that is one letter at a time. Done would be choosing the month and sending one reviewed letter to each.",
  },
  {
    title: "Show which certificates are waiting on a carrier",
    area: "certificates",
    detail:
      "Holders call to ask where their certificate is. A list of requests waiting on someone else would let the CSR answer without digging.",
  },
  {
    title: "Remind me before a task is due, not only on the day",
    area: "tasks",
    detail:
      "A reminder the day before would give time to collect what the client needs.",
  },
];

function SuggestionForm({
  saved,
}: {
  saved: (records: AmsRecord[]) => void;
}) {
  const [title, setTitle] = useState("");
  const [area, setArea] = useState<Area>("other");
  const [detail, setDetail] = useState("");
  const mutation = useAccountCommand(saved);
  const submit = async () => {
    const ok = await mutation.run(() => ({
      id: crypto.randomUUID(),
      action: "create",
      kind: "suggestions",
      data: { title: title.trim(), area, detail: detail.trim() },
      reason: "",
    }));
    if (ok) {
      setTitle("");
      setDetail("");
      setArea("other");
    }
  };
  return (
    <form
      className="agency-suggest-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={mutation.busy || mutation.uncertain}>
        <label className="agency-field">
          <span>Your idea, in a sentence</span>
          <input
            required
            minLength={3}
            maxLength={140}
            value={title}
            placeholder="Send renewal reminder letters in bulk"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="agency-field">
          <span>Part of OpenAMS</span>
          <select
            value={area}
            onChange={(event) => setArea(event.target.value as Area)}
          >
            {AMS_SUGGESTION_AREAS.map((option) => (
              <option key={option} value={option}>
                {AREA_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="agency-field agency-suggest-detail">
          <span>What happens today, and what would “done” look like?</span>
          <textarea
            rows={4}
            maxLength={4000}
            value={detail}
            placeholder="Who does this work, what makes it slow, and what you would like to happen instead."
            onChange={(event) => setDetail(event.target.value)}
          />
        </label>
        <div className="agency-suggest-actions">
          <button className="agency-button primary" type="submit">
            <Send size={15} />
            {mutation.busy ? "Adding…" : "Add to the suggestion box"}
          </button>
          <small>
            Your team sees it here. It is not sent anywhere else.
          </small>
        </div>
      </fieldset>
      {mutation.error && (
        <p className="agency-form-error" role="alert">
          {mutation.error}
        </p>
      )}
      {mutation.uncertain && (
        <button
          type="button"
          className="agency-button"
          disabled={mutation.busy}
          onClick={() => void mutation.retry()}
        >
          Retry the same suggestion
        </button>
      )}
      {!title && !detail && (
        <div className="agency-suggest-starters">
          <span>Need a starting point? Try one of these:</span>
          {STARTERS.map((starter) => (
            <button
              key={starter.title}
              type="button"
              className="agency-suggest-starter"
              onClick={() => {
                setTitle(starter.title);
                setArea(starter.area);
                setDetail(starter.detail);
              }}
            >
              <Lightbulb size={13} aria-hidden="true" />
              {starter.title}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

function ManagerReply({
  suggestion,
  saved,
}: {
  suggestion: Suggestion;
  saved: (records: AmsRecord[]) => void;
}) {
  const [status, setStatus] = useState<Status>(suggestion.data.status);
  const [response, setResponse] = useState(suggestion.data.response);
  const mutation = useAccountCommand(saved);
  const changed =
    status !== suggestion.data.status || response.trim() !== suggestion.data.response;
  return (
    <form
      className="agency-suggest-reply"
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.run(() => ({
          id: crypto.randomUUID(),
          action: "suggestion.respond",
          kind: "suggestions",
          recordId: suggestion.id,
          expectedVersion: suggestion.version,
          data: { status, response: response.trim() },
          reason: "",
        }));
      }}
    >
      <fieldset disabled={mutation.busy || mutation.uncertain}>
        <select
          aria-label={`Status of ${suggestion.data.title}`}
          value={status}
          onChange={(event) => setStatus(event.target.value as Status)}
        >
          {AMS_SUGGESTION_STATUSES.map((option) => (
            <option key={option} value={option}>
              {STATUS_LABELS[option]}
            </option>
          ))}
        </select>
        <input
          aria-label={`Reply to ${suggestion.data.title}`}
          maxLength={2000}
          value={response}
          placeholder="Reply to the team (optional)"
          onChange={(event) => setResponse(event.target.value)}
        />
        <button className="agency-button quiet" type="submit" disabled={!changed}>
          <MessageSquareReply size={14} />
          Update
        </button>
      </fieldset>
      {mutation.error && (
        <p className="agency-form-error" role="alert">
          {mutation.error}
        </p>
      )}
      {mutation.uncertain && (
        <button
          type="button"
          className="agency-button"
          disabled={mutation.busy}
          onClick={() => void mutation.retry()}
        >
          Retry reply
        </button>
      )}
    </form>
  );
}

function SuggestionCard({
  suggestion,
  session,
  saved,
}: {
  suggestion: Suggestion;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
}) {
  const vote = useAccountCommand(saved);
  const data = suggestion.data;
  const mine = suggestion.createdBy === session.actor.userId;
  const supported = data.votes.includes(session.actor.userId);
  const author =
    session.members.find((member) => member.id === suggestion.createdBy)?.name ||
    "A former teammate";
  const manager = ["admin", "manager"].includes(session.actor.role);
  return (
    <article className="agency-suggestion" data-status={data.status}>
      <button
        className="agency-suggestion-vote"
        aria-pressed={supported}
        disabled={mine || vote.busy || vote.uncertain}
        title={mine ? "Your suggestion" : supported ? "Remove your support" : "Support this suggestion"}
        onClick={() =>
          void vote.run(() => ({
            id: crypto.randomUUID(),
            action: "suggestion.vote",
            kind: "suggestions",
            recordId: suggestion.id,
            expectedVersion: suggestion.version,
            data: { support: !supported },
            reason: "",
          }))
        }
      >
        <ThumbsUp size={15} aria-hidden="true" />
        <strong>{data.votes.length}</strong>
        <span className="agency-visually-hidden">
          {supported ? "You support this. Remove support" : "Support"}
        </span>
      </button>
      <div className="agency-suggestion-body">
        <div className="agency-suggestion-meta">
          <span className="agency-suggestion-status">{STATUS_LABELS[data.status]}</span>
          <span>{AREA_LABELS[data.area]}</span>
        </div>
        <h3>{data.title}</h3>
        {data.detail && <p>{data.detail}</p>}
        {data.response && (
          <blockquote>
            <MessageSquareReply size={14} aria-hidden="true" />
            {data.response}
          </blockquote>
        )}
        <div className="agency-suggestion-footer">
          <small>
            {mine ? "You" : author} · {dateLabel(suggestion.createdAt)}
          </small>
          <a
            className="account-text-button"
            href={shareUrl(data)}
            target="_blank"
            rel="noreferrer noopener"
            title="Opens a public GitHub issue for you to review before submitting. Remove client names and anything private first."
          >
            Share with the OpenAMS project <ExternalLink size={13} />
          </a>
        </div>
        {vote.error && (
          <p className="agency-form-error" role="alert">
            {vote.error}
          </p>
        )}
        {vote.uncertain && (
          <button
            type="button"
            className="agency-button"
            disabled={vote.busy}
            onClick={() => void vote.retry()}
          >
            Retry support update
          </button>
        )}
        {manager && <ManagerReply key={suggestion.version} suggestion={suggestion} saved={saved} />}
      </div>
    </article>
  );
}

export function SuggestionBox({
  book,
  session,
  saved,
}: {
  book: Book;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
}) {
  const [filter, setFilter] = useState<keyof typeof FILTERS>("open");
  const all = (book.suggestions || []) as Suggestion[];
  const shown = useMemo(
    () =>
      all
        .filter((record) =>
          (FILTERS[filter].statuses as readonly Status[]).includes(record.data.status),
        )
        .sort(
          (a, b) =>
            b.data.votes.length - a.data.votes.length ||
            b.createdAt.localeCompare(a.createdAt),
        ),
    [all, filter],
  );
  return (
    <div className="agency-suggest-page">
      <PageHeader
        eyebrow="SUGGESTION BOX"
        title="What would make your day easier?"
        description="Suggest a feature or a fix. Your team can support ideas, and an administrator or manager replies with what happens next."
      />
      <div className="agency-suggest-layout">
        <section className="agency-panel agency-suggest-panel">
          <h2>Suggest something</h2>
          <SuggestionForm saved={saved} />
        </section>
        <section className="agency-suggest-list" aria-label="Suggestions">
          <div className="agency-suggest-filters" role="tablist" aria-label="Filter suggestions">
            {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((key) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
              >
                {FILTERS[key].label}
                <em>
                  {
                    all.filter((record) =>
                      (FILTERS[key].statuses as readonly Status[]).includes(record.data.status),
                    ).length
                  }
                </em>
              </button>
            ))}
          </div>
          {shown.length ? (
            shown.map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                session={session}
                saved={saved}
              />
            ))
          ) : (
            <p className="agency-suggest-empty">
              {all.length
                ? "Nothing here yet. Try another filter."
                : "No suggestions yet. The first good idea is often the thing everyone works around."}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
