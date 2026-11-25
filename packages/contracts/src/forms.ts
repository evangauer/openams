import { z } from "zod";

/*
 * Hosted forms: a form an agency publishes at a public link so a client can answer
 * questions and upload files without signing in. A submission is kept apart from the
 * book until a person at the agency files it to an account.
 *
 * This module has no imports from ./index.js (which imports it), so it defines the few
 * primitives it needs.
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const reference = Id.nullable().default(null);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** Section, field and line identifiers: stable keys inside one form. */
export const AmsFormKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const label = (max: number) => z.string().trim().min(1).max(max);

export const AMS_FORM_FIELD_TYPES = [
  "text",
  "longtext",
  "email",
  "phone",
  "number",
  "currency",
  "percent",
  "year",
  "date",
  "zip",
  "address",
  "vin",
  "ein",
  "select",
  "multiselect",
  "yesno",
  "file",
] as const;
export type AmsFormFieldType = (typeof AMS_FORM_FIELD_TYPES)[number];

/** Each item of a repeating section can become one of these on the account. */
export const AMS_FORM_EXPOSURE_KINDS = [
  "location",
  "building",
  "vehicle",
  "driver",
  "payroll",
  "equipment",
  "operations",
] as const;

/** What a client may upload through a public form (apps/api/src/files.ts checks the bytes). */
export const AMS_FORM_UPLOAD_EXTENSIONS = [
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "docx",
  "xlsx",
  "csv",
] as const;
export const AMS_FORM_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const AMS_FORM_UPLOAD_MAX_FILES = 10;
export const AMS_FORM_UPLOADS_PER_FIELD = 5;
export const AMS_FORM_MAX_ITEMS = 25;

