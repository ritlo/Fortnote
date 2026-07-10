import { beforeEach, describe, expect, it } from "vitest";
import type { CollaborationEvent } from "../api";
import type { DecryptedNote } from "./appStore";
import { useAppStore } from "./appStore";

describe("collaboration event store", () => {
  beforeEach(() => {
    useAppStore.getState().resetVaultState("test reset");
  });

  it("deduplicates replayed events while keeping the latest cursor", () => {
    const first = collaborationEvent({ cursor: 3, eventId: "event_3" });
    const duplicate = collaborationEvent({ cursor: 3, eventId: "event_3" });
    const next = collaborationEvent({ cursor: 4, eventId: "event_4" });

    useAppStore.getState().addCollaborationEvents([first]);
    useAppStore.getState().addCollaborationEvents([duplicate, next]);

    expect(useAppStore.getState().collaborationEvents).toEqual([first, next]);
    expect(useAppStore.getState().eventCursor).toBe(4);
  });

  it("does not regress the event cursor for older events", () => {
    useAppStore
      .getState()
      .addCollaborationEvents([collaborationEvent({ cursor: 10, eventId: "event_10" })]);
    useAppStore
      .getState()
      .addCollaborationEvents([collaborationEvent({ cursor: 5, eventId: "event_5" })]);

    expect(useAppStore.getState().eventCursor).toBe(10);
    expect(useAppStore.getState().collaborationEvents.map((event) => event.eventId)).toEqual([
      "event_10",
      "event_5"
    ]);
  });

  it("keeps selection inside shared notes after access is revoked in the shared view", () => {
    useAppStore.getState().setNotes([
      note({ id: "owner_note", role: "owner" }),
      note({ id: "revoked_note", role: "editor" }),
      note({ id: "next_shared_note", role: "viewer" })
    ]);
    useAppStore.getState().setNotesView("shared");
    useAppStore.getState().setSelectedNoteId("revoked_note");

    useAppStore.getState().removeNoteAccess("revoked_note");

    expect(useAppStore.getState().selectedNoteId).toBe("next_shared_note");
  });

  it("clears revocation rotation failure when note access is removed", () => {
    useAppStore.getState().setRevocationRotationFailure("revoked_note", {
      failedAt: "2026-07-02T10:00:00.000Z",
      message: "network failed",
      noteId: "revoked_note",
      revokedUserId: "bob",
      revokedUsername: "bob"
    });
    useAppStore.getState().setNotes([note({ id: "revoked_note", role: "editor" })]);

    useAppStore.getState().removeNoteAccess("revoked_note");

    expect(useAppStore.getState().revocationRotationFailures).toEqual({});
  });

  it("preserves revocation rotation failure when selection changes", () => {
    useAppStore.getState().setSelectedNoteId("note_1");
    useAppStore.getState().setRevocationRotationFailure("note_1", {
      failedAt: "2026-07-02T10:00:00.000Z",
      message: "network failed",
      noteId: "note_1",
      revokedUserId: "bob",
      revokedUsername: "bob"
    });

    useAppStore.getState().setSelectedNoteId("note_2");

    expect(useAppStore.getState().revocationRotationFailures.note_1).toMatchObject({
      message: "network failed",
      noteId: "note_1"
    });
  });

  it("clears revocation rotation failure on vault reset", () => {
    useAppStore.getState().setRevocationRotationFailure("note_1", {
      failedAt: "2026-07-02T10:00:00.000Z",
      message: "network failed",
      noteId: "note_1",
      revokedUserId: "bob",
      revokedUsername: "bob"
    });

    useAppStore.getState().resetVaultState("locked");

    expect(useAppStore.getState().revocationRotationFailures).toEqual({});
  });
});

function collaborationEvent(
  overrides: Partial<CollaborationEvent> = {}
): CollaborationEvent {
  return {
    actorUserId: "user_1",
    createdAt: "2026-07-02T10:00:00.000Z",
    cursor: 1,
    eventId: "event_1",
    metadata: null,
    noteId: "note_1",
    resourceId: "note_1",
    resourceType: "note",
    type: "note.updated",
    version: 1,
    ...overrides
  };
}

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
    ...overrides
  };
}
