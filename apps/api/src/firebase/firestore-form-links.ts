import type { Firestore } from "firebase-admin/firestore";
import {
  handleSet,
  handleTaken,
  linkTaken,
  type AmsFormLinks,
  type AmsFormLinkTarget,
} from "../form-links.js";

/**
 * Public form links in Firestore: `form_links/{linkId}` → { tenantId, formId }. Documents
 * are created once and never changed. Like every other collection, browsers cannot read
 * it (firestore.rules denies all); only the API resolves a link.
 *
 * An agency's forms address lives in the same collection, so a link and an address can
 * never share a name: `form_links/{handle}` → { tenantId, handle: true }. The agency's
 * side of it is `form_handles/{tenantId}` → { handle }, written in the same transaction,
 * which is what keeps an agency to one address.
 */
export const FORM_LINKS_COLLECTION = "form_links";
export const FORM_HANDLES_COLLECTION = "form_handles";
const LINK = /^[a-z0-9](?:[a-z0-9-]{4,62})[a-z0-9]$/;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
const TENANT = /^[A-Za-z0-9_-]{1,128}$/;

export class FirestoreFormLinks implements AmsFormLinks {
  constructor(
    private db: Firestore,
    private collection = FORM_LINKS_COLLECTION,
    private handles = FORM_HANDLES_COLLECTION,
  ) {}
  private owner(tenantId: string) {
    return this.db.collection(this.handles).doc(tenantId);
  }
  private ref(linkId: string) {
    return this.db.collection(this.collection).doc(linkId);
  }
  async claim(linkId: string, target: AmsFormLinkTarget) {
    if (!LINK.test(linkId)) throw linkTaken();
    try {
      await this.ref(linkId).create({
        tenantId: target.tenantId,
        formId: target.formId,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      // ALREADY_EXISTS: fine when it is this form's own link.
      if ((error as { code?: unknown })?.code !== 6) throw error;
      const existing = await this.resolve(linkId);
      if (
        existing?.tenantId !== target.tenantId ||
        existing.formId !== target.formId
      )
        throw linkTaken();
    }
  }
  async resolve(linkId: string) {
    if (!LINK.test(linkId)) return null;
    const doc = await this.ref(linkId).get();
    const tenantId = doc.get("tenantId");
    const formId = doc.get("formId");
    return doc.exists && typeof tenantId === "string" && typeof formId === "string"
      ? { tenantId, formId }
      : null;
  }
  async claimHandle(handle: string, tenantId: string) {
    if (!HANDLE.test(handle) || !TENANT.test(tenantId)) throw handleTaken();
    const createdAt = new Date().toISOString();
    await this.db.runTransaction(async (transaction) => {
      const [owner, held] = await Promise.all([
        transaction.get(this.owner(tenantId)),
        transaction.get(this.ref(handle)),
      ]);
      const own = owner.get("handle");
      if (owner.exists && typeof own === "string") {
        if (own !== handle) throw handleSet();
        return;
      }
      // A form link, or another agency's address.
      if (held.exists) throw handleTaken();
      transaction.create(this.ref(handle), { tenantId, handle: true, createdAt });
      transaction.create(this.owner(tenantId), { handle, createdAt });
    });
  }
  async resolveHandle(handle: string) {
    if (!HANDLE.test(handle)) return null;
    const doc = await this.ref(handle).get();
    const tenantId = doc.get("tenantId");
    return doc.exists && doc.get("handle") === true && typeof tenantId === "string"
      ? tenantId
      : null;
  }
  async handleOf(tenantId: string) {
    if (!TENANT.test(tenantId)) return null;
    const handle = (await this.owner(tenantId).get()).get("handle");
    return typeof handle === "string" ? handle : null;
  }
}