export const AmsFormFieldSchema = z
  .object({
    id: AmsFormKey,
    label: label(200),
    help: z.string().trim().max(300).default(""),
    type: z.enum(AMS_FORM_FIELD_TYPES),
    required: z.boolean().default(false),
    /** Choices for select and multiselect questions. */
    options: z.array(z.string().trim().min(1).max(120)).max(60).default([]),
    /** Ask this only when an earlier question in the same section has this answer. */
    showIf: z
      .object({
        field: AmsFormKey,
        equals: z.union([z.string().max(120), z.boolean()]),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type AmsFormField = z.infer<typeof AmsFormFieldSchema>;

export const AmsFormSectionSchema = z
  .object({
    id: AmsFormKey,
    title: label(120),
    description: z.string().trim().max(400).default(""),
    /** Lines of business this section belongs to. Empty: every client answers it. */
    lines: z.array(AmsFormKey).max(40).default([]),
    /** Answered once per item, with "Add another". */
    repeat: z
      .object({
        /** What one item is called: "driver", "vehicle", "location". */
        noun: label(40),
        min: z.number().int().min(0).max(AMS_FORM_MAX_ITEMS).default(1),
        max: z.number().int().min(1).max(AMS_FORM_MAX_ITEMS).default(10),
        /** Fields whose answers name an item: year, make and model for a vehicle. */
        title: z.array(AmsFormKey).max(4).default([]),
      })
      .strict()
      .refine((value) => value.min <= value.max, "The least must not exceed the most.")
      .nullable()
      .default(null),
    /** On filing, each item becomes an exposure of this kind on the account. */
    exposure: z.enum(AMS_FORM_EXPOSURE_KINDS).nullable().default(null),
    fields: z.array(AmsFormFieldSchema).min(1).max(40),
  })
  .strict()
  .superRefine((section, ctx) => {
    const seen = new Map<string, AmsFormField>();
    section.fields.forEach((field, index) => {
      const issue = (message: string) =>
        ctx.addIssue({ code: "custom", path: ["fields", index], message });
      if (seen.has(field.id)) issue("Give each question in a section its own id.");
      if (
        (field.type === "select" || field.type === "multiselect") &&
        !field.options.length
      )
        issue("Add at least one choice.");
      if (new Set(field.options).size !== field.options.length)
        issue("List each choice once.");
      if (field.showIf) {
        const controller = seen.get(field.showIf.field);
        if (!controller || !["yesno", "select"].includes(controller.type))
          issue("A question can depend only on an earlier yes/no or choice question in the same section.");
        else if (
          controller.type === "yesno"
            ? typeof field.showIf.equals !== "boolean"
            : !controller.options.includes(String(field.showIf.equals))
        )
          issue("The answer this question depends on is not one of the choices.");
      }
      seen.set(field.id, field);
    });
    if (section.repeat?.title.some((id) => !seen.has(id)))
      ctx.addIssue({
        code: "custom",
        path: ["repeat", "title"],
        message: "An item can be named only by questions in its own section.",
      });
  });
export type AmsFormSection = z.infer<typeof AmsFormSectionSchema>;

export const AmsFormLineSchema = z
  .object({ id: AmsFormKey, label: label(80) })
  .strict();
export type AmsFormLine = z.infer<typeof AmsFormLineSchema>;

/** The section every form opens with; a submission's contact is read from it. */
export const AMS_FORM_CONTACT_SECTION = "contact";
/** Field ids in the contact section with a fixed meaning. */
export const AMS_FORM_CONTACT_FIELDS = {
  name: "name",
  email: "email",
  phone: "phone",
  business: "business_name",
  address: "address",
} as const;
export const AMS_FORM_STATUSES = ["draft", "published", "paused"] as const;
export const AMS_FORM_DEFAULT_ACCENT = "#1f6f5c";
/** `<form name>-<random>`: readable, and never guessable from another form's link. */
export const AmsFormLinkId = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{4,62})[a-z0-9]$/);

export const AmsFormSchema = z
  .object({
    /** The agency's own name for the form. Clients see `title`. */
    name: label(120),
    status: z.enum(AMS_FORM_STATUSES).default("draft"),
    /** Set when the form is first published; the link never changes afterwards. */
    linkId: AmsFormLinkId.nullable().default(null),
    publishedAt: z.string().datetime().nullable().default(null),
    /** Lines the client can ask about. With two or more, the client chooses. */
    lines: z.array(AmsFormLineSchema).max(24).default([]),
    title: label(120),
    intro: z.string().trim().max(600).default(""),
    sections: z.array(AmsFormSectionSchema).min(1).max(40),
    branding: z
      .object({
        agencyName: label(120),
        accent: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default(AMS_FORM_DEFAULT_ACCENT),
        /** A small raster logo as a data URL, resized in the browser before saving. */
        logo: z
          .union([
            z.literal(""),
            z
              .string()
              .max(60_000)
              .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
          ])
          .default(""),
        phone: z.string().trim().max(40).default(""),
        email: z.union([z.literal(""), z.string().email().max(254)]).default(""),
      })
      .strict(),
    confirmation: z
      .object({
        title: label(120).default("Thank you. We have your information."),
        body: z
          .string()
          .trim()
          .max(600)
          .default("Someone from our team will review it and get back to you."),
      })
      .strict()
      .prefault({}),
    /** Shown above the submit button. */
    consent: z.string().trim().max(1000).default(""),
    /** Who gets the follow-up task for each submission. Falls back to the agency default. */
    ownerId: reference,
    followUpDays: z.number().int().min(0).max(30).default(1),
  })
  .strict()
  .superRefine((form, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const lineIds = new Set(form.lines.map((line) => line.id));
    if (lineIds.size !== form.lines.length)
      issue(["lines"], "List each line of business once.");
    const sectionIds = new Set<string>();
    let fields = 0;
    form.sections.forEach((section, index) => {
      if (sectionIds.has(section.id))
        issue(["sections", index, "id"], "Give each section its own id.");
      sectionIds.add(section.id);
      fields += section.fields.length;
      if (section.lines.some((line) => !lineIds.has(line)))
        issue(
          ["sections", index, "lines"],
          "A section can belong only to a line of business on this form.",
        );
    });
    if (fields > 300) issue(["sections"], "Keep a form to 300 questions or fewer.");
    const contact = form.sections[0];
    const field = (id: string) => contact?.fields.find((item) => item.id === id);
    const name = field(AMS_FORM_CONTACT_FIELDS.name);
    const email = field(AMS_FORM_CONTACT_FIELDS.email);
    if (
      contact?.id !== AMS_FORM_CONTACT_SECTION ||
      contact.repeat ||
      contact.lines.length ||
      name?.type !== "text" ||
      !name.required ||
      name.showIf ||
      email?.type !== "email" ||
      !email.required ||
      email.showIf
    )
      issue(
        ["sections", 0],
        "A form starts with a contact section that asks for a name and an email address.",
      );
  });
export type AmsForm = z.infer<typeof AmsFormSchema>;

/* ------------------------------------------------------------------ answers */

export const AmsFormAddressValueSchema = z
  .object({
    line1: z.string().trim().max(200).default(""),
    line2: z.string().trim().max(200).default(""),
    city: z.string().trim().max(100).default(""),
    state: z.string().trim().max(2).default(""),
    postalCode: z.string().trim().max(20).default(""),
  })
  .strict();
export type AmsFormAddressValue = z.infer<typeof AmsFormAddressValueSchema>;
export const AmsFormValueSchema = z.union([
  z.string().max(4000),
  z.boolean(),
  z.array(z.string().max(120)).max(60),
  AmsFormAddressValueSchema,
]);
export type AmsFormValue = z.infer<typeof AmsFormValueSchema>;
/** One item's answers, by field id. */
export type AmsFormItem = Record<string, AmsFormValue>;
/** Answers by section id. A section that doesn't repeat has one item. */
export const AmsFormAnswersSchema = z.record(
  AmsFormKey,
  z.array(z.record(AmsFormKey, AmsFormValueSchema)).max(AMS_FORM_MAX_ITEMS),
);
export type AmsFormAnswers = z.infer<typeof AmsFormAnswersSchema>;
/** A file the client uploaded before submitting, named by where it belongs. */
export const AmsFormUploadSchema = z
  .object({
    section: AmsFormKey,
    item: z.number().int().min(0).max(AMS_FORM_MAX_ITEMS - 1),
    field: AmsFormKey,
    name: z.string().trim().min(1).max(200),
    sha256: Sha256,
    bytes: z.number().int().positive().max(AMS_FORM_UPLOAD_MAX_BYTES),
  })
  .strict();
export type AmsFormUpload = z.infer<typeof AmsFormUploadSchema>;
/** What the public page sends when the client submits. */
export const AmsFormSubmitSchema = z
  .object({
    /** Chosen by the page, so a retried submit is never saved twice. */
    id: z.string().uuid(),
    /** The form revision the client answered. */
    revision: z.number().int().positive().safe(),
    lines: z.array(AmsFormKey).max(24).default([]),
    answers: AmsFormAnswersSchema,
    files: z.array(AmsFormUploadSchema).max(AMS_FORM_UPLOAD_MAX_FILES).default([]),
    /** A field people never see. Anything in it means a script filled the form. */
    confirm: z.string().max(200).default(""),
    /** How long the page was open, in milliseconds. */
    elapsedMs: z.number().int().min(0).safe().default(0),
  })
  .strict();
export type AmsFormSubmit = z.infer<typeof AmsFormSubmitSchema>;

/* -------------------------------------------------------------- submissions */

export const AMS_FORM_SUBMISSION_STATUSES = ["new", "filed", "dismissed"] as const;
/**
 * A submission keeps the questions as they were asked beside the answers, so it reads
 * the same after the form is edited or retired.
 */
export const AmsFormSubmissionSchema = z
  .object({
    formId: Id,
    formName: label(120),
    formRevision: z.number().int().positive().safe(),
    lines: z.array(AmsFormLineSchema).max(24).default([]),
    contact: z
      .object({
        name: label(200),
        email: z.string().email().max(254),
        phone: z.string().trim().max(40).default(""),
        businessName: z.string().trim().max(200).default(""),
      })
      .strict(),
    sections: z
      .array(
        z
          .object({
            id: AmsFormKey,
            title: label(120),
            /** The repeat noun, or empty for a section answered once. */
            noun: z.string().trim().max(40).default(""),
            exposure: z.enum(AMS_FORM_EXPOSURE_KINDS).nullable().default(null),
            items: z
              .array(
                z
                  .object({
                    /** What the client's answers call this item: "2021 Toyota Camry". */
                    title: z.string().trim().max(200).default(""),
                    answers: z
                      .array(
                        z
                          .object({
                            id: AmsFormKey,
                            label: label(200),
                            type: z.enum(AMS_FORM_FIELD_TYPES),
                            value: AmsFormValueSchema,
                          })
                          .strict(),
                      )
                      .max(40),
                  })
                  .strict(),
              )
              .max(AMS_FORM_MAX_ITEMS),
          })
          .strict(),
      )
      .max(40),
    files: z
      .array(
        z
          .object({
            id: AmsFormKey,
            section: AmsFormKey,
            item: z.number().int().min(0).max(AMS_FORM_MAX_ITEMS - 1),
            field: AmsFormKey,
            label: label(200),
            name: label(200),
            mediaType: label(200),
            bytes: z.number().int().positive().max(AMS_FORM_UPLOAD_MAX_BYTES),
            sha256: Sha256,
            storageKey: label(500),
            /** The account document this file became when the submission was filed. */
            documentId: reference,
          })
          .strict(),
      )
      .max(AMS_FORM_UPLOAD_MAX_FILES)
      .default([]),
    status: z.enum(AMS_FORM_SUBMISSION_STATUSES).default("new"),
    /** The account the submission was filed to. */
    accountId: reference,
    /** The follow-up task opened when the submission arrived. */
    taskId: reference,
    filedAt: z.string().datetime().nullable().default(null),
    filedBy: reference,
    dismissReason: z.string().trim().max(500).default(""),
    submittedAt: z.string().datetime(),
    /**
     * A fingerprint of what the client sent. A repeat of the same send is the same
     * submission; a repeat with other answers is told the first ones were kept.
     */
    digest: Sha256,
  })
  .strict();
export type AmsFormSubmission = z.infer<typeof AmsFormSubmissionSchema>;

/** How a person at the agency files a submission to the book. */
export const AmsFormFilingSchema = z
  .object({
    /** An existing account, or null to create a prospect from the submission. */
    accountId: reference,
    account: z
      .object({
        name: label(500),
        type: z.enum(["business", "person"]),
      })
      .strict()
      .nullable()
      .default(null),
    createContact: z.boolean().default(true),
    createExposures: z.boolean().default(true),
  })
  .strict()
  .refine(
    (value) => Boolean(value.accountId) !== Boolean(value.account),
    "Choose an existing account or name a new one.",
  );
export type AmsFormFiling = z.infer<typeof AmsFormFilingSchema>;

/* ------------------------------------------------------- the public version */

/** What an unauthenticated visitor receives: the questions and the look, nothing else. */
export interface AmsPublicForm {
  linkId: string;
  revision: number;
  title: string;
  intro: string;
  lines: AmsFormLine[];
  sections: AmsFormSection[];
  branding: AmsForm["branding"];
  confirmation: AmsForm["confirmation"];
  consent: string;
}
export function amsPublicForm(
  form: AmsForm,
  revision: number,
  linkId = form.linkId ?? "",
): AmsPublicForm {
  return {
    linkId,
    revision,
    title: form.title,
    intro: form.intro,
    lines: form.lines,
    sections: form.sections,
    branding: form.branding,
    confirmation: form.confirmation,
    consent: form.consent,
  };
}

/* ---------------------------------------------------------------- behaviour */

type FormShape = Pick<AmsPublicForm, "lines" | "sections">;

/** The lines a submission is about: the client's choice, or the form's only line. */
export function amsFormChosenLines(form: FormShape, chosen: string[]): AmsFormLine[] {
  if (form.lines.length <= 1) return form.lines;
  return form.lines.filter((line) => chosen.includes(line.id));
}
/** The sections a client answers, given the lines they chose. */
export function amsFormSections(form: FormShape, chosen: string[]): AmsFormSection[] {
  const lines = new Set(amsFormChosenLines(form, chosen).map((line) => line.id));
  return form.sections.filter(
    (section) =>
      !section.lines.length || section.lines.some((line) => lines.has(line)),
  );
}
export function amsFormFieldVisible(field: AmsFormField, item: AmsFormItem): boolean {
  return !field.showIf || item[field.showIf.field] === field.showIf.equals;
}
/** The fields of a section a client is asked for one item, following earlier answers. */
export function amsFormVisibleFields(
  section: AmsFormSection,
  item: AmsFormItem,
): AmsFormField[] {
  const visible: AmsFormField[] = [];
  for (const field of section.fields)
    if (
      !field.showIf ||
      (visible.some((earlier) => earlier.id === field.showIf!.field) &&
        amsFormFieldVisible(field, item))
    )
      visible.push(field);
  return visible;
}
export function amsFormValueEmpty(value: AmsFormValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return !value.trim();
  if (typeof value === "boolean") return false;
  if (Array.isArray(value)) return !value.length;
  return !Object.values(value).some((part) => String(part ?? "").trim());
}
/** How many items of a section the client is answering: at least the section's minimum. */
export function amsFormItemCount(section: AmsFormSection, answered: number): number {
  if (!section.repeat) return 1;
  return Math.min(section.repeat.max, Math.max(section.repeat.min, answered));
}

const EMAIL = z.string().email().max(254);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* --------------------------------------------------------------- formatting */

const digitsOf = (value: string) => value.replace(/\D/g, "");
const grouped = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pad2 = (digits: string) => digits.padStart(2, "0");

/**
 * A phone number as it is typed. Ten digits become (518) 555-0142, with an optional
 * extension after an x; a number that starts with + and another country's code is left
 * as its digits. A leading 1 or +1 is dropped: no area code starts with 1.
 */
function phoneTyped(input: string): string {
  const text = input.trimStart();
  if (text.startsWith("+") && !/^\+\s*1/.test(text)) {
    const rest = text
      .slice(1)
      .replace(/[^\d ]/g, "")
      .replace(/ {2,}/g, " ")
      .trimStart();
    return `+${rest}`.slice(0, 20);
  }
  const mark = text.search(/x/i);
  const digits = digitsOf(mark === -1 ? text : text.slice(0, mark))
    .replace(/^1+/, "")
    .slice(0, 10);
  if (!digits) return "";
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  const number = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return mark === -1 || digits.length < 10
    ? number
    : `${number} x${digitsOf(text.slice(mark)).slice(0, 6)}`;
}
/**
 * A number as it is typed: digits, one decimal point and, where allowed, a leading minus.
 * Thousands are grouped from `groupFrom` whole digits up, so a dollar amount reads
 * 1,200 while a plain number that may be a year stays 1998.
 */
function numberTyped(
  input: string,
  rules: { decimals: number; groupFrom: number; negative?: boolean },
): string {
  const text = input.replace(/[^\d.-]/g, "");
  const sign = rules.negative && text.startsWith("-") ? "-" : "";
  const [whole = "", ...rest] = text.replace(/-/g, "").split(".");
  const digits = whole.replace(/^0+(?=\d)/, "").slice(0, 12);
  const shown = digits.length >= rules.groupFrom ? grouped(digits) : digits;
  if (!rest.length || !rules.decimals) return sign + shown;
  return `${sign}${shown || "0"}.${rest.join("").slice(0, rules.decimals)}`;
}
/** A date as it is typed, toward MM/DD/YYYY. Slashes are optional: 3/14 and 0314 both work. */
function dateTyped(input: string): string {
  const text = input.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return `${pad2(iso[2])}/${pad2(iso[3])}/${iso[1]}`;
  const parts = text.split(/[^\d]+/);
  if (parts.length > 1 && parts[0] && parts[0].length <= 2 && parts[1].length <= 2) {
    const month = pad2(parts[0]);
    if (parts.length === 2) return `${month}/${parts[1]}`;
    const day = parts[1] ? pad2(parts[1]) : "";
    return `${month}/${day}/${parts.slice(2).join("").slice(0, 4)}`;
  }
  // A run of digits. A first digit that can only be a whole month or day gets its zero.
  let rest = digitsOf(text);
  const take = (lone: RegExp) => {
    const part = lone.test(rest) ? `0${rest[0]}` : rest.slice(0, 2);
    rest = rest.slice(lone.test(rest) ? 1 : 2);
    return part;
  };
  const month = take(/^[2-9]/);
  if (!rest) return month;
  const day = take(/^[4-9]/);
  return rest ? `${month}/${day}/${rest.slice(0, 4)}` : `${month}/${day}`;
}
/**
 * What an input shows while a client types: the same answer, tidied as it goes. Applying
 * it to its own result changes nothing, so it is safe on every keystroke.
 */
export function amsFormTyped(type: AmsFormFieldType, input: string): string {
  switch (type) {
    case "phone":
      return phoneTyped(input);
    case "currency":
      return numberTyped(input, { decimals: 2, groupFrom: 4 });
    case "number":
      return numberTyped(input, { decimals: 4, groupFrom: 5, negative: true });
    case "percent":
      return numberTyped(input, { decimals: 2, groupFrom: 99 }).slice(0, 6);
    case "year":
      return digitsOf(input).slice(0, 4);
    case "zip": {
      const digits = digitsOf(input).slice(0, 9);
      return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
    }
    case "ein": {
      const digits = digitsOf(input).slice(0, 9);
      return digits.length > 2 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : digits;
    }
    case "vin":
      return input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);
    case "date":
      return dateTyped(input);
    case "email":
      return input.replace(/\s/g, "");
    default:
      return input;
  }
}
/**
 * An answer as it is kept: one spelling for each value, however it was typed or pasted.
 * Checked and saved answers go through this, so 5185550142 and (518) 555-0142 are the
 * same phone number and 250,000 is the amount 250000.
 */
export function amsFormStored(type: AmsFormFieldType, input: string): string {
  const text = input.trim();
  switch (type) {
    case "phone":
      return phoneTyped(text).replace(/ x$/, "").trim();
    case "currency":
    case "number":
    case "percent": {
      const plain = text.replace(/[$,%\s]/g, "").replace(/\.$/, "");
      return plain.startsWith(".") ? `0${plain}` : plain;
    }
    case "date": {
      const typed = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateTyped(text));
      return typed ? `${typed[3]}-${typed[1]}-${typed[2]}` : text;
    }
    case "year":
      return text;
    case "zip":
    case "ein":
    case "vin":
    case "email":
      return amsFormTyped(type, text);
    default:
      return text;
  }
}
function validDate(value: string) {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    return false;
  const year = Number(value.slice(0, 4));
  return year >= 1900 && year <= 2100;
}
/** Why one answer can't be accepted, or null. Shared by the page and the server. */
export function amsFormFieldError(
  field: AmsFormField,
  value: AmsFormValue | undefined,
  uploads = 0,
): string | null {
  if (field.type === "file") {
    if (field.required && !uploads) return "Attach a file.";
    if (uploads > AMS_FORM_UPLOADS_PER_FIELD)
      return `Attach up to ${AMS_FORM_UPLOADS_PER_FIELD} files here.`;
    return null;
  }
  if (field.type === "yesno") {
    if (typeof value === "boolean") return null;
    return field.required || !amsFormValueEmpty(value) ? "Choose yes or no." : null;
  }
  if (field.type === "address") {
    if (amsFormValueEmpty(value)) return field.required ? "Enter the address." : null;
    const parsed = AmsFormAddressValueSchema.safeParse(value);
    if (!parsed.success) return "Enter the address.";
    const { line1, city, state, postalCode } = parsed.data;
    if (!line1 || !city) return "Enter the street and city.";
    if (!/^[A-Za-z]{2}$/.test(state)) return "Choose the state.";
    if (!/^\d{5}(-\d{4})?$/.test(postalCode)) return "Enter a 5-digit ZIP code.";
    return null;
  }
  if (field.type === "multiselect") {
    if (amsFormValueEmpty(value)) return field.required ? "Choose at least one." : null;
    if (
      !Array.isArray(value) ||
      value.some((choice) => !field.options.includes(choice)) ||
      new Set(value).size !== value.length
    )
      return "Choose from the list.";
    return null;
  }
  if (amsFormValueEmpty(value)) return field.required ? "This is required." : null;
  if (typeof value !== "string") return "Enter a value.";
  const text = amsFormStored(field.type, value);
  switch (field.type) {
    case "text":
      return text.length > 200 ? "Keep this under 200 characters." : null;
    case "email":
      return EMAIL.safeParse(text).success
        ? null
        : "Enter an email address like name@example.com.";
    case "phone": {
      const digits = digitsOf(text.split(" x")[0]).length;
      return (text.startsWith("+") ? digits >= 8 && digits <= 15 : digits === 10)
        ? null
        : "Enter a 10-digit phone number, area code first.";
    }
    case "number":
      return /^-?\d{1,12}(\.\d{1,4})?$/.test(text) ? null : "Enter a number.";
    case "currency":
      return /^\d{1,12}(\.\d{1,2})?$/.test(text)
        ? null
        : "Enter a dollar amount, like 250,000.";
    case "percent":
      return /^\d{1,3}(\.\d{1,2})?$/.test(text) && Number(text) <= 100
        ? null
        : "Enter a percent from 0 to 100.";
    case "year":
      return /^\d{4}$/.test(text) && Number(text) >= 1600 && Number(text) <= 2100
        ? null
        : "Enter a 4-digit year.";
    case "zip":
      return /^\d{5}(-\d{4})?$/.test(text) ? null : "Enter a 5-digit ZIP code.";
    case "ein":
      return /^\d{2}-\d{7}$/.test(text) ? null : "Enter the 9-digit tax ID.";
    case "vin":
      return /^[A-Z0-9]{5,17}$/.test(text)
        ? null
        : "Enter the VIN: up to 17 letters and numbers.";
    case "date":
      return validDate(text) ? null : "Enter a date as MM/DD/YYYY.";
    case "select":
      // Exactly one of the choices: a padded "Yes " must not pass here and then miss the
      // condition of a question that depends on it.
      return field.options.includes(value) ? null : "Choose from the list.";
    default:
      return null;
  }
}

