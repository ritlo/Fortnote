// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RealtimeConnection,
  RealtimeMessage,
  RecoverableCrdtDraft
} from "../realtime/client";
import { useAppStore } from "../store/appStore";

interface ConnectionOptions {
  after: number;
  onClose?: () => void;
  onError?: () => void;
  onMessage: (message: RealtimeMessage) => void;
  onOpen?: () => void;
  onRecoverableCrdtDraft?: (draft: RecoverableCrdtDraft) => void;
}

interface MockConnection {
  connection: RealtimeConnection;
  options: ConnectionOptions;
}

const mocks = vi.hoisted(() => ({
  acknowledgeEvents: vi.fn(),
  connections: [] as MockConnection[],
  getCursor: vi.fn(),
  loadFolders: vi.fn(),
  loadNote: vi.fn()
}));

vi.mock("../api", () => ({
  acknowledgeCollaborationEvents: mocks.acknowledgeEvents,
  getClientInstanceId: () => "test-client",
  getCollaborationEventCursor: mocks.getCursor
}));

vi.mock("../realtime/client", () => ({
  connectRealtime: (options: ConnectionOptions) => {
    const connection: RealtimeConnection = {
      close: vi.fn(),
      discardCrdtUpdates: vi.fn(),
      sendPresence: vi.fn(),
      subscribeCrdt: vi.fn(),
      sendCrdtUpdate: vi.fn()
    };
    mocks.connections.push({ connection, options });
    return connection;
  }
}));

vi.mock("./useAppData", () => ({
  loadDecryptedNote: mocks.loadNote,
  loadFolders: mocks.loadFolders
}));

import { useRealtimeEvents } from "./useRealtimeEvents";

