import { FileText, Redo2, Undo2 } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  EmbedTab,
  FilePanelController,
  type FilePanelProps,
  UploadTab,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
  useDictionary
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import type { BlockNoteEditor, BlockSchema } from "@blocknote/core";
import type * as Y from "yjs";
import type { AttachmentSummary } from "../api";
import { getCrdtFragment, getCrdtProvider, updateCrdtNote } from "../realtime/crdt";
import {
  formatAttachmentReference,
  isAttachmentMimeCompatible
} from "../lib/attachmentMedia";
import type { DecryptedNote, NotesView } from "../store/appStore";
import { useAppStore } from "../store/appStore";

interface NoteEditorProps {
  notesView: NotesView;
  selectedNote: DecryptedNote | null;
  resolveAttachmentUrl: (url: string) => Promise<string>;
  updateSelectedNote: (patch: Partial<Pick<DecryptedNote, "folderId" | "title">>) => void;
  uploadSelectedAttachment: (file: File | undefined) => Promise<AttachmentSummary | null>;
}

interface BlockNoteFieldProps {
  canEdit: boolean;
  title: ReactNode;
  resolveAttachmentUrl: NoteEditorProps["resolveAttachmentUrl"];
  selectedNote: DecryptedNote;
  sectionId: string;
  uploadSelectedAttachment: NoteEditorProps["uploadSelectedAttachment"];
}

function CollaborativeBlockNoteField({
  canEdit,
  title,
  resolveAttachmentUrl,
  selectedNote,
  sectionId,
  uploadSelectedAttachment
}: BlockNoteFieldProps) {
  const user = useAppStore((state) => state.user);
  const fragment = getCrdtFragment(selectedNote.id, selectedNote.keyEpoch, sectionId);
  const provider = getCrdtProvider(selectedNote.id, selectedNote.keyEpoch, sectionId);
  const editor = useCreateBlockNote({
    domAttributes: {
      editor: { "aria-label": "Note content" }
    },
    collaboration: {
      fragment,
      user: { name: user?.username ?? "User", color: "#30bced" },
      provider: { awareness: provider.awareness },
      showCursorLabels: "activity"
    },
    resolveFileUrl: resolveAttachmentUrl,
    ...(canEdit
      ? {
          uploadFile: async (file: File) => {
            const attachment = await uploadSelectedAttachment(file);
            if (!attachment) {
              throw new Error("Attachment upload failed");
            }
            return {
              props: {
                name: attachment.filename,
                url: formatAttachmentReference(attachment.id)
              }
            };
          }
        }
      : {})
  }) as unknown as BlockNoteEditor<BlockSchema>;
  useEffect(() => {
    reattachUndoManager(editor);
    return editor.onMount(() => {
      reattachUndoManager(editor);
    });
  }, [editor]);

  // Edits made before the section's history first arrives are replaced when it
  // does, so content stays read-only until then. Later reconnects resume into
  // the same document and keep it editable.
  const [historyLoaded, setHistoryLoaded] = useState(provider.isSynced);
  useEffect(() => {
    const markLoaded = () => {
      setHistoryLoaded(true);
    };
    if (provider.isSynced) {
      markLoaded();
    }
    provider.on("synced", markLoaded);
    return () => {
      provider.off("synced", markLoaded);
    };
  }, [provider]);

  const setError = useAppStore((state) => state.setError);
  const setNotes = useAppStore((state) => state.setNotes);
  const setStatus = useAppStore((state) => state.setStatus);

  useEffect(() => {
    if (!canEdit) {
      return;
    }
    const handleSaveState = (state?: unknown) => {
      if (state === "saving") {
        setError(null);
        setStatus("Saving encrypted note");
        return;
      }
      if (state === "failed") {
        setStatus("Save failed");
        return;
      }
      if (state !== "saved") {
        return;
      }
      const updatedAt = new Date().toISOString();
      setNotes((notes) =>
        notes.map((note) => (note.id === selectedNote.id ? { ...note, updatedAt } : note))
      );
      setError(null);
      setStatus("Ready");
    };
    provider.on("save-state", handleSaveState);
    return () => {
      provider.off("save-state", handleSaveState);
    };
  }, [canEdit, provider, selectedNote.id, setError, setNotes, setStatus]);

  useEffect(() => {
    updateCrdtNote(selectedNote);
  }, [selectedNote]);

  return (
    <>
      <div className="editor-title-row">
        {title}
        {canEdit ? <HistoryControls editor={editor} /> : null}
      </div>
      <div className="blocknote-surface" data-theme="light">
        <BlockNoteView
          editor={editor}
          editable={canEdit && historyLoaded}
          filePanel={false}
        >
          {canEdit ? <FilePanelController filePanel={FortnoteFilePanel} /> : null}
        </BlockNoteView>
      </div>
    </>
  );
}

