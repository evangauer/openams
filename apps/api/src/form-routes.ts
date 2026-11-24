import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  AMS_FORM_UPLOAD_EXTENSIONS,
  AMS_FORM_UPLOAD_MAX_BYTES,
  AmsFormLinkId,
  AmsFormSubmitSchema,
  AmsId,
  amsCanRead,
  amsCanWrite,
  amsFormChosenLines,
  amsFormContact,
  amsFormIssues,
  amsFormSections,
  amsFormSnapshot,
  amsFormVisibleFields,
  amsPublicForm,
  type AmsActor,
  type AmsData,
  type AmsRecord,
} from "@openams/contracts";
import { AmsError } from "./repository.js";
import { fileHash, verifiedFile } from "./files.js";
import { requestLimitOptions, TokenBuckets } from "./firebase/rate-limit.js";
import {
  formSubmissionId,
  formUploadKey,
  newFormLinkId,
  type AmsFormLinks,
} from "./form-links.js";
import { parseAms, type AmsService } from "./service.js";
import type { AmsRouterDependencies } from "./routes.js";

/** Hosted forms. Without this dependency the workspace hides them and no link resolves. */
export interface AmsFormsDependency {
  links: AmsFormLinks;
  /**
   * False where forms can be built and previewed but never opened to the public: an
   * environment anyone can reach without an account must not host public forms.
   */
  publishing?: boolean;
  /** Whether an agency's public forms may be open right now. Default: always. */
  accepting?: (tenantId: string) => Promise<boolean>;
  /**
   * Bytes of client uploads one form may take per UTC day on this process (default
   * 500 MB), so a public form can't be used to fill the agency's storage.
   */
  uploadBytesPerDay?: number;
}
const DAY_MS = 24 * 60 * 60 * 1000;
/** A per-form daily allowance of uploaded bytes, held in this process. */
class UploadAllowance {
  private used = new Map<string, { day: number; bytes: number }>();
  constructor(
    private limit: number,
    private now: () => number = Date.now,
  ) {}
  private entry(formId: string) {
    const day = Math.floor(this.now() / DAY_MS);
    let entry = this.used.get(formId);
    if (!entry || entry.day !== day) {
      entry = { day, bytes: 0 };
      this.used.set(formId, entry);
      if (this.used.size > 10_000) this.used.delete(this.used.keys().next().value!);
    }
    return entry;
  }
  /** Whether the form can take this many more bytes today. */
  has(formId: string, bytes = 1) {
    return this.entry(formId).bytes + bytes <= this.limit;
  }
  add(formId: string, bytes: number) {
    this.entry(formId).bytes += bytes;
  }
}

type Handle = (
  action: (request: Request, response: Response, actor: AmsActor) => Promise<void>,
) => RequestHandler;

/** What an anonymous visitor may be told. Everything else becomes one plain refusal. */
const PUBLIC_ERRORS = new Set([
  "form_not_found",
  "form_closed",
  "form_busy",
  "not_accepted",
  "invalid_answers",
  "invalid_file",
  "unsupported_file",
  "invalid_pdf",
  "invalid_image",
  "invalid_office_file",
  "invalid_file_name",
  "uploads_not_requested",
  "upload_missing",
  "answers_too_long",
]);
const notFound = () =>
  new AmsError(404, "form_not_found", "This form link isn't active.");
const closed = () =>
  new AmsError(409, "form_closed", "This form isn't taking responses right now.");
const busy = () =>
  new AmsError(
    429,
    "form_busy",
    "This form is getting a lot of responses. Wait a minute and try again.",
  );

