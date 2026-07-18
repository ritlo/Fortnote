import { describe, expect, it } from "vitest";
import type { DecryptedNote } from "../store/appStore";
import { notesForView } from "./useNoteViewModel";

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
