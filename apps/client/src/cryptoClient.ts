import {
  attachmentAssociatedData,
  crdtBinaryAssociatedData,
  crdtCheckpointAssociatedData,
  crdtUpdateAssociatedData,
  cryptoReady,
  decryptBytes,
  encryptBytes,
  encryptBytesV2,
  fromBase64,
  randomBytes,
  randomUuid,
  toBase64,
  utf8,
  type EncryptedPayload
} from "@fortnote/shared";
import {
  encryptAttachmentMetadataV2,
  encryptNoteKeyEnvelopeV2,
  encryptNoteTitleV2
} from "./crypto/protected";

export * from "./crypto/account";
export * from "./crypto/protected";
export * from "./crypto/sharing";

function noteKeyAad(userId: string, noteId: string): Uint8Array {
  return utf8(`fortnote:note-key:v1:${userId}:${noteId}`);
}

function attachmentKeyAad(
  userId: string,
  noteId: string,
  attachmentId: string
): Uint8Array {
  return utf8(
    `fortnote:attachment-key:v1:${userId}:${noteId}:${attachmentId}`
  );
}

export interface EncryptedNoteDraft {
  id: string;
  title: string;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  noteKey: Uint8Array;
}

export interface ProtectedNoteDraftV2 {
  id: string;
  rootSectionId: string;
  titleCipher: string;
  titleNonce: string;
  titleFormatVersion: 2;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  noteKeyFormatVersion: 2;
  noteKey: Uint8Array;
}

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

export interface RewrappedAttachmentKey {
  attachmentId: string;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
}

export async function createEncryptedNoteDraft(input: {
  userId: string;
  rootKey: Uint8Array;
  title: string;
  body: string;
}): Promise<EncryptedNoteDraft> {
  await cryptoReady();
  const id = randomUuid();
  const noteKey = randomBytes(32);
  const encryptedNoteKey = await encryptBytes(
    noteKey,
    input.rootKey,
    noteKeyAad(input.userId, id)
  );
  const encryptedBody = await encryptBytes(
    utf8(input.body),
    noteKey,
    noteBodyAad(input.userId, id)
  );

  return {
    id,
    title: input.title,
    encryptedNoteKey: encryptedNoteKey.cipher,
    noteKeyNonce: encryptedNoteKey.nonce,
    contentCipher: encryptedBody.cipher,
    contentNonce: encryptedBody.nonce,
    contentLength: encryptedBody.cipher.length,
    noteKey
  };
}

export async function createProtectedNoteDraftV2(input: {
  cryptoOwnerId: string;
  rootKey: Uint8Array;
  title: string;
}): Promise<ProtectedNoteDraftV2> {
  await cryptoReady();
  const id = randomUuid();
  const rootSectionId = randomUuid();
  const noteKey = randomBytes(32);
  const [title, wrappedKey] = await Promise.all([
    encryptNoteTitleV2({
      cryptoOwnerId: input.cryptoOwnerId,
      noteId: id,
      keyEpoch: 1,
      noteKey,
      title: input.title
    }),
    encryptNoteKeyEnvelopeV2({
      cryptoOwnerId: input.cryptoOwnerId,
      noteId: id,
      keyEpoch: 1,
      rootKey: input.rootKey,
      noteKey
    })
  ]);
  return {
    id,
    rootSectionId,
    titleCipher: title.cipher,
    titleNonce: title.nonce,
    titleFormatVersion: 2,
    encryptedNoteKey: wrappedKey.cipher,
    noteKeyNonce: wrappedKey.nonce,
    noteKeyFormatVersion: 2,
    noteKey
  };
}

export function decryptLegacyNoteKey(input: {
  userId: string;
  rootKey: Uint8Array;
  noteId: string;
  encryptedNoteKey: EncryptedPayload;
}): Promise<Uint8Array> {
  return decryptBytes(
    input.encryptedNoteKey,
    input.rootKey,
    noteKeyAad(input.userId, input.noteId)
  );
}

export async function decryptNote(input: {
  userId: string;
  rootKey: Uint8Array;
  noteId: string;
  encryptedNoteKey: EncryptedPayload;
  encryptedBody: EncryptedPayload;
}): Promise<{ body: string; noteKey: Uint8Array }> {
  const noteKey = await decryptBytes(
    input.encryptedNoteKey,
    input.rootKey,
    noteKeyAad(input.userId, input.noteId)
  );
  const bodyBytes = await decryptBytes(
    input.encryptedBody,
    noteKey,
    noteBodyAad(input.userId, input.noteId)
  );

  return {
    body: new TextDecoder().decode(bodyBytes),
    noteKey
  };
}

export async function decryptNoteBodyWithKey(input: {
  cryptoOwnerId: string;
  noteId: string;
  noteKeyBase64: string;
  encryptedBody: EncryptedPayload;
}): Promise<string> {
  const bodyBytes = await decryptBytes(
    input.encryptedBody,
    fromBase64(input.noteKeyBase64),
    noteBodyAad(input.cryptoOwnerId, input.noteId)
  );
  return new TextDecoder().decode(bodyBytes);
}

export async function encryptExistingNoteBody(input: {
  userId: string;
  noteId: string;
  noteKeyBase64: string;
  body: string;
}): Promise<{ contentCipher: string; contentNonce: string; contentLength: number }> {
  const encrypted = await encryptBytes(
    utf8(input.body),
    fromBase64(input.noteKeyBase64),
    noteBodyAad(input.userId, input.noteId)
  );

  return {
    contentCipher: encrypted.cipher,
    contentNonce: encrypted.nonce,
    contentLength: encrypted.cipher.length
  };
}

