import { FileText, Folder, Lock, LogOut, Plus, Search, Settings } from "lucide-react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import {
  createNote,
  createFolder,
  deleteAttachment,
  deleteFolder,
  deleteNote,
  downloadAttachment,
  getAuthKdfParams,
  getKeyMaterial,
  getMe,
  getRecoveryParams,
  listFolders,
  listAttachments,
  listNotes,
  permanentlyDeleteNote,
  recover,
  login,
  logout,
  register,
  restoreNote,
  updateNote,
  updateKeyMaterial,
  uploadAttachment,
  type AttachmentSummary,
  type FolderSummary,
  type AuthKdfResponse,
  type KeyMaterialResponse,
  type NoteSummary,
  type RecoveryParamsResponse,
  type User
} from "./api";
import {
  createAccountRecoveryCrypto,
  createEncryptedNoteDraft,
  createEncryptedAttachmentDraft,
  createLoginAuthVerifier,
  createPasswordChangeCrypto,
  createRegistrationCrypto,
  createRecoveryRotationCrypto,
  decryptAttachmentBytes,
  decryptNote,
  encryptExistingNoteBody,
  noteKeyToBase64,
  openVault
} from "./cryptoClient";
import "./styles.css";

type AuthMode = "login" | "register" | "recover";
type NotesView = "notes" | "trash" | "settings";

interface DecryptedNote {
  id: string;
  folderId: string | null;
  title: string;
  body: string;
  noteKeyBase64: string;
  contentLength: number;
  version: number;
  isDeleted: boolean;
  updatedAt: string;
}

type StateUpdate<T> = T | ((current: T) => T);
type StoreSetter<T> = (value: StateUpdate<T>) => void;

interface AppStore {
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
  setError: StoreSetter<string | null>;
  setStatus: StoreSetter<string>;
}

function resolveState<T>(value: StateUpdate<T>, current: T): T {
  return typeof value === "function" ? (value as (current: T) => T)(current) : value;
}

const useAppStore = create<AppStore>((set) => ({
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
  setError: (value) => {
    set((state) => ({ error: resolveState(value, state.error) }));
  },
  setStatus: (value) => {
    set((state) => ({ status: resolveState(value, state.status) }));
  }
}));

