// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CollaborationAction } from "@client/lib/collaborationState";
import type { DecryptedNote } from "@client/store/appStore";
import { useAppStore } from "@client/store/appStore";
import { EditorPane } from "@client/components/EditorPane";

const mocks = vi.hoisted(() => ({
  createOptions: [] as unknown[],
  editor: {
    document: [{ id: "block", type: "paragraph", props: {}, content: [], children: [] }],
    getBlock: vi.fn(() => ({ id: "block", type: "paragraph", props: {} })),
    prosemirrorState: { plugins: [] },
    onChange: vi.fn(() => () => undefined),
    onMount: vi.fn(() => () => undefined),
    redo: vi.fn(),
    schema: { blockSpecs: {} },
    undo: vi.fn(),
    updateBlock: vi.fn()
  },
  getFragment: vi.fn(),
  getProvider: vi.fn(() => ({
    awareness: {},
    isSynced: false,
    off: vi.fn(),
    on: vi.fn()
  })),
  updateBinding: vi.fn()
}));

vi.mock("@blocknote/react", () => ({
  EmbedTab: () => <div />,
  FilePanelController: () => null,
  UploadTab: () => <div />,
  useBlockNoteEditor: () => mocks.editor,
  useComponentsContext: () => null,
  useCreateBlockNote: (options: unknown) => {
    mocks.createOptions.push(options);
    return mocks.editor;
  },
  useDictionary: () => ({
    file_panel: { embed: { title: "Embed" }, upload: { title: "Upload" } }
  })
}));

vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: ({ children }: { children?: ReactNode }) => (
    <div data-testid="block-note">{children}</div>
  )
}));

vi.mock("@client/realtime/crdt", () => ({
  getCrdtFragment: mocks.getFragment,
  getCrdtProvider: mocks.getProvider,
  updateCrdtNote: mocks.updateBinding
}));

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
  useAppStore.getState().resetVaultState("reset");
});

describe("EditorPane composition", () => {
  it("renders NoteEditor by default filling the pane", () => {
    renderEditorPane();
    expect(screen.getByTestId("block-note")).toBeTruthy();
  });

  it("renders SettingsPanel when notesView is settings", () => {
    renderEditorPane({ notesView: "settings" });
    expect(screen.queryByTestId("block-note")).toBeNull();
    expect(screen.getByText("Account password")).toBeTruthy();
  });

  it("renders RecoveryDialog when recovery button is clicked", () => {
    const collaborationState = {
      actions: ["retry" as CollaborationAction],
      announcement: "assertive" as const,
      draftRetained: false,
      editing: false,
      id: "error",
      label: "Error",
      saved: false,
      synchronized: false
    };
    renderEditorPane({ collaborationState });

    fireEvent.click(screen.getByRole("button", { name: "More note actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open recovery actions" }));
    expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
  });

  it("renders empty state when no note selected", () => {
    renderEditorPane({ selectedNote: null });
    expect(screen.getByText("Select or create a note.")).toBeTruthy();
  });

  it("handles StrictMode replay without errors", async () => {
    const view = render(
      <StrictMode>
        <EditorPane
          collaborationState={{
            actions: [],
            announcement: "none",
            draftRetained: false,
            editing: false,
            id: "idle",
            label: "Ready",
            saved: true,
            synchronized: true
          }}
          newPassword=""
          notesView="notes"
          recoverySecret={null}
          selectedNote={note()}
          user={{ id: "alice", username: "alice" }}
          changePassword={vi.fn()}
          cleanupSharingKeys={vi.fn()}
          deleteSelectedForever={vi.fn()}
          lockVault={vi.fn()}
          moveSelectedToTrash={vi.fn()}
          resolveAttachmentUrl={(url) => Promise.resolve(url)}
          restoreSelectedNote={vi.fn()}
          rotateRecoveryKey={vi.fn()}
          rotateSharingKey={vi.fn()}
          setNewPassword={vi.fn()}
          updateSelectedNote={vi.fn()}
          uploadSelectedAttachment={vi.fn()}
          recoveryCallbacks={{
            cleanup: vi.fn(),
            copy: vi.fn(),
            discard: vi.fn(),
            encryptedExport: vi.fn(),
            reapply: vi.fn(),
            repairAccess: vi.fn(),
            retry: vi.fn(),
            reviewAccess: vi.fn(),
            reviewDraft: vi.fn(),
            tryAgain: vi.fn()
          }}
        />
      </StrictMode>
    );
    await act(async () => Promise.resolve());
    view.unmount();
    await act(async () => Promise.resolve());
  });
});

function renderEditorPane(overrides: Partial<Parameters<typeof EditorPane>[0]> = {}) {
  return render(
    <EditorPane
      collaborationState={{
        actions: [],
        announcement: "none",
        draftRetained: false,
        editing: false,
        id: "idle",
        label: "Ready",
        saved: true,
        synchronized: true
      }}
      newPassword=""
      notesView="notes"
      recoverySecret={null}
      selectedNote={note()}
      user={{ id: "alice", username: "alice" }}
      changePassword={vi.fn()}
      cleanupSharingKeys={vi.fn()}
      deleteSelectedForever={vi.fn()}
      lockVault={vi.fn()}
      moveSelectedToTrash={vi.fn()}
      resolveAttachmentUrl={(url) => Promise.resolve(url)}
      restoreSelectedNote={vi.fn()}
      rotateRecoveryKey={vi.fn()}
      rotateSharingKey={vi.fn()}
      setNewPassword={vi.fn()}
      updateSelectedNote={vi.fn()}
      uploadSelectedAttachment={vi.fn()}
      recoveryCallbacks={{
        cleanup: vi.fn(),
        copy: vi.fn(),
        discard: vi.fn(),
        encryptedExport: vi.fn(),
        reapply: vi.fn(),
        repairAccess: vi.fn(),
        retry: vi.fn(),
        reviewAccess: vi.fn(),
        reviewDraft: vi.fn(),
        tryAgain: vi.fn()
      }}
      {...overrides}
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
    noteKeyBase64: "key",
    ownerUserId: "alice",
    role: "owner",
    title: "Title",
    updatedAt: "2026-07-15T00:00:00.000Z",
    version: 1,
    ...overrides
  };
}
