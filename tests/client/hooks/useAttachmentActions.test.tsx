// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentDownload,
  AttachmentSummary,
  BinaryTransferProgress,
  EncryptedAttachmentSummary
} from "@client/api";
import type { DecryptedNote } from "@client/store/appStore";
import { useAppStore } from "@client/store/appStore";
import { formatAttachmentReference } from "@client/lib/attachmentMedia";

const mocks = vi.hoisted(() => ({
  createDraft: vi.fn(),
  createObjectUrl: vi.fn(),
  decrypt: vi.fn(),
  decryptMetadata: vi.fn(),
  deleteAttachment: vi.fn(),
  downloadAttachment: vi.fn(),
  downloadBytes: vi.fn(),
  listAttachments: vi.fn(),
  listNoteEpochLinks: vi.fn(),
  resolveNoteKeyAtEpoch: vi.fn(),
  revokeObjectUrl: vi.fn(),
  uploadAttachment: vi.fn()
}));

vi.mock("@client/api", () => ({
  deleteAttachment: mocks.deleteAttachment,
  downloadAttachment: mocks.downloadAttachment,
  listAttachments: mocks.listAttachments,
  listNoteEpochLinks: mocks.listNoteEpochLinks,
  uploadAttachment: mocks.uploadAttachment
}));

vi.mock("@client/cryptoClient", () => ({
  createEncryptedAttachmentDraft: mocks.createDraft,
  decryptAttachmentBytes: mocks.decrypt,
  decryptAttachmentMetadataV2: mocks.decryptMetadata
}));

vi.mock("@client/lib/browser", () => ({ downloadBytes: mocks.downloadBytes }));
vi.mock("@client/lib/keyMaterial", () => ({
  resolveNoteKeyAtEpoch: mocks.resolveNoteKeyAtEpoch
}));

import { useAttachmentActions } from "@client/hooks/useAttachmentActions";

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
  mocks.decryptMetadata.mockResolvedValue({
    filename: "image.png",
    mimeType: "image/png"
  });
  mocks.downloadAttachment.mockResolvedValue(download());
  mocks.listAttachments.mockResolvedValue({ attachments: [encryptedAttachment()] });
  mocks.listNoteEpochLinks.mockResolvedValue({ links: [] });
  mocks.resolveNoteKeyAtEpoch.mockResolvedValue(new Uint8Array([9, 8, 7]));
  mocks.uploadAttachment.mockResolvedValue({ id: ATTACHMENT_ID, keyEpoch: 1 });
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
    expect(mocks.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ keyEpoch: 1 })
    );
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

  it("maps browser capacity failure without claiming the attachment was saved", async () => {
    mocks.createDraft.mockRejectedValue(
      Object.assign(new Error("private detail"), {
        name: "QuotaExceededError"
      })
    );
    const { result } = renderHook(() => useAttachmentActions(note()));

    const uploaded = await act(async () =>
      result.current.uploadSelectedAttachment(
        new File(["image"], "image.png", { type: "image/png" })
      )
    );

    expect(uploaded).toBeNull();
    expect(useAppStore.getState()).toMatchObject({
      status: "Local storage full — changes need attention",
      localStorageCapacity: { status: "full", availableBytes: 0 }
    });
  });

  it("reports binary upload progress without placing the filename in status", async () => {
    let progressStatus = "";
    mocks.createDraft.mockResolvedValue({ id: ATTACHMENT_ID });
    mocks.uploadAttachment.mockImplementationOnce(
      (
        _noteId: string,
        _payload: unknown,
        onProgress: (progress: BinaryTransferProgress) => void
      ) => {
        onProgress({ loadedBytes: 4, totalBytes: 8 });
        progressStatus = useAppStore.getState().status;
        return Promise.resolve({ id: ATTACHMENT_ID, keyEpoch: 1 });
      }
    );
    const { result } = renderHook(() => useAttachmentActions(note()));

    await act(async () => {
      await result.current.uploadSelectedAttachment(
        new File(["image"], "private-name.png", { type: "image/png" })
      );
    });

    expect(progressStatus).toBe("Uploading attachment 50%");
    expect(progressStatus).not.toContain("private-name.png");
  });
});

