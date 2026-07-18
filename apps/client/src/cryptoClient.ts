import {
  associatedDataV2,
  attachmentAssociatedData,
  contentChunkAssociatedData,
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
  encryptBytesV2,
  epochLinkAssociatedData,
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
  vaultKey: Uint8Array;
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

export interface PasswordChangeCrypto {
  authVerifier: string;
  authKdf: KdfParams;
  vaultKdf: KdfParams;
  encryptedRootKey: string;
  rootKeyNonce: string;
  rootKeyFormatVersion: 1 | 2;
  rootKeyContextVersion: number;
}

export interface RecoveryRotationCrypto {
  recoverySecret: string;
  recoveryAuthVerifier: string;
  recoveryKdf: KdfParams;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryRootKeyFormatVersion: 1 | 2;
  recoveryRootKeyContextVersion: number;
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

export type ProtectedEnvelopeV2 = EncryptedPayload & { formatVersion: 2 };

export interface EncryptedAttachmentMetadataV2 extends ProtectedEnvelopeV2 {
  attachmentId: string;
  keyEpoch: number;
}

export interface EncryptedEpochLinkV2 extends ProtectedEnvelopeV2 {
  sourceEpoch: number;
  targetEpoch: number;
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
    vaultKey,
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
  rootKeyNonce: string,
  context?: {
    userId: string;
    formatVersion: number;
    contextVersion: number;
  }
): Promise<OpenedVault> {
  const authVerifier = await deriveAuthVerifier(password, authKdf);
  const vaultKey = await deriveVaultWrappingKey(password, vaultKdf);
  const envelope = {
    cipher: encryptedRootKey,
    nonce: rootKeyNonce,
    formatVersion: context?.formatVersion ?? 1
  };
  const rootKey = context?.formatVersion === 2
    ? await decryptRootKeyEnvelopeV2({
        userId: context.userId,
        keyMaterialVersion: context.contextVersion,
        wrappingKey: vaultKey,
        envelope
      })
    : await decryptBytes(envelope, vaultKey, ROOT_KEY_AAD);

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
  newPassword: string,
  context?: { userId: string; keyMaterialVersion: number }
): Promise<PasswordChangeCrypto> {
  await cryptoReady();
  const authKdf = createKdfParams();
  const vaultKdf = createKdfParams();
  const authVerifier = await deriveAuthVerifier(newPassword, authKdf);
  const vaultKey = await deriveVaultWrappingKey(newPassword, vaultKdf);
  const encryptedRoot = context
    ? await encryptRootKeyEnvelopeV2({
        userId: context.userId,
        keyMaterialVersion: context.keyMaterialVersion,
        rootKey,
        wrappingKey: vaultKey
      })
    : await encryptBytes(rootKey, vaultKey, ROOT_KEY_AAD);

  return {
    authVerifier: toBase64(authVerifier),
    authKdf,
    vaultKdf,
    encryptedRootKey: encryptedRoot.cipher,
    rootKeyNonce: encryptedRoot.nonce,
    rootKeyFormatVersion: context ? 2 : 1,
    rootKeyContextVersion: context?.keyMaterialVersion ?? 1
  };
}

export async function createRecoveryRotationCrypto(
  rootKey: Uint8Array,
  context?: { userId: string; keyMaterialVersion: number }
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
  const recoveryEncryptedRoot = context
    ? await encryptRootKeyEnvelopeV2({
        userId: context.userId,
        keyMaterialVersion: context.keyMaterialVersion,
        rootKey,
        wrappingKey: recoveryWrappingKey
      })
    : await encryptBytes(rootKey, recoveryWrappingKey, ROOT_KEY_AAD);

  return {
    recoverySecret,
    recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
    recoveryKdf,
    recoveryEncryptedRootKey: recoveryEncryptedRoot.cipher,
    recoveryRootKeyNonce: recoveryEncryptedRoot.nonce,
    recoveryRootKeyFormatVersion: context ? 2 : 1,
    recoveryRootKeyContextVersion: context?.keyMaterialVersion ?? 1
  };
}

export async function createAccountRecoveryCrypto(input: {
  recoverySecret: string;
  recoveryKdf: KdfParams;
  recoveryEncryptedRootKey: string;
  recoveryRootKeyNonce: string;
  recoveryRootKeyFormatVersion?: number;
  recoveryRootKeyContextVersion?: number;
  userId?: string;
  nextKeyMaterialVersion?: number;
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
  const recoveryEnvelope = {
    cipher: input.recoveryEncryptedRootKey,
    nonce: input.recoveryRootKeyNonce,
    formatVersion: input.recoveryRootKeyFormatVersion ?? 1
  };
  const rootKey = input.recoveryRootKeyFormatVersion === 2
    ? await decryptRootKeyEnvelopeV2({
        userId: requireEnvelopeUserId(input.userId),
        keyMaterialVersion: requireKeyMaterialVersion(
          input.recoveryRootKeyContextVersion
        ),
        wrappingKey: recoveryWrappingKey,
        envelope: recoveryEnvelope
      })
    : await decryptBytes(recoveryEnvelope, recoveryWrappingKey, ROOT_KEY_AAD);

  return {
    rootKey,
    recoveryAuthVerifier: toBase64(recoveryAuthVerifier),
    passwordChange: await createPasswordChangeCrypto(
      rootKey,
      input.newPassword,
      input.userId && input.nextKeyMaterialVersion
        ? {
            userId: input.userId,
            keyMaterialVersion: input.nextKeyMaterialVersion
          }
        : undefined
    )
  };
}

export async function createUserSharingKey(
  rootKey: Uint8Array,
  sharingKeyVersion = 1,
  userId?: string
): Promise<CreatedSharingKey> {
  const keyPair = await createSharingKeyPair();
  const encryptedPrivateKey = userId
    ? await encryptSharingPrivateKeyEnvelopeV2({
        userId,
        sharingKeyVersion,
        publicKey: keyPair.publicKey,
        rootKey,
        privateKey: fromBase64(keyPair.privateKey)
      })
    : await encryptBytes(
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
      formatVersion: encryptedPrivateKey.formatVersion
    },
    opened: {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      sharingKeyVersion
    }
  };
}

export async function openUserSharingKey(input: {
  userId?: string;
  rootKey: Uint8Array;
  envelope: SharingKeyEnvelope;
}): Promise<OpenedSharingKey> {
  const encryptedPrivateKey = {
    cipher: input.envelope.encryptedPrivateKey,
    nonce: input.envelope.privateKeyNonce,
    formatVersion: input.envelope.formatVersion
  };
  const privateKey = input.envelope.formatVersion === 2
    ? await decryptSharingPrivateKeyEnvelopeV2({
        userId: requireEnvelopeUserId(input.userId),
        sharingKeyVersion: input.envelope.sharingKeyVersion,
        publicKey: input.envelope.publicKey,
        rootKey: input.rootKey,
        envelope: encryptedPrivateKey
      })
    : await decryptBytes(
        encryptedPrivateKey,
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

export function encryptNoteTitleV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  noteKey: Uint8Array;
  title: string;
}): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedTextV2(
    input.title,
    input.noteKey,
    "note-title",
    protectedContext(input, ["cryptoOwnerId", "noteId", "keyEpoch"])
  );
}

export function decryptNoteTitleV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  noteKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<string> {
  return decryptProtectedTextV2(
    input.envelope,
    input.noteKey,
    "note-title",
    protectedContext(input, ["cryptoOwnerId", "noteId", "keyEpoch"])
  );
}

export function encryptFolderNameV2(input: {
  userId: string;
  folderId: string;
  rootKey: Uint8Array;
  name: string;
}): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedTextV2(
    input.name,
    input.rootKey,
    "folder-name",
    protectedContext(input, ["userId", "folderId"])
  );
}

