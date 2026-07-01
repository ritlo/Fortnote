import { FileText } from "lucide-react";
import type { FolderSummary } from "../api";
import type { DecryptedNote, NotesView } from "../store/appStore";

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
  return (
    <div className="editor-column">
      <FileText size={20} />
      <label>
        Folder
        <select
          value={selectedNote?.folderId ?? ""}
          disabled={!selectedNote || notesView === "trash"}
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
          disabled={!selectedNote || notesView === "trash"}
          onChange={(event) => {
            updateSelectedNote({ title: event.target.value });
          }}
        />
      </label>
      <label>
        Markdown editor
        <textarea
          value={selectedNote?.body ?? ""}
          disabled={!selectedNote || notesView === "trash"}
          onChange={(event) => {
            updateSelectedNote({ body: event.target.value });
          }}
        />
      </label>
      <label>
        Attach encrypted file
        <input
          type="file"
          disabled={!selectedNote || notesView === "trash"}
          onChange={(event) => {
            void uploadSelectedAttachment(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </label>
    </div>
  );
}
