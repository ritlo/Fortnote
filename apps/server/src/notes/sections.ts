import type { AppContext } from "../http/app.js";
import { isSessionActive } from "../auth/session.js";

export const ROOT_CRDT_SECTION_ID = "root";

export interface NoteSectionRecord {
  id: string;
  noteId: string;
  createdEpoch: number;
  currentSequence: number;
  initializationManifestId: string | null;
  isDeleted: number;
}

export interface NoteSectionAccess {
  cryptoOwnerId: string;
  keyEpoch: number;
  version: number;
  rootVersion: number;
  rotationFenced: number;
  isDeleted: number;
  role: "owner" | "editor" | "viewer";
  status: "active" | "revoked";
}

export type LegacySectionReservationOutcome =
  | {
      status: "reserved" | "pending" | "complete";
      sectionId: string;
      keyEpoch: number;
      rootVersion: number;
      version: number;
      manifestId?: string;
      changed?: boolean;
    }
  | {
      status: "rejected";
      code: "forbidden" | "rotation-pending" | "stale-epoch" | "stale-version";
    };

export type SectionInitializationOutcome =
  | { status: "installed" | "already-initialized"; manifestId: string }
  | {
      status: "rejected";
      code: "forbidden" | "rotation-pending" | "stale-epoch" | "stale-version";
    };

export type SectionMutationOutcome =
  | {
      status: "created" | "already-created" | "deleted" | "already-deleted";
      rootVersion: number;
      version: number;
    }
  | {
      status: "rejected";
      code:
        | "forbidden"
        | "last-section"
        | "rotation-pending"
        | "stale-epoch"
        | "stale-version";
    };

export function storageSectionId(noteId: string, sectionId: string): string {
  return sectionId === ROOT_CRDT_SECTION_ID ? noteId : sectionId;
}

export function ensureNoteSection(
  context: AppContext,
  noteId: string,
  sectionId: string,
  keyEpoch: number
): NoteSectionRecord | null {
  const storedId = storageSectionId(noteId, sectionId);
  if (sectionId === ROOT_CRDT_SECTION_ID) {
    context.db.sqlite
      .prepare(`
        INSERT OR IGNORE INTO note_sections (id, note_id, created_epoch)
        SELECT id, id, key_epoch FROM notes WHERE id = ?
      `)
      .run(noteId);
  }
  const section = context.db.sqlite
    .prepare(`
      SELECT
        id,
        note_id AS noteId,
        created_epoch AS createdEpoch,
        current_sequence AS currentSequence,
        initialization_manifest_id AS initializationManifestId,
        is_deleted AS isDeleted
      FROM note_sections
      WHERE id = ? AND note_id = ?
    `)
    .get(storedId, noteId) as NoteSectionRecord | undefined;
  if (!section || section.isDeleted || section.createdEpoch > keyEpoch) {
    return null;
  }
  return section;
}

export function readNoteSectionAccess(
  context: AppContext,
  noteId: string,
  userId: string
): NoteSectionAccess | null {
  return (context.db.sqlite
    .prepare(`
      SELECT
        n.crypto_owner_id AS cryptoOwnerId,
        n.key_epoch AS keyEpoch,
        n.version,
        n.root_version AS rootVersion,
        n.rotation_fenced AS rotationFenced,
        n.is_deleted AS isDeleted,
        m.role,
        m.status
      FROM notes n
      INNER JOIN note_memberships m ON m.note_id = n.id
      WHERE n.id = ? AND m.user_id = ?
    `)
    .get(noteId, userId) ?? null) as NoteSectionAccess | null;
}

