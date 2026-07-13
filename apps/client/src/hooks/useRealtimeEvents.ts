import { useEffect, useRef } from "react";
import {
  acknowledgeCollaborationEvents,
  getClientInstanceId,
  getCollaborationEventCursor,
  type CollaborationEvent
} from "../api";
import {
  connectRealtime,
  type ClientPresenceState,
  type RealtimeConnection
} from "../realtime/client";
import {
  clearCrdtNotes,
  finishCrdtSync,
  receiveCrdtUpdate,
  removeCrdtNote,
  setCrdtTransport
} from "../realtime/crdt";
import { useAppStore } from "../store/appStore";
import { loadDecryptedNotes, loadFolders } from "./useAppData";

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;
const EVENT_RETRY_DELAY_MS = 2_000;
const PRESENCE_HEARTBEAT_MS = 15_000;

export function useRealtimeEvents() {
  const user = useAppStore((state) => state.user);
  const rootKey = useAppStore((state) => state.rootKey);
  const localPresenceState = useAppStore((state) => state.localPresenceState);
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const addCollaborationEvents = useAppStore((state) => state.addCollaborationEvents);
  const setEventCursor = useAppStore((state) => state.setEventCursor);
  const setNotePresence = useAppStore((state) => state.setNotePresence);
  const setError = useAppStore((state) => state.setError);
  const setRealtimeStatus = useAppStore((state) => state.setRealtimeStatus);
  const connectionRef = useRef<RealtimeConnection | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const eventRetryTimersRef = useRef<number[]>([]);
  const localPresenceStateRef = useRef(localPresenceState);
  const previousSelectedNoteIdRef = useRef<string | null>(selectedNoteId);
  const selectedNoteIdRef = useRef<string | null>(selectedNoteId);

  useEffect(() => {
    if (!user || !rootKey) {
      clearCrdtNotes();
      setRealtimeStatus("idle");
      return;
    }

    let isActive = true;

    function clearReconnectTimer() {
      if (reconnectTimerRef.current === null) {
        return;
      }
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    function clearEventRetryTimers() {
      eventRetryTimersRef.current.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      eventRetryTimersRef.current = [];
    }

    const processEvents = createCollaborationEventProcessor({
      acknowledgeEvents: acknowledgeCollaborationEvents,
      applyEvents: (events) => {
        addCollaborationEvents(events);
        removeRevokedNotes(events);
      },
      isActive: () => isActive,
      reloadEvents: reloadAfterEvents,
      scheduleRetry: (retry) => {
        const timerId = window.setTimeout(() => {
          eventRetryTimersRef.current = eventRetryTimersRef.current.filter(
            (storedTimerId) => storedTimerId !== timerId
          );
          retry();
        }, EVENT_RETRY_DELAY_MS);
        eventRetryTimersRef.current.push(timerId);
      }
    });

    function scheduleReconnect() {
      if (!isActive || reconnectTimerRef.current !== null) {
        return;
      }
      setRealtimeStatus("disconnected");
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttemptRef.current,
        RECONNECT_MAX_DELAY_MS
      );
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        startConnection();
      }, delay);
    }

    async function bootstrapConnection() {
      setRealtimeStatus("connecting");
      try {
        const { cursor } = await getCollaborationEventCursor();
        if (!isActive) {
          return;
        }
        setEventCursor((current) => mergeEventCursor(current, cursor));
      } catch {
        if (!isActive) {
          return;
        }
      }
      startConnection();
    }

    function startConnection() {
      if (!isActive) {
        return;
      }
      setRealtimeStatus("connecting");
      const connection = connectRealtime({
        after: useAppStore.getState().eventCursor,
        onOpen: () => {
          if (!isActive) {
            return;
          }
          reconnectAttemptRef.current = 0;
          setRealtimeStatus("connected");
          sendSelectedNotePresence(
            connectionRef.current,
            selectedNoteIdRef.current,
            localPresenceStateRef.current
          );
        },
        onClose: () => {
          if (connectionRef.current === connection) {
            connectionRef.current = null;
          }
          scheduleReconnect();
        },
        onError: () => {
          if (!isActive) {
            return;
          }
          setRealtimeStatus("disconnected");
        },
        onMessage: (message) => {
          if (message.type === "replay") {
            processEvents(message.events);
            return;
          }
          if (message.type === "event") {
            processEvents([message.event]);
            return;
          }
          if (message.type === "presence") {
            setNotePresence(message.noteId, message.users);
            return;
          }
          if (
            message.type === "crdt-update" ||
            message.type === "crdt-checkpoint"
          ) {
            void receiveCrdtUpdate(message).catch(() => undefined);
            return;
          }
          if (message.type === "crdt-sync") {
            void finishCrdtSync(message.noteId, message.hasUpdates);
            return;
          }
          if (message.type === "crdt-reject") {
            setError("Realtime storage limit reached; waiting for compaction.");
          }
        }
      });
      connectionRef.current = connection;
      setCrdtTransport({
        discard: connection.discardCrdtUpdates,
        subscribe: connection.subscribeCrdt,
        send: connection.sendCrdtUpdate
      });
    }

    void bootstrapConnection();
    const heartbeatId = window.setInterval(() => {
      sendSelectedNotePresence(
        connectionRef.current,
        selectedNoteIdRef.current,
        localPresenceStateRef.current
      );
    }, PRESENCE_HEARTBEAT_MS);

    return () => {
      isActive = false;
      clearReconnectTimer();
      clearEventRetryTimers();
      window.clearInterval(heartbeatId);
      reconnectAttemptRef.current = 0;
      const connection = connectionRef.current;
      connectionRef.current = null;
      setCrdtTransport(null);
      connection?.close();
    };
  }, [
    addCollaborationEvents,
    rootKey,
    setError,
    setEventCursor,
    setNotePresence,
    setRealtimeStatus,
    user
  ]);

  useEffect(() => {
    if (previousSelectedNoteIdRef.current && previousSelectedNoteIdRef.current !== selectedNoteId) {
      connectionRef.current?.sendPresence(previousSelectedNoteIdRef.current, "left");
    }
    previousSelectedNoteIdRef.current = selectedNoteId;
    selectedNoteIdRef.current = selectedNoteId;
    if (!selectedNoteId) {
      return;
    }
    connectionRef.current?.sendPresence(selectedNoteId, localPresenceStateRef.current);
  }, [selectedNoteId]);

  useEffect(() => {
    localPresenceStateRef.current = localPresenceState;
    sendSelectedNotePresence(connectionRef.current, selectedNoteIdRef.current, localPresenceState);
  }, [localPresenceState]);
}

