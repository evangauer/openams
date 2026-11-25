// Pure helpers behind the team page and the suggestion box, kept free of React and CSS
// so the web regression programs can import them.
import type {
  AMS_SUGGESTION_AREAS,
  AMS_SUGGESTION_STATUSES,
  AmsData,
} from "@openams/contracts";
import type { IdentityInvitation } from "./identity-model";
import { ROLE_GUIDE } from "./roles";

export type SuggestionArea = (typeof AMS_SUGGESTION_AREAS)[number];
export type SuggestionStatus = (typeof AMS_SUGGESTION_STATUSES)[number];

export const OPENAMS_ISSUES_URL = "https://github.com/evangauer/openams/issues/new";

export const AREA_LABELS: Record<SuggestionArea, string> = {
  setup: "Agency setup",
  accounts: "Accounts",
  policies: "Policies",
  renewals: "Renewals",
  tasks: "Tasks and follow-ups",
  email: "Email",
  certificates: "Certificates",
  financials: "Financials",
  reports: "Reports",
  team: "Team",
  other: "Something else",
};
export const STATUS_LABELS: Record<SuggestionStatus, string> = {
  new: "New",
  considering: "Considering",
  planned: "Planned",
  done: "Done",
  declined: "Not now",
};
/** A pre-filled public issue in the project's "Workflow request" shape. */
export function shareUrl(suggestion: Pick<AmsData<"suggestions">, "title" | "detail" | "area">) {
  const body = [
    `**Area:** ${AREA_LABELS[suggestion.area]}`,
    "",
    "**What we would like OpenAMS to do**",
    suggestion.detail || suggestion.title,
    "",
    "**What \"done\" looks like**",
    "",
    "> Shared from an agency's OpenAMS suggestion box. Please describe your agency in general terms and use fictional examples.",
  ].join("\n");
  const params = new URLSearchParams({
    template: "workflow_request.md",
    labels: "enhancement",
    title: suggestion.title,
    body,
  });
  return `${OPENAMS_ISSUES_URL}?${params}`;
}

/** What to send someone you invited. OpenAMS itself sends nothing. */
/**
 * The message an inviter sends themselves when no email went out. It carries the
 * invitation link, which only works together with sign-in as the invited address.
 */
export function invitationMessage(
  invite: Pick<IdentityInvitation, "email" | "role" | "expiresAt">,
  agencyName: string,
  link: string,
) {
  const until = new Date(invite.expiresAt).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return [
    `You're invited to ${agencyName} on OpenAMS as ${ROLE_GUIDE[invite.role].label.toLowerCase()}.`,
    `Open this link and sign in with ${invite.email}. It's just for you and works until ${until}:`,
    link,
  ].join("\n");
}

/** The invitation link (see join-link.ts): the secret goes after "#", never to a server. */
export function invitationLink(origin: string, invitationId: string, token: string) {
  const url = new URL("/join", origin);
  url.hash = new URLSearchParams({ i: invitationId, t: token }).toString();
  return url.toString();
}

