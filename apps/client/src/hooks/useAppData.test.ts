import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUserSharingKey, encryptFolderNameV2 } from "../cryptoClient";
import {
  getCurrentSharingKey,
  getNote,
  listFolders,
  listNotes,
  storeCurrentSharingKey,
  updateFolder,
  type NoteSummary,
  type User
} from "../api";
import { decryptNoteSummary } from "../lib/keyMaterial";
import { useAppStore } from "../store/appStore";
import {
  ensureLegacyNoteMigrated,
  ensureSharingKey,
  loadDecryptedNote,
  loadDecryptedNotes,
  loadFolders
} from "./useAppData";

const migrationMocks = vi.hoisted(() => ({
  createManifest: vi.fn(),
  decryptBody: vi.fn(),
  editNote: vi.fn(),
  getLegacyContent: vi.fn(),
  initializeSection: vi.fn(),
  openSection: vi.fn(),
  replaceOrder: vi.fn(),
  reserveSection: vi.fn(),
  seedLegacySection: vi.fn(),
  waitDurable: vi.fn(),
  waitReady: vi.fn()
}));

vi.mock("../api", () => ({
  getCurrentSharingKey: vi.fn(),
  getLegacyNoteContent: migrationMocks.getLegacyContent,
  getNote: vi.fn(),
  initializeNoteSection: migrationMocks.initializeSection,
  listFolders: vi.fn(),
  listNotes: vi.fn(),
  reserveLegacyRootSection: migrationMocks.reserveSection,
  storeCurrentSharingKey: vi.fn(),
  updateFolder: vi.fn()
}));

vi.mock("../cryptoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cryptoClient")>()),
  decryptNoteBodyWithKey: migrationMocks.decryptBody
}));

vi.mock("../realtime/crdt", () => ({
  createCrdtSectionInitializationManifest: migrationMocks.createManifest,
  editCrdtNote: migrationMocks.editNote,
  openCrdtSection: migrationMocks.openSection,
  preserveCrdtContent: <T>(note: T) => note,
  replaceCrdtSectionOrder: migrationMocks.replaceOrder,
  seedLegacyCrdtSection: migrationMocks.seedLegacySection,
  waitForCrdtSectionDurable: migrationMocks.waitDurable,
  waitForCrdtSectionReady: migrationMocks.waitReady
}));

