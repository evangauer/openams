"use client";
// Hosted sign-in (AMS_AUTH_MODE=firebase): email link → server session cookie, then
// create an agency or accept an invitation, then the existing workspace.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowRight, KeyRound, Link2Off, Loader2, LogOut, Mail, MailCheck, ShieldCheck } from "lucide-react";
import qrcode from "qrcode-generator";
import {
  completeSignIn,
  type SignInStep,
  type PhoneChallenge,
  startTextSignIn,
  firebaseClientConfigured,
  isSignInLink,
  rememberedEmail,
  sendSignInLink,
  signInErrorCode,
  signInErrorMessage,
  usingAuthEmulator,
} from "@/lib/firebase-client";
import { AgencyWorkspace } from "./workspace";
import { documentSmsSignin, phoneSetupRequested } from "@/lib/auth-methods";
import { ACCESS_REFUSED_EVENT } from "./model";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { human } from "./model";
import {
  hostedSignOut,
  identityRequest,
  type IdentityMe,
} from "./identity-model";
import {
  CONTINUE_ACCESS_KEY,
  clearSetupSuggestion,
  takeSetupSuggestion,
  type SetupSuggestion,
} from "./setup-suggestion";
import "./workspace.css";
import "./themes/portal.css";
import "./themes/brand.css";
import "./hosted-identity.css";

/**
 * The frame of every sign-in and onboarding step: the night side with a sundown scene
 * (brand/scenes, copied to public/brand/scenes) and the step itself on the canvas. On a
 * phone the night side becomes a band across the top. Text never sits on the scene.
 */
function Card({
  title,
  lead,
  icon,
  scene = "door",
  children,
}: {
  title: string;
  lead?: ReactNode;
  /** A small icon above the title, for steps that ask the person to do something. */
  icon?: ReactNode;
  /** "lost": the desert without its door, for a link that no longer works. */
  scene?: "door" | "lost";
  children?: ReactNode;
}) {
  return (
    <div className="auth-shell" data-scene={scene}>
      <aside className="auth-night">
        <img className="auth-logo" src="/brand/openams-lockup-horizontal-inverse.svg" alt="OpenAMS" width={136} height={28} />
        <div className="auth-pitch">
          {scene === "lost" ? (
            <>
              <p className="auth-pitch-title">The door&apos;s still open.</p>
              <p>Sign-in links close after they&apos;re used. A new one takes a moment.</p>
            </>
          ) : (
            <>
              <p className="auth-pitch-title">Agency management you own.</p>
              <p>Your book. Your data. Software your team actually likes using.</p>
            </>
          )}
        </div>
        <div className="auth-scene" aria-hidden="true" />
      </aside>
      <main className="auth-panel">
        <div className="auth-form">
          {icon && (
            <div className="auth-icon" aria-hidden="true">
              {icon}
            </div>
          )}
          <h1>{title}</h1>
          {lead && <p className="auth-lead">{lead}</p>}
          {children}
        </div>
        <footer className="auth-foot">OpenAMS · open-source agency management</footer>
      </main>
    </div>
  );
}

/** Shown while the signed-in check runs, so a returning member doesn't see the sign-in frame flash. */
function Opening() {
  return (
    <div className="auth-opening" role="status">
      <Loader2 className="agency-spin" aria-hidden="true" />
      <span>Opening your agency…</span>
    </div>
  );
}

