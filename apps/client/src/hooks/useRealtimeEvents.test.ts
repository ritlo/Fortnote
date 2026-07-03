import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationEvent } from "../api";
import { useAppStore, type DecryptedNote } from "../store/appStore";
import {
  eventsRequireNoteReload,
  isOwnRevocation,
  mergeEventCursor,
  processCollaborationEvents,
  removeRevokedNotes,
  shouldReloadNotes
} from "./useRealtimeEvents";

describe("realtime event processing", () => {
  afterEach(() => {
    useAppStore.getState().resetVaultState("reset");
  });

  it("records events and acknowledges the highest cursor", () => {
    const addCollaborationEvents = vi.fn();
    const acknowledgeEvents = vi.fn().mockResolvedValue(undefined);
    const removeRevoked = vi.fn();
    const events = [
      event({ cursor: 4, eventId: "event_4" }),
      event({ cursor: 9, eventId: "event_9" })
    ];

    processCollaborationEvents(events, addCollaborationEvents, {
      acknowledgeEvents,
      removeRevoked
    });

    expect(addCollaborationEvents).toHaveBeenCalledWith(events);
    expect(removeRevoked).toHaveBeenCalledWith(events);
    expect(acknowledgeEvents).toHaveBeenCalledWith(9);
  });

  it("ignores empty event batches", () => {
    const addCollaborationEvents = vi.fn();
    const acknowledgeEvents = vi.fn().mockResolvedValue(undefined);
    const removeRevoked = vi.fn();

    processCollaborationEvents([], addCollaborationEvents, {
      acknowledgeEvents,
      removeRevoked
    });

    expect(addCollaborationEvents).not.toHaveBeenCalled();
    expect(removeRevoked).not.toHaveBeenCalled();
    expect(acknowledgeEvents).not.toHaveBeenCalled();
  });

  it("removes notes for the signed-in user's revoke tombstones", () => {
    useAppStore.setState({
      user: { id: "user_bob", username: "bob" },
      notes: [note("note_keep"), note("note_revoke")],
      trashNotes: [note("trash_revoke")],
      selectedNoteId: "note_revoke",
      attachmentsByNote: {
        note_revoke: [],
        note_keep: []
      },
      presenceByNote: {
        note_revoke: [],
        note_keep: []
      }
    });

    removeRevokedNotes([
      event({
        noteId: "note_revoke",
        type: "membership.revoked",
        metadata: { membershipUserId: "user_bob" }
      }),
      event({
        noteId: "trash_revoke",
        type: "membership.revoked",
        metadata: { membershipUserId: "user_alice" }
      })
    ]);

    expect(useAppStore.getState().notes.map((storedNote) => storedNote.id)).toEqual([
      "note_keep"
    ]);
    expect(useAppStore.getState().trashNotes.map((storedNote) => storedNote.id)).toEqual([
      "trash_revoke"
    ]);
    expect(useAppStore.getState().selectedNoteId).toBe("note_keep");
    expect(useAppStore.getState().attachmentsByNote).toEqual({ note_keep: [] });
    expect(useAppStore.getState().presenceByNote).toEqual({ note_keep: [] });
  });

  it("classifies own revokes and reloadable resources", () => {
    expect(
      isOwnRevocation(
        event({
          type: "membership.revoked",
          metadata: { membershipUserId: "user_bob" }
        }),
        "user_bob"
      )
    ).toBe(true);
    expect(
      isOwnRevocation(
        event({
          type: "membership.revoked",
          metadata: { membershipUserId: "user_alice" }
        }),
        "user_bob"
      )
    ).toBe(false);
    expect(shouldReloadNotes(event({ resourceType: "attachment" }))).toBe(true);
    expect(shouldReloadNotes(event({ resourceType: "presence" }))).toBe(false);
  });

  it("skips own events when deciding whether to reload notes", () => {
    expect(
      eventsRequireNoteReload([event({ actorUserId: "user_bob" })], "user_bob", {
        skipOwnEvents: true
      })
    ).toBe(false);
    expect(
      eventsRequireNoteReload([event({ actorUserId: "user_alice" })], "user_bob", {
        skipOwnEvents: true
      })
    ).toBe(true);
    expect(eventsRequireNoteReload([event({ resourceType: "presence" })], "user_bob")).toBe(
      false
    );
  });

  it("does not regress the bootstrapped cursor", () => {
    expect(mergeEventCursor(10, 4)).toBe(10);
    expect(mergeEventCursor(4, 10)).toBe(10);
  });
});

function event(overrides: Partial<CollaborationEvent> = {}): CollaborationEvent {
  return {
    actorUserId: "user_alice",
    createdAt: "2026-07-03T00:00:00.000Z",
    cursor: 1,
    eventId: "event_1",
    metadata: null,
    noteId: "note_1",
    resourceId: "note_1",
    resourceType: "note",
    type: "note.updated",
    version: 2,
    ...overrides
  };
}

function note(id: string): DecryptedNote {
  return {
    body: "",
    contentLength: 0,
    cryptoOwnerId: "user_alice",
    folderId: null,
    id,
    isDeleted: false,
    noteKeyBase64: "note-key",
    ownerUserId: "user_alice",
    role: "owner",
    title: id,
    updatedAt: "2026-07-03T00:00:00.000Z",
    version: 1
  };
}
