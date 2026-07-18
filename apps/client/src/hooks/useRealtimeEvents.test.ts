import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationEvent } from "../api";
import { useAppStore, type DecryptedNote } from "../store/appStore";
import {
  createCollaborationEventProcessor,
  eventsFromOtherClients,
  eventsRequireFolderReload,
  eventsRequireNoteReload,
  eventsRequireTrashReload,
  isOwnRevocation,
  mergeEventCursor,
  noteIdsRequiringReload,
  removeRevokedNotes,
  shouldReloadFolders,
  shouldReloadNotes
} from "./useRealtimeEvents";

describe("realtime event processing", () => {
  afterEach(() => {
    useAppStore.getState().resetVaultState("reset");
  });

  it("acknowledges only after applying and reloading events", async () => {
    const applyEvents = vi.fn();
    const acknowledgeEvents = vi.fn().mockResolvedValue(undefined);
    const reload = deferred<undefined>();
    const reloadEvents = vi.fn().mockReturnValue(reload.promise);
    const events = [
      event({ cursor: 4, eventId: "event_4" }),
      event({ cursor: 9, eventId: "event_9" })
    ];
    const processEvents = createCollaborationEventProcessor({
      acknowledgeEvents,
      applyEvents,
      reloadEvents,
      scheduleRetry: vi.fn()
    });

    processEvents(events);
    await flushPromises();

    expect(applyEvents).toHaveBeenCalledWith(events);
    expect(reloadEvents).toHaveBeenCalledWith(events);
    expect(acknowledgeEvents).not.toHaveBeenCalled();

    reload.resolve(undefined);
    await flushPromises();

    expect(acknowledgeEvents).toHaveBeenCalledWith(9);
  });

  it("retries failed reloads before acknowledgement", async () => {
    const retryCallbacks: (() => void)[] = [];
    const applyEvents = vi.fn();
    const acknowledgeEvents = vi.fn().mockResolvedValue(undefined);
    const reloadEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error("network offline"))
      .mockResolvedValueOnce(undefined);
    const processEvents = createCollaborationEventProcessor({
      acknowledgeEvents,
      applyEvents,
      reloadEvents,
      scheduleRetry: (retry) => {
        retryCallbacks.push(retry);
      }
    });

    processEvents([event({ cursor: 7 })]);
    await flushPromises();

    expect(applyEvents).toHaveBeenCalledTimes(1);
    expect(reloadEvents).toHaveBeenCalledTimes(1);
    expect(acknowledgeEvents).not.toHaveBeenCalled();
    expect(retryCallbacks).toHaveLength(1);

    const retry = retryCallbacks[0];
    if (!retry) {
      throw new Error("Expected acknowledgement retry callback");
    }
    retry();
    await flushPromises();

    expect(applyEvents).toHaveBeenCalledTimes(1);
    expect(reloadEvents).toHaveBeenCalledTimes(2);
    expect(acknowledgeEvents).toHaveBeenCalledWith(7);
  });

  it("retries acknowledgement without repeating a successful reload", async () => {
    const retryCallbacks: (() => void)[] = [];
    const acknowledgeEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error("network offline"))
      .mockResolvedValue(undefined);
    const reloadEvents = vi.fn().mockResolvedValue(undefined);
    const processEvents = createCollaborationEventProcessor({
      acknowledgeEvents,
      applyEvents: vi.fn(),
      reloadEvents,
      scheduleRetry: (retry) => {
        retryCallbacks.push(retry);
      }
    });

    processEvents([event({ cursor: 9 })]);
    await flushPromises();

    expect(retryCallbacks).toHaveLength(1);
    expect(reloadEvents).toHaveBeenCalledTimes(1);
    expect(acknowledgeEvents).toHaveBeenCalledTimes(1);

    const retry = retryCallbacks[0];
    if (!retry) {
      throw new Error("Expected acknowledgement retry callback");
    }
    retry();
    await flushPromises();

    expect(acknowledgeEvents).toHaveBeenCalledTimes(2);
    expect(reloadEvents).toHaveBeenCalledTimes(1);
  });

  it("serializes event reloads so older snapshots cannot finish last", async () => {
    const firstReload = deferred<undefined>();
    const reloadEvents = vi
      .fn()
      .mockReturnValueOnce(firstReload.promise)
      .mockResolvedValueOnce(undefined);
    const acknowledgeEvents = vi.fn().mockResolvedValue(undefined);
    const processEvents = createCollaborationEventProcessor({
      acknowledgeEvents,
      applyEvents: vi.fn(),
      reloadEvents,
      scheduleRetry: vi.fn()
    });

    processEvents([event({ cursor: 4, eventId: "event_4" })]);
    processEvents([event({ cursor: 9, eventId: "event_9" })]);
    await flushPromises();

    expect(reloadEvents).toHaveBeenCalledTimes(1);
    expect(acknowledgeEvents).not.toHaveBeenCalled();

    firstReload.resolve(undefined);
    await flushPromises();

    expect(reloadEvents).toHaveBeenCalledTimes(2);
    expect(acknowledgeEvents).toHaveBeenNthCalledWith(1, 4);
    expect(acknowledgeEvents).toHaveBeenNthCalledWith(2, 9);
  });

  it("ignores empty event batches", async () => {
    const applyEvents = vi.fn();
    const acknowledgeEvents = vi.fn().mockResolvedValue(undefined);
    const reloadEvents = vi.fn().mockResolvedValue(undefined);
    const processEvents = createCollaborationEventProcessor({
      acknowledgeEvents,
      applyEvents,
      reloadEvents,
      scheduleRetry: vi.fn()
    });

    processEvents([]);
    await flushPromises();

    expect(applyEvents).not.toHaveBeenCalled();
    expect(reloadEvents).not.toHaveBeenCalled();
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
    expect(shouldReloadNotes(event({ resourceType: "attachment" }))).toBe(false);
    expect(shouldReloadNotes(event({ resourceType: "folder" }))).toBe(false);
    expect(shouldReloadNotes(event({ resourceType: "section" }))).toBe(true);
    expect(shouldReloadFolders(event({ resourceType: "folder" }))).toBe(true);
    expect(shouldReloadFolders(event({ resourceType: "note" }))).toBe(false);
    expect(shouldReloadNotes(event({ resourceType: "presence" }))).toBe(false);
  });

  it("reloads same-account events from another tab", () => {
    const ownEvent = event({
      actorUserId: "user_bob",
      metadata: { clientInstanceId: "this-client" }
    });
    const otherTabEvent = event({
      actorUserId: "user_bob",
      metadata: { clientInstanceId: "other-client" }
    });

    expect(eventsFromOtherClients([ownEvent, otherTabEvent], "this-client")).toEqual([
      otherTabEvent
    ]);
    expect(eventsRequireNoteReload([otherTabEvent])).toBe(true);
    expect(eventsRequireNoteReload([event({ resourceType: "presence" })])).toBe(false);
    expect(eventsRequireFolderReload([event({ resourceType: "folder" })])).toBe(true);
    expect(eventsRequireFolderReload([event({ resourceType: "note" })])).toBe(false);
    expect(eventsRequireTrashReload([event({ type: "note.deleted" })])).toBe(true);
    expect(eventsRequireTrashReload([event({ type: "note.restored" })])).toBe(true);
    expect(
      eventsRequireTrashReload([event({ type: "note.permanently_deleted" })])
    ).toBe(true);
    expect(eventsRequireTrashReload([event({ type: "note.updated" })])).toBe(false);
    expect(noteIdsRequiringReload([
      otherTabEvent,
      event({ noteId: "note_2", resourceType: "membership" }),
      event({ noteId: "note_2", resourceType: "membership" }),
      event({ noteId: "section_note", resourceType: "section" }),
      event({ noteId: "attachment_note", resourceType: "attachment" }),
      event({
        noteId: "revoked_note",
        resourceType: "membership",
        type: "membership.revoked",
        metadata: { membershipUserId: "user_bob" }
      }),
      event({ noteId: "deleted_note", type: "note.permanently_deleted" })
    ], "user_bob")).toEqual(["note_1", "note_2", "section_note"]);
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
    version: 1,
    keyEpoch: 1
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
