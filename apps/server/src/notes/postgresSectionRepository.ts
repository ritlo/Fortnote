import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { serializedEventMetadata } from "./events.js";
import type {
  InitializeSectionInput,
  LegacySectionReservationOutcome,
  NoteSectionRepository,
  SectionInitializationOutcome,
  SectionMutationOutcome,
  SectionRecord,
  SectionRejectionCode,
  SectionWriteInput
} from "./sectionRepository/contracts.js";
import {
  isWritableSectionAccess as isAccess,
  validateWritableSectionAccess,
  type WritableSectionAccess as WritableAccess
} from "./sectionRepository/policy.js";
import { ROOT_CRDT_SECTION_ID, storageSectionId } from "./sections.js";

type PostgresDatabase = NodePgDatabase<typeof schema>;

async function activeSession(
  database: Pick<PostgresDatabase, "select">,
  sessionId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const sessions = await database
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        gt(schema.sessions.idleExpiresAt, now),
        gt(schema.sessions.absoluteExpiresAt, now)
      )
    )
    .limit(1)
    .for("key share");
  return Boolean(sessions[0]);
}

async function sectionAccess(
  database: Pick<PostgresDatabase, "select">,
  noteId: string,
  userId: string
): Promise<WritableAccess | null> {
  const rows = await database
    .select({
      cryptoOwnerId: schema.notes.cryptoOwnerId,
      keyEpoch: schema.notes.keyEpoch,
      version: schema.notes.version,
      rootVersion: schema.notes.rootVersion,
      rotationFenced: schema.notes.rotationFenced,
      isDeleted: schema.notes.isDeleted,
      role: schema.noteMemberships.role,
      status: schema.noteMemberships.status
    })
    .from(schema.notes)
    .innerJoin(schema.noteMemberships, eq(schema.noteMemberships.noteId, schema.notes.id))
    .where(and(eq(schema.notes.id, noteId), eq(schema.noteMemberships.userId, userId)))
    .limit(1)
    .for("update", { of: [schema.notes, schema.noteMemberships] });
  return rows[0] ?? null;
}

async function writableAccess(
  database: Pick<PostgresDatabase, "select">,
  input: SectionWriteInput
): Promise<WritableAccess | SectionRejectionCode> {
  if (!(await activeSession(database, input.sessionId))) {
    return "forbidden";
  }
  return validateWritableSectionAccess(
    await sectionAccess(database, input.noteId, input.userId),
    input
  );
}

async function insertEvent(
  database: Pick<PostgresDatabase, "insert">,
  input: {
    eventType: "note.updated" | "section.created" | "section.deleted";
    resourceType: "note" | "section";
    resourceId: string;
    noteId: string;
    actorUserId: string;
    noteVersion: number;
    clientInstanceId?: string;
  }
): Promise<number> {
  const events = await database
    .insert(schema.noteEvents)
    .values({
      eventId: randomUUID(),
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      noteId: input.noteId,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      noteVersion: input.noteVersion,
      payloadMetadata: serializedEventMetadata(undefined, input.clientInstanceId)
    })
    .returning({ cursor: schema.noteEvents.cursor });
  const event = events[0];
  if (!event) {
    throw new Error("Section event insert did not return a cursor");
  }
  return event.cursor;
}

function staleReservation(updatedAt: string | null): boolean {
  if (!updatedAt) {
    return true;
  }
  return Date.parse(updatedAt) <= Date.now() - 30_000;
}

export class PostgresNoteSectionRepository implements NoteSectionRepository {
  constructor(private readonly orm: PostgresDatabase) {}

  list(noteId: string): Promise<SectionRecord[]> {
    return this.orm
      .select({
        id: schema.noteSections.id,
        noteId: schema.noteSections.noteId,
        createdEpoch: schema.noteSections.createdEpoch,
        currentSequence: schema.noteSections.currentSequence,
        initializationManifestId: schema.noteSections.initializationManifestId,
        isDeleted: schema.noteSections.isDeleted
      })
      .from(schema.noteSections)
      .where(
        and(
          eq(schema.noteSections.noteId, noteId),
          ne(schema.noteSections.id, noteId),
          eq(schema.noteSections.isDeleted, false)
        )
      )
      .orderBy(schema.noteSections.createdAt, schema.noteSections.id);
  }

