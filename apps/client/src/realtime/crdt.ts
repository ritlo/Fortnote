import {
  CRDT_UPDATE_FORMAT_VERSION,
  type EncryptedCrdtCheckpoint,
  type EncryptedCrdtUpdate,
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
// ponytail: fixed threshold; tune from update-size metrics if storage churn matters.
const CHECKPOINT_UPDATE_COUNT = 64;
const bindings = new Map<string, Binding>();
let transport: CrdtTransport | null = null;
const transportWaiters: {
  reject: (error: Error) => void;
  resolve: (next: CrdtTransport) => void;
}[] = [];

interface CrdtTransport {
  discard: (noteId: string, beforeKeyEpoch: number) => void;
  subscribe: (noteId: string) => void;
  send: (update: EncryptedCrdtMessage) => Promise<void>;
}

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
  provider: CrdtProvider;
  note: DecryptedNote;
  onChange: (patch: Partial<Pick<DecryptedNote, "title" | "body">>) => void;
  pendingUpdateIds: Set<string>;
  failedUpdateIds: Set<string>;
  appliedUpdateCount: number;
  checkpointing: boolean;
  pendingPatch: Partial<Pick<DecryptedNote, "title" | "body">>;
  ready: boolean;
  receiving: Promise<void>;
  snapshotSeeded: boolean;
  keyEpoch: number;
}

// Synchronous, render-safe accessor so the editor can bind to the fragment before the
// sync effect runs. Idempotent per note id; the binding is destroyed on note/epoch switch.
export function getCrdtFragment(noteId: string, keyEpoch?: number): Y.XmlFragment {
  return getOrCreateBinding(noteId, keyEpoch).fragment;
}

export function getCrdtProvider(noteId: string, keyEpoch?: number): CrdtProvider {
  return getOrCreateBinding(noteId, keyEpoch).provider;
}

