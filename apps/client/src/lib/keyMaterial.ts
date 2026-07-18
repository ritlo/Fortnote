import type {
  AuthKdfResponse,
  KeyMaterialResponse,
  NoteSummary,
  RecoveryParamsResponse,
  User
} from "../api";
import {
  fromBase64,
  randomBytes,
  type KdfParams
} from "@fortnote/shared";
import {
  decryptLegacyNoteKey,
  decryptNoteBodyWithKey,
  decryptNoteKeyEnvelopeV2,
  decryptNoteKeyShare,
  decryptNoteKeyShareV2,
  decryptNoteTitleV2,
  createEpochLinkV2,
  encryptNoteKeyEnvelopeV2,
  encryptNoteTitleV2,
  encryptRootKeyEnvelopeV2,
  encryptSharingPrivateKeyEnvelopeV2,
  noteKeyToBase64,
  openUserSharingKey,
  traverseEpochLinksBackward,
  type OpenedSharingKey
} from "../cryptoClient";
import {
  getNoteKeyShare,
  getSharingKeyVersion,
  updateKeyMaterial,
  type NoteEpochLink,
  type SharingKeyEnvelope,
  type StoreSharingKeyPayload
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
  const decrypted =
    note.role === "owner"
      ? await decryptOwnedNote(user, rootKey, note)
      : await decryptSharedNote(user, rootKey, note, openedSharingKey);

  const title = await decryptNoteTitle(note, decrypted.noteKey);
  return {
    id: note.id,
    folderId: note.folderId,
    title,
    body: decrypted.body,
    noteKeyBase64: decrypted.noteKeyBase64,
    contentLength: note.contentLength,
    legacyContentAvailable: Boolean(note.legacyContentAvailable),
    legacyBodyLoaded: false,
    version: note.version,
    keyEpoch: note.keyEpoch,
    isDeleted: Boolean(note.isDeleted),
    updatedAt: note.updatedAt,
    ownerUserId: note.ownerUserId,
    cryptoOwnerId: note.cryptoOwnerId,
    role: note.role,
    rootVersion: note.rootVersion ?? note.version,
    rootSectionId: note.rootSectionId ?? null,
    metadataMigration:
      note.titleFormatVersion === 2 && note.noteKeyFormatVersion === 2
        ? "current"
        : "write-v2-pending"
  };
}

async function decryptOwnedNote(
  user: User,
  rootKey: Uint8Array,
  note: NoteSummary
): Promise<{ body: string; noteKey: Uint8Array; noteKeyBase64: string }> {
  if (!note.encryptedNoteKey || !note.noteKeyNonce) {
    throw new Error("Owned note key is missing");
  }

  const noteKey =
    note.noteKeyFormatVersion === 2
      ? await decryptNoteKeyEnvelopeV2({
          cryptoOwnerId: note.cryptoOwnerId,
          noteId: note.id,
          keyEpoch: note.keyEpoch,
          rootKey,
          envelope: {
            cipher: note.encryptedNoteKey,
            nonce: note.noteKeyNonce,
            formatVersion: 2
          }
        })
      : await decryptLegacyNoteKey({
          userId: user.id,
          rootKey,
          noteId: note.id,
          encryptedNoteKey: {
            cipher: note.encryptedNoteKey,
            nonce: note.noteKeyNonce,
            formatVersion: 1
          }
        });
  const noteKeyBase64 = noteKeyToBase64(noteKey);
  return {
    body: await decryptLegacyBody(note, noteKeyBase64),
    noteKey,
    noteKeyBase64
  };
}

async function decryptSharedNote(
  user: User,
  rootKey: Uint8Array,
  note: NoteSummary,
  openedSharingKey: OpenedSharingKey | null
): Promise<{ body: string; noteKey: Uint8Array; noteKeyBase64: string }> {
  const keyShare = await getNoteKeyShare(note.id);
  const sharingKey =
    openedSharingKey?.sharingKeyVersion === keyShare.sharingKeyVersion
      ? openedSharingKey
      : await openUserSharingKey({
          userId: user.id,
          rootKey,
          envelope: await getSharingKeyVersion(keyShare.sharingKeyVersion)
        });
  const noteKey =
    keyShare.formatVersion === 2
      ? await decryptNoteKeyShareV2({
          cryptoOwnerId: note.cryptoOwnerId,
          noteId: note.id,
          keyEpoch: note.keyEpoch,
          recipientUserId: keyShare.recipientUserId,
          recipientSharingKeyVersion: keyShare.sharingKeyVersion,
          senderUserId: keyShare.senderUserId,
          encryptedNoteKey: keyShare.encryptedNoteKey,
          publicKey: sharingKey.publicKey,
          privateKey: sharingKey.privateKey
        })
      : fromBase64(
          await decryptNoteKeyShare({
            encryptedNoteKey: keyShare.encryptedNoteKey,
            publicKey: sharingKey.publicKey,
            privateKey: sharingKey.privateKey
          })
        );
  const noteKeyBase64 = noteKeyToBase64(noteKey);

  return {
    body: await decryptLegacyBody(note, noteKeyBase64),
    noteKey,
    noteKeyBase64
  };
}

export async function prepareSharingKeyEnvelopeMigrationV2(input: {
  userId: string;
  rootKey: Uint8Array;
  envelope: SharingKeyEnvelope;
  opened: OpenedSharingKey;
}): Promise<StoreSharingKeyPayload | null> {
  if (input.envelope.formatVersion === 2) {
    return null;
  }
  const encrypted = await encryptSharingPrivateKeyEnvelopeV2({
    userId: input.userId,
    sharingKeyVersion: input.envelope.sharingKeyVersion,
    publicKey: input.envelope.publicKey,
    rootKey: input.rootKey,
    privateKey: fromBase64(input.opened.privateKey)
  });
  return {
    sharingKeyVersion: input.envelope.sharingKeyVersion,
    publicKey: input.envelope.publicKey,
    encryptedPrivateKey: encrypted.cipher,
    privateKeyNonce: encrypted.nonce,
    formatVersion: 2
  };
}

async function decryptNoteTitle(note: NoteSummary, noteKey: Uint8Array): Promise<string> {
  if (note.titleFormatVersion !== 2) {
    return note.title;
  }
  if (!note.titleCipher || !note.titleNonce) {
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

function decryptLegacyBody(note: NoteSummary, noteKeyBase64: string): Promise<string> {
  if (!note.contentCipher || !note.contentNonce) {
    return Promise.resolve("");
  }
  return decryptNoteBodyWithKey({
    cryptoOwnerId: note.cryptoOwnerId,
    noteId: note.id,
    noteKeyBase64,
    encryptedBody: {
      cipher: note.contentCipher,
      nonce: note.contentNonce,
      formatVersion: 1
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
