import type { Request, Response, RequestHandler, Router } from "express";
import { z } from "zod";
import { AmsId, type AmsActor } from "@openams/contracts";
import { parseAms } from "./service.js";
import type { Mailboxes } from "./mailboxes.js";

const provider = z.enum(["gmail", "microsoft365"]);
const revision = z.number().int().min(1);
const cursor = z.string().max(4096).optional();
const bodyRevision = z.object({ expectedRevision: revision }).strict();
const folders = z
  .object({
    parentId: z.string().min(1).max(2048).optional(),
    next: z.string().min(1).max(16_384).optional(),
  })
  .strict();
export function mountMailboxRoutes(
  router: Router,
  mailboxes: Mailboxes,
  handle: (
    action: (
      request: Request,
      response: Response,
      actor: AmsActor,
    ) => Promise<void>,
  ) => RequestHandler,
) {
  router.get(
    "/ams/mailboxes",
    handle(async (request, response, actor) => {
      const query = parseAms(z.object({ cursor }).strict(), request.query);
      response.json(await mailboxes.list(actor, query.cursor));
    }),
  );
  router.post(
    "/ams/mailboxes/connect",
    handle(async (request, response, actor) => {
      response.json(
        await mailboxes.begin(
          actor,
          parseAms(z.object({ provider }).strict(), request.body).provider,
        ),
      );
    }),
  );
  router.post(
    "/ams/mailboxes/authorize/:provider",
    handle(async (request, response, actor) => {
      const input = parseAms(
        z.object({ query: z.string().min(1).max(20_000) }).strict(),
        request.body,
      );
      response.json(
        await mailboxes.complete(
          actor,
          parseAms(provider, request.params.provider),
          input.query,
        ),
      );
    }),
  );
  router.get(
    "/ams/mailboxes/messages",
    handle(async (request, response, actor) => {
      const query = parseAms(
        z
          .object({
            connectionId: AmsId.optional(),
            status: z
              .enum([
                "review",
                "filing",
                "filed",
                "dismissed",
                "error",
                "unavailable",
              ])
              .optional(),
            cursor,
            limit: z.coerce.number().int().min(1).max(100).optional(),
          })
          .strict(),
        request.query,
      );
      response.json(await mailboxes.messages(actor, query));
    }),
  );
  router.get(
    "/ams/mailboxes/messages/:id/original",
    handle(async (request, response, actor) => {
      const bytes = await mailboxes.original(
        actor,
        parseAms(AmsId, request.params.id),
      );
      response.setHeader("Content-Type", "message/rfc822");
      response.setHeader(
        "Content-Disposition",
        'attachment; filename="original-mailbox-message.eml"',
      );
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.send(bytes);
    }),
  );
  router.get(
    "/ams/mailboxes/messages/:id",
    handle(async (request, response, actor) => {
      response.json(
        await mailboxes.getMessage(actor, parseAms(AmsId, request.params.id)),
      );
    }),
  );
  router.post(
    "/ams/mailboxes/messages/:id/file",
    handle(async (request, response, actor) => {
      const input = parseAms(
        z
          .object({
            expectedRevision: revision,
            accountId: AmsId,
            expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
            policyId: AmsId.nullable(),
            direction: z.enum(["inbound", "outbound", "unknown"]),
            shareWithAgency: z.literal(true),
          })
          .strict(),
        request.body,
      );
      response.json(
        await mailboxes.file(actor, parseAms(AmsId, request.params.id), input),
      );
    }),
  );
  router.post(
    "/ams/mailboxes/messages/:id/dismiss",
    handle(async (request, response, actor) => {
      const input = parseAms(
        bodyRevision.extend({ reason: z.string().trim().min(1).max(1000) }),
        request.body,
      );
      response.json(
        await mailboxes.dismiss(
          actor,
          parseAms(AmsId, request.params.id),
          input.expectedRevision,
          input.reason,
        ),
      );
    }),
  );
  router.post(
    "/ams/mailboxes/messages/:id/retry",
    handle(async (request, response, actor) => {
      const input = parseAms(bodyRevision, request.body);
      response.json(
        await mailboxes.retry(
          actor,
          parseAms(AmsId, request.params.id),
          input.expectedRevision,
        ),
      );
    }),
  );
  router.post(
    "/ams/mailboxes/:id/folders",
    handle(async (request, response, actor) => {
      response.json(
        await mailboxes.folders(
          actor,
          parseAms(AmsId, request.params.id),
          parseAms(folders, request.body),
        ),
      );
    }),
  );
  router.post(
    "/ams/mailboxes/:id/select-folder",
    handle(async (request, response, actor) => {
      const input = parseAms(
        z
          .object({
            folderId: z.string().min(1).max(2048),
            since: z.string().datetime({ offset: true }),
            shareWithAgency: z.literal(true),
            replaceSelection: z.boolean().optional(),
          })
          .strict(),
        request.body,
      );
      response.json(
        await mailboxes.selectFolder(
          actor,
          parseAms(AmsId, request.params.id),
          input,
        ),
      );
    }),
  );
  router.post(
    "/ams/mailboxes/:id/sync",
    handle(async (request, response, actor) => {
      parseAms(z.object({}).strict(), request.body);
      response.json(
        await mailboxes.sync(actor, parseAms(AmsId, request.params.id)),
      );
    }),
  );
  for (const action of ["disconnect", "reset"] as const)
    router.post(
      `/ams/mailboxes/:id/${action}`,
      handle(async (request, response, actor) => {
        const input = parseAms(bodyRevision, request.body);
        response.json(
          await mailboxes[action](
            actor,
            parseAms(AmsId, request.params.id),
            input.expectedRevision,
          ),
        );
      }),
    );
  router.get(
    "/ams/mailboxes/:id/events",
    handle(async (request, response, actor) => {
      const query = parseAms(z.object({ cursor }).strict(), request.query);
      response.json(
        await mailboxes.events(
          actor,
          parseAms(AmsId, request.params.id),
          query.cursor,
        ),
      );
    }),
  );
}
