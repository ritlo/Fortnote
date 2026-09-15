import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  AttachmentCiphertextSizeError,
  type AttachmentStorage
} from "../attachments/storage.js";

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

/** Stores each encrypted content chunk as its own attachment object. */
export class AttachmentBackedContentStorage implements ContentStorage {
  constructor(private readonly objectStorage: AttachmentStorage) {}

  async write(input: ContentChunkWrite): Promise<StoredContentChunk> {
    validateStorageIdentity(input.uploadId);
    validateChunkIndex(input.chunkIndex);
    validateExpectedChunk(input);
    const storageKey = crypto.randomUUID();
    const hash = createHash("sha256");
    const source = Readable.from(hashChunks(input.source, hash));
    try {
      await this.objectStorage.write({
        storageId: storageKey,
        source,
        expectedBytes: input.expectedLength,
        maxBytes: input.maxBytes
      });
    } catch (error) {
      // The chunk route reports these messages as client errors.
      if (error instanceof AttachmentCiphertextSizeError) {
        throw new Error(
          error.kind === "too-large"
            ? "Encrypted content chunk exceeds maximum bytes"
            : "Encrypted content chunk length mismatch",
          { cause: error }
        );
      }
      throw error;
    }
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

async function* hashChunks(
  source: Readable,
  hash: ReturnType<typeof createHash>
): AsyncGenerator<Buffer> {
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    hash.update(chunk);
    yield chunk;
  }
}
