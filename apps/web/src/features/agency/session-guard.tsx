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
  announceSessionEnded,
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

import {
  clockLabel,
  nextPhaseCheck,
  recoveryDelay,
  sessionPhase,
} from "./session-guard-model";

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

  // When this session ends, where that is known (hosted sign-in). Measured from when the
  // answer arrived, on this browser's clock only, so a wrong clock can't skew it.
  const [deadline, setDeadline] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [warned, setWarned] = useState(false);
  useEffect(() => {
    setDeadline(
      typeof session.sessionSecondsLeft === "number"
        ? Date.now() + session.sessionSecondsLeft * 1000
        : null,
    );
    setEnding(false);
    setWarned(false);
  }, [session]);

  /** Returns true when the person is (still, or again) signed in as themselves. */
  // One check at a time: a timer, a focus and a tab switch often land together.
  const checking = useRef<Promise<boolean> | null>(null);
  const checkNow = useCallback(async () => {
    const result = await checkSessionRecovery(actor.current);
    if (result.kind === "resume") {
      if (result.secondsLeft !== undefined) setDeadline(Date.now() + result.secondsLeft * 1000);
      setEnding(false);
      setWarned(false);
      if (endedNow.current) {
        setEnded(null);
        setOpen(false);
        resume.current();
      }
      return true;
    }
    if (result.kind === "other_person") {
      setEnded({ reason: endedNow.current?.reason ?? "signed_out", otherPerson: true });
      setOpen(true);
    } else if (result.kind === "signed_out" && !endedNow.current) announceSessionEnded("signed_out");
    return false;
  }, [setEnded]);
  const check = useCallback(() => {
    checking.current ??= checkNow().finally(() => {
      checking.current = null;
    });
    return checking.current;
  }, [checkNow]);

  // Before the end: say when. At the end: confirm it and pause, without waiting for a
  // request to be refused. Timers can run late (a sleeping laptop, a background tab),
  // so coming back to the tab looks again.
  const live = !ended;
  useEffect(() => {
    if (!live || deadline === null) return;
    let timer: number | undefined;
    let stopped = false;
    const look = async () => {
      window.clearTimeout(timer);
      const left = deadline - Date.now();
      const phase = sessionPhase(left);
      setEnding(phase === "ending");
      // check() moves the deadline or ends the session; either re-runs this effect.
      if (phase === "due" && (await check())) return;
      if (!stopped) timer = window.setTimeout(() => void look(), nextPhaseCheck(left));
    };
    const shown = () => {
      if (document.visibilityState === "visible") void look();
    };
    void look();
    document.addEventListener("visibilitychange", shown);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [live, deadline, check]);

  // While signed out: look for the person coming back, less often as time passes, and
  // straight away when they return to this tab.
  const waiting = Boolean(ended) && !ended?.otherPerson;
  useEffect(() => {
    if (!waiting) return;
    let timer: number | undefined;
    let attempt = 0;
    let stopped = false;
    const look = async (returned = false) => {
      window.clearTimeout(timer);
      if (returned) attempt = 0;
      if (document.visibilityState === "visible") await check();
      if (!stopped) timer = window.setTimeout(() => void look(), recoveryDelay(attempt++));
    };
    const back = () => {
      if (document.visibilityState === "visible") void look(true);
    };
    timer = window.setTimeout(() => void look(), recoveryDelay(attempt++));
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
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
      {!ended && ending && !warned && deadline !== null && (
        <div className="agency-session-banner" data-tone="notice" role="status">
          <span>
            {hosted
              ? `You'll be asked to sign in again at ${clockLabel(deadline)}. Nothing in this tab will be lost.`
              : `This session ends at ${clockLabel(deadline)}.`}
          </span>
          <button className="agency-access-link" onClick={() => setWarned(true)}>
            OK
          </button>
        </div>
      )}
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
