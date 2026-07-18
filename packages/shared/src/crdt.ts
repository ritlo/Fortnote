import {
  fromCanonicalBase64,
  utf8,
  XCHACHA_NONCE_BYTES
} from "./crypto.js";

export const CRDT_REALTIME_CAPABILITY = "crdt-v1";
export const CRDT_UPDATE_FORMAT_VERSION = 1;
export const CRDT_REALTIME_CAPABILITY_V2 = "crdt-binary-v2";
export const CRDT_BINARY_FORMAT_VERSION = 2;
export const CRDT_BINARY_HEADER_MAX_BYTES = 4096;

export type CrdtBinaryKind = "update" | "checkpoint" | "root-update";

export interface CrdtBinaryHeader {
  type: "crdt-binary";
  kind: CrdtBinaryKind;
  formatVersion: typeof CRDT_BINARY_FORMAT_VERSION;
  updateId: string;
  noteId: string;
  sectionId: string;
  cryptoOwnerId: string;
  expectedKeyEpoch: number;
  nonce: string;
  cipherLength: number;
  checkpointSequenceCutoff?: number;
  serverSequence?: number;
}

export interface CrdtSubscribeV2 {
  type: "crdt-subscribe";
  requestId: string;
  noteId: string;
  sectionId: string;
  expectedKeyEpoch: number;
  afterSequence: number;
}

export interface CrdtAckV2 {
  type: "crdt-ack";
  updateId: string;
  sectionId: string;
  result: "inserted" | "already-present";
  keyEpoch: number;
  serverSequence: number;
}

export type CrdtRejectCode =
  | "storage-limit"
  | "frame-too-large"
  | "stale-epoch"
  | "rotation-pending"
  | "forbidden";

export interface CrdtRejectV2 {
  type: "crdt-reject";
  updateId: string;
  sectionId: string;
  code: CrdtRejectCode;
}

export type CrdtHistoryEntry =
  | {
      kind: "inline";
      updateId: string;
      serverSequence: number;
    }
  | {
      kind: "manifest";
      updateId: string;
      manifestId: string;
      serverSequence: number;
    };

export interface CrdtHistoryPageV2 {
  type: "crdt-history-page";
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  afterSequence: number;
  nextSequence: number;
  hasMore: boolean;
  entries: CrdtHistoryEntry[];
}

export interface CrdtManifestReferenceV2 {
  type: "crdt-manifest";
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  updateId: string;
  manifestId: string;
  serverSequence: number;
}

export type CrdtControlMessageV2 =
  | CrdtSubscribeV2
  | CrdtAckV2
  | CrdtRejectV2
  | CrdtHistoryPageV2
  | CrdtManifestReferenceV2;

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
  reason: "forbidden" | "payload-too-large" | "storage-limit";
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

export function encodeCrdtBinaryFrame(
  header: CrdtBinaryHeader,
  cipher: Uint8Array,
  maxFrameBytes: number
): Uint8Array {
  validateFrameLimit(maxFrameBytes);
  const validated = validateBinaryHeader(header);
  if (validated.cipherLength !== cipher.length) {
    throw new Error("CRDT binary cipher length mismatch");
  }
  const headerBytes = utf8(JSON.stringify(validated));
  if (headerBytes.length === 0 || headerBytes.length > CRDT_BINARY_HEADER_MAX_BYTES) {
    throw new Error("CRDT binary header exceeds limit");
  }
  const frameLength = 4 + headerBytes.length + cipher.length;
  if (frameLength > maxFrameBytes) {
    throw new Error("CRDT binary frame limit exceeded");
  }
  const frame = new Uint8Array(frameLength);
  new DataView(frame.buffer).setUint32(0, headerBytes.length, false);
  frame.set(headerBytes, 4);
  frame.set(cipher, 4 + headerBytes.length);
  return frame;
}