export function decryptFolderNameV2(input: {
  userId: string;
  folderId: string;
  rootKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<string> {
  return decryptProtectedTextV2(
    input.envelope,
    input.rootKey,
    "folder-name",
    protectedContext(input, ["userId", "folderId"])
  );
}

export async function encryptAttachmentMetadataV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  attachmentId: string;
  keyEpoch: number;
  noteKey: Uint8Array;
  filename: string;
  mimeType: string;
}): Promise<EncryptedAttachmentMetadataV2> {
  const envelope = await encryptProtectedJsonV2(
    { filename: input.filename, mimeType: input.mimeType },
    input.noteKey,
    "attachment-metadata",
    protectedContext(input, ["cryptoOwnerId", "noteId", "attachmentId", "keyEpoch"])
  );
  return { ...envelope, attachmentId: input.attachmentId, keyEpoch: input.keyEpoch };
}

export async function decryptAttachmentMetadataV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  attachmentId: string;
  keyEpoch: number;
  noteKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<{ filename: string; mimeType: string }> {
  const value = await decryptProtectedJsonV2(
    input.envelope,
    input.noteKey,
    "attachment-metadata",
    protectedContext(input, ["cryptoOwnerId", "noteId", "attachmentId", "keyEpoch"])
  );
  if (
    !isRecord(value) ||
    typeof value.filename !== "string" ||
    typeof value.mimeType !== "string"
  ) {
    throw new Error("Invalid protected attachment metadata");
  }
  return { filename: value.filename, mimeType: value.mimeType };
}

