// Browser side of hosted sign-in. Firebase client auth is used only to complete the
// email link or text code and obtain one ID token. Persistence is in memory while
// signing in or changing a linked phone, then the client signs out. The cookie is the session.
import { getApps, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  deleteUser,
  getAdditionalUserInfo,
  linkWithCredential,
  PhoneAuthProvider,
  RecaptchaVerifier,
  signInWithCredential,
  unlink,
  updatePhoneNumber,
  type PhoneAuthCredential,
  getMultiFactorResolver,
  inMemoryPersistence,
  initializeAuth,
  isSignInWithEmailLink,
  multiFactor,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut,
  TotpMultiFactorGenerator,
  type Auth,
  type MultiFactorError,
  type User,
} from "firebase/auth";
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from "firebase/app-check";
import { documentAuthTenantId } from "./auth-tenant";
import { documentSmsSignin, internationalPhone, phoneSetupRequested, rememberTextSignIn } from "./auth-methods";

// NEXT_PUBLIC_ values are inlined at build time; they identify the Firebase project
// and are not secrets. Never commit real values (see .env.example).
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
const emulatorHost = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
const appCheckSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY;
export const FINISH_PATH = "/sign-in/finish";
const EMAIL_KEY = "openams.signInEmail";

export function firebaseClientConfigured() {
  return Object.values(config).every(Boolean);
}
export const usingAuthEmulator = Boolean(emulatorHost);

let state: { auth: Auth; appCheck: AppCheck | null } | null = null;
function firebase() {
  if (state) return state;
  if (!firebaseClientConfigured())
    throw new Error("Firebase sign-in is not configured for this deployment.");
  const app = getApps()[0] ?? initializeApp(config);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  // A deployment that shares its Google Cloud project with others signs people in
  // through its own Identity Platform tenant. The id arrives at runtime from the root
  // layout's <meta> tag (see auth-tenant.ts) and must be set before any sign-in call.
  auth.tenantId = documentAuthTenantId();
  if (emulatorHost) {
    auth.settings.appVerificationDisabledForTesting = true;
    connectAuthEmulator(auth, `http://${emulatorHost}`, {
      disableWarnings: true,
    });
  }
  const appCheck = appCheckSiteKey
    ? initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
        isTokenAutoRefreshEnabled: true,
      })
    : null;
  state = { auth, appCheck };
  return state;
}

const remember = (email: string | null) => {
  try {
    if (email) window.localStorage.setItem(EMAIL_KEY, email);
    else window.localStorage.removeItem(EMAIL_KEY);
  } catch {
    // Storage can be unavailable; the finish page then asks for the email again.
  }
};
export function rememberedEmail(): string | null {
  try {
    return window.localStorage.getItem(EMAIL_KEY);
  } catch {
    return null;
  }
}

/**
 * Emails a sign-in link that returns to this origin's finish path. A deployment with its
 * own mail settings sends it in the OpenAMS look (POST /api/auth/sign-in-link); otherwise,
 * or whenever that service declines or can't be reached, Firebase sends its built-in email.
 */
export async function sendSignInLink(email: string, addPhone = false) {
  const phoneSetup = addPhone && documentSmsSignin();
  if (!(await sentByDeployment(email, phoneSetup)))
    await sendSignInLinkToEmail(firebase().auth, email, {
      url: `${window.location.origin}${FINISH_PATH}${phoneSetup ? "?phone=add" : ""}`,
      handleCodeInApp: true,
    });
  // Kept only so the same browser can complete the link without retyping.
  remember(email);
}

/** True when the deployment emailed the link itself; false means ask Firebase. */
async function sentByDeployment(email: string, phoneSetup: boolean): Promise<boolean> {
  const { appCheck } = firebase();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let response: Response;
  try {
    if (appCheck) headers["X-Firebase-AppCheck"] = (await getToken(appCheck, false)).token;
    response = await fetch("/api/auth/sign-in-link", {
      method: "POST",
      headers,
      body: JSON.stringify({ email, ...(phoneSetup ? { phoneSetup: true } : {}) }),
      cache: "no-store",
    });
  } catch {
    return false;
  }
  // The service being down, missing (an older API) or over its request limit never blocks
  // sign-in: Firebase can still send the link, under its own abuse limits.
  if (response.status === 404 || response.status === 429 || response.status >= 500) return false;
  const value = (await response.json().catch(() => null)) as { sent?: unknown; message?: unknown } | null;
  if (!response.ok)
    throw new SignInRefused(
      typeof value?.message === "string" ? value.message : "The sign-in link couldn't be requested. Try again.",
    );
  return value?.sent === true;
}

export function isSignInLink(href: string) {
  return firebaseClientConfigured() && isSignInWithEmailLink(firebase().auth, href);
}

