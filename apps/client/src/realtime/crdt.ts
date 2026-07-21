import {
  CRDT_BINARY_FORMAT_VERSION,
  CRDT_BINARY_HEADER_MAX_BYTES,
  fromBase64,
  toBase64,
  type CrdtBinaryHeader,
  type CrdtManifestReferenceV2,
  type EncryptedCrdtMessage
} from "@fortnote/shared";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  CONTENT_CHUNK_AUTH_BYTES,
  decryptCrdtMessage,
  encryptContentChunksV2,
  encryptCrdtMessage,
  type PreparedEncryptedContentV2
} from "../cryptoClient";
import type { ContentManifestSummary } from "../api";
import {
  downloadVerifiedContent,
  type VerifiedContentDownloadInput
} from "./contentTransfer";
import {
  appendBlockNoteFragmentSnapshot,
  replaceBlockNoteFragment,
  replaceBlockNoteFragmentSnapshot,
  snapshotBlockNoteFragment,
  splitBlockNoteFragmentSnapshot,
  type BlockNoteFragmentSnapshot
} from "../lib/blockNote";
import type { DecryptedNote } from "../store/appStore";

// Yjs provides battle-tested character/structure-level merging; the server only sees ciphertext.
const REMOTE_UPDATE = Symbol("remote-update");
const SNAPSHOT_SEED = Symbol("snapshot-seed");
const SNAPSHOT_VERSION_KEY = "snapshotVersion";
const FRAGMENT_KEY = "document-store";
const ROOT_SECTION_ID = "root";
const SECTION_ORDER_KEY = "sections";
// ponytail: fixed threshold; tune from update-size metrics if storage churn matters.
const CHECKPOINT_UPDATE_COUNT = 64;
const REALTIME_FRAME_MAX_BYTES = 256 * 1024;
const bindings = new Map<string, Binding>();
let nextBindingGeneration = 1;
let transport: CrdtTransport | null = null;
const transportWaiters: {
  reject: (error: Error) => void;
  resolve: (next: CrdtTransport) => void;
}[] = [];

interface CrdtTransport {
  discard: (noteId: string, beforeKeyEpoch: number) => void;
  subscribe: (
    noteId: string,
    sectionId?: string,
    keyEpoch?: number,
    afterSequence?: number
  ) => void;
  unsubscribe?: (noteId: string, sectionId: string, keyEpoch: number) => void;
  send: (update: ScopedEncryptedCrdtMessage) => Promise<void>;
  sendDurably?: (
    update: ScopedEncryptedCrdtMessage
  ) => DurableDelivery<void>;
  sendContent?: (
    prepared: PreparedEncryptedContentV2
  ) => Promise<ContentManifestSummary>;
  sendContentDurably?: (
    prepared: PreparedEncryptedContentV2
  ) => DurableDelivery<ContentManifestSummary>;
  downloadContent?: (input: VerifiedContentDownloadInput) => Promise<Uint8Array>;
}

interface DurableDelivery<T> {
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
type IncomingCrdtMessage =
  | EncryptedCrdtMessage
  | ScopedEncryptedCrdtMessage
  | ReceivedBinaryCrdtMessage
  | CrdtManifestReferenceV2;

// BlockNote binds a ProseMirror doc to a Y.XmlFragment; awareness stays local.
export class CrdtProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  isSynced = false;
  private listeners = new Map<string, Set<(data?: unknown) => void>>();

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.awareness = new Awareness(doc);
  }

  on(event: string, callback: (data?: unknown) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(callback);
    this.listeners.set(event, set);
  }

  off(event: string, callback: (data?: unknown) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  emit(event: string, data?: unknown): void {
    if (event === "synced") {
      this.isSynced = true;
    }
    this.listeners.get(event)?.forEach((callback) => {
      callback(data);
    });
  }

}

interface Binding {
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  noteId: string;
  sectionId: string;
  provider: CrdtProvider;
  note: DecryptedNote;
  onChange: (patch: Partial<Pick<DecryptedNote, "title">>) => void;
  pendingUpdateIds: Set<string>;
  failedUpdateIds: Set<string>;
  receivedServerSequences: Map<string, number>;
  generation: number;
  appliedUpdateCount: number;
  checkpointing: boolean;
  observedServerSequence: number;
  pendingPatch: Partial<Pick<DecryptedNote, "title">>;
  pendingBroadcasts: Set<Promise<void>>;
  openGeneration: number;
  ready: boolean;
  receiving: Promise<void>;
  snapshotSeeded: boolean;
  inheritedEpochState: boolean;
  keyEpoch: number;
}

