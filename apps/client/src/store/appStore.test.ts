import { beforeEach, describe, expect, it } from "vitest";
import type { CollaborationEvent } from "../api";
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
