import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import * as schema from "../db/schema.js";
import type { AppContext } from "../http/app.js";
import { sendApiError } from "../http/errors.js";
import { requireSession } from "../auth/session.js";
import { canEditNote, canOwnNote, canReadNote, getNoteAccess } from "./access.js";
import { writeRequestEvent } from "./events.js";
import {
  compareAndSetSectionInitialization,
  createNoteSection,
  listVisibleNoteSections,
  reserveLegacyRootSection,
  tombstoneNoteSection
} from "./sections.js";

const legacyCreateNoteSchema = z.object({
  id: z.uuid(),
  folderId: z.uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  encryptedNoteKey: z.string().min(16),
  noteKeyNonce: z.string().min(16),
  contentCipher: z.string().min(1),
  contentNonce: z.string().min(16),
  contentLength: z.number().int().nonnegative()
});

const protectedCreateNoteSchema = z.object({
  id: z.uuid(),
  folderId: z.uuid().nullable().optional(),
  rootSectionId: z.uuid(),
  titleCipher: z.string().min(1),
  titleNonce: z.string().min(16),
  titleFormatVersion: z.literal(2),
  encryptedNoteKey: z.string().min(16),
  noteKeyNonce: z.string().min(16),
  noteKeyFormatVersion: z.literal(2)
});

const createNoteSchema = z.union([protectedCreateNoteSchema, legacyCreateNoteSchema]);

const legacyUpdateNoteSchema = z.object({
  folderId: z.uuid().nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  contentCipher: z.string().min(1),
  contentNonce: z.string().min(16),
  contentLength: z.number().int().nonnegative(),
  version: z.number().int().positive()
});
const protectedUpdateNoteSchema = z
  .object({
    folderId: z.uuid().nullable().optional(),
    titleCipher: z.string().min(1).optional(),
    titleNonce: z.string().min(16).optional(),
    titleFormatVersion: z.literal(2).optional(),
    encryptedNoteKey: z.string().min(16).optional(),
    noteKeyNonce: z.string().min(16).optional(),
    noteKeyFormatVersion: z.literal(2).optional(),
    rootSectionId: z.uuid().optional(),
    rootVersion: z.number().int().positive(),
    keyEpoch: z.number().int().positive()
  })
  .superRefine((value, context) => {
    const titleFieldCount = [
      value.titleCipher,
      value.titleNonce,
      value.titleFormatVersion
    ].filter((field) => field !== undefined).length;
    if (titleFieldCount !== 0 && titleFieldCount !== 3) {
      context.addIssue({ code: "custom", message: "Incomplete encrypted title" });
    }
    const keyFieldCount = [
      value.encryptedNoteKey,
      value.noteKeyNonce,
      value.noteKeyFormatVersion,
      value.rootSectionId
    ].filter((field) => field !== undefined).length;
    if (keyFieldCount !== 0 && keyFieldCount !== 4) {
      context.addIssue({ code: "custom", message: "Incomplete protected note key" });
    }
  });
const updateNoteSchema = z.union([protectedUpdateNoteSchema, legacyUpdateNoteSchema]);
const legacySectionReservationSchema = z.object({
  sectionId: z.uuid(),
  expectedKeyEpoch: z.number().int().positive(),
  expectedRootVersion: z.number().int().positive()
});
const sectionInitializationSchema = z.object({
  manifestId: z.string().min(1),
  expectedKeyEpoch: z.number().int().positive(),
  expectedRootVersion: z.number().int().positive()
});
const sectionMutationSchema = z.object({
  expectedKeyEpoch: z.number().int().positive(),
  expectedRootVersion: z.number().int().positive()
});
const sectionCreateSchema = sectionMutationSchema.extend({ sectionId: z.uuid() });
const legacyRotateNoteKeySchema = z.object({
  encryptedNoteKey: z.string().min(16),
  noteKeyNonce: z.string().min(16),
  contentCipher: z.string().min(1),
  contentNonce: z.string().min(16),
  contentLength: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  shares: z.array(
    z.object({
      recipientUserId: z.uuid(),
      sharingKeyVersion: z.number().int().positive(),
      encryptedNoteKey: z.string().min(32),
      formatVersion: z.number().int().positive()
    })
  ),
  attachmentKeys: z.array(
    z.object({
      attachmentId: z.uuid(),
      encryptedAttachmentKey: z.string().min(16),
      attachmentKeyNonce: z.string().min(16)
    })
  )
});
const linkedRotateNoteKeySchema = z.object({
  mode: z.literal("linked"),
  revokedUserId: z.uuid(),
  rootVersion: z.number().int().positive(),
  sourceEpoch: z.number().int().positive(),
  targetEpoch: z.number().int().positive(),
  encryptedNoteKey: z.string().min(16),
  noteKeyNonce: z.string().min(16),
  noteKeyFormatVersion: z.literal(2),
  titleCipher: z.string().min(1),
  titleNonce: z.string().min(16),
  titleFormatVersion: z.literal(2),
  previousKeyCipher: z.string().min(16),
  previousKeyNonce: z.string().min(16),
  linkFormatVersion: z.literal(2),
  shares: z.array(
    z.object({
      recipientUserId: z.uuid(),
      sharingKeyVersion: z.number().int().positive(),
      encryptedNoteKey: z.string().min(32),
      formatVersion: z.literal(2)
    })
  )
});
const rotateNoteKeySchema = z.union([
  linkedRotateNoteKeySchema,
  legacyRotateNoteKeySchema
]);

const memberRoleSchema = z.enum(["editor", "viewer"]);

const inviteMemberSchema = z.object({
  username: z.string().min(1).max(64),
  role: memberRoleSchema,
  sharingKeyVersion: z.number().int().positive(),
  encryptedNoteKey: z.string().min(32),
  formatVersion: z.number().int().positive()
});

const updateMemberSchema = z.object({
  role: memberRoleSchema
});