export function mountFormRoutes(
  router: Router,
  deps: AmsRouterDependencies,
  handle: Handle,
  service: () => AmsService,
) {
  const forms = deps.forms;
  if (!forms) return;
  const publishing = forms.publishing !== false;

  /* ------------------------------------------------------------- the agency */

  // Publishing is the one form change that needs the public link index, so it has its
  // own route; every other form change is an ordinary command.
  router.post(
    "/ams/forms/:id/publish",
    handle(async (request, response, actor) => {
      if (!amsCanWrite(actor.role, "forms"))
        throw new AmsError(
          403,
          "manager_required",
          "An agency administrator or manager publishes forms.",
        );
      if (!publishing)
        throw new AmsError(
          403,
          "publishing_off",
          "Public form links are turned off here. Build and preview the form, then publish it from your own agency.",
        );
      const id = parseAms(AmsId, request.params.id);
      const input = parseAms(
        z
          .object({
            commandId: z.string().uuid(),
            expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
        request.body,
      );
      const form = await deps.repository().get(actor.tenantId, "forms", id);
      if (!form || form.archivedAt)
        throw new AmsError(404, "not_found", "Form not found in your agency.");
      // A form keeps its first link for good, so a paused form reopens where it was.
      const linkId = form.data.linkId ?? newFormLinkId(form.data.name);
      await forms.links.claim(linkId, { tenantId: actor.tenantId, formId: id });
      response.json(
        await service().publishForm(actor, {
          id: input.commandId,
          action: "form.publish",
          kind: "forms",
          recordId: id,
          expectedVersion: input.expectedVersion,
          data: { linkId },
          reason: "",
        }),
      );
    }),
  );
  // A client's upload, before or after the submission is filed to an account.
  router.get(
    "/ams/form-submissions/:id/files/:file",
    handle(async (request, response, actor) => {
      if (!amsCanRead(actor.role, "formsubmissions"))
        throw new AmsError(403, "permission_denied", "Your role cannot read these records.");
      const submission = await deps
        .repository()
        .get(actor.tenantId, "formsubmissions", parseAms(AmsId, request.params.id));
      const file = submission?.data.files.find(
        (item) => item.id === request.params.file,
      );
      if (!submission || submission.archivedAt || !file)
        throw new AmsError(404, "not_found", "File not found.");
      if (
        file.storageKey !==
        formUploadKey(actor.tenantId, submission.id, file.sha256)
      )
        throw new AmsError(
          409,
          "invalid_document_reference",
          "The stored file reference is invalid.",
        );
      const bytes = await deps.files.get(file.storageKey);
      if (fileHash(bytes) !== file.sha256 || bytes.length !== file.bytes)
        throw new AmsError(
          409,
          "document_integrity_failure",
          "The stored file does not match its recorded fingerprint.",
        );
      response.setHeader("Content-Type", file.mediaType);
      response.setHeader("Content-Length", bytes.length);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`,
      );
      response.send(bytes);
    }),
  );

  /* ------------------------------------------------------------- the public */

  // No session and no agency in the request: the link decides everything. Limits are per
  // client where the deployment says who the client is (see admissionKey), and per form
  // in this process, so one busy or abused form cannot flood an agency's records.
  const submissionsPerForm = new TokenBuckets({ capacity: 40, refillPerSecond: 1 / 120 });
  const uploadsPerForm = new TokenBuckets({ capacity: 60, refillPerSecond: 1 / 60 });
  const uploadAllowance = new UploadAllowance(
    forms.uploadBytesPerDay ?? 500 * 1024 * 1024,
  );
  const open: RequestHandler = (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  };
  const publicHandle =
    (action: (request: Request, response: Response) => Promise<void>): RequestHandler =>
    async (request, response) => {
      try {
        await action(request, response);
      } catch (error) {
        if (error instanceof AmsError && PUBLIC_ERRORS.has(error.code)) {
          response.status(error.status).json({
            error: error.code,
            message: error.message,
            ...((error as AmsError & { extra?: object }).extra ?? {}),
          });
          return;
        }
        if (!(error instanceof AmsError))
          console.error(
            `Public form request failed: ${error instanceof Error ? error.name : typeof error}`,
          );
        // Storage limits, record conflicts and the like are the agency's business.
        response.status(503).json({
          error: "form_unavailable",
          message:
            "This form couldn't save your response just now. Try again in a minute, or contact the agency directly.",
        });
      }
    };
  /** The form behind a link, whether or not it is open. Null: the link leads nowhere. */
  async function linked(link: unknown) {
    const linkId = AmsFormLinkId.safeParse(link);
    if (!linkId.success) return null;
    const target = await forms!.links.resolve(linkId.data);
    if (!target || !(await deps.enabled(target.tenantId))) return null;
    const form = await deps.repository().get(target.tenantId, "forms", target.formId);
    if (!form || form.archivedAt || form.data.linkId !== linkId.data) return null;
    const accepting =
      publishing &&
      form.data.status === "published" &&
      ((await forms!.accepting?.(target.tenantId)) ?? true);
    return { tenantId: target.tenantId, form, accepting };
  }
  async function openForm(link: unknown) {
    const found = await linked(link);
    if (!found) throw notFound();
    if (!found.accepting) throw closed();
    return found;
  }
  const hasUploads = (form: AmsRecord<"forms">) =>
    form.data.sections.some((section) =>
      section.fields.some((field) => field.type === "file"),
    );

  router.get(
    "/public/forms/:link",
    open,
    rateLimit(requestLimitOptions(300)),
    publicHandle(async (request, response) => {
      const found = await linked(request.params.link);
      if (!found) throw notFound();
      const { form } = found;
      // A paused form still says whose it is, so the client knows who to call.
      response.json(
        found.accepting
          ? { status: "open", form: amsPublicForm(form.data, form.revision) }
          : {
              status: "closed",
              title: form.data.title,
              branding: form.data.branding,
            },
      );
    }),
  );
  // The web app asks this before it reads an upload's bytes, so a refused upload costs
  // nothing. It charges the upload's limits; the upload itself is not charged again.
  router.post(
    "/public/forms/:link/upload-check",
    open,
    rateLimit(requestLimitOptions(40)),
    publicHandle(async (request, response) => {
      const { form } = await openForm(request.params.link);
      if (!hasUploads(form))
        throw new AmsError(
          422,
          "uploads_not_requested",
          "This form doesn't take file uploads.",
        );
      if (!uploadAllowance.has(form.id) || !uploadsPerForm.take(form.id)) throw busy();
      response.json({ ok: true });
    }),
  );
  router.post(
    "/public/forms/:link/files",
    open,
    rateLimit(requestLimitOptions(80)),
    express.raw({ type: "application/octet-stream", limit: AMS_FORM_UPLOAD_MAX_BYTES }),
    publicHandle(async (request, response) => {
      const client = z.string().uuid().safeParse(request.query.submission);
      if (!client.success || !Buffer.isBuffer(request.body))
        throw new AmsError(400, "invalid_file", "This file couldn't be read. Try attaching it again.");
      const { tenantId, form } = await openForm(request.params.link);
      if (!hasUploads(form))
        throw new AmsError(
          422,
          "uploads_not_requested",
          "This form doesn't take file uploads.",
        );
      let filename: string;
      try {
        filename = decodeURIComponent(request.header("x-file-name") ?? "");
      } catch {
        throw new AmsError(400, "invalid_file_name", "This file's name couldn't be read. Rename it and try again.");
      }
      const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
      if (!(AMS_FORM_UPLOAD_EXTENSIONS as readonly string[]).includes(extension))
        throw new AmsError(
          415,
          "unsupported_file",
          "Attach a PDF, a photo (JPG or PNG), a Word or Excel file, or a CSV.",
        );
      const metadata = verifiedFile(filename, request.body);
      if (!uploadAllowance.has(form.id, request.body.length)) throw busy();
      await deps.files.put(
        formUploadKey(tenantId, formSubmissionId(form.id, client.data), metadata.sha256),
        request.body,
        metadata.mediaType,
      );
      uploadAllowance.add(form.id, request.body.length);
      response.status(201).json({
        name: metadata.name,
        mediaType: metadata.mediaType,
        bytes: request.body.length,
        sha256: metadata.sha256,
      });
    }),
  );
  router.post(
    "/public/forms/:link/submissions",
    open,
    rateLimit(requestLimitOptions(20)),
    publicHandle(async (request, response) => {
      const parsed = AmsFormSubmitSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AmsError(
          400,
          "not_accepted",
          "This response couldn't be read. Reload the page and try again.",
        );
      const input = parsed.data;
      // A filled hidden field or an instant submit is a script, not a person.
      if (input.confirm || input.elapsedMs < 2000)
        throw new AmsError(
          422,
          "not_accepted",
          "This response couldn't be accepted. Reload the page and try again.",
        );
      for (let attempt = 0; ; attempt++) {
        const { tenantId, form } = await openForm(request.params.link);
        const submissionId = formSubmissionId(form.id, input.id);
        // One page load is one submission: a retry of a saved one is simply done.
        if (await deps.repository().get(tenantId, "formsubmissions", submissionId)) {
          response.json({ ok: true });
          return;
        }
        const issues = amsFormIssues(form.data, input);
        const sections = amsFormSections(form.data, input.lines);
        // Every file must sit on a file question the client was actually asked.
        for (const file of input.files) {
          const section = sections.find((item) => item.id === file.section);
          const item = input.answers[file.section]?.[file.item] ?? {};
          if (
            !section ||
            (file.item > 0 && !section.repeat) ||
            !amsFormVisibleFields(section, item).some(
              (field) => field.id === file.field && field.type === "file",
            )
          )
            issues.push({
              section: file.section,
              item: file.item,
              field: file.field,
              message: "Remove this file and attach it again.",
            });
        }
        if (issues.length)
          throw Object.assign(
            new AmsError(
              422,
              "invalid_answers",
              input.revision === form.revision
                ? "Some answers need another look."
                : "This form was updated while you were filling it in. Check the highlighted questions.",
            ),
            {
              extra: {
                issues,
                // The page redraws with the current questions and keeps the answers.
                ...(input.revision === form.revision
                  ? {}
                  : { form: amsPublicForm(form.data, form.revision) }),
              },
            },
          );
        if (!submissionsPerForm.take(form.id)) throw busy();
        const files: AmsData<"formsubmissions">["files"] = [];
        for (const upload of input.files) {
          if (
            files.some(
              (file) =>
                file.sha256 === upload.sha256 &&
                file.section === upload.section &&
                file.item === upload.item &&
                file.field === upload.field,
            )
          )
            continue;
          const storageKey = formUploadKey(tenantId, submissionId, upload.sha256);
          // Read back what was stored: the record never lists a file that isn't there.
          const bytes = await deps.files.get(storageKey).catch(() => null);
          if (!bytes || bytes.length !== upload.bytes || fileHash(bytes) !== upload.sha256)
            throw new AmsError(
              422,
              "upload_missing",
              `"${upload.name.slice(0, 80)}" didn't finish uploading. Remove it and attach it again.`,
            );
          const metadata = verifiedFile(upload.name, bytes);
          const field = sections
            .find((section) => section.id === upload.section)!
            .fields.find((item) => item.id === upload.field)!;
          files.push({
            id: `f${files.length + 1}`,
            section: upload.section,
            item: upload.item,
            field: upload.field,
            label: field.label,
            name: metadata.name,
            mediaType: metadata.mediaType,
            bytes: bytes.length,
            sha256: metadata.sha256,
            storageKey,
            documentId: null,
          });
        }
        try {
          const result = await service().receiveFormSubmission(tenantId, form, {
            submissionId,
            lines: amsFormChosenLines(form.data, input.lines),
            contact: amsFormContact(input.answers),
            sections: amsFormSnapshot(form.data, input),
            files,
          });
          response.status(result.replayed ? 200 : 201).json({ ok: true });
          return;
        } catch (error) {
          // The form was edited between the check and the save: check again, once.
          if (error instanceof AmsError && error.code === "stale_record" && attempt < 1)
            continue;
          if (error instanceof AmsError && error.code === "record_too_large")
            throw new AmsError(
              413,
              "answers_too_long",
              "Your answers are longer than this form can save. Shorten the longest ones, or send the details as a file.",
            );
          throw error;
        }
      }
    }),
  );
}
