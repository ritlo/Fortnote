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
  rootVersion: number;
  rotationFenced: number;
  isDeleted: number;
  role: "owner" | "editor" | "viewer";
  status: "active" | "revoked";
}

export type SectionInitializationOutcome =
  | { status: "installed" | "already-initialized"; manifestId: string }
  | {
      status: "rejected";
      code: "forbidden" | "rotation-pending" | "stale-epoch" | "stale-version";
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
    return { status: "installed", manifestId: input.manifestId };
  });
  return commit.immediate();
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
