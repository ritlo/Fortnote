import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerConfig } from "../config.js";
import type { AttachmentStorage } from "../attachments/storage.js";

const STORAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface StoredContentChunk {
  fileCipherPath: string;
  cipherLength: number;
  cipherHash: string;
  deleteOnMetadataRace?: true;
}

export interface ContentChunkWrite {
  uploadId: string;
  chunkIndex: number;
  expectedLength: number;
  expectedHash: string;
  maxBytes: number;
  source: Readable;
}

export interface ContentStorage {
  write(input: ContentChunkWrite): Promise<StoredContentChunk>;
  read(storageKey: string): Promise<Readable>;
  delete(storageKey: string): Promise<void>;
  deleteUpload(uploadId: string, storageKeys?: readonly string[]): Promise<void>;
}

export class ContentChunkConflictError extends Error {
  constructor() {
    super("Conflicting encrypted content chunk already exists");
    this.name = "ContentChunkConflictError";
  }
}

export class LocalContentStorage implements ContentStorage {
  constructor(private readonly config: ServerConfig) {}

  write(input: ContentChunkWrite): Promise<StoredContentChunk> {
    return writeEncryptedContentChunk(this.config, input);
  }

  read(storageKey: string): Promise<Readable> {
    const identity = localStorageIdentity(storageKey);
    return Promise.resolve(
      readEncryptedContentChunk(
        this.config,
        identity.uploadId,
        identity.chunkIndex
      )
    );
  }

  delete(storageKey: string): Promise<void> {
    const identity = localStorageIdentity(storageKey);
    return deleteEncryptedContentChunk(
      this.config,
      identity.uploadId,
      identity.chunkIndex
    );
  }

  deleteUpload(uploadId: string): Promise<void> {
    return deleteUncommittedContentUpload(this.config, uploadId);
  }
}

export class AttachmentBackedContentStorage implements ContentStorage {
  constructor(private readonly objectStorage: AttachmentStorage) {}

  async write(input: ContentChunkWrite): Promise<StoredContentChunk> {
    validateStorageIdentity(input.uploadId);
    validateChunkIndex(input.chunkIndex);
    validateExpectedChunk(input);
    const storageKey = crypto.randomUUID();
    const hash = createHash("sha256");
    const source = Readable.from(hashChunks(input.source, hash));
    await this.objectStorage.write({
      storageId: storageKey,
      source,
      expectedBytes: input.expectedLength,
      maxBytes: input.maxBytes
    });
    const actualHash = hash.digest("hex");
    if (actualHash !== input.expectedHash) {
      await this.objectStorage.delete(storageKey);
      throw new Error("Encrypted content chunk hash mismatch");
    }
    return {
      fileCipherPath: storageKey,
      cipherLength: input.expectedLength,
      cipherHash: actualHash,
      deleteOnMetadataRace: true
    };
  }

  read(storageKey: string): Promise<Readable> {
    return this.objectStorage.read(storageKey);
  }

  delete(storageKey: string): Promise<void> {
    return this.objectStorage.delete(storageKey);
  }

  async deleteUpload(
    _uploadId: string,
    storageKeys: readonly string[] = []
  ): Promise<void> {
    await Promise.all(storageKeys.map((storageKey) => this.delete(storageKey)));
  }
}

export function contentChunkPath(
  config: ServerConfig,
  uploadId: string,
  chunkIndex: number
): string {
  validateStorageIdentity(uploadId);
  validateChunkIndex(chunkIndex);
  return path.join(config.dataDir, "content", uploadId, `${String(chunkIndex)}.bin`);
}

