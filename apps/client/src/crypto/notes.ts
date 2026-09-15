import { cryptoReady, randomBytes, randomUuid, toBase64 } from "@fortnote/shared";
import { encryptNoteKeyEnvelopeV2, encryptNoteTitleV2 } from "./protected";

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

export function noteKeyToBase64(noteKey: Uint8Array): string {
  return toBase64(noteKey);
}
