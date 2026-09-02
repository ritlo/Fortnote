import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "./events.js";

interface NoteMutationInput {
  noteId: string;
  actorUserId: string;
  clientInstanceId?: string;
}

export interface CreateNoteInput extends NoteMutationInput {
  folderId: string | null;
  title: string;
  titleCipher: string | null;
  titleNonce: string | null;
  titleFormatVersion: number | null;
  encryptedNoteKey: string;
  noteKeyNonce: string;
  noteKeyFormatVersion: number;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
  rootSectionId: string | null;
}

export type CreateNoteOutcome =
  | { kind: "created"; eventCursor: number }
  | { kind: "invalid-folder" };

export interface ProtectedNoteUpdateInput extends NoteMutationInput {
  expectedRootVersion: number;
  expectedKeyEpoch: number;
  folderId: string | null | undefined;
  titleCipher: string | undefined;
  titleNonce: string | undefined;
  titleFormatVersion: number | undefined;
  encryptedNoteKey: string | undefined;
  noteKeyNonce: string | undefined;
  noteKeyFormatVersion: number | undefined;
  rootSectionId: string | undefined;
}

export type ProtectedNoteUpdateOutcome =
  | {
      kind: "saved";
      eventCursor: number;
      rootVersion: number;
      keyEpoch: number;
      updatedAt: string;
    }
  | { kind: "not-found" }
  | { kind: "invalid-folder" }
  | { kind: "conflict" };

export interface LegacyNoteUpdateInput extends NoteMutationInput {
  expectedVersion: number;
  folderId: string | null | undefined;
  title: string | undefined;
  contentCipher: string;
  contentNonce: string;
  contentLength: number;
}

export type LegacyNoteUpdateOutcome =
  | {
      kind: "saved";
      eventCursor: number;
      version: number;
      updatedAt: string;
    }
  | { kind: "not-found" }
  | { kind: "deleted" }
  | { kind: "conflict" }
  | { kind: "shared-folder" }
  | { kind: "invalid-folder" };

