// Hosted identity for OpenAMS: Firebase Auth email-link sign-in, server-side session
// cookies, first-run agency setup, invitations and team membership.
//
// Agency creation has two modes (AMS_SIGNUP):
// - "admin" (default): the deployment serves one agency, created once by an administrator
//   email named at install (AMS_ADMIN_EMAIL); everyone else joins by invitation.
// - "open": anyone with a verified email can create an agency, one per person and per
//   mailbox, with per-domain and deployment-wide daily caps. For running OpenAMS as a
//   service for many agencies; every agency is isolated by the server-derived tenant.
//
// Instances of Auth, Firestore and App Check are injected; this module never calls
// initializeApp. Auth is a BaseAuth: the project-level Auth, or a TenantAwareAuth when the
// deployment signs people in through an Identity Platform tenant (AMS_AUTH_TENANT_ID). The API never sets cookies: the web app receives the session cookie
// value from POST /identity/session and stores it in an HTTP-only cookie, then forwards
// it back here as `Authorization: Bearer <session cookie>`.
//
// Security invariants (see docs/hosted-identity.md):
// - Every request verifies the session cookie with the revocation check.
// - The tenant id always comes from the stored membership, never from the client.
// - Membership writes keep identity_users and members consistent in one transaction.
// - Nobody can grant a role above their own; the last active admin cannot be removed.
// - In "admin" mode only an install-time administrator email can create the agency, once.
// - Errors never echo tokens, emails or verification details.
import { rateLimit } from "express-rate-limit";
import { requestLimitOptions, TokenBuckets } from "./rate-limit.js";
import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BaseAuth, DecodedIdToken } from "firebase-admin/auth";
import type { AppCheck } from "firebase-admin/app-check";
import {
  Timestamp,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {
  AmsRoleSchema,
  AmsTimeZone,
  type AmsActor,
  type AmsMember,
  type AmsRole,
} from "@openams/contracts";
import { AmsError } from "../repository.js";
import { signAccessToken, type AccessView } from "./external-access.js";
import type { InvitationMailer } from "./invitation-mail.js";
import { DEFAULT_INVITATION_TTL_HOURS, MAX_INVITATION_TTL_HOURS } from "./invitation-policy.js";
import { appSignInLink, FINISH_PATH, type SignInMailer } from "./sign-in-mail.js";

export const IDENTITY_COLLECTIONS = {
  users: "identity_users",
  agencies: "identity_agencies",
  members: "members",
  invitations: "identity_invitations",
  limits: "identity_limits",
  tenants: "tenants",
  audit: "identity_audit",
} as const;
export const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
export const RECENT_SIGN_IN_SECONDS = 5 * 60;
export { DEFAULT_INVITATION_TTL_HOURS, MAX_INVITATION_TTL_HOURS };
const HOUR_MS = 60 * 60 * 1000;
/**
 * AMS_INVITATION_TTL_HOURS: how long a new invitation stays open, a whole number of hours
 * from 1 to 720. Anything else falls back to seven days.
 */
export function invitationTtlHoursFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AMS_INVITATION_TTL_HOURS?.trim();
  if (!raw) return DEFAULT_INVITATION_TTL_HOURS;
  const parsed = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (parsed >= 1 && parsed <= MAX_INVITATION_TTL_HOURS) return parsed;
  console.warn("AMS_INVITATION_TTL_HOURS must be a whole number of hours from 1 to 720; using 168.");
  return DEFAULT_INVITATION_TTL_HOURS;
}
export interface IdentityLimits {
  /** Invitations one agency may create per UTC day. */
  invitationsPerAgencyPerDay: number;
  /**
   * Open sign-up without external access control: invitations one agency may have
   * emailed per UTC day. Nobody vets such an agency, so this keeps the deployment's mail
   * sender from being used to write to strangers. Later invitations are still recorded.
   */
  openSignupInvitationEmailsPerAgencyPerDay: number;
  /** Open sign-up: new agencies across the deployment per UTC day (last-resort backstop). */
  agenciesPerDay: number;
  /** Open sign-up: new agencies per email domain per UTC day (large public mail providers excepted). */
  agenciesPerDomainPerDay: number;
  /**
   * Sign-in emails the deployment sends itself per UTC day (with AMS_SMTP_URL). Past it,
   * the browser falls back to Firebase's built-in email, so sign-in keeps working.
   */
  signInEmailsPerDay: number;
}
const DEFAULT_LIMITS: IdentityLimits = {
  invitationsPerAgencyPerDay: 50,
  openSignupInvitationEmailsPerAgencyPerDay: 5,
  agenciesPerDay: 1000,
  agenciesPerDomainPerDay: 5,
  signInEmailsPerDay: 2000,
};
/**
 * AMS_REQUIRE_MFA: "1", "true", "yes" or "required" makes everyone finish sign-in with a
 * second factor (an authenticator app) after the email link. Off by default.
 */
export const mfaRequiredFromEnv = (env: Record<string, string | undefined> = process.env): boolean =>
  ["1", "true", "yes", "required"].includes(env.AMS_REQUIRE_MFA?.trim().toLowerCase() ?? "");
/** Optional project-level SMS sign-in; Identity Platform tenants do not support it. */
export const smsSigninFromEnv = (env: Record<string, string | undefined> = process.env): boolean =>
  ["1", "true", "yes"].includes(env.AMS_SMS_SIGNIN?.trim().toLowerCase() ?? "") &&
  !mfaRequiredFromEnv(env) && !env.AMS_AUTH_TENANT_ID?.trim();

async function assertPhoneIdentity(auth: BaseAuth, decoded: DecodedIdToken, allowSms: boolean) {
  if (decoded.firebase?.sign_in_provider !== "phone") return;
  if (!allowSms || typeof decoded.phone_number !== "string") throw unauthorized();
  // A removed/replaced phone must immediately stop authenticating old SMS sessions.
  // Never resolve a user or membership by a caller-supplied phone number.
  const user = await auth.getUser(decoded.uid);
  if (user.disabled || !user.emailVerified || user.email !== decoded.email || user.phoneNumber !== decoded.phone_number)
    throw unauthorized();
}

/** The second factor this token was signed in with ("totp", "phone"), or null. */
export function secondFactorOf(decoded: DecodedIdToken): string | null {
  const factor = (decoded.firebase as { sign_in_second_factor?: unknown } | undefined)?.sign_in_second_factor;
  return typeof factor === "string" && factor.length > 0 ? factor : null;
}
/**
 * AMS_TERMS_URL (https) and AMS_TERMS_VERSION: terms that whoever creates an agency must
 * accept on its behalf. Both or neither; the accepted version is stored on the agency.
 */
export function termsFromEnv(env: Record<string, string | undefined> = process.env): { url: string; version: string } | null {
  const url = env.AMS_TERMS_URL?.trim() ?? "";
  const version = env.AMS_TERMS_VERSION?.trim() ?? "";
  if (!url || !version) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("AMS_TERMS_URL must be an https URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("AMS_TERMS_URL must be an https URL.");
  if (!/^[A-Za-z0-9.;@_:+-]{1,200}$/.test(version)) throw new Error("AMS_TERMS_VERSION has unsupported characters.");
  return { url: parsed.toString(), version };
}
export type SignupMode = "admin" | "open";
/** AMS_SIGNUP: "open" allows anyone to create an agency; anything else is "admin". */
export const signupModeFromEnv = (env: Record<string, string | undefined> = process.env): SignupMode =>
  env.AMS_SIGNUP?.trim().toLowerCase() === "open" ? "open" : "admin";
/**
 * Reads AMS_INVITATION_DAILY_LIMIT, AMS_OPEN_SIGNUP_INVITATION_EMAILS, AMS_AGENCY_DAILY_LIMIT,
 * AMS_AGENCY_DOMAIN_DAILY_LIMIT and AMS_SIGN_IN_EMAIL_DAILY_LIMIT, falling back to defaults.
 */
export function identityLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): IdentityLimits {
  const positive = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000_000
      ? parsed
      : fallback;
  };
  return {
    invitationsPerAgencyPerDay: positive(
      env.AMS_INVITATION_DAILY_LIMIT,
      DEFAULT_LIMITS.invitationsPerAgencyPerDay,
    ),
    openSignupInvitationEmailsPerAgencyPerDay: positive(
      env.AMS_OPEN_SIGNUP_INVITATION_EMAILS,
      DEFAULT_LIMITS.openSignupInvitationEmailsPerAgencyPerDay,
    ),
    agenciesPerDay: positive(env.AMS_AGENCY_DAILY_LIMIT, DEFAULT_LIMITS.agenciesPerDay),
    agenciesPerDomainPerDay: positive(
      env.AMS_AGENCY_DOMAIN_DAILY_LIMIT,
      DEFAULT_LIMITS.agenciesPerDomainPerDay,
    ),
    signInEmailsPerDay: positive(
      env.AMS_SIGN_IN_EMAIL_DAILY_LIMIT,
      DEFAULT_LIMITS.signInEmailsPerDay,
    ),
  };
}

