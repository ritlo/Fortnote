import { useAttachmentActions } from "../hooks/useAttachmentActions";
import { useAuthActions } from "../hooks/useAuthActions";
import { useNoteActions } from "../hooks/useNoteActions";
import { useNoteViewModel } from "../hooks/useNoteViewModel";
import { useSectionData } from "../hooks/useSectionData";
import { useSectionActions } from "../hooks/useSectionActions";
import { useAppStore } from "../store/appStore";
import { EditorPane } from "./EditorPane";
import { NotesPane } from "./NotesPane";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  const user = useAppStore((state) => state.user);
  const keyMaterialVersion = useAppStore((state) => state.keyMaterialVersion);
  const newPassword = useAppStore((state) => state.newPassword);
  const folders = useAppStore((state) => state.folders);
  const notesView = useAppStore((state) => state.notesView);
  const selectedFolderId = useAppStore((state) => state.selectedFolderId);
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const search = useAppStore((state) => state.search);
  const recoverySecret = useAppStore((state) => state.recoverySecret);
  const error = useAppStore((state) => state.error);
  const status = useAppStore((state) => state.status);
  const realtimeStatus = useAppStore((state) => state.realtimeStatus);
  const setNewPassword = useAppStore((state) => state.setNewPassword);
  const setNotesView = useAppStore((state) => state.setNotesView);
  const setSelectedFolderId = useAppStore((state) => state.setSelectedFolderId);
  const setSelectedNoteId = useAppStore((state) => state.setSelectedNoteId);
  const setSearch = useAppStore((state) => state.setSearch);
  const noteView = useNoteViewModel();
  const sectionData = useSectionData(noteView.selectedNote);
  const sectionActions = useSectionActions(noteView.selectedNote);
  const authActions = useAuthActions();
  const noteActions = useNoteActions(noteView.selectedNote);
  const attachmentActions = useAttachmentActions(noteView.selectedNote);

  if (!user) {
    return null;
  }

  return (
    <main className="app-shell">
      <Sidebar
        addFolder={noteActions.addFolder}
        folders={folders}
        notesView={notesView}
        openNotes={noteActions.openNotes}
        openSharedNotes={noteActions.openSharedNotes}
        openSettings={() => {
          setNotesView("settings");
          setSelectedNoteId(null);
          setSelectedFolderId(null);
        }}
        openTrash={noteActions.openTrash}
        removeFolder={noteActions.removeFolder}
        selectedFolderId={selectedFolderId}
        submitLogout={authActions.submitLogout}
      />
      <NotesPane
        addNote={noteActions.addNote}
        error={error}
        filteredNotes={noteView.filteredNotes}
        notesView={notesView}
        recoverySecret={recoverySecret}
        search={search}
        selectedNoteId={selectedNoteId}
        setSearch={setSearch}
        setSelectedNoteId={setSelectedNoteId}
        realtimeStatus={realtimeStatus}
        status={status}
      />
      <EditorPane
        changePassword={authActions.changePassword}
        cleanupSharingKeys={authActions.cleanupSharingKeys}
        deleteSelectedForever={noteActions.deleteSelectedForever}
        downloadSelectedAttachment={attachmentActions.downloadSelectedAttachment}
        folders={folders}
        keyMaterialVersion={keyMaterialVersion}
        lockVault={authActions.lockVault}
        moveSelectedToTrash={noteActions.moveSelectedToTrash}
        newPassword={newPassword}
        notesView={notesView}
        recoverySecret={recoverySecret}
        removeSelectedAttachment={attachmentActions.removeSelectedAttachment}
        resolveAttachmentUrl={attachmentActions.resolveAttachmentUrl}
        retrySectionLoad={sectionData.retry}
        restoreSelectedNote={noteActions.restoreSelectedNote}
        rotateRecoveryKey={authActions.rotateRecoveryKey}
        rotateSharingKey={authActions.rotateSharingKey}
        selectedAttachments={noteView.selectedAttachments}
        selectedNote={noteView.selectedNote}
        sectionActions={sectionActions}
        setNewPassword={setNewPassword}
        updateSelectedNote={noteActions.updateSelectedNote}
        uploadSelectedAttachment={attachmentActions.uploadSelectedAttachment}
        user={user}
      />
    </main>
  );
}
