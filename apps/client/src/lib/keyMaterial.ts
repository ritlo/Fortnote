import type {
  AuthKdfResponse,
  KeyMaterialResponse,
  NoteSummary,
  RecoveryParamsResponse,
  User
} from "../api";
import { fromBase64, randomBytes, type KdfParams } from "@fortnote/shared";
import {
  decryptNoteKeyEnvelopeV2,
  decryptNoteKeyShareV2,
  decryptNoteTitleV2,
  createEpochLinkV2,
  encryptNoteKeyEnvelopeV2,
  encryptNoteTitleV2,
  encryptRootKeyEnvelopeV2,
  noteKeyToBase64,
  openUserSharingKey,
  traverseEpochLinksBackward,
  type OpenedSharingKey
} from "../cryptoClient";
import {
  getNoteKeyShare,
  getSharingKeyVersion,
  updateKeyMaterial,
  type NoteEpochLink
} from "../api";
import type { DecryptedNote } from "../store/appStore";

export interface LinkedEpochRotationPreparation {
  noteId: string;
  revokedUserId: string;
  rootVersion: number;
  sourceEpoch: number;
  targetEpoch: number;
  targetNoteKeyBase64: string;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  titleCipher: string;
  titleNonce: string;
  previousKeyCipher: string;
  previousKeyNonce: string;
}

export async function prepareLinkedEpochRotation(input: {
  note: DecryptedNote;
  revokedUserId: string;
  rootKey: Uint8Array;
}): Promise<LinkedEpochRotationPreparation> {
  const sourceNoteKey = fromBase64(input.note.noteKeyBase64);
  const targetNoteKey = randomBytes(32);
  const targetEpoch = input.note.keyEpoch + 1;
  const [ownerEnvelope, titleEnvelope, previousKeyLink] = await Promise.all([
    encryptNoteKeyEnvelopeV2({
      cryptoOwnerId: input.note.cryptoOwnerId,
      noteId: input.note.id,
      keyEpoch: targetEpoch,
      rootKey: input.rootKey,
      noteKey: targetNoteKey
    }),
    encryptNoteTitleV2({
      cryptoOwnerId: input.note.cryptoOwnerId,
      noteId: input.note.id,
      keyEpoch: targetEpoch,
      noteKey: targetNoteKey,
      title: input.note.title
    }),
    createEpochLinkV2({
      cryptoOwnerId: input.note.cryptoOwnerId,
      noteId: input.note.id,
      sourceEpoch: input.note.keyEpoch,
      targetEpoch,
      sourceNoteKey,
      targetNoteKey
    })
  ]);
  return {
    noteId: input.note.id,
    revokedUserId: input.revokedUserId,
    rootVersion: input.note.rootVersion ?? input.note.version,
    sourceEpoch: input.note.keyEpoch,
    targetEpoch,
    targetNoteKeyBase64: noteKeyToBase64(targetNoteKey),
    encryptedNoteKey: ownerEnvelope.cipher,
    noteKeyNonce: ownerEnvelope.nonce,
    titleCipher: titleEnvelope.cipher,
    titleNonce: titleEnvelope.nonce,
    previousKeyCipher: previousKeyLink.cipher,
    previousKeyNonce: previousKeyLink.nonce
  };
}

export function linkedEpochPreparationMatches(input: {
  preparation: LinkedEpochRotationPreparation;
  note: DecryptedNote;
  revokedUserId: string;
}): boolean {
  return (
    input.preparation.noteId === input.note.id &&
    input.preparation.revokedUserId === input.revokedUserId &&
    input.preparation.rootVersion === (input.note.rootVersion ?? input.note.version) &&
    input.preparation.sourceEpoch === input.note.keyEpoch &&
    input.preparation.targetEpoch === input.note.keyEpoch + 1
  );
}

export function resolveNoteKeyAtEpoch(input: {
  note: DecryptedNote;
  targetEpoch: number;
  links: NoteEpochLink[];
}): Promise<Uint8Array> {
  if (input.targetEpoch === input.note.keyEpoch) {
    return Promise.resolve(fromBase64(input.note.noteKeyBase64));
  }
  return traverseEpochLinksBackward({
    cryptoOwnerId: input.note.cryptoOwnerId,
    noteId: input.note.id,
    currentEpoch: input.note.keyEpoch,
    targetEpoch: input.targetEpoch,
    currentNoteKey: fromBase64(input.note.noteKeyBase64),
    links: input.links.map((link) => ({
      sourceEpoch: link.sourceEpoch,
      targetEpoch: link.targetEpoch,
      cipher: link.previousKeyCipher,
      nonce: link.nonce,
      formatVersion: link.formatVersion as 2
    }))
  });
}

