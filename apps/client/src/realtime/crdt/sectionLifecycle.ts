import { fromBase64, randomUuid } from "@fortnote/shared";
import * as Y from "yjs";
import type { ContentManifestSummary } from "../../api";
import { encryptContentChunksV2 } from "../../cryptoClient";
import type { DecryptedNote } from "../../store/appStore";
import { notifyCrdtSectionChange } from "./changes";
import {
  replaceLegacySectionContent,
  setSnapshotVersion,
  SNAPSHOT_SEED
} from "./document";
import { getOrCreateBinding } from "./lifecycle";
import { CrdtProvider } from "./provider";
import { getCrdtTransport, waitForCrdtTransport } from "./runtime";
import {
  bindingKey,
  bindings,
  canWrite,
  defaultSectionId,
  isActiveBinding,
  isActiveBindingForNote,
  throwIfCrdtHistoryUnreadable,
  trackPendingBroadcast,
  type Binding
} from "./state";
import { sendOutbound } from "./transport";

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
