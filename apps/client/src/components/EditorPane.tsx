import { useState } from "react";
import type { AttachmentSummary, FolderSummary, User } from "../api";
import type { DecryptedNote, NotesView } from "../store/appStore";
import type { SectionActions } from "../hooks/useSectionActions";
import { EditorHeader } from "./EditorHeader";
import { NoteEditor } from "./NoteEditor";
import { SettingsPanel } from "./SettingsPanel";
import type { CollaborationState } from "../lib/collaborationState";
import { type RecoveryCallbacks } from "./RecoveryPanel";
import { RecoveryDialog } from "./RecoveryDialog";
import { SharingDialog } from "./SharingDialog";

interface EditorPaneProps {
  collaborationState: CollaborationState;
  recoveryCallbacks: RecoveryCallbacks;
  folders: FolderSummary[];
  keyMaterialVersion: number | null;
  newPassword: string;
  notesView: NotesView;
  recoverySecret: string | null;
  selectedNote: DecryptedNote | null;
  user: User;
  changePassword: () => Promise<void>;
  cleanupSharingKeys: () => Promise<void>;
  deleteSelectedForever: () => Promise<void>;
  lockVault: () => void;
  moveSelectedToTrash: () => Promise<void>;
  resolveAttachmentUrl: (url: string) => Promise<string>;
  restoreSelectedNote: () => Promise<void>;
  rotateRecoveryKey: () => Promise<void>;
  rotateSharingKey: () => Promise<void>;
  setNewPassword: (value: string) => void;
  updateSelectedNote: (
    patch: Partial<Pick<DecryptedNote, "folderId" | "title">>
  ) => void;
  uploadSelectedAttachment: (file: File | undefined) => Promise<AttachmentSummary | null>;
}

export function EditorPane({
  collaborationState,
  recoveryCallbacks,
  folders,
  keyMaterialVersion,
  newPassword,
  notesView,
  recoverySecret,
  selectedNote,
  user,
  changePassword,
  cleanupSharingKeys,
  deleteSelectedForever,
  lockVault,
  moveSelectedToTrash,
  resolveAttachmentUrl,
  restoreSelectedNote,
  rotateRecoveryKey,
  rotateSharingKey,
  setNewPassword,
  updateSelectedNote,
  uploadSelectedAttachment
}: EditorPaneProps) {
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const canShare =
    selectedNote !== null &&
    selectedNote.role !== "viewer" &&
    notesView !== "settings" &&
    notesView !== "trash";

  return (
    <section className="editor-pane">
      <EditorHeader
        canShare={canShare}
        collaborationState={collaborationState}
        deleteSelectedForever={deleteSelectedForever}
        keyMaterialVersion={keyMaterialVersion}
        lockVault={lockVault}
        moveSelectedToTrash={moveSelectedToTrash}
        notesView={notesView}
        onShare={() => { setSharingOpen(true); }}
        recoveryCallbacks={recoveryCallbacks}
        recoveryOpen={recoveryOpen}
        restoreSelectedNote={restoreSelectedNote}
        selectedNote={selectedNote}
        setRecoveryOpen={setRecoveryOpen}
        user={user}
      />
      <RecoveryDialog
        state={collaborationState}
        callbacks={recoveryCallbacks}
        open={recoveryOpen}
        onClose={() => { setRecoveryOpen(false); }}
      />
      <SharingDialog
        selectedNote={selectedNote}
        open={sharingOpen}
        onClose={() => { setSharingOpen(false); }}
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
          folders={folders}
          notesView={notesView}
          resolveAttachmentUrl={resolveAttachmentUrl}
          selectedNote={selectedNote}
          updateSelectedNote={updateSelectedNote}
          uploadSelectedAttachment={uploadSelectedAttachment}
        />
      )}
    </section>
  );
}
