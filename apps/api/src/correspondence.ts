import { simpleParser } from "mailparser";
import { z } from "zod";
import {
  AmsId,
  amsCanWrite,
  type AmsActor,
  type AmsData,
} from "@openams/contracts";
import {
  accountScope,
  AmsError,
  digest,
  type AmsRepository,
} from "./repository.js";
import { verifiedFile, type AmsFiles } from "./files.js";
import type { AmsService } from "./service.js";
import { emailPreview } from "./email-preview.js";

export const EmailFilingInput = z
  .object({
    commandId: z.string().uuid(),
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
    policyId: AmsId.nullable().default(null),
    direction: z.enum(["inbound", "outbound", "unknown"]).default("unknown"),
    shareWithAgency: z.literal(true),
  })
  .strict();
export type EmailFiling = z.infer<typeof EmailFilingInput>;
export async function fileOriginalEmail(input: {
  actor: AmsActor;
  accountId: string;
  filing: EmailFiling;
  bytes: Buffer;
  filename: string;
  repository: AmsRepository;
  files: AmsFiles;
  service: AmsService;
  source?:
    | {
        leadId: string;
        messageId: string;
        direction: "inbound" | "outbound";
      }
    | {
        provider: "gmail" | "microsoft365";
        connectionId: string;
        messageId: string;
        direction: "inbound" | "outbound" | "unknown";
      };
}) {
  const { actor, accountId, repository, filing } = input;
  if (!amsCanWrite(actor.role, "correspondence"))
    throw new AmsError(
      403,
      "permission_denied",
      "Your role cannot file correspondence.",
    );
  EmailFilingInput.parse(filing);
  const account = await repository.get(actor.tenantId, "accounts", accountId);
  if (!account || account.archivedAt || account.data.consolidation)
    throw new AmsError(
      409,
      "account_unavailable",
      "Select an active primary account for filing.",
    );
  const scope = await accountScope(repository, actor.tenantId, accountId);
  if (filing.policyId) {
    const policy = await repository.get(
      actor.tenantId,
      "policies",
      filing.policyId,
    );
    if (!policy || policy.archivedAt || !scope.includes(policy.data.accountId))
      throw new AmsError(
        422,
        "account_mismatch",
        "Select a policy from this account.",
      );
  }
  const original = verifiedFile(input.filename, input.bytes);
  if (original.mediaType !== "message/rfc822")
    throw new AmsError(
      415,
      "email_required",
      "Choose the original .eml email file.",
    );
  const header = input.bytes
    .subarray(0, 64 * 1024)
    .toString("utf8")
    .split(/\r?\n\r?\n/, 1)[0]!;
  if (!/^(from|to|subject|message-id):/im.test(header))
    throw new AmsError(
      422,
      "invalid_email",
      "This file does not contain email headers.",
    );
  const mail = await simpleParser(input.bytes, {
    skipHtmlToText: false,
    skipTextToHtml: true,
    skipImageLinks: true,
    maxHtmlLengthToParse: 2_000_000,
  });
  if (mail.attachments.length > 30)
    throw new AmsError(
      413,
      "too_many_attachments",
      "Email filing supports up to 30 attachments. Keep the original as a document for larger messages.",
    );
  const artifacts: Array<{
    metadata: ReturnType<typeof verifiedFile>;
    bytes: Buffer;
  }> = [{ metadata: original, bytes: input.bytes }];
  const unextractedAttachments: string[] = [];
  for (const [index, attachment] of mail.attachments.entries()) {
    const filename = (attachment.filename || `attachment-${index + 1}`).slice(
      0,
      200,
    );
    try {
      artifacts.push({
        metadata: verifiedFile(filename, attachment.content),
        bytes: attachment.content,
      });
    } catch (error) {
      if (!(error instanceof AmsError)) throw error;
      // Unsupported or invalid standalone attachments remain intact in the original email.
      unextractedAttachments.push(filename);
    }
  }
  const documents: Array<{ id: string; data: AmsData<"documents"> }> = [];
  for (const [index, artifact] of artifacts.entries()) {
    const id = `email_${digest({ commandId: filing.commandId, index }).slice(0, 48)}`;
    const storageKey = `ams-documents/${actor.tenantId}/${filing.commandId}/${artifact.metadata.sha256}`;
    await input.files.put(
      storageKey,
      artifact.bytes,
      artifact.metadata.mediaType,
    );
    documents.push({
      id,
      data: {
        ...artifact.metadata,
        accountId,
        policyId: filing.policyId,
        storageKey,
        bytes: artifact.bytes.length,
        category: "correspondence",
        supersedesId: null,
        description:
          index === 0
            ? "Original email, including all MIME attachments."
            : `Attachment from ${original.name}`,
      },
    });
  }
  const addresses = (value: typeof mail.to) =>
    Array.isArray(value)
      ? value.map((a) => a.text).join(", ")
      : value?.text || "";
  // Provider/header timestamps stay source facts. Missing dates are never invented.
  const messageAt =
    mail.date && Number.isFinite(mail.date.getTime())
      ? mail.date.toISOString()
      : null;
  const message = {
    accountId,
    policyId: filing.policyId,
    subject: (mail.subject || "(No subject)").slice(0, 500),
    from: (mail.from?.text || "").slice(0, 2000),
    to: addresses(mail.to).slice(0, 4000),
    cc: addresses(mail.cc).slice(0, 4000),
    direction: input.source?.direction ?? filing.direction,
    messageAt,
    messageId: (mail.messageId || "").slice(0, 1000),
    ...emailPreview(mail),
    source: input.source
      ? "provider" in input.source
        ? input.source.provider
        : "relay_mailbox"
      : "eml_upload",
    sourceLeadId:
      input.source && "leadId" in input.source ? input.source.leadId : null,
    sourceMessageId: input.source?.messageId ?? null,
    sourceConnectionId:
      input.source && "connectionId" in input.source
        ? input.source.connectionId
        : null,
    sha256: original.sha256,
    originalDocumentId: documents[0]!.id,
    documentIds: documents.map((d) => d.id),
    attachmentCount: mail.attachments.length,
    unextractedAttachments,
  };
  return input.service.fileCorrespondence(actor, {
    id: filing.commandId,
    action: "correspondence.file",
    kind: "accounts",
    recordId: accountId,
    expectedVersion: filing.expectedVersion,
    reason:
      "Explicitly filed the original email and attachments into the shared agency account.",
    data: { message, documents, shareWithAgency: true },
  });
}
