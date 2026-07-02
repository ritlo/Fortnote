import { useEffect, useRef } from "react";
import type { CollaborationEvent } from "../api";
import { connectRealtime, type RealtimeConnection } from "../realtime/client";
import { useAppStore } from "../store/appStore";
import { loadDecryptedNotes } from "./useAppData";

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;
const PRESENCE_HEARTBEAT_MS = 15_000;

export function useRealtimeEvents() {
  const user = useAppStore((state) => state.user);
  const rootKey = useAppStore((state) => state.rootKey);
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const addCollaborationEvents = useAppStore((state) => state.addCollaborationEvents);
  const removeNoteAccess = useAppStore((state) => state.removeNoteAccess);
  const setNotePresence = useAppStore((state) => state.setNotePresence);
  const setRealtimeStatus = useAppStore((state) => state.setRealtimeStatus);
  const connectionRef = useRef<RealtimeConnection | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
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
          sendSelectedNotePresence(connectionRef.current, selectedNoteIdRef.current);
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
            addCollaborationEvents(message.events);
            removeRevokedNotes(message.events);
            void reloadAfterEvents(message.events, { skipOwnEvents: true });
            return;
          }
          if (message.type === "event") {
            addCollaborationEvents([message.event]);
            removeRevokedNotes([message.event]);
            void reloadAfterEvents([message.event], { skipOwnEvents: true });
            return;
          }
          if (message.type === "presence") {
            setNotePresence(message.noteId, message.users);
          }
        }
      });
      connectionRef.current = connection;
    }

    startConnection();
    const heartbeatId = window.setInterval(() => {
      sendSelectedNotePresence(connectionRef.current, selectedNoteIdRef.current);
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
    setNotePresence,
    setRealtimeStatus,
    user
  ]);

  useEffect(() => {
    selectedNoteIdRef.current = selectedNoteId;
    if (!selectedNoteId) {
      return;
    }
    connectionRef.current?.sendPresence(selectedNoteId, "idle");
  }, [selectedNoteId]);
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

  await loadDecryptedNotes(user, rootKey, false);
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
  noteId: string | null
): void {
  if (!noteId) {
    return;
  }
  connection?.sendPresence(noteId, "idle");
}
