import {
  CRDT_UPDATE_FORMAT_VERSION,
  type EncryptedCrdtUpdate
} from "@fortnote/shared";
import * as Y from "yjs";
import { decryptCrdtUpdate, encryptCrdtUpdate } from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";

// Yjs provides battle-tested character-level merging; the server only sees ciphertext.
const REMOTE_UPDATE = Symbol("remote-update");
const bindings = new Map<string, Binding>();
let transport: CrdtTransport | null = null;

interface CrdtTransport {
  subscribe: (noteId: string) => void;
  send: (update: EncryptedCrdtUpdate) => void;
}

interface Binding {
  doc: Y.Doc;
  note: DecryptedNote;
  onChange: (patch: Partial<Pick<DecryptedNote, "title" | "body">>) => void;
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
    const created = { doc, note, onChange };
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

export async function receiveCrdtUpdate(update: EncryptedCrdtUpdate): Promise<void> {
  const binding = bindings.get(update.noteId);
  if (
    binding?.note.cryptoOwnerId !== update.cryptoOwnerId ||
    binding.note.keyEpoch !== update.keyEpoch
  ) {
    return;
  }
  const plaintext = await decryptCrdtUpdate({
    ...update,
    noteKeyBase64: binding.note.noteKeyBase64
  });
  Y.applyUpdate(binding.doc, plaintext, REMOTE_UPDATE);
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
  const encrypted = await encryptCrdtUpdate({
    cryptoOwnerId: binding.note.cryptoOwnerId,
    noteId: binding.note.id,
    noteKeyBase64: binding.note.noteKeyBase64,
    keyEpoch: binding.note.keyEpoch,
    updateId,
    update
  });
  transport.send({
    type: "crdt-update",
    formatVersion: CRDT_UPDATE_FORMAT_VERSION,
    updateId,
    noteId: binding.note.id,
    cryptoOwnerId: binding.note.cryptoOwnerId,
    keyEpoch: binding.note.keyEpoch,
    cipher: encrypted.cipher,
    nonce: encrypted.nonce
  });
}
