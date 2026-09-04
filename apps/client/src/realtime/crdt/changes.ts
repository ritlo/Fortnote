import { ROOT_SECTION_ID } from "./document";
import { isActiveBinding, type Binding } from "./state";

export interface CrdtSectionChange {
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  serverSequence: number;
}

const sectionChangeListeners = new Set<(change: CrdtSectionChange) => void>();

export function subscribeCrdtSectionChanges(
  listener: (change: CrdtSectionChange) => void
): () => void {
  sectionChangeListeners.add(listener);
  return () => {
    sectionChangeListeners.delete(listener);
  };
}

export function notifyCrdtSectionChange(binding: Binding): void {
  if (
    binding.sectionId === ROOT_SECTION_ID ||
    !binding.ready ||
    !isActiveBinding(binding)
  ) {
    return;
  }
  const change = {
    noteId: binding.noteId,
    sectionId: binding.sectionId,
    keyEpoch: binding.keyEpoch,
    serverSequence: binding.observedServerSequence
  };
  sectionChangeListeners.forEach((listener) => {
    try {
      listener(change);
    } catch {
      // Search/index observers must never interrupt CRDT convergence.
    }
  });
}