export function encryptRootKeyEnvelopeV2(input: {
  userId: string;
  keyMaterialVersion: number;
  rootKey: Uint8Array;
  wrappingKey: Uint8Array;
}): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedBytesV2(
    input.rootKey,
    input.wrappingKey,
    "root-key",
    protectedContext(input, ["userId", "keyMaterialVersion"])
  );
}

export function decryptRootKeyEnvelopeV2(input: {
  userId: string;
  keyMaterialVersion: number;
  wrappingKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<Uint8Array> {
  return decryptProtectedBytesV2(
    input.envelope,
    input.wrappingKey,
    "root-key",
    protectedContext(input, ["userId", "keyMaterialVersion"])
  );
}

export function encryptSharingPrivateKeyEnvelopeV2(input: {
  userId: string;
  sharingKeyVersion: number;
  publicKey: string;
  rootKey: Uint8Array;
  privateKey: Uint8Array;
}): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedBytesV2(
    input.privateKey,
    input.rootKey,
    "sharing-private-key",
    protectedContext(input, ["userId", "sharingKeyVersion", "publicKey"])
  );
}

export function decryptSharingPrivateKeyEnvelopeV2(input: {
  userId: string;
  sharingKeyVersion: number;
  publicKey: string;
  rootKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<Uint8Array> {
  return decryptProtectedBytesV2(
    input.envelope,
    input.rootKey,
    "sharing-private-key",
    protectedContext(input, ["userId", "sharingKeyVersion", "publicKey"])
  );
}

function requireEnvelopeUserId(userId: string | undefined): string {
  if (!userId) {
    throw new Error("Protected sharing key account context is missing");
  }
  return userId;
}

function requireKeyMaterialVersion(version: number | undefined): number {
  if (!version) {
    throw new Error("Protected root key material context is missing");
  }
  return version;
}

export function encryptNoteKeyEnvelopeV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  rootKey: Uint8Array;
  noteKey: Uint8Array;
}): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedBytesV2(
    input.noteKey,
    input.rootKey,
    "note-key",
    protectedContext(input, ["cryptoOwnerId", "noteId", "keyEpoch"])
  );
}

export function decryptNoteKeyEnvelopeV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  rootKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<Uint8Array> {
  return decryptProtectedBytesV2(
    input.envelope,
    input.rootKey,
    "note-key",
    protectedContext(input, ["cryptoOwnerId", "noteId", "keyEpoch"])
  );
}

