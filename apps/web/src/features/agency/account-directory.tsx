"use client";
import { useMemo, useState } from "react";
import { ArrowRight, Search } from "lucide-react";
import {
  accountAttention,
  accountSummary,
  groupAccountBook,
} from "./account-model";
import { AccountAssignmentDialog } from "./account-assignment";
import { AccountBadge } from "./account-workspace";
import {
  dateLabel,
  money,
  today,
  type AgencySession,
  type AmsRecord,
  type Book,
} from "./model";

export function AccountDirectory({
  records,
  book,
  session,
  open,
  saved,
}: {
  records: AmsRecord[];
  book: Book;
  session: AgencySession;
  open: (record: AmsRecord) => void;
  saved: (records: AmsRecord[]) => void;
}) {
  const grouped = useMemo(
    () => groupAccountBook(book, session.readableKinds),
    [book, session.readableKinds],
  );
  const date = today(session.timeZone);
  const [selected, setSelected] = useState<string[]>([]);
  const [assigning, setAssigning] = useState<AmsRecord<"accounts">[] | null>(
    null,
  );
  const canAssign = ["admin", "manager"].includes(session.actor.role);
  const chosen = records.filter(
    (row) => selected.includes(row.id) && !row.archivedAt,
  ) as AmsRecord<"accounts">[];
  return (
    <section className="agency-records account-directory" aria-label="Accounts">
      <div className="agency-table-count">
        {records.length} {records.length === 1 ? "account" : "accounts"}
      </div>
      {canAssign && chosen.length > 0 && (
        <div
          className="account-directory-selection"
          role="region"
          aria-label="Selected accounts"
        >
          <strong>{chosen.length} selected</strong>
          <button
            className="agency-button"
            onClick={() => setAssigning(chosen)}
          >
            Assign team
          </button>
          <button
            className="account-text-button"
            onClick={() => setSelected([])}
          >
            Clear selection
          </button>
        </div>
      )}
      {assigning && (
        <AccountAssignmentDialog
          accounts={assigning}
          session={session}
          saved={(rows) => {
            saved(rows);
            setSelected([]);
          }}
          close={() => setAssigning(null)}
        />
      )}
      {records.length ? (
        <div className="agency-table-scroll">
          <table>
            <thead>
              <tr>
                {canAssign && (
                  <th className="account-directory-checkbox">
                    <input
                      type="checkbox"
                      aria-label="Select up to 50 visible accounts"
                      checked={
                        Boolean(
                          records.filter((row) => !row.archivedAt).length,
                        ) &&
                        records
                          .filter((row) => !row.archivedAt)
                          .slice(0, 50)
                          .every((row) => selected.includes(row.id))
                      }
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? records
                                .filter((row) => !row.archivedAt)
                                .slice(0, 50)
                                .map((row) => row.id)
                            : [],
                        )
                      }
                    />
                  </th>
                )}
                <th>Account</th>
                <th>Coverage</th>
                <th>Next up</th>
                <th>Account manager</th>
                <th>Relationship</th>
                <th>
                  <span className="sr-only">Open account</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((row) => {
                const account = row as AmsRecord<"accounts">;
                const scoped = grouped.get(row.id) || {};
                const summary = accountSummary(scoped, date);
                const next = accountAttention(scoped, date)[0];
                const manager = session.members.find(
                  (member) => member.id === account.data.serviceOwnerId,
                );
                return (
                  <tr key={row.id}>
                    {canAssign && (
                      <td className="account-directory-checkbox">
                        <input
                          type="checkbox"
                          aria-label={`Select ${account.data.name}`}
                          disabled={
                            Boolean(row.archivedAt) ||
                            (chosen.length >= 50 && !selected.includes(row.id))
                          }
                          checked={selected.includes(row.id)}
                          onChange={(event) =>
                            setSelected((ids) =>
                              event.target.checked
                                ? [...ids, row.id]
                                : ids.filter((id) => id !== row.id),
                            )
                          }
                        />
                      </td>
                    )}
                    <td>
                      <button
                        className="agency-record-link"
                        onClick={() => open(row)}
                      >
                        <span className="agency-avatar">
                          {account.data.name.slice(0, 2).toUpperCase()}
                        </span>
                        <span>
                          <strong>{account.data.name}</strong>
                          <small>
                            {[
                              account.data.industry,
                              [
                                account.data.address.city,
                                account.data.address.state,
                              ]
                                .filter(Boolean)
                                .join(", "),
                            ]
                              .filter(Boolean)
                              .join(" · ") || "Account details not recorded"}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <strong>
                        {summary.activeCount} active{" "}
                        {summary.activeCount === 1 ? "policy" : "policies"}
                      </strong>
                      <small>{money(summary.premiumCents)} term premium</small>
                    </td>
                    <td className="account-directory-next">
                      {next ? (
                        <>
                          <strong>{next.title}</strong>
                          <small>
                            {next.date
                              ? `${next.date < date ? "Overdue · " : next.date === date ? "Today · " : ""}${dateLabel(next.date)}`
                              : next.detail}
                          </small>
                        </>
                      ) : (
                        <small>No open follow-ups</small>
                      )}
                    </td>
                    <td>{manager?.name || "Unassigned"}</td>
                    <td>
                      <AccountBadge
                        value={
                          row.archivedAt ? "archived" : account.data.status
                        }
                      />
                    </td>
                    <td>
                      <button
                        className="agency-icon-button"
                        aria-label={`Open ${account.data.name}`}
                        onClick={() => open(row)}
                      >
                        <ArrowRight size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="agency-empty">
          <Search size={25} />
          <h2>No accounts found</h2>
          <p>Create an account or adjust your search.</p>
        </div>
      )}
    </section>
  );
}