export interface NoteMutationRepository {
  create(input: CreateNoteInput): Promise<CreateNoteOutcome>;
  updateProtected(
    input: ProtectedNoteUpdateInput
  ): Promise<ProtectedNoteUpdateOutcome>;
  updateLegacy(input: LegacyNoteUpdateInput): Promise<LegacyNoteUpdateOutcome>;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

function validFolder(
  database: Pick<SqliteDatabase, "select">,
  userId: string,
  folderId: string | null
): boolean {
  if (!folderId) {
    return true;
  }
  return Boolean(
    database
      .select({ id: schema.folders.id })
      .from(schema.folders)
      .where(
        and(eq(schema.folders.id, folderId), eq(schema.folders.userId, userId))
      )
      .get()
  );
}

function insertNoteEvent(
  database: Pick<SqliteDatabase, "insert">,
  input: NoteMutationInput & {
    eventType: "note.created" | "note.updated";
    noteVersion: number;
  }
): number {
  return database
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
    .returning({ cursor: schema.noteEvents.cursor })
    .get().cursor;
}

export class SqliteNoteMutationRepository implements NoteMutationRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  create(input: CreateNoteInput): Promise<CreateNoteOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      if (!validFolder(transaction, input.actorUserId, input.folderId)) {
        return { kind: "invalid-folder" } as const;
      }
      transaction
        .insert(schema.notes)
        .values({
          id: input.noteId,
          userId: input.actorUserId,
          cryptoOwnerId: input.actorUserId,
          folderId: input.folderId,
          title: input.title,
          titleCipher: input.titleCipher,
          titleNonce: input.titleNonce,
          titleFormatVersion: input.titleFormatVersion,
          encryptedNoteKey: input.encryptedNoteKey,
          noteKeyNonce: input.noteKeyNonce,
          noteKeyFormatVersion: input.noteKeyFormatVersion,
          contentCipher: input.contentCipher,
          contentNonce: input.contentNonce,
          contentLength: input.contentLength,
          rootSectionId: input.rootSectionId,
          contentUpdatedAt: sql`CURRENT_TIMESTAMP`
        })
        .run();
      if (input.rootSectionId) {
        transaction
          .insert(schema.noteSections)
          .values({
            id: input.rootSectionId,
            noteId: input.noteId,
            createdEpoch: 1
          })
          .run();
      }
      transaction
        .insert(schema.noteMemberships)
        .values({
          noteId: input.noteId,
          userId: input.actorUserId,
          role: "owner",
          status: "active"
        })
        .run();
      const eventCursor = insertNoteEvent(transaction, {
        noteId: input.noteId,
        actorUserId: input.actorUserId,
        eventType: "note.created",
        noteVersion: 1,
        ...(input.clientInstanceId
          ? { clientInstanceId: input.clientInstanceId }
          : {})
      });
      return { kind: "created", eventCursor } as const;
    });
    return Promise.resolve(outcome);
  }

  updateProtected(
    input: ProtectedNoteUpdateInput
  ): Promise<ProtectedNoteUpdateOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const current = transaction
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
        .get();
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
        !validFolder(transaction, input.actorUserId, folderId)
      ) {
        return { kind: "invalid-folder" } as const;
      }

      const updated = transaction
        .update(schema.notes)
        .set({
          folderId,
          title: input.titleCipher ? "" : undefined,
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
        .run();
      if (updated.changes !== 1) {
        return { kind: "conflict" } as const;
      }
      if (input.rootSectionId) {
        transaction
          .insert(schema.noteSections)
          .values({
            id: input.rootSectionId,
            noteId: current.noteId,
            createdEpoch: current.keyEpoch
          })
          .onConflictDoNothing()
          .run();
      }
      const rootVersion = current.rootVersion + 1;
      const eventCursor = insertNoteEvent(transaction, {
        noteId: current.noteId,
        actorUserId: input.actorUserId,
        eventType: "note.updated",
        noteVersion: rootVersion,
        ...(input.clientInstanceId
          ? { clientInstanceId: input.clientInstanceId }
          : {})
      });
      const saved = transaction
        .select({ updatedAt: schema.notes.updatedAt })
        .from(schema.notes)
        .where(eq(schema.notes.id, current.noteId))
        .get();
      if (!saved) {
        throw new Error("Protected note disappeared after update");
      }
      return {
        kind: "saved",
        eventCursor,
        rootVersion,
        keyEpoch: current.keyEpoch,
        updatedAt: saved.updatedAt
      } as const;
    });
    return Promise.resolve(outcome);
  }

  updateLegacy(input: LegacyNoteUpdateInput): Promise<LegacyNoteUpdateOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const current = transaction
        .select({
          noteId: schema.notes.id,
          folderId: schema.notes.folderId,
          version: schema.notes.version,
          isDeleted: schema.notes.isDeleted,
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
        .get();
      if (
        current?.status !== "active" ||
        (current.role !== "owner" && current.role !== "editor")
      ) {
        return { kind: "not-found" } as const;
      }
      if (current.isDeleted) {
        return { kind: "deleted" } as const;
      }
      if (current.version !== input.expectedVersion) {
        return { kind: "conflict" } as const;
      }
      const folderId = input.folderId ?? current.folderId;
      if (
        current.role !== "owner" &&
        input.folderId !== undefined &&
        input.folderId !== current.folderId
      ) {
        return { kind: "shared-folder" } as const;
      }
      if (
        current.role === "owner" &&
        !validFolder(transaction, input.actorUserId, folderId)
      ) {
        return { kind: "invalid-folder" } as const;
      }

      const updated = transaction
        .update(schema.notes)
        .set({
          folderId,
          title: input.title,
          contentCipher: input.contentCipher,
          contentNonce: input.contentNonce,
          contentLength: input.contentLength,
          contentUpdatedAt: sql`CURRENT_TIMESTAMP`,
          version: sql`${schema.notes.version} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.notes.id, current.noteId),
            eq(schema.notes.version, input.expectedVersion)
          )
        )
        .run();
      if (updated.changes !== 1) {
        return { kind: "conflict" } as const;
      }
      const version = current.version + 1;
      const eventCursor = insertNoteEvent(transaction, {
        noteId: current.noteId,
        actorUserId: input.actorUserId,
        eventType: "note.updated",
        noteVersion: version,
        ...(input.clientInstanceId
          ? { clientInstanceId: input.clientInstanceId }
          : {})
      });
      const saved = transaction
        .select({ updatedAt: schema.notes.updatedAt })
        .from(schema.notes)
        .where(eq(schema.notes.id, current.noteId))
        .get();
      if (!saved) {
        throw new Error("Legacy note disappeared after update");
      }
      return {
        kind: "saved",
        eventCursor,
        version,
        updatedAt: saved.updatedAt
      } as const;
    });
    return Promise.resolve(outcome);
  }
}
