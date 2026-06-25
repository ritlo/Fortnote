import { FileText, Folder, Lock, LogOut, Plus, Search, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createNote,
  deleteAttachment,
  downloadAttachment,
  getAuthKdfParams,
  getKeyMaterial,
  getMe,
  listAttachments,
  listNotes,
  login,
  logout,
  register,
  updateNote,
  uploadAttachment,
  type AttachmentSummary,
  type AuthKdfResponse,
  type KeyMaterialResponse,
  type NoteSummary,
  type User
} from "./api";
import {
  createEncryptedNoteDraft,
  createEncryptedAttachmentDraft,
  createLoginAuthVerifier,
  createRegistrationCrypto,
  decryptAttachmentBytes,
  decryptNote,
  encryptExistingNoteBody,
  noteKeyToBase64,
  openVault
} from "./cryptoClient";
import "./styles.css";

type AuthMode = "login" | "register";

interface DecryptedNote {
  id: string;
  folderId: string | null;
  title: string;
  body: string;
  noteKeyBase64: string;
  contentLength: number;
  version: number;
  updatedAt: string;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [rootKey, setRootKey] = useState<Uint8Array | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("alice");
  const [password, setPassword] = useState("correct horse battery staple");
  const [notes, setNotes] = useState<DecryptedNote[]>([]);
  const [attachmentsByNote, setAttachmentsByNote] = useState<
    Record<string, AttachmentSummary[]>
  >({});
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [recoverySecret, setRecoverySecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Checking session");

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

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId]
  );

  const selectedAttachments = selectedNoteId
    ? attachmentsByNote[selectedNoteId] ?? []
    : [];

  const filteredNotes = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return notes;
    }

    return notes.filter(
      (note) =>
        note.title.toLowerCase().includes(query) ||
        note.body.toLowerCase().includes(query)
    );
  }, [notes, search]);

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

  async function loadDecryptedNotes(currentUser: User, currentRootKey: Uint8Array) {
    const payload = await listNotes();
    const decrypted = await Promise.all(
      payload.notes
        .filter((note) => !note.isDeleted)
        .map((note) => decryptNoteSummary(currentUser, currentRootKey, note))
    );
    const nextNotes = decrypted.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
    setNotes(nextNotes);
    setSelectedNoteId(nextNotes[0]?.id ?? null);
    setAttachmentsByNote({});
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
        setRecoverySecret(registration.recoverySecret);
        setStatus("Signed in and decrypted");
        await loadDecryptedNotes(currentUser, registration.rootKey);
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
      setStatus("Signed in and decrypted");
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
    setNotes([]);
    setAttachmentsByNote({});
    setSelectedNoteId(null);
    setRecoverySecret(null);
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
        title: draft.title,
        encryptedNoteKey: draft.encryptedNoteKey,
        noteKeyNonce: draft.noteKeyNonce,
        contentCipher: draft.contentCipher,
        contentNonce: draft.contentNonce,
        contentLength: draft.contentLength
      });
      const note: DecryptedNote = {
        id: draft.id,
        folderId: null,
        title: draft.title,
        body: "",
        noteKeyBase64: noteKeyToBase64(draft.noteKey),
        contentLength: draft.contentLength,
        version: created.version,
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

  function updateSelectedNote(patch: Partial<Pick<DecryptedNote, "title" | "body">>) {
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

  if (!user) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <div className="brand-row">
            <div className="brand-mark">CN</div>
            <div>
              <h1>CipherNotes</h1>
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

          {error ? <p className="error">{error}</p> : null}
          <button
            className="primary"
            type="button"
            onClick={() => {
              void submitAuth();
            }}
          >
            {authMode === "register" ? "Create encrypted vault" : "Sign in and decrypt"}
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
          <strong>CipherNotes</strong>
        </div>
        <button className="nav-item active" type="button">
          <Folder size={17} /> All notes
        </button>
        <button className="nav-item" type="button">
          <Folder size={17} /> Work
        </button>
        <button className="nav-item indented" type="button">
          <Folder size={17} /> Planning
        </button>
        <button className="nav-item" type="button">
          <Lock size={17} /> Trash
        </button>
        <div className="sidebar-footer">
          <button className="nav-item" type="button">
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
          <h2>Notes</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="New note"
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
        <ul className="note-list">
          {filteredNotes.length === 0 ? (
            <li className="empty-state">No notes match this view.</li>
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
            <h2>{selectedNote?.title ?? "No note selected"}</h2>
            <p>{user.username} · root key in memory only</p>
          </div>
          <button
            className="primary"
            type="button"
            disabled={!selectedNote}
            onClick={() => {
              void saveSelectedNote();
            }}
          >
            Save
          </button>
        </header>
        <div className="editor-grid">
          <div className="editor-column">
            <FileText size={20} />
            <label>
              Title
              <input
                value={selectedNote?.title ?? ""}
                disabled={!selectedNote}
                onChange={(event) => {
                  updateSelectedNote({ title: event.target.value });
                }}
              />
            </label>
            <label>
              Markdown editor
              <textarea
                value={selectedNote?.body ?? ""}
                disabled={!selectedNote}
                onChange={(event) => {
                  updateSelectedNote({ body: event.target.value });
                }}
              />
            </label>
            <label>
              Attach encrypted file
              <input
                type="file"
                disabled={!selectedNote}
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
              {selectedNote?.body ?? "Select or create a note."}
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
