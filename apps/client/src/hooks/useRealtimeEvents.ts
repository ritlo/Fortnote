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
import { loadDecryptedNotes } from "./useAppData";

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;
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
        setEventCursor((current) => Math.max(current, cursor));
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
            processCollaborationEvents(message.events, addCollaborationEvents);
            void reloadAfterEvents(message.events, { skipOwnEvents: true });
            return;
          }
          if (message.type === "event") {
            const events = [message.event];
            processCollaborationEvents(events, addCollaborationEvents);
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

function processCollaborationEvents(
  events: CollaborationEvent[],
  addCollaborationEvents: (events: CollaborationEvent[]) => void
): void {
  if (events.length === 0) {
    return;
  }

  addCollaborationEvents(events);
  removeRevokedNotes(events);
  const cursor = Math.max(...events.map((event) => event.cursor));
  void acknowledgeCollaborationEvents(cursor).catch(() => {
    // Reconnect/replay will retry acknowledgement from the stored cursor.
  });
}

function removeRevokedNotes(events: CollaborationEvent[]): void {
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

  const reloadEvents = options.skipOwnEvents
    ? events.filter((event) => event.actorUserId !== user.id)
    : events;
  if (!reloadEvents.some((event) => shouldReloadNotes(event))) {
    return;
  }

  await loadDecryptedNotes(user, rootKey, false, { preserveSelection: true });
}

function isOwnRevocation(event: CollaborationEvent, userId: string): boolean {
  return (
    event.type === "membership.revoked" &&
    event.metadata?.membershipUserId === userId
  );
}

function shouldReloadNotes(event: CollaborationEvent): boolean {
  return (
    event.resourceType === "note" ||
    event.resourceType === "membership" ||
    event.resourceType === "attachment"
  );
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
