// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sectionRuntimeKey, useAppStore } from "../store/appStore";
import { SectionNavigator } from "./SectionNavigator";

describe("SectionNavigator", () => {
  beforeEach(() => {
    useAppStore.getState().resetVaultState("test reset");
  });

  afterEach(() => {
    cleanup();
  });

  it("shows root/index and requested-section loading honestly", () => {
    useAppStore.getState().setSectionIndex("note-1", {
      noteId: "note-1",
      status: "loading",
      orderedSectionIds: [],
      sections: []
    });
    const view = render(<SectionNavigator noteId="note-1" canEdit />);
    expect(screen.queryByText("Opening encrypted note…")).not.toBeNull();

    act(() => {
      installReadyIndex();
    });
    act(() => {
      useAppStore.getState().setLoadedSection({
        noteId: "note-1",
        sectionId: "section-2",
        keyEpoch: 1,
        status: "loading",
        currentSequence: 4,
        prefetched: false,
        transferProgress: {
          phase: "downloading",
          completedChunks: 2,
          totalChunks: 4,
          transferredBytes: 512,
          totalBytes: 1024
        }
      });
    });
    view.rerender(<SectionNavigator noteId="note-1" canEdit />);
    expect(screen.queryByText("Section 1 of 2 — Loading section…")).not.toBeNull();
    expect(screen.getAllByText("Loading")).toHaveLength(1);
    expect(
      screen.getByRole("progressbar", { name: "Section downloading progress" })
        .getAttribute("value")
    ).toBe("512");
  });

  it("renders ordered visible boundaries and excludes unloaded content from the editor surface", () => {
    installReadyIndex();
    useAppStore.getState().setLoadedSection({
      noteId: "note-1",
      sectionId: "section-1",
      keyEpoch: 1,
      status: "ready",
      currentSequence: 2,
      prefetched: true
    });
    render(<SectionNavigator noteId="note-1" canEdit={false} />);

    const list = screen.getByRole("list");
    const buttons = within(list).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Section 1",
      "Section 2"
    ]);
    expect(buttons[0]?.getAttribute("aria-current")).toBe("page");
    expect(within(list).queryByText("Unloaded")).not.toBeNull();
    expect(within(list).queryByText("Ready")).not.toBeNull();
    expect(screen.queryByText("section-3 secret body")).toBeNull();
  });

  it("exposes all section operations for writable notes", () => {
    installReadyIndex();
    useAppStore.getState().setLoadedSection({
      noteId: "note-1",
      sectionId: "section-2",
      keyEpoch: 1,
      status: "ready",
      currentSequence: 4,
      prefetched: false
    });
    const onCopy = vi.fn();
    const onCreate = vi.fn();
    const onDelete = vi.fn();
    const onMerge = vi.fn();
    const onMove = vi.fn();
    const onSplit = vi.fn();
    render(
      <SectionNavigator
        noteId="note-1"
        canEdit
        onCopy={onCopy}
        onCreate={onCreate}
        onDelete={onDelete}
        onMerge={onMerge}
        onMove={onMove}
        onSplit={onSplit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Add section" }));
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    fireEvent.click(screen.getByRole("button", { name: "Split section" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy into next" }));
    fireEvent.click(screen.getByRole("button", { name: "Merge with next" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete section" }));
    expect(onCopy).toHaveBeenCalledWith("section-2");
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledWith("section-2", 1);
    expect(onMerge).toHaveBeenCalledWith("section-2");
    expect(onSplit).toHaveBeenCalledWith("section-2");
    expect(onDelete).toHaveBeenCalledWith("section-2");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Move up" }).disabled
    ).toBe(true);
  });

  it("offers retry for index and section failures", () => {
    const retry = vi.fn();
    useAppStore.getState().setSectionIndex("note-1", {
      noteId: "note-1",
      status: "error",
      orderedSectionIds: [],
      sections: [],
      error: "Index failed"
    });
    const view = render(
      <SectionNavigator noteId="note-1" canEdit onRetry={retry} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    act(() => {
      installReadyIndex();
    });
    act(() => {
      useAppStore.getState().setLoadedSection({
        noteId: "note-1",
        sectionId: "section-2",
        keyEpoch: 1,
        status: "error",
        currentSequence: 4,
        prefetched: false,
        error: "Chunk verification failed"
      });
    });
    view.rerender(
      <SectionNavigator noteId="note-1" canEdit onRetry={retry} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry section" }));
    expect(retry).toHaveBeenCalledTimes(2);
  });
});

function installReadyIndex(): void {
  useAppStore.getState().setSectionIndex("note-1", {
    noteId: "note-1",
    status: "ready",
    orderedSectionIds: ["section-2", "section-1", "section-3"],
    sections: [
      section("section-1"),
      section("section-2"),
      { ...section("section-3"), isDeleted: true }
    ]
  });
  useAppStore.getState().setSelectedSection("note-1", "section-2");
  useAppStore.setState({
    loadedSections: Object.fromEntries(
      Object.entries(useAppStore.getState().loadedSections).filter(
        ([key]) => key !== sectionRuntimeKey("note-1", "section-2")
      )
    )
  });
}

function section(id: string) {
  return {
    id,
    noteId: "note-1",
    createdEpoch: 1,
    currentSequence: id === "section-2" ? 4 : 2,
    initialized: true,
    isDeleted: false
  };
}
