import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  AMS_FORM_UPLOAD_EXTENSIONS,
  AMS_FORM_UPLOAD_MAX_BYTES,
  AmsFormHandle,
  AmsFormLinkId,
  AmsFormSubmitSchema,
  AmsId,
  amsCanRead,
  amsCanWrite,
  amsFormChosenLines,
  amsFormContact,
  amsFormHandleError,
  amsFormIssues,
  amsFormPath,
  amsFormSections,
  amsFormSlug,
  amsFormSnapshot,
  amsPublicForm,
  type AmsActor,
  type AmsData,
  type AmsPublicAgencyForms,
  type AmsRecord,
} from "@openams/contracts";
import { AmsError, digest } from "./repository.js";
import { fileHash, verifiedFile, type AmsFiles } from "./files.js";
import {
  admissionKey,
  requestLimitOptions,
  TokenBuckets,
} from "./firebase/rate-limit.js";
import {
  formPendingKey,
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
   * Where a file waits between being attached and the client pressing Send, under
   * `form-uploads/<agency>/…`. It must support `remove`, and whatever is left there
   * (a client who never sent the form) should expire on its own. Nothing in it counts
   * toward an agency's storage; a file is copied to the agency's documents only when
   * its submission is saved.
   */
  pending: AmsFiles;
  /**
   * Bytes of client uploads one form may take per UTC day on this process (default
   * 500 MB), which bounds what can pile up in `pending` before it expires.
   */
  uploadBytesPerDay?: number;
  /**
   * How many submissions and uploads one form may save in a burst on this process
   * before the steady rate applies (defaults: 40 and 60).
   */
  burst?: { submissions?: number; uploads?: number };
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
  "form_updated",
  "already_received",
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

const publishingOff = () =>
  new AmsError(
    403,
    "publishing_off",
    "Public form links are turned off here. Build and preview the form, then publish it from your own agency.",
  );
/** A forms address to offer an agency, from its name. Always one it could be given. */
function suggestedHandle(name: string) {
  const slug = amsFormSlug(name);
  const candidates = [
    slug,
    `${slug.slice(0, 33).replace(/-+$/, "")}-agency`,
    "agency-forms",
  ];
  return candidates.find((candidate) => !amsFormHandleError(candidate))!;
}

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
      if (!publishing) throw publishingOff();
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
  /** An agency's forms, up to a few hundred: more than an agency keeps. */
  async function agencyForms(tenantId: string, status?: string) {
    const found: AmsRecord<"forms">[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await deps.repository().list(tenantId, "forms", {
        limit: 100,
        includeArchived: "false",
        ...(status ? { status } : {}),
        ...(cursor ? { cursor } : {}),
      });
      found.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return found;
  }
  // The agency's forms address: /f/<handle> lists its live forms. The agency chooses it
  // itself, once; nobody else can read or set it.
  router.get(
    "/ams/forms/address",
    handle(async (_request, response, actor) => {
      const [current, setup, workspaceName] = await Promise.all([
        forms.links.handleOf(actor.tenantId),
        deps.repository().get(actor.tenantId, "workspace", "agency"),
        deps.workspaceName(actor.tenantId).catch(() => ""),
      ]);
      let name = (setup?.data.name ?? workspaceName ?? "").trim();
      if (!name) {
        const latest = (await agencyForms(actor.tenantId)).sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        )[0];
        name = latest?.data.branding.agencyName ?? "";
      }
      response.setHeader("Cache-Control", "no-store");
      response.json({ handle: current, suggestion: suggestedHandle(name), publishing });
    }),
  );
  router.post(
    "/ams/forms/address",
    handle(async (request, response, actor) => {
      if (!amsCanWrite(actor.role, "forms"))
        throw new AmsError(
          403,
          "manager_required",
          "An agency administrator or manager sets the forms address.",
        );
      if (!publishing) throw publishingOff();
      const input = z.object({ handle: z.string() }).strict().safeParse(request.body);
      const invalid = input.success
        ? amsFormHandleError(input.data.handle)
        : "Use 3 to 40 lowercase letters, numbers and dashes.";
      if (!input.success || invalid) {
        response.status(422).json({ error: "handle_invalid", message: invalid });
        return;
      }
      const wanted = input.data.handle;
      try {
        await forms.links.claimHandle(wanted, actor.tenantId);
      } catch (error) {
        if (!(error instanceof AmsError) || error.code !== "handle_set") throw error;
        // Set once: say which address the agency has.
        response.status(409).json({
          error: error.code,
          message: error.message,
          handle: await forms.links.handleOf(actor.tenantId),
        });
        return;
      }
      response.json({ handle: wanted });
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
  // client where the deployment says who the client is. Where it doesn't, they are per
  // link, so traffic to one form (or to links that lead nowhere) never closes another
  // agency's forms. Per form, in this process, a limit on what is actually saved keeps a
  // busy or abused form from flooding an agency's records.
  const perClient = (limit: number) =>
    rateLimit({
      ...requestLimitOptions(limit),
      keyGenerator: (request) => {
        const key = admissionKey(request);
        return key === "instance"
          ? `form:${String(request.params.link ?? request.params.handle).slice(0, 80)}`
          : key;
      },
    });
  const submissionsPerForm = new TokenBuckets({
    capacity: forms.burst?.submissions ?? 40,
    refillPerSecond: 1 / 120,
  });
  const uploadsPerForm = new TokenBuckets({
    capacity: forms.burst?.uploads ?? 60,
    refillPerSecond: 1 / 60,
  });
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
  /** A client upload's name and type, held to what a public form takes. */
  function uploadMetadata(name: string, bytes: Buffer) {
    const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
    if (!(AMS_FORM_UPLOAD_EXTENSIONS as readonly string[]).includes(extension))
      throw new AmsError(
        415,
        "unsupported_file",
        "Attach a PDF, a photo (JPG or PNG), a Word or Excel file, or a CSV.",
      );
    return verifiedFile(name, bytes);
  }
  const pageUpload = (request: Request) => {
    const client = z.string().uuid().safeParse(request.query.submission);
    if (!client.success)
      throw new AmsError(400, "invalid_file", "This file couldn't be read. Try attaching it again.");
    return client.data;
  };

  router.get(
    "/public/forms/:link",
    open,
    perClient(300),
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
  // An agency's forms address: who the agency is and its live forms. An address that was
  // never claimed, an agency that isn't taking submissions and an agency with nothing
  // live all read the same, so the answer says nothing about who has an address.
  router.get(
    "/public/agencies/:handle",
    open,
    perClient(300),
    publicHandle(async (request, response) => {
      const missing = () => {
        response.status(404).json({ error: "not_found" });
      };
      const address = AmsFormHandle.safeParse(request.params.handle);
      if (!address.success || !publishing) return missing();
      const tenantId = await forms.links.resolveHandle(address.data);
      if (
        !tenantId ||
        !(await deps.enabled(tenantId)) ||
        !((await forms.accepting?.(tenantId)) ?? true)
      )
        return missing();
      const live = (await agencyForms(tenantId, "published"))
        .filter(
          (form) =>
            !form.archivedAt && form.data.status === "published" && form.data.linkId,
        )
        .sort(
          (a, b) =>
            (b.data.publishedAt ?? "").localeCompare(a.data.publishedAt ?? "") ||
            b.updatedAt.localeCompare(a.updatedAt),
        );
      if (!live.length) return missing();
      const { branding } = live[0]!.data;
      const body: AmsPublicAgencyForms = {
        handle: address.data,
        name: branding.agencyName,
        phone: branding.phone,
        email: branding.email,
        accent: branding.accent,
        logo: branding.logo,
        forms: live.map((form) => ({
          linkId: form.data.linkId!,
          path: amsFormPath(form.data.linkId!),
          title: form.data.title,
          intro: form.data.intro,
          lines: form.data.lines,
        })),
      };
      response.json(body);
    }),
  );
  // The web app asks this before it reads an upload's bytes, so an upload that would be
  // refused costs nothing. It spends nothing itself: only a stored file counts.
  router.post(
    "/public/forms/:link/upload-check",
    open,
    perClient(40),
    publicHandle(async (request, response) => {
      const { form } = await openForm(request.params.link);
      if (!hasUploads(form))
        throw new AmsError(
          422,
          "uploads_not_requested",
          "This form doesn't take file uploads.",
        );
      if (!uploadAllowance.has(form.id)) throw busy();
      response.json({ ok: true });
    }),
  );
  router.post(
    "/public/forms/:link/files",
    open,
    perClient(80),
    express.raw({ type: "application/octet-stream", limit: AMS_FORM_UPLOAD_MAX_BYTES }),
    publicHandle(async (request, response) => {
      const client = pageUpload(request);
      if (!Buffer.isBuffer(request.body))
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
      const metadata = uploadMetadata(filename, request.body);
      if (
        !uploadAllowance.has(form.id, request.body.length) ||
        !uploadsPerForm.take(form.id)
      )
        throw busy();
      // Held apart from the agency's documents until the client sends the form.
      await forms.pending.put(
        formPendingKey(tenantId, formSubmissionId(form.id, client), metadata.sha256),
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
  // "Remove" on the client's page: the file a client took back is deleted, not kept.
  router.post(
    "/public/forms/:link/files/remove",
    open,
    perClient(80),
    publicHandle(async (request, response) => {
      const client = pageUpload(request);
      const sha256 = z
        .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .safeParse(request.body);
      if (!sha256.success)
        throw new AmsError(400, "invalid_file", "This file couldn't be removed. Reload the page and try again.");
      const found = await linked(request.params.link);
      if (!found) throw notFound();
      await forms.pending.remove?.(
        formPendingKey(found.tenantId, formSubmissionId(found.form.id, client), sha256.data.sha256),
      );
      response.json({ ok: true });
    }),
  );
  router.post(
    "/public/forms/:link/submissions",
    open,
    perClient(20),
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
      // What the client sent, whatever order it arrived in.
      const sent = digest({
        lines: [...input.lines].sort(),
        answers: input.answers,
        files: input.files
          .map((file) => `${file.section}/${file.item}/${file.field}/${file.sha256}`)
          .sort(),
      });
      for (let attempt = 0; ; attempt++) {
        const found = await linked(request.params.link);
        if (!found) throw notFound();
        const { tenantId, form } = found;
        const submissionId = formSubmissionId(form.id, input.id);
        // One page load is one submission. This comes before anything else, so a client
        // whose first send was saved is told so even if the form has closed since.
        const saved = await deps
          .repository()
          .get(tenantId, "formsubmissions", submissionId);
        if (saved) {
          if (saved.data.digest === sent) {
            response.json({ ok: true });
            return;
          }
          throw new AmsError(
            409,
            "already_received",
            "We already have the answers from the first time you pressed Send. Changes made after that were not saved.",
          );
        }
        if (!found.accepting) throw closed();
        // A client answers the questions on their screen. If the agency has changed the
        // form since, they see the current questions and send again; an answer is never
        // filed under wording the client didn't read.
        if (input.revision !== form.revision)
          throw Object.assign(
            new AmsError(
              409,
              "form_updated",
              "This form was updated while you were filling it in. Look over your answers and send again.",
            ),
            {
              extra: {
                issues: amsFormIssues(form.data, input),
                form: amsPublicForm(form.data, form.revision),
              },
            },
          );
        const issues = amsFormIssues(form.data, input);
        if (issues.length)
          throw Object.assign(
            new AmsError(422, "invalid_answers", "Some answers need another look."),
            { extra: { issues } },
          );
        const sections = amsFormSections(form.data, input.lines);
        const uploads = input.files.filter(
          (upload, index, all) =>
            all.findIndex(
              (other) =>
                other.sha256 === upload.sha256 &&
                other.section === upload.section &&
                other.item === upload.item &&
                other.field === upload.field,
            ) === index,
        );
        // Read back what was stored: the record never lists a file that isn't there.
        const checked: { upload: (typeof uploads)[number]; bytes: Buffer; name: string; mediaType: string }[] = [];
        for (const upload of uploads) {
          const bytes = await forms.pending
            .get(formPendingKey(tenantId, submissionId, upload.sha256))
            .catch(() => null);
          if (!bytes || bytes.length !== upload.bytes || fileHash(bytes) !== upload.sha256)
            throw new AmsError(
              422,
              "upload_missing",
              `"${upload.name.slice(0, 80)}" didn't finish uploading. Remove it and attach it again.`,
            );
          const metadata = uploadMetadata(upload.name, bytes);
          checked.push({ upload, bytes, name: metadata.name, mediaType: metadata.mediaType });
        }
        // Only a submission that is about to be saved spends the form's allowance.
        if (!submissionsPerForm.take(form.id)) throw busy();
        const files: AmsData<"formsubmissions">["files"] = [];
        for (const { upload, bytes, name, mediaType } of checked) {
          const storageKey = formUploadKey(tenantId, submissionId, upload.sha256);
          // Now it joins the agency's documents (and counts toward its storage).
          await deps.files.put(storageKey, bytes, mediaType);
          files.push({
            id: `f${files.length + 1}`,
            section: upload.section,
            item: upload.item,
            field: upload.field,
            label: sections
              .find((section) => section.id === upload.section)!
              .fields.find((item) => item.id === upload.field)!.label,
            name,
            mediaType,
            bytes: bytes.length,
            sha256: upload.sha256,
            storageKey,
            documentId: null,
          });
        }
        try {
          const snapshot = amsFormSnapshot(form.data, input);
          const result = await service().receiveFormSubmission(tenantId, form, {
            submissionId,
            lines: amsFormChosenLines(form.data, input.lines),
            contact: amsFormContact(snapshot),
            sections: snapshot,
            files,
            digest: sent,
          });
          // The waiting copies have done their job. One left behind expires on its own.
          for (const { upload } of checked)
            await forms.pending
              .remove?.(formPendingKey(tenantId, submissionId, upload.sha256))
              .catch(() => undefined);
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