export interface AmsFormIssue {
  section: string;
  item: number;
  /** Empty when the problem is with the section as a whole. */
  field: string;
  message: string;
}
export interface AmsFormInput {
  lines: string[];
  answers: AmsFormAnswers;
  files: Pick<AmsFormUpload, "section" | "item" | "field">[];
}
/** Everything that stops a submission from being accepted. */
export function amsFormIssues(form: FormShape, input: AmsFormInput): AmsFormIssue[] {
  const issues: AmsFormIssue[] = [];
  if (form.lines.length > 1 && !amsFormChosenLines(form, input.lines).length)
    issues.push({
      section: "",
      item: 0,
      field: "",
      message: "Choose at least one kind of coverage.",
    });
  for (const section of amsFormSections(form, input.lines)) {
    const answered = input.answers[section.id] ?? [];
    if (section.repeat && answered.length > section.repeat.max)
      issues.push({
        section: section.id,
        item: 0,
        field: "",
        message: `Add up to ${section.repeat.max}.`,
      });
    const count = amsFormItemCount(section, answered.length);
    for (let index = 0; index < count; index++) {
      const item = answered[index] ?? {};
      for (const field of amsFormVisibleFields(section, item)) {
        const uploads = input.files.filter(
          (file) =>
            file.section === section.id &&
            file.item === index &&
            file.field === field.id,
        ).length;
        const message = amsFormFieldError(field, item[field.id], uploads);
        if (message)
          issues.push({ section: section.id, item: index, field: field.id, message });
      }
    }
  }
  // Every file sits on a file question the client was asked, for an item they answered.
  const sections = amsFormSections(form, input.lines);
  for (const file of input.files) {
    const section = sections.find((item) => item.id === file.section);
    const answered = input.answers[file.section] ?? [];
    if (
      !section ||
      file.item >= amsFormItemCount(section, answered.length) ||
      !amsFormVisibleFields(section, answered[file.item] ?? {}).some(
        (field) => field.id === file.field && field.type === "file",
      )
    )
      issues.push({
        section: file.section,
        item: file.item,
        field: file.field,
        message: "Remove this file and attach it again.",
      });
  }
  if (input.files.length > AMS_FORM_UPLOAD_MAX_FILES)
    issues.push({
      section: input.files[AMS_FORM_UPLOAD_MAX_FILES].section,
      item: input.files[AMS_FORM_UPLOAD_MAX_FILES].item,
      field: input.files[AMS_FORM_UPLOAD_MAX_FILES].field,
      message: `This form takes up to ${AMS_FORM_UPLOAD_MAX_FILES} files in all. Remove one.`,
    });
  return issues;
}

