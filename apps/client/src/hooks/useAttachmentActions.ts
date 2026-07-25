import { useCallback, useEffect, useRef } from "react";
import {
  deleteAttachment,
  downloadAttachment,
  listAttachments,
  listNoteEpochLinks,
  uploadAttachment,
  type AttachmentSummary,
  type BinaryTransferProgress,
  type EncryptedAttachmentSummary
} from "../api";
import {
  createEncryptedAttachmentDraft,
  decryptAttachmentBytes,
  decryptAttachmentMetadataV2
} from "../cryptoClient";
import { fromBase64, toBase64 } from "@fortnote/shared";
import { parseAttachmentReference } from "../lib/attachmentMedia";
import { downloadBytes } from "../lib/browser";
import { resolveNoteKeyAtEpoch } from "../lib/keyMaterial";
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
  const reportOperationFailure = useAppStore((state) => state.reportOperationFailure);
  const noteRef = useRef(selectedNote);
  const attachmentsRef = useRef(attachmentsByNote);
  const attachmentLoads = useRef(new Map<string, Promise<AttachmentSummary[]>>());
  const urlCache = useRef(new Map<string, AttachmentUrlCacheEntry>());
  const epochKeys = useRef(new Map<string, Promise<string>>());
  noteRef.current = selectedNote;
  attachmentsRef.current = attachmentsByNote;

  const noteAtEpoch = useCallback(
    async (note: DecryptedNote, targetEpoch: number): Promise<DecryptedNote> => {
      if (targetEpoch === note.keyEpoch) {
        return note;
      }
      const cacheKey = `${note.id}:${String(note.keyEpoch)}:${String(targetEpoch)}`;
      let pendingKey = epochKeys.current.get(cacheKey);
      if (!pendingKey) {
        pendingKey = listNoteEpochLinks(note.id).then(async ({ links }) =>
          toBase64(await resolveNoteKeyAtEpoch({ note, targetEpoch, links }))
        );
        epochKeys.current.set(cacheKey, pendingKey);
      }
      try {
        return { ...note, keyEpoch: targetEpoch, noteKeyBase64: await pendingKey };
      } catch (error) {
        epochKeys.current.delete(cacheKey);
        throw error;
      }
    },
    []
  );

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
        .then(async (payload) => {
          const note = noteRef.current;
          if (note?.id !== noteId) {
            throw new Error("Attachment metadata is no longer available");
          }
          const attachments = await Promise.all(
            payload.attachments.map(async (attachment) =>
              decryptAttachmentSummary(
                await noteAtEpoch(note, attachment.keyEpoch),
                attachment
              )
            )
          );
          if (noteRef.current?.id !== noteId) {
            throw new Error("Attachment metadata is no longer available");
          }
          storeAttachments(noteId, attachments);
          return attachments;
        })
        .finally(() => {
          attachmentLoads.current.delete(noteId);
        });
      attachmentLoads.current.set(noteId, load);
      return load;
    },
    [noteAtEpoch, storeAttachments]
  );

  useEffect(() => {
    if (
      !selectedNote ||
      !selectedNoteId ||
      selectedNote.id !== selectedNoteId ||
      attachmentsByNote[selectedNoteId]
    ) {
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

  useEffect(() => {
    const prefix = selectedNote
      ? `${selectedNote.id}:${String(selectedNote.keyEpoch)}:`
      : null;
    for (const key of epochKeys.current.keys()) {
      if (!prefix || !key.startsWith(prefix)) {
        epochKeys.current.delete(key);
      }
    }
  }, [selectedNote?.id, selectedNote?.keyEpoch]);

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
    const note = noteRef.current;
    if (note?.id !== noteId) {
      throw new Error("Attachment metadata is no longer available");
    }
    const attachments = await Promise.all(
      payload.attachments.map(async (attachment) =>
        decryptAttachmentSummary(
          await noteAtEpoch(note, attachment.keyEpoch),
          attachment
        )
      )
    );
    storeAttachments(noteId, attachments);
    return attachments;
  }

  async function uploadSelectedAttachment(
    file: File | undefined
  ): Promise<AttachmentSummary | null> {
    if (!file || !user || !selectedNote || !canWriteSelectedAttachment(selectedNote)) {
      return null;
    }

    setError(null);
    setStatus("Encrypting attachment");
    try {
      const encrypted = await createEncryptedAttachmentDraft({
        userId: selectedNote.cryptoOwnerId,
        noteId: selectedNote.id,
        keyEpoch: selectedNote.keyEpoch,
        noteKeyBase64: selectedNote.noteKeyBase64,
        file
      });
      if (!canWriteSelectedAttachment(selectedNote)) {
        return null;
      }
      const uploaded = await uploadAttachment(
        selectedNote.id,
        encrypted,
        (progress) => {
          setStatus(transferStatus("Uploading attachment", progress));
        }
      );
      if (uploaded.keyEpoch !== selectedNote.keyEpoch) {
        throw new Error("Attachment protection changed during upload");
      }
      const attachments = await refreshAttachments(selectedNote.id);
      const attachment = attachments.find(({ id }) => id === uploaded.id);
      if (!attachment) {
        throw new Error("Uploaded attachment is unavailable");
      }
      setStatus("Attachment encrypted and saved");
      return attachment;
    } catch (uploadError) {
      reportOperationFailure(
        uploadError,
        uploadError instanceof Error ? uploadError.message : "Unable to upload attachment",
        "Attachment failed"
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
      const plaintext = await decryptAuthorizedAttachment(
        await noteAtEpoch(selectedNote, attachment.keyEpoch),
        attachment,
        (progress) => {
          setStatus(transferStatus("Downloading attachment", progress));
        }
      );
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
      entry.promise = noteAtEpoch(note, attachment.keyEpoch)
        .then((epochNote) => decryptAuthorizedAttachment(epochNote, attachment))
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

  async function removeSelectedAttachment(attachmentId: string): Promise<boolean> {
    if (!selectedNote || !canWriteSelectedAttachment(selectedNote)) {
      return false;
    }

    setError(null);
    setStatus("Deleting attachment");
    try {
      await deleteAttachment(attachmentId);
      await refreshAttachments(selectedNote.id);
      setStatus("Attachment deleted");
      return true;
    } catch (deleteError) {
      setStatus("Attachment failed");
      setError(
        deleteError instanceof Error ? deleteError.message : "Unable to delete attachment"
      );
      return false;
    }
  }

  return {
    downloadSelectedAttachment,
    loadAttachments,
    removeSelectedAttachment,
    resolveAttachmentUrl,
    uploadSelectedAttachment
  };
}

function canWriteSelectedAttachment(note: DecryptedNote): boolean {
  const state = useAppStore.getState();
  return (
    state.user !== null &&
    state.selectedNoteId === note.id &&
    state.notesView !== "trash" &&
    !note.isDeleted &&
    note.role !== "viewer"
  );
}

export async function decryptAuthorizedAttachment(
  selectedNote: DecryptedNote,
  attachment: AttachmentSummary,
  onProgress?: (progress: BinaryTransferProgress) => void
): Promise<Uint8Array> {
  const encrypted = onProgress
    ? await downloadAttachment(attachment.id, onProgress)
    : await downloadAttachment(attachment.id);
  if (
    encrypted.id !== attachment.id ||
    encrypted.noteId !== selectedNote.id ||
    encrypted.keyEpoch !== attachment.keyEpoch ||
    selectedNote.keyEpoch !== attachment.keyEpoch
  ) {
    throw new Error("Attachment does not belong to the selected note");
  }
  return decryptAttachmentBytes({
    userId: selectedNote.cryptoOwnerId,
    noteId: selectedNote.id,
    noteKeyBase64: selectedNote.noteKeyBase64,
    attachmentId: attachment.id,
    encryptedAttachmentKey: {
      cipher: attachment.encryptedAttachmentKey,
      nonce: attachment.attachmentKeyNonce,
      formatVersion: 1
    },
    encryptedBytes: {
      cipher: toBase64(encrypted.encryptedBytes),
      nonce: attachment.fileNonce,
      formatVersion: 1
    }
  });
}

export async function decryptAttachmentSummary(
  selectedNote: DecryptedNote,
  attachment: EncryptedAttachmentSummary
): Promise<AttachmentSummary> {
  let metadata: { filename: string; mimeType: string };
  if (attachment.metadataFormatVersion === 2) {
    if (!attachment.metadataCipher || !attachment.metadataNonce) {
      throw new Error("Attachment metadata is incomplete");
    }
    if (attachment.keyEpoch !== selectedNote.keyEpoch) {
      throw new Error("Historical attachment key is not loaded");
    }
    metadata = await decryptAttachmentMetadataV2({
      cryptoOwnerId: selectedNote.cryptoOwnerId,
      noteId: selectedNote.id,
      attachmentId: attachment.id,
      keyEpoch: attachment.keyEpoch,
      noteKey: fromBase64(selectedNote.noteKeyBase64),
      envelope: {
        cipher: attachment.metadataCipher,
        nonce: attachment.metadataNonce,
        formatVersion: 2
      }
    });
  } else if (attachment.filename && attachment.mimeType) {
    metadata = { filename: attachment.filename, mimeType: attachment.mimeType };
  } else {
    throw new Error("Attachment metadata is unavailable");
  }

  return {
    id: attachment.id,
    filename: metadata.filename,
    mimeType: metadata.mimeType,
    keyEpoch: attachment.keyEpoch,
    size: attachment.size,
    encryptedAttachmentKey: attachment.encryptedAttachmentKey,
    attachmentKeyNonce: attachment.attachmentKeyNonce,
    fileNonce: attachment.fileNonce,
    createdAt: attachment.createdAt
  };
}

function transferStatus(label: string, progress: BinaryTransferProgress): string {
  if (!progress.totalBytes || progress.totalBytes <= 0) {
    return label;
  }
  const percentage = Math.min(
    100,
    Math.round((progress.loadedBytes / progress.totalBytes) * 100)
  );
  return `${label} ${String(percentage)}%`;
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
