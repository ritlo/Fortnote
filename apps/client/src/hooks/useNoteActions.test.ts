import { describe, expect, it } from "vitest";
import type { DecryptedNote } from "../store/appStore";
import { mergeDraftAfterConflict } from "./useNoteActions";

describe("note save conflict handling", () => {
  it("keeps the local draft while adopting latest server metadata", () => {
    const latestNote = note({
      body: "Server copy",
      folderId: "server-folder",
      role: "viewer",
      title: "Server title",
      updatedAt: "2026-07-02T10:00:00.000Z",
      version: 4
    });
    const localDraft = note({
      body: "Unsaved local draft",
      folderId: "local-folder",
      role: "editor",
      title: "Local title",
      updatedAt: "2026-07-02T09:00:00.000Z",
      version: 3
    });

    const merged = mergeDraftAfterConflict(latestNote, localDraft);

    expect(merged).toMatchObject({
      body: "Unsaved local draft",
      folderId: "local-folder",
      role: "viewer",
      title: "Local title",
      updatedAt: "2026-07-02T10:00:00.000Z",
      version: 4
    });
    expect(merged.contentLength).toBe(new TextEncoder().encode("Unsaved local draft").length);
  });
});

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    body: "",
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
