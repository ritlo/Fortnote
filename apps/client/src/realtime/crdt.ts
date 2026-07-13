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
// ponytail: fixed threshold; tune from update-size metrics if storage churn matters.
const CHECKPOINT_UPDATE_COUNT = 64;
const bindings = new Map<string, Binding>();
let transport: CrdtTransport | null = null;

interface CrdtTransport {
  subscribe: (noteId: string) => void;
  send: (update: EncryptedCrdtMessage) => void;
}

interface Binding {
  doc: Y.Doc;
  note: DecryptedNote;
  onChange: (patch: Partial<Pick<DecryptedNote, "title" | "body">>) => void;
  pendingUpdateIds: Set<string>;
  checkpointing: boolean;
}

export function openCrdtNote(
  note: DecryptedNote,
  onChange: Binding["onChange"]
): () => void {
  const binding = bindings.get(note.id);
  if (
    binding?.note.noteKeyBase64 !== note.noteKeyBase64 ||
    binding.note.keyEpoch !== note.keyEpoch
  ) {
    // ponytail: snapshot text seeds a field on its first edit; replace with a
    // persisted Yjs migration checkpoint when offline migration lands.
    const doc = new Y.Doc();
    const created = {
      doc,
      note,
      onChange,
      pendingUpdateIds: new Set<string>(),
      checkpointing: false
    };
    bindings.set(note.id, created);
    doc.getText("title").observe(() => {
      created.onChange({ title: doc.getText("title").toJSON() });
    });
    doc.getText("body").observe(() => {
      created.onChange({ body: doc.getText("body").toJSON() });
    });
    doc.on("update", (update, origin) => {
      if (origin !== REMOTE_UPDATE) {
        void broadcastUpdate(created, update);
      }
    });
  } else {
    binding.note = note;
    binding.onChange = onChange;
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
    for (const noteId of bindings.keys()) {
      transport.subscribe(noteId);
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

export async function receiveCrdtUpdate(update: EncryptedCrdtMessage): Promise<void> {
  const binding = bindings.get(update.noteId);
  if (
    binding?.note.cryptoOwnerId !== update.cryptoOwnerId ||
    binding.note.keyEpoch !== update.keyEpoch
  ) {
    return;
  }
  const plaintext = await decryptCrdtMessage({
    ...update,
    noteKeyBase64: binding.note.noteKeyBase64
  });
  Y.applyUpdate(binding.doc, plaintext, REMOTE_UPDATE);
  if (update.type === "crdt-checkpoint") {
    update.compactedUpdateIds.forEach((id) => binding.pendingUpdateIds.delete(id));
  }
  binding.pendingUpdateIds.add(update.updateId);
  if (
    binding.pendingUpdateIds.size >= CHECKPOINT_UPDATE_COUNT &&
    !binding.checkpointing
  ) {
    void broadcastCheckpoint(binding);
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
}

async function broadcastCheckpoint(binding: Binding): Promise<void> {
  if (!transport) {
    return;
  }
  binding.checkpointing = true;
  const updateId = crypto.randomUUID();
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
