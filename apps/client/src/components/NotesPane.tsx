import { Plus, Search } from "lucide-react";
import type { DecryptedNote, NotesView } from "../store/appStore";

interface NotesPaneProps {
  error: string | null;
  filteredNotes: DecryptedNote[];
  notesView: NotesView;
  recoverySecret: string | null;
  search: string;
  selectedNoteId: string | null;
  status: string;
  addNote: () => Promise<void>;
  setSearch: (value: string) => void;
  setSelectedNoteId: (value: string) => void;
}

export function NotesPane({
  error,
  filteredNotes,
  notesView,
  recoverySecret,
  search,
  selectedNoteId,
  status,
  addNote,
  setSearch,
  setSelectedNoteId
}: NotesPaneProps) {
  return (
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
  );
}
