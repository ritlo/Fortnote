import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { ServerConfig } from "../config.js";

const STORAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function attachmentPath(config: ServerConfig, storageId: string): string {
  return path.join(config.dataDir, storageId);
}

export function writeEncryptedAttachment(
  config: ServerConfig,
  storageId: string,
  bytes: Buffer
): Promise<void> {
  return fsPromises.mkdir(config.dataDir, { recursive: true }).then(() =>
    fsPromises.writeFile(attachmentPath(config, storageId), bytes)
  );
}

export function readEncryptedAttachment(
  config: ServerConfig,
  storageId: string
): Promise<Buffer> {
  return fsPromises.readFile(attachmentPath(config, storageId));
}

export function deleteEncryptedAttachment(
  config: ServerConfig,
  storageId: string
): Promise<void> {
  return fsPromises.unlink(attachmentPath(config, storageId)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

export function removeOrphanedEncryptedAttachments(
  config: ServerConfig,
  referencedStorageIds: ReadonlySet<string>
): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  for (const entry of fs.readdirSync(config.dataDir, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      STORAGE_ID_PATTERN.test(entry.name) &&
      !referencedStorageIds.has(entry.name)
    ) {
      fs.unlinkSync(attachmentPath(config, entry.name));
    }
  }
}

export function safeDisplayFilename(filename: string): boolean {
  const trimmed = filename.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 180 &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    trimmed !== "." &&
    trimmed !== ".."
  );
}
