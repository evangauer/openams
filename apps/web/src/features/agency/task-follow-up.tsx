"use client";
import { useCallback, useEffect, useState } from "react";
import { Bell, CalendarClock, Check, RefreshCw } from "lucide-react";
import {
  AmsTaskFollowUpSchema,
  type AmsPage,
} from "@openams/contracts";
import { useAccountCommand } from "./account-command";
import {
  dateLabel,
  request,
  today,
  type AgencySession,
  type AmsRecord,
  type Book,
} from "./model";

export function TaskFollowUp({
  task,
  session,
  saved,
  readOnly = false,
}: {
  task: AmsRecord<"tasks">;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(() =>
    AmsTaskFollowUpSchema.parse(task.data.followUp || {}),
  );
  const mutation = useAccountCommand(saved);
  const change = (patch: Partial<typeof values>) =>
    setValues((v) => ({ ...v, ...patch }));
  const writable =
    !readOnly &&
    session.writableKinds.includes("tasks") &&
    task.data.status !== "done" &&
    !task.archivedAt;
  return (
    <section className="agency-follow-up" aria-label="Task follow-ups">
      <div className="account-section-heading">
        <h2>
          <CalendarClock size={16} /> Follow-ups
        </h2>
        {writable && !editing && (
          <button
            className="account-text-button"
            onClick={() => {
              setValues(AmsTaskFollowUpSchema.parse(task.data.followUp || {}));
              setEditing(true);
            }}
          >
            Set follow-ups
          </button>
        )}
      </div>
      {!editing ? (
        <p className="account-relay-note">
          {task.data.followUp?.reminderDaysBefore !== null &&
          task.data.followUp?.reminderDaysBefore !== undefined
            ? `Remind owner ${task.data.followUp.reminderDaysBefore === 0 ? "on the due date" : `${task.data.followUp.reminderDaysBefore} days before`}. `
            : "No reminder set. "}
          {task.data.followUp?.escalationAfterDays
            ? `Escalate when ${task.data.followUp.escalationAfterDays} ${task.data.followUp.escalationAfterDays === 1 ? "day" : "days"} overdue. `
            : ""}
          {task.data.followUp?.repeatEveryDays
            ? `Repeat every ${task.data.followUp.repeatEveryDays} days on the original schedule${task.data.followUp.repeatUntil ? ` through ${dateLabel(task.data.followUp.repeatUntil)}` : ""}. `
            : ""}
          {task.data.nextTaskId
            ? "The next task in this series has been created."
            : ""}
        </p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await mutation.run(() => ({
                id: crypto.randomUUID(),
                action: "task.followUp",
                kind: "tasks",
                recordId: task.id,
                expectedVersion: task.version,
                reason: "",
                data: values,
              }))
            )
              setEditing(false);
          }}
        >
          <fieldset
            className="account-profile-form"
            disabled={mutation.busy || mutation.uncertain}
          >
            <label>
              Remind owner
              <select
                aria-label="Remind owner"
                value={values.reminderDaysBefore ?? ""}
                onChange={(e) =>
                  change({
                    reminderDaysBefore:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              >
                <option value="">No reminder</option>
                {values.reminderDaysBefore !== null &&
                  ![0, 1, 3, 7, 14, 30].includes(values.reminderDaysBefore) && (
                    <option value={values.reminderDaysBefore}>
                      {values.reminderDaysBefore} days before
                    </option>
                  )}
                {[0, 1, 3, 7, 14, 30].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "On the due date" : `${n} days before`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Escalate after overdue days
              <input
                aria-label="Escalate after overdue days"
                type="number"
                min={1}
                max={365}
                value={values.escalationAfterDays ?? ""}
                onChange={(e) =>
                  change({
                    escalationAfterDays: e.target.value
                      ? Number(e.target.value)
                      : null,
                    ...(!e.target.value ? { escalationOwnerId: null } : {}),
                  })
                }
              />
            </label>
            <label>
              Escalate to
              <select
                aria-label="Escalate to"
                value={values.escalationOwnerId || ""}
                onChange={(e) =>
                  change({ escalationOwnerId: e.target.value || null })
                }
              >
                <option value="">Choose a manager</option>
                {session.members
                  .filter(
                    (m) => m.active && ["admin", "manager"].includes(m.role),
                  )
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Repeat every days
              <input
                aria-label="Repeat every days"
                type="number"
                min={1}
                max={366}
                value={values.repeatEveryDays ?? ""}
                onChange={(e) =>
                  change({
                    repeatEveryDays: e.target.value
                      ? Number(e.target.value)
                      : null,
                    ...(!e.target.value ? { repeatUntil: null } : {}),
                  })
                }
              />
            </label>
            <label>
              Repeat until
              <input
                aria-label="Repeat until"
                type="date"
                value={values.repeatUntil || ""}
                onChange={(e) =>
                  change({ repeatUntil: e.target.value || null })
                }
              />
            </label>
            <p className="account-profile-help">
              Reminders appear in the agency work queue. Completing a repeating
              task creates one next task on its original cadence; missed dates
              are skipped. Assign an owner first.
            </p>
            <div className="account-profile-actions">
              <button className="agency-button primary" type="submit">
                Save follow-ups
              </button>
              <button
                className="agency-button"
                type="button"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </fieldset>
          {mutation.error && <p role="alert">{mutation.error}</p>}
          {mutation.uncertain && (
            <button
              className="agency-button"
              type="button"
              onClick={async () => {
                if (await mutation.retry()) setEditing(false);
              }}
            >
              Retry same save
            </button>
          )}
        </form>
      )}
    </section>
  );
}

export function ReminderQueue({
  accountId,
  book,
  session,
  saved,
  open,
}: {
  accountId?: string;
  book: Book;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  open: (record: AmsRecord) => void;
}) {
  const [rows, setRows] = useState<AmsRecord<"reminders">[]>([]);
  const [error, setError] = useState("");
  const [processing, setProcessing] = useState(false);
  const [team, setTeam] = useState(false);
  const manager = ["admin", "manager"].includes(session.actor.role);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const all: AmsRecord<"reminders">[] = [];
      let cursor: string | null = null;
      do {
        const page: AmsPage<AmsRecord<"reminders">> = await request(
          `records/reminders?limit=100${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ""}${!team || !manager ? `&ownerId=${encodeURIComponent(session.actor.userId)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          { signal },
        );
        all.push(...page.items);
        cursor = page.nextCursor;
        if (all.length > 10_000)
          throw new Error(
            "The reminder history exceeds the current interactive limit.",
          );
      } while (cursor);
      return all;
    },
    [accountId, team, manager, session.actor.userId],
  );
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const all = await load(signal);
        if (!signal?.aborted) {
          setRows(all);
          setError("");
        }
      } catch (e) {
        if (!signal?.aborted)
          setError(
            e instanceof Error ? e.message : "Could not refresh reminders.",
          );
      }
    },
    [load],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .then((all) => {
        if (!controller.signal.aborted) {
          setRows(all);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Could not load reminders.",
          );
      });
    const interval = setInterval(() => {
      if (document.visibilityState === "visible")
        void refresh(controller.signal);
    }, 20_000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [load, refresh, book.reminders]);
  const active = rows
    .filter((r) => ["ready", "blocked"].includes(r.data.status))
    .sort(
      (a, b) =>
        a.data.dueDate.localeCompare(b.data.dueDate) ||
        a.id.localeCompare(b.id),
    );
  const scheduled = rows.filter((r) => r.data.status === "scheduled").length;
  return (
    <section
      className="account-section agency-reminder-queue"
      aria-label="Reminder queue"
    >
      <div className="account-section-heading">
        <h2>
          <Bell size={17} /> {team ? "Team reminders" : "Your reminders"}
        </h2>
        <div className="account-profile-actions">
          {manager && (
            <button
              className="account-text-button"
              onClick={() => setTeam((v) => !v)}
            >
              {team ? "Show mine" : "Show team"}
            </button>
          )}
          <button
            className="account-text-button"
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} /> Refresh reminders
          </button>
        </div>
      </div>
      <p className="account-relay-note">
        {scheduled} scheduled · In-app follow-ups
        {manager ? " · Review blocked reminders here." : "."}
      </p>
      {error && <p role="alert">{error}</p>}
      {!active.length && (
        <p className="account-relay-note">
          No reminders need your attention. Set follow-ups on a task to bring it
          back here.
        </p>
      )}
      {active.length > 0 && (
        <div className="agency-reminder-list">
          {active.slice(0, 50).map((record) => (
            <ReminderRow
              key={`${record.id}:${record.version}`}
              record={record}
              task={
                book.tasks?.find((t) => t.id === record.data.taskId) as
                  | AmsRecord<"tasks">
                  | undefined
              }
              session={session}
              open={open}
              saved={(records) => {
                saved(records);
                void refresh();
              }}
            />
          ))}
        </div>
      )}
      {active.length > 50 && (
        <p className="account-relay-note">
          Showing the first 50 reminders. Complete or dismiss reviewed items to
          work through the queue.
        </p>
      )}
      {manager && (
        <button
          className="account-text-button"
          disabled={processing}
          onClick={async () => {
            setProcessing(true);
            try {
              const result = await request<{
                records: AmsRecord[];
                more: boolean;
              }>("reminders/process", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
              saved(result.records);
              await refresh();
              if (result.more)
                setError(
                  "More due reminders remain. Run the queue again to continue.",
                );
            } catch (e) {
              setError(
                e instanceof Error
                  ? e.message
                  : "Processing could not be confirmed. Running again safely checks remaining work.",
              );
            } finally {
              setProcessing(false);
            }
          }}
        >
          Run due reminders
        </button>
      )}
    </section>
  );
}
function ReminderRow({
  record,
  task,
  session,
  saved,
  open,
}: {
  record: AmsRecord<"reminders">;
  task?: AmsRecord<"tasks">;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  open: (record: AmsRecord) => void;
}) {
  const mutation = useAccountCommand(saved);
  const [snooze, setSnooze] = useState("");
  const writable =
    session.writableKinds.includes("reminders") &&
    (session.actor.userId === record.data.ownerId ||
      ["admin", "manager"].includes(session.actor.role));
  const run = (
    action: "reminder.dismiss" | "reminder.snooze" | "reminder.retry",
  ) =>
    mutation.run(() => ({
      id: crypto.randomUUID(),
      action,
      kind: "reminders",
      recordId: record.id,
      expectedVersion: record.version,
      reason: "",
      data: action === "reminder.snooze" ? { dueDate: snooze } : {},
    }));
  return (
    <article
      className="agency-reminder-row"
      aria-label={`${record.data.type} reminder for ${record.data.title}`}
    >
      <div>
        <button
          className="account-text-button"
          disabled={!task}
          onClick={() => task && open(task)}
        >
          <strong>{task?.data.title || record.data.title}</strong>
        </button>
        <p>
          {record.data.type === "escalation" ? "Escalation" : "Follow-up"} ·{" "}
          {dateLabel(record.data.dueDate)} ·{" "}
          {session.members.find((m) => m.id === record.data.ownerId)?.name ||
            "Unavailable recipient"}
        </p>
        {record.data.status === "blocked" && (
          <p role="status">{record.data.detail}</p>
        )}
      </div>
      {writable && (
        <div className="agency-reminder-actions">
          <fieldset disabled={mutation.busy || mutation.uncertain}>
            {record.data.status === "ready" ? (
              <>
                <button
                  className="agency-button"
                  onClick={() => void run("reminder.dismiss")}
                >
                  <Check size={13} /> Dismiss reminder
                </button>
                <label>
                  Snooze until
                  <input
                    aria-label={`Snooze ${record.data.title} until`}
                    type="date"
                    min={today(session.timeZone)}
                    value={snooze}
                    onChange={(e) => setSnooze(e.target.value)}
                  />
                </label>
                <button
                  className="agency-button"
                  disabled={!snooze}
                  onClick={() => void run("reminder.snooze")}
                >
                  Snooze
                </button>
              </>
            ) : (
              <button
                className="agency-button"
                onClick={() => void run("reminder.retry")}
              >
                Retry recipient check
              </button>
            )}
          </fieldset>
          {mutation.error && <p role="alert">{mutation.error}</p>}
          {mutation.uncertain && (
            <button
              className="agency-button"
              onClick={() => void mutation.retry()}
            >
              Retry same save
            </button>
          )}
        </div>
      )}
    </article>
  );
}
