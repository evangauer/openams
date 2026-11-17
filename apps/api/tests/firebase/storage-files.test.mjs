// CloudStorageAmsFiles against the Cloud Storage emulator.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { fileHash } from "../../dist/files.js";
import { firebaseServices } from "../support/backend.mjs";

const firebase = await firebaseServices();
const rejectsCode = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.stack);
    return true;
  });
const setup = () => {
  const bucket = firebase.storage.bucket(
    `files-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
  );
  return { bucket, files: new firebase.CloudStorageAmsFiles(bucket) };
};
const keyFor = (bytes, tenant = "agency-a") =>
  `ams-documents/${tenant}/${randomUUID()}/${fileHash(bytes)}`;

test("cloud storage: bytes round-trip exactly with private metadata", async () => {
  const { bucket, files } = setup();
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from([0, 255, 1, 254, 10, 13]),
    Buffer.from("Fictional declarations page ✓"),
  ]);
  const key = keyFor(bytes);
  await files.put(key, bytes, "application/pdf");
  assert.deepEqual(await files.get(key), bytes);
  const [metadata] = await bucket.file(key).getMetadata();
  assert.equal(metadata.contentType, "application/pdf");
  assert.equal(metadata.cacheControl, "private, no-store");
  assert.equal(metadata.metadata.sha256, fileHash(bytes));
});

test("cloud storage: put is write-once; identical retries are no-ops and different bytes conflict", async () => {
  const { bucket, files } = setup();
  const bytes = Buffer.from("original bytes");
  const key = keyFor(bytes);
  await files.put(key, bytes, "text/plain");
  const [before] = await bucket.file(key).getMetadata();
  await files.put(key, Buffer.from("original bytes"), "text/plain");
  const [after] = await bucket.file(key).getMetadata();
  assert.equal(after.generation, before.generation);
  await rejectsCode(
    files.put(key, Buffer.from("different bytes"), "text/plain"),
    "file_conflict",
  );
  assert.deepEqual(await files.get(key), bytes);
  // Concurrent first writes of identical bytes all succeed with one object.
  const shared = Buffer.from("concurrent identical");
  const sharedKey = keyFor(shared);
  await Promise.all(
    Array.from({ length: 4 }, () => files.put(sharedKey, shared, "text/plain")),
  );
  assert.deepEqual(await files.get(sharedKey), shared);
});

test("cloud storage: keys outside the document prefix or with unsafe segments are rejected", async () => {
  const { files } = setup();
  const bytes = Buffer.from("x");
  for (const key of [
    "",
    "ams-documents",
    "ams-documents/",
    "other/agency-a/cmd/hash",
    "/ams-documents/agency-a/cmd/hash",
    "ams-documents/../secrets/hash",
    "ams-documents/agency-a/../agency-b/hash",
    "ams-documents/agency-a/./hash",
    "ams-documents//cmd/hash",
    "ams-documents/agency-a/cmd/",
    "ams-documents/agency-a/cmd\\..\\hash",
    "ams-documents/agency-a/cmd/hash\u0000",
    "ams-documents-other/agency-a/cmd/hash",
    `ams-documents/${"x".repeat(1100)}`,
  ]) {
    await rejectsCode(files.put(key, bytes, "text/plain"), "invalid_file_path");
    await rejectsCode(files.get(key), "invalid_file_path");
  }
});

// The Storage emulator ignores `ifGenerationMatch`, so the race path (another
// writer creates the object between the existence check and the upload) is
// covered with a stub that behaves like Cloud Storage: 412 on an existing object.
test("cloud storage: a lost create race (412) compares hashes instead of overwriting", async () => {
  const objects = new Map();
  const saves = [];
  let racer = Buffer.from("same");
  const bucket = {
    file: (name) => ({
      download: async () => {
        if (!objects.has(name))
          throw Object.assign(new Error("No such object"), { code: 404 });
        return [objects.get(name)];
      },
      save: async (bytes, options) => {
        saves.push(options);
        // A concurrent writer won the race with `racer` bytes.
        objects.set(name, racer);
        throw Object.assign(new Error("Precondition Failed"), { code: 412 });
      },
    }),
  };
  const files = new firebase.CloudStorageAmsFiles(bucket);
  await files.put("ams-documents/agency-a/cmd-1/hash", Buffer.from("same"), "text/plain");
  racer = Buffer.from("other");
  await rejectsCode(
    files.put("ams-documents/agency-a/cmd-2/hash", Buffer.from("mine"), "text/plain"),
    "file_conflict",
  );
  assert.equal(saves.length, 2);
  for (const options of saves) {
    assert.deepEqual(options.preconditionOpts, { ifGenerationMatch: 0 });
    assert.equal(options.metadata.cacheControl, "private, no-store");
    assert.equal(options.contentType, "text/plain");
    assert.equal(options.public, undefined);
    assert.equal(options.private, undefined);
    assert.equal(options.predefinedAcl, undefined);
  }
});

test("cloud storage: a missing object is a 404 AmsError", async () => {
  const { files } = setup();
  await rejectsCode(
    files.get(`ams-documents/agency-a/${randomUUID()}/${"a".repeat(64)}`),
    "not_found",
  );
});
