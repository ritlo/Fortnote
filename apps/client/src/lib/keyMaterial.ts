import type {
  AuthKdfResponse,
  KeyMaterialResponse,
  NoteSummary,
  RecoveryParamsResponse,
  User
} from "../api";
import { decryptNote, noteKeyToBase64 } from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";

export async function decryptNoteSummary(
  user: User,
  rootKey: Uint8Array,
  note: NoteSummary
): Promise<DecryptedNote> {
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
    id: note.id,
    folderId: note.folderId,
    title: note.title,
    body: decrypted.body,
    noteKeyBase64: noteKeyToBase64(decrypted.noteKey),
    contentLength: note.contentLength,
    version: note.version,
    isDeleted: Boolean(note.isDeleted),
    updatedAt: note.updatedAt
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
