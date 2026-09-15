import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { decryptCrdtMessage, encryptCrdtMessage } from "@client/cryptoClient";
import { replaceBlockNoteFragment } from "@client/lib/blockNote";
import * as contentTransfer from "@client/realtime/contentTransfer";
import {
  clearCrdtNotes,
  createCrdtSectionInitializationManifest,
  ensureCrdtHistoryReadable,
  finishCrdtSync,
  getCrdtProvider,
  getCrdtSectionOrder,
  openCrdtSection,
  openCrdtNote,
  receiveCrdtUpdate,
  releaseCrdtSection,
  replaceCrdtSectionOrder,
  requiresContentTransfer,
  setCrdtTransport,
  snapshotReadyCrdtSection,
  subscribeCrdtSectionChanges,
  waitForCrdtSectionDurable,
  type ScopedEncryptedCrdtMessage
} from "@client/realtime/crdt";
import {
  FRAGMENT_KEY,
  appendFragment,
  createDocument,
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

vi.mock("@client/realtime/contentTransfer", () => ({
  downloadVerifiedContent: vi.fn()
}));

describe("CRDT collaboration", () => {
  afterEach(() => {
    setCrdtTransport(null);
    clearCrdtNotes();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("routes only updates that cannot fit the realtime frame through content transfer", () => {
    expect(requiresContentTransfer(256 * 1024 - 4096 - 16)).toBe(false);
    expect(requiresContentTransfer(256 * 1024 - 4096 - 15)).toBe(true);
  });

  it("forces initialization checkpoints through durable chunks and protects root order", async () => {
    const sectionId = "00000000-0000-4000-8000-000000000002";
    const current = note({
      noteKeyBase64: "AQIDBA==",
      rootSectionId: sectionId
    });
    const sendDurably = vi.fn().mockReturnValue({
      durable: Promise.resolve(),
      delivered: Promise.resolve()
    });
    const manifest = {
      manifestId: "manifest-1",
      uploadId: "upload-1",
      updateId: "update-1",
      noteId: current.id,
      sectionId,
      cryptoOwnerId: current.cryptoOwnerId,
      keyEpoch: 1,
      kind: "checkpoint" as const,
      firstSequence: 1,
      lastSequence: 1,
      totalCipherBytes: 32,
      chunkCount: 1,
      manifestHash: "hash",
      checkpointSequenceCutoff: 0
    };
    const sendContentDurably = vi.fn().mockReturnValue({
      durable: Promise.resolve(),
      delivered: Promise.resolve(manifest)
    });
    vi.mocked(
      (await import("@client/cryptoClient")).encryptContentChunksV2
    ).mockResolvedValue({
      cryptoOwnerId: current.cryptoOwnerId,
      noteId: current.id,
      sectionId,
      keyEpoch: 1,
      updateId: "prepared-update",
      uploadId: "upload-1",
      requestId: "request-1",
      kind: "checkpoint",
      formatVersion: 2,
      totalCipherBytes: 32,
      chunkCount: 1,
      manifestHash: "hash",
      checkpointSequenceCutoff: 0,
      chunks: []
    });
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      sendDurably,
      sendContentDurably,
      subscribe: vi.fn()
    });
    openCrdtSection(current, "root");
    await finishCrdtSync(current.id, 1, false, "root");
    expect(replaceCrdtSectionOrder(current.id, [sectionId, sectionId])).toBe(true);
    await waitForCrdtSectionDurable(current.id, 1, "root");
    expect(getCrdtSectionOrder(current.id)).toEqual([sectionId]);

    openCrdtSection(current, sectionId);
    await finishCrdtSync(current.id, 1, false, sectionId);
    await expect(
      createCrdtSectionInitializationManifest(current.id, 1, sectionId)
    ).resolves.toEqual(manifest);
    expect(sendContentDurably).toHaveBeenCalledOnce();
  });

  it("releases after pending delivery without tearing down a reopened section", async () => {
    const sectionId = "00000000-0000-4000-8000-000000000002";
    const current = note({ rootSectionId: sectionId });
    let finishDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const sendDurably = vi
      .fn()
      .mockReturnValueOnce({
        durable: Promise.resolve(),
        delivered: Promise.resolve()
      })
      .mockReturnValue({
        durable: Promise.resolve(),
        delivered: delivery
      });
    const unsubscribe = vi.fn();
    setCrdtTransport({
      discard: vi.fn(),
      send,
      sendDurably,
      subscribe: vi.fn(),
      unsubscribe
    });
    const first = openCrdtSection(current, sectionId);
    await finishCrdtSync(current.id, current.keyEpoch, false, sectionId);
    sendDurably.mockClear();

    appendFragment(first.provider.doc, "pending edit");
    await vi.waitFor(() => {
      expect(sendDurably).toHaveBeenCalledOnce();
    });
    const releasing = releaseCrdtSection(
      current.id,
      sectionId,
      current.keyEpoch,
      first.generation
    );
    const reopened = openCrdtSection(current, sectionId);

    await expect(releasing).resolves.toBe(true);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(reopened.provider).toBe(first.provider);
    finishDelivery();
    await delivery;
    await expect(
      releaseCrdtSection(current.id, sectionId, current.keyEpoch, reopened.generation)
    ).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalledWith(current.id, sectionId, current.keyEpoch);
  });

  it("applies manifest-backed updates only after verified download completes", async () => {
    const sectionId = "00000000-0000-4000-8000-000000000002";
    const current = note({
      rootSectionId: sectionId,
      noteKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    });
    let finishDownload!: (bytes: Uint8Array) => void;
    const downloadContent = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finishDownload = resolve;
        })
    );
    setCrdtTransport({
      discard: vi.fn(),
      downloadContent,
      send: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn()
    });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, current.keyEpoch, false, sectionId);
    const provider = getCrdtProvider(current.id, current.keyEpoch, sectionId);
    const remote = new Y.Doc();
    setFragmentBody(remote, "Verified remote content");

    const receiving = receiveCrdtUpdate({
      type: "crdt-manifest",
      formatVersion: 2,
      noteId: current.id,
      sectionId,
      keyEpoch: current.keyEpoch,
      updateId: crypto.randomUUID(),
      manifestId: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
      cryptoOwnerId: current.cryptoOwnerId,
      kind: "update",
      totalCipherBytes: 1024,
      chunkCount: 1,
      manifestHash: "a".repeat(64),
      serverSequence: 1
    });
    await vi.waitFor(() => {
      expect(finishDownload).toBeTypeOf("function");
    });
    expect(fragmentText(provider.doc)).not.toContain("Verified remote content");

    finishDownload(Y.encodeStateAsUpdate(remote));
    await receiving;
    expect(downloadContent).toHaveBeenCalledOnce();
    expect(fragmentText(provider.doc)).toContain("Verified remote content");
  });

  it("recovers from corrupt covered history after a verified manifest checkpoint", async () => {
    const sectionId = "00000000-0000-4000-8000-000000000002";
    const current = note({
      rootSectionId: sectionId,
      noteKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    });
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn()
    });
    openCrdtNote(current, vi.fn());
    vi.mocked(decryptCrdtMessage).mockRejectedValueOnce(new Error("bad cipher"));

    await expect(
      receiveCrdtUpdate({
        type: "crdt-binary",
        formatVersion: 2,
        kind: "update",
        updateId: crypto.randomUUID(),
        noteId: current.id,
        sectionId,
        cryptoOwnerId: current.cryptoOwnerId,
        expectedKeyEpoch: current.keyEpoch,
        nonce: "nonce",
        cipherLength: 1,
        serverSequence: 1,
        cipher: Uint8Array.of(1)
      })
    ).rejects.toThrow("bad cipher");
    await expect(ensureCrdtHistoryReadable(current.id, sectionId)).rejects.toThrow(
      "could not be decrypted"
    );

    const checkpoint = new Y.Doc();
    setFragmentBody(checkpoint, "Recovered checkpoint");
    vi.mocked(contentTransfer.downloadVerifiedContent).mockResolvedValueOnce(
      Y.encodeStateAsUpdate(checkpoint)
    );
    await receiveCrdtUpdate({
      type: "crdt-manifest",
      formatVersion: 2,
      noteId: current.id,
      sectionId,
      keyEpoch: current.keyEpoch,
      updateId: crypto.randomUUID(),
      manifestId: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
      cryptoOwnerId: current.cryptoOwnerId,
      kind: "checkpoint",
      checkpointSequenceCutoff: 1,
      totalCipherBytes: 1024,
      chunkCount: 1,
      manifestHash: "a".repeat(64),
      serverSequence: 2
    });
    await finishCrdtSync(current.id, current.keyEpoch, true, sectionId);

    await expect(
      ensureCrdtHistoryReadable(current.id, sectionId)
    ).resolves.toBeUndefined();
    expect(
      fragmentText(getCrdtProvider(current.id, current.keyEpoch, sectionId).doc)
    ).toContain("Recovered checkpoint");
  });

  it("keeps the encrypted root and BlockNote section in independent Y.Docs", async () => {
    const current = note({
      rootSectionId: "00000000-0000-4000-8000-000000000002"
    });
    const send = vi
      .fn<(message: ScopedEncryptedCrdtMessage) => Promise<void>>()
      .mockResolvedValue(undefined);
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });

    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, current.keyEpoch, false, "root");
    await finishCrdtSync(
      current.id,
      current.keyEpoch,
      false,
      current.rootSectionId ?? "root"
    );

    const root = getCrdtProvider(current.id, current.keyEpoch, "root").doc;
    const section = getCrdtProvider(
      current.id,
      current.keyEpoch,
      current.rootSectionId ?? "root"
    ).doc;
    expect(root).not.toBe(section);
    expect(root.getText("title").toJSON()).toBe(current.title);
    expect(root.getArray<string>("sections").toArray()).toEqual([current.rootSectionId]);
    expect(fragmentText(root)).toBe("");
    expect(fragmentText(section)).not.toContain("Body");
    expect(new Set(send.mock.calls.map(([message]) => message.sectionId))).toEqual(
      new Set(["root", current.rootSectionId])
    );
  });

  it("publishes only ready verified section snapshots for incremental search", async () => {
    const current = note({
      rootSectionId: "00000000-0000-4000-8000-000000000002"
    });
    const changes: { noteId: string; sectionId: string; serverSequence: number }[] = [];
    const unsubscribe = subscribeCrdtSectionChanges((change) => {
      changes.push(change);
    });
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn()
    });
    const section = openCrdtSection(current, current.rootSectionId ?? "root");

    expect(
      snapshotReadyCrdtSection(
        current.id,
        current.keyEpoch,
        current.rootSectionId ?? "root"
      )
    ).toBeNull();
    await finishCrdtSync(
      current.id,
      current.keyEpoch,
      false,
      current.rootSectionId ?? "root",
      4
    );
    changes.length = 0;
    section.provider.doc.transact(() => {
      replaceBlockNoteFragment(
        section.provider.doc.getXmlFragment(FRAGMENT_KEY),
        "Fresh searchable text"
      );
    });

    expect(changes).toEqual([
      expect.objectContaining({
        noteId: current.id,
        sectionId: current.rootSectionId,
        serverSequence: 4
      })
    ]);
    expect(
      snapshotReadyCrdtSection(
        current.id,
        current.keyEpoch,
        current.rootSectionId ?? "root"
      )
    ).not.toBeNull();
    unsubscribe();
  });

  it("reports local content saves through the provider lifecycle", async () => {
    const current = note({
      rootSectionId: "00000000-0000-4000-8000-000000000002"
    });
    let finishDelivery!: () => void;
    const delivered = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const sendDurably = vi
      .fn()
      .mockReturnValueOnce({
        durable: Promise.resolve(),
        delivered: Promise.resolve()
      })
      .mockReturnValue({
        durable: Promise.resolve(),
        delivered
      });
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      sendDurably,
      subscribe: vi.fn()
    });
    const section = openCrdtSection(current, current.rootSectionId ?? "root");
    await finishCrdtSync(
      current.id,
      current.keyEpoch,
      false,
      current.rootSectionId ?? "root"
    );
    const states: unknown[] = [];
    section.provider.on("save-state", (state) => {
      states.push(state);
    });

    section.provider.doc.transact(() => {
      replaceBlockNoteFragment(
        section.provider.doc.getXmlFragment(FRAGMENT_KEY),
        "Edited content"
      );
    });

    expect(states).toEqual(["saving"]);
    finishDelivery();
    await vi.waitFor(() => {
      expect(states).toEqual(["saving", "saved"]);
    });
  });

  it("resubscribes each section after its highest reconciled server sequence", async () => {
    const current = note();
    const firstSubscribe = vi.fn();
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      subscribe: firstSubscribe
    });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, current.keyEpoch, false, "root", 12);

    setCrdtTransport(null);
    const resumedSubscribe = vi.fn();
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      subscribe: resumedSubscribe
    });

    expect(resumedSubscribe).toHaveBeenCalledWith(
      current.id,
      "root",
      current.keyEpoch,
      12
    );
  });

  it("ignores a delayed decrypt after its provider generation is replaced", async () => {
    const current = note();
    setCrdtTransport({
      discard: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn()
    });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(current.id, 1, false);
    let finishDecrypt!: (update: Uint8Array) => void;
    vi.mocked(decryptCrdtMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDecrypt = resolve;
        })
    );
    const receiving = receiveCrdtUpdate({
      type: "crdt-update",
      formatVersion: 1,
      updateId: crypto.randomUUID(),
      noteId: current.id,
      cryptoOwnerId: current.cryptoOwnerId,
      keyEpoch: 1,
      cipher: "cipher",
      nonce: "nonce"
    });
    await vi.waitFor(() => {
      expect(finishDecrypt).toBeTypeOf("function");
    });
    const replacementChange = vi.fn();
    const replacement = note({ keyEpoch: 2, noteKeyBase64: "replacement-key" });
    openCrdtNote(replacement, replacementChange);
    const replacementProvider = getCrdtProvider(current.id, 2);
    const stale = createDocument("Stale remote title", "Stale remote body");

    finishDecrypt(Y.encodeStateAsUpdate(stale));
    await receiving;

    expect(replacementProvider.doc.getText("title").toJSON()).toBe(current.title);
    expect(replacementChange).not.toHaveBeenCalledWith({ title: "Stale remote title" });
    expect(getCrdtProvider(current.id, 1)).toBe(replacementProvider);
  });

  it("never assigns or reuses Yjs client IDs across root and section documents", () => {
    const current = note({
      rootSectionId: "00000000-0000-4000-8000-000000000002"
    });

    openCrdtNote(current, vi.fn());

    const root = getCrdtProvider(current.id, current.keyEpoch, "root").doc;
    const section = getCrdtProvider(
      current.id,
      current.keyEpoch,
      current.rootSectionId ?? "root"
    ).doc;
    expect(root.clientID).not.toBe(section.clientID);
    expect(root.clientID).not.toBe(Number.parseInt(current.id.slice(0, 8), 16));
    expect(section.clientID).not.toBe(Number.parseInt(current.id.slice(0, 8), 16));
  });

  it("creates a valid first checkpoint for an empty section", async () => {
    const current = note({
      rootSectionId: "00000000-0000-4000-8000-000000000002"
    });
    const send = vi
      .fn<(message: ScopedEncryptedCrdtMessage) => Promise<void>>()
      .mockResolvedValue(undefined);
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());

    await finishCrdtSync(
      current.id,
      current.keyEpoch,
      false,
      current.rootSectionId ?? "root"
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        sectionId: current.rootSectionId,
        type: "crdt-checkpoint"
      })
    );
    const encrypted = vi.mocked(encryptCrdtMessage).mock.calls.at(-1)?.[0].update;
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(encrypted?.byteLength).toBeGreaterThan(0);
  });

  it("keeps terminally rejected section work visible for encrypted draft recovery", async () => {
    const current = note({
      rootSectionId: "00000000-0000-4000-8000-000000000002"
    });
    const send = vi
      .fn<(message: ScopedEncryptedCrdtMessage) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("stale-epoch"));
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });
    openCrdtNote(current, vi.fn());
    await finishCrdtSync(
      current.id,
      current.keyEpoch,
      false,
      current.rootSectionId ?? "root"
    );

    const section = getCrdtProvider(
      current.id,
      current.keyEpoch,
      current.rootSectionId ?? "root"
    ).doc;
    setFragmentBody(section, "Visible rejected work");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "update",
        sectionId: current.rootSectionId,
        type: "crdt-update"
      })
    );
    expect(fragmentText(section)).toBe("Visible rejected work");
  });

  it("merges concurrent BlockNote edits through the encrypted transport", async () => {
    const sent: ScopedEncryptedCrdtMessage[] = [];
    setCrdtTransport({
      discard: vi.fn(),
      send: (message: ScopedEncryptedCrdtMessage) => {
        sent.push(message);
        return Promise.resolve();
      },
      subscribe: vi.fn()
    });
    const plaintext = new Map<string, Uint8Array>();
    vi.mocked(encryptCrdtMessage).mockImplementation((input) => {
      plaintext.set(input.updateId, input.update);
      return Promise.resolve({ cipher: "cipher", nonce: "nonce", formatVersion: 1 });
    });
    vi.mocked(decryptCrdtMessage).mockImplementation((message) => {
      const update = plaintext.get(message.updateId);
      if (!update) {
        throw new Error("unknown update");
      }
      return Promise.resolve(update);
    });

    const aliceId = "00000000-0000-4000-8000-0000000000a1";
    const bobId = "00000000-0000-4000-8000-0000000000b1";
    openCrdtNote(note({ id: aliceId }), vi.fn());
    await finishCrdtSync(aliceId, 1, false);
    setFragmentBody(getCrdtProvider(aliceId).doc, "shared");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Seed bob from alice's already-broadcast state so they share one fragment node.
    const aliceMessages = sent.filter((message) => message.noteId === aliceId);
    openCrdtNote(note({ id: bobId }), vi.fn());
    for (const message of aliceMessages) {
      await receiveCrdtUpdate({ ...message, noteId: bobId });
    }
    await finishCrdtSync(bobId, 1, false);
    expect(fragmentText(getCrdtProvider(bobId).doc)).toBe("shared");

    // Concurrent edits on the shared node merge deterministically via the transport.
    appendFragment(getCrdtProvider(aliceId).doc, "A");
    appendFragment(getCrdtProvider(bobId).doc, "B");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const aliceEdits = sent.filter(
      (message) => message.noteId === aliceId && message.type === "crdt-update"
    );
    const bobEdits = sent.filter(
      (message) => message.noteId === bobId && message.type === "crdt-update"
    );
    for (const message of aliceEdits) {
      await receiveCrdtUpdate({ ...message, noteId: bobId });
    }
    for (const message of bobEdits) {
      await receiveCrdtUpdate({ ...message, noteId: aliceId });
    }

    expect(fragmentText(getCrdtProvider(aliceId).doc)).toBe(
      fragmentText(getCrdtProvider(bobId).doc)
    );
  });
});
