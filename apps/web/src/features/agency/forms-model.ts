// Pure helpers for the Forms screens: what a draft is, what stops it from saving, how a
// link and an embed are written, and which accounts a submission probably belongs to.
import {
  AMS_FORM_DEFAULT_ACCENT,
  AmsFormSchema,
  amsFormFromCatalog,
  amsPublicForm,
  type AmsForm,
  type AmsFormField,
  type AmsFormSection,
  type AmsPublicForm,
} from "@openams/contracts";
import type { AmsRecord, Book } from "./model";

/** The part of a form a person edits. Status, link and publish time belong to the server. */
export type FormDraft = Omit<AmsForm, "status" | "linkId" | "publishedAt">;
export type FormRecord = AmsRecord<"forms">;
export type SubmissionRecord = AmsRecord<"formsubmissions">;

export const FORM_ACCENTS = [
  { name: "Pine", value: AMS_FORM_DEFAULT_ACCENT },
  { name: "Navy", value: "#1f3a5f" },
  { name: "Cobalt", value: "#2457c5" },
  { name: "Plum", value: "#6b3fa0" },
  { name: "Brick", value: "#b4442e" },
  { name: "Marigold", value: "#f0b429" },
  { name: "Graphite", value: "#2a2d34" },
] as const;

export function newFormDraft(
  agency: { name: string; phone?: string; email?: string },
  lineIds: string[] = [],
  name = "",
): FormDraft {
  const catalog = amsFormFromCatalog(lineIds);
  return {
    name: name || formNameFor(catalog),
    title: "Let's get you a quote",
    intro:
      "Answer a few questions and attach what you have. We'll review it and come back to you with options.",
    ...catalog,
    branding: {
      agencyName: agency.name || "Our agency",
      accent: AMS_FORM_DEFAULT_ACCENT,
      logo: "",
      phone: agency.phone || "",
      email: agency.email || "",
    },
    confirmation: {
      title: "Thank you. We have your information.",
      body: "Someone from our team will review it and get back to you.",
    },
    consent:
      "By sending this form you agree that we may contact you about your insurance.",
    ownerId: null,
    followUpDays: 1,
  };
}
export function draftOf(record: FormRecord): FormDraft {
  const { status: _status, linkId: _linkId, publishedAt: _publishedAt, ...draft } = record.data;
  return draft;
}
/** Two drafts say the same thing, whatever order their properties were written in. */
export function sameDraft(a: FormDraft, b: FormDraft): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
/** A good default name for a form with these lines: "Auto & homeowners quote". */
export function formNameFor(draft: Pick<FormDraft, "lines">): string {
  const labels = draft.lines.map((line) => line.label);
  if (!labels.length) return "New form";
  if (labels.length > 3) return "Insurance quote request";
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} & ${labels.at(-1)!.toLowerCase()}`;
  return `${list} quote`.slice(0, 120);
}

const controls = (field: AmsFormField | undefined, equals: string | boolean) =>
  field?.type === "yesno"
    ? typeof equals === "boolean"
    : field?.type === "select" && field.options.includes(String(equals));
/**
 * Makes a draft consistent after edits: a question whose condition no longer has
 * something to depend on is asked always, and a repeating section is named only by
 * questions it still has.
 */
export function tidyDraft(draft: FormDraft): FormDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) => {
      const earlier: AmsFormField[] = [];
      const fields = section.fields.map((field) => {
        const options = [...new Set(field.options.map((option) => option.trim()).filter(Boolean))];
        const controller = earlier.find((item) => item.id === field.showIf?.field);
        const next: AmsFormField = {
          ...field,
          label: field.label.trim(),
          help: field.help.trim(),
          options: field.type === "select" || field.type === "multiselect" ? options : [],
          showIf: field.showIf && controls(controller, field.showIf.equals) ? field.showIf : null,
        };
        earlier.push(next);
        return next;
      });
      return {
        ...section,
        fields,
        repeat: section.repeat && {
          ...section.repeat,
          title: section.repeat.title.filter((id) => fields.some((field) => field.id === id)),
        },
      };
    }),
  };
}
/** What stops a draft from saving, in words for the person editing it. Empty: it can save. */
export function draftProblems(draft: FormDraft): string[] {
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push("Give the form a name.");
  if (!draft.title.trim()) problems.push("Give the form a headline.");
  if (!draft.branding.agencyName.trim()) problems.push("Add your agency's name.");
  if (draft.sections.length > FORM_MAX_SECTIONS)
    problems.push(
      `A form holds up to ${FORM_MAX_SECTIONS} sections and this one has ${draft.sections.length}. Take a line of business or a section off, or split it into two forms.`,
    );
  else if (questionCount(draft) > FORM_MAX_QUESTIONS)
    problems.push(
      `A form holds up to ${FORM_MAX_QUESTIONS} questions and this one has ${questionCount(draft)}. Take a line of business off, or split it into two forms.`,
    );
  for (const section of draft.sections) {
    if (!section.title.trim()) problems.push("Every section needs a title.");
    for (const field of section.fields) {
      if (!field.label.trim())
        problems.push(`A question in "${section.title}" has no wording.`);
      else if (
        (field.type === "select" || field.type === "multiselect") &&
        !field.options.some((option) => option.trim())
      )
        problems.push(`"${field.label}" needs at least one choice.`);
    }
    if (!section.fields.length) problems.push(`"${section.title}" has no questions.`);
  }
  if (problems.length) return [...new Set(problems)];
  const parsed = AmsFormSchema.safeParse(tidyDraft(draft));
  return parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((issue) => issue.message))].slice(0, 3);
}
/** The draft as a client would see it, for the live preview. */
export function previewForm(draft: FormDraft): AmsPublicForm {
  return amsPublicForm(
    { ...tidyDraft(draft), status: "draft", linkId: null, publishedAt: null },
    1,
    "preview",
  );
}
/**
 * A new section or question id. Random, so the id of a removed question is never given
 * to a new one: an answer a client already typed can't attach itself to a different
 * question.
 */
export function newKey(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const key = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
    if (/^[a-z][a-z0-9_]{0,39}$/.test(key) && !used.has(key)) return key;
  }
}
/** The most a form can hold (packages/contracts/src/forms.ts). */
export const FORM_MAX_SECTIONS = 40;
export const FORM_MAX_QUESTIONS = 300;
export const questionCount = (draft: Pick<FormDraft, "sections">) =>
  draft.sections.reduce((total, section) => total + section.fields.length, 0);
/** Whether a draft is within what one form can hold. */
export const fitsOneForm = (draft: Pick<FormDraft, "sections">) =>
  draft.sections.length <= FORM_MAX_SECTIONS && questionCount(draft) <= FORM_MAX_QUESTIONS;
export const sectionSummary = (section: AmsFormSection) =>
  [
    `${section.fields.length} ${section.fields.length === 1 ? "question" : "questions"}`,
    section.repeat ? `one set per ${section.repeat.noun}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/* ------------------------------------------------------------------ sharing */

