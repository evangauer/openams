import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { AmsError } from "./repository.js";
import type { MailboxProvider } from "./mailbox-providers.js";

export const MailboxCredentialsSchema = z
  .object({
    accessToken: z.string().min(1).max(32_000),
    refreshToken: z.string().min(1).max(16_000),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MailboxCredentials = z.infer<typeof MailboxCredentialsSchema>;
type Context = {
  tenantId: string;
  id: string;
  provider: MailboxProvider;
  purpose: "credentials" | "authorization";
};
const unreadable = () =>
  new AmsError(
    503,
    "mailbox_credentials_unavailable",
    "Mailbox credentials cannot be read. Restore the deployment's mailbox key or reconnect after correcting its configuration.",
  );

/** AES-256-GCM with a per-deployment key kept outside the database and its backups. */
export class MailboxVault {
  private key: Buffer;
  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, "base64");
    if (this.key.length !== 32 || this.key.toString("base64") !== encodedKey)
      throw new Error(
        "AMS_MAILBOX_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
      );
  }
  seal(context: Context, plaintext: string) {
    if (Buffer.byteLength(plaintext) > 48_000) throw unreadable();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify([
          "v1",
          context.purpose,
          context.tenantId,
          context.id,
          context.provider,
        ]),
      ),
    );
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      nonce.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join(".");
  }
  open(context: Context, sealed: string) {
    try {
      if (sealed.length > 64_000) throw new Error();
      const parts = sealed.split(".");
      if (
        parts.length !== 4 ||
        parts[0] !== "v1" ||
        parts.slice(1).some((p) => !/^[A-Za-z0-9_-]+$/.test(p))
      )
        throw new Error();
      const nonce = Buffer.from(parts[1]!, "base64url"),
        tag = Buffer.from(parts[2]!, "base64url");
      if (nonce.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(
        Buffer.from(
          JSON.stringify([
            "v1",
            context.purpose,
            context.tenantId,
            context.id,
            context.provider,
          ]),
        ),
      );
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3]!, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw unreadable();
    }
  }
  credentials(context: Omit<Context, "purpose">, sealed: string) {
    try {
      return MailboxCredentialsSchema.parse(
        JSON.parse(this.open({ ...context, purpose: "credentials" }, sealed)),
      );
    } catch {
      throw unreadable();
    }
  }
}
