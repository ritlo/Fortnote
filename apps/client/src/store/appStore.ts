import { create } from "zustand";
import type { OpenedSharingKey } from "../cryptoClient";
import type {
  AttachmentSummary,
  CollaborationEvent,
  FolderSummary,
  PresenceUser,
  User
} from "../api";

export type AuthMode = "login" | "register" | "recover";
export type NotesView = "notes" | "trash" | "settings";
export type RealtimeStatus = "idle" | "connecting" | "connected" | "disconnected";

export interface DecryptedNote {
  id: string;
  folderId: string | null;
  title: string;
  body: string;
  noteKeyBase64: string;
  contentLength: number;
  version: number;
  isDeleted: boolean;
  updatedAt: string;
  ownerUserId: string;
  cryptoOwnerId: string;
  role: "owner" | "editor" | "viewer";
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
  eventCursor: number;
  collaborationEvents: CollaborationEvent[];
  presenceByNote: Record<string, PresenceUser[]>;
  openedSharingKey: OpenedSharingKey | null;
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
  setEventCursor: StoreSetter<number>;
  addCollaborationEvents: (events: CollaborationEvent[]) => void;
  removeNoteAccess: (noteId: string) => void;
  setNotePresence: (noteId: string, users: PresenceUser[]) => void;
  setOpenedSharingKey: StoreSetter<OpenedSharingKey | null>;
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
  username: "alice",
  password: "correct horse battery staple",
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
  eventCursor: 0,
  collaborationEvents: [],
  presenceByNote: {},
  openedSharingKey: null,
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
    set((state) => ({ selectedNoteId: resolveState(value, state.selectedNoteId) }));
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
  setEventCursor: (value) => {
    set((state) => ({ eventCursor: resolveState(value, state.eventCursor) }));
  },
  addCollaborationEvents: (events) => {
    set((state) => {
      if (events.length === 0) {
        return {};
      }
      const nextCursor = Math.max(
        state.eventCursor,
        ...events.map((event) => event.cursor)
      );
      return {
        collaborationEvents: [...state.collaborationEvents, ...events].slice(-200),
        eventCursor: nextCursor
      };
    });
  },
  removeNoteAccess: (noteId) => {
    set((state) => {
      const notes = state.notes.filter((note) => note.id !== noteId);
      const trashNotes = state.trashNotes.filter((note) => note.id !== noteId);
      return {
        attachmentsByNote: omitRecordKey(state.attachmentsByNote, noteId),
        notes,
        presenceByNote: omitRecordKey(state.presenceByNote, noteId),
        selectedNoteId:
          state.selectedNoteId === noteId ? (notes[0]?.id ?? null) : state.selectedNoteId,
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
      eventCursor: 0,
      collaborationEvents: [],
      presenceByNote: {},
      openedSharingKey: null,
      newPassword: "",
      user: null,
      status: nextStatus
    });
  }
}));

function omitRecordKey<T>(record: Record<string, T>, keyToRemove: string): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== keyToRemove)
  );
}
