import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

export interface NoteQueryRecord {
  id: string;
  folderId: string | null;
  title: string;
  titleCipher: string | null;
  titleNonce: string | null;
  titleFormatVersion: number | null;
  encryptedNoteKey: string | null;
  noteKeyNonce: string | null;
  noteKeyFormatVersion: number | null;
  contentLength: number;
  legacyContentAvailable: boolean;
  version: number;
  rootVersion: number;
  rootSectionId: string | null;
  keyEpoch: number;
  isDeleted: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  ownerUserId: string;
  cryptoOwnerId: string;
  role: string;
}

export interface LegacyNoteContent {
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  version: number;
  rootVersion: number;
  keyEpoch: number;
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
  legacyContent(noteId: string): Promise<LegacyNoteContent | null>;
  memberships(noteId: string): Promise<NoteMembershipRecord[]>;
  keyShare(noteId: string, recipientUserId: string): Promise<NoteKeyShareRecord | null>;
  epochLinks(noteId: string): Promise<NoteEpochLinkRecord[]>;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

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
  legacyContentAvailable: sql<number>`CASE WHEN ${schema.notes.contentCipher} <> '' THEN 1 ELSE 0 END`,
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

function normalizeNote(
  row: Omit<NoteQueryRecord, "legacyContentAvailable"> & {
    legacyContentAvailable: number;
  }
): NoteQueryRecord {
  return { ...row, legacyContentAvailable: Boolean(row.legacyContentAvailable) };
}

export class SqliteNoteQueryRepository implements NoteQueryRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  list(userId: string, includeDeleted: boolean): Promise<NoteQueryRecord[]> {
    const rows = this.orm
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
      .orderBy(desc(schema.notes.updatedAt))
      .all();
    return Promise.resolve(rows.map(normalizeNote));
  }

  find(noteId: string, userId: string): Promise<NoteQueryRecord | null> {
    const row = this.orm
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
      .get();
    return Promise.resolve(row ? normalizeNote(row) : null);
  }

  legacyContent(noteId: string): Promise<LegacyNoteContent | null> {
    const row = this.orm
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
      .get();
    return Promise.resolve(row ?? null);
  }

  memberships(noteId: string): Promise<NoteMembershipRecord[]> {
    const rows = this.orm
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
      .orderBy(sql`${schema.noteMemberships.role} = 'owner' DESC`, schema.users.username)
      .all();
    return Promise.resolve(rows);
  }

  keyShare(noteId: string, recipientUserId: string): Promise<NoteKeyShareRecord | null> {
    const row = this.orm
      .select()
      .from(schema.noteKeyShares)
      .where(
        and(
          eq(schema.noteKeyShares.noteId, noteId),
          eq(schema.noteKeyShares.recipientUserId, recipientUserId)
        )
      )
      .get();
    return Promise.resolve(row ?? null);
  }

  epochLinks(noteId: string): Promise<NoteEpochLinkRecord[]> {
    const rows = this.orm
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
      .orderBy(desc(schema.noteEpochLinks.targetEpoch))
      .all();
    return Promise.resolve(rows);
  }
}
