import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/postgres/schema.js";
import type { NoteAccess } from "./access.js";
import type { NoteAccessRepository } from "./noteAccessRepository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

export class PostgresNoteAccessRepository implements NoteAccessRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  async find(noteId: string, userId: string): Promise<NoteAccess | undefined> {
    const rows = await this.orm
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
      .limit(1);
    return rows[0] as NoteAccess | undefined;
  }
}