function cleanValue(field: AmsFormField, value: AmsFormValue): AmsFormValue {
  // A choice is kept exactly as listed; everything else typed gets its one spelling.
  if (typeof value === "string")
    return field.type === "select" ? value : amsFormStored(field.type, value);
  if (field.type === "address") return AmsFormAddressValueSchema.parse(value);
  return value;
}
/**
 * The answered questions in the order they were asked, with their labels. Call this
 * only for input that has no issues.
 */
export function amsFormSnapshot(
  form: FormShape,
  input: AmsFormInput,
): AmsFormSubmission["sections"] {
  return amsFormSections(form, input.lines).flatMap((section) => {
    const answered = input.answers[section.id] ?? [];
    const items = Array.from(
      { length: amsFormItemCount(section, answered.length) },
      (_unused, index) => {
        const item = answered[index] ?? {};
        const answers = amsFormVisibleFields(section, item).flatMap((field) => {
          const value = item[field.id];
          return field.type === "file" || amsFormValueEmpty(value)
            ? []
            : [
                {
                  id: field.id,
                  label: field.label,
                  type: field.type,
                  value: cleanValue(field, value!),
                },
              ];
        });
        const title = (section.repeat?.title ?? [])
          .flatMap((id) => answers.filter((answer) => answer.id === id))
          .map((answer) => amsFormValueText(answer.value, answer.type))
          .join(" ")
          .trim()
          .slice(0, 200);
        return { title, answers };
      },
    );
    // Items keep their place (a file names its item by position); a section with
    // nothing answered at all is left out.
    return items.some((item) => item.answers.length)
      ? [
          {
            id: section.id,
            title: section.title,
            noun: section.repeat?.noun ?? "",
            exposure: section.exposure,
            items,
          },
        ]
      : [];
  });
}
/**
 * The submitter, read from the contact section of a snapshot: only answers to questions
 * the form asks, already checked.
 */