function getOrCreateBinding(noteId: string, keyEpoch?: number): Binding {
  const existing = bindings.get(noteId);
  if (
    existing &&
    (keyEpoch === undefined || existing.keyEpoch === keyEpoch || keyEpoch < existing.keyEpoch)
  ) {
    return existing;
  }
  const inheritedState = existing
    ? Y.encodeStateAsUpdate(existing.doc)
    : null;
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  const provider = new CrdtProvider(doc);
  const created: Binding = {
    doc,
    fragment,
    provider,
    note: undefined as unknown as DecryptedNote,
    onChange: () => undefined,
    pendingUpdateIds: new Set<string>(),
    failedUpdateIds: new Set<string>(),
    appliedUpdateCount: 0,
    checkpointing: false,
    pendingPatch: {},
    ready: false,
    receiving: Promise.resolve(),
    snapshotSeeded: inheritedState !== null,
    keyEpoch: keyEpoch ?? 0
  };
  if (inheritedState) {
    Y.applyUpdate(doc, inheritedState, SNAPSHOT_SEED);
  }
  bindings.set(noteId, created);
  doc.getText("title").observe((event) => {
    if (event.transaction.origin !== SNAPSHOT_SEED) {
      created.onChange({ title: doc.getText("title").toJSON() });
    }
  });
  doc.on("update", (update, origin) => {
    const note = created.note as DecryptedNote | undefined;
    if (
      origin !== REMOTE_UPDATE &&
      origin !== SNAPSHOT_SEED &&
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
  const binding = getOrCreateBinding(note.id, note.keyEpoch);
  binding.onChange = onChange;
  binding.note = note;
  transport?.subscribe(note.id);
  return () => {
    const current = bindings.get(note.id);
    if (current) {
      current.onChange = () => undefined;
    }
  };
}

export function updateCrdtNote(note: DecryptedNote): void {
  const binding = bindings.get(note.id);
  if (binding?.keyEpoch === note.keyEpoch) {
    binding.note = note;
  }
}

export function openCrdtNote(
  note: DecryptedNote,
  onChange: Binding["onChange"]
): () => void {
  const binding = bindings.get(note.id);
  if (binding) {
    const epochAdvanced = note.keyEpoch > binding.note.keyEpoch;
    binding.onChange = onChange;
    if (epochAdvanced && note.role !== "owner") {
      // ponytail: rotation advanced the epoch; re-checkpoint so collaborators converge.
      void checkpointCrdtNote(note).catch(() => undefined);
    } else {
      binding.note = note;
    }
    transport?.subscribe(note.id);
    return () => {
      const current = bindings.get(note.id);
      if (current) {
        current.onChange = () => undefined;
      }
    };
  }
  return attachCrdtNote(note, onChange);
}

export function editCrdtNote(
  noteId: string,
  patch: Partial<Pick<DecryptedNote, "title" | "body">>
): boolean {
  const binding = bindings.get(noteId);
  if (!binding) {
    return false;
  }
  if (!binding.ready) {
    binding.pendingPatch = { ...binding.pendingPatch, ...patch };
    binding.onChange(patch);
    return true;
  }
  binding.doc.transact(() => {
    // Body lives in the BlockNote editor / Y.XmlFragment; only title routes through Y.Text.
    if (patch.title !== undefined) {
      const text = binding.doc.getText("title");
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
        next.subscribe(note.id);
      }
    }
  }
}

export function preserveCrdtContent(note: DecryptedNote): DecryptedNote {
  const binding = bindings.get(note.id);
  if (!binding) {
    return note;
  }
  if (binding.note.keyEpoch !== note.keyEpoch) {
    return note;
  }
  if (!binding.ready) {
    return { ...note, ...binding.pendingPatch };
  }
  const content = {
    title: binding.doc.getText("title").toJSON(),
    body: binding.note.body
  };
  binding.note = { ...note, ...content };
  return binding.note;
}

export function removeCrdtNote(noteId: string, expectedProvider?: CrdtProvider): void {
  const binding = bindings.get(noteId);
  if (!binding && !expectedProvider) {
    return;
  }
  const provider = expectedProvider ?? binding!.provider;
  provider.awareness.destroy();
  provider.doc.destroy();
  if (binding?.provider === provider) {
    bindings.delete(noteId);
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

export async function ensureCrdtHistoryReadable(noteId: string): Promise<void> {
  const binding = bindings.get(noteId);
  if (!binding) {
    return;
  }
  await binding.receiving;
  throwIfCrdtHistoryUnreadable(binding);
  if (!binding.ready) {
    throw new Error("Realtime history is still synchronizing");
  }
}

export async function checkpointCrdtNote(note: DecryptedNote): Promise<void> {
  let binding = bindings.get(note.id);
  if (!binding) {
    openCrdtNote(note, () => undefined);
    binding = bindings.get(note.id)!;
    Y.applyUpdate(binding.doc, snapshotUpdate(note), SNAPSHOT_SEED);
    binding.ready = true;
    binding.snapshotSeeded = true;
  }
  await ensureCrdtHistoryReadable(note.id);
  binding.note = note;
  binding.doc.transact(() => {
    setSnapshotVersion(binding.doc, note.version);
  }, SNAPSHOT_SEED);
  binding.pendingUpdateIds.clear();
  transport?.discard(note.id, note.keyEpoch);
  await broadcastCheckpoint(binding);
}

export function receiveCrdtUpdate(update: EncryptedCrdtMessage): Promise<void> {
  const binding = bindings.get(update.noteId);
  if (
    binding?.note.cryptoOwnerId !== update.cryptoOwnerId ||
    binding.note.keyEpoch !== update.keyEpoch
  ) {
    return Promise.resolve();
  }
  const received = binding.receiving.then(async () => {
    try {
      const plaintext = await decryptCrdtMessage({
        ...update,
        noteKeyBase64: binding.note.noteKeyBase64
      });
      Y.applyUpdate(binding.doc, plaintext, REMOTE_UPDATE);
      binding.appliedUpdateCount += 1;
      binding.failedUpdateIds.delete(update.updateId);
      if (update.type === "crdt-checkpoint") {
        update.compactedUpdateIds.forEach((id) => binding.pendingUpdateIds.delete(id));
      }
      trackUpdate(binding, update.updateId);
    } catch (error) {
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
  hasUpdates: boolean
): Promise<void> {
  const binding = bindings.get(noteId);
  if (!binding) {
    return;
  }
  await binding.receiving;
  if (binding.note.keyEpoch !== keyEpoch || binding.ready) {
    return;
  }
  throwIfCrdtHistoryUnreadable(binding);
  const snapshotIsNewer = binding.note.version > getSnapshotVersion(binding.doc);
  if (snapshotIsNewer && hasUpdates && binding.appliedUpdateCount > 0) {
    replaceWithSnapshot(binding);
    if (binding.note.role !== "viewer") {
      await broadcastCheckpoint(binding);
    }
  }
  if ((!hasUpdates || binding.appliedUpdateCount === 0) && !binding.snapshotSeeded) {
    // ponytail: snapshot seeds title; the BlockNote fragment is seeded by the editor.
    Y.applyUpdate(binding.doc, snapshotUpdate(binding.note), SNAPSHOT_SEED);
    binding.snapshotSeeded = true;
    if (binding.note.role !== "viewer") {
      await broadcastCheckpoint(binding);
    }
  }
  binding.ready = true;
  binding.provider.emit("synced");
  const pendingPatch = binding.pendingPatch;
  binding.pendingPatch = {};
  if (pendingPatch.title !== undefined || pendingPatch.body !== undefined) {
    editCrdtNote(noteId, pendingPatch);
  }
}

async function broadcastUpdate(binding: Binding, update: Uint8Array): Promise<void> {
  const currentTransport = await getTransport();
  const updateId = crypto.randomUUID();
  const envelope = {
    type: "crdt-update" as const,
    formatVersion: CRDT_UPDATE_FORMAT_VERSION,
    updateId,
    noteId: binding.note.id,
    cryptoOwnerId: binding.note.cryptoOwnerId,
    keyEpoch: binding.note.keyEpoch
  } satisfies Omit<EncryptedCrdtUpdate, "cipher" | "nonce">;
  const encrypted = await encryptCrdtMessage({
    ...envelope,
    noteKeyBase64: binding.note.noteKeyBase64,
    update
  });
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
  throwIfCrdtHistoryUnreadable(binding);
  binding.checkpointing = true;
  const compactedUpdateIds = [...binding.pendingUpdateIds].slice(0, 100);
  const envelope = {
    type: "crdt-checkpoint" as const,
    formatVersion: CRDT_UPDATE_FORMAT_VERSION,
    updateId,
    noteId: binding.note.id,
    cryptoOwnerId: binding.note.cryptoOwnerId,
    keyEpoch: binding.note.keyEpoch,
    compactedUpdateIds
  } satisfies Omit<EncryptedCrdtCheckpoint, "cipher" | "nonce">;
  try {
    const currentTransport = await getTransport();
    const encrypted = await encryptCrdtMessage({
      ...envelope,
      noteKeyBase64: binding.note.noteKeyBase64,
      update: Y.encodeStateAsUpdate(binding.doc)
    });
    await currentTransport.send({
      ...envelope,
      cipher: encrypted.cipher,
      nonce: encrypted.nonce
    });
    compactedUpdateIds.forEach((id) => binding.pendingUpdateIds.delete(id));
    compactedUpdateIds.forEach((id) => binding.failedUpdateIds.delete(id));
    binding.pendingUpdateIds.add(updateId);
  } finally {
    binding.checkpointing = false;
  }
}

// Seeds only the title into a fresh Y.Doc snapshot; the editor owns body content seeding.
function snapshotUpdate(note: DecryptedNote): Uint8Array {
  const seed = new Y.Doc();
  seed.clientID = Number.parseInt(note.id.slice(0, 8), 16);
  seed.transact(() => {
    seed.getText("title").insert(0, note.title);
    replaceBlockNoteFragment(seed.getXmlFragment(FRAGMENT_KEY), note.body);
    setSnapshotVersion(seed, note.version);
  }, SNAPSHOT_SEED);
  return Y.encodeStateAsUpdate(seed);
}

function getSnapshotVersion(doc: Y.Doc): number {
  return doc.getMap<number>("metadata").get(SNAPSHOT_VERSION_KEY) ?? 0;
}

function setSnapshotVersion(doc: Y.Doc, version: number): void {
  doc.getMap<number>("metadata").set(SNAPSHOT_VERSION_KEY, version);
}

function replaceWithSnapshot(binding: Binding): void {
  const clientId = binding.doc.clientID;
  binding.doc.clientID =
    (Number.parseInt(binding.note.id.slice(0, 8), 16) ^ binding.note.version) >>> 0;
  binding.doc.transact(() => {
    const text = binding.doc.getText("title");
    text.delete(0, text.length);
    text.insert(0, binding.note.title);
    replaceBlockNoteFragment(binding.fragment, binding.note.body);
    setSnapshotVersion(binding.doc, binding.note.version);
  }, SNAPSHOT_SEED);
  binding.doc.clientID = clientId;
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

function getTransport(): Promise<CrdtTransport> {
  return transport
    ? Promise.resolve(transport)
    : new Promise((resolve, reject) => transportWaiters.push({ reject, resolve }));
}
