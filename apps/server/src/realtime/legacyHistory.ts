import type { EncryptedCrdtMessage } from "@fortnote/shared";

export type LegacyHistoryPersistOutcome =
  "inserted" | "duplicate" | "storage-limit" | "forbidden";

export interface PersistLegacyHistoryInput {
  sessionId: string;
  userId: string;
  update: EncryptedCrdtMessage;
  maxEnvelopes: number;
  maxBytes: number;
}

export interface LegacyHistoryRepository {
  list(noteId: string, keyEpoch: number): Promise<EncryptedCrdtMessage[]>;
  persist(input: PersistLegacyHistoryInput): Promise<LegacyHistoryPersistOutcome>;
}

export interface LegacyHistoryRow {
  updateId: string;
  noteId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  formatVersion: number;
  cipher: string;
  nonce: string;
  kind: string;
  compactedUpdateIds: string | null;
}

export function legacyStorageLimitExceeded(
  storedUpdates: { updateId: string; cipher: string }[],
  input: Pick<PersistLegacyHistoryInput, "update" | "maxEnvelopes" | "maxBytes">
): boolean {
  const compactedIds = new Set(
    input.update.type === "crdt-checkpoint" ? input.update.compactedUpdateIds : []
  );
  const compactedUpdates = storedUpdates.filter(({ updateId }) =>
    compactedIds.has(updateId)
  );
  const storedBytes = storedUpdates.reduce(
    (total, stored) => total + Buffer.byteLength(stored.cipher, "utf8"),
    0
  );
  const compactedBytes = compactedUpdates.reduce(
    (total, stored) => total + Buffer.byteLength(stored.cipher, "utf8"),
    0
  );
  return (
    storedUpdates.length + 1 - compactedUpdates.length > input.maxEnvelopes ||
    storedBytes + Buffer.byteLength(input.update.cipher, "utf8") - compactedBytes >
      input.maxBytes
  );
}

export function legacyHistoryValues(update: EncryptedCrdtMessage) {
  return {
    updateId: update.updateId,
    noteId: update.noteId,
    cryptoOwnerId: update.cryptoOwnerId,
    keyEpoch: update.keyEpoch,
    formatVersion: update.formatVersion,
    cipher: update.cipher,
    nonce: update.nonce,
    kind: update.type === "crdt-checkpoint" ? "checkpoint" : "update",
    compactedUpdateIds:
      update.type === "crdt-checkpoint" ? JSON.stringify(update.compactedUpdateIds) : null
  };
}

export function legacyHistoryMessage(row: LegacyHistoryRow): EncryptedCrdtMessage {
  const envelope = {
    formatVersion: row.formatVersion as 1,
    updateId: row.updateId,
    noteId: row.noteId,
    cryptoOwnerId: row.cryptoOwnerId,
    keyEpoch: row.keyEpoch,
    cipher: row.cipher,
    nonce: row.nonce
  };
  return row.kind === "checkpoint"
    ? {
        ...envelope,
        type: "crdt-checkpoint",
        compactedUpdateIds: JSON.parse(row.compactedUpdateIds ?? "[]") as string[]
      }
    : { ...envelope, type: "crdt-update" };
}
