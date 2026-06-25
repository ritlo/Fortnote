import {
  attachmentAssociatedData,
  createKdfParams,
  decryptBytes,
  deriveAuthVerifier,
  deriveRecoveryAuthVerifier,
  deriveRecoveryWrappingKey,
  deriveVaultWrappingKey,
  encryptBytes,
  fromBase64,
  generateRecoverySecret,
  randomBytes,
  randomUuid,
  toBase64,
  utf8,
  type EncryptedPayload,
  type KdfParams
} from "@ciphernotes/shared";
import type { RegisterPayload } from "./api";

const ROOT_KEY_AAD = utf8("ciphernotes:root-key:v1");

function noteKeyAad(userId: string, noteId: string): Uint8Array {
  return utf8(`ciphernotes:note-key:v1:${userId}:${noteId}`);
}

function attachmentKeyAad(
  userId: string,
  noteId: string,
  attachmentId: string
): Uint8Array {
  return utf8(
    `ciphernotes:attachment-key:v1:${userId}:${noteId}:${attachmentId}`
  );
}

export interface RegistrationCrypto {
  payload: RegisterPayload;
  rootKey: Uint8Array;
  recoverySecret: string;
}

export interface OpenedVault {
  authVerifier: string;
  vaultKey: Uint8Array;
  rootKey: Uint8Array;
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

export interface EncryptedAttachmentDraft {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
  fileNonce: string;
  encryptedBytes: string;
}

export async function createRegistrationCrypto(
  username: string,
  password: string
): Promise<RegistrationCrypto> {
  const authKdf = createKdfParams();
  const vaultKdf = createKdfParams();
  const recoveryKdf = createKdfParams();
  const rootKey = randomBytes(32);
  const recoverySecret = generateRecoverySecret();

  const authVerifier = await deriveAuthVerifier(password, authKdf);
  const vaultKey = await deriveVaultWrappingKey(password, vaultKdf);
  const recoveryAuthVerifier = await deriveRecoveryAuthVerifier(
    recoverySecret,
    recoveryKdf
  );
  const recoveryWrappingKey = await deriveRecoveryWrappingKey(
    recoverySecret,
    recoveryKdf
  );
  const encryptedRoot = await encryptBytes(rootKey, vaultKey, ROOT_KEY_AAD);
  const recoveryEncryptedRoot = await encryptBytes(
    rootKey,
    recoveryWrappingKey,
    ROOT_KEY_AAD
  );

  return {
    rootKey,
    recoverySecret,
    payload: {
      username,
      authVerifier: toBase64(authVerifier),
      authKdf,
      vaultKdf,
      encryptedRootKey: encryptedRoot.cipher,
      rootKeyNonce: encryptedRoot.nonce,
      recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
      recoveryKdf,
      recoveryEncryptedRootKey: recoveryEncryptedRoot.cipher,
      recoveryRootKeyNonce: recoveryEncryptedRoot.nonce
    }
  };
}

export async function openVault(
  password: string,
  authKdf: KdfParams,
  vaultKdf: KdfParams,
  encryptedRootKey: string,
  rootKeyNonce: string
): Promise<OpenedVault> {
  const authVerifier = await deriveAuthVerifier(password, authKdf);
  const vaultKey = await deriveVaultWrappingKey(password, vaultKdf);
  const rootKey = await decryptBytes(
    {
      cipher: encryptedRootKey,
      nonce: rootKeyNonce,
      formatVersion: 1
    },
    vaultKey,
    ROOT_KEY_AAD
  );

  return {
    authVerifier: toBase64(authVerifier),
    vaultKey,
    rootKey
  };
}

export async function createLoginAuthVerifier(
  password: string,
  authKdf: KdfParams
): Promise<string> {
  return toBase64(await deriveAuthVerifier(password, authKdf));
}

export async function createEncryptedNoteDraft(input: {
  userId: string;
  rootKey: Uint8Array;
  title: string;
  body: string;
}): Promise<EncryptedNoteDraft> {
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

export function noteKeyToBase64(noteKey: Uint8Array): string {
  return toBase64(noteKey);
}

export async function createEncryptedAttachmentDraft(input: {
  userId: string;
  noteId: string;
  noteKeyBase64: string;
  file: File;
}): Promise<EncryptedAttachmentDraft> {
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

  return {
    id,
    filename: input.file.name,
    mimeType: input.file.type || "application/octet-stream",
    size: fromBase64(encryptedFile.cipher).byteLength,
    encryptedAttachmentKey: encryptedAttachmentKey.cipher,
    attachmentKeyNonce: encryptedAttachmentKey.nonce,
    fileNonce: encryptedFile.nonce,
    encryptedBytes: encryptedFile.cipher
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
  return utf8(`ciphernotes:note-body:v1:${userId}:${noteId}`);
}
