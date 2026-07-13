import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EncryptedCrdtMessage } from "@fortnote/shared";
import { encryptCrdtMessage } from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";
import {
  checkpointCrdtNote,
  clearCrdtNotes,
  editCrdtNote,
  finishCrdtSync,
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
    vi.clearAllMocks();
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
    await finishCrdtSync(note().id, false);
    expect(send).toHaveBeenCalledOnce();
    send.mockClear();

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
    expect(discard).toHaveBeenCalledWith(note().id, 2);
  });

  it("checkpoints snapshot state after a closed document rotates", async () => {
    const send = vi.fn();
    const discard = vi.fn();
    setCrdtTransport({ discard, send, subscribe: vi.fn() });
    const rotated = note({ keyEpoch: 2, noteKeyBase64: "rotated-key" });

    await checkpointCrdtNote(rotated);

    const encryptionInput = vi.mocked(encryptCrdtMessage).mock.calls[0]![0];
    const restored = new Y.Doc();
    Y.applyUpdate(restored, encryptionInput.update);
    expect(restored.getText("title").toJSON()).toBe(rotated.title);
    expect(restored.getText("body").toJSON()).toBe(rotated.body);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ keyEpoch: 2, type: "crdt-checkpoint" })
    );
    expect(discard).toHaveBeenCalledWith(rotated.id, 2);
  });

  it("persists the whole-note snapshot as the first CRDT checkpoint", async () => {
    const send = vi.fn();
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });

    openCrdtNote(note(), vi.fn());
    await finishCrdtSync(note().id, false);

    expect(send).toHaveBeenCalledOnce();
    const encryptionInput = vi.mocked(encryptCrdtMessage).mock.calls[0]![0];
    const restored = new Y.Doc();
    Y.applyUpdate(restored, encryptionInput.update);
    expect(restored.getText("title").toJSON()).toBe("Title");
    expect(restored.getText("body").toJSON()).toBe("Body");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        compactedUpdateIds: [],
        type: "crdt-checkpoint",
        updateId: "00000000-0000-4000-8000-000000000001"
      })
    );
  });

  it("replays edits made while snapshot migration is syncing", async () => {
    setCrdtTransport({ discard: vi.fn(), send: vi.fn(), subscribe: vi.fn() });
    const onChange = vi.fn();
    const current = note();
    openCrdtNote(current, onChange);

    editCrdtNote(current.id, { body: "Draft" });
    await finishCrdtSync(current.id, false);

    await vi.waitFor(() => {
      expect(encryptCrdtMessage).toHaveBeenCalledTimes(2);
    });
    const restored = new Y.Doc();
    for (const [input] of vi.mocked(encryptCrdtMessage).mock.calls) {
      Y.applyUpdate(restored, input.update);
    }
    expect(restored.getText("body").toJSON()).toBe("Draft");
    expect(onChange).toHaveBeenCalledWith({ body: "Draft" });
  });

  it("compacts a solo editor's locally sent updates", async () => {
    const send = vi.fn<(message: EncryptedCrdtMessage) => void>();
    const current = note();
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, false);
    send.mockClear();

    for (let index = 0; index < 63; index += 1) {
      editCrdtNote(current.id, { body: `Body ${String(index)}` });
    }

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(64);
    });
    const checkpoint = send.mock.calls.find(
      ([message]) => message.type === "crdt-checkpoint"
    )?.[0];
    expect(checkpoint?.type === "crdt-checkpoint" ? checkpoint.compactedUpdateIds : [])
      .toHaveLength(64);
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
