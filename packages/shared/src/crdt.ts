import { utf8 } from "./crypto.js";

export const CRDT_REALTIME_CAPABILITY = "crdt-v1";
export const CRDT_UPDATE_FORMAT_VERSION = 1;

export interface EncryptedCrdtUpdate {
  type: "crdt-update";
  formatVersion: typeof CRDT_UPDATE_FORMAT_VERSION;
  updateId: string;
  noteId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  cipher: string;
  nonce: string;
}

export interface EncryptedCrdtCheckpoint
  extends Omit<EncryptedCrdtUpdate, "type"> {
  type: "crdt-checkpoint";
  compactedUpdateIds: string[];
}

export type EncryptedCrdtMessage =
  | EncryptedCrdtUpdate
  | EncryptedCrdtCheckpoint;

export interface CrdtAck {
  type: "crdt-ack";
  updateId: string;
}

export interface CrdtReject {
  type: "crdt-reject";
  noteId: string;
  updateId: string;
  reason: "storage-limit";
}

export function crdtUpdateAssociatedData(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  updateId: string;
  formatVersion: number;
}): Uint8Array {
  return utf8(
    `fortnote:crdt-update:v${String(input.formatVersion)}:${input.cryptoOwnerId}:${input.noteId}:${String(input.keyEpoch)}:${input.updateId}`
  );
}

export function crdtCheckpointAssociatedData(input: {
  cryptoOwnerId: string;
  noteId: string;
  keyEpoch: number;
  updateId: string;
  formatVersion: number;
  compactedUpdateIds: string[];
}): Uint8Array {
  return utf8(
    `fortnote:crdt-checkpoint:v${String(input.formatVersion)}:${input.cryptoOwnerId}:${input.noteId}:${String(input.keyEpoch)}:${input.updateId}:${[...input.compactedUpdateIds].sort().join(",")}`
  );
}
