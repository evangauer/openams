import express, {
  type Router,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import { z } from "zod";
import {
  AmsId,
  amsCanWrite,
  type AmsActor,
  type AmsRecord,
  type AmsCommandResult,
} from "@openams/contracts";
import { AmsError, digest } from "./repository.js";
import { fileHash } from "./files.js";
import { parseAms, type AmsService } from "./service.js";
import type { AmsRouterDependencies } from "./routes.js";
import { processCertificatePdf } from "./certificate-renderer.js";

type Handle = (
  action: (req: Request, res: Response, actor: AmsActor) => Promise<void>,
) => RequestHandler;
export function mountCertificateRoutes(
  router: Router,
  deps: AmsRouterDependencies,
  handle: Handle,
  service: () => AmsService,
) {
  async function replay(actor: AmsActor, id: string, fingerprint: string) {
    const receipt = await deps
      .repository()
      .transact(actor.tenantId, (tx) => tx.receipt(id));
    if (!receipt) return null;
    const data = receipt.result.audit.details as Record<string, unknown>;
    const prior =
      data.requestFingerprint ??
      (data.preparation as Record<string, unknown> | undefined)
        ?.requestFingerprint;
    if (receipt.actorId !== actor.userId || prior !== fingerprint)
      throw new AmsError(
        409,
        "idempotency_conflict",
        "This operation ID was already used for a different request.",
      );
    return { ...receipt.result, replayed: true };
  }
  async function template(actor: AmsActor, id: string) {
    const record = await deps
      .repository()
      .get(actor.tenantId, "certificatetemplates", id);
    if (!record || record.archivedAt)
      throw new AmsError(
        404,
        "not_found",
        "Template not found in your agency.",
      );
    if (record.data.revokedAt)
      throw new AmsError(
        409,
        "template_revoked",
        "This form edition has been revoked.",
      );
    if (
      !record.data.storageKey.startsWith(
        `ams-documents/${actor.tenantId}/templates/`,
      )
    )
      throw new AmsError(
        409,
        "template_integrity",
        "Invalid template reference.",
      );
    const bytes = await deps.files.get(record.data.storageKey);
    if (
      bytes.length !== record.data.bytes ||
      fileHash(bytes) !== record.data.sha256
    )
      throw new AmsError(
        409,
        "template_integrity",
        "The template bytes no longer match the approved edition.",
      );
    return { record, bytes };
  }
  router.post(
    "/ams/certificate-templates",
    express.raw({ type: "application/octet-stream", limit: "5mb" }),
    handle(async (req, res, actor) => {
      if (!amsCanWrite(actor.role, "certificatetemplates"))
        throw new AmsError(
          403,
          "permission_denied",
          "An administrator or manager must authorize templates.",
        );
      const input = parseAms(
        z
          .object({
            commandId: z.string().uuid(),
            name: z.string().trim().min(1).max(200),
            edition: z.string().trim().min(1).max(200),
            authorization: z.string().trim().min(1).max(200),
            authorized: z.literal("true"),
          })
          .strict(),
        req.query,
      );
      if (!Buffer.isBuffer(req.body))
        throw new AmsError(
          415,
          "binary_required",
          "Upload a fillable PDF as application/octet-stream.",
        );
      const sha256 = fileHash(req.body);
      const requestFingerprint = digest({
        operation: "template",
        ...input,
        sha256,
      });
      const prior = await replay(actor, input.commandId, requestFingerprint);
      if (prior) {
        res.json(prior);
        return;
      }
      const inspected = await processCertificatePdf(req.body);
      const storageKey = `ams-documents/${actor.tenantId}/templates/${input.commandId}/${sha256}`;
      await deps.files.put(storageKey, req.body, "application/pdf");
      const result = await service().registerCertificateTemplate(actor, {
        id: input.commandId,
        action: "create",
        kind: "certificatetemplates",
        reason: "Agency authorization of certificate form edition",
        data: {
          name: input.name,
          edition: input.edition,
          authorization: input.authorization,
          authorizedBy: actor.userId,
          authorizedAt: new Date().toISOString(),
          storageKey,
          sha256,
          bytes: req.body.byteLength,
          fields: inspected.fields,
          requestFingerprint,
        },
      });
      res.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  router.get(
    "/ams/certificate-templates/:id/content",
    handle(async (req, res, actor) => {
      const { bytes } = await template(actor, parseAms(AmsId, req.params.id));
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="certificate-template.pdf"',
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(bytes);
    }),
  );
  router.post(
    "/ams/certificates/:id/prepare",
    handle(async (req, res, actor) => {
      if (!amsCanWrite(actor.role, "certificates"))
        throw new AmsError(
          403,
          "permission_denied",
          "Your role cannot prepare certificates.",
        );
      const certificateId = parseAms(AmsId, req.params.id);
      const input = parseAms(
        z
          .object({
            commandId: z.string().uuid(),
            expectedVersion: z.string().min(1).max(250),
            templateId: AmsId,
            accountVersion: z.string().min(1).max(250),
            policyVersions: z
              .array(
                z
                  .object({ id: AmsId, version: z.string().min(1).max(250) })
                  .strict(),
              )
              .min(1)
              .max(25),
            fields: z
              .record(
                z.string().max(250),
                z.union([z.string().max(4000), z.boolean()]),
              )
              .refine((value) => Object.keys(value).length <= 150),
          })
          .strict(),
        req.body,
      );
      const requestFingerprint = digest({
        operation: "prepare",
        certificateId,
        ...input,
      });
      const prior = await replay(actor, input.commandId, requestFingerprint);
      if (prior) {
        res.json(prior);
        return;
      }
      const repository = deps.repository();
      const certificate = await repository.get(
        actor.tenantId,
        "certificates",
        certificateId,
      );
      if (!certificate || certificate.archivedAt)
        throw new AmsError(404, "not_found", "Certificate not found.");
      if (certificate.version !== input.expectedVersion)
        throw new AmsError(
          409,
          "stale_record",
          "Refresh and review this changed request.",
        );
      if (!["requested", "review"].includes(certificate.data.status))
        throw new AmsError(
          409,
          "certificate_finalized",
          "Create a reissue request for a finalized certificate.",
        );
      const [form, account, policies] = await Promise.all([
        template(actor, input.templateId),
        repository.get(actor.tenantId, "accounts", certificate.data.accountId),
        Promise.all(
          certificate.data.policyIds.map((id) =>
            repository.get(actor.tenantId, "policies", id),
          ),
        ),
      ]);
      if (
        !account ||
        account.archivedAt ||
        policies.some((p) => !p || p.archivedAt)
      )
        throw new AmsError(
          409,
          "sources_unavailable",
          "The account or policy is unavailable. Review this request.",
        );
      if (
        account.version !== input.accountVersion ||
        input.policyVersions.length !== policies.length ||
        policies.some(
          (p) =>
            !input.policyVersions.some(
              (v) => v.id === p!.id && v.version === p!.version,
            ),
        )
      )
        throw new AmsError(
          409,
          "certificate_sources_changed",
          "The account or policy changed while you filled the form. Refresh and prepare again.",
        );
      const rendered = await processCertificatePdf(form.bytes, input.fields);
      const bytes = Buffer.from(rendered.bytes!);
      const sha256 = fileHash(bytes);
      const storageKey = `ams-documents/${actor.tenantId}/${input.commandId}/${sha256}`;
      await deps.files.put(storageKey, bytes, "application/pdf");
      // Separate deterministic ID avoids consuming the preparation command's receipt.
      const uploadId = digest({
        operation: "certificate-pdf",
        commandId: input.commandId,
      }).slice(0, 32);
      const uuid = `${uploadId.slice(0, 8)}-${uploadId.slice(8, 12)}-4${uploadId.slice(13, 16)}-a${uploadId.slice(17, 20)}-${uploadId.slice(20)}`;
      const uploaded = await service().createDocument(actor, {
        id: uuid,
        action: "create",
        kind: "documents",
        reason: "Generated certificate draft",
        data: {
          accountId: account.id,
          name: `certificate-${certificate.id}.pdf`,
          mediaType: "application/pdf",
          bytes: bytes.length,
          sha256,
          storageKey,
          category: "certificate",
          description: `Generated from ${form.record.data.name} (${form.record.data.edition}); requires review before issuance.`,
        },
      });
      const document = uploaded.records.find((r) => r.kind === "documents")!;
      const result = await service().prepareCertificate(actor, {
        id: input.commandId,
        action: "certificate.prepare",
        kind: "certificates",
        recordId: certificate.id,
        expectedVersion: input.expectedVersion,
        reason: "Generate draft for policy review; not issued or sent",
        data: {
          documentId: document.id,
          preparation: {
            formId: form.record.data.name,
            templateId: form.record.id,
            templateSha256: form.record.data.sha256,
            accountVersion: account.version,
            policyVersions: (policies as AmsRecord<"policies">[]).map((p) => ({
              id: p.id,
              version: p.version,
            })),
            fields: input.fields,
            requestFingerprint,
          },
        },
      });
      res.json({
        ...result,
        records: [...uploaded.records, ...result.records],
      } satisfies AmsCommandResult);
    }),
  );
  router.get(
    "/ams/certificates/:id/email-draft",
    handle(async (req, res, actor) => {
      const certificate = await deps
        .repository()
        .get(actor.tenantId, "certificates", parseAms(AmsId, req.params.id));
      if (!certificate || certificate.archivedAt)
        throw new AmsError(404, "not_found", "Certificate not found.");
      if (
        certificate.data.status !== "issued" ||
        !certificate.data.documentId ||
        !certificate.data.holderEmail
      )
        throw new AmsError(
          409,
          "delivery_not_ready",
          "Issue the certificate and set a holder email before preparing an email draft.",
        );
      const document = await deps
        .repository()
        .get(actor.tenantId, "documents", certificate.data.documentId);
      if (
        !document ||
        document.archivedAt ||
        !document.data.storageKey.startsWith(`ams-documents/${actor.tenantId}/`)
      )
        throw new AmsError(404, "not_found", "Certificate PDF unavailable.");
      const bytes = await deps.files.get(document.data.storageKey);
      if (
        fileHash(bytes) !== document.data.sha256 ||
        bytes.length !== document.data.bytes
      )
        throw new AmsError(
          409,
          "document_integrity_failure",
          "The PDF does not match the issued document.",
        );
      const boundary = `openams_${certificate.id}`;
      const base64 = (b: Buffer) =>
        b
          .toString("base64")
          .match(/.{1,76}/g)!
          .join("\r\n");
      const body = [
        `To: ${certificate.data.holderEmail}`,
        `Subject: =?UTF-8?B?${Buffer.from(`Certificate for ${certificate.data.holderName}`).toString("base64")}?=`,
        "X-Unsent: 1",
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        base64(
          Buffer.from(
            "Please find the reviewed certificate attached. Refer to the attached document and policy terms.\n",
          ),
        ),
        `--${boundary}`,
        'Content-Type: application/pdf; name="certificate.pdf"',
        'Content-Disposition: attachment; filename="certificate.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        base64(bytes),
        `--${boundary}--`,
        "",
      ].join("\r\n");
      res.setHeader("Content-Type", "message/rfc822");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="certificate-email-draft.eml"',
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(body);
    }),
  );
}
