// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentDownload, AttachmentSummary } from "../api";
import type { DecryptedNote } from "../store/appStore";
import { useAppStore } from "../store/appStore";
import { formatAttachmentReference } from "../lib/attachmentMedia";

const mocks = vi.hoisted(() => ({
  createDraft: vi.fn(),
  createObjectUrl: vi.fn(),
  decrypt: vi.fn(),
  deleteAttachment: vi.fn(),
  downloadAttachment: vi.fn(),
  downloadBytes: vi.fn(),
  listAttachments: vi.fn(),
  revokeObjectUrl: vi.fn(),
  uploadAttachment: vi.fn()
}));

vi.mock("../api", () => ({
  deleteAttachment: mocks.deleteAttachment,
  downloadAttachment: mocks.downloadAttachment,
  listAttachments: mocks.listAttachments,
  uploadAttachment: mocks.uploadAttachment
}));

vi.mock("../cryptoClient", () => ({
  createEncryptedAttachmentDraft: mocks.createDraft,
  decryptAttachmentBytes: mocks.decrypt
}));

vi.mock("../lib/browser", () => ({ downloadBytes: mocks.downloadBytes }));

import { useAttachmentActions } from "./useAttachmentActions";

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const REFERENCE = formatAttachmentReference(ATTACHMENT_ID);

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: mocks.createObjectUrl },
    revokeObjectURL: { configurable: true, value: mocks.revokeObjectUrl }
  });
  mocks.createObjectUrl.mockReturnValue("blob:fortnote-media");
  mocks.decrypt.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.downloadAttachment.mockResolvedValue(download());
  mocks.listAttachments.mockResolvedValue({ attachments: [attachment()] });
  mocks.uploadAttachment.mockResolvedValue({ id: ATTACHMENT_ID });
  useAppStore.setState({
    attachmentsByNote: { "note-1": [attachment()] },
    error: null,
    rootKey: new Uint8Array([1]),
    selectedNoteId: "note-1",
    status: "Ready",
    user: { id: "alice", username: "alice" }
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().resetVaultState("reset");
});

describe("attachment upload", () => {
  it("returns refreshed metadata while preserving success status", async () => {
    mocks.createDraft.mockResolvedValue({ id: ATTACHMENT_ID });
    const { result } = renderHook(() => useAttachmentActions(note()));

    let uploaded: AttachmentSummary | null = null;
    await act(async () => {
      uploaded = await result.current.uploadSelectedAttachment(
        new File(["image"], "image.png", { type: "image/png" })
      );
    });

    expect(uploaded).toEqual(attachment());
    expect(useAppStore.getState().status).toBe("Attachment encrypted and saved");
    expect(useAppStore.getState().error).toBeNull();
  });

  it("returns null while preserving failure status and error", async () => {
    mocks.createDraft.mockRejectedValue(new Error("encryption failed"));
    const { result } = renderHook(() => useAttachmentActions(note()));

    let uploaded: AttachmentSummary | null = attachment();
    await act(async () => {
      uploaded = await result.current.uploadSelectedAttachment(
        new File(["image"], "image.png", { type: "image/png" })
      );
    });

    expect(uploaded).toBeNull();
    expect(useAppStore.getState().status).toBe("Attachment failed");
    expect(useAppStore.getState().error).toBe("encryption failed");
  });
});

