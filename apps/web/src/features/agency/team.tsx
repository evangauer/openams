"use client";
// Team management. Hosted agencies (AMS_AUTH_MODE=firebase) invite people, change roles
// and deactivate members through /api/identity. OpenAMS has no outbound email provider
// yet, so inviting someone records the invitation and the inviter tells the person;
// nothing is emailed. Local evaluation has fixed test identities instead.
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  KeyRound,
  ClipboardCopy,
  Plus,
  ShieldCheck,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import type { AmsMember } from "@openams/contracts";
import { human, type AgencySession } from "./model";
import {
  canAssignRole,
  identityRequest,
  IDENTITY_ROLES,
  type IdentityInvitation,
  type IdentityRole,
} from "./identity-model";
import { PageHeader } from "./page-header";
import { ROLE_GUIDE } from "./roles";
import { invitationMessage } from "./team-suggestions-model";
import "./team-suggestions.css";

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function RoleGuide({ highlight }: { highlight?: IdentityRole }) {
  return (
    <div className="agency-role-guide">
      {IDENTITY_ROLES.map((role) => {
        const guide = ROLE_GUIDE[role];
        return (
          <article key={role} data-highlight={highlight === role || undefined}>
            <strong>{guide.label}</strong>
            <p>{guide.summary}</p>
            <ul>
              {guide.can.map((line) => (
                <li key={line}>
                  <Check size={13} aria-hidden="true" /> {line}
                </li>
              ))}
              {guide.cannot.map((line) => (
                <li key={line} data-cannot>
                    <X size={13} aria-hidden="true" /> Cannot {line.charAt(0).toLowerCase() + line.slice(1)}
                </li>
              ))}
            </ul>
            <small>For example: {guide.example}</small>
          </article>
        );
      })}
    </div>
  );
}

