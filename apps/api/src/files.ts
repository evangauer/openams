import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { AmsError } from "./repository.js";

export interface AmsFiles {
  put(key: string, bytes: Buffer, mediaType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /**
   * Deletes one object; a missing one is not an error. Only a store that holds
   * temporary files (uploads a form's visitor has not submitted yet) needs it. Account
   * documents are never removed.
   */
  remove?(key: string): Promise<void>;
}
export const fileHash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export function verifiedFile(
  name: string,
  bytes: Buffer,
): { name: string; mediaType: string; sha256: string } {
  const byteCount = Buffer.byteLength(bytes);
  const clean = name
    .normalize("NFC")
    .replace(/[\x00-\x1f\x7f/\\]/g, "_")
    .trim();
  if (
    !clean ||
    clean.length > 200 ||
    !byteCount ||
    byteCount > 20 * 1024 * 1024
  )
    throw new AmsError(
      400,
      "invalid_file",
      "Choose a file with a name under 200 characters and a size between 1 byte and 20 MB.",
    );
  const extension = clean.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    txt: "text/plain",
    csv: "text/csv",
    eml: "message/rfc822",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  const mediaType = types[extension ?? ""];
  if (!mediaType)
    throw new AmsError(
      415,
      "unsupported_file",
      "Use PDF, PNG, JPEG, TXT, CSV, EML, DOCX or XLSX.",
    );
  if (
    extension === "pdf" &&
    !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))
  )
    throw new AmsError(
      415,
      "invalid_pdf",
      "This file does not contain a PDF header.",
    );
  if (
    extension === "png" &&
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new AmsError(415, "invalid_image", "The PNG file header is invalid.");
  if (
    (extension === "jpg" || extension === "jpeg") &&
    !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
  )
    throw new AmsError(
      415,
      "invalid_image",
      "The JPEG file header is invalid.",
    );
  if (
    (extension === "docx" || extension === "xlsx") &&
    !bytes.subarray(0, 2).equals(Buffer.from("PK"))
  )
    throw new AmsError(
      415,
      "invalid_office_file",
      "The Office file header is invalid.",
    );
  return { name: clean, mediaType, sha256: fileHash(bytes) };
}
export class LocalAmsFiles implements AmsFiles {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}${sep}`))
      throw new AmsError(400, "invalid_file_path", "Invalid document path.");
    return path;
  }
  async put(key: string, bytes: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (fileHash(await readFile(path)) !== fileHash(bytes))
        throw new AmsError(
          409,
          "file_conflict",
          "The existing document has different content.",
        );
    }
  }
  get(key: string) {
    return readFile(this.path(key));
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
  /** Deletes every file under a key prefix (a demo sandbox's documents). */
  async removeAll(prefix: string) {
    await rm(this.path(prefix), { recursive: true, force: true });
  }
  /**
   * Deletes the folders two levels under a prefix (`<prefix>/<agency>/<upload>`) that
   * were last written before `cutoff`: uploads nobody went on to submit.
   */
  async removeStale(prefix: string, cutoff: number) {
    const root = this.path(prefix);
    const folders = (path: string) =>
      readdir(path, { withFileTypes: true })
        .then((entries) => entries.filter((entry) => entry.isDirectory()))
        .catch(() => []);
    for (const agency of await folders(root))
      for (const upload of await folders(join(root, agency.name))) {
        const path = join(root, agency.name, upload.name);
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs < cutoff)
          await rm(path, { recursive: true, force: true });
      }
  }
}
