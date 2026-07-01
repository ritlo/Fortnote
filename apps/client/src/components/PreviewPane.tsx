import type { AttachmentSummary } from "../api";
import { AttachmentPanel } from "./AttachmentPanel";

interface PreviewPaneProps {
  previewHtml: string;
  selectedAttachments: AttachmentSummary[];
  downloadSelectedAttachment: (attachment: AttachmentSummary) => Promise<void>;
  removeSelectedAttachment: (attachmentId: string) => Promise<void>;
}

export function PreviewPane({
  previewHtml,
  selectedAttachments,
  downloadSelectedAttachment,
  removeSelectedAttachment
}: PreviewPaneProps) {
  return (
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
  );
}