const messages: Record<string, string> = {
  "auth/invalid-action-code":
    "This sign-in link has expired or was already used. Request a new one.",
  "auth/expired-action-code":
    "This sign-in link has expired. Request a new one.",
  "auth/invalid-email":
    "That email address doesn't match this sign-in link.",
  "auth/user-disabled": "This sign-in has been disabled.",
  "auth/network-request-failed":
    "The sign-in service couldn't be reached. Check your connection and try again.",
  "auth/invalid-verification-code":
    "That code didn't match. Check the 6-digit code and try again.",
  "auth/missing-code": "Enter the 6-digit code.",
  "auth/unsupported-tenant-operation": "Text sign-in is not available for this deployment. Use an email link.",
  "auth/invalid-phone-number": "Enter a mobile number with its country code.",
  "auth/credential-already-in-use": "That mobile number is linked to another account. Sign in with your email or use a different number.",
  "auth/provider-already-linked": "Text sign-in is already linked. Request a new email link to manage it.",
  "auth/code-expired": "That text code has expired. Request a new code.",
  "auth/session-expired": "That text code has expired. Request a new code.",
  "auth/too-many-requests": "Too many attempts. Wait a little before trying again.",
  "auth/quota-exceeded": "Text sign-in is temporarily unavailable. Use an email link.",
  "auth/captcha-check-failed": "The verification check failed. Try again or use an email link.",
  "auth/requires-recent-login": "Request a new email link before changing text sign-in.",
  "auth/totp-challenge-timeout":
    "That took too long. Request a new sign-in link and try again.",
  "auth/multi-factor-auth-required":
    "Finish signing in with the code from your authenticator app.",
};
/** The Firebase error code, such as "auth/expired-action-code", or null. */
export function signInErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}
export function signInErrorMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && messages[code]) return messages[code];
  return error instanceof SignInRefused
    ? error.message
    : "Sign-in couldn't be completed. Try again or use a new email link.";
}
class SignInRefused extends Error {}

/**
 * Where an email-link sign-in stands. With a required second factor (AMS_REQUIRE_MFA), the
 * person either enters the code from their authenticator app or, the first time, sets
 * one up. `submit` moves to the next step; a wrong code throws and the step can be retried.
 */
export type SignInStep =
  | { kind: "done" }
  | { kind: "code"; submit: (code: string) => Promise<SignInStep> }
  | {
      kind: "enroll";
      /** otpauth:// URL for the QR code (and for opening an authenticator app on this device). */
      otpauthUrl: string;
      /** The same secret, for typing into an authenticator app by hand. */
      secretKey: string;
      submit: (code: string) => Promise<SignInStep>;
    }
  | { kind: "again" }
  | { kind: "email-again" }
  | {
      kind: "phone-setup";
      phoneNumber: string | null;
      hasAuthenticator: boolean;
      removeAuthenticator: () => Promise<SignInStep>;
      send: (number: string, container: HTMLElement) => Promise<PhoneChallenge>;
      skip: () => Promise<SignInStep>;
      remove: () => Promise<SignInStep>;
    };

export interface PhoneChallenge {
  submit: (code: string) => Promise<SignInStep>;
}

/** Firebase's app verifier is created only for an explicit text-code request. */
async function requestPhoneCode(
  number: string,
  container: HTMLElement,
  confirm: (credential: PhoneAuthCredential) => Promise<SignInStep>,
): Promise<PhoneChallenge> {
  if (!documentSmsSignin()) throw new SignInRefused("Text sign-in is not enabled here. Use an email link.");
  let phone: string;
  try { phone = internationalPhone(number); }
  catch (error) { throw new SignInRefused((error as Error).message); }
  const { auth } = firebase();
  auth.useDeviceLanguage();
  const verifier = new RecaptchaVerifier(auth, container, { size: "invisible" });
  try {
    const verificationId = await new PhoneAuthProvider(auth).verifyPhoneNumber(phone, verifier);
    return { submit: (code) => confirm(PhoneAuthProvider.credential(verificationId, sixDigits(code))) };
  } finally {
    verifier.clear();
  }
}

/** Only an already-linked, verified-email account can obtain an application session. */
export async function startTextSignIn(number: string, container: HTMLElement): Promise<PhoneChallenge> {
  return requestPhoneCode(number, container, async (credential) => {
    const { auth, appCheck } = firebase();
    try {
      const signedIn = await signInWithCredential(auth, credential);
      if (!signedIn.user.emailVerified || !signedIn.user.email) {
        // Firebase creates a phone-only user on first SMS sign-in. Remove only the
        // just-created empty identity; never merge or delete an existing account.
        if (getAdditionalUserInfo(signedIn)?.isNewUser) await deleteUser(signedIn.user);
        // This number isn't linked to a verified-email account, so stop offering the
        // text button in this browser until a sign-in shows a linked number.
        rememberTextSignIn(false);
        throw new SignInRefused("Use an email link first, then choose Add text sign-in to link this number to your account.");
      }
      if (await exchange(signedIn.user, appCheck) !== "ok")
        throw new SignInRefused("Use an email link to finish this account's sign-in.");
      return { kind: "done" };
    } finally {
      await signOut(auth).catch(() => undefined);
    }
  });
}

