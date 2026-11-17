// Isolated local AMS recovery. Never connects to Firestore or copies login-token files.
// Encrypted mailbox grants remain in the database; their deployment key is separate.
import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  chmod,
  rm,
} from "node:fs/promises";
import { resolve, join, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (root, key) => {
  const path = resolve(root, key);
  if (!path.startsWith(resolve(root) + sep))
    throw new Error("File reference escapes its root.");
  return path;
};
function inspect(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok")
      throw new Error("Database integrity check failed.");
    const hasMailbox = Boolean(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='ams_mailbox'",
        )
        .get(),
    );
    const counts = Object.fromEntries(
      [
        "ams_records",
        "ams_receipts",
        "ams_audit",
        "ams_revisions",
        "ams_keys",
        ...(hasMailbox ? ["ams_mailbox"] : []),
        ...(db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='ams_account_epochs'",
          )
          .get()
          ? ["ams_account_epochs"]
          : []),
      ].map((table) => [
        table,
        Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n),
      ]),
    );
    const documents = db
      .prepare("SELECT value FROM ams_records WHERE kind='documents'")
      .all()
      .map((row) => JSON.parse(row.value));
    const templateOriginals = db
      .prepare("SELECT value FROM ams_records WHERE kind='certificatetemplates'")
      .all()
      .map((row) => JSON.parse(row.value));
    const mailboxOriginals = hasMailbox
      ? db
          .prepare("SELECT value FROM ams_mailbox WHERE kind='messages'")
          .all()
          .map((row) => JSON.parse(row.value))
          .filter((message) => message.original)
          .map((message) => ({ id: message.id, data: message.original }))
      : [];
    const retained = new Map();
    for (const reference of [...documents, ...templateOriginals, ...mailboxOriginals]) {
      const previous = retained.get(reference.data.storageKey);
      if (
        previous &&
        (previous.data.sha256 !== reference.data.sha256 ||
          previous.data.bytes !== reference.data.bytes)
      )
        throw new Error(`Conflicting document reference: ${reference.id}`);
      retained.set(reference.data.storageKey, reference);
    }
    return {
      counts,
      documents,
      templateOriginals,
      mailboxOriginals,
      files: [...retained.values()],
    };
  } finally {
    db.close();
  }
}
export async function verifyLocalBackup(directory) {
  const root = resolve(directory),
    manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.format !== "openams-local-backup-v1")
    throw new Error("Unsupported backup format.");
  if (
    hash(await readFile(join(root, "agency.sqlite"))) !==
    manifest.databaseSha256
  )
    throw new Error("Database hash mismatch.");
  const { counts, documents, templateOriginals, mailboxOriginals, files } = inspect(
    join(root, "agency.sqlite"),
  );
  if (JSON.stringify(counts) !== JSON.stringify(manifest.counts))
    throw new Error("Record counts do not match the manifest.");
  if (
    manifest.documentCount !== documents.length ||
    (manifest.templateOriginalCount ?? 0) !== templateOriginals.length ||
    (manifest.mailboxOriginalCount ?? 0) !== mailboxOriginals.length
  )
    throw new Error("File reference counts do not match the manifest.");
  for (const record of files) {
    const bytes = await readFile(
      within(join(root, "files"), record.data.storageKey),
    );
    if (
      bytes.length !== record.data.bytes ||
      hash(bytes) !== record.data.sha256
    )
      throw new Error(`Document integrity failure: ${record.id}`);
  }
  return { manifest, documents, files };
}
export async function createLocalBackup(source, output) {
  const root = resolve(source),
    dest = resolve(output);
  if (dest === root || dest.startsWith(root + sep))
    throw new Error("Place backups outside the active data directory.");
  // Exclusive directory creation prevents overwriting any existing backup.
  await mkdir(dest, { mode: 0o700 });
  try {
    const db = new DatabaseSync(join(root, "agency.sqlite"), {
      readOnly: true,
    });
    try {
      await backup(db, join(dest, "agency.sqlite"));
      await chmod(join(dest, "agency.sqlite"), 0o600);
    } finally {
      db.close();
    }
    const { counts, documents, templateOriginals, mailboxOriginals, files } = inspect(
      join(dest, "agency.sqlite"),
    );
    for (const record of files) {
      const bytes = await readFile(
        within(join(root, "files"), record.data.storageKey),
      );
      if (
        bytes.length !== record.data.bytes ||
        hash(bytes) !== record.data.sha256
      )
        throw new Error(`Document integrity failure: ${record.id}`);
      const target = within(join(dest, "files"), record.data.storageKey);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    }
    const manifest = {
      format: "openams-local-backup-v1",
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      databaseSha256: hash(await readFile(join(dest, "agency.sqlite"))),
      counts,
      documentCount: documents.length,
      templateOriginalCount: templateOriginals.length,
      mailboxOriginalCount: mailboxOriginals.length,
    };
    await writeFile(
      join(dest, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    await verifyLocalBackup(dest);
    return manifest;
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
}
export async function restoreLocalBackup(source, target) {
  const verified = await verifyLocalBackup(source),
    dest = resolve(target);
  await mkdir(dest, { mode: 0o700 }); // Existing targets are always rejected, even empty ones.
  try {
    await copyFile(join(source, "agency.sqlite"), join(dest, "agency.sqlite"));
    for (const record of verified.files) {
      const to = within(join(dest, "files"), record.data.storageKey);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await copyFile(within(join(source, "files"), record.data.storageKey), to);
    }
    // Re-verify copied bytes, including changes to the backup between validation/copy.
    await copyFile(join(source, "manifest.json"), join(dest, "manifest.json"));
    await verifyLocalBackup(dest);
    await rm(join(dest, "manifest.json"));
    return verified.manifest;
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [action, source, target] = process.argv.slice(2);
  try {
    if (
      !source ||
      !["create", "verify", "restore"].includes(action) ||
      (action !== "verify" && !target)
    )
      throw new Error(
        "Usage: npm run backup -- create <local-directory> <new-backup-directory> | verify <backup-directory> | restore <backup-directory> <new-local-directory>",
      );
    const result =
      action === "create"
        ? await createLocalBackup(source, target)
        : action === "restore"
          ? await restoreLocalBackup(source, target)
          : (await verifyLocalBackup(source)).manifest;
    console.log(
      JSON.stringify({
        action,
        verified: true,
        counts: result.counts,
        documentCount: result.documentCount,
        templateOriginalCount: result.templateOriginalCount ?? 0,
        mailboxOriginalCount: result.mailboxOriginalCount ?? 0,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
