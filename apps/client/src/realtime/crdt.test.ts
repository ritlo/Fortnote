import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EncryptedCrdtMessage } from "@fortnote/shared";
import { decryptCrdtMessage, encryptCrdtMessage } from "../cryptoClient";
import type { DecryptedNote } from "../store/appStore";
import * as contentTransfer from "./contentTransfer";
import {
  checkpointCrdtNote,
  clearCrdtNotes,
  editCrdtNote,
  ensureCrdtHistoryReadable,
  finishCrdtSync,
  getCrdtProvider,
  openCrdtNote,
  preserveCrdtContent,
  receiveCrdtUpdate,
  requiresContentTransfer,
  setCrdtTransport,
  updateCrdtNote,
  type ScopedEncryptedCrdtMessage
} from "./crdt";

vi.mock("../cryptoClient", () => ({
  CONTENT_CHUNK_AUTH_BYTES: 16,
  decryptCrdtMessage: vi.fn(),
  encryptContentChunksV2: vi.fn(),
  encryptCrdtMessage: vi.fn().mockResolvedValue({ cipher: "cipher", nonce: "nonce" })
}));

vi.mock("./contentTransfer", () => ({
  downloadVerifiedContent: vi.fn()
}));

const FRAGMENT_KEY = "document-store";

// ponytail: body now lives in the collaborative Y.XmlFragment; simulate BlockNote content.
function setFragmentBody(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  doc.transact(() => {
    fragment.delete(0, fragment.length);
    const xmlText = new Y.XmlText();
    xmlText.insert(0, text);
    fragment.insert(0, [xmlText]);
  });
}

function fragmentText(doc: Y.Doc): string {
  return doc.getXmlFragment(FRAGMENT_KEY).toJSON();
}

function appendFragment(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  const first = fragment.get(0);
  if (first instanceof Y.XmlText) {
    first.insert(first.length, text);
  } else {
    setFragmentBody(doc, text);
  }
}

function createDocument(title: string, body: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("title").insert(0, title);
  setFragmentBody(doc, body);
  return doc;
}

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

  it("applies manifest-backed updates only after verified download completes", async () => {
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
    await finishCrdtSync(current.id, current.keyEpoch, false, sectionId);
    const provider = getCrdtProvider(current.id, current.keyEpoch, sectionId);
    const remote = new Y.Doc();
    setFragmentBody(remote, "Verified remote content");
    let finishDownload!: (bytes: Uint8Array) => void;
    vi.mocked(contentTransfer.downloadVerifiedContent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDownload = resolve;
        })
    );

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

    await expect(ensureCrdtHistoryReadable(current.id, sectionId)).resolves.toBeUndefined();
    expect(fragmentText(getCrdtProvider(current.id, current.keyEpoch, sectionId).doc))
      .toContain("Recovered checkpoint");
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
    expect(fragmentText(section)).toContain("Body");
    expect(new Set(send.mock.calls.map(([message]) => message.sectionId))).toEqual(
      new Set(["root", current.rootSectionId])
    );
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
      () => new Promise((resolve) => {
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
      body: "[]",
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

  it("checkpoints an editor's open document after a key epoch advances", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const discard = vi.fn();
    setCrdtTransport({ discard, send, subscribe: vi.fn() });
    openCrdtNote(note(), vi.fn());
    await finishCrdtSync(note().id, 1, false);
    expect(send).toHaveBeenCalledOnce();
    send.mockClear();
    setFragmentBody(getCrdtProvider(note().id).doc, "Live body before rotation");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    send.mockClear();

    openCrdtNote(note({ keyEpoch: 2, noteKeyBase64: "rotated-key", role: "editor" }), vi.fn());
    expect(fragmentText(getCrdtProvider(note().id, 2).doc)).toBe("Live body before rotation");

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ compactedUpdateIds: [], keyEpoch: 2, type: "crdt-checkpoint" })
    );
    expect(discard).toHaveBeenCalledWith(note().id, 2);
  });

  it("checkpoints snapshot state after a closed document rotates", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const discard = vi.fn();
    setCrdtTransport({ discard, send, subscribe: vi.fn() });
    const rotated = note({
      body: blockNoteBody("Rotated body"),
      keyEpoch: 2,
      noteKeyBase64: "rotated-key"
    });

    await checkpointCrdtNote(rotated);

    const encryptionInput = vi.mocked(encryptCrdtMessage).mock.calls[0]![0];
    const restored = new Y.Doc();
    Y.applyUpdate(restored, encryptionInput.update);
    expect(restored.getText("title").toJSON()).toBe(rotated.title);
    expect(restored.getXmlFragment(FRAGMENT_KEY).toJSON()).toContain("Rotated body");
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

  it("persists the whole-note title and BlockNote body as the first CRDT checkpoint", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setCrdtTransport({ discard: vi.fn(), send, subscribe: vi.fn() });

    openCrdtNote(note(), vi.fn());
    await finishCrdtSync(note().id, 1, false);

    expect(send).toHaveBeenCalledOnce();
    const encryptionInput = vi.mocked(encryptCrdtMessage).mock.calls[0]![0];
    const restored = new Y.Doc();
    Y.applyUpdate(restored, encryptionInput.update);
    expect(restored.getText("title").toJSON()).toBe("Title");
    expect(restored.getXmlFragment(FRAGMENT_KEY).toJSON()).toContain("Body");
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
    editCrdtNote(current.id, { title: "Live CRDT title" });
    updateCrdtNote({ ...current, body: blockNoteBody("Live CRDT body") });

    expect(
      preserveCrdtContent(note({
        body: blockNoteBody("Stale snapshot body"),
        title: "Stale snapshot",
        updatedAt: "2026-07-14T00:00:00.000Z",
        version: 2
      }))
    ).toMatchObject({
      body: blockNoteBody("Live CRDT body"),
      title: "Live CRDT title",
      updatedAt: "2026-07-14T00:00:00.000Z",
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

  it("checkpoints successful whole-note snapshot versions", async () => {
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
    expect(restored.getXmlFragment(FRAGMENT_KEY).toJSON()).toContain("Body");
  });

  it("migrates a newer legacy snapshot on a fresh CRDT open", async () => {
    const current = note({ body: "Newer snapshot", version: 2 });
    const older = createDocument(current.title, "Older CRDT body");
    setCrdtTransport({ discard: vi.fn(), send: vi.fn(), subscribe: vi.fn() });
    vi.mocked(decryptCrdtMessage).mockResolvedValueOnce(Y.encodeStateAsUpdate(older));

    openCrdtNote(current, vi.fn());
    await receiveCrdtUpdate(encryptedUpdate(current));
    await finishCrdtSync(current.id, current.keyEpoch, true);

    // ponytail: body durable state is the store snapshot; the live fragment is re-seeded by the editor.
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

    expect(fragmentText(getCrdtProvider(current.id).doc)).toBe("Newer CRDT body");
  });

  it("keeps section-backed history authoritative over root metadata versions", async () => {
    const current = note({
      body: "",
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

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    body: blockNoteBody("Body"),
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

function blockNoteBody(text: string): string {
  return JSON.stringify([
    {
      id: "block-1",
      type: "paragraph",
      props: {
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left"
      },
      content: [{ type: "text", text, styles: {} }],
      children: []
    }
  ]);
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