/** After a link is requested: what to do next, and a way to ask again. */
function CheckEmail({
  address,
  addPhone,
  onDifferentEmail,
}: {
  address: string;
  addPhone: boolean;
  onDifferentEmail: () => void;
}) {
  // Firebase limits how often one address can ask; waiting a little avoids that error.
  const [wait, setWait] = useState(30);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWait((left) => left - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [wait]);
  return (
    <Card
      icon={<Mail size={22} />}
      title="Check your email"
      lead={
        <>
          Check <span className="auth-chip">{address}</span> for your sign-in link.
        </>
      }
    >
      <ol className="auth-steps">
        <li>Open the sign-in email. It can take a minute to arrive.</li>
        <li>
          Click the link in it. Open it in this browser and you won&apos;t need to type your
          email again. There&apos;s no password.
        </li>
      </ol>
      {usingAuthEmulator && (
        <p className="agency-hosted-note" role="note">
          Development: the Firebase Auth emulator does not send email. Copy the link from
          the emulator log.
        </p>
      )}
      <button
        className="agency-button"
        disabled={busy || wait > 0}
        onClick={async () => {
          setBusy(true);
          setStatus("");
          setError("");
          try {
            await sendSignInLink(address, addPhone);
            setStatus("Requested another link. Use the newest email.");
            setWait(30);
          } catch (failure) {
            setError(signInErrorMessage(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Sending…" : wait > 0 ? `Send another link in ${wait}s` : "Send another link"}
      </button>
      {status && (
        <p className="auth-status" role="status">
          {status}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button className="agency-button quiet" onClick={onDifferentEmail}>
        Use a different email
      </button>
      <small>Can&apos;t find it? Check your spam or junk folder.</small>
    </Card>
  );
}

/** A link that can't be used (expired, used, cut short): ask for a new one right here. */
function NewLink({ email: initial, reason }: { email: string; reason: string }) {
  const [email, setEmail] = useState(initial);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addPhone = useMemo(() => phoneSetupRequested(window.location.href), []);
  if (sent)
    return <CheckEmail address={sent} addPhone={addPhone} onDifferentEmail={() => setSent(null)} />;
  return (
    <Card
      scene="lost"
      icon={<Link2Off size={22} />}
      title="This link doesn't work anymore"
      lead={reason || "Sign-in links work once and expire after a while. A link can also break when it's copied."}
    >
      <form
        className="agency-hosted-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const address = email.trim().toLowerCase();
          try {
            await sendSignInLink(address, addPhone);
            setSent(address);
          } catch (failure) {
            setError(signInErrorMessage(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="agency-field">
          <span>Work email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button className="agency-button primary" disabled={busy}>
          {busy ? "Sending…" : "Email me a new link"}
          <ArrowRight size={15} />
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </Card>
  );
}
async function signOutAndReload() {
  await hostedSignOut();
  window.location.replace("/");
}

function TextCodeForm({ start, onDone }: {
  start: (number: string, container: HTMLElement) => Promise<PhoneChallenge>;
  onDone: (step: SignInStep) => void;
}) {
  const [number, setNumber] = useState("");
  const [challenge, setChallenge] = useState<PhoneChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const captcha = useRef<HTMLDivElement>(null);
  return <>
    {challenge ? <>
      <p>Enter the code texted to <strong>{number}</strong>.</p>
      <CodeForm label="Text message code" submitLabel="Continue" busy={busy} error={error} onSubmit={async (code) => {
        setBusy(true); setError("");
        try { onDone(await challenge.submit(code)); }
        catch (failure) { setError(signInErrorMessage(failure)); }
        finally { setBusy(false); }
      }} />
      <button className="agency-button" disabled={busy} onClick={() => { setChallenge(null); setError(""); }}>Send a new code</button>
    </> : <form className="agency-hosted-form" onSubmit={async (event) => {
      event.preventDefault();
      if (!captcha.current) return;
      setBusy(true); setError("");
      try { setChallenge(await start(number, captcha.current)); }
      catch (failure) { setError(signInErrorMessage(failure)); }
      finally { setBusy(false); }
    }}>
      <label className="agency-field"><span>Mobile number, including country code</span>
        <input type="tel" autoComplete="tel" required maxLength={30} placeholder="+1 202 555 0123" value={number} onChange={(event) => setNumber(event.target.value)} />
      </label>
      <label className="agency-hosted-note"><input type="checkbox" required /> I agree to receive a sign-in code by text. Message and data rates may apply. Google processes this number for authentication and abuse prevention.</label>
      <button className="agency-button primary" disabled={busy}>{busy ? "Sending…" : "Text me a code"}</button>
      {error && <p role="alert">{error}</p>}
    </form>}
    <div ref={captcha} />
    <small>Use a number only you control. Remove it from text sign-in before giving it up.</small>
  </>;
}

function SignInForm({ suggestion }: { suggestion: SetupSuggestion | null }) {
  const [email, setEmail] = useState(suggestion?.email ?? "");
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [method, setMethod] = useState<"email" | "text" | "add-phone">("email");
  useEffect(() => setSmsEnabled(documentSmsSignin()), []);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (method === "text" && smsEnabled) return <Card title="Sign in by text" lead="Use the mobile number you've linked to your verified email account.">
    <TextCodeForm start={startTextSignIn} onDone={(next) => { if (next.kind === "done") window.location.replace("/"); }} />
    <button className="agency-button" onClick={() => setMethod("email")}>Use an email link</button>
    <button className="agency-button" onClick={() => setMethod("add-phone")}>Add or change text sign-in</button>
  </Card>;
  if (sent)
    return (
      <CheckEmail
        address={sent}
        addPhone={method === "add-phone"}
        onDifferentEmail={() => {
          setSent(null);
          setError("");
        }}
      />
    );
  return (
    <Card
      title={method === "add-phone" ? "Set up text sign-in" : "Sign in to your agency"}
      lead={method === "add-phone" ? "First, verify your email with a fresh link. Then add, change or remove the mobile number on that same account." : "Enter your work email. We'll email you a link that signs you in, so there's no password to remember."}
    >
      <form
        className="agency-hosted-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const address = email.trim().toLowerCase();
          try {
            await sendSignInLink(address, method === "add-phone");
            setSent(address);
          } catch (failure) {
            setError(signInErrorMessage(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="agency-field">
          <span>Work email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button className="agency-button primary" disabled={busy}>
          {busy ? "Sending…" : "Email me a sign-in link"}
          <ArrowRight size={15} />
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
      {smsEnabled && <div className="agency-auth-methods">
        <button className="agency-button" onClick={() => { setMethod("text"); setError(""); }}>Use a text message</button>
        <button className="agency-button" onClick={() => { setMethod(method === "add-phone" ? "email" : "add-phone"); setError(""); }}>{method === "add-phone" ? "Use email sign-in" : "Add or change text sign-in"}</button>
      </div>}
      <small>Sign in to accept an invitation or check whether agency setup is available.</small>
    </Card>
  );
}

/** A scannable image of an otpauth:// URL (data URL; nothing leaves the browser). */
function qrImage(text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(5, 2);
}

/** The 6-digit code field shared by sign-in and setup. */
function CodeForm({
  label,
  submitLabel,
  onSubmit,
  error,
  busy,
}: {
  label: string;
  submitLabel: string;
  onSubmit: (code: string) => void;
  error: string;
  busy: boolean;
}) {
  const [code, setCode] = useState("");
  return (
    <form
      className="agency-hosted-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(code);
      }}
    >
      <label className="agency-field">
        <span>{label}</span>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <button className="agency-button primary" disabled={busy}>
        {busy ? "Checking…" : submitLabel}
        <ArrowRight size={15} />
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

/** The page an email link opens. */
export function FinishSignIn() {
  const [phase, setPhase] = useState<"checking" | "ask" | "working" | "invalid">(
    "checking",
  );
  const [step, setStep] = useState<Exclude<SignInStep, { kind: "done" }> | null>(null);
  const [email, setEmail] = useState("");
  // The address this attempt used, so a new link can be requested without retyping it.
  const [tried, setTried] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const advance = useCallback((next: SignInStep) => {
    // Replace, so the one-time link is not left in history.
    if (next.kind === "done") window.location.replace("/");
    else setStep(next);
  }, []);
  const finish = useCallback(async (address: string) => {
    const normalized = address.trim().toLowerCase();
    setPhase("working");
    setError("");
    setTried(normalized);
    try {
      advance(await completeSignIn(normalized, window.location.href));
    } catch (failure) {
      setError(signInErrorMessage(failure));
      // A used or expired link can't succeed with any address: offer a new link instead.
      const dead = ["auth/invalid-action-code", "auth/expired-action-code"].includes(
        signInErrorCode(failure) ?? "",
      );
      setPhase(dead ? "invalid" : "ask");
    }
  }, [advance]);
  const submitCode = useCallback(
    async (code: string) => {
      if (!step || (step.kind !== "code" && step.kind !== "enroll")) return;
      setBusy(true);
      setError("");
      try {
        advance(await step.submit(code));
      } catch (failure) {
        const retry = ["auth/invalid-verification-code", "auth/missing-code"].includes(
          String((failure as { code?: unknown } | null)?.code),
        );
        setError(signInErrorMessage(failure));
        // Anything but a wrong code ends this attempt: start again from a new link.
        if (!retry) {
          setStep(null);
          setPhase("invalid");
        }
      } finally {
        setBusy(false);
      }
    },
    [step, advance],
  );
  const qr = useMemo(() => (step?.kind === "enroll" ? qrImage(step.otpauthUrl) : null), [step]);
  // A link's code works once; never start a second attempt (Strict Mode re-runs effects).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!firebaseClientConfigured() || !isSignInLink(window.location.href)) {
      setPhase("invalid");
      return;
    }
    // Only an email this browser requested completes automatically. Otherwise the
    // person confirms it, so a link sent to someone else can't sign them in.
    const remembered = rememberedEmail();
    if (remembered) void finish(remembered);
    else setPhase("ask");
  }, [finish]);
  if (step?.kind === "phone-setup") return <Card title="Your text sign-in" lead={step.phoneNumber ? `Your account is linked to ${step.phoneNumber}. Verify a new number to replace it, or remove text sign-in below.` : "Your email is verified. Add a mobile number to sign in by email link or text on the same account."}>
    <TextCodeForm start={step.send} onDone={advance} />
    {step.hasAuthenticator && <>
      <p>An authenticator app is still linked to this account. Remove it to use just an email link or your linked text number. You'll sign in again after removing it.</p>
      <button className="agency-button" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { advance(await step.removeAuthenticator()); } catch (failure) { setError(signInErrorMessage(failure)); } finally { setBusy(false); }
      }}>Remove authenticator app</button>
    </>}
    <div className="agency-auth-methods">
      <button className="agency-button" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { advance(await step.skip()); } catch (failure) { setError(signInErrorMessage(failure)); } finally { setBusy(false); }
      }}>Continue without changes</button>
      {step.phoneNumber && <button className="agency-button" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { advance(await step.remove()); } catch (failure) { setError(signInErrorMessage(failure)); } finally { setBusy(false); }
      }}>Remove text sign-in</button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </Card>;
  if (step?.kind === "code")
    return (
      <Card
        icon={<KeyRound size={22} />}
        title="Enter your code"
        lead="Open your authenticator app and enter the 6-digit code for OpenAMS."
      >
        <CodeForm label="Code" submitLabel="Sign in" onSubmit={(code) => void submitCode(code)} error={error} busy={busy} />
      </Card>
    );
  if (step?.kind === "enroll")
    return (
      <Card
        icon={<ShieldCheck size={22} />}
        title="Set up two-step sign-in"
        lead="This agency requires a second step at sign-in. Scan the code with an authenticator app (for example Google Authenticator, Microsoft Authenticator or 1Password), then enter the 6-digit code it shows."
      >
        {qr && <img className="agency-mfa-qr" src={qr} alt="QR code for your authenticator app" width={200} height={200} />}
        <p className="agency-hosted-note">
          Can&apos;t scan it? Add an account by hand with this key:{" "}
          <code className="agency-mfa-key">{step.secretKey.replace(/(.{4})/g, "$1 ").trim()}</code>{" "}
          or <a href={step.otpauthUrl}>open it in an authenticator app on this device</a>.
        </p>
        <CodeForm label="Code from the app" submitLabel="Turn on and sign in" onSubmit={(code) => void submitCode(code)} error={error} busy={busy} />
        <small>
          <ShieldCheck size={13} aria-hidden="true" /> Keep the app on your phone. If you lose it, an
          administrator of your agency can reset it.
        </small>
      </Card>
    );
  if (step?.kind === "email-again") return <Card title="Authenticator removed" lead="Request a new email link to sign in. You can also use a text code if you've linked your mobile number.">
    <a className="agency-button primary" href="/">Return to sign-in <ArrowRight size={15} /></a>
  </Card>;
  if (step?.kind === "again")
    return (
      <Card
        title="Two-step sign-in is on"
        lead="Sign in once more: request a new link, then enter the code from your authenticator app."
      >
        <a className="agency-button primary" href="/">
          Request a new sign-in link
          <ArrowRight size={15} />
        </a>
      </Card>
    );
  if (phase === "invalid") return <NewLink email={tried} reason={error} />;
  if (phase === "checking" || phase === "working")
    return (
      <Card title="Signing you in…">
        <Loader2 className="agency-spin" aria-hidden="true" />
      </Card>
    );
  return (
    <Card
      icon={<MailCheck size={22} />}
      title="Confirm your email"
      lead="Enter the email address this sign-in link was sent to. If you didn't ask for a link, close this page."
    >
      <form
        className="agency-hosted-form"
        onSubmit={(event) => {
          event.preventDefault();
          void finish(email);
        }}
      >
        <label className="agency-field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button className="agency-button primary">
          Finish signing in
          <ArrowRight size={15} />
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </Card>
  );
}

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}
/**
 * A signed-in person without a membership: join by invitation, or, for the
 * administrator named at install, set up this instance's one agency.
 */
function JoinOrSetUp({
  me,
  reload,
  suggestion,
}: {
  me: IdentityMe;
  reload: () => void;
  /** Values a link into the app suggested (setup-suggestion.ts). */
  suggestion: SetupSuggestion | null;
}) {
  const zones = useMemo(timeZones, []);
  const [name, setName] = useState(suggestion?.agencyName ?? "");
  const [displayName, setDisplayName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      reload();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "The request failed.",
      );
      setBusy(false);
    }
  }
  return (
    <Card
      title={
        me.pendingInvitations.length
          ? "Join your agency"
          : me.setupAvailable
            ? me.signup === "open"
              ? "Create your agency"
              : "Set up your agency"
            : "Waiting for an invitation"
      }
      lead={
        me.pendingInvitations.length || me.setupAvailable ? (
          <>Signed in as {me.email}.</>
        ) : (
          <>
            Signed in as {me.email}. Ask your agency&apos;s administrator to
            invite this address, then reload this page.
          </>
        )
      }
    >
      {me.pendingInvitations.length > 0 && (
        <div className="agency-login-roles">
          {!me.setupAvailable && (
            <label className="agency-field">
              <span>Your name</span>
              <input
                maxLength={100}
                value={displayName}
                placeholder={me.email.split("@")[0]}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
          )}
          <p className="agency-invite-note">
            Only join an agency you recognize. If you weren&apos;t expecting
            this, ask the person who invited you before you join.
          </p>
          {me.pendingInvitations.map((invitation) => (
            <div key={invitation.id} className="agency-invite">
            <button
              className="agency-button primary"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  identityRequest("invitations/accept", {
                    invitationId: invitation.id,
                    ...(displayName.trim()
                      ? { displayName: displayName.trim() }
                      : {}),
                  }),
                )
              }
            >
              Join {invitation.agencyName} as {human(invitation.role)}
              <ArrowRight size={15} />
            </button>
              <p className="agency-invite-meta">
                Invited by {invitation.invitedByEmail ?? "an agency manager"}
                {invitation.agencyCreatedAt
                  ? ` · agency created ${new Date(invitation.agencyCreatedAt).toLocaleDateString()}`
                  : ""}
              </p>
            </div>
          ))}
        </div>
      )}
      {me.setupAvailable && (
      <form
        className="agency-hosted-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await identityRequest("agencies", {
              name: name.trim(),
              timeZone,
              ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
              ...(me.terms && agreed ? { acceptTerms: me.terms.version } : {}),
            });
            clearSetupSuggestion();
            // If this agency now waits on an outside system, go straight to its page.
            try {
              window.sessionStorage.setItem(CONTINUE_ACCESS_KEY, "1");
            } catch {
              // The Continue button is still there.
            }
          });
        }}
      >
        <label className="agency-field">
          <span>Your name</span>
          <input
            autoComplete="name"
            maxLength={100}
            value={displayName}
            placeholder={me.email.split("@")[0]}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        {me.pendingInvitations.length > 0 && (
          <h2 className="agency-hosted-divider">
            {me.signup === "open" ? "Or create a new agency" : "Or set up this agency"}
          </h2>
        )}
        <label className="agency-field">
          <span>Agency name</span>
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="agency-field">
          <span>Agency time zone</span>
          <select
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
          >
            {(zones.includes(timeZone) ? zones : [timeZone, ...zones]).map(
              (zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll("_", " ")}
                </option>
              ),
            )}
          </select>
          <small>Policy status and due dates follow this calendar.</small>
        </label>
        {me.terms && (
          <label className="agency-terms">
            <input type="checkbox" required checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
            <span>
              I agree to the{" "}
              <a href={me.terms.url} target="_blank" rel="noreferrer">
                terms
              </a>{" "}
              on behalf of this agency.
            </span>
          </label>
        )}
        <button
          className={`agency-button ${me.pendingInvitations.length ? "" : "primary"}`}
          disabled={busy || !name.trim() || Boolean(me.terms && !agreed)}
        >
          {busy ? "Working…" : me.signup === "open" ? "Create agency" : "Set up agency"}
          <ArrowRight size={15} />
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
      )}
      {!me.setupAvailable && error && <p role="alert">{error}</p>}
      <button
        className="agency-button quiet"
        onClick={() => void signOutAndReload()}
      >
        <LogOut size={15} />
        Sign out
      </button>
    </Card>
  );
}