function folderBelongsToUser(
  context: AppContext,
  userId: string,
  folderId: string | null | undefined
): boolean {
  if (!folderId) {
    return true;
  }

  const row = context.db.orm
    .select({ id: schema.folders.id })
    .from(schema.folders)
    .where(and(eq(schema.folders.id, folderId), eq(schema.folders.userId, userId)))
    .get();
  return Boolean(row);
}

function publishEventCursors(context: AppContext, cursors: number[]): void {
  context.realtime?.publishEvents(cursors);
}

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

const noteSelection = {
  id: schema.notes.id,
  folderId: schema.notes.folderId,
  title: schema.notes.title,
  titleCipher: schema.notes.titleCipher,
  titleNonce: schema.notes.titleNonce,
  titleFormatVersion: schema.notes.titleFormatVersion,
  encryptedNoteKey: sql<string | null>`CASE WHEN ${schema.noteMemberships.role} = 'owner' THEN ${schema.notes.encryptedNoteKey} ELSE NULL END`,
  noteKeyNonce: sql<string | null>`CASE WHEN ${schema.noteMemberships.role} = 'owner' THEN ${schema.notes.noteKeyNonce} ELSE NULL END`,
  noteKeyFormatVersion: sql<number | null>`CASE WHEN ${schema.noteMemberships.role} = 'owner' THEN ${schema.notes.noteKeyFormatVersion} ELSE NULL END`,
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

export function createNotesRouter(context: AppContext): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const includeDeleted = request.query.deleted === "true";
    const rows = context.db.orm
      .select(noteSelection)
      .from(schema.notes)
      .innerJoin(
        schema.noteMemberships,
        eq(schema.noteMemberships.noteId, schema.notes.id)
      )
      .where(and(
        eq(schema.noteMemberships.userId, session.userId),
        eq(schema.noteMemberships.status, "active"),
        eq(schema.notes.isDeleted, includeDeleted)
      ))
      .orderBy(desc(schema.notes.updatedAt))
      .all();

    response.json({
      notes: rows.map((row) => ({
        ...row,
        legacyContentAvailable: Boolean(row.legacyContentAvailable)
      }))
    });
  });

  router.post("/", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = createNoteSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid note payload");
      return;
    }

    const folderId = parsed.data.folderId ?? null;
    if (!folderBelongsToUser(context, session.userId, folderId)) {
      sendApiError(response, "bad_request", "Invalid folder");
      return;
    }

    const payload = parsed.data;
    const cursor = context.db.orm.transaction((tx) => {
      tx.insert(schema.notes).values({
        id: payload.id,
        userId: session.userId,
        cryptoOwnerId: session.userId,
        folderId,
        title: "title" in payload ? payload.title : "",
        titleCipher: "titleCipher" in payload ? payload.titleCipher : null,
        titleNonce: "titleCipher" in payload ? payload.titleNonce : null,
        titleFormatVersion: "titleCipher" in payload ? payload.titleFormatVersion : null,
        encryptedNoteKey: payload.encryptedNoteKey,
        noteKeyNonce: payload.noteKeyNonce,
        noteKeyFormatVersion: "titleCipher" in payload ? payload.noteKeyFormatVersion : 1,
        contentCipher: "contentCipher" in payload ? payload.contentCipher : "",
        contentNonce: "contentCipher" in payload ? payload.contentNonce : "",
        contentLength: "contentCipher" in payload ? payload.contentLength : 0,
        rootSectionId: "rootSectionId" in payload ? payload.rootSectionId : null,
        contentUpdatedAt: sql`CURRENT_TIMESTAMP`
      }).run();
      if ("rootSectionId" in payload) {
        tx.insert(schema.noteSections).values({
          id: payload.rootSectionId,
          noteId: payload.id,
          createdEpoch: 1
        }).run();
      }
      tx.insert(schema.noteMemberships).values({
        noteId: parsed.data.id,
        userId: session.userId,
        role: "owner",
        status: "active"
      }).run();
      return writeRequestEvent(context, request, {
        noteId: parsed.data.id,
        actorUserId: session.userId,
        eventType: "note.created",
        noteVersion: 1
      }, tx);
    });
    publishEventCursors(context, [cursor]);

    response.status(201).json({
      id: parsed.data.id,
      version: 1,
      rootVersion: 1,
      keyEpoch: 1,
      rootSectionId: "rootSectionId" in payload ? payload.rootSectionId : null
    });
  });

  router.get("/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const row = context.db.orm
      .select(noteSelection)
      .from(schema.notes)
      .innerJoin(
        schema.noteMemberships,
        eq(schema.noteMemberships.noteId, schema.notes.id)
      )
      .where(and(
        eq(schema.notes.id, request.params.id),
        eq(schema.noteMemberships.userId, session.userId),
        eq(schema.noteMemberships.status, "active")
      ))
      .get();

    if (!row) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    response.json({
      ...row,
      legacyContentAvailable: Boolean(row.legacyContentAvailable)
    });
  });

  router.get("/:id/legacy-content", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    const legacy = context.db.sqlite
      .prepare(`
        SELECT
          content_cipher AS contentCipher,
          content_nonce AS contentNonce,
          content_length AS contentLength,
          version,
          root_version AS rootVersion,
          key_epoch AS keyEpoch
        FROM notes
        WHERE id = ? AND content_cipher <> ''
      `)
      .get(access.noteId) as {
        contentCipher: string;
        contentNonce: string;
        contentLength: number;
        version: number;
        rootVersion: number;
        keyEpoch: number;
      } | undefined;
    if (!legacy) {
      sendApiError(response, "conflict", "Legacy note content is already migrated");
      return;
    }
    response.json(legacy);
  });

  router.post("/:id/sections/legacy-reservation", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const parsed = legacySectionReservationSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid legacy migration reservation");
      return;
    }
    const outcome = reserveLegacyRootSection(context, {
      sessionId: session.id,
      userId: session.userId,
      noteId: request.params.id,
      sectionId: parsed.data.sectionId,
      expectedKeyEpoch: parsed.data.expectedKeyEpoch,
      expectedRootVersion: parsed.data.expectedRootVersion
    });
    if (outcome.status === "rejected") {
      if (outcome.code === "forbidden") {
        sendApiError(response, "not_found", "Note not found");
      } else {
        sendApiError(response, "conflict", legacyMigrationConflict(outcome.code));
      }
      return;
    }
    if (outcome.changed) {
      const eventCursor = context.db.orm.transaction((tx) =>
        writeRequestEvent(context, request, {
          noteId: request.params.id,
          actorUserId: session.userId,
          eventType: "note.updated",
          noteVersion: outcome.version
        }, tx)
      );
      publishEventCursors(context, [eventCursor]);
    }
    response.status(outcome.changed ? 201 : 200).json({
      status: outcome.status,
      sectionId: outcome.sectionId,
      keyEpoch: outcome.keyEpoch,
      rootVersion: outcome.rootVersion,
      version: outcome.version,
      ...(outcome.manifestId ? { manifestId: outcome.manifestId } : {})
    });
  });

  router.post("/:id/sections", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const parsed = sectionCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid section creation");
      return;
    }
    const outcome = createNoteSection(context, {
      sessionId: session.id,
      userId: session.userId,
      noteId: request.params.id,
      sectionId: parsed.data.sectionId,
      expectedKeyEpoch: parsed.data.expectedKeyEpoch,
      expectedRootVersion: parsed.data.expectedRootVersion
    });
    if (outcome.status === "rejected") {
      sendSectionMutationError(response, outcome.code);
      return;
    }
    if (outcome.status === "created") {
      const eventCursor = context.db.orm.transaction((tx) =>
        writeRequestEvent(context, request, {
          noteId: request.params.id,
          actorUserId: session.userId,
          eventType: "section.created",
          noteVersion: outcome.version,
          resourceType: "section",
          resourceId: parsed.data.sectionId
        }, tx)
      );
      publishEventCursors(context, [eventCursor]);
    }
    response.status(outcome.status === "created" ? 201 : 200).json({
      status: outcome.status,
      rootVersion: outcome.rootVersion,
      version: outcome.version,
      section: {
        id: parsed.data.sectionId,
        noteId: request.params.id,
        createdEpoch: parsed.data.expectedKeyEpoch,
        currentSequence: 0,
        initialized: false,
        isDeleted: false
      }
    });
  });

  router.delete("/:id/sections/:sectionId", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const parsed = sectionMutationSchema.safeParse(request.body);
    if (!parsed.success || !z.uuid().safeParse(request.params.sectionId).success) {
      sendApiError(response, "bad_request", "Invalid section deletion");
      return;
    }
    const outcome = tombstoneNoteSection(context, {
      sessionId: session.id,
      userId: session.userId,
      noteId: request.params.id,
      sectionId: request.params.sectionId,
      expectedKeyEpoch: parsed.data.expectedKeyEpoch,
      expectedRootVersion: parsed.data.expectedRootVersion
    });
    if (outcome.status === "rejected") {
      sendSectionMutationError(response, outcome.code);
      return;
    }
    if (outcome.status === "deleted") {
      const eventCursor = context.db.orm.transaction((tx) =>
        writeRequestEvent(context, request, {
          noteId: request.params.id,
          actorUserId: session.userId,
          eventType: "section.deleted",
          noteVersion: outcome.version,
          resourceType: "section",
          resourceId: request.params.sectionId
        }, tx)
      );
      publishEventCursors(context, [eventCursor]);
    }
    response.json({
      status: outcome.status,
      rootVersion: outcome.rootVersion,
      version: outcome.version
    });
  });

  router.post("/:id/sections/:sectionId/initialization", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const parsed = sectionInitializationSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid section initialization");
      return;
    }
    const legacyBefore = context.db.sqlite
      .prepare("SELECT content_cipher <> '' AS available FROM notes WHERE id = ?")
      .get(request.params.id) as { available: number } | undefined;
    const outcome = compareAndSetSectionInitialization(context, {
      sessionId: session.id,
      userId: session.userId,
      noteId: request.params.id,
      sectionId: request.params.sectionId,
      expectedKeyEpoch: parsed.data.expectedKeyEpoch,
      expectedRootVersion: parsed.data.expectedRootVersion,
      manifestId: parsed.data.manifestId
    });
    if (outcome.status === "rejected") {
      if (outcome.code === "forbidden") {
        sendApiError(response, "not_found", "Note not found");
      } else {
        sendApiError(response, "conflict", legacyMigrationConflict(outcome.code));
      }
      return;
    }
    const current = context.db.sqlite
      .prepare(`SELECT root_version AS rootVersion, version FROM notes WHERE id = ?`)
      .get(request.params.id) as { rootVersion: number; version: number };
    if (outcome.status === "installed" || legacyBefore?.available) {
      const eventCursor = context.db.orm.transaction((tx) =>
        writeRequestEvent(context, request, {
          noteId: request.params.id,
          actorUserId: session.userId,
          eventType: "note.updated",
          noteVersion: current.version
        }, tx)
      );
      publishEventCursors(context, [eventCursor]);
    }
    response.json({ ...outcome, ...current });
  });

  router.get("/:id/sections", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    response.json({
      sections: listVisibleNoteSections(context, access.noteId).map((section) => ({
        id: section.id,
        noteId: section.noteId,
        createdEpoch: section.createdEpoch,
        currentSequence: section.currentSequence,
        initialized: section.initializationManifestId !== null,
        isDeleted: Boolean(section.isDeleted)
      }))
    });
  });

  router.get("/:id/memberships", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const rows = context.db.orm
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
      .where(eq(schema.noteMemberships.noteId, access.noteId))
      .orderBy(sql`${schema.noteMemberships.role} = 'owner' DESC`, schema.users.username)
      .all();

    response.json({ memberships: rows });
  });

  router.post("/:id/memberships", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = inviteMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid membership payload");
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const recipient = context.db.orm
      .select({ userId: schema.users.id, username: schema.users.username })
      .from(schema.users)
      .innerJoin(
        schema.userSharingKeys,
        eq(schema.userSharingKeys.userId, schema.users.id)
      )
      .where(and(
        eq(schema.users.username, parsed.data.username),
        eq(schema.userSharingKeys.sharingKeyVersion, parsed.data.sharingKeyVersion)
      ))
      .get();

    if (!recipient) {
      sendApiError(response, "not_found", "Sharing key not found");
      return;
    }
    if (recipient.userId === session.userId) {
      sendApiError(response, "bad_request", "Cannot invite yourself");
      return;
    }

    const existing = context.db.orm
      .select({ role: schema.noteMemberships.role })
      .from(schema.noteMemberships)
      .where(and(
        eq(schema.noteMemberships.noteId, access.noteId),
        eq(schema.noteMemberships.userId, recipient.userId)
      ))
      .get();
    if (existing?.role === "owner") {
      sendApiError(response, "bad_request", "Cannot replace note owner");
      return;
    }

    const cursor = context.db.orm.transaction((tx) => {
      tx.insert(schema.noteMemberships)
        .values({
          noteId: access.noteId,
          userId: recipient.userId,
          role: parsed.data.role,
          status: "active"
        })
        .onConflictDoUpdate({
          target: [schema.noteMemberships.noteId, schema.noteMemberships.userId],
          set: {
            role: parsed.data.role,
            status: "active",
            updatedAt: sql`CURRENT_TIMESTAMP`
          }
        })
        .run();
      tx.insert(schema.noteKeyShares)
        .values({
          noteId: access.noteId,
          recipientUserId: recipient.userId,
          senderUserId: session.userId,
          sharingKeyVersion: parsed.data.sharingKeyVersion,
          encryptedNoteKey: parsed.data.encryptedNoteKey,
          formatVersion: parsed.data.formatVersion
        })
        .onConflictDoUpdate({
          target: [schema.noteKeyShares.noteId, schema.noteKeyShares.recipientUserId],
          set: {
            senderUserId: session.userId,
            sharingKeyVersion: parsed.data.sharingKeyVersion,
            encryptedNoteKey: parsed.data.encryptedNoteKey,
            formatVersion: parsed.data.formatVersion,
            createdAt: sql`CURRENT_TIMESTAMP`
          }
        })
        .run();
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "membership.added",
        noteVersion: access.version,
        resourceType: "membership",
        resourceId: `${access.noteId}:${recipient.userId}`,
        payloadMetadata: {
          membershipUserId: recipient.userId,
          role: parsed.data.role
        }
      }, tx);
    });
    publishEventCursors(context, [cursor]);

    response.status(201).json({
      noteId: access.noteId,
      userId: recipient.userId,
      username: recipient.username,
      role: parsed.data.role,
      status: "active"
    });
  });

  router.patch("/:id/memberships/:userId", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = updateMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid membership payload");
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (request.params.userId === session.userId) {
      sendApiError(response, "bad_request", "Cannot change owner role");
      return;
    }

    const updateCursor = context.db.orm.transaction((tx) => {
      const result = tx.update(schema.noteMemberships)
        .set({ role: parsed.data.role, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(
          eq(schema.noteMemberships.noteId, access.noteId),
          eq(schema.noteMemberships.userId, request.params.userId),
          ne(schema.noteMemberships.role, "owner"),
          eq(schema.noteMemberships.status, "active")
        ))
        .run();
      if (result.changes === 0) {
        return null;
      }
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "membership.role_updated",
        noteVersion: access.version,
        resourceType: "membership",
        resourceId: `${access.noteId}:${request.params.userId}`,
        payloadMetadata: {
          membershipUserId: request.params.userId,
          role: parsed.data.role
        }
      }, tx);
    });
    if (updateCursor === null) {
      sendApiError(response, "not_found", "Membership not found");
      return;
    }
    publishEventCursors(context, [updateCursor]);

    response.json({
      noteId: access.noteId,
      userId: request.params.userId,
      role: parsed.data.role,
      status: "active"
    });
  });

  router.delete("/:id/memberships/:userId", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (request.params.userId === session.userId) {
      sendApiError(response, "bad_request", "Cannot revoke note owner");
      return;
    }

    const revokeCursor = context.db.orm.transaction((tx) => {
      const result = tx.update(schema.noteMemberships)
        .set({ status: "revoked", updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(
          eq(schema.noteMemberships.noteId, access.noteId),
          eq(schema.noteMemberships.userId, request.params.userId),
          ne(schema.noteMemberships.role, "owner"),
          ne(schema.noteMemberships.status, "revoked")
        ))
        .run();
      if (result.changes === 0) {
        return null;
      }
      tx.delete(schema.noteKeyShares)
        .where(and(
          eq(schema.noteKeyShares.noteId, access.noteId),
          eq(schema.noteKeyShares.recipientUserId, request.params.userId)
        ))
        .run();
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "membership.revoked",
        noteVersion: access.version,
        resourceType: "membership",
        resourceId: `${access.noteId}:${request.params.userId}`,
        payloadMetadata: {
          membershipUserId: request.params.userId
        }
      }, tx);
    });
    if (revokeCursor === null) {
      sendApiError(response, "not_found", "Membership not found");
      return;
    }
    context.realtime?.closeNoteAccess(access.noteId, request.params.userId);
    publishEventCursors(context, [revokeCursor]);

    response.status(204).send();
  });

  router.get("/:id/key-share", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (access.role === "owner") {
      sendApiError(response, "not_found", "Note key share not found");
      return;
    }

    const row = context.db.orm
      .select()
      .from(schema.noteKeyShares)
      .where(and(
        eq(schema.noteKeyShares.noteId, access.noteId),
        eq(schema.noteKeyShares.recipientUserId, session.userId)
      ))
      .get();

    if (!row) {
      sendApiError(response, "not_found", "Note key share not found");
      return;
    }

    response.json(row);
  });

  router.get("/:id/epoch-links", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }
    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canReadNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    const links = context.db.orm
      .select({
        sourceEpoch: schema.noteEpochLinks.sourceEpoch,
        targetEpoch: schema.noteEpochLinks.targetEpoch,
        previousKeyCipher: schema.noteEpochLinks.previousKeyCipher,
        nonce: schema.noteEpochLinks.nonce,
        formatVersion: schema.noteEpochLinks.formatVersion,
        createdAt: schema.noteEpochLinks.createdAt
      })
      .from(schema.noteEpochLinks)
      .where(eq(schema.noteEpochLinks.noteId, access.noteId))
      .orderBy(desc(schema.noteEpochLinks.targetEpoch))
      .all();
    response.json({ links });
  });

  router.post("/:id/key-rotation", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = rotateNoteKeySchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid key rotation payload");
      return;
    }

    if ("mode" in parsed.data) {
      const linkedRotation = parsed.data;
      const outcome = context.db.orm.transaction((tx) => {
        const current = tx
          .select({
            noteId: schema.notes.id,
            version: schema.notes.version,
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
              eq(schema.notes.id, request.params.id),
              eq(schema.noteMemberships.userId, session.userId)
            )
          )
          .get();
        if (current?.role !== "owner" || current.status !== "active") {
          return { kind: "not-found" as const };
        }
        if (
          current.isDeleted ||
          current.rotationFenced ||
          current.rootVersion !== linkedRotation.rootVersion ||
          current.keyEpoch !== linkedRotation.sourceEpoch ||
          linkedRotation.targetEpoch !== linkedRotation.sourceEpoch + 1
        ) {
          return { kind: "conflict" as const };
        }

        const activeMembers = tx
          .select({
            userId: schema.noteMemberships.userId,
            role: schema.noteMemberships.role,
            status: schema.noteMemberships.status
          })
          .from(schema.noteMemberships)
          .where(eq(schema.noteMemberships.noteId, current.noteId))
          .all();
        const revoked = activeMembers.find(
          (member) =>
            member.userId === linkedRotation.revokedUserId &&
            member.status === "active" &&
            member.role !== "owner"
        );
        if (!revoked) {
          return { kind: "not-found" as const };
        }
        const remainingIds = activeMembers
          .filter(
            (member) =>
              member.status === "active" &&
              member.role !== "owner" &&
              member.userId !== linkedRotation.revokedUserId
          )
          .map((member) => member.userId);
        if (
          !sameMembers(
            remainingIds,
            linkedRotation.shares.map((share) => share.recipientUserId)
          )
        ) {
          return { kind: "invalid-set" as const };
        }
        for (const share of linkedRotation.shares) {
          const trustedKey = tx
            .select({ userId: schema.userSharingKeys.userId })
            .from(schema.userSharingKeys)
            .where(
              and(
                eq(schema.userSharingKeys.userId, share.recipientUserId),
                eq(
                  schema.userSharingKeys.sharingKeyVersion,
                  share.sharingKeyVersion
                )
              )
            )
            .get();
          if (!trustedKey) {
            return { kind: "invalid-set" as const };
          }
        }

        const fence = tx
          .update(schema.notes)
          .set({ rotationFenced: true })
          .where(
            and(
              eq(schema.notes.id, current.noteId),
              eq(schema.notes.rootVersion, linkedRotation.rootVersion),
              eq(schema.notes.keyEpoch, linkedRotation.sourceEpoch),
              eq(schema.notes.rotationFenced, false)
            )
          )
          .run();
        if (fence.changes !== 1) {
          return { kind: "conflict" as const };
        }
        const revokedMembership = tx
          .update(schema.noteMemberships)
          .set({ status: "revoked", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(schema.noteMemberships.noteId, current.noteId),
              eq(schema.noteMemberships.userId, linkedRotation.revokedUserId),
              eq(schema.noteMemberships.status, "active"),
              ne(schema.noteMemberships.role, "owner")
            )
          )
          .run();
        if (revokedMembership.changes !== 1) {
          return { kind: "conflict" as const };
        }
        tx.delete(schema.noteKeyShares)
          .where(
            and(
              eq(schema.noteKeyShares.noteId, current.noteId),
              eq(
                schema.noteKeyShares.recipientUserId,
                linkedRotation.revokedUserId
              )
            )
          )
          .run();
        for (const share of linkedRotation.shares) {
          tx.insert(schema.noteKeyShares)
            .values({
              noteId: current.noteId,
              recipientUserId: share.recipientUserId,
              senderUserId: session.userId,
              sharingKeyVersion: share.sharingKeyVersion,
              encryptedNoteKey: share.encryptedNoteKey,
              formatVersion: share.formatVersion
            })
            .onConflictDoUpdate({
              target: [
                schema.noteKeyShares.noteId,
                schema.noteKeyShares.recipientUserId
              ],
              set: {
                senderUserId: session.userId,
                sharingKeyVersion: share.sharingKeyVersion,
                encryptedNoteKey: share.encryptedNoteKey,
                formatVersion: share.formatVersion,
                createdAt: sql`CURRENT_TIMESTAMP`
              }
            })
            .run();
        }
        tx.insert(schema.noteEpochLinks)
          .values({
            noteId: current.noteId,
            sourceEpoch: linkedRotation.sourceEpoch,
            targetEpoch: linkedRotation.targetEpoch,
            previousKeyCipher: linkedRotation.previousKeyCipher,
            nonce: linkedRotation.previousKeyNonce,
            formatVersion: linkedRotation.linkFormatVersion
          })
          .run();
        tx.update(schema.notes)
          .set({
            encryptedNoteKey: linkedRotation.encryptedNoteKey,
            noteKeyNonce: linkedRotation.noteKeyNonce,
            noteKeyFormatVersion: linkedRotation.noteKeyFormatVersion,
            titleCipher: linkedRotation.titleCipher,
            titleNonce: linkedRotation.titleNonce,
            titleFormatVersion: linkedRotation.titleFormatVersion,
            keyEpoch: linkedRotation.targetEpoch,
            rootVersion: sql`${schema.notes.rootVersion} + 1`,
            version: sql`${schema.notes.version} + 1`,
            rotationFenced: false,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(
            and(
              eq(schema.notes.id, current.noteId),
              eq(schema.notes.rotationFenced, true)
            )
          )
          .run();
        const eventCursor = writeRequestEvent(
          context,
          request,
          {
            noteId: current.noteId,
            actorUserId: session.userId,
            eventType: "membership.revoked",
            noteVersion: current.version + 1,
            resourceType: "membership",
            resourceId: `${current.noteId}:${linkedRotation.revokedUserId}`,
            payloadMetadata: {
              membershipUserId: linkedRotation.revokedUserId,
              targetEpoch: linkedRotation.targetEpoch
            }
          },
          tx
        );
        return {
          kind: "rotated" as const,
          eventCursor,
          version: current.version + 1,
          rootVersion: current.rootVersion + 1
        };
      });
      if (outcome.kind === "not-found") {
        sendApiError(response, "not_found", "Note not found");
        return;
      }
      if (outcome.kind === "invalid-set") {
        sendApiError(response, "bad_request", "Key shares must match active members");
        return;
      }
      if (outcome.kind === "conflict") {
        sendApiError(response, "conflict", "Note rotation state changed");
        return;
      }
      context.realtime?.closeNoteAccess(
        request.params.id,
        linkedRotation.revokedUserId
      );
      publishEventCursors(context, [outcome.eventCursor]);
      response.json({
        id: request.params.id,
        version: outcome.version,
        rootVersion: outcome.rootVersion,
        keyEpoch: linkedRotation.targetEpoch
      });
      return;
    }

    const legacyRotation = parsed.data;

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (access.isDeleted) {
      sendApiError(response, "conflict", "Restore note before rotating keys");
      return;
    }
    if (access.version !== legacyRotation.version) {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }

    const activeMembers = context.db.orm
      .select({ userId: schema.noteMemberships.userId })
      .from(schema.noteMemberships)
      .where(and(
        eq(schema.noteMemberships.noteId, access.noteId),
        eq(schema.noteMemberships.status, "active"),
        ne(schema.noteMemberships.role, "owner")
      ))
      .all();
    const activeMemberIds = activeMembers.map((member) => member.userId);
    const shareRecipientIds = legacyRotation.shares.map((share) => share.recipientUserId);
    if (!sameMembers(activeMemberIds, shareRecipientIds)) {
      sendApiError(response, "bad_request", "Key shares must cover all active members");
      return;
    }

    const validShareRows = legacyRotation.shares.length
      ? context.db.orm.all<{ userId: string; sharingKeyVersion: number }>(sql`
          SELECT user_id AS userId, sharing_key_version AS sharingKeyVersion
          FROM ${schema.userSharingKeys}
          WHERE (user_id, sharing_key_version) IN (
            ${sql.join(
              legacyRotation.shares.map((share) =>
                sql`(${share.recipientUserId}, ${share.sharingKeyVersion})`
              ),
              sql`, `
            )}
          )
        `)
      : [];
    const validShareKeys = new Set(
      validShareRows.map((row) => `${row.userId}:${String(row.sharingKeyVersion)}`)
    );
    if (
      legacyRotation.shares.some(
        (share) =>
          !validShareKeys.has(`${share.recipientUserId}:${String(share.sharingKeyVersion)}`)
      )
    ) {
      sendApiError(response, "bad_request", "Invalid sharing key version");
      return;
    }

    const attachmentRows = context.db.orm
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(eq(schema.attachments.noteId, access.noteId))
      .all();
    const attachmentIds = attachmentRows.map((attachment) => attachment.id);
    const rotatedAttachmentIds = legacyRotation.attachmentKeys.map(
      (attachment) => attachment.attachmentId
    );
    if (!sameMembers(attachmentIds, rotatedAttachmentIds)) {
      sendApiError(response, "bad_request", "Attachment keys must cover all attachments");
      return;
    }

    const nextVersion = access.version + 1;
    const eventCursor = context.db.orm.transaction((tx) => {
      const updateResult = tx.update(schema.notes)
        .set({
          encryptedNoteKey: legacyRotation.encryptedNoteKey,
          noteKeyNonce: legacyRotation.noteKeyNonce,
          contentCipher: legacyRotation.contentCipher,
          contentNonce: legacyRotation.contentNonce,
          contentLength: legacyRotation.contentLength,
          contentUpdatedAt: sql`CURRENT_TIMESTAMP`,
          version: sql`${schema.notes.version} + 1`,
          keyEpoch: sql`${schema.notes.keyEpoch} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(and(
          eq(schema.notes.id, access.noteId),
          eq(schema.notes.version, legacyRotation.version)
        ))
        .run();
      if (updateResult.changes !== 1) {
        return null;
      }
      for (const share of legacyRotation.shares) {
        tx.insert(schema.noteKeyShares)
          .values({
            noteId: access.noteId,
            recipientUserId: share.recipientUserId,
            senderUserId: session.userId,
            sharingKeyVersion: share.sharingKeyVersion,
            encryptedNoteKey: share.encryptedNoteKey,
            formatVersion: share.formatVersion
          })
          .onConflictDoUpdate({
            target: [schema.noteKeyShares.noteId, schema.noteKeyShares.recipientUserId],
            set: {
              senderUserId: session.userId,
              sharingKeyVersion: share.sharingKeyVersion,
              encryptedNoteKey: share.encryptedNoteKey,
              formatVersion: share.formatVersion,
              createdAt: sql`CURRENT_TIMESTAMP`
            }
          })
          .run();
      }
      for (const attachmentKey of legacyRotation.attachmentKeys) {
        tx.update(schema.attachments)
          .set({
            encryptedAttachmentKey: attachmentKey.encryptedAttachmentKey,
            attachmentKeyNonce: attachmentKey.attachmentKeyNonce
          })
          .where(and(
            eq(schema.attachments.id, attachmentKey.attachmentId),
            eq(schema.attachments.noteId, access.noteId)
          ))
          .run();
      }
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.updated",
        noteVersion: nextVersion,
        payloadMetadata: {
          keyRotated: true
        }
      }, tx);
    });
    if (eventCursor === null) {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }
    publishEventCursors(context, [eventCursor]);

    response.json({
      id: access.noteId,
      version: nextVersion,
      keyEpoch: access.keyEpoch + 1
    });
  });

  router.put("/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const parsed = updateNoteSchema.safeParse(request.body);
    if (!parsed.success) {
      sendApiError(response, "bad_request", "Invalid note payload");
      return;
    }

    if ("rootVersion" in parsed.data) {
      const protectedUpdate = parsed.data;
      const metadataUpdate = context.db.orm.transaction((tx) => {
        const current = tx
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
              eq(schema.notes.id, request.params.id),
              eq(schema.noteMemberships.userId, session.userId)
            )
          )
          .get();
        if (
          current?.status !== "active" ||
          (current.role !== "owner" && current.role !== "editor")
        ) {
          return { kind: "not-found" as const };
        }
        if (
          current.isDeleted ||
          current.rotationFenced ||
          current.rootVersion !== protectedUpdate.rootVersion ||
          current.keyEpoch !== protectedUpdate.keyEpoch
        ) {
          return { kind: "conflict" as const };
        }
        if (
          protectedUpdate.encryptedNoteKey !== undefined &&
          (current.role !== "owner" ||
            (current.rootSectionId !== null &&
              current.rootSectionId !== protectedUpdate.rootSectionId))
        ) {
          return { kind: "conflict" as const };
        }
        const folderId = protectedUpdate.folderId ?? current.folderId;
        if (
          current.role !== "owner" &&
          protectedUpdate.folderId !== undefined &&
          protectedUpdate.folderId !== current.folderId
        ) {
          return { kind: "invalid-folder" as const };
        }
        if (current.role === "owner" && folderId) {
          const folder = tx
            .select({ id: schema.folders.id })
            .from(schema.folders)
            .where(
              and(
                eq(schema.folders.id, folderId),
                eq(schema.folders.userId, session.userId)
              )
            )
            .get();
          if (!folder) {
            return { kind: "invalid-folder" as const };
          }
        }

        const updateResult = tx
          .update(schema.notes)
          .set({
            folderId,
            title: protectedUpdate.titleCipher ? "" : undefined,
            titleCipher: protectedUpdate.titleCipher,
            titleNonce: protectedUpdate.titleNonce,
            titleFormatVersion: protectedUpdate.titleFormatVersion,
            encryptedNoteKey: protectedUpdate.encryptedNoteKey,
            noteKeyNonce: protectedUpdate.noteKeyNonce,
            noteKeyFormatVersion: protectedUpdate.noteKeyFormatVersion,
            rootSectionId: protectedUpdate.rootSectionId,
            rootVersion: sql`${schema.notes.rootVersion} + 1`,
            version: sql`${schema.notes.version} + 1`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(
            and(
              eq(schema.notes.id, current.noteId),
              eq(schema.notes.rootVersion, protectedUpdate.rootVersion),
              eq(schema.notes.keyEpoch, protectedUpdate.keyEpoch),
              eq(schema.notes.rotationFenced, false)
            )
          )
          .run();
        if (updateResult.changes !== 1) {
          return { kind: "conflict" as const };
        }
        if (protectedUpdate.rootSectionId) {
          tx.insert(schema.noteSections)
            .values({
              id: protectedUpdate.rootSectionId,
              noteId: current.noteId,
              createdEpoch: current.keyEpoch
            })
            .onConflictDoNothing()
            .run();
        }
        const nextRootVersion = current.rootVersion + 1;
        const eventCursor = writeRequestEvent(
          context,
          request,
          {
            noteId: current.noteId,
            actorUserId: session.userId,
            eventType: "note.updated",
            noteVersion: nextRootVersion
          },
          tx
        );
        const saved = tx
          .select({ updatedAt: schema.notes.updatedAt })
          .from(schema.notes)
          .where(eq(schema.notes.id, current.noteId))
          .get();
        return saved
          ? {
              kind: "saved" as const,
              eventCursor,
              rootVersion: nextRootVersion,
              updatedAt: saved.updatedAt
            }
          : { kind: "conflict" as const };
      });
      if (metadataUpdate.kind === "not-found") {
        sendApiError(response, "not_found", "Note not found");
        return;
      }
      if (metadataUpdate.kind === "invalid-folder") {
        sendApiError(response, "bad_request", "Invalid folder");
        return;
      }
      if (metadataUpdate.kind === "conflict") {
        sendApiError(response, "conflict", "Note metadata changed");
        return;
      }
      publishEventCursors(context, [metadataUpdate.eventCursor]);
      response.json({
        id: request.params.id,
        rootVersion: metadataUpdate.rootVersion,
        keyEpoch: protectedUpdate.keyEpoch,
        updatedAt: `${metadataUpdate.updatedAt.replace(" ", "T")}Z`
      });
      return;
    }

    const legacyUpdate = parsed.data;

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canEditNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }
    if (access.isDeleted) {
      sendApiError(response, "conflict", "Restore note before updating");
      return;
    }
    if (access.version !== legacyUpdate.version) {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }

    const folderId = legacyUpdate.folderId ?? access.folderId;
    if (
      access.role !== "owner" &&
      legacyUpdate.folderId !== undefined &&
      legacyUpdate.folderId !== access.folderId
    ) {
      sendApiError(response, "bad_request", "Shared notes cannot be moved");
      return;
    }
    if (access.role === "owner" && !folderBelongsToUser(context, session.userId, folderId)) {
      sendApiError(response, "bad_request", "Invalid folder");
      return;
    }

    const title = legacyUpdate.title ?? undefined;
    const nextVersion = access.version + 1;
    const update = context.db.orm.transaction((tx) => {
      const updateResult = tx.update(schema.notes)
        .set({
          folderId,
          title,
          contentCipher: legacyUpdate.contentCipher,
          contentNonce: legacyUpdate.contentNonce,
          contentLength: legacyUpdate.contentLength,
          contentUpdatedAt: sql`CURRENT_TIMESTAMP`,
          version: sql`${schema.notes.version} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(and(
          eq(schema.notes.id, access.noteId),
          eq(schema.notes.version, legacyUpdate.version)
        ))
        .run();
      if (updateResult.changes !== 1) {
        return null;
      }
      const eventCursor = writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.updated",
        noteVersion: nextVersion
      }, tx);
      const saved = tx
        .select({ updatedAt: schema.notes.updatedAt })
        .from(schema.notes)
        .where(eq(schema.notes.id, access.noteId))
        .get();

      return saved ? { eventCursor, updatedAt: saved.updatedAt } : null;
    });
    if (update === null) {
      sendApiError(response, "conflict", "Note version conflict");
      return;
    }
    publishEventCursors(context, [update.eventCursor]);

    response.json({
      id: access.noteId,
      version: nextVersion,
      updatedAt: `${update.updatedAt.replace(" ", "T")}Z`
    });
  });

  router.delete("/:id", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const cursor = context.db.orm.transaction((tx) => {
      tx.update(schema.notes)
        .set({
          isDeleted: true,
          deletedAt: sql`CURRENT_TIMESTAMP`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(and(
          eq(schema.notes.id, access.noteId),
          eq(schema.notes.userId, session.userId)
        ))
        .run();
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.deleted",
        noteVersion: access.version
      }, tx);
    });
    publishEventCursors(context, [cursor]);

    response.status(204).send();
  });

  router.post("/:id/restore", (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const cursor = context.db.orm.transaction((tx) => {
      tx.update(schema.notes)
        .set({ isDeleted: false, deletedAt: null, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(
          eq(schema.notes.id, access.noteId),
          eq(schema.notes.userId, session.userId)
        ))
        .run();
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.restored",
        noteVersion: access.version
      }, tx);
    });
    publishEventCursors(context, [cursor]);

    response.json({ id: access.noteId });
  });

  router.delete("/:id/permanent", async (request, response) => {
    const session = requireSession(context.db, request, response);
    if (!session) {
      return;
    }

    const access = getNoteAccess(context, request.params.id, session.userId);
    if (!canOwnNote(access)) {
      sendApiError(response, "not_found", "Note not found");
      return;
    }

    const rows = context.db.orm
      .select({
        storageKey: schema.attachments.storageKey,
        size: schema.attachments.size
      })
      .from(schema.attachments)
      .where(and(
        eq(schema.attachments.noteId, access.noteId),
        eq(schema.attachments.userId, session.userId)
      ))
      .all();

    const memberRows = context.db.orm
      .select({ userId: schema.noteMemberships.userId })
      .from(schema.noteMemberships)
      .where(and(
        eq(schema.noteMemberships.noteId, access.noteId),
        eq(schema.noteMemberships.status, "active")
      ))
      .all();

    const cursor = context.db.orm.transaction((tx) => {
      const attachmentBytes = rows.reduce((total, row) => total + row.size, 0);
      tx.delete(schema.notes)
        .where(and(
          eq(schema.notes.id, access.noteId),
          eq(schema.notes.userId, session.userId)
        ))
        .run();
      if (attachmentBytes > 0) {
        tx.update(schema.storageAccounts)
          .set({
            usedBytes: sql`MAX(${schema.storageAccounts.usedBytes} - ${attachmentBytes}, 0)`,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(eq(schema.storageAccounts.userId, session.userId))
          .run();
      }
      return writeRequestEvent(context, request, {
        noteId: access.noteId,
        actorUserId: session.userId,
        eventType: "note.permanently_deleted",
        noteVersion: access.version,
        payloadMetadata: {
          visibleUserIds: memberRows.map((row) => row.userId)
        }
      }, tx);
    });
    publishEventCursors(context, [cursor]);
    await Promise.all(
      rows.map((row) =>
        context.db.attachmentStorage.delete(row.storageKey).catch((error: unknown) => {
          console.error("Unable to delete attachment ciphertext", error);
        })
      )
    );

    response.status(204).send();
  });

  return router;
}

function legacyMigrationConflict(
  code: "rotation-pending" | "stale-epoch" | "stale-version"
): string {
  if (code === "rotation-pending") {
    return "Note-key rotation is pending";
  }
  return code === "stale-epoch"
    ? "Note key epoch changed"
    : "Note metadata changed";
}

function sendSectionMutationError(
  response: Parameters<typeof sendApiError>[0],
  code:
    | "forbidden"
    | "last-section"
    | "rotation-pending"
    | "stale-epoch"
    | "stale-version"
): void {
  if (code === "forbidden") {
    sendApiError(response, "not_found", "Note not found");
    return;
  }
  if (code === "last-section") {
    sendApiError(response, "conflict", "A note must keep at least one section");
    return;
  }
  sendApiError(response, "conflict", legacyMigrationConflict(code));
}