function HistoryControls({ editor }: { editor: BlockNoteEditor<BlockSchema> }) {
  const [history, setHistory] = useState(() => historyAvailability(editor));
  useEffect(() => {
    // Remounting the editor destroys the undo manager's event listeners (see
    // reattachUndoManager), so its stacks are read after each editor change
    // instead. Yjs updates the stacks after the editor applies an undo, so the
    // read waits for that transaction to finish.
    const refresh = () => {
      setHistory(historyAvailability(editor));
    };
    refresh();
    return editor.onChange(() => {
      queueMicrotask(refresh);
    });
  }, [editor]);

  const run = (action: () => void) => {
    action();
    setHistory(historyAvailability(editor));
  };
  const keepEditorFocus = (event: MouseEvent) => {
    event.preventDefault();
  };

  return (
    <div className="history-controls" role="group" aria-label="Edit history">
      <button
        type="button"
        aria-label="Undo"
        aria-keyshortcuts="Control+Z Meta+Z"
        disabled={!history.canUndo}
        onMouseDown={keepEditorFocus}
        onClick={() => {
          run(() => editor.undo());
        }}
      >
        <Undo2 size={17} aria-hidden="true" />
        <span className="history-tooltip" aria-hidden="true">
          Undo (Ctrl+Z)
        </span>
      </button>
      <button
        type="button"
        aria-label="Redo"
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
        disabled={!history.canRedo}
        onMouseDown={keepEditorFocus}
        onClick={() => {
          run(() => editor.redo());
        }}
      >
        <Redo2 size={17} aria-hidden="true" />
        <span className="history-tooltip" aria-hidden="true">
          Redo (Ctrl+Shift+Z)
        </span>
      </button>
    </div>
  );
}

function historyAvailability(editor: BlockNoteEditor<BlockSchema>): {
  canUndo: boolean;
  canRedo: boolean;
} {
  const undoManager = findUndoManager(editor);
  return {
    canUndo: (undoManager?.undoStack.length ?? 0) > 0,
    canRedo: (undoManager?.redoStack.length ?? 0) > 0
  };
}

function findUndoManager(
  editor: BlockNoteEditor<BlockSchema>
): Y.UndoManager | undefined {
  const state = editor.prosemirrorState;
  const undoState = state.plugins
    .find((plugin) => (plugin as unknown as { key: string }).key === "y-undo$")
    ?.getState(state) as { undoManager: Y.UndoManager } | undefined;
  return undoState?.undoManager;
}

// BlockNote remounts its view when `editable` changes (and twice under
// StrictMode). y-prosemirror destroys the undo manager with the old view but
// keeps it in the editor state, so the new view would stop recording history.
function reattachUndoManager(editor: BlockNoteEditor<BlockSchema>): void {
  const undoManager = findUndoManager(editor);
  const scope = undoManager?.scope[0];
  const doc = scope && "doc" in scope ? scope.doc : scope;
  if (!undoManager || !doc) {
    return;
  }
  undoManager.trackedOrigins.add(undoManager);
  doc.on("afterTransaction", undoManager.afterTransactionHandler);
}

