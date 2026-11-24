"use client";
// The form builder: what to ask, how it looks, and where it lives, beside a live preview
// that is the same page a client will fill in.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  ImagePlus,
  Loader2,
  Monitor,
  Pause,
  Play,
  Plus,
  Smartphone,
  Trash2,
} from "lucide-react";
import qrcode from "qrcode-generator";
import {
  AMS_FORM_CATALOG,
  AMS_FORM_CONTACT_FIELDS,
  AMS_FORM_CONTACT_SECTION,
  AMS_FORM_FIELD_TYPES,
  amsFormAddLine,
  amsFormRemoveLine,
  type AmsFormField,
  type AmsFormFieldType,
  type AmsFormSection,
} from "@openams/contracts";
import { FormRunner } from "@/features/forms/form-runner";
import { inkOn } from "@/features/forms/form-color";
import { useAccountCommand } from "./account-command";
import {
  AgencyRequestError,
  request,
  type AgencySession,
  type AmsRecord,
} from "./model";
import {
  FORM_ACCENTS,
  draftOf,
  draftProblems,
  embedSnippet,
  formNameFor,
  formUrl,
  isLoopback,
  newKey,
  previewForm,
  sameDraft,
  sectionSummary,
  tidyDraft,
  type FormDraft,
  type FormRecord,
} from "./forms-model";

const STEPS = [
  { id: "coverage", label: "Coverage" },
  { id: "questions", label: "Questions" },
  { id: "look", label: "Look" },
  { id: "share", label: "Share" },
] as const;
export type BuilderStep = (typeof STEPS)[number]["id"];
type StepId = BuilderStep;
const TYPE_LABELS: Record<AmsFormFieldType, string> = {
  text: "Short answer",
  longtext: "Paragraph",
  email: "Email",
  phone: "Phone",
  number: "Number",
  currency: "Dollar amount",
  date: "Date",
  select: "Choose one",
  multiselect: "Choose any",
  yesno: "Yes or no",
  address: "Address",
  file: "File upload",
};
const lockedField = (section: AmsFormSection, field: AmsFormField) =>
  section.id === AMS_FORM_CONTACT_SECTION &&
  (field.id === AMS_FORM_CONTACT_FIELDS.name || field.id === AMS_FORM_CONTACT_FIELDS.email);
const draftKey = (id: string) => `openams.formdraft.${id}`;