export interface CrdtSectionChange {
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  serverSequence: number;
}

const sectionChangeListeners = new Set<(change: CrdtSectionChange) => void>();

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

export function snapshotReadyCrdtSection(
  noteId: string,
  keyEpoch: number,
  sectionId: string
): BlockNoteFragmentSnapshot | null {
  const binding = bindings.get(bindingKey(noteId, sectionId));
  if (
    binding?.keyEpoch !== keyEpoch ||
    !binding.ready ||
    !isActiveBinding(binding)
  ) {
    return null;
  }
  return snapshotBlockNoteFragment(binding.fragment);
}

export function subscribeCrdtSectionChanges(
  listener: (change: CrdtSectionChange) => void
): () => void {
  sectionChangeListeners.add(listener);
  return () => {
    sectionChangeListeners.delete(listener);
  };
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
  transport?.subscribe(
    note.id,
    sectionId,
    note.keyEpoch,
    binding.observedServerSequence
  );
  return { provider: binding.provider, generation: binding.openGeneration };
}

export function seedLegacyCrdtSection(
  note: DecryptedNote,
  sectionId: string,
  body: string
): void {
  const binding = getOrCreateBinding(note.id, sectionId, note.keyEpoch);
  binding.note = note;
  binding.doc.transact(() => {
    replaceBlockNoteFragment(binding.fragment, body);
    setSnapshotVersion(binding.doc, note.version);
  }, SNAPSHOT_SEED);
  binding.snapshotSeeded = true;
  binding.ready = true;
  binding.provider.emit("synced");
}

export function getCrdtSectionOrder(noteId: string): string[] {
  const root = bindings.get(bindingKey(noteId, ROOT_SECTION_ID));
  if (!root?.ready) {
    return [];
  }
  return [...new Set(
    root.doc
      .getArray<unknown>(SECTION_ORDER_KEY)
      .toArray()
      .filter((sectionId): sectionId is string => typeof sectionId === "string")
  )];
}

export function replaceCrdtSectionOrder(
  noteId: string,
  orderedSectionIds: string[]
): boolean {
  const root = bindings.get(bindingKey(noteId, ROOT_SECTION_ID));
  if (!root?.ready || !canWrite(root)) {
    return false;
  }
  const uniqueIds = [...new Set(orderedSectionIds)];
  root.doc.transact(() => {
    const sections = root.doc.getArray<string>(SECTION_ORDER_KEY);
    sections.delete(0, sections.length);
    if (uniqueIds.length > 0) {
      sections.insert(0, uniqueIds);
    }
  });
  return true;
}

export function snapshotCrdtSection(
  noteId: string,
  sectionId: string
): BlockNoteFragmentSnapshot {
  const binding = writableReadyBinding(noteId, sectionId);
  return snapshotBlockNoteFragment(binding.fragment);
}

export function replaceCrdtSectionContent(
  noteId: string,
  sectionId: string,
  snapshot: BlockNoteFragmentSnapshot
): void {
  const binding = writableReadyBinding(noteId, sectionId);
  replaceBlockNoteFragmentSnapshot(binding.fragment, snapshot);
}

export function appendCrdtSectionContent(
  noteId: string,
  sectionId: string,
  snapshot: BlockNoteFragmentSnapshot
): void {
  const binding = writableReadyBinding(noteId, sectionId);
  appendBlockNoteFragmentSnapshot(binding.fragment, snapshot);
}

