import { AgencyRequestError, sessionEndReason } from "./model";

/** An open conversation looks for new messages this often. */
export const CONVERSATION_POLL_MS = 3_000;
/** Presence and unread counts, while the tab is in view and while it isn't. */
export const PULSE_VISIBLE_MS = 15_000;
export const PULSE_HIDDEN_MS = 60_000;
/** Failing requests back off to at most this. */
export const CONVERSATION_MAX_MS = 30_000;
export const PULSE_MAX_MS = 120_000;

/**
 * Why a chat request failed, which decides what chat says and whether it tries again.
 * "paused": the session (or membership) ended; the workspace explains and resumes chat.
 * "rejected": the request was refused for good (not found, not allowed, invalid).
 * "offline": the network or the service failed, or asked to slow down; try again later.
 */
export type ChatFailure = "paused" | "rejected" | "offline";
export function chatFailure(error: unknown): ChatFailure {
  if (!(error instanceof AgencyRequestError)) return "offline";
  if (sessionEndReason(error.status, error.code)) return "paused";
  if (error.status === 408 || error.status === 429 || error.status >= 500) return "offline";
  return error.status >= 400 ? "rejected" : "offline";
}

/** The wait before the next try: the usual interval, doubling per failure up to a cap. */
export function retryDelay(base: number, failures: number, max: number) {
  return failures <= 0 ? base : Math.min(max, base * 2 ** Math.min(failures, 16));
}

/**
 * What an undelivered message says. Only a refusal means it wasn't saved; when the
 * service didn't answer, it may have been, and retrying with the same id is safe.
 */
export function undeliveredLabel(failure: ChatFailure, message?: string) {
  if (failure === "paused") return "Not sent: you're signed out.";
  if (failure === "rejected") return `Not sent: ${message || "the message was refused"}`.replace(/\.?$/, ".");
  return "Delivery unconfirmed.";
}
