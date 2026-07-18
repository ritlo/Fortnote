// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedNote } from "../store/appStore";
import type { AttachmentSummary } from "../api";
import { useAppStore } from "../store/appStore";
import { formatAttachmentReference } from "../lib/attachmentMedia";
import { parseBlockNoteBody } from "../lib/blockNote";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(() => vi.fn()),
  createOptions: [] as unknown[],
  edit: vi.fn(() => true),
  editor: {
    document: [
      {
        id: "empty-block",
        type: "paragraph",
        props: {},
        content: [],
        children: []
      }
    ],
    getBlock: vi.fn(() => ({ id: "media-block", type: "image", props: {} })),
    prosemirrorState: {
      plugins: []
    },
    redo: vi.fn(),
    schema: {
      blockSpecs: {
        file: { implementation: { meta: { fileBlockAccept: ["*/*"] } } },
        image: { implementation: { meta: { fileBlockAccept: ["image/*"] } } }
      }
    },
    updateBlock: vi.fn(),
    undo: vi.fn()
  },
  editorChange: undefined as ((editor: { document: unknown[] }) => void) | undefined,
  editorChanges: [] as ((editor: { document: unknown[] }) => void)[],
  fragment: {},
  provider: {
    awareness: {},
    isSynced: false,
    off: vi.fn(),
    on: vi.fn()
  },
  remove: vi.fn(),
  updateBinding: vi.fn()
}));

vi.mock("@blocknote/react", () => ({
  EmbedTab: () => <div data-testid="embed-tab" />,
  FilePanelController: ({ filePanel: Panel }: {
    filePanel: ComponentType<{ blockId: string }>;
  }) => (
    <div data-testid="file-panel-controller">
      <Panel blockId="media-block" />
    </div>
  ),
  UploadTab: () => <div data-testid="upload-tab" />,
  useBlockNoteEditor: () => mocks.editor,
  useComponentsContext: () => ({
    FilePanel: {
      Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
        <button type="button" onClick={onClick}>{children}</button>
      ),
      Root: ({ tabs }: { tabs: { name: string; tabPanel: ReactNode }[] }) => (
        <div data-testid="file-tabs">
          {tabs.map((tab) => (
            <section key={tab.name}>
              <span data-testid="file-tab-name">{tab.name}</span>
              {tab.tabPanel}
            </section>
          ))}
        </div>
      ),
      TabPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>
    }
  }),
  useCreateBlockNote: (options: unknown) => {
    mocks.createOptions.push(options);
    return mocks.editor;
  },
  useDictionary: () => ({
    file_panel: {
      embed: { title: "Embed" },
      upload: { title: "Upload" }
    }
  }),
  useEditorChange: (callback: (editor: { document: unknown[] }) => void) => {
    mocks.editorChange = callback;
    mocks.editorChanges.push(callback);
  }
}));

vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: ({ children, editable, filePanel }: {
    children?: ReactNode;
    editable: boolean;
    filePanel?: boolean;
  }) => (
    <div
      data-testid="block-note"
      data-editable={String(editable)}
      data-file-panel={String(filePanel)}
    >
      {children}
    </div>
  )
}));

vi.mock("../realtime/crdt", () => ({
  attachCrdtNote: mocks.attach,
  editCrdtNote: mocks.edit,
  getCrdtFragment: () => mocks.fragment,
  getCrdtProvider: () => mocks.provider,
  removeCrdtNote: mocks.remove,
  updateCrdtNote: mocks.updateBinding
}));