export function splitCrdtSectionContent(
  noteId: string,
  sectionId: string
): { before: BlockNoteFragmentSnapshot; after: BlockNoteFragmentSnapshot } | null {
  return splitBlockNoteFragmentSnapshot(snapshotCrdtSection(noteId, sectionId));
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
  const updateId = crypto.randomUUID();
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
  const currentTransport = await getTransport();
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
  transport?.unsubscribe?.(noteId, sectionId, keyEpoch);
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
  const key = bindingKey(noteId, sectionId);
  const existing = bindings.get(key);
  if (
    existing &&
    (keyEpoch === undefined || existing.keyEpoch === keyEpoch || keyEpoch < existing.keyEpoch)
  ) {
    return existing;
  }
  const inheritedState = existing
    ? Y.encodeStateAsUpdate(existing.doc)
    : null;
  const epochAdvanced = Boolean(
    existing && keyEpoch !== undefined && keyEpoch > existing.keyEpoch
  );
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  const provider = new CrdtProvider(doc);
  const created: Binding = {
    doc,
    fragment,
    noteId,
    sectionId,
    provider,
    note: undefined as unknown as DecryptedNote,
    onChange: () => undefined,
    pendingUpdateIds: new Set(epochAdvanced ? [] : (existing?.pendingUpdateIds ?? [])),
    failedUpdateIds: new Set(existing?.failedUpdateIds ?? []),
    receivedServerSequences: new Map(
      epochAdvanced ? [] : (existing?.receivedServerSequences ?? [])
    ),
    generation: nextBindingGeneration,
    appliedUpdateCount: epochAdvanced ? 0 : (existing?.appliedUpdateCount ?? 0),
    checkpointing: false,
    observedServerSequence: epochAdvanced ? 0 : (existing?.observedServerSequence ?? 0),
    pendingPatch: {},
    pendingBroadcasts: new Set(),
    openGeneration: 0,
    ready: existing?.ready ?? false,
    receiving: Promise.resolve(),
    snapshotSeeded: inheritedState !== null,
    inheritedEpochState: epochAdvanced && inheritedState !== null,
    keyEpoch: keyEpoch ?? 0
  };
  nextBindingGeneration += 1;
  if (inheritedState) {
    Y.applyUpdate(doc, inheritedState, SNAPSHOT_SEED);
  }
  if (epochAdvanced && existing) {
    existing.onChange = () => undefined;
    existing.provider.awareness.destroy();
    existing.doc.destroy();
  }
  bindings.set(key, created);
  if (sectionId === ROOT_SECTION_ID) {
    doc.getText("title").observe((event) => {
      if (event.transaction.origin !== SNAPSHOT_SEED && isActiveBinding(created)) {
        created.onChange({ title: doc.getText("title").toJSON() });
      }
    });
  }
  doc.on("update", (update, origin) => {
    const note = created.note as DecryptedNote | undefined;
    if (
      origin !== REMOTE_UPDATE &&
      origin !== SNAPSHOT_SEED &&
      isActiveBinding(created) &&
      note &&
      note.role !== "viewer"
    ) {
      const delivery = broadcastUpdate(created, update);
      trackPendingBroadcast(created, delivery.durable);
      void delivery.delivered.catch(() => undefined);
    }
    notifyCrdtSectionChange(created);
  });
  return created;
}

