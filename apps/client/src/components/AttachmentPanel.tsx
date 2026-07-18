import type { AttachmentSummary } from "../api";
import { formatBytes } from "../lib/browser";

interface AttachmentPanelProps {
  canDeleteAttachments: boolean;
  selectedAttachments: AttachmentSummary[];
  downloadSelectedAttachment: (attachment: AttachmentSummary) => Promise<void>;
  removeSelectedAttachment: (attachmentId: string) => Promise<void>;
}

export function AttachmentPanel({
  canDeleteAttachments,
  selectedAttachments,
  downloadSelectedAttachment,
  removeSelectedAttachment
}: AttachmentPanelProps) {
  return (
    <div className="attachment-panel">
      <h3>Attachments</h3>
      {selectedAttachments.length === 0 ? (
        <p className="muted">No attachments.</p>
      ) : (
        <ul className="attachment-list">
          {selectedAttachments.map((attachment) => (
            <li key={attachment.id}>
              <span>
                <strong>{attachment.filename}</strong>
                <small>
                  {attachment.mimeType} · {formatBytes(attachment.size)}
                </small>
              </span>
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  void downloadSelectedAttachment(attachment);
                }}
              >
                Download
              </button>
              {canDeleteAttachments ? (
                <button
                  className="text-button danger"
                  type="button"
                  onClick={() => {
                    void removeSelectedAttachment(attachment.id);
                  }}
                >
                  Delete
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
