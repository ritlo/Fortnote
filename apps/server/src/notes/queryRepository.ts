export interface NoteQueryRecord {
  id: string;
  folderId: string | null;
  titleCipher: string;
  titleNonce: string;
  titleFormatVersion: number;
  encryptedNoteKey: string | null;
  noteKeyNonce: string | null;
  noteKeyFormatVersion: number | null;
  version: number;
  rootVersion: number;
  rootSectionId: string;
  keyEpoch: number;
  isDeleted: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  ownerUserId: string;
  cryptoOwnerId: string;
  role: string;
}

export interface NoteMembershipRecord {
  userId: string;
  username: string;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteKeyShareRecord {
  noteId: string;
  recipientUserId: string;
  senderUserId: string;
  sharingKeyVersion: number;
  encryptedNoteKey: string;
  formatVersion: number;
  createdAt: string;
}

export interface NoteEpochLinkRecord {
  sourceEpoch: number;
  targetEpoch: number;
  previousKeyCipher: string;
  nonce: string;
  formatVersion: number;
  createdAt: string;
}

export interface NoteQueryRepository {
  list(userId: string, includeDeleted: boolean): Promise<NoteQueryRecord[]>;
  find(noteId: string, userId: string): Promise<NoteQueryRecord | null>;
  memberships(noteId: string): Promise<NoteMembershipRecord[]>;
  keyShare(noteId: string, recipientUserId: string): Promise<NoteKeyShareRecord | null>;
  epochLinks(noteId: string): Promise<NoteEpochLinkRecord[]>;
}
