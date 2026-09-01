import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

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

export class SqliteAttachmentMetadataRepository
  implements AttachmentMetadataRepository
{
  constructor(private readonly orm: BetterSQLite3Database<typeof schema>) {}

  find(attachmentId: string): Promise<AttachmentRecord | undefined> {
    const row = this.orm
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId))
      .get();
    return Promise.resolve(row);
  }

  list(noteId: string): Promise<AttachmentListRecord[]> {
    const rows = this.orm
      .select({
        id: schema.attachments.id,
        filename: schema.attachments.filename,
        mimeType: schema.attachments.mimeType,
        metadataCipher: schema.attachments.metadataCipher,
        metadataNonce: schema.attachments.metadataNonce,
        metadataFormatVersion: schema.attachments.metadataFormatVersion,
        keyEpoch: schema.attachments.keyEpoch,
        size: schema.attachments.size,
        encryptedAttachmentKey: schema.attachments.encryptedAttachmentKey,
        attachmentKeyNonce: schema.attachments.attachmentKeyNonce,
        fileNonce: schema.attachments.fileNonce,
        createdAt: schema.attachments.createdAt
      })
      .from(schema.attachments)
      .where(eq(schema.attachments.noteId, noteId))
      .orderBy(desc(schema.attachments.createdAt))
      .all();
    return Promise.resolve(rows);
  }
}
