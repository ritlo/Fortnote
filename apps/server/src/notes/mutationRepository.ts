interface NoteMutationInput {
  noteId: string;
  actorUserId: string;
  clientInstanceId?: string;
}

export interface CreateNoteInput extends NoteMutationInput {
  folderId: string | null;
  titleCipher: string;
  titleNonce: string;
  titleFormatVersion: number;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  noteKeyFormatVersion: number;
  rootSectionId: string;
}

export type CreateNoteOutcome =
  { kind: "created"; eventCursor: number } | { kind: "invalid-folder" };

export interface ProtectedNoteUpdateInput extends NoteMutationInput {
  expectedRootVersion: number;
  expectedKeyEpoch: number;
  folderId: string | null | undefined;
  titleCipher: string | undefined;
  titleNonce: string | undefined;
  titleFormatVersion: number | undefined;
  encryptedNoteKey: string | undefined;
  noteKeyNonce: string | undefined;
  noteKeyFormatVersion: number | undefined;
  rootSectionId: string | undefined;
}

export type ProtectedNoteUpdateOutcome =
  | {
      kind: "saved";
      eventCursor: number;
      rootVersion: number;
      keyEpoch: number;
      updatedAt: string;
    }
  | { kind: "not-found" }
  | { kind: "invalid-folder" }
  | { kind: "conflict" };

export interface NoteMutationRepository {
  create(input: CreateNoteInput): Promise<CreateNoteOutcome>;
  updateProtected(input: ProtectedNoteUpdateInput): Promise<ProtectedNoteUpdateOutcome>;
}
