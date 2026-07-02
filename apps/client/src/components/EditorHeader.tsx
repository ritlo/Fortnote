import type { User } from "../api";
import type { DecryptedNote, NotesView } from "../store/appStore";

interface EditorHeaderProps {
  keyMaterialVersion: number | null;
  notesView: NotesView;
  selectedNote: DecryptedNote | null;
  user: User;
  deleteSelectedForever: () => Promise<void>;
  lockVault: () => void;
  moveSelectedToTrash: () => Promise<void>;
  restoreSelectedNote: () => Promise<void>;
  saveSelectedNote: () => Promise<void>;
}

export function EditorHeader({
  keyMaterialVersion,
  notesView,
  selectedNote,
  user,
  deleteSelectedForever,
  lockVault,
  moveSelectedToTrash,
  restoreSelectedNote,
  saveSelectedNote
	}: EditorHeaderProps) {
  const canSave =
    selectedNote?.role !== undefined &&
    selectedNote.role !== "viewer" &&
    notesView !== "trash";
  const canDelete = selectedNote?.role === "owner";

  return (
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
	            disabled={!canSave}
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
	              disabled={!canDelete}
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
  );
}