describe("attachment write guards", () => {
  it("does not encrypt, upload, or delete for viewers, trash readers, or revoked notes", async () => {
    const file = new File(["image"], "image.png", { type: "image/png" });
    const viewer = renderHook(() => useAttachmentActions(note({ role: "viewer" })));
    await act(async () => {
      await viewer.result.current.uploadSelectedAttachment(file);
      await viewer.result.current.removeSelectedAttachment(ATTACHMENT_ID);
    });
    viewer.unmount();

    useAppStore.setState({ notesView: "trash" });
    const trash = renderHook(() => useAttachmentActions(note({ isDeleted: true })));
    await act(async () => {
      await trash.result.current.uploadSelectedAttachment(file);
      await trash.result.current.removeSelectedAttachment(ATTACHMENT_ID);
    });
    trash.unmount();

    const revoked = renderHook(() => useAttachmentActions(null));
    await act(async () => {
      await revoked.result.current.uploadSelectedAttachment(file);
      await revoked.result.current.removeSelectedAttachment(ATTACHMENT_ID);
    });
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.uploadAttachment).not.toHaveBeenCalled();
    expect(mocks.deleteAttachment).not.toHaveBeenCalled();
  });
});

describe("attachment metadata", () => {
  it("decrypts protected filename and MIME envelopes before storing them", async () => {
    useAppStore.setState({ attachmentsByNote: {} });
    mocks.listAttachments.mockResolvedValue({ attachments: [encryptedAttachment()] });
    renderHook(() => useAttachmentActions(note({ noteKeyBase64: "AQIDBA==" })));

    await waitFor(() => {
      expect(useAppStore.getState().attachmentsByNote["note-1"]).toEqual([attachment()]);
    });
    expect(mocks.decryptMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: ATTACHMENT_ID,
        keyEpoch: 1,
        noteId: "note-1"
      })
    );
  });

  it("traverses epoch links for historical attachment metadata", async () => {
    useAppStore.setState({ attachmentsByNote: {} });
    mocks.listAttachments.mockResolvedValue({
      attachments: [encryptedAttachment({ keyEpoch: 1 })]
    });
    const selectedNote = note({ keyEpoch: 2, noteKeyBase64: "AQIDBA==" });
    renderHook(() => useAttachmentActions(selectedNote));

    await waitFor(() => {
      expect(mocks.resolveNoteKeyAtEpoch).toHaveBeenCalledWith(
        expect.objectContaining({ note: selectedNote, targetEpoch: 1 })
      );
    });
    expect(mocks.listNoteEpochLinks).toHaveBeenCalledWith("note-1");
    expect(mocks.decryptMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        keyEpoch: 1,
        noteKey: new Uint8Array([9, 8, 7])
      })
    );
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
      () =>
        new Promise((resolve) => {
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
    keyEpoch: 1,
    mimeType: "image/png",
    size: 3,
    ...overrides
  };
}

function encryptedAttachment(
  overrides: Partial<EncryptedAttachmentSummary> = {}
): EncryptedAttachmentSummary {
  return {
    attachmentKeyNonce: "attachment-key-nonce",
    createdAt: "2026-07-18T00:00:00.000Z",
    encryptedAttachmentKey: "encrypted-key",
    fileNonce: "file-nonce",
    id: ATTACHMENT_ID,
    keyEpoch: 1,
    metadataCipher: "metadata-cipher",
    metadataFormatVersion: 2,
    metadataNonce: "metadata-nonce",
    size: 3,
    ...overrides
  };
}

function download(overrides: Partial<AttachmentDownload> = {}): AttachmentDownload {
  return {
    ...attachment(),
    encryptedBytes: new Uint8Array([4, 5, 6]),
    noteId: "note-1",
    ...overrides
  };
}

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    contentLength: 0,
    cryptoOwnerId: "alice",
    folderId: null,
    id: "note-1",
    isDeleted: false,
    keyEpoch: 1,
    noteKeyBase64: "AQIDBA==",
    ownerUserId: "alice",
    role: "owner",
    title: "Title",
    updatedAt: "2026-07-18T00:00:00.000Z",
    version: 1,
    ...overrides
  };
}