export function decodeCrdtBinaryFrame(
  frame: Uint8Array,
  maxFrameBytes: number
): { header: CrdtBinaryHeader; cipher: Uint8Array } {
  validateFrameLimit(maxFrameBytes);
  if (frame.length > maxFrameBytes) {
    throw new Error("CRDT binary frame limit exceeded");
  }
  if (frame.length < 5) {
    throw new Error("Invalid CRDT binary header");
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength
  ).getUint32(0, false);
  if (
    headerLength === 0 ||
    headerLength > CRDT_BINARY_HEADER_MAX_BYTES ||
    4 + headerLength >= frame.length
  ) {
    throw new Error("Invalid CRDT binary header");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + headerLength))) as unknown;
  } catch {
    throw new Error("Invalid CRDT binary header");
  }
  const header = validateBinaryHeader(parsed);
  const cipher = frame.slice(4 + headerLength);
  if (cipher.length !== header.cipherLength) {
    throw new Error("CRDT binary cipher length mismatch");
  }
  return { header, cipher };
}

export function parseCrdtControlMessage(value: unknown): CrdtControlMessageV2 {
  const record = asRecord(value);
  switch (record.type) {
    case "crdt-subscribe":
      return parseSubscribe(record);
    case "crdt-ack":
      return parseAck(record);
    case "crdt-reject":
      return parseReject(record);
    case "crdt-history-page":
      return parseHistoryPage(record);
    case "crdt-manifest":
      return parseManifestReference(record);
    default:
      throw new Error("Invalid CRDT control message");
  }
}

function validateBinaryHeader(value: unknown): CrdtBinaryHeader {
  const record = asRecord(value);
  if (
    record.type !== "crdt-binary" ||
    !isOneOf(record.kind, ["update", "checkpoint", "root-update"] as const) ||
    record.formatVersion !== CRDT_BINARY_FORMAT_VERSION ||
    !isUuid(record.updateId) ||
    !isUuid(record.noteId) ||
    !isSectionId(record.sectionId) ||
    !isUuid(record.cryptoOwnerId) ||
    !isPositiveInteger(record.expectedKeyEpoch) ||
    typeof record.nonce !== "string" ||
    !isPositiveInteger(record.cipherLength) ||
    (record.checkpointSequenceCutoff !== undefined &&
      !isNonnegativeInteger(record.checkpointSequenceCutoff)) ||
    (record.serverSequence !== undefined && !isPositiveInteger(record.serverSequence))
  ) {
    throw new Error("Invalid CRDT binary header");
  }
  try {
    if (fromCanonicalBase64(record.nonce).length !== XCHACHA_NONCE_BYTES) {
      throw new Error("nonce");
    }
  } catch {
    throw new Error("Invalid CRDT binary header nonce");
  }
  const header: CrdtBinaryHeader = {
    type: "crdt-binary",
    kind: record.kind,
    formatVersion: CRDT_BINARY_FORMAT_VERSION,
    updateId: record.updateId,
    noteId: record.noteId,
    sectionId: record.sectionId,
    cryptoOwnerId: record.cryptoOwnerId,
    expectedKeyEpoch: record.expectedKeyEpoch,
    nonce: record.nonce,
    cipherLength: record.cipherLength
  };
  if (record.checkpointSequenceCutoff !== undefined) {
    header.checkpointSequenceCutoff = record.checkpointSequenceCutoff;
  }
  if (record.serverSequence !== undefined) {
    header.serverSequence = record.serverSequence;
  }
  return header;
}

function parseSubscribe(record: Record<string, unknown>): CrdtSubscribeV2 {
  if (
    !isUuid(record.requestId) ||
    !isUuid(record.noteId) ||
    !isSectionId(record.sectionId) ||
    !isPositiveInteger(record.expectedKeyEpoch) ||
    !isNonnegativeInteger(record.afterSequence)
  ) {
    throw new Error("Invalid CRDT control message");
  }
  return {
    type: "crdt-subscribe",
    requestId: record.requestId,
    noteId: record.noteId,
    sectionId: record.sectionId,
    expectedKeyEpoch: record.expectedKeyEpoch,
    afterSequence: record.afterSequence
  };
}

