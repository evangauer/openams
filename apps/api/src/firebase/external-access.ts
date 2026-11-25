// Optional external access control (AMS_ACCESS_CONTROL=external).
//
// Some deployments let an outside system decide whether each agency may use OpenAMS:
// a billing system, a compliance review, an onboarding process. When enabled:
// - every agency has an access state: pending (new, not yet activated), active,
//   read_only (view and export only) or suspended;
// - only one Google service account (AMS_ACCESS_SERVICE_ACCOUNT) can set it, through
//   PUT /internal/access/v1/agencies/{id}, verified like the reminder scheduler;
// - an agency administrator can follow a short-lived signed link (AMS_ACCESS_URL with a
//   token signed with AMS_ACCESS_LINK_SECRET) to the outside system's page.
// OpenAMS knows nothing about what the outside system does; it stores the state and an
// optional message to show, and enforces the state on every request.
//
// Off (the default), nothing here runs and every agency has full access.
import { createHmac, randomBytes } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { AmsActor } from "@openams/contracts";
import { IDENTITY_COLLECTIONS } from "./identity.js";
import { MAX_INVITATION_TTL_HOURS } from "./invitation-policy.js";

export const ACCESS_COLLECTION = "agency_access";
export const ACCESS_PATH = "/internal/access/v1/agencies/:tenantId";
export const ACCESS_STATES = ["pending", "active", "read_only", "suspended"] as const;
export type AccessState = (typeof ACCESS_STATES)[number];
export interface AccessView {
  state: AccessState;
  /** Plain text from the outside system, shown to the agency (e.g. a trial reminder). */
  message: string | null;
}

export interface ExternalAccessConfig {
  enabled: boolean;
  serviceAccount: string | undefined;
  url: string | undefined;
  secret: string | undefined;
}
/** Reads and validates the settings; throws on an incomplete configuration. */
export function externalAccessFromEnv(env: Record<string, string | undefined> = process.env): ExternalAccessConfig {
  const enabled = env.AMS_ACCESS_CONTROL?.trim().toLowerCase() === "external";
  const config = {
    enabled,
    serviceAccount: env.AMS_ACCESS_SERVICE_ACCOUNT?.trim() || undefined,
    url: env.AMS_ACCESS_URL?.trim() || undefined,
    secret: env.AMS_ACCESS_LINK_SECRET || undefined,
  };
  if (!enabled) return config;
  const problems: string[] = [];
  if (!config.serviceAccount?.endsWith(".iam.gserviceaccount.com")) problems.push("AMS_ACCESS_SERVICE_ACCOUNT");
  try {
    if (new URL(config.url ?? "").protocol !== "https:") problems.push("AMS_ACCESS_URL (https)");
  } catch {
    problems.push("AMS_ACCESS_URL");
  }
  if ((config.secret?.length ?? 0) < 32) problems.push("AMS_ACCESS_LINK_SECRET (32+ characters)");
  if (problems.length) throw new Error(`AMS_ACCESS_CONTROL=external needs ${problems.join(", ")}.`);
  return config;
}

const InvitationTtlHours = z.number().int().min(1).max(MAX_INVITATION_TTL_HOURS);
const StoredAccess = z.object({
  state: z.enum(ACCESS_STATES),
  message: z.string().max(300).nullable().optional(),
  /** This agency's invitation lifetime in hours; absent or null: the deployment's. */
  invitationTtlHours: InvitationTtlHours.nullable().optional(),
});
const ACCESS_CACHE_MS = 30_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const refusals: Record<Exclude<AccessState, "active">, { code: string; message: string }> = {
  pending: {
    code: "access_pending",
    message: "This agency isn't activated yet. An administrator can activate it from the sign-in page.",
  },
  read_only: {
    code: "access_read_only",
    message: "This agency is read-only: you can view and export everything, but changes are paused. An administrator can restore full access.",
  },
  suspended: {
    code: "access_suspended",
    message: "This agency's access is paused. An administrator can restore it.",
  },
};