describe("embedded attachment resolver", () => {
  it("decrypts authorized attachments into MIME-typed object URLs", async () => {
    const { result } = renderHook(() => useAttachmentActions(note()));

    await expect(result.current.resolveAttachmentUrl(REFERENCE)).resolves.toBe(
      "blob:fortnote-media"
    );

    expect(mocks.downloadAttachment).toHaveBeenCalledWith(ATTACHMENT_ID);
    expect(mocks.decrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: ATTACHMENT_ID,
        noteId: "note-1",
        userId: "alice"
      })
    );
    expect(mocks.createObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/png" })
    );
  });

  it("waits for attachment metadata before resolving a freshly opened note", async () => {
    useAppStore.setState({ attachmentsByNote: {} });
    const { result } = renderHook(() => useAttachmentActions(note()));

    await expect(result.current.resolveAttachmentUrl(REFERENCE)).resolves.toBe(
      "blob:fortnote-media"
    );

    expect(mocks.listAttachments).toHaveBeenCalledOnce();
    expect(mocks.downloadAttachment).toHaveBeenCalledOnce();
  });

  it("reuses one concurrent download and resolved object URL", async () => {
    let finishDownload!: (value: AttachmentDownload) => void;
    mocks.downloadAttachment.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishDownload = resolve;
      })
    );
    const { result } = renderHook(() => useAttachmentActions(note()));

    const first = result.current.resolveAttachmentUrl(REFERENCE);
    const second = result.current.resolveAttachmentUrl(REFERENCE);
    await vi.waitFor(() => {
      expect(mocks.downloadAttachment).toHaveBeenCalledOnce();
    });
    finishDownload(download());

    await expect(Promise.all([first, second])).resolves.toEqual([
      "blob:fortnote-media",
      "blob:fortnote-media"
    ]);
    expect(mocks.createObjectUrl).toHaveBeenCalledOnce();
  });

  it("rejects unavailable and cross-note attachments before exposing bytes", async () => {
    const { result } = renderHook(() => useAttachmentActions(note()));

    act(() => {
      useAppStore.setState({ attachmentsByNote: { "note-1": [] } });
    });
    await expect(result.current.resolveAttachmentUrl(REFERENCE)).rejects.toThrow(
      "Attachment is unavailable"
    );
    expect(mocks.downloadAttachment).not.toHaveBeenCalled();

    act(() => {
      useAppStore.setState({ attachmentsByNote: { "note-1": [attachment()] } });
    });
    mocks.downloadAttachment.mockResolvedValueOnce(download({ noteId: "note-2" }));
    await expect(result.current.resolveAttachmentUrl(REFERENCE)).rejects.toThrow(
      "Attachment does not belong to the selected note"
    );
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("revokes object URLs when attachments, epochs, and editor lifetimes end", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ selectedNote }) => useAttachmentActions(selectedNote),
      { initialProps: { selectedNote: note() } }
    );

    await result.current.resolveAttachmentUrl(REFERENCE);
    act(() => {
      useAppStore.setState({ attachmentsByNote: { "note-1": [] } });
    });
    expect(mocks.revokeObjectUrl).toHaveBeenLastCalledWith("blob:fortnote-media");

    act(() => {
      useAppStore.setState({ attachmentsByNote: { "note-1": [attachment()] } });
    });
    await result.current.resolveAttachmentUrl(REFERENCE);
    rerender({ selectedNote: note({ keyEpoch: 2 }) });
    expect(mocks.revokeObjectUrl).toHaveBeenCalledTimes(2);

    await result.current.resolveAttachmentUrl(REFERENCE);
    unmount();
    expect(mocks.revokeObjectUrl).toHaveBeenCalledTimes(3);
  });
});

function attachment(overrides: Partial<AttachmentSummary> = {}): AttachmentSummary {
  return {
    attachmentKeyNonce: "attachment-key-nonce",
    createdAt: "2026-07-18T00:00:00.000Z",
    encryptedAttachmentKey: "encrypted-key",
    fileNonce: "file-nonce",
    filename: "image.png",
    id: ATTACHMENT_ID,
    mimeType: "image/png",
    size: 3,
    ...overrides
  };
}

function download(overrides: Partial<AttachmentDownload> = {}): AttachmentDownload {
  return {
    ...attachment(),
    encryptedBytes: "encrypted-bytes",
    noteId: "note-1",
    ...overrides
  };
}

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    body: "",
    contentLength: 0,
    cryptoOwnerId: "alice",
    folderId: null,
    id: "note-1",
    isDeleted: false,
    keyEpoch: 1,
    noteKeyBase64: "note-key",
    ownerUserId: "alice",
    role: "owner",
    title: "Title",
    updatedAt: "2026-07-18T00:00:00.000Z",
    version: 1,
    ...overrides
  };
}
