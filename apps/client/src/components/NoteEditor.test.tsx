// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecryptedNote } from "../store/appStore";
import { useAppStore } from "../store/appStore";
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
    prosemirrorState: {
      plugins: []
    },
    redo: vi.fn(),
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
  useCreateBlockNote: (options: unknown) => {
    mocks.createOptions.push(options);
    return mocks.editor;
  },
  useEditorChange: (callback: (editor: { document: unknown[] }) => void) => {
    mocks.editorChange = callback;
    mocks.editorChanges.push(callback);
  }
}));

vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: ({ editable }: { editable: boolean }) => (
    <div data-testid="block-note" data-editable={String(editable)} />
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

vi.mock("./AttachmentPanel", () => ({ AttachmentPanel: () => null }));
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
    useAppStore.setState({ user: { id: "alice", username: "alice" } });
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
    expect(mocks.attach).toHaveBeenCalledOnce();
    viewer.unmount();

    vi.clearAllMocks();
    renderEditor(note({ isDeleted: true }), vi.fn(), "trash");
    expect(screen.getByTestId("block-note").getAttribute("data-editable")).toBe("false");
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.createOptions.at(-1)).toMatchObject({
      initialContent: expect.arrayContaining([expect.objectContaining({ type: "paragraph" })])
    });
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
  notesView: "notes" | "shared" | "trash" = "notes"
) {
  return render(editor(selectedNote, updateSelectedNote, notesView));
}

function editor(
  selectedNote: DecryptedNote,
  updateSelectedNote: UpdateSelectedNote,
  notesView: "notes" | "shared" | "trash" = "notes"
) {
  return (
    <NoteEditor
      canDeleteAttachments
      downloadSelectedAttachment={vi.fn()}
      folders={[]}
      notesView={notesView}
      removeSelectedAttachment={vi.fn()}
      selectedAttachments={[]}
      selectedNote={selectedNote}
      updateSelectedNote={updateSelectedNote}
      uploadSelectedAttachment={vi.fn()}
    />
  );
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
