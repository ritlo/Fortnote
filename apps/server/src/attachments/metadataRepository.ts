export interface AttachmentRecord {
  id: string;
  noteId: string;
  userId: string;
  metadataCipher: string;
  metadataNonce: string;
  metadataFormatVersion: number;
  keyEpoch: number;
  size: number;
  encryptedAttachmentKey: string;
  attachmentKeyNonce: string;
  storageKey: string;
  fileNonce: string;
  createdAt: string;
}

export type AttachmentListRecord = Omit<
  AttachmentRecord,
  "noteId" | "storageKey" | "userId"
>;

export interface AttachmentMetadataRepository {
  find(attachmentId: string): Promise<AttachmentRecord | undefined>;
  list(noteId: string): Promise<AttachmentListRecord[]>;
}
