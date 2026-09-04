import type { EncryptedCrdtMessage } from "@fortnote/shared";
import type { DecryptedNote } from "@client/store/appStore";
import * as Y from "yjs";

export const FRAGMENT_KEY = "document-store";

export function setFragmentBody(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  doc.transact(() => {
    fragment.delete(0, fragment.length);
    const xmlText = new Y.XmlText();
    xmlText.insert(0, text);
    fragment.insert(0, [xmlText]);
  });
}

export function fragmentText(doc: Y.Doc): string {
  return doc.getXmlFragment(FRAGMENT_KEY).toJSON();
}

export function appendFragment(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  const first = fragment.get(0);
  if (first instanceof Y.XmlText) {
    first.insert(first.length, text);
  } else {
    setFragmentBody(doc, text);
  }
}

export function createDocument(title: string, body: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("title").insert(0, title);
  setFragmentBody(doc, body);
  return doc;
}

export function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    contentLength: 4,
    cryptoOwnerId: "owner_1",
    folderId: null,
    id: "00000000-0000-4000-8000-000000000001",
    isDeleted: false,
    keyEpoch: 1,
    noteKeyBase64: "note-key",
    ownerUserId: "owner_1",
    role: "owner",
    title: "Title",
    updatedAt: "2026-07-13T00:00:00.000Z",
    version: 1,
    ...overrides
  };
}

export function encryptedUpdate(current: DecryptedNote): EncryptedCrdtMessage {
  return {
    type: "crdt-update",
    formatVersion: 1,
    updateId: crypto.randomUUID(),
    noteId: current.id,
    cryptoOwnerId: current.cryptoOwnerId,
    keyEpoch: current.keyEpoch,
    cipher: "cipher",
    nonce: "nonce"
  };
}
