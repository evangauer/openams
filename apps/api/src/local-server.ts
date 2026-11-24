import express from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AmsActor,
  AmsMember,
  AmsRole,
} from "@openams/contracts";
import { createAmsRouter } from "./routes.js";
import { SqliteAmsRepository } from "./sqlite-repository.js";
import { LocalAmsFiles } from "./files.js";
import { AmsService } from "./service.js";
import { AmsError } from "./repository.js";
import {
  demoChat,
  demoSeen,
  LocalAmsDemo,
  localDemoToken,
  type AmsDemoInfo,
} from "./local-demo.js";
import { directConversation, SqliteAmsChat } from "./chat.js";
import { DemoSandboxes } from "./demo-sandboxes.js";
import { SqliteMailboxStore } from "./mailbox-store.js";
import { mailboxRuntime } from "./mailbox-oauth.js";
import { FORM_PENDING_PREFIX, SqliteFormLinks } from "./form-links.js";

// Evaluation entrypoint: local development, the IAP-protected hosted preview, or the
// public demo (scripts/preview.mjs). Always loopback; only the web app reaches it.
// Hosted sign-in (AMS_AUTH_MODE=firebase) never uses the local test-role tokens.
if (process.env.AMS_AUTH_MODE === "firebase")
  throw new Error(
    "The local AMS server uses local test roles; it does not run with AMS_AUTH_MODE=firebase.",
  );
/** The public demo: no sign-in, a private sandbox per visitor (docs/public-demo.md). */
const publicDemo = process.env.AMS_PREVIEW === "public";
const hostedPreview =
  publicDemo ||
  (process.env.AMS_PREVIEW === "iap" && Boolean(process.env.AMS_PREVIEW_IAP_AUDIENCE));
if (
  (process.env.NODE_ENV !== "development" && !hostedPreview) ||
  process.env.AMS_LOCAL_ENABLED !== "1"
)
  throw new Error(
    "The local AMS server requires the development or hosted-preview launcher.",
  );
const directory = process.env.AMS_LOCAL_DIRECTORY;
if (!directory) throw new Error("AMS_LOCAL_DIRECTORY is required.");
const tokens = JSON.parse(process.env.AMS_LOCAL_TOKENS ?? "{}") as Record<
  string,
  string
>;
const roles: AmsRole[] = ["admin", "manager", "member", "accountant", "viewer"];
if (roles.some((role) => !tokens[role] || tokens[role].length < 40))
  throw new Error("Local development tokens are missing.");
