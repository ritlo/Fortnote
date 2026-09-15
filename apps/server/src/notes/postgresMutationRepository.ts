import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "./events.js";
import type {
  CreateNoteInput,
  CreateNoteOutcome,
  NoteMutationRepository,
  ProtectedNoteUpdateInput,
  ProtectedNoteUpdateOutcome
} from "./mutationRepository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

async function validFolder(
  database: Pick<PostgresDatabase, "select">,
  userId: string,
  folderId: string | null
): Promise<boolean> {
  if (!folderId) {
    return true;
  }
  const folders = await database
    .select({ id: schema.folders.id })
    .from(schema.folders)
    .where(and(eq(schema.folders.id, folderId), eq(schema.folders.userId, userId)))
    .limit(1)
    .for("key share");
  return Boolean(folders[0]);
}

async function insertNoteEvent(
  database: Pick<PostgresDatabase, "insert">,
  input: {
    noteId: string;
    actorUserId: string;
    eventType: "note.created" | "note.updated";
    noteVersion: number;
    clientInstanceId?: string;
  }
): Promise<number> {
  const events = await database
    .insert(schema.noteEvents)
    .values({
      eventId: randomUUID(),
      resourceType: "note",
      resourceId: input.noteId,
      noteId: input.noteId,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      noteVersion: input.noteVersion,
      payloadMetadata: serializedEventMetadata(undefined, input.clientInstanceId)
    })
    .returning({ cursor: schema.noteEvents.cursor });
  const event = events[0];
  if (!event) {
    throw new Error("Note mutation event insert did not return a cursor");
  }
  return event.cursor;
}

export class PostgresNoteMutationRepository implements NoteMutationRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  create(input: CreateNoteInput): Promise<CreateNoteOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (!(await validFolder(transaction, input.actorUserId, input.folderId))) {
        return { kind: "invalid-folder" } as const;
      }
      await transaction.insert(schema.notes).values({
        id: input.noteId,
        userId: input.actorUserId,
        cryptoOwnerId: input.actorUserId,
        folderId: input.folderId,
        title: "",
        titleCipher: input.titleCipher,
        titleNonce: input.titleNonce,
        titleFormatVersion: input.titleFormatVersion,
        encryptedNoteKey: input.encryptedNoteKey,
        noteKeyNonce: input.noteKeyNonce,
        noteKeyFormatVersion: input.noteKeyFormatVersion,
        contentCipher: "",
        contentNonce: "",
        contentLength: 0,
        rootSectionId: input.rootSectionId,
        contentUpdatedAt: sql`CURRENT_TIMESTAMP`
      });
      await transaction.insert(schema.noteSections).values({
        id: input.rootSectionId,
        noteId: input.noteId,
        createdEpoch: 1
      });
      await transaction.insert(schema.noteMemberships).values({
        noteId: input.noteId,
        userId: input.actorUserId,
        role: "owner",
        status: "active"
      });
      const eventCursor = await insertNoteEvent(transaction, {
        noteId: input.noteId,
        actorUserId: input.actorUserId,
        eventType: "note.created",
        noteVersion: 1,
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {})
      });
      return { kind: "created", eventCursor } as const;
    });
  }

  updateProtected(input: ProtectedNoteUpdateInput): Promise<ProtectedNoteUpdateOutcome> {
    return this.orm.transaction(async (transaction) => {
      const currentRows = await transaction
        .select({
          noteId: schema.notes.id,
          folderId: schema.notes.folderId,
          rootSectionId: schema.notes.rootSectionId,
          rootVersion: schema.notes.rootVersion,
          keyEpoch: schema.notes.keyEpoch,
          isDeleted: schema.notes.isDeleted,
          rotationFenced: schema.notes.rotationFenced,
          role: schema.noteMemberships.role,
          status: schema.noteMemberships.status
        })
        .from(schema.notes)
        .innerJoin(
          schema.noteMemberships,
          eq(schema.noteMemberships.noteId, schema.notes.id)
        )
        .where(
          and(
            eq(schema.notes.id, input.noteId),
            eq(schema.noteMemberships.userId, input.actorUserId)
          )
        )
        .limit(1)
        .for("update", { of: [schema.notes, schema.noteMemberships] });
      const current = currentRows[0];
      if (
        current?.status !== "active" ||
        (current.role !== "owner" && current.role !== "editor")
      ) {
        return { kind: "not-found" } as const;
      }
      if (
        current.isDeleted ||
        current.rotationFenced ||
        current.rootVersion !== input.expectedRootVersion ||
        current.keyEpoch !== input.expectedKeyEpoch
      ) {
        return { kind: "conflict" } as const;
      }
      if (
        input.encryptedNoteKey !== undefined &&
        (current.role !== "owner" ||
          (current.rootSectionId !== null &&
            current.rootSectionId !== input.rootSectionId))
      ) {
        return { kind: "conflict" } as const;
      }
      const folderId = input.folderId ?? current.folderId;
      if (
        current.role !== "owner" &&
        input.folderId !== undefined &&
        input.folderId !== current.folderId
      ) {
        return { kind: "invalid-folder" } as const;
      }
      if (
        current.role === "owner" &&
        !(await validFolder(transaction, input.actorUserId, folderId))
      ) {
        return { kind: "invalid-folder" } as const;
      }

      const updated = await transaction
        .update(schema.notes)
        .set({
          folderId,
          titleCipher: input.titleCipher,
          titleNonce: input.titleNonce,
          titleFormatVersion: input.titleFormatVersion,
          encryptedNoteKey: input.encryptedNoteKey,
          noteKeyNonce: input.noteKeyNonce,
          noteKeyFormatVersion: input.noteKeyFormatVersion,
          rootSectionId: input.rootSectionId,
          rootVersion: sql`${schema.notes.rootVersion} + 1`,
          version: sql`${schema.notes.version} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.notes.id, current.noteId),
            eq(schema.notes.rootVersion, input.expectedRootVersion),
            eq(schema.notes.keyEpoch, input.expectedKeyEpoch),
            eq(schema.notes.rotationFenced, false)
          )
        )
        .returning({ updatedAt: schema.notes.updatedAt });
      const saved = updated[0];
      if (!saved) {
        return { kind: "conflict" } as const;
      }
      if (input.rootSectionId) {
        await transaction
          .insert(schema.noteSections)
          .values({
            id: input.rootSectionId,
            noteId: current.noteId,
            createdEpoch: current.keyEpoch
          })
          .onConflictDoNothing();
      }
      const rootVersion = current.rootVersion + 1;
      const eventCursor = await insertNoteEvent(transaction, {
        noteId: current.noteId,
        actorUserId: input.actorUserId,
        eventType: "note.updated",
        noteVersion: rootVersion,
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {})
      });
      return {
        kind: "saved",
        eventCursor,
        rootVersion,
        keyEpoch: current.keyEpoch,
        updatedAt: saved.updatedAt
      } as const;
    });
  }
}
