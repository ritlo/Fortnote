import { FileText } from "lucide-react";
import { useEffect } from "react";
import type { FolderSummary } from "../api";
import { editCrdtNote, openCrdtNote } from "../realtime/crdt";
import type { DecryptedNote, NotesView } from "../store/appStore";
import { useAppStore } from "../store/appStore";
import { SharingPanel } from "./SharingPanel";

interface NoteEditorProps {
  folders: FolderSummary[];
  notesView: NotesView;
  selectedNote: DecryptedNote | null;
  updateSelectedNote: (
    patch: Partial<Pick<DecryptedNote, "folderId" | "title" | "body">>
  ) => void;
  uploadSelectedAttachment: (file: File | undefined) => Promise<void>;
}

export function NoteEditor({
  folders,
  notesView,
  selectedNote,
  updateSelectedNote,
  uploadSelectedAttachment
	}: NoteEditorProps) {
  const canEdit =
    selectedNote?.role !== undefined &&
    selectedNote.role !== "viewer" &&
    notesView !== "trash";
  const canMove = selectedNote?.role === "owner" && notesView !== "trash";
  const setLocalPresenceState = useAppStore((state) => state.setLocalPresenceState);

  useEffect(() => {
    if (!selectedNote || notesView === "trash") {
      return;
    }
    return openCrdtNote(selectedNote, updateSelectedNote);
  }, [notesView, selectedNote?.id, selectedNote?.keyEpoch, selectedNote?.noteKeyBase64]);

  function markEditing() {
    if (canEdit) {
      setLocalPresenceState("editing");
    }
  }

  function markIdle() {
    setLocalPresenceState("idle");
  }

  return (
    <div className="editor-column">
      <FileText size={20} />
      <label>
        Folder
        <select
          value={selectedNote?.folderId ?? ""}
          disabled={!canMove}
          onChange={(event) => {
            updateSelectedNote({ folderId: event.target.value || null });
          }}
        >
          <option value="">All notes</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.parentFolderId ? "  " : ""}
              {folder.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input
          value={selectedNote?.title ?? ""}
          disabled={!canEdit}
          onBlur={markIdle}
          onChange={(event) => {
            markEditing();
            if (!selectedNote || !editCrdtNote(selectedNote.id, { title: event.target.value })) {
              updateSelectedNote({ title: event.target.value });
            }
          }}
          onFocus={markEditing}
        />
      </label>
      <label>
        Markdown editor
        <textarea
          value={selectedNote?.body ?? ""}
          disabled={!canEdit}
          onBlur={markIdle}
          onChange={(event) => {
            markEditing();
            if (!selectedNote || !editCrdtNote(selectedNote.id, { body: event.target.value })) {
              updateSelectedNote({ body: event.target.value });
            }
          }}
          onFocus={markEditing}
        />
      </label>
      <label>
        Attach encrypted file
        <input
          type="file"
          disabled={!canEdit}
          onChange={(event) => {
            void uploadSelectedAttachment(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </label>
      <SharingPanel selectedNote={selectedNote} disabled={notesView === "trash"} />
    </div>
  );
}
