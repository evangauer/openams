import { mountCertificateRoutes } from "./certificate-routes.js";
import { rateLimit } from "express-rate-limit";
import { requestLimitOptions } from "./firebase/rate-limit.js";
import express, {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { z } from "zod";
import {
  AMS_KINDS,
  AmsId,
  AmsKindSchema,
  AmsListSchema,
  AmsTimeZone,
  amsCanRead,
  amsCanWrite,
  type AmsActor,
  type AmsMember,
  type AmsRecord,
  type AmsPage,
} from "@openams/contracts";
import {
  accountScope,
  AmsError,
  type AmsRepository,
} from "./repository.js";
import { AmsService, parseAms } from "./service.js";
import {
  fileHash,
  verifiedFile,
  type AmsFiles,
} from "./files.js";
import { EmailFilingInput, fileOriginalEmail } from "./correspondence.js";
import { applyImport, planImport } from "./import.js";
import type { AmsDemoInfo } from "./local-demo.js";
import { mountChatRoutes, type AmsChatStore } from "./chat.js";
import { Mailboxes } from "./mailboxes.js";
import type { MailboxStore } from "./mailbox-store.js";
import type { MailboxVault } from "./mailbox-credentials.js";
import type { MailboxOAuth } from "./mailbox-oauth.js";
import { mountMailboxRoutes } from "./mailbox-routes.js";

export interface AmsRouterDependencies {
  authenticate: RequestHandler;
  actor: (request: Request) => AmsActor;
  enabled: (tenantId: string) => Promise<boolean>;
  repository: () => AmsRepository;
  files: AmsFiles;
  members: (tenantId: string) => Promise<AmsMember[]>;
  workspaceName: (tenantId: string) => Promise<string>;
  certificateTemplates?: (tenantId: string) => Promise<string[]>;
  timeZone?: (tenantId: string) => Promise<string>;
  /** A Relay workspace is connected (quoting, assistant). This does not attest to provider connection health. */
  relayWorkspaceEnabled?: boolean;
  authorizeScheduler?: (request: Request, tenantId: string) => Promise<boolean>;
  /** Relay extension: reads an original email from the connected Relay mailbox for filing. */
  originalEmail?: (
    request: Request,
    input: { accountIds: string[]; leadId: string; messageId: string },
  ) => Promise<{
    bytes: Buffer;
    filename: string;
    direction: "inbound" | "outbound";
  }>;
  /** Team chat and presence. Without it the workspace hides chat. */
  chat?: AmsChatStore;
  mailboxes?: { store: MailboxStore; vault?: MailboxVault; oauth?: MailboxOAuth };
  demo?: {
    /** The demo a tenant is, or null when the tenant isn't a demo. */
    info: (tenantId: string) => AmsDemoInfo | null;
    start: (input: {
      commandId: string;
      restart: boolean;
      expectedTenantId: string | null;
    }) => Promise<AmsDemoInfo>;
  };
}
const MAX_CONCURRENT_EXPORTS = 2;
export function createAmsRouter(deps: AmsRouterDependencies): Router {
  const router = Router();
  const exportsRunning = new Set<string>();
  router.use(
    "/ams",
    rateLimit(requestLimitOptions(5000)),
    deps.authenticate,
    async (request: Request, response: Response, next: NextFunction) => {
      try {
        const actor = deps.actor(request);
        parseAms(AmsId, actor.tenantId);
        parseAms(AmsId, actor.userId);
        if (!(await deps.enabled(actor.tenantId))) {
          response.status(404).json({
            error: "ams_not_enabled",
            message: "Agency management is not enabled for this workspace.",
          });
          return;
        }
        response.setHeader("Cache-Control", "private, no-store");
        next();
      } catch (error) {
        next(error);
      }
    },
  );
  const handle =
    (
      action: (
        request: Request,
        response: Response,
        actor: AmsActor,
      ) => Promise<void>,
    ): RequestHandler =>
    async (request, response, next) => {
      try {
        await action(request, response, deps.actor(request));
      } catch (error) {
        if (error instanceof AmsError) {
          response
            .status(error.status)
            .json({ error: error.code, message: error.message });
          return;
        }
        next(error);
      }
    };
  const service = () =>
    new AmsService({
      repository: deps.repository(),
      members: deps.members,
      certificateTemplates: deps.certificateTemplates,
      timeZone: deps.timeZone,
    });
  if (deps.mailboxes) mountMailboxRoutes(router, new Mailboxes({ ...deps.mailboxes, repository: deps.repository(), files: deps.files, service, members: deps.members }), handle);
  mountCertificateRoutes(router, deps, handle, service);
  router.post(
    "/internal/ams/reminders/process",
    rateLimit(requestLimitOptions(10)),
    async (request, response, next) => {
      try {
        if (!deps.authorizeScheduler) {
          response.status(404).json({ error: "not_found" });
          return;
        }
        const { tenantId } = parseAms(
          z.object({ tenantId: AmsId }).strict(),
          request.body,
        );
        if (!(await deps.authorizeScheduler(request, tenantId))) {
          response.status(404).json({ error: "not_found" });
          return;
        }
        if (!(await deps.enabled(tenantId))) {
          response.status(404).json({ error: "ams_not_enabled" });
          return;
        }
        const { processed, conflicts, more } =
          await service().processDueReminders(tenantId);
        response.setHeader("Cache-Control", "no-store");
        response.json({ processed, conflicts, more });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get(
    "/ams/session",
    handle(async (_request, response, actor) => {
      const setup = await deps
        .repository()
        .get(actor.tenantId, "workspace", "agency");
      const [members, workspaceName, timeZone] = await Promise.all([
        deps.members(actor.tenantId),
        deps.workspaceName(actor.tenantId),
        setup
          ? Promise.resolve(setup.data.timeZone)
          : (deps.timeZone?.(actor.tenantId) ?? Promise.resolve("UTC")).catch(
              (error) => {
                if (
                  error instanceof AmsError &&
                  error.code === "agency_time_zone_required"
                )
                  return null;
                throw error;
              },
            ),
      ]);
      response.json({
        actor,
        members,
        workspaceName: setup?.data.name ?? workspaceName,
        timeZone: parseAms(AmsTimeZone, timeZone ?? "UTC"),
        calendarConfigured: timeZone !== null,
        defaultOwnerId: setup?.data.defaultOwnerId ?? null,
        demoAvailable: Boolean(deps.demo),
        demo: deps.demo?.info(actor.tenantId) ?? null,
        relayWorkspaceEnabled: deps.relayWorkspaceEnabled === true,
        chatEnabled: Boolean(deps.chat),
        originalEmailFilingEnabled: Boolean(deps.originalEmail),
        mailboxReviewEnabled: Boolean(deps.mailboxes),
        readableKinds: AMS_KINDS.filter((kind) => amsCanRead(actor.role, kind)),
        certificateTemplateHashes:
          (await deps.certificateTemplates?.(actor.tenantId)) ?? [],
        writableKinds: AMS_KINDS.filter((kind) =>
          amsCanWrite(actor.role, kind),
        ),
      });
    }),
  );
  if (deps.chat)
    mountChatRoutes(router, {
      chat: deps.chat,
      members: deps.members,
      handle,
    });
  router.post(
    "/ams/demo/start",
    handle(async (request, response, actor) => {
      if (!deps.demo)
        throw new AmsError(
          404,
          "not_found",
          "Demo is unavailable in this environment.",
        );
      if (actor.role !== "admin")
        throw new AmsError(
          403,
          "permission_denied",
          "Use the local administrator to start a demo.",
        );
      const input = parseAms(
        z
          .object({
            commandId: z.string().uuid(),
            restart: z.boolean().default(false),
            expectedTenantId: z.string().nullable().default(null),
          })
          .strict(),
        request.body,
      );
      response.json(await deps.demo.start(input));
    }),
  );
  router.post(
    "/ams/reminders/process",
    handle(async (_request, response, actor) => {
      if (!["admin", "manager"].includes(actor.role))
        throw new AmsError(
          403,
          "manager_required",
          "Only an agency manager can run the team reminder queue.",
        );
      response.json(await service().processDueReminders(actor.tenantId));
    }),
  );
  router.post(
    "/ams/accounts/:id/emails",
    express.raw({ type: "application/octet-stream", limit: "20mb" }),
    handle(async (request, response, actor) => {
      if (!amsCanWrite(actor.role, "correspondence"))
        throw new AmsError(
          403,
          "permission_denied",
          "Your role cannot file correspondence.",
        );
      if (!Buffer.isBuffer(request.body))
        throw new AmsError(
          415,
          "binary_required",
          "Upload the original .eml as application/octet-stream.",
        );
      const accountId = parseAms(AmsId, request.params.id);
      const filing = parseAms(EmailFilingInput, {
        ...request.query,
        shareWithAgency: request.query.shareWithAgency === "true",
      });
      let filename: string;
      try {
        filename = decodeURIComponent(request.header("x-file-name") || "");
      } catch {
        throw new AmsError(
          400,
          "invalid_file_name",
          "The file name encoding is invalid.",
        );
      }
      const result = await fileOriginalEmail({
        actor,
        accountId,
        filing,
        filename,
        bytes: request.body,
        repository: deps.repository(),
        files: deps.files,
        service: service(),
      });
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  router.post(
    "/ams/correspondence/file",
    handle(async (request, response, actor) => {
      if (!amsCanWrite(actor.role, "correspondence"))
        throw new AmsError(
          403,
          "permission_denied",
          "Your role cannot file correspondence.",
        );
      if (!deps.originalEmail)
        throw new AmsError(
          503,
          "mailbox_unavailable",
          "Mailbox filing is unavailable in this workspace. You can file an exported .eml.",
        );
      const { accountId, leadId, messageId, ...filing } = parseAms(
        EmailFilingInput.extend({
          accountId: AmsId,
          leadId: AmsId,
          messageId: AmsId,
        }).strict(),
        request.body,
      );
      const accountIds = await accountScope(
        deps.repository(),
        actor.tenantId,
        accountId,
      );
      const email = await deps.originalEmail(request, {
        accountIds,
        leadId,
        messageId,
      });
      const result = await fileOriginalEmail({
        actor,
        accountId,
        filing,
        ...email,
        source: { leadId, messageId, direction: email.direction },
        repository: deps.repository(),
        files: deps.files,
        service: service(),
      });
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  router.get(
    "/ams/records/:kind",
    handle(async (request, response, actor) => {
      const kind = parseAms(AmsKindSchema, request.params.kind);
      if (!amsCanRead(actor.role, kind))
        throw new AmsError(
          403,
          "permission_denied",
          "Your role cannot read these records.",
        );
      const options = parseAms(AmsListSchema, request.query);
      const accountIds = options.accountId
        ? await accountScope(
            deps.repository(),
            actor.tenantId,
            options.accountId,
          )
        : undefined;
      response.json(
        await deps.repository().list(actor.tenantId, kind, {
          ...options,
          ...(accountIds ? { accountIds } : {}),
        }),
      );
    }),
  );
  router.get(
    "/ams/records/:kind/:id",
    handle(async (request, response, actor) => {
      const kind = parseAms(AmsKindSchema, request.params.kind);
      const id = parseAms(AmsId, request.params.id);
      if (!amsCanRead(actor.role, kind))
        throw new AmsError(
          403,
          "permission_denied",
          "Your role cannot read these records.",
        );
      const record = await deps.repository().get(actor.tenantId, kind, id);
      if (!record) throw new AmsError(404, "not_found", "Record not found.");
      response.setHeader("ETag", `"${record.version}"`);
      response.json({ record });
    }),
  );
  router.get(
    "/ams/records/:kind/:id/revisions/:revision",
    handle(async (request, response, actor) => {
      const kind = parseAms(AmsKindSchema, request.params.kind);
      const id = parseAms(AmsId, request.params.id);
      const revision = parseAms(
        z.coerce.number().int().positive().safe(),
        request.params.revision,
      );
      if (!amsCanRead(actor.role, kind))
        throw new AmsError(
          403,
          "permission_denied",
          "Your role cannot read these records.",
        );
      const record = await deps
        .repository()
        .revision(actor.tenantId, kind, id, revision);
      if (!record) throw new AmsError(404, "not_found", "Revision not found.");
      response.json({ record });
    }),
  );
  router.get(
    "/ams/audit",
    handle(async (request, response, actor) => {
      const query = parseAms(
        z
          .object({
            accountId: AmsId.optional(),
            before: z.coerce.number().int().positive().safe().optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .strict(),
        request.query,
      );
      const scope = query.accountId
        ? await accountScope(deps.repository(), actor.tenantId, query.accountId)
        : undefined;
      const result = await deps
        .repository()
        .history(actor.tenantId, scope, query.before, query.limit);
      response.json({
        ...result,
        items: result.items
          .map((event) => ({
            ...event,
            records: event.records.filter((record) =>
              amsCanRead(actor.role, record.kind),
            ),
          }))
          .filter((event) => event.records.length),
      });
    }),
  );
  router.post(
    "/ams/commands",
    handle(async (request, response, actor) => {
      response.json(await service().execute(actor, request.body));
    }),
  );
  // Cheapest authenticated call: the web proxy uses it to confirm a session before it
  // reads a large upload body.
  router.get(
    "/ams/whoami",
    handle(async (_request, response, actor) => {
      response.json({ role: actor.role });
    }),
  );
  // The same check as a change: with external access control, a read-only, suspended or
  // pending agency is refused here (402) before the proxy reads an upload it would refuse.
  router.post(
    "/ams/upload-check",
    handle(async (_request, response) => {
      response.json({ ok: true });
    }),
  );
  // One import step per agency at a time, and a few per process: planning an import
  // reads the agency's accounts, policies and the target kind into memory.
  const importsRunning = new Set<string>();
  const guardedImport = async <T>(actor: AmsActor, work: () => Promise<T>): Promise<T> => {
    if (importsRunning.has(actor.tenantId))
      throw new AmsError(409, "import_in_progress", "An import step for this workspace is already running. Try again when it finishes.");
    if (importsRunning.size >= MAX_CONCURRENT_EXPORTS)
      throw new AmsError(503, "import_busy", "The server is busy with other imports. Try again in a minute.");
    importsRunning.add(actor.tenantId);
    try {
      return await work();
    } finally {
      importsRunning.delete(actor.tenantId);
    }
  };
  router.post(
    "/ams/import/validate",
    handle(async (request, response, actor) => {
      response.json(await guardedImport(actor, () => planImport(actor, request.body, deps.repository())));
    }),
  );
  router.post(
    "/ams/import/apply",
    handle(async (request, response, actor) => {
      const body = parseAms(
        z
          .object({
            input: z.unknown(),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
        request.body,
      );
      response.json(
        await guardedImport(actor, () =>
          applyImport(
            actor,
            body.input,
            deps.repository(),
            service(),
            body.fingerprint,
          ),
        ),
      );
    }),
  );
  router.post(
    "/ams/accounts/:id/documents",
    express.raw({ type: "application/octet-stream", limit: "20mb" }),
    handle(async (request, response, actor) => {
      if (!amsCanWrite(actor.role, "documents"))
        throw new AmsError(
          403,
          "permission_denied",
          "Your role cannot upload documents.",
        );
      const accountId = parseAms(AmsId, request.params.id);
      const repository = deps.repository();
      const account = await repository.get(
        actor.tenantId,
        "accounts",
        accountId,
      );
      if (!account || account.archivedAt)
        throw new AmsError(404, "not_found", "Account not found.");
      const input = parseAms(
        z
          .object({
            commandId: z.string().uuid(),
            policyId: AmsId.optional(),
            category: z
              .enum([
                "policy",
                "endorsement",
                "application",
                "certificate",
                "claims",
                "billing",
                "correspondence",
                "other",
              ])
              .default("other"),
            supersedesId: AmsId.optional(),
            description: z.string().max(10000).default(""),
          })
          .strict(),
        request.query,
      );
      if (!Buffer.isBuffer(request.body))
        throw new AmsError(
          415,
          "binary_required",
          "Upload the file as application/octet-stream.",
        );
      let filename: string;
      try {
        filename = decodeURIComponent(request.header("x-file-name") ?? "");
      } catch {
        throw new AmsError(
          400,
          "invalid_file_name",
          "The file name encoding is invalid.",
        );
      }
      const scope = await accountScope(repository, actor.tenantId, accountId);
      for (const [kind, id] of [
        ["policies", input.policyId],
        ["documents", input.supersedesId],
      ] as const)
        if (id) {
          const related = await repository.get(actor.tenantId, kind, id);
          if (
            !related ||
            related.archivedAt ||
            !scope.includes(related.data.accountId)
          )
            throw new AmsError(
              422,
              "account_mismatch",
              "Related documents and policies must belong to this account.",
            );
        }
      const metadata = verifiedFile(filename, request.body);
      const key = `ams-documents/${actor.tenantId}/${input.commandId}/${metadata.sha256}`;
      // An immutable content-addressed object may remain after a failed metadata transaction.
      // It is never listed/downloadable without authorized metadata; retries reuse the bytes.
      await deps.files.put(key, request.body, metadata.mediaType);
      const result = await service().createDocument(actor, {
        id: input.commandId,
        action: "create",
        kind: "documents",
        reason: "",
        data: {
          accountId,
          policyId: input.policyId ?? null,
          ...metadata,
          bytes: Buffer.byteLength(request.body),
          storageKey: key,
          category: input.category,
          supersedesId: input.supersedesId ?? null,
          description: input.description,
        },
      });
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  router.get(
    "/ams/documents/:id/content",
    handle(async (request, response, actor) => {
      if (!amsCanRead(actor.role, "documents"))
        throw new AmsError(
          403,
          "permission_denied",
          "Your role cannot read these records.",
        );
      const document = await deps
        .repository()
        .get(actor.tenantId, "documents", parseAms(AmsId, request.params.id));
      if (!document || document.archivedAt)
        throw new AmsError(404, "not_found", "Document not found.");
      if (
        !document.data.storageKey.startsWith(`ams-documents/${actor.tenantId}/`)
      )
        throw new AmsError(
          409,
          "invalid_document_reference",
          "The stored document reference is invalid.",
        );
      const bytes = await deps.files.get(document.data.storageKey);
      if (
        fileHash(bytes) !== document.data.sha256 ||
        bytes.length !== document.data.bytes
      )
        throw new AmsError(
          409,
          "document_integrity_failure",
          "The stored file does not match its recorded fingerprint.",
        );
      response.setHeader("Content-Type", document.data.mediaType);
      response.setHeader("Content-Length", bytes.length);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(document.data.name).replace(/'/g, "%27")}`,
      );
      response.send(bytes);
    }),
  );
  router.get(
    "/ams/export",
    handle(async (_request, response, actor) => {
      if (!["admin", "manager"].includes(actor.role))
        throw new AmsError(
          403,
          "manager_required",
          "An administrator or manager must export the full workspace.",
        );
      // One export per agency at a time, and a few per process: an export holds the
      // agency's records in memory until it is sent.
      if (exportsRunning.has(actor.tenantId))
        throw new AmsError(
          409,
          "export_in_progress",
          "An export for this workspace is already running. Try again when it finishes.",
        );
      if (exportsRunning.size >= MAX_CONCURRENT_EXPORTS)
        throw new AmsError(
          503,
          "export_busy",
          "The server is busy with other exports. Try again in a minute.",
        );
      exportsRunning.add(actor.tenantId);
      try {
        const records: AmsRecord[] = [];
        const startedAt = new Date().toISOString();
        for (const kind of AMS_KINDS) {
          let cursor: string | null = null;
          do {
            const page: AmsPage<AmsRecord> = await deps
              .repository()
              .list(actor.tenantId, kind, {
                limit: 100,
                includeArchived: "true",
                ...(cursor ? { cursor } : {}),
              });
            records.push(...page.items);
            cursor = page.nextCursor;
            if (records.length > 50_000)
              throw new AmsError(
                413,
                "export_too_large",
                "Use a managed database export for workspaces above 50,000 records.",
              );
          } while (cursor);
        }
        response.setHeader(
          "Content-Disposition",
          'attachment; filename="agency-records.json"',
        );
        response.json({
          schemaVersion: 1,
          workspaceId: actor.tenantId,
          startedAt,
          finishedAt: new Date().toISOString(),
          consistency:
            "Versioned record export; not a point-in-time database backup. Original file bytes are downloaded separately.",
          records,
        });
      } finally {
        exportsRunning.delete(actor.tenantId);
      }
    }),
  );
  return router;
}
