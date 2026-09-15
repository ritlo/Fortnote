export interface FolderNameValues {
  nameCipher: string | null;
  nameNonce: string | null;
  nameFormatVersion: number | null;
}

export interface FolderRecord extends FolderNameValues {
  id: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FolderMutationInput extends FolderNameValues {
  folderId: string;
  userId: string;
  parentFolderId: string | null;
  clientInstanceId?: string;
}

export type FolderMutationOutcome =
  { kind: "saved"; cursor: number } | { kind: "invalid-parent" } | { kind: "not-found" };

export type DeleteFolderOutcome =
  { kind: "deleted"; cursor: number } | { kind: "not-found" };

export interface FolderRepository {
  list(userId: string): Promise<FolderRecord[]>;
  create(input: FolderMutationInput): Promise<FolderMutationOutcome>;
  update(input: FolderMutationInput): Promise<FolderMutationOutcome>;
  delete(
    folderId: string,
    userId: string,
    clientInstanceId?: string
  ): Promise<DeleteFolderOutcome>;
}
