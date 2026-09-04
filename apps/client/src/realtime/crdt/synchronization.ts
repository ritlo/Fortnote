import type { DecryptedNote } from "../../store/appStore";
import { notifyCrdtSectionChange } from "./changes";
import {
  getSnapshotVersion,
  replaceWithSnapshot,
  ROOT_SECTION_ID,
  setSnapshotVersion,
  SNAPSHOT_SEED
} from "./document";
import { editCrdtNote, noteBindings } from "./lifecycle";
import { broadcastCheckpoint } from "./outbound";
import { getCrdtTransport } from "./runtime";
import {
  bindingKey,
  bindings,
  bindingsForNote,
  defaultSectionId,
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

export async function checkpointCrdtNote(note: DecryptedNote): Promise<void> {
  const existing = bindingsForNote(note.id);
  const current = noteBindings(note, true);
  for (const binding of current) {
    binding.note = note;
    if (existing.length === 0) {
      seedBinding(binding, note);
      binding.ready = true;
      binding.snapshotSeeded = true;
    }
  }
  await ensureCrdtHistoryReadable(note.id);
  for (const binding of current) {
    binding.note = note;
    binding.doc.transact(() => {
      setSnapshotVersion(binding.doc, note.version);
    }, SNAPSHOT_SEED);
    binding.titleAuthorityVersion = Math.max(binding.titleAuthorityVersion, note.version);
  }
  getCrdtTransport()?.discard(note.id, note.keyEpoch);
  await Promise.all(current.map((binding) => broadcastCheckpoint(binding)));
}

export async function finishCrdtSync(
  noteId: string,
  keyEpoch: number,
  hasUpdates: boolean,
  sectionId?: string,
  serverSequence?: number
): Promise<void> {
  const candidates = sectionId
    ? [bindings.get(bindingKey(noteId, sectionId))].filter(isBinding)
    : bindingsForNote(noteId);
  if (candidates.length === 0) {
    return;
  }
  const primarySectionId = defaultSectionId(noteId);
  for (const binding of candidates) {
    if (!isActiveBinding(binding) || binding.keyEpoch !== keyEpoch) {
      continue;
    }
    if (serverSequence !== undefined) {
      binding.observedServerSequence = Math.max(
        binding.observedServerSequence,
        serverSequence
      );
      notifyCrdtSectionChange(binding);
    }
    await finishBindingSync(
      binding,
      keyEpoch,
      sectionId !== undefined || binding.sectionId === primarySectionId
        ? hasUpdates
        : false
    );
  }
}

async function finishBindingSync(
  binding: Binding,
  keyEpoch: number,
  hasUpdates: boolean
): Promise<void> {
  await binding.receiving;
  if (!isActiveBinding(binding) || binding.note.keyEpoch !== keyEpoch || binding.ready) {
    return;
  }
  throwIfCrdtHistoryUnreadable(binding);
  const snapshotIsNewer = binding.note.version > getSnapshotVersion(binding.doc);
  const hasLegacyWholeNoteSnapshot =
    !binding.note.rootSectionId && binding.sectionId === ROOT_SECTION_ID;
  if (
    hasLegacyWholeNoteSnapshot &&
    snapshotIsNewer &&
    hasUpdates &&
    binding.appliedUpdateCount > 0
  ) {
    replaceWithSnapshot(
      binding.doc,
      binding.fragment,
      binding.sectionId,
      binding.note
    );
    binding.snapshotSeeded = true;
    if (binding.note.role !== "viewer") {
      await broadcastCheckpoint(binding);
    }
  }
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
      binding.titleAuthorityVersion = Math.max(binding.titleAuthorityVersion, binding.note.version);
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
    getCrdtTransport()?.discard(binding.note.id, binding.keyEpoch);
    void broadcastCheckpoint(binding).catch(() => undefined);
  }
  const pendingPatch = binding.pendingPatch;
  binding.pendingPatch = {};
  if (
    binding.sectionId === ROOT_SECTION_ID &&
    pendingPatch.title !== undefined
  ) {
    editCrdtNote(binding.note, pendingPatch);
  }
}