interface NoteShareContextV2 {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  recipientUserId: string;
  recipientSharingKeyVersion: number;
  senderUserId: string;
}

export function encryptNoteKeyShareV2(
  input: NoteShareContextV2 & {
    noteKey: Uint8Array;
    recipientPublicKey: string;
  }
): Promise<string> {
  return sealBytes(
    utf8(
      JSON.stringify({
        formatVersion: 2,
        ...protectedContext(input, [
          "cryptoOwnerId",
          "noteId",
          "keyEpoch",
          "recipientUserId",
          "recipientSharingKeyVersion",
          "senderUserId"
        ]),
        noteKey: toBase64(input.noteKey)
      })
    ),
    input.recipientPublicKey
  );
}

export async function decryptNoteKeyShareV2(
  input: NoteShareContextV2 & {
    encryptedNoteKey: string;
    publicKey: string;
    privateKey: string;
  }
): Promise<Uint8Array> {
  const bytes = await openSealedBytes({
    cipher: input.encryptedNoteKey,
    publicKey: input.publicKey,
    privateKey: input.privateKey
  });
  const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (
    !isRecord(value) ||
    value.formatVersion !== 2 ||
    value.cryptoOwnerId !== input.cryptoOwnerId ||
    value.noteId !== input.noteId ||
    value.keyEpoch !== input.keyEpoch ||
    value.recipientUserId !== input.recipientUserId ||
    value.recipientSharingKeyVersion !== input.recipientSharingKeyVersion ||
    value.senderUserId !== input.senderUserId ||
    typeof value.noteKey !== "string"
  ) {
    throw new Error("Protected note share context mismatch");
  }
  return fromBase64(value.noteKey);
}

export function encryptContentChunkV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  uploadId: string;
  chunkIndex: number;
  chunkCount: number;
  totalCipherBytes: number;
  kind: "update" | "checkpoint" | "root-update";
  noteKey: Uint8Array;
  plaintext: Uint8Array;
}): Promise<ProtectedEnvelopeV2> {
  return encryptBytesV2(
    input.plaintext,
    input.noteKey,
    contentChunkAssociatedData({ ...contentChunkContext(input), formatVersion: 2 })
  ).then(requireV2);
}

export function decryptContentChunkV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  uploadId: string;
  chunkIndex: number;
  chunkCount: number;
  totalCipherBytes: number;
  kind: "update" | "checkpoint" | "root-update";
  noteKey: Uint8Array;
  envelope: EncryptedPayload;
}): Promise<Uint8Array> {
  requireV2(input.envelope);
  return decryptBytes(
    input.envelope,
    input.noteKey,
    contentChunkAssociatedData({ ...contentChunkContext(input), formatVersion: 2 })
  );
}

export async function createEpochLinkV2(input: {
  cryptoOwnerId: string;
  noteId: string;
  sourceEpoch: number;
  targetEpoch: number;
  sourceNoteKey: Uint8Array;
  targetNoteKey: Uint8Array;
}): Promise<EncryptedEpochLinkV2> {
  const context = epochContext(input);
  const envelope = await encryptBytesV2(
    input.sourceNoteKey,
    input.targetNoteKey,
    epochLinkAssociatedData({ ...context, formatVersion: 2 })
  );
  return {
    ...requireV2(envelope),
    sourceEpoch: input.sourceEpoch,
    targetEpoch: input.targetEpoch
  };
}

