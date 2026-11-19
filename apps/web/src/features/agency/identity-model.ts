import type { AmsMember } from "@openams/contracts";
import { AgencyRequestError } from "./model";

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
  /** True when this person may create an agency now: with open sign-up, anyone whose inbox hasn't created one; otherwise only an install-time administrator while the deployment has no agency. */
  setupAvailable: boolean;
  /** Open sign-up: this person, or another address of their inbox, already created an agency, so they can't create another. */
  agencyLimitReached?: boolean;
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
  }[];
}
export interface IdentityInvitation {
  id: string;
  email: string;
  role: IdentityRole;
  status: "pending" | "accepted" | "revoked" | "expired";
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
