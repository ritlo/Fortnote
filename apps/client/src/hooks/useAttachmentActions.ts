import { useCallback, useEffect, useRef } from "react";
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
import { parseAttachmentReference } from "../lib/attachmentMedia";
import { downloadBytes } from "../lib/browser";
import { useAppStore, type DecryptedNote } from "../store/appStore";

interface AttachmentUrlCacheEntry {
  attachmentId: string;
  keyEpoch: number;
  noteId: string;
  objectUrl?: string;
  promise: Promise<string>;
}

export function useAttachmentActions(selectedNote: DecryptedNote | null) {
  const user = useAppStore((state) => state.user);
  const selectedNoteId = useAppStore((state) => state.selectedNoteId);
  const attachmentsByNote = useAppStore((state) => state.attachmentsByNote);
  const setAttachmentsByNote = useAppStore((state) => state.setAttachmentsByNote);
  const setError = useAppStore((state) => state.setError);
  const setStatus = useAppStore((state) => state.setStatus);
  const noteRef = useRef(selectedNote);
  const attachmentsRef = useRef(attachmentsByNote);
  const attachmentLoads = useRef(new Map<string, Promise<AttachmentSummary[]>>());
  const urlCache = useRef(new Map<string, AttachmentUrlCacheEntry>());
  noteRef.current = selectedNote;
  attachmentsRef.current = attachmentsByNote;

  const storeAttachments = useCallback(
    (noteId: string, attachments: AttachmentSummary[]) => {
      attachmentsRef.current = {
        ...attachmentsRef.current,
        [noteId]: attachments
      };
      setAttachmentsByNote((current) => ({
        ...current,
        [noteId]: attachments
      }));
    },
    [setAttachmentsByNote]
  );

  const loadAttachments = useCallback(
    (noteId: string): Promise<AttachmentSummary[]> => {
      const loaded = attachmentsRef.current[noteId];
      if (loaded) {
        return Promise.resolve(loaded);
      }
      const inFlight = attachmentLoads.current.get(noteId);
      if (inFlight) {
        return inFlight;
      }
      const load = listAttachments(noteId)
        .then((payload) => {
          storeAttachments(noteId, payload.attachments);
          return payload.attachments;
        })
        .finally(() => {
          attachmentLoads.current.delete(noteId);
        });
      attachmentLoads.current.set(noteId, load);
      return load;
    },
    [storeAttachments]
  );

  useEffect(() => {
    if (!selectedNoteId || attachmentsByNote[selectedNoteId]) {
      return;
    }

    void loadAttachments(selectedNoteId)
      .catch((attachmentError: unknown) => {
        setStatus("Attachment load failed");
        setError(
          attachmentError instanceof Error
            ? attachmentError.message
            : "Unable to load attachments"
        );
      });
  }, [attachmentsByNote, loadAttachments, selectedNoteId, setError, setStatus]);

  const attachmentIds = selectedNote
    ? (attachmentsByNote[selectedNote.id] ?? [])
        .map((attachment) => attachment.id)
        .sort()
        .join(",")
    : "";

  useEffect(() => {
    const note = selectedNote;
    const currentIds = new Set(attachmentIds ? attachmentIds.split(",") : []);
    for (const [key, entry] of urlCache.current) {
      if (
        entry.noteId !== note?.id ||
        entry.keyEpoch !== note.keyEpoch ||
        !currentIds.has(entry.attachmentId)
      ) {
        revokeAttachmentUrl(urlCache.current, key, entry);
      }
    }
  }, [attachmentIds, selectedNote?.id, selectedNote?.keyEpoch]);

  useEffect(
    () => () => {
      for (const [key, entry] of urlCache.current) {
        revokeAttachmentUrl(urlCache.current, key, entry);
      }
    },
    []
  );

  async function refreshAttachments(noteId: string): Promise<AttachmentSummary[]> {
    const payload = await listAttachments(noteId);
    storeAttachments(noteId, payload.attachments);
    return payload.attachments;
  }

  async function uploadSelectedAttachment(
    file: File | undefined
  ): Promise<AttachmentSummary | null> {
    if (!file || !user || !selectedNote || selectedNote.role === "viewer") {
      return null;
    }

    setError(null);
    setStatus("Encrypting attachment");
    try {
      const encrypted = await createEncryptedAttachmentDraft({
        userId: selectedNote.cryptoOwnerId,
        noteId: selectedNote.id,
        noteKeyBase64: selectedNote.noteKeyBase64,
        file
      });
      const uploaded = await uploadAttachment(selectedNote.id, encrypted);
      const attachments = await refreshAttachments(selectedNote.id);
      const attachment = attachments.find(({ id }) => id === uploaded.id);
      if (!attachment) {
        throw new Error("Uploaded attachment is unavailable");
      }
      setStatus("Attachment encrypted and saved");
      return attachment;
    } catch (uploadError) {
      setStatus("Attachment failed");
      setError(
        uploadError instanceof Error ? uploadError.message : "Unable to upload attachment"
      );
      return null;
    }
  }

  async function downloadSelectedAttachment(attachment: AttachmentSummary) {
    if (!user || !selectedNote) {
      return;
    }

    setError(null);
    setStatus("Decrypting attachment");
    try {
      const plaintext = await decryptAuthorizedAttachment(selectedNote, attachment);
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

  const resolveAttachmentUrl = useCallback(
    async (url: string): Promise<string> => {
      const attachmentId = parseAttachmentReference(url);
      if (!attachmentId) {
        return url;
      }

      const note = noteRef.current;
      if (!note) {
        throw new Error("Attachment is unavailable");
      }
      const attachments = await loadAttachments(note.id);
      if (
        noteRef.current?.id !== note.id ||
        noteRef.current.keyEpoch !== note.keyEpoch
      ) {
        throw new Error("Attachment is no longer available");
      }
      const attachment = attachments.find(({ id }) => id === attachmentId);
      if (!attachment) {
        throw new Error("Attachment is unavailable");
      }

      const key = `${note.id}:${String(note.keyEpoch)}:${attachmentId}`;
      const cached = urlCache.current.get(key);
      if (cached) {
        return cached.promise;
      }

      const entry: AttachmentUrlCacheEntry = {
        attachmentId,
        keyEpoch: note.keyEpoch,
        noteId: note.id,
        promise: Promise.resolve("")
      };
      entry.promise = decryptAuthorizedAttachment(note, attachment)
        .then((plaintext) => {
          if (urlCache.current.get(key) !== entry) {
            throw new Error("Attachment is no longer available");
          }
          const objectUrl = URL.createObjectURL(
            new Blob([plaintext.slice()], { type: attachment.mimeType })
          );
          entry.objectUrl = objectUrl;
          return objectUrl;
        })
        .catch((error: unknown) => {
          if (urlCache.current.get(key) === entry) {
            urlCache.current.delete(key);
          }
          throw error;
        });
      urlCache.current.set(key, entry);
      return entry.promise;
    },
    [loadAttachments]
  );

  async function removeSelectedAttachment(attachmentId: string) {
    if (!selectedNote || selectedNote.role === "viewer") {
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
    resolveAttachmentUrl,
    uploadSelectedAttachment
  };
}

export async function decryptAuthorizedAttachment(
  selectedNote: DecryptedNote,
  attachment: AttachmentSummary
): Promise<Uint8Array> {
  const encrypted = await downloadAttachment(attachment.id);
  if (encrypted.id !== attachment.id || encrypted.noteId !== selectedNote.id) {
    throw new Error("Attachment does not belong to the selected note");
  }
  return decryptAttachmentBytes({
    userId: selectedNote.cryptoOwnerId,
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
}

function revokeAttachmentUrl(
  cache: Map<string, AttachmentUrlCacheEntry>,
  key: string,
  entry: AttachmentUrlCacheEntry
): void {
  cache.delete(key);
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
  }
}
