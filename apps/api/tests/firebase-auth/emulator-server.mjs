// Test-only composition of the identity and agency routers against the Firebase
// emulators, for driving the hosted web flow in a browser. Not a production server:
// the deploy composition lives elsewhere. Refuses to run without emulator hosts.
//
//   firebase emulators:start --config tests/firebase-auth/firebase.emulators.json \
//     --project demo-openams-auth --only auth,firestore
//   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9299 FIRESTORE_EMULATOR_HOST=127.0.0.1:8282 \
//     node tests/firebase-auth/emulator-server.mjs
import express from "express";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import {
  createFirebaseAuthenticate,
  createIdentityRouter,
  firestoreMembers,
  firestoreTimeZone,
  firestoreWorkspaceName,
} from "../../dist/firebase/identity.js";
import { createAmsRouter } from "../../dist/routes.js";
import { SqliteAmsRepository } from "../../dist/sqlite-repository.js";
import { LocalAmsFiles } from "../../dist/files.js";

if (
  !/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "") ||
  !/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")
)
  throw new Error("emulator-server.mjs runs only against local Firebase emulators.");
const app = initializeApp({ projectId: "demo-openams-auth" });
const auth = getAuth(app);
const db = getFirestore(app);
const dir = await mkdtemp(join(tmpdir(), "openams-emulator-"));
const repository = new SqliteAmsRepository(join(dir, "agency.sqlite"));
const server = express();
server.disable("x-powered-by");
server.use(express.json({ limit: "300kb" }));
server.use(createIdentityRouter({ auth, db }));
server.use(
  createAmsRouter({
    authenticate: createFirebaseAuthenticate({ auth, db }),
    actor: (request) => request.res.locals.amsActor,
    enabled: async () => true,
    repository: () => repository,
    files: new LocalAmsFiles(join(dir, "files")),
    members: firestoreMembers(db),
    workspaceName: firestoreWorkspaceName(db),
    timeZone: firestoreTimeZone(db),
  }),
);
server.use((error, _request, response, _next) => {
  const status = error?.status >= 400 && error.status < 500 ? error.status : 500;
  response.status(status).json({ error: error?.code ?? "request_failed" });
});
const port = Number(process.env.AMS_API_PORT ?? 4710);
server.listen(port, "127.0.0.1", () =>
  console.log(`Emulator-backed OpenAMS API on http://127.0.0.1:${port}`),
);