export async function migrateRootKeyEnvelopeV2(input: {
  userId: string;
  rootKey: Uint8Array;
  vaultKey: Uint8Array;
  vaultKdf: KdfParams;
  keyMaterialVersion: number;
  rootKeyFormatVersion?: number;
}): Promise<number> {
  if (input.rootKeyFormatVersion === 2) {
    return input.keyMaterialVersion;
  }
  const nextVersion = input.keyMaterialVersion + 1;
  const encrypted = await encryptRootKeyEnvelopeV2({
    userId: input.userId,
    keyMaterialVersion: nextVersion,
    rootKey: input.rootKey,
    wrappingKey: input.vaultKey
  });
  const updated = await updateKeyMaterial({
    encryptedRootKey: encrypted.cipher,
    rootKeyNonce: encrypted.nonce,
    rootKeyFormatVersion: 2,
    rootKeyContextVersion: nextVersion,
    vaultKdf: input.vaultKdf,
    keyMaterialVersion: input.keyMaterialVersion
  });
  return updated.keyMaterialVersion;
}

export async function decryptNoteSummary(
  user: User,
  rootKey: Uint8Array,
  note: NoteSummary,
  openedSharingKey: OpenedSharingKey | null = null
): Promise<DecryptedNote> {
  const noteKey =
    note.role === "owner"
      ? await decryptOwnedNoteKey(rootKey, note)
      : await decryptSharedNoteKey(user, rootKey, note, openedSharingKey);

  return {
    id: note.id,
    folderId: note.folderId,
    title: await decryptNoteTitle(note, noteKey),
    noteKeyBase64: noteKeyToBase64(noteKey),
    contentLength: note.contentLength,
    version: note.version,
    keyEpoch: note.keyEpoch,
    isDeleted: Boolean(note.isDeleted),
    updatedAt: note.updatedAt,
    ownerUserId: note.ownerUserId,
    cryptoOwnerId: note.cryptoOwnerId,
    role: note.role,
    rootVersion: note.rootVersion ?? note.version,
    rootSectionId: note.rootSectionId ?? null
  };
}

function decryptOwnedNoteKey(
  rootKey: Uint8Array,
  note: NoteSummary
): Promise<Uint8Array> {
  if (note.noteKeyFormatVersion !== 2 || !note.encryptedNoteKey || !note.noteKeyNonce) {
    throw new Error("Owned note key is missing");
  }
  return decryptNoteKeyEnvelopeV2({
    cryptoOwnerId: note.cryptoOwnerId,
    noteId: note.id,
    keyEpoch: note.keyEpoch,
    rootKey,
    envelope: {
      cipher: note.encryptedNoteKey,
      nonce: note.noteKeyNonce,
      formatVersion: 2
    }
  });
}

async function decryptSharedNoteKey(
  user: User,
  rootKey: Uint8Array,
  note: NoteSummary,
  openedSharingKey: OpenedSharingKey | null
): Promise<Uint8Array> {
  const keyShare = await getNoteKeyShare(note.id);
  if (keyShare.formatVersion !== 2) {
    throw new Error("Unsupported note key share");
  }
  const sharingKey =
    openedSharingKey?.sharingKeyVersion === keyShare.sharingKeyVersion
      ? openedSharingKey
      : await openUserSharingKey({
          userId: user.id,
          rootKey,
          envelope: await getSharingKeyVersion(keyShare.sharingKeyVersion)
        });
  return decryptNoteKeyShareV2({
    cryptoOwnerId: note.cryptoOwnerId,
    noteId: note.id,
    keyEpoch: note.keyEpoch,
    recipientUserId: keyShare.recipientUserId,
    recipientSharingKeyVersion: keyShare.sharingKeyVersion,
    senderUserId: keyShare.senderUserId,
    encryptedNoteKey: keyShare.encryptedNoteKey,
    publicKey: sharingKey.publicKey,
    privateKey: sharingKey.privateKey
  });
}

function decryptNoteTitle(note: NoteSummary, noteKey: Uint8Array): Promise<string> {
  if (note.titleFormatVersion !== 2 || !note.titleCipher || !note.titleNonce) {
    throw new Error("Protected note title is incomplete");
  }
  return decryptNoteTitleV2({
    cryptoOwnerId: note.cryptoOwnerId,
    noteId: note.id,
    keyEpoch: note.keyEpoch,
    noteKey,
    envelope: {
      cipher: note.titleCipher,
      nonce: note.titleNonce,
      formatVersion: 2
    }
  });
}

export function authKdf(response: AuthKdfResponse) {
  return {
    salt: response.authKdfSalt,
    opsLimit: response.authKdfOpsLimit,
    memLimit: response.authKdfMemLimit,
    version: response.authKdfVersion
  };
}

export function vaultKdf(response: KeyMaterialResponse) {
  return {
    salt: response.kdfSalt,
    opsLimit: response.kdfOpsLimit,
    memLimit: response.kdfMemLimit,
    version: response.kdfVersion
  };
}

export function recoveryKdf(response: RecoveryParamsResponse) {
  return {
    salt: response.recoveryKdfSalt,
    opsLimit: response.recoveryKdfOpsLimit,
    memLimit: response.recoveryKdfMemLimit,
    version: response.recoveryKdfVersion
  };
}
