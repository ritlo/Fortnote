import {
  attachmentAssociatedData,
  crdtCheckpointAssociatedData,
  crdtUpdateAssociatedData,
  createKdfParams,
  createSharingKeyPair,
  cryptoReady,
  decryptBytes,
  deriveAuthVerifier,
  deriveRecoveryAuthVerifier,
  deriveRecoveryWrappingKey,
  deriveVaultWrappingKey,
  encryptBytes,
  fromBase64,
  generateRecoverySecret,
  openSealedBytes,
  randomBytes,
  randomUuid,
  sealBytes,
  toBase64,
  utf8,
  type EncryptedPayload,
  type KdfParams
} from "@fortnote/shared";
import type {
  SharingKeyEnvelope,
  StoreSharingKeyPayload,
  RegisterPayload
} from "./api";

const ROOT_KEY_AAD = utf8("fortnote:root-key:v1");
const SHARING_PRIVATE_KEY_AAD = utf8("fortnote:sharing-private-key:v1");

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
  encryptedBytes: Uint8Array;
}

export interface PasswordChangeCrypto {
  authVerifier: string;
  authKdf: KdfParams;
  vaultKdf: KdfParams;
  encryptedRootKey: string;
  rootKeyNonce: string;
}

export interface RecoveryRotationCrypto {
  recoverySecret: string;
  recoveryAuthVerifier: string;
  recoveryKdf: KdfParams;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
}

export interface AccountRecoveryCrypto {
  rootKey: Uint8Array;
  recoveryAuthVerifier: string;
  passwordChange: PasswordChangeCrypto;
}

export interface OpenedSharingKey {
  publicKey: string;
  privateKey: string;
  sharingKeyVersion: number;
}

export interface CreatedSharingKey {
  payload: StoreSharingKeyPayload;
  opened: OpenedSharingKey;
}

export interface RotatedNoteKeyMaterial {
  contentCipher: string;
  contentLength: number;
  contentNonce: string;
  encryptedNoteKey: string;
  noteKeyBase64: string;
  noteKeyNonce: string;
}

export interface RewrappedAttachmentKey {
  attachmentId: string;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
}