export function compareAndSetSectionInitialization(
  context: AppContext,
  input: {
    sessionId: string;
    userId: string;
    noteId: string;
    sectionId: string;
    expectedKeyEpoch: number;
    expectedRootVersion: number;
    manifestId: string;
  }
): SectionInitializationOutcome {
  const commit = context.db.sqlite.transaction((): SectionInitializationOutcome => {
    if (!isSessionActive(context.db, input.sessionId)) {
      return { status: "rejected", code: "forbidden" };
    }
    const access = readNoteSectionAccess(context, input.noteId, input.userId);
    if (
      access?.status !== "active" ||
      access.isDeleted ||
      (access.role !== "owner" && access.role !== "editor")
    ) {
      return { status: "rejected", code: "forbidden" };
    }
    if (access.keyEpoch !== input.expectedKeyEpoch) {
      return { status: "rejected", code: "stale-epoch" };
    }
    const section = ensureNoteSection(
      context,
      input.noteId,
      input.sectionId,
      input.expectedKeyEpoch
    );
    if (!section) {
      return { status: "rejected", code: "forbidden" };
    }
    const storedSectionId = storageSectionId(input.noteId, input.sectionId);
    const existing = readInitialization(
      context,
      input.noteId,
      storedSectionId,
      input.expectedKeyEpoch
    );
    if (existing) {
      clearLegacyContentForInitializedRoot(
        context,
        input.noteId,
        storedSectionId
      );
      return { status: "already-initialized", manifestId: existing.manifestId };
    }
    if (access.rotationFenced) {
      return { status: "rejected", code: "rotation-pending" };
    }
    if (access.rootVersion !== input.expectedRootVersion) {
      return { status: "rejected", code: "stale-version" };
    }
    if (section.initializationManifestId) {
      return { status: "rejected", code: "forbidden" };
    }
    const manifest = context.db.sqlite
      .prepare(`
        SELECT id
        FROM content_manifests
        WHERE id = ?
          AND note_id = ?
          AND section_id = ?
          AND key_epoch = ?
          AND kind = 'checkpoint'
      `)
      .get(
        input.manifestId,
        input.noteId,
        storedSectionId,
        input.expectedKeyEpoch
      ) as { id: string } | undefined;
    if (!manifest) {
      return { status: "rejected", code: "forbidden" };
    }
    context.db.sqlite
      .prepare(`
        INSERT INTO crdt_initializations (
          note_id, section_id, key_epoch, manifest_id, legacy_root_version
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        input.noteId,
        storedSectionId,
        input.expectedKeyEpoch,
        input.manifestId,
        input.expectedRootVersion
      );
    const sectionUpdate = context.db.sqlite
      .prepare(`
        UPDATE note_sections
        SET initialization_manifest_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND note_id = ? AND initialization_manifest_id IS NULL
      `)
      .run(input.manifestId, storedSectionId, input.noteId);
    if (sectionUpdate.changes !== 1) {
      throw new Error("Section initialization invariant failed");
    }
    clearLegacyContentForInitializedRoot(context, input.noteId, storedSectionId);
    return { status: "installed", manifestId: input.manifestId };
  });
  return commit.immediate();
}

export function reserveLegacyRootSection(
  context: AppContext,
  input: {
    sessionId: string;
    userId: string;
    noteId: string;
    sectionId: string;
    expectedKeyEpoch: number;
    expectedRootVersion: number;
  }
): LegacySectionReservationOutcome {
  const reserve = context.db.sqlite.transaction((): LegacySectionReservationOutcome => {
    if (!isSessionActive(context.db, input.sessionId)) {
      return { status: "rejected", code: "forbidden" };
    }
    const current = context.db.sqlite
      .prepare(`
        SELECT
          n.root_section_id AS rootSectionId,
          n.root_version AS rootVersion,
          n.version,
          n.key_epoch AS keyEpoch,
          n.rotation_fenced AS rotationFenced,
          n.is_deleted AS isDeleted,
          n.content_cipher AS contentCipher,
          m.role,
          m.status AS membershipStatus,
          s.initialization_manifest_id AS initializationManifestId,
          s.updated_at AS sectionUpdatedAt
        FROM notes n
        INNER JOIN note_memberships m ON m.note_id = n.id AND m.user_id = ?
        LEFT JOIN note_sections s ON s.id = n.root_section_id AND s.note_id = n.id
        WHERE n.id = ?
      `)
      .get(input.userId, input.noteId) as {
        rootSectionId: string | null;
        rootVersion: number;
        version: number;
        keyEpoch: number;
        rotationFenced: number;
        isDeleted: number;
        contentCipher: string;
        role: "owner" | "editor" | "viewer";
        membershipStatus: "active" | "revoked";
        initializationManifestId: string | null;
        sectionUpdatedAt: string | null;
      } | undefined;
    if (
      current?.membershipStatus !== "active" ||
      current.isDeleted ||
      (current.role !== "owner" && current.role !== "editor")
    ) {
      return { status: "rejected", code: "forbidden" };
    }
    if (current.keyEpoch !== input.expectedKeyEpoch) {
      return { status: "rejected", code: "stale-epoch" };
    }
    if (current.rotationFenced) {
      return { status: "rejected", code: "rotation-pending" };
    }
    if (current.rootSectionId) {
      const manifest = latestCheckpointManifest(
        context,
        input.noteId,
        current.rootSectionId,
        current.keyEpoch
      );
      const outcome = {
        sectionId: current.rootSectionId,
        keyEpoch: current.keyEpoch,
        rootVersion: current.rootVersion,
        version: current.version,
        ...(manifest ? { manifestId: manifest.id } : {})
      };
      if (current.contentCipher === "" || current.initializationManifestId) {
        return { status: "complete", ...outcome };
      }
      if (current.rootSectionId === input.sectionId) {
        return { status: "reserved", ...outcome };
      }
      if (manifest || !isStaleReservation(context, current.sectionUpdatedAt)) {
        return { status: "pending", ...outcome };
      }
      if (current.rootVersion !== input.expectedRootVersion) {
        return { status: "rejected", code: "stale-version" };
      }
      context.db.sqlite
        .prepare(`
          UPDATE note_sections
          SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND note_id = ? AND initialization_manifest_id IS NULL
        `)
        .run(current.rootSectionId, input.noteId);
    } else if (current.rootVersion !== input.expectedRootVersion) {
      return { status: "rejected", code: "stale-version" };
    }

    const sectionIdInUse = context.db.sqlite
      .prepare("SELECT id FROM note_sections WHERE id = ?")
      .get(input.sectionId);
    if (sectionIdInUse) {
      return { status: "rejected", code: "forbidden" };
    }

    const updated = context.db.sqlite
      .prepare(`
        UPDATE notes
        SET root_section_id = ?, root_version = root_version + 1,
            version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND root_version = ? AND key_epoch = ?
          AND rotation_fenced = 0 AND content_cipher <> ''
      `)
      .run(
        input.sectionId,
        input.noteId,
        current.rootVersion,
        input.expectedKeyEpoch
      );
    if (updated.changes !== 1) {
      return { status: "rejected", code: "stale-version" };
    }
    context.db.sqlite
      .prepare(`
        INSERT INTO note_sections (id, note_id, created_epoch)
        VALUES (?, ?, ?)
      `)
      .run(input.sectionId, input.noteId, input.expectedKeyEpoch);
    return {
      status: "reserved",
      sectionId: input.sectionId,
      keyEpoch: input.expectedKeyEpoch,
      rootVersion: current.rootVersion + 1,
      version: current.version + 1,
      changed: true
    };
  });
  return reserve.immediate();
}

export function createNoteSection(
  context: AppContext,
  input: {
    sessionId: string;
    userId: string;
    noteId: string;
    sectionId: string;
    expectedKeyEpoch: number;
    expectedRootVersion: number;
  }
): SectionMutationOutcome {
  const create = context.db.sqlite.transaction((): SectionMutationOutcome => {
    const access = writableSectionAccess(context, input);
    if ("code" in access) {
      return access;
    }
    const existing = context.db.sqlite
      .prepare("SELECT note_id AS noteId, is_deleted AS isDeleted FROM note_sections WHERE id = ?")
      .get(input.sectionId) as { noteId: string; isDeleted: number } | undefined;
    if (existing) {
      return existing.noteId === input.noteId && !existing.isDeleted
        ? {
            status: "already-created",
            rootVersion: access.rootVersion,
            version: access.version
          }
        : { status: "rejected", code: "forbidden" };
    }
    if (access.rootVersion !== input.expectedRootVersion) {
      return { status: "rejected", code: "stale-version" };
    }
    const advanced = context.db.sqlite
      .prepare(`
        UPDATE notes
        SET root_version = root_version + 1, version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND root_version = ? AND key_epoch = ? AND rotation_fenced = 0
      `)
      .run(
        input.noteId,
        input.expectedRootVersion,
        input.expectedKeyEpoch
      );
    if (advanced.changes !== 1) {
      return { status: "rejected", code: "stale-version" };
    }
    context.db.sqlite
      .prepare(`
        INSERT INTO note_sections (id, note_id, created_epoch)
        VALUES (?, ?, ?)
      `)
      .run(input.sectionId, input.noteId, input.expectedKeyEpoch);
    return {
      status: "created",
      rootVersion: access.rootVersion + 1,
      version: access.version + 1
    };
  });
  return create.immediate();
}

export function tombstoneNoteSection(
  context: AppContext,
  input: {
    sessionId: string;
    userId: string;
    noteId: string;
    sectionId: string;
    expectedKeyEpoch: number;
    expectedRootVersion: number;
  }
): SectionMutationOutcome {
  const tombstone = context.db.sqlite.transaction((): SectionMutationOutcome => {
    const access = writableSectionAccess(context, input);
    if ("code" in access) {
      return access;
    }
    const section = context.db.sqlite
      .prepare(`
        SELECT is_deleted AS isDeleted
        FROM note_sections
        WHERE id = ? AND note_id = ? AND id <> note_id
      `)
      .get(input.sectionId, input.noteId) as { isDeleted: number } | undefined;
    if (!section) {
      return { status: "rejected", code: "forbidden" };
    }
    if (section.isDeleted) {
      return {
        status: "already-deleted",
        rootVersion: access.rootVersion,
        version: access.version
      };
    }
    if (access.rootVersion !== input.expectedRootVersion) {
      return { status: "rejected", code: "stale-version" };
    }
    const visible = context.db.sqlite
      .prepare(`
        SELECT COUNT(*) AS count
        FROM note_sections
        WHERE note_id = ? AND id <> note_id AND is_deleted = 0
      `)
      .get(input.noteId) as { count: number };
    if (visible.count <= 1) {
      return { status: "rejected", code: "last-section" };
    }
    const advanced = context.db.sqlite
      .prepare(`
        UPDATE notes
        SET root_version = root_version + 1, version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND root_version = ? AND key_epoch = ? AND rotation_fenced = 0
      `)
      .run(
        input.noteId,
        input.expectedRootVersion,
        input.expectedKeyEpoch
      );
    if (advanced.changes !== 1) {
      return { status: "rejected", code: "stale-version" };
    }
    const result = context.db.sqlite
      .prepare(`
        UPDATE note_sections
        SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND note_id = ? AND is_deleted = 0
      `)
      .run(input.sectionId, input.noteId);
    return result.changes === 1
      ? {
          status: "deleted",
          rootVersion: access.rootVersion + 1,
          version: access.version + 1
        }
      : {
          status: "already-deleted",
          rootVersion: access.rootVersion + 1,
          version: access.version + 1
        };
  });
  return tombstone.immediate();
}

export function listVisibleNoteSections(
  context: AppContext,
  noteId: string
): NoteSectionRecord[] {
  return context.db.sqlite
    .prepare(`
      SELECT
        id,
        note_id AS noteId,
        created_epoch AS createdEpoch,
        current_sequence AS currentSequence,
        initialization_manifest_id AS initializationManifestId,
        is_deleted AS isDeleted
      FROM note_sections
      WHERE note_id = ? AND id <> note_id AND is_deleted = 0
      ORDER BY created_at, id
    `)
    .all(noteId) as NoteSectionRecord[];
}

function readInitialization(
  context: AppContext,
  noteId: string,
  sectionId: string,
  keyEpoch: number
): { manifestId: string } | null {
  return (context.db.sqlite
    .prepare(`
      SELECT manifest_id AS manifestId
      FROM crdt_initializations
      WHERE note_id = ? AND section_id = ? AND key_epoch = ?
    `)
    .get(noteId, sectionId, keyEpoch) ?? null) as { manifestId: string } | null;
}

function clearLegacyContentForInitializedRoot(
  context: AppContext,
  noteId: string,
  storedSectionId: string
): void {
  context.db.sqlite
    .prepare(`
      UPDATE notes
      SET content_cipher = '', content_nonce = '', content_length = 0,
          content_updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND root_section_id = ? AND content_cipher <> ''
    `)
    .run(noteId, storedSectionId);
}

function latestCheckpointManifest(
  context: AppContext,
  noteId: string,
  sectionId: string,
  keyEpoch: number
): { id: string } | null {
  return (context.db.sqlite
    .prepare(`
      SELECT id
      FROM content_manifests
      WHERE note_id = ? AND section_id = ? AND key_epoch = ? AND kind = 'checkpoint'
      ORDER BY last_sequence DESC
      LIMIT 1
    `)
    .get(noteId, sectionId, keyEpoch) ?? null) as { id: string } | null;
}

function isStaleReservation(context: AppContext, updatedAt: string | null): boolean {
  if (!updatedAt) {
    return true;
  }
  const stale = context.db.sqlite
    .prepare(`SELECT datetime(?) <= datetime('now', '-30 seconds') AS stale`)
    .get(updatedAt) as { stale: number };
  return Boolean(stale.stale);
}

function writableSectionAccess(
  context: AppContext,
  input: {
    sessionId: string;
    userId: string;
    noteId: string;
    expectedKeyEpoch: number;
  }
):
  | NoteSectionAccess
  | Extract<SectionMutationOutcome, { status: "rejected" }> {
  if (!isSessionActive(context.db, input.sessionId)) {
    return { status: "rejected", code: "forbidden" };
  }
  const access = readNoteSectionAccess(context, input.noteId, input.userId);
  if (
    access?.status !== "active" ||
    access.isDeleted ||
    (access.role !== "owner" && access.role !== "editor")
  ) {
    return { status: "rejected", code: "forbidden" };
  }
  if (access.keyEpoch !== input.expectedKeyEpoch) {
    return { status: "rejected", code: "stale-epoch" };
  }
  if (access.rotationFenced) {
    return { status: "rejected", code: "rotation-pending" };
  }
  return access;
}
