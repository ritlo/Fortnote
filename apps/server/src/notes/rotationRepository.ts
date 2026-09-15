export interface RotatedNoteKeyShare {
  recipientUserId: string;
  sharingKeyVersion: number;
  encryptedNoteKey: string;
  formatVersion: number;
}

export interface LinkedNoteRotationInput {
  noteId: string;
  actorUserId: string;
  clientInstanceId?: string;
  revokedUserId: string;
  rootVersion: number;
  sourceEpoch: number;
  targetEpoch: number;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  noteKeyFormatVersion: number;
  titleCipher: string;
  titleNonce: string;
  titleFormatVersion: number;
  previousKeyCipher: string;
  previousKeyNonce: string;
  linkFormatVersion: number;
  shares: RotatedNoteKeyShare[];
}

export type LinkedNoteRotationOutcome =
  | {
      kind: "rotated";
      eventCursor: number;
      version: number;
      rootVersion: number;
      keyEpoch: number;
    }
  | { kind: "not-found" }
  | { kind: "invalid-set" }
  | { kind: "conflict" };

export interface NoteRotationRepository {
  rotateLinked(input: LinkedNoteRotationInput): Promise<LinkedNoteRotationOutcome>;
}
