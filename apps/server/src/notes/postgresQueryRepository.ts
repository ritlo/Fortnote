import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import type {
  LegacyNoteContent,
  NoteEpochLinkRecord,
  NoteKeyShareRecord,
  NoteMembershipRecord,
  NoteQueryRecord,
  NoteQueryRepository
} from "./queryRepository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

const noteSelection = {
  id: schema.notes.id,
  folderId: schema.notes.folderId,
  title: schema.notes.title,
  titleCipher: schema.notes.titleCipher,
  titleNonce: schema.notes.titleNonce,
  titleFormatVersion: schema.notes.titleFormatVersion,
  encryptedNoteKey: sql<
    string | null
  >`CASE WHEN ${schema.noteMemberships.role} = 'owner' THEN ${schema.notes.encryptedNoteKey} ELSE NULL END`,
  noteKeyNonce: sql<
    string | null
  >`CASE WHEN ${schema.noteMemberships.role} = 'owner' THEN ${schema.notes.noteKeyNonce} ELSE NULL END`,
  noteKeyFormatVersion: sql<
    number | null
  >`CASE WHEN ${schema.noteMemberships.role} = 'owner' THEN ${schema.notes.noteKeyFormatVersion} ELSE NULL END`,
  contentLength: schema.notes.contentLength,
  legacyContentAvailable: sql<boolean>`${schema.notes.contentCipher} <> ''`,
  version: schema.notes.version,
  rootVersion: schema.notes.rootVersion,
  rootSectionId: schema.notes.rootSectionId,
  keyEpoch: schema.notes.keyEpoch,
  isDeleted: schema.notes.isDeleted,
  deletedAt: schema.notes.deletedAt,
  createdAt: schema.notes.createdAt,
  updatedAt: schema.notes.updatedAt,
  ownerUserId: schema.notes.userId,
  cryptoOwnerId: schema.notes.cryptoOwnerId,
  role: schema.noteMemberships.role
};

export class PostgresNoteQueryRepository implements NoteQueryRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  list(userId: string, includeDeleted: boolean): Promise<NoteQueryRecord[]> {
    return this.orm
      .select(noteSelection)
      .from(schema.notes)
      .innerJoin(
        schema.noteMemberships,
        eq(schema.noteMemberships.noteId, schema.notes.id)
      )
      .where(
        and(
          eq(schema.noteMemberships.userId, userId),
          eq(schema.noteMemberships.status, "active"),
          eq(schema.notes.isDeleted, includeDeleted)
        )
      )
      .orderBy(desc(schema.notes.updatedAt));
  }

  async find(noteId: string, userId: string): Promise<NoteQueryRecord | null> {
    const rows = await this.orm
      .select(noteSelection)
      .from(schema.notes)
      .innerJoin(
        schema.noteMemberships,
        eq(schema.noteMemberships.noteId, schema.notes.id)
      )
      .where(
        and(
          eq(schema.notes.id, noteId),
          eq(schema.noteMemberships.userId, userId),
          eq(schema.noteMemberships.status, "active")
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async legacyContent(noteId: string): Promise<LegacyNoteContent | null> {
    const rows = await this.orm
      .select({
        contentCipher: schema.notes.contentCipher,
        contentNonce: schema.notes.contentNonce,
        contentLength: schema.notes.contentLength,
        version: schema.notes.version,
        rootVersion: schema.notes.rootVersion,
        keyEpoch: schema.notes.keyEpoch
      })
      .from(schema.notes)
      .where(and(eq(schema.notes.id, noteId), ne(schema.notes.contentCipher, "")))
      .limit(1);
    return rows[0] ?? null;
  }

  memberships(noteId: string): Promise<NoteMembershipRecord[]> {
    return this.orm
      .select({
        userId: schema.noteMemberships.userId,
        username: schema.users.username,
        role: schema.noteMemberships.role,
        status: schema.noteMemberships.status,
        createdAt: schema.noteMemberships.createdAt,
        updatedAt: schema.noteMemberships.updatedAt
      })
      .from(schema.noteMemberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.noteMemberships.userId))
      .where(eq(schema.noteMemberships.noteId, noteId))
      .orderBy(sql`${schema.noteMemberships.role} = 'owner' DESC`, schema.users.username);
  }

  async keyShare(
    noteId: string,
    recipientUserId: string
  ): Promise<NoteKeyShareRecord | null> {
    const rows = await this.orm
      .select()
      .from(schema.noteKeyShares)
      .where(
        and(
          eq(schema.noteKeyShares.noteId, noteId),
          eq(schema.noteKeyShares.recipientUserId, recipientUserId)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  epochLinks(noteId: string): Promise<NoteEpochLinkRecord[]> {
    return this.orm
      .select({
        sourceEpoch: schema.noteEpochLinks.sourceEpoch,
        targetEpoch: schema.noteEpochLinks.targetEpoch,
        previousKeyCipher: schema.noteEpochLinks.previousKeyCipher,
        nonce: schema.noteEpochLinks.nonce,
        formatVersion: schema.noteEpochLinks.formatVersion,
        createdAt: schema.noteEpochLinks.createdAt
      })
      .from(schema.noteEpochLinks)
      .where(eq(schema.noteEpochLinks.noteId, noteId))
      .orderBy(desc(schema.noteEpochLinks.targetEpoch));
  }
}
