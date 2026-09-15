import type { Readable } from "node:stream";

const STORAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export function validateAttachmentSize(expectedBytes: number, maxBytes: number): void {
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

export function validateStorageId(storageId: string): void {
  if (!STORAGE_ID_PATTERN.test(storageId)) {
    throw new Error("Invalid attachment storage identity");
  }
}
