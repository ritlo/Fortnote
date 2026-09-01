import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { NoteAccess } from "./access.js";

export interface NoteAccessRepository {
  find(noteId: string, userId: string): Promise<NoteAccess | undefined>;
}

export class SqliteNoteAccessRepository implements NoteAccessRepository {
  constructor(private readonly orm: BetterSQLite3Database<typeof schema>) {}

  find(noteId: string, userId: string): Promise<NoteAccess | undefined> {
    const row = this.orm
      .select({
        noteId: schema.notes.id,
        ownerUserId: schema.notes.userId,
        cryptoOwnerId: schema.notes.cryptoOwnerId,
        role: schema.noteMemberships.role,
        status: schema.noteMemberships.status,
        folderId: schema.notes.folderId,
        version: schema.notes.version,
        keyEpoch: schema.notes.keyEpoch,
        isDeleted: schema.notes.isDeleted
      })
      .from(schema.notes)
      .innerJoin(
        schema.noteMemberships,
        eq(schema.noteMemberships.noteId, schema.notes.id)
      )
      .where(and(
        eq(schema.notes.id, noteId),
        eq(schema.noteMemberships.userId, userId)
      ))
      .get() as NoteAccess | undefined;
    return Promise.resolve(row);
  }
}