/** Root of the hosted app: decides between sign-in, joining or setup, and the workspace. */
export function HostedAgency() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "signed-out" }
    | { kind: "error"; message: string }
    | { kind: "me"; me: IdentityMe }
  >({ kind: "loading" });
  const load = useCallback(() => {
    setState({ kind: "loading" });
    identityRequest<IdentityMe>("me")
      .then((me) => setState({ kind: "me", me }))
      .catch((failure: { status?: number; message?: string }) =>
        setState(
          failure.status === 401
            ? { kind: "signed-out" }
            : {
                kind: "error",
                message: failure.message || "Unable to reach OpenAMS.",
              },
        ),
      );
  }, []);
  // Read before the first request finishes, so the forms below start out prefilled.
  const [suggestion, setSuggestion] = useState<SetupSuggestion | null>(null);
  useEffect(() => setSuggestion(takeSetupSuggestion()), []);
  useEffect(load, [load]);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const markWorkspaceReady = useCallback(() => setWorkspaceReady(true), []);
  if (!firebaseClientConfigured())
    return (
      <Card
        title="Sign-in isn't configured"
        lead="This deployment is missing its Firebase web configuration. See .env.example."
      />
    );
  if (state.kind === "loading") return <Opening />;
  if (state.kind === "signed-out") return <SignInForm suggestion={suggestion} />;
  if (state.kind === "error")
    return (
      <Card title="Agency management" lead={state.message}>
        <button className="agency-button" onClick={load}>
          Try again
        </button>
      </Card>
    );
  const { me } = state;
  if (!me.membership) return <JoinOrSetUp me={me} reload={load} suggestion={suggestion} />;
  if (!me.membership.active)
    return (
      <Card
        title="Your access is paused"
        lead={`An administrator of ${me.membership.agencyName} has deactivated your membership. Ask them to reactivate it.`}
      >
        <button
          className="agency-button"
          onClick={() => void signOutAndReload()}
        >
          <LogOut size={15} />
          Sign out
        </button>
      </Card>
    );
  const access = me.access ?? null;
  const admin = me.membership.role === "admin";
  const showNotice = access && (access.state === "read_only" || access.message);
  if (access && (access.state === "pending" || access.state === "suspended"))
    return <AccessGate agencyName={me.membership.agencyName} access={access} admin={admin} />;
  return (
    <>
      {showNotice && <AccessNotice access={access} admin={admin} ready={workspaceReady} />}
      <AgencyWorkspace
        local={false}
        hosted={{
          signOut: signOutAndReload,
          onReady: markWorkspaceReady,
          ...(access && admin ? { manageAccount: openAccessLink } : {}),
        }}
      />
    </>
  );
}

