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
  /**
   * Gives an agency its forms address, in one step. An agency has at most one and it is
   * set once: claiming the one it has changes nothing, claiming another is refused
   * (`handle_set`). A handle another agency holds, or one spelled like an existing form
   * link, is refused (`handle_taken`). Like links, handles cannot be listed.
   */
  claimHandle(handle: string, tenantId: string): Promise<void>;
  /** The agency behind a forms address. */
  resolveHandle(handle: string): Promise<string | null>;
  /** An agency's own forms address. */
  handleOf(tenantId: string): Promise<string | null>;
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
export const handleTaken = () =>
  new AmsError(409, "handle_taken", "That address is already in use. Choose another.");
export const handleSet = () =>
  new AmsError(409, "handle_set", "Your agency already has a forms address.");

/** Local adapter: one table in the agency database. */
export class SqliteFormLinks implements AmsFormLinks {
  private ready: Promise<void>;
  constructor(private database: SqliteExclusive) {
    this.ready = database.exclusive((db) => {
      // The `tenant` column lets a demo sandbox's links be deleted with the sandbox.
      db.exec(
        "CREATE TABLE IF NOT EXISTS ams_form_links(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,form_id TEXT NOT NULL,created_at TEXT NOT NULL)",
      );
      // One forms address per agency, and one agency per address.
      db.exec(
        "CREATE TABLE IF NOT EXISTS ams_form_handles(handle TEXT PRIMARY KEY,tenant TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL)",
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
      // A link and a forms address share /f/<name>, so neither may take the other's.
      if (db.prepare("SELECT 1 FROM ams_form_handles WHERE handle=?").get(linkId))
        throw linkTaken();
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
  async claimHandle(handle: string, tenantId: string) {
    await this.ready;
    await this.database.exclusive((db) => {
      const own = db
        .prepare("SELECT handle FROM ams_form_handles WHERE tenant=?")
        .get(tenantId);
      if (own) {
        if (own.handle !== handle) throw handleSet();
        return;
      }
      if (
        db.prepare("SELECT 1 FROM ams_form_handles WHERE handle=?").get(handle) ||
        db.prepare("SELECT 1 FROM ams_form_links WHERE id=?").get(handle)
      )
        throw handleTaken();
      db.prepare("INSERT INTO ams_form_handles VALUES(?,?,?)").run(
        handle,
        tenantId,
        new Date().toISOString(),
      );
    });
  }
  async resolveHandle(handle: string) {
    await this.ready;
    return this.database.exclusive((db) => {
      const row = db
        .prepare("SELECT tenant FROM ams_form_handles WHERE handle=?")
        .get(handle);
      return row ? String(row.tenant) : null;
    });
  }
  async handleOf(tenantId: string) {
    await this.ready;
    return this.database.exclusive((db) => {
      const row = db
        .prepare("SELECT handle FROM ams_form_handles WHERE tenant=?")
        .get(tenantId);
      return row ? String(row.handle) : null;
    });
  }
}

/** For tests and single-process tools. */
export class MemoryFormLinks implements AmsFormLinks {
  private links = new Map<string, AmsFormLinkTarget>();
  /** handle → agency, and agency → handle. */
  private handles = new Map<string, string>();
  private owners = new Map<string, string>();
  async claim(linkId: string, target: AmsFormLinkTarget) {
    const existing = this.links.get(linkId);
    if (
      existing &&
      (existing.tenantId !== target.tenantId || existing.formId !== target.formId)
    )
      throw linkTaken();
    if (this.handles.has(linkId)) throw linkTaken();
    this.links.set(linkId, { ...target });
  }
  async resolve(linkId: string) {
    const target = this.links.get(linkId);
    return target ? { ...target } : null;
  }
  async claimHandle(handle: string, tenantId: string) {
    const own = this.owners.get(tenantId);
    if (own !== undefined) {
      if (own !== handle) throw handleSet();
      return;
    }
    if (this.handles.has(handle) || this.links.has(handle)) throw handleTaken();
    this.handles.set(handle, tenantId);
    this.owners.set(tenantId, handle);
  }
  async resolveHandle(handle: string) {
    return this.handles.get(handle) ?? null;
  }
  async handleOf(tenantId: string) {
    return this.owners.get(tenantId) ?? null;
  }
}
