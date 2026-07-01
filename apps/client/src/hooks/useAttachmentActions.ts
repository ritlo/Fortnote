import { useEffect } from "react";
import {
  deleteAttachment,
  downloadAttachment,
  listAttachments,
  uploadAttachment,
  type AttachmentSummary
} from "../api";
import {
  createEncryptedAttachmentDraft,
  decryptAttachmentBytes
} from "../cryptoClient";
import { downloadBytes } from "../lib/browser";
import { useAppStore, type DecryptedNote } from "../store/appStore";

export function useAttachmentActions(selectedNote: DecryptedNote | null) {
  const user = useAppStore((state) => state.user);
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const attachmentsByNote = useAppStore((state) => state.attachmentsByNote);
  const setAttachmentsByNote = useAppStore((state) => state.setAttachmentsByNote);
  const setError = useAppStore((state) => state.setError);
  const setStatus = useAppStore((state) => state.setStatus);

  useEffect(() => {
    if (!selectedNoteId || attachmentsByNote[selectedNoteId]) {
      return;
    }

    void listAttachments(selectedNoteId)
      .then((payload) => {
        setAttachmentsByNote((current) => ({
          ...current,
          [selectedNoteId]: payload.attachments
        }));
      })
      .catch((attachmentError: unknown) => {
        setStatus("Attachment load failed");
        setError(
          attachmentError instanceof Error
            ? attachmentError.message
            : "Unable to load attachments"
        );
      });
  }, [attachmentsByNote, selectedNoteId, setAttachmentsByNote, setError, setStatus]);

  async function refreshAttachments(noteId: string) {
    const payload = await listAttachments(noteId);
    setAttachmentsByNote((current) => ({
      ...current,
      [noteId]: payload.attachments
    }));
  }

  async function uploadSelectedAttachment(file: File | undefined) {
    if (!file || !user || !selectedNote) {
      return;
    }

    setError(null);
    setStatus("Encrypting attachment");
    try {
      const encrypted = await createEncryptedAttachmentDraft({
        userId: user.id,
        noteId: selectedNote.id,
        noteKeyBase64: selectedNote.noteKeyBase64,
        file
      });
      await uploadAttachment(selectedNote.id, encrypted);
      await refreshAttachments(selectedNote.id);
      setStatus("Attachment encrypted and saved");
    } catch (uploadError) {
      setStatus("Attachment failed");
      setError(
        uploadError instanceof Error ? uploadError.message : "Unable to upload attachment"
      );
    }
  }

  async function downloadSelectedAttachment(attachment: AttachmentSummary) {
    if (!user || !selectedNote) {
      return;
    }

    setError(null);
    setStatus("Decrypting attachment");
    try {
      const encrypted = await downloadAttachment(attachment.id);
      const plaintext = await decryptAttachmentBytes({
        userId: user.id,
        noteId: selectedNote.id,
        noteKeyBase64: selectedNote.noteKeyBase64,
        attachmentId: attachment.id,
        encryptedAttachmentKey: {
          cipher: encrypted.encryptedAttachmentKey,
          nonce: encrypted.attachmentKeyNonce,
          formatVersion: 1
        },
        encryptedBytes: {
          cipher: encrypted.encryptedBytes,
          nonce: encrypted.fileNonce,
          formatVersion: 1
        }
      });
      downloadBytes(plaintext, attachment.filename, attachment.mimeType);
      setStatus("Attachment decrypted");
    } catch (downloadError) {
      setStatus("Attachment failed");
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Unable to download attachment"
      );
    }
  }

  async function removeSelectedAttachment(attachmentId: string) {
    if (!selectedNote) {
      return;
    }

    setError(null);
    setStatus("Deleting attachment");
    try {
      await deleteAttachment(attachmentId);
      await refreshAttachments(selectedNote.id);
      setStatus("Attachment deleted");
    } catch (deleteError) {
      setStatus("Attachment failed");
      setError(
        deleteError instanceof Error ? deleteError.message : "Unable to delete attachment"
      );
    }
  }

  return {
    downloadSelectedAttachment,
    removeSelectedAttachment,
    uploadSelectedAttachment
  };
}
