// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockNoteFragmentSnapshot } from "../lib/blockNote";
import type { DecryptedNote } from "../store/appStore";
import { useAppStore } from "../store/appStore";

const mocks = vi.hoisted(() => ({
  applySection: vi.fn(),
  buildNextBatch: vi.fn(),
  closeDatabase: vi.fn(),
  coverage: vi.fn(),
  createProtectedSearchIndex: vi.fn(),
  listNoteSections: vi.fn(),
  openCrdtSection: vi.fn(),
  openFortnoteIndexedDb: vi.fn(),
  query: vi.fn(),
  releaseCrdtSection: vi.fn(),
  snapshotReadyCrdtSection: vi.fn(),
  subscribeCrdtSectionChanges: vi.fn(),
  waitForCrdtSectionReady: vi.fn()
}));

vi.mock("../api", () => ({ listNoteSections: mocks.listNoteSections }));
vi.mock("../lib/indexedDb", () => ({
  openFortnoteIndexedDb: mocks.openFortnoteIndexedDb
}));
vi.mock("../lib/searchIndex", () => ({
  createProtectedSearchIndex: mocks.createProtectedSearchIndex
}));
vi.mock("../realtime/crdt", () => ({
  openCrdtSection: mocks.openCrdtSection,
  releaseCrdtSection: mocks.releaseCrdtSection,
  snapshotReadyCrdtSection: mocks.snapshotReadyCrdtSection,
  subscribeCrdtSectionChanges: mocks.subscribeCrdtSectionChanges,
  waitForCrdtSectionReady: mocks.waitForCrdtSectionReady
}));

import {
  notesForView,
  searchBlocksFromSnapshot,
  useNoteViewModel
} from "./useNoteViewModel";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openFortnoteIndexedDb.mockResolvedValue({ close: mocks.closeDatabase });
  mocks.createProtectedSearchIndex.mockReturnValue({
    applySection: mocks.applySection,
    buildNextBatch: mocks.buildNextBatch,
    coverage: mocks.coverage,
    query: mocks.query
  });
  mocks.openCrdtSection.mockReturnValue({ generation: 7, provider: {} });
  mocks.waitForCrdtSectionReady.mockResolvedValue(undefined);
  mocks.releaseCrdtSection.mockResolvedValue(true);
  mocks.snapshotReadyCrdtSection.mockReturnValue(sectionSnapshot());
  mocks.subscribeCrdtSectionChanges.mockReturnValue(vi.fn());
});

afterEach(() => {
  cleanup();
  useAppStore.getState().resetVaultState("reset");
});

describe("notesForView", () => {
  it("shows only shared notes in the shared view", () => {
    const ownerNote = note({ id: "owner_note", role: "owner" });
    const editorNote = note({ id: "editor_note", role: "editor" });
    const viewerNote = note({ id: "viewer_note", role: "viewer" });

    expect(
      notesForView({
        notes: [ownerNote, editorNote, viewerNote],
        notesView: "shared",
        selectedFolderId: "folder_1",
        trashNotes: []
      })
    ).toEqual([editorNote, viewerNote]);
  });

  it("keeps folder filtering scoped to the notes view", () => {
    const matchingNote = note({ id: "matching_note", folderId: "folder_1" });
    const otherNote = note({ id: "other_note", folderId: "folder_2" });

    expect(
      notesForView({
        notes: [matchingNote, otherNote],
        notesView: "notes",
        selectedFolderId: "folder_1",
        trashNotes: []
      })
    ).toEqual([matchingNote]);
  });

  it("uses trash notes only in the trash view", () => {
    const activeNote = note({ id: "active_note" });
    const deletedNote = note({ id: "deleted_note", isDeleted: true });

    expect(
      notesForView({
        notes: [activeNote],
        notesView: "trash",
        selectedFolderId: null,
        trashNotes: [deletedNote]
      })
    ).toEqual([deletedNote]);
  });
});

