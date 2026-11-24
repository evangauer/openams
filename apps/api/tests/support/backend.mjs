// Chooses the storage backend for the API test suite.
//
// Default (`npm test`): SQLite repository and local files, no emulators needed.
// `OPENAMS_TEST_BACKEND=firebase` (set by `npm run test:firebase`): Firestore and
// Cloud Storage against the local emulators only. It refuses to run unless the
// emulator hosts are set, and always uses the offline `demo-openams` project,
// so tests can never reach a real Google Cloud project.
import { createHash, randomUUID } from "node:crypto";
import { SqliteAmsRepository } from "../../dist/sqlite-repository.js";
import { LocalAmsFiles } from "../../dist/files.js";

export const backend = process.env.OPENAMS_TEST_BACKEND ?? "sqlite";
if (backend !== "sqlite" && backend !== "firebase")
  throw new Error(`Unknown OPENAMS_TEST_BACKEND: ${backend}`);

export const projectId = "demo-openams";
let firebase = null;
export async function firebaseServices() {
  if (firebase) return firebase;
  if (
    !process.env.FIRESTORE_EMULATOR_HOST ||
    !process.env.FIREBASE_STORAGE_EMULATOR_HOST
  )
    throw new Error(
      "Firebase tests need the local emulators. Run `npm run test:firebase --workspace @openams/api`.",
    );
  const { initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getStorage } = await import("firebase-admin/storage");
  const { FirestoreAmsRepository } = await import(
    "../../dist/firebase/firestore-repository.js"
  );
  const { CloudStorageAmsFiles } = await import(
    "../../dist/firebase/storage-files.js"
  );
  const app = initializeApp(
    { projectId, storageBucket: `${projectId}.appspot.com` },
    `openams-tests-${randomUUID()}`,
  );
  firebase = {
    app,
    firestore: getFirestore(app),
    storage: getStorage(app),
    FirestoreAmsRepository,
    CloudStorageAmsFiles,
  };
  return firebase;
}
if (backend === "firebase") await firebaseServices();

const rootFor = (location) =>
  location === ":memory:"
    ? `test_${randomUUID().replaceAll("-", "")}`
    : `test_${createHash("sha256").update(location).digest("hex").slice(0, 40)}`;

/**
 * Drop-in for `new SqliteAmsRepository(location)`. Under Firebase, the same
 * location reopens the same Firestore root (so restart tests keep their data)
 * and `:memory:` gets a fresh, isolated root.
 */
export function openRepository(location) {
  if (backend === "sqlite") return new SqliteAmsRepository(location);
  const repository = new firebase.FirestoreAmsRepository(firebase.firestore, {
    root: rootFor(location),
  });
  repository.close = () => {};
  return repository;
}
/** Drop-in for `new LocalAmsFiles(dir)`; under Firebase each dir gets its own bucket. */
export function openFiles(dir) {
  if (backend === "sqlite") return new LocalAmsFiles(dir);
  return new firebase.CloudStorageAmsFiles(
    firebase.storage.bucket(rootFor(dir).replaceAll("_", "-")),
  );
}
/** Where unsent form uploads wait: the same folder locally, its own prefix in Cloud Storage. */
export function openPendingFiles(dir) {
  if (backend === "sqlite") return new LocalAmsFiles(dir);
  return new firebase.CloudStorageAmsFiles(
    firebase.storage.bucket(rootFor(dir).replaceAll("_", "-")),
    { prefix: "form-uploads" },
  );
}
