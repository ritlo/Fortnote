import type { PresenceUser, User } from "../api";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { DecryptedNote, NotesView } from "../store/appStore";
import { useAppStore } from "../store/appStore";
import type { CollaborationState } from "../lib/collaborationState";
import { MoreHorizontal, Share2 } from "lucide-react";
import { CollaborationStatus } from "./CollaborationStatus";
import type { RecoveryCallbacks } from "./RecoveryPanel";

interface EditorHeaderProps {
  collaborationState?: CollaborationState;
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
  shareButtonRef?: RefObject<HTMLButtonElement | null>;
}

export function EditorHeader({
  collaborationState,
  notesView,
  selectedNote,
  user,
  canShare,
  deleteSelectedForever,
  lockVault,
  moveSelectedToTrash,
  restoreSelectedNote,
  setRecoveryOpen,
  onShare,
  shareButtonRef
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
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const hasRecoveryActions = (collaborationState?.actions.length ?? 0) > 0;

  function closeOverflow() {
    setOverflowOpen(false);
    overflowButtonRef.current?.focus();
  }

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

  useEffect(() => {
    if (!overflowOpen) {
      return;
    }
    function handleOutsideClick(event: MouseEvent) {
      if (overflowRef.current && !overflowRef.current.contains(event.target as Node)) {
        closeOverflow();
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [overflowOpen]);

  useEffect(() => {
    if (!overflowOpen) {
      return;
    }
    overflowRef.current
      ?.querySelector<HTMLButtonElement>("button[role='menuitem']:not(:disabled)")
      ?.focus();
  }, [overflowOpen]);

  const lastSaved = selectedNote && presence.length === 0 && notesView !== "settings"
    ? formatLastSaved(selectedNote.updatedAt, now)
    : "";

  return (
    <header className="pane-header editor-header">
      <div className="editor-header-status">
        {notesView === "settings" ? <h2>Vault settings</h2> : null}
        {presenceSummary ? <p className="presence-summary">{presenceSummary}</p> : null}
        {lastSaved ? <p className="last-saved">{lastSaved}</p> : null}
        {collaborationState ? <CollaborationStatus state={collaborationState} /> : null}
      </div>
      <div className="editor-header-actions">
        {canShare && notesView !== "settings" && notesView !== "trash" ? (
          <button
            ref={shareButtonRef}
            className="text-button"
            type="button"
            onClick={() => { onShare?.(); }}
            aria-label="Share note"
          >
            <Share2 size={16} /> Share
          </button>
        ) : null}
        {notesView === "settings" ? (
          <button className="text-button" type="button" onClick={lockVault}>
            Lock vault
          </button>
        ) : (
          <div ref={overflowRef} className="editor-overflow">
            <button
              ref={overflowButtonRef}
              className="icon-button"
              type="button"
              aria-label="More note actions"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              onClick={() => {
                if (overflowOpen) {
                  closeOverflow();
                } else {
                  setOverflowOpen(true);
                }
              }}
            >
              <MoreHorizontal size={18} aria-hidden="true" />
            </button>
            {overflowOpen ? (
              <div
                className="editor-action-menu"
                role="menu"
                aria-orientation="vertical"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeOverflow();
                    return;
                  }
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button[role='menuitem']:not(:disabled)"
                    )
                  );
                  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
                  if (items.length === 0 || currentIndex < 0) {
                    return;
                  }
                  const nextIndex = event.key === "ArrowDown"
                    ? (currentIndex + 1) % items.length
                    : event.key === "ArrowUp"
                      ? (currentIndex - 1 + items.length) % items.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : -1;
                  if (nextIndex >= 0) {
                    event.preventDefault();
                    items[nextIndex]?.focus();
                  }
                }}
              >
                {notesView === "trash" ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!canDelete}
                      onClick={() => {
                        void restoreSelectedNote();
                        closeOverflow();
                      }}
                    >
                      Restore
                    </button>
                    <button
                      className="danger"
                      type="button"
                      role="menuitem"
                      disabled={!canDelete}
                      onClick={() => {
                        void deleteSelectedForever();
                        closeOverflow();
                      }}
                    >
                      Delete forever
                    </button>
                  </>
                ) : (
                  <button
                    className="danger"
                    type="button"
                    role="menuitem"
                    disabled={!canDelete}
                    onClick={() => {
                      void moveSelectedToTrash();
                      closeOverflow();
                    }}
                  >
                    Move to trash
                  </button>
                )}
                {hasRecoveryActions ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setRecoveryOpen?.(true);
                      closeOverflow();
                    }}
                  >
                    Open recovery actions
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </header>
  );
}

export function formatLastSaved(updatedAt: string, now = Date.now()): string {
  const savedAt = Date.parse(updatedAt);
  if (!Number.isFinite(savedAt) || !Number.isFinite(now)) {
    return "Last saved recently";
  }
  const seconds = Math.max(0, Math.floor((now - savedAt) / 1000));
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
