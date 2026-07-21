// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedNote } from "../store/appStore";
import type { AttachmentSummary } from "../api";
import { useAppStore } from "../store/appStore";

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
  })
}));

vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: ({ children, editable }: {
    children?: ReactNode;
    editable: boolean;
  }) => (
    <div data-testid="block-note" data-editable={String(editable)}>
      {children}
    </div>
  )
}));

vi.mock("../realtime/crdt", () => ({
  getCrdtFragment: mocks.getFragment,
  getCrdtProvider: mocks.getProvider,
  updateCrdtNote: mocks.updateBinding
}));

import { NoteEditor } from "./NoteEditor";

type UpdateSelectedNote = (
  patch: Partial<Pick<DecryptedNote, "folderId" | "title">>
) => void;

describe("NoteEditor simplified editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createOptions.length = 0;
    mocks.provider.isSynced = false;
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
  });

  it("renders read-only for viewer role", () => {
    renderEditor(note({ role: "viewer" }));
    expect(screen.getByTestId("block-note").getAttribute("data-editable")).toBe("false");
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("shows compact save/sync state", () => {
    useAppStore.setState({ status: "Ready" });
    renderEditor(note());
    expect(screen.getByText("Saved and synchronized")).toBeTruthy();
  });

  it("shows conflict state", () => {
    useAppStore.setState({
      error: "Conflict detected",
      status: "Save conflict"
    });
    renderEditor(note());
    expect(screen.getByText("Changes need review")).toBeTruthy();
  });

  it("shows offline state", () => {
    useAppStore.setState({ realtimeStatus: "disconnected" });
    renderEditor(note());
    expect(screen.getByText("Offline — changes kept on this device")).toBeTruthy();
  });

  it("does not expose section controls", () => {
    const { container } = renderEditor(note());
    expect(screen.queryByLabelText("Note sections")).toBeNull();
    expect(screen.queryByText("Add section")).toBeNull();
    expect(screen.queryByText("Section 1 of 2")).toBeNull();
    expect(screen.queryByText("Merge with next")).toBeNull();
    expect(screen.queryByText("Split section")).toBeNull();
  });

  it("does not expose standalone attachment input", () => {
    renderEditor(note());
    expect(screen.queryByLabelText("Attach encrypted file")).toBeNull();
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
        folders={[]}
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
          folders={[]}
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

function renderEditor(
  selectedNote: DecryptedNote,
  updateSelectedNote: UpdateSelectedNote = vi.fn()
) {
  return render(
    <NoteEditor
      folders={[]}
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