export function amsFormContact(
  sections: AmsFormSubmission["sections"],
): AmsFormSubmission["contact"] {
  const answers =
    sections.find((section) => section.id === AMS_FORM_CONTACT_SECTION)?.items[0]
      ?.answers ?? [];
  const text = (id: string) => {
    const value = answers.find((answer) => answer.id === id)?.value;
    return typeof value === "string" ? value.trim() : "";
  };
  return {
    name: text(AMS_FORM_CONTACT_FIELDS.name).slice(0, 200),
    email: text(AMS_FORM_CONTACT_FIELDS.email),
    phone: text(AMS_FORM_CONTACT_FIELDS.phone).slice(0, 40),
    businessName: text(AMS_FORM_CONTACT_FIELDS.business).slice(0, 200),
  };
}
/** An answer as a person reads it. */
export function amsFormValueText(value: AmsFormValue, type?: AmsFormFieldType): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object")
    return [
      value.line1,
      value.line2,
      [value.city, [value.state, value.postalCode].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(", "),
    ]
      .filter(Boolean)
      .join(", ");
  if (type === "phone") return amsFormStored("phone", value) || value;
  if (type === "number" && /^-?\d+(\.\d+)?$/.test(value))
    return amsFormTyped("number", value);
  if (type === "percent" && /^\d+(\.\d+)?$/.test(value)) return `${value}%`;
  if (type === "currency" && /^\d+(\.\d+)?$/.test(value))
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: value.includes(".") ? 2 : 0,
    }).format(Number(value));
  if (type === "date" && DATE.test(value)) {
    const [year, month, day] = value.split("-");
    return `${month}/${day}/${year}`;
  }
  return value;
}
/** The readable start of a link: "Auto & home quote" becomes "auto-home-quote". */
export function amsFormSlug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      // Every run of other characters is now one dash, so there is at most one to trim
      // at each end, before and after the cut.
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-/, "")
      .replace(/-$/, "")
      .slice(0, 40)
      .replace(/-$/, "") || "form"
  );
}

