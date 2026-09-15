import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "../notes/events.js";

export interface FolderNameValues {
  name: string;
  nameCipher: string | null;
  nameNonce: string | null;
  nameFormatVersion: number | null;
}

export interface FolderRecord extends FolderNameValues {
  id: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FolderMutationInput extends FolderNameValues {
  folderId: string;
  userId: string;
  parentFolderId: string | null;
  clientInstanceId?: string;
}

export type FolderMutationOutcome =
  { kind: "saved"; cursor: number } | { kind: "invalid-parent" } | { kind: "not-found" };

export type DeleteFolderOutcome =
  { kind: "deleted"; cursor: number } | { kind: "not-found" };

export interface FolderRepository {
  list(userId: string): Promise<FolderRecord[]>;
  create(input: FolderMutationInput): Promise<FolderMutationOutcome>;
  update(input: FolderMutationInput): Promise<FolderMutationOutcome>;
  delete(
    folderId: string,
    userId: string,
    clientInstanceId?: string
  ): Promise<DeleteFolderOutcome>;
}

type SqliteDatabase = BetterSQLite3Database<typeof schema>;

function validParent(
  database: Pick<SqliteDatabase, "select">,
  userId: string,
  parentFolderId: string | null,
  ownFolderId?: string
): boolean {
  if (!parentFolderId) {
    return true;
  }
  if (parentFolderId === ownFolderId) {
    return false;
  }
  const parent = database
    .select({
      userId: schema.folders.userId,
      parentFolderId: schema.folders.parentFolderId
    })
    .from(schema.folders)
    .where(eq(schema.folders.id, parentFolderId))
    .get();
  return parent?.userId === userId && parent.parentFolderId === null;
}

function insertFolderEvent(
  database: Pick<SqliteDatabase, "insert">,
  input: {
    eventType: "folder.created" | "folder.updated" | "folder.deleted";
    folderId: string;
    userId: string;
    parentFolderId?: string | null;
    clientInstanceId?: string;
  }
): number {
  return database
    .insert(schema.noteEvents)
    .values({
      eventId: randomUUID(),
      resourceType: "folder",
      resourceId: input.folderId,
      noteId: null,
      actorUserId: input.userId,
      eventType: input.eventType,
      noteVersion: null,
      payloadMetadata: serializedEventMetadata(
        {
          folderId: input.folderId,
          ...(input.parentFolderId !== undefined
            ? { parentFolderId: input.parentFolderId }
            : {})
        },
        input.clientInstanceId
      )
    })
    .returning({ cursor: schema.noteEvents.cursor })
    .get().cursor;
}

export class SqliteFolderRepository implements FolderRepository {
  constructor(private readonly orm: SqliteDatabase) {}

  list(userId: string): Promise<FolderRecord[]> {
    const rows = this.orm
      .select({
        id: schema.folders.id,
        name: schema.folders.name,
        nameCipher: schema.folders.nameCipher,
        nameNonce: schema.folders.nameNonce,
        nameFormatVersion: schema.folders.nameFormatVersion,
        parentFolderId: schema.folders.parentFolderId,
        createdAt: schema.folders.createdAt,
        updatedAt: schema.folders.updatedAt
      })
      .from(schema.folders)
      .where(eq(schema.folders.userId, userId))
      .orderBy(sql`${schema.folders.parentFolderId} IS NOT NULL`, schema.folders.id)
      .all();
    return Promise.resolve(rows);
  }

  create(input: FolderMutationInput): Promise<FolderMutationOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      if (!validParent(transaction, input.userId, input.parentFolderId)) {
        return { kind: "invalid-parent" as const };
      }
      transaction
        .insert(schema.folders)
        .values({
          id: input.folderId,
          userId: input.userId,
          name: input.name,
          nameCipher: input.nameCipher,
          nameNonce: input.nameNonce,
          nameFormatVersion: input.nameFormatVersion,
          parentFolderId: input.parentFolderId
        })
        .run();
      const cursor = insertFolderEvent(transaction, {
        eventType: "folder.created",
        folderId: input.folderId,
        userId: input.userId,
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {})
      });
      return { kind: "saved" as const, cursor };
    });
    return Promise.resolve(outcome);
  }

  update(input: FolderMutationInput): Promise<FolderMutationOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      if (!validParent(transaction, input.userId, input.parentFolderId, input.folderId)) {
        return { kind: "invalid-parent" as const };
      }
      const updated = transaction
        .update(schema.folders)
        .set({
          name: input.name,
          nameCipher: input.nameCipher,
          nameNonce: input.nameNonce,
          nameFormatVersion: input.nameFormatVersion,
          parentFolderId: input.parentFolderId,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.folders.id, input.folderId),
            eq(schema.folders.userId, input.userId)
          )
        )
        .run();
      if (updated.changes !== 1) {
        return { kind: "not-found" as const };
      }
      const cursor = insertFolderEvent(transaction, {
        eventType: "folder.updated",
        folderId: input.folderId,
        userId: input.userId,
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {})
      });
      return { kind: "saved" as const, cursor };
    });
    return Promise.resolve(outcome);
  }

  delete(
    folderId: string,
    userId: string,
    clientInstanceId?: string
  ): Promise<DeleteFolderOutcome> {
    const outcome = this.orm.transaction((transaction) => {
      const folder = transaction
        .select({ parentFolderId: schema.folders.parentFolderId })
        .from(schema.folders)
        .where(and(eq(schema.folders.id, folderId), eq(schema.folders.userId, userId)))
        .get();
      if (!folder) {
        return { kind: "not-found" as const };
      }
      transaction
        .delete(schema.folders)
        .where(and(eq(schema.folders.id, folderId), eq(schema.folders.userId, userId)))
        .run();
      const cursor = insertFolderEvent(transaction, {
        eventType: "folder.deleted",
        folderId,
        userId,
        parentFolderId: folder.parentFolderId,
        ...(clientInstanceId ? { clientInstanceId } : {})
      });
      return { kind: "deleted" as const, cursor };
    });
    return Promise.resolve(outcome);
  }
}
