import { create } from "zustand";
import type { OpenedSharingKey } from "../cryptoClient";
import type {
  AttachmentSummary,
  CollaborationEvent,
  FolderSummary,
  PresenceState,
  PresenceUser,
  User
} from "../api";

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

export interface RevocationRotationFailure {
  noteId: string;
  revokedUserId: string;
  revokedUsername: string;
  message: string;
  failedAt: string;
}

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

function omitRecordKey<T>(record: Record<string, T>, keyToRemove: string): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== keyToRemove)
  );
}
