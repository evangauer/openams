import { convert } from "html-to-text";

const MAX_HTML = 2_000_000;
const MAX_PREVIEW = 20_000;
const OMITTED = "[Additional content omitted]";

/** Plain text only. Original MIME bytes remain the authoritative source. */
export function emailPreview(mail: { text?: string; html?: string | false }) {
  let text = mail.text?.trim() ? mail.text : "";
  let shortened = false;
  // Some multipart HTML-only messages have no generated `mail.text`, even
  // when MailParser's skipHtmlToText option is false.
  if (!text && mail.html) {
    shortened = mail.html.length > MAX_HTML;
    try {
      text = convert(mail.html.slice(0, MAX_HTML), {
        wordwrap: false,
        limits: {
          maxInputLength: MAX_HTML,
          maxDepth: 100,
          maxChildNodes: 5000,
          maxBaseElements: 100,
          ellipsis: OMITTED,
        },
        selectors: [
          { selector: "img", format: "skip" },
          { selector: "script", format: "skip" },
          { selector: "style", format: "skip" },
        ],
      });
      shortened ||= text.includes(OMITTED);
    } catch {
      // Preview conversion must not discard the original or its attachments.
      // The UI directs staff to the original whenever no preview is available.
      return { body: "", bodyTruncated: false };
    }
  }
  return {
    body: text.slice(0, MAX_PREVIEW).replace(/[\uD800-\uDBFF]$/, ""),
    bodyTruncated: shortened || text.length > MAX_PREVIEW,
  };
}
