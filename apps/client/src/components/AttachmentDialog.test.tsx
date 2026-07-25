// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AttachmentSummary } from "../api";
import { AttachmentDialog } from "./AttachmentDialog";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  });
});

afterEach(cleanup);

describe("AttachmentDialog", () => {
  it("opens an attachment in a full preview and deletes it without confirmation", async () => {
    const attachment = imageAttachment();
    const removeAttachment = vi.fn().mockResolvedValue(true);
    render(
      <AttachmentDialog
        attachments={[attachment]}
        canDelete
        error={null}
        loading={false}
        noteTitle="Project notes"
        onClose={vi.fn()}
        open
        downloadAttachment={vi.fn()}
        removeAttachment={removeAttachment}
        resolveAttachmentUrl={vi.fn().mockResolvedValue("blob:image")}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "photo.png" }));
    expect(await screen.findByAltText("Preview of photo.png")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete attachment" })).toBeTruthy();
    expect(screen.queryByText(/confirm/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete attachment" }));
    await vi.waitFor(() => {
      expect(removeAttachment).toHaveBeenCalledWith(attachment.id);
    });
  });

  it("shows a preview error when attachment decryption fails", async () => {
    render(
      <AttachmentDialog
        attachments={[imageAttachment()]}
        canDelete
        error={null}
        loading={false}
        noteTitle="Project notes"
        onClose={vi.fn()}
        open
        downloadAttachment={vi.fn()}
        removeAttachment={vi.fn()}
        resolveAttachmentUrl={vi.fn().mockRejectedValue(new Error("Attachment is unavailable"))}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "photo.png" }));
    expect(await screen.findByText("Attachment is unavailable")).toBeTruthy();
  });
});

function imageAttachment(): AttachmentSummary {
  return {
    attachmentKeyNonce: "attachment-key-nonce",
    createdAt: "2026-07-23T00:00:00.000Z",
    encryptedAttachmentKey: "encrypted-key",
    fileNonce: "file-nonce",
    filename: "photo.png",
    id: "00000000-0000-4000-8000-000000000001",
    keyEpoch: 1,
    mimeType: "image/png",
    size: 3
  };
}
