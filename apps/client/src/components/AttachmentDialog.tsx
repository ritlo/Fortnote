import { ArrowLeft, Download, File, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AttachmentSummary } from "../api";
import { formatAttachmentReference } from "../lib/attachmentMedia";

export interface AttachmentDialogProps {
  attachments: AttachmentSummary[] | undefined;
  canDelete: boolean;
  downloadAttachment: (attachment: AttachmentSummary) => Promise<void>;
  error: string | null;
  loading: boolean;
  noteTitle: string;
  onClose: () => void;
  open: boolean;
  removeAttachment: (attachmentId: string) => Promise<boolean>;
  resolveAttachmentUrl: (url: string) => Promise<string>;
}

export function AttachmentDialog({
  attachments,
  canDelete,
  downloadAttachment,
  error,
  loading,
  noteTitle,
  onClose,
  open,
  removeAttachment,
  resolveAttachmentUrl
}: AttachmentDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const selectedAttachment = attachments?.find(({ id }) => id === selectedAttachmentId);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      closeButtonRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => {
      setSelectedAttachmentId(null);
      onClose();
    };
    dialog.addEventListener("close", handleClose);
    return () => { dialog.removeEventListener("close", handleClose); };
  }, [onClose]);

  useEffect(() => {
    if (selectedAttachmentId && !selectedAttachment) {
      setSelectedAttachmentId(null);
    }
  }, [selectedAttachment, selectedAttachmentId]);

  useEffect(() => {
    if (!selectedAttachment) {
      setPreviewUrl(null);
      setPreviewError(null);
      return;
    }
    let active = true;
    setPreviewUrl(null);
    setPreviewError(null);
    void resolveAttachmentUrl(formatAttachmentReference(selectedAttachment.id))
      .then((url) => {
        if (active) setPreviewUrl(url);
      })
      .catch((previewFailure: unknown) => {
        if (active) {
          setPreviewError(
            previewFailure instanceof Error
              ? previewFailure.message
              : "Unable to preview attachment"
          );
        }
      });
    return () => { active = false; };
  }, [resolveAttachmentUrl, selectedAttachment]);

  if (!open && !dialogRef.current?.open) return null;

  const inPreview = selectedAttachmentId !== null;
  const title = selectedAttachment?.filename ?? "Attachments";

  async function handleDelete() {
    if (!selectedAttachment || deleting) return;
    setDeleting(true);
    try {
      const deleted = await removeAttachment(selectedAttachment.id);
      if (deleted) setSelectedAttachmentId(null);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="attachment-dialog" aria-label={`Attachments for ${noteTitle}`}>
      <header className="attachment-dialog-header">
        <div className="attachment-dialog-heading">
          {inPreview ? (
            <button
              className="icon-button"
              type="button"
              aria-label="Back to attachments"
              onClick={() => { setSelectedAttachmentId(null); }}
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </button>
          ) : null}
          <div>
            <p className="attachment-dialog-kicker">{noteTitle}</p>
            <h2>{title}</h2>
          </div>
        </div>
        <button
          ref={closeButtonRef}
          className="icon-button"
          type="button"
          aria-label="Close attachments"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className="attachment-dialog-body">
        {inPreview && selectedAttachment ? (
          <AttachmentPreview
            attachment={selectedAttachment}
            canDelete={canDelete}
            deleting={deleting}
            downloadAttachment={downloadAttachment}
            error={previewError}
            previewUrl={previewUrl}
            onDelete={() => { void handleDelete(); }}
          />
        ) : (
          <AttachmentList
            attachments={attachments}
            error={error}
            loading={loading}
            onSelect={setSelectedAttachmentId}
          />
        )}
      </div>
    </dialog>
  );
}

function AttachmentList({
  attachments,
  error,
  loading,
  onSelect
}: {
  attachments: AttachmentSummary[] | undefined;
  error: string | null;
  loading: boolean;
  onSelect: (attachmentId: string) => void;
}) {
  if (loading && attachments === undefined) {
    return <p className="attachment-dialog-state" role="status">Loading attachments…</p>;
  }
  if (error && attachments === undefined) {
    return <p className="attachment-dialog-state attachment-dialog-error" role="alert">{error}</p>;
  }
  if (!attachments || attachments.length === 0) {
    return <p className="attachment-dialog-state">No attachments in this note.</p>;
  }
  return (
    <div className="attachment-list" aria-label="Attachments in this note">
      {attachments.map((attachment) => (
        <button
          key={attachment.id}
          className="attachment-card"
          type="button"
          aria-label={attachment.filename}
          onClick={() => { onSelect(attachment.id); }}
        >
          <span className={`attachment-thumb ${attachment.mimeType.startsWith("image/") ? "image" : ""}`}>
            {attachment.mimeType.startsWith("image/") ? "IMG" : <File size={20} aria-hidden="true" />}
          </span>
          <span className="attachment-card-copy">
            <strong>{attachment.filename}</strong>
            <small>{formatAttachmentMetadata(attachment)}</small>
          </span>
          <span className="attachment-chevron" aria-hidden="true">›</span>
        </button>
      ))}
    </div>
  );
}

function AttachmentPreview({
  attachment,
  canDelete,
  deleting,
  downloadAttachment,
  error,
  previewUrl,
  onDelete
}: {
  attachment: AttachmentSummary;
  canDelete: boolean;
  deleting: boolean;
  downloadAttachment: (attachment: AttachmentSummary) => Promise<void>;
  error: string | null;
  previewUrl: string | null;
  onDelete: () => void;
}) {
  const isImage = attachment.mimeType.startsWith("image/");
  return (
    <div className="attachment-preview-view">
      <div className="attachment-preview-toolbar">
        <div>
          <strong>{attachment.filename}</strong>
          <small>{formatAttachmentMetadata(attachment)}</small>
        </div>
        <div className="attachment-preview-actions">
          {!error ? (
            <button
              className="text-button"
              type="button"
              onClick={() => { void downloadAttachment(attachment); }}
            >
              <Download size={16} aria-hidden="true" />
              Download
            </button>
          ) : null}
          {canDelete ? (
            <button
              className="danger-button"
              type="button"
              aria-label="Delete attachment"
              disabled={deleting}
              onClick={onDelete}
            >
              <Trash2 size={16} aria-hidden="true" />
              {deleting ? "Deleting…" : "Delete"}
            </button>
          ) : null}
        </div>
      </div>
      <div className="attachment-preview-canvas">
        {error ? (
          <div className="attachment-preview-error" role="alert">
            <strong>Attachment unavailable</strong>
            <p>{error}</p>
          </div>
        ) : previewUrl ? (
          isImage ? (
            <img src={previewUrl} alt={`Preview of ${attachment.filename}`} />
          ) : (
            <div className="attachment-file-preview">
              <File size={48} aria-hidden="true" />
              <strong>{attachment.filename}</strong>
              <p>Preview is ready to download.</p>
            </div>
          )
        ) : (
          <p className="attachment-dialog-state" role="status">Preparing preview…</p>
        )}
      </div>
    </div>
  );
}

function formatAttachmentMetadata(attachment: AttachmentSummary): string {
  return `${formatBytes(attachment.size)} · ${attachment.mimeType}`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
