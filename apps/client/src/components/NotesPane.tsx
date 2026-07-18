import { Plus, Search } from "lucide-react";
import type { SearchCoverage, SearchMatch } from "../lib/searchIndex";
import type { SearchIndexStatus } from "../hooks/useNoteViewModel";
import type { DecryptedNote, NotesView, RealtimeStatus } from "../store/appStore";

interface NotesPaneProps {
  error: string | null;
  filteredNotes: DecryptedNote[];
  notesView: NotesView;
  realtimeStatus: RealtimeStatus;
  recoverySecret: string | null;
  search: string;
  searchCoverage: SearchCoverage | null;
  searchIndexError: string | null;
  searchIndexStatus: SearchIndexStatus;
  searchMatches: SearchMatch[];
  selectedNoteId: string | null;
  status: string;
  addNote: () => Promise<void>;
  retrySearchIndex: () => void;
  selectSearchMatch: (match: SearchMatch) => void;
  setSearch: (value: string) => void;
  setSelectedNoteId: (value: string) => void;
}

export function NotesPane({
  error,
  filteredNotes,
  notesView,
  realtimeStatus,
  recoverySecret,
  search,
  searchCoverage,
  searchIndexError,
  searchIndexStatus,
  searchMatches,
  selectedNoteId,
  status,
  addNote,
  retrySearchIndex,
  selectSearchMatch,
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
              : notesView === "shared"
                ? "Shared"
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
        <label className="visually-hidden" htmlFor="note-search">
          Search notes
        </label>
        <input
          id="note-search"
          placeholder="Search decrypted notes"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </div>
      {search.trim() ? (
        <SearchCoverageStatus
          coverage={searchCoverage}
          error={searchIndexError}
          retry={retrySearchIndex}
          status={searchIndexStatus}
        />
      ) : null}
      <div className="status-row">
        <div className="status-pill">{status}</div>
        <div className={`sync-pill ${realtimeStatus}`}>{syncLabel(realtimeStatus)}</div>
      </div>
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
                : notesView === "shared"
                  ? "No shared notes."
                  : "No notes match this view."}
          </li>
        ) : (
          filteredNotes.map((note) => {
            const noteMatches = searchMatches.filter((match) => match.noteId === note.id);
            return (
              <li key={note.id}>
                <button
                  className={note.id === selectedNoteId ? "note-card active" : "note-card"}
                  type="button"
                  onClick={() => {
                    setSelectedNoteId(note.id);
                  }}
                >
                  <span className="note-title-row">
                    <strong>{note.title}</strong>
                    {note.role !== "owner" ? (
                      <small className="role-badge">{roleLabel(note.role)}</small>
                    ) : null}
                  </span>
                  <span>{String(note.contentLength)} encrypted bytes</span>
                </button>
                {noteMatches.length > 0 ? (
                  <ul className="search-match-list" aria-label={`Section matches in ${note.title}`}>
                    {noteMatches.map((match) => (
                      <li key={`${match.sectionId}:${match.blockId}`}>
                        <button
                          className="search-match"
                          type="button"
                          onClick={() => {
                            selectSearchMatch(match);
                          }}
                        >
                          <span>Open matching section</span>
                          <small>{match.excerpt || "Matching encrypted section"}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })
        )}
      </ul>
    </section>
  );
}

function SearchCoverageStatus({
  coverage,
  error,
  retry,
  status
}: {
  coverage: SearchCoverage | null;
  error: string | null;
  retry: () => void;
  status: SearchIndexStatus;
}) {
  const isDiscovering = status === "discovering";
  const label = searchCoverageLabel(coverage, status);
  return (
    <div className="search-coverage" role="status" aria-live="polite">
      <span>{label}</span>
      {isDiscovering ? (
        <progress aria-label="Search indexing progress" />
      ) : coverage && coverage.totalSections > 0 ? (
        <progress
          aria-label="Search indexing progress"
          max={coverage.totalSections}
          value={coverage.indexedSections}
        />
      ) : null}
      {error ? <small>{error}</small> : null}
      {status === "error" ? (
        <button className="text-button" type="button" onClick={retry}>
          Retry indexing
        </button>
      ) : null}
    </div>
  );
}

function searchCoverageLabel(
  coverage: SearchCoverage | null,
  status: SearchIndexStatus
): string {
  if (status === "discovering" || !coverage) {
    return "Preparing protected search coverage…";
  }
  if (status === "ready" && coverage.complete) {
    return `Search covers all ${String(coverage.totalSections)} sections.`;
  }
  return `Searching indexed sections — more results may appear (${String(
    coverage.indexedSections
  )} of ${String(coverage.totalSections)}).`;
}

export function roleLabel(role: DecryptedNote["role"]): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "editor":
      return "Editor";
    case "viewer":
      return "Viewer";
  }
}

function syncLabel(status: RealtimeStatus): string {
  switch (status) {
    case "connected":
      return "Sync connected";
    case "connecting":
      return "Sync connecting";
    case "disconnected":
      return "Sync offline";
    case "idle":
      return "Sync idle";
  }
}
