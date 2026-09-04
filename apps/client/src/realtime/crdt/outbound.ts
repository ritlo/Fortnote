import {
  CRDT_BINARY_FORMAT_VERSION,
  randomUuid,
  type CrdtManifestReferenceV2
} from "@fortnote/shared";
import * as Y from "yjs";
import { notifyCrdtSectionChange } from "./changes";
import { ROOT_SECTION_ID } from "./document";
import { waitForCrdtTransport } from "./runtime";
import {
  canWrite,
  isActiveBindingForNote,
  throwIfCrdtHistoryUnreadable,
  type Binding
} from "./state";
import {
  prepareOutbound,
  sendOutbound,
  type DurableDelivery,
  type ReceivedBinaryCrdtMessage,
  type ScopedEncryptedCrdtMessage
} from "./transport";

const CHECKPOINT_UPDATE_COUNT = 64;

export function broadcastUpdate(
  binding: Binding,
  update: Uint8Array
): DurableDelivery<void> {
  const pending = (async () => {
    const note = binding.note;
    if (!isActiveBindingForNote(binding, note)) {
      return null;
    }
    const currentTransport = await waitForCrdtTransport();
    if (!isActiveBindingForNote(binding, note)) {
      return null;
    }
    const updateId = randomUuid();
    const kind = binding.sectionId === ROOT_SECTION_ID ? "root-update" : "update";
    const envelope = {
      type: "crdt-update" as const,
      formatVersion: CRDT_BINARY_FORMAT_VERSION,
      updateId,
      noteId: note.id,
      cryptoOwnerId: note.cryptoOwnerId,
      keyEpoch: note.keyEpoch,
      sectionId: binding.sectionId,
      kind
    } satisfies Omit<ScopedEncryptedCrdtMessage, "cipher" | "nonce">;
    const outbound = await prepareOutbound(
      envelope,
      note.noteKeyBase64,
      update
    );
    if (!isActiveBindingForNote(binding, note)) {
      return null;
    }
    const delivery = sendOutbound(currentTransport, outbound);
    trackUpdate(binding, updateId);
    return { delivery, note };
  })();
  return {
    durable: pending.then(async (result) => {
      await result?.delivery.durable;
    }),
    delivered: pending.then(async (result) => {
      if (!result) {
        return;
      }
      const manifest = await result.delivery.delivered;
      if (manifest && isActiveBindingForNote(binding, result.note)) {
        binding.observedServerSequence = Math.max(
          binding.observedServerSequence,
          manifest.lastSequence
        );
        notifyCrdtSectionChange(binding);
      }
    })
  };
}

export async function broadcastCheckpoint(
  binding: Binding,
  updateId: string = randomUuid()
): Promise<void> {
  if (!canWrite(binding)) {
    return;
  }
  const note = binding.note;
  if (!isActiveBindingForNote(binding, note)) {
    return;
  }
  throwIfCrdtHistoryUnreadable(binding);
  binding.checkpointing = true;
  const compactedUpdateIds = [...binding.pendingUpdateIds].slice(0, 100);
  const checkpointSequenceCutoff = binding.observedServerSequence;
  const envelope = {
    type: "crdt-checkpoint" as const,
    formatVersion: CRDT_BINARY_FORMAT_VERSION,
    updateId,
    noteId: note.id,
    cryptoOwnerId: note.cryptoOwnerId,
    keyEpoch: note.keyEpoch,
    sectionId: binding.sectionId,
    kind: "checkpoint" as const,
    compactedUpdateIds,
    checkpointSequenceCutoff
  } satisfies Omit<ScopedEncryptedCrdtMessage, "cipher" | "nonce">;
  try {
    const currentTransport = await waitForCrdtTransport();
    if (!isActiveBindingForNote(binding, note)) {
      return;
    }
    const outbound = await prepareOutbound(
      envelope,
      note.noteKeyBase64,
      Y.encodeStateAsUpdate(binding.doc)
    );
    if (!isActiveBindingForNote(binding, note)) {
      return;
    }
    const manifest = await sendOutbound(currentTransport, outbound).delivered;
    if (!isActiveBindingForNote(binding, note)) {
      return;
    }
    if (manifest) {
      binding.observedServerSequence = Math.max(
        binding.observedServerSequence,
        manifest.lastSequence
      );
      notifyCrdtSectionChange(binding);
    }
    compactedUpdateIds.forEach((id) => binding.pendingUpdateIds.delete(id));
    compactedUpdateIds.forEach((id) => binding.failedUpdateIds.delete(id));
    compactedUpdateIds.forEach((id) => binding.receivedServerSequences.delete(id));
    binding.pendingUpdateIds.add(updateId);
  } finally {
    binding.checkpointing = false;
  }
}

export function clearCheckpointCoverage(
  binding: Binding,
  update: ReceivedBinaryCrdtMessage | CrdtManifestReferenceV2
): void {
  if (update.kind !== "checkpoint" || update.checkpointSequenceCutoff === undefined) {
    return;
  }
  for (const [updateId, serverSequence] of binding.receivedServerSequences) {
    if (serverSequence <= update.checkpointSequenceCutoff) {
      binding.pendingUpdateIds.delete(updateId);
      binding.failedUpdateIds.delete(updateId);
      binding.receivedServerSequences.delete(updateId);
    }
  }
}

export function trackUpdate(binding: Binding, updateId: string): void {
  binding.pendingUpdateIds.add(updateId);
  if (
    binding.ready &&
    canWrite(binding) &&
    binding.pendingUpdateIds.size >= CHECKPOINT_UPDATE_COUNT &&
    !binding.checkpointing
  ) {
    void broadcastCheckpoint(binding).catch(() => undefined);
  }
}
