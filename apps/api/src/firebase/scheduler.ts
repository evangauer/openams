import type { RequestHandler } from "express";
import { OAuth2Client } from "google-auth-library";
import { FieldPath, type Firestore } from "firebase-admin/firestore";
import type { AmsService } from "../service.js";

/**
 * Cloud Scheduler calls the reminder run with a Google-signed OIDC ID token minted for
 * a dedicated service account. Only that service account, with that audience, passes.
 * The status API reuses this check with its own service account and audience.
 * Refusals answer 404, like a route that's switched off, so an outsider can't tell which
 * operator features a deployment has enabled.
 */
export function createSchedulerAuthorization(options: {
  serviceAccount: string | undefined;
  audience: string | undefined;
  client?: Pick<OAuth2Client, "verifyIdToken">;
  /** @deprecated Refusals are now a plain 404; kept so existing callers compile. */
  errorCode?: string;
}): RequestHandler {
  const client = options.client ?? new OAuth2Client();
  return async (request, response, next) => {
    const refuse = () => response.status(404).json({ error: "not_found" });
    const { serviceAccount, audience } = options;
    if (!serviceAccount || !audience) return refuse();
    const token = request.header("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token) return refuse();
    try {
      const ticket = await client.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      if (
        !payload ||
        payload.email !== serviceAccount ||
        payload.email_verified !== true ||
        (payload.iss !== "https://accounts.google.com" &&
          payload.iss !== "accounts.google.com")
      )
        return refuse();
      next();
    } catch {
      refuse();
    }
  };
}

/**
 * Processes due reminders for every agency within a time budget, fairly: each agency gets
 * at most `roundsPerAgency` batches per pass, and a run that runs out of time records where
 * it stopped so the next run starts there instead of at the first agency again.
 */
export async function runRemindersForAllAgencies(input: {
  db: Firestore;
  service: () => Pick<AmsService, "processDueReminders">;
  budgetMs?: number;
  roundsPerAgency?: number;
}) {
  const deadline = Date.now() + (input.budgetMs ?? 240_000);
  const roundsPerAgency = input.roundsPerAgency ?? 3;
  const cursorRef = input.db.collection("identity_limits").doc("reminders_cursor");
  const saved = (await cursorRef.get()).get("after");
  const start = typeof saved === "string" ? saved : null;
  let agencies = 0;
  let processed = 0;
  let conflicts = 0;
  let incomplete = false;
  let resumeAfter: string | null = null;
  // Two sweeps: from the saved position to the end, then from the beginning up to it.
  const sweeps: { after: string | null; until: string | null }[] = start
    ? [{ after: start, until: null }, { after: null, until: start }]
    : [{ after: null, until: null }];
  outer: for (const sweep of sweeps) {
    let cursor = sweep.after;
    for (;;) {
      let query = input.db
        .collection("identity_agencies")
        .orderBy(FieldPath.documentId())
        .select()
        .limit(200);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const agency of page.docs) {
        if (sweep.until && agency.id > sweep.until) break;
        if (Date.now() > deadline) {
          incomplete = true;
          break outer;
        }
        agencies += 1;
        for (let round = 0; round < roundsPerAgency; round += 1) {
          const result = await input.service().processDueReminders(agency.id);
          processed += Number(result.processed ?? 0);
          conflicts += Number(result.conflicts ?? 0);
          if (!result.more) break;
        }
        resumeAfter = agency.id;
      }
      if (page.size < 200) break;
      cursor = page.docs[page.docs.length - 1]!.id;
    }
  }
  // Out of time: start after the last agency served. Finished: start from the beginning.
  // (Out of time before serving anyone: keep the saved position.)
  await cursorRef.set({ after: incomplete ? (resumeAfter ?? start) : null, updatedAt: new Date() });
  return { agencies, processed, conflicts, incomplete };
}
