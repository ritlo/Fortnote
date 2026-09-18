// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DecryptedNote } from "@client/store/appStore";
import type { AttachmentSummary } from "@client/api";
import { useAppStore } from "@client/store/appStore";

const mocks = vi.hoisted(() => ({
  createOptions: [] as unknown[],
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
    onChange: vi.fn<(callback: () => void) => () => void>(() => () => undefined),
    onMount: vi.fn<(callback: () => void) => () => void>(() => () => undefined),
    prosemirrorState: {
      plugins: [] as unknown[]
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
  getFragment: vi.fn((_noteId: string, _keyEpoch: number, sectionId: string) => ({
    sectionId
  })),
  getProvider: vi.fn(),
  provider: {
    awareness: {},
    isSynced: false,
    off: vi.fn(),
    on: vi.fn()
  },
  updateBinding: vi.fn()
}));

vi.mock("@blocknote/react", () => ({
  EmbedTab: () => <div data-testid="embed-tab" />,
  FilePanelController: ({
    filePanel: Panel
  }: {
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
        <button type="button" onClick={onClick}>
          {children}
        </button>
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
  })
}));

vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: ({
    children,
    editable
  }: {
    children?: ReactNode;
    editable: boolean;
  }) => (
    <div data-testid="block-note" data-editable={String(editable)}>
      {children}
    </div>
  )
}));

vi.mock("@client/realtime/crdt", () => ({
  getCrdtFragment: mocks.getFragment,
  getCrdtProvider: mocks.getProvider,
  updateCrdtNote: mocks.updateBinding
}));

import { NoteEditor } from "@client/components/NoteEditor";

type UpdateSelectedNote = (
  patch: Partial<Pick<DecryptedNote, "folderId" | "title">>
) => void;

