/** Tell people this long before a session of known length ends. */
export const SESSION_WARNING_MS = 5 * 60_000;
/** While signed out, look for the person coming back this often at first, then less. */
export const RECOVERY_CHECK_MS = 10_000;
export const RECOVERY_CHECK_MAX_MS = 60_000;

/**
 * Where a session of known length stands. Its end is known from the moment it starts,
 * so the workspace says so beforehand and stops asking at the end, instead of learning
 * it from refused requests. "due" means: check now whether it really ended.
 */
export type SessionPhase = "ok" | "ending" | "due";
export function sessionPhase(msLeft: number): SessionPhase {
  if (msLeft <= 0) return "due";
  return msLeft <= SESSION_WARNING_MS ? "ending" : "ok";
}
/** How long until the phase can next change (never zero, so a timer always advances). */
export function nextPhaseCheck(msLeft: number) {
  if (msLeft <= 0) return RECOVERY_CHECK_MS;
  return Math.max(1_000, msLeft > SESSION_WARNING_MS ? msLeft - SESSION_WARNING_MS : msLeft);
}
/** Checks for a returning person: 10s, 20s, 40s, then every 60s. */
export function recoveryDelay(attempt: number) {
  return Math.min(RECOVERY_CHECK_MAX_MS, RECOVERY_CHECK_MS * 2 ** Math.min(Math.max(attempt, 0), 10));
}
/** "3:42 PM" in the browser's own time zone. */
export function clockLabel(at: number) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(at));
}
