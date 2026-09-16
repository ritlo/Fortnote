import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUserSharingKey, encryptFolderNameV2 } from "@client/cryptoClient";
import {
  getCurrentSharingKey,
  getNote,
  listFolders,
  listNotes,
  storeCurrentSharingKey,
  type NoteSummary,
  type User
} from "@client/api";
import { decryptNoteSummary } from "@client/lib/keyMaterial";
import { useAppStore } from "@client/store/appStore";
import {
  ensureSharingKey,
  loadDecryptedNote,
  loadDecryptedNotes,
  loadFolders
} from "@client/hooks/useAppData";

vi.mock("@client/api", () => ({
  getCurrentSharingKey: vi.fn(),
  getNote: vi.fn(),
  listFolders: vi.fn(),
  listNotes: vi.fn(),
  storeCurrentSharingKey: vi.fn()
}));

vi.mock("@client/realtime/crdt", () => ({
  preserveCrdtContent: <T>(note: T) => note
}));

vi.mock("@client/lib/keyMaterial", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@client/lib/keyMaterial")>()),
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
    mockedStoreCurrentSharingKey.mockReset();
    mockedStoreCurrentSharingKey.mockResolvedValue({ sharingKeyVersion: 1 });
    useAppStore.getState().resetVaultState("test reset");
  });

  it("opens an existing sharing key envelope", async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const created = await createUserSharingKey(rootKey, 1, currentUser().id);
    useAppStore.setState({ rootKey, user: currentUser() });
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
    useAppStore.setState({ rootKey, user: currentUser() });
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
        formatVersion: 2
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

  it("loads note metadata without transferring or retaining section bodies", async () => {
    const user = currentUser();
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const summary = noteSummary({ id: "body-free" });
    useAppStore.setState({ rootKey, user });
    mockedListNotesWith(summary);

    await loadDecryptedNotes(user, rootKey);

    expect(summary).not.toHaveProperty("contentCipher");
    expect(summary).not.toHaveProperty("contentNonce");
    expect(mockedDecryptNoteSummary).toHaveBeenCalledOnce();
    expect(mockedDecryptNoteSummary.mock.calls[0]?.[2]).toBe(summary);
    expect(useAppStore.getState().notes).toEqual([
      expect.not.objectContaining({ body: expect.anything() })
    ]);
    expect(useAppStore.getState().notes[0]?.id).toBe("body-free");
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

  it("ignores an older note-list response that finishes after a newer reload", async () => {
    const user = currentUser();
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    let finishFirst!: (value: { notes: NoteSummary[] }) => void;
    let finishSecond!: (value: { notes: NoteSummary[] }) => void;
    vi.mocked(listNotes)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          })
      );
    useAppStore.setState({ rootKey, user });

    const firstLoad = loadDecryptedNotes(user, rootKey);
    const secondLoad = loadDecryptedNotes(user, rootKey, false, {
      preserveSelection: true
    });
    finishSecond({ notes: [noteSummary({ id: "newer", titleCipher: "Newer" })] });
    await secondLoad;
    finishFirst({ notes: [noteSummary({ id: "older", titleCipher: "Older" })] });
    await firstLoad;

    expect(useAppStore.getState().notes).toEqual([
      expect.objectContaining({ id: "newer", title: "Newer" })
    ]);
  });

  it("retains a note created while the list request was in flight", async () => {
    const user = currentUser();
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    let finishLoad!: (value: { notes: NoteSummary[] }) => void;
    vi.mocked(listNotes).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        })
    );
    const created = decryptedNote({
      id: "created-during-load",
      title: "Created locally",
      updatedAt: "2026-07-02T11:00:00.000Z"
    });
    useAppStore.setState({ rootKey, user });

    const loading = loadDecryptedNotes(user, rootKey);
    useAppStore.getState().setNotes([created]);
    finishLoad({ notes: [noteSummary({ id: "remote" })] });
    await loading;

    expect(useAppStore.getState().notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "remote" }),
        expect.objectContaining({ id: "created-during-load", title: "Created locally" })
      ])
    );
  });

  it("reloads only the targeted note metadata without clearing unrelated state", async () => {
    const user = currentUser();
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const existing = decryptedNote({ id: "target", title: "Old title" });
    const untouched = decryptedNote({ id: "untouched", title: "Untouched" });
    useAppStore.setState({
      rootKey,
      user,
      notes: [existing, untouched],
      selectedNoteId: "target",
      attachmentsByNote: { target: [], untouched: [] }
    });
    vi.mocked(getNote).mockResolvedValue(
      noteSummary({
        id: "target",
        titleCipher: "Encrypted title",
        updatedAt: "2026-07-03T00:00:00.000Z",
        version: 2
      })
    );
    mockedDecryptNoteSummary.mockResolvedValue(
      decryptedNote({
        id: "target",
        title: "Remote title",
        updatedAt: "2026-07-03T00:00:00.000Z",
        version: 2
      })
    );

    await loadDecryptedNote(user, rootKey, "target");

    expect(getNote).toHaveBeenCalledWith("target");
    expect(listNotes).not.toHaveBeenCalled();
    expect(useAppStore.getState().notes).toEqual([
      expect.objectContaining({ id: "target", title: "Remote title", version: 2 }),
      untouched
    ]);
    expect(useAppStore.getState().selectedNoteId).toBe("target");
    expect(useAppStore.getState().attachmentsByNote).toEqual({
      target: [],
      untouched: []
    });
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
      () =>
        new Promise((resolve) => {
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

  it("decrypts protected folder names without exposing them in list data", async () => {
    const user = currentUser();
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const folderId = crypto.randomUUID();
    const encrypted = await encryptFolderNameV2({
      userId: user.id,
      folderId,
      rootKey,
      name: "Private folder"
    });
    useAppStore.setState({ rootKey, user });
    vi.mocked(listFolders).mockResolvedValue({
      folders: [
        {
          id: folderId,
          nameCipher: encrypted.cipher,
          nameNonce: encrypted.nonce,
          nameFormatVersion: 2,
          parentFolderId: null,
          createdAt: "2026-07-02T00:00:00.000Z",
          updatedAt: "2026-07-02T00:00:00.000Z"
        }
      ]
    });

    await loadFolders();

    expect(useAppStore.getState().folders).toEqual([
      expect.objectContaining({
        id: folderId,
        name: "Private folder"
      })
    ]);
  });

  it("rejects folder names that are not protected v2 envelopes", async () => {
    useAppStore.setState({
      rootKey: crypto.getRandomValues(new Uint8Array(32)),
      user: currentUser()
    });
    vi.mocked(listFolders).mockResolvedValue({
      folders: [
        {
          id: crypto.randomUUID(),
          nameCipher: "cipher",
          nameNonce: "nonce",
          nameFormatVersion: 1,
          parentFolderId: null,
          createdAt: "2026-07-02T00:00:00.000Z",
          updatedAt: "2026-07-02T00:00:00.000Z"
        }
      ]
    });

    await expect(loadFolders()).rejects.toThrow("Protected folder name is incomplete");
  });
});

function currentUser(): User {
  return { id: "alice-id", username: "alice" };
}

function mockedListNotesWith(...notes: NoteSummary[]) {
  vi.mocked(listNotes).mockResolvedValue({ notes });
  mockedDecryptNoteSummary.mockImplementation((_user, _rootKey, note) =>
    Promise.resolve({
      cryptoOwnerId: note.cryptoOwnerId,
      folderId: note.folderId,
      id: note.id,
      isDeleted: Boolean(note.isDeleted),
      noteKeyBase64: "note-key",
      ownerUserId: note.ownerUserId,
      role: note.role,
      title: note.titleCipher,
      updatedAt: note.updatedAt,
      version: note.version,
      keyEpoch: note.keyEpoch
    })
  );
}

function noteSummary(overrides: Partial<NoteSummary>): NoteSummary {
  return {
    cryptoOwnerId: "alice-id",
    encryptedNoteKey: "encrypted-key",
    folderId: null,
    id: "note-id",
    isDeleted: false,
    noteKeyNonce: "note-key-nonce",
    ownerUserId: "alice-id",
    role: "owner",
    rootSectionId: "section-id",
    titleCipher: "Note",
    titleNonce: "title-nonce",
    titleFormatVersion: 2,
    updatedAt: "2026-07-02T00:00:00.000Z",
    version: 1,
    keyEpoch: 1,
    ...overrides
  };
}

function decryptedNote(
  overrides: Partial<Awaited<ReturnType<typeof decryptNoteSummary>>>
): Awaited<ReturnType<typeof decryptNoteSummary>> {
  return {
    cryptoOwnerId: "alice-id",
    folderId: null,
    id: "note-id",
    isDeleted: false,
    noteKeyBase64: "note-key",
    ownerUserId: "alice-id",
    role: "owner",
    title: "Note",
    updatedAt: "2026-07-02T00:00:00.000Z",
    version: 1,
    keyEpoch: 1,
    ...overrides
  };
}
