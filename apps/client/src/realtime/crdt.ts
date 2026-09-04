import {
  fromBase64,
  randomUuid
} from "@fortnote/shared";
import * as Y from "yjs";
import {
  encryptContentChunksV2
} from "../cryptoClient";
import type { ContentManifestSummary } from "../api";
import type { DecryptedNote } from "../store/appStore";
import { notifyCrdtSectionChange } from "./crdt/changes";
import {
  getSnapshotVersion,
  replaceLegacySectionContent,
  replaceWithSnapshot,
  ROOT_SECTION_ID,
  setSnapshotVersion,
  SNAPSHOT_SEED
} from "./crdt/document";
import { CrdtProvider } from "./crdt/provider";
import {
  broadcastCheckpoint,
  broadcastUpdate
} from "./crdt/outbound";
import {
  getCrdtTransport,
  rejectCrdtTransportWaiters,
  waitForCrdtTransport
} from "./crdt/runtime";
import {
  bindingKey,
  bindings,
  bindingsForNote,
  canWrite,
  defaultSectionId,
  getOrCreateBinding as getOrCreateStoredBinding,
  isActiveBinding,
  isActiveBindingForNote,
  isBinding,
  seedBinding,
  throwIfCrdtHistoryUnreadable,
  trackPendingBroadcast,
  type Binding
} from "./crdt/state";
import { sendOutbound } from "./crdt/transport";

export { CrdtProvider } from "./crdt/provider";
export { receiveCrdtUpdate } from "./crdt/incoming";
export {
  subscribeCrdtSectionChanges,
  type CrdtSectionChange
} from "./crdt/changes";
export {
  appendCrdtSectionContent,
  getCrdtSectionOrder,
  replaceCrdtSectionContent,
  replaceCrdtSectionOrder,
  snapshotCrdtSection,
  snapshotReadyCrdtSection,
  splitCrdtSectionContent
} from "./crdt/sectionContent";
export { isCrdtHistoryUnreadableError } from "./crdt/state";
export { setCrdtTransport } from "./crdt/runtime";
export { requiresContentTransfer } from "./crdt/transport";
export type {
  ReceivedBinaryCrdtMessage,
  ScopedEncryptedCrdtMessage
} from "./crdt/transport";

// Synchronous, render-safe accessor so the editor can bind to the fragment before the
// sync effect runs. Idempotent per note id; the binding is destroyed on note/epoch switch.
export function getCrdtFragment(
  noteId: string,
  keyEpoch?: number,
  sectionId?: string
): Y.XmlFragment {
  return getOrCreateBinding(noteId, sectionId ?? defaultSectionId(noteId), keyEpoch).fragment;
}

export function getCrdtProvider(
  noteId: string,
  keyEpoch?: number,
  sectionId?: string
): CrdtProvider {
  return getOrCreateBinding(noteId, sectionId ?? defaultSectionId(noteId), keyEpoch).provider;
}

export function openCrdtSection(
  note: DecryptedNote,
  sectionId: string,
  onChange: Binding["onChange"] = () => undefined
): { provider: CrdtProvider; generation: number } {
  const binding = getOrCreateBinding(note.id, sectionId, note.keyEpoch);
  binding.openGeneration += 1;
  binding.note = note;
  binding.onChange = onChange;
  getCrdtTransport()?.subscribe(
    note.id,
    sectionId,
    note.keyEpoch,
    binding.observedServerSequence
  );
  return { provider: binding.provider, generation: binding.openGeneration };
}

export function retryCrdtSection(
  noteId: string,
  sectionId: string,
  keyEpoch: number
): number | null {
  const binding = bindings.get(bindingKey(noteId, sectionId));
  if (
    binding?.keyEpoch !== keyEpoch ||
    binding.failedUpdateIds.size === 0
  ) {
    return null;
  }
  const failedSequences = [...binding.failedUpdateIds]
    .map((updateId) => binding.receivedServerSequences.get(updateId))
    .filter((sequence): sequence is number => sequence !== undefined);
  if (failedSequences.length > 0) {
    binding.observedServerSequence = Math.max(0, Math.min(...failedSequences) - 1);
  }
  for (const updateId of binding.failedUpdateIds) {
    binding.pendingUpdateIds.delete(updateId);
    binding.receivedServerSequences.delete(updateId);
  }
  binding.failedUpdateIds.clear();
  binding.ready = false;
  binding.provider.isSynced = false;
  const note = binding.note as DecryptedNote | undefined;
  if (note) {
    getCrdtTransport()?.subscribe(
      note.id,
      sectionId,
      keyEpoch,
      binding.observedServerSequence
    );
  }
  return binding.observedServerSequence;
}

