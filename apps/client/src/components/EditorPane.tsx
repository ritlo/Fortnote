import type { AttachmentSummary, FolderSummary, User } from "../api";
import type { DecryptedNote, NotesView } from "../store/appStore";
import { EditorHeader } from "./EditorHeader";
import { NoteEditor } from "./NoteEditor";
import { SettingsPanel } from "./SettingsPanel";

interface EditorPaneProps {
  folders: FolderSummary[];
  keyMaterialVersion: number | null;
  newPassword: string;
  notesView: NotesView;
  recoverySecret: string | null;
  retrySectionLoad?: (() => void) | undefined;
  selectedAttachments: AttachmentSummary[];
  selectedNote: DecryptedNote | null;
  user: User;
  changePassword: () => Promise<void>;
  cleanupSharingKeys: () => Promise<void>;
  deleteSelectedForever: () => Promise<void>;
  downloadSelectedAttachment: (attachment: AttachmentSummary) => Promise<void>;
  lockVault: () => void;
  moveSelectedToTrash: () => Promise<void>;
  removeSelectedAttachment: (attachmentId: string) => Promise<void>;
  resolveAttachmentUrl: (url: string) => Promise<string>;
  restoreSelectedNote: () => Promise<void>;
  rotateRecoveryKey: () => Promise<void>;
  rotateSharingKey: () => Promise<void>;
  setNewPassword: (value: string) => void;
  updateSelectedNote: (
    patch: Partial<Pick<DecryptedNote, "folderId" | "title" | "body">>
  ) => void;
  uploadSelectedAttachment: (file: File | undefined) => Promise<AttachmentSummary | null>;
}

export function EditorPane({
  folders,
  keyMaterialVersion,
  newPassword,
  notesView,
  recoverySecret,
  retrySectionLoad,
  selectedAttachments,
  selectedNote,
  user,
  changePassword,
  cleanupSharingKeys,
  deleteSelectedForever,
  downloadSelectedAttachment,
  lockVault,
  moveSelectedToTrash,
  removeSelectedAttachment,
  resolveAttachmentUrl,
  restoreSelectedNote,
  rotateRecoveryKey,
  rotateSharingKey,
  setNewPassword,
  updateSelectedNote,
  uploadSelectedAttachment
}: EditorPaneProps) {
  const canDeleteAttachments =
    selectedNote?.role !== undefined &&
    selectedNote.role !== "viewer" &&
    notesView !== "trash";

  return (
    <section className="editor-pane">
      <EditorHeader
        deleteSelectedForever={deleteSelectedForever}
        keyMaterialVersion={keyMaterialVersion}
        lockVault={lockVault}
        moveSelectedToTrash={moveSelectedToTrash}
        notesView={notesView}
        restoreSelectedNote={restoreSelectedNote}
        selectedNote={selectedNote}
        user={user}
      />
      {notesView === "settings" ? (
        <SettingsPanel
          changePassword={changePassword}
          cleanupSharingKeys={cleanupSharingKeys}
          newPassword={newPassword}
          recoverySecret={recoverySecret}
          rotateRecoveryKey={rotateRecoveryKey}
          rotateSharingKey={rotateSharingKey}
          setNewPassword={setNewPassword}
        />
      ) : (
        <NoteEditor
          canDeleteAttachments={canDeleteAttachments}
          downloadSelectedAttachment={downloadSelectedAttachment}
          folders={folders}
          notesView={notesView}
          removeSelectedAttachment={removeSelectedAttachment}
          resolveAttachmentUrl={resolveAttachmentUrl}
          retrySectionLoad={retrySectionLoad}
          selectedAttachments={selectedAttachments}
          selectedNote={selectedNote}
          updateSelectedNote={updateSelectedNote}
          uploadSelectedAttachment={uploadSelectedAttachment}
        />
      )}
    </section>
  );
}
