"use client";
// A hosted form as a client fills it in: a welcome, one section per step, a review and
// a confirmation. The same component is the builder's live preview, where nothing is
// uploaded or sent.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  Loader2,
  Lock,
  Mail,
  Pencil,
  Phone,
  Plus,
  Trash2,
} from "lucide-react";
import { LineIcon } from "./line-icons";
import {
  AMS_FORM_CONTACT_SECTION,
  AMS_FORM_UPLOAD_EXTENSIONS,
  AMS_FORM_UPLOAD_MAX_BYTES,
  AMS_FORM_UPLOAD_MAX_FILES,
  AMS_FORM_UPLOADS_PER_FIELD,
  amsFormIssues,
  amsFormItemCount,
  amsFormSections,
  amsFormSnapshot,
  amsFormStored,
  amsFormValueText,
  amsFormVisibleFields,
  type AmsFormAnswers,
  type AmsFormIssue,
  type AmsFormSection,
  type AmsFormValue,
  type AmsPublicForm,
} from "@openams/contracts";
import { revealInFrame, useEmbedFrame } from "./embed-frame";
import { inkOn } from "./form-color";
import { FormQuestion, fileSize, type RunnerUpload } from "./form-inputs";
import "./form-runner.css";

const issueKey = (issue: Pick<AmsFormIssue, "section" | "item" | "field">) =>
  `${issue.section}.${issue.item}.${issue.field}`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

interface Draft {
  id: string;
  /** The form revision these answers were given to. */
  revision: number;
  openedAt: number;
  started: boolean;
  step: number;
  lines: string[];
  answers: AmsFormAnswers;
  uploads: RunnerUpload[];
}
const newDraft = (form: AmsPublicForm): Draft => ({
  id: crypto.randomUUID(),
  revision: form.revision,
  openedAt: Date.now(),
  started: false,
  step: 0,
  lines: form.lines.length === 1 ? [form.lines[0].id] : [],
  answers: {},
  uploads: [],
});
function readDraft(form: AmsPublicForm, storageKey: string | null): Draft {
  if (storageKey)
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null") as Draft | null;
      if (saved && typeof saved.id === "string" && saved.answers) {
        const restored = {
          ...newDraft(form),
          ...saved,
          uploads: (saved.uploads || []).filter((upload) => upload.status === "done"),
        };
        // The agency changed the form since: keep the answers, but walk the client
        // through the questions as they are now.
        return saved.revision === form.revision
          ? restored
          : { ...restored, revision: form.revision, started: false, step: 0 };
      }
    } catch {
      // A private window without storage: the form still works, it just can't resume.
    }
  return newDraft(form);
}

