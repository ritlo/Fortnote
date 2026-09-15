import { notifyCrdtSectionChange } from "./changes";
import { getSnapshotVersion, ROOT_SECTION_ID } from "./document";
import { editCrdtNote } from "./lifecycle";
import { broadcastCheckpoint } from "./outbound";
import {
  bindingKey,
  bindings,
  bindingsForNote,
  isActiveBinding,
  isBinding,
  seedBinding,
  throwIfCrdtHistoryUnreadable,
  type Binding
} from "./state";

export async function ensureCrdtHistoryReadable(
  noteId: string,
  sectionId?: string
): Promise<void> {
  const candidates = sectionId
    ? [bindings.get(bindingKey(noteId, sectionId))].filter(isBinding)
    : bindingsForNote(noteId);
  if (candidates.length === 0) {
    return;
  }
  for (const binding of candidates) {
    await binding.receiving;
    throwIfCrdtHistoryUnreadable(binding);
    if (!binding.ready) {
      throw new Error("Realtime history is still synchronizing");
    }
  }
}

export async function finishCrdtSync(
  noteId: string,
  keyEpoch: number,
  sectionId: string,
  serverSequence: number
): Promise<void> {
  const binding = bindings.get(bindingKey(noteId, sectionId));
  if (!binding || !isActiveBinding(binding) || binding.keyEpoch !== keyEpoch) {
    return;
  }
  binding.observedServerSequence = Math.max(
    binding.observedServerSequence,
    serverSequence
  );
  notifyCrdtSectionChange(binding);
  await finishBindingSync(binding, keyEpoch);
}

async function finishBindingSync(binding: Binding, keyEpoch: number): Promise<void> {
  await binding.receiving;
  if (!isActiveBinding(binding) || binding.note.keyEpoch !== keyEpoch || binding.ready) {
    return;
  }
  throwIfCrdtHistoryUnreadable(binding);
  if (binding.sectionId === ROOT_SECTION_ID && binding.appliedUpdateCount > 0) {
    binding.titleAuthorityVersion = Math.max(
      binding.titleAuthorityVersion,
      getSnapshotVersion(binding.doc)
    );
  }
  if (binding.appliedUpdateCount === 0 && !binding.snapshotSeeded) {
    seedBinding(
      binding,
      binding.sectionId === ROOT_SECTION_ID && binding.pendingPatch.title !== undefined
        ? { ...binding.note, title: binding.pendingPatch.title }
        : binding.note
    );
    if (binding.sectionId === ROOT_SECTION_ID) {
      binding.titleAuthorityVersion = Math.max(
        binding.titleAuthorityVersion,
        binding.note.version
      );
    }
    binding.snapshotSeeded = true;
    if (binding.note.role !== "viewer") {
      await broadcastCheckpoint(binding);
    }
  }
  binding.ready = true;
  binding.provider.emit("synced");
  notifyCrdtSectionChange(binding);
  const shouldRepublishInheritedEpochState =
    binding.inheritedEpochState && binding.note.role !== "viewer";
  binding.inheritedEpochState = false;
  if (shouldRepublishInheritedEpochState) {
    void broadcastCheckpoint(binding).catch(() => undefined);
  }
  const pendingPatch = binding.pendingPatch;
  binding.pendingPatch = {};
  if (binding.sectionId === ROOT_SECTION_ID && pendingPatch.title !== undefined) {
    editCrdtNote(binding.note, pendingPatch);
  }
}
