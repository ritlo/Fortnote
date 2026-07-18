import { fromCanonicalBase64, type CrdtBinaryHeader } from "@fortnote/shared";
import type { AppContext } from "../http/app.js";
import { isSessionActive } from "../auth/session.js";
import {
  ensureNoteSection,
  readNoteSectionAccess,
  storageSectionId
} from "../notes/sections.js";

export type BinaryUpdateOutcome =
  | { status: "inserted" | "already-present"; serverSequence: number }
  | {
      status: "rejected";
      code: "forbidden" | "rotation-pending" | "stale-epoch" | "storage-limit";
    };

interface SectionHistoryEntryBase {
  updateId: string;
  serverSequence: number;
  cryptoOwnerId: string;
  keyEpoch: number;
  formatVersion: number;
  kind: "update" | "checkpoint" | "root-update";
  checkpointSequenceCutoff: number | null;
}

export interface InlineSectionHistoryEntry extends SectionHistoryEntryBase {
  storage: "inline";
  inlineCipher: Buffer;
  nonce: Buffer;
}

export interface ManifestSectionHistoryEntry extends SectionHistoryEntryBase {
  storage: "manifest";
  manifestId: string;
  uploadId: string;
  totalCipherBytes: number;
  chunkCount: number;
  manifestHash: string;
}

export type SectionHistoryEntry =
  | InlineSectionHistoryEntry
  | ManifestSectionHistoryEntry;

interface SectionHistoryRow extends SectionHistoryEntryBase {
  inlineCipher: Buffer | null;
  nonce: Buffer | null;
  manifestId: string | null;
  uploadId: string | null;
  totalCipherBytes: number | null;
  chunkCount: number | null;
  manifestHash: string | null;
}

export interface SectionHistoryPage {
  entries: SectionHistoryEntry[];
  hasMore: boolean;
  nextSequence: number;
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
    const access = readNoteSectionAccess(context, input.header.noteId, input.userId);
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
    const checkpointCutoff = input.header.checkpointSequenceCutoff;
    if (
      (input.header.kind === "checkpoint") !== (checkpointCutoff !== undefined) ||
      (checkpointCutoff !== undefined && checkpointCutoff > section.currentSequence)
    ) {
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
          key_epoch, format_version, kind, inline_cipher, nonce,
          checkpoint_sequence_cutoff
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        Buffer.from(fromCanonicalBase64(input.header.nonce)),
        input.header.checkpointSequenceCutoff ?? null
      );
    context.db.sqlite
      .prepare(`
        UPDATE note_sections
        SET current_sequence = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND note_id = ?
      `)
      .run(nextSequence, storedSectionId, input.header.noteId);
    if (checkpointCutoff !== undefined && checkpointCutoff > 0) {
      context.db.sqlite
        .prepare(`
          DELETE FROM section_updates
          WHERE note_id = ?
            AND section_id = ?
            AND key_epoch = ?
            AND server_sequence <= ?
            AND update_id <> ?
        `)
        .run(
          input.header.noteId,
          storedSectionId,
          input.header.expectedKeyEpoch,
          checkpointCutoff,
          input.header.updateId
        );
    }
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
        s.update_id AS updateId,
        s.server_sequence AS serverSequence,
        s.crypto_owner_id AS cryptoOwnerId,
        s.key_epoch AS keyEpoch,
        s.format_version AS formatVersion,
        s.kind,
        s.inline_cipher AS inlineCipher,
        s.nonce,
        s.checkpoint_sequence_cutoff AS checkpointSequenceCutoff,
        s.manifest_id AS manifestId,
        m.upload_id AS uploadId,
        m.total_cipher_bytes AS totalCipherBytes,
        m.chunk_count AS chunkCount,
        m.manifest_hash AS manifestHash
      FROM section_updates s
      LEFT JOIN content_manifests m ON m.id = s.manifest_id
      WHERE s.note_id = ? AND s.section_id = ? AND s.key_epoch = ?
        AND s.server_sequence > ?
      ORDER BY s.server_sequence
      LIMIT ?
    `)
    .all(
      input.noteId,
      storageSectionId(input.noteId, input.sectionId),
      input.keyEpoch,
      input.afterSequence,
      context.config.historyPageMaxItems + 1
    ) as SectionHistoryRow[];
  const hasMoreItems = rows.length > context.config.historyPageMaxItems;
  const candidates = rows
    .slice(0, context.config.historyPageMaxItems)
    .map(historyEntry);
  const entries: SectionHistoryEntry[] = [];
  let bytes = 0;
  for (const row of candidates) {
    const nextBytes = bytes + (row.storage === "inline" ? row.inlineCipher.length : 0);
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

function historyEntry(row: SectionHistoryRow): SectionHistoryEntry {
  const base = {
    updateId: row.updateId,
    serverSequence: row.serverSequence,
    cryptoOwnerId: row.cryptoOwnerId,
    keyEpoch: row.keyEpoch,
    formatVersion: row.formatVersion,
    kind: row.kind,
    checkpointSequenceCutoff: row.checkpointSequenceCutoff
  };
  if (row.manifestId) {
    if (
      !row.uploadId ||
      row.totalCipherBytes === null ||
      row.chunkCount === null ||
      !row.manifestHash
    ) {
      throw new Error("Content manifest history is incomplete");
    }
    return {
      ...base,
      storage: "manifest",
      manifestId: row.manifestId,
      uploadId: row.uploadId,
      totalCipherBytes: row.totalCipherBytes,
      chunkCount: row.chunkCount,
      manifestHash: row.manifestHash
    };
  }
  if (!row.inlineCipher || !row.nonce) {
    throw new Error("Inline content history is incomplete");
  }
  return {
    ...base,
    storage: "inline",
    inlineCipher: row.inlineCipher,
    nonce: row.nonce
  };
}