export function FormRunner({
  form: initialForm,
  preview = false,
  embed = false,
  focus,
}: {
  form: AmsPublicForm;
  /** The builder's preview: nothing is uploaded, saved or sent. */
  preview?: boolean;
  /** Preview only: the section to show, or "@welcome". The builder follows what is being edited. */
  focus?: string;
  /** Inside another site's frame: no page chrome, and the frame is told its height. */
  embed?: boolean;
}) {
  const [liveForm, setLiveForm] = useState(initialForm);
  // In the builder the form changes under the preview; on the public page it changes
  // only when the server says the agency edited it mid-visit.
  const form = preview ? initialForm : liveForm;
  const storageKey = preview ? null : `openams.form.${form.linkId}`;
  const [draft, setDraft] = useState<Draft>(() => newDraft(initialForm));
  const [ready, setReady] = useState(preview);
  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState("");
  const [serverIssues, setServerIssues] = useState<AmsFormIssue[]>([]);
  const [done, setDone] = useState(false);
  /** The first send was saved; a later one with other answers was not. */
  const [keptFirst, setKeptFirst] = useState(false);
  const [closed, setClosed] = useState(false);
  const [trap, setTrap] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // Resume after a refresh. Read after mount so server and first client render agree.
  useEffect(() => {
    if (preview) return;
    setDraft(readDraft(initialForm, `openams.form.${initialForm.linkId}`));
    setReady(true);
  }, [preview, initialForm]);
  useEffect(() => {
    if (!storageKey || !ready || done) return;
    const timer = window.setTimeout(() => {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(draft));
      } catch {
        // Storage is full or off; the answers stay on the page.
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, storageKey, ready, done]);
  // An embedding page sizes its frame to the form.
  useEmbedFrame(root, embed);

  // The builder's preview shows the section being edited, choosing every line so no
  // section is hidden behind a choice.
  useEffect(() => {
    if (!preview || !focus) return;
    setDone(false);
    setDraft((previous) => {
      if (focus === "@welcome") return previous.started ? { ...previous, started: false } : previous;
      const lines = initialForm.lines.map((line) => line.id);
      const index = amsFormSections(initialForm, lines).findIndex((item) => item.id === focus);
      if (index === -1) return previous;
      return { ...previous, started: true, lines, step: index };
    });
    // The form itself changes on every keystroke; only a new focus moves the preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, focus]);

  const sections = useMemo(() => amsFormSections(form, draft.lines), [form, draft.lines]);
  const step = Math.min(draft.step, sections.length);
  const reviewing = step === sections.length;
  const section: AmsFormSection | undefined = sections[step];
  const input = useMemo(
    () => ({
      lines: draft.lines,
      answers: draft.answers,
      files: draft.uploads.filter((upload) => upload.status === "done"),
    }),
    [draft],
  );
  const issues = useMemo(() => amsFormIssues(form, input), [form, input]);
  const errors = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of [...serverIssues, ...issues]) map.set(issueKey(issue), issue.message);
    return map;
  }, [issues, serverIssues]);
  const questionCount = sections.reduce(
    (total, item) => total + item.fields.filter((field) => !field.showIf).length,
    0,
  );
  const minutes = Math.max(2, Math.round(questionCount / 6));
  // Named documents only: a catch-all upload question is nothing to go and find.
  const documents = [
    ...new Set(
      sections
        .filter((item) => item.lines.length > 0)
        .flatMap((item) =>
          item.fields.filter((field) => field.type === "file").map((field) => field.label),
        ),
    ),
  ];

  /**
   * Starts what was just rendered at its top: the heading takes focus, and the page
   * scrolls there. A framing page that already shows the top of the form is left where
   * it is, so a visitor's own page doesn't jump on every step.
   */
  const toTop = useCallback(() => {
    window.requestAnimationFrame(() => {
      const form = root.current;
      heading.current?.focus({ preventScroll: true });
      if (!form) return;
      // The builder's preview scrolls its own screen, never the workspace around it.
      if (preview) form.parentElement?.scrollTo({ top: 0, behavior: "instant" });
      else if (embed) void revealInFrame(form, { mark: form.firstElementChild ?? form });
      else form.scrollIntoView({ block: "start", behavior: "instant" });
    });
  }, [embed, preview]);
  const move = useCallback(
    (next: Partial<Draft>) => {
      setAttempted(false);
      setFailure("");
      setDraft((previous) => ({ ...previous, ...next }));
      toTop();
    },
    [toTop],
  );
  const setAnswer = (sectionId: string, index: number, fieldId: string, value: AmsFormValue) => {
    setServerIssues((previous) =>
      previous.filter(
        (issue) => issueKey(issue) !== `${sectionId}.${index}.${fieldId}`,
      ),
    );
    setDraft((previous) => {
      const items = [...(previous.answers[sectionId] ?? [])];
      while (items.length <= index) items.push({});
      items[index] = { ...items[index], [fieldId]: value };
      return { ...previous, answers: { ...previous.answers, [sectionId]: items } };
    });
  };
  const setItems = (target: AmsFormSection, change: "add" | number) =>
    setDraft((previous) => {
      const count = amsFormItemCount(target, (previous.answers[target.id] ?? []).length);
      const items = Array.from({ length: count }, (_unused, index) => previous.answers[target.id]?.[index] ?? {});
      if (change === "add")
        return { ...previous, answers: { ...previous.answers, [target.id]: [...items, {}] } };
      return {
        ...previous,
        answers: {
          ...previous.answers,
          [target.id]: items.filter((_item, index) => index !== change),
        },
        // Files follow their item: drop the removed item's, and close the gap.
        uploads: previous.uploads
          .filter((upload) => upload.section !== target.id || upload.item !== change)
          .map((upload) =>
            upload.section === target.id && upload.item > change
              ? { ...upload, item: upload.item - 1 }
              : upload,
          ),
      };
    });

  /**
   * Moves focus after a change that leaves it stranded: the button pressed is gone, or
   * what it made is somewhere else. The page is not scrolled; the change happened where
   * the client was already looking.
   */
  const focusOn = (find: (form: HTMLElement) => HTMLElement | null | undefined) =>
    window.requestAnimationFrame(() => {
      const target = root.current && find(root.current);
      if (!target) return;
      // A group of questions takes focus for this moment only; a click inside it later
      // should not land on the group.
      if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) {
        target.tabIndex = -1;
        target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
      }
      target.focus({ preventScroll: true });
    });
  /** Deletes a file the client took back from where it was waiting to be sent. */
  const discard = (sha256: string) =>
    void fetch(`/api/forms/${form.linkId}/files?submission=${draft.id}&sha256=${sha256}`, {
      method: "DELETE",
    }).catch(() => undefined);
  function addItem(target: AmsFormSection) {
    setItems(target, "add");
    focusOn((node) => {
      const all = node.querySelectorAll<HTMLElement>(".hf-item");
      return all[all.length - 1];
    });
  }
  function removeItem(target: AmsFormSection, index: number) {
    // Its files go with it, unless the same file is still attached somewhere else.
    if (!preview) {
      const here = (upload: RunnerUpload) => upload.section === target.id && upload.item === index;
      const kept = new Set(draft.uploads.filter((upload) => !here(upload)).map((upload) => upload.sha256));
      const gone = draft.uploads.filter((upload) => here(upload) && upload.status === "done");
      for (const sha256 of new Set(gone.map((upload) => upload.sha256))) if (!kept.has(sha256)) discard(sha256);
    }
    setItems(target, index);
    // The one that took its place; after the last one, the button that adds another.
    focusOn((node) => {
      const left = node.querySelectorAll<HTMLElement>(".hf-item");
      return left[index] ?? node.querySelector<HTMLElement>(".hf-add") ?? left[left.length - 1];
    });
  }

  // Kept in step with the draft, and added to the moment a file is taken, so files
  // picked on two questions at once still add up to the form's limit.
  const taken = useRef<RunnerUpload[]>([]);
  taken.current = draft.uploads.filter((upload) => upload.status !== "failed");
  async function attach(sectionId: string, index: number, fieldId: string, files: File[]) {
    for (const file of files) {
      const room = Math.min(
        AMS_FORM_UPLOADS_PER_FIELD -
          taken.current.filter(
            (upload) => upload.section === sectionId && upload.item === index && upload.field === fieldId,
          ).length,
        AMS_FORM_UPLOAD_MAX_FILES - taken.current.length,
      );
      const key = crypto.randomUUID();
      const base = { key, section: sectionId, item: index, field: fieldId, name: file.name, bytes: file.size, sha256: "" };
      const refuse = (error: string) =>
        setDraft((previous) => ({
          ...previous,
          uploads: [...previous.uploads.filter((upload) => upload.key !== key), { ...base, status: "failed", error }],
        }));
      const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
      if (room <= 0) {
        refuse(`This form takes up to ${AMS_FORM_UPLOAD_MAX_FILES} files, ${AMS_FORM_UPLOADS_PER_FIELD} per question.`);
        continue;
      }
      if (!(AMS_FORM_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
        refuse("Attach a PDF, a photo (JPG or PNG), a Word or Excel file, or a CSV.");
        continue;
      }
      if (!file.size || file.size > AMS_FORM_UPLOAD_MAX_BYTES) {
        refuse(file.size ? "This file is larger than 10 MB." : "This file is empty.");
        continue;
      }
      taken.current = [...taken.current, { ...base, status: "uploading" }];
      setDraft((previous) => ({ ...previous, uploads: [...previous.uploads, { ...base, status: "uploading" }] }));
      const settle = (change: Partial<RunnerUpload>) =>
        setDraft((previous) => ({
          ...previous,
          uploads: previous.uploads.map((upload) => (upload.key === key ? { ...upload, ...change } : upload)),
        }));
      if (preview) {
        // Shown as attached so the agency sees the step as a client will; nothing is stored.
        window.setTimeout(() => settle({ status: "done", sha256: "0".repeat(64) }), 500);
        continue;
      }
      try {
        const response = await fetch(`/api/forms/${form.linkId}/files?submission=${draft.id}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
          },
          body: file,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) settle({ status: "failed", error: body.message || "This file didn't upload." });
        else settle({ status: "done", name: body.name, bytes: body.bytes, sha256: body.sha256 });
      } catch {
        settle({ status: "failed", error: "This file didn't upload. Check your connection and try again." });
      }
    }
  }
  function removeUpload(key: string) {
    const upload = draft.uploads.find((item) => item.key === key);
    setDraft((previous) => ({
      ...previous,
      uploads: previous.uploads.filter((item) => item.key !== key),
    }));
    // A file the client takes back is deleted from where it was waiting, unless the
    // same file is still attached to another question.
    if (
      preview ||
      upload?.status !== "done" ||
      draft.uploads.some((item) => item.key !== key && item.sha256 === upload.sha256)
    )
      return;
    discard(upload.sha256);
  }

  function focusFirstProblem() {
    window.requestAnimationFrame(() => {
      const control = root.current?.querySelector<HTMLElement>(
        "[data-invalid] input, [data-invalid] select, [data-invalid] textarea, [data-invalid] button",
      );
      if (!control) return;
      // Focus scrolls to the answer, except from a frame in Safari: there the page is asked.
      control.focus();
      if (embed)
        void revealInFrame(control.closest<HTMLElement>("[data-invalid]") ?? control, {
          whole: true,
          above: 16,
          after: true,
        });
    });
  }
  function next() {
    if (!section) return;
    if (draft.uploads.some((upload) => upload.section === section.id && upload.status === "uploading")) {
      setFailure("Your files are still uploading. Give them a moment.");
      return;
    }
    if (!preview && issues.some((issue) => issue.section === section.id)) {
      setAttempted(true);
      focusFirstProblem();
      return;
    }
    move({ step: step + 1 });
  }
  async function send() {
    if (sending) return;
    if (preview) {
      setDone(true);
      return;
    }
    const first = issues[0];
    if (first) {
      const index = sections.findIndex((item) => item.id === first.section);
      move({ step: Math.max(0, index) });
      setAttempted(true);
      return;
    }
    setSending(true);
    setFailure("");
    try {
      const response = await fetch(`/api/forms/${form.linkId}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id,
          revision: form.revision,
          lines: draft.lines,
          answers: draft.answers,
          files: input.files.map(({ section: at, item, field, name, sha256, bytes }) => ({
            section: at,
            item,
            field,
            name,
            sha256,
            bytes,
          })),
          confirm: trap,
          elapsedMs: Date.now() - draft.openedAt,
        }),
      });
      const body = await response.json().catch(() => ({}));
      // Thanked only on the server's word that the answers were saved. "Already
      // received" means an earlier send was saved and this one, with changes, was not.
      if ((response.ok && body.ok === true) || body.error === "already_received") {
        try {
          sessionStorage.removeItem(storageKey!);
        } catch {
          // Nothing to clear.
        }
        setKeptFirst(body.error === "already_received");
        setDone(true);
        toTop();
        return;
      }
      if (body.error === "form_closed") {
        setClosed(true);
        toTop();
        return;
      }
      if (
        (body.error === "invalid_answers" || body.error === "form_updated") &&
        Array.isArray(body.issues)
      ) {
        const reported = body.issues as AmsFormIssue[];
        const current = (body.form as AmsPublicForm | undefined) ?? form;
        if (body.form) setLiveForm(current);
        setServerIssues(reported);
        const shown = amsFormSections(current, draft.lines);
        const at = shown.findIndex((item) => item.id === reported[0]?.section);
        // With nothing to fix, the client looks over the answers under the current
        // wording on the review step, and sends again.
        move({ step: at === -1 ? shown.length : at, revision: current.revision });
        setAttempted(reported.length > 0);
        setFailure(body.message || "Some answers need another look.");
        return;
      }
      setFailure(body.message || "We couldn't save your response. Try again in a minute.");
    } catch {
      setFailure(
        "We couldn't confirm your response was saved. Check your connection and press Send again: sending twice never saves it twice.",
      );
    } finally {
      setSending(false);
    }
  }

  const { branding } = form;
  const style = {
    "--hf-accent": branding.accent,
    "--hf-on-accent": inkOn(branding.accent),
  } as CSSProperties;
  const brand = (
    <div className="hf-brand">
      {branding.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={branding.logo} alt="" />
      ) : (
        <span className="hf-monogram" aria-hidden="true">
          {branding.agencyName.trim().charAt(0).toUpperCase()}
        </span>
      )}
      <strong>{branding.agencyName}</strong>
    </div>
  );
  const contactLinks = (branding.phone || branding.email) && (
    <span className="hf-reach">
      {branding.phone && (
        <a href={`tel:${branding.phone.replace(/[^0-9+]/g, "")}`}>
          <Phone size={14} aria-hidden="true" />
          {/^1?\d{10}$/.test(branding.phone.replace(/\D/g, ""))
            ? amsFormStored("phone", branding.phone)
            : branding.phone}
        </a>
      )}
      {branding.email && (
        <a href={`mailto:${branding.email}`}>
          <Mail size={14} aria-hidden="true" />
          {branding.email}
        </a>
      )}
    </span>
  );
  const shell = (content: React.ReactNode) => (
    <div className="hf" ref={root} style={style} data-embed={embed || undefined} data-preview={preview || undefined}>
      <header className="hf-top">
        {brand}
        {contactLinks}
      </header>
      <main className="hf-main">{content}</main>
      <footer className="hf-foot">
        <span>
          <Lock size={12} aria-hidden="true" />
          Your answers go to {branding.agencyName}. Never enter passwords or card numbers here.
        </span>
        {/* No referrer: the form's own link stays with the client and the agency. */}
        <a href="https://openams.com" target="_blank" rel="noreferrer">
          Powered by OpenAMS
        </a>
      </footer>
    </div>
  );

  if (closed)
    return shell(
      <section className="hf-card hf-done">
        <h1 ref={heading} tabIndex={-1}>
          This form just closed
        </h1>
        <p>
          {branding.agencyName} isn&apos;t taking responses through this form right now. Your
          answers were not sent. Reach the agency directly and they will help you.
        </p>
        {contactLinks}
      </section>,
    );
  if (done)
    return shell(
      <section className="hf-card hf-done" aria-live="polite">
        <span className="hf-done-mark" aria-hidden="true">
          <Check size={30} strokeWidth={2.5} />
        </span>
        <h1 ref={heading} tabIndex={-1}>
          {keptFirst ? "We have your first answers" : form.confirmation.title}
        </h1>
        <p>
          {keptFirst
            ? `${branding.agencyName} received this form the first time you pressed Send. The changes you made after that were not saved, so tell the agency about them directly.`
            : form.confirmation.body}
        </p>
        {preview ? (
          <p className="hf-preview-note">This is the preview. Nothing was sent or saved.</p>
        ) : (
          contactLinks
        )}
        {preview && (
          <button
            type="button"
            className="hf-button quiet"
            onClick={() => {
              setDone(false);
              setDraft(newDraft(form));
            }}
          >
            Run the preview again
          </button>
        )}
      </section>,
    );

  if (!draft.started) {
    const needsLine = form.lines.length > 1 && !draft.lines.length;
    return shell(
      <section className="hf-card hf-welcome">
        <p className="hf-eyebrow">{branding.agencyName}</p>
        <h1 ref={heading} tabIndex={-1}>
          {form.title}
        </h1>
        {form.intro && <p className="hf-intro">{form.intro}</p>}
        {form.lines.length > 1 && (
          <div className="hf-lines">
            <h2 id="hf-lines-label">What can we help you with?</h2>
            <p>Choose everything you&apos;d like a quote for.</p>
            <div role="group" aria-labelledby="hf-lines-label">
              {form.lines.map((line) => {
                const on = draft.lines.includes(line.id);
                return (
                  <button
                    key={line.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() =>
                      setDraft((previous) => ({
                        ...previous,
                        // Kept in the form's order, however they were picked.
                        lines: form.lines
                          .map((item) => item.id)
                          .filter((id) => (id === line.id ? !on : previous.lines.includes(id))),
                      }))
                    }
                  >
                    <span className="hf-line-icon" aria-hidden="true">
                      <LineIcon line={line.id} />
                    </span>
                    <span className="hf-line-label">{line.label}</span>
                    <i aria-hidden="true">{on && <Check size={13} strokeWidth={3} />}</i>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <ul className="hf-facts">
          {!needsLine && (
            <li>
              <Clock size={15} aria-hidden="true" />
              About {minutes} minutes{form.lines.length > 1 ? " for what you chose" : ""}
            </li>
          )}
          {documents.length > 0 && !needsLine && (
            <li>
              <Plus size={15} aria-hidden="true" />
              Handy to have nearby: {documents.slice(0, 3).join(", ").toLowerCase()}
            </li>
          )}
          {!preview && (
            <li>
              <Check size={15} aria-hidden="true" />
              Your answers stay on this device until you send them
              {documents.length > 0 ? "; files upload as you attach them" : ""}
            </li>
          )}
        </ul>
        <button
          type="button"
          className="hf-button primary large"
          disabled={needsLine && !preview}
          onClick={() => move({ started: true, step: draft.started ? step : 0 })}
        >
          {draft.answers[AMS_FORM_CONTACT_SECTION] ? "Pick up where you left off" : "Get started"}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
        {needsLine && <p className="hf-hint">Choose at least one to get started.</p>}
      </section>,
    );
  }

  const steps = [...sections.map((item) => item.title), "Review"];
  const progress = (
    <nav className="hf-progress" aria-label="Progress">
      <p>
        Step {step + 1} of {steps.length}
      </p>
      <ol>
        {steps.map((title, index) => {
          const reachable = preview || index < step;
          return (
            <li key={`${title}-${index}`} data-state={index < step ? "done" : index === step ? "current" : "ahead"}>
              <button
                type="button"
                disabled={!reachable || index === step}
                aria-current={index === step ? "step" : undefined}
                onClick={() => move({ step: index })}
              >
                <i aria-hidden="true" />
                <span>{title}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
  const actions = (
    <div className="hf-actions">
      <button
        type="button"
        className="hf-button quiet"
        disabled={sending}
        onClick={() => (step === 0 ? move({ started: false }) : move({ step: step - 1 }))}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        Back
      </button>
      {reviewing ? (
        <button type="button" className="hf-button primary" disabled={sending} onClick={() => void send()}>
          {sending ? <Loader2 size={16} className="hf-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
          {/* Both labels hold the button's width, so the row doesn't reflow while sending. */}
          <span className="hf-swap">
            <span data-off={sending || undefined}>Send my answers</span>
            <span data-off={!sending || undefined}>Sending…</span>
          </span>
        </button>
      ) : (
        <button type="button" className="hf-button primary" onClick={next}>
          Continue
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
  const alert = failure && (
    <p className="hf-alert" role="alert">
      {failure}
    </p>
  );

  if (reviewing) {
    const snapshot = amsFormSnapshot(form, input);
    return shell(
      <>
        {progress}
        <section className="hf-card hf-step" key="review">
          <h1 ref={heading} tabIndex={-1}>
            Look it over
          </h1>
          <p className="hf-step-description">
            Check your answers, then send them to {branding.agencyName}.
          </p>
          <div className="hf-review">
            {sections.map((item, index) => {
              const answered = snapshot.find((entry) => entry.id === item.id);
              const files = input.files.filter((file) => file.section === item.id);
              const problems = issues.filter((issue) => issue.section === item.id).length;
              return (
                <section key={item.id} data-problem={problems ? true : undefined}>
                  <header>
                    <h2>{item.title}</h2>
                    <button type="button" onClick={() => move({ step: index })}>
                      <Pencil size={13} aria-hidden="true" />
                      Edit
                    </button>
                  </header>
                  {problems > 0 && (
                    <p className="hf-error">
                      {problems === 1 ? "One answer needs" : `${problems} answers need`} another look.
                    </p>
                  )}
                  {!answered && !files.length && !problems && <p className="hf-empty">Nothing added.</p>}
                  {answered?.items.map((entry, position) => (
                    <dl key={position}>
                      {item.repeat && (
                        <div className="hf-review-item">
                          <dt>
                            {capital(item.repeat.noun)} {position + 1}
                          </dt>
                          <dd>{entry.title}</dd>
                        </div>
                      )}
                      {entry.answers.map((answer) => (
                        <div key={answer.id}>
                          <dt>{answer.label}</dt>
                          <dd>{amsFormValueText(answer.value, answer.type)}</dd>
                        </div>
                      ))}
                    </dl>
                  ))}
                  {files.length > 0 && (
                    <dl>
                      <div>
                        <dt>Files</dt>
                        <dd>{files.map((file) => `${file.name} (${fileSize(file.bytes)})`).join(", ")}</dd>
                      </div>
                    </dl>
                  )}
                </section>
              );
            })}
          </div>
          {form.consent && <p className="hf-consent">{form.consent}</p>}
          {/* People never see or reach this field; a script that fills every input does. */}
          <div className="hf-trap" aria-hidden="true">
            <label>
              Leave this empty
              <input tabIndex={-1} autoComplete="off" value={trap} onChange={(event) => setTrap(event.target.value)} />
            </label>
          </div>
          {alert}
          {actions}
        </section>
      </>,
    );
  }
  if (!section) return shell(null);

  const count = amsFormItemCount(section, (draft.answers[section.id] ?? []).length);
  const sectionProblem = attempted && errors.get(`${section.id}.0.`);
  const items = Array.from({ length: count }, (_unused, index) => {
    const item = draft.answers[section.id]?.[index] ?? {};
    const fields = (
      <div className="hf-fields">
        {amsFormVisibleFields(section, item).map((field) => {
          const key = `${section.id}.${index}.${field.id}`;
          return (
            <FormQuestion
              key={key}
              field={field}
              value={item[field.id]}
              error={attempted || serverIssues.length ? (errors.get(key) ?? null) : null}
              autofill={section.id === AMS_FORM_CONTACT_SECTION}
              uploads={draft.uploads.filter(
                (upload) => upload.section === section.id && upload.item === index && upload.field === field.id,
              )}
              onChange={(value) => setAnswer(section.id, index, field.id, value)}
              onFiles={(files) => void attach(section.id, index, field.id, files)}
              onRemoveFile={removeUpload}
            />
          );
        })}
      </div>
    );
    if (!section.repeat) return <div key={index}>{fields}</div>;
    return (
      <fieldset className="hf-item" key={index}>
        <legend>
          <span>
            {capital(section.repeat.noun)} {index + 1}
          </span>
        </legend>
        {count > section.repeat.min && (
          <button type="button" className="hf-item-remove" onClick={() => removeItem(section, index)}>
            <Trash2 size={14} aria-hidden="true" />
            Remove
          </button>
        )}
        {fields}
      </fieldset>
    );
  });
  return shell(
    <>
      {progress}
      <section className="hf-card hf-step" key={section.id}>
        <h1 ref={heading} tabIndex={-1}>
          {section.title}
        </h1>
        {section.description && <p className="hf-step-description">{section.description}</p>}
        {sectionProblem && <p className="hf-error">{sectionProblem}</p>}
        {items}
        {section.repeat && count < section.repeat.max && (
          <button type="button" className="hf-add" onClick={() => addItem(section)}>
            <Plus size={16} aria-hidden="true" />
            Add {count ? "another" : /^[aeiou]/i.test(section.repeat.noun) ? "an" : "a"} {section.repeat.noun}
          </button>
        )}
        {alert}
        {actions}
      </section>
    </>,
  );
}
