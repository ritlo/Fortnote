import type { AppContext } from "../http/app.js";

export const ROOT_CRDT_SECTION_ID = "root";

export interface NoteSectionRecord {
  id: string;
  noteId: string;
  createdEpoch: number;
  currentSequence: number;
  initializationManifestId: string | null;
  isDeleted: number;
}

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
