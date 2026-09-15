import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "../notes/events.js";
import type {
  DeleteFolderOutcome,
  FolderMutationInput,
  FolderMutationOutcome,
  FolderRecord,
  FolderRepository
} from "./repository.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

async function validParent(
  database: Pick<PostgresDatabase, "select">,
  userId: string,
  parentFolderId: string | null,
  ownFolderId?: string
): Promise<boolean> {
  if (!parentFolderId) {
    return true;
  }
  if (parentFolderId === ownFolderId) {
    return false;
  }
  const rows = await database
    .select({
      userId: schema.folders.userId,
      parentFolderId: schema.folders.parentFolderId
    })
    .from(schema.folders)
    .where(eq(schema.folders.id, parentFolderId))
    .limit(1)
    .for("key share");
  return rows[0]?.userId === userId && rows[0].parentFolderId === null;
}

async function insertFolderEvent(
  database: Pick<PostgresDatabase, "insert">,
  input: {
    eventType: "folder.created" | "folder.updated" | "folder.deleted";
    folderId: string;
    userId: string;
    parentFolderId?: string | null;
    clientInstanceId?: string;
  }
): Promise<number> {
  const events = await database
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
    .returning({ cursor: schema.noteEvents.cursor });
  const event = events[0];
  if (!event) {
    throw new Error("Folder event insert did not return a cursor");
  }
  return event.cursor;
}

export class PostgresFolderRepository implements FolderRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  list(userId: string): Promise<FolderRecord[]> {
    return this.orm
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
      .orderBy(sql`${schema.folders.parentFolderId} IS NOT NULL`, schema.folders.id);
  }

  create(input: FolderMutationInput): Promise<FolderMutationOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (!(await validParent(transaction, input.userId, input.parentFolderId))) {
        return { kind: "invalid-parent" as const };
      }
      await transaction.insert(schema.folders).values({
        id: input.folderId,
        userId: input.userId,
        name: input.name,
        nameCipher: input.nameCipher,
        nameNonce: input.nameNonce,
        nameFormatVersion: input.nameFormatVersion,
        parentFolderId: input.parentFolderId
      });
      const cursor = await insertFolderEvent(transaction, {
        eventType: "folder.created",
        folderId: input.folderId,
        userId: input.userId,
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {})
      });
      return { kind: "saved" as const, cursor };
    });
  }

  update(input: FolderMutationInput): Promise<FolderMutationOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (
        !(await validParent(
          transaction,
          input.userId,
          input.parentFolderId,
          input.folderId
        ))
      ) {
        return { kind: "invalid-parent" as const };
      }
      const updated = await transaction
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
        .returning({ id: schema.folders.id });
      if (updated.length !== 1) {
        return { kind: "not-found" as const };
      }
      const cursor = await insertFolderEvent(transaction, {
        eventType: "folder.updated",
        folderId: input.folderId,
        userId: input.userId,
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {})
      });
      return { kind: "saved" as const, cursor };
    });
  }

  delete(
    folderId: string,
    userId: string,
    clientInstanceId?: string
  ): Promise<DeleteFolderOutcome> {
    return this.orm.transaction(async (transaction) => {
      const folders = await transaction
        .select({ parentFolderId: schema.folders.parentFolderId })
        .from(schema.folders)
        .where(and(eq(schema.folders.id, folderId), eq(schema.folders.userId, userId)))
        .limit(1)
        .for("update");
      const folder = folders[0];
      if (!folder) {
        return { kind: "not-found" as const };
      }
      await transaction
        .delete(schema.folders)
        .where(and(eq(schema.folders.id, folderId), eq(schema.folders.userId, userId)));
      const cursor = await insertFolderEvent(transaction, {
        eventType: "folder.deleted",
        folderId,
        userId,
        parentFolderId: folder.parentFolderId,
        ...(clientInstanceId ? { clientInstanceId } : {})
      });
      return { kind: "deleted" as const, cursor };
    });
  }
}
