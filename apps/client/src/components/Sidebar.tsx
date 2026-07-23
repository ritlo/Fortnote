import { Folder, Lock, LogOut, Plus, Settings, Users } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { FolderSummary } from "../api";
import type { NotesView } from "../store/appStore";

interface SidebarProps {
  folders: FolderSummary[];
  notesView: NotesView;
  selectedFolderId: string | null;
  addFolder: (parentFolderId?: string | null) => Promise<void>;
  moveNoteToFolder: (noteId: string, folderId: string | null) => Promise<void>;
  openNotes: (folderId?: string | null) => void;
  openSharedNotes: () => void;
  openSettings: () => void;
  openTrash: () => Promise<void>;
  removeFolder: (folderId: string) => Promise<void>;
  submitLogout: () => Promise<void>;
}

function DropTarget({
  onDrop,
  children
}: {
  folderId: string | null;
  onDrop: (noteId: string) => void;
  children: ReactNode;
}) {
  const [isOver, setIsOver] = useState(false);

  function handleDragOver(event: React.DragEvent) {
    if (event.dataTransfer.types.includes("text/note-id")) {
      event.preventDefault();
      setIsOver(true);
    }
  }

  function handleDragLeave() {
    setIsOver(false);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setIsOver(false);
    const noteId = event.dataTransfer.getData("text/note-id");
    if (noteId) {
      onDrop(noteId);
    }
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={isOver ? "drop-target-over" : undefined}
    >
      {children}
    </div>
  );
}

export function Sidebar({
  folders,
  notesView,
  selectedFolderId,
  addFolder,
  moveNoteToFolder,
  openNotes,
  openSharedNotes,
  openSettings,
  openTrash,
  removeFolder,
  submitLogout
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand-row compact">
        <div className="brand-mark">FN</div>
        <h1>Fortnote</h1>
      </div>
      <DropTarget folderId={null} onDrop={(noteId: string) => { void moveNoteToFolder(noteId, null); }}>
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
      </DropTarget>
      <button
        className={notesView === "shared" ? "nav-item active" : "nav-item"}
        type="button"
        onClick={openSharedNotes}
      >
        <Users size={17} /> Shared
      </button>
      <div className="nav-label">Folders</div>
      <div className="folder-list">
        {folders
          .filter((folder) => folder.parentFolderId === null)
          .map((folder) => (
            <div key={folder.id}>
              <DropTarget folderId={folder.id} onDrop={(noteId: string) => { void moveNoteToFolder(noteId, folder.id); }}>
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
              </DropTarget>
              {folders
                .filter((child) => child.parentFolderId === folder.id)
                .map((child) => (
                  <DropTarget key={child.id} folderId={child.id} onDrop={(noteId: string) => { void moveNoteToFolder(noteId, child.id); }}>
                    <div className="folder-row child">
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
                  </DropTarget>
                ))}
            </div>
          ))}
      </div>
      <button
        className="nav-item"
        type="button"
        onClick={() => {
          void addFolder();
        }}
      >
        <Plus size={17} /> New folder
      </button>
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
          onClick={openSettings}
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
  );
}