  reserveLegacy(input: SectionWriteInput): Promise<LegacySectionReservationOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (!(await activeSession(transaction, input.sessionId))) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      const rows = await transaction
        .select({
          rootSectionId: schema.notes.rootSectionId,
          rootVersion: schema.notes.rootVersion,
          version: schema.notes.version,
          keyEpoch: schema.notes.keyEpoch,
          rotationFenced: schema.notes.rotationFenced,
          isDeleted: schema.notes.isDeleted,
          contentCipher: schema.notes.contentCipher,
          role: schema.noteMemberships.role,
          membershipStatus: schema.noteMemberships.status,
          initializationManifestId: schema.noteSections.initializationManifestId,
          sectionUpdatedAt: schema.noteSections.updatedAt
        })
        .from(schema.notes)
        .innerJoin(
          schema.noteMemberships,
          and(
            eq(schema.noteMemberships.noteId, schema.notes.id),
            eq(schema.noteMemberships.userId, input.userId)
          )
        )
        .leftJoin(
          schema.noteSections,
          and(
            eq(schema.noteSections.id, schema.notes.rootSectionId),
            eq(schema.noteSections.noteId, schema.notes.id)
          )
        )
        .where(eq(schema.notes.id, input.noteId))
        .limit(1)
        .for("update", { of: [schema.notes, schema.noteMemberships] });
      const current = rows[0];
      if (
        current?.membershipStatus !== "active" ||
        current.isDeleted ||
        (current.role !== "owner" && current.role !== "editor")
      ) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      if (current.keyEpoch !== input.expectedKeyEpoch) {
        return { status: "rejected", code: "stale-epoch" } as const;
      }
      if (current.rotationFenced) {
        return { status: "rejected", code: "rotation-pending" } as const;
      }
      if (current.rootSectionId) {
        const sections = await transaction
          .select({
            initializationManifestId: schema.noteSections.initializationManifestId,
            updatedAt: schema.noteSections.updatedAt
          })
          .from(schema.noteSections)
          .where(
            and(
              eq(schema.noteSections.id, current.rootSectionId),
              eq(schema.noteSections.noteId, input.noteId)
            )
          )
          .limit(1)
          .for("update");
        const rootSection = sections[0];
        const manifests = await transaction
          .select({ id: schema.contentManifests.id })
          .from(schema.contentManifests)
          .where(
            and(
              eq(schema.contentManifests.noteId, input.noteId),
              eq(schema.contentManifests.sectionId, current.rootSectionId),
              eq(schema.contentManifests.keyEpoch, current.keyEpoch),
              eq(schema.contentManifests.kind, "checkpoint")
            )
          )
          .orderBy(desc(schema.contentManifests.lastSequence))
          .limit(1);
        const manifest = manifests[0];
        const base = {
          sectionId: current.rootSectionId,
          keyEpoch: current.keyEpoch,
          rootVersion: current.rootVersion,
          version: current.version,
          manifestId: manifest?.id ?? null,
          changed: false,
          eventCursor: null
        };
        if (current.contentCipher === "" || rootSection?.initializationManifestId) {
          return { status: "complete", ...base } as const;
        }
        if (current.rootSectionId === input.sectionId) {
          return { status: "reserved", ...base } as const;
        }
        if (manifest || !staleReservation(rootSection?.updatedAt ?? null)) {
          return { status: "pending", ...base } as const;
        }
        if (current.rootVersion !== input.expectedRootVersion) {
          return { status: "rejected", code: "stale-version" } as const;
        }
        await transaction
          .update(schema.noteSections)
          .set({ isDeleted: true, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(schema.noteSections.id, current.rootSectionId),
              eq(schema.noteSections.noteId, input.noteId),
              sql`${schema.noteSections.initializationManifestId} IS NULL`
            )
          );
      } else if (current.rootVersion !== input.expectedRootVersion) {
        return { status: "rejected", code: "stale-version" } as const;
      }

