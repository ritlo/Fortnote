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

    return viewNotes.filter(
      (note) =>
        note.title.toLowerCase().includes(query) ||
        blockNoteToText(note.body).toLowerCase().includes(query)
    );
  }, [viewNotes, search]);

  return {
    filteredNotes,
    selectedAttachments,
    selectedNote
  };
}

// ponytail: BlockNote bodies are JSON; extract plaintext without a dependency.
export function blockNoteToText(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? walkBlocks(parsed) : "";
  } catch {
    return "";
  }
}

function walkBlocks(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      for (const item of record.content) {
        parts.push(walkInline(item));
      }
    }
    if (Array.isArray(record.children)) {
      parts.push(walkBlocks(record.children));
    }
  }
  return parts.join(" ");
}

function walkInline(content: unknown): string {
  if (!content || typeof content !== "object") {
    return "";
  }
  const record = content as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (Array.isArray(record.content)) {
    return record.content.map(walkInline).join("");
  }
  return "";
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
