import { create } from "zustand";
import type { OpenedSharingKey } from "../cryptoClient";
import type {
  AttachmentSummary,
  CollaborationEvent,
  FolderSummary,
  LogicalNoteSectionSummary,
  PresenceState,
  PresenceUser,
  User
} from "../api";
import type { LinkedEpochRotationPreparation } from "../lib/keyMaterial";

export type AuthMode = "login" | "register" | "recover";
export type NotesView = "notes" | "shared" | "trash" | "settings";
export type RealtimeStatus = "idle" | "connecting" | "connected" | "disconnected";
export type NoteProtectionFailure = "stale" | "undecryptable";

export interface DecryptedNote {
  id: string;
  folderId: string | null;
  title: string;
  noteKeyBase64: string;
  contentLength: number;
  legacyContentAvailable?: boolean;
  legacyBodyLoaded?: boolean;
  version: number;
  keyEpoch: number;
  isDeleted: boolean;
  updatedAt: string;
  ownerUserId: string;
  cryptoOwnerId: string;
  role: "owner" | "editor" | "viewer";
  rootVersion?: number;
  rootSectionId?: string | null;
  metadataMigration?: "current" | "write-v2-pending" | "retry-required";
}

export type SectionIndexStatus = "idle" | "loading" | "ready" | "error";
export type SectionLoadStatus =
  | "unloaded"
  | "loading"
  | "ready"
  | "releasing"
  | "error";

export interface NoteSectionIndexState {
  noteId: string;
  status: SectionIndexStatus;
  orderedSectionIds: string[];
  sections: LogicalNoteSectionSummary[];
  error?: string;
}

export interface LoadedSectionState {
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  status: SectionLoadStatus;
  currentSequence: number;
  prefetched: boolean;
  transferProgress?: SectionTransferProgress;
  error?: string;
}

export interface SectionTransferProgress {
  phase: "uploading" | "downloading" | "verifying";
  completedChunks: number;
  totalChunks: number;
  transferredBytes: number;
  totalBytes: number;
}

export interface StorageCapacityState {
  status: "unknown" | "available" | "full" | "error";
  usedBytes: number;
  availableBytes: number;
  quotaBytes: number;
}

export interface OperationFailureState {
  kind: "conflict" | "generic" | "local-capacity" | "server-capacity" | "server-maintenance";
  message: string;
  status: string;
}

export interface RevocationRotationFailure {
  noteId: string;
  revokedUserId: string;
  revokedUsername: string;
  message: string;
  failedAt: string;
  preparation?: LinkedEpochRotationPreparation;
}

export type RecoverableDraftState =
  | "retained"
  | "reviewing"
  | "reapplied"
  | "exported"
  | "split"
  | "discarded";

export interface RecoverableSectionDraft {
  id: string;
  userId: string;
  noteId: string;
  sectionId: string;
  keyEpoch: number;
  reason: "forbidden" | "stale-epoch";
  updateIds: string[];
  state: RecoverableDraftState;
  createdAt: number;
  retainedAt: number;
}

export type RetainedSectionDraft = Omit<RecoverableSectionDraft, "id" | "state">;

type StateUpdate<T> = T | ((current: T) => T);
type StoreSetter<T> = (value: StateUpdate<T>) => void;

