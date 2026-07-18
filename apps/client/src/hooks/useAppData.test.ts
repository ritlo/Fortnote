import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUserSharingKey } from "../cryptoClient";
import {
  getCurrentSharingKey,
  listFolders,
  listNotes,
  storeCurrentSharingKey,
  type NoteSummary,
  type User
} from "../api";
import { decryptNoteSummary } from "../lib/keyMaterial";
import { useAppStore } from "../store/appStore";
import { ensureSharingKey, loadDecryptedNotes } from "./useAppData";

vi.mock("../api", () => ({
  getCurrentSharingKey: vi.fn(),
  listFolders: vi.fn(),
  listNotes: vi.fn(),
  storeCurrentSharingKey: vi.fn()
}));

vi.mock("../lib/keyMaterial", () => ({
  decryptNoteSummary: vi.fn()
}));

const mockedGetCurrentSharingKey = vi.mocked(getCurrentSharingKey);
const mockedDecryptNoteSummary = vi.mocked(decryptNoteSummary);
const mockedStoreCurrentSharingKey = vi.mocked(storeCurrentSharingKey);
vi.mocked(listFolders).mockResolvedValue({ folders: [] });
vi.mocked(listNotes).mockResolvedValue({ notes: [] });

describe("app data collaboration bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().resetVaultState("test reset");
  });

  it("opens an existing sharing key envelope", async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const created = await createUserSharingKey(rootKey);
    mockedGetCurrentSharingKey.mockResolvedValue({
      ...created.payload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const opened = await ensureSharingKey(rootKey);

    expect(opened).toEqual(created.opened);
    expect(useAppStore.getState().openedSharingKey).toEqual(created.opened);
    expect(mockedStoreCurrentSharingKey).not.toHaveBeenCalled();
  });

  it("creates and stores a sharing key when none exists", async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    mockedGetCurrentSharingKey.mockRejectedValue(new Error("Sharing key not found"));
    mockedStoreCurrentSharingKey.mockResolvedValue({ sharingKeyVersion: 1 });

    const opened = await ensureSharingKey(rootKey);

    expect(opened.sharingKeyVersion).toBe(1);
    expect(opened.privateKey).toEqual(expect.any(String));
    expect(opened.publicKey).toEqual(expect.any(String));
    expect(mockedStoreCurrentSharingKey).toHaveBeenCalledWith(
      expect.objectContaining({
        sharingKeyVersion: 1,
        publicKey: opened.publicKey,
        encryptedPrivateKey: expect.any(String),
        privateKeyNonce: expect.any(String),
        formatVersion: 1
      })
    );
    expect(useAppStore.getState().openedSharingKey).toEqual(opened);
  });

  it("selects the newest note by default after loading notes", async () => {
    const user = currentUser();
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    useAppStore.setState({ rootKey, user });
    mockedListNotesWith(
      noteSummary({ id: "older", updatedAt: "2026-07-02T09:00:00.000Z" }),
      noteSummary({ id: "newer", updatedAt: "2026-07-02T10:00:00.000Z" })
    );

    await loadDecryptedNotes(user, rootKey);

    expect(useAppStore.getState().selectedNoteId).toBe("newer");
  });

  it("preserves the current selection during realtime note reloads", async () => {
    const user = currentUser();
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    useAppStore.setState({ rootKey, user });
    mockedListNotesWith(
      noteSummary({ id: "older", updatedAt: "2026-07-02T09:00:00.000Z" }),
      noteSummary({ id: "newer", updatedAt: "2026-07-02T10:00:00.000Z" })
    );
    useAppStore.getState().setSelectedNoteId("older");

    await loadDecryptedNotes(user, rootKey, false, { preserveSelection: true });

    expect(useAppStore.getState().selectedNoteId).toBe("older");
  });

  it("does not clear a trash selection while reloading active notes", async () => {
    const user = currentUser();
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    useAppStore.setState({ rootKey, user });
    mockedListNotesWith(noteSummary({ id: "active-note" }));
    useAppStore.getState().setNotesView("trash");
    useAppStore.getState().setSelectedNoteId("deleted-note");

    await loadDecryptedNotes(user, rootKey, false, { preserveSelection: true });

    expect(useAppStore.getState().selectedNoteId).toBe("deleted-note");
  });

  it("does not restore decrypted notes after the vault is locked", async () => {
    const user = currentUser();
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    let finishLoad!: (value: { notes: NoteSummary[] }) => void;
    vi.mocked(listNotes).mockImplementationOnce(
      () => new Promise((resolve) => {
        finishLoad = resolve;
      })
    );
    useAppStore.setState({ rootKey, user });

    const loading = loadDecryptedNotes(user, rootKey);
    useAppStore.getState().resetVaultState("Vault locked");
    finishLoad({ notes: [noteSummary({ id: "stale-note" })] });
    await loading;

    expect(useAppStore.getState().notes).toEqual([]);
    expect(useAppStore.getState().status).toBe("Vault locked");
  });
});

function currentUser(): User {
  return { id: "alice-id", username: "alice" };
}

function mockedListNotesWith(...notes: NoteSummary[]) {
  vi.mocked(listNotes).mockResolvedValue({ notes });
  mockedDecryptNoteSummary.mockImplementation((_user, _rootKey, note) =>
    Promise.resolve({
      body: `Body for ${note.id}`,
      contentLength: note.contentLength,
      cryptoOwnerId: note.cryptoOwnerId,
      folderId: note.folderId,
      id: note.id,
      isDeleted: Boolean(note.isDeleted),
      noteKeyBase64: "note-key",
      ownerUserId: note.ownerUserId,
      role: note.role,
      title: note.title,
      updatedAt: note.updatedAt,
      version: note.version,
      keyEpoch: note.keyEpoch
    })
  );
}

function noteSummary(overrides: Partial<NoteSummary>): NoteSummary {
  return {
    contentCipher: "cipher",
    contentLength: 1,
    contentNonce: "nonce",
    cryptoOwnerId: "alice-id",
    encryptedNoteKey: "encrypted-key",
    folderId: null,
    id: "note-id",
    isDeleted: false,
    noteKeyNonce: "note-key-nonce",
    ownerUserId: "alice-id",
    role: "owner",
    title: "Note",
    updatedAt: "2026-07-02T00:00:00.000Z",
    version: 1,
    keyEpoch: 1,
    ...overrides
  };
}
