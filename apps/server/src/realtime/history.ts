import { fromCanonicalBase64, type CrdtBinaryHeader } from "@fortnote/shared";
import type { AppContext } from "../http/app.js";
import { isSessionActive } from "../auth/session.js";
import {
  ensureNoteSection,
  storageSectionId
} from "../notes/sections.js";

export type BinaryUpdateOutcome =
  | { status: "inserted" | "already-present"; serverSequence: number }
  | {
      status: "rejected";
      code: "forbidden" | "rotation-pending" | "stale-epoch" | "storage-limit";
    };

export interface SectionHistoryEntry {
  updateId: string;
  serverSequence: number;
  cryptoOwnerId: string;
  keyEpoch: number;
  formatVersion: number;
  kind: "update" | "checkpoint" | "root-update";
  inlineCipher: Buffer;
  nonce: Buffer;
}

export interface SectionHistoryPage {
  entries: SectionHistoryEntry[];
  hasMore: boolean;
  nextSequence: number;
}

interface AccessRow {
  cryptoOwnerId: string;
  keyEpoch: number;
  rotationFenced: number;
  isDeleted: number;
  role: string;
  status: string;
}

interface ExistingUpdateRow {
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  serverSequence: number;
}

export function persistBinaryUpdate(
  context: AppContext,
  input: {
    sessionId: string;
    userId: string;
    header: CrdtBinaryHeader;
    cipher: Uint8Array;
  }
): BinaryUpdateOutcome {
  const commit = context.db.sqlite.transaction((): BinaryUpdateOutcome => {
    if (!isSessionActive(context.db, input.sessionId)) {
      return { status: "rejected", code: "forbidden" };
    }
    const access = readAccess(context, input.header.noteId, input.userId);
    if (access?.status !== "active" || access.isDeleted) {
      return { status: "rejected", code: "forbidden" };
    }
    if (access.rotationFenced) {
      return { status: "rejected", code: "rotation-pending" };
    }
    if (access.keyEpoch !== input.header.expectedKeyEpoch) {
      return { status: "rejected", code: "stale-epoch" };
    }
    if (
      (access.role !== "owner" && access.role !== "editor") ||
      access.cryptoOwnerId !== input.header.cryptoOwnerId
    ) {
      return { status: "rejected", code: "forbidden" };
    }
    const section = ensureNoteSection(
      context,
      input.header.noteId,
      input.header.sectionId,
      access.keyEpoch
    );
    if (!section) {
      return { status: "rejected", code: "forbidden" };
    }

    const storedSectionId = storageSectionId(input.header.noteId, input.header.sectionId);
    const existing = context.db.sqlite
      .prepare(`
        SELECT
          note_id AS noteId,
          section_id AS sectionId,
          key_epoch AS keyEpoch,
          server_sequence AS serverSequence
        FROM section_updates WHERE update_id = ?
      `)
      .get(input.header.updateId) as ExistingUpdateRow | undefined;
    if (existing) {
      return existing.noteId === input.header.noteId &&
        existing.sectionId === storedSectionId &&
        existing.keyEpoch === input.header.expectedKeyEpoch
        ? { status: "already-present", serverSequence: existing.serverSequence }
        : { status: "rejected", code: "forbidden" };
    }

    const nextSequence = section.currentSequence + 1;
    context.db.sqlite
      .prepare(`
        INSERT INTO section_updates (
          update_id, note_id, section_id, server_sequence, crypto_owner_id,
          key_epoch, format_version, kind, inline_cipher, nonce
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.header.updateId,
        input.header.noteId,
        storedSectionId,
        nextSequence,
        input.header.cryptoOwnerId,
        input.header.expectedKeyEpoch,
        input.header.formatVersion,
        input.header.kind,
        Buffer.from(input.cipher),
        Buffer.from(fromCanonicalBase64(input.header.nonce))
      );
    context.db.sqlite
      .prepare(`
        UPDATE note_sections
        SET current_sequence = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND note_id = ?
      `)
      .run(nextSequence, storedSectionId, input.header.noteId);
    return { status: "inserted", serverSequence: nextSequence };
  });
  return commit.immediate();
}

export function listSectionHistory(
  context: AppContext,
  input: {
    noteId: string;
    sectionId: string;
    keyEpoch: number;
    afterSequence: number;
  }
): SectionHistoryPage {
  const section = ensureNoteSection(
    context,
    input.noteId,
    input.sectionId,
    input.keyEpoch
  );
  if (!section) {
    return { entries: [], hasMore: false, nextSequence: input.afterSequence };
  }
  const rows = context.db.sqlite
    .prepare(`
      SELECT
        update_id AS updateId,
        server_sequence AS serverSequence,
        crypto_owner_id AS cryptoOwnerId,
        key_epoch AS keyEpoch,
        format_version AS formatVersion,
        kind,
        inline_cipher AS inlineCipher,
        nonce
      FROM section_updates
      WHERE note_id = ? AND section_id = ? AND key_epoch = ? AND server_sequence > ?
      ORDER BY server_sequence
      LIMIT ?
    `)
    .all(
      input.noteId,
      storageSectionId(input.noteId, input.sectionId),
      input.keyEpoch,
      input.afterSequence,
      context.config.historyPageMaxItems + 1
    ) as SectionHistoryEntry[];
  const hasMoreItems = rows.length > context.config.historyPageMaxItems;
  const candidates = rows.slice(0, context.config.historyPageMaxItems);
  const entries: SectionHistoryEntry[] = [];
  let bytes = 0;
  for (const row of candidates) {
    const nextBytes = bytes + row.inlineCipher.length;
    if (entries.length > 0 && nextBytes > context.config.historyPageMaxBytes) {
      break;
    }
    entries.push(row);
    bytes = nextBytes;
  }
  return {
    entries,
    hasMore: hasMoreItems || entries.length < candidates.length,
    nextSequence: entries.at(-1)?.serverSequence ?? input.afterSequence
  };
}

function readAccess(
  context: AppContext,
  noteId: string,
  userId: string
): AccessRow | null {
  return (context.db.sqlite
    .prepare(`
      SELECT
        n.crypto_owner_id AS cryptoOwnerId,
        n.key_epoch AS keyEpoch,
        n.rotation_fenced AS rotationFenced,
        n.is_deleted AS isDeleted,
        m.role,
        m.status
      FROM notes n
      INNER JOIN note_memberships m ON m.note_id = n.id
      WHERE n.id = ? AND m.user_id = ?
    `)
    .get(noteId, userId) ?? null) as AccessRow | null;
}