describe("NoteEditor simplified editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createOptions.length = 0;
    mocks.provider.isSynced = true;
    mocks.editor.prosemirrorState.plugins = [];
    mocks.getProvider.mockReturnValue(mocks.provider);
    useAppStore.setState({
      selectedNoteId: "note-1",
      user: { id: "alice", username: "alice" }
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().resetVaultState("reset");
  });

  it("renders editable title heading as the first control", () => {
    renderEditor(note());
    const titleInput = screen.getByRole("textbox", { name: "Title" });
    expect(titleInput).toBeTruthy();
    expect((titleInput as HTMLInputElement).value).toBe("Title");
    expect((titleInput as HTMLInputElement).disabled).toBe(false);
  });

  it("renders continuous BlockNote content area", () => {
    renderEditor(note());
    expect(screen.getByTestId("block-note")).toBeTruthy();
    expect(screen.getByTestId("block-note").getAttribute("data-editable")).toBe("true");
    expect(screen.getByTestId("block-note").closest(".blocknote-surface")).toBeTruthy();
  });

  it("keeps content read-only until its section history has loaded", () => {
    mocks.provider.isSynced = false;
    renderEditor(note());
    expect(screen.getByTestId("block-note").getAttribute("data-editable")).toBe("false");

    const [, markSynced] = mocks.provider.on.mock.calls.find(
      ([event]) => event === "synced"
    ) as [string, () => void];
    act(() => {
      markSynced();
    });
    expect(screen.getByTestId("block-note").getAttribute("data-editable")).toBe("true");
  });

  it("binds protected notes to their encrypted root section", () => {
    renderEditor(note({ rootSectionId: "root-section" }));

    expect(mocks.getFragment).toHaveBeenCalledWith("note-1", 1, "root-section");
    expect(mocks.getProvider).toHaveBeenCalledWith("note-1", 1, "root-section");
  });

  it("renders read-only for viewer role", () => {
    renderEditor(note({ role: "viewer" }));
    expect(screen.getByTestId("block-note").getAttribute("data-editable")).toBe("false");
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Title" }).disabled
    ).toBe(true);
  });

  it("updates editor status and last-saved metadata after content is delivered", () => {
    const originalUpdatedAt = "2026-07-15T00:00:00.000Z";
    const current = note({ updatedAt: originalUpdatedAt });
    useAppStore.setState({
      notes: [current],
      status: "Ready"
    });
    renderEditor(current);
    const saveStateHandler = mocks.provider.on.mock.calls.find(
      ([event]) => event === "save-state"
    )?.[1] as ((state: "saving" | "saved") => void) | undefined;

    expect(saveStateHandler).toBeTypeOf("function");
    act(() => {
      saveStateHandler?.("saving");
    });
    expect(useAppStore.getState().status).toBe("Saving encrypted note");

    act(() => {
      saveStateHandler?.("saved");
    });
    expect(useAppStore.getState().status).toBe("Ready");
    expect(useAppStore.getState().notes[0]?.updatedAt).not.toBe(originalUpdatedAt);
  });

  it("leaves save and sync state to the editor header", () => {
    useAppStore.setState({ realtimeStatus: "disconnected", status: "Save conflict" });
    renderEditor(note());
    expect(screen.queryByText("Saved and synchronized")).toBeNull();
    expect(screen.queryByText("Changes need review")).toBeNull();
    expect(screen.queryByText("Offline — changes kept on this device")).toBeNull();
  });

  it("enables undo and redo from the editor history", async () => {
    const undoManager = {
      scope: [],
      undoStack: [] as unknown[],
      redoStack: [] as unknown[]
    };
    mocks.editor.prosemirrorState.plugins = [
      { key: "y-undo$", getState: () => ({ undoManager }) }
    ];
    renderEditor(note());
    const undo = screen.getByRole<HTMLButtonElement>("button", { name: "Undo" });
    const redo = screen.getByRole<HTMLButtonElement>("button", { name: "Redo" });
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);

    const [notifyChange] = mocks.editor.onChange.mock.calls.at(-1)!;
    undoManager.undoStack.push({});
    await act(async () => {
      notifyChange();
      await Promise.resolve();
    });
    expect(undo.disabled).toBe(false);
    expect(redo.disabled).toBe(true);

    mocks.editor.undo.mockImplementationOnce(() => {
      undoManager.redoStack.push(undoManager.undoStack.pop());
    });
    fireEvent.click(undo);
    expect(mocks.editor.undo).toHaveBeenCalledOnce();
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(false);
  });

  it("keeps recording history after the editor view remounts", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("document");
    const undoManager = new Y.UndoManager(fragment, {
      trackedOrigins: new Set(["editor"])
    });
    mocks.editor.prosemirrorState.plugins = [
      { key: "y-undo$", getState: () => ({ undoManager }) }
    ];
    renderEditor(note());

    // y-prosemirror destroys the manager along with the unmounted view.
    undoManager.destroy();
    const [notifyMount] = mocks.editor.onMount.mock.calls.at(-1)!;
    notifyMount();
    doc.transact(() => {
      fragment.insert(0, [new Y.XmlText("typed")]);
    }, "editor");

    expect(undoManager.undoStack).toHaveLength(1);
  });

  it("does not offer undo and redo to viewers", () => {
    renderEditor(note({ role: "viewer" }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Redo" })).toBeNull();
  });

  it("reports editing presence while the note has focus", () => {
    const { unmount } = renderEditor(note());
    const title = screen.getByLabelText("Title");
    const presence = () => useAppStore.getState().localPresenceState;

    fireEvent.focus(title);
    expect(presence()).toBe("editing");

    // Moving focus within the note keeps the editing state.
    fireEvent.blur(title, { relatedTarget: document.querySelector(".block-editor div") });
    expect(presence()).toBe("editing");

    fireEvent.blur(title, { relatedTarget: document.body });
    expect(presence()).toBe("idle");

    fireEvent.focus(title);
    unmount();
    expect(presence()).toBe("idle");
  });

  it("does not report viewers as editing", () => {
    renderEditor(note({ role: "viewer" }));
    fireEvent.focus(screen.getByLabelText("Title"));
    expect(useAppStore.getState().localPresenceState).toBe("idle");
  });

  it("does not expose standalone attachment panel", () => {
    renderEditor(note());
    expect(screen.queryByRole("heading", { name: "Attachments" })).toBeNull();
    expect(screen.queryByText(/^No attachments\.$/)).toBeNull();
  });

  it("does not expose embedded sharing panel", () => {
    renderEditor(note());
    expect(screen.queryByText("Sharing")).toBeNull();
  });

  it("routes title edits through the update action", () => {
    const update = vi.fn();
    renderEditor(note(), update);
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "New title" }
    });
    expect(update).toHaveBeenCalledWith({ title: "New title" });
  });

  it("shows empty state when no note selected", () => {
    render(
      <NoteEditor
        notesView="notes"
        resolveAttachmentUrl={(url) => Promise.resolve(url)}
        selectedNote={null}
        updateSelectedNote={vi.fn()}
        uploadSelectedAttachment={vi.fn()}
      />
    );
    expect(screen.getByText("Select or create a note.")).toBeTruthy();
  });

  it("handles StrictMode replay without errors", async () => {
    const view = render(
      <StrictMode>
        <NoteEditor
          notesView="notes"
          resolveAttachmentUrl={(url) => Promise.resolve(url)}
          selectedNote={note()}
          updateSelectedNote={vi.fn()}
          uploadSelectedAttachment={vi.fn()}
        />
      </StrictMode>
    );
    await act(async () => Promise.resolve());
    view.unmount();
    await act(async () => Promise.resolve());
  });
});

