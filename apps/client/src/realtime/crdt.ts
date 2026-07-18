import {
  CRDT_BINARY_FORMAT_VERSION,
  toBase64,
  type CrdtBinaryHeader,
  type EncryptedCrdtMessage
} from "@fortnote/shared";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  decryptCrdtMessage,
  encryptCrdtMessage
} from "../cryptoClient";
import { replaceBlockNoteFragment } from "../lib/blockNote";
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
  send: (update: ScopedEncryptedCrdtMessage) => Promise<void>;
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
  | ReceivedBinaryCrdtMessage;

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
  onChange: (patch: Partial<Pick<DecryptedNote, "title" | "body">>) => void;
  pendingUpdateIds: Set<string>;
  failedUpdateIds: Set<string>;
  generation: number;
  appliedUpdateCount: number;
  checkpointing: boolean;
  observedServerSequence: number;
  pendingPatch: Partial<Pick<DecryptedNote, "title" | "body">>;
  ready: boolean;
  receiving: Promise<void>;
  snapshotSeeded: boolean;
  keyEpoch: number;
}

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
    generation: nextBindingGeneration,
    appliedUpdateCount: epochAdvanced ? 0 : (existing?.appliedUpdateCount ?? 0),
    checkpointing: false,
    observedServerSequence: epochAdvanced ? 0 : (existing?.observedServerSequence ?? 0),
    pendingPatch: {},
    ready: existing?.ready ?? false,
    receiving: Promise.resolve(),
    snapshotSeeded: inheritedState !== null,
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
      void broadcastUpdate(created, update).catch(() => undefined);
    }
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
  if (epochAdvanced && note.role !== "owner") {
    void checkpointCrdtNote(note).catch(() => undefined);
  }
  return () => {
    for (const binding of bindingsForNote(note.id)) {
      binding.onChange = () => undefined;
    }
  };
}

export function editCrdtNote(
  noteId: string,
  patch: Partial<Pick<DecryptedNote, "title" | "body">>
): boolean {
  const root = bindings.get(bindingKey(noteId, ROOT_SECTION_ID));
  if (!root) {
    return false;
  }
  if (!root.ready) {
    root.pendingPatch = { ...root.pendingPatch, ...patch };
    root.onChange(patch);
    return true;
  }
  root.doc.transact(() => {
    if (patch.title !== undefined) {
      const text = root.doc.getText("title");
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
    title: root.doc.getText("title").toJSON(),
    body: root.note.body
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
        update.compactedUpdateIds?.forEach((id) => binding.pendingUpdateIds.delete(id));
      }
      if (update.type === "crdt-binary" && update.serverSequence) {
        binding.observedServerSequence = Math.max(
          binding.observedServerSequence,
          update.serverSequence
        );
      }
      trackUpdate(binding, update.updateId);
    } catch (error) {
      if (!isActiveBinding(binding)) {
        return;
      }
      binding.failedUpdateIds.add(update.updateId);
      binding.pendingUpdateIds.add(update.updateId);
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
    seedBinding(binding, binding.note);
    binding.snapshotSeeded = true;
    if (binding.note.role !== "viewer") {
      await broadcastCheckpoint(binding);
    }
  }
  binding.ready = true;
  binding.provider.emit("synced");
  const pendingPatch = binding.pendingPatch;
  binding.pendingPatch = {};
  if (
    binding.sectionId === ROOT_SECTION_ID &&
    (pendingPatch.title !== undefined || pendingPatch.body !== undefined)
  ) {
    editCrdtNote(binding.noteId, pendingPatch);
  }
}

async function broadcastUpdate(binding: Binding, update: Uint8Array): Promise<void> {
  const note = binding.note;
  if (!isActiveBindingForNote(binding, note)) {
    return;
  }
  const currentTransport = await getTransport();
  if (!isActiveBindingForNote(binding, note)) {
    return;
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
  const encrypted = await encryptCrdtMessage({
    ...envelope,
    noteKeyBase64: note.noteKeyBase64,
    update
  });
  if (!isActiveBindingForNote(binding, note)) {
    return;
  }
  const delivered = currentTransport.send({
    ...envelope,
    cipher: encrypted.cipher,
    nonce: encrypted.nonce
  });
  trackUpdate(binding, updateId);
  await delivered;
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
    const encrypted = await encryptCrdtMessage({
      ...envelope,
      noteKeyBase64: note.noteKeyBase64,
      update: Y.encodeStateAsUpdate(binding.doc)
    });
    if (!isActiveBindingForNote(binding, note)) {
      return;
    }
    await currentTransport.send({
      ...envelope,
      cipher: encrypted.cipher,
      nonce: encrypted.nonce
    });
    if (!isActiveBindingForNote(binding, note)) {
      return;
    }
    compactedUpdateIds.forEach((id) => binding.pendingUpdateIds.delete(id));
    compactedUpdateIds.forEach((id) => binding.failedUpdateIds.delete(id));
    binding.pendingUpdateIds.add(updateId);
  } finally {
    binding.checkpointing = false;
  }
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
      replaceBlockNoteFragment(binding.fragment, note.body);
    }
    if (!note.rootSectionId && binding.sectionId === ROOT_SECTION_ID) {
      replaceBlockNoteFragment(binding.fragment, note.body);
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
    if (binding.sectionId !== ROOT_SECTION_ID || !binding.note.rootSectionId) {
      replaceBlockNoteFragment(binding.fragment, binding.note.body);
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
    binding.note === note &&
    binding.keyEpoch === note.keyEpoch &&
    binding.note.cryptoOwnerId === note.cryptoOwnerId
  );
}

function getTransport(): Promise<CrdtTransport> {
  return transport
    ? Promise.resolve(transport)
    : new Promise((resolve, reject) => transportWaiters.push({ reject, resolve }));
}
