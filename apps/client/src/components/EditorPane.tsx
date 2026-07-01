import { FileText } from "lucide-react";
import type { AttachmentSummary, FolderSummary, User } from "../api";
import type { DecryptedNote, NotesView } from "../store/appStore";
import { AttachmentPanel } from "./AttachmentPanel";
import { SettingsPanel } from "./SettingsPanel";

interface EditorPaneProps {
  folders: FolderSummary[];
  keyMaterialVersion: number | null;
  newPassword: string;
  notesView: NotesView;
  previewHtml: string;
  recoverySecret: string | null;
  selectedAttachments: AttachmentSummary[];
  selectedNote: DecryptedNote | null;
  user: User;
  changePassword: () => Promise<void>;
  deleteSelectedForever: () => Promise<void>;
  downloadSelectedAttachment: (attachment: AttachmentSummary) => Promise<void>;
  lockVault: () => void;
  moveSelectedToTrash: () => Promise<void>;
  removeSelectedAttachment: (attachmentId: string) => Promise<void>;
  restoreSelectedNote: () => Promise<void>;
  rotateRecoveryKey: () => Promise<void>;
  saveSelectedNote: () => Promise<void>;
  setNewPassword: (value: string) => void;
  updateSelectedNote: (
    patch: Partial<Pick<DecryptedNote, "folderId" | "title" | "body">>
  ) => void;
  uploadSelectedAttachment: (file: File | undefined) => Promise<void>;
}

export function EditorPane({
  folders,
  keyMaterialVersion,
  newPassword,
  notesView,
  previewHtml,
  recoverySecret,
  selectedAttachments,
  selectedNote,
  user,
  changePassword,
  deleteSelectedForever,
  downloadSelectedAttachment,
  lockVault,
  moveSelectedToTrash,
  removeSelectedAttachment,
  restoreSelectedNote,
  rotateRecoveryKey,
  saveSelectedNote,
  setNewPassword,
  updateSelectedNote,
  uploadSelectedAttachment
}: EditorPaneProps) {
  return (
    <section className="editor-pane">
      <header className="pane-header">
        <div>
          <h2>
            {notesView === "settings"
              ? "Vault settings"
              : selectedNote?.title ?? "No note selected"}
          </h2>
          <p>
            {user.username} ·{" "}
            {keyMaterialVersion
              ? `key material v${String(keyMaterialVersion)}`
              : "root key in memory only"}
          </p>
        </div>
        {notesView === "settings" ? (
          <div className="action-row">
            <button
              className="text-button"
              type="button"
              onClick={() => {
                lockVault();
              }}
            >
              Lock vault
            </button>
          </div>
        ) : (
          <>
            <button
              className="primary"
              type="button"
              disabled={!selectedNote || notesView === "trash"}
              onClick={() => {
                void saveSelectedNote();
              }}
            >
              Save
            </button>
            {notesView === "trash" ? (
              <div className="action-row">
                <button
                  className="text-button"
                  type="button"
                  disabled={!selectedNote}
                  onClick={() => {
                    void restoreSelectedNote();
                  }}
                >
                  Restore
                </button>
                <button
                  className="text-button danger"
                  type="button"
                  disabled={!selectedNote}
                  onClick={() => {
                    void deleteSelectedForever();
                  }}
                >
                  Delete forever
                </button>
              </div>
            ) : (
              <button
                className="text-button danger"
                type="button"
                disabled={!selectedNote}
                onClick={() => {
                  void moveSelectedToTrash();
                }}
              >
                Delete
              </button>
            )}
          </>
        )}
      </header>
      {notesView === "settings" ? (
        <SettingsPanel
          changePassword={changePassword}
          newPassword={newPassword}
          recoverySecret={recoverySecret}
          rotateRecoveryKey={rotateRecoveryKey}
          setNewPassword={setNewPassword}
        />
      ) : (
        <div className="editor-grid">
          <div className="editor-column">
            <FileText size={20} />
            <label>
              Folder
              <select
                value={selectedNote?.folderId ?? ""}
                disabled={!selectedNote || notesView === "trash"}
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
                value={selectedNote?.title ?? ""}
                disabled={!selectedNote || notesView === "trash"}
                onChange={(event) => {
                  updateSelectedNote({ title: event.target.value });
                }}
              />
            </label>
            <label>
              Markdown editor
              <textarea
                value={selectedNote?.body ?? ""}
                disabled={!selectedNote || notesView === "trash"}
                onChange={(event) => {
                  updateSelectedNote({ body: event.target.value });
                }}
              />
            </label>
            <label>
              Attach encrypted file
              <input
                type="file"
                disabled={!selectedNote || notesView === "trash"}
                onChange={(event) => {
                  void uploadSelectedAttachment(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
          <div className="editor-column preview">
            <h3>Preview</h3>
            <div className="preview-body">
              <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
            <AttachmentPanel
              downloadSelectedAttachment={downloadSelectedAttachment}
              removeSelectedAttachment={removeSelectedAttachment}
              selectedAttachments={selectedAttachments}
            />
            <div className="notice">Plaintext stays in browser memory.</div>
          </div>
        </div>
      )}
    </section>
  );
}
