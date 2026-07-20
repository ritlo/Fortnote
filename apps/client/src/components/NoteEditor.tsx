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
import type { AttachmentSummary, FolderSummary } from "../api";
import {
  getCrdtFragment,
  getCrdtProvider,
  updateCrdtNote
} from "../realtime/crdt";
import {
  formatAttachmentReference,
  isAttachmentMimeCompatible
} from "../lib/attachmentMedia";
import type { DecryptedNote, NotesView } from "../store/appStore";
import { sectionRuntimeKey, useAppStore } from "../store/appStore";
import { AttachmentPanel } from "./AttachmentPanel";
import { SharingPanel } from "./SharingPanel";
import { SectionNavigator } from "./SectionNavigator";
import type { SectionActions } from "../hooks/useSectionActions";

interface NoteEditorProps {
  canDeleteAttachments: boolean;
  folders: FolderSummary[];
  notesView: NotesView;
  selectedAttachments: AttachmentSummary[];
  selectedNote: DecryptedNote | null;
  sectionActions?: SectionActions;
  downloadSelectedAttachment: (attachment: AttachmentSummary) => Promise<void>;
  removeSelectedAttachment: (attachmentId: string) => Promise<void>;
  resolveAttachmentUrl: (url: string) => Promise<string>;
  retrySectionLoad?: (() => void) | undefined;
  updateSelectedNote: (
    patch: Partial<Pick<DecryptedNote, "folderId" | "title">>
  ) => void;
  uploadSelectedAttachment: (file: File | undefined) => Promise<AttachmentSummary | null>;
}

interface BlockNoteFieldProps {
  canEdit: boolean;
  resolveAttachmentUrl: NoteEditorProps["resolveAttachmentUrl"];
  selectedNote: DecryptedNote;
  sectionId: string;
  uploadSelectedAttachment: NoteEditorProps["uploadSelectedAttachment"];
}

function CollaborativeBlockNoteField({
  canEdit,
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
        <BlockNoteView editor={editor} editable={canEdit} filePanel={false}>
          {canEdit ? <FilePanelController filePanel={FortnoteFilePanel} /> : null}
        </BlockNoteView>
      </div>
    </>
  );
}