class IdentityError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const unauthorized = () =>
  new IdentityError(401, "unauthorized", "Sign in again to continue.");
const notFound = () =>
  new IdentityError(404, "not_found", "That item was not found.");

// ---------------------------------------------------------------------------
// Input schemas. Every body is strict and length-limited; emails are normalized.
const noControl = /^[^\p{Cc}]*$/u;
const Email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email();
const DisplayName = z.string().trim().min(1).max(100).regex(noControl);
const AgencyName = z.string().trim().min(1).max(120).regex(noControl);
const MemberId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const InvitationId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const SessionBody = z
  .object({ idToken: z.string().min(20).max(8192) })
  .strict();
const SignInLinkBody = z
  .object({ email: Email, phoneSetup: z.boolean().optional() })
  .strict();
const EmptyBody = z.object({}).strict();
const AgencyBody = z
  .object({
    name: AgencyName,
    timeZone: AmsTimeZone,
    displayName: DisplayName.optional(),
    /** The terms version being accepted (required when terms are configured). */
    acceptTerms: z.string().max(200).optional(),
  })
  .strict();
const InvitationBody = z
  .object({ email: Email, role: AmsRoleSchema })
  .strict();
/** The secret part of an invitation link: 32 random bytes, base64url. */
const InvitationToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const AcceptBody = z
  .object({
    invitationId: InvitationId,
    token: InvitationToken.optional(),
    displayName: DisplayName.optional(),
  })
  .strict();
const LinkBody = z
  .object({ invitationId: InvitationId, token: InvitationToken })
  .strict();
const DeclineBody = z
  .object({ invitationId: InvitationId, token: InvitationToken.optional() })
  .strict();
const RoleBody = z.object({ role: AmsRoleSchema }).strict();
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
/**
 * Reads the install-time administrator emails (AMS_ADMIN_EMAIL, comma-separated). Only
 * these addresses may create this instance's agency, and only while it has none.
 */
export function adminEmailsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return (env.AMS_ADMIN_EMAIL ?? "")
    .split(",")
    .map(normalizeEmail)
    .filter((email) => Email.safeParse(email).success);
}

/**
 * Large public mail providers: a per-domain cap would let one person block everyone on
 * them, and their accounts are costly to mint in bulk. Aliases there are folded by
 * canonicalMailbox instead.
 */
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
]);
/**
 * The mailbox an address delivers to, for sign-up limits only: drops "+tag" everywhere
 * and dots for Gmail, so aliases of one inbox count as one sign-up.
 */
export function canonicalMailbox(email: string): { mailbox: string; domain: string } {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  let local = normalized.slice(0, at).split("+")[0] ?? "";
  let domain = normalized.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  return { mailbox: `${local}@${domain}`, domain };
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------
// Roles. Admin may grant any role. Manager may grant any role except admin.
// Everyone else grants nothing.
export function canAssignRole(actor: AmsRole, target: AmsRole): boolean {
  if (actor === "admin") return true;
  return actor === "manager" && target !== "admin";
}
const MANAGERS: AmsRole[] = ["admin", "manager"];

// ---------------------------------------------------------------------------
// Stored shapes.
interface MemberDoc {
  role: AmsRole;
  name: string;
  email: string;
  active: boolean;
}
interface InvitationDoc {
  tenantId: string;
  email: string;
  role: AmsRole;
  status: "pending" | "accepted" | "revoked" | "declined";
  /**
   * sha256 (hex) of the secret in the invitation link. The secret itself is never stored.
   * Invitations created before links existed have none.
   */
  tokenHash?: string;
  invitedBy: string;
  /** The inviter's email, shown to the invitee so they can judge the invitation. */
  invitedByEmail?: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}
const StoredMember = z.object({
  role: AmsRoleSchema,
  name: z.string(),
  email: z.string(),
  active: z.boolean(),
});
function memberOf(data: unknown): MemberDoc {
  return StoredMember.parse(data);
}

function refs(db: Firestore) {
  const agencies = db.collection(IDENTITY_COLLECTIONS.agencies);
  return {
    user: (uid: string) => db.collection(IDENTITY_COLLECTIONS.users).doc(uid),
    agency: (tenantId: string) => agencies.doc(tenantId),
    members: (tenantId: string) =>
      agencies.doc(tenantId).collection(IDENTITY_COLLECTIONS.members),
    member: (tenantId: string, uid: string) =>
      agencies
        .doc(tenantId)
        .collection(IDENTITY_COLLECTIONS.members)
        .doc(uid),
    invitations: db.collection(IDENTITY_COLLECTIONS.invitations),
    anyAgency: agencies.limit(1),
    limit: (id: string) => db.collection(IDENTITY_COLLECTIONS.limits).doc(id),
    audit: (tenantId: string) =>
      db
        .collection(IDENTITY_COLLECTIONS.tenants)
        .doc(tenantId)
        .collection(IDENTITY_COLLECTIONS.audit)
        .doc(),
  };
}

interface Identity {
  uid: string;
  email: string;
}
interface Membership {
  tenantId: string;
  member: MemberDoc;
}

function bearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9._-]{20,8192})$/.exec(
    request.header("authorization") ?? "",
  );
  if (!match) throw unauthorized();
  return match[1];
}
/**
 * Verifies the session cookie (with revocation check) and a verified email, and, when
 * MFA is required, that the session was created from a sign-in with a second factor.
 */
async function verifySession(auth: BaseAuth, request: Request, requireMfa = false, allowSms = false): Promise<Identity> {
  let decoded: DecodedIdToken;
  try {
    decoded = await auth.verifySessionCookie(bearer(request), true);
  } catch {
    throw unauthorized();
  }
  if (decoded.email_verified !== true || typeof decoded.email !== "string")
    throw unauthorized();
  if (requireMfa && !secondFactorOf(decoded)) throw unauthorized();
  await assertPhoneIdentity(auth, decoded, allowSms && !requireMfa);
  return { uid: decoded.uid, email: normalizeEmail(decoded.email) };
}
async function loadMembership(
  db: Firestore,
  uid: string,
): Promise<Membership | null> {
  const r = refs(db);
  const user = await r.user(uid).get();
  const tenantId = user.get("tenantId");
  if (typeof tenantId !== "string") return null;
  const member = await r.member(tenantId, uid).get();
  if (!member.exists) return null;
  return { tenantId, member: memberOf(member.data()) };
}

/**
 * Authenticates `/ams` requests: a verified, unrevoked session cookie and an active
 * agency membership. The actor's tenant comes only from the stored membership.
 */
