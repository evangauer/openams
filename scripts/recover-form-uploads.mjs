// Run from the built distribution, under a maintenance identity.
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { recoverFormPromotion } from "../apps/api/dist/firebase/form-promotions.js";

const [projectId, databaseId, bucketName] = process.argv.slice(2);
if (!projectId || !databaseId || !bucketName)
  throw new Error("Usage: node scripts/recover-form-uploads.mjs PROJECT DATABASE BUCKET");
const app = initializeApp({ projectId });
const db = getFirestore(app, databaseId);
const bucket = getStorage(app).bucket(bucketName);
const cutoff = Timestamp.fromMillis(Date.now() - 48 * 60 * 60_000);
let recovered = 0;
for (;;) {
  const page = await db.collection("form_promotions").where("createdAt", "<=", cutoff).limit(100).get();
  if (page.empty) break;
  for (const entry of page.docs) {
    await recoverFormPromotion(db, bucket, entry.id);
    recovered++;
  }
}
console.log("Processed abandoned upload attempts:", recovered);
