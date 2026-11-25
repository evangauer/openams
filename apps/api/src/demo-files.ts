/**
 * Files for the demo agency: carrier-style PDFs (declarations, loss runs, notices),
 * spreadsheets as CSV, and emails with attachments, so visitors can open and download
 * documents the way they would in their own book. Everything is fictional and marked
 * as such on the page.
 */
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

export interface DemoPdf {
  /** Who issued it: a carrier, the agency, a vendor. */
  issuer: string;
  title: string;
  /** Label / value pairs under the title. */
  fields?: [string, string][];
  /** One or more tables. */
  tables?: {
    heading?: string;
    head: string[];
    rows: string[][];
    widths?: number[];
  }[];
  paragraphs?: string[];
}

const INK = rgb(0.11, 0.12, 0.14);
const MUTED = rgb(0.42, 0.44, 0.48);
const RULE = rgb(0.85, 0.86, 0.88);
const BAND = rgb(0.13, 0.22, 0.36);

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

export async function renderDemoPdf(doc: DemoPdf, at: Date): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.title);
  pdf.setAuthor(doc.issuer);
  pdf.setCreator("OpenAMS demo");
  pdf.setCreationDate(at);
  pdf.setModificationDate(at);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [W, H, M] = [612, 792, 48];
  let page: PDFPage;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 0, y: H - 64, width: W, height: 64, color: BAND });
    page.drawText(doc.issuer, {
      x: M,
      y: H - 40,
      size: 15,
      font: bold,
      color: rgb(1, 1, 1),
    });
    page.drawText("FICTIONAL DEMO DOCUMENT · NOT A REAL POLICY OR NOTICE", {
      x: M,
      y: 24,
      size: 7,
      font: bold,
      color: MUTED,
    });
    y = H - 100;
  };
  const room = (needed: number) => {
    if (y - needed < 56) newPage();
  };
  newPage();
  page!.drawText(doc.title, { x: M, y, size: 18, font: bold, color: INK });
  y -= 30;
  for (const [label, value] of doc.fields ?? []) {
    const lines = wrap(value, regular, 10, W - M * 2 - 150);
    room(14 * lines.length);
    page!.drawText(label, { x: M, y, size: 9, font: bold, color: MUTED });
    lines.forEach((line, i) =>
      page.drawText(line, {
        x: M + 150,
        y: y - i * 13,
        size: 10,
        font: regular,
        color: INK,
      }),
    );
    y -= 13 * lines.length + 4;
  }
  for (const table of doc.tables ?? []) {
    y -= 12;
    const total = W - M * 2;
    const widths = table.widths ?? table.head.map(() => 1 / table.head.length);
    const xs = widths.reduce<number[]>(
      (acc, w, i) => [...acc, acc[i] + w * total],
      [M],
    );
    if (table.heading) {
      room(40);
      page!.drawText(table.heading, {
        x: M,
        y,
        size: 11,
        font: bold,
        color: INK,
      });
      y -= 18;
    }
    const header = () => {
      page.drawRectangle({
        x: M,
        y: y - 5,
        width: total,
        height: 18,
        color: rgb(0.94, 0.95, 0.96),
      });
      table.head.forEach((cell, i) =>
        page.drawText(cell, {
          x: xs[i] + 4,
          y,
          size: 8,
          font: bold,
          color: MUTED,
        }),
      );
      y -= 18;
    };
    room(36);
    header();
    for (const row of table.rows) {
      const cells = row.map((cell, i) =>
        wrap(cell, regular, 9, widths[i] * total - 8),
      );
      const height = Math.max(...cells.map((c) => c.length)) * 11 + 6;
      if (y - height < 56) {
        newPage();
        header();
      }
      cells.forEach((lines, i) =>
        lines.forEach((line, j) =>
          page.drawText(line, {
            x: xs[i] + 4,
            y: y - j * 11,
            size: 9,
            font: regular,
            color: INK,
          }),
        ),
      );
      y -= height;
      page!.drawLine({
        start: { x: M, y: y + 8 },
        end: { x: W - M, y: y + 8 },
        thickness: 0.5,
        color: RULE,
      });
    }
  }
  for (const paragraph of doc.paragraphs ?? []) {
    y -= 10;
    for (const line of wrap(paragraph, regular, 10, W - M * 2)) {
      room(14);
      page!.drawText(line, { x: M, y, size: 10, font: regular, color: INK });
      y -= 14;
    }
  }
  return Buffer.from(await pdf.save());
}

export function csv(rows: (string | number)[][]) {
  return Buffer.from(
    rows
      .map((row) =>
        row
          .map((cell) => {
            const text = String(cell);
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          })
          .join(","),
      )
      .join("\r\n") + "\r\n",
  );
}

/** A multipart email with attachments, as a mailbox would export it (.eml). */
export function demoEmail(input: {
  from: string;
  to: string;
  subject: string;
  date: Date;
  messageId: string;
  body: string;
  attachments: { name: string; type: string; bytes: Buffer }[];
}) {
  const boundary = `demo-${input.messageId.replace(/[^a-z0-9]/gi, "").slice(0, 24)}`;
  const parts = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: <${input.messageId}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    `${input.body.replace(/\n/g, "\r\n")}\r\n\r\nFictional demo message.`,
  ];
  for (const file of input.attachments)
    parts.push(
      `--${boundary}`,
      `Content-Type: ${file.type}; name="${file.name}"`,
      `Content-Disposition: attachment; filename="${file.name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      file.bytes.toString("base64").replace(/.{76}/g, "$&\r\n"),
    );
  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n"));
}

export const money = (dollars: number) =>
  `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
