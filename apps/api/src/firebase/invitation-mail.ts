// Optional invitation email over SMTP. Off unless AMS_SMTP_URL and AMS_MAIL_FROM are set;
// without them an invitation is only recorded and the inviter passes its link on
// themselves. The link carries the invitation's secret after "#", so it never reaches a
// server log; the invitee still proves the address with email-link sign-in, and
// acceptance is bound to that address.
import nodemailer from "nodemailer";
import { brandedEmailHtml, escapeHtml } from "./mail-layout.js";

export interface InvitationMessage {
  to: string;
  agencyName: string;
  invitedByEmail: string;
  role: string;
  expiresAt: Date;
  invitationId: string;
  /** The link secret. Goes only into the link; never logged. */
  token: string;
}
export type InvitationMailer = (message: InvitationMessage) => Promise<void>;

const ROLE_LABELS: Record<string, string> = {
  admin: "an administrator",
  manager: "a manager",
  member: "a member",
  accountant: "an accountant",
  viewer: "a viewer",
};

/**
 * An agency names itself, and that name goes to an address the agency chose. Keep it to
 * one short line and take out anything a mail client would turn into a link.
 */
export function mailSafeName(name: string): string {
  const flat = name
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ")
    .replace(/\bwww\.\S*/gi, " ")
    .replace(/\S+\.[a-z]{2,}(\/\S*)?/gi, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return flat || "An agency";
}

/**
 * The expiry is an instant, and the server can't know the reader's time zone. Write the
 * UTC calendar day in a fixed locale so every server gives the same answer, and say it is
 * UTC, because that day can differ from the reader's own by one.
 */
const EXPIRY_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "long",
  day: "numeric",
});

/**
 * The invitation link: the join page, with the invitation and its secret after "#". The
 * fragment is never sent to a server, in the request or in a Referer.
 */
export function invitationLink(appOrigin: string, invitationId: string, token: string): string {
  const url = new URL("/join", appOrigin);
  url.hash = new URLSearchParams({ i: invitationId, t: token }).toString();
  return url.toString();
}

/** The subject, text and HTML of an invitation. Exported for tests. */
export function invitationContent(message: InvitationMessage, appOrigin: string) {
  const agency = mailSafeName(message.agencyName);
  const role = ROLE_LABELS[message.role] ?? "a member";
  const until = `${EXPIRY_DAY.format(message.expiresAt)} (UTC)`;
  const link = invitationLink(appOrigin, message.invitationId, message.token);
  const lines = [
    `${message.invitedByEmail} invited you to join ${agency} on OpenAMS as ${role}.`,
    "",
    "To accept, open this link and sign in with this email address",
    `(${message.to}):`,
    link,
    "",
    "The link is just for you. Don't forward it.",
    "",
    `The invitation is open until ${until}.`,
    "",
    "Only join an agency you recognize. If you weren't expecting this, ask the person",
    "who invited you before you join, or ignore this message.",
  ];
  const subject = "You've been invited to join an agency on OpenAMS";
  const html = brandedEmailHtml({
    appOrigin,
    title: subject,
    preheader: `${message.invitedByEmail} invited you to join ${agency} on OpenAMS.`,
    heading: "You're invited to OpenAMS",
    paragraphs: [
      `${escapeHtml(message.invitedByEmail)} invited you to join <strong style="color:#16181d;">${escapeHtml(agency)}</strong> on OpenAMS as ${role}.`,
      `To accept, choose the button below and sign in with this email address (${escapeHtml(message.to)}).`,
    ],
    button: { label: "Accept invitation", href: link },
    notes: [
      `The invitation is open until ${until}.`,
      "The link is just for you. Don't forward it: it works only with your email address, and only once.",
      "Only join an agency you recognize. If you weren't expecting this, ask the person who invited you before you join, or ignore this message.",
    ],
    showLink: true,
    footer: "OpenAMS · open-source agency management",
  });
  return { subject, text: lines.join("\n"), html };
}

/**
 * Reads AMS_SMTP_URL (for example smtps://user:password@smtp.example.org:465) and
 * AMS_MAIL_FROM (for example "OpenAMS <no-reply@example.org>"). Returns undefined when
 * either is missing or the app's public origin is unknown, so nothing is sent.
 */
export function invitationMailFromEnv(
  env: NodeJS.ProcessEnv,
  appOrigin: string | undefined,
): InvitationMailer | undefined {
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
      ...invitationContent(message, appOrigin),
    });
  };
}
