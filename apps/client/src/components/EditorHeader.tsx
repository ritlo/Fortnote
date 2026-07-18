import type { PresenceUser, User } from "../api";
import { useEffect, useState } from "react";
import type { DecryptedNote, NotesView } from "../store/appStore";
import { useAppStore } from "../store/appStore";

interface EditorHeaderProps {
  keyMaterialVersion: number | null;
  notesView: NotesView;
  selectedNote: DecryptedNote | null;
  user: User;
  deleteSelectedForever: () => Promise<void>;
  lockVault: () => void;
  moveSelectedToTrash: () => Promise<void>;
  restoreSelectedNote: () => Promise<void>;
}

export function EditorHeader({
  keyMaterialVersion,
  notesView,
  selectedNote,
  user,
  deleteSelectedForever,
  lockVault,
  moveSelectedToTrash,
  restoreSelectedNote
}: EditorHeaderProps) {
  const canDelete = selectedNote?.role === "owner";
  const presenceByNote = useAppStore((state) => state.presenceByNote);
  const presence = selectedNote
    ? (presenceByNote[selectedNote.id] ?? []).filter(
        (presenceUser) => presenceUser.userId !== user.id
      )
    : [];
  const presenceSummary = formatPresenceSummary(presence);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!selectedNote || presence.length > 0 || notesView === "settings") {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [notesView, presence.length, selectedNote]);

  const lastSaved = selectedNote && presence.length === 0 && notesView !== "settings"
    ? formatLastSaved(selectedNote.updatedAt, now)
    : "";

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
        {presenceSummary ? <p className="presence-summary">{presenceSummary}</p> : null}
        {lastSaved ? <p className="last-saved">{lastSaved}</p> : null}
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

export function formatLastSaved(updatedAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 1000));
  if (seconds < 60) {
    return `Last saved ${String(seconds)} seconds ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `Last saved ${String(minutes)} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `Last saved ${String(hours)} hours ago`;
  }
  return `Last saved ${String(Math.floor(hours / 24))} days ago`;
}

export function formatPresenceSummary(presence: PresenceUser[]): string {
  if (presence.length === 0) {
    return "";
  }

  return presence
    .map((presenceUser) => `${presenceUser.username} ${presenceUser.state}`)
    .join(", ");
}