await mkdir(directory, { recursive: true, mode: 0o700 });
const repository = new SqliteAmsRepository(join(directory, "agency.sqlite"));
const members: AmsMember[] = roles.map((role) => ({
  id: `local_${role}`,
  role,
  name: `Local ${role}`,
  email: `${role}@local.example`,
  active: true,
}));
const demoNames: Record<string, string> = {
  admin: "Alex Morgan",
  manager: "Sam Rivera",
  member: "Jordan Parker",
  accountant: "Taylor Brooks",
  viewer: "Casey Lee",
};
const demoMembers = members.map((member) => ({
  ...member,
  name: demoNames[member.role],
  email: `${member.role}@harbor.example.test`,
}));
const files = new LocalAmsFiles(join(directory, "files"));
const formLinks = new SqliteFormLinks(repository);
// Anyone can open the public demo, so its forms are built and previewed there but never
// published: an open sandbox must not host public forms on this domain.
const demo = new LocalAmsDemo(directory, repository, files, demoMembers, {
  links: formLinks,
  publishing: !publicDemo,
});
await demo.load();
/** In the demo agency the fictional teammates show as around, so chat feels lived in. */
class LocalChat extends SqliteAmsChat {
  async seen(tenantId: string) {
    const seen = await super.seen(tenantId);
    if (!demoInfo(tenantId)) return seen;
    // Whichever is more recent: the scripted time or a real visit.
    for (const [id, at] of Object.entries(demoSeen(demoMembers, new Date())))
      if (!seen[id] || seen[id] < at) seen[id] = at;
    return seen;
  }
}
const chat = new LocalChat(repository);
/** A fresh demo agency starts with a short team conversation. */
async function seedDemoChat(info: AmsDemoInfo | null) {
  if (!info || (await chat.last(info.tenantId, "team"))) return;
  const admin = demoMembers.find((member) => member.role === "admin")!.id;
  for (const message of demoChat(demoMembers, new Date())) {
    const conversation =
      "with" in message
        ? directConversation(message.with[0], message.with[1])
        : "team";
    const saved = await chat.post(info.tenantId, conversation, {
      id: randomUUID(),
      authorId: message.authorId,
      body: message.body,
      createdAt: message.createdAt,
    });
    if (message.read)
      await chat.markRead(info.tenantId, conversation, admin, saved.sequence);
  }
}
await seedDemoChat(demo.info());
const setting = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const sandboxes = publicDemo
  ? new DemoSandboxes({
      seed: async (input) => {
        const info = await demo.seed(input);
        await seedDemoChat(info);
        return info;
      },
      remove: async (tenantId) => {
        await repository.deleteTenant(tenantId);
        await files.removeAll(`ams-documents/${tenantId}`);
        await files.removeAll(`${FORM_PENDING_PREFIX}/${tenantId}`);
      },
      ttlMs: setting("AMS_DEMO_HOURS", 24) * 60 * 60 * 1000,
      max: setting("AMS_DEMO_MAX_SANDBOXES", 200),
      perMinute: setting("AMS_DEMO_STARTS_PER_MINUTE", 30),
    })
  : null;
/** The demo a tenant is: a visitor's sandbox, or the one local demo. */
function demoInfo(tenantId: string) {
  if (sandboxes) return sandboxes.info(tenantId);
  return demo.info()?.tenantId === tenantId ? demo.info() : null;
}
const sameToken = (given: string, expected: string) =>
  timingSafeEqual(
    createHash("sha256").update(given).digest(),
    createHash("sha256").update(expected).digest(),
  );
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "300kb" }));
// The web app opens a sandbox for a visitor. Only it holds the launcher's token.
if (sandboxes)
  app.post("/demo/sandboxes", (request, response, next) => {
    const bearer = request.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!sameToken(bearer, tokens.admin)) {
      response.status(404).json({ error: "not_found", message: "Not found." });
      return;
    }
    const { token, replaces } = (request.body ?? {}) as { token?: unknown; replaces?: unknown };
    sandboxes
      .create(String(token ?? ""), typeof replaces === "string" ? replaces : null)
      .then((sandbox) =>
        response.status(201).json({ expiresAt: new Date(sandbox.expiresAt).toISOString() }),
      )
      .catch(next);
  });