describe("useRealtimeEvents lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.acknowledgeEvents.mockResolvedValue(undefined);
    mocks.connections.length = 0;
    mocks.getCursor.mockReset();
    mocks.loadFolders.mockReset();
    mocks.loadNote.mockReset();
    useAppStore.getState().resetVaultState("reset");
    useAppStore.setState({
      eventCursor: 3,
      localPresenceState: "editing",
      rootKey: new Uint8Array([1, 2, 3]),
      selectedNoteId: "note-1",
      user: { id: "user-1", username: "alice" }
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().resetVaultState("reset");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connects after cursor bootstrap fails and publishes selected-note presence", async () => {
    mocks.getCursor.mockRejectedValue(new Error("offline"));

    render(<RealtimeHarness />);
    await flushEffects();
    expect(mocks.connections).toHaveLength(1);

    const first = mocks.connections[0]!;
    expect(first.options.after).toBe(3);
    act(() => first.options.onOpen?.());

    expect(useAppStore.getState().realtimeStatus).toBe("connected");
    expect(first.connection.sendPresence).toHaveBeenCalledWith("note-1", "editing");
  });

  it("reconnects, sends note transitions, and cancels timers on unmount", async () => {
    mocks.getCursor.mockResolvedValue({ cursor: 7 });
    const view = render(<RealtimeHarness />);
    await flushEffects();
    expect(mocks.connections).toHaveLength(1);

    const first = mocks.connections[0]!;
    act(() => first.options.onOpen?.());
    act(() => {
      useAppStore.getState().setSelectedNoteId("note-2");
    });

    expect(first.connection.sendPresence).toHaveBeenCalledWith("note-1", "left");
    expect(first.connection.sendPresence).toHaveBeenCalledWith("note-2", "editing");

    act(() => first.options.onClose?.());
    expect(useAppStore.getState().realtimeStatus).toBe("disconnected");
    await act(() => {
      vi.advanceTimersByTime(499);
      return Promise.resolve();
    });
    expect(mocks.connections).toHaveLength(1);
    await act(() => {
      vi.advanceTimersByTime(1);
      return Promise.resolve();
    });
    expect(mocks.connections).toHaveLength(2);

    const second = mocks.connections[1]!;
    view.unmount();
    expect(second.connection.close).toHaveBeenCalledOnce();
    await act(() => {
      vi.advanceTimersByTime(30_000);
      return Promise.resolve();
    });
    expect(mocks.connections).toHaveLength(2);
  });

  it("does not continue a delayed event reload into a replacement vault", async () => {
    const delayedFolders = deferred<undefined>();
    mocks.getCursor.mockResolvedValue({ cursor: 3 });
    mocks.loadFolders.mockReturnValueOnce(delayedFolders.promise);
    mocks.loadNote.mockResolvedValue(undefined);
    render(<RealtimeHarness />);
    await flushEffects();
    const first = mocks.connections[0]!;
    act(() => {
      first.options.onMessage({
        type: "replay",
        events: [
          collaborationEvent({
            eventId: "folder-event",
            resourceId: "folder-1",
            resourceType: "folder",
            type: "folder.deleted"
          }),
          collaborationEvent({
            cursor: 2,
            eventId: "note-event",
            noteId: "note-1",
            resourceId: "note-1",
            resourceType: "note",
            type: "note.updated"
          })
        ]
      });
    });
    await flushEffects();
    expect(mocks.loadFolders).toHaveBeenCalledOnce();

    const replacementRootKey = new Uint8Array([9]);
    act(() => {
      useAppStore.setState({
        rootKey: replacementRootKey,
        user: { id: "user-2", username: "bob" },
        notes: [{
          id: "fresh-note",
          folderId: "folder-1",
          title: "Fresh",
          body: "",
          noteKeyBase64: "fresh-key",
          contentLength: 0,
          version: 1,
          keyEpoch: 1,
          isDeleted: false,
          updatedAt: "2026-07-18T00:00:00.000Z",
          ownerUserId: "user-2",
          cryptoOwnerId: "user-2",
          role: "owner"
        }]
      });
      delayedFolders.resolve(undefined);
    });
    await flushEffects();

    expect(mocks.loadNote).not.toHaveBeenCalled();
    expect(useAppStore.getState().notes).toEqual([
      expect.objectContaining({ id: "fresh-note", folderId: "folder-1" })
    ]);
  });

  it("retains rejected work before reloading durable note state", async () => {
    mocks.getCursor.mockResolvedValue({ cursor: 3 });
    mocks.loadNote.mockResolvedValue(null);
    render(<RealtimeHarness />);
    await flushEffects();
    const connection = mocks.connections[0]!;
    const rootKey = useAppStore.getState().rootKey!;

    act(() => {
      connection.options.onRecoverableCrdtDraft?.({
        userId: "user-1",
        noteId: "note-1",
        sectionId: "section-1",
        keyEpoch: 1,
        reason: "stale-epoch",
        updateIds: ["update-1"],
        createdAt: 10,
        retainedAt: 20,
        source: "rejected"
      });
    });
    await flushEffects();

    expect(Object.values(useAppStore.getState().recoverableDrafts)).toEqual([
      expect.objectContaining({
        noteId: "note-1",
        state: "retained",
        updateIds: ["update-1"]
      })
    ]);
    expect(mocks.loadNote).toHaveBeenCalledWith(
      { id: "user-1", username: "alice" },
      rootKey,
      "note-1",
      expect.objectContaining({
        beforeCommit: expect.any(Function),
        preserveRealtimeContent: false
      })
    );
    expect(useAppStore.getState().error).toContain("encrypted draft was retained");
  });
});

function RealtimeHarness() {
  useRealtimeEvents();
  return null;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collaborationEvent(overrides: Record<string, unknown>) {
  return {
    actorUserId: "user-3",
    createdAt: "2026-07-18T00:00:00.000Z",
    cursor: 1,
    eventId: "event-1",
    metadata: { clientInstanceId: "other-client" },
    noteId: null,
    resourceId: "resource-1",
    resourceType: "note",
    type: "note.updated",
    version: 1,
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