vi.mock("../lib/keyMaterial", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/keyMaterial")>()),
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
    migrationMocks.createManifest.mockResolvedValue({ manifestId: "manifest-1" });
    migrationMocks.decryptBody.mockResolvedValue("legacy body");
    migrationMocks.editNote.mockReturnValue(true);
    migrationMocks.getLegacyContent.mockResolvedValue({
      contentCipher: "legacy-cipher",
      contentNonce: "legacy-nonce",
      contentLength: 11,
      version: 1,
      rootVersion: 1,
      keyEpoch: 1
    });
    migrationMocks.initializeSection.mockResolvedValue({
      status: "installed",
      manifestId: "manifest-1",
      rootVersion: 2,
      version: 2
    });
    migrationMocks.openSection.mockReturnValue({ provider: {}, generation: 1 });
    migrationMocks.replaceOrder.mockReturnValue(true);
    migrationMocks.reserveSection.mockResolvedValue({
      status: "reserved",
      sectionId: "section-1",
      keyEpoch: 1,
      rootVersion: 2,
      version: 2
    });
    migrationMocks.waitDurable.mockResolvedValue(undefined);
    migrationMocks.waitReady.mockResolvedValue(undefined);
    useAppStore.getState().resetVaultState("test reset");
  });

  it("opens and upgrades an existing v1 sharing key envelope", async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const created = await createUserSharingKey(rootKey);
    useAppStore.setState({ rootKey, user: currentUser() });
    mockedGetCurrentSharingKey.mockResolvedValue({
      ...created.payload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const opened = await ensureSharingKey(rootKey);

    expect(opened).toEqual(created.opened);
    expect(useAppStore.getState().openedSharingKey).toEqual(created.opened);
    expect(mockedStoreCurrentSharingKey).toHaveBeenCalledWith(
      expect.objectContaining({
        sharingKeyVersion: created.opened.sharingKeyVersion,
        publicKey: created.opened.publicKey,
        formatVersion: 2
      })
    );
  });

  it("keeps a v1 sharing key open when its v2 migration must be retried", async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const created = await createUserSharingKey(rootKey);
    useAppStore.setState({ rootKey, user: currentUser() });
    mockedGetCurrentSharingKey.mockResolvedValue({
      ...created.payload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    mockedStoreCurrentSharingKey.mockRejectedValueOnce(new Error("offline"));

    await expect(ensureSharingKey(rootKey)).resolves.toEqual(created.opened);

    expect(useAppStore.getState().openedSharingKey).toEqual(created.opened);
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
    vi.mocked(getNote).mockResolvedValue(noteSummary({
      id: "target",
      title: "Encrypted title",
      updatedAt: "2026-07-03T00:00:00.000Z",
      version: 2
    }));
    mockedDecryptNoteSummary.mockResolvedValue(decryptedNote({
      id: "target",
      title: "Remote title",
      updatedAt: "2026-07-03T00:00:00.000Z",
      version: 2
    }));

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

  it("migrates one legacy body through a resumable CAS initialization", async () => {
    const legacy = decryptedNote({
      id: "legacy-note",
      legacyContentAvailable: true,
      legacyBodyLoaded: false,
      rootSectionId: null,
      rootVersion: 1
    });
    useAppStore.setState({
      rootKey: new Uint8Array([1]),
      user: currentUser(),
      notes: [legacy],
      selectedNoteId: legacy.id
    });

    await ensureLegacyNoteMigrated(legacy);

    expect(migrationMocks.decryptBody).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: legacy.id, noteKeyBase64: legacy.noteKeyBase64 })
    );
    expect(migrationMocks.openSection).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ rootSectionId: "section-1" }),
      "root"
    );
    expect(migrationMocks.openSection).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ rootSectionId: "section-1" }),
      "section-1"
    );
    expect(migrationMocks.seedLegacySection).toHaveBeenCalledWith(
      expect.objectContaining({ rootSectionId: "section-1" }),
      "section-1",
      "legacy body"
    );
    expect(migrationMocks.replaceOrder).toHaveBeenCalledWith(
      legacy.id,
      ["section-1"]
    );
    expect(migrationMocks.initializeSection).toHaveBeenCalledWith(
      legacy.id,
      "section-1",
      {
        manifestId: "manifest-1",
        expectedKeyEpoch: 1,
        expectedRootVersion: 2
      }
    );
    expect(useAppStore.getState().notes[0]).toMatchObject({
      contentLength: 0,
      legacyBodyLoaded: false,
      legacyContentAvailable: false,
      rootSectionId: "section-1",
      rootVersion: 2,
      version: 2
    });
  });

  it("finalizes another client's committed migration without reseeding content", async () => {
    const legacy = decryptedNote({
      id: "pending-legacy-note",
      legacyContentAvailable: true,
      rootSectionId: null,
      rootVersion: 1
    });
    migrationMocks.reserveSection.mockResolvedValueOnce({
      status: "pending",
      sectionId: "winning-section",
      keyEpoch: 1,
      rootVersion: 2,
      version: 2,
      manifestId: "winning-manifest"
    });
    migrationMocks.initializeSection.mockResolvedValueOnce({
      status: "installed",
      manifestId: "winning-manifest",
      rootVersion: 2,
      version: 2
    });
    useAppStore.setState({
      rootKey: new Uint8Array([1]),
      user: currentUser(),
      notes: [legacy]
    });

    await ensureLegacyNoteMigrated(legacy);

    expect(migrationMocks.openSection).not.toHaveBeenCalled();
    expect(migrationMocks.createManifest).not.toHaveBeenCalled();
    expect(migrationMocks.initializeSection).toHaveBeenCalledWith(
      legacy.id,
      "winning-section",
      expect.objectContaining({ manifestId: "winning-manifest" })
    );
    expect(useAppStore.getState().notes[0]).toMatchObject({
      legacyContentAvailable: false,
      rootSectionId: "winning-section"
    });
  });

  it("opens legacy content read-only for viewers without reserving a section", async () => {
    const legacy = decryptedNote({
      id: "legacy-viewer-note",
      legacyContentAvailable: true,
      role: "viewer",
      rootSectionId: null
    });
    useAppStore.setState({
      rootKey: new Uint8Array([1]),
      user: currentUser(),
      notes: [legacy]
    });

    await ensureLegacyNoteMigrated(legacy);

    expect(migrationMocks.reserveSection).not.toHaveBeenCalled();
    expect(migrationMocks.seedLegacySection).toHaveBeenCalledWith(
      expect.objectContaining({ id: legacy.id }),
      "root",
      "legacy body"
    );
    expect(useAppStore.getState().notes[0]).toMatchObject({
      legacyBodyLoaded: true,
      legacyContentAvailable: true
    });
    expect(useAppStore.getState().notes[0]).not.toHaveProperty("body");
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
          name: "",
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
        name: "Private folder",
        metadataMigration: "current"
      })
    ]);
  });

  it("retains a retry marker when legacy folder migration cannot be written", async () => {
    const user = currentUser();
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    useAppStore.setState({ rootKey, user });
    vi.mocked(listFolders).mockResolvedValue({
      folders: [
        {
          id: crypto.randomUUID(),
          name: "Legacy folder",
          nameCipher: null,
          nameNonce: null,
          nameFormatVersion: null,
          parentFolderId: null,
          createdAt: "2026-07-02T00:00:00.000Z",
          updatedAt: "2026-07-02T00:00:00.000Z"
        }
      ]
    });
    vi.mocked(updateFolder).mockRejectedValueOnce(new Error("offline"));

    await loadFolders();

    expect(useAppStore.getState().folders[0]).toMatchObject({
      name: "Legacy folder",
      metadataMigration: "retry-required"
    });
    expect(vi.mocked(updateFolder)).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({ name: "Legacy folder" })
    );
  });
});

function currentUser(): User {
  return { id: "alice-id", username: "alice" };
}

function mockedListNotesWith(...notes: NoteSummary[]) {
  vi.mocked(listNotes).mockResolvedValue({ notes });
  mockedDecryptNoteSummary.mockImplementation((_user, _rootKey, note) =>
    Promise.resolve({
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
    contentLength: 1,
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

function decryptedNote(
  overrides: Partial<Awaited<ReturnType<typeof decryptNoteSummary>>>
): Awaited<ReturnType<typeof decryptNoteSummary>> {
  return {
    contentLength: 1,
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