/** Enforces each agency's access state on `/ams` and reports it to the workspace. */
export function createAccessControl(deps: { db: Firestore; enabled: boolean; actor: (response: Response) => AmsActor | undefined }) {
  const cache = new Map<string, { at: number; value: AccessView; invitationTtlHours: number | null }>();
  async function read(tenantId: string) {
    const hit = cache.get(tenantId);
    if (hit && Date.now() - hit.at < ACCESS_CACHE_MS) return hit;
    const snapshot = await deps.db.collection(ACCESS_COLLECTION).doc(tenantId).get();
    const parsed = snapshot.exists ? StoredAccess.safeParse(snapshot.data()) : null;
    // No record yet: a new agency waits for the outside system to activate it.
    const value: AccessView = parsed?.success
      ? { state: parsed.data.state, message: parsed.data.message ?? null }
      : { state: "pending", message: null };
    const entry = {
      at: Date.now(),
      value,
      invitationTtlHours: parsed?.success ? (parsed.data.invitationTtlHours ?? null) : null,
    };
    if (cache.size > 5000) cache.clear();
    cache.set(tenantId, entry);
    return entry;
  }
  const view = async (tenantId: string): Promise<AccessView> => (await read(tenantId)).value;
  const gate: RequestHandler = async (request, response, next) => {
    const actor = deps.actor(response);
    if (!deps.enabled || !actor) {
      next();
      return;
    }
    try {
      const { state } = await view(actor.tenantId);
      if (state === "active" || (state === "read_only" && SAFE_METHODS.has(request.method))) {
        next();
        return;
      }
      const refusal = refusals[state];
      response.status(402).json({ error: refusal.code, message: refusal.message });
    } catch (error) {
      next(error);
    }
  };
  return {
    gate,
    /** The agency's access for /identity/me, or null when access control is off. */
    access: async (tenantId: string) => (deps.enabled ? view(tenantId) : null),
    /** The agency's own invitation lifetime in hours, or null for the deployment's. */
    invitationTtlHours: async (tenantId: string) =>
      deps.enabled ? (await read(tenantId)).invitationTtlHours : null,
    /** Drop a cached state so a change applies at once on this instance. */
    forget: (tenantId: string) => cache.delete(tenantId),
  };
}

const TenantId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const noControl = /^[^\p{Cc}]*$/u;
const AccessBody = z
  .object({
    state: z.enum(ACCESS_STATES),
    message: z.string().trim().max(300).regex(noControl).nullable().default(null),

  })
  .strict();

