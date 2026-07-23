import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerConfig } from "../config.js";

const STORAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export function attachmentPath(config: ServerConfig, storageId: string): string {
  validateStorageId(storageId);
  return path.join(config.dataDir, storageId);
}

export class AttachmentCiphertextSizeError extends Error {
  constructor(readonly kind: "mismatch" | "too-large" = "mismatch") {
    super(
      kind === "too-large"
        ? "Encrypted attachment exceeds maximum bytes"
        : "Encrypted attachment size mismatch"
    );
    this.name = "AttachmentCiphertextSizeError";
  }
}

export async function writeEncryptedAttachment(
  config: ServerConfig,
  storageId: string,
  source: Readable,
  expectedBytes: number,
  maxBytes: number
): Promise<void> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    expectedBytes > maxBytes
  ) {
    throw new AttachmentCiphertextSizeError(
      expectedBytes > maxBytes ? "too-large" : "mismatch"
    );
  }

  const finalPath = attachmentPath(config, storageId);
  const temporaryPath = path.join(config.dataDir, `.${storageId}.part`);
  const limiter = new AttachmentSizeTransform(maxBytes);
  await fsPromises.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    await pipeline(
      source,
      limiter,
      fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 })
    );
    if (limiter.byteLength !== expectedBytes) {
      throw new AttachmentCiphertextSizeError();
    }
    await fsPromises.rename(temporaryPath, finalPath);
  } finally {
    await fsPromises.unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }
}

export function readEncryptedAttachment(
  config: ServerConfig,
  storageId: string
): fs.ReadStream {
  return fs.createReadStream(attachmentPath(config, storageId));
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
      const file = attachmentPath(config, entry.name);
      if (Date.now() - fs.statSync(file).mtimeMs < ORPHAN_GRACE_MS) {
        continue;
      }
      fs.unlinkSync(file);
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

function validateStorageId(storageId: string): void {
  if (!STORAGE_ID_PATTERN.test(storageId)) {
    throw new Error("Invalid attachment storage identity");
  }
}

class AttachmentSizeTransform extends Transform {
  readonly #maxBytes: number;
  #byteLength = 0;

  constructor(maxBytes: number) {
    super();
    this.#maxBytes = maxBytes;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.#byteLength += chunk.length;
    if (this.#byteLength > this.#maxBytes) {
      callback(new AttachmentCiphertextSizeError("too-large"));
      return;
    }
    callback(null, chunk);
  }
}
