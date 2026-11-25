"use client";
// The inputs of a hosted form, one per question type. They hold no state of their own:
// the runner owns the answers and tells each input its value and its problem.
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check, FileText, Loader2, Paperclip, TriangleAlert, X } from "lucide-react";
import {
  AMS_FORM_UPLOADS_PER_FIELD,
  AMS_FORM_US_STATES,
  amsFormTyped,
  type AmsFormAddressValue,
  type AmsFormField,
  type AmsFormFieldType,
  type AmsFormValue,
} from "@openams/contracts";

export interface RunnerUpload {
  key: string;
  section: string;
  item: number;
  field: string;
  name: string;
  bytes: number;
  sha256: string;
  status: "uploading" | "done" | "failed";
  error?: string;
}
export const fileSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Browser autofill hints for the contact section, where they are certain to be right. */
const AUTOFILL: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "tel",
  business_name: "organization",
};
const EMPTY_ADDRESS: AmsFormAddressValue = {
  line1: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
};
const asAddress = (value: AmsFormValue | undefined): AmsFormAddressValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? { ...EMPTY_ADDRESS, ...value }
    : EMPTY_ADDRESS;

/** How each typed answer is asked for: the keyboard a phone shows, and what the box hints. */
const TYPED: Partial<
  Record<
    AmsFormFieldType,
    {
      inputMode: "text" | "tel" | "numeric" | "decimal" | "email";
      maxLength: number;
      placeholder?: string;
      capitalize?: "characters";
      /** Shown inside the box, before or after what is typed. */
      before?: string;
      after?: string;
      size?: "short" | "medium";
    }
  >
> = {
  phone: { inputMode: "tel", maxLength: 24, placeholder: "(555) 555-0123", size: "medium" },
  number: { inputMode: "decimal", maxLength: 21, size: "medium" },
  currency: { inputMode: "decimal", maxLength: 19, before: "$", size: "medium" },
  percent: { inputMode: "decimal", maxLength: 6, after: "%", size: "short" },
  year: { inputMode: "numeric", maxLength: 4, placeholder: "YYYY", size: "short" },
  date: { inputMode: "numeric", maxLength: 10, placeholder: "MM/DD/YYYY", size: "medium" },
  zip: { inputMode: "numeric", maxLength: 10, size: "short" },
  ein: { inputMode: "numeric", maxLength: 10, placeholder: "12-3456789", size: "medium" },
  vin: { inputMode: "text", maxLength: 17, capitalize: "characters" },
};
/** The characters of a typed answer that are the answer; the rest is punctuation we add. */
const MEANT = /[0-9A-Za-z.+]/g;
const meantBefore = (text: string, caret: number) => text.slice(0, caret).match(MEANT)?.length ?? 0;

/**
 * A text box that tidies what is typed (see amsFormTyped) and keeps the caret where the
 * person was working, so fixing one digit in the middle doesn't send them to the end.
 */
function TypedInput({
  type,
  value,
  onChange,
  ...rest
}: {
  type: AmsFormFieldType;
  value: string;
  onChange: (value: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange">) {
  const input = useRef<HTMLInputElement>(null);
  const keep = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (keep.current === null || !element) return;
    let position = 0;
    for (let seen = 0; position < element.value.length && seen < keep.current; position++)
      if (element.value[position].match(MEANT)) seen++;
    element.setSelectionRange(position, position);
    keep.current = null;
  });
  // An answer kept from before dates were typed (YYYY-MM-DD) reads the way it is typed now.
  const shown = type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? amsFormTyped(type, value) : value;
  return (
    <input
      {...rest}
      ref={input}
      type={type === "phone" ? "tel" : "text"}
      value={shown}
      onChange={(event) => {
        const typed = event.target.value;
        const caret = event.target.selectionStart ?? typed.length;
        keep.current = caret >= typed.length ? null : meantBefore(typed, caret);
        onChange(amsFormTyped(type, typed));
      }}
    />
  );
}

/** A choice question reads better as buttons when there are only a few short choices. */
const asChips = (options: string[]) =>
  options.length <= 5 && options.every((option) => option.length <= 28);

