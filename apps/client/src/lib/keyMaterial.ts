import type {
  AuthKdfResponse,
  KeyMaterialResponse,
  NoteSummary,
  RecoveryParamsResponse,
  User
} from "../api";
import {
  decryptNote,
  decryptNoteBodyWithKey,
  decryptNoteKeyShare,
  noteKeyToBase64,
  type OpenedSharingKey
} from "../cryptoClient";
import { getNoteKeyShare } from "../api";
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
      : await decryptSharedNote(note, openedSharingKey);

  return {
    id: note.id,
    folderId: note.folderId,
    title: note.title,
    body: decrypted.body,
    noteKeyBase64: decrypted.noteKeyBase64,
    contentLength: note.contentLength,
    version: note.version,
    isDeleted: Boolean(note.isDeleted),
    updatedAt: note.updatedAt,
    ownerUserId: note.ownerUserId,
    cryptoOwnerId: note.cryptoOwnerId,
    role: note.role
  };
}

async function decryptOwnedNote(
  user: User,
  rootKey: Uint8Array,
  note: NoteSummary
): Promise<{ body: string; noteKeyBase64: string }> {
  if (!note.encryptedNoteKey || !note.noteKeyNonce) {
    throw new Error("Owned note key is missing");
  }

  const decrypted = await decryptNote({
    userId: user.id,
    rootKey,
    noteId: note.id,
    encryptedNoteKey: {
      cipher: note.encryptedNoteKey,
      nonce: note.noteKeyNonce,
      formatVersion: 1
    },
    encryptedBody: {
      cipher: note.contentCipher,
      nonce: note.contentNonce,
      formatVersion: 1
    }
  });
  return {
    body: decrypted.body,
    noteKeyBase64: noteKeyToBase64(decrypted.noteKey)
  };
}

async function decryptSharedNote(
  note: NoteSummary,
  openedSharingKey: OpenedSharingKey | null
): Promise<{ body: string; noteKeyBase64: string }> {
  if (!openedSharingKey) {
    throw new Error("Sharing key is not loaded");
  }

  const keyShare = await getNoteKeyShare(note.id);
  const noteKeyBase64 = await decryptNoteKeyShare({
    encryptedNoteKey: keyShare.encryptedNoteKey,
    publicKey: openedSharingKey.publicKey,
    privateKey: openedSharingKey.privateKey
  });
  const body = await decryptNoteBodyWithKey({
    cryptoOwnerId: note.cryptoOwnerId,
    noteId: note.id,
    noteKeyBase64,
    encryptedBody: {
      cipher: note.contentCipher,
      nonce: note.contentNonce,
      formatVersion: 1
    }
  });

  return {
    body,
    noteKeyBase64
  };
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