describe("NoteEditor inline attachment states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createOptions.length = 0;
    mocks.provider.isSynced = true;
    mocks.editor.prosemirrorState.plugins = [];
    mocks.getProvider.mockReturnValue(mocks.provider);
    useAppStore.setState({
      selectedNoteId: "note-1",
      user: { id: "alice", username: "alice" }
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().resetVaultState("reset");
  });

  it("passes resolveFileUrl to the BlockNote editor", () => {
    const resolveUrl = vi.fn((url: string) => Promise.resolve(url));
    render(
      <NoteEditor
        notesView="notes"
        resolveAttachmentUrl={resolveUrl}
        selectedNote={note()}
        updateSelectedNote={vi.fn()}
        uploadSelectedAttachment={vi.fn()}
      />
    );
    const options = mocks.createOptions[0] as Record<string, unknown>;
    expect(options.resolveFileUrl).toBe(resolveUrl);
  });

  it("configures uploadFile callback in editable mode", () => {
    renderEditor(note());
    const options = mocks.createOptions[0] as Record<string, unknown>;
    expect(options.uploadFile).toBeDefined();
    expect(typeof options.uploadFile).toBe("function");
  });

  it("does not configure uploadFile callback in read-only mode", () => {
    renderEditor(note({ role: "viewer" }));
    const options = mocks.createOptions[0] as Record<string, unknown>;
    expect(options.uploadFile).toBeUndefined();
  });

  it("renders FortnoteFilePanel inside the editor when editable", () => {
    renderEditor(note());
    expect(screen.getByTestId("file-panel-controller")).toBeTruthy();
    expect(screen.getByTestId("upload-tab")).toBeTruthy();
    expect(screen.getByTestId("embed-tab")).toBeTruthy();
  });

  it("lets the BlockNote file panel insert an existing compatible attachment", () => {
    useAppStore.setState({
      attachmentsByNote: {
        "note-1": [
          attachment({
            filename: "photo.png",
            mimeType: "image/png",
            id: "00000000-0000-4000-8000-000000000001"
          }),
          attachment({
            filename: "notes.txt",
            mimeType: "text/plain",
            id: "00000000-0000-4000-8000-000000000002"
          })
        ]
      }
    });
    renderEditor(note());
    expect(screen.getByRole("button", { name: "photo.png" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "notes.txt" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "photo.png" }));
    expect(mocks.editor.updateBlock).toHaveBeenCalledWith(
      "media-block",
      expect.objectContaining({
        props: {
          name: "photo.png",
          url: "fortnote-attachment:00000000-0000-4000-8000-000000000001"
        }
      })
    );
  });

  it("does not render file panel controller in read-only mode", () => {
    renderEditor(note({ role: "viewer" }));
    expect(screen.queryByTestId("file-panel-controller")).toBeNull();
  });

  it("uploadFile callback calls uploadSelectedAttachment and returns formatAttachmentReference", async () => {
    const uploadFn = vi.fn().mockResolvedValue({
      filename: "image.png",
      id: "00000000-0000-4000-8000-000000000001",
      mimeType: "image/png",
      keyEpoch: 1,
      size: 3,
      createdAt: "2026-07-18T00:00:00.000Z",
      encryptedAttachmentKey: "key",
      attachmentKeyNonce: "nonce",
      fileNonce: "nonce"
    });
    render(
      <NoteEditor
        notesView="notes"
        resolveAttachmentUrl={(url) => Promise.resolve(url)}
        selectedNote={note()}
        updateSelectedNote={vi.fn()}
        uploadSelectedAttachment={uploadFn}
      />
    );
    const options = mocks.createOptions[0] as {
      uploadFile?: (file: File) => Promise<{ props: { name: string; url: string } }>;
    };
    const result = await options.uploadFile!(
      new File(["data"], "test.png", { type: "image/png" })
    );
    expect(uploadFn).toHaveBeenCalledOnce();
    expect(result.props.name).toBe("image.png");
    expect(result.props.url).toContain("fortnote-attachment:");
  });

  it("exposes loading state via file panel during upload", () => {
    useAppStore.setState({ status: "Encrypting attachment" });
    renderEditor(note());
    const filePanel = screen.getByTestId("file-panel-controller");
    expect(filePanel).toBeTruthy();
    expect(screen.getByTestId("file-tabs")).toBeTruthy();
  });
});

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

function renderEditor(
  selectedNote: DecryptedNote,
  updateSelectedNote: UpdateSelectedNote = vi.fn()
) {
  return render(
    <NoteEditor
      notesView="notes"
      resolveAttachmentUrl={(url) => Promise.resolve(url)}
      selectedNote={selectedNote}
      updateSelectedNote={updateSelectedNote}
      uploadSelectedAttachment={vi.fn()}
    />
  );
}

function note(overrides: Partial<DecryptedNote> = {}): DecryptedNote {
  return {
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
