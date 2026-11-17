// Optional sign-in email from the deployment itself. Off unless AMS_SMTP_URL and
// AMS_MAIL_FROM are set, and then only as a nicer copy of what Firebase would send: the
// API asks Firebase for the same one-time email link, points it straight at this app's
// /sign-in/finish (instead of Firebase's own action page) and mails it in the OpenAMS
// look. Whenever it can't, the browser falls back to Firebase's built-in email.
import nodemailer from "nodemailer";
import { brandedEmailHtml, escapeHtml } from "./mail-layout.js";

export interface SignInMessage {
  to: string;
  /** The app's /sign-in/finish link carrying the one-time code (see appSignInLink). */
  link: string;
}
export type SignInMailer = (message: SignInMessage) => Promise<void>;

export const FINISH_PATH = "/sign-in/finish";

/**
 * Turns the action link Firebase generates (its own handler, or the Auth emulator's) into
 * the address that handler would redirect to: this app's finish page with the same
 * one-time code. The browser SDK reads `apiKey`, `oobCode` and `mode` from it, and
 * `tenantId` when the deployment signs in through an Identity Platform tenant.
 */
export function appSignInLink(firebaseLink: string, appOrigin: string, phoneSetup = false): string {
  const source = new URL(firebaseLink).searchParams;
  const mode = source.get("mode");
  const oobCode = source.get("oobCode");
  const apiKey = source.get("apiKey");
  if (mode !== "signIn" || !oobCode || !apiKey)
    throw new Error("Firebase returned an unexpected sign-in link.");
  const target = new URL(FINISH_PATH, appOrigin);
  if (phoneSetup) target.searchParams.set("phone", "add");
  target.searchParams.set("mode", mode);
  target.searchParams.set("oobCode", oobCode);
  target.searchParams.set("apiKey", apiKey);
  for (const name of ["tenantId", "lang"]) {
    const value = source.get(name);
    if (value) target.searchParams.set(name, value);
  }
  return target.toString();
}

/** The subject, text and HTML of a sign-in email. Exported for tests. */
export function signInEmailContent(message: SignInMessage, appOrigin: string) {
  const host = new URL(appOrigin).host;
  const subject = "Your OpenAMS sign-in link";
  const text = [
    "Sign in to OpenAMS",
    "",
    `Open this link to sign in as ${message.to}. There's no password.`,
    "",
    message.link,
    "",
    "The link works once. If you open it in a different browser, you'll be asked to confirm your email first.",
    "",
    "Didn't ask for this? You can ignore this email. Nothing happens unless the link is used.",
    "",
    "--",
    "OpenAMS: open-source agency management",
    `Someone asked to sign in to ${host} with this address.`,
  ].join("\n");
  const html = brandedEmailHtml({
    appOrigin,
    title: subject,
    preheader: `Sign in as ${message.to}. The link works once.`,
    heading: "Sign in to OpenAMS",
    paragraphs: [
      `Click the button to sign in as <strong style="color:#16181d;">${escapeHtml(message.to)}</strong>. There's no password.`,
    ],
    button: { label: "Sign in to OpenAMS", href: message.link },
    notes: [
      "The link works once. If you open it in a different browser, you'll be asked to confirm your email first.",
      `<strong style="color:#3f434c;">Didn't ask for this?</strong> You can ignore this email. Nothing happens unless the link is used.`,
    ],
    showLink: true,
    footer: `OpenAMS · open-source agency management<br>Someone asked to sign in to ${escapeHtml(host)} with this address.`,
  });
  return { subject, text, html };
}

/**
 * Reads AMS_SMTP_URL and AMS_MAIL_FROM, the same settings as invitation email. Returns
 * undefined when either is missing or the app's public origin is unknown; sign-in email
 * then stays with Firebase.
 */
export function signInMailFromEnv(
  env: NodeJS.ProcessEnv,
  appOrigin: string | undefined,
): SignInMailer | undefined {
  const url = env.AMS_SMTP_URL?.trim();
  const from = env.AMS_MAIL_FROM?.trim();
  if (!url || !from || !appOrigin) return undefined;
  if (!/^smtps?:\/\//i.test(url))
    throw new Error("AMS_SMTP_URL must start with smtp:// or smtps://.");
  const transport = nodemailer.createTransport(url);
  return async (message) => {
    await transport.sendMail({
      from,
      to: message.to,
      ...signInEmailContent(message, appOrigin),
    });
  };
}
