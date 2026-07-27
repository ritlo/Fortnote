import { beforeEach, describe, expect, it } from "vitest";
import type { CollaborationEvent } from "../api";
import type { DecryptedNote } from "./appStore";
import { operationFailureState, useAppStore } from "./appStore";

describe("collaboration event store", () => {
  beforeEach(() => {
    useAppStore.getState().resetVaultState("test reset");
  });

  it("returns to the login screen after a vault reset", () => {
    useAppStore.getState().setAuthMode("recover");

    useAppStore.getState().resetVaultState("Signed out");

    expect(useAppStore.getState().authMode).toBe("login");
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

  it("clears undecryptable protection when note access is removed", () => {
    useAppStore.getState().setNoteProtectionFailure("revoked_note", "undecryptable");
    useAppStore.getState().setNotes([note({ id: "revoked_note", role: "editor" })]);

    useAppStore.getState().removeNoteAccess("revoked_note");

    expect(useAppStore.getState().noteProtectionFailures).toEqual({});
  });

  it("clears undecryptable protection on vault reset", () => {
    useAppStore.getState().setNoteProtectionFailure("note_1", "undecryptable");

    useAppStore.getState().resetVaultState("locked");

    expect(useAppStore.getState().noteProtectionFailures).toEqual({});
  });

  it("retains the removed note notice until another note is selected", () => {
    useAppStore.getState().setNotes([note({ id: "revoked_note", role: "viewer" })]);
    useAppStore.getState().setSelectedNoteId("revoked_note");

    useAppStore.getState().removeNoteAccess("revoked_note");

    expect(useAppStore.getState().removedNoteId).toBe("revoked_note");
    useAppStore.getState().setSelectedNoteId("another_note");
    expect(useAppStore.getState().removedNoteId).toBeNull();
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

  it("retains encrypted-draft references until an explicit recovery transition", () => {
    const draft = {
      userId: "user_1",
      noteId: "note_1",
      sectionId: "section_1",
      keyEpoch: 2,
      reason: "stale-epoch" as const,
      updateIds: ["update_1"],
      createdAt: 10,
      retainedAt: 20
    };

    useAppStore.getState().retainRecoverableDraft(draft);
    useAppStore.getState().retainRecoverableDraft({
      ...draft,
      updateIds: ["update_1", "update_2"],
      retainedAt: 30
    });
    const retained = Object.values(useAppStore.getState().recoverableDrafts)[0]!;

    expect(retained).toMatchObject({
      state: "retained",
      updateIds: ["update_1", "update_2"],
      retainedAt: 30
    });
    useAppStore.getState().setRecoverableDraftState(retained.id, "discarded");
    expect(useAppStore.getState().recoverableDrafts[retained.id]?.state).toBe("retained");
    useAppStore.getState().setRecoverableDraftState(retained.id, "reviewing");
    useAppStore.getState().setRecoverableDraftState(retained.id, "exported");
    expect(useAppStore.getState().recoverableDrafts[retained.id]?.state).toBe("exported");

    useAppStore.getState().resetVaultState("locked");
    expect(useAppStore.getState().recoverableDrafts).toEqual({});
  });

  it("maps recognized failures without exposing their details", () => {
    expect(operationFailureState(
      { code: "version_conflict", message: "private server detail", status: 409 },
      "fallback"
    )).toEqual({
      kind: "conflict",
      message: "Encrypted changes were retained because the server version changed.",
      status: "Changes need review"
    });
    expect(operationFailureState(
      { code: "forbidden", message: "private server detail", status: 409 },
      "fallback"
    )).toMatchObject({
      kind: "conflict",
      status: "Changes need review"
    });
    expect(operationFailureState(
      { code: "quota_exceeded", message: "private server detail", status: 413 },
      "fallback"
    )).toEqual({
      kind: "server-capacity",
      message: "Encrypted changes remain on this device until server storage is available.",
      status: "Server storage full — changes kept on this device"
    });
    expect(operationFailureState(
      { message: "private browser detail", name: "QuotaExceededError" },
      "fallback"
    )).toMatchObject({
      kind: "local-capacity",
      status: "Local storage full — changes need attention"
    });
    expect(operationFailureState(
      { code: "storage_limit", message: "private server detail", status: 507 },
      "fallback"
    )).toMatchObject({
      kind: "server-capacity",
      status: "Server storage full — changes kept on this device"
    });
    expect(operationFailureState(
      { code: "storage-limit" },
      "fallback"
    )).toMatchObject({
      kind: "server-capacity",
      status: "Server storage full — changes kept on this device"
    });
    expect(operationFailureState(undefined, "safe fallback")).toEqual({
      kind: "generic",
      message: "safe fallback",
      status: "Operation failed"
    });
  });

  it("rejects completions from superseded request tokens", () => {
    const first = useAppStore.getState().beginRequest("search");
    const second = useAppStore.getState().beginRequest("search");

    expect(useAppStore.getState().isCurrentRequest("search", first)).toBe(false);
    expect(useAppStore.getState().isCurrentRequest("search", second)).toBe(true);
    useAppStore.getState().finishRequest("search", first);
    expect(useAppStore.getState().isCurrentRequest("search", second)).toBe(true);
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
