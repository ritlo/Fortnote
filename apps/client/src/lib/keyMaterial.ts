import type {
  AuthKdfResponse,
  KeyMaterialResponse,
  NoteSummary,
  RecoveryParamsResponse,
  User
} from "../api";
import { fromBase64 } from "@fortnote/shared";
import {
  decryptLegacyNoteKey,
  decryptNoteBodyWithKey,
  decryptNoteKeyEnvelopeV2,
  decryptNoteKeyShare,
  decryptNoteKeyShareV2,
  decryptNoteTitleV2,
  noteKeyToBase64,
  openUserSharingKey,
  type OpenedSharingKey
} from "../cryptoClient";
import { getNoteKeyShare, getSharingKeyVersion } from "../api";
import type { DecryptedNote } from "../store/appStore";

export async function decryptNoteSummary(
  user: User,
  rootKey: Uint8Array,
  note: NoteSummary,
  openedSharingKey: OpenedSharingKey | null = null
): Promise<DecryptedNote> {
  const decrypted =
    note.role === "owner"
      ? await decryptOwnedNote(user, rootKey, note)
      : await decryptSharedNote(rootKey, note, openedSharingKey);

  const title = await decryptNoteTitle(note, decrypted.noteKey);
  return {
    id: note.id,
    folderId: note.folderId,
    title,
    body: decrypted.body,
    noteKeyBase64: decrypted.noteKeyBase64,
    contentLength: note.contentLength,
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
  rootKey: Uint8Array,
  note: NoteSummary,
  openedSharingKey: OpenedSharingKey | null
): Promise<{ body: string; noteKey: Uint8Array; noteKeyBase64: string }> {
  const keyShare = await getNoteKeyShare(note.id);
  const sharingKey =
    openedSharingKey?.sharingKeyVersion === keyShare.sharingKeyVersion
      ? openedSharingKey
      : await openUserSharingKey({
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
