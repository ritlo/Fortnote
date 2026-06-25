import fs from "node:fs";
import path from "node:path";
import type { ServerConfig } from "../config.js";

export function ensureAttachmentDir(config: ServerConfig): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

export function attachmentPath(config: ServerConfig, storageId: string): string {
  return path.join(config.dataDir, storageId);
}

export function writeEncryptedAttachment(
  config: ServerConfig,
  storageId: string,
  bytesBase64: string
): void {
  ensureAttachmentDir(config);
  fs.writeFileSync(attachmentPath(config, storageId), Buffer.from(bytesBase64, "base64"));
}

export function readEncryptedAttachment(
  config: ServerConfig,
  storageId: string
): Buffer {
  return fs.readFileSync(attachmentPath(config, storageId));
}

export function deleteEncryptedAttachment(
  config: ServerConfig,
  storageId: string
): void {
  try {
    fs.unlinkSync(attachmentPath(config, storageId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
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