export function App() {
  const {
    user,
    rootKey,
    keyMaterialVersion,
    authMode,
    username,
    password,
    newPassword,
    recoveryInput,
    recoveryNewPassword,
    notes,
    trashNotes,
    folders,
    notesView,
    selectedFolderId,
    attachmentsByNote,
    selectedNoteId,
    search,
    recoverySecret,
    error,
    status,
    setUser,
    setRootKey,
    setKeyMaterialVersion,
    setAuthMode,
    setUsername,
    setPassword,
    setNewPassword,
    setRecoveryInput,
    setRecoveryNewPassword,
    setNotes,
    setTrashNotes,
    setFolders,
    setNotesView,
    setSelectedFolderId,
    setAttachmentsByNote,
    setSelectedNoteId,
    setSearch,
    setRecoverySecret,
    setError,
    setStatus
  } = useAppStore();

  useEffect(() => {
    void getMe()
      .then((currentUser) => {
        setUsername(currentUser.username);
        setStatus("Session active. Sign in again to decrypt");
      })
      .catch(() => {
        setStatus("Signed out");
      });
  }, []);

  const visibleSourceNotes =
    notesView === "trash" ? trashNotes : notesView === "settings" ? [] : notes;

  const folderFilteredNotes =
    notesView === "trash" || !selectedFolderId
      ? visibleSourceNotes
      : visibleSourceNotes.filter((note) => note.folderId === selectedFolderId);

  const selectedNote = useMemo(
    () => visibleSourceNotes.find((note) => note.id === selectedNoteId) ?? null,
    [selectedNoteId, visibleSourceNotes]
  );

  const selectedAttachments = selectedNoteId
    ? attachmentsByNote[selectedNoteId] ?? []
    : [];

  const filteredNotes = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return folderFilteredNotes;
    }

    return folderFilteredNotes.filter(
      (note) =>
        note.title.toLowerCase().includes(query) ||
        note.body.toLowerCase().includes(query)
    );
  }, [folderFilteredNotes, search]);

  const previewHtml = useMemo(
    () => renderMarkdown(selectedNote?.body ?? "Select or create a note."),
    [selectedNote?.body]
  );

  useEffect(() => {
    if (!selectedNoteId || attachmentsByNote[selectedNoteId]) {
      return;
    }

    void listAttachments(selectedNoteId)
      .then((payload) => {
        setAttachmentsByNote((current) => ({
          ...current,
          [selectedNoteId]: payload.attachments
        }));
      })
      .catch((attachmentError: unknown) => {
        setStatus("Attachment load failed");
        setError(
          attachmentError instanceof Error
            ? attachmentError.message
            : "Unable to load attachments"
        );
      });
  }, [attachmentsByNote, selectedNoteId]);

  async function loadDecryptedNotes(
    currentUser: User,
    currentRootKey: Uint8Array,
    deleted = false
  ) {
    const payload = await listNotes(deleted);
    const decrypted = await Promise.all(
      payload.notes
        .filter((note) => Boolean(note.isDeleted) === deleted)
        .map((note) => decryptNoteSummary(currentUser, currentRootKey, note))
    );
    const nextNotes = decrypted.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
    if (deleted) {
      setTrashNotes(nextNotes);
    } else {
      setNotes(nextNotes);
    }
    setSelectedNoteId(nextNotes[0]?.id ?? null);
    setAttachmentsByNote({});
  }

  async function loadFolders() {
    const payload = await listFolders();
    setFolders(payload.folders);
  }

  async function submitAuth() {
    setError(null);
    setRecoverySecret(null);
    setStatus("Deriving keys");
    try {
      if (authMode === "register") {
        const registration = await createRegistrationCrypto(username, password);
        const currentUser = await register(registration.payload);
        setUser(currentUser);
        setRootKey(registration.rootKey);
        setKeyMaterialVersion(1);
        setRecoverySecret(registration.recoverySecret);
        setStatus("Signed in and decrypted");
        await loadFolders();
        await loadDecryptedNotes(currentUser, registration.rootKey);
        return;
      }

      if (authMode === "recover") {
        const recoveryParams = await getRecoveryParams(username);
        const recovery = await createAccountRecoveryCrypto({
          recoverySecret: recoveryInput,
          recoveryKdf: recoveryKdf(recoveryParams),
          recoveryEncryptedRootKey: recoveryParams.recoveryEncryptedRootKey,
          recoveryRootKeyNonce: recoveryParams.recoveryRootKeyNonce,
          newPassword: recoveryNewPassword
        });
        const currentUser = await recover({
          username,
          recoveryAuthVerifier: recovery.recoveryAuthVerifier,
          newAuthVerifier: recovery.passwordChange.authVerifier,
          authKdf: recovery.passwordChange.authKdf,
          vaultKdf: recovery.passwordChange.vaultKdf,
          encryptedRootKey: recovery.passwordChange.encryptedRootKey,
          rootKeyNonce: recovery.passwordChange.rootKeyNonce,
          keyMaterialVersion: recoveryParams.keyMaterialVersion
        });
        setUser(currentUser);
        setRootKey(recovery.rootKey);
        setKeyMaterialVersion(recoveryParams.keyMaterialVersion + 1);
        setPassword(recoveryNewPassword);
        setRecoveryInput("");
        setRecoveryNewPassword("");
        setStatus("Recovered and decrypted");
        await loadFolders();
        await loadDecryptedNotes(currentUser, recovery.rootKey);
        return;
      }

      const kdf = await getAuthKdfParams(username);
      const authVerifier = await createLoginAuthVerifier(password, authKdf(kdf));
      const currentUser = await login(username, authVerifier);
      const keyMaterial = await getKeyMaterial();
      const openedVault = await openVault(
        password,
        authKdf(kdf),
        vaultKdf(keyMaterial),
        keyMaterial.encryptedRootKey,
        keyMaterial.rootKeyNonce
      );
      setUser(currentUser);
      setRootKey(openedVault.rootKey);
      setKeyMaterialVersion(keyMaterial.keyMaterialVersion);
      setStatus("Signed in and decrypted");
      await loadFolders();
      await loadDecryptedNotes(currentUser, openedVault.rootKey);
    } catch (authError) {
      setStatus("Auth failed");
      setError(authError instanceof Error ? authError.message : "Unable to sign in");
    }
  }

  async function submitLogout() {
    await logout();
    setUser(null);
    setRootKey(null);
    setKeyMaterialVersion(null);
    setNotes([]);
    setTrashNotes([]);
    setFolders([]);
    setAttachmentsByNote({});
    setSelectedNoteId(null);
    setSelectedFolderId(null);
    setNotesView("notes");
    setRecoverySecret(null);
    setNewPassword("");
    setStatus("Signed out");
  }

  async function addNote() {
    if (!user || !rootKey) {
      return;
    }

    setError(null);
    setStatus("Encrypting note");
    try {
      const draft = await createEncryptedNoteDraft({
        userId: user.id,
        rootKey,
        title: "Untitled note",
        body: ""
      });
      const created = await createNote({
        id: draft.id,
        folderId: selectedFolderId,
        title: draft.title,
        encryptedNoteKey: draft.encryptedNoteKey,
        noteKeyNonce: draft.noteKeyNonce,
        contentCipher: draft.contentCipher,
        contentNonce: draft.contentNonce,
        contentLength: draft.contentLength
      });
      const note: DecryptedNote = {
        id: draft.id,
        folderId: selectedFolderId,
        title: draft.title,
        body: "",
        noteKeyBase64: noteKeyToBase64(draft.noteKey),
        contentLength: draft.contentLength,
        version: created.version,
        isDeleted: false,
        updatedAt: new Date().toISOString()
      };
      setNotes((current) => [note, ...current]);
      setSelectedNoteId(note.id);
      setStatus("Note encrypted and saved");
    } catch (noteError) {
      setStatus("Save failed");
      setError(noteError instanceof Error ? noteError.message : "Unable to create note");
    }
  }

  async function saveSelectedNote() {
    if (!user || !selectedNote) {
      return;
    }

    setError(null);
    setStatus("Encrypting note");
    try {
      const encrypted = await encryptExistingNoteBody({
        userId: user.id,
        noteId: selectedNote.id,
        noteKeyBase64: selectedNote.noteKeyBase64,
        body: selectedNote.body
      });
      const saved = await updateNote(selectedNote.id, {
        title: selectedNote.title,
        folderId: selectedNote.folderId,
        version: selectedNote.version,
        ...encrypted
      });
      setNotes((current) =>
        current.map((note) =>
          note.id === selectedNote.id
            ? {
                ...note,
                contentLength: encrypted.contentLength,
                version: saved.version,
                updatedAt: new Date().toISOString()
              }
            : note
        )
      );
      setStatus("Note encrypted and saved");
    } catch (saveError) {
      setStatus("Save failed");
      setError(saveError instanceof Error ? saveError.message : "Unable to save note");
    }
  }

  function updateSelectedNote(
    patch: Partial<Pick<DecryptedNote, "folderId" | "title" | "body">>
  ) {
    if (!selectedNoteId) {
      return;
    }

    setNotes((current) =>
      current.map((note) => (note.id === selectedNoteId ? { ...note, ...patch } : note))
    );
  }

  async function refreshAttachments(noteId: string) {
    const payload = await listAttachments(noteId);
    setAttachmentsByNote((current) => ({
      ...current,
      [noteId]: payload.attachments
    }));
  }

  async function uploadSelectedAttachment(file: File | undefined) {
    if (!file || !user || !selectedNote) {
      return;
    }

    setError(null);
    setStatus("Encrypting attachment");
    try {
      const encrypted = await createEncryptedAttachmentDraft({
        userId: user.id,
        noteId: selectedNote.id,
        noteKeyBase64: selectedNote.noteKeyBase64,
        file
      });
      await uploadAttachment(selectedNote.id, encrypted);
      await refreshAttachments(selectedNote.id);
      setStatus("Attachment encrypted and saved");
    } catch (uploadError) {
      setStatus("Attachment failed");
      setError(
        uploadError instanceof Error ? uploadError.message : "Unable to upload attachment"
      );
    }
  }

  async function downloadSelectedAttachment(attachment: AttachmentSummary) {
    if (!user || !selectedNote) {
      return;
    }

    setError(null);
    setStatus("Decrypting attachment");
    try {
      const encrypted = await downloadAttachment(attachment.id);
      const plaintext = await decryptAttachmentBytes({
        userId: user.id,
        noteId: selectedNote.id,
        noteKeyBase64: selectedNote.noteKeyBase64,
        attachmentId: attachment.id,
        encryptedAttachmentKey: {
          cipher: encrypted.encryptedAttachmentKey,
          nonce: encrypted.attachmentKeyNonce,
          formatVersion: 1
        },
        encryptedBytes: {
          cipher: encrypted.encryptedBytes,
          nonce: encrypted.fileNonce,
          formatVersion: 1
        }
      });
      downloadBytes(plaintext, attachment.filename, attachment.mimeType);
      setStatus("Attachment decrypted");
    } catch (downloadError) {
      setStatus("Attachment failed");
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Unable to download attachment"
      );
    }
  }

  async function removeSelectedAttachment(attachmentId: string) {
    if (!selectedNote) {
      return;
    }

    setError(null);
    setStatus("Deleting attachment");
    try {
      await deleteAttachment(attachmentId);
      await refreshAttachments(selectedNote.id);
      setStatus("Attachment deleted");
    } catch (deleteError) {
      setStatus("Attachment failed");
      setError(
        deleteError instanceof Error ? deleteError.message : "Unable to delete attachment"
      );
    }
  }

  async function addFolder(parentFolderId: string | null = null) {
    const name = window.prompt("Folder name");
    if (!name?.trim()) {
      return;
    }

    setError(null);
    try {
      await createFolder({ name: name.trim(), parentFolderId });
      await loadFolders();
      setStatus("Folder created");
    } catch (folderError) {
      setStatus("Folder failed");
      setError(folderError instanceof Error ? folderError.message : "Unable to create folder");
    }
  }

  async function removeFolder(folderId: string) {
    setError(null);
    try {
      await deleteFolder(folderId);
      await loadFolders();
      if (selectedFolderId === folderId) {
        setSelectedFolderId(null);
      }
      setStatus("Folder deleted");
    } catch (folderError) {
      setStatus("Folder failed");
      setError(folderError instanceof Error ? folderError.message : "Unable to delete folder");
    }
  }

  async function openTrash() {
    if (!user || !rootKey) {
      return;
    }

    setNotesView("trash");
    setSelectedFolderId(null);
    await loadDecryptedNotes(user, rootKey, true);
  }

  function openNotes(folderId: string | null = selectedFolderId) {
    setNotesView("notes");
    setSelectedFolderId(folderId);
    const nextNotes = folderId ? notes.filter((note) => note.folderId === folderId) : notes;
    setSelectedNoteId(nextNotes[0]?.id ?? null);
  }

  async function moveSelectedToTrash() {
    if (!selectedNote) {
      return;
    }

    setError(null);
    try {
      await deleteNote(selectedNote.id);
      setNotes((current) => current.filter((note) => note.id !== selectedNote.id));
      setSelectedNoteId(notes.find((note) => note.id !== selectedNote.id)?.id ?? null);
      setStatus("Note moved to trash");
    } catch (deleteError) {
      setStatus("Delete failed");
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete note");
    }
  }

  async function restoreSelectedNote() {
    if (!user || !rootKey || !selectedNote) {
      return;
    }

    setError(null);
    try {
      await restoreNote(selectedNote.id);
      await loadDecryptedNotes(user, rootKey, true);
      await loadDecryptedNotes(user, rootKey, false);
      setStatus("Note restored");
    } catch (restoreError) {
      setStatus("Restore failed");
      setError(restoreError instanceof Error ? restoreError.message : "Unable to restore note");
    }
  }

  async function deleteSelectedForever() {
    if (!selectedNote) {
      return;
    }

    setError(null);
    try {
      await permanentlyDeleteNote(selectedNote.id);
      const nextTrash = trashNotes.filter((note) => note.id !== selectedNote.id);
      setTrashNotes(nextTrash);
      setSelectedNoteId(nextTrash[0]?.id ?? null);
      setStatus("Note permanently deleted");
    } catch (deleteError) {
      setStatus("Delete failed");
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete note");
    }
  }

  function lockVault() {
    setRootKey(null);
    setKeyMaterialVersion(null);
    setNotes([]);
    setTrashNotes([]);
    setFolders([]);
    setAttachmentsByNote({});
    setSelectedNoteId(null);
    setSelectedFolderId(null);
    setNotesView("notes");
    setRecoverySecret(null);
    setStatus("Vault locked. Sign in again to decrypt");
    setUser(null);
  }

  async function changePassword() {
    if (!rootKey || !newPassword.trim()) {
      return;
    }

    setError(null);
    setStatus("Rewrapping vault");
    try {
      const current = await getKeyMaterial();
      const rewrapped = await createPasswordChangeCrypto(rootKey, newPassword);
      const updated = await updateKeyMaterial({
        newAuthVerifier: rewrapped.authVerifier,
        authKdf: rewrapped.authKdf,
        encryptedRootKey: rewrapped.encryptedRootKey,
        rootKeyNonce: rewrapped.rootKeyNonce,
        vaultKdf: rewrapped.vaultKdf,
        keyMaterialVersion: current.keyMaterialVersion
      });
      setKeyMaterialVersion(updated.keyMaterialVersion);
      setPassword(newPassword);
      setNewPassword("");
      setStatus("Password changed and vault rewrapped");
    } catch (changeError) {
      setStatus("Password change failed");
      setError(
        changeError instanceof Error ? changeError.message : "Unable to change password"
      );
    }
  }

  async function rotateRecoveryKey() {
    if (!rootKey) {
      return;
    }

    setError(null);
    setStatus("Rotating recovery key");
    try {
      const current = await getKeyMaterial();
      const rotated = await createRecoveryRotationCrypto(rootKey);
      const updated = await updateKeyMaterial({
        encryptedRootKey: current.encryptedRootKey,
        rootKeyNonce: current.rootKeyNonce,
        vaultKdf: vaultKdf(current),
        recoveryAuthVerifier: rotated.recoveryAuthVerifier,
        recoveryKdf: rotated.recoveryKdf,
        recoveryEncryptedRootKey: rotated.recoveryEncryptedRootKey,
        recoveryRootKeyNonce: rotated.recoveryRootKeyNonce,
        keyMaterialVersion: current.keyMaterialVersion
      });
      setKeyMaterialVersion(updated.keyMaterialVersion);
      setRecoverySecret(rotated.recoverySecret);
      setStatus("Recovery key rotated");
    } catch (rotateError) {
      setStatus("Recovery rotation failed");
      setError(
        rotateError instanceof Error ? rotateError.message : "Unable to rotate recovery key"
      );
    }
  }

  if (!user) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <div className="brand-row">
            <div className="brand-mark">CN</div>
            <div>
              <h1>Fortnote</h1>
              <p>One password signs in and decrypts your vault locally.</p>
            </div>
          </div>

          <div className="segmented">
            <button
              className={authMode === "login" ? "active" : ""}
              type="button"
              onClick={() => {
                setAuthMode("login");
              }}
            >
              Sign in
            </button>
            <button
              className={authMode === "register" ? "active" : ""}
              type="button"
              onClick={() => {
                setAuthMode("register");
              }}
            >
              Register
            </button>
            <button
              className={authMode === "recover" ? "active" : ""}
              type="button"
              onClick={() => {
                setAuthMode("recover");
              }}
            >
              Recover
            </button>
          </div>

          <label>
            Username
            <input
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
            />
          </label>
          {authMode === "recover" ? (
            <>
              <label>
                Recovery key
                <input
                  value={recoveryInput}
                  onChange={(event) => {
                    setRecoveryInput(event.target.value);
                  }}
                />
              </label>
              <label>
                New account password
                <input
                  type="password"
                  value={recoveryNewPassword}
                  onChange={(event) => {
                    setRecoveryNewPassword(event.target.value);
                  }}
                />
              </label>
            </>
          ) : (
            <label>
              Account password
              <input
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </label>
          )}

          {error ? <p className="error">{error}</p> : null}
          <button
            className="primary"
            type="button"
            onClick={() => {
              void submitAuth();
            }}
          >
            {authMode === "register"
              ? "Create encrypted vault"
              : authMode === "recover"
                ? "Recover and decrypt"
                : "Sign in and decrypt"}
          </button>
          <p className="muted">{status}</p>
          {recoverySecret ? (
            <p className="recovery-code">Recovery key: {recoverySecret}</p>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row compact">
          <div className="brand-mark">CN</div>
          <strong>Fortnote</strong>
        </div>
        <button
          className={
            notesView === "notes" && selectedFolderId === null
              ? "nav-item active"
              : "nav-item"
          }
          type="button"
          onClick={() => {
            openNotes(null);
          }}
        >
          <Folder size={17} /> All notes
        </button>
        <button
          className="nav-item"
          type="button"
          onClick={() => {
            void addFolder();
          }}
        >
          <Plus size={17} /> New folder
        </button>
        <div className="folder-list">
          {folders
            .filter((folder) => folder.parentFolderId === null)
            .map((folder) => (
              <div key={folder.id}>
                <div className="folder-row">
                  <button
                    className={
                      selectedFolderId === folder.id && notesView === "notes"
                        ? "nav-item active"
                        : "nav-item"
                    }
                    type="button"
                    onClick={() => {
                      openNotes(folder.id);
                    }}
                  >
                    <Folder size={17} /> {folder.name}
                  </button>
                  <button
                    className="mini-button"
                    type="button"
                    aria-label={`Add child folder to ${folder.name}`}
                    onClick={() => {
                      void addFolder(folder.id);
                    }}
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    className="mini-button"
                    type="button"
                    aria-label={`Delete ${folder.name}`}
                    onClick={() => {
                      void removeFolder(folder.id);
                    }}
                  >
                    x
                  </button>
                </div>
                {folders
                  .filter((child) => child.parentFolderId === folder.id)
                  .map((child) => (
                    <div className="folder-row child" key={child.id}>
                      <button
                        className={
                          selectedFolderId === child.id && notesView === "notes"
                            ? "nav-item indented active"
                            : "nav-item indented"
                        }
                        type="button"
                        onClick={() => {
                          openNotes(child.id);
                        }}
                      >
                        <Folder size={17} /> {child.name}
                      </button>
                      <button
                        className="mini-button"
                        type="button"
                        aria-label={`Delete ${child.name}`}
                        onClick={() => {
                          void removeFolder(child.id);
                        }}
                      >
                        x
                      </button>
                    </div>
                  ))}
              </div>
            ))}
        </div>
        <button
          className={notesView === "trash" ? "nav-item active" : "nav-item"}
          type="button"
          onClick={() => {
            void openTrash();
          }}
        >
          <Lock size={17} /> Trash
        </button>
        <div className="sidebar-footer">
          <button
            className={notesView === "settings" ? "nav-item active" : "nav-item"}
            type="button"
            onClick={() => {
              setNotesView("settings");
              setSelectedNoteId(null);
              setSelectedFolderId(null);
            }}
          >
            <Settings size={17} /> Settings
          </button>
          <button
            className="nav-item"
            type="button"
            onClick={() => {
              void submitLogout();
            }}
          >
            <LogOut size={17} /> Logout
          </button>
        </div>
      </aside>

      <section className="notes-pane">
        <header className="pane-header">
          <h2>
            {notesView === "trash"
              ? "Trash"
              : notesView === "settings"
                ? "Settings"
                : "Notes"}
          </h2>
          <button
            className="icon-button"
            type="button"
            aria-label="New note"
            disabled={notesView !== "notes"}
            onClick={() => {
              void addNote();
            }}
          >
            <Plus size={18} />
          </button>
        </header>
        <div className="search">
          <Search size={16} />
          <input
            placeholder="Search decrypted notes"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="status-pill">{status}</div>
        {error ? <p className="pane-error">{error}</p> : null}
        {recoverySecret ? (
          <p className="recovery-code">Recovery key: {recoverySecret}</p>
        ) : null}
        <ul className="note-list">
          {filteredNotes.length === 0 ? (
            <li className="empty-state">
              {notesView === "trash"
                ? "Trash is empty."
                : notesView === "settings"
                  ? "Vault controls are open."
                  : "No notes match this view."}
            </li>
          ) : (
            filteredNotes.map((note) => (
              <li key={note.id}>
                <button
                  className={note.id === selectedNoteId ? "note-card active" : "note-card"}
                  type="button"
                  onClick={() => {
                    setSelectedNoteId(note.id);
                  }}
                >
                  <strong>{note.title}</strong>
                  <span>{String(note.contentLength)} encrypted bytes</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="editor-pane">
        <header className="pane-header">
          <div>
            <h2>
              {notesView === "settings"
                ? "Vault settings"
                : selectedNote?.title ?? "No note selected"}
            </h2>
            <p>
              {user.username} ·{" "}
              {keyMaterialVersion
                ? `key material v${String(keyMaterialVersion)}`
                : "root key in memory only"}
            </p>
          </div>
          {notesView === "settings" ? (
            <div className="action-row">
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  lockVault();
                }}
              >
                Lock vault
              </button>
            </div>
          ) : (
            <>
              <button
                className="primary"
                type="button"
                disabled={!selectedNote || notesView === "trash"}
                onClick={() => {
                  void saveSelectedNote();
                }}
              >
                Save
              </button>
              {notesView === "trash" ? (
                <div className="action-row">
                  <button
                    className="text-button"
                    type="button"
                    disabled={!selectedNote}
                    onClick={() => {
                      void restoreSelectedNote();
                    }}
                  >
                    Restore
                  </button>
                  <button
                    className="text-button danger"
                    type="button"
                    disabled={!selectedNote}
                    onClick={() => {
                      void deleteSelectedForever();
                    }}
                  >
                    Delete forever
                  </button>
                </div>
              ) : (
                <button
                  className="text-button danger"
                  type="button"
                  disabled={!selectedNote}
                  onClick={() => {
                    void moveSelectedToTrash();
                  }}
                >
                  Delete
                </button>
              )}
            </>
          )}
        </header>
        {notesView === "settings" ? (
          <div className="settings-panel">
            <section>
              <h3>Account password</h3>
              <label>
                New password
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => {
                    setNewPassword(event.target.value);
                  }}
                />
              </label>
              <button
                className="primary"
                type="button"
                disabled={!newPassword.trim()}
                onClick={() => {
                  void changePassword();
                }}
              >
                Change password
              </button>
            </section>
            <section>
              <h3>Recovery key</h3>
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  void rotateRecoveryKey();
                }}
              >
                Rotate recovery key
              </button>
              {recoverySecret ? (
                <p className="recovery-code">Recovery key: {recoverySecret}</p>
              ) : null}
            </section>
          </div>
        ) : (
          <div className="editor-grid">
          <div className="editor-column">
            <FileText size={20} />
            <label>
              Folder
              <select
                value={selectedNote?.folderId ?? ""}
                disabled={!selectedNote || notesView === "trash"}
                onChange={(event) => {
                  updateSelectedNote({ folderId: event.target.value || null });
                }}
              >
                <option value="">All notes</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.parentFolderId ? "  " : ""}
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Title
              <input
                value={selectedNote?.title ?? ""}
                disabled={!selectedNote || notesView === "trash"}
                onChange={(event) => {
                  updateSelectedNote({ title: event.target.value });
                }}
              />
            </label>
            <label>
              Markdown editor
              <textarea
                value={selectedNote?.body ?? ""}
                disabled={!selectedNote || notesView === "trash"}
                onChange={(event) => {
                  updateSelectedNote({ body: event.target.value });
                }}
              />
            </label>
            <label>
              Attach encrypted file
              <input
                type="file"
                disabled={!selectedNote || notesView === "trash"}
                onChange={(event) => {
                  void uploadSelectedAttachment(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
          <div className="editor-column preview">
            <h3>Preview</h3>
            <div className="preview-body">
              <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
            <div className="attachment-panel">
              <h3>Attachments</h3>
              {selectedAttachments.length === 0 ? (
                <p className="muted">No attachments.</p>
              ) : (
                <ul className="attachment-list">
                  {selectedAttachments.map((attachment) => (
                    <li key={attachment.id}>
                      <span>
                        <strong>{attachment.filename}</strong>
                        <small>{formatBytes(attachment.size)}</small>
                      </span>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => {
                          void downloadSelectedAttachment(attachment);
                        }}
                      >
                        Download
                      </button>
                      <button
                        className="text-button danger"
                        type="button"
                        onClick={() => {
                          void removeSelectedAttachment(attachment.id);
                        }}
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="notice">Plaintext stays in browser memory.</div>
          </div>
        </div>
        )}
      </section>
    </main>
  );
}

async function decryptNoteSummary(
  user: User,
  rootKey: Uint8Array,
  note: NoteSummary
): Promise<DecryptedNote> {
  const decrypted = await decryptNote({
    userId: user.id,
    rootKey,
    noteId: note.id,
    encryptedNoteKey: {
      cipher: note.encryptedNoteKey,
      nonce: note.noteKeyNonce,
      formatVersion: 1
    },
    encryptedBody: {
      cipher: note.contentCipher,
      nonce: note.contentNonce,
      formatVersion: 1
    }
  });

  return {
    id: note.id,
    folderId: note.folderId,
    title: note.title,
    body: decrypted.body,
    noteKeyBase64: noteKeyToBase64(decrypted.noteKey),
    contentLength: note.contentLength,
    version: note.version,
    isDeleted: Boolean(note.isDeleted),
    updatedAt: note.updatedAt
  };
}

function authKdf(response: AuthKdfResponse) {
  return {
    salt: response.authKdfSalt,
    opsLimit: response.authKdfOpsLimit,
    memLimit: response.authKdfMemLimit,
    version: response.authKdfVersion
  };
}

function vaultKdf(response: KeyMaterialResponse) {
  return {
    salt: response.kdfSalt,
    opsLimit: response.kdfOpsLimit,
    memLimit: response.kdfMemLimit,
    version: response.kdfVersion
  };
}

function recoveryKdf(response: RecoveryParamsResponse) {
  return {
    salt: response.recoveryKdfSalt,
    opsLimit: response.recoveryKdfOpsLimit,
    memLimit: response.recoveryKdfMemLimit,
    version: response.recoveryKdfVersion
  };
}

function downloadBytes(bytes: Uint8Array, filename: string, mimeType: string) {
  const blob = new Blob([bytes.slice()], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${String(Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderMarkdown(markdown: string): string {
  const rendered = marked.parse(escapeRawHtml(markdown), {
    async: false,
    breaks: true,
    gfm: true
  });

  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "style"]
  });
}

function escapeRawHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