export function attachCrdtNote(
  note: DecryptedNote,
  onChange: Binding["onChange"]
): () => void {
  const attached = noteBindings(note, true);
  for (const binding of attached) {
    binding.onChange = onChange;
    binding.note = note;
    transport?.subscribe(
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
  const epochAdvanced = currentBindings.some((binding) => note.keyEpoch > binding.keyEpoch);
  const attached = noteBindings(note, true);
  for (const binding of attached) {
    binding.onChange = onChange;
    binding.note = note;
    transport?.subscribe(
      note.id,
      binding.sectionId,
      note.keyEpoch,
      binding.observedServerSequence
    );
  }
  if (epochAdvanced) {
    void checkpointCrdtNote(note).catch(() => undefined);
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
    transport?.subscribe(
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

export function setCrdtTransport(next: CrdtTransport | null): void {
  transport = next;
  for (const binding of bindings.values()) {
    binding.ready = false;
    binding.provider.isSynced = false;
  }
  if (next) {
    transportWaiters.splice(0).forEach(({ resolve }) => {
      resolve(next);
    });
    for (const binding of bindings.values()) {
      const note = binding.note as DecryptedNote | undefined;
      if (note) {
        next.discard(note.id, note.keyEpoch);
        next.subscribe(
          note.id,
          binding.sectionId,
          note.keyEpoch,
          binding.observedServerSequence
        );
      }
    }
  }
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
  transportWaiters.splice(0).forEach(({ reject }) => {
    reject(new Error("Vault locked"));
  });
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
  }
  transport?.discard(note.id, note.keyEpoch);
  await Promise.all(current.map((binding) => broadcastCheckpoint(binding)));
}

export function receiveCrdtUpdate(
  update: IncomingCrdtMessage
): Promise<void> {
  const sectionId = scopedSectionId(update) ?? defaultSectionId(update.noteId);
  const binding = bindings.get(bindingKey(update.noteId, sectionId));
  if (
    binding?.note.cryptoOwnerId !== update.cryptoOwnerId ||
    binding.note.keyEpoch !== messageKeyEpoch(update)
  ) {
    return Promise.resolve();
  }
  const received = binding.receiving.then(async () => {
    try {
      const plaintext = await decryptReceivedUpdate(binding, update);
      if (!isActiveBinding(binding) || binding.note.keyEpoch !== messageKeyEpoch(update)) {
        return;
      }
      Y.applyUpdate(binding.doc, plaintext, REMOTE_UPDATE);
      binding.appliedUpdateCount += 1;
      binding.failedUpdateIds.delete(update.updateId);
      if (update.type === "crdt-checkpoint") {
        update.compactedUpdateIds?.forEach((id) => {
          binding.pendingUpdateIds.delete(id);
          binding.failedUpdateIds.delete(id);
          binding.receivedServerSequences.delete(id);
        });
      }
      if (
        (update.type === "crdt-binary" || update.type === "crdt-manifest") &&
        update.serverSequence
      ) {
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
      if (
        (update.type === "crdt-binary" || update.type === "crdt-manifest") &&
        update.serverSequence
      ) {
        binding.receivedServerSequences.set(update.updateId, update.serverSequence);
      }
      throw error;
    }
  });
  binding.receiving = received.catch(() => undefined);
  return received;
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
    replaceWithSnapshot(binding);
    if (binding.note.role !== "viewer") {
      await broadcastCheckpoint(binding);
    }
  }
  if (binding.appliedUpdateCount === 0 && !binding.snapshotSeeded) {
    seedBinding(
      binding,
      binding.sectionId === ROOT_SECTION_ID && binding.pendingPatch.title !== undefined
        ? { ...binding.note, title: binding.pendingPatch.title }
        : binding.note
    );
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
  if (
    binding.sectionId === ROOT_SECTION_ID &&
    pendingPatch.title !== undefined
  ) {
    editCrdtNote(binding.note, pendingPatch);
  }
}

function broadcastUpdate(binding: Binding, update: Uint8Array): DurableDelivery<void> {
  const pending = (async () => {
    const note = binding.note;
    if (!isActiveBindingForNote(binding, note)) {
      return null;
    }
    const currentTransport = await getTransport();
    if (!isActiveBindingForNote(binding, note)) {
      return null;
    }
    const updateId = crypto.randomUUID();
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

async function broadcastCheckpoint(
  binding: Binding,
  updateId: string = crypto.randomUUID()
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
    const currentTransport = await getTransport();
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

function clearCheckpointCoverage(
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

type PreparedOutbound =
  | { storage: "content"; prepared: PreparedEncryptedContentV2 }
  | { storage: "inline"; update: ScopedEncryptedCrdtMessage };

async function prepareOutbound(
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

function sendOutbound(
  currentTransport: CrdtTransport,
  outbound: PreparedOutbound
): DurableDelivery<ContentManifestSummary | null> {
  if (outbound.storage === "inline") {
    const delivery = currentTransport.sendDurably?.(outbound.update) ?? (() => {
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

function seedBinding(binding: Binding, note: DecryptedNote): void {
  binding.doc.transact(() => {
    if (binding.sectionId === ROOT_SECTION_ID) {
      const title = binding.doc.getText("title");
      if (title.length === 0) {
        title.insert(0, note.title);
      }
      const sections = binding.doc.getArray<string>(SECTION_ORDER_KEY);
      if (sections.length === 0 && note.rootSectionId) {
        sections.insert(0, [note.rootSectionId]);
      }
    } else if (binding.fragment.length === 0) {
      replaceBlockNoteFragment(binding.fragment, undefined);
    }
    setSnapshotVersion(binding.doc, note.version);
  }, SNAPSHOT_SEED);
}

function getSnapshotVersion(doc: Y.Doc): number {
  return doc.getMap<number>("metadata").get(SNAPSHOT_VERSION_KEY) ?? 0;
}

function setSnapshotVersion(doc: Y.Doc, version: number): void {
  doc.getMap<number>("metadata").set(SNAPSHOT_VERSION_KEY, version);
}

function replaceWithSnapshot(binding: Binding): void {
  binding.doc.transact(() => {
    if (binding.sectionId === ROOT_SECTION_ID) {
      const text = binding.doc.getText("title");
      text.delete(0, text.length);
      text.insert(0, binding.note.title);
    }
    if (binding.sectionId !== ROOT_SECTION_ID && binding.fragment.length === 0) {
      replaceBlockNoteFragment(binding.fragment, undefined);
    }
    setSnapshotVersion(binding.doc, binding.note.version);
  }, SNAPSHOT_SEED);
  binding.snapshotSeeded = true;
}

function throwIfCrdtHistoryUnreadable(binding: Binding): void {
  if (binding.failedUpdateIds.size > 0) {
    throw new Error("Realtime history could not be decrypted");
  }
}

export function isCrdtHistoryUnreadableError(error: unknown): boolean {
  return error instanceof Error && error.message === "Realtime history could not be decrypted";
}

function trackUpdate(binding: Binding, updateId: string): void {
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

function trackPendingBroadcast(binding: Binding, pending: Promise<void>): void {
  binding.pendingBroadcasts.add(pending);
  const finish = () => {
    binding.pendingBroadcasts.delete(pending);
  };
  void pending.then(finish, finish);
}

function canWrite(binding: Binding): boolean {
  return binding.note.role !== "viewer";
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

function bindingsForNote(noteId: string): Binding[] {
  return [...bindings.values()].filter((binding) => binding.noteId === noteId);
}

function defaultSectionId(noteId: string): string {
  for (const binding of bindingsForNote(noteId)) {
    const note = binding.note as DecryptedNote | undefined;
    if (note?.rootSectionId) {
      return note.rootSectionId;
    }
  }
  return ROOT_SECTION_ID;
}

function bindingKey(noteId: string, sectionId: string): string {
  return JSON.stringify([noteId, sectionId]);
}

function scopedSectionId(
  update: IncomingCrdtMessage
): string | null {
  return "sectionId" in update && typeof update.sectionId === "string"
    ? update.sectionId
    : null;
}

function messageKeyEpoch(
  update: IncomingCrdtMessage
): number {
  return update.type === "crdt-binary" ? update.expectedKeyEpoch : update.keyEpoch;
}

function decryptReceivedUpdate(
  binding: Binding,
  update: IncomingCrdtMessage
): Promise<Uint8Array> {
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
    const download = transport?.downloadContent ?? downloadVerifiedContent;
    return download({
      manifest,
      cryptoOwnerId: update.cryptoOwnerId,
      noteKey: fromBase64(binding.note.noteKeyBase64),
      onProgress: (progress) => {
        binding.provider.emit("progress", progress);
      }
    });
  }
  if (update.type !== "crdt-binary") {
    return decryptCrdtMessage({
      ...update,
      noteKeyBase64: binding.note.noteKeyBase64
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
    noteKeyBase64: binding.note.noteKeyBase64
  });
}

function isBinding(binding: Binding | undefined): binding is Binding {
  return binding !== undefined;
}

function isActiveBinding(binding: Binding): boolean {
  const active = bindings.get(bindingKey(binding.noteId, binding.sectionId));
  return active === binding && active.generation === binding.generation;
}

function isActiveBindingForNote(binding: Binding, note: DecryptedNote): boolean {
  return (
    isActiveBinding(binding) &&
    binding.note.id === note.id &&
    binding.keyEpoch === note.keyEpoch &&
    binding.note.cryptoOwnerId === note.cryptoOwnerId
  );
}

function notifyCrdtSectionChange(binding: Binding): void {
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

function writableReadyBinding(noteId: string, sectionId: string): Binding {
  const binding = bindings.get(bindingKey(noteId, sectionId));
  if (!binding?.ready || !canWrite(binding) || !isActiveBinding(binding)) {
    throw new Error("Encrypted section is not ready for this operation");
  }
  return binding;
}

function getTransport(): Promise<CrdtTransport> {
  return transport
    ? Promise.resolve(transport)
    : new Promise((resolve, reject) => transportWaiters.push({ reject, resolve }));
}
