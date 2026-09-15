interface NoteMutationInput {
  noteId: string;
  actorUserId: string;
  clientInstanceId?: string;
}

export interface CreateNoteInput extends NoteMutationInput {
  folderId: string | null;
  title: string;
  titleCipher: string | null;
  titleNonce: string | null;
  titleFormatVersion: number | null;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  noteKeyFormatVersion: number;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  rootSectionId: string | null;
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

export interface LegacyNoteUpdateInput extends NoteMutationInput {
  expectedVersion: number;
  folderId: string | null | undefined;
  title: string | undefined;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
}

export type LegacyNoteUpdateOutcome =
  | {
      kind: "saved";
      eventCursor: number;
      version: number;
      updatedAt: string;
    }
  | { kind: "not-found" }
  | { kind: "deleted" }
  | { kind: "conflict" }
  | { kind: "shared-folder" }
  | { kind: "invalid-folder" };

export interface NoteMutationRepository {
  create(input: CreateNoteInput): Promise<CreateNoteOutcome>;
  updateProtected(input: ProtectedNoteUpdateInput): Promise<ProtectedNoteUpdateOutcome>;
  updateLegacy(input: LegacyNoteUpdateInput): Promise<LegacyNoteUpdateOutcome>;
}
