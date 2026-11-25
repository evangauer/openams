import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { firebaseServices } from "../support/backend.mjs";
import { formPromotions, recoverFormPromotion } from "../../dist/firebase/form-promotions.js";
import { fileHash } from "../../dist/files.js";
import { formUploadKey } from "../../dist/form-links.js";

test("only abandoned attempts are reaped, with one quota release across retries", async () => {
  const { firestore, storage, FirestoreAmsRepository } = await firebaseServices();
  const repo = new FirestoreAmsRepository(firestore);
  const bucket = storage.bucket();
  const tenant = randomUUID(), submission = randomUUID();
  const bytes = Buffer.from("fictional attachment");
  const file = { sha256: fileHash(bytes), bytes: bytes.length };
  const promotions = formPromotions(firestore, bucket, bytes.length * 2);
  const good = randomUUID(), abandoned = randomUUID();
  const key = (id) => formUploadKey(tenant, submission, file.sha256, id);
  const ref = (id) => firestore.collection("form_promotions").doc(id);
  const quota = async () => (await firestore.collection("identity_limits").doc("agency_storage_" + tenant).get()).get("count");
  for (const id of [good, abandoned]) {
    await promotions.begin(id, tenant, submission, [file, file]);
    await promotions.put(key(id), bytes, "text/plain");
  }
  assert.equal(await quota(), bytes.length * 2);
  await assert.rejects(promotions.begin(randomUUID(), tenant, submission, [file]), { code: "storage_quota_exceeded" });
  await recoverFormPromotion(firestore, bucket, abandoned);
  assert.equal((await ref(abandoned).get()).exists, true);
  await repo.transact(tenant, async (tx) => tx.consumeFormPromotion(good, submission));
  await recoverFormPromotion(firestore, bucket, good);
  await ref(abandoned).update({ createdAt: Timestamp.fromMillis(0) });
  const denied = { name: bucket.name, file: () => ({ delete: async () => { throw new Error("delete refused"); } }) };
  await assert.rejects(recoverFormPromotion(firestore, denied, abandoned), /delete refused/);
  assert.equal(await quota(), bytes.length * 2);
  await assert.rejects(repo.transact(tenant, async (tx) => tx.consumeFormPromotion(abandoned, submission)), { code: "upload_expired" });
  await recoverFormPromotion(firestore, bucket, abandoned);
  await recoverFormPromotion(firestore, bucket, abandoned);
  assert.equal(await quota(), bytes.length);
  assert.deepEqual((await bucket.file(key(good)).download())[0], bytes);
  assert.equal((await bucket.file(key(abandoned)).exists())[0], false);
});