/** Exchanges the signed-in user's ID token for the server session cookie. */
async function exchange(user: User, appCheck: AppCheck | null): Promise<"ok" | "enroll" | "code"> {
  const idToken = await user.getIdToken(true);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (appCheck) headers["X-Firebase-AppCheck"] = (await getToken(appCheck, false)).token;
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers,
    body: JSON.stringify({ idToken }),
    cache: "no-store",
  });
  if (response.ok) {
    // Every session starts here. Note whether this account has a linked mobile number so
    // the sign-in page offers the text button only where it can work (a yes/no flag).
    rememberTextSignIn(Boolean(user.phoneNumber));
    return "ok";
  }
  const value = await response.json().catch(() => ({}));
  if (value.error === "mfa_enrollment_required") return "enroll";
  if (value.error === "mfa_required") return "code";
  throw new SignInRefused(typeof value.message === "string" ? value.message : "Sign-in couldn't be completed.");
}

const sixDigits = (code: string) => {
  const digits = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(digits)) throw Object.assign(new Error("missing code"), { code: "auth/missing-code" });
  return digits;
};

/**
 * Completes an email link: signs in with the client SDK, adds the second factor when the
 * deployment requires one, exchanges the ID token for the server session cookie, then
 * signs the client SDK out again. Nothing is kept in the browser but the cookie.
 */
export async function completeSignIn(email: string, href: string): Promise<SignInStep> {
  const { auth, appCheck } = firebase();
  const addPhone = documentSmsSignin() && phoneSetupRequested(href);
  const end = async () => {
    await signOut(auth).catch(() => undefined);
    remember(null);
  };
  const guard = (step: () => Promise<SignInStep>) => async () => {
    try {
      const next = await step();
      if (next.kind === "done" || next.kind === "again" || next.kind === "email-again") await end();
      return next;
    } catch (error) {
      // A wrong or malformed code can be retried on the same step; anything else ends it.
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "auth/invalid-verification-code" && code !== "auth/missing-code") await end();
      throw error;
    }
  };
  const finish = async (user: User, offerPhone = true): Promise<SignInStep> => {
    const result = await exchange(user, appCheck);
    if (result === "ok") {
      if (addPhone && offerPhone) {
        if (!user.emailVerified || !user.email) throw new SignInRefused("Verify your email before adding text sign-in.");
        return {
          kind: "phone-setup",
          phoneNumber: user.phoneNumber,
          hasAuthenticator: multiFactor(user).enrolledFactors.some((factor) => factor.factorId === TotpMultiFactorGenerator.FACTOR_ID),
          removeAuthenticator: guard(async () => {
            // This screen follows fresh email proof and any existing provider MFA
            // challenge. Never silently strip an enrolled factor during sign-in.
            for (const factor of multiFactor(user).enrolledFactors.filter((item) => item.factorId === TotpMultiFactorGenerator.FACTOR_ID))
              await multiFactor(user).unenroll(factor);
            return { kind: "email-again" };
          }),
          skip: guard(() => finish(user, false)),
          remove: guard(async () => {
            // unlink clears user.phoneNumber itself, so the exchange below records "no number".
            if (user.phoneNumber) await unlink(user, PhoneAuthProvider.PROVIDER_ID);
            return finish(user, false);
          }),
          send: (number, container) => requestPhoneCode(number, container, (credential) => guard(async () => {
            // Link to the email-authenticated UID. A credential already owned by
            // another UID is refused by Firebase; no automatic account merge.
            if (user.phoneNumber) await updatePhoneNumber(user, credential);
            else await linkWithCredential(user, credential);
            await user.reload();
            return finish(user, false);
          })()),
        };
      }
      return { kind: "done" };
    }
    // Enrolled, but this sign-in didn't use the factor: start over with a new link.
    if (result === "code") return { kind: "again" };
    const secret = await TotpMultiFactorGenerator.generateSecret(await multiFactor(user).getSession());
    return {
      kind: "enroll",
      otpauthUrl: secret.generateQrCodeUrl(user.email ?? email, `OpenAMS (${window.location.hostname})`),
      secretKey: secret.secretKey,
      submit: (code) =>
        guard(async () => {
          await multiFactor(user).enroll(TotpMultiFactorGenerator.assertionForEnrollment(secret, sixDigits(code)), "Authenticator app");
          // Enrolling proves the factor, so the refreshed token normally carries it. If
          // not, the person signs in again with a new link and their code.
          const after = await exchange(user, appCheck);
          return after === "ok" ? { kind: "done" } : { kind: "again" };
        })(),
    };
  };
  return guard(async () => {
    try {
      return await finish((await signInWithEmailLink(auth, email, href)).user);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "auth/multi-factor-auth-required") throw error;
      const resolver = getMultiFactorResolver(auth, error as MultiFactorError);
      const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
      if (!hint)
        throw new SignInRefused("This account's second factor can't be used here. Ask your agency administrator to reset it.");
      return {
        kind: "code",
        submit: (code) =>
          guard(async () => finish((await resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(hint.uid, sixDigits(code)))).user))(),
      };
    }
  })();
}
