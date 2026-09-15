import { act } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { DecryptedNote } from "@client/store/appStore";
import { useAppStore } from "@client/store/appStore";

const mocks = vi.hoisted(() => ({
  createNote: vi.fn(),
  createProtectedNoteDraftV2: vi.fn(),
  deleteNote: vi.fn(),
  deleteFolder: vi.fn(),
  editCrdtNote: vi.fn(() => true),
  encrypt: vi.fn(),
  encryptNoteKey: vi.fn(),
  loadFolders: vi.fn(),
  loadNotes: vi.fn(),
  permanentlyDeleteNote: vi.fn(),
  updateNote: vi.fn()
}));

export { mocks };

vi.mock("@client/api", () => ({
  createFolder: vi.fn(),
  createNote: mocks.createNote,
  deleteFolder: mocks.deleteFolder,
  deleteNote: mocks.deleteNote,
  isApiRequestError: (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error,
  permanentlyDeleteNote: mocks.permanentlyDeleteNote,
  restoreNote: vi.fn(),
  updateNote: mocks.updateNote
}));

vi.mock("@client/cryptoClient", () => ({
  createProtectedNoteDraftV2: mocks.createProtectedNoteDraftV2,
  encryptFolderNameV2: vi.fn(),
  encryptNoteKeyEnvelopeV2: mocks.encryptNoteKey,
  encryptNoteTitleV2: mocks.encrypt,
  noteKeyToBase64: vi.fn()
}));

vi.mock("@client/hooks/useAppData", () => ({
  loadDecryptedNotes: mocks.loadNotes,
  loadFolders: mocks.loadFolders
}));

vi.mock("@client/realtime/crdt", () => ({
  editCrdtNote: mocks.editCrdtNote
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.encrypt.mockResolvedValue({
    cipher: "cipher",
    formatVersion: 2,
    nonce: "nonce"
  });
  mocks.encryptNoteKey.mockResolvedValue({
    cipher: "protected-note-key",
    formatVersion: 2,
    nonce: "protected-note-key-nonce"
  });
  mocks.createProtectedNoteDraftV2.mockResolvedValue({
    encryptedNoteKey: "encrypted-note-key",
    id: "new-note",
    noteKey: new Uint8Array([1, 2, 3]),
    noteKeyNonce: "note-key-nonce",
    rootSectionId: "root",
    titleCipher: "title-cipher",
    titleNonce: "title-nonce"
  });
  mocks.createNote.mockResolvedValue({
    id: "new-note",
    keyEpoch: 1,
    rootSectionId: "root",
    rootVersion: 1,
    version: 1
  });
  mocks.updateNote.mockResolvedValue({
    id: "note_1",
    rootVersion: 2,
    version: 2,
    updatedAt: "2026-07-02T00:00:01.000Z"
  });
  mocks.deleteNote.mockResolvedValue(undefined);
  mocks.deleteFolder.mockResolvedValue(undefined);
  mocks.loadNotes.mockResolvedValue(undefined);
  mocks.loadFolders.mockResolvedValue(undefined);
  mocks.permanentlyDeleteNote.mockResolvedValue(undefined);
  useAppStore.setState({
    error: null,
    folders: [
      {
        id: "folder-1",
        name: "Work",
        parentFolderId: null,
        createdAt: "",
        updatedAt: ""
      },
      {
        id: "folder-2",
        name: "Personal",
        parentFolderId: null,
        createdAt: "",
        updatedAt: ""
      }
    ],
    notes: [note()],
    notesView: "notes",
    rootKey: new Uint8Array([1]),
    selectedNoteId: "note_1",
    status: "Ready",
    user: { id: "alice", username: "alice" }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAppStore.getState().resetVaultState("reset");
});

export function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    contentLength: 0,
    cryptoOwnerId: "alice",
    folderId: null,
    id: "note_1",
    isDeleted: false,
    noteKeyBase64: "AQIDBA==",
    ownerUserId: "alice",
    role: "owner",
    rootSectionId: "section_1",
    rootVersion: 1,
    title: "Title",
    updatedAt: "2026-07-02T00:00:00.000Z",
    version: 1,
    keyEpoch: 1,
    ...overrides
  };
}

export async function advanceAutosave(): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(500));
}

export async function waitForAssertion(assertion: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}
