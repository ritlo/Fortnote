import { useEffect, useRef, useState } from "react";
import type { FolderSummary } from "../api";

interface NewNoteDialogProps {
  folders: FolderSummary[];
  open: boolean;
  onClose: () => void;
  onCreate: (folderId: string | null) => Promise<void>;
}

export function NewNoteDialog({ folders, open, onClose, onCreate }: NewNoteDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onCreate(selectedFolderId || null);
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    if (!submitting) {
      setSelectedFolderId("");
      onClose();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="new-note-dialog-title"
      onClose={handleClose}
    >
      <form method="dialog" onSubmit={handleSubmit}>
        <h3 id="new-note-dialog-title">New note</h3>
        <label>
          Folder
          <select
            value={selectedFolderId}
            onChange={(e) => setSelectedFolderId(e.target.value)}
            disabled={submitting}
          >
            <option value="">No folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={handleClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" disabled={submitting}>
            {submitting ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