interface CollaborationEventProcessorOptions {
  acknowledgeEvents: (cursor: number) => Promise<undefined>;
  applyEvents: (events: CollaborationEvent[]) => void;
  isActive?: () => boolean;
  reloadEvents: (events: CollaborationEvent[]) => Promise<void>;
  scheduleRetry: (retry: () => void) => void;
}

interface PendingEventBatch {
  applied: boolean;
  events: CollaborationEvent[];
  reloaded: boolean;
}

export function createCollaborationEventProcessor({
  acknowledgeEvents,
  applyEvents,
  isActive = () => true,
  reloadEvents,
  scheduleRetry
}: CollaborationEventProcessorOptions): (events: CollaborationEvent[]) => void {
  const pendingBatches: PendingEventBatch[] = [];
  let isProcessing = false;
  let retryScheduled = false;

  async function flushPendingBatches(): Promise<void> {
    const batch = pendingBatches[0];
    if (!isActive() || isProcessing || !batch) {
      return;
    }

    isProcessing = true;
    try {
      if (!batch.applied) {
        applyEvents(batch.events);
        batch.applied = true;
      }
      if (!batch.reloaded) {
        await reloadEvents(batch.events);
        batch.reloaded = true;
      }
      if (!isActive()) {
        return;
      }
      await acknowledgeEvents(Math.max(...batch.events.map((event) => event.cursor)));
      pendingBatches.shift();
    } catch {
      if (!retryScheduled && isActive()) {
        retryScheduled = true;
        scheduleRetry(() => {
          retryScheduled = false;
          void flushPendingBatches();
        });
      }
    } finally {
      isProcessing = false;
      if (pendingBatches.length > 0 && !retryScheduled) {
        void flushPendingBatches();
      }
    }
  }

  return (events: CollaborationEvent[]) => {
    if (events.length === 0) {
      return;
    }
    pendingBatches.push({ applied: false, events, reloaded: false });
    void flushPendingBatches();
  };
}

export function removeRevokedNotes(events: CollaborationEvent[]): void {
  const { removeNoteAccess, user } = useAppStore.getState();
  if (!user) {
    return;
  }

  for (const event of events) {
    if (!isOwnRevocation(event, user.id) || !event.noteId) {
      continue;
    }
    removeNoteAccess(event.noteId);
    removeCrdtNote(event.noteId);
  }
}

async function reloadAfterEvents(events: CollaborationEvent[]): Promise<void> {
  const { rootKey, user } = useAppStore.getState();
  if (!rootKey || !user) {
    return;
  }

  const remoteEvents = eventsFromOtherClients(events, getClientInstanceId());
  const shouldReloadFolders = eventsRequireFolderReload(remoteEvents);
  const shouldReloadNoteData =
    eventsRequireNoteReload(remoteEvents) || shouldReloadFolders;

  if (shouldReloadFolders) {
    await loadFolders();
  }

  if (!shouldReloadNoteData) {
    return;
  }

  const reloads = [
    loadDecryptedNotes(user, rootKey, false, { preserveSelection: true })
  ];
  if (eventsRequireTrashReload(remoteEvents)) {
    reloads.push(
      loadDecryptedNotes(user, rootKey, true, { preserveSelection: true })
    );
  }
  await Promise.all(reloads);
}

export function isOwnRevocation(event: CollaborationEvent, userId: string): boolean {
  return (
    event.type === "membership.revoked" &&
    event.metadata?.membershipUserId === userId
  );
}

export function eventsRequireNoteReload(
  events: CollaborationEvent[]
): boolean {
  return events.some((event) => shouldReloadNotes(event));
}

export function eventsFromOtherClients(
  events: CollaborationEvent[],
  clientInstanceId: string
): CollaborationEvent[] {
  return events.filter(
    (event) => event.metadata?.clientInstanceId !== clientInstanceId
  );
}

export function eventsRequireFolderReload(events: CollaborationEvent[]): boolean {
  return events.some((event) => shouldReloadFolders(event));
}

export function eventsRequireTrashReload(events: CollaborationEvent[]): boolean {
  return events.some((event) =>
    ["note.deleted", "note.restored", "note.permanently_deleted"].includes(event.type)
  );
}

export function shouldReloadNotes(event: CollaborationEvent): boolean {
  return (
    event.resourceType === "note" ||
    event.resourceType === "membership" ||
    event.resourceType === "attachment" ||
    event.resourceType === "folder"
  );
}

export function shouldReloadFolders(event: CollaborationEvent): boolean {
  return event.resourceType === "folder";
}

export function mergeEventCursor(current: number, acknowledged: number): number {
  return Math.max(current, acknowledged);
}

function sendSelectedNotePresence(
  connection: RealtimeConnection | null,
  noteId: string | null,
  state: ClientPresenceState
): void {
  if (!noteId) {
    return;
  }
  connection?.sendPresence(noteId, state);
}