/** Follows the signed link to the outside system's page (external access control). */
async function openAccessLink() {
  const { url } = await identityRequest<{ url: string }>("access-link", {});
  if (!/^https:\/\//.test(url)) throw new Error("The account page isn't configured.");
  window.location.assign(url);
}

function AccessButton({ label, continueOnce = false }: { label: string; continueOnce?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = useCallback(() => {
    setBusy(true);
    setError("");
    openAccessLink().catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : "That didn't work. Try again.");
      setBusy(false);
    });
  }, []);
  // Right after creating the agency, follow the link without another click. Once only:
  // coming back from that page, or reloading, shows the button instead.
  useEffect(() => {
    if (!continueOnce) return;
    try {
      if (!window.sessionStorage.getItem(CONTINUE_ACCESS_KEY)) return;
      window.sessionStorage.removeItem(CONTINUE_ACCESS_KEY);
    } catch {
      return;
    }
    open();
  }, [continueOnce, open]);
  return (
    <>
      <button
        className="agency-button primary"
        disabled={busy}
        onClick={open}
      >
        {busy ? "Opening…" : label}
        <ArrowRight size={15} />
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

/** A pending or suspended agency: nothing but the way to (re)activate it. */
function AccessGate({
  agencyName,
  access,
  admin,
}: {
  agencyName: string;
  access: NonNullable<IdentityMe["access"]>;
  admin: boolean;
}) {
  const pending = access.state === "pending";
  return (
    <Card
      title={pending ? `Activate ${agencyName}` : `${agencyName} is paused`}
      lead={
        access.message ??
        (pending
          ? "One more step before your team can start working here."
          : "Access to this agency is paused. Your records are safe.")
      }
    >
      {admin ? (
        <AccessButton label={pending ? "Continue" : "Restore access"} continueOnce={pending} />
      ) : (
        <p className="agency-invite-note">Ask your agency&apos;s administrator to finish this step.</p>
      )}
      <button className="agency-button quiet" onClick={() => void signOutAndReload()}>
        <LogOut size={15} />
        Sign out
      </button>
    </Card>
  );
}

/**
 * Read-only state or a message from the outside system: a banner across the top, plus a
 * dialog when the agency opens read-only (once per session) and whenever a change is
 * refused because of the agency's access.
 */
function AccessNotice({
  access,
  admin,
  ready,
}: {
  access: NonNullable<IdentityMe["access"]>;
  admin: boolean;
  /** The workspace has loaded; the first-visit dialog waits for it rather than covering the spinner. */
  ready: boolean;
}) {
  const readOnly = access.state === "read_only";
  const text =
    access.message ?? "This agency is read-only: you can view and export everything, but changes are paused.";
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (readOnly && ready) {
      try {
        if (!window.sessionStorage.getItem("openams.accessNoticeSeen")) {
          window.sessionStorage.setItem("openams.accessNoticeSeen", "1");
          setOpen(true);
        }
      } catch {
        setOpen(true);
      }
    }
  }, [readOnly, ready]);
  useEffect(() => {
    const refused = () => setOpen(true);
    window.addEventListener(ACCESS_REFUSED_EVENT, refused);
    return () => window.removeEventListener(ACCESS_REFUSED_EVENT, refused);
  }, []);
  return (
    <>
      <div className={`agency-access-banner${readOnly ? " lapsed" : ""}`} role="status">
        <span>{text}</span>
        {admin && (
          <button className="agency-access-link" onClick={() => void openAccessLink()}>
            {readOnly ? "Restore access" : "Manage"}
          </button>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="agency-dialog agency-access-dialog">
          <DialogHeader>
            <DialogTitle>{readOnly ? "This agency is read-only" : "This change isn't available"}</DialogTitle>
            <DialogDescription>{text}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="agency-access-dialog-note">
              {admin
                ? "Your records are safe. You can keep viewing and exporting them while you restore access."
                : "Your records are safe. Ask your agency's administrator to restore access; you can keep viewing and exporting them meanwhile."}
            </p>
          </DialogBody>
          <DialogFooter>
            <button className="agency-button quiet" onClick={() => setOpen(false)}>Keep viewing</button>
            {admin && <AccessButton label="Restore access" />}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