export interface AppStore {
  user: User | null;
  rootKey: Uint8Array | null;
  keyMaterialVersion: number | null;
  authMode: AuthMode;
  username: string;
  password: string;
  newPassword: string;
  recoveryInput: string;
  recoveryNewPassword: string;
  notes: DecryptedNote[];
  trashNotes: DecryptedNote[];
  folders: FolderSummary[];
  notesView: NotesView;
  selectedFolderId: string | null;
  attachmentsByNote: Record<string, AttachmentSummary[]>;
  selectedNoteId: string | null;
  search: string;
  recoverySecret: string | null;
  realtimeStatus: RealtimeStatus;
  localPresenceState: PresenceState;
  eventCursor: number;
  collaborationEvents: CollaborationEvent[];
  presenceByNote: Record<string, PresenceUser[]>;
  openedSharingKey: OpenedSharingKey | null;
  removedNoteId: string | null;
  revocationRotationPendingNoteId: string | null;
  revocationRotationFailures: Record<string, RevocationRotationFailure>;
  noteProtectionFailures: Record<string, NoteProtectionFailure>;
  recoverableDrafts: Record<string, RecoverableSectionDraft>;
  sectionIndexes: Record<string, NoteSectionIndexState>;
  loadedSections: Record<string, LoadedSectionState>;
  selectedSectionByNote: Record<string, string>;
  localStorageCapacity: StorageCapacityState;
  serverStorageCapacity: StorageCapacityState;
  operationFailure: OperationFailureState | null;
  requestTokens: Record<string, string>;
  error: string | null;
  status: string;
  setUser: StoreSetter<User | null>;
  setRootKey: StoreSetter<Uint8Array | null>;
  setKeyMaterialVersion: StoreSetter<number | null>;
  setAuthMode: StoreSetter<AuthMode>;
  setUsername: StoreSetter<string>;
  setPassword: StoreSetter<string>;
  setNewPassword: StoreSetter<string>;
  setRecoveryInput: StoreSetter<string>;
  setRecoveryNewPassword: StoreSetter<string>;
  setNotes: StoreSetter<DecryptedNote[]>;
  setTrashNotes: StoreSetter<DecryptedNote[]>;
  setFolders: StoreSetter<FolderSummary[]>;
  setNotesView: StoreSetter<NotesView>;
  setSelectedFolderId: StoreSetter<string | null>;
  setAttachmentsByNote: StoreSetter<Record<string, AttachmentSummary[]>>;
  setSelectedNoteId: StoreSetter<string | null>;
  setSearch: StoreSetter<string>;
  setRecoverySecret: StoreSetter<string | null>;
  setRealtimeStatus: StoreSetter<RealtimeStatus>;
  setLocalPresenceState: StoreSetter<PresenceState>;
  setEventCursor: StoreSetter<number>;
  addCollaborationEvents: (events: CollaborationEvent[]) => void;
  removeNoteAccess: (noteId: string) => void;
  setNotePresence: (noteId: string, users: PresenceUser[]) => void;
  setOpenedSharingKey: StoreSetter<OpenedSharingKey | null>;
  setRevocationRotationPendingNoteId: StoreSetter<string | null>;
  setRevocationRotationFailure: (
    noteId: string,
    failure: RevocationRotationFailure | null
  ) => void;
  setNoteProtectionFailure: (
    noteId: string,
    failure: NoteProtectionFailure | null
  ) => void;
  retainRecoverableDraft: (draft: RetainedSectionDraft) => void;
  setRecoverableDraftState: (id: string, state: RecoverableDraftState) => void;
  setSectionIndex: (noteId: string, value: NoteSectionIndexState | null) => void;
  setLoadedSection: (value: LoadedSectionState | null, sectionId?: string) => void;
  setSelectedSection: (noteId: string, sectionId: string | null) => void;
  setLocalStorageCapacity: StoreSetter<StorageCapacityState>;
  setServerStorageCapacity: StoreSetter<StorageCapacityState>;
  reportOperationFailure: (
    error: unknown,
    fallback: string,
    fallbackStatus?: string
  ) => OperationFailureState;
  beginRequest: (scope: string) => string;
  finishRequest: (scope: string, token: string) => void;
  isCurrentRequest: (scope: string, token: string) => boolean;
  setError: StoreSetter<string | null>;
  setStatus: StoreSetter<string>;
  resetVaultState: (nextStatus: string) => void;
}

function resolveState<T>(value: StateUpdate<T>, current: T): T {
  return typeof value === "function" ? (value as (current: T) => T)(current) : value;
}

