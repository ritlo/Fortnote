export interface RotatedNoteKeyShare {
  recipientUserId: string;
  sharingKeyVersion: number;
  encryptedNoteKey: string;
  formatVersion: number;
}

export interface RotatedAttachmentKey {
  attachmentId: string;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
}

interface RotationInput {
  noteId: string;
  actorUserId: string;
  clientInstanceId?: string;
}

export interface LinkedNoteRotationInput extends RotationInput {
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

export interface LegacyNoteRotationInput extends RotationInput {
  encryptedNoteKey: string;
  noteKeyNonce: string;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  version: number;
  shares: RotatedNoteKeyShare[];
  attachmentKeys: RotatedAttachmentKey[];
}

export type LegacyNoteRotationOutcome =
  | {
      kind: "rotated";
      eventCursor: number;
      version: number;
      keyEpoch: number;
    }
  | { kind: "not-found" }
  | { kind: "deleted" }
  | { kind: "conflict" }
  | { kind: "invalid-members" }
  | { kind: "invalid-sharing-key" }
  | { kind: "invalid-attachments" };

export interface NoteRotationRepository {
  rotateLinked(input: LinkedNoteRotationInput): Promise<LinkedNoteRotationOutcome>;
  rotateLegacy(input: LegacyNoteRotationInput): Promise<LegacyNoteRotationOutcome>;
}
