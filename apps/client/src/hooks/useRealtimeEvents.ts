import { useEffect, useRef } from "react";
import {
  acknowledgeCollaborationEvents,
  getCollaborationEventCursor,
  type CollaborationEvent
} from "../api";
import {
  connectRealtime,
  type ClientPresenceState,
  type RealtimeConnection
} from "../realtime/client";
import { useAppStore } from "../store/appStore";
import { loadDecryptedNotes, loadFolders } from "./useAppData";

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;
const ACKNOWLEDGE_RETRY_DELAY_MS = 2_000;
const PRESENCE_HEARTBEAT_MS = 15_000;

export function useRealtimeEvents() {
  const user = useAppStore((state) => state.user);
  const rootKey = useAppStore((state) => state.rootKey);
  const localPresenceState = useAppStore((state) => state.localPresenceState);
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const addCollaborationEvents = useAppStore((state) => state.addCollaborationEvents);
  const removeNoteAccess = useAppStore((state) => state.removeNoteAccess);
  const setEventCursor = useAppStore((state) => state.setEventCursor);
  const setNotePresence = useAppStore((state) => state.setNotePresence);
  const setRealtimeStatus = useAppStore((state) => state.setRealtimeStatus);
  const connectionRef = useRef<RealtimeConnection | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const acknowledgeRetryTimersRef = useRef<number[]>([]);
  const localPresenceStateRef = useRef(localPresenceState);
  const previousSelectedNoteIdRef = useRef<string | null>(selectedNoteId);
  const selectedNoteIdRef = useRef<string | null>(selectedNoteId);

  useEffect(() => {
    if (!user || !rootKey) {
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

    function clearAcknowledgeRetryTimers() {
      acknowledgeRetryTimersRef.current.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      acknowledgeRetryTimersRef.current = [];
    }

    const acknowledgeEventCursor = createEventAcknowledger({
      acknowledgeEvents: acknowledgeCollaborationEvents,
      isActive: () => isActive,
      scheduleRetry: (retry) => {
        const timerId = window.setTimeout(() => {
          acknowledgeRetryTimersRef.current = acknowledgeRetryTimersRef.current.filter(
            (storedTimerId) => storedTimerId !== timerId
          );
          retry();
        }, ACKNOWLEDGE_RETRY_DELAY_MS);
        acknowledgeRetryTimersRef.current.push(timerId);
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
            processCollaborationEvents(message.events, addCollaborationEvents, {
              acknowledgeEvents: acknowledgeEventCursor
            });
            void reloadAfterEvents(message.events, { skipOwnEvents: true });
            return;
          }
          if (message.type === "event") {
            const events = [message.event];
            processCollaborationEvents(events, addCollaborationEvents, {
              acknowledgeEvents: acknowledgeEventCursor
            });
            void reloadAfterEvents(events, { skipOwnEvents: true });
            return;
          }
          if (message.type === "presence") {
            setNotePresence(message.noteId, message.users);
          }
        }
      });
      connectionRef.current = connection;
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
      clearAcknowledgeRetryTimers();
      window.clearInterval(heartbeatId);
      reconnectAttemptRef.current = 0;
      const connection = connectionRef.current;
      connectionRef.current = null;
      connection?.close();
    };
  }, [
    addCollaborationEvents,
    removeNoteAccess,
    rootKey,
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

interface ProcessCollaborationEventsOptions {
  acknowledgeEvents?: (cursor: number) => Promise<undefined>;
  removeRevoked?: (events: CollaborationEvent[]) => void;
}

interface EventAcknowledgerOptions {
  acknowledgeEvents: (cursor: number) => Promise<undefined>;
  isActive?: () => boolean;
  scheduleRetry: (retry: () => void) => void;
}

export function processCollaborationEvents(
  events: CollaborationEvent[],
  addCollaborationEvents: (events: CollaborationEvent[]) => void,
  {
    acknowledgeEvents = acknowledgeCollaborationEvents,
    removeRevoked = removeRevokedNotes
  }: ProcessCollaborationEventsOptions = {}
): void {
  if (events.length === 0) {
    return;
  }

  addCollaborationEvents(events);
  removeRevoked(events);
  const cursor = Math.max(...events.map((event) => event.cursor));
  void acknowledgeEvents(cursor).catch(() => {
    // The hook supplies a retried acknowledger; direct callers can ignore failures.
  });
}

export function createEventAcknowledger({
  acknowledgeEvents,
  isActive = () => true,
  scheduleRetry
}: EventAcknowledgerOptions): (cursor: number) => Promise<undefined> {
  let pendingCursor: number | null = null;
  let isAcknowledging = false;
  let retryScheduled = false;

  async function flushPendingCursor(): Promise<void> {
    if (!isActive() || isAcknowledging || pendingCursor === null) {
      return;
    }

    const cursor = pendingCursor;
    isAcknowledging = true;
    try {
      await acknowledgeEvents(cursor);
      if (pendingCursor <= cursor) {
        pendingCursor = null;
      }
    } catch {
      if (!retryScheduled && isActive()) {
        retryScheduled = true;
        scheduleRetry(() => {
          retryScheduled = false;
          void flushPendingCursor();
        });
      }
    } finally {
      isAcknowledging = false;
      if (pendingCursor !== null && pendingCursor > cursor) {
        void flushPendingCursor();
      }
    }
  }

  return (cursor: number) => {
    pendingCursor = Math.max(pendingCursor ?? 0, cursor);
    void flushPendingCursor();
    return Promise.resolve(undefined);
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
  }
}

async function reloadAfterEvents(
  events: CollaborationEvent[],
  options: { skipOwnEvents?: boolean } = {}
): Promise<void> {
  const { rootKey, user } = useAppStore.getState();
  if (!rootKey || !user) {
    return;
  }

  const shouldReloadFolders = eventsRequireFolderReload(events);
  const shouldReloadNoteData =
    eventsRequireNoteReload(events, user.id, options) || shouldReloadFolders;

  if (shouldReloadFolders) {
    await loadFolders();
  }

  if (!shouldReloadNoteData) {
    return;
  }

  await loadDecryptedNotes(user, rootKey, false, { preserveSelection: true });
}

export function isOwnRevocation(event: CollaborationEvent, userId: string): boolean {
  return (
    event.type === "membership.revoked" &&
    event.metadata?.membershipUserId === userId
  );
}

export function eventsRequireNoteReload(
  events: CollaborationEvent[],
  userId: string,
  options: { skipOwnEvents?: boolean } = {}
): boolean {
  const reloadEvents = options.skipOwnEvents
    ? events.filter((event) => event.actorUserId !== userId)
    : events;
  return reloadEvents.some((event) => shouldReloadNotes(event));
}

export function eventsRequireFolderReload(events: CollaborationEvent[]): boolean {
  return events.some((event) => shouldReloadFolders(event));
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
