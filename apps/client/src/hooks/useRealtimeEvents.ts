import { useEffect } from "react";
import type { CollaborationEvent } from "../api";
import { connectRealtime } from "../realtime/client";
import { useAppStore } from "../store/appStore";
import { loadDecryptedNotes } from "./useAppData";

export function useRealtimeEvents() {
  const user = useAppStore((state) => state.user);
  const rootKey = useAppStore((state) => state.rootKey);
  const addCollaborationEvents = useAppStore((state) => state.addCollaborationEvents);
  const setRealtimeStatus = useAppStore((state) => state.setRealtimeStatus);

  useEffect(() => {
    if (!user || !rootKey) {
      setRealtimeStatus("idle");
      return;
    }

    setRealtimeStatus("connecting");
    const connection = connectRealtime({
      after: useAppStore.getState().eventCursor,
      onOpen: () => {
        setRealtimeStatus("connected");
      },
      onClose: () => {
        setRealtimeStatus("disconnected");
      },
      onError: () => {
        setRealtimeStatus("disconnected");
      },
      onMessage: (message) => {
        if (message.type === "replay") {
          addCollaborationEvents(message.events);
          void reloadAfterEvents(message.events);
          return;
        }
        if (message.type === "event") {
          addCollaborationEvents([message.event]);
          void reloadAfterEvents([message.event]);
        }
      }
    });

    return () => {
      connection.close();
    };
  }, [addCollaborationEvents, rootKey, setRealtimeStatus, user]);
}

async function reloadAfterEvents(events: CollaborationEvent[]): Promise<void> {
  if (!events.some((event) => shouldReloadNotes(event))) {
    return;
  }

  const { rootKey, user } = useAppStore.getState();
  if (!rootKey || !user) {
    return;
  }

  await loadDecryptedNotes(user, rootKey, false);
}

function shouldReloadNotes(event: CollaborationEvent): boolean {
  return (
    event.resourceType === "note" ||
    event.resourceType === "membership" ||
    event.resourceType === "attachment"
  );
}