describe("protected note search", () => {
  it("builds bounded coverage without an editor and navigates to a matching section", async () => {
    const target = {
      keyEpoch: 1,
      noteId: "note_1",
      sectionId: "section-a",
      serverSequence: 3
    };
    mocks.listNoteSections.mockResolvedValue({
      sections: [{
        id: "section-a",
        initialized: true,
        isDeleted: false,
        currentSequence: 3
      }]
    });
    mocks.coverage.mockResolvedValue({
      complete: false,
      indexedSections: 0,
      totalSections: 1,
      pending: [{
        ...target,
        indexedSequence: 0,
        targetSequence: 3
      }]
    });
    mocks.buildNextBatch.mockImplementation(async (targets, loadSection) => {
      await loadSection(targets[0]);
      return {
        complete: true,
        indexedSections: 1,
        totalSections: 1,
        pending: []
      };
    });
    const match = {
      noteId: "note_1",
      sectionId: "section-a",
      blockId: "block-a",
      indexedSequence: 3,
      excerpt: "Needle body"
    };
    mocks.query.mockResolvedValue({
      coverage: { complete: true, indexedSections: 1, totalSections: 1, pending: [] },
      matches: [match]
    });
    useAppStore.setState({
      notes: [note({ rootSectionId: "section-a" })],
      notesView: "notes",
      rootKey: new Uint8Array(32),
      search: "needle",
      user: { id: "alice", username: "alice" }
    });

    const { result } = renderHook(() => useNoteViewModel());

    await waitFor(() => {
      expect(result.current.searchIndexStatus).toBe("ready");
      expect(result.current.searchMatches).toEqual([match]);
    });
    expect(mocks.buildNextBatch).toHaveBeenCalledOnce();
    expect(mocks.openCrdtSection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note_1" }),
      "section-a"
    );
    expect(mocks.releaseCrdtSection).toHaveBeenCalledWith(
      "note_1",
      "section-a",
      1,
      7
    );
    expect(mocks.query).toHaveBeenCalledWith("needle", [target]);
    expect(result.current.filteredNotes.map((candidate) => candidate.id)).toEqual(["note_1"]);

    const sectionChange = mocks.subscribeCrdtSectionChanges.mock.calls[0]![0];
    act(() => {
      sectionChange({
        keyEpoch: 1,
        noteId: "note_1",
        sectionId: "section-a",
        serverSequence: 4
      });
    });
    await waitFor(() => {
      expect(mocks.applySection).toHaveBeenCalledWith({
        blocks: [
          { blockId: "block-a", text: "Needle body" },
          { blockId: "block-b", text: "Nested text" }
        ],
        keyEpoch: 1,
        noteId: "note_1",
        sectionId: "section-a",
        serverSequence: 4
      });
    });

    act(() => {
      result.current.selectSearchMatch(match);
    });
    expect(useAppStore.getState().selectedNoteId).toBe("note_1");
    expect(useAppStore.getState().selectedSectionByNote.note_1).toBe("section-a");
  });

  it("extracts stable block IDs and text without duplicating nested blocks", () => {
    expect(searchBlocksFromSnapshot(sectionSnapshot())).toEqual([
      { blockId: "block-a", text: "Needle body" },
      { blockId: "block-b", text: "Nested text" }
    ]);
  });
});

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    contentLength: 0,
    cryptoOwnerId: "alice",
    folderId: null,
    id: "note_1",
    isDeleted: false,
    noteKeyBase64: "note-key",
    ownerUserId: "alice",
    role: "owner",
    title: "Title",
    updatedAt: "2026-07-02T00:00:00.000Z",
    version: 1,
    keyEpoch: 1,
    ...overrides
  };
}

function sectionSnapshot(): BlockNoteFragmentSnapshot {
  return {
    type: "doc" as const,
    content: [{
      type: "blockGroup" as const,
      content: [{
        type: "blockContainer",
        attrs: { id: "block-a" },
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Needle body" }] },
          {
            type: "blockGroup",
            content: [{
              type: "blockContainer",
              attrs: { id: "block-b" },
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: "Nested text" }]
              }]
            }]
          }
        ]
      }]
    }]
  };
}