export function seedLegacyCrdtSection(
  note: DecryptedNote,
  sectionId: string,
  body: string
): void {
  const binding = getOrCreateBinding(note.id, sectionId, note.keyEpoch);
  binding.note = note;
  binding.doc.transact(() => {
    replaceLegacySectionContent(binding.fragment, body);
    setSnapshotVersion(binding.doc, note.version);
  }, SNAPSHOT_SEED);
  binding.titleAuthorityVersion = Math.max(binding.titleAuthorityVersion, note.version);
  binding.snapshotSeeded = true;
  binding.ready = true;
  binding.provider.emit("synced");
}

export async function waitForCrdtSectionDurable(
  noteId: string,
  keyEpoch: number,
  sectionId: string
): Promise<void> {
  const binding = bindings.get(bindingKey(noteId, sectionId));
  if (binding?.keyEpoch !== keyEpoch) {
    throw new Error("Encrypted section is not open");
  }
  while (binding.pendingBroadcasts.size > 0) {
    await Promise.all([...binding.pendingBroadcasts]);
  }
}

export async function createCrdtSectionInitializationManifest(
  noteId: string,
  keyEpoch: number,
  sectionId: string
): Promise<ContentManifestSummary> {
  const binding = bindings.get(bindingKey(noteId, sectionId));
  if (
    binding?.keyEpoch !== keyEpoch ||
    !binding.ready ||
    !canWrite(binding) ||
    !isActiveBinding(binding)
  ) {
    throw new Error("Encrypted section is not ready for initialization");
  }
  throwIfCrdtHistoryUnreadable(binding);
  const note = binding.note;
  const updateId = randomUuid();
  const checkpointSequenceCutoff = binding.observedServerSequence;
  const prepared = await encryptContentChunksV2({
    cryptoOwnerId: note.cryptoOwnerId,
    noteId: note.id,
    sectionId,
    keyEpoch,
    updateId,
    kind: "checkpoint",
    checkpointSequenceCutoff,
    noteKey: fromBase64(note.noteKeyBase64),
    plaintext: Y.encodeStateAsUpdate(binding.doc)
  });
  const currentTransport = await waitForCrdtTransport();
  if (!isActiveBindingForNote(binding, note)) {
    throw new Error("Encrypted section changed during initialization");
  }
  const delivery = sendOutbound(currentTransport, {
    storage: "content",
    prepared
  });
  trackPendingBroadcast(binding, delivery.durable);
  const manifest = await delivery.delivered;
  if (!manifest) {
    throw new Error("Section initialization manifest was not committed");
  }
  if (isActiveBindingForNote(binding, note)) {
    binding.observedServerSequence = Math.max(
      binding.observedServerSequence,
      manifest.lastSequence
    );
    binding.pendingUpdateIds.add(updateId);
    notifyCrdtSectionChange(binding);
  }
  return manifest;
}

export function waitForCrdtSectionReady(
  noteId: string,
  keyEpoch: number,
  sectionId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<void> {
  const provider = getCrdtProvider(noteId, keyEpoch, sectionId);
  if (provider.isSynced) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      provider.off("synced", onSynced);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new DOMException("Section load canceled", "AbortError")
      );
    };
    const onSynced = () => {
      cleanup();
      resolve();
    };
    provider.on("synced", onSynced);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Encrypted section synchronization timed out"));
    }, options.timeoutMs ?? 15_000);
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}

export async function releaseCrdtSection(
  noteId: string,
  sectionId: string,
  keyEpoch: number,
  expectedGeneration?: number
): Promise<boolean> {
  const binding = bindings.get(bindingKey(noteId, sectionId));
  if (binding?.keyEpoch !== keyEpoch) {
    return true;
  }
  try {
    await Promise.all(binding.pendingBroadcasts);
  } catch {
    return false;
  }
  if (
    expectedGeneration !== undefined &&
    binding.openGeneration !== expectedGeneration
  ) {
    return true;
  }
  if (!isActiveBinding(binding) || binding.pendingBroadcasts.size > 0) {
    return false;
  }
  binding.onChange = () => undefined;
  getCrdtTransport()?.unsubscribe?.(noteId, sectionId, keyEpoch);
  binding.provider.awareness.destroy();
  binding.doc.destroy();
  bindings.delete(bindingKey(noteId, sectionId));
  return true;
}

function getOrCreateBinding(
  noteId: string,
  sectionId: string,
  keyEpoch?: number
): Binding {
  return getOrCreateStoredBinding(noteId, sectionId, keyEpoch, {
    broadcastUpdate,
    notifyChange: notifyCrdtSectionChange
  });
}

export function attachCrdtNote(
  note: DecryptedNote,
  onChange: Binding["onChange"]
): () => void {
  const attached = noteBindings(note, true);
  for (const binding of attached) {
    binding.onChange = onChange;
    binding.note = note;
    getCrdtTransport()?.subscribe(
      note.id,
      binding.sectionId,
      note.keyEpoch,
      binding.observedServerSequence
    );
  }
  return () => {
    for (const binding of bindingsForNote(note.id)) {
      binding.onChange = () => undefined;
    }
  };
}