/* ------------------------------------------------------- the forms address */

/**
 * The short name an agency chooses for its forms: `/f/<handle>` lists its live forms and
 * `/f/<handle>/<path>` opens one. An agency has one, chosen once.
 */
export const AmsFormHandle = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/)
  .refine((handle) => !handle.includes("--"));
/** Names that would read as part of the product, not as an agency. */
export const AMS_FORM_RESERVED_HANDLES: readonly string[] = [
  "forms",
  "form",
  "f",
  "api",
  "app",
  "admin",
  "www",
  "openams",
  "support",
  "help",
  "billing",
  "login",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "security",
  "status",
  "demo",
  "test",
  "new",
  "about",
  "pricing",
  "terms",
  "privacy",
  "agency",
  "agencies",
  "public",
  "embed",
  "preview",
];
/** Why a forms address can't be used, in words for the person typing it. Null: it can. */
export function amsFormHandleError(handle: string): string | null {
  if (!AmsFormHandle.safeParse(handle).success)
    return "Use 3 to 40 lowercase letters, numbers and dashes.";
  if (AMS_FORM_RESERVED_HANDLES.includes(handle)) return "That address is reserved.";
  return null;
}
/** A form's readable name under its agency's address: its link without the random ending. */
export function amsFormPath(linkId: string): string {
  return linkId.replace(/-[a-z0-9]{10}$/, "");
}
/**
 * What a visitor to an agency's forms address receives: how to reach the agency and its
 * live forms, newest first. Two forms may share a `path`; link those by `linkId`.
 */
export interface AmsPublicAgencyForms {
  handle: string;
  name: string;
  phone: string;
  email: string;
  accent: string;
  logo: string;
  forms: {
    linkId: string;
    path: string;
    title: string;
    intro: string;
    lines: AmsFormLine[];
  }[];
}