export function FortnoteFilePanel({ blockId }: FilePanelProps) {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const editor = useBlockNoteEditor();
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const attachmentsByNote = useAppStore((state) => state.attachmentsByNote);
  const [loading, setLoading] = useState(false);
  const uploadTab = dict.file_panel.upload.title;
  const embedTab = dict.file_panel.embed.title;
  const [openTab, setOpenTab] = useState(uploadTab);
  const block = editor.getBlock(blockId)!;
  const acceptedMimeTypes =
    editor.schema.blockSpecs[block.type]?.implementation.meta?.fileBlockAccept ?? [];
  const attachments =
    (selectedNoteId ? attachmentsByNote[selectedNoteId] : undefined) ?? [];
  const compatibleAttachments = attachments.filter(({ mimeType }) =>
    isAttachmentMimeCompatible(mimeType, acceptedMimeTypes)
  );
  const tabs = [
    {
      name: uploadTab,
      tabPanel: <UploadTab blockId={blockId} setLoading={setLoading} />
    },
    {
      name: "Attachments",
      tabPanel: (
        <Components.FilePanel.TabPanel className="bn-tab-panel fortnote-attachment-tab">
          {compatibleAttachments.length === 0 ? (
            <p className="muted">No compatible attachments.</p>
          ) : (
            compatibleAttachments.map((attachment) => (
              <Components.FilePanel.Button
                key={attachment.id}
                className="bn-button"
                onClick={() => {
                  editor.updateBlock(blockId, {
                    props: {
                      name: attachment.filename,
                      url: formatAttachmentReference(attachment.id)
                    }
                  } as unknown as Parameters<typeof editor.updateBlock>[1]);
                }}
              >
                {attachment.filename}
              </Components.FilePanel.Button>
            ))
          )}
        </Components.FilePanel.TabPanel>
      )
    },
    {
      name: embedTab,
      tabPanel: <EmbedTab blockId={blockId} />
    }
  ];

  return (
    <Components.FilePanel.Root
      className="bn-panel"
      defaultOpenTab={uploadTab}
      loading={loading}
      openTab={openTab}
      setOpenTab={setOpenTab}
      tabs={tabs}
    />
  );
}

export function NoteEditor({
  notesView,
  selectedNote,
  updateSelectedNote,
  resolveAttachmentUrl,
  uploadSelectedAttachment
}: NoteEditorProps) {
  const canEdit =
    selectedNote?.role !== undefined &&
    selectedNote.role !== "viewer" &&
    notesView !== "trash";
  const setLocalPresenceState = useAppStore((state) => state.setLocalPresenceState);
  const selectedNoteId = selectedNote?.id;
  // Collaborators see this user as editing while focus is anywhere in the note.
  useEffect(
    () => () => {
      setLocalPresenceState("idle");
    },
    [canEdit, selectedNoteId, setLocalPresenceState]
  );

  if (!selectedNote) {
    return (
      <div className="editor-column">
        <FileText size={20} />
        <p className="muted">Select or create a note.</p>
      </div>
    );
  }
  const sectionId = selectedNote.rootSectionId ?? "root";

  // Save and sync state is shown once, in the editor header's collaboration status.
  const title = (
    <>
      <label className="visually-hidden" htmlFor="note-title-input">
        Title
      </label>
      <input
        id="note-title-input"
        className="editor-title-input"
        value={selectedNote.title}
        disabled={!canEdit}
        onChange={(event) => {
          updateSelectedNote({ title: event.target.value });
        }}
      />
    </>
  );

  return (
    <div className="editor-column">
      <div
        className="block-editor"
        onFocus={() => {
          if (canEdit) {
            setLocalPresenceState("editing");
          }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setLocalPresenceState("idle");
          }
        }}
      >
        <CollaborativeBlockNoteField
          key={`${selectedNote.id}:root:${String(selectedNote.keyEpoch)}:${canEdit ? "edit" : "view"}`}
          canEdit={canEdit}
          title={title}
          resolveAttachmentUrl={resolveAttachmentUrl}
          selectedNote={selectedNote}
          sectionId={sectionId}
          uploadSelectedAttachment={uploadSelectedAttachment}
        />
      </div>
    </div>
  );
}
