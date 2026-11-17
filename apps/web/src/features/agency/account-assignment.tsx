"use client";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAccountCommand } from "./account-command";
import type { AgencySession, AmsRecord } from "./model";

export function AccountAssignmentDialog({
  accounts,
  session,
  saved,
  close,
}: {
  accounts: AmsRecord<"accounts">[];
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  close: () => void;
}) {
  const [producer, setProducer] = useState("unchanged");
  const [manager, setManager] = useState("unchanged");
  const [reason, setReason] = useState("");
  const mutation = useAccountCommand(saved);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.busy && !mutation.uncertain) close();
      }}
    >
      <DialogContent
        data-brand="relay"
        className="agency-dialog account-profile-dialog"
      >
        <DialogHeader>
          <DialogTitle>Assign account team</DialogTitle>
          <DialogDescription>
            Update {accounts.length} selected account
            {accounts.length === 1 ? "" : "s"} together. Existing policy
            producers and task assignments keep their current owners.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              await mutation.run(() => ({
                id: crypto.randomUUID(),
                action: "account.bulkAssign",
                kind: "accounts",
                recordId: accounts[0].id,
                expectedVersion: accounts[0].version,
                reason,
                data: {
                  accounts: accounts.map((account) => ({
                    id: account.id,
                    version: account.version,
                  })),
                  ...(producer !== "unchanged"
                    ? { producerId: producer || null }
                    : {}),
                  ...(manager !== "unchanged"
                    ? { serviceOwnerId: manager || null }
                    : {}),
                },
              }))
            )
              close();
          }}
        >
          <fieldset
            disabled={mutation.busy || mutation.uncertain}
            className="account-profile-form"
          >
            <details>
              <summary>Review selected accounts</summary>
              <ul>
                {accounts.map((account) => (
                  <li key={account.id}>{account.data.name}</li>
                ))}
              </ul>
            </details>
            {[
              { label: "Producer", value: producer, set: setProducer },
              { label: "Account manager", value: manager, set: setManager },
            ].map((field) => (
              <label key={field.label}>
                {field.label}
                <select
                  aria-label={field.label}
                  value={field.value}
                  onChange={(event) => field.set(event.target.value)}
                >
                  <option value="unchanged">Keep current assignment</option>
                  <option value="">Unassigned</option>
                  {session.members
                    .filter((member) => member.active)
                    .map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
            <label>
              Reason
              <textarea
                required
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          </fieldset>
          {mutation.error && (
            <p className="agency-error" role="alert">
              {mutation.error}
            </p>
          )}
          <div className="account-profile-footer">
            <button
              type="button"
              className="agency-button"
              disabled={mutation.busy || mutation.uncertain}
              onClick={close}
            >
              Cancel
            </button>
            <button
              className="agency-button primary"
              disabled={
                mutation.busy ||
                (producer === "unchanged" && manager === "unchanged")
              }
            >
              {mutation.busy
                ? "Assigning…"
                : mutation.uncertain
                  ? "Retry same assignment"
                  : "Assign team"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
