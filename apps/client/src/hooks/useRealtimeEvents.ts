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
  isCrdtHistoryUnreadableError,
  receiveCrdtUpdate,
  removeCrdtNote,
  setCrdtTransport
} from "../realtime/crdt";
import { useAppStore, type DecryptedNote } from "../store/appStore";
import { loadDecryptedNote, loadDecryptedNotes, loadFolders } from "./useAppData";

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
  const retainRecoverableDraft = useAppStore((state) => state.retainRecoverableDraft);
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
    const currentUser = user;
    const currentRootKey = rootKey;
    const userId = user.id;

    function reportCrdtError(message: string, error?: unknown) {
      if (!isActive || !isCurrentVaultSession(userId, currentRootKey)) {
        return;
      }
      if (error) {
        useAppStore.getState().reportOperationFailure(error, message);
        return;
      }
      setError(message);
    }

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

    function handleOffline() {
      if (isActive) {
        setRealtimeStatus("disconnected");
      }
    }

    function handleOnline() {
      if (!isActive) {
        return;
      }
      clearReconnectTimer();
      const connection = connectionRef.current;
      connectionRef.current = null;
      setCrdtTransport(null);
      connection?.suspend();
      startConnection();
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

    function reportCrdtSyncFailure(noteId: string, error: unknown): void {
      if (!isActive || !isCurrentVaultSession(userId, currentRootKey)) {
        return;
      }
      if (isCrdtHistoryUnreadableError(error)) {
        useAppStore.getState().setNoteProtectionFailure(noteId, "undecryptable");
        return;
      }
      setError("Realtime synchronization could not complete.");
    }

    function startConnection() {
      if (!isActive) {
        return;
      }
      setRealtimeStatus("connecting");
      const connection = connectRealtime({
        after: useAppStore.getState().eventCursor,
        userId,
        onCrdtError: reportCrdtError,
        onRecoverableCrdtDraft: (draft) => {
          if (
            !isActive ||
            draft.userId !== userId ||
            !isCurrentVaultSession(userId, currentRootKey)
          ) {
            return;
          }
          retainRecoverableDraft(draft);
          if (draft.source === "restored") {
            return;
          }
          setError(
            draft.reason === "forbidden"
              ? "Write access changed. Your encrypted draft was retained for recovery."
              : "The note key changed. Your encrypted draft was retained for recovery."
          );
          void loadDecryptedNote(currentUser, currentRootKey, draft.noteId, {
            beforeCommit: () => {
              removeCrdtNote(draft.noteId);
            },
            preserveRealtimeContent: false
          }).catch(() => {
            if (!isActive || !isCurrentVaultSession(userId, currentRootKey)) {
              return;
            }
            if (draft.reason === "forbidden") {
              removeCrdtNote(draft.noteId);
              useAppStore.getState().removeNoteAccess(draft.noteId);
            }
            setError(
              "Your encrypted draft is retained, but current server state could not be reloaded."
            );
          });
        },
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
        onClose: (event) => {
          if (connectionRef.current !== connection) {
            return;
          }
          connectionRef.current = null;
          setCrdtTransport(null);
          const revokedNoteId = revokedNoteIdFromClose(event);
          if (revokedNoteId) {
            useAppStore.getState().removeNoteAccess(revokedNoteId);
            removeCrdtNote(revokedNoteId);
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
            message.type === "crdt-checkpoint" ||
            message.type === "crdt-binary" ||
            message.type === "crdt-manifest"
          ) {
            void receiveCrdtUpdate(message).catch(() => {
              // A ciphertext that reaches the binding but cannot be opened is
              // a protection failure, not merely a transport warning. Surface
              // the typed recovery state immediately; the sync terminator may
              // arrive later (or be lost during reconnect).
              useAppStore.getState().setNoteProtectionFailure(message.noteId, "undecryptable");
              setError("A realtime update could not be decrypted; recovery is pending.");
            });
            return;
          }
          if (message.type === "crdt-history-page" && !message.hasMore) {
            void finishCrdtSync(
              message.noteId,
              message.keyEpoch,
              message.nextSequence > 0,
              message.sectionId,
              message.nextSequence
            ).catch((error: unknown) => {
              reportCrdtSyncFailure(message.noteId, error);
            });
            return;
          }
          if (message.type === "crdt-sync") {
            void finishCrdtSync(
              message.noteId,
              message.keyEpoch,
              message.hasUpdates
            ).catch((error: unknown) => {
              reportCrdtSyncFailure(message.noteId, error);
            });
            return;
          }
          if (message.type === "crdt-reject") {
            const code = "code" in message ? message.code : message.reason;
            if (code === "storage-limit") {
              return;
            }
            setError(
              code === "payload-too-large" || code === "frame-too-large"
                  ? "Realtime update is too large to synchronize."
                  : code === "rotation-pending"
                    ? "Note-key rotation is pending; encrypted work remains queued."
                    : "Realtime rejected an edit; protected recovery is being prepared."
            );
          }
        }
      });
      connectionRef.current = connection;
      setCrdtTransport({
        discard: connection.discardCrdtUpdates,
        downloadContent: connection.downloadCrdtContent,
        subscribe: connection.subscribeCrdt,
        unsubscribe: connection.unsubscribeCrdt,
        send: connection.sendCrdtUpdate,
        sendDurably: connection.sendCrdtUpdateDurably,
        sendContent: connection.sendCrdtContent,
        sendContentDurably: connection.sendCrdtContentDurably
      });
    }

    void bootstrapConnection();
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
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
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
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
    retainRecoverableDraft,
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

function revokedNoteIdFromClose(event?: CloseEvent): string | null {
  const prefix = "Note access revoked:";
  const reason = event?.reason ?? "";
  return reason.startsWith(prefix) ? reason.slice(prefix.length) || null : null;
}

async function reloadAfterEvents(events: CollaborationEvent[]): Promise<void> {
  const { rootKey, user } = useAppStore.getState();
  if (!rootKey || !user) {
    return;
  }

  const reloadEvents = eventsForReload(events, getClientInstanceId(), user.id);
  if (eventsRequireFolderReload(reloadEvents)) {
    await loadFolders();
    if (!isCurrentVaultSession(user.id, rootKey)) {
      return;
    }
    applyFolderInvalidations(reloadEvents);
  }
  if (!isCurrentVaultSession(user.id, rootKey)) {
    return;
  }
  invalidateAttachmentCaches(reloadEvents);
  const reloadableEvents = reloadEvents.filter(
    (event) => !isOwnRevocation(event, user.id)
  );
  if (
    !eventsRequireNoteReload(reloadableEvents) &&
    !eventsRequireTrashReload(reloadableEvents)
  ) {
    return;
  }
  const reloads: Promise<unknown>[] = [
    loadDecryptedNotes(user, rootKey, false, { preserveSelection: true })
  ];
  if (eventsRequireTrashReload(reloadableEvents)) {
    reloads.push(loadDecryptedNotes(user, rootKey, true, { preserveSelection: true }));
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

export function noteIdsRequiringReload(
  events: CollaborationEvent[],
  userId: string
): string[] {
  return [...new Set(
    events
      .filter((event) =>
        shouldReloadNotes(event) &&
        event.type !== "note.permanently_deleted" &&
        !isOwnRevocation(event, userId)
      )
      .map((event) => event.noteId)
      .filter((noteId): noteId is string => noteId !== null)
  )];
}

export function eventsFromOtherClients(
  events: CollaborationEvent[],
  clientInstanceId: string
): CollaborationEvent[] {
  return events.filter(
    (event) => event.metadata?.clientInstanceId !== clientInstanceId
  );
}

export function eventsForReload(
  events: CollaborationEvent[],
  clientInstanceId: string,
  userId: string
): CollaborationEvent[] {
  const remoteEvents = eventsFromOtherClients(events, clientInstanceId);
  const ownKeyRotationEvents = events.filter(
    (event) =>
      event.type === "membership.revoked" &&
      event.metadata?.clientInstanceId === clientInstanceId &&
      !isOwnRevocation(event, userId)
  );
  return [...remoteEvents, ...ownKeyRotationEvents];
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
    event.resourceType === "section"
  );
}

export function shouldReloadFolders(event: CollaborationEvent): boolean {
  return event.resourceType === "folder";
}

export function mergeEventCursor(current: number, acknowledged: number): number {
  return Math.max(current, acknowledged);
}

function invalidateAttachmentCaches(events: CollaborationEvent[]): void {
  const noteIds = new Set(
    events
      .filter((event) => event.resourceType === "attachment")
      .map((event) => event.noteId)
      .filter((noteId): noteId is string => noteId !== null)
  );
  if (noteIds.size === 0) {
    return;
  }
  useAppStore.getState().setAttachmentsByNote((current) =>
    Object.fromEntries(
      Object.entries(current).filter(([noteId]) => !noteIds.has(noteId))
    )
  );
}

function applyFolderInvalidations(events: CollaborationEvent[]): void {
  const deletedFolderIds = new Set(
    events
      .filter((event) => event.type === "folder.deleted")
      .map((event) => event.resourceId)
  );
  if (deletedFolderIds.size === 0) {
    return;
  }
  const state = useAppStore.getState();
  const clearDeletedFolder = (note: DecryptedNote): DecryptedNote =>
    note.folderId && deletedFolderIds.has(note.folderId)
      ? { ...note, folderId: null }
      : note;
  state.setNotes((current) => current.map(clearDeletedFolder));
  state.setTrashNotes((current) => current.map(clearDeletedFolder));
  if (state.selectedFolderId && deletedFolderIds.has(state.selectedFolderId)) {
    state.setSelectedFolderId(null);
  }
}

function isCurrentVaultSession(userId: string, rootKey: Uint8Array): boolean {
  const state = useAppStore.getState();
  return state.user?.id === userId && state.rootKey === rootKey;
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