export function updateCrdtNote(note: DecryptedNote): void {
  for (const binding of bindingsForNote(note.id)) {
    if (binding.keyEpoch === note.keyEpoch) {
      binding.note = note;
    }
  }
}

export function openCrdtNote(
  note: DecryptedNote,
  onChange: Binding["onChange"]
): () => void {
  const currentBindings = bindingsForNote(note.id);
  if (currentBindings.some((binding) => binding.keyEpoch > note.keyEpoch)) {
    return () => undefined;
  }
  if (currentBindings.length === 0) {
    return attachCrdtNote(note, onChange);
  }
  const attached = noteBindings(note, true);
  for (const binding of attached) {
    binding.onChange = onChange;
    binding.note = note;
    getCrdtTransport()?.subscribe(
      note.id,
      binding.sectionId,
      note.keyEpoch,
      binding.observedServerSequence
    );
  }
  return () => {
    for (const binding of bindingsForNote(note.id)) {
      binding.onChange = () => undefined;
    }
  };
}

export function editCrdtNote(
  noteOrId: DecryptedNote | string,
  patch: Partial<Pick<DecryptedNote, "title">>
): boolean {
  const noteId = typeof noteOrId === "string" ? noteOrId : noteOrId.id;
  const root = bindings.get(bindingKey(noteId, ROOT_SECTION_ID));
  let writableRoot: Binding;
  if (typeof noteOrId === "string") {
    if (!root) {
      return false;
    }
    writableRoot = root;
  } else {
    writableRoot = root ?? getOrCreateBinding(noteId, ROOT_SECTION_ID, noteOrId.keyEpoch);
    writableRoot.note = noteOrId;
    writableRoot.titleAuthorityVersion = Math.max(
      writableRoot.titleAuthorityVersion,
      noteOrId.version
    );
    getCrdtTransport()?.subscribe(
      noteId,
      ROOT_SECTION_ID,
      noteOrId.keyEpoch,
      writableRoot.observedServerSequence
    );
  }
  if (!writableRoot.ready) {
    writableRoot.pendingPatch = { ...writableRoot.pendingPatch, ...patch };
    writableRoot.onChange(patch);
  }
  writableRoot.doc.transact(() => {
    if (patch.title !== undefined) {
      if (typeof noteOrId !== "string") {
        writableRoot.titleAuthorityVersion = Math.max(
          writableRoot.titleAuthorityVersion,
          noteOrId.version + 1
        );
      }
      const text = writableRoot.doc.getText("title");
      if (text.toJSON() === patch.title) {
        return;
      }
      text.delete(0, text.length);
      text.insert(0, patch.title);
    }
  });
  return true;
}

export function preserveCrdtContent(note: DecryptedNote): DecryptedNote {
  const root = bindings.get(bindingKey(note.id, ROOT_SECTION_ID));
  if (!root) {
    return note;
  }
  if (root.note.keyEpoch !== note.keyEpoch) {
    return note;
  }
  if (!root.ready) {
    return { ...note, ...root.pendingPatch };
  }
  if (root.titleAuthorityVersion < note.version) {
    return note;
  }
  const content = {
    title: root.doc.getText("title").toJSON()
  };
  root.note = { ...note, ...content };
  return root.note;
}

export function removeCrdtNote(noteId: string, expectedProvider?: CrdtProvider): void {
  const noteBindings = bindingsForNote(noteId);
  if (noteBindings.length === 0 && !expectedProvider) {
    return;
  }
  if (expectedProvider && !noteBindings.some(({ provider }) => provider === expectedProvider)) {
    expectedProvider.awareness.destroy();
    expectedProvider.doc.destroy();
    return;
  }
  for (const binding of noteBindings) {
    binding.provider.awareness.destroy();
    binding.doc.destroy();
    bindings.delete(bindingKey(binding.noteId, binding.sectionId));
  }
}

export function clearCrdtNotes(): void {
  for (const binding of bindings.values()) {
    binding.provider.awareness.destroy();
    binding.doc.destroy();
  }
  bindings.clear();
  rejectCrdtTransportWaiters(new Error("Vault locked"));
}

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

function noteBindings(note: DecryptedNote, includeRoot: boolean): Binding[] {
  const sectionId = note.rootSectionId ?? ROOT_SECTION_ID;
  const section = getOrCreateBinding(note.id, sectionId, note.keyEpoch);
  if (!includeRoot || sectionId === ROOT_SECTION_ID) {
    return [section];
  }
  return [
    getOrCreateBinding(note.id, ROOT_SECTION_ID, note.keyEpoch),
    section
  ];
}
