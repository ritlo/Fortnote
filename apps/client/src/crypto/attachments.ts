import { cryptoReady, fromBase64, randomBytes, randomUuid } from "@fortnote/shared";
import {
  decryptAttachmentFileV2,
  decryptAttachmentKeyV2,
  encryptAttachmentFileV2,
  encryptAttachmentKeyV2,
  encryptAttachmentMetadataV2
} from "./protected";

export interface EncryptedAttachmentDraft {
  id: string;
  expectedKeyEpoch: number;
  metadataCipher: string;
  metadataNonce: string;
  metadataFormatVersion: 2;
  size: number;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
  fileNonce: string;
  encryptedBytes: Uint8Array;
}

export async function createEncryptedAttachmentDraft(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  noteKeyBase64: string;
  file: File;
}): Promise<EncryptedAttachmentDraft> {
  await cryptoReady();
  const id = randomUuid();
  const attachmentKey = randomBytes(32);
  const noteKey = fromBase64(input.noteKeyBase64);
  const encryptedAttachmentKey = await encryptAttachmentKeyV2({
    cryptoOwnerId: input.cryptoOwnerId,
    noteId: input.noteId,
    attachmentId: id,
    keyEpoch: input.keyEpoch,
    noteKey,
    attachmentKey
  });
  const encryptedFile = await encryptAttachmentFileV2({
    cryptoOwnerId: input.cryptoOwnerId,
    noteId: input.noteId,
    attachmentId: id,
    attachmentKey,
    bytes: new Uint8Array(await input.file.arrayBuffer())
  });
  const encryptedMetadata = await encryptAttachmentMetadataV2({
    cryptoOwnerId: input.cryptoOwnerId,
    noteId: input.noteId,
    attachmentId: id,
    keyEpoch: input.keyEpoch,
    noteKey,
    filename: input.file.name,
    mimeType: input.file.type || "application/octet-stream"
  });
  const encryptedBytes = fromBase64(encryptedFile.cipher);

  return {
    id,
    expectedKeyEpoch: input.keyEpoch,
    metadataCipher: encryptedMetadata.cipher,
    metadataNonce: encryptedMetadata.nonce,
    metadataFormatVersion: 2,
    size: encryptedBytes.byteLength,
    encryptedAttachmentKey: encryptedAttachmentKey.cipher,
    attachmentKeyNonce: encryptedAttachmentKey.nonce,
    fileNonce: encryptedFile.nonce,
    encryptedBytes
  };
}

export async function decryptAttachmentBytes(input: {
  cryptoOwnerId: string;
  noteId: string;
  attachmentId: string;
  keyEpoch: number;
  noteKeyBase64: string;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
  encryptedBytes: string;
  fileNonce: string;
}): Promise<Uint8Array> {
  const attachmentKey = await decryptAttachmentKeyV2({
    cryptoOwnerId: input.cryptoOwnerId,
    noteId: input.noteId,
    attachmentId: input.attachmentId,
    keyEpoch: input.keyEpoch,
    noteKey: fromBase64(input.noteKeyBase64),
    envelope: {
      cipher: input.encryptedAttachmentKey,
      nonce: input.attachmentKeyNonce,
      formatVersion: 2
    }
  });
  return decryptAttachmentFileV2({
    cryptoOwnerId: input.cryptoOwnerId,
    noteId: input.noteId,
    attachmentId: input.attachmentId,
    attachmentKey,
    envelope: { cipher: input.encryptedBytes, nonce: input.fileNonce, formatVersion: 2 }
  });
}