export async function createRegistrationCrypto(
  username: string,
  password: string
): Promise<RegistrationCrypto> {
  await cryptoReady();
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

export async function createPasswordChangeCrypto(
  rootKey: Uint8Array,
  newPassword: string
): Promise<PasswordChangeCrypto> {
  await cryptoReady();
  const authKdf = createKdfParams();
  const vaultKdf = createKdfParams();
  const authVerifier = await deriveAuthVerifier(newPassword, authKdf);
  const vaultKey = await deriveVaultWrappingKey(newPassword, vaultKdf);
  const encryptedRoot = await encryptBytes(rootKey, vaultKey, ROOT_KEY_AAD);

  return {
    authVerifier: toBase64(authVerifier),
    authKdf,
    vaultKdf,
    encryptedRootKey: encryptedRoot.cipher,
    rootKeyNonce: encryptedRoot.nonce
  };
}

export async function createRecoveryRotationCrypto(
  rootKey: Uint8Array
): Promise<RecoveryRotationCrypto> {
  await cryptoReady();
  const recoverySecret = generateRecoverySecret();
  const recoveryKdf = createKdfParams();
  const recoveryAuthVerifier = await deriveRecoveryAuthVerifier(
    recoverySecret,
    recoveryKdf
  );
  const recoveryWrappingKey = await deriveRecoveryWrappingKey(
    recoverySecret,
    recoveryKdf
  );
  const recoveryEncryptedRoot = await encryptBytes(
    rootKey,
    recoveryWrappingKey,
    ROOT_KEY_AAD
  );

  return {
    recoverySecret,
    recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
    recoveryKdf,
    recoveryEncryptedRootKey: recoveryEncryptedRoot.cipher,
    recoveryRootKeyNonce: recoveryEncryptedRoot.nonce
  };
}

export async function createAccountRecoveryCrypto(input: {
  recoverySecret: string;
  recoveryKdf: KdfParams;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  newPassword: string;
}): Promise<AccountRecoveryCrypto> {
  const recoveryAuthVerifier = await deriveRecoveryAuthVerifier(
    input.recoverySecret,
    input.recoveryKdf
  );
  const recoveryWrappingKey = await deriveRecoveryWrappingKey(
    input.recoverySecret,
    input.recoveryKdf
  );
  const rootKey = await decryptBytes(
    {
      cipher: input.recoveryEncryptedRootKey,
      nonce: input.recoveryRootKeyNonce,
      formatVersion: 1
    },
    recoveryWrappingKey,
    ROOT_KEY_AAD
  );

  return {
    rootKey,
    recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
    passwordChange: await createPasswordChangeCrypto(rootKey, input.newPassword)
  };
}

export async function createUserSharingKey(
  rootKey: Uint8Array,
  sharingKeyVersion = 1
): Promise<CreatedSharingKey> {
  const keyPair = await createSharingKeyPair();
  const encryptedPrivateKey = await encryptBytes(
    fromBase64(keyPair.privateKey),
    rootKey,
    SHARING_PRIVATE_KEY_AAD
  );

  return {
    payload: {
      sharingKeyVersion,
      publicKey: keyPair.publicKey,
      encryptedPrivateKey: encryptedPrivateKey.cipher,
      privateKeyNonce: encryptedPrivateKey.nonce,
      formatVersion: 1
    },
    opened: {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      sharingKeyVersion
    }
  };
}

export async function openUserSharingKey(input: {
  rootKey: Uint8Array;
  envelope: SharingKeyEnvelope;
}): Promise<OpenedSharingKey> {
  const privateKey = await decryptBytes(
    {
      cipher: input.envelope.encryptedPrivateKey,
      nonce: input.envelope.privateKeyNonce,
      formatVersion: input.envelope.formatVersion
    },
    input.rootKey,
    SHARING_PRIVATE_KEY_AAD
  );

  return {
    publicKey: input.envelope.publicKey,
    privateKey: toBase64(privateKey),
    sharingKeyVersion: input.envelope.sharingKeyVersion
  };
}

export async function encryptNoteKeyShare(input: {
  noteKeyBase64: string;
  recipientPublicKey: string;
}): Promise<string> {
  return sealBytes(fromBase64(input.noteKeyBase64), input.recipientPublicKey);
}

export async function decryptNoteKeyShare(input: {
  encryptedNoteKey: string;
  publicKey: string;
  privateKey: string;
}): Promise<string> {
  const noteKey = await openSealedBytes({
    cipher: input.encryptedNoteKey,
    publicKey: input.publicKey,
    privateKey: input.privateKey
  });
  return toBase64(noteKey);
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

type CrdtAadInput = {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  updateId: string;
  formatVersion: number;
} & (
  | { type: "crdt-update" }
  | { type: "crdt-checkpoint"; compactedUpdateIds: string[] }
);

export async function encryptCrdtMessage(input: CrdtAadInput & {
  noteKeyBase64: string;
  update: Uint8Array;
}) {
  return encryptBytes(
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
  return input.type === "crdt-checkpoint"
    ? crdtCheckpointAssociatedData(input)
    : crdtUpdateAssociatedData(input);
}

export function noteKeyToBase64(noteKey: Uint8Array): string {
  return toBase64(noteKey);
}

export async function rotateNoteKeyMaterial(input: {
  cryptoOwnerId: string;
  noteId: string;
  rootKey: Uint8Array;
  body: string;
}): Promise<RotatedNoteKeyMaterial> {
  const noteKey = randomBytes(32);
  const encryptedNoteKey = await encryptBytes(
    noteKey,
    input.rootKey,
    noteKeyAad(input.cryptoOwnerId, input.noteId)
  );
  const encryptedBody = await encryptBytes(
    utf8(input.body),
    noteKey,
    noteBodyAad(input.cryptoOwnerId, input.noteId)
  );

  return {
    contentCipher: encryptedBody.cipher,
    contentLength: encryptedBody.cipher.length,
    contentNonce: encryptedBody.nonce,
    encryptedNoteKey: encryptedNoteKey.cipher,
    noteKeyBase64: toBase64(noteKey),
    noteKeyNonce: encryptedNoteKey.nonce
  };
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

  return {
    id,
    filename: input.file.name,
    mimeType: input.file.type || "application/octet-stream",
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