function parseAck(record: Record<string, unknown>): CrdtAckV2 {
  if (
    !isUuid(record.updateId) ||
    !isSectionId(record.sectionId) ||
    !isOneOf(record.result, ["inserted", "already-present"] as const) ||
    !isPositiveInteger(record.keyEpoch) ||
    !isPositiveInteger(record.serverSequence)
  ) {
    throw new Error("Invalid CRDT control message");
  }
  return {
    type: "crdt-ack",
    updateId: record.updateId,
    sectionId: record.sectionId,
    result: record.result,
    keyEpoch: record.keyEpoch,
    serverSequence: record.serverSequence
  };
}

function parseReject(record: Record<string, unknown>): CrdtRejectV2 {
  if (
    !isUuid(record.updateId) ||
    !isSectionId(record.sectionId) ||
    !isOneOf(
      record.code,
      [
        "storage-limit",
        "frame-too-large",
        "stale-epoch",
        "rotation-pending",
        "forbidden"
      ] as const
    )
  ) {
    throw new Error("Invalid CRDT control message");
  }
  return {
    type: "crdt-reject",
    updateId: record.updateId,
    sectionId: record.sectionId,
    code: record.code
  };
}

function parseHistoryPage(record: Record<string, unknown>): CrdtHistoryPageV2 {
  if (
    !isUuid(record.noteId) ||
    !isSectionId(record.sectionId) ||
    !isPositiveInteger(record.keyEpoch) ||
    !isNonnegativeInteger(record.afterSequence) ||
    !isNonnegativeInteger(record.nextSequence) ||
    typeof record.hasMore !== "boolean" ||
    !Array.isArray(record.entries) ||
    record.entries.length > 128
  ) {
    throw new Error("Invalid CRDT control message");
  }
  const entries = record.entries.map(parseHistoryEntry);
  return {
    type: "crdt-history-page",
    noteId: record.noteId,
    sectionId: record.sectionId,
    keyEpoch: record.keyEpoch,
    afterSequence: record.afterSequence,
    nextSequence: record.nextSequence,
    hasMore: record.hasMore,
    entries
  };
}

function parseHistoryEntry(value: unknown): CrdtHistoryEntry {
  const record = asRecord(value);
  if (!isUuid(record.updateId) || !isPositiveInteger(record.serverSequence)) {
    throw new Error("Invalid CRDT control message");
  }
  if (record.kind === "inline") {
    return {
      kind: "inline",
      updateId: record.updateId,
      serverSequence: record.serverSequence
    };
  }
  if (record.kind === "manifest" && isUuid(record.manifestId)) {
    return {
      kind: "manifest",
      updateId: record.updateId,
      manifestId: record.manifestId,
      serverSequence: record.serverSequence
    };
  }
  throw new Error("Invalid CRDT control message");
}

function parseManifestReference(record: Record<string, unknown>): CrdtManifestReferenceV2 {
  if (
    !isUuid(record.noteId) ||
    !isSectionId(record.sectionId) ||
    !isPositiveInteger(record.keyEpoch) ||
    !isUuid(record.updateId) ||
    !isUuid(record.manifestId) ||
    !isPositiveInteger(record.serverSequence)
  ) {
    throw new Error("Invalid CRDT control message");
  }
  return {
    type: "crdt-manifest",
    noteId: record.noteId,
    sectionId: record.sectionId,
    keyEpoch: record.keyEpoch,
    updateId: record.updateId,
    manifestId: record.manifestId,
    serverSequence: record.serverSequence
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid CRDT control message");
  }
  return value as Record<string, unknown>;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value
    )
  );
}

function isSectionId(value: unknown): value is string {
  return value === "root" || isUuid(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T
): value is T[number] {
  return typeof value === "string" && choices.includes(value);
}

function validateFrameLimit(maxFrameBytes: number): void {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 4) {
    throw new Error("Invalid CRDT binary frame limit");
  }
}
