import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { AmsError } from "../repository.js";
import { formUploadKey } from "../form-links.js";
import type { AmsBucket } from "./storage-files.js";
import { CloudStorageAmsFiles } from "./storage-files.js";

interface Promotion {
  tenantId: string;
  submissionId: string;
  bucket: string;
  files: { sha256: string; bytes: number }[];
}

/** Reserve the complete attempt before creating any permanent object. Each attempt
 * owns its keys and quota, even if the process stops between two writes. */
export function formPromotions(db: Firestore, bucket: AmsBucket, limit: number) {
  const store = new CloudStorageAmsFiles(bucket);
  return {
    async begin(attempt: string, tenantId: string, submissionId: string, files: Promotion["files"]) {
      const unique = [...new Map(files.map((file) => [file.sha256, file])).values()];
      const size = unique.reduce((sum, file) => sum + file.bytes, 0);
      const counter = db.collection("identity_limits").doc("agency_storage_" + tenantId);
      await db.runTransaction(async (tx) => {
        const count = Number((await tx.get(counter)).get("count") ?? 0);
        if (count + size > limit)
          throw new AmsError(413, "storage_quota_exceeded", "Your agency has reached its document storage limit.");
        tx.create(db.collection("form_promotions").doc(attempt), {
          bucket: bucket.name, tenantId, submissionId, files: unique,
          createdAt: FieldValue.serverTimestamp(),
        });
        tx.set(counter, { count: count + size, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      });
    },
    put: store.put.bind(store),
  };
}

/** Claim an abandoned attempt before deleting. The submission transaction consumes the
 * same journal document, so a saved submission can never lose its objects here. */
export async function recoverFormPromotion(db: Firestore, bucket: AmsBucket, attempt: string) {
  const ref = db.collection("form_promotions").doc(attempt);
  const entry = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return null;
    const promotion = snapshot.data() as Promotion;
    if (promotion.bucket !== bucket.name) throw new Error("Promotion belongs to another bucket.");
    // Outlast all in-flight storage writes, including retries on a terminated request.
    if (snapshot.get("createdAt").toMillis() > Date.now() - 48 * 60 * 60_000) return null;
    tx.update(ref, { recovering: true });
    return promotion;
  });
  if (!entry) return;
  const { tenantId, submissionId, files } = entry;
  for (const file of files) {
    const key = formUploadKey(tenantId, submissionId, file.sha256, attempt);
    await bucket.file(key).delete({ ignoreNotFound: true });
  }
  const release = files.reduce((sum, file) => sum + file.bytes, 0);
  await db.runTransaction(async (tx) => {
    if (!(await tx.get(ref)).exists) return;
    const counter = db.collection("identity_limits").doc("agency_storage_" + tenantId);
    if (release) {
      const count = Number((await tx.get(counter)).get("count") ?? 0);
      tx.set(counter, { count: Math.max(0, count - release), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    tx.delete(ref);
  });
}