export async function traverseEpochLinksBackward(input: {
  cryptoOwnerId: string;
  noteId: string;
  currentEpoch: number;
  targetEpoch: number;
  currentNoteKey: Uint8Array;
  links: EncryptedEpochLinkV2[];
}): Promise<Uint8Array> {
  if (input.targetEpoch <= 0 || input.targetEpoch > input.currentEpoch) {
    throw new Error("Invalid target note epoch");
  }
  let epoch = input.currentEpoch;
  let noteKey = input.currentNoteKey;
  while (epoch > input.targetEpoch) {
    const link = input.links.find((candidate) => candidate.targetEpoch === epoch);
    if (link?.sourceEpoch !== epoch - 1) {
      throw new Error("Missing adjacent note epoch link");
    }
    requireV2(link);
    noteKey = await decryptBytes(
      link,
      noteKey,
      epochLinkAssociatedData({
        cryptoOwnerId: input.cryptoOwnerId,
        noteId: input.noteId,
        sourceEpoch: link.sourceEpoch,
        targetEpoch: link.targetEpoch,
        formatVersion: 2
      })
    );
    epoch = link.sourceEpoch;
  }
  return noteKey;
}

function contentChunkContext(input: {
  cryptoOwnerId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  uploadId: string;
  chunkIndex: number;
  chunkCount: number;
  totalCipherBytes: number;
  kind: "update" | "checkpoint" | "root-update";
}) {
  return protectedContext(input, [
    "cryptoOwnerId",
    "noteId",
    "sectionId",
    "keyEpoch",
    "updateId",
    "uploadId",
    "chunkIndex",
    "chunkCount",
    "totalCipherBytes",
    "kind"
  ]) as {
    cryptoOwnerId: string;
    noteId: string;
    sectionId: string;
    keyEpoch: number;
    updateId: string;
    uploadId: string;
    chunkIndex: number;
    chunkCount: number;
    totalCipherBytes: number;
    kind: "update" | "checkpoint" | "root-update";
  };
}

function epochContext(input: {
  cryptoOwnerId: string;
  noteId: string;
  sourceEpoch: number;
  targetEpoch: number;
}) {
  return protectedContext(input, [
    "cryptoOwnerId",
    "noteId",
    "sourceEpoch",
    "targetEpoch"
  ]) as {
    cryptoOwnerId: string;
    noteId: string;
    sourceEpoch: number;
    targetEpoch: number;
  };
}

async function encryptProtectedTextV2(
  value: string,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedBytesV2(utf8(value), key, kind, context);
}

async function decryptProtectedTextV2(
  envelope: EncryptedPayload,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<string> {
  return new TextDecoder().decode(
    await decryptProtectedBytesV2(envelope, key, kind, context)
  );
}

async function encryptProtectedJsonV2(
  value: unknown,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<ProtectedEnvelopeV2> {
  return encryptProtectedTextV2(JSON.stringify(value), key, kind, context);
}

async function decryptProtectedJsonV2(
  envelope: EncryptedPayload,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<unknown> {
  return JSON.parse(await decryptProtectedTextV2(envelope, key, kind, context)) as unknown;
}

async function encryptProtectedBytesV2(
  value: Uint8Array,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<ProtectedEnvelopeV2> {
  const envelope = await encryptBytesV2(value, key, associatedDataV2(kind, context));
  return requireV2(envelope);
}

async function decryptProtectedBytesV2(
  envelope: EncryptedPayload,
  key: Uint8Array,
  kind: string,
  context: Record<string, string | number | boolean>
): Promise<Uint8Array> {
  requireV2(envelope);
  return await decryptBytes(envelope, key, associatedDataV2(kind, context));
}

function requireV2(envelope: EncryptedPayload): ProtectedEnvelopeV2 {
  if (envelope.formatVersion !== 2) {
    throw new Error("Protected envelope downgrade rejected");
  }
  return envelope as ProtectedEnvelopeV2;
}

function protectedContext<T extends object>(
  input: T,
  keys: (keyof T)[]
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    keys.map((key) => {
      const value = input[key];
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error("Invalid protected context");
      }
      return [String(key), value];
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function noteBodyAad(userId: string, noteId: string): Uint8Array {
  return utf8(`fortnote:note-body:v1:${userId}:${noteId}`);
}
