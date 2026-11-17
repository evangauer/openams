/** Runs in a bounded worker: templates are untrusted agency uploads. */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFDict,
  PDFName,
  PDFArray,
  PDFStream,
  StandardFonts,
} from "pdf-lib";

export async function certificatePdf(input: {
  bytes: Uint8Array;
  fields?: Record<string, string | boolean>;
}) {
  if (!input.bytes.length || input.bytes.length > 5 * 1024 * 1024)
    throw new Error("Use a PDF under 5 MB.");
  const pdf = await PDFDocument.load(input.bytes, {
    updateMetadata: false,
    throwOnInvalidObject: true,
  });
  if (pdf.getPageCount() > 10)
    throw new Error("Use a template with at most ten pages.");
  const objects = pdf.context.enumerateIndirectObjects();
  if (objects.length > 10000) throw new Error("This PDF is too complex.");
  const forbidden = new Set([
    "AA",
    "OpenAction",
    "JS",
    "JavaScript",
    "EmbeddedFiles",
    "EF",
    "AF",
    "RichMediaContent",
    "XFA",
  ]);
  const seen = new Set<unknown>();
  function inspect(value: unknown) {
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof PDFArray)
      for (const child of value.asArray()) inspect(child);
    if (value instanceof PDFStream) inspect(value.dict);
    if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) {
        if (
          key.decodeText() === "A" ||
          forbidden.has(key.decodeText()) ||
          (child instanceof PDFName &&
            ["EmbeddedFile", "FileAttachment"].includes(child.decodeText())) ||
          (key.decodeText() === "S" &&
            child instanceof PDFName &&
            [
              "JavaScript",
              "Launch",
              "SubmitForm",
              "ImportData",
              "GoToR",
              "URI",
              "GoToE",
              "Rendition",
              "Sound",
              "Movie",
            ].includes(child.decodeText()))
        )
          throw new Error(
            "Remove scripts, external actions and attachments from the template.",
          );
        inspect(child);
      }
    }
  }
  for (const [, object] of objects) inspect(object);
  const form = pdf.getForm();
  if (form.hasXFA())
    throw new Error(
      "XFA forms are unsupported. Supply a standard fillable PDF.",
    );
  const fields = form.getFields();
  if (!fields.length || fields.length > 150)
    throw new Error("Use a template with 1 to 150 text or checkbox fields.");
  const names = new Set<string>();
  const descriptions = fields.map((field) => {
    const pdfKey = field.getName();
    if (!pdfKey || pdfKey.length > 250 || names.has(pdfKey))
      throw new Error(
        "Template field names must be unique and under 250 characters.",
      );
    names.add(pdfKey);
    if (!(field instanceof PDFTextField) && !(field instanceof PDFCheckBox))
      throw new Error(
        "Only text and checkbox fields are supported; remove signatures, dropdowns and buttons.",
      );
    if (
      field instanceof PDFTextField &&
      (field.isRichFormatted() ||
        field.isFileSelector() ||
        field.isPassword() ||
        field.isCombed())
    )
      throw new Error(
        "Use plain text fields without rich text, passwords, file selectors or combing.",
      );
    return {
      pdfKey,
      label: pdfKey.slice(0, 200),
      section: "Form fields",
      type:
        field instanceof PDFCheckBox
          ? ("checkbox" as const)
          : ("text" as const),
      maxLength:
        field instanceof PDFTextField
          ? Math.min(field.getMaxLength() ?? 4000, 4000)
          : 1,
      multiline: field instanceof PDFTextField && field.isMultiline(),
    };
  });
  if (!input.fields) return { fields: descriptions };
  for (const key of Object.keys(input.fields))
    if (!names.has(key)) throw new Error(`Unknown form field: ${key}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const field of fields) {
    const value = input.fields[field.getName()];
    if (field instanceof PDFCheckBox) {
      if (value !== undefined && typeof value !== "boolean")
        throw new Error(`Use a checkbox value for ${field.getName()}.`);
      value === true ? field.check() : field.uncheck();
    } else if (field instanceof PDFTextField) {
      if (value !== undefined && typeof value !== "string")
        throw new Error(`Use text for ${field.getName()}.`);
      const text = String(value ?? "");
      if (text.length > Math.min(field.getMaxLength() ?? 4000, 4000))
        throw new Error(
          `Shorten ${field.getName()} to the field's character limit.`,
        );
      if (!field.isMultiline() && /[\r\n]/.test(text))
        throw new Error(`${field.getName()} is a single-line field.`);
      // Reject overflow instead of silently clipping evidence. Require at least 8 pt.
      for (const widget of field.acroField.getWidgets()) {
        const rect = widget.getRectangle();
        const width = rect.width - 6;
        const lines = text.split(/\r?\n/).flatMap((line) => {
          if (!field.isMultiline()) return [line];
          const wrapped = [""];
          for (const word of line.split(" ")) {
            if (font.widthOfTextAtSize(word, 8) > width)
              throw new Error(
                `Shorten a word in ${field.getName()}; it does not fit.`,
              );
            const next = [wrapped.at(-1), word].filter(Boolean).join(" ");
            if (font.widthOfTextAtSize(next, 8) > width) wrapped.push(word);
            else wrapped[wrapped.length - 1] = next;
          }
          return wrapped;
        });
        if (
          lines.some((line) => font.widthOfTextAtSize(line, 8) > width) ||
          lines.length * 10 > rect.height - 4
        )
          throw new Error(
            `Shorten ${field.getName()}; the text will not fit at a readable size.`,
          );
      }
      field.setText(text);
      field.setFontSize(8);
      field.disableScrolling();
    }
    field.enableReadOnly();
  }
  form.updateFieldAppearances(font);
  // Keep canonical AcroForm values as well as their visible appearance streams.
  return { fields: descriptions, bytes: await pdf.save() };
}
if (!isMainThread)
  certificatePdf(workerData)
    .then((result) => parentPort!.postMessage({ result }))
    .catch((error) =>
      parentPort!.postMessage({
        error:
          error instanceof Error
            ? error.message
            : "Cannot process this template.",
      }),
    );