type LegacyCrdtAadInput = {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  updateId: string;
  formatVersion: number;
} & (
  | { type: "crdt-update" }
  | { type: "crdt-checkpoint"; compactedUpdateIds: string[] }
);

interface BinaryCrdtAadInput {
  type: "crdt-update" | "crdt-checkpoint";
  formatVersion: 2;
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  kind: "update" | "checkpoint" | "root-update";
  checkpointSequenceCutoff?: number;
}

type CrdtAadInput = LegacyCrdtAadInput | BinaryCrdtAadInput;

export async function encryptCrdtMessage(input: CrdtAadInput & {
  noteKeyBase64: string;
  update: Uint8Array;
}) {
  const encrypt = input.formatVersion === 2 ? encryptBytesV2 : encryptBytes;
  return encrypt(
    input.update,
    fromBase64(input.noteKeyBase64),
    crdtMessageAad(input)
  );
}

export async function decryptCrdtMessage(input: CrdtAadInput & {
  noteKeyBase64: string;
  cipher: string;
  nonce: string;
}): Promise<Uint8Array> {
  return decryptBytes(
    {
      cipher: input.cipher,
      nonce: input.nonce,
      formatVersion: input.formatVersion
    },
    fromBase64(input.noteKeyBase64),
    crdtMessageAad(input)
  );
}

function crdtMessageAad(input: CrdtAadInput): Uint8Array {
  if ("sectionId" in input) {
    return crdtBinaryAssociatedData(input);
  }
  return input.type === "crdt-checkpoint"
    ? crdtCheckpointAssociatedData(input)
    : crdtUpdateAssociatedData(input);
}

export function noteKeyToBase64(noteKey: Uint8Array): string {
  return toBase64(noteKey);
}

export async function rewrapAttachmentKey(input: {
  cryptoOwnerId: string;
  noteId: string;
  oldNoteKeyBase64: string;
  newNoteKeyBase64: string;
  attachmentId: string;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
}): Promise<RewrappedAttachmentKey> {
  const aad = attachmentKeyAad(input.cryptoOwnerId, input.noteId, input.attachmentId);
  const attachmentKey = await decryptBytes(
    {
      cipher: input.encryptedAttachmentKey,
      nonce: input.attachmentKeyNonce,
      formatVersion: 1
    },
    fromBase64(input.oldNoteKeyBase64),
    aad
  );
  const encryptedAttachmentKey = await encryptBytes(
    attachmentKey,
    fromBase64(input.newNoteKeyBase64),
    aad
  );

  return {
    attachmentId: input.attachmentId,
    encryptedAttachmentKey: encryptedAttachmentKey.cipher,
    attachmentKeyNonce: encryptedAttachmentKey.nonce
  };
}

export async function createEncryptedAttachmentDraft(input: {
  userId: string;
  noteId: string;
  keyEpoch: number;
  noteKeyBase64: string;
  file: File;
}): Promise<EncryptedAttachmentDraft> {
  await cryptoReady();
  const id = randomUuid();
  const attachmentKey = randomBytes(32);
  const noteKey = fromBase64(input.noteKeyBase64);
  const encryptedAttachmentKey = await encryptBytes(
    attachmentKey,
    noteKey,
    attachmentKeyAad(input.userId, input.noteId, id)
  );
  const encryptedFile = await encryptBytes(
    new Uint8Array(await input.file.arrayBuffer()),
    attachmentKey,
    attachmentAssociatedData({
      userId: input.userId,
      noteId: input.noteId,
      attachmentId: id,
      formatVersion: 1
    })
  );
  const encryptedMetadata = await encryptAttachmentMetadataV2({
    cryptoOwnerId: input.userId,
    noteId: input.noteId,
    attachmentId: id,
    keyEpoch: input.keyEpoch,
    noteKey,
    filename: input.file.name,
    mimeType: input.file.type || "application/octet-stream"
  });

  return {
    id,
    expectedKeyEpoch: input.keyEpoch,
    metadataCipher: encryptedMetadata.cipher,
    metadataNonce: encryptedMetadata.nonce,
    metadataFormatVersion: 2,
    size: fromBase64(encryptedFile.cipher).byteLength,
    encryptedAttachmentKey: encryptedAttachmentKey.cipher,
    attachmentKeyNonce: encryptedAttachmentKey.nonce,
    fileNonce: encryptedFile.nonce,
    encryptedBytes: fromBase64(encryptedFile.cipher)
  };
}

export async function decryptAttachmentBytes(input: {
  userId: string;
  noteId: string;
  noteKeyBase64: string;
  attachmentId: string;
  encryptedAttachmentKey: EncryptedPayload;
  encryptedBytes: EncryptedPayload;
}): Promise<Uint8Array> {
  const noteKey = fromBase64(input.noteKeyBase64);
  const attachmentKey = await decryptBytes(
    input.encryptedAttachmentKey,
    noteKey,
    attachmentKeyAad(input.userId, input.noteId, input.attachmentId)
  );
  return decryptBytes(
    input.encryptedBytes,
    attachmentKey,
    attachmentAssociatedData({
      userId: input.userId,
      noteId: input.noteId,
      attachmentId: input.attachmentId,
      formatVersion: 1
    })
  );
}

function noteBodyAad(userId: string, noteId: string): Uint8Array {
  return utf8(`fortnote:note-body:v1:${userId}:${noteId}`);
}