export function createFirebaseAuthenticate(deps: {
  auth: BaseAuth;
  db: Firestore;
  /** Require a second factor on every session (default: AMS_REQUIRE_MFA). */
  requireMfa?: boolean;
  /** Allow primary SMS sign-in for a verified-email account (default: AMS_SMS_SIGNIN). */
  allowSms?: boolean;
}): RequestHandler {
  const requireMfa = deps.requireMfa ?? mfaRequiredFromEnv();
  const allowSms = (deps.allowSms ?? smsSigninFromEnv()) && !requireMfa;
  return async (request, response, next) => {
    let membership: Membership | null;
    let identity: Identity;
    try {
      identity = await verifySession(deps.auth, request, requireMfa, allowSms);
      membership = await loadMembership(deps.db, identity.uid);
    } catch {
      response
        .status(401)
        .json({ error: "unauthorized", message: "Sign in again to continue." });
      return;
    }
    if (!membership) {
      response.status(403).json({
        error: "agency_required",
        message: "Ask your agency administrator for an invitation to continue.",
      });
      return;
    }
    if (!membership.member.active) {
      response.status(403).json({
        error: "membership_inactive",
        message: "Your agency membership is not active.",
      });
      return;
    }
    response.locals.amsActor = {
      userId: identity.uid,
      tenantId: membership.tenantId,
      name: membership.member.name,
      role: membership.member.role,
    } satisfies AmsActor;
    next();
  };
}

