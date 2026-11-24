import type { Firestore } from "firebase-admin/firestore";
import { linkTaken, type AmsFormLinks, type AmsFormLinkTarget } from "../form-links.js";

/**
 * Public form links in Firestore: `form_links/{linkId}` → { tenantId, formId }. Documents
 * are created once and never changed. Like every other collection, browsers cannot read
 * it (firestore.rules denies all); only the API resolves a link.
 */
export const FORM_LINKS_COLLECTION = "form_links";
const LINK = /^[a-z0-9](?:[a-z0-9-]{4,62})[a-z0-9]$/;

export class FirestoreFormLinks implements AmsFormLinks {
  constructor(
    private db: Firestore,
    private collection = FORM_LINKS_COLLECTION,
  ) {}
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
}
