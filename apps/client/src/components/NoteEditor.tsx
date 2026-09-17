import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
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
import { sectionRuntimeKey, useAppStore } from "../store/appStore";

interface NoteEditorProps {
  notesView: NotesView;
  selectedNote: DecryptedNote | null;
  resolveAttachmentUrl: (url: string) => Promise<string>;
  updateSelectedNote: (patch: Partial<Pick<DecryptedNote, "folderId" | "title">>) => void;
  uploadSelectedAttachment: (file: File | undefined) => Promise<AttachmentSummary | null>;
}

interface BlockNoteFieldProps {
  canEdit: boolean;
  sectionReady: boolean;
  resolveAttachmentUrl: NoteEditorProps["resolveAttachmentUrl"];
  selectedNote: DecryptedNote;
  sectionId: string;
  uploadSelectedAttachment: NoteEditorProps["uploadSelectedAttachment"];
}

function CollaborativeBlockNoteField({
  canEdit,
  sectionReady,
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
    restoreDevelopmentUndoManager(editor);
  }, [editor]);

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
      {canEdit ? (
        <div className="action-row editor-history-controls">
          <button
            className="text-button"
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              editor.undo();
            }}
          >
            Undo
          </button>
          <button
            className="text-button"
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              editor.redo();
            }}
          >
            Redo
          </button>
        </div>
      ) : null}
      <div
        onFocusCapture={() => {
          restoreDevelopmentUndoManager(editor);
        }}
      >
        <div className="blocknote-surface" data-theme="light">
          {/* Edits made before the section's history arrives are replaced when it
              does, so content stays read-only until the section has loaded. */}
          <BlockNoteView
            editor={editor}
            editable={canEdit && sectionReady}
            filePanel={false}
          >
            {canEdit ? <FilePanelController filePanel={FortnoteFilePanel} /> : null}
          </BlockNoteView>
        </div>
      </div>
    </>
  );
}

function restoreDevelopmentUndoManager(editor: BlockNoteEditor<BlockSchema>): void {
  if (!import.meta.env.DEV) {
    return;
  }
  const state = editor.prosemirrorState;
  const undoState = state.plugins
    .find((plugin) => (plugin as unknown as { key: string }).key === "y-undo$")
    ?.getState(state) as { undoManager: Y.UndoManager } | undefined;
  const undoManager = undoState?.undoManager;
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
  const realtimeStatus = useAppStore((state) => state.realtimeStatus);
  const status = useAppStore((state) => state.status);
  const sectionId = selectedNote?.rootSectionId ?? "root";
  const sectionReady = useAppStore(
    (state) =>
      selectedNote !== null &&
      state.loadedSections[sectionRuntimeKey(selectedNote.id, sectionId)]?.status ===
        "ready"
  );

  if (!selectedNote) {
    return (
      <div className="editor-column">
        <FileText size={20} />
        <p className="muted">Select or create a note.</p>
      </div>
    );
  }
  const saveLabel =
    status === "Save conflict"
      ? "Changes need review"
      : status === "Save failed"
        ? "Save failed"
        : realtimeStatus === "disconnected"
          ? "Offline — changes kept on this device"
          : status === "Ready" ||
              status === "Note encrypted and saved" ||
              status === "Note shared"
            ? "Saved and synchronized"
            : "Saving…";

  return (
    <div className="editor-column">
      <div className="editor-title-row">
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
        <span className="editor-save-status" aria-live="polite">
          {saveLabel}
        </span>
      </div>
      <div className="block-editor">
        <CollaborativeBlockNoteField
          key={`${selectedNote.id}:root:${String(selectedNote.keyEpoch)}:${canEdit ? "edit" : "view"}`}
          canEdit={canEdit}
          sectionReady={sectionReady}
          resolveAttachmentUrl={resolveAttachmentUrl}
          selectedNote={selectedNote}
          sectionId={sectionId}
          uploadSelectedAttachment={uploadSelectedAttachment}
        />
      </div>
    </div>
  );
}
