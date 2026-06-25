import { FileText, Folder, Lock, LogOut, Plus, Search, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getMe, listNotes, login, logout, register, type NoteSummary, type User } from "./api";
import { createRegisterPayload, fakeVerifier } from "./mockCrypto";
import "./styles.css";

type AuthMode = "login" | "register";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("alice");
  const [password, setPassword] = useState("correct horse battery staple");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Checking session");

  useEffect(() => {
    void getMe()
      .then((currentUser) => {
        setUser(currentUser);
        setStatus("Vault decrypted");
        return listNotes();
      })
      .then((payload) => {
        setNotes(payload.notes);
        setSelectedNoteId(payload.notes[0]?.id ?? null);
      })
      .catch(() => {
        setStatus("Signed out");
      });
  }, []);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId]
  );

  async function submitAuth() {
    setError(null);
    setStatus("Deriving keys");
    try {
      const currentUser =
        authMode === "register"
          ? await register(createRegisterPayload(username, password))
          : await login(username, fakeVerifier(password, "auth"));
      setUser(currentUser);
      setStatus("Signed in and decrypted");
      const payload = await listNotes();
      setNotes(payload.notes);
      setSelectedNoteId(payload.notes[0]?.id ?? null);
    } catch (authError) {
      setStatus("Auth failed");
      setError(authError instanceof Error ? authError.message : "Unable to sign in");
    }
  }

  async function submitLogout() {
    await logout();
    setUser(null);
    setNotes([]);
    setSelectedNoteId(null);
    setStatus("Signed out");
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
          <button className="icon-button" type="button" aria-label="New note">
            <Plus size={18} />
          </button>
        </header>
        <div className="search">
          <Search size={16} />
          <input placeholder="Search decrypted notes" />
        </div>
        <div className="status-pill">{status}</div>
        <ul className="note-list">
          {notes.length === 0 ? (
            <li className="empty-state">No notes yet. Create your first encrypted note.</li>
          ) : (
            notes.map((note) => (
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
          <button className="primary" type="button">
            Save
          </button>
        </header>
        <div className="editor-grid">
          <div className="editor-column">
            <FileText size={20} />
            <h3>Markdown editor</h3>
            <textarea
              value={
                selectedNote
                  ? "# Encrypted note\n\nCiphertext is stored on the server. Plaintext stays in browser memory."
                  : ""
              }
              readOnly
            />
          </div>
          <div className="editor-column preview">
            <h3>Preview</h3>
            <p>
              Ciphertext is stored on the server. Plaintext stays in browser memory.
            </p>
            <div className="notice">Markdown output will be sanitized before render.</div>
          </div>
        </div>
      </section>
    </main>
  );
}
