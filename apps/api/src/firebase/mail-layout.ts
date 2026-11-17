// The OpenAMS look for the few emails a deployment sends (sign-in links, invitations):
// a sundown band, the logo, one heading, short paragraphs and at most one button. Mail
// clients ignore most CSS, so this is tables and inline styles, and it reads fine with
// images blocked. The images are served by the web app (apps/web/public/brand/email,
// built by brand/scripts) from the deployment's own origin.

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `Menlo, Consolas, 'Liberation Mono', monospace`;
// brand/tokens.css: graphite, ink-muted, slate, stone, bone, saffron, denim, night.
const C = {
  ink: "#16181d",
  muted: "#3f434c",
  subtle: "#5b6170",
  line: "#e6e3dc",
  bone: "#f6f5f1",
  saffron: "#f7cc2e",
  link: "#2e5a88",
  night: "#211832",
};

export interface BrandedEmail {
  /** The deployment's origin, for the images (https://…, no trailing slash). */
  appOrigin: string;
  /** The page title, usually the subject. Plain text. */
  title: string;
  /** Shown by some mail clients next to the subject. Plain text. */
  preheader: string;
  /** Plain text. */
  heading: string;
  /** Paragraphs of trusted HTML: escape every value that goes into them. */
  paragraphs: string[];
  /** The one action. `href` must be an https link the deployment made. */
  button?: { label: string; href: string };
  /** Smaller paragraphs after the button, trusted HTML. */
  notes?: string[];
  /** Below a rule: the button's link written out, for clients that drop buttons. */
  showLink?: boolean;
  /** Under the card, trusted HTML. */
  footer: string;
}

/** The full HTML document of a branded email. */
export function brandedEmailHtml(email: BrandedEmail): string {
  const origin = escapeHtml(email.appOrigin);
  const p = (html: string, size = 16, color = C.muted, margin = "0 0 16px") =>
    `<p style="margin:${margin};font-family:${FONT};font-size:${size}px;line-height:1.55;color:${color};">${html}</p>`;
  const button = email.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px;"><tr>` +
      `<td style="border-radius:8px;background:${C.saffron};">` +
      `<a href="${escapeHtml(email.button.href)}" style="display:inline-block;padding:14px 26px;border-radius:8px;font-family:${FONT};font-size:16px;font-weight:600;line-height:1.2;color:${C.ink};text-decoration:none;">${escapeHtml(email.button.label)}</a>` +
      `</td></tr></table>`
    : "";
  const notes = (email.notes ?? []).map((note) => p(note, 14, C.subtle, "16px 0 0")).join("");
  const link =
    email.showLink && email.button
      ? `<div style="height:1px;margin:28px 0 20px;background:${C.line};line-height:1px;font-size:1px;">&nbsp;</div>` +
        p("Button not working? Paste this link into your browser:", 13, C.subtle, "0 0 8px") +
        `<p style="margin:0;font-family:${MONO};font-size:12px;line-height:1.5;word-break:break-all;"><a href="${escapeHtml(email.button.href)}" style="color:${C.link};">${escapeHtml(email.button.href)}</a></p>`
      : "";
  return [
    `<!doctype html>`,
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">`,
    `<title>${escapeHtml(email.title)}</title>`,
    // Clients that read <style> get tighter margins on a phone; the rest keep the inline ones.
    `<style>@media (max-width:520px){.oams-body{padding:26px 22px 28px !important}.oams-outer{padding:16px 8px 24px !important}}</style></head>`,
    `<body style="margin:0;padding:0;background:${C.bone};">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(email.preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bone};"><tr><td class="oams-outer" align="center" style="padding:28px 12px 32px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:14px;border-collapse:separate;">`,
    // The band's top row is the night color, so with images blocked the strip still shows.
    `<tr><td style="background:${C.night};border-radius:14px 14px 0 0;line-height:0;font-size:0;">`,
    `<img src="${origin}/brand/email/scene-band.png" width="600" height="84" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:14px 14px 0 0;">`,
    `</td></tr>`,
    `<tr><td class="oams-body" style="padding:32px 40px 34px;">`,
    `<img src="${origin}/brand/email/openams-lockup.png" width="137" height="28" alt="OpenAMS" style="display:block;margin:0 0 28px;border:0;font-family:${FONT};font-size:20px;font-weight:600;color:${C.ink};">`,
    `<h1 style="margin:0 0 12px;font-family:${FONT};font-size:26px;line-height:1.2;font-weight:600;letter-spacing:-0.02em;color:${C.ink};">${escapeHtml(email.heading)}</h1>`,
    email.paragraphs.map((html) => p(html)).join(""),
    button,
    notes,
    link,
    `</td></tr></table>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;"><tr><td style="padding:18px 24px 0;">`,
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.subtle};text-align:center;">${email.footer}</p>`,
    `</td></tr></table>`,
    `</td></tr></table>`,
    `</body></html>`,
  ].join("\n");
}
