// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AttachmentSummary } from "@client/api";
import { AttachmentDialog } from "@client/components/AttachmentDialog";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AttachmentDialog", () => {
  it("opens an attachment in a full preview and deletes it after confirmation", async () => {
    const attachment = imageAttachment();
    const removeAttachment = vi.fn().mockResolvedValue(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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

    fireEvent.click(screen.getByRole("button", { name: "Delete attachment" }));
    await vi.waitFor(() => {
      expect(removeAttachment).toHaveBeenCalledWith(attachment.id);
    });
    expect(confirm).toHaveBeenCalledWith(
      'Delete attachment "photo.png"? This cannot be undone.'
    );
  });

  it("does not delete an attachment when confirmation is declined", async () => {
    const attachment = imageAttachment();
    const removeAttachment = vi.fn().mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(false);
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
    await screen.findByAltText("Preview of photo.png");
    fireEvent.click(screen.getByRole("button", { name: "Delete attachment" }));

    expect(removeAttachment).not.toHaveBeenCalled();
  });

  it("returns focus to the trigger after closing", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(
      <AttachmentDialog
        attachments={[imageAttachment()]}
        canDelete={false}
        error={null}
        loading={false}
        noteTitle="Project notes"
        onClose={onClose}
        open
        downloadAttachment={vi.fn()}
        removeAttachment={vi.fn()}
        resolveAttachmentUrl={vi.fn().mockResolvedValue("blob:image")}
      />
    );

    view.rerender(
      <AttachmentDialog
        attachments={[imageAttachment()]}
        canDelete={false}
        error={null}
        loading={false}
        noteTitle="Project notes"
        onClose={onClose}
        open={false}
        downloadAttachment={vi.fn()}
        removeAttachment={vi.fn()}
        resolveAttachmentUrl={vi.fn().mockResolvedValue("blob:image")}
      />
    );

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
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
        resolveAttachmentUrl={vi
          .fn()
          .mockRejectedValue(new Error("Attachment is unavailable"))}
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