// ---------------------------------------------------------------------------
// Router dependency helpers matching routes.ts signatures.
export function firestoreMembers(
  db: Firestore,
): (tenantId: string) => Promise<AmsMember[]> {
  return async (tenantId) => {
    const snapshot = await refs(db).members(tenantId).limit(1000).get();
    return snapshot.docs
      .map((doc) => {
        const member = memberOf(doc.data());
        return {
          id: doc.id,
          name: member.name,
          email: member.email,
          role: member.role,
          active: member.active,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  };
}
async function agencyField(db: Firestore, tenantId: string, field: string) {
  const agency = await refs(db).agency(tenantId).get();
  const value = agency.get(field);
  if (!agency.exists || typeof value !== "string")
    throw new AmsError(404, "agency_not_found", "This agency was not found.");
  return value;
}
export function firestoreWorkspaceName(
  db: Firestore,
): (tenantId: string) => Promise<string> {
  return (tenantId) => agencyField(db, tenantId, "name");
}
export function firestoreTimeZone(
  db: Firestore,
): (tenantId: string) => Promise<string> {
  return (tenantId) => agencyField(db, tenantId, "timeZone");
}

// ---------------------------------------------------------------------------
// Router.
export interface IdentityRouterDependencies {
  auth: BaseAuth;
  db: Firestore;
  appCheck?: AppCheck;
  now?: () => Date;
  limits?: Partial<IdentityLimits>;
  /** Emails allowed to create this instance's one agency in "admin" mode (default: AMS_ADMIN_EMAIL). */
  adminEmails?: string[];
  /** Who may create agencies (default: AMS_SIGNUP). */
  signup?: SignupMode;
  /** Require a second factor (authenticator app) for every session (default: AMS_REQUIRE_MFA). */
  requireMfa?: boolean;
  /** Allow primary SMS sign-in for a verified-email account (default: AMS_SMS_SIGNIN). */
  allowSms?: boolean;
  /** Terms an agency's creator accepts (default: AMS_TERMS_URL and AMS_TERMS_VERSION). */
  terms?: { url: string; version: string } | null;
  /**
   * Optional external access control (AMS_ACCESS_CONTROL=external): the agency's access
   * state for /identity/me, and the signed link administrators follow to the outside page.
   */
  access?: {
    view: (tenantId: string) => Promise<AccessView | null>;
    link: { appOrigin: string; url: string; secret: string };
  };
  /**
   * Optional: emails the invitee when an invitation is created (AMS_SMTP_URL and
   * AMS_MAIL_FROM). Without it invitations are only recorded.
   */
  invitationMail?: InvitationMailer;
  /**
   * Optional: the deployment sends sign-in links itself, in the OpenAMS look (same
   * settings, plus AMS_APP_URL). Without it the browser asks Firebase to send its
   * built-in email.
   */
  signInMail?: { appOrigin: string; send: SignInMailer };
  /** How long a new invitation stays open, in hours (default: AMS_INVITATION_TTL_HOURS). */
  invitationTtlHours?: number;
  /**
   * Optional: an agency's own invitation lifetime in hours, set through external access
   * control. Null means the deployment's setting applies.
   */
  agencyInvitationTtlHours?: (tenantId: string) => Promise<number | null>;
}
type Locals = { identity: Identity; membership: Membership };

const randomId = (bytes: number) => randomBytes(bytes).toString("base64url");
const utcDay = (date: Date) => date.toISOString().slice(0, 10);
const emailName = (email: string) =>
  email.split("@")[0]?.slice(0, 100) || "Agency member";
const newInvitationToken = () => randomBytes(32).toString("base64url");
/** Compares a presented link secret with the stored hash in constant time. */
function tokenMatches(token: string | undefined, tokenHash: string | undefined): boolean {
  if (!token || !tokenHash || !/^[0-9a-f]{64}$/.test(tokenHash)) return false;
  return timingSafeEqual(Buffer.from(sha(token), "hex"), Buffer.from(tokenHash, "hex"));
}
/**
 * When an invitation stops working: the expiry stored when it was sent, or sooner if the
 * lifetime that now applies is shorter. Shortening the setting cuts open invitations at
 * once; lengthening it never extends one already sent.
 */
function closesAt(data: InvitationDoc, ttlHours: number): number {
  return Math.min(data.expiresAt.toMillis(), data.createdAt.toMillis() + ttlHours * HOUR_MS);
}
function invitationView(id: string, data: InvitationDoc, now: Date, ttlHours: number) {
  const closes = closesAt(data, ttlHours);
  const expired = data.status === "pending" && closes <= now.getTime();
  return {
    id,
    email: data.email,
    role: data.role,
    status: expired ? ("expired" as const) : data.status,
    createdAt: data.createdAt.toDate().toISOString(),
    expiresAt: new Date(closes).toISOString(),
  };
}

export function createIdentityRouter(deps: IdentityRouterDependencies): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const limits = { ...identityLimitsFromEnv(), ...deps.limits };
  const adminEmails = new Set(
    (deps.adminEmails ?? adminEmailsFromEnv()).map(normalizeEmail),
  );
  const signup = deps.signup ?? signupModeFromEnv();
  const requireMfa = deps.requireMfa ?? mfaRequiredFromEnv();
  const allowSms = (deps.allowSms ?? smsSigninFromEnv()) && !requireMfa;
  const terms = deps.terms === undefined ? termsFromEnv() : deps.terms;
  const deploymentTtlHours = deps.invitationTtlHours ?? invitationTtlHoursFromEnv();
  /** The invitation lifetime that applies to an agency now, in hours. */
  async function ttlHoursFor(tenantId: string): Promise<number> {
    const own = deps.agencyInvitationTtlHours ? await deps.agencyInvitationTtlHours(tenantId) : null;
    return own !== null && Number.isInteger(own) && own >= 1 && own <= MAX_INVITATION_TTL_HOURS
      ? own
      : deploymentTtlHours;
  }
  // Link-holding endpoints (preview, accept, decline): a tight per-client admission cap,
  // and a per-person bucket, so the link secret can't be probed. 256 random bits can't be
  // guessed anyway; this bounds the cost of trying.
  const linkAdmission = rateLimit(requestLimitOptions(30));
  const linkBuckets = new TokenBuckets({ capacity: 20, refillPerSecond: 0.1 });
  const linkLimited: RequestHandler = (_request, response, next) => {
    if (linkBuckets.take((response.locals as Locals).identity.uid)) next();
    else
      next(new IdentityError(429, "rate_limited", "Too many requests. Wait a minute and try again."));
  };
  const r = refs(deps.db);
  const audit = (
    tx: Transaction,
    tenantId: string,
    entry: {
      actorUid: string;
      action: string;
      targetUid?: string | null;
      invitationId?: string | null;
      email?: string | null;
      beforeRole?: AmsRole | null;
      afterRole?: AmsRole | null;
      beforeActive?: boolean | null;
      afterActive?: boolean | null;
    },
  ) =>
    tx.create(r.audit(tenantId), {
      targetUid: null,
      invitationId: null,
      email: null,
      beforeRole: null,
      afterRole: null,
      beforeActive: null,
      afterActive: null,
      ...entry,
      at: Timestamp.fromDate(now()),
    });

  const route =
    (
      action: (
        request: Request,
        response: Response<unknown, Locals>,
      ) => Promise<void>,
    ): RequestHandler =>
    async (request, response, next) => {
      try {
        await action(request, response as Response<unknown, Locals>);
      } catch (error) {
        next(error);
      }
    };
  const sessionThen: RequestHandler = (request, response, next) => {
    verifySession(deps.auth, request, requireMfa, allowSms).then(
      (identity) => {
        (response.locals as Locals).identity = identity;
        next();
      },
      next,
    );
  };
  const requireMember =
    (roles?: AmsRole[]): RequestHandler =>
    async (request, response, next) => {
      try {
        const membership = await loadMembership(
          deps.db,
          (response.locals as Locals).identity.uid,
        );
        if (!membership)
          throw new IdentityError(
            403,
            "agency_required",
            "Ask your agency administrator for an invitation to continue.",
          );
        if (!membership.member.active)
          throw new IdentityError(
            403,
            "membership_inactive",
            "Your agency membership is not active.",
          );
        if (roles && !roles.includes(membership.member.role))
          throw new IdentityError(
            403,
            "manager_required",
            "Only an agency administrator or manager can manage the team.",
          );
        (response.locals as Locals).membership = membership;
        next();
      } catch (error) {
        next(error);
      }
    };
  /** Re-reads the actor inside the transaction so a concurrent demotion is honored. */
  async function actorInTransaction(
    tx: Transaction,
    tenantId: string,
    uid: string,
  ): Promise<MemberDoc> {
    const snapshot = await tx.get(r.member(tenantId, uid));
    if (!snapshot.exists) throw notFound();
    const actor = memberOf(snapshot.data());
    if (!actor.active || !MANAGERS.includes(actor.role))
      throw new IdentityError(
        403,
        "manager_required",
        "Only an agency administrator or manager can manage the team.",
      );
    return actor;
  }
  async function assertAnotherActiveAdmin(
    tx: Transaction,
    tenantId: string,
    targetUid: string,
  ) {
    const admins = await tx.get(
      r
        .members(tenantId)
        .where("role", "==", "admin")
        .where("active", "==", true),
    );
    if (!admins.docs.some((doc) => doc.id !== targetUid))
      throw new IdentityError(
        409,
        "last_admin",
        "An agency needs at least one active administrator. Make someone else an administrator first.",
      );
  }

  async function verifyAppCheck(request: Request) {
    if (!deps.appCheck) return;
    const token = request.header("x-firebase-appcheck");
    const refused = new IdentityError(
      401,
      "app_check_failed",
      "This app could not be verified. Reload the page and try again.",
    );
    if (!token || token.length > 4096) throw refused;
    try {
      await deps.appCheck.verifyToken(token);
    } catch {
      throw refused;
    }
  }

  router.use(
    "/identity",
    rateLimit(requestLimitOptions(1000)),
    (_request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      next();
    },
    express.json({ limit: "16kb", type: "application/json" }),
    (request, _response, next) => {
      if (request.method === "POST" && !request.is("application/json"))
        next(
          new IdentityError(
            415,
            "json_required",
            "Send this request as application/json.",
          ),
        );
      else next();
    },
  );

  // Exchange a fresh ID token for an 8-hour session cookie.
  router.post(
    "/identity/session",
    route(async (request, response) => {
      const { idToken } = SessionBody.parse(request.body);
      await verifyAppCheck(request);
      let decoded: DecodedIdToken;
      try {
        decoded = await deps.auth.verifyIdToken(idToken, true);
      } catch {
        throw unauthorized();
      }
      if (decoded.email_verified !== true || typeof decoded.email !== "string")
        throw unauthorized();
      await assertPhoneIdentity(deps.auth, decoded, allowSms);
      const age = now().getTime() / 1000 - decoded.auth_time;
      if (!(age >= -60 && age <= RECENT_SIGN_IN_SECONDS))
        throw new IdentityError(
          401,
          "recent_sign_in_required",
          "Your sign-in has expired. Sign in again to continue.",
        );
      // With MFA required, a session needs a sign-in that used a second factor. The
      // browser then either asks for the code or sets up an authenticator first.
      if (requireMfa && !secondFactorOf(decoded)) {
        let enrolled = false;
        try {
          enrolled = ((await deps.auth.getUser(decoded.uid)).multiFactor?.enrolledFactors ?? []).length > 0;
        } catch {
          throw unauthorized();
        }
        throw enrolled
          ? new IdentityError(401, "mfa_required", "Enter the code from your authenticator app to finish signing in.")
          : new IdentityError(403, "mfa_enrollment_required", "Set up an authenticator app to finish signing in.");
      }
      // Computed before minting so the browser cookie never outlives the session.
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
      let sessionCookie: string;
      try {
        sessionCookie = await deps.auth.createSessionCookie(idToken, {
          expiresIn: SESSION_DURATION_MS,
        });
      } catch {
        throw unauthorized();
      }
      response.json({ sessionCookie, expiresAt: expiresAt.toISOString() });
    }),
  );

  // The deployment's own sign-in email (optional). `{ sent: false }` tells the browser to
  // ask Firebase for its built-in email instead: mail isn't configured, this mailbox has
  // asked often lately, today's allowance is used up, or sending failed. Sign-in keeps
  // working either way, and the answer never depends on whether the address has an
  // account. Firebase's own email has its own abuse limits.
  const signInMailboxes = new TokenBuckets({ capacity: 3, refillPerSecond: 1 / 600 });
  let signInCapLoggedFor = "";
  async function takeSignInEmail(): Promise<boolean> {
    const day = utcDay(now());
    const ref = r.limit(`sign_in_emails_${day}`);
    const allowed = await deps.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const count = Number(doc.get("count") ?? 0);
      if (Number.isFinite(count) && count >= limits.signInEmailsPerDay) return false;
      tx.set(ref, { count: (Number.isFinite(count) ? count : 0) + 1, updatedAt: Timestamp.fromDate(now()) });
      return true;
    });
    if (!allowed && signInCapLoggedFor !== day) {
      signInCapLoggedFor = day;
      console.warn("OpenAMS sign-in emails today reached AMS_SIGN_IN_EMAIL_DAILY_LIMIT; Firebase sends the rest");
    }
    return allowed;
  }
  router.post(
    "/identity/sign-in-link",
    rateLimit(requestLimitOptions(20)),
    route(async (request, response) => {
      const mail = deps.signInMail;
      if (!mail) {
        response.json({ sent: false });
        return;
      }
      await verifyAppCheck(request);
      const input = SignInLinkBody.parse(request.body);
      const phoneSetup = input.phoneSetup === true && allowSms;
      // Aliases of one inbox share an allowance, so +tags can't multiply the mail.
      if (!signInMailboxes.take(canonicalMailbox(input.email).mailbox)) {
        response.json({ sent: false });
        return;
      }
      try {
        if (!(await takeSignInEmail())) {
          response.json({ sent: false });
          return;
        }
        const generated = await deps.auth.generateSignInWithEmailLink(input.email, {
          url: `${mail.appOrigin}${FINISH_PATH}${phoneSetup ? "?phone=add" : ""}`,
          handleCodeInApp: true,
        });
        await mail.send({
          to: input.email,
          link: appSignInLink(generated, mail.appOrigin, phoneSetup),
        });
      } catch (error) {
        // No address is logged; Firebase and SMTP error codes say what went wrong.
        const code = (error as { code?: unknown } | null)?.code;
        console.error("sign_in_mail_failed", typeof code === "string" ? code : "");
        response.json({ sent: false });
        return;
      }
      response.json({ sent: true });
    }),
  );

  // Revokes every session for this user (all devices).
  router.post(
    "/identity/sign-out",
    sessionThen,
    route(async (request, response) => {
      EmptyBody.parse(request.body ?? {});
      await deps.auth.revokeRefreshTokens(response.locals.identity.uid);
      response.json({ ok: true });
    }),
  );

  /** A person's pending invitations that are still open, read outside any transaction. */
  async function openInvitationsFor(email: string, current: Date) {
    const docs = (await r.invitations.where("email", "==", email).where("status", "==", "pending").get()).docs;
    const open = [];
    for (const doc of docs) {
      const data = doc.data() as InvitationDoc;
      if (data.status !== "pending") continue;
      const closes = closesAt(data, await ttlHoursFor(data.tenantId));
      if (closes > current.getTime()) open.push({ doc, data, closes });
    }
    return open;
  }

  router.get(
    "/identity/me",
    sessionThen,
    route(async (_request, response) => {
      const { uid, email } = response.locals.identity;
      const membership = await loadMembership(deps.db, uid);
      const agency = membership
        ? await r.agency(membership.tenantId).get()
        : null;
      const current = now();
      const invitations = membership ? [] : await openInvitationsFor(email, current);
      const agencies = new Map<string, { name: string; createdAt: string | null }>();
      for (const { data } of invitations)
        if (!agencies.has(data.tenantId)) {
          const doc = await r.agency(data.tenantId).get();
          const createdAt = doc.get("createdAt");
          agencies.set(data.tenantId, {
            name: String(doc.get("name") ?? "An agency"),
            createdAt:
              createdAt instanceof Timestamp
                ? createdAt.toDate().toISOString()
                : null,
          });
        }
      // Open sign-up: anyone without a membership may try (limits apply on create).
      // Otherwise first-run setup: only an install-time administrator, only while this
      // instance has no agency. Someone with an open invitation accepts or declines it
      // first (POST /identity/agencies refuses too).
      const setupAvailable =
        !membership &&
        invitations.length === 0 &&
        (signup === "open" ||
          (adminEmails.has(email) && (await r.anyAgency.get()).empty));
      response.json({
        uid,
        email,
        setupAvailable,
        signup,
        mfaRequired: requireMfa,
        terms,
        access: membership && deps.access ? await deps.access.view(membership.tenantId) : null,
        membership: membership
          ? {
              tenantId: membership.tenantId,
              role: membership.member.role,
              name: membership.member.name,
              active: membership.member.active,
              agencyName: String(agency?.get("name") ?? ""),
            }
          : null,
        // Shown so the person knows to open their invitation link. The id lets them
        // decline; accepting takes the secret that only the link carries.
        pendingInvitations: invitations.map(({ doc, data, closes }) => ({
          id: doc.id,
          agencyName: agencies.get(data.tenantId)?.name ?? "An agency",
          agencyCreatedAt: agencies.get(data.tenantId)?.createdAt ?? null,
          invitedByEmail: data.invitedByEmail ?? null,
          role: data.role,
          expiresAt: new Date(closes).toISOString(),
          // Sent before invitation links existed: accepted from this page until it closes.
          linkRequired: Boolean(data.tokenHash),
        })),
      });
    }),
  );

  // Agency creation: open sign-up, or first-run setup by an install-time administrator.
  router.post(
    "/identity/agencies",
    sessionThen,
    route(async (request, response) => {
      const input = AgencyBody.parse(request.body);
      const { uid, email } = response.locals.identity;
      if (terms && input.acceptTerms !== terms.version)
        throw new IdentityError(
          400,
          "terms_required",
          input.acceptTerms
            ? "The terms have changed since this page loaded. Reload it and review them."
            : "Agree to the terms to create an agency.",
        );
      if (signup !== "open" && !adminEmails.has(email))
        throw new IdentityError(
          403,
          adminEmails.size ? "setup_not_allowed" : "setup_not_configured",
          adminEmails.size
            ? "Only this OpenAMS's administrator can set up the agency. Ask them for an invitation."
            : "This OpenAMS has no administrator email configured (AMS_ADMIN_EMAIL), so the agency can't be set up yet.",
        );
      const current = now();
      const tenantId = `agency_${randomId(18)}`;
      const userRef = r.user(uid);
      const agencyRef = r.agency(tenantId);
      const name = input.displayName ?? emailName(email);
      // "admin" mode: created with the agency, so a second setup fails even under a race.
      const instanceRef = r.limit("instance_agency");
      // "open" mode: one agency per person and per mailbox, ever; daily caps.
      const { mailbox, domain } = canonicalMailbox(email);
      const creatorRef = r.limit(`agency_creator_${uid}`);
      const mailboxRef = r.limit(`agency_mailbox_${sha(mailbox)}`);
      const domainRef = PUBLIC_MAIL_DOMAINS.has(domain)
        ? null
        : r.limit(`agencies_domain_${sha(domain).slice(0, 32)}_${utcDay(current)}`);
      const dayRef = r.limit(`agencies_${utcDay(current)}`);
      let dailyCount = 0;
      await deps.db.runTransaction(async (tx) => {
        const [user, agency] = await tx.getAll(userRef, agencyRef);
        if (typeof user.get("tenantId") === "string")
          throw new IdentityError(409, "already_member", "You already belong to an agency.");
        if (agency.exists) throw new IdentityError(409, "conflict", "Try again.");
        // Someone invited to an agency accepts or declines that first. Read in the
        // transaction, so an invitation arriving at the same moment is seen.
        const invited = await tx.get(r.invitations.where("email", "==", email).where("status", "==", "pending"));
        for (const doc of invited.docs) {
          const data = doc.data() as InvitationDoc;
          if (data.status === "pending" && closesAt(data, await ttlHoursFor(data.tenantId)) > current.getTime())
            throw new IdentityError(
              409,
              "invitation_pending",
              "You have an invitation to join an agency. Accept or decline it first.",
            );
        }
        const at = Timestamp.fromDate(current);
        if (signup === "open") {
          const [creator, mailboxUsed, day, ...rest] = await tx.getAll(
            creatorRef,
            mailboxRef,
            dayRef,
            ...(domainRef ? [domainRef] : []),
          );
          const domainDay = rest[0];
          if (creator.exists || mailboxUsed.exists)
            throw new IdentityError(429, "agency_limit_reached", "This email address has already created an agency.");
          const domainCount = Number(domainDay?.get("count") ?? 0);
          if (domainRef && domainCount >= limits.agenciesPerDomainPerDay)
            throw new IdentityError(
              429,
              "agency_domain_limit",
              "Too many agencies were created from this email domain today. Try again tomorrow.",
            );
          const count = Number(day.get("count") ?? 0);
          if (count >= limits.agenciesPerDay)
            throw new IdentityError(429, "agency_daily_limit", "New agency sign-ups are paused for today. Try again tomorrow.");
          tx.create(creatorRef, { tenantId, createdAt: at });
          tx.create(mailboxRef, { tenantId, createdAt: at });
          tx.set(dayRef, { count: count + 1, updatedAt: at });
          if (domainRef) tx.set(domainRef, { count: domainCount + 1, updatedAt: at });
          dailyCount = count + 1;
        } else {
          const instance = await tx.get(instanceRef);
          // The query also covers agencies created before the instance marker existed.
          const existing = await tx.get(r.anyAgency);
          if (instance.exists || !existing.empty)
            throw new IdentityError(
              409,
              "agency_exists",
              "This OpenAMS is already set up. Ask its administrator for an invitation.",
            );
          tx.create(instanceRef, { tenantId, createdAt: at });
        }
        tx.create(agencyRef, {
          name: input.name,
          timeZone: input.timeZone,
          createdBy: uid,
          createdAt: at,
          // What the creator accepted on the agency's behalf, when terms are configured.
          ...(terms ? { termsAccepted: { version: terms.version, uid, email, at } } : {}),
        });
        tx.create(r.member(tenantId, uid), {
          role: "admin",
          name,
          email,
          active: true,
          createdAt: at,
          updatedAt: at,
        });
        tx.set(userRef, { email, tenantId, updatedAt: at });
        audit(tx, tenantId, {
          actorUid: uid,
          action: "agency.created",
          targetUid: uid,
          afterRole: "admin",
          afterActive: true,
        });
      });
      // A log-based alert on this line warns before the backstop cap is hit.
      if (dailyCount >= Math.ceil(limits.agenciesPerDay / 2))
        console.warn(`OpenAMS agency sign-ups today: ${dailyCount} of ${limits.agenciesPerDay} (daily backstop).`);
      response.status(201).json({
        membership: {
          tenantId,
          role: "admin",
          name,
          active: true,
          agencyName: input.name,
        },
      });
    }),
  );

  // External access control: a short-lived signed link to the outside system's page, for
  // the agency's administrators only.
  router.post(
    "/identity/access-link",
    sessionThen,
    requireMember(["admin"]),
    route(async (request, response) => {
      EmptyBody.parse(request.body ?? {});
      if (!deps.access) throw notFound();
      const { uid, email } = response.locals.identity;
      const { tenantId } = response.locals.membership;
      const agency = await r.agency(tenantId).get();
      const { link } = deps.access;
      const token = signAccessToken(
        { appOrigin: link.appOrigin, accessUrl: link.url, tenantId, agencyName: String(agency.get("name") ?? ""), uid, email },
        link.secret,
        now(),
      );
      const url = new URL(link.url);
      url.searchParams.set("token", token);
      response.json({ url: url.toString() });
    }),
  );

  // Invitations. Two things are needed to accept one: email-link sign-in as the invited
  // address (the proof of who you are), and the secret from the invitation link (so an
  // invitation is accepted only from the link that was sent). Only the secret's hash is
  // stored. The link carries it after "#", so it never reaches a server log or a Referer.
  /**
   * Emails the invitee when mail is configured. With external access control on, only
   * an active agency sends mail, so an agency that was never approved can't use this
   * deployment to write to strangers. With open sign-up and no access control, nobody
   * vets an agency, so only its first few invitations each day are emailed. Returns
   * whether an email went out.
   */
  async function sendInvitation(
    tenantId: string,
    invitationId: string,
    token: string,
    data: InvitationDoc,
    invitedToday: number,
  ): Promise<boolean> {
    if (!deps.invitationMail) return false;
    const mayEmail = deps.access
      ? (await deps.access.view(tenantId))?.state === "active"
      : signup !== "open" ||
        invitedToday <= limits.openSignupInvitationEmailsPerAgencyPerDay;
    if (!mayEmail) return false;
    try {
      const agency = await r.agency(tenantId).get();
      await deps.invitationMail({
        to: data.email,
        agencyName: String(agency.get("name") ?? ""),
        invitedByEmail: data.invitedByEmail ?? "",
        role: data.role,
        expiresAt: data.expiresAt.toDate(),
        invitationId,
        token,
      });
      return true;
    } catch {
      // The invitation stands; the inviter is told no email went out. No address or
      // link is logged.
      console.error("invitation_mail_failed");
      return false;
    }
  }

  router.post(
    "/identity/invitations",
    sessionThen,
    requireMember(MANAGERS),
    route(async (request, response) => {
      const input = InvitationBody.parse(request.body);
      const { uid, email: ownEmail } = response.locals.identity;
      const { tenantId } = response.locals.membership;
      if (input.email === ownEmail)
        throw new IdentityError(
          409,
          "already_member",
          "You are already a member of this agency.",
        );
      const current = now();
      const id = randomId(18);
      const token = newInvitationToken();
      const ttlHours = await ttlHoursFor(tenantId);
      const dayRef = r.limit(`invitations_${tenantId}_${utcDay(current)}`);
      const data: InvitationDoc = {
        tenantId,
        email: input.email,
        role: input.role,
        status: "pending",
        tokenHash: sha(token),
        invitedBy: uid,
        invitedByEmail: ownEmail,
        createdAt: Timestamp.fromDate(current),
        expiresAt: Timestamp.fromMillis(current.getTime() + ttlHours * HOUR_MS),
      };
      let invitedToday = 0;
      await deps.db.runTransaction(async (tx) => {
        const actor = await actorInTransaction(tx, tenantId, uid);
        if (!canAssignRole(actor.role, input.role))
          throw new IdentityError(
            403,
            "role_not_allowed",
            "You can't invite someone with a role above your own.",
          );
        const day = await tx.get(dayRef);
        const existingMember = await tx.get(
          r.members(tenantId).where("email", "==", input.email).limit(1),
        );
        const existingInvites = await tx.get(
          r.invitations.where("email", "==", input.email).limit(50),
        );
        if (!existingMember.empty)
          throw new IdentityError(
            409,
            "already_member",
            "That person is already a member of this agency.",
          );
        if (
          existingInvites.docs.some((doc) => {
            const invite = doc.data() as InvitationDoc;
            return (
              invite.tenantId === tenantId &&
              invite.status === "pending" &&
              closesAt(invite, ttlHours) > current.getTime()
            );
          })
        )
          throw new IdentityError(
            409,
            "invitation_exists",
            "That person already has a pending invitation.",
          );
        const count = Number(day.get("count") ?? 0);
        if (count >= limits.invitationsPerAgencyPerDay)
          throw new IdentityError(
            429,
            "invitation_daily_limit",
            "Your agency has reached today's invitation limit. Try again tomorrow.",
          );
        tx.create(r.invitations.doc(id), data);
        tx.set(dayRef, { count: count + 1, updatedAt: data.createdAt });
        invitedToday = count + 1;
        audit(tx, tenantId, {
          actorUid: uid,
          action: "invitation.created",
          invitationId: id,
          email: input.email,
          afterRole: input.role,
        });
      });
      // The response says what actually happened (see sendInvitation).
      const emailed = await sendInvitation(tenantId, id, token, data, invitedToday);
      response.status(201).json({
        invitation: invitationView(id, data, current, ttlHours),
        emailed,
        // Only when no email went out, so the inviter can pass the link on themselves.
        ...(emailed ? {} : { token }),
      });
    }),
  );

  // Resend: a new link secret (the old link stops working) and a fresh lifetime. Counts
  // toward the agency's daily invitation limit.
  router.post(
    "/identity/invitations/:id/resend",
    sessionThen,
    requireMember(MANAGERS),
    route(async (request, response) => {
      const id = InvitationId.parse(request.params.id);
      EmptyBody.parse(request.body);
      const { uid, email: ownEmail } = response.locals.identity;
      const { tenantId } = response.locals.membership;
      const current = now();
      const token = newInvitationToken();
      const ttlHours = await ttlHoursFor(tenantId);
      const ref = r.invitations.doc(id);
      const dayRef = r.limit(`invitations_${tenantId}_${utcDay(current)}`);
      let invitedToday = 0;
      const data = await deps.db.runTransaction(async (tx) => {
        const actor = await actorInTransaction(tx, tenantId, uid);
        const [snapshot, day] = await tx.getAll(ref, dayRef);
        const invite = snapshot.data() as InvitationDoc | undefined;
        if (!invite || invite.tenantId !== tenantId) throw notFound();
        if (!canAssignRole(actor.role, invite.role))
          throw new IdentityError(
            403,
            "role_not_allowed",
            "Only an administrator can resend an administrator invitation.",
          );
        if (invite.status !== "pending")
          throw new IdentityError(
            409,
            "invitation_not_pending",
            "This invitation was already used, declined or revoked.",
          );
        const count = Number(day.get("count") ?? 0);
        if (count >= limits.invitationsPerAgencyPerDay)
          throw new IdentityError(
            429,
            "invitation_daily_limit",
            "Your agency has reached today's invitation limit. Try again tomorrow.",
          );
        const at = Timestamp.fromDate(current);
        const next: InvitationDoc = {
          ...invite,
          tokenHash: sha(token),
          invitedBy: uid,
          invitedByEmail: ownEmail,
          createdAt: at,
          expiresAt: Timestamp.fromMillis(current.getTime() + ttlHours * HOUR_MS),
        };
        tx.update(ref, {
          tokenHash: next.tokenHash,
          invitedBy: uid,
          invitedByEmail: ownEmail,
          createdAt: at,
          expiresAt: next.expiresAt,
        });
        tx.set(dayRef, { count: count + 1, updatedAt: at });
        invitedToday = count + 1;
        audit(tx, tenantId, {
          actorUid: uid,
          action: "invitation.resent",
          invitationId: id,
          email: invite.email,
          afterRole: invite.role,
        });
        return next;
      });
      const emailed = await sendInvitation(tenantId, id, token, data, invitedToday);
      response.json({
        invitation: invitationView(id, data, current, ttlHours),
        emailed,
        ...(emailed ? {} : { token }),
      });
    }),
  );

  router.get(
    "/identity/invitations",
    sessionThen,
    requireMember(MANAGERS),
    route(async (_request, response) => {
      const current = now();
      const { tenantId } = response.locals.membership;
      const ttlHours = await ttlHoursFor(tenantId);
      const snapshot = await r.invitations
        .where("tenantId", "==", tenantId)
        .limit(500)
        .get();
      response.json({
        invitations: snapshot.docs
          .map((doc) =>
            invitationView(doc.id, doc.data() as InvitationDoc, current, ttlHours),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      });
    }),
  );

  router.post(
    "/identity/invitations/:id/revoke",
    sessionThen,
    requireMember(MANAGERS),
    route(async (request, response) => {
      const id = InvitationId.parse(request.params.id);
      EmptyBody.parse(request.body);
      const { uid } = response.locals.identity;
      const { tenantId } = response.locals.membership;
      const current = now();
      const ttlHours = await ttlHoursFor(tenantId);
      const ref = r.invitations.doc(id);
      const view = await deps.db.runTransaction(async (tx) => {
        const actor = await actorInTransaction(tx, tenantId, uid);
        const snapshot = await tx.get(ref);
        const invite = snapshot.data() as InvitationDoc | undefined;
        // Another agency's invitation is indistinguishable from a missing one.
        if (!invite || invite.tenantId !== tenantId) throw notFound();
        if (!canAssignRole(actor.role, invite.role))
          throw new IdentityError(
            403,
            "role_not_allowed",
            "Only an administrator can revoke an administrator invitation.",
          );
        if (invite.status !== "pending")
          throw new IdentityError(
            409,
            "invitation_not_pending",
            "This invitation was already accepted, declined or revoked.",
          );
        tx.update(ref, {
          status: "revoked",
          revokedBy: uid,
          revokedAt: Timestamp.fromDate(current),
        });
        audit(tx, tenantId, {
          actorUid: uid,
          action: "invitation.revoked",
          invitationId: id,
          email: invite.email,
          beforeRole: invite.role,
        });
        return invitationView(id, { ...invite, status: "revoked" }, current, ttlHours);
      });
      response.json({ invitation: view });
    }),
  );

  /**
   * Who may act on an invitation. With a link (every invitation sent since links
   * existed): the secret must match, then the signed-in email must be the invited one.
   * A wrong or missing secret looks exactly like a missing invitation. Only someone
   * holding the real link learns that it was meant for another address, never which.
   * Without a link (older invitations): the email alone, and a mismatch is a 404 too.
   */
  function checkInvitation(
    invite: InvitationDoc | undefined,
    token: string | undefined,
    email: string,
    legacy: "allow" | "refuse",
  ): InvitationDoc {
    if (!invite) throw notFound();
    if (invite.tokenHash) {
      if (!tokenMatches(token, invite.tokenHash)) throw notFound();
      if (invite.email !== email)
        throw new IdentityError(
          403,
          "invitation_wrong_email",
          "This invitation was sent to a different email address. Sign out, then sign in with the address it was sent to.",
        );
      return invite;
    }
    if (legacy === "refuse" || invite.email !== email) throw notFound();
    return invite;
  }
  function assertOpen(invite: InvitationDoc, ttlHours: number, current: Date) {
    if (invite.status !== "pending")
      throw new IdentityError(
        409,
        "invitation_not_pending",
        "This invitation was already used, declined or revoked.",
      );
    if (closesAt(invite, ttlHours) <= current.getTime())
      throw new IdentityError(
        410,
        "invitation_expired",
        "This invitation has expired. Ask the agency to invite you again.",
      );
  }
  /** The invitation's agency lifetime, read before a transaction (the tenant never changes). */
  async function ttlForInvitation(id: string): Promise<number> {
    const tenantId = (await r.invitations.doc(id).get()).get("tenantId");
    return typeof tenantId === "string" ? ttlHoursFor(tenantId) : deploymentTtlHours;
  }

  // Preview: what the invitation link is for, after sign-in, changing nothing. Takes the
  // link secret in the body (never in a URL).
  router.post(
    "/identity/invitations/preview",
    linkAdmission,
    sessionThen,
    linkLimited,
    route(async (request, response) => {
      const input = LinkBody.parse(request.body);
      const { uid, email } = response.locals.identity;
      const current = now();
      const ttlHours = await ttlForInvitation(input.invitationId);
      const [snapshot, user] = await deps.db.getAll(r.invitations.doc(input.invitationId), r.user(uid));
      const invite = checkInvitation(snapshot.data() as InvitationDoc | undefined, input.token, email, "refuse");
      assertOpen(invite, ttlHours, current);
      const [agency, inviterDoc] = await deps.db.getAll(
        r.agency(invite.tenantId),
        r.member(invite.tenantId, invite.invitedBy),
      );
      if (!agency.exists) throw notFound();
      const inviter = inviterDoc.exists ? memberOf(inviterDoc.data()) : null;
      if (!inviter || !inviter.active || !canAssignRole(inviter.role, invite.role))
        throw new IdentityError(
          410,
          "invitation_withdrawn",
          "This invitation is no longer valid. Ask the agency to invite you again.",
        );
      response.json({
        invitation: {
          agencyName: String(agency.get("name") ?? "An agency"),
          role: invite.role,
          invitedByEmail: invite.invitedByEmail ?? null,
          expiresAt: new Date(closesAt(invite, ttlHours)).toISOString(),
        },
        alreadyMember: typeof user.get("tenantId") === "string",
      });
    }),
  );

  // Accept: the invitation link's secret and the verified invited email, no membership yet.
  router.post(
    "/identity/invitations/accept",
    linkAdmission,
    sessionThen,
    linkLimited,
    route(async (request, response) => {
      const input = AcceptBody.parse(request.body);
      const { uid, email } = response.locals.identity;
      const current = now();
      const ttlHours = await ttlForInvitation(input.invitationId);
      const ref = r.invitations.doc(input.invitationId);
      const userRef = r.user(uid);
      const name = input.displayName ?? emailName(email);
      let withoutLink = false;
      const result = await deps.db.runTransaction(async (tx) => {
        const [snapshot, user] = await tx.getAll(ref, userRef);
        const invite = checkInvitation(snapshot.data() as InvitationDoc | undefined, input.token, email, "allow");
        withoutLink = !invite.tokenHash;
        assertOpen(invite, ttlHours, current);
        if (typeof user.get("tenantId") === "string")
          throw new IdentityError(
            409,
            "already_member",
            "You already belong to an agency.",
          );
        const memberRef = r.member(invite.tenantId, uid);
        const [agency, member, inviterDoc] = await tx.getAll(
          r.agency(invite.tenantId),
          memberRef,
          r.member(invite.tenantId, invite.invitedBy),
        );
        if (!agency.exists) throw notFound();
        // The invitation is only as good as its sender's current authority: a deactivated
        // or demoted inviter's pending invitations stop working.
        const inviter = inviterDoc.exists ? memberOf(inviterDoc.data()) : null;
        if (!inviter || !inviter.active || !canAssignRole(inviter.role, invite.role))
          throw new IdentityError(
            410,
            "invitation_withdrawn",
            "This invitation is no longer valid. Ask the agency to invite you again.",
          );
        if (member.exists)
          throw new IdentityError(
            409,
            "already_member",
            "You already belong to this agency.",
          );
        const at = Timestamp.fromDate(current);
        tx.create(memberRef, {
          role: invite.role,
          name,
          email,
          active: true,
          createdAt: at,
          updatedAt: at,
        });
        tx.set(userRef, { email, tenantId: invite.tenantId, updatedAt: at });
        tx.update(ref, { status: "accepted", acceptedBy: uid, acceptedAt: at });
        audit(tx, invite.tenantId, {
          actorUid: uid,
          action: "invitation.accepted",
          invitationId: input.invitationId,
          targetUid: uid,
          email,
          afterRole: invite.role,
          afterActive: true,
        });
        return {
          tenantId: invite.tenantId,
          role: invite.role,
          name,
          active: true,
          agencyName: String(agency.get("name") ?? ""),
        };
      });
      // Counted so the path for invitations sent before links existed can be removed
      // once none are left. Nothing identifying is logged.
      if (withoutLink) console.info("invitation_accepted_without_link");
      response.json({ membership: result });
    }),
  );

  // Decline: only the invited person. From the link (secret and email), or from the
  // signed-in page by email alone, so a lost link never traps anyone. Declining is what
  // lets someone with an invitation create their own agency instead.
  router.post(
    "/identity/invitations/decline",
    linkAdmission,
    sessionThen,
    linkLimited,
    route(async (request, response) => {
      const input = DeclineBody.parse(request.body);
      const { uid, email } = response.locals.identity;
      const current = now();
      const ttlHours = await ttlForInvitation(input.invitationId);
      const ref = r.invitations.doc(input.invitationId);
      await deps.db.runTransaction(async (tx) => {
        const found = (await tx.get(ref)).data() as InvitationDoc | undefined;
        let invite: InvitationDoc;
        if (input.token) invite = checkInvitation(found, input.token, email, "refuse");
        else if (found && found.email === email) invite = found;
        else throw notFound();
        assertOpen(invite, ttlHours, current);
        const at = Timestamp.fromDate(current);
        tx.update(ref, { status: "declined", declinedBy: uid, declinedAt: at });
        audit(tx, invite.tenantId, {
          actorUid: uid,
          action: "invitation.declined",
          invitationId: input.invitationId,
          targetUid: uid,
          email,
          beforeRole: invite.role,
        });
      });
      response.json({ declined: true });
    }),
  );

  // Members.
  router.get(
    "/identity/members",
    sessionThen,
    requireMember(),
    route(async (_request, response) => {
      const members = await firestoreMembers(deps.db)(response.locals.membership.tenantId);
      // Who has an authenticator set up, for administrators and managers to follow up.
      // Best effort: the list still loads if the sign-in service can't be asked.
      let enrolled: Set<string> | null = null;
      if (MANAGERS.includes(response.locals.membership.member.role)) {
        try {
          enrolled = new Set();
          for (let i = 0; i < members.length; i += 100) {
            const { users } = await deps.auth.getUsers(members.slice(i, i + 100).map((m) => ({ uid: m.id })));
            for (const user of users)
              if ((user.multiFactor?.enrolledFactors ?? []).length) enrolled.add(user.uid);
          }
        } catch {
          enrolled = null;
        }
      }
      response.json({
        members: members.map((member) =>
          enrolled ? { ...member, secondFactor: enrolled.has(member.id) } : member,
        ),
      });
    }),
  );

  // An administrator removes a member's authenticator (lost phone). The member sets up a
  // new one at their next sign-in; their current sessions end now. Not for yourself:
  // another administrator does it, so one stolen session can't remove the factor.
  router.post(
    "/identity/members/:uid/reset-mfa",
    sessionThen,
    requireMember(["admin"]),
    route(async (request, response) => {
      const targetUid = MemberId.parse(request.params.uid);
      EmptyBody.parse(request.body ?? {});
      const { uid } = response.locals.identity;
      const { tenantId } = response.locals.membership;
      if (targetUid === uid)
        throw new IdentityError(409, "cannot_change_self", "Ask another administrator to reset your authenticator.");
      await deps.db.runTransaction(async (tx) => {
        const actor = await actorInTransaction(tx, tenantId, uid);
        if (actor.role !== "admin")
          throw new IdentityError(403, "role_not_allowed", "Only an administrator can reset an authenticator.");
        // Members of other agencies are indistinguishable from missing ones.
        if (!(await tx.get(r.member(tenantId, targetUid))).exists) throw notFound();
        audit(tx, tenantId, { actorUid: uid, action: "member.mfa_reset", targetUid });
      });
      await deps.auth.updateUser(targetUid, { multiFactor: { enrolledFactors: null } });
      const sessionsRevoked = await deps.auth
        .revokeRefreshTokens(targetUid)
        .then(() => true, () => false);
      response.json({ ok: true, sessionsRevoked });
    }),
  );

  const changeMember = (
    action: "role" | "deactivate" | "reactivate",
  ): RequestHandler =>
    route(async (request, response) => {
      const targetUid = MemberId.parse(request.params.uid);
      const input =
        action === "role"
          ? RoleBody.parse(request.body)
          : (EmptyBody.parse(request.body), null);
      const { uid } = response.locals.identity;
      const { tenantId } = response.locals.membership;
      if (action !== "role" && targetUid === uid)
        throw new IdentityError(
          409,
          "cannot_change_self",
          "Ask another administrator to change your own access.",
        );
      const current = now();
      const ref = r.member(tenantId, targetUid);
      const updated = await deps.db.runTransaction(async (tx) => {
        const actor = await actorInTransaction(tx, tenantId, uid);
        const snapshot = await tx.get(ref);
        // Members of other agencies are indistinguishable from missing ones.
        if (!snapshot.exists) throw notFound();
        const target = memberOf(snapshot.data());
        if (target.role === "admin" && actor.role !== "admin")
          throw new IdentityError(
            403,
            "role_not_allowed",
            "Only an administrator can change an administrator.",
          );
        const next: MemberDoc = {
          ...target,
          role: input?.role ?? target.role,
          active:
            action === "deactivate"
              ? false
              : action === "reactivate"
                ? true
                : target.active,
        };
        if (!canAssignRole(actor.role, next.role))
          throw new IdentityError(
            403,
            "role_not_allowed",
            "You can't grant a role above your own.",
          );
        if (next.role === target.role && next.active === target.active)
          return { id: targetUid, ...target };
        if (
          target.role === "admin" &&
          target.active &&
          (next.role !== "admin" || !next.active)
        )
          await assertAnotherActiveAdmin(tx, tenantId, targetUid);
        tx.update(ref, {
          role: next.role,
          active: next.active,
          updatedAt: Timestamp.fromDate(current),
        });
        audit(tx, tenantId, {
          actorUid: uid,
          action:
            action === "role" ? "member.role_changed" : `member.${action}d`,
          targetUid,
          beforeRole: target.role,
          afterRole: next.role,
          beforeActive: target.active,
          afterActive: next.active,
        });
        return { id: targetUid, ...next };
      });
      let sessionsRevoked: boolean | undefined;
      if (action === "deactivate") {
        // Belt and braces: authenticate also refuses inactive members on every request.
        sessionsRevoked = await deps.auth
          .revokeRefreshTokens(targetUid)
          .then(() => true)
          .catch(() => false);
      }
      response.json({
        member: {
          id: updated.id,
          name: updated.name,
          email: updated.email,
          role: updated.role,
          active: updated.active,
        },
        ...(sessionsRevoked === undefined ? {} : { sessionsRevoked }),
      });
    });
  router.post(
    "/identity/members/:uid/role",
    sessionThen,
    requireMember(MANAGERS),
    changeMember("role"),
  );
  router.post(
    "/identity/members/:uid/deactivate",
    sessionThen,
    requireMember(MANAGERS),
    changeMember("deactivate"),
  );
  router.post(
    "/identity/members/:uid/reactivate",
    sessionThen,
    requireMember(MANAGERS),
    changeMember("reactivate"),
  );

  router.use("/identity", (_request: Request, response: Response) => {
    response.status(404).json({ error: "not_found", message: "Not found." });
  });
  router.use(
    "/identity",
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof IdentityError) {
        response
          .status(error.status)
          .json({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        response.status(400).json({
          error: "invalid_request",
          message: "Check the details and try again.",
        });
        return;
      }
      const type = (error as { type?: string } | null)?.type;
      if (type === "entity.too.large") {
        response
          .status(413)
          .json({ error: "too_large", message: "This request is too large." });
        return;
      }
      if (type === "entity.parse.failed") {
        response.status(400).json({
          error: "invalid_request",
          message: "Check the details and try again.",
        });
        return;
      }
      // Never log the error object: it can carry tokens or email addresses.
      console.error("Identity request failed.");
      response.status(500).json({
        error: "identity_failed",
        message: "The request failed. No change has been confirmed.",
      });
    },
  );
  return router;
}

