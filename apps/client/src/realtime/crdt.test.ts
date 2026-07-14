import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EncryptedCrdtMessage } from "@fortnote/shared";
import { decryptCrdtMessage, encryptCrdtMessage } from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";
import {
  checkpointCrdtNote,
  clearCrdtNotes,
  editCrdtNote,
  finishCrdtSync,
  openCrdtNote,
  preserveCrdtContent,
  receiveCrdtUpdate,
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

  it("checkpoints an editor's open document after a key epoch advances", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const discard = vi.fn();
    setCrdtTransport({ discard, send, subscribe: vi.fn() });
    const editorNote = note({ role: "editor" });
    openCrdtNote(editorNote, vi.fn());
    await finishCrdtSync(editorNote.id, 1, false);
    expect(send).toHaveBeenCalledOnce();
    send.mockClear();

    openCrdtNote(
      note({ keyEpoch: 2, noteKeyBase64: "rotated-key", role: "editor" }),
      vi.fn()
    );

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
    const send = vi.fn().mockResolvedValue(undefined);
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

  it("ignores stale sync completion from an older key epoch", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const rotated = note({ keyEpoch: 2, noteKeyBase64: "rotated-key" });
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(rotated, vi.fn());

    await finishCrdtSync(rotated.id, 1, false);
    expect(send).not.toHaveBeenCalled();

    await finishCrdtSync(rotated.id, 2, false);
    expect(send).toHaveBeenCalledOnce();
  });

  it("persists the whole-note snapshot as the first CRDT checkpoint", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });

    openCrdtNote(note(), vi.fn());
    await finishCrdtSync(note().id, 1, false);

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
        updateId: expect.any(String)
      })
    );
  });

  it("replays edits made while snapshot migration is syncing", async () => {
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn()
    });
    const onChange = vi.fn();
    const current = note();
    openCrdtNote(current, onChange);

    editCrdtNote(current.id, { body: "Draft" });
    await finishCrdtSync(current.id, 1, false);

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
    const send = vi.fn<(message: EncryptedCrdtMessage) => Promise<void>>()
      .mockResolvedValue(undefined);
    const current = note();
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, 1, false);
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

  it("keeps an open CRDT document authoritative over snapshot reloads", async () => {
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn()
    });
    const current = note();
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, 1, false);
    editCrdtNote(current.id, { body: "Live CRDT body" });

    expect(preserveCrdtContent(note({ body: "Stale snapshot" })).body)
      .toBe("Live CRDT body");
  });

  it("preserves undecryptable envelopes instead of checkpointing over them", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const current = note();
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());
    vi.mocked(decryptCrdtMessage).mockRejectedValueOnce(new Error("bad cipher"));

    const corrupt = encryptedUpdate(current);
    await expect(receiveCrdtUpdate(corrupt)).rejects.toThrow("bad cipher");
    await expect(finishCrdtSync(current.id, 1, true)).rejects.toThrow(
      "Realtime history could not be decrypted"
    );
    expect(send).not.toHaveBeenCalled();

    vi.mocked(decryptCrdtMessage).mockResolvedValueOnce(Y.encodeStateAsUpdate(new Y.Doc()));
    await receiveCrdtUpdate(corrupt);
    await expect(finishCrdtSync(current.id, 1, true)).resolves.toBeUndefined();
  });

  it("blocks key rotation checkpoints while history is undecryptable", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const current = note();
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());
    vi.mocked(decryptCrdtMessage).mockRejectedValueOnce(new Error("bad cipher"));

    await expect(receiveCrdtUpdate(encryptedUpdate(current))).rejects.toThrow("bad cipher");
    await expect(
      checkpointCrdtNote(note({ keyEpoch: 2, noteKeyBase64: "rotated-key" }))
    ).rejects.toThrow("Realtime history could not be decrypted");
    expect(send).not.toHaveBeenCalled();
  });

  it("migrates a newer legacy snapshot on a fresh CRDT open", async () => {
    const current = note({ body: "Newer snapshot", version: 2 });
    const older = createDocument(current.title, "Older CRDT body");
    setCrdtTransport({ discard: vi.fn(), send: vi.fn(), subscribe: vi.fn() });
    vi.mocked(decryptCrdtMessage).mockResolvedValueOnce(Y.encodeStateAsUpdate(older));

    openCrdtNote(current, vi.fn());
    await receiveCrdtUpdate(encryptedUpdate(current));
    await finishCrdtSync(current.id, current.keyEpoch, true);

    expect(preserveCrdtContent(current).body).toBe("Newer snapshot");
  });

  it("keeps same-version CRDT history authoritative on a fresh open", async () => {
    const current = note({ body: "Older snapshot", version: 2 });
    const live = createDocument(current.title, "Newer CRDT body");
    live.getMap<number>("metadata").set("snapshotVersion", current.version);
    setCrdtTransport({ discard: vi.fn(), send: vi.fn(), subscribe: vi.fn() });
    vi.mocked(decryptCrdtMessage).mockResolvedValueOnce(Y.encodeStateAsUpdate(live));

    openCrdtNote(current, vi.fn());
    await receiveCrdtUpdate(encryptedUpdate(current));
    await finishCrdtSync(current.id, current.keyEpoch, true);

    expect(preserveCrdtContent(current).body).toBe("Newer CRDT body");
  });

  it("does not checkpoint remote traffic as a viewer", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const current = note({ role: "viewer" });
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, 1, false);
    vi.mocked(decryptCrdtMessage).mockResolvedValue(Y.encodeStateAsUpdate(new Y.Doc()));
    await Promise.all(
      Array.from({ length: 64 }, () => receiveCrdtUpdate(encryptedUpdate(current)))
    );

    expect(send).not.toHaveBeenCalled();
  });

  it("waits for transport before completing a rotation checkpoint", async () => {
    const current = note({ keyEpoch: 2, noteKeyBase64: "rotated-key" });
    const pending = checkpointCrdtNote(current);
    const send = vi.fn().mockResolvedValue(undefined);

    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    await pending;

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ keyEpoch: 2, type: "crdt-checkpoint" })
    );
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

function encryptedUpdate(current: DecryptedNote): EncryptedCrdtMessage {
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