function restoreDevelopmentUndoManager(editor: BlockNoteEditor<BlockSchema>): void {
  if (!import.meta.env.DEV) {
    return;
  }
  const state = editor.prosemirrorState;
  const undoState = state.plugins.find(
    (plugin) => (plugin as unknown as { key: string }).key === "y-undo$"
  )?.getState(state) as { undoManager: Y.UndoManager } | undefined;
  const undoManager = undoState?.undoManager;
  const scope = undoManager?.scope[0];
  const doc = scope && "doc" in scope ? scope.doc : scope;
  if (!undoManager || !doc) {
    return;
  }
  // BlockNote 0.51/y-prosemirror 1.3 destroys this manager during StrictMode replay.
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
  const attachments = (selectedNoteId ? attachmentsByNote[selectedNoteId] : undefined) ?? [];
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
                  editor.updateBlock(
                    blockId,
                    {
                      props: {
                        name: attachment.filename,
                        url: formatAttachmentReference(attachment.id)
                      }
                    } as unknown as Parameters<typeof editor.updateBlock>[1]
                  );
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
  canDeleteAttachments,
  folders,
  notesView,
  selectedAttachments,
  selectedNote,
  sectionActions,
  downloadSelectedAttachment,
  removeSelectedAttachment,
  resolveAttachmentUrl,
  retrySectionLoad,
  updateSelectedNote,
  uploadSelectedAttachment
}: NoteEditorProps) {
  const canEdit =
    selectedNote?.role !== undefined &&
    selectedNote.role !== "viewer" &&
    notesView !== "trash";
  const canMove = selectedNote?.role === "owner" && notesView !== "trash";
  const setLocalPresenceState = useAppStore((state) => state.setLocalPresenceState);
  const selectedSectionId = useAppStore((state) =>
    state.selectedSectionByNote[selectedNote?.id ?? ""] ?? null
  );
  const selectedSection = useAppStore((state) =>
    selectedNote && selectedSectionId
      ? state.loadedSections[sectionRuntimeKey(selectedNote.id, selectedSectionId)]
      : undefined
  );
  const sectionIndex = useAppStore((state) =>
    selectedNote ? state.sectionIndexes[selectedNote.id] : undefined
  );

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
            const title = event.target.value;
            updateSelectedNote({ title });
          }}
          onFocus={markEditing}
        />
      </label>
      {selectedNote.rootSectionId && !selectedNote.legacyContentAvailable ? (
        <SectionNavigator
          canEdit={canEdit}
          noteId={selectedNote.id}
          {...(sectionActions
            ? {
                onCopy: (sectionId: string) => {
                  void sectionActions.copySectionToNext(sectionId);
                },
                onCreate: () => {
                  void sectionActions.createSection();
                },
                onDelete: (sectionId: string) => {
                  void sectionActions.deleteSection(sectionId);
                },
                onMerge: (sectionId: string) => {
                  void sectionActions.mergeSectionWithNext(sectionId);
                },
                onMove: (sectionId: string, direction: -1 | 1) => {
                  void sectionActions.moveSection(sectionId, direction);
                },
                onSplit: (sectionId: string) => {
                  void sectionActions.splitSection(sectionId);
                }
              }
            : {})}
          onRetry={retrySectionLoad}
        />
      ) : null}
      <div className="block-editor" onBlurCapture={markIdle} onFocusCapture={markEditing}>
        {selectedNote.legacyContentAvailable && !selectedNote.legacyBodyLoaded ? (
          sectionIndex?.status === "error" ? (
            <div role="alert" className="section-loading-status">
              {sectionIndex.error ?? "Legacy encrypted note could not open"}
              <button type="button" disabled={!retrySectionLoad} onClick={retrySectionLoad}>
                Retry
              </button>
            </div>
          ) : (
            <div aria-live="polite" className="section-loading-status">
              Migrating encrypted note…
            </div>
          )
        ) : notesView === "trash" ? (
          selectedNote.legacyContentAvailable ? (
            <CollaborativeBlockNoteField
              key={`${selectedNote.id}:root:${String(selectedNote.keyEpoch)}:trash`}
              canEdit={false}
              resolveAttachmentUrl={resolveAttachmentUrl}
              selectedNote={selectedNote}
              sectionId="root"
              uploadSelectedAttachment={uploadSelectedAttachment}
            />
          ) : (
            <div className="section-loading-status">
              Restore this note to open its encrypted sections.
            </div>
          )
        ) : selectedNote.legacyContentAvailable || !selectedNote.rootSectionId ? (
          <CollaborativeBlockNoteField
            key={`${selectedNote.id}:root:${String(selectedNote.keyEpoch)}:${canEdit ? "edit" : "view"}`}
            canEdit={canEdit}
            resolveAttachmentUrl={resolveAttachmentUrl}
            selectedNote={selectedNote}
            sectionId="root"
            uploadSelectedAttachment={uploadSelectedAttachment}
          />
        ) : !selectedSectionId || selectedSection?.status === "loading" ? (
          <div aria-live="polite" className="section-loading-status">
            Loading section…
          </div>
        ) : selectedSection?.status === "error" ? (
          <div role="alert" className="section-loading-status">
            {selectedSection.error ?? "Encrypted section could not load"}
          </div>
        ) : selectedSection?.status === "ready" ? (
          <CollaborativeBlockNoteField
            key={`${selectedNote.id}:${selectedSectionId}:${String(selectedNote.keyEpoch)}:${canEdit ? "edit" : "view"}`}
            canEdit={canEdit}
            resolveAttachmentUrl={resolveAttachmentUrl}
            selectedNote={selectedNote}
            sectionId={selectedSectionId}
            uploadSelectedAttachment={uploadSelectedAttachment}
          />
        ) : (
          <div aria-live="polite" className="section-loading-status">
            Opening encrypted note…
          </div>
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
