import type { Storage } from "firebase-admin/storage";
import { AmsError } from "../repository.js";
import { fileHash, type AmsFiles } from "../files.js";

/** The `Bucket` returned by `getStorage().bucket()`, without a direct @google-cloud/storage dependency. */
export type AmsBucket = ReturnType<Storage["bucket"]>;

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
const invalidPath = () =>
  new AmsError(400, "invalid_file_path", "Invalid document path.");
const statusOf = (error: unknown) => {
  const value = error as { code?: unknown; status?: unknown };
  return Number(value?.code ?? value?.status);
};

/**
 * Write-once document bytes in Cloud Storage. Objects are created with an
 * `ifGenerationMatch: 0` precondition, so an existing object is never replaced;
 * a retry with identical bytes is a no-op and different bytes are a 409.
 * Objects keep the bucket's default (private) access; nothing is made public.
 */
/** Optional per-agency stored-bytes quota (see AgencyStorageQuota). */
export interface AmsStorageQuota {
  reserve(tenantId: string, bytes: number): Promise<void>;
  release(tenantId: string, bytes: number): Promise<void>;
}
export class CloudStorageAmsFiles implements AmsFiles {
  private prefix: string;
  private quota?: AmsStorageQuota;
  constructor(
    private bucket: AmsBucket,
    options: { prefix?: string; quota?: AmsStorageQuota } = {},
  ) {
    const prefix = options.prefix ?? "ams-documents";
    if (!prefix.split("/").every((segment) => SEGMENT.test(segment)))
      throw new Error("Invalid Cloud Storage key prefix.");
    this.prefix = prefix;
    this.quota = options.quota;
  }
  private file(key: string) {
    if (typeof key !== "string" || key.length > 1024) throw invalidPath();
    const segments = key.split("/");
    if (
      segments.length < 2 ||
      segments.slice(0, this.prefix.split("/").length).join("/") !==
        this.prefix ||
      segments.length <= this.prefix.split("/").length ||
      !segments.every(
        (segment) =>
          SEGMENT.test(segment) && segment !== "." && segment !== "..",
      ) ||
      key.includes("..")
    )
      throw invalidPath();
    return this.bucket.file(key);
  }
  private async compare(file: ReturnType<AmsBucket["file"]>, sha256: string) {
    const [existing] = await file.download();
    if (fileHash(existing) !== sha256)
      throw new AmsError(
        409,
        "file_conflict",
        "The existing document has different content.",
      );
  }
  async put(key: string, bytes: Buffer, mediaType: string) {
    const file = this.file(key);
    const sha256 = fileHash(bytes);
    // Fast path for retries. The generation precondition below is what makes the
    // write safe against races (the Firebase Storage emulator ignores it, so this
    // check is also what keeps emulator runs write-once).
    try {
      await this.compare(file, sha256);
      return;
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    // Keys are `<prefix>/<tenantId>/...` (checked by this.file), so the agency is known.
    const tenantId = key.split("/")[this.prefix.split("/").length]!;
    await this.quota?.reserve(tenantId, Buffer.byteLength(bytes));
    try {
      await file.save(bytes, {
        resumable: false,
        validation: "md5",
        contentType: mediaType || "application/octet-stream",
        metadata: {
          cacheControl: "private, no-store",
          contentDisposition: "attachment",
          metadata: { sha256 },
        },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (error) {
      // No new object was created here (it already existed, or the write failed). A
      // failed release leaves the agency over-counted rather than failing the request.
      await this.quota?.release(tenantId, Buffer.byteLength(bytes)).catch(() => undefined);
      if (statusOf(error) !== 412) throw error;
      await this.compare(file, sha256);
    }
  }
  /** Deletes one object and gives back its reserved bytes. A missing object is fine. */
  async remove(key: string) {
    const file = this.file(key);
    let bytes = 0;
    try {
      const [metadata] = await file.getMetadata();
      bytes = Number(metadata.size) || 0;
      await file.delete();
    } catch (error) {
      if (statusOf(error) === 404) return;
      throw error;
    }
    const tenantId = key.split("/")[this.prefix.split("/").length]!;
    if (bytes) await this.quota?.release(tenantId, bytes).catch(() => undefined);
  }
  async get(key: string) {
    const file = this.file(key);
    try {
      const [bytes] = await file.download();
      return bytes;
    } catch (error) {
      if (statusOf(error) === 404)
        throw new AmsError(404, "not_found", "Document not found.");
      throw error;
    }
  }
}
