import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DecryptedNote } from "../store/appStore";
import {
  clearCrdtNotes,
  openCrdtNote,
  replaceYText,
  setCrdtTransport
} from "./crdt";

vi.mock("../cryptoClient", () => ({
  decryptCrdtMessage: vi.fn(),
  encryptCrdtMessage: vi.fn().mockResolvedValue({ cipher: "cipher", nonce: "nonce" })
}));

describe("CRDT collaboration", () => {
  afterEach(() => {
    setCrdtTransport(null);
    clearCrdtNotes();
  });

  it("converges concurrent character edits from two clients", () => {
    const alice = createDocument("Title", "hello");
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    replaceYText(alice.getText("body"), "A hello");
    replaceYText(bob.getText("body"), "hello B");
    const aliceUpdate = Y.encodeStateAsUpdate(alice, Y.encodeStateVector(bob));
    const bobUpdate = Y.encodeStateAsUpdate(bob, Y.encodeStateVector(alice));
    Y.applyUpdate(alice, bobUpdate);
    Y.applyUpdate(bob, aliceUpdate);

    expect(alice.getText("body").toJSON()).toBe(bob.getText("body").toJSON());
    expect(alice.getText("body").toJSON()).toContain("A ");
    expect(alice.getText("body").toJSON()).toContain(" B");
  });

  it("checkpoints open document state after a key epoch advances", async () => {
    const send = vi.fn();
    const discard = vi.fn();
    setCrdtTransport({ discard, send, subscribe: vi.fn() });
    openCrdtNote(note(), vi.fn());

    openCrdtNote(note({ keyEpoch: 2, noteKeyBase64: "rotated-key" }), vi.fn());

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        compactedUpdateIds: [],
        keyEpoch: 2,
        type: "crdt-checkpoint"
      })
    );
    expect(discard).toHaveBeenCalledWith("note_1", 2);
  });
});

function createDocument(title: string, body: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("title").insert(0, title);
  doc.getText("body").insert(0, body);
  return doc;
}

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    body: "Body",
    contentLength: 4,
    cryptoOwnerId: "owner_1",
    folderId: null,
    id: "note_1",
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
