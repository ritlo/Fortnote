// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedNote } from "../store/appStore";
import { useAppStore } from "../store/appStore";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  initialize: vi.fn(),
  manifest: vi.fn(),
  open: vi.fn(),
  release: vi.fn(),
  replaceContent: vi.fn(),
  replaceOrder: vi.fn(),
  snapshot: vi.fn(),
  split: vi.fn(),
  waitDurable: vi.fn(),
  waitReady: vi.fn()
}));

vi.mock("../api", () => ({
  createNoteSection: mocks.create,
  deleteNoteSection: mocks.delete,
  initializeNoteSection: mocks.initialize
}));

vi.mock("../realtime/crdt", () => ({
  appendCrdtSectionContent: mocks.append,
  createCrdtSectionInitializationManifest: mocks.manifest,
  openCrdtSection: mocks.open,
  releaseCrdtSection: mocks.release,
  replaceCrdtSectionContent: mocks.replaceContent,
  replaceCrdtSectionOrder: mocks.replaceOrder,
  snapshotCrdtSection: mocks.snapshot,
  splitCrdtSectionContent: mocks.split,
  waitForCrdtSectionDurable: mocks.waitDurable,
  waitForCrdtSectionReady: mocks.waitReady
}));

import { useSectionActions } from "./useSectionActions";

