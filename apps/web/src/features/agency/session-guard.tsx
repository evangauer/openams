"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  SESSION_ENDED_EVENT,
  checkSessionRecovery,
  type AgencySession,
  type SessionEndReason,
  type SessionEndedDetail,
} from "./model";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** While a session check is waiting, look again this often (only while the tab is in view). */
const RECOVERY_CHECK_MS = 10_000;

const SessionLive = createContext(true);
/**
 * False once a request showed this tab's session (or membership) has ended. Background
 * work (chat, reminders) pauses until the same person is signed in again.
 */
export const useSessionLive = () => useContext(SessionLive);

type Ended = { reason: SessionEndReason; otherPerson: boolean };

/**
 * Handles the end of a session in one place. Any refused request announces it; this
 * pauses background work, explains, and offers the way back. Nothing in the tab is
 * discarded: when the same person signs in again (in another tab), it carries on with
 * every unsent message and unsaved form as it was. If someone else signs in, this
 * tab's work isn't theirs, so the only way on is to reload.
 */
export function SessionGuard({
  session,
  hosted,
  onResume,
  children,
}: {
  session: AgencySession;
  /** Hosted sign-in: sign in again in a new tab. Elsewhere, reloading starts over. */
  hosted: boolean;
  /** Refreshes what may have changed while the session was away. */
  onResume: () => void;
  children: ReactNode;
}) {
  const [ended, setEndedState] = useState<Ended | null>(null);
  const [open, setOpen] = useState(false);
  // Read synchronously by the event handler: a burst of refusals opens one dialog.
  const endedNow = useRef<Ended | null>(null);
  const setEnded = useCallback((next: Ended | null) => {
    endedNow.current = next;
    setEndedState(next);
  }, []);
  const actor = useRef(session.actor);
  actor.current = session.actor;
  const resume = useRef(onResume);
  resume.current = onResume;

  useEffect(() => {
    const announced = (event: Event) => {
      if (endedNow.current) return;
      const { reason } = (event as CustomEvent<SessionEndedDetail>).detail;
      setEnded({ reason, otherPerson: false });
      setOpen(true);
    };
    window.addEventListener(SESSION_ENDED_EVENT, announced);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, announced);
  }, [setEnded]);

  const check = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    const result = await checkSessionRecovery(actor.current);
    if (result === "resume") {
      setEnded(null);
      setOpen(false);
      resume.current();
    } else if (result === "other_person" && endedNow.current) {
      setEnded({ ...endedNow.current, otherPerson: true });
      setOpen(true);
    }
  }, [setEnded]);
  const waiting = Boolean(ended) && !ended?.otherPerson;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void check(), RECOVERY_CHECK_MS);
    const look = () => void check();
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", look);
    };
  }, [waiting, check]);

  const signIn = hosted && ended?.reason === "signed_out" && !ended.otherPerson;
  const reload = () => window.location.reload();
  const openSignIn = () => {
    window.open("/", "_blank", "noopener");
  };
  const copy = !ended
    ? null
    : ended.otherPerson
      ? {
          title: "You're signed in as someone else",
          lead: "Another account is signed in to OpenAMS in this browser now. Reload to open its workspace.",
          note: "Unsent messages and unsaved changes in this tab belong to the previous account and won't be sent from the new one.",
        }
      : ended.reason === "access_ended"
        ? {
            title: "Your access to this agency ended",
            lead: "Your membership of this agency is no longer active, so changes can't be saved.",
            note: "If this is a mistake, ask your agency's administrator. This tab carries on by itself if your access comes back.",
          }
        : signIn
          ? {
              title: "Your session ended",
              lead: "For security, OpenAMS signs you out after a while. Sign in again to keep working.",
              note: "Everything in this tab stays as it is, including unsent chat messages and unsaved changes. Sign in in the new tab, then come back here: this tab picks up where you left off.",
            }
          : {
              title: "Your session ended",
              lead: "This workspace session is no longer valid.",
              note: "Reload to start a new session. Unsaved changes in this tab won't be kept.",
            };

  return (
    <SessionLive.Provider value={!ended}>
      {children}
      {ended && copy && (
        <>
          {!open && (
            <div className="agency-session-banner" role="status">
              <span>{copy.title}.</span>
              {signIn ? (
                <button className="agency-access-link" onClick={openSignIn}>
                  Sign in again
                </button>
              ) : (
                <button className="agency-access-link" onClick={() => setOpen(true)}>
                  Details
                </button>
              )}
            </div>
          )}
          <Dialog
            open={open}
            // Someone else's session can't be dismissed: this tab would act as them.
            onOpenChange={(next) => setOpen(ended.otherPerson ? true : next)}
          >
            <DialogContent className="agency-dialog agency-access-dialog">
              <DialogHeader>
                <DialogTitle>{copy.title}</DialogTitle>
                <DialogDescription>{copy.lead}</DialogDescription>
              </DialogHeader>
              <DialogBody>
                <p className="agency-access-dialog-note">{copy.note}</p>
              </DialogBody>
              <DialogFooter>
                {!ended.otherPerson && (
                  <button className="agency-button quiet" onClick={() => setOpen(false)}>
                    Keep viewing
                  </button>
                )}
                {signIn ? (
                  <button className="agency-button primary" onClick={openSignIn}>
                    Sign in again
                  </button>
                ) : (
                  <button className="agency-button primary" onClick={reload}>
                    Reload
                  </button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </SessionLive.Provider>
  );
}