export async function writeEncryptedContentChunk(
  config: ServerConfig,
  input: ContentChunkWrite
): Promise<StoredContentChunk> {
  const finalPath = contentChunkPath(config, input.uploadId, input.chunkIndex);
  validateExpectedChunk(input);
  const existing = await inspectExisting(finalPath, input.expectedLength, input.expectedHash);
  if (existing) {
    return existing;
  }

  const directory = path.dirname(finalPath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${String(input.chunkIndex)}.${crypto.randomUUID()}.part`
  );
  const verifier = new HashingTransform(input.maxBytes);
  try {
    await pipeline(
      input.source,
      verifier,
      fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 })
    );
    const actualHash = verifier.digest();
    if (verifier.byteLength !== input.expectedLength) {
      throw new Error("Encrypted content chunk length mismatch");
    }
    if (actualHash !== input.expectedHash) {
      throw new Error("Encrypted content chunk hash mismatch");
    }
    try {
      await fsPromises.link(temporaryPath, finalPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const raced = await inspectExisting(finalPath, input.expectedLength, input.expectedHash);
      if (!raced) {
        throw new ContentChunkConflictError();
      }
      return raced;
    }
    return {
      fileCipherPath: relativeChunkPath(input.uploadId, input.chunkIndex),
      cipherLength: verifier.byteLength,
      cipherHash: actualHash
    };
  } finally {
    await fsPromises.unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }
}

export function readEncryptedContentChunk(
  config: ServerConfig,
  uploadId: string,
  chunkIndex: number
): fs.ReadStream {
  return fs.createReadStream(contentChunkPath(config, uploadId, chunkIndex));
}

export async function deleteEncryptedContentChunk(
  config: ServerConfig,
  uploadId: string,
  chunkIndex: number
): Promise<void> {
  await fsPromises.rm(contentChunkPath(config, uploadId, chunkIndex), { force: true });
}

export async function deleteUncommittedContentUpload(
  config: ServerConfig,
  uploadId: string
): Promise<void> {
  validateStorageIdentity(uploadId);
  await fsPromises.rm(path.join(config.dataDir, "content", uploadId), {
    recursive: true,
    force: true
  });
}

async function inspectExisting(
  filePath: string,
  expectedLength: number,
  expectedHash: string
): Promise<StoredContentChunk | null> {
  let stat: fs.Stats;
  try {
    stat = await fsPromises.stat(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!stat.isFile() || stat.size !== expectedLength) {
    throw new ContentChunkConflictError();
  }
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath) as AsyncIterable<Buffer>) {
    hash.update(chunk);
  }
  if (hash.digest("hex") !== expectedHash) {
    throw new ContentChunkConflictError();
  }
  const { uploadId, chunkIndex } = parseChunkPath(filePath);
  return {
    fileCipherPath: relativeChunkPath(uploadId, chunkIndex),
    cipherLength: expectedLength,
    cipherHash: expectedHash
  };
}

function validateExpectedChunk(input: {
  expectedLength: number;
  expectedHash: string;
  maxBytes: number;
}): void {
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0 ||
    !Number.isSafeInteger(input.expectedLength) ||
    input.expectedLength <= 0 ||
    input.expectedLength > input.maxBytes
  ) {
    throw new Error("Encrypted content chunk exceeds maximum bytes");
  }
  if (!SHA256_PATTERN.test(input.expectedHash)) {
    throw new Error("Invalid encrypted content chunk hash");
  }
}

function validateStorageIdentity(uploadId: string): void {
  if (!STORAGE_ID_PATTERN.test(uploadId)) {
    throw new Error("Invalid content storage identity");
  }
}

function validateChunkIndex(chunkIndex: number): void {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("Invalid content chunk index");
  }
}

function relativeChunkPath(uploadId: string, chunkIndex: number): string {
  return path.posix.join("content", uploadId, `${String(chunkIndex)}.bin`);
}

function localStorageIdentity(storageKey: string): {
  uploadId: string;
  chunkIndex: number;
} {
  const match = /^content\/([^/]+)\/(\d+)\.bin$/u.exec(storageKey);
  if (!match) {
    throw new Error("Invalid content storage key");
  }
  const uploadId = match[1]!;
  const chunkIndex = Number(match[2]);
  validateStorageIdentity(uploadId);
  validateChunkIndex(chunkIndex);
  return { uploadId, chunkIndex };
}

async function* hashChunks(
  source: Readable,
  hash: ReturnType<typeof createHash>
): AsyncGenerator<Buffer> {
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value as Uint8Array);
    hash.update(chunk);
    yield chunk;
  }
}

function parseChunkPath(filePath: string): { uploadId: string; chunkIndex: number } {
  const uploadId = path.basename(path.dirname(filePath));
  const chunkIndex = Number.parseInt(path.basename(filePath, ".bin"), 10);
  validateStorageIdentity(uploadId);
  validateChunkIndex(chunkIndex);
  return { uploadId, chunkIndex };
}

class HashingTransform extends Transform {
  readonly #hash = createHash("sha256");
  readonly #maxBytes: number;
  #byteLength = 0;
  #digested = false;

  constructor(maxBytes: number) {
    super();
    this.#maxBytes = maxBytes;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  digest(): string {
    if (this.#digested) {
      throw new Error("Encrypted content chunk hash already read");
    }
    this.#digested = true;
    return this.#hash.digest("hex");
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.#byteLength += chunk.length;
    if (this.#byteLength > this.#maxBytes) {
      callback(new Error("Encrypted content chunk exceeds maximum bytes"));
      return;
    }
    this.#hash.update(chunk);
    callback(null, chunk);
  }
}
