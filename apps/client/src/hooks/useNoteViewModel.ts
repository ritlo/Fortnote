import { useMemo } from "react";
import { useAppStore, type DecryptedNote, type NotesView } from "../store/appStore";

interface NotesForViewInput {
  notes: DecryptedNote[];
  notesView: NotesView;
  selectedFolderId: string | null;
  trashNotes: DecryptedNote[];
}

export function useNoteViewModel() {
  const notes = useAppStore((state) => state.notes);
  const trashNotes = useAppStore((state) => state.trashNotes);
  const notesView = useAppStore((state) => state.notesView);
  const selectedFolderId = useAppStore((state) => state.selectedFolderId);
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const attachmentsByNote = useAppStore((state) => state.attachmentsByNote);
  const search = useAppStore((state) => state.search);

  const viewNotes = useMemo(
    () => notesForView({ notes, notesView, selectedFolderId, trashNotes }),
    [notes, notesView, selectedFolderId, trashNotes]
  );

  const selectedNote = useMemo(
    () => viewNotes.find((note) => note.id === selectedNoteId) ?? null,
    [selectedNoteId, viewNotes]
  );

  const selectedAttachments = selectedNoteId
    ? attachmentsByNote[selectedNoteId] ?? []
    : [];

  const filteredNotes = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return viewNotes;
    }

    return viewNotes.filter((note) => note.title.toLowerCase().includes(query));
  }, [viewNotes, search]);

  return {
    filteredNotes,
    selectedAttachments,
    selectedNote
  };
}

export function notesForView({
  notes,
  notesView,
  selectedFolderId,
  trashNotes
}: NotesForViewInput): DecryptedNote[] {
  switch (notesView) {
    case "settings":
      return [];
    case "trash":
      return trashNotes;
    case "shared":
      return notes.filter(isSharedNote);
    case "notes":
      return selectedFolderId
        ? notes.filter((note) => note.folderId === selectedFolderId)
        : notes;
  }
}

function isSharedNote(note: DecryptedNote): boolean {
  return note.role !== "owner";
}
