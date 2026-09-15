import * as Y from "yjs";
import { notifyCrdtSectionChange } from "./changes";
import { REMOTE_UPDATE } from "./document";
import { clearCheckpointCoverage, trackUpdate } from "./outbound";
import { getCrdtTransport } from "./runtime";
import { bindingKey, bindings, isActiveBinding } from "./state";
import { decryptReceivedUpdate, type IncomingCrdtMessage } from "./transport";

export function receiveCrdtUpdate(update: IncomingCrdtMessage): Promise<void> {
  const binding = bindings.get(bindingKey(update.noteId, update.sectionId));
  if (
    binding?.note.cryptoOwnerId !== update.cryptoOwnerId ||
    binding.note.keyEpoch !== messageKeyEpoch(update)
  ) {
    return Promise.resolve();
  }
  const received = binding.receiving.then(async () => {
    try {
      const currentTransport = getCrdtTransport();
      const plaintext = await decryptReceivedUpdate({
        update,
        noteKeyBase64: binding.note.noteKeyBase64,
        ...(currentTransport?.downloadContent
          ? { downloadContent: currentTransport.downloadContent }
          : {}),
        onProgress: (progress) => {
          binding.provider.emit("progress", progress);
        }
      });
      if (
        !isActiveBinding(binding) ||
        binding.note.keyEpoch !== messageKeyEpoch(update)
      ) {
        return;
      }
      Y.applyUpdate(binding.doc, plaintext, REMOTE_UPDATE);
      binding.appliedUpdateCount += 1;
      binding.failedUpdateIds.delete(update.updateId);
      if (update.serverSequence) {
        binding.observedServerSequence = Math.max(
          binding.observedServerSequence,
          update.serverSequence
        );
        binding.receivedServerSequences.set(update.updateId, update.serverSequence);
        clearCheckpointCoverage(binding, update);
      }
      trackUpdate(binding, update.updateId);
      notifyCrdtSectionChange(binding);
    } catch (error) {
      if (!isActiveBinding(binding)) {
        return;
      }
      binding.failedUpdateIds.add(update.updateId);
      binding.pendingUpdateIds.add(update.updateId);
      if (update.serverSequence) {
        binding.receivedServerSequences.set(update.updateId, update.serverSequence);
      }
      throw error;
    }
  });
  binding.receiving = received.catch(() => undefined);
  return received;
}

function messageKeyEpoch(update: IncomingCrdtMessage): number {
  return update.type === "crdt-binary" ? update.expectedKeyEpoch : update.keyEpoch;
}
