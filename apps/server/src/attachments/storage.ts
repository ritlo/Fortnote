import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const STORAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface AttachmentWrite {
  storageId: string;
  source: Readable;
  expectedBytes: number;
  maxBytes: number;
}

export interface AttachmentStorage {
  write(input: AttachmentWrite): Promise<void>;
  read(storageId: string): Promise<Readable>;
  delete(storageId: string): Promise<void>;
}

export class LocalAttachmentStorage implements AttachmentStorage {
  constructor(private readonly dataDirectory: string) {}

  async write(input: AttachmentWrite): Promise<void> {
    validateAttachmentSize(input.expectedBytes, input.maxBytes);
    const finalPath = this.path(input.storageId);
    const temporaryPath = path.join(this.dataDirectory, `.${input.storageId}.part`);
    const limiter = new AttachmentSizeTransform(input.maxBytes);
    await fsPromises.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    try {
      await pipeline(
        input.source,
        limiter,
        fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 })
      );
      if (limiter.byteLength !== input.expectedBytes) {
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

  read(storageId: string): Promise<fs.ReadStream> {
    return Promise.resolve(fs.createReadStream(this.path(storageId)));
  }

  delete(storageId: string): Promise<void> {
    return fsPromises.unlink(this.path(storageId)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }

  removeOrphans(referencedStorageIds: ReadonlySet<string>): void {
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    for (const entry of fs.readdirSync(this.dataDirectory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        STORAGE_ID_PATTERN.test(entry.name) &&
        !referencedStorageIds.has(entry.name)
      ) {
        const file = this.path(entry.name);
        if (Date.now() - fs.statSync(file).mtimeMs < ORPHAN_GRACE_MS) {
          continue;
        }
        fs.unlinkSync(file);
      }
    }
  }

  private path(storageId: string): string {
    validateStorageId(storageId);
    return path.join(this.dataDirectory, storageId);
  }
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

function validateAttachmentSize(expectedBytes: number, maxBytes: number): void {
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
