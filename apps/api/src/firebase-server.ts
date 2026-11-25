import express from "express";
import { rateLimit } from "express-rate-limit";
import { requestLimitOptions } from "./firebase/rate-limit.js";
import { initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { getAuth, type BaseAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { AmsActor } from "@openams/contracts";
import { createAmsRouter } from "./routes.js";
import { AmsService } from "./service.js";
import { FirestoreMailboxStore } from "./mailbox-store.js";
import { mailboxRuntime } from "./mailbox-oauth.js";
import { AmsError } from "./repository.js";
import { FirestoreAmsRepository } from "./firebase/firestore-repository.js";
import { FirestoreAmsChat } from "./firebase/firestore-chat.js";
import { FirestoreFormLinks } from "./firebase/firestore-form-links.js";
import { FORM_PENDING_PREFIX } from "./form-links.js";
import { CloudStorageAmsFiles } from "./firebase/storage-files.js";
import {
  createFirebaseAuthenticate,
  createIdentityRouter,
  signupModeFromEnv,
  firestoreMembers,
  firestoreTimeZone,
  firestoreWorkspaceName,
} from "./firebase/identity.js";
import { createStatusApi } from "./firebase/status.js";
import { invitationMailFromEnv } from "./firebase/invitation-mail.js";
import { signInMailFromEnv } from "./firebase/sign-in-mail.js";
import {
  createAccessApi,
  createAccessControl,
  externalAccessFromEnv,
} from "./firebase/external-access.js";
import {
  authTenantId,
  configuredAppOrigin,
  firestoreDatabaseId,
} from "./firebase/deployment-config.js";
import {
  rateLimitedAuthenticate,
  TokenBuckets,
} from "./firebase/rate-limit.js";
import {
  AgencyStorageQuota,
  AgencyWriteQuota,
  agencyLimitsFromEnv,
  agencyRequestBuckets,
  agencyRequestLimit,
  agencyWriteLimit,
  firestoreCounters,
} from "./firebase/agency-limits.js";
import {
  createSchedulerAuthorization,
  runRemindersForAllAgencies,
} from "./firebase/scheduler.js";

// Firebase deployment entrypoint (scripts/firebase-start.mjs). Binds loopback only: the
// web app on $PORT is the sole public surface and forwards an allowlist of paths here.
// Credentials come from the runtime's service account (Application Default Credentials);
// OpenAMS never reads a service-account key file.
if (process.env.AMS_AUTH_MODE !== "firebase")
  throw new Error("The Firebase API server requires AMS_AUTH_MODE=firebase.");
// Emulator mode must be asked for explicitly (scripts/dev-firebase.mjs). Anything else is
// treated as a real deployment: App Check is required and emulator hosts are refused, so
// a missing NODE_ENV can never switch off abuse protection.
const EMULATOR_HOSTS = [
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIREBASE_STORAGE_EMULATOR_HOST",
] as const;
const emulated = process.env.AMS_FIREBASE_EMULATORS === "1";
if (emulated) {
  if (process.env.NODE_ENV === "production")
    throw new Error(
      "Refusing to run production against the Firebase emulators.",
    );
  for (const name of EMULATOR_HOSTS)
    if (!process.env[name])
      throw new Error(`AMS_FIREBASE_EMULATORS=1 requires ${name}.`);
} else {
  for (const name of EMULATOR_HOSTS)
    if (process.env[name])
      throw new Error(
        `${name} is set without AMS_FIREBASE_EMULATORS=1; refusing to start.`,
      );
}
const appCheckRequired = !emulated;

// Optional per-deployment isolation inside one Google Cloud project (docs/cloud-run.md):
// a named Firestore database and an Identity Platform tenant. Unset means the default
// database and project-level Firebase Auth.
const databaseId = firestoreDatabaseId();
const tenantId = authTenantId();
const appOrigin = configuredAppOrigin();

const firebase = initializeApp();
const auth: BaseAuth = tenantId
  ? getAuth(firebase).tenantManager().authForTenant(tenantId)
  : getAuth(firebase);
const db = databaseId
  ? getFirestore(firebase, databaseId)
  : getFirestore(firebase);
const bucket = getStorage(firebase).bucket(
  process.env.AMS_STORAGE_BUCKET || undefined,
);
const appCheck = appCheckRequired ? getAppCheck(firebase) : undefined;

// Per-agency protective limits (docs/limits.md). Counters live in identity_limits and are
// never readable through any API.
const agencyLimits = agencyLimitsFromEnv();
const counters = firestoreCounters(db);
const repository = new FirestoreAmsRepository(db);
const files = new CloudStorageAmsFiles(bucket, {
  quota: new AgencyStorageQuota({
    store: counters,
    limitBytes: agencyLimits.storageBytes,
  }),
});
const members = firestoreMembers(db);
const timeZone = firestoreTimeZone(db);
const service = () => new AmsService({ repository, members, timeZone });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
app.use(express.json({ limit: "300kb" }));
app.get("/healthz", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true });
});
app.post(
  "/internal/reminders/run",
  // Unauthenticated requests are counted per client (the scheduler is its own client),
  // so nobody can use up the scheduler's admission. The scheduler's own allowance is
  // charged only after its Google-signed token is verified.
  rateLimit(requestLimitOptions(60)),
  createSchedulerAuthorization({
    serviceAccount: process.env.AMS_SCHEDULER_SERVICE_ACCOUNT,
    audience: appOrigin ? `${appOrigin}/api/internal/reminders` : undefined,
  }),
  rateLimit({ ...requestLimitOptions(10), keyGenerator: () => "scheduler" }),
  async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await runRemindersForAllAgencies({ db, service }));
    } catch (error) {
      next(error);
    }
  },
);
// Optional external access control (docs/external-access.md). Off by default.
const accessConfig = externalAccessFromEnv();
if (accessConfig.enabled && !appOrigin)
  throw new Error("AMS_ACCESS_CONTROL=external needs AMS_APP_URL.");