export const formUrl = (origin: string, linkId: string) => `${origin}/f/${linkId}`;
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
/**
 * HTML an agency pastes into its website. The frame grows with the form: the page
 * inside reports its height, and only messages from the form's own origin are heard.
 */
export function embedSnippet(origin: string, linkId: string, title: string): string {
  const url = `${formUrl(origin, linkId)}?embed=1`;
  const id = `openams-form-${linkId.slice(-10)}`;
  return [
    `<iframe id="${id}" src="${escapeHtml(url)}" title="${escapeHtml(title)}"`,
    `  style="width:100%;max-width:760px;height:900px;border:0" loading="lazy"></iframe>`,
    `<script>`,
    `  window.addEventListener("message", function (event) {`,
    `    if (event.origin !== ${JSON.stringify(origin)}) return;`,
    `    if (!event.data || event.data.type !== "openams:form-height") return;`,
    `    document.getElementById(${JSON.stringify(id)}).style.height = event.data.height + "px";`,
    `  });`,
    `</script>`,
  ].join("\n");
}
/** True on a computer's own address, where a link can't be opened by anyone else. */
export const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/* -------------------------------------------------------------- submissions */

const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "").slice(-10);
const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
export interface AccountMatch {
  account: AmsRecord<"accounts">;
  /** Why this account is suggested, for the person filing. */
  reason: string;
  /**
   * The same email or phone number. A name alone is offered but never chosen for the
   * person filing: anyone can type a client's name into a public form.
   */
  strong: boolean;
}
/** Accounts a submission probably belongs to: same email, phone or name. Best first. */
export function matchingAccounts(book: Book, submission: SubmissionRecord): AccountMatch[] {
  const { contact } = submission.data;
  const email = lower(contact.email);
  const phone = digits(contact.phone);
  const names = [lower(contact.businessName), lower(contact.name)].filter(Boolean);
  const scored = new Map<string, { score: number; reason: string }>();
  const note = (accountId: string | null | undefined, score: number, reason: string) => {
    if (!accountId) return;
    const current = scored.get(accountId);
    if (!current || current.score < score) scored.set(accountId, { score, reason });
  };
  for (const account of (book.accounts || []) as AmsRecord<"accounts">[]) {
    if (account.data.consolidation) continue;
    if (email && lower(account.data.email) === email) note(account.id, 4, "Same email");
    else if (phone.length === 10 && digits(account.data.phone) === phone)
      note(account.id, 3, "Same phone number");
    else if (names.includes(lower(account.data.name)) || names.includes(lower(account.data.legalName)))
      note(account.id, 2, "Same name");
  }
  for (const record of (book.contacts || []) as AmsRecord<"contacts">[]) {
    if (email && lower(record.data.email) === email)
      note(record.data.accountId, 4, `Contact ${record.data.name} has this email`);
    else if (
      phone.length === 10 &&
      [digits(record.data.phone), digits(record.data.mobile)].includes(phone)
    )
      note(record.data.accountId, 3, `Contact ${record.data.name} has this phone number`);
  }
  const accounts = new Map(
    ((book.accounts || []) as AmsRecord<"accounts">[]).map((account) => [account.id, account]),
  );
  return [...scored]
    .flatMap(([id, match]) => {
      const account = accounts.get(id);
      return account ? [{ account, ...match }] : [];
    })
    .sort((a, b) => b.score - a.score || a.account.data.name.localeCompare(b.account.data.name))
    .slice(0, 4)
    .map(({ account, reason, score }) => ({ account, reason, strong: score >= 3 }));
}
/** What filing will add to the account, in words: "2 drivers, 1 vehicle". */
export function exposureSummary(submission: SubmissionRecord): string {
  const counts = new Map<string, number>();
  for (const section of submission.data.sections)
    if (section.exposure)
      counts.set(section.exposure, (counts.get(section.exposure) ?? 0) + section.items.length);
  return [...counts]
    .map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`)
    .join(", ");
}
/** "3 minutes ago", "yesterday", then a date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
