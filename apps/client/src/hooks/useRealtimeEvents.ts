import { useEffect } from "react";
import { connectRealtime } from "../realtime/client";
import { useAppStore } from "../store/appStore";

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
          return;
        }
        if (message.type === "event") {
          addCollaborationEvents([message.event]);
        }
      }
    });

    return () => {
      connection.close();
    };
  }, [addCollaborationEvents, rootKey, setRealtimeStatus, user]);
}