// Optional sign-in email in the OpenAMS look, through the same SMTP settings as
// invitations (docs/hosted-identity.md). Unset: Firebase sends its built-in email.
const signInMail = signInMailFromEnv(process.env, appOrigin ?? undefined);
const accessControl = createAccessControl({
  db,
  enabled: accessConfig.enabled,
  actor: (response) => response.locals.amsActor as AmsActor | undefined,
});
app.use(
  createIdentityRouter({
    auth,
    db,
    appCheck,
    access:
      accessConfig.enabled && appOrigin
        ? {
            view: accessControl.access,
            link: {
              appOrigin,
              url: accessConfig.url!,
              secret: accessConfig.secret!,
            },
          }
        : undefined,
    invitationMail: invitationMailFromEnv(process.env, appOrigin ?? undefined),
    signInMail:
      signInMail && appOrigin ? { appOrigin, send: signInMail } : undefined,
  }),
);
app.use(
  createAccessApi({
    db,
    enabled: accessConfig.enabled,
    authorize: createSchedulerAuthorization({
      serviceAccount: accessConfig.enabled
        ? accessConfig.serviceAccount
        : undefined,
      audience: appOrigin ? `${appOrigin}/api/internal/access` : undefined,
    }),
    onChange: accessControl.forget,
  }),
);
// Read-only instance status for an uptime monitor or other outside service. Off (404)
// unless a status service account is configured; then only its Google-signed ID tokens
// are accepted.
const statusServiceAccount = process.env.AMS_STATUS_SERVICE_ACCOUNT?.trim();
const statusEnabled = Boolean(
  statusServiceAccount && statusServiceAccount !== "off" && appOrigin,
);
app.use(
  createStatusApi({
    db,
    signup: signupModeFromEnv(),
    enabled: statusEnabled,
    authorize: createSchedulerAuthorization({
      serviceAccount: statusEnabled ? statusServiceAccount : undefined,
      audience: appOrigin ? `${appOrigin}/api/internal/status` : undefined,
    }),
  }),
);
const authenticateWithLimit = rateLimitedAuthenticate(
  createFirebaseAuthenticate({ auth, db }),
  (response) => (response.locals.amsActor as AmsActor | undefined)?.userId,
  new TokenBuckets({ capacity: 200, refillPerSecond: 5 }),
);
/** Runs handlers in order, stopping at the first that answers or fails. */
const inSequence =
  (...handlers: express.RequestHandler[]): express.RequestHandler =>
  (request, response, next) => {
    const step =
      (index: number) =>
      (error?: unknown): void => {
        const handler = handlers[index];
        if (error || !handler) return next(error);
        void handler(request, response, step(index + 1));
      };
    step(0)();
  };
const tenantOf = (response: express.Response) =>
  (response.locals.amsActor as AmsActor | undefined)?.tenantId;
const agencyRequests = agencyRequestLimit(
  tenantOf,
  agencyRequestBuckets(agencyLimits),
);
const agencyWrites = agencyWriteLimit(
  tenantOf,
  new AgencyWriteQuota({ store: counters, limit: agencyLimits.writesPerDay }),
);
app.use(
  createAmsRouter({
    // 5 requests a second per user with bursts of 200. One workspace load is ~25
    // requests (more for a large book, which pages each record type), so this leaves room
    // for normal use while capping how hard one account can push an instance. Each list
    // request is itself bounded by the repository's scan and byte budgets.
    // Then the agency's request bucket, its access state (when external access control
    // is on) and, for changes, its daily write quota.
    authenticate: inSequence(
      authenticateWithLimit,
      agencyRequests,
      accessControl.gate,
      agencyWrites,
    ),
    actor: (request) => request.res!.locals.amsActor as AmsActor,
    enabled: async () => true,
    repository: () => repository,
    files,
    members,
    chat: new FirestoreAmsChat(db),
    forms: {
      links: new FirestoreFormLinks(db),
      // Unsent uploads wait under their own prefix, outside any agency's storage count.
      // Give the bucket a lifecycle rule that deletes what is left there (docs/forms.md).
      pending: new CloudStorageAmsFiles(bucket, { prefix: FORM_PENDING_PREFIX }),
      // A form is a public page under this deployment's name. Where anyone can create
      // an agency and nothing vets them, forms are built and previewed but not published
      // (the same reasoning that limits such an agency's invitation email).
      publishing: signupModeFromEnv() !== "open" || accessConfig.enabled,
      // With external access control on, only an active agency's public forms stay open.
      accepting: async (agencyId) =>
        ((await accessControl.access(agencyId))?.state ?? "active") === "active",
    },
    mailboxes: { store: new FirestoreMailboxStore(db), ...mailboxRuntime() },
    workspaceName: firestoreWorkspaceName(db),
    timeZone,
  }),
);
app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof AmsError) {
      response
        .status(error.status)
        .json({ error: error.code, message: error.message });
      return;
    }
    const status = (error as { status?: number }).status;
    if (!status || status >= 500)
      // Log the error class only: messages and stacks can carry record contents.
      console.error(
        `OpenAMS API request failed: ${error instanceof Error ? error.name : typeof error}`,
      );
    response
      .status(status && status >= 400 && status < 500 ? status : 500)
      .json({
        error: "request_failed",
        message: "The request failed. No successful save has been confirmed.",
      });
  },
);

const server = app.listen(
  Number(process.env.AMS_API_PORT ?? 4510),
  "127.0.0.1",
  () =>
    console.log(
      `OpenAMS API ready on loopback${emulated ? " (Firebase emulators)" : ""}.`,
    ),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