vi.mock("./AttachmentPanel", () => ({
  AttachmentPanel: ({
    canDeleteAttachments,
    downloadSelectedAttachment,
    removeSelectedAttachment,
    selectedAttachments
  }: {
    canDeleteAttachments: boolean;
    downloadSelectedAttachment: (attachment: AttachmentSummary) => void;
    removeSelectedAttachment: (id: string) => void;
    selectedAttachments: AttachmentSummary[];
  }) => (
    <div data-testid="attachment-panel">
      {selectedAttachments.map((attachment) => (
        <div key={attachment.id}>
          <button
            type="button"
            onClick={() => {
              downloadSelectedAttachment(attachment);
            }}
          >
            Download {attachment.filename}
          </button>
          {canDeleteAttachments ? (
            <button
              type="button"
              onClick={() => {
                removeSelectedAttachment(attachment.id);
              }}
            >
              Delete {attachment.filename}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}));
vi.mock("./SharingPanel", () => ({ SharingPanel: () => null }));

import { NoteEditor } from "./NoteEditor";

type UpdateSelectedNote = (
  patch: Partial<Pick<DecryptedNote, "folderId" | "title" | "body">>
) => void;

describe("NoteEditor BlockNote lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createOptions.length = 0;
    mocks.editorChange = undefined;
    mocks.editorChanges.length = 0;
    mocks.provider.isSynced = false;
    mocks.editor.getBlock.mockReturnValue({ id: "media-block", type: "image", props: {} });
    useAppStore.setState({
      attachmentsByNote: { "note-1": [] },
      selectedNoteId: "note-1",
      user: { id: "alice", username: "alice" }
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().resetVaultState("reset");
  });

  it("keeps one binding through body updates and cleans up on epoch changes", async () => {
    const update = vi.fn();
    const view = renderEditor(note(), update);

    act(() => mocks.editorChange?.({ document: [{ id: "one" }] }));
    view.rerender(editor(note({ body: JSON.stringify([{ id: "one" }]) }), update));
    act(() => mocks.editorChange?.({ document: [{ id: "two" }] }));
    view.rerender(editor(note({ body: JSON.stringify([{ id: "two" }]) }), update));

    expect(mocks.attach).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();

    view.rerender(editor(note({ keyEpoch: 2, noteKeyBase64: "rotated" }), update));
    await flushCleanup();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.attach).toHaveBeenCalledTimes(2);

    view.unmount();
    await flushCleanup();
    expect(mocks.remove).toHaveBeenCalledTimes(2);
  });

  it("keeps the live binding through the StrictMode effect replay", async () => {
    const view = render(<StrictMode>{editor(note(), vi.fn())}</StrictMode>);

    await flushCleanup();
    expect(mocks.attach).toHaveBeenCalledTimes(2);
    expect(mocks.remove).not.toHaveBeenCalled();

    view.unmount();
    await flushCleanup();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("keeps the editor change subscription stable through body updates", () => {
    const update = vi.fn();
    const view = renderEditor(note(), update);

    view.rerender(editor(note({ body: JSON.stringify([{ id: "one" }]) }), update));
    view.rerender(editor(note({ body: JSON.stringify([{ id: "two" }]) }), update));

    expect(new Set(mocks.editorChanges)).toHaveLength(1);
  });

  it("routes title edits through the collaborative title path", () => {
    const update = vi.fn();
    renderEditor(note(), update);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Shared title" } });

    expect(mocks.edit).toHaveBeenCalledWith("note-1", { title: "Shared title" });
    expect(update).not.toHaveBeenCalledWith({ title: "Shared title" });
  });

  it("renders viewer and trash documents read-only without attaching trash", () => {
    const viewer = renderEditor(note({ role: "viewer" }), vi.fn(), "shared");
    expect(screen.getByTestId("block-note").getAttribute("data-editable")).toBe("false");
    expect(screen.getByTestId("block-note").getAttribute("data-file-panel")).toBe("false");
    expect(screen.queryByTestId("file-panel-controller")).toBeNull();
    expect(mocks.createOptions.at(-1)).not.toHaveProperty("uploadFile");
    expect(mocks.createOptions.at(-1)).toHaveProperty("resolveFileUrl");
    expect(mocks.attach).toHaveBeenCalledOnce();
    viewer.unmount();

    vi.clearAllMocks();
    renderEditor(note({ isDeleted: true }), vi.fn(), "trash");
    expect(screen.getByTestId("block-note").getAttribute("data-editable")).toBe("false");
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.createOptions.at(-1)).toMatchObject({
      initialContent: expect.arrayContaining([expect.objectContaining({ type: "paragraph" })]),
      resolveFileUrl: expect.any(Function)
    });
    expect(mocks.createOptions.at(-1)).not.toHaveProperty("uploadFile");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Redo" })).toBeNull();
  });

  it("uses BlockNote's native undo and redo for writable notes", () => {
    renderEditor(note(), vi.fn());

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));

    expect(mocks.editor.undo).toHaveBeenCalledOnce();
    expect(mocks.editor.redo).toHaveBeenCalledOnce();
  });

  it("uploads encrypted media props and reports upload failure to BlockNote", async () => {
    const uploaded = attachment();
    const upload = vi.fn().mockResolvedValue(uploaded);
    const resolve = vi.fn((url: string) => Promise.resolve(url));
    renderEditor(note(), vi.fn(), "notes", {
      resolveAttachmentUrl: resolve,
      uploadSelectedAttachment: upload
    });
    const options = mocks.createOptions.at(-1) as {
      resolveFileUrl: (url: string) => Promise<string>;
      uploadFile: (file: File) => Promise<unknown>;
    };
    const file = new File(["image"], "image.png", { type: "image/png" });

    await expect(options.uploadFile(file)).resolves.toEqual({
      props: {
        name: "image.png",
        url: formatAttachmentReference(uploaded.id)
      }
    });
    expect(upload).toHaveBeenCalledWith(file);
    expect(options.resolveFileUrl).toBe(resolve);

    upload.mockResolvedValueOnce(null);
    await expect(options.uploadFile(file)).rejects.toThrow("Attachment upload failed");
  });

  it("orders media tabs and selects only compatible existing attachments", () => {
    const image = attachment();
    const audio = attachment({
      filename: "audio.mp3",
      id: "00000000-0000-4000-8000-000000000002",
      mimeType: "audio/mpeg"
    });
    useAppStore.setState({ attachmentsByNote: { "note-1": [image, audio] } });
    const upload = vi.fn();

    renderEditor(note(), vi.fn(), "notes", { uploadSelectedAttachment: upload });

    expect(
      within(screen.getByTestId("file-tabs"))
        .getAllByTestId("file-tab-name")
        .map((tab) => tab.textContent)
    ).toEqual(["Upload", "Attachments", "Embed"]);
    expect(screen.getByTestId("upload-tab")).toBeTruthy();
    expect(screen.getByTestId("embed-tab")).toBeTruthy();
    expect(screen.getByRole("button", { name: "image.png" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "audio.mp3" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "image.png" }));
    expect(mocks.editor.updateBlock).toHaveBeenCalledWith("media-block", {
      props: {
        name: "image.png",
        url: formatAttachmentReference(image.id)
      }
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("passes unavailable media failures through and retains note-wide actions", async () => {
    const unavailable = vi.fn().mockRejectedValue(new Error("Attachment is unavailable"));
    const download = vi.fn();
    const remove = vi.fn();
    const image = attachment();
    renderEditor(note(), vi.fn(), "notes", {
      downloadSelectedAttachment: download,
      removeSelectedAttachment: remove,
      resolveAttachmentUrl: unavailable,
      selectedAttachments: [image]
    });
    const options = mocks.createOptions.at(-1) as {
      resolveFileUrl: (url: string) => Promise<string>;
    };

    await expect(options.resolveFileUrl(formatAttachmentReference(image.id))).rejects.toThrow(
      "Attachment is unavailable"
    );
    fireEvent.click(screen.getByRole("button", { name: "Download image.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete image.png" }));
    expect(download).toHaveBeenCalledWith(image);
    expect(remove).toHaveBeenCalledWith(image.id);
  });

  it("canonicalizes legacy content after sync and rejects malformed arrays", () => {
    const update = vi.fn();
    mocks.provider.isSynced = true;
    renderEditor(note({ body: "# legacy" }), update);

    expect(update).toHaveBeenCalledWith({ body: JSON.stringify(mocks.editor.document) });
    expect(parseBlockNoteBody(JSON.stringify([{}]))).toBeNull();
    expect(parseBlockNoteBody(validBody())).not.toBeNull();
  });
});

async function flushCleanup(): Promise<void> {
  await act(async () => Promise.resolve());
}

function renderEditor(
  selectedNote: DecryptedNote,
  updateSelectedNote: UpdateSelectedNote,
  notesView: "notes" | "shared" | "trash" = "notes",
  overrides: EditorOverrides = {}
) {
  return render(editor(selectedNote, updateSelectedNote, notesView, overrides));
}

function editor(
  selectedNote: DecryptedNote,
  updateSelectedNote: UpdateSelectedNote,
  notesView: "notes" | "shared" | "trash" = "notes",
  overrides: EditorOverrides = {}
) {
  return (
    <NoteEditor
      canDeleteAttachments
      downloadSelectedAttachment={overrides.downloadSelectedAttachment ?? vi.fn()}
      folders={[]}
      notesView={notesView}
      removeSelectedAttachment={overrides.removeSelectedAttachment ?? vi.fn()}
      resolveAttachmentUrl={
        overrides.resolveAttachmentUrl ?? ((url) => Promise.resolve(url))
      }
      selectedAttachments={overrides.selectedAttachments ?? []}
      selectedNote={selectedNote}
      updateSelectedNote={updateSelectedNote}
      uploadSelectedAttachment={overrides.uploadSelectedAttachment ?? vi.fn()}
    />
  );
}

interface EditorOverrides {
  downloadSelectedAttachment?: (attachment: AttachmentSummary) => Promise<void>;
  removeSelectedAttachment?: (id: string) => Promise<void>;
  resolveAttachmentUrl?: (url: string) => Promise<string>;
  selectedAttachments?: AttachmentSummary[];
  uploadSelectedAttachment?: (file: File | undefined) => Promise<AttachmentSummary | null>;
}

function validBody() {
  return JSON.stringify([
    {
      id: "block-1",
      type: "paragraph",
      props: {
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left"
      },
      content: [{ type: "text", text: "Saved", styles: {} }],
      children: []
    }
  ]);
}

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
    body: validBody(),
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
    updatedAt: "2026-07-15T00:00:00.000Z",
    version: 1,
    ...overrides
  };
}

function attachment(overrides: Partial<AttachmentSummary> = {}): AttachmentSummary {
  return {
    attachmentKeyNonce: "attachment-key-nonce",
    createdAt: "2026-07-18T00:00:00.000Z",
    encryptedAttachmentKey: "encrypted-key",
    fileNonce: "file-nonce",
    filename: "image.png",
    id: "00000000-0000-4000-8000-000000000001",
    keyEpoch: 1,
    mimeType: "image/png",
    size: 3,
    ...overrides
  };
}
