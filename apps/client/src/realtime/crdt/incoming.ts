import * as Y from "yjs";
import { notifyCrdtSectionChange } from "./changes";
import { REMOTE_UPDATE } from "./document";
import { clearCheckpointCoverage, trackUpdate } from "./outbound";
import { getCrdtTransport } from "./runtime";
import { isApiRequestError } from "../../api/http";
import {
  bindingKey,
  bindings,
  CrdtUpdateError,
  isActiveBinding,
  type Binding,
  type CrdtUpdateFailure
} from "./state";
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
    let plaintext: Uint8Array;
    try {
      const currentTransport = getCrdtTransport();
      plaintext = await decryptReceivedUpdate({
        update,
        noteKeyBase64: binding.note.noteKeyBase64,
        ...(currentTransport?.downloadContent
          ? { downloadContent: currentTransport.downloadContent }
          : {}),
        onProgress: (progress) => {
          binding.provider.emit("progress", progress);
        }
      });
    } catch (error) {
      const failure =
        update.type === "crdt-manifest" && isContentUnavailable(error)
          ? "unavailable"
          : "unreadable";
      if (recordFailure(binding, update, failure)) {
        throw new CrdtUpdateError(failure, error);
      }
      return;
    }
    if (!isActiveBinding(binding) || binding.note.keyEpoch !== messageKeyEpoch(update)) {
      return;
    }
    let displayError: unknown = null;
    const application = { merged: false };
    const markMerged = (transaction: Y.Transaction) => {
      application.merged ||= transaction.origin === REMOTE_UPDATE;
    };
    // Yjs merges an update before it calls observers, so an error raised after
    // this event comes from a view such as the editor, not from the update.
    binding.doc.on("beforeObserverCalls", markMerged);
    try {
      Y.applyUpdate(binding.doc, plaintext, REMOTE_UPDATE);
    } catch (error) {
      if (!application.merged) {
        recordFailure(binding, update, "unreadable");
        throw new CrdtUpdateError("unreadable", error);
      }
      displayError = error;
    } finally {
      binding.doc.off("beforeObserverCalls", markMerged);
    }
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
    if (displayError !== null) {
      throw new CrdtUpdateError("display", displayError);
    }
  });
  binding.receiving = received.catch(() => undefined);
  return received;
}

function recordFailure(
  binding: Binding,
  update: IncomingCrdtMessage,
  failure: CrdtUpdateFailure
): boolean {
  if (!isActiveBinding(binding)) {
    return false;
  }
  binding.failedUpdateIds.set(update.updateId, failure);
  binding.pendingUpdateIds.add(update.updateId);
  if (update.serverSequence) {
    binding.receivedServerSequences.set(update.updateId, update.serverSequence);
  }
  return true;
}

/** A manifest whose chunks could not be fetched, as opposed to failing verification. */
function isContentUnavailable(error: unknown): boolean {
  return (
    isApiRequestError(error) ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof TypeError && /fetch|network|load failed/iu.test(error.message))
  );
}

function messageKeyEpoch(update: IncomingCrdtMessage): number {
  return update.type === "crdt-binary" ? update.expectedKeyEpoch : update.keyEpoch;
}
