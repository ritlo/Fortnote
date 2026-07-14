import {
  CRDT_UPDATE_FORMAT_VERSION,
  type EncryptedCrdtCheckpoint,
  type EncryptedCrdtUpdate,
  type EncryptedCrdtMessage
} from "@fortnote/shared";
import * as Y from "yjs";
import {
  decryptCrdtMessage,
  encryptCrdtMessage
} from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";

// Yjs provides battle-tested character-level merging; the server only sees ciphertext.
const REMOTE_UPDATE = Symbol("remote-update");
const SNAPSHOT_SEED = Symbol("snapshot-seed");
const SNAPSHOT_VERSION_KEY = "snapshotVersion";
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

interface Binding {
  doc: Y.Doc;
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
}

export function openCrdtNote(
  note: DecryptedNote,
  onChange: Binding["onChange"]
): () => void {
  const binding = bindings.get(note.id);
  if (!binding) {
    const doc = new Y.Doc();
    const created = {
      doc,
      note,
      onChange,
      pendingUpdateIds: new Set<string>(),
      failedUpdateIds: new Set<string>(),
      appliedUpdateCount: 0,
      checkpointing: false,
      pendingPatch: {},
      ready: false,
      receiving: Promise.resolve(),
      snapshotSeeded: false
    };
    bindings.set(note.id, created);
    doc.getText("title").observe((event) => {
      if (event.transaction.origin !== SNAPSHOT_SEED) {
        created.onChange({ title: doc.getText("title").toJSON() });
      }
    });
    doc.getText("body").observe((event) => {
      if (event.transaction.origin !== SNAPSHOT_SEED) {
        created.onChange({ body: doc.getText("body").toJSON() });
      }
    });
    doc.on("update", (update, origin) => {
      if (origin !== REMOTE_UPDATE && origin !== SNAPSHOT_SEED) {
        void broadcastUpdate(created, update).catch(() => undefined);
      }
    });
  } else {
    const epochAdvanced = note.keyEpoch > binding.note.keyEpoch;
    binding.onChange = onChange;
    if (epochAdvanced && note.role !== "owner") {
      void checkpointCrdtNote(note).catch(() => undefined);
    } else {
      binding.note = note;
    }
  }
  transport?.subscribe(note.id);

  return () => {
    const current = bindings.get(note.id);
    if (current) {
      current.onChange = () => undefined;
    }
  };
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
    if (patch.title !== undefined) {
      replaceYText(binding.doc.getText("title"), patch.title);
    }
    if (patch.body !== undefined) {
      replaceYText(binding.doc.getText("body"), patch.body);
    }
  });
  return true;
}

export function setCrdtTransport(next: CrdtTransport | null): void {
  transport = next;
  for (const binding of bindings.values()) {
    binding.ready = false;
  }
  if (next) {
    transportWaiters.splice(0).forEach(({ resolve }) => { resolve(next); });
    for (const binding of bindings.values()) {
      next.discard(binding.note.id, binding.note.keyEpoch);
      next.subscribe(binding.note.id);
    }
  }
}

export function markCrdtSnapshotVersion(noteId: string, version: number): void {
  const binding = bindings.get(noteId);
  if (!binding) {
    return;
  }
  binding.note = { ...binding.note, version };
  if (binding.ready && getSnapshotVersion(binding.doc) < version) {
    binding.doc.getMap<number>("metadata").set(SNAPSHOT_VERSION_KEY, version);
  }
}

export function preserveCrdtContent(note: DecryptedNote): DecryptedNote {
  const binding = bindings.get(note.id);
  if (!binding) {
    return note;
  }
  if (!binding.ready) {
    return { ...note, ...binding.pendingPatch };
  }
  const content = {
    title: binding.doc.getText("title").toJSON(),
    body: binding.doc.getText("body").toJSON()
  };
  if (note.keyEpoch === binding.note.keyEpoch) {
    binding.note = { ...note, ...content };
  }
  return { ...note, ...content };
}

export function removeCrdtNote(noteId: string): void {
  bindings.get(noteId)?.doc.destroy();
  bindings.delete(noteId);
}

export function clearCrdtNotes(): void {
  for (const binding of bindings.values()) {
    binding.doc.destroy();
  }
  bindings.clear();
  transportWaiters.splice(0).forEach(({ reject }) => { reject(new Error("Vault locked")); });
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
  binding.doc.transact(() => { setSnapshotVersion(binding.doc, note.version); }, SNAPSHOT_SEED);
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
    Y.applyUpdate(binding.doc, snapshotUpdate(binding.note), SNAPSHOT_SEED);
    binding.snapshotSeeded = true;
    if (binding.note.role !== "viewer") {
      await broadcastCheckpoint(binding);
    }
  }
  binding.ready = true;
  const pendingPatch = binding.pendingPatch;
  binding.pendingPatch = {};
  if (pendingPatch.title !== undefined || pendingPatch.body !== undefined) {
    editCrdtNote(noteId, pendingPatch);
  }
}

export function replaceYText(text: Y.Text, next: string): void {
  const current = text.toJSON();
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) {
    start += 1;
  }
  let currentEnd = current.length;
  let nextEnd = next.length;
  while (
    currentEnd > start &&
    nextEnd > start &&
    current[currentEnd - 1] === next[nextEnd - 1]
  ) {
    currentEnd -= 1;
    nextEnd -= 1;
  }
  if (currentEnd > start) {
    text.delete(start, currentEnd - start);
  }
  if (nextEnd > start) {
    text.insert(start, next.slice(start, nextEnd));
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

function snapshotUpdate(note: DecryptedNote): Uint8Array {
  const seed = new Y.Doc();
  seed.clientID = Number.parseInt(note.id.slice(0, 8), 16);
  seed.getText("title").insert(0, note.title);
  seed.getText("body").insert(0, note.body);
  setSnapshotVersion(seed, note.version);
  return Y.encodeStateAsUpdate(seed);
}

function replaceWithSnapshot(binding: Binding): void {
  const clientId = binding.doc.clientID;
  binding.doc.clientID = (Number.parseInt(binding.note.id.slice(0, 8), 16) ^ binding.note.version) >>> 0;
  binding.doc.transact(() => {
    replaceYText(binding.doc.getText("title"), binding.note.title);
    replaceYText(binding.doc.getText("body"), binding.note.body);
    setSnapshotVersion(binding.doc, binding.note.version);
  }, SNAPSHOT_SEED);
  binding.doc.clientID = clientId;
  binding.snapshotSeeded = true;
}

function getSnapshotVersion(doc: Y.Doc): number {
  return doc.getMap<number>("metadata").get(SNAPSHOT_VERSION_KEY) ?? 0;
}

function setSnapshotVersion(doc: Y.Doc, version: number): void {
  doc.getMap<number>("metadata").set(SNAPSHOT_VERSION_KEY, version);
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
