import { createHash, randomBytes } from "node:crypto";
import { amsFormSlug } from "@openams/contracts";
import { AmsError } from "./repository.js";
import type { SqliteExclusive } from "./chat.js";

/*
 * A public form link names no agency. This index is the only thing that turns a link into
 * the agency and form behind it, and nothing reads it except to resolve one link: there
 * is no way to list links or to ask which links an agency has.
 */
export interface AmsFormLinkTarget {
  tenantId: string;
  formId: string;
}
export interface AmsFormLinks {
  /** Points a new link at a form. A link that already points there is left alone. */
  claim(linkId: string, target: AmsFormLinkTarget): Promise<void>;
  resolve(linkId: string): Promise<AmsFormLinkTarget | null>;
}

const LINK_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** `<form name>-<10 random characters>`: about 49 bits a visitor cannot guess. */
export function newFormLinkId(name: string): string {
  const random = Array.from(
    randomBytes(10),
    (byte) => LINK_ALPHABET[byte % LINK_ALPHABET.length],
  ).join("");
  return `${amsFormSlug(name)}-${random}`;
}
/**
 * The record id of a submission, from the form and the id the client's page chose. One
 * page load is one submission however often it is retried, and two forms never collide.
 */
export function formSubmissionId(formId: string, clientId: string): string {
  const hash = createHash("sha256")
    .update(`openams-form-submission:${formId}:${clientId.toLowerCase()}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
/** Where a submitted file is kept: with the agency's documents, before and after filing. */
export const formUploadKey = (tenantId: string, submissionId: string, sha256: string) =>
  `ams-documents/${tenantId}/forms/${submissionId}/${sha256}`;
/**
 * Where a file waits between being attached and the client pressing Send. This prefix
 * holds nothing else, so a deployment can expire whatever is left in it.
 */
export const FORM_PENDING_PREFIX = "form-uploads";
export const formPendingKey = (tenantId: string, submissionId: string, sha256: string) =>
  `${FORM_PENDING_PREFIX}/${tenantId}/${submissionId}/${sha256}`;

export const linkTaken = () =>
  new AmsError(409, "link_taken", "That link is already in use. Try again.");

/** Local adapter: one table in the agency database. */
export class SqliteFormLinks implements AmsFormLinks {
  private ready: Promise<void>;
  constructor(private database: SqliteExclusive) {
    this.ready = database.exclusive((db) => {
      // The `tenant` column lets a demo sandbox's links be deleted with the sandbox.
      db.exec(
        "CREATE TABLE IF NOT EXISTS ams_form_links(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,form_id TEXT NOT NULL,created_at TEXT NOT NULL)",
      );
    });
  }
  async claim(linkId: string, target: AmsFormLinkTarget) {
    await this.ready;
    await this.database.exclusive((db) => {
      const row = db
        .prepare("SELECT tenant,form_id FROM ams_form_links WHERE id=?")
        .get(linkId);
      if (row) {
        if (row.tenant !== target.tenantId || row.form_id !== target.formId)
          throw linkTaken();
        return;
      }
      db.prepare("INSERT INTO ams_form_links VALUES(?,?,?,?)").run(
        linkId,
        target.tenantId,
        target.formId,
        new Date().toISOString(),
      );
    });
  }
  async resolve(linkId: string) {
    await this.ready;
    return this.database.exclusive((db) => {
      const row = db
        .prepare("SELECT tenant,form_id FROM ams_form_links WHERE id=?")
        .get(linkId);
      return row
        ? { tenantId: String(row.tenant), formId: String(row.form_id) }
        : null;
    });
  }
}

/** For tests and single-process tools. */
export class MemoryFormLinks implements AmsFormLinks {
  private links = new Map<string, AmsFormLinkTarget>();
  async claim(linkId: string, target: AmsFormLinkTarget) {
    const existing = this.links.get(linkId);
    if (
      existing &&
      (existing.tenantId !== target.tenantId || existing.formId !== target.formId)
    )
      throw linkTaken();
    this.links.set(linkId, { ...target });
  }
  async resolve(linkId: string) {
    const target = this.links.get(linkId);
    return target ? { ...target } : null;
  }
}