      const sectionsInUse = await transaction
        .select({ id: schema.noteSections.id })
        .from(schema.noteSections)
        .where(eq(schema.noteSections.id, input.sectionId))
        .limit(1)
        .for("update");
      if (sectionsInUse[0]) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      const updated = await transaction
        .update(schema.notes)
        .set({
          rootSectionId: input.sectionId,
          rootVersion: sql`${schema.notes.rootVersion} + 1`,
          version: sql`${schema.notes.version} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.notes.id, input.noteId),
            eq(schema.notes.rootVersion, current.rootVersion),
            eq(schema.notes.keyEpoch, input.expectedKeyEpoch),
            eq(schema.notes.rotationFenced, false),
            ne(schema.notes.contentCipher, "")
          )
        )
        .returning({ id: schema.notes.id });
      if (updated.length !== 1) {
        return { status: "rejected", code: "stale-version" } as const;
      }
      await transaction.insert(schema.noteSections).values({
        id: input.sectionId,
        noteId: input.noteId,
        createdEpoch: input.expectedKeyEpoch
      });
      const version = current.version + 1;
      const eventCursor = await insertEvent(transaction, {
        eventType: "note.updated",
        resourceType: "note",
        resourceId: input.noteId,
        noteId: input.noteId,
        actorUserId: input.userId,
        noteVersion: version,
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {})
      });
      return {
        status: "reserved",
        sectionId: input.sectionId,
        keyEpoch: input.expectedKeyEpoch,
        rootVersion: current.rootVersion + 1,
        version,
        manifestId: null,
        changed: true,
        eventCursor
      } as const;
    });
  }

  create(input: SectionWriteInput): Promise<SectionMutationOutcome> {
    return this.orm.transaction(async (transaction) => {
      const access = await writableAccess(transaction, input);
      if (!isAccess(access)) {
        return { status: "rejected", code: access } as const;
      }
      const existingRows = await transaction
        .select({
          noteId: schema.noteSections.noteId,
          isDeleted: schema.noteSections.isDeleted
        })
        .from(schema.noteSections)
        .where(eq(schema.noteSections.id, input.sectionId))
        .limit(1)
        .for("update");
      const existing = existingRows[0];
      if (existing) {
        return existing.noteId === input.noteId && !existing.isDeleted
          ? ({
              status: "already-created",
              rootVersion: access.rootVersion,
              version: access.version,
              eventCursor: null
            } as const)
          : ({ status: "rejected", code: "forbidden" } as const);
      }
      if (access.rootVersion !== input.expectedRootVersion) {
        return { status: "rejected", code: "stale-version" } as const;
      }
      const advanced = await transaction
        .update(schema.notes)
        .set({
          rootVersion: sql`${schema.notes.rootVersion} + 1`,
          version: sql`${schema.notes.version} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.notes.id, input.noteId),
            eq(schema.notes.rootVersion, input.expectedRootVersion),
            eq(schema.notes.keyEpoch, input.expectedKeyEpoch),
            eq(schema.notes.rotationFenced, false)
          )
        )
        .returning({ id: schema.notes.id });
      if (advanced.length !== 1) {
        return { status: "rejected", code: "stale-version" } as const;
      }
      await transaction.insert(schema.noteSections).values({
        id: input.sectionId,
        noteId: input.noteId,
        createdEpoch: input.expectedKeyEpoch
      });
      const version = access.version + 1;
      const eventCursor = await insertEvent(transaction, {
        eventType: "section.created",
        resourceType: "section",
        resourceId: input.sectionId,
        noteId: input.noteId,
        actorUserId: input.userId,
        noteVersion: version,
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {})
      });
      return {
        status: "created",
        rootVersion: access.rootVersion + 1,
        version,
        eventCursor
      } as const;
    });
  }

  tombstone(input: SectionWriteInput): Promise<SectionMutationOutcome> {
    return this.orm.transaction(async (transaction) => {
      const access = await writableAccess(transaction, input);
      if (!isAccess(access)) {
        return { status: "rejected", code: access } as const;
      }
      const sections = await transaction
        .select({ isDeleted: schema.noteSections.isDeleted })
        .from(schema.noteSections)
        .where(
          and(
            eq(schema.noteSections.id, input.sectionId),
            eq(schema.noteSections.noteId, input.noteId),
            ne(schema.noteSections.id, schema.noteSections.noteId)
          )
        )
        .limit(1)
        .for("update");
      const section = sections[0];
      if (!section) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      if (section.isDeleted) {
        return {
          status: "already-deleted",
          rootVersion: access.rootVersion,
          version: access.version,
          eventCursor: null
        } as const;
      }
      if (access.rootVersion !== input.expectedRootVersion) {
        return { status: "rejected", code: "stale-version" } as const;
      }
      const visibleRows = await transaction
        .select({ count: sql<number>`count(*)` })
        .from(schema.noteSections)
        .where(
          and(
            eq(schema.noteSections.noteId, input.noteId),
            ne(schema.noteSections.id, schema.noteSections.noteId),
            eq(schema.noteSections.isDeleted, false)
          )
        );
      if (!visibleRows[0] || visibleRows[0].count <= 1) {
        return { status: "rejected", code: "last-section" } as const;
      }
      const advanced = await transaction
        .update(schema.notes)
        .set({
          rootVersion: sql`${schema.notes.rootVersion} + 1`,
          version: sql`${schema.notes.version} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(schema.notes.id, input.noteId),
            eq(schema.notes.rootVersion, input.expectedRootVersion),
            eq(schema.notes.keyEpoch, input.expectedKeyEpoch),
            eq(schema.notes.rotationFenced, false)
          )
        )
        .returning({ id: schema.notes.id });
      if (advanced.length !== 1) {
        return { status: "rejected", code: "stale-version" } as const;
      }
      const deleted = await transaction
        .update(schema.noteSections)
        .set({ isDeleted: true, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(schema.noteSections.id, input.sectionId),
            eq(schema.noteSections.noteId, input.noteId),
            eq(schema.noteSections.isDeleted, false)
          )
        )
        .returning({ id: schema.noteSections.id });
      const version = access.version + 1;
      if (deleted.length !== 1) {
        return {
          status: "already-deleted",
          rootVersion: access.rootVersion + 1,
          version,
          eventCursor: null
        } as const;
      }
      const eventCursor = await insertEvent(transaction, {
        eventType: "section.deleted",
        resourceType: "section",
        resourceId: input.sectionId,
        noteId: input.noteId,
        actorUserId: input.userId,
        noteVersion: version,
        ...(input.clientInstanceId ? { clientInstanceId: input.clientInstanceId } : {})
      });
      return {
        status: "deleted",
        rootVersion: access.rootVersion + 1,
        version,
        eventCursor
      } as const;
    });
  }

  initialize(input: InitializeSectionInput): Promise<SectionInitializationOutcome> {
    return this.orm.transaction(async (transaction) => {
      if (!(await activeSession(transaction, input.sessionId))) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      const access = await sectionAccess(transaction, input.noteId, input.userId);
      if (
        access?.status !== "active" ||
        access.isDeleted ||
        (access.role !== "owner" && access.role !== "editor")
      ) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      if (access.keyEpoch !== input.expectedKeyEpoch) {
        return { status: "rejected", code: "stale-epoch" } as const;
      }
      const storedSectionId = storageSectionId(input.noteId, input.sectionId);
      if (input.sectionId === ROOT_CRDT_SECTION_ID) {
        await transaction
          .insert(schema.noteSections)
          .values({
            id: input.noteId,
            noteId: input.noteId,
            createdEpoch: access.keyEpoch
          })
          .onConflictDoNothing();
      }
      const sections = await transaction
        .select({
          createdEpoch: schema.noteSections.createdEpoch,
          initializationManifestId: schema.noteSections.initializationManifestId,
          isDeleted: schema.noteSections.isDeleted
        })
        .from(schema.noteSections)
        .where(
          and(
            eq(schema.noteSections.id, storedSectionId),
            eq(schema.noteSections.noteId, input.noteId)
          )
        )
        .limit(1)
        .for("update");
      const section = sections[0];
      if (
        !section ||
        section.isDeleted ||
        section.createdEpoch > input.expectedKeyEpoch
      ) {
        return { status: "rejected", code: "forbidden" } as const;
      }
      const legacyRows = await transaction
        .select({
          contentCipher: schema.notes.contentCipher,
          rootSectionId: schema.notes.rootSectionId
        })
        .from(schema.notes)
        .where(eq(schema.notes.id, input.noteId))
        .limit(1);
      const legacy = legacyRows[0];
      const initializations = await transaction
        .select({ manifestId: schema.crdtInitializations.manifestId })
        .from(schema.crdtInitializations)
        .where(
          and(
            eq(schema.crdtInitializations.noteId, input.noteId),
            eq(schema.crdtInitializations.sectionId, storedSectionId),
            eq(schema.crdtInitializations.keyEpoch, input.expectedKeyEpoch)
          )
        )
        .limit(1);
      const existing = initializations[0];
      let status: "installed" | "already-initialized";
      let manifestId: string;
      if (existing) {
        status = "already-initialized";
        manifestId = existing.manifestId;
      } else {
        if (access.rotationFenced) {
          return { status: "rejected", code: "rotation-pending" } as const;
        }
        if (access.rootVersion !== input.expectedRootVersion) {
          return { status: "rejected", code: "stale-version" } as const;
        }
        if (section.initializationManifestId) {
          return { status: "rejected", code: "forbidden" } as const;
        }
        const manifests = await transaction
          .select({ id: schema.contentManifests.id })
          .from(schema.contentManifests)
          .where(
            and(
              eq(schema.contentManifests.id, input.manifestId),
              eq(schema.contentManifests.noteId, input.noteId),
              eq(schema.contentManifests.sectionId, storedSectionId),
              eq(schema.contentManifests.keyEpoch, input.expectedKeyEpoch),
              eq(schema.contentManifests.kind, "checkpoint")
            )
          )
          .limit(1);
        if (!manifests[0]) {
          return { status: "rejected", code: "forbidden" } as const;
        }
        await transaction.insert(schema.crdtInitializations).values({
          noteId: input.noteId,
          sectionId: storedSectionId,
          keyEpoch: input.expectedKeyEpoch,
          manifestId: input.manifestId,
          legacyRootVersion: input.expectedRootVersion
        });
        const initialized = await transaction
          .update(schema.noteSections)
          .set({
            initializationManifestId: input.manifestId,
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(
            and(
              eq(schema.noteSections.id, storedSectionId),
              eq(schema.noteSections.noteId, input.noteId),
              sql`${schema.noteSections.initializationManifestId} IS NULL`
            )
          )
          .returning({ id: schema.noteSections.id });
        if (initialized.length !== 1) {
          throw new Error("Section initialization invariant failed");
        }
        status = "installed";
        manifestId = input.manifestId;
      }

      const legacyAvailable = Boolean(legacy?.contentCipher);
      if (legacyAvailable && legacy?.rootSectionId === storedSectionId) {
        await transaction
          .update(schema.notes)
          .set({
            contentCipher: "",
            contentNonce: "",
            contentLength: 0,
            contentUpdatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(
            and(
              eq(schema.notes.id, input.noteId),
              eq(schema.notes.rootSectionId, storedSectionId),
              ne(schema.notes.contentCipher, "")
            )
          );
      }
      const shouldWriteEvent = status === "installed" || legacyAvailable;
      const eventCursor = shouldWriteEvent
        ? await insertEvent(transaction, {
            eventType: "note.updated",
            resourceType: "note",
            resourceId: input.noteId,
            noteId: input.noteId,
            actorUserId: input.userId,
            noteVersion: access.version,
            ...(input.clientInstanceId
              ? { clientInstanceId: input.clientInstanceId }
              : {})
          })
        : null;
      return {
        status,
        manifestId,
        rootVersion: access.rootVersion,
        version: access.version,
        eventCursor
      } as const;
    });
  }
}
