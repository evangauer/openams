"use client";
import { useState } from "react";
import { AmsWorkspaceProfileSchema } from "@openams/contracts";
import { useAccountCommand } from "./account-command";
import type { AgencySession, AmsRecord, Book } from "./model";
import "./agency-profile.css";

export const workspaceRecord = (book: Book) =>
  book.workspace?.find((r) => r.id === "agency") as
    | AmsRecord<"workspace">
    | undefined;

/**
 * The agency's own details: name, calendar, defaults and operating plan. Saving
 * the calendar is what opens the workspace for operational records.
 */
export function AgencyProfileForm({
  setup,
  session,
  saved,
}: {
  setup?: AmsRecord<"workspace">;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
}) {
  const [values, setValues] = useState(() =>
    AmsWorkspaceProfileSchema.parse(
      setup
        ? Object.fromEntries(
            Object.keys(AmsWorkspaceProfileSchema.shape).map((key) => [
              key,
              setup.data[key as keyof typeof setup.data],
            ]),
          )
        : {
            name: session.workspaceName,
            timeZone:
              session.calendarConfigured === false
                ? "America/New_York"
                : session.timeZone || "America/Chicago",
            defaultOwnerId: session.actor.userId,
          },
    ),
  );
  const [ack, setAck] = useState(false);
  const mutation = useAccountCommand(saved);
  const canManage = session.writableKinds.includes("workspace");
  const change = (key: keyof typeof values, value: string | null) =>
    setValues((v) => ({ ...v, [key]: value }));
  const submit = () =>
    mutation.run(() => ({
      id: crypto.randomUUID(),
      kind: "workspace",
      action: "workspace.configure",
      ...(setup ? { recordId: setup.id, expectedVersion: setup.version } : {}),
      data: { ...values, calendarAcknowledged: true },
      reason: "Reviewed agency details, calendar, and operating preferences.",
    }));
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (await submit()) setAck(false);
      }}
    >
      {!canManage && (
        <p className="agency-setup-notice">
          An agency administrator or manager can change these details.
        </p>
      )}
      <fieldset
        className="agency-setup-form"
        disabled={!canManage || mutation.busy || mutation.uncertain}
      >
        <label>
          Agency name
          <input
            required
            maxLength={500}
            value={values.name}
            onChange={(e) => change("name", e.target.value)}
          />
        </label>
        <div className="agency-setup-pair">
          <label>
            Agency email
            <input
              type="email"
              maxLength={254}
              value={values.email}
              onChange={(e) => change("email", e.target.value)}
            />
          </label>
          <label>
            Agency phone
            <input
              maxLength={500}
              value={values.phone}
              onChange={(e) => change("phone", e.target.value)}
            />
          </label>
        </div>
        <label>
          Agency calendar
          <select
            aria-label="Agency calendar"
            value={values.timeZone}
            onChange={(e) => change("timeZone", e.target.value)}
          >
            {[
              ...new Set([
                values.timeZone,
                "America/New_York",
                "America/Chicago",
                "America/Denver",
                "America/Phoenix",
                "America/Los_Angeles",
                "America/Anchorage",
                "Pacific/Honolulu",
                "UTC",
              ]),
            ].map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Default servicing owner
          <select
            aria-label="Default servicing owner"
            value={values.defaultOwnerId || ""}
            onChange={(e) => change("defaultOwnerId", e.target.value || null)}
          >
            <option value="">Choose when creating work</option>
            {session.members
              .filter((m) => m.active && m.role !== "viewer")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
        <div className="agency-setup-pair">
          <label>
            Billing mix
            <select
              aria-label="Billing mix"
              value={values.billingMode}
              onChange={(e) => change("billingMode", e.target.value)}
            >
              <option value="direct">Primarily direct-bill</option>
              <option value="mixed">Mixed direct and agency-bill</option>
              <option value="agency">Primarily agency-bill</option>
            </select>
          </label>
          <label>
            Starting approach
            <select
              aria-label="Starting approach"
              value={values.adoptionMode}
              onChange={(e) => change("adoptionMode", e.target.value)}
            >
              <option value="alongside">Work alongside our current AMS</option>
              <option value="primary">Evaluate as our primary AMS</option>
            </select>
          </label>
        </div>
        <label>
          Current AMS or source system
          <input
            placeholder="For example, NowCerts"
            maxLength={100}
            value={values.sourceSystem}
            onChange={(e) => change("sourceSystem", e.target.value)}
          />
        </label>
        <div className="agency-setup-pair">
          <label>
            Email workflow
            <select
              aria-label="Email workflow"
              value={values.emailPlan}
              onChange={(e) => change("emailPlan", e.target.value)}
            >
              <option value="undecided">Not decided yet</option>
              <option value="microsoft">Microsoft 365</option>
              <option value="google">Google Workspace</option>
              <option value="manual">File original emails manually for now</option>
            </select>
          </label>
          <label>
            Accounting arrangement
            <select
              aria-label="Accounting arrangement"
              value={values.accountingPlan}
              onChange={(e) => change("accountingPlan", e.target.value)}
            >
              <option value="undecided">Not decided yet</option>
              <option value="external">
                Keep accounting in an external system
              </option>
              <option value="ams_direct_bill">
                Evaluate AMS direct-bill commission tracking
              </option>
            </select>
          </label>
        </div>
        <p className="agency-setup-notice">
          The email and accounting choices record your operating plan. They do
          not connect a mailbox or an accounting system.
        </p>
        {canManage && (
          <>
            <label className="agency-setup-check">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              <span>
                I have reviewed the agency calendar. It controls due dates and
                reminders; existing recorded dates stay as entered.
              </span>
            </label>
            <button
              className="agency-button primary"
              disabled={!ack}
              type="submit"
            >
              {mutation.busy ? "Saving…" : "Save agency details"}
            </button>
          </>
        )}
      </fieldset>
      {mutation.error && (
        <p className="agency-form-error" role="alert">
          {mutation.error}
        </p>
      )}
      {mutation.uncertain && (
        <button
          className="agency-button"
          type="button"
          disabled={mutation.busy}
          onClick={() => void mutation.retry()}
        >
          Retry same save
        </button>
      )}
    </form>
  );
}