export function FormQuestion({
  field,
  value,
  error,
  autofill,
  uploads,
  onChange,
  onFiles,
  onRemoveFile,
}: {
  field: AmsFormField;
  value: AmsFormValue | undefined;
  error: string | null;
  /** True in the contact section. */
  autofill: boolean;
  uploads: RunnerUpload[];
  onChange: (value: AmsFormValue) => void;
  onFiles: (files: File[]) => void;
  onRemoveFile: (key: string) => void;
}) {
  const id = useId();
  const describedBy =
    [field.help ? `${id}-help` : "", error ? `${id}-error` : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const common = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": field.required || undefined,
  } as const;
  const text = typeof value === "string" ? value : "";
  // A group of controls is labelled by its legend, a single control by its label.
  const grouped =
    field.type === "yesno" ||
    field.type === "multiselect" ||
    field.type === "address" ||
    field.type === "file" ||
    (field.type === "select" && asChips(field.options));
  const wide =
    grouped || field.type === "longtext" || field.label.length > 44 || Boolean(field.help);
  const labelText = (
    <>
      <span>
        {field.label}
        {field.required && (
          <span className="hf-required" aria-hidden="true">
            {"\u00a0*"}
          </span>
        )}
      </span>
      {!field.required && <span className="hf-optional">Optional</span>}
    </>
  );
  let control: React.ReactNode;
  switch (field.type) {
    case "longtext":
      control = (
        <textarea
          {...common}
          rows={4}
          maxLength={4000}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      );
      break;
    case "select":
      control = asChips(field.options) ? (
        <div className="hf-chips" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
          {field.options.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={text === option}
              onClick={() => onChange(text === option ? "" : option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <select {...common} value={text} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      );
      break;
    case "multiselect": {
      const chosen = Array.isArray(value) ? value : [];
      control = (
        <div className="hf-chips" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
          {field.options.map((option) => {
            const on = chosen.includes(option);
            return (
              <button
                key={option}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() =>
                  onChange(on ? chosen.filter((item) => item !== option) : [...chosen, option])
                }
              >
                <i aria-hidden="true">{on && <Check size={12} strokeWidth={3} />}</i>
                {option}
              </button>
            );
          })}
        </div>
      );
      break;
    }
    case "yesno":
      control = (
        <div className="hf-yesno" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
          {[true, false].map((option) => (
            <button
              key={String(option)}
              type="button"
              role="radio"
              aria-checked={value === option}
              onClick={() => onChange(option)}
            >
              {option ? "Yes" : "No"}
            </button>
          ))}
        </div>
      );
      break;
    case "address": {
      const address = asAddress(value);
      const part = (key: keyof AmsFormAddressValue, next: string) =>
        onChange({ ...address, [key]: next });
      control = (
        <div className="hf-address" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
          <input
            aria-label="Street address"
            placeholder="Street address"
            autoComplete={autofill ? "address-line1" : "off"}
            maxLength={200}
            value={address.line1}
            aria-invalid={error ? true : undefined}
            onChange={(event) => part("line1", event.target.value)}
          />
          <input
            aria-label="Apartment, suite or unit"
            placeholder="Apt, suite or unit"
            autoComplete={autofill ? "address-line2" : "off"}
            maxLength={200}
            value={address.line2}
            onChange={(event) => part("line2", event.target.value)}
          />
          <input
            aria-label="City"
            placeholder="City"
            autoComplete={autofill ? "address-level2" : "off"}
            maxLength={100}
            value={address.city}
            aria-invalid={error ? true : undefined}
            onChange={(event) => part("city", event.target.value)}
          />
          <select
            aria-label="State"
            autoComplete={autofill ? "address-level1" : "off"}
            value={address.state}
            aria-invalid={error ? true : undefined}
            onChange={(event) => part("state", event.target.value)}
          >
            <option value="">State</option>
            {AMS_FORM_US_STATES.map((state) => (
              <option key={state}>{state}</option>
            ))}
          </select>
          <input
            aria-label="ZIP code"
            placeholder="ZIP"
            inputMode="numeric"
            autoComplete={autofill ? "postal-code" : "off"}
            maxLength={10}
            value={address.postalCode}
            aria-invalid={error ? true : undefined}
            onChange={(event) => part("postalCode", amsFormTyped("zip", event.target.value))}
          />
        </div>
      );
      break;
    }
    case "file":
      control = (
        <FileQuestion
          labelledBy={`${id}-label`}
          describedBy={describedBy}
          uploads={uploads}
          onFiles={onFiles}
          onRemove={onRemoveFile}
        />
      );
      break;
    default: {
      const typed = TYPED[field.type];
      const contact = autofill ? AUTOFILL[field.id] : undefined;
      if (!typed) {
        // Short answers and email: nothing to tidy beyond stray spaces in an address.
        const email = field.type === "email";
        control = (
          <input
            {...common}
            type={email ? "email" : "text"}
            inputMode={email ? "email" : undefined}
            autoComplete={contact || "off"}
            autoCapitalize={email ? "none" : field.id === "name" ? "words" : undefined}
            spellCheck={email || contact ? false : undefined}
            maxLength={email ? 254 : 200}
            value={text}
            onChange={(event) =>
              onChange(email ? amsFormTyped("email", event.target.value) : event.target.value)
            }
          />
        );
        break;
      }
      const box = (
        <TypedInput
          {...common}
          type={field.type}
          inputMode={typed.inputMode}
          autoComplete={contact || "off"}
          autoCapitalize={typed.capitalize ?? "none"}
          autoCorrect="off"
          spellCheck={false}
          maxLength={typed.maxLength}
          placeholder={typed.placeholder}
          value={text}
          onChange={onChange}
        />
      );
      control =
        typed.before || typed.after ? (
          <div className="hf-affix" data-size={typed.size}>
            {typed.before && <span aria-hidden="true">{typed.before}</span>}
            {box}
            {typed.after && <span aria-hidden="true">{typed.after}</span>}
          </div>
        ) : (
          <div className="hf-typed" data-size={typed.size}>
            {box}
          </div>
        );
    }
  }
  return (
    <div
      className="hf-field"
      data-type={field.type}
      data-wide={wide || undefined}
      data-invalid={error ? true : undefined}
    >
      {grouped ? (
        <span className="hf-label" id={`${id}-label`}>
          {labelText}
        </span>
      ) : (
        <label className="hf-label" htmlFor={id}>
          {labelText}
        </label>
      )}
      {field.help && (
        <p className="hf-help" id={`${id}-help`}>
          {field.help}
        </p>
      )}
      {control}
      {error && (
        <p className="hf-error" id={`${id}-error`}>
          <TriangleAlert size={13} aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

function FileQuestion({
  labelledBy,
  describedBy,
  uploads,
  onFiles,
  onRemove,
}: {
  labelledBy: string;
  describedBy?: string;
  uploads: RunnerUpload[];
  onFiles: (files: File[]) => void;
  onRemove: (key: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const drop = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  const full = uploads.length >= AMS_FORM_UPLOADS_PER_FIELD;
  return (
    <div className="hf-files" role="group" aria-labelledby={labelledBy} aria-describedby={describedBy}>
      {uploads.length > 0 && (
        <ul>
          {uploads.map((upload) => (
            <li key={upload.key} data-status={upload.status}>
              <span className="hf-file-icon" aria-hidden="true">
                {upload.status === "uploading" ? (
                  <Loader2 size={16} className="hf-spin" />
                ) : upload.status === "failed" ? (
                  <TriangleAlert size={16} />
                ) : (
                  <FileText size={16} />
                )}
              </span>
              <span className="hf-file-name">
                {upload.name}
                <small>
                  {upload.status === "uploading"
                    ? "Uploading…"
                    : upload.status === "failed"
                      ? upload.error || "This file didn't upload."
                      : fileSize(upload.bytes)}
                </small>
              </span>
              <button
                type="button"
                aria-label={`Remove ${upload.name}`}
                onClick={() => {
                  onRemove(upload.key);
                  // The button pressed is gone: focus moves to adding a file, in place.
                  window.requestAnimationFrame(() => drop.current?.focus({ preventScroll: true }));
                }}
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <button
          ref={drop}
          type="button"
          className="hf-drop"
          data-over={over || undefined}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            onFiles([...event.dataTransfer.files]);
          }}
        >
          <Paperclip size={16} aria-hidden="true" />
          <span>
            <strong>{uploads.length ? "Add another file" : "Choose a file"}</strong> or drop it here
            <small>PDF, photo, Word, Excel or CSV. Up to 10 MB each.</small>
          </span>
        </button>
      )}
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx,.csv,application/pdf,image/jpeg,image/png"
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </div>
  );
}
