// Read-only instance status for whoever runs this OpenAMS, for example an uptime
// monitor or tooling that watches several deployments.
//
// It is off (404) unless AMS_STATUS_SERVICE_ACCOUNT names a service account; then it
// accepts only that account's Google-signed ID tokens, checked like the reminder
// scheduler. It reports health and counts only. It never reads record contents,
// documents, correspondence or people's email addresses, and it changes nothing.
import { readFileSync } from "node:fs";
import { Router, type RequestHandler } from "express";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { IDENTITY_COLLECTIONS } from "./identity.js";

export const STATUS_PATH = "/internal/status/v1";

function packageVersion(): string {
  try {
    const url = new URL("../../../../package.json", import.meta.url);
    const version = JSON.parse(readFileSync(url, "utf8")).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

export function createStatusApi(deps: {
  db: Firestore;
  enabled: boolean;
  authorize: RequestHandler;
  now?: () => Date;
  /** "open" when the deployment hosts many agencies (AMS_SIGNUP). */
  signup?: "admin" | "open";
}): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const version = process.env.AMS_VERSION || packageVersion();
  router.get(
    STATUS_PATH,
    (_request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      if (!deps.enabled) {
        response.status(404).json({ error: "not_found", message: "Not found." });
        return;
      }
      next();
    },
    deps.authorize,
    async (_request, response) => {
      const agencies = deps.db.collection(IDENTITY_COLLECTIONS.agencies);
      try {
        // With open sign-up the deployment hosts many agencies: report counts only, never
        // one agency's details.
        if (deps.signup === "open") {
          const [agencyCount, peopleCount] = await Promise.all([
            agencies.count().get(),
            // People who belong to an agency (single-field index, no collection-group scan).
            deps.db.collection(IDENTITY_COLLECTIONS.users).where("tenantId", "!=", null).count().get(),
          ]);
          response.json({
            status: "ok",
            version,
            revision: process.env.K_REVISION ?? null,
            startedAt: startedAt.toISOString(),
            checkedAt: now().toISOString(),
            signup: "open",
            agencies: { total: agencyCount.data().count },
            people: { total: peopleCount.data().count },
          });
          return;
        }
        const first = (await agencies.limit(1).get()).docs[0];
        let members = { active: 0, total: 0 };
        if (first) {
          const all = first.ref.collection(IDENTITY_COLLECTIONS.members);
          const [total, active] = await Promise.all([
            all.count().get(),
            all.where("active", "==", true).count().get(),
          ]);
          members = { active: active.data().count, total: total.data().count };
        }
        const createdAt = first?.get("createdAt");
        response.json({
          status: "ok",
          version,
          revision: process.env.K_REVISION ?? null,
          startedAt: startedAt.toISOString(),
          checkedAt: now().toISOString(),
          agency: first
            ? {
                configured: true,
                name: String(first.get("name") ?? ""),
                timeZone: String(first.get("timeZone") ?? ""),
                createdAt:
                  createdAt instanceof Timestamp
                    ? createdAt.toDate().toISOString()
                    : null,
              }
            : { configured: false },
          members,
        });
      } catch {
        response.status(503).json({
          status: "degraded",
          version,
          checkedAt: now().toISOString(),
          error: "database_unavailable",
        });
      }
    },
  );
  return router;
}