/** The endpoint the outside system uses to read and set an agency's access state. */
export function createAccessApi(deps: {
  db: Firestore;
  enabled: boolean;
  authorize: RequestHandler;
  onChange?: (tenantId: string) => void;
  now?: () => Date;
}): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const off: RequestHandler = (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (!deps.enabled) {
      response.status(404).json({ error: "not_found", message: "Not found." });
      return;
    }
    next();
  };
  const agencyRef = (tenantId: string) => deps.db.collection(IDENTITY_COLLECTIONS.agencies).doc(tenantId);
  const accessRef = (tenantId: string) => deps.db.collection(ACCESS_COLLECTION).doc(tenantId);
  const parseId = (request: Request, response: Response) => {
    const parsed = TenantId.safeParse(request.params.tenantId);
    if (!parsed.success) response.status(404).json({ error: "not_found", message: "Not found." });
    return parsed.success ? parsed.data : null;
  };

  router.get(ACCESS_PATH, off, deps.authorize, async (request, response, next) => {
    try {
      const tenantId = parseId(request, response);
      if (!tenantId) return;
      const [agency, access] = await Promise.all([agencyRef(tenantId).get(), accessRef(tenantId).get()]);
      if (!agency.exists) {
        response.status(404).json({ error: "not_found", message: "Not found." });
        return;
      }
      const parsed = access.exists ? StoredAccess.safeParse(access.data()) : null;
      response.json({
        tenantId,
        state: parsed?.success ? parsed.data.state : "pending",
        message: parsed?.success ? (parsed.data.message ?? null) : null,
        invitationTtlHours: parsed?.success ? (parsed.data.invitationTtlHours ?? null) : null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.put(`${ACCESS_PATH}/invitation-lifetime`, off, deps.authorize, async (request, response, next) => {
    try {
      const tenantId = parseId(request, response);
      if (!tenantId) return;
      const body = z.object({ hours: InvitationTtlHours.nullable() }).strict().safeParse(request.body);
      if (!body.success) {
        response.status(400).json({ error: "invalid_request", message: "Send whole hours from 1 to 720 or null." });
        return;
      }
      const revision = await deps.db.runTransaction(async (tx) => {
        const [agency, before] = await tx.getAll(agencyRef(tenantId), accessRef(tenantId));
        if (!agency.exists) return null;
        const revision = (before.get("invitationLifetimeRevision") ?? 0) + 1;
        tx.set(accessRef(tenantId), {
          ...(!before.exists ? { state: "pending", message: null } : {}),
          invitationTtlHours: body.data.hours,
          invitationLifetimeRevision: revision,
        }, { merge: true });
        tx.create(deps.db.collection(IDENTITY_COLLECTIONS.tenants).doc(tenantId).collection(IDENTITY_COLLECTIONS.audit).doc(), {
          actorUid: "external-access", action: "invitation_lifetime.changed",
          beforeInvitationTtlHours: before.get("invitationTtlHours") ?? null,
          afterInvitationTtlHours: body.data.hours, at: Timestamp.fromDate(now()),
        });
        return revision;
      });
      if (revision === null) {
        response.status(404).json({ error: "not_found", message: "Not found." });
        return;
      }
      deps.onChange?.(tenantId);
      response.json({ tenantId, invitationTtlHours: body.data.hours, revision });
    } catch (error) {
      next(error);
    }
  });

  router.put(ACCESS_PATH, off, deps.authorize, async (request, response, next) => {
    try {
      const tenantId = parseId(request, response);
      if (!tenantId) return;
      const body = AccessBody.safeParse(request.body);
      if (!body.success) {
        response.status(400).json({ error: "invalid_request", message: "Send { state, message }." });
        return;
      }
      const at = Timestamp.fromDate(now());
      const result = await deps.db.runTransaction(async (tx) => {
        const [agency, before] = await tx.getAll(agencyRef(tenantId), accessRef(tenantId));
        if (!agency.exists) return null;
        const previous = before.exists ? StoredAccess.safeParse(before.data()) : null;
        const invitationTtlHours = previous?.success ? (previous.data.invitationTtlHours ?? null) : null;
        tx.set(accessRef(tenantId), {
          state: body.data.state,
          message: body.data.message,
          invitationTtlHours,
          updatedAt: at,
        }, { merge: true });
        // Recorded in the agency's own audit trail, so its administrators can see it.
        tx.create(deps.db.collection(IDENTITY_COLLECTIONS.tenants).doc(tenantId).collection(IDENTITY_COLLECTIONS.audit).doc(), {
          actorUid: "external-access",
          action: "access.changed",
          targetUid: null,
          invitationId: null,
          email: null,
          beforeRole: null,
          afterRole: null,
          beforeActive: null,
          afterActive: null,
          beforeAccess: before.exists ? String(before.get("state")) : null,
          afterAccess: body.data.state,
          at,
        });
        return { invitationTtlHours };
      });
      if (!result) {
        response.status(404).json({ error: "not_found", message: "Not found." });
        return;
      }
      deps.onChange?.(tenantId);
      response.json({
        tenantId,
        state: body.data.state,
        message: body.data.message,
        invitationTtlHours: result.invitationTtlHours,
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
/**
 * A short-lived token (HS256 JWT) that tells the outside system who is coming and for
 * which agency. It carries no records, only the agency id and name and the administrator.
 */
export function signAccessToken(
  input: { appOrigin: string; accessUrl: string; tenantId: string; agencyName: string; uid: string; email: string },
  secret: string,
  now = new Date(),
  ttlSeconds = 600,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({
      iss: input.appOrigin,
      aud: new URL(input.accessUrl).origin,
      sub: input.tenantId,
      name: input.agencyName,
      uid: input.uid,
      email: input.email,
      iat,
      exp: iat + ttlSeconds,
      jti: randomBytes(12).toString("base64url"),
    }),
  );
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