app.use(
  createAmsRouter({
    authenticate: (request, response, next) => {
      const bearer =
        request.header("authorization")?.replace(/^Bearer /, "") ?? "";
      if (sandboxes) {
        // Visitors hold a sandbox token and nothing else: the local test roles and the
        // scratch agency don't exist here.
        const sandbox = sandboxes.find(bearer);
        if (!sandbox) {
          response.status(401).json({
            error: "unauthorized",
            message: "This demo has ended. Start a fresh one.",
          });
          return;
        }
        try {
          sandboxes.admit(sandbox, request.method !== "GET");
        } catch (error) {
          next(error);
          return;
        }
        response.locals.amsActor = {
          userId: "local_admin",
          tenantId: sandbox.tenantId,
          name: demoNames.admin,
          role: "admin",
        } satisfies AmsActor;
        next();
        return;
      }
      const hash = createHash("sha256").update(bearer).digest();
      const entries = roles.flatMap((role) => [
        { role, demo: false, token: tokens[role] },
        { role, demo: true, token: localDemoToken(tokens[role]) },
      ]);
      const match = entries.find((entry) =>
        timingSafeEqual(
          hash,
          createHash("sha256").update(entry.token).digest(),
        ),
      );
      if (!match || (match.demo && !demo.info())) {
        response.status(401).json({
          error: "unauthorized",
          message: "Choose a local test session.",
        });
        return;
      }
      const { role } = match;
      response.locals.amsActor = {
        userId: `local_${role}`,
        tenantId: match.demo ? demo.info()!.tenantId : "local_agency",
        name: match.demo ? demoNames[role] : `Local ${role}`,
        role,
      } satisfies AmsActor;
      next();
    },
    actor: (request) => request.res!.locals.amsActor as AmsActor,
    enabled: async () => true,
    repository: () => repository,
    files,
    members: async (tenantId) =>
      tenantId === "local_agency" ? members : demoMembers,
    chat,
    // Files a client attaches wait beside the documents folder until the form is sent.
    forms: { links: formLinks, pending: files, publishing: !publicDemo },
    // The public demo connects to no mailbox.
    ...(sandboxes
      ? {}
      : { mailboxes: { store: new SqliteMailboxStore(repository), ...mailboxRuntime() } }),
    demo: {
      info: demoInfo,
      start: async (input) => {
        if (sandboxes)
          throw new AmsError(404, "not_found", "Start a fresh demo from the demo banner.");
        const info = await demo.start(input);
        await seedDemoChat(info);
        return info;
      },
    },
    workspaceName: async () => "Your local agency",
    timeZone: async () => process.env.AMS_LOCAL_TIME_ZONE || "America/Chicago",
  }),
);
app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof AmsError)
      response
        .status(error.status)
        .json({ error: error.code, message: error.message });
    else {
      const status = (error as { status?: number }).status;
      response
        .status(status && status >= 400 && status < 500 ? status : 500)
        .json({
          error: "request_failed",
          message: "The request failed. No successful save has been confirmed.",
        });
    }
  },
);
// Local worker uses durable records; a restart catches up due work. No external effects.
const reminderService = new AmsService({
  repository,
  members: async (tenantId) =>
    tenantId === "local_agency" ? members : demoMembers,
  timeZone: async () => process.env.AMS_LOCAL_TIME_ZONE || "America/Chicago",
});
let reminderRun: Promise<unknown> | null = null;
const runReminders = () => {
  if (reminderRun) return;
  reminderRun = Promise.all(
    (sandboxes
      ? sandboxes.tenants()
      : ["local_agency", ...(demo.info() ? [demo.info()!.tenantId] : [])]
    ).map((tenantId) => reminderService.processDueReminders(tenantId)),
  )
    .catch(() => {
      console.error(
        "AMS reminder processing failed; pending records remain available for retry.",
      );
    })
    .finally(() => {
      reminderRun = null;
    });
};
const reminderTimer = setInterval(runReminders, 10_000);
reminderTimer.unref();
// Files attached to a form that was never sent are deleted after two days.
const sweepUploads = () =>
  files
    .removeStale(FORM_PENDING_PREFIX, Date.now() - 48 * 60 * 60 * 1000)
    .catch(() => console.error("Clearing unsent form uploads failed; it will be retried."));
setInterval(sweepUploads, 60 * 60 * 1000).unref();
void sweepUploads();
// Expired sandboxes are deleted within a minute of their time.
if (sandboxes)
  setInterval(() => {
    sandboxes.sweep().catch(() => console.error("Demo cleanup failed; it will be retried."));
  }, 60_000).unref();
runReminders();
const server = app.listen(
  Number(process.env.AMS_LOCAL_PORT ?? 4455),
  "127.0.0.1",
  () =>
    console.log(
      "Local AMS API ready; records and files persist in the configured local directory.",
    ),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    clearInterval(reminderTimer);
    server.close(async () => {
      await reminderRun;
      repository.close();
      process.exit(0);
    });
  });