export function TeamManagement({
  session,
  changed,
}: {
  session: AgencySession;
  changed: () => void;
}) {
  const actorRole = session.actor.role;
  const manager = actorRole === "admin" || actorRole === "manager";
  // `secondFactor` is present for administrators and managers when the sign-in service
  // could be asked (and only matters when the deployment requires two-step sign-in).
  const [members, setMembers] = useState<(AmsMember & { secondFactor?: boolean })[]>(session.members);
  const [invitations, setInvitations] = useState<IdentityInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<IdentityRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [team, invites] = await Promise.all([
      identityRequest<{ members: (AmsMember & { secondFactor?: boolean })[] }>("members"),
      manager
        ? identityRequest<{ invitations: IdentityInvitation[] }>("invitations")
        : Promise.resolve({ invitations: [] }),
    ]);
    setMembers(team.members);
    setInvitations(invites.invitations);
  }, [manager]);
  useEffect(() => {
    load().catch((failure: Error) => setError(failure.message));
  }, [load]);
  async function run(action: () => Promise<string | void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const done = await action();
      if (done) setNotice(done);
      await load();
      changed();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }
  async function copy(invite: IdentityInvitation) {
    try {
      await navigator.clipboard.writeText(
        invitationMessage(invite, session.workspaceName, window.location.origin),
      );
      setCopied(invite.id);
      setNotice(
        `Sign-in steps for ${invite.email} copied, ready for you to send.`,
      );
    } catch {
      setError("Your browser did not allow copying. Select and copy the steps by hand.");
    }
  }
  const canManage = (member: AmsMember) =>
    manager &&
    member.id !== session.actor.userId &&
    (member.role !== "admin" || actorRole === "admin");
  const pending = invitations.filter((invite) => invite.status === "pending");
  return (
    <div className="agency-team-manage">
      {manager && (
        <form
          className="agency-team-invite"
          onSubmit={(event) => {
            event.preventDefault();
            const address = email.trim().toLowerCase();
            void run(async () => {
              const result = await identityRequest<{ emailed?: boolean }>(
                "invitations",
                { email: address, role },
              );
              setEmail("");
              return result?.emailed === true
                ? `Invitation emailed to ${address}. They can join by signing in with that address.`
                : `Invitation recorded for ${address}; no email was sent. Use “Copy sign-in steps” below and send them yourself.`;
            });
          }}
        >
          <label className="agency-field">
            <span>Invite by email</span>
            <input
              type="email"
              required
              maxLength={254}
              value={email}
              placeholder="teammate@example.test"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="agency-field">
            <span>Role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as IdentityRole)}
            >
              {IDENTITY_ROLES.filter((option) =>
                canAssignRole(actorRole, option),
              ).map((option) => (
                <option key={option} value={option}>
                  {ROLE_GUIDE[option].label}
                </option>
              ))}
            </select>
          </label>
          <button className="agency-button primary" disabled={busy}>
            <Plus size={15} />
            Add invitation
          </button>
          <p className="agency-team-role-hint">
            <ShieldCheck size={14} aria-hidden="true" />
            {ROLE_GUIDE[role].summary}
          </p>
        </form>
      )}
      {pending.length > 0 && (
        <section>
          <h3 className="agency-team-subhead">
            Waiting to join <em>{pending.length}</em>
          </h3>
          <div className="agency-team-list agency-team-invitations">
            {pending.map((invite) => (
              <div key={invite.id}>
                <span className="agency-avatar" data-pending>
                  {initials(invite.email)}
                </span>
                <span>
                  <strong>{invite.email}</strong>
                  <small>
                    Invited as {ROLE_GUIDE[invite.role].label.toLowerCase()} ·
                    waiting until{" "}
                    {new Date(invite.expiresAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </small>
                </span>
                <button
                  className="agency-button quiet"
                  disabled={busy}
                  onClick={() => void copy(invite)}
                >
                  {copied === invite.id ? <Check size={15} /> : <ClipboardCopy size={15} />}
                  Copy sign-in steps
                </button>
                {canAssignRole(actorRole, invite.role) && (
                  <button
                    className="agency-button quiet"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await identityRequest(`invitations/${invite.id}/revoke`, {});
                        return `The invitation for ${invite.email} was revoked.`;
                      })
                    }
                  >
                    <X size={15} />
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        <h3 className="agency-team-subhead">
          Members <em>{members.filter((member) => member.active).length}</em>
        </h3>
        <div className="agency-team-list">
          {members.map((member) => (
            <div key={member.id} data-inactive={!member.active || undefined}>
              <span className="agency-avatar">{initials(member.name)}</span>
              <span>
                <strong>
                  {member.name}
                  {member.id === session.actor.userId && (
                    <span className="agency-team-you">That’s you</span>
                  )}
                </strong>
                <small>
                  {member.email}
                  {member.active ? "" : " · Deactivated"}
                  {member.secondFactor === true && " · Two-step sign-in on"}
                  {member.secondFactor === false && " · No authenticator yet"}
                </small>
              </span>
              {canManage(member) ? (
                <>
                  <select
                    aria-label={`Role for ${member.name}`}
                    value={member.role}
                    disabled={busy || !member.active}
                    onChange={(event) =>
                      void run(async () => {
                        await identityRequest(`members/${member.id}/role`, {
                          role: event.target.value,
                        });
                        return `${member.name} is now ${ROLE_GUIDE[event.target.value as IdentityRole].label.toLowerCase()}.`;
                      })
                    }
                  >
                    {IDENTITY_ROLES.filter(
                      (option) =>
                        option === member.role || canAssignRole(actorRole, option),
                    ).map((option) => (
                      <option key={option} value={option}>
                        {ROLE_GUIDE[option].label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="agency-button quiet"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await identityRequest<{
                          sessionsRevoked?: boolean;
                        }>(
                          `members/${member.id}/${member.active ? "deactivate" : "reactivate"}`,
                          {},
                        );
                        if (!member.active)
                          return `${member.name} can open this agency again.`;
                        return result.sessionsRevoked
                          ? `${member.name} can no longer open this agency, and their sessions were signed out.`
                          : `${member.name} can no longer open this agency. Signing out their other sessions could not be confirmed; their access is still refused on every request.`;
                      })
                    }
                  >
                    {member.active ? <UserMinus size={15} /> : <UserPlus size={15} />}
                    {member.active ? "Deactivate" : "Reactivate"}
                  </button>
                  {actorRole === "admin" && member.secondFactor && (
                    <button
                      className="agency-button quiet"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Reset ${member.name}'s authenticator? They'll be signed out and set up a new one at their next sign-in.`)) return;
                        void run(async () => {
                          const result = await identityRequest<{ sessionsRevoked?: boolean }>(`members/${member.id}/reset-mfa`, {});
                          return result.sessionsRevoked
                            ? `${member.name}'s authenticator was reset and their sessions were signed out. They'll set up a new one at their next sign-in.`
                            : `${member.name}'s authenticator was reset. Signing out their sessions could not be confirmed.`;
                        });
                      }}
                    >
                      <KeyRound size={15} />
                      Reset authenticator
                    </button>
                  )}
                </>
              ) : (
                <span className="agency-team-role">{ROLE_GUIDE[member.role].label}</span>
              )}
            </div>
          ))}
        </div>
      </section>
      {notice && (
        <p className="agency-team-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="agency-team-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Local evaluation: fixed test identities, one per role, on this computer only. */
function LocalTeam({
  session,
  signIn,
}: {
  session: AgencySession;
  signIn: (role: string) => Promise<void>;
}) {
  return (
    <div className="agency-team-manage">
      <p className="agency-setup-notice">
        This local workspace has one test identity per role, so you can see the
        agency the way each person would. Invitations need hosted sign-in
        (<code>AMS_AUTH_MODE=firebase</code>); see docs/hosted-identity.md.
      </p>
      <div className="agency-team-list">
        {session.members.map((member) => (
          <div key={member.id}>
            <span className="agency-avatar">{initials(member.name)}</span>
            <span>
              <strong>
                {member.name}
                {member.id === session.actor.userId && (
                  <span className="agency-team-you">That’s you</span>
                )}
              </strong>
              <small>{member.email}</small>
            </span>
            <span className="agency-team-role">{ROLE_GUIDE[member.role].label}</span>
            {member.id !== session.actor.userId && (
              <button
                className="agency-button quiet"
                onClick={() => void signIn(member.role)}
              >
                See it as {ROLE_GUIDE[member.role].label.toLowerCase()}
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TeamPage({
  session,
  local,
  hosted,
  refresh,
  signIn,
}: {
  session: AgencySession;
  local: boolean;
  hosted: boolean;
  refresh: () => void;
  signIn: (role: string) => Promise<void>;
}) {
  const active = session.members.filter((member) => member.active);
  const manager = ["admin", "manager"].includes(session.actor.role);
  return (
    <div className="agency-team-page">
      <PageHeader
        eyebrow="TEAM"
        title="The people who work this book."
        description={
          manager && hosted
            ? "Invite teammates, choose what each person can do, and remove access when someone leaves."
            : "Who works in this agency and what each role can do."
        }
      />
      <div className="agency-team-stats">
        <div>
          <strong>{active.length}</strong>
          <span>active {active.length === 1 ? "member" : "members"}</span>
        </div>
        <div>
          <strong>{active.filter((member) => ["admin", "manager"].includes(member.role)).length}</strong>
          <span>can manage the team</span>
        </div>
        <div>
          <strong>{session.members.length - active.length}</strong>
          <span>deactivated</span>
        </div>
      </div>
      <div className="agency-team-layout">
        <section className="agency-panel agency-team-panel">
          <h2>{manager && hosted ? "Invite and manage" : "Your team"}</h2>
          {hosted ? (
            <TeamManagement session={session} changed={refresh} />
          ) : local ? (
            <LocalTeam session={session} signIn={signIn} />
          ) : (
            <p className="agency-setup-notice">
              Team membership is managed by your agency administrator.
            </p>
          )}
          {hosted && !manager && (
            <p className="agency-setup-notice">
              Your agency administrator or a manager invites people and changes
              roles.
            </p>
          )}
        </section>
        <section className="agency-panel agency-team-panel">
          <h2>What each role can do</h2>
          <p>
            Start people with the least access their work needs. You can change a
            role later{hosted ? ", and each change is kept in the team history" : ""}.
          </p>
          <RoleGuide highlight={session.actor.role} />
        </section>
      </div>
    </div>
  );
}