/** A raster logo small enough to keep on the form record, made in the browser. */
async function logoDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  let scale = Math.min(1, 360 / bitmap.width, 144 / bitmap.height);
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const type of ["image/webp", "image/png"]) {
      const url = canvas.toDataURL(type, 0.9);
      if (url.startsWith(`data:${type};base64,`) && url.length <= 60_000) return url;
    }
    scale *= 0.72;
  }
  throw new Error("This image is too detailed for a logo. Try a simpler or smaller one.");
}
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="agency-button"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        })
      }
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function FormBuilder({
  record,
  initial,
  session,
  saved,
  back,
  opened,
  step: chosenStep,
  setStep,
}: {
  /** The builder step, kept by the parent so it survives a new form's first save. */
  step: BuilderStep | null;
  setStep: (step: BuilderStep) => void;
  /** The saved form, or null for one that hasn't been saved yet. */
  record: FormRecord | null;
  /** The starting draft for a new form. */
  initial: FormDraft;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  back: () => void;
  /** Called with a new form's id after its first save, so the address can follow. */
  opened: (id: string) => void;
}) {
  const savedDraft = useMemo(() => (record ? draftOf(record) : initial), [record, initial]);
  const [draft, setDraft] = useState<FormDraft>(savedDraft);
  const [restored, setRestored] = useState(false);
  const step: StepId = chosenStep ?? (record ? "questions" : "coverage");
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [device, setDevice] = useState<"phone" | "desktop">("phone");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [logoError, setLogoError] = useState("");
  const [autoName, setAutoName] = useState(!record);
  const pendingPublish = useRef<string | null>(null);
  const lastSaved = useRef<FormRecord | null>(null);
  const mutation = useAccountCommand((records) => {
    const form = records.find((item) => item.kind === "forms") as FormRecord | undefined;
    if (form) lastSaved.current = form;
    saved(records);
  });
  const canEdit = session.writableKinds.includes("forms");
  const storageId = record?.id ?? "new";
  const dirty = !sameDraft(draft, savedDraft);
  const problems = useMemo(() => draftProblems(draft), [draft]);
  const preview = useMemo(() => previewForm(draft), [draft]);

  // Unsaved edits survive leaving the builder: they are kept on this device until saved.
  useEffect(() => {
    try {
      const kept = JSON.parse(sessionStorage.getItem(draftKey(storageId)) || "null") as FormDraft | null;
      if (kept && Array.isArray(kept.sections) && !sameDraft(kept, savedDraft)) {
        setDraft(kept);
        setRestored(true);
        setAutoName(false);
      }
    } catch {
      // Nothing kept.
    }
    // Only when a different form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageId]);
  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(draftKey(storageId), JSON.stringify(draft));
      else sessionStorage.removeItem(draftKey(storageId));
    } catch {
      // Storage is off; edits live on this page only.
    }
  }, [draft, dirty, storageId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const change = (patch: Partial<FormDraft>) => setDraft((previous) => ({ ...previous, ...patch }));
  const changeSection = (id: string, patch: (section: AmsFormSection) => AmsFormSection) =>
    setDraft((previous) => ({
      ...previous,
      sections: previous.sections.map((section) => (section.id === id ? patch(section) : section)),
    }));
  const changeField = (sectionId: string, fieldId: string, patch: Partial<AmsFormField>) =>
    changeSection(sectionId, (section) => ({
      ...section,
      fields: section.fields.map((field) => (field.id === fieldId ? { ...field, ...patch } : field)),
    }));
  function toggleLine(id: string) {
    setDraft((previous) => {
      const next = previous.lines.some((line) => line.id === id)
        ? amsFormRemoveLine(previous, id)
        : amsFormAddLine(previous, id);
      const merged = { ...previous, ...next };
      return autoName ? { ...merged, name: formNameFor(merged) } : merged;
    });
  }
  function moveSection(index: number, by: number) {
    setDraft((previous) => {
      const sections = [...previous.sections];
      const target = index + by;
      // The contact section stays first.
      if (target < 1 || target >= sections.length) return previous;
      [sections[index], sections[target]] = [sections[target], sections[index]];
      return { ...previous, sections };
    });
  }
  function addSection() {
    const id = newKey("section", draft.sections.map((section) => section.id));
    setDraft((previous) => {
      const end = previous.sections.findIndex((section) => section.id === "wrap_up");
      const added: AmsFormSection = {
        id,
        title: "More about you",
        description: "",
        lines: [],
        repeat: null,
        exposure: null,
        fields: [
          { id: "question_1", label: "Your question", help: "", type: "text", required: false, options: [], showIf: null },
        ],
      };
      const sections = [...previous.sections];
      sections.splice(end === -1 ? sections.length : end, 0, added);
      return { ...previous, sections };
    });
    setOpenSection(id);
  }

  async function save(): Promise<FormRecord | null> {
    if (problems.length) return null;
    const data = tidyDraft(draft);
    lastSaved.current = null;
    const ok = await mutation.run(() => ({
      id: crypto.randomUUID(),
      action: record ? "update" : "create",
      kind: "forms",
      ...(record ? { recordId: record.id, expectedVersion: record.version } : {}),
      data,
      reason: "",
    }));
    const result = lastSaved.current as FormRecord | null;
    if (!ok || !result) return null;
    try {
      sessionStorage.removeItem(draftKey(storageId));
    } catch {
      // Nothing kept.
    }
    setDraft(draftOf(result));
    setRestored(false);
    if (!record) opened(result.id);
    return result;
  }
  async function publish() {
    if (publishing) return;
    setPublishing(true);
    setPublishError("");
    try {
      const current = dirty || !record ? await save() : record;
      if (!current) return;
      pendingPublish.current ||= crypto.randomUUID();
      const result = await request<{ records: AmsRecord[] }>(`forms/${current.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: pendingPublish.current, expectedVersion: current.version }),
      });
      pendingPublish.current = null;
      saved(result.records);
    } catch (failure) {
      if (failure instanceof AgencyRequestError && failure.status < 500) pendingPublish.current = null;
      setPublishError(failure instanceof Error ? failure.message : "The form could not be published.");
    } finally {
      setPublishing(false);
    }
  }
  const pause = () =>
    record &&
    mutation.run(() => ({
      id: crypto.randomUUID(),
      action: "form.pause",
      kind: "forms",
      recordId: record.id,
      expectedVersion: record.version,
      data: {},
      reason: "",
    }));

  const status = record?.data.status ?? "draft";
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const link = record?.data.linkId ? formUrl(origin, record.data.linkId) : "";
  const busy = mutation.busy || publishing;
  const focusSection =
    step === "questions" ? (openSection ?? draft.sections[0]?.id ?? "@welcome") : "@welcome";

  return (
    <div className="fb">
      <header className="fb-head">
        <button type="button" className="fb-back" onClick={back}>
          <ArrowLeft size={15} />
          Forms
        </button>
        <div className="fb-title">
          <input
            aria-label="Form name"
            value={draft.name}
            maxLength={120}
            disabled={!canEdit}
            onChange={(event) => {
              setAutoName(false);
              change({ name: event.target.value });
            }}
          />
          <span className="fb-status" data-status={status}>
            <i />
            {status === "published" ? "Live" : status === "paused" ? "Paused" : "Draft"}
          </span>
        </div>
        <div className="fb-head-actions">
          <span className="fb-saved" data-dirty={dirty || undefined}>
            {dirty ? "Unsaved changes" : record ? "All changes saved" : ""}
          </span>
          {canEdit && (
            <button
              type="button"
              className="agency-button"
              disabled={busy || (!dirty && Boolean(record)) || problems.length > 0}
              onClick={() => void save()}
            >
              {mutation.busy && !publishing ? <Loader2 size={15} className="fb-spin" /> : null}
              {status === "published" ? "Save and update live form" : "Save draft"}
            </button>
          )}
        </div>
      </header>
      {restored && (
        <p className="fb-banner">
          Your unsaved changes from earlier are back.
          <button
            type="button"
            onClick={() => {
              setDraft(savedDraft);
              setRestored(false);
            }}
          >
            Discard them
          </button>
        </p>
      )}
      {!canEdit && (
        <p className="fb-banner">
          You can look through this form. An administrator or manager changes and publishes forms.
        </p>
      )}
      {(mutation.error || (problems.length > 0 && dirty)) && (
        <p className="fb-banner" data-tone="problem" role="alert">
          {mutation.error || problems[0]}
          {mutation.uncertain && (
            <button type="button" disabled={mutation.busy} onClick={() => void mutation.retry()}>
              Retry the same save
            </button>
          )}
        </p>
      )}
      <div className="fb-body">
        <div className="fb-edit">
          <nav className="fb-steps" aria-label="Builder steps">
            {STEPS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                aria-current={step === item.id ? "step" : undefined}
                onClick={() => setStep(item.id)}
              >
                <em>{index + 1}</em>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          {/* Everyone may copy a live form's link; only the questions and look are locked. */}
          <fieldset className="fb-pane" disabled={!canEdit && step !== "share"} key={step}>
            {step === "coverage" && (
              <>
                <h2>What can clients ask you for?</h2>
                <p className="fb-lead">
                  Pick the lines this form covers. Each one brings its own questions, and a client
                  who chooses two answers the shared ones once.
                </p>
                {(["personal", "commercial"] as const).map((family) => (
                  <section key={family} className="fb-lines">
                    <h3>{family === "personal" ? "Personal lines" : "Commercial lines"}</h3>
                    <div>
                      {AMS_FORM_CATALOG.filter((line) => line.family === family).map((line) => {
                        const on = draft.lines.some((item) => item.id === line.id);
                        return (
                          <button
                            key={line.id}
                            type="button"
                            role="checkbox"
                            aria-checked={on}
                            onClick={() => toggleLine(line.id)}
                          >
                            <i aria-hidden="true">{on && <Check size={12} strokeWidth={3} />}</i>
                            <span>
                              {line.label}
                              <small>{line.summary}</small>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
                <p className="fb-note">
                  No line fits? Leave them all off and write your own questions in the next step.
                </p>
              </>
            )}
            {step === "questions" && (
              <>
                <h2>What you ask</h2>
                <p className="fb-lead">
                  Open a section to reword, add or remove questions. The preview follows the
                  section you have open.
                </p>
                <div className="fb-sections">
                  {draft.sections.map((section, index) => (
                    <SectionEditor
                      key={section.id}
                      section={section}
                      lineLabels={section.lines.flatMap(
                        (id) => draft.lines.find((line) => line.id === id)?.label ?? [],
                      )}
                      open={openSection === section.id}
                      toggle={() => setOpenSection(openSection === section.id ? null : section.id)}
                      canMoveUp={index > 1}
                      canMoveDown={index > 0 && index < draft.sections.length - 1}
                      move={(by) => moveSection(index, by)}
                      remove={
                        section.id === AMS_FORM_CONTACT_SECTION
                          ? undefined
                          : () => {
                              change({ sections: draft.sections.filter((item) => item.id !== section.id) });
                              setOpenSection(null);
                            }
                      }
                      change={(patch) => changeSection(section.id, patch)}
                      changeField={(fieldId, patch) => changeField(section.id, fieldId, patch)}
                    />
                  ))}
                </div>
                <button type="button" className="fb-add" onClick={addSection}>
                  <Plus size={15} />
                  Add a section
                </button>
              </>
            )}
            {step === "look" && (
              <>
                <h2>Make it yours</h2>
                <p className="fb-lead">Clients see your name, your color and your words. Nothing says OpenAMS but the footer.</p>
                <div className="fb-grid">
                  <label className="agency-field fb-span">
                    <span>Headline</span>
                    <input value={draft.title} maxLength={120} onChange={(event) => change({ title: event.target.value })} />
                  </label>
                  <label className="agency-field fb-span">
                    <span>Welcome message</span>
                    <textarea rows={3} value={draft.intro} maxLength={600} onChange={(event) => change({ intro: event.target.value })} />
                  </label>
                  <label className="agency-field">
                    <span>Agency name</span>
                    <input
                      value={draft.branding.agencyName}
                      maxLength={120}
                      onChange={(event) => change({ branding: { ...draft.branding, agencyName: event.target.value } })}
                    />
                  </label>
                  <label className="agency-field">
                    <span>Phone clients can call</span>
                    <input
                      value={draft.branding.phone}
                      maxLength={40}
                      onChange={(event) => change({ branding: { ...draft.branding, phone: event.target.value } })}
                    />
                  </label>
                  <label className="agency-field fb-span">
                    <span>Email clients can write to</span>
                    <input
                      type="email"
                      value={draft.branding.email}
                      maxLength={254}
                      onChange={(event) => change({ branding: { ...draft.branding, email: event.target.value.trim() } })}
                    />
                  </label>
                  <div className="agency-field fb-span">
                    <span>Color</span>
                    <div className="fb-swatches">
                      {FORM_ACCENTS.map((accent) => (
                        <button
                          key={accent.value}
                          type="button"
                          title={accent.name}
                          aria-label={accent.name}
                          aria-pressed={draft.branding.accent.toLowerCase() === accent.value}
                          style={{ background: accent.value, color: inkOn(accent.value) }}
                          onClick={() => change({ branding: { ...draft.branding, accent: accent.value } })}
                        >
                          {draft.branding.accent.toLowerCase() === accent.value && <Check size={15} strokeWidth={3} />}
                        </button>
                      ))}
                      <label className="fb-custom-color" title="Your own color">
                        <input
                          type="color"
                          aria-label="Your own color"
                          value={draft.branding.accent}
                          onChange={(event) => change({ branding: { ...draft.branding, accent: event.target.value } })}
                        />
                        Your own
                      </label>
                    </div>
                  </div>
                  <div className="agency-field fb-span">
                    <span>Logo</span>
                    <div className="fb-logo">
                      {draft.branding.logo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={draft.branding.logo} alt="Your logo" />
                      ) : (
                        <span className="fb-logo-empty" style={{ background: draft.branding.accent, color: inkOn(draft.branding.accent) }}>
                          {draft.branding.agencyName.trim().charAt(0).toUpperCase() || "A"}
                        </span>
                      )}
                      <label className="agency-button">
                        <ImagePlus size={15} />
                        {draft.branding.logo ? "Replace" : "Upload a logo"}
                        <input
                          type="file"
                          hidden
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (!file) return;
                            setLogoError("");
                            logoDataUrl(file)
                              .then((logo) => change({ branding: { ...draft.branding, logo } }))
                              .catch((failure: unknown) =>
                                setLogoError(failure instanceof Error ? failure.message : "This image could not be read."),
                              );
                          }}
                        />
                      </label>
                      {draft.branding.logo && (
                        <button type="button" className="agency-button quiet" onClick={() => change({ branding: { ...draft.branding, logo: "" } })}>
                          Remove
                        </button>
                      )}
                    </div>
                    <small>{logoError || "PNG, JPG or WebP. Without one, clients see your initial on your color."}</small>
                  </div>
                </div>
                <h3 className="fb-subhead">After they send it</h3>
                <div className="fb-grid">
                  <label className="agency-field fb-span">
                    <span>Thank-you headline</span>
                    <input
                      value={draft.confirmation.title}
                      maxLength={120}
                      onChange={(event) => change({ confirmation: { ...draft.confirmation, title: event.target.value } })}
                    />
                  </label>
                  <label className="agency-field fb-span">
                    <span>Thank-you message</span>
                    <textarea
                      rows={2}
                      value={draft.confirmation.body}
                      maxLength={600}
                      onChange={(event) => change({ confirmation: { ...draft.confirmation, body: event.target.value } })}
                    />
                  </label>
                  <label className="agency-field fb-span">
                    <span>Consent line above the Send button</span>
                    <textarea rows={2} value={draft.consent} maxLength={1000} onChange={(event) => change({ consent: event.target.value })} />
                    <small>Leave it empty to show none. Ask your compliance contact what your state expects.</small>
                  </label>
                  <label className="agency-field">
                    <span>Who follows up</span>
                    <select value={draft.ownerId ?? ""} onChange={(event) => change({ ownerId: event.target.value || null })}>
                      <option value="">The agency&apos;s default owner</option>
                      {session.members
                        .filter((member) => member.active && !["viewer", "accountant"].includes(member.role))
                        .map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.name}
                          </option>
                        ))}
                    </select>
                    <small>Each submission opens a task for this person.</small>
                  </label>
                  <label className="agency-field">
                    <span>Follow-up task is due</span>
                    <select value={draft.followUpDays} onChange={(event) => change({ followUpDays: Number(event.target.value) })}>
                      <option value={0}>The same day</option>
                      <option value={1}>The next day</option>
                      <option value={2}>In 2 days</option>
                      <option value={3}>In 3 days</option>
                      <option value={7}>In a week</option>
                    </select>
                  </label>
                </div>
              </>
            )}
            {step === "share" && (
              <>
                <h2>{status === "published" ? "Your form is live" : "Put it in front of clients"}</h2>
                {status === "published" && link ? (
                  <>
                    <p className="fb-lead">
                      Anyone with this link can fill in the form. Put it in your email signature, text it to a client, or add it to your website.
                    </p>
                    <div className="fb-link">
                      <code>{link}</code>
                      <CopyButton text={link} label="Copy link" />
                      <a className="agency-button" href={link} target="_blank" rel="noreferrer">
                        <ExternalLink size={15} />
                        Open
                      </a>
                    </div>
                    {isLoopback(window.location.hostname) && (
                      <p className="fb-note">
                        You are running OpenAMS on this computer, so this link opens here only. On your deployed OpenAMS the same button gives you a link clients can open.
                      </p>
                    )}
                    <div className="fb-share">
                      <section>
                        <h3>Scan to open</h3>
                        <p>For a counter card, a flyer or the back of a business card.</p>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className="fb-qr" alt="QR code for the form link" src={qrFor(link)} />
                      </section>
                      <section>
                        <h3>Add it to your website</h3>
                        <p>Paste this where the form should appear. It grows to fit as clients move through it.</p>
                        <pre>{embedSnippet(origin, record!.data.linkId!, `${draft.branding.agencyName}: ${draft.title}`)}</pre>
                        <CopyButton
                          text={embedSnippet(origin, record!.data.linkId!, `${draft.branding.agencyName}: ${draft.title}`)}
                          label="Copy code"
                        />
                      </section>
                    </div>
                    {canEdit && (
                      <button type="button" className="agency-button quiet" disabled={busy} onClick={() => void pause()}>
                        <Pause size={15} />
                        Pause this form
                      </button>
                    )}
                  </>
                ) : session.formPublishingEnabled === false ? (
                  <p className="fb-lead">
                    The demo is shared with everyone who tries OpenAMS, so public links stay off here. Build the form and run the preview on the right: it is the same page a client fills in. In your own agency this step gives you the link, a QR code and the code for your website.
                  </p>
                ) : (
                  <>
                    <p className="fb-lead">
                      {status === "paused"
                        ? "This form is paused: its link tells clients to reach you directly. Reopen it and the same link works again."
                        : "Publishing gives the form a link of its own. You can keep editing afterwards, and pause it whenever you like."}
                    </p>
                    <ul className="fb-checklist">
                      <li data-ok={draft.lines.length > 0 || draft.sections.length > 2 || undefined}>
                        {draft.lines.length
                          ? `Covers ${draft.lines.map((line) => line.label).join(", ")}`
                          : "No line of business chosen: clients answer only your own questions"}
                      </li>
                      <li data-ok>
                        {draft.sections.reduce((total, section) => total + section.fields.length, 0)} questions in {draft.sections.length} sections
                      </li>
                      <li data-ok={Boolean(draft.branding.phone || draft.branding.email) || undefined}>
                        {draft.branding.phone || draft.branding.email
                          ? "Clients can see how to reach you"
                          : "Add a phone or email under Look so clients can reach you"}
                      </li>
                    </ul>
                    {canEdit && (
                      <button
                        type="button"
                        className="agency-button primary fb-publish"
                        disabled={busy || problems.length > 0}
                        onClick={() => void publish()}
                      >
                        {publishing ? <Loader2 size={16} className="fb-spin" /> : <Play size={16} />}
                        {status === "paused" ? "Reopen form" : dirty || !record ? "Save and publish" : "Publish form"}
                      </button>
                    )}
                    {publishError && (
                      <p className="agency-form-error" role="alert">
                        {publishError}
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </fieldset>
        </div>
        <aside className="fb-preview" aria-label="Preview">
          <div className="fb-preview-bar">
            <span>Preview · what a client sees</span>
            <div role="group" aria-label="Preview size">
              <button type="button" aria-pressed={device === "phone"} aria-label="Phone" onClick={() => setDevice("phone")}>
                <Smartphone size={15} />
              </button>
              <button type="button" aria-pressed={device === "desktop"} aria-label="Computer" onClick={() => setDevice("desktop")}>
                <Monitor size={15} />
              </button>
            </div>
          </div>
          <div className="fb-device" data-device={device}>
            <div className="fb-screen">
              <FormRunner form={preview} preview focus={focusSection} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function qrFor(text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(5, 8);
}

function SectionEditor({
  section,
  lineLabels,
  open,
  toggle,
  canMoveUp,
  canMoveDown,
  move,
  remove,
  change,
  changeField,
}: {
  section: AmsFormSection;
  lineLabels: string[];
  open: boolean;
  toggle: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  move: (by: number) => void;
  remove?: () => void;
  change: (patch: (section: AmsFormSection) => AmsFormSection) => void;
  changeField: (fieldId: string, patch: Partial<AmsFormField>) => void;
}) {
  const [openField, setOpenField] = useState<string | null>(null);
  const moveField = (index: number, by: number) =>
    change((current) => {
      const fields = [...current.fields];
      const target = index + by;
      if (target < 0 || target >= fields.length) return current;
      [fields[index], fields[target]] = [fields[target], fields[index]];
      return { ...current, fields };
    });
  const addField = () => {
    const id = newKey("question", section.fields.map((field) => field.id));
    change((current) => ({
      ...current,
      fields: [
        ...current.fields,
        { id, label: "", help: "", type: "text", required: false, options: [], showIf: null },
      ],
    }));
    setOpenField(id);
  };
  return (
    <article className="fb-section" data-open={open || undefined}>
      <button type="button" className="fb-section-head" aria-expanded={open} onClick={toggle}>
        <span>
          <strong>{section.title || "Untitled section"}</strong>
          <small>
            {sectionSummary(section)}
            {lineLabels.length ? ` · asked for ${lineLabels.join(", ")}` : " · everyone answers"}
          </small>
        </span>
        <ChevronDown size={17} />
      </button>
      {open && (
        <div className="fb-section-body">
          <div className="fb-grid">
            <label className="agency-field">
              <span>Section title</span>
              <input value={section.title} maxLength={120} onChange={(event) => change((current) => ({ ...current, title: event.target.value }))} />
            </label>
            <label className="agency-field">
              <span>Line under the title</span>
              <input
                value={section.description}
                maxLength={400}
                onChange={(event) => change((current) => ({ ...current, description: event.target.value }))}
              />
            </label>
          </div>
          {section.repeat && (
            <p className="fb-note">
              Clients answer these once per {section.repeat.noun} and can add up to {section.repeat.max}.
              {section.exposure ? ` When you file a submission, each one becomes a ${section.exposure} on the account.` : ""}
            </p>
          )}
          <ol className="fb-questions">
            {section.fields.map((field, index) => {
              const locked = lockedField(section, field);
              const expanded = openField === field.id;
              const controllers = section.fields
                .slice(0, index)
                .filter((item) => item.type === "yesno" || item.type === "select");
              const controller = controllers.find((item) => item.id === field.showIf?.field);
              return (
                <li key={field.id} data-open={expanded || undefined}>
                  <div className="fb-question">
                    <span className="fb-order">
                      <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => moveField(index, -1)}>
                        <ArrowUp size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        disabled={index === section.fields.length - 1}
                        onClick={() => moveField(index, 1)}
                      >
                        <ArrowDown size={13} />
                      </button>
                    </span>
                    <input
                      aria-label="Question"
                      placeholder="Write your question"
                      value={field.label}
                      maxLength={200}
                      autoFocus={expanded && !field.label}
                      onChange={(event) => changeField(field.id, { label: event.target.value })}
                    />
                    <label className="fb-required" title={locked ? "Every form needs this" : undefined}>
                      <input
                        type="checkbox"
                        checked={field.required}
                        disabled={locked}
                        onChange={(event) => changeField(field.id, { required: event.target.checked })}
                      />
                      Required
                    </label>
                    <button
                      type="button"
                      className="fb-more"
                      aria-expanded={expanded}
                      onClick={() => setOpenField(expanded ? null : field.id)}
                    >
                      {TYPE_LABELS[field.type]}
                      <ChevronDown size={14} />
                    </button>
                  </div>
                  {field.showIf && controller && !expanded && (
                    <p className="fb-condition">
                      Asked when &ldquo;{controller.label}&rdquo; is{" "}
                      {typeof field.showIf.equals === "boolean" ? (field.showIf.equals ? "Yes" : "No") : field.showIf.equals}
                    </p>
                  )}
                  {expanded && (
                    <div className="fb-question-more">
                      <label className="agency-field">
                        <span>Answer type</span>
                        <select
                          value={field.type}
                          disabled={locked}
                          onChange={(event) => changeField(field.id, { type: event.target.value as AmsFormFieldType })}
                        >
                          {AMS_FORM_FIELD_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {TYPE_LABELS[type]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="agency-field">
                        <span>Ask it</span>
                        <select
                          value={field.showIf ? `${field.showIf.field}=${String(field.showIf.equals)}` : ""}
                          disabled={locked}
                          onChange={(event) => {
                            const [id, ...rest] = event.target.value.split("=");
                            const answer = rest.join("=");
                            const target = controllers.find((item) => item.id === id);
                            changeField(field.id, {
                              showIf: target
                                ? { field: id, equals: target.type === "yesno" ? answer === "true" : answer }
                                : null,
                            });
                          }}
                        >
                          <option value="">Always</option>
                          {controllers.flatMap((item) =>
                            (item.type === "yesno" ? ["true", "false"] : item.options).map((answer) => (
                              <option key={`${item.id}=${answer}`} value={`${item.id}=${answer}`}>
                                Only when &ldquo;{item.label.slice(0, 40)}&rdquo; is{" "}
                                {item.type === "yesno" ? (answer === "true" ? "Yes" : "No") : answer}
                              </option>
                            )),
                          )}
                        </select>
                      </label>
                      {(field.type === "select" || field.type === "multiselect") && (
                        <label className="agency-field fb-span">
                          <span>Choices, one per line</span>
                          <textarea
                            rows={Math.min(8, Math.max(3, field.options.length + 1))}
                            value={field.options.join("\n")}
                            onChange={(event) => changeField(field.id, { options: event.target.value.split("\n").slice(0, 60) })}
                          />
                        </label>
                      )}
                      <label className="agency-field fb-span">
                        <span>Help text under the question</span>
                        <input value={field.help} maxLength={300} onChange={(event) => changeField(field.id, { help: event.target.value })} />
                      </label>
                      {!locked && (
                        <button
                          type="button"
                          className="fb-remove"
                          onClick={() =>
                            change((current) => ({
                              ...current,
                              fields: current.fields.filter((item) => item.id !== field.id),
                            }))
                          }
                        >
                          <Trash2 size={14} />
                          Remove question
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="fb-section-foot">
            <button type="button" className="fb-add small" onClick={addField}>
              <Plus size={14} />
              Add a question
            </button>
            <span>
              <button type="button" aria-label="Move section up" disabled={!canMoveUp} onClick={() => move(-1)}>
                <ArrowUp size={14} />
              </button>
              <button type="button" aria-label="Move section down" disabled={!canMoveDown} onClick={() => move(1)}>
                <ArrowDown size={14} />
              </button>
              {remove && (
                <button type="button" className="fb-remove" onClick={remove}>
                  <Trash2 size={14} />
                  Remove section
                </button>
              )}
            </span>
          </div>
        </div>
      )}
    </article>
  );
}