describe("useSectionActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockImplementation((_noteId: string, payload: { sectionId: string }) =>
      Promise.resolve({
        status: "created",
        rootVersion: 2,
        version: 2,
        section: section(payload.sectionId)
      })
    );
    mocks.delete.mockImplementation(
      (
        _noteId: string,
        _sectionId: string,
        payload: { expectedRootVersion: number }
      ) => Promise.resolve({
        status: "deleted",
        rootVersion: payload.expectedRootVersion + 1,
        version: payload.expectedRootVersion + 1
      })
    );
    mocks.initialize.mockResolvedValue({
      status: "installed",
      manifestId: "manifest-new",
      rootVersion: 1,
      version: 1
    });
    mocks.manifest.mockResolvedValue({ manifestId: "manifest-new", lastSequence: 3 });
    mocks.open.mockReturnValue({ provider: {}, generation: 1 });
    mocks.release.mockResolvedValue(true);
    mocks.replaceOrder.mockReturnValue(true);
    mocks.waitDurable.mockResolvedValue(undefined);
    mocks.waitReady.mockResolvedValue(undefined);
    installState();
  });

  afterEach(() => {
    useAppStore.getState().resetVaultState("test reset");
  });

  it("initializes a new section before publishing it in encrypted order", async () => {
    const { result } = renderHook(() => useSectionActions(note()));

    await act(async () => result.current.createSection());

    const createdId = mocks.create.mock.calls[0]?.[1].sectionId as string;
    expect(mocks.initialize).toHaveBeenCalledWith(
      "note-1",
      createdId,
      expect.objectContaining({
        manifestId: "manifest-new",
        expectedRootVersion: 2
      })
    );
    expect(mocks.replaceOrder).toHaveBeenCalledWith("note-1", [
      "section-1",
      createdId,
      "section-2"
    ]);
    expect(mocks.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replaceOrder.mock.invocationCallOrder[0]!
    );
    expect(useAppStore.getState().sectionIndexes["note-1"]).toMatchObject({
      orderedSectionIds: ["section-1", createdId, "section-2"]
    });
    expect(useAppStore.getState().selectedSectionByNote["note-1"]).toBe(createdId);
    expect(useAppStore.getState().notes[0]).toMatchObject({
      rootVersion: 2,
      version: 2
    });
  });

  it("cleans up a server section when initialization fails", async () => {
    mocks.initialize.mockRejectedValueOnce(new Error("initialization failed"));
    const { result } = renderHook(() => useSectionActions(note()));

    await act(async () => result.current.createSection());

    const createdId = mocks.create.mock.calls[0]?.[1].sectionId as string;
    expect(mocks.delete).toHaveBeenCalledWith(
      "note-1",
      createdId,
      { expectedKeyEpoch: 1, expectedRootVersion: 2 }
    );
    expect(mocks.replaceOrder).not.toHaveBeenCalled();
    expect(useAppStore.getState().status).toBe("Section operation failed");
  });

  it("cleans up an initialized section when encrypted order publication fails", async () => {
    mocks.replaceOrder.mockReturnValueOnce(false);
    const { result } = renderHook(() => useSectionActions(note()));

    await act(async () => result.current.createSection());

    const createdId = mocks.create.mock.calls[0]?.[1].sectionId as string;
    expect(mocks.delete).toHaveBeenCalledWith(
      "note-1",
      createdId,
      { expectedKeyEpoch: 1, expectedRootVersion: 2 }
    );
    expect(useAppStore.getState().sectionIndexes["note-1"]?.orderedSectionIds).toEqual([
      "section-1",
      "section-2"
    ]);
  });

  it("durably publishes reorder and tombstone operations", async () => {
    const { result } = renderHook(() => useSectionActions(note()));

    await act(async () => result.current.moveSection("section-1", 1));
    expect(mocks.replaceOrder).toHaveBeenLastCalledWith("note-1", [
      "section-2",
      "section-1"
    ]);

    await act(async () => result.current.deleteSection("section-2"));
    expect(mocks.delete).toHaveBeenCalledWith(
      "note-1",
      "section-2",
      { expectedKeyEpoch: 1, expectedRootVersion: 1 }
    );
    expect(mocks.delete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replaceOrder.mock.invocationCallOrder[1]!
    );
    expect(useAppStore.getState().notes[0]).toMatchObject({
      rootVersion: 2,
      version: 2
    });
  });

  it("publishes a split copy before trimming the source", async () => {
    const before = { type: "doc", content: [{ type: "before" }] } as const;
    const after = { type: "doc", content: [{ type: "after" }] } as const;
    mocks.split.mockReturnValue({ before, after });
    const { result } = renderHook(() => useSectionActions(note()));

    await act(async () => result.current.splitSection("section-1"));

    const createdId = mocks.create.mock.calls[0]?.[1].sectionId as string;
    expect(mocks.replaceContent).toHaveBeenNthCalledWith(1, "note-1", createdId, after);
    expect(mocks.replaceContent).toHaveBeenNthCalledWith(2, "note-1", "section-1", before);
    expect(mocks.replaceOrder.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replaceContent.mock.invocationCallOrder[1]!
    );
  });

  it("checkpoints merged content before tombstoning its source", async () => {
    const copied = { type: "doc", content: [{ type: "copied" }] } as const;
    mocks.snapshot.mockReturnValue(copied);
    const { result } = renderHook(() => useSectionActions(note()));

    await act(async () => result.current.mergeSectionWithNext("section-1"));

    expect(mocks.append).toHaveBeenCalledWith("note-1", "section-1", copied);
    expect(mocks.manifest.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.delete.mock.invocationCallOrder[0]!
    );
    expect(mocks.delete).toHaveBeenCalledWith(
      "note-1",
      "section-2",
      { expectedKeyEpoch: 1, expectedRootVersion: 1 }
    );
    expect(useAppStore.getState().sectionIndexes["note-1"]?.orderedSectionIds).toEqual([
      "section-1"
    ]);
  });

  it("checkpoints an explicit cross-section copy without deleting its source", async () => {
    const copied = { type: "doc", content: [{ type: "copied" }] } as const;
    mocks.snapshot.mockReturnValue(copied);
    const { result } = renderHook(() => useSectionActions(note()));

    await act(async () => result.current.copySectionToNext("section-1"));

    expect(mocks.append).toHaveBeenCalledWith("note-1", "section-2", copied);
    expect(mocks.manifest).toHaveBeenCalledWith("note-1", 1, "section-2");
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});

function installState(): void {
  const current = note();
  useAppStore.setState({
    user: { id: "owner-1", username: "alice" },
    rootKey: Uint8Array.of(1),
    notes: [current],
    selectedNoteId: current.id,
    selectedSectionByNote: { [current.id]: "section-1" },
    sectionIndexes: {
      [current.id]: {
        noteId: current.id,
        status: "ready",
        orderedSectionIds: ["section-1", "section-2"],
        sections: [section("section-1"), section("section-2")]
      }
    }
  });
}

function note(): DecryptedNote {
  return {
    id: "note-1",
    folderId: null,
    title: "Note",
    body: "",
    noteKeyBase64: "AQIDBA==",
    contentLength: 0,
    version: 1,
    rootVersion: 1,
    rootSectionId: "section-1",
    keyEpoch: 1,
    isDeleted: false,
    updatedAt: "2026-07-18T00:00:00.000Z",
    ownerUserId: "owner-1",
    cryptoOwnerId: "owner-1",
    role: "owner"
  };
}

function section(id: string) {
  return {
    id,
    noteId: "note-1",
    createdEpoch: 1,
    currentSequence: 0,
    initialized: true,
    isDeleted: false
  };
}
