import type { AmsMember } from "@openams/contracts";
import { AgencyRequestError, announceSessionEnded } from "./model";

export type IdentityRole = AmsMember["role"];
export const IDENTITY_ROLES: IdentityRole[] = [
  "admin",
  "manager",
  "member",
  "accountant",
  "viewer",
];
export interface IdentityMembership {
  tenantId: string;
  role: IdentityRole;
  name: string;
  active: boolean;
  agencyName: string;
}
export interface IdentityMe {
  uid: string;
  email: string;
  /** True when this person may create an agency now: anyone with open sign-up, otherwise only an install-time administrator while the deployment has no agency. */
  setupAvailable: boolean;
  /** "open": anyone can create an agency; "admin": one agency, set up by its administrator. */
  signup?: "open" | "admin";
  /** Every sign-in needs a second factor (AMS_REQUIRE_MFA). */
  mfaRequired?: boolean;
  /** Terms whoever creates an agency accepts on its behalf (AMS_TERMS_URL / AMS_TERMS_VERSION). */
  terms?: { url: string; version: string } | null;
  /** External access control (null when the deployment doesn't use it). */
  access?: {
    state: "pending" | "active" | "read_only" | "suspended";
    message: string | null;
  } | null;
  membership: IdentityMembership | null;
  pendingInvitations: {
    id: string;
    agencyName: string;
    /** When the inviting agency was created; a brand-new agency deserves a second look. */
    agencyCreatedAt: string | null;
    invitedByEmail: string | null;
    role: IdentityRole;
    expiresAt: string;
    /** Accepted only from the invitation link; false for invitations sent before links existed. */
    linkRequired: boolean;
  }[];
}
export interface IdentityInvitation {
  id: string;
  email: string;
  role: IdentityRole;
  status: "pending" | "accepted" | "revoked" | "declined" | "expired";
  createdAt: string;
  expiresAt: string;
}
/** Mirrors the API rule: admins grant any role, managers any role but admin. */
export function canAssignRole(actor: IdentityRole, target: IdentityRole) {
  return actor === "admin" || (actor === "manager" && target !== "admin");
}
export async function identityRequest<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/identity/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const value = await response.json().catch(() => ({}));
  // Sign-in steps answer 401 with their own codes (mfa_required, …); only a refused
  // session means the workspace's session ended.
  if (response.status === 401 && value.error === "unauthorized")
    announceSessionEnded("signed_out");
  if (!response.ok)
    throw new AgencyRequestError(
      response.status,
      value.error || "request_failed",
      value.message || "The request failed.",
    );
  return value as T;
}
export async function hostedSignOut() {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store",
  }).catch(() => null);
  const value = await response?.json().catch(() => null);
  return { revoked: value?.revoked === true };
}
