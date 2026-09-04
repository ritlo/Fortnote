import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { decryptCrdtMessage, encryptCrdtMessage } from "@client/cryptoClient";
import {
  checkpointCrdtNote,
  clearCrdtNotes,
  editCrdtNote,
  ensureCrdtHistoryReadable,
  finishCrdtSync,
  getCrdtProvider,
  openCrdtSection,
  openCrdtNote,
  preserveCrdtContent,
  receiveCrdtUpdate,
  retryCrdtSection,
  seedLegacyCrdtSection,
  setCrdtTransport,
  type ReceivedBinaryCrdtMessage,
  type ScopedEncryptedCrdtMessage
} from "@client/realtime/crdt";
import {
  FRAGMENT_KEY,
  createDocument,
  encryptedUpdate,
  fragmentText,
  note,
  setFragmentBody
} from "./crdt.fixtures";

vi.mock("@client/cryptoClient", () => ({
  CONTENT_CHUNK_AUTH_BYTES: 16,
  decryptCrdtMessage: vi.fn(),
  encryptContentChunksV2: vi.fn(),
  encryptCrdtMessage: vi.fn().mockResolvedValue({ cipher: "cipher", nonce: "nonce" })
}));

describe("CRDT lifecycle and recovery", () => {
  afterEach(() => {
    setCrdtTransport(null);
    clearCrdtNotes();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("reports synchronization completion", async () => {
    const current = note();
    openCrdtNote(current, vi.fn());
    const provider = getCrdtProvider(current.id);
    const synced = vi.fn();
    provider.on("synced", synced);

    setCrdtTransport({ discard: vi.fn(), send: vi.fn(), subscribe: vi.fn() });
    expect(provider.isSynced).toBe(false);

    await finishCrdtSync(current.id, current.keyEpoch, false);
    expect(provider.isSynced).toBe(true);
    expect(synced).toHaveBeenCalledOnce();
  });

  it.each(["owner", "editor"] as const)(
    "checkpoints a %s open document after a key epoch advances",
    async (role) => {
    const send = vi.fn().mockResolvedValue(undefined);
    const discard = vi.fn();
    setCrdtTransport({ discard, send, subscribe: vi.fn() });
    openCrdtSection(note(), "root");
    await finishCrdtSync(note().id, 1, false, "root");
    expect(send).toHaveBeenCalledOnce();
    send.mockClear();
    setFragmentBody(getCrdtProvider(note().id, 1, "root").doc, "Live body before rotation");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    send.mockClear();

    openCrdtSection(note({ keyEpoch: 2, noteKeyBase64: "rotated-key", role }), "root");
    expect(fragmentText(getCrdtProvider(note().id, 2, "root").doc)).toBe("Live body before rotation");
    expect(getCrdtProvider(note().id, 2, "root").isSynced).toBe(false);
    await finishCrdtSync(note().id, 2, false, "root");

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ compactedUpdateIds: [], keyEpoch: 2, type: "crdt-checkpoint" })
    );
    expect(discard).toHaveBeenCalledWith(note().id, 2);
    }
  );

  it("checkpoints metadata after a closed document rotates", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const discard = vi.fn();
    setCrdtTransport({ discard, send, subscribe: vi.fn() });
    const rotated = note({
      keyEpoch: 2,
      noteKeyBase64: "rotated-key"
    });

    await checkpointCrdtNote(rotated);

    const encryptionInput = vi.mocked(encryptCrdtMessage).mock.calls[0]![0];
    const restored = new Y.Doc();
    Y.applyUpdate(restored, encryptionInput.update);
    expect(restored.getText("title").toJSON()).toBe(rotated.title);
    expect(restored.getXmlFragment(FRAGMENT_KEY).toJSON()).toBe("");
    expect(encryptionInput.noteKeyBase64).toBe("rotated-key");
    expect(encryptionInput.keyEpoch).toBe(2);
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

  it("persists metadata without synthesizing section content from the note summary", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });

    openCrdtNote(note(), vi.fn());
    await finishCrdtSync(note().id, 1, false);

    expect(send).toHaveBeenCalledOnce();
    const encryptionInput = vi.mocked(encryptCrdtMessage).mock.calls[0]![0];
    const restored = new Y.Doc();
    Y.applyUpdate(restored, encryptionInput.update);
    expect(restored.getText("title").toJSON()).toBe("Title");
    expect(restored.getXmlFragment(FRAGMENT_KEY).toJSON()).toBe("");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        compactedUpdateIds: [],
        type: "crdt-checkpoint",
        updateId: expect.any(String)
      })
    );
  });

  it("replays title edits made while snapshot migration is syncing", async () => {
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn()
    });
    const onChange = vi.fn();
    const current = note();
    openCrdtNote(current, onChange);

    editCrdtNote(current.id, { title: "Draft" });
    await finishCrdtSync(current.id, 1, false);

    await vi.waitFor(() => {
      expect(encryptCrdtMessage).toHaveBeenCalled();
    });
    const restored = new Y.Doc();
    for (const [input] of vi.mocked(encryptCrdtMessage).mock.calls) {
      Y.applyUpdate(restored, input.update);
    }
    expect(restored.getText("title").toJSON()).toBe("Draft");
    expect(onChange).toHaveBeenCalledWith({ title: "Draft" });
  });

  it("attaches an early title edit to the root binding", async () => {
    const subscribe = vi.fn();
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      subscribe
    });
    const current = note({ rootSectionId: crypto.randomUUID() });

    expect(editCrdtNote(current, { title: "Early draft" })).toBe(true);
    expect(subscribe).toHaveBeenCalledWith(current.id, "root", 1, 0);
    await vi.waitFor(() => {
      expect(encryptCrdtMessage).toHaveBeenCalled();
    });
    await finishCrdtSync(current.id, 1, false, "root");
    const restored = new Y.Doc();
    for (const [input] of vi.mocked(encryptCrdtMessage).mock.calls) {
      Y.applyUpdate(restored, input.update);
    }
    expect(restored.getText("title").toJSON()).toBe("Early draft");
  });

  it("keeps a local edit when the store replaces its note snapshot", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const current = note();
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, 1, false);
    send.mockClear();

    editCrdtNote(current, { title: "Rendered draft" });
    openCrdtNote({ ...current, title: "Rendered draft" }, vi.fn());

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "root-update" }));
  });

  it("compacts a solo editor's locally sent updates", async () => {
    const send = vi
      .fn<(message: ScopedEncryptedCrdtMessage) => Promise<void>>()
      .mockResolvedValue(undefined);
    const current = note();
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, 1, false);
    send.mockClear();

    for (let index = 0; index < 64; index += 1) {
      editCrdtNote(current.id, { title: `Title ${String(index)}` });
    }

    await vi.waitFor(() => {
      expect(send.mock.calls.some(([message]) => message.type === "crdt-checkpoint")).toBe(true);
    });
    const checkpoint = send.mock.calls.find(([message]) => message.type === "crdt-checkpoint")?.[0];
    expect(checkpoint?.type === "crdt-checkpoint" ? checkpoint.compactedUpdateIds : []).toHaveLength(64);
  });

  it("retains checkpoint eligibility until acknowledgement without losing later edits", async () => {
    let rejectCheckpoint: ((error: Error) => void) | undefined;
    let pendingCheckpoint: Promise<void> | undefined;
    let holdCheckpoint = false;
    const send = vi.fn<(message: ScopedEncryptedCrdtMessage) => Promise<void>>(
      (message) => {
        if (holdCheckpoint && message.type === "crdt-checkpoint") {
          holdCheckpoint = false;
          pendingCheckpoint = new Promise<void>((_resolve, reject) => {
            rejectCheckpoint = reject;
          });
          return pendingCheckpoint;
        }
        return Promise.resolve();
      }
    );
    const current = note();
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, 1, false);
    send.mockClear();
    holdCheckpoint = true;

    for (let index = 0; index < 63; index += 1) {
      editCrdtNote(current.id, { title: `Before checkpoint ${String(index)}` });
    }
    await vi.waitFor(() => {
      expect(rejectCheckpoint).toBeDefined();
    });
    const failedCheckpoint = send.mock.calls.find(
      ([message]) => message.type === "crdt-checkpoint"
    )?.[0];
    expect(failedCheckpoint?.compactedUpdateIds).toHaveLength(64);

    editCrdtNote(current.id, { title: "Concurrent later edit" });
    await vi.waitFor(() => {
      expect(send.mock.calls.filter(([message]) => message.type === "crdt-update"))
        .toHaveLength(64);
    });
    const concurrentUpdate = send.mock.calls.filter(
      ([message]) => message.type === "crdt-update"
    ).at(-1)?.[0];
    rejectCheckpoint!(new Error("acknowledgement lost"));
    await expect(pendingCheckpoint).rejects.toThrow("acknowledgement lost");

    send.mockClear();
    await checkpointCrdtNote(current);
    const acknowledgedCheckpoint = send.mock.calls.find(
      ([message]) => message.type === "crdt-checkpoint"
    )?.[0];
    expect(acknowledgedCheckpoint?.compactedUpdateIds).toEqual(
      expect.arrayContaining([
        ...(failedCheckpoint?.compactedUpdateIds ?? []),
        concurrentUpdate?.updateId
      ])
    );
    expect(acknowledgedCheckpoint?.compactedUpdateIds).toHaveLength(65);

    send.mockClear();
    await checkpointCrdtNote(current);
    const nextCheckpoint = send.mock.calls.find(
      ([message]) => message.type === "crdt-checkpoint"
    )?.[0];
    expect(nextCheckpoint?.compactedUpdateIds).toEqual([
      acknowledgedCheckpoint?.updateId
    ]);
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
    editCrdtNote(current, { title: "Live CRDT title" });

    expect(
      preserveCrdtContent(note({
        title: "Stale snapshot",
        updatedAt: "2026-07-14T00:00:00.000Z",
        version: 2
      }))
    ).toMatchObject({
      title: "Live CRDT title",
      updatedAt: "2026-07-14T00:00:00.000Z",
      version: 2
    });
  });

  it("does not let an older CRDT title replace newer metadata", async () => {
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn()
    });
    const current = note();
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, 1, false);
    editCrdtNote(current.id, { title: "Untitled note" });

    expect(preserveCrdtContent(note({ title: "Delayed note", version: 2 }))).toMatchObject({
      title: "Delayed note",
      version: 2
    });
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

  it("rewinds a failed history sequence before retrying a section", async () => {
    const current = note();
    const subscribe = vi.fn();
    setCrdtTransport({ discard: vi.fn(), send: vi.fn(), subscribe });
    openCrdtSection(current, "root");
    await finishCrdtSync(current.id, current.keyEpoch, false, "root");
    vi.mocked(decryptCrdtMessage).mockRejectedValueOnce(new Error("bad cipher"));

    const corrupt: ReceivedBinaryCrdtMessage = {
      type: "crdt-binary",
      formatVersion: 2,
      kind: "update",
      updateId: crypto.randomUUID(),
      noteId: current.id,
      sectionId: "root",
      cryptoOwnerId: current.cryptoOwnerId,
      expectedKeyEpoch: current.keyEpoch,
      nonce: "nonce",
      cipherLength: 1,
      serverSequence: 5,
      cipher: Uint8Array.of(1)
    };
    await expect(receiveCrdtUpdate(corrupt)).rejects.toThrow("bad cipher");

    subscribe.mockClear();
    expect(retryCrdtSection(current.id, "root", current.keyEpoch)).toBe(4);

    expect(subscribe).toHaveBeenCalledWith(current.id, "root", current.keyEpoch, 4);
    expect(getCrdtProvider(current.id, current.keyEpoch, "root").isSynced).toBe(false);
    await expect(ensureCrdtHistoryReadable(current.id, "root")).rejects.toThrow(
      "synchronizing"
    );
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

  it("blocks key rotation while initial synchronization is incomplete", async () => {
    const current = note();
    setCrdtTransport({ discard: vi.fn(), send: vi.fn(), subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());

    await expect(ensureCrdtHistoryReadable(current.id)).rejects.toThrow("synchronizing");
    await finishCrdtSync(current.id, current.keyEpoch, false);
    await expect(ensureCrdtHistoryReadable(current.id)).resolves.toBeUndefined();
  });

  it("checkpoints successful root metadata versions", async () => {
    const current = note();
    setCrdtTransport({ discard: vi.fn(), send: vi.fn(), subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, current.keyEpoch, false);
    vi.mocked(encryptCrdtMessage).mockClear();

    await checkpointCrdtNote(note({ version: 2 }));

    expect(encryptCrdtMessage).toHaveBeenCalledOnce();
    const restored = new Y.Doc();
    Y.applyUpdate(restored, vi.mocked(encryptCrdtMessage).mock.calls[0]![0].update);
    expect(restored.getMap<number>("metadata").get("snapshotVersion")).toBe(2);
    expect(restored.getText("title").toJSON()).toBe("Title");
    expect(restored.getXmlFragment(FRAGMENT_KEY).toJSON()).toBe("");
  });

  it("seeds requested legacy content outside the vault summary", () => {
    const current = note({ rootSectionId: null, version: 2 });

    seedLegacyCrdtSection(current, "root", "Newer snapshot");

    expect(fragmentText(getCrdtProvider(current.id).doc)).toContain("Newer snapshot");
    expect(preserveCrdtContent(current)).not.toHaveProperty("body");
  });

  it("keeps same-version CRDT history authoritative on a fresh open", async () => {
    const current = note({ version: 2 });
    const live = createDocument(current.title, "Newer CRDT body");
    live.getMap<number>("metadata").set("snapshotVersion", current.version);
    setCrdtTransport({ discard: vi.fn(), send: vi.fn(), subscribe: vi.fn() });
    vi.mocked(decryptCrdtMessage).mockResolvedValueOnce(Y.encodeStateAsUpdate(live));

    openCrdtNote(current, vi.fn());
    await receiveCrdtUpdate(encryptedUpdate(current));
    await finishCrdtSync(current.id, current.keyEpoch, true);

    expect(fragmentText(getCrdtProvider(current.id).doc)).toBe("Newer CRDT body");
  });

  it("keeps section-backed history authoritative over root metadata versions", async () => {
    const current = note({
      rootSectionId: "00000000-0000-4000-8000-000000000002",
      version: 2
    });
    const live = createDocument(current.title, "Persisted CRDT body");
    live.getMap<number>("metadata").set("snapshotVersion", 1);
    setCrdtTransport({ discard: vi.fn(), send: vi.fn(), subscribe: vi.fn() });
    vi.mocked(decryptCrdtMessage).mockResolvedValueOnce(Y.encodeStateAsUpdate(live));

    openCrdtNote(current, vi.fn());
    await receiveCrdtUpdate(encryptedUpdate(current));
    await finishCrdtSync(current.id, current.keyEpoch, true);

    expect(fragmentText(getCrdtProvider(current.id).doc)).toBe("Persisted CRDT body");
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

  it("requires fresh sync when transport reconnects during a rotation checkpoint", async () => {
    const current = note({ keyEpoch: 2, noteKeyBase64: "rotated-key" });
    const pending = checkpointCrdtNote(current);
    const send = vi.fn().mockResolvedValue(undefined);

    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    await expect(pending).rejects.toThrow("synchronizing");
    await finishCrdtSync(current.id, current.keyEpoch, false);
    await checkpointCrdtNote(current);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ keyEpoch: 2, type: "crdt-checkpoint" })
    );
  });

  it("converges a fresh session on the checkpoint after a save/reload", async () => {
    const ownerId = "00000000-0000-4000-8000-0000000000c1";
    const freshId = "00000000-0000-4000-8000-0000000000c2";
    setCrdtTransport({ discard: vi.fn(), send: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() });
    openCrdtNote(note({ id: ownerId }), vi.fn());
    await finishCrdtSync(ownerId, 1, false);
    setFragmentBody(getCrdtProvider(ownerId).doc, "Persisted content");
    vi.mocked(encryptCrdtMessage).mockClear();
    await checkpointCrdtNote(note({ id: ownerId, keyEpoch: 1 }));

    const checkpointInput = vi.mocked(encryptCrdtMessage).mock.calls.find(
      ([input]) => input.type === "crdt-checkpoint"
    )?.[0];
    vi.mocked(decryptCrdtMessage).mockResolvedValueOnce(checkpointInput!.update);

    openCrdtNote(note({ id: freshId }), vi.fn());
    await receiveCrdtUpdate({
      type: "crdt-checkpoint",
      formatVersion: 1,
      updateId: crypto.randomUUID(),
      noteId: freshId,
      cryptoOwnerId: "owner_1",
      keyEpoch: 1,
      cipher: "cipher",
      nonce: "nonce",
      compactedUpdateIds: []
    });
    await finishCrdtSync(freshId, 1, true);

    expect(fragmentText(getCrdtProvider(freshId).doc)).toBe("Persisted content");
  });
});
