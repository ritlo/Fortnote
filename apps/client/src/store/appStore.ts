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

export interface DecryptedNote {
  id: string;
  folderId: string | null;
  title: string;
  body: string;
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
  revocationRotationFailures: Record<string, RevocationRotationFailure>;
  recoverableDrafts: Record<string, RecoverableSectionDraft>;
  sectionIndexes: Record<string, NoteSectionIndexState>;
  loadedSections: Record<string, LoadedSectionState>;
  selectedSectionByNote: Record<string, string>;
  localStorageCapacity: StorageCapacityState;
  serverStorageCapacity: StorageCapacityState;
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
  setRevocationRotationFailure: (
    noteId: string,
    failure: RevocationRotationFailure | null
  ) => void;
  retainRecoverableDraft: (draft: RetainedSectionDraft) => void;
  setRecoverableDraftState: (id: string, state: RecoverableDraftState) => void;
  setSectionIndex: (noteId: string, value: NoteSectionIndexState | null) => void;
  setLoadedSection: (value: LoadedSectionState | null, sectionId?: string) => void;
  setSelectedSection: (noteId: string, sectionId: string | null) => void;
  setLocalStorageCapacity: StoreSetter<StorageCapacityState>;
  setServerStorageCapacity: StoreSetter<StorageCapacityState>;
  setError: StoreSetter<string | null>;
  setStatus: StoreSetter<string>;
  resetVaultState: (nextStatus: string) => void;
}

function resolveState<T>(value: StateUpdate<T>, current: T): T {
  return typeof value === "function" ? (value as (current: T) => T)(current) : value;
}

export const useAppStore = create<AppStore>((set) => ({
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
  revocationRotationFailures: {},
  recoverableDrafts: {},
  sectionIndexes: {},
  loadedSections: {},
  selectedSectionByNote: {},
  localStorageCapacity: emptyCapacityState(),
  serverStorageCapacity: emptyCapacityState(),
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
      return { selectedNoteId };
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
        revocationRotationFailures: omitRecordKey(
          state.revocationRotationFailures,
          noteId
        ),
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
  setError: (value) => {
    set((state) => ({ error: resolveState(value, state.error) }));
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
      revocationRotationFailures: {},
      recoverableDrafts: {},
      sectionIndexes: {},
      loadedSections: {},
      selectedSectionByNote: {},
      localStorageCapacity: emptyCapacityState(),
      serverStorageCapacity: emptyCapacityState(),
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
    (current === "retained" && next === "reviewing") ||
    (current === "reviewing" &&
      (next === "reapplied" ||
        next === "exported" ||
        next === "split" ||
        next === "discarded"))
  );
}

function omitRecordKey<T>(record: Record<string, T>, keyToRemove: string): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== keyToRemove)
  );
}

function emptyCapacityState(): StorageCapacityState {
  return {
    status: "unknown",
    usedBytes: 0,
    availableBytes: 0,
    quotaBytes: 0
  };
}
