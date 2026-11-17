"use client";

/*
 * Relay design take: account workspace pieces. Each renders nothing outside the
 * Relay take. They reuse the account's existing callbacks (open, add) so records,
 * saves and permissions behave exactly as in the standard account overview.
 */
import Link from "next/link";
import { useState } from "react";
import {
  ArrowUpRight,
  Briefcase,
  Building2,
  ChevronDown,
  Globe,
  HardHat,
  Mail,
  Phone,
  Plus,
  Shield,
  ShieldCheck,
  Sparkles,
  Truck,
  Umbrella,
} from "lucide-react";
import { accountStatus, accountWebsiteHref } from "../account-model";
import {
  dateLabel,
  human,
  money,
  type AgencySession,
  type AmsRecord,
} from "../model";
import { useAgencyTheme } from "../theme";
import { RelayConnectDialog } from "./relay-shell";

type Account = AmsRecord<"accounts">;

export function RelayAccountMark() {
  if (useAgencyTheme() !== "relay") return null;
  return (
    <span className="relay-account-mark" aria-hidden="true">
      <Briefcase size={20} />
    </span>
  );
}

/** Email, phone and website as quiet pills under the account name. */
export function RelayContactChips({ account }: { account: Account }) {
  if (useAgencyTheme() !== "relay") return null;
  const d = account.data;
  const website = accountWebsiteHref(d.website);
  if (!d.email && !d.phone && !website) return null;
  return (
    <div className="relay-contacts">
      {d.email && (
        <a className="relay-contact" href={`mailto:${d.email}`}>
          <Mail size={14} aria-hidden="true" />
          {d.email}
        </a>
      )}
      {d.phone && (
        <a className="relay-contact" href={`tel:${d.phone}`}>
          <Phone size={14} aria-hidden="true" />
          {d.phone}
        </a>
      )}
      {website && (
        <a className="relay-contact" href={website} target="_blank" rel="noreferrer">
          <Globe size={14} aria-hidden="true" />
          {d.website.replace(/^https?:\/\//, "")}
        </a>
      )}
    </div>
  );
}

/**
 * Ask Relay on the account header. Connected: opens the account in Relay (the same
 * destination as the existing Relay account link). Not connected: explains.
 */
export function RelayAskButton({
  account,
  session,
}: {
  account: Account;
  session: AgencySession;
}) {
  const theme = useAgencyTheme();
  const [explain, setExplain] = useState(false);
  if (theme !== "relay") return null;
  if (session.relayWorkspaceEnabled)
    return (
      <Link
        className="agency-button relay-ask"
        prefetch={false}
        href={`/accounts?accountId=${encodeURIComponent(account.id)}`}
      >
        <Sparkles size={15} aria-hidden="true" />
        Open in Relay
        <ArrowUpRight size={14} aria-hidden="true" />
      </Link>
    );
  return (
    <>
      <button
        className="agency-button relay-ask"
        data-locked="true"
        aria-label="Ask Relay, available when this workspace is connected to Relay"
        onClick={() => setExplain(true)}
      >
        <Sparkles size={15} aria-hidden="true" />
        Ask Relay
        <span className="relay-tag">Connect</span>
      </button>
      {explain && (
        <RelayConnectDialog
          focus="assistant"
          subject={account.data.name}
          close={() => setExplain(false)}
        />
      )}
    </>
  );
}

function lineTone(line: string) {
  const value = line.toLowerCase();
  if (value.includes("worker")) return { tone: "emerald", icon: HardHat };
  if (value.includes("auto") || value.includes("vehicle"))
    return { tone: "amber", icon: Truck };
  if (value.includes("umbrella") || value.includes("excess"))
    return { tone: "sky", icon: Umbrella };
  if (value.includes("property") || value.includes("building"))
    return { tone: "rose", icon: Building2 };
  if (value.includes("liability")) return { tone: "violet", icon: ShieldCheck };
  return { tone: "neutral", icon: Shield };
}

function Badge({ value, tone }: { value: string; tone?: string }) {
  const resolved =
    tone ||
    (["active", "renewed", "issued"].includes(value)
      ? "positive"
      : ["cancelled", "nonrenewed", "notice", "lost", "expired"].includes(value)
        ? "attention"
        : "");
  return <span className={`account-badge ${resolved}`}>{human(value)}</span>;
}

/**
 * Policies as Relay list rows: line icon, carrier and term, term premium, status
 * and any open renewal. Mirrors the standard Coverage filter and paging.
 */
export function RelayPolicies({
  records,
  renewals,
  date,
  open,
  add,
}: {
  records: AmsRecord<"policies">[];
  renewals: AmsRecord[];
  date: string;
  open: (record: AmsRecord) => void;
  add?: () => void;
}) {
  const theme = useAgencyTheme();
  const [filter, setFilter] = useState("current");
  const [visible, setVisible] = useState(5);
  if (theme !== "relay") return null;
  const policies = records
    .filter(
      (record) =>
        filter === "all" ||
        ["active", "scheduled", "draft"].includes(accountStatus(record, date)),
    )
    .sort(
      (a, b) =>
        a.data.expirationDate.localeCompare(b.data.expirationDate) ||
        a.data.line.localeCompare(b.data.line),
    );
  const openRenewals = (renewals as AmsRecord<"renewals">[]).filter(
    (record) => !["renewed", "lost"].includes(record.data.stage),
  );
  const activePremium = records
    .filter((record) => accountStatus(record, date) === "active")
    .reduce((total, record) => total + record.data.premiumCents, 0);
  return (
    <section className="account-section relay-policies" aria-label="Policies">
      <div className="account-section-heading">
        <h2>
          Policies <span className="account-count">{records.length}</span>
          {activePremium > 0 && (
            <span
              className="relay-heading-caption"
              title="Premium for active policy terms; excludes taxes and fees. Not an annualized total."
            >
              {money(activePremium)} term premium
            </span>
          )}
        </h2>
        <div className="account-section-actions">
          <select
            aria-label="Policy terms shown"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setVisible(5);
            }}
          >
            <option value="current">Current & draft</option>
            <option value="all">All terms · {records.length}</option>
          </select>
          {add && (
            <button className="account-text-button relay-add" onClick={add}>
              <Plus size={15} aria-hidden="true" />
              Add policy
            </button>
          )}
        </div>
      </div>
      {policies.length ? (
        <ul className="relay-policy-list">
          {policies.slice(0, visible).map((record) => {
            const { tone, icon: Glyph } = lineTone(record.data.line);
            const status = accountStatus(record, date);
            const renewal = openRenewals.find((item) =>
              item.data.policyIds.includes(record.id),
            );
            return (
              <li key={record.id}>
                <button
                  className="relay-policy"
                  onClick={() => open(record)}
                  aria-label={`Open ${record.data.line} ${record.data.number}`}
                >
                  <span className={`relay-lob relay-tone-${tone}`} aria-hidden="true">
                    <Glyph size={17} />
                  </span>
                  <span className="relay-policy-main">
                    <strong>{record.data.line}</strong>
                    <small>
                      {[
                        record.data.carrier,
                        record.data.number,
                        `${dateLabel(record.data.effectiveDate)} – ${dateLabel(record.data.expirationDate)}`,
                      ].join(" · ")}
                    </small>
                  </span>
                  <span className="relay-policy-side">
                    <strong>{money(record.data.premiumCents)}</strong>
                    <span>
                      {renewal && (
                        <span className="account-badge attention">
                          Renewal · {human(renewal.data.stage)}
                        </span>
                      )}
                      {record.data.nonrenewal && (
                        <span className="account-badge attention">
                          Nonrenewal notice
                        </span>
                      )}
                      <Badge value={status} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="account-empty">
          {records.length
            ? "No current or draft terms. Choose All terms to see the policy history."
            : "No policy terms yet. Add the policy and its carrier evidence to start a coverage record."}
        </p>
      )}
      {policies.length > visible && (
        <button className="account-show-more" onClick={() => setVisible(visible + 10)}>
          Show more · {policies.length - visible} remaining
          <ChevronDown size={14} />
        </button>
      )}
    </section>
  );
}
