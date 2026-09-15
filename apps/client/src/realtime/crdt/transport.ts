import {
  CRDT_BINARY_FORMAT_VERSION,
  CRDT_BINARY_HEADER_MAX_BYTES,
  fromBase64,
  toBase64,
  type CrdtBinaryHeader,
  type CrdtManifestReferenceV2,
  type EncryptedCrdtMessage
} from "@fortnote/shared";
import {
  CONTENT_CHUNK_AUTH_BYTES,
  decryptCrdtMessage,
  encryptContentChunksV2,
  encryptCrdtMessage,
  type PreparedEncryptedContentV2
} from "../../cryptoClient";
import type { ContentManifestSummary } from "../../api";
import {
  downloadVerifiedContent,
  type VerifiedContentDownloadInput
} from "../contentTransfer";

const REALTIME_FRAME_MAX_BYTES = 256 * 1024;

export interface DurableDelivery<T> {
  durable: Promise<void>;
  delivered: Promise<T>;
}

export interface ScopedEncryptedCrdtMessage {
  type: "crdt-update" | "crdt-checkpoint";
  formatVersion: typeof CRDT_BINARY_FORMAT_VERSION;
  updateId: string;
  noteId: string;
  cryptoOwnerId: string;
  keyEpoch: number;
  sectionId: string;
  kind: "update" | "checkpoint" | "root-update";
  cipher: string;
  nonce: string;
  compactedUpdateIds?: string[];
  checkpointSequenceCutoff?: number;
}

export type ReceivedBinaryCrdtMessage = CrdtBinaryHeader & { cipher: Uint8Array };
export type IncomingCrdtMessage =
  | EncryptedCrdtMessage
  | ScopedEncryptedCrdtMessage
  | ReceivedBinaryCrdtMessage
  | CrdtManifestReferenceV2;

export interface CrdtTransport {
  discard: (noteId: string, beforeKeyEpoch: number) => void;
  subscribe: (
    noteId: string,
    sectionId?: string,
    keyEpoch?: number,
    afterSequence?: number
  ) => void;
  unsubscribe?: (noteId: string, sectionId: string, keyEpoch: number) => void;
  send: (update: ScopedEncryptedCrdtMessage) => Promise<void>;
  sendDurably?: (update: ScopedEncryptedCrdtMessage) => DurableDelivery<void>;
  sendContent?: (prepared: PreparedEncryptedContentV2) => Promise<ContentManifestSummary>;
  sendContentDurably?: (
    prepared: PreparedEncryptedContentV2
  ) => DurableDelivery<ContentManifestSummary>;
  downloadContent?: (input: VerifiedContentDownloadInput) => Promise<Uint8Array>;
}

type PreparedOutbound =
  | { storage: "content"; prepared: PreparedEncryptedContentV2 }
  | { storage: "inline"; update: ScopedEncryptedCrdtMessage };

export async function prepareOutbound(
  envelope: Omit<ScopedEncryptedCrdtMessage, "cipher" | "nonce">,
  noteKeyBase64: string,
  update: Uint8Array
): Promise<PreparedOutbound> {
  if (requiresContentTransfer(update.byteLength)) {
    const prepared = await encryptContentChunksV2({
      cryptoOwnerId: envelope.cryptoOwnerId,
      noteId: envelope.noteId,
      sectionId: envelope.sectionId,
      keyEpoch: envelope.keyEpoch,
      updateId: envelope.updateId,
      kind: envelope.kind,
      ...(envelope.checkpointSequenceCutoff === undefined
        ? {}
        : { checkpointSequenceCutoff: envelope.checkpointSequenceCutoff }),
      noteKey: fromBase64(noteKeyBase64),
      plaintext: update
    });
    return { storage: "content", prepared };
  }
  const encrypted = await encryptCrdtMessage({
    ...envelope,
    noteKeyBase64,
    update
  });
  return {
    storage: "inline",
    update: {
      ...envelope,
      cipher: encrypted.cipher,
      nonce: encrypted.nonce
    }
  };
}

export function sendOutbound(
  currentTransport: CrdtTransport,
  outbound: PreparedOutbound
): DurableDelivery<ContentManifestSummary | null> {
  if (outbound.storage === "inline") {
    const delivery =
      currentTransport.sendDurably?.(outbound.update) ??
      (() => {
        const delivered = Promise.resolve(currentTransport.send(outbound.update));
        return { durable: delivered, delivered };
      })();
    return {
      durable: delivery.durable,
      delivered: delivery.delivered.then(() => null)
    };
  }
  const durableDelivery = currentTransport.sendContentDurably?.(outbound.prepared);
  if (durableDelivery) {
    return durableDelivery;
  }
  if (!currentTransport.sendContent) {
    throw new Error("Resumable encrypted content transport is unavailable");
  }
  const delivered = Promise.resolve(currentTransport.sendContent(outbound.prepared));
  return { durable: delivered.then(() => undefined), delivered };
}

export function requiresContentTransfer(plaintextBytes: number): boolean {
  return (
    plaintextBytes + CONTENT_CHUNK_AUTH_BYTES + CRDT_BINARY_HEADER_MAX_BYTES >
    REALTIME_FRAME_MAX_BYTES
  );
}

export function decryptReceivedUpdate(input: {
  update: IncomingCrdtMessage;
  noteKeyBase64: string;
  downloadContent?: CrdtTransport["downloadContent"];
  onProgress: (progress: unknown) => void;
}): Promise<Uint8Array> {
  const { update } = input;
  if (update.type === "crdt-manifest") {
    const manifest: ContentManifestSummary = {
      manifestId: update.manifestId,
      uploadId: update.uploadId,
      updateId: update.updateId,
      noteId: update.noteId,
      sectionId: update.sectionId,
      cryptoOwnerId: update.cryptoOwnerId,
      keyEpoch: update.keyEpoch,
      kind: update.kind,
      firstSequence: update.serverSequence,
      lastSequence: update.serverSequence,
      totalCipherBytes: update.totalCipherBytes,
      chunkCount: update.chunkCount,
      manifestHash: update.manifestHash,
      ...(update.checkpointSequenceCutoff === undefined
        ? {}
        : { checkpointSequenceCutoff: update.checkpointSequenceCutoff })
    };
    const download = input.downloadContent ?? downloadVerifiedContent;
    return download({
      manifest,
      cryptoOwnerId: update.cryptoOwnerId,
      noteKey: fromBase64(input.noteKeyBase64),
      onProgress: input.onProgress
    });
  }
  if (update.type !== "crdt-binary") {
    return decryptCrdtMessage({
      ...update,
      noteKeyBase64: input.noteKeyBase64
    });
  }
  return decryptCrdtMessage({
    type: update.kind === "checkpoint" ? "crdt-checkpoint" : "crdt-update",
    formatVersion: CRDT_BINARY_FORMAT_VERSION,
    updateId: update.updateId,
    noteId: update.noteId,
    sectionId: update.sectionId,
    cryptoOwnerId: update.cryptoOwnerId,
    keyEpoch: update.expectedKeyEpoch,
    kind: update.kind,
    ...(update.checkpointSequenceCutoff === undefined
      ? {}
      : { checkpointSequenceCutoff: update.checkpointSequenceCutoff }),
    cipher: toBase64(update.cipher),
    nonce: update.nonce,
    noteKeyBase64: input.noteKeyBase64
  });
}
