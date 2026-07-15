import { FileText } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useCreateBlockNote, useEditorChange } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import type { BlockNoteEditor, BlockSchema } from "@blocknote/core";
import type { AttachmentSummary, FolderSummary } from "../api";
import {
  attachCrdtNote,
  editCrdtNote,
  getCrdtFragment,
  getCrdtProvider,
  removeCrdtNote,
  updateCrdtNote
} from "../realtime/crdt";
import { blockNoteInitialContent } from "../lib/blockNote";
import type { DecryptedNote, NotesView } from "../store/appStore";
import { useAppStore } from "../store/appStore";
import { AttachmentPanel } from "./AttachmentPanel";
import { SharingPanel } from "./SharingPanel";

interface NoteEditorProps {
  canDeleteAttachments: boolean;
  folders: FolderSummary[];
  notesView: NotesView;
  selectedAttachments: AttachmentSummary[];
  selectedNote: DecryptedNote | null;
  downloadSelectedAttachment: (attachment: AttachmentSummary) => Promise<void>;
  removeSelectedAttachment: (attachmentId: string) => Promise<void>;
  updateSelectedNote: (
    patch: Partial<Pick<DecryptedNote, "folderId" | "title" | "body">>
  ) => void;
  uploadSelectedAttachment: (file: File | undefined) => Promise<void>;
}

interface BlockNoteFieldProps {
  canEdit: boolean;
  selectedNote: DecryptedNote;
  updateSelectedNote: NoteEditorProps["updateSelectedNote"];
}

function CollaborativeBlockNoteField({
  canEdit,
  selectedNote,
  updateSelectedNote
}: BlockNoteFieldProps) {
  const user = useAppStore((state) => state.user);
  const fragment = getCrdtFragment(selectedNote.id, selectedNote.keyEpoch);
  const provider = getCrdtProvider(selectedNote.id, selectedNote.keyEpoch);
  const editor = useCreateBlockNote({
    collaboration: {
      fragment,
      user: { name: user?.username ?? "User", color: "#30bced" },
      provider: { awareness: provider.awareness },
      showCursorLabels: "activity"
    }
  }) as unknown as BlockNoteEditor<BlockSchema>;
  const updateRef = useRef(updateSelectedNote);
  const lifecycleRef = useRef(0);
  const syncFrameRef = useRef<number | null>(null);
  updateRef.current = updateSelectedNote;
  const syncEditorBody = useCallback((currentEditor: BlockNoteEditor<BlockSchema>) => {
    if (syncFrameRef.current !== null) {
      return;
    }
    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = null;
      updateRef.current({ body: JSON.stringify(currentEditor.document) });
    });
  }, []);

  useEffect(
    () => () => {
      if (syncFrameRef.current !== null) {
        cancelAnimationFrame(syncFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    updateCrdtNote(selectedNote);
  }, [selectedNote]);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    const detach = attachCrdtNote(selectedNote, (patch) => {
      updateRef.current(patch);
    });
    const syncBody = () => {
      updateRef.current({ body: JSON.stringify(editor.document) });
    };
    if (provider.isSynced) {
      syncBody();
    } else {
      provider.on("synced", syncBody);
    }
    return () => {
      detach();
      provider.off("synced", syncBody);
      queueMicrotask(() => {
        if (lifecycleRef.current === lifecycle) {
          removeCrdtNote(selectedNote.id, provider);
        }
      });
    };
  }, [editor, provider, selectedNote.id]);

  useEditorChange(syncEditorBody, editor);

  return <BlockNoteView editor={editor} editable={canEdit} />;
}

function ReadOnlyBlockNoteField({ selectedNote }: Pick<BlockNoteFieldProps, "selectedNote">) {
  const editor = useCreateBlockNote({
    initialContent: blockNoteInitialContent(selectedNote.body)
  }) as unknown as BlockNoteEditor<BlockSchema>;

  return <BlockNoteView editor={editor} editable={false} />;
}

export function NoteEditor({
  canDeleteAttachments,
  folders,
  notesView,
  selectedAttachments,
  selectedNote,
  downloadSelectedAttachment,
  removeSelectedAttachment,
  updateSelectedNote,
  uploadSelectedAttachment
}: NoteEditorProps) {
  const canEdit =
    selectedNote?.role !== undefined &&
    selectedNote.role !== "viewer" &&
    notesView !== "trash";
  const canMove = selectedNote?.role === "owner" && notesView !== "trash";
  const setLocalPresenceState = useAppStore((state) => state.setLocalPresenceState);

  function markEditing() {
    if (canEdit) {
      setLocalPresenceState("editing");
    }
  }

  function markIdle() {
    setLocalPresenceState("idle");
  }

  if (!selectedNote) {
    return (
      <div className="editor-column">
        <FileText size={20} />
        <p className="muted">Select or create a note.</p>
      </div>
    );
  }

  return (
    <div className="editor-column">
      <FileText size={20} />
      <label>
        Folder
        <select
          value={selectedNote.folderId ?? ""}
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
          value={selectedNote.title}
          disabled={!canEdit}
          onBlur={markIdle}
          onChange={(event) => {
            markEditing();
            if (!editCrdtNote(selectedNote.id, { title: event.target.value })) {
              updateSelectedNote({ title: event.target.value });
            }
          }}
          onFocus={markEditing}
        />
      </label>
      <div className="block-editor" onBlurCapture={markIdle} onFocusCapture={markEditing}>
        {notesView === "trash" ? (
          <ReadOnlyBlockNoteField
            key={`${selectedNote.id}:${String(selectedNote.keyEpoch)}:trash`}
            selectedNote={selectedNote}
          />
        ) : (
          <CollaborativeBlockNoteField
            key={`${selectedNote.id}:${String(selectedNote.keyEpoch)}`}
            canEdit={canEdit}
            selectedNote={selectedNote}
            updateSelectedNote={updateSelectedNote}
          />
        )}
      </div>
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
      <AttachmentPanel
        canDeleteAttachments={canDeleteAttachments}
        downloadSelectedAttachment={downloadSelectedAttachment}
        removeSelectedAttachment={removeSelectedAttachment}
        selectedAttachments={selectedAttachments}
      />
      <SharingPanel selectedNote={selectedNote} disabled={notesView === "trash"} />
    </div>
  );
}
