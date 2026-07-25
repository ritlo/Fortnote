import { MoreHorizontal, Plus, Search } from "lucide-react";
import type { FolderSummary } from "../api";
import type { SearchCoverage, SearchMatch } from "../lib/searchIndex";
import type { SearchIndexStatus } from "../hooks/useNoteViewModel";
import type { DecryptedNote, NotesView, RealtimeStatus } from "../store/appStore";
import { useEffect, useRef, useState } from "react";
import { NewNoteDialog } from "./NewNoteDialog";

interface NotesPaneProps {
  error: string | null;
  filteredNotes: DecryptedNote[];
  folders: FolderSummary[];
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
  addNote: (folderId?: string | null) => Promise<void>;
  moveNoteToFolder: (noteId: string, folderId: string | null) => Promise<void>;
  openAttachments: (note: DecryptedNote) => void;
  retrySearchIndex: () => void;
  selectSearchMatch: (match: SearchMatch) => void;
  setSearch: (value: string) => void;
  setSelectedNoteId: (value: string) => void;
}

export function NotesPane({
  error,
  filteredNotes,
  folders,
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
  moveNoteToFolder,
  openAttachments,
  retrySearchIndex,
  selectSearchMatch,
  setSearch,
  setSelectedNoteId
}: NotesPaneProps) {
  const [newNoteDialogOpen, setNewNoteDialogOpen] = useState(false);

  return (
    <section className="notes-pane">
      <NewNoteDialog
        folders={folders}
        open={newNoteDialogOpen}
        onClose={() => { setNewNoteDialogOpen(false); }}
        onCreate={async (folderId) => {
          await addNote(folderId);
          setNewNoteDialogOpen(false);
        }}
      />
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
            setNewNoteDialogOpen(true);
          }}
        >
          <Plus size={18} />
        </button>
      </header>
      <div className="search" role="search">
        <Search size={16} />
        <label className="visually-hidden" htmlFor="note-search">
          Search notes
        </label>
        <input
          id="note-search"
          aria-describedby={search.trim() ? "search-coverage-status" : undefined}
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
      <ul className="note-list" aria-label="Notes">
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
              <NoteListItem
                key={note.id}
                note={note}
                folders={folders}
                notesView={notesView}
                selectedNoteId={selectedNoteId}
                noteMatches={noteMatches}
                onSelect={setSelectedNoteId}
                onMove={async (noteId, folderId) => {
                  await moveNoteToFolder(noteId, folderId);
                }}
                onOpenAttachments={openAttachments}
                onSearchSelect={selectSearchMatch}
              />
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
    <div
      className="search-coverage"
      id="search-coverage-status"
      role="status"
      aria-live="polite"
    >
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
    return "Preparing search…";
  }
  if (status === "ready" && coverage.complete) {
    return "Search is ready.";
  }
  return "Searching more note content — more results may appear.";
}

function NoteListItem({
  note,
  folders,
  notesView,
  selectedNoteId,
  noteMatches,
  onSelect,
  onMove,
  onOpenAttachments,
  onSearchSelect
}: {
  note: DecryptedNote;
  folders: FolderSummary[];
  notesView: NotesView;
  selectedNoteId: string | null;
  noteMatches: SearchMatch[];
  onSelect: (id: string) => void;
  onMove: (noteId: string, folderId: string | null) => Promise<void>;
  onOpenAttachments: (note: DecryptedNote) => void;
  onSearchSelect: (match: SearchMatch) => void;
}) {
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const canManageNote = notesView === "notes" && note.role !== "viewer";
  const canOpenNoteMenu = notesView === "notes" || notesView === "shared";
  const folderName = folders.find((folder) => folder.id === note.folderId)?.name ?? "All notes";

  useEffect(() => {
    if (!contextMenuOpen) {
      return;
    }
    const firstMenuItem = menuRef.current?.querySelector<HTMLButtonElement>(
      "button[role='menuitem']"
    );
    firstMenuItem?.focus();
    function handleOutsideClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [contextMenuOpen]);

  function handleDragStart(event: React.DragEvent) {
    event.dataTransfer.setData("text/note-id", note.id);
    event.dataTransfer.effectAllowed = "move";
  }

  function handleMoveSelect(folderId: string) {
    void onMove(note.id, folderId);
    closeMenu();
  }

  function closeMenu() {
    setContextMenuOpen(false);
    setShowMove(false);
    menuButtonRef.current?.focus();
  }

  function openMenu() {
    if (canOpenNoteMenu) {
      setContextMenuOpen(true);
    }
  }

  function handleCardKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openMenu();
    }
  }

  return (
    <li
      key={note.id}
      draggable={notesView === "notes" && note.role !== "viewer"}
      onDragStart={handleDragStart}
      onContextMenu={(event) => {
        if (canOpenNoteMenu) {
          event.preventDefault();
          openMenu();
        }
      }}
    >
      <button
        className={note.id === selectedNoteId ? "note-card active" : "note-card"}
        type="button"
        onKeyDown={handleCardKeyDown}
        onClick={() => {
          onSelect(note.id);
        }}
      >
        <span className="note-title-row">
          <strong>{note.title}</strong>
          {note.role !== "owner" ? (
            <small className="role-badge">{roleLabel(note.role)}</small>
          ) : null}
        </span>
        <span className="note-meta">{formatNoteMetadata(note.updatedAt, folderName)}</span>
      </button>
      {canOpenNoteMenu ? (
        <div className="note-actions">
          <button
            ref={menuButtonRef}
            className="note-menu-button"
            type="button"
            aria-label="Open note menu"
            aria-haspopup="menu"
            aria-expanded={contextMenuOpen}
            onClick={() => {
              if (contextMenuOpen) {
                closeMenu();
              } else {
                openMenu();
              }
            }}
          >
            <MoreHorizontal size={18} aria-hidden="true" />
          </button>
          {contextMenuOpen ? (
            <div
              ref={menuRef}
              className="note-context-menu"
              role="menu"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeMenu();
                }
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onSelect(note.id);
                  closeMenu();
                }}
              >
                Open note
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onOpenAttachments(note);
                  closeMenu();
                }}
              >
                Attachments
              </button>
              {canManageNote ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setShowMove(true); }}
                >
                  Move to folder
                </button>
              ) : null}
              {showMove ? (
                <div className="move-folder-list" role="menu">
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="menuitem"
                      onClick={() => { handleMoveSelect(f.id); }}
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {noteMatches.length > 0 ? (
        <ul className="search-match-list" aria-label={`Matches in ${note.title}`}>
          {noteMatches.map((match, position) => (
            <li key={`${match.sectionId}:${match.blockId}`}>
              <button
                className="search-match"
                type="button"
                aria-label={`Search result ${String(position + 1)} of ${String(
                  noteMatches.length
                )} in ${note.title}: ${match.excerpt || "Matching content"}`}
                onClick={() => {
                  onSearchSelect(match);
                }}
              >
                <span>{match.excerpt || "Matching content"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
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

function formatNoteMetadata(updatedAt: string, folderName: string): string {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return `Updated recently · ${folderName}`;
  }
  const days = Math.floor(Math.max(0, Date.now() - timestamp) / 86_400_000);
  const updatedLabel = days === 0
    ? "Updated today"
    : `Updated ${String(days)} ${days === 1 ? "day" : "days"} ago`;
  return `${updatedLabel} · ${folderName}`;
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
