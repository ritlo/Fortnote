import { Folder, Lock, LogOut, Plus, Settings } from "lucide-react";
import type { FolderSummary } from "../api";
import type { NotesView } from "../store/appStore";

interface SidebarProps {
  folders: FolderSummary[];
  notesView: NotesView;
  selectedFolderId: string | null;
  addFolder: (parentFolderId?: string | null) => Promise<void>;
  openNotes: (folderId?: string | null) => void;
  openSettings: () => void;
  openTrash: () => Promise<void>;
  removeFolder: (folderId: string) => Promise<void>;
  submitLogout: () => Promise<void>;
}

export function Sidebar({
  folders,
  notesView,
  selectedFolderId,
  addFolder,
  openNotes,
  openSettings,
  openTrash,
  removeFolder,
  submitLogout
}: SidebarProps) {
  return (
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