export const useAppStore = create<AppStore>((set, get) => ({
  user: null,
  rootKey: null,
  keyMaterialVersion: null,
  authMode: "login",
  username: "",
  password: "",
  newPassword: "",
  recoveryInput: "",
  recoveryNewPassword: "",
  notes: [],
  trashNotes: [],
  folders: [],
  notesView: "notes",
  selectedFolderId: null,
  attachmentsByNote: {},
  selectedNoteId: null,
  search: "",
  recoverySecret: null,
  realtimeStatus: "idle",
  localPresenceState: "idle",
  eventCursor: 0,
  collaborationEvents: [],
  presenceByNote: {},
  openedSharingKey: null,
  removedNoteId: null,
  revocationRotationPendingNoteId: null,
  revocationRotationFailures: {},
  noteProtectionFailures: {},
  recoverableDrafts: {},
  sectionIndexes: {},
  loadedSections: {},
  selectedSectionByNote: {},
  localStorageCapacity: emptyCapacityState(),
  serverStorageCapacity: emptyCapacityState(),
  operationFailure: null,
  requestTokens: {},
  error: null,
  status: "Checking session",
  setUser: (value) => {
    set((state) => ({ user: resolveState(value, state.user) }));
  },
  setRootKey: (value) => {
    set((state) => ({ rootKey: resolveState(value, state.rootKey) }));
  },
  setKeyMaterialVersion: (value) => {
    set((state) => ({
      keyMaterialVersion: resolveState(value, state.keyMaterialVersion)
    }));
  },
  setAuthMode: (value) => {
    set((state) => ({ authMode: resolveState(value, state.authMode) }));
  },
  setUsername: (value) => {
    set((state) => ({ username: resolveState(value, state.username) }));
  },
  setPassword: (value) => {
    set((state) => ({ password: resolveState(value, state.password) }));
  },
  setNewPassword: (value) => {
    set((state) => ({ newPassword: resolveState(value, state.newPassword) }));
  },
  setRecoveryInput: (value) => {
    set((state) => ({ recoveryInput: resolveState(value, state.recoveryInput) }));
  },
  setRecoveryNewPassword: (value) => {
    set((state) => ({
      recoveryNewPassword: resolveState(value, state.recoveryNewPassword)
    }));
  },
  setNotes: (value) => {
    set((state) => ({ notes: resolveState(value, state.notes) }));
  },
  setTrashNotes: (value) => {
    set((state) => ({ trashNotes: resolveState(value, state.trashNotes) }));
  },
  setFolders: (value) => {
    set((state) => ({ folders: resolveState(value, state.folders) }));
  },
  setNotesView: (value) => {
    set((state) => ({ notesView: resolveState(value, state.notesView) }));
  },
  setSelectedFolderId: (value) => {
    set((state) => ({
      selectedFolderId: resolveState(value, state.selectedFolderId)
    }));
  },
  setAttachmentsByNote: (value) => {
    set((state) => ({
      attachmentsByNote: resolveState(value, state.attachmentsByNote)
    }));
  },
  setSelectedNoteId: (value) => {
    set((state) => {
      const selectedNoteId = resolveState(value, state.selectedNoteId);
      return { selectedNoteId, removedNoteId: null };
    });
  },
  setSearch: (value) => {
    set((state) => ({ search: resolveState(value, state.search) }));
  },
  setRecoverySecret: (value) => {
    set((state) => ({
      recoverySecret: resolveState(value, state.recoverySecret)
    }));
  },
  setRealtimeStatus: (value) => {
    set((state) => ({ realtimeStatus: resolveState(value, state.realtimeStatus) }));
  },
  setLocalPresenceState: (value) => {
    set((state) => ({
      localPresenceState: resolveState(value, state.localPresenceState)
    }));
  },
  setEventCursor: (value) => {
    set((state) => ({ eventCursor: resolveState(value, state.eventCursor) }));
  },
  addCollaborationEvents: (events) => {
    set((state) => {
      if (events.length === 0) {
        return {};
      }
      const seenEventIds = new Set(
        state.collaborationEvents.map((event) => event.eventId)
      );
      const newEvents = events.filter((event) => {
        if (seenEventIds.has(event.eventId)) {
          return false;
        }
        seenEventIds.add(event.eventId);
        return true;
      });
      const nextCursor = Math.max(
        state.eventCursor,
        ...events.map((event) => event.cursor)
      );
      return {
        collaborationEvents: [...state.collaborationEvents, ...newEvents].slice(-200),
        eventCursor: nextCursor
      };
    });
  },
  removeNoteAccess: (noteId) => {
    set((state) => {
      const notes = state.notes.filter((note) => note.id !== noteId);
      const trashNotes = state.trashNotes.filter((note) => note.id !== noteId);
      const nextSelectedNoteId =
        state.notesView === "shared"
          ? (notes.find((note) => note.role !== "owner")?.id ?? null)
          : (notes[0]?.id ?? null);
      return {
        attachmentsByNote: omitRecordKey(state.attachmentsByNote, noteId),
        notes,
        presenceByNote: omitRecordKey(state.presenceByNote, noteId),
        removedNoteId: state.selectedNoteId === noteId ? noteId : state.removedNoteId,
        revocationRotationFailures: omitRecordKey(
          state.revocationRotationFailures,
          noteId
        ),
        noteProtectionFailures: omitRecordKey(state.noteProtectionFailures, noteId),
        revocationRotationPendingNoteId:
          state.revocationRotationPendingNoteId === noteId
            ? null
            : state.revocationRotationPendingNoteId,
        sectionIndexes: omitRecordKey(state.sectionIndexes, noteId),
        loadedSections: Object.fromEntries(
          Object.entries(state.loadedSections).filter(
            ([, section]) => section.noteId !== noteId
          )
        ),
        selectedSectionByNote: omitRecordKey(state.selectedSectionByNote, noteId),
        selectedNoteId:
          state.selectedNoteId === noteId ? nextSelectedNoteId : state.selectedNoteId,
        trashNotes
      };
    });
  },
  setNotePresence: (noteId, users) => {
    set((state) => ({
      presenceByNote: {
        ...state.presenceByNote,
        [noteId]: users
      }
    }));
  },
  setOpenedSharingKey: (value) => {
    set((state) => ({
      openedSharingKey: resolveState(value, state.openedSharingKey)
    }));
  },
  setRevocationRotationPendingNoteId: (value) => {
    set((state) => ({
      revocationRotationPendingNoteId: resolveState(
        value,
        state.revocationRotationPendingNoteId
      )
    }));
  },
  setRevocationRotationFailure: (noteId, failure) => {
    set((state) => ({
      revocationRotationFailures: failure
        ? {
            ...state.revocationRotationFailures,
            [noteId]: failure
          }
        : omitRecordKey(state.revocationRotationFailures, noteId)
    }));
  },
  setNoteProtectionFailure: (noteId, failure) => {
    set((state) => ({
      noteProtectionFailures: failure
        ? { ...state.noteProtectionFailures, [noteId]: failure }
        : omitRecordKey(state.noteProtectionFailures, noteId)
    }));
  },
  retainRecoverableDraft: (draft) => {
    set((state) => {
      const id = recoverableDraftId(draft);
      const current = state.recoverableDrafts[id];
      const updateIds = [...new Set([
        ...(current?.updateIds ?? []),
        ...draft.updateIds
      ])];
      return {
        recoverableDrafts: {
          ...state.recoverableDrafts,
          [id]: {
            ...draft,
            id,
            updateIds,
            state:
              current?.updateIds.length === updateIds.length
                ? current.state
                : "retained"
          }
        }
      };
    });
  },
  setRecoverableDraftState: (id, nextState) => {
    set((state) => {
      const current = state.recoverableDrafts[id];
      if (!current || !isRecoverableDraftTransition(current.state, nextState)) {
        return {};
      }
      return {
        recoverableDrafts: {
          ...state.recoverableDrafts,
          [id]: { ...current, state: nextState }
        }
      };
    });
  },
  setSectionIndex: (noteId, value) => {
    set((state) => ({
      sectionIndexes: value
        ? { ...state.sectionIndexes, [noteId]: value }
        : omitRecordKey(state.sectionIndexes, noteId)
    }));
  },
  setLoadedSection: (value, sectionId) => {
    set((state) => {
      const key = value
        ? sectionRuntimeKey(value.noteId, value.sectionId)
        : sectionId;
      if (!key) {
        return {};
      }
      return {
        loadedSections: value
          ? { ...state.loadedSections, [key]: value }
          : omitRecordKey(state.loadedSections, key)
      };
    });
  },
  setSelectedSection: (noteId, sectionId) => {
    set((state) => ({
      selectedSectionByNote: sectionId
        ? { ...state.selectedSectionByNote, [noteId]: sectionId }
        : omitRecordKey(state.selectedSectionByNote, noteId)
    }));
  },
  setLocalStorageCapacity: (value) => {
    set((state) => ({
      localStorageCapacity: resolveState(value, state.localStorageCapacity)
    }));
  },
  setServerStorageCapacity: (value) => {
    set((state) => ({
      serverStorageCapacity: resolveState(value, state.serverStorageCapacity)
    }));
  },
  reportOperationFailure: (error, fallback, fallbackStatus) => {
    const failure = operationFailureState(error, fallback, fallbackStatus);
    set((state) => ({
      error: failure.message,
      operationFailure: failure,
      status: failure.status,
      ...(failure.kind === "local-capacity"
        ? {
            localStorageCapacity: {
              ...state.localStorageCapacity,
              availableBytes: 0,
              status: "full" as const
            }
          }
        : {}),
      ...(failure.kind === "server-capacity" || failure.kind === "server-maintenance"
        ? {
            serverStorageCapacity: {
              ...state.serverStorageCapacity,
              ...(failure.kind === "server-capacity" ? { availableBytes: 0 } : {}),
              status: failure.kind === "server-capacity" ? "full" as const : "error" as const
            }
          }
        : {})
    }));
    return failure;
  },
  beginRequest: (scope) => {
    const token = crypto.randomUUID();
    set((state) => ({ requestTokens: { ...state.requestTokens, [scope]: token } }));
    return token;
  },
  finishRequest: (scope, token) => {
    set((state) => state.requestTokens[scope] === token
      ? { requestTokens: omitRecordKey(state.requestTokens, scope) }
      : {}
    );
  },
  isCurrentRequest: (scope, token) => get().requestTokens[scope] === token,
  setError: (value) => {
    set((state) => {
      const error = resolveState(value, state.error);
      return { error, ...(error === null ? { operationFailure: null } : {}) };
    });
  },
  setStatus: (value) => {
    set((state) => ({ status: resolveState(value, state.status) }));
  },
  resetVaultState: (nextStatus) => {
    set({
      rootKey: null,
      keyMaterialVersion: null,
      notes: [],
      trashNotes: [],
      folders: [],
      attachmentsByNote: {},
      selectedNoteId: null,
      selectedFolderId: null,
      notesView: "notes",
      recoverySecret: null,
      realtimeStatus: "idle",
      localPresenceState: "idle",
      eventCursor: 0,
      collaborationEvents: [],
      presenceByNote: {},
      openedSharingKey: null,
      removedNoteId: null,
      revocationRotationPendingNoteId: null,
      revocationRotationFailures: {},
      noteProtectionFailures: {},
      recoverableDrafts: {},
      sectionIndexes: {},
      loadedSections: {},
      selectedSectionByNote: {},
      localStorageCapacity: emptyCapacityState(),
      serverStorageCapacity: emptyCapacityState(),
      operationFailure: null,
      requestTokens: {},
      search: "",
      password: "",
      newPassword: "",
      recoveryInput: "",
      recoveryNewPassword: "",
      user: null,
      error: null,
      status: nextStatus
    });
  }
}));

