// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeConnection, RealtimeMessage } from "../realtime/client";
import { useAppStore } from "../store/appStore";

interface ConnectionOptions {
  after: number;
  onClose?: () => void;
  onError?: () => void;
  onMessage: (message: RealtimeMessage) => void;
  onOpen?: () => void;
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
  loadNotes: vi.fn()
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
      sendPresence: vi.fn(),
      subscribeCrdt: vi.fn(),
      sendCrdtUpdate: vi.fn()
    };
    mocks.connections.push({ connection, options });
    return connection;
  }
}));

vi.mock("./useAppData", () => ({
  loadDecryptedNotes: mocks.loadNotes,
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
    mocks.loadNotes.mockReset();
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
