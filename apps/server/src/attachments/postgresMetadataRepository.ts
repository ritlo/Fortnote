import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import type {
  AttachmentListRecord,
  AttachmentMetadataRepository,
  AttachmentRecord
} from "./metadataRepository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

export class PostgresAttachmentMetadataRepository implements AttachmentMetadataRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  async find(attachmentId: string): Promise<AttachmentRecord | undefined> {
    const rows = await this.orm
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId))
      .limit(1);
    return rows[0];
  }

  list(noteId: string): Promise<AttachmentListRecord[]> {
    return this.orm
      .select({
        id: schema.attachments.id,
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
      .orderBy(desc(schema.attachments.createdAt));
  }
}