export function sectionRuntimeKey(noteId: string, sectionId: string): string {
  return JSON.stringify([noteId, sectionId]);
}

export function recoverableDraftId(
  draft: Pick<RecoverableSectionDraft, "userId" | "noteId" | "sectionId" | "keyEpoch">
): string {
  return JSON.stringify([
    draft.userId,
    draft.noteId,
    draft.sectionId,
    draft.keyEpoch
  ]);
}

function isRecoverableDraftTransition(
  current: RecoverableDraftState,
  next: RecoverableDraftState
): boolean {
  return (
    current === next ||
    (current === "retained" &&
      (next === "reviewing" || next === "exported" || next === "reapplied")) ||
    ((current === "reviewing" || current === "exported") &&
      (next === "reapplied" ||
        next === "exported" ||
        next === "reviewing" ||
        next === "split" ||
        next === "discarded"))
  );
}

function omitRecordKey<T>(record: Record<string, T>, keyToRemove: string): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== keyToRemove)
  );
}

export function operationFailureState(
  error: unknown,
  fallback: string,
  fallbackStatus = "Operation failed"
): OperationFailureState {
  if (["conflict", "version_conflict", "chunk_conflict", "manifest_mismatch", "forbidden"].includes(
    errorCode(error) ?? ""
  )) {
    return {
      kind: "conflict",
      message: "Encrypted changes were retained because the server version changed.",
      status: "Changes need review"
    };
  }
  if (["quota_exceeded", "storage_limit", "storage-limit"].includes(errorCode(error) ?? "")) {
    return {
      kind: "server-capacity",
      message: "Encrypted changes remain on this device until server storage is available.",
      status: "Server storage full — changes kept on this device"
    };
  }
  if (errorName(error) === "IndexedDbCapacityError" || errorName(error) === "QuotaExceededError") {
    return {
      kind: "local-capacity",
      message: "The visible draft is not crash-safe. Free browser storage, export, or split it.",
      status: "Local storage full — changes need attention"
    };
  }
  if (errorCode(error) === "internal_error" || errorStatus(error) >= 500) {
    return {
      kind: "server-maintenance",
      message: "Encrypted changes remain local while the server is unavailable.",
      status: "Synchronizing paused — server unavailable"
    };
  }
  return { kind: "generic", message: fallback, status: fallbackStatus };
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : null;
}

function errorName(error: unknown): string | null {
  return typeof error === "object" && error !== null && "name" in error &&
    typeof error.name === "string" ? error.name : null;
}

function errorStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error &&
    typeof error.status === "number" ? error.status : 0;
}

function emptyCapacityState(): StorageCapacityState {
  return {
    status: "unknown",
    usedBytes: 0,
    availableBytes: 0,
    quotaBytes: 0
  };
}
