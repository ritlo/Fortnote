import { useMemo } from "react";
import { renderMarkdown } from "../lib/markdown";
import { useAppStore } from "../store/appStore";

export function useNoteViewModel() {
  const notes = useAppStore((state) => state.notes);
  const trashNotes = useAppStore((state) => state.trashNotes);
  const notesView = useAppStore((state) => state.notesView);
  const selectedFolderId = useAppStore((state) => state.selectedFolderId);
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const attachmentsByNote = useAppStore((state) => state.attachmentsByNote);
  const search = useAppStore((state) => state.search);

  const visibleSourceNotes =
    notesView === "trash" ? trashNotes : notesView === "settings" ? [] : notes;

  const folderFilteredNotes =
    notesView === "trash" || !selectedFolderId
      ? visibleSourceNotes
      : visibleSourceNotes.filter((note) => note.folderId === selectedFolderId);

  const selectedNote = useMemo(
    () => visibleSourceNotes.find((note) => note.id === selectedNoteId) ?? null,
    [selectedNoteId, visibleSourceNotes]
  );

  const selectedAttachments = selectedNoteId
    ? attachmentsByNote[selectedNoteId] ?? []
    : [];

  const filteredNotes = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return folderFilteredNotes;
    }

    return folderFilteredNotes.filter(
      (note) =>
        note.title.toLowerCase().includes(query) ||
        note.body.toLowerCase().includes(query)
    );
  }, [folderFilteredNotes, search]);

  const previewHtml = useMemo(
    () => renderMarkdown(selectedNote?.body ?? "Select or create a note."),
    [selectedNote?.body]
  );

  return {
    filteredNotes,
    selectedAttachments,
    selectedNote,
    previewHtml
  };
}
