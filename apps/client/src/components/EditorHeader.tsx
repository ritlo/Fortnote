import type { PresenceUser, User } from "../api";
import { useEffect, useState } from "react";
import type { DecryptedNote, NotesView } from "../store/appStore";
import { useAppStore } from "../store/appStore";
import type { CollaborationState } from "../lib/collaborationState";
import { AlertTriangle, Share2 } from "lucide-react";
import { CollaborationStatus } from "./CollaborationStatus";
import type { RecoveryCallbacks } from "./RecoveryPanel";

interface EditorHeaderProps {
  collaborationState?: CollaborationState;
  keyMaterialVersion: number | null;
  notesView: NotesView;
  selectedNote: DecryptedNote | null;
  user: User;
  canShare: boolean;
  deleteSelectedForever: () => Promise<void>;
  lockVault: () => void;
  moveSelectedToTrash: () => Promise<void>;
  recoveryCallbacks?: RecoveryCallbacks;
  recoveryOpen?: boolean;
  restoreSelectedNote: () => Promise<void>;
  setRecoveryOpen?: (open: boolean) => void;
  onShare?: () => void;
}

export function EditorHeader({
  collaborationState,
  keyMaterialVersion,
  notesView,
  selectedNote,
  user,
  canShare,
  deleteSelectedForever,
  lockVault,
  moveSelectedToTrash,
  recoveryCallbacks: _recoveryCallbacks,
  recoveryOpen: _recoveryOpen,
  restoreSelectedNote,
  setRecoveryOpen,
  onShare
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
  const hasRecoveryActions = (collaborationState?.actions.length ?? 0) > 0;

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
        {presenceSummary ? <p className="presence-summary">{presenceSummary}</p> : null}
        {lastSaved ? <p className="last-saved">{lastSaved}</p> : null}
        {collaborationState ? <CollaborationStatus state={collaborationState} /> : null}
      </div>
      {canShare && notesView !== "settings" && notesView !== "trash" ? (
        <button
          className="text-button"
          type="button"
          onClick={() => { onShare?.(); }}
          aria-label="Share note"
        >
          <Share2 size={16} /> Share
        </button>
      ) : null}
      {hasRecoveryActions && notesView !== "settings" ? (
        <button
          className="text-button"
          type="button"
          onClick={() => { setRecoveryOpen?.(true); }}
          aria-label="Open recovery actions"
        >
          <AlertTriangle size={16} /> Recovery
        </button>
      ) : null}
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
                disabled={!canDelete}
                onClick={() => {
                  void restoreSelectedNote();
                }}
              >
                Restore
              </button>
              <button
                className="text-button danger"
                type="button"
                disabled={!canDelete}
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
