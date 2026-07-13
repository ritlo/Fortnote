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
// ponytail: fixed threshold; tune from update-size metrics if storage churn matters.
const CHECKPOINT_UPDATE_COUNT = 64;
const bindings = new Map<string, Binding>();
let transport: CrdtTransport | null = null;

interface CrdtTransport {
  discard: (noteId: string, beforeKeyEpoch: number) => void;
  subscribe: (noteId: string) => void;
  send: (update: EncryptedCrdtMessage) => void;
}

interface Binding {
  doc: Y.Doc;
  note: DecryptedNote;
  onChange: (patch: Partial<Pick<DecryptedNote, "title" | "body">>) => void;
  pendingUpdateIds: Set<string>;
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
        void broadcastUpdate(created, update);
      }
    });
  } else {
    const epochAdvanced = note.keyEpoch > binding.note.keyEpoch;
    binding.note = note;
    binding.onChange = onChange;
    if (epochAdvanced) {
      binding.pendingUpdateIds.clear();
      transport?.discard(note.id, note.keyEpoch);
      // ponytail: this checkpoints current Yjs state; the still-open migration
      // work must first seed untouched snapshot fields into that state.
      void broadcastCheckpoint(binding);
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
  if (transport) {
    for (const binding of bindings.values()) {
      transport.discard(binding.note.id, binding.note.keyEpoch);
      transport.subscribe(binding.note.id);
    }
  }
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
    const plaintext = await decryptCrdtMessage({
      ...update,
      noteKeyBase64: binding.note.noteKeyBase64
    });
    Y.applyUpdate(binding.doc, plaintext, REMOTE_UPDATE);
    if (update.type === "crdt-checkpoint") {
      update.compactedUpdateIds.forEach((id) => binding.pendingUpdateIds.delete(id));
    }
    trackUpdate(binding, update.updateId);
  });
  binding.receiving = received.catch(() => undefined);
  return received;
}

export async function finishCrdtSync(
  noteId: string,
  hasUpdates: boolean
): Promise<void> {
  const binding = bindings.get(noteId);
  if (!binding || binding.ready) {
    return;
  }
  await binding.receiving;
  if (!hasUpdates && !binding.snapshotSeeded) {
    Y.applyUpdate(binding.doc, snapshotUpdate(binding.note), SNAPSHOT_SEED);
    binding.snapshotSeeded = true;
    if (binding.note.role !== "viewer") {
      await broadcastCheckpoint(binding, binding.note.id);
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
  if (!transport) {
    return;
  }
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
  transport.send({
    ...envelope,
    cipher: encrypted.cipher,
    nonce: encrypted.nonce
  });
  trackUpdate(binding, updateId);
}

async function broadcastCheckpoint(
  binding: Binding,
  updateId: string = crypto.randomUUID()
): Promise<void> {
  if (!transport) {
    return;
  }
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
    const encrypted = await encryptCrdtMessage({
      ...envelope,
      noteKeyBase64: binding.note.noteKeyBase64,
      update: Y.encodeStateAsUpdate(binding.doc)
    });
    transport.send({
      ...envelope,
      cipher: encrypted.cipher,
      nonce: encrypted.nonce
    });
    compactedUpdateIds.forEach((id) => binding.pendingUpdateIds.delete(id));
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
  return Y.encodeStateAsUpdate(seed);
}

function trackUpdate(binding: Binding, updateId: string): void {
  binding.pendingUpdateIds.add(updateId);
  if (
    binding.pendingUpdateIds.size >= CHECKPOINT_UPDATE_COUNT &&
    !binding.checkpointing
  ) {
    void broadcastCheckpoint(binding);
  }
}
