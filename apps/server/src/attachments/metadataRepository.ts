export interface AttachmentRecord {
  id: string;
  noteId: string;
  userId: string;
  filename: string;
  mimeType: string;
  metadataCipher: string | null;
  metadataNonce: string | null;
  metadataFormatVersion: number | null;
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
